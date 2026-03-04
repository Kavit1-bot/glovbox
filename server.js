// GLOVBOX SERVER - COMPLETE SECURE VERSION 2.0
// Production ready with all security features
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs').promises;
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true });

app.use('/api/', generalLimiter);
app.use('/api/signin', authLimiter);
app.use('/api/signup', authLimiter);

app.use(express.json());
app.use(express.static('public'));
app.use('/receipts', express.static('receipts'));

const DVLA_API_KEY = process.env.DVLA_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SITE_URL = process.env.SITE_URL || 'https://www.glovbox.net';

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'receipts');
    try { await fs.mkdir(uploadDir, { recursive: true }); } catch (e) {}
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|pdf/;
    cb(allowed.test(path.extname(file.originalname).toLowerCase()) ? null : new Error('Images/PDFs only'), true);
  }
});

const DB_FILE = path.join(__dirname, 'glovbox-db.json');
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');

async function loadDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(data)));
  } catch {
    return new Map();
  }
}

async function saveDB(users) {
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(Object.fromEntries(users), null, 2));
  } catch (error) {
    console.error('DB save error:', error.message);
  }
}

let users = new Map();
(async () => {
  users = await loadDB();
  console.log(`📊 Loaded ${users.size} users`);
})();

let analytics = { signups: [], logins: [], dailyStats: {} };

async function loadAnalytics() {
  try {
    const data = await fs.readFile(ANALYTICS_FILE, 'utf8');
    analytics = JSON.parse(data);
  } catch {
    analytics = { signups: [], logins: [], dailyStats: {} };
  }
}

async function saveAnalytics() {
  try {
    await fs.writeFile(ANALYTICS_FILE, JSON.stringify(analytics, null, 2));
  } catch {}
}

function logEvent(type, data) {
  const today = new Date().toISOString().split('T')[0];
  if (!analytics.dailyStats[today]) {
    analytics.dailyStats[today] = { signups: 0, logins: 0 };
  }
  if (type === 'signup') {
    analytics.signups.push({ type, data, timestamp: new Date().toISOString() });
    analytics.dailyStats[today].signups++;
  } else if (type === 'login') {
    analytics.logins.push({ type, data, timestamp: new Date().toISOString() });
    analytics.dailyStats[today].logins++;
  }
  saveAnalytics();
}

loadAnalytics();

function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

async function sendBrevoEmail(to, subject, htmlContent) {
  if (!BREVO_API_KEY) return { success: false };
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Glovbox', email: 'support@glovbox.net' },
      to: [{ email: to }],
      subject,
      htmlContent
    }, { headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }});
    return { success: true };
  } catch {
    return { success: false };
  }
}

function getVerificationEmail(name, token) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;background:#f9fafb;"><div style="max-width:600px;margin:0 auto;background:white;padding:40px;border-radius:12px;"><h2 style="color:#0B3D91;">Verify Your Email</h2><p>Hi ${name},</p><p>Click to verify:</p><a href="${SITE_URL}/verify-email.html?token=${token}" style="background:#FF6B35;color:white;padding:16px 32px;text-decoration:none;border-radius:8px;font-weight:bold;">Verify Email</a><p style="margin-top:30px;color:#666;">Expires in 24 hours.</p></div></body></html>`;
}

function getPasswordResetEmail(name, token) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;background:#f9fafb;"><div style="max-width:600px;margin:0 auto;background:white;padding:40px;border-radius:12px;"><h2 style="color:#0B3D91;">Reset Password</h2><p>Hi ${name},</p><p>Click to reset:</p><a href="${SITE_URL}/reset-password.html?token=${token}" style="background:#FF6B35;color:white;padding:16px 32px;text-decoration:none;border-radius:8px;font-weight:bold;">Reset Password</a><p style="margin-top:30px;color:#666;">Expires in 1 hour.</p></div></body></html>`;
}

function getMotReminderEmail(userName, vehicle, daysUntil) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;padding:20px;"><h2>🚗 MOT Reminder</h2><p>Hi ${userName},</p><p>${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) MOT expires in ${daysUntil} days!</p><p><strong>Expiry:</strong> ${vehicle.motExpiryDate}</p><a href="${SITE_URL}/mot-search.html" style="background:#FF6B35;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;">Find MOT Centre</a></body></html>`;
}

function getTaxReminderEmail(userName, vehicle, daysUntil) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;padding:20px;"><h2>💷 Tax Reminder</h2><p>Hi ${userName},</p><p>${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) tax expires in ${daysUntil} days!</p><p><strong>Due:</strong> ${vehicle.taxDueDate}</p><a href="https://www.gov.uk/vehicle-tax" style="background:#0B3D91;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;">Pay Tax</a></body></html>`;
}

function daysUntilDate(dateString) {
  if (!dateString) return null;
  const target = new Date(dateString);
  const today = new Date();
  today.setHours(0,0,0,0);
  target.setHours(0,0,0,0);
  return Math.ceil((target - today) / (1000*60*60*24));
}

function calculateHealthScore(vehicle) {
 ```javascript
function calculateHealthScore(vehicle, serviceRecords = [], costHistory = []) {
  let score = 0;
  let breakdown = {};
  
  // 1. REGULATORY COMPLIANCE (30 points max)
  let regulatory = 30;
  
  // MOT Status with time-based decay
  if (vehicle.motStatus !== 'Valid') {
    regulatory -= 25;
  } else {
    const motDays = daysUntilDate(vehicle.motExpiryDate);
    if (motDays !== null) {
      if (motDays < 7) regulatory -= 10;  // Urgent
      else if (motDays < 30) regulatory -= 5; // Soon
    }
  }
  
  // Tax Status
  if (vehicle.taxStatus !== 'Taxed') regulatory -= 5;
  
  score += regulatory;
  breakdown.regulatory = regulatory;
  
  // 2. SERVICE HISTORY QUALITY (25 points max)
  let serviceScore = 0;
  
  if (serviceRecords && serviceRecords.length > 0) {
    // Has service records bonus
    serviceScore += 10;
    
    // Recent service (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const recentService = serviceRecords.find(r => new Date(r.date) > sixMonthsAgo);
    if (recentService) serviceScore += 10;
    
    // Service consistency (3+ records shows pattern)
    if (serviceRecords.length >= 3) serviceScore += 5;
  }
  
  score += serviceScore;
  breakdown.service = serviceScore;
  
  // 3. AGE & MILEAGE RELATIONSHIP (20 points max)
  let ageScore = 20;
  const age = new Date().getFullYear() - (vehicle.yearOfManufacture || 2020);
  
  // Age penalty
  ageScore -= Math.min(age * 2, 15); // Max -15 for old cars
  
  // Mileage analysis (if tracked in service records)
  if (serviceRecords && serviceRecords.length > 0) {
    const latestRecord = serviceRecords.sort((a,b) => new Date(b.date) - new Date(a.date))[0];
    if (latestRecord && latestRecord.mileage) {
      const milesPerYear = latestRecord.mileage / Math.max(age, 1);
      // Low mileage per year = well maintained
      if (milesPerYear < 12000) ageScore += 5; // Excellent
      else if (milesPerYear < 15000) ageScore += 3; // Good
    }
  }
  
  score += Math.max(ageScore, 0);
  breakdown.age = ageScore;
  
  // 4. COST TREND ANALYSIS (15 points max) ⭐ UNIQUE
  let costScore = 10; // Base score
  
  if (costHistory && costHistory.length >= 2) {
    // Compare recent 3 months vs older 3 months
    const recent = costHistory.slice(0, 3).reduce((sum, c) => sum + (c.amount || 0), 0);
    const older = costHistory.slice(3, 6).reduce((sum, c) => sum + (c.amount || 0), 0);
    
    if (older > 0) {
      if (recent < older * 0.7) costScore += 5; // Costs decreasing significantly = excellent
      else if (recent < older) costScore += 3; // Costs decreasing = good
      else if (recent > older * 1.5) costScore -= 5; // Costs increasing = bad sign
    }
  }
  
  score += costScore;
  breakdown.costs = costScore;
  
  // 5. PROACTIVITY BONUS (10 points max) ⭐ UNIQUE
  let proactivity = 0;
  
  // Early MOT booking
  const motDays = daysUntilDate(vehicle.motExpiryDate);
  if (motDays !== null && motDays > 30 && vehicle.motStatus === 'Valid') {
    proactivity += 5; // Proactive maintenance
  }
  
  // Good record keeping (5+ service records)
  if (serviceRecords && serviceRecords.length >= 5) {
    proactivity += 5;
  }
  
  score += proactivity;
  breakdown.proactivity = proactivity;
  
  return {
    score: Math.round(Math.min(score, 100)),
    breakdown,
    maxScores: {
      regulatory: 30,
      service: 25,
      age: 20,
      costs: 15,
      proactivity: 10
    }
  };
}
```
// Update your health-score endpoint:

```javascript
app.get('/api/vehicle/:reg/health-score', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  const vehicle = user.vehicles?.find(v => v.registrationNumber === req.params.reg);
  
  if (!vehicle) return res.status(404).json({error:'Vehicle not found'});
  
  // Get service records and cost history for this vehicle
  const serviceRecords = (user.serviceRecords?.[req.params.reg] || [])
    .sort((a,b) => new Date(b.date) - new Date(a.date));
  
  const costHistory = (user.costTransactions || [])
    .filter(t => t.vehicleReg === req.params.reg)
    .sort((a,b) => new Date(b.date) - new Date(a.date));
  
  // Calculate enhanced health score
  const result = calculateHealthScore(vehicle, serviceRecords, costHistory);
  const score = result.score;
  
  // Generate issues list
  const issues = [];
  if (vehicle.motStatus !== 'Valid') issues.push('MOT expired or expiring soon');
  if (vehicle.taxStatus !== 'Taxed') issues.push('Tax not paid');
  if (serviceRecords.length === 0) issues.push('No service history recorded');
  const age = new Date().getFullYear() - (vehicle.yearOfManufacture || 2020);
  if (age > 10) issues.push('Vehicle is over 10 years old');
  
  // Generate recommendations
  const recommendations = [];
  if (result.breakdown.regulatory < 25) {
    recommendations.push('Renew MOT and Tax immediately');
  }
  if (result.breakdown.service < 15) {
    recommendations.push('Add service records to track maintenance history');
  }
  if (result.breakdown.age < 10) {
    recommendations.push('Regular maintenance becomes more important as vehicle ages');
  }
  if (result.breakdown.costs < 8) {
    recommendations.push('Consider budgeting for upcoming repairs - costs are trending up');
  }
  if (result.breakdown.proactivity < 5) {
    recommendations.push('Book MOT early and keep detailed service records for bonus points');
  }
  if (recommendations.length === 0) {
    recommendations.push('Excellent maintenance! Keep up the great work!');
  }
  
  res.json({
    score,
    grade: score > 80 ? 'A' : score > 60 ? 'B' : score > 40 ? 'C' : 'D',
    issues,
    recommendations,
    breakdown: result.breakdown,
    maxScores: result.maxScores,
    // Individual scores for frontend display
    regulatoryScore: result.breakdown.regulatory,
    serviceScore: result.breakdown.service,
    mileageScore: result.breakdown.age,
    costScore: result.breakdown.costs,
    proactivityScore: result.breakdown.proactivity
  });
});
```
}

function generateInsights(user) {
  const vehicles = user.vehicles || [];
  const opportunities = [];
  vehicles.forEach(v => {
    const motDays = daysUntilDate(v.motExpiryDate);
    if (motDays !== null && motDays > 0 && motDays < 60) {
      opportunities.push({
        type: 'mot',
        vehicle: v.registrationNumber,
        title: `MOT Expires in ${motDays} Days`,
        message: `Book MOT for ${v.make} ${v.model}`,
        action: '/mot-search.html',
        priority: motDays < 14 ? 'high' : 'medium',
        potentialSaving: 15
      });
    }
    const taxDays = daysUntilDate(v.taxDueDate);
    if (taxDays !== null && taxDays > 0 && taxDays < 30) {
      opportunities.push({
        type: 'tax',
        vehicle: v.registrationNumber,
        title: `Tax Due in ${taxDays} Days`,
        message: `Renew tax for ${v.make} ${v.model}`,
        action: 'https://www.gov.uk/vehicle-tax',
        priority: taxDays < 7 ? 'high' : 'medium',
        potentialSaving: 0
      });
    }
  });
  return opportunities;
}

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token'});
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({error:'Invalid token'});
    req.userEmail = decoded.email;
    next();
  });
}

async function checkAndSendReminders() {
  console.log('🔔 Checking reminders...');
  let sent = 0;
  for (const [email, user] of users.entries()) {
    if (!user.vehicles || !user.emailVerified) continue;
    for (const v of user.vehicles) {
      const motDays = daysUntilDate(v.motExpiryDate);
      const taxDays = daysUntilDate(v.taxDueDate);
      const today = new Date().toISOString().split('T')[0];
      if ([30,14,7].includes(motDays) && v.lastMotReminder !== today && user.reminderSettings?.mot) {
        await sendBrevoEmail(email, `🚗 MOT expires in ${motDays} days`, getMotReminderEmail(user.name, v, motDays));
        v.lastMotReminder = today;
        sent++;
      }
      if ([30,14,7].includes(taxDays) && v.lastTaxReminder !== today && user.reminderSettings?.tax) {
        await sendBrevoEmail(email, `💷 Tax expires in ${taxDays} days`, getTaxReminderEmail(user.name, v, taxDays));
        v.lastTaxReminder = today;
        sent++;
      }
    }
  }
  await saveDB(users);
  console.log(`✓ Sent ${sent} reminders`);
}

async function createBackup() {
  const date = new Date().toISOString().split('T')[0];
  const backupDir = path.join(__dirname, 'backups');
  const backupFile = path.join(backupDir, `glovbox-backup-${date}.json`);
  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(DB_FILE, backupFile);
    console.log(`✅ Backup: ${date}`);
  } catch {}
}

cron.schedule('0 9 * * *', checkAndSendReminders, {timezone: "Europe/London"});
cron.schedule('0 2 * * *', createBackup, {timezone: "Europe/London"});

app.get('/health', (req, res) => {
  res.json({
    status:'ok',
    users: users.size,
    version: '2.0-SECURE',
    features: ['email-verification', 'password-reset', 'account-deletion', 'analytics'],
    timestamp: new Date().toISOString()
  });
});

app.post('/api/signup', async (req, res) => {
  const {name,email,password} = req.body;
  if (!name || !email || !password) return res.status(400).json({error:'All fields required'});
  if (password.length < 8) return res.status(400).json({error:'Password 8+ chars'});
  if (!validateEmail(email)) return res.status(400).json({error:'Invalid email'});
  if (users.has(email.toLowerCase())) return res.status(400).json({error:'Email exists'});
  try {
    const hash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const user = {
      name, email: email.toLowerCase(), password:hash,
      emailVerified: false, verificationToken,
      verificationExpiry: Date.now() + 24*60*60*1000,
      vehicles:[], serviceRecords:{}, costTracking:{}, monthlyBudget: 150,
      reminderSettings:{mot:true,tax:true,service:false},
      createdAt:new Date().toISOString()
    };
    users.set(email.toLowerCase(), user);
    await saveDB(users);
    await sendBrevoEmail(email, 'Verify your Glovbox account', getVerificationEmail(name, verificationToken));
    logEvent('signup', {email: email.toLowerCase(), name});
    res.json({success: true, message: 'Check your email to verify', email: email.toLowerCase()});
  } catch {
    res.status(500).json({error:'Signup failed'});
  }
});

app.post('/api/verify-email', async (req, res) => {
  const {token} = req.body;
  if (!token) return res.status(400).json({error:'Token required'});
  for (const [email, user] of users.entries()) {
    if (user.verificationToken === token) {
      if (Date.now() > (user.verificationExpiry || 0)) {
        return res.status(400).json({error:'Link expired'});
      }
      user.emailVerified = true;
      user.verificationToken = null;
      user.verificationExpiry = null;
      await saveDB(users);
      const jwtToken = jwt.sign({email}, JWT_SECRET, {expiresIn:'30d'});
      return res.json({success: true, token: jwtToken, user: {name: user.name, email, createdAt: user.createdAt}});
    }
  }
  res.status(400).json({error:'Invalid token'});
});

app.post('/api/signin', async (req, res) => {
  const {email,password} = req.body;
  const user = users.get(email.toLowerCase());
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({error:'Invalid credentials'});
  }
  if (!user.emailVerified) {
    return res.status(403).json({error:'Email not verified', message: 'Check your email', needsVerification: true});
  }
  logEvent('login', {email: email.toLowerCase()});
  const token = jwt.sign({email: email.toLowerCase()}, JWT_SECRET, {expiresIn:'30d'});
  res.json({token, user:{name:user.name, email:email.toLowerCase(), createdAt: user.createdAt}});
});

app.post('/api/forgot-password', async (req, res) => {
  const {email} = req.body;
  const user = users.get(email.toLowerCase());
  if (!user) return res.json({success: true, message: 'If email exists, link sent'});
  const resetToken = crypto.randomBytes(32).toString('hex');
  user.passwordResetToken = resetToken;
  user.passwordResetExpiry = Date.now() + 60*60*1000;
  await saveDB(users);
  await sendBrevoEmail(email, 'Reset your Glovbox password', getPasswordResetEmail(user.name, resetToken));
  res.json({success: true, message: 'If email exists, link sent'});
});

app.post('/api/reset-password', async (req, res) => {
  const {token, newPassword} = req.body;
  if (!token || !newPassword) return res.status(400).json({error:'Token and password required'});
  if (newPassword.length < 8) return res.status(400).json({error:'Password 8+ chars'});
  for (const [email, user] of users.entries()) {
    if (user.passwordResetToken === token) {
      if (Date.now() > (user.passwordResetExpiry || 0)) {
        return res.status(400).json({error:'Link expired'});
      }
      user.password = await bcrypt.hash(newPassword, 10);
      user.passwordResetToken = null;
      user.passwordResetExpiry = null;
      await saveDB(users);
      return res.json({success: true, message: 'Password reset'});
    }
  }
  res.status(400).json({error:'Invalid token'});
});

app.post('/api/contact', async (req, res) => {
  const {name, email, message} = req.body;
  if (!name || !email || !message) return res.status(400).json({error:'All fields required'});
  if (!validateEmail(email)) return res.status(400).json({error:'Invalid email'});
  await sendBrevoEmail('support@glovbox.net', `Contact: ${name}`, `<p>From: ${email}</p><p>${message}</p>`);
  await sendBrevoEmail(email, 'We got your message', `<p>Hi ${name}, we'll reply within 24 hours.</p>`);
  res.json({success: true, message: 'Sent'});
});

app.delete('/api/user/account', authenticateToken, async (req, res) => {
  const {password} = req.body;
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  if (!await bcrypt.compare(password, user.password)) {
    return res.status(401).json({error:'Wrong password'});
  }
  users.delete(req.userEmail);
  await saveDB(users);
  res.json({success: true, message: 'Account deleted'});
});

app.get('/api/analytics/stats', authenticateToken, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const stats = analytics.dailyStats[today] || {signups: 0, logins: 0};
  res.json({
    today: stats,
    total: {users: users.size, signups: analytics.signups.length},
    recent: {signups: analytics.signups.slice(-10).reverse()}
  });
});

app.get('/api/vehicle/:registration', async (req, res) => {
  if (!DVLA_API_KEY) return res.status(503).json({error:'DVLA unavailable'});
  try {
    const response = await axios.post(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      {registrationNumber:req.params.registration.toUpperCase().replace(/\s/g,'')},
      {headers:{'x-api-key':DVLA_API_KEY,'Content-Type':'application/json'}}
    );
    res.json(response.data);
  } catch {
    res.status(500).json({error:'Vehicle not found'});
  }
});

app.get('/api/user/vehicles', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  res.json({vehicles: user.vehicles || []});
});

app.post('/api/user/vehicles', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  try {
    const response = await axios.post(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      {registrationNumber:req.body.registrationNumber},
      {headers:{'x-api-key':DVLA_API_KEY,'Content-Type':'application/json'}}
    );
    const vehicle = {...response.data, addedAt: new Date().toISOString()};
    if (!user.vehicles) user.vehicles = [];
    user.vehicles.push(vehicle);
    await saveDB(users);
    res.json({success:true, vehicle});
  } catch {
    res.status(500).json({error:'Failed'});
  }
});

app.delete('/api/user/vehicles/:reg', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  user.vehicles = user.vehicles.filter(v => v.registrationNumber !== req.params.reg);
  await saveDB(users);
  res.json({success:true});
});

app.get('/api/vehicle/:reg/health-score', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  const vehicle = user.vehicles?.find(v => v.registrationNumber === req.params.reg);
  if (!vehicle) return res.status(404).json({error:'Vehicle not found'});
  const score = calculateHealthScore(vehicle);
  const issues = [];
  if (vehicle.motStatus !== 'Valid') issues.push('MOT expired');
  if (vehicle.taxStatus !== 'Taxed') issues.push('Tax not paid');
  res.json({
    score,
    grade: score > 80 ? 'A' : score > 60 ? 'B' : score > 40 ? 'C' : 'D',
    issues,
    recommendations: issues.length > 0 ? ['Check MOT', 'Renew tax'] : ['Good!']
  });
});

app.get('/api/ai/insights', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const opportunities = generateInsights(user);
  const vehicleScores = (user.vehicles || []).map(v => ({
    registration: v.registrationNumber,
    score: calculateHealthScore(v)
  }));
  const avgHealth = vehicleScores.length > 0 
    ? Math.round(vehicleScores.reduce((sum, v) => sum + v.score, 0) / vehicleScores.length)
    : 100;
  res.json({
    opportunities,
    totalPotentialSavings: opportunities.reduce((sum, o) => sum + (o.potentialSaving || 0), 0),
    averageHealthScore: avgHealth,
    vehicleScores
  });
});

app.get('/api/user/costs', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const costs = user.costTracking?.[month] || {};
  const total = Object.values(costs).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
  res.json({
    month,
    total: Math.round(total * 100) / 100,
    breakdown: costs,
    budget: user.monthlyBudget || 150,
    percentUsed: Math.round((total / (user.monthlyBudget || 150)) * 100)
  });
});

app.post('/api/user/costs', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const {category, amount, date, description, vehicleReg} = req.body;
  if (!category || !amount) return res.status(400).json({error:'Category and amount required'});
  const month = (date || new Date().toISOString()).slice(0, 7);
  if (!user.costTracking) user.costTracking = {};
  if (!user.costTracking[month]) user.costTracking[month] = {};
  if (!user.costTracking[month][category]) user.costTracking[month][category] = 0;
  user.costTracking[month][category] += parseFloat(amount);
  if (!user.costTransactions) user.costTransactions = [];
  user.costTransactions.push({
    id: Date.now().toString(),
    category,
    amount: parseFloat(amount),
    date: date || new Date().toISOString(),
    description,
    vehicleReg,
    createdAt: new Date().toISOString()
  });
  await saveDB(users);
  res.json({success:true, month, category, amount: parseFloat(amount)});
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const notifications = [];
  const vehicles = user.vehicles || [];
  vehicles.forEach(v => {
    const motDays = daysUntilDate(v.motExpiryDate);
    if (motDays !== null && motDays > 0 && motDays < 30) {
      notifications.push({
        id: `mot-${v.registrationNumber}`,
        type: motDays < 7 ? 'urgent' : 'warning',
        title: 'MOT Expiring',
        message: `${v.make} ${v.model} MOT in ${motDays} days`,
        action: '/mot-search.html',
        actionText: 'Find MOT',
        read: false
      });
    }
  });
  res.json({
    notifications,
    unread: notifications.filter(n => !n.read).length
  });
});

app.get('/api/documents/export-pdf/:vehicleReg', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({error: 'No token'});
  let userEmail;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userEmail = decoded.email;
  } catch {
    return res.status(403).json({error: 'Invalid token'});
  }
  const user = users.get(userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const vehicle = user.vehicles?.find(v => v.registrationNumber === req.params.vehicleReg);
  if (!vehicle) return res.status(404).json({error:'Vehicle not found'});
  const records = user.serviceRecords?.[req.params.vehicleReg] || [];
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=service-history-${req.params.vehicleReg}.pdf`);
  doc.pipe(res);
  doc.fontSize(24).fillColor('#0B3D91').text('Service History', { align: 'center' });
  doc.moveDown();
  doc.fontSize(16).text(`${vehicle.make} ${vehicle.model}`, { align: 'center' });
  doc.fontSize(12).fillColor('#666').text(vehicle.registrationNumber, { align: 'center' });
  doc.moveDown(2);
  if (records.length === 0) {
    doc.fontSize(10).text('No records');
  } else {
    records.forEach(r => {
      doc.fontSize(11).text(`${new Date(r.date).toLocaleDateString()} - ${r.type} - £${r.cost?.toFixed(2) || '0'}`);
      doc.moveDown(0.3);
    });
  }
  doc.end();
});

app.post('/api/upload-receipt', authenticateToken, upload.single('receipt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, url: `/receipts/${req.file.filename}` });
});

app.get('/api/user/service-records', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  res.json({success:true, records: user.serviceRecords?.[req.query.vehicleReg] || []});
});

app.post('/api/user/service-records', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const {vehicleReg, date, mileage, type, cost, garage, description, receiptUrl} = req.body;
  const record = {
    id: Date.now().toString(),
    date, mileage: parseInt(mileage), type,
    cost: parseFloat(cost) || 0,
    garage, description, receiptUrl,
    addedAt: new Date().toISOString()
  };
  if (!user.serviceRecords) user.serviceRecords = {};
  if (!user.serviceRecords[vehicleReg]) user.serviceRecords[vehicleReg] = [];
  user.serviceRecords[vehicleReg].push(record);
  await saveDB(users);
  res.json({success:true, record});
});

app.delete('/api/user/service-records/:id', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const {vehicleReg} = req.query;
  if (user.serviceRecords?.[vehicleReg]) {
    user.serviceRecords[vehicleReg] = user.serviceRecords[vehicleReg].filter(r => r.id !== req.params.id);
    await saveDB(users);
  }
  res.json({success:true});
});

app.get('/api/user/settings', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  res.json({
    name: user.name,
    email: user.email,
    reminderSettings: user.reminderSettings || {mot:true,tax:true,service:false},
    monthlyBudget: user.monthlyBudget || 150
  });
});

app.patch('/api/user/settings', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const {name, reminderSettings, monthlyBudget} = req.body;
  if (name) user.name = name;
  if (reminderSettings) user.reminderSettings = reminderSettings;
  if (monthlyBudget) user.monthlyBudget = parseFloat(monthlyBudget);
  await saveDB(users);
  res.json({success:true});
});

app.get('/api/mot-centres', async (req, res) => {
  const {postcode} = req.query;
  if (!postcode) return res.status(400).json({error:'Postcode required'});
  if (!GOOGLE_MAPS_API_KEY) return res.status(503).json({error:'Maps unavailable'});
  try {
    const geo = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(postcode)},UK&key=${GOOGLE_MAPS_API_KEY}`);
    if (!geo.data.results.length) return res.status(400).json({error:'Invalid postcode'});
    const loc = geo.data.results[0].geometry.location;
    const places = await axios.get(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=8000&type=car_repair&keyword=MOT&key=${GOOGLE_MAPS_API_KEY}`);
    const detailedCentres = await Promise.all(
      places.data.results.slice(0, 10).map(async (place) => {
        try {
          const details = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,opening_hours&key=${GOOGLE_MAPS_API_KEY}`);
          return {
            name: place.name,
            address: place.vicinity,
            rating: place.rating || 'N/A',
            isOpenNow: place.opening_hours?.open_now || false,
            phone: details.data.result?.formatted_phone_number || null,
            hours: details.data.result?.opening_hours?.weekday_text || null
          };
        } catch {
          return {
            name: place.name,
            address: place.vicinity,
            rating: place.rating || 'N/A',
            isOpenNow: place.opening_hours?.open_now || false,
            phone: null,
            hours: null
          };
        }
      })
    );
    res.json({centres: detailedCentres});
  } catch {
    res.status(500).json({error:'Search failed'});
  }
});
```javascript
// ===== MARKET VALUE ENDPOINT (Market Check API) =====
app.get('/api/vehicle/:reg/market-value', authenticateToken, async (req, res) => {
  const reg = req.params.reg.toUpperCase().replace(/\s/g, '');
  
  try {
    // Check cache first (24 hour cache to save API calls)
    const user = users.get(req.userEmail);
    const vehicle = user.vehicles?.find(v => v.registrationNumber === reg);
    
    // Return cached data if less than 24 hours old
    if (vehicle && vehicle.marketValueCache && 
        vehicle.marketValueCacheTime && 
        Date.now() - vehicle.marketValueCacheTime < 24*60*60*1000) {
      console.log('💰 Market value from cache:', reg);
      return res.json(vehicle.marketValueCache);
    }
    
    console.log('💰 Fetching market value from API:', reg);
    
    // Fetch from Market Check API
    const response = await axios.get(
      'https://api.marketcheck.com/v2/search/car/active',
      {
        params: {
          api_key: 'QbyFue6ZqVsNtMgRVkLABlwNQu1jPFdE',
          vin: reg,
          rows: 1
        },
        headers: { 
          'Accept': 'application/json',
          'Host': 'api.marketcheck.com'
        },
        timeout: 10000
      }
    );
    
    // Extract valuation data
    const listings = response.data?.listings || [];
    
    if (listings.length > 0) {
      const listing = listings[0];
      const basePrice = listing.price || listing.msrp || 0;
      
      const valuation = {
        marketValue: basePrice,
        tradeIn: Math.round(basePrice * 0.85), // 15% below market
        privateSale: Math.round(basePrice * 0.95), // 5% below market
        dealerRetail: Math.round(basePrice * 1.10), // 10% above market
        trend: {
          direction: 'stable',
          percentage: 0
        },
        lastUpdated: new Date().toISOString(),
        source: 'Market Check UK'
      };
      
      // Cache result for 24 hours
      if (vehicle) {
        vehicle.marketValueCache = valuation;
        vehicle.marketValueCacheTime = Date.now();
        await saveDB(users);
      }
      
      console.log('✅ Market value fetched:', basePrice);
      return res.json(valuation);
      
    } else {
      // No listings found - return estimated value based on year
      console.log('⚠️ No market data found, using estimation');
      
      const year = vehicle?.yearOfManufacture || 2020;
      const age = new Date().getFullYear() - year;
      const estimatedValue = Math.max(15000 - (age * 1500), 3000); // Rough estimate
      
      const valuation = {
        marketValue: estimatedValue,
        tradeIn: Math.round(estimatedValue * 0.85),
        privateSale: Math.round(estimatedValue * 0.95),
        dealerRetail: Math.round(estimatedValue * 1.10),
        trend: {
          direction: 'stable',
          percentage: 0
        },
        lastUpdated: new Date().toISOString(),
        source: 'Estimated (no market data)',
        isEstimate: true
      };
      
      return res.json(valuation);
    }
    
  } catch (error) {
    console.error('❌ Market Check API error:', error.message);
    
    // Return fallback estimated value
    const user = users.get(req.userEmail);
    const vehicle = user?.vehicles?.find(v => v.registrationNumber === reg);
    const year = vehicle?.yearOfManufacture || 2020;
    const age = new Date().getFullYear() - year;
    const estimatedValue = Math.max(15000 - (age * 1500), 3000);
    
    res.json({
      marketValue: estimatedValue,
      tradeIn: Math.round(estimatedValue * 0.85),
      privateSale: Math.round(estimatedValue * 0.95),
      dealerRetail: Math.round(estimatedValue * 1.10),
      trend: { direction: 'stable', percentage: 0 },
      lastUpdated: new Date().toISOString(),
      source: 'Estimated (API unavailable)',
      isEstimate: true,
      error: 'Market data temporarily unavailable'
    });
  }
});
```
app.listen(port, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  GLOVBOX v2.0 SECURE                 ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port: ${port}                        `);
  console.log('║  ✅ Email Verification               ║');
  console.log('║  ✅ Password Reset                   ║');
  console.log('║  ✅ Account Deletion                 ║');
  console.log('║  ✅ Analytics                        ║');
  console.log('║  ✅ All Features                     ║');
  console.log(`║  Users: ${users.size}                         `);
  console.log('╚══════════════════════════════════════╝\n');
});
