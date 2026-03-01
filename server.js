// GLOVBOX SERVER - COMPLETE PHASE 1
// All existing features + Cost Tracking + AI Insights + Health Scores + PDF Export + Notifications

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
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

// Environment variables
const DVLA_API_KEY = process.env.DVLA_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'glovbox_secret_2026';
const BREVO_API_KEY = process.env.BREVO_API_KEY;

// Multer configuration
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

// ===== DATABASE =====
async function loadDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(data)));
  } catch {
    console.log('📂 Creating new database...');
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

// ===== EMAIL FUNCTIONS =====
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

function getMotReminderEmail(userName, vehicle, daysUntil) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;padding:20px;"><h2>🚗 MOT Reminder</h2><p>Hi ${userName},</p><p>Your ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) MOT expires in ${daysUntil} days!</p><p><strong>Expiry Date:</strong> ${vehicle.motExpiryDate}</p><a href="https://www.glovbox.net/mot-search.html" style="background:#FF6B35;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Find MOT Centre</a></body></html>`;
}

function getTaxReminderEmail(userName, vehicle, daysUntil) {
  return `<!DOCTYPE html><html><body style="font-family:Arial;padding:20px;"><h2>💷 Tax Reminder</h2><p>Hi ${userName},</p><p>Your ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) road tax expires in ${daysUntil} days!</p><p><strong>Due Date:</strong> ${vehicle.taxDueDate}</p><a href="https://www.gov.uk/vehicle-tax" style="background:#0B3D91;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Pay Tax</a></body></html>`;
}

function daysUntilDate(dateString) {
  if (!dateString) return null;
  const target = new Date(dateString);
  const today = new Date();
  today.setHours(0,0,0,0);
  target.setHours(0,0,0,0);
  return Math.ceil((target - today) / (1000*60*60*24));
}

// ===== AI FUNCTIONS =====
function calculateHealthScore(vehicle) {
  let score = 100;
  if (vehicle.motStatus !== 'Valid') score -= 30;
  if (vehicle.taxStatus !== 'Taxed') score -= 30;
  const age = new Date().getFullYear() - (vehicle.yearOfManufacture || 2020);
  score -= Math.min(age * 2, 20);
  return Math.max(score, 0);
}

function generateInsights(user) {
  const vehicles = user.vehicles || [];
  const opportunities = [];
  
  vehicles.forEach(v => {
    // MOT check
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
    
    // Tax check
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

// ===== AUTH MIDDLEWARE =====
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token'});
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({error:'Invalid token'});
    req.userEmail = decoded.email;
    next();
  });
}

// ===== REMINDER CHECKER =====
async function checkAndSendReminders() {
  console.log('🔔 Checking reminders...');
  let sent = 0;
  for (const [email, user] of users.entries()) {
    if (!user.vehicles) continue;
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

cron.schedule('0 9 * * *', checkAndSendReminders, {timezone: "Europe/London"});

// ===== API ROUTES =====

app.get('/health', (req, res) => {
  res.json({
    status:'ok', 
    users: users.size, 
    version: '1.0-COMPLETE-PHASE1',
    features: ['auth', 'vehicles', 'service-records', 'cost-tracking', 'ai-insights', 'health-scores', 'pdf-export', 'notifications'],
    timestamp: new Date().toISOString()
  });
});

// AUTH
app.post('/api/signup', async (req, res) => {
  const {name,email,password} = req.body;
  if (!name || !email || !password) return res.status(400).json({error:'All fields required'});
  if (password.length < 8) return res.status(400).json({error:'Password 8+ chars'});
  if (users.has(email)) return res.status(400).json({error:'Email exists'});
  
  try {
    const hash = await bcrypt.hash(password, 10);
    const user = {
      name, email, password:hash,
      vehicles:[], serviceRecords:{}, 
      costTracking:{}, monthlyBudget: 150,
      reminderSettings:{mot:true,tax:true,service:false},
      createdAt:new Date().toISOString()
    };
    users.set(email, user);
    await saveDB(users);
    const token = jwt.sign({email}, JWT_SECRET, {expiresIn:'30d'});
    res.json({token, user:{name,email}});
  } catch {
    res.status(500).json({error:'Signup failed'});
  }
});

app.post('/api/signin', async (req, res) => {
  const {email,password} = req.body;
  const user = users.get(email);
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({error:'Invalid credentials'});
  }
  const token = jwt.sign({email}, JWT_SECRET, {expiresIn:'30d'});
  res.json({token, user:{name:user.name,email}});
});

// VEHICLES
app.get('/api/vehicle/:registration', async (req, res) => {
  if (!DVLA_API_KEY) return res.status(503).json({error:'DVLA unavailable'});
  try {
    const response = await axios.post(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      {registrationNumber:req.params.registration.toUpperCase().replace(/\s/g,'')},
      {headers:{'x-api-key':DVLA_API_KEY,'Content-Type':'application/json'}}
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status||500).json({error:'Vehicle not found'});
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
    res.status(500).json({error:'Failed to add vehicle'});
  }
});

app.delete('/api/user/vehicles/:reg', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  user.vehicles = user.vehicles.filter(v => v.registrationNumber !== req.params.reg);
  await saveDB(users);
  res.json({success:true});
});

// ===== NEW: VEHICLE HEALTH SCORE =====
app.get('/api/vehicle/:reg/health-score', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  const vehicle = user.vehicles?.find(v => v.registrationNumber === req.params.reg);
  
  if (!vehicle) return res.status(404).json({error:'Vehicle not found'});
  
  const score = calculateHealthScore(vehicle);
  const issues = [];
  
  if (vehicle.motStatus !== 'Valid') issues.push('MOT expired or expiring soon');
  if (vehicle.taxStatus !== 'Taxed') issues.push('Tax not paid');
  const age = new Date().getFullYear() - (vehicle.yearOfManufacture || 2020);
  if (age > 10) issues.push('Vehicle is over 10 years old');
  
  res.json({
    score,
    grade: score > 80 ? 'A' : score > 60 ? 'B' : score > 40 ? 'C' : 'D',
    issues,
    recommendations: issues.length > 0 ? ['Check MOT status', 'Renew tax', 'Book service'] : ['Keep up the good maintenance!']
  });
});

// ===== NEW: AI INSIGHTS =====
app.get('/api/ai/insights', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  
  const opportunities = generateInsights(user);
  const totalSavings = opportunities.reduce((sum, o) => sum + (o.potentialSaving || 0), 0);
  
  // Calculate health scores for all vehicles
  const vehicleScores = (user.vehicles || []).map(v => ({
    registration: v.registrationNumber,
    score: calculateHealthScore(v)
  }));
  
  const avgHealth = vehicleScores.length > 0 
    ? Math.round(vehicleScores.reduce((sum, v) => sum + v.score, 0) / vehicleScores.length)
    : 100;
  
  res.json({
    opportunities: opportunities.sort((a,b) => {
      const priorityOrder = {high:3, medium:2, low:1};
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    }),
    totalPotentialSavings: totalSavings,
    averageHealthScore: avgHealth,
    vehicleScores
  });
});

// ===== NEW: COST TRACKING =====
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
  
  // Log transaction
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

app.get('/api/user/costs/transactions', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  
  const {month, vehicleReg} = req.query;
  let transactions = user.costTransactions || [];
  
  if (month) {
    transactions = transactions.filter(t => t.date.startsWith(month));
  }
  if (vehicleReg) {
    transactions = transactions.filter(t => t.vehicleReg === vehicleReg);
  }
  
  res.json({transactions: transactions.sort((a,b) => new Date(b.date) - new Date(a.date))});
});

// ===== NEW: NOTIFICATIONS =====
app.get('/api/notifications', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  
  const notifications = [];
  const vehicles = user.vehicles || [];
  
  vehicles.forEach(v => {
    // MOT notifications
    const motDays = daysUntilDate(v.motExpiryDate);
    if (motDays !== null && motDays > 0 && motDays < 30) {
      notifications.push({
        id: `mot-${v.registrationNumber}`,
        type: motDays < 7 ? 'urgent' : 'warning',
        title: 'MOT Expiring Soon',
        message: `${v.make} ${v.model} (${v.registrationNumber}) MOT expires in ${motDays} days`,
        action: '/mot-search.html',
        actionText: 'Find MOT Centre',
        read: false,
        createdAt: new Date().toISOString()
      });
    }
    
    // Tax notifications
    const taxDays = daysUntilDate(v.taxDueDate);
    if (taxDays !== null && taxDays > 0 && taxDays < 30) {
      notifications.push({
        id: `tax-${v.registrationNumber}`,
        type: taxDays < 7 ? 'urgent' : 'warning',
        title: 'Tax Due Soon',
        message: `${v.make} ${v.model} (${v.registrationNumber}) tax due in ${taxDays} days`,
        action: 'https://www.gov.uk/vehicle-tax',
        actionText: 'Pay Tax',
        read: false,
        createdAt: new Date().toISOString()
      });
    }
    
    // Service due (estimate based on 12 months/10k miles)
    const serviceRecords = user.serviceRecords?.[v.registrationNumber] || [];
    if (serviceRecords.length > 0) {
      const lastService = serviceRecords[serviceRecords.length - 1];
      const daysSinceService = Math.floor((new Date() - new Date(lastService.date)) / (1000*60*60*24));
      
      if (daysSinceService > 300) { // ~10 months
        notifications.push({
          id: `service-${v.registrationNumber}`,
          type: 'info',
          title: 'Service Due',
          message: `${v.make} ${v.model} last serviced ${Math.floor(daysSinceService/30)} months ago`,
          action: '/service-logbook.html',
          actionText: 'View History',
          read: false,
          createdAt: new Date().toISOString()
        });
      }
    }
  });
  
  res.json({
    notifications: notifications.sort((a,b) => {
      const typeOrder = {urgent:3, warning:2, info:1};
      return typeOrder[b.type] - typeOrder[a.type];
    }),
    unread: notifications.filter(n => !n.read).length
  });
});

// ===== NEW: PDF EXPORT =====
app.get('/api/documents/export-pdf/:vehicleReg', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  
  const vehicle = user.vehicles?.find(v => v.registrationNumber === req.params.vehicleReg);
  if (!vehicle) return res.status(404).json({error:'Vehicle not found'});
  
  const records = user.serviceRecords?.[req.params.vehicleReg] || [];
  
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=service-history-${req.params.vehicleReg}.pdf`);
  
  doc.pipe(res);
  
  // Header
  doc.fontSize(24).fillColor('#0B3D91').text('Service History', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor('#000').text(`${vehicle.make} ${vehicle.model}`, { align: 'center' });
  doc.fontSize(12).fillColor('#666').text(vehicle.registrationNumber, { align: 'center' });
  doc.moveDown(2);
  
  // Vehicle Details
  doc.fontSize(14).fillColor('#0B3D91').text('Vehicle Details');
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#000');
  doc.text(`Year: ${vehicle.yearOfManufacture || 'N/A'}`);
  doc.text(`Fuel Type: ${vehicle.fuelType || 'N/A'}`);
  doc.text(`MOT Expires: ${vehicle.motExpiryDate || 'N/A'}`);
  doc.text(`Tax Due: ${vehicle.taxDueDate || 'N/A'}`);
  doc.moveDown(2);
  
  // Service Records
  doc.fontSize(14).fillColor('#0B3D91').text('Service Records');
  doc.moveDown(0.5);
  
  if (records.length === 0) {
    doc.fontSize(10).fillColor('#666').text('No service records found.');
  } else {
    records.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach((record, index) => {
      doc.fontSize(11).fillColor('#000').text(`${new Date(record.date).toLocaleDateString('en-GB')} - ${record.type}`, {
        continued: true
      });
      doc.fillColor('#FF6B35').text(` £${record.cost?.toFixed(2) || '0.00'}`, { align: 'right' });
      
      if (record.garage) {
        doc.fontSize(9).fillColor('#666').text(`    Garage: ${record.garage}`);
      }
      if (record.mileage) {
        doc.fontSize(9).fillColor('#666').text(`    Mileage: ${record.mileage.toLocaleString()} miles`);
      }
      if (record.description) {
        doc.fontSize(9).fillColor('#666').text(`    Notes: ${record.description}`);
      }
      doc.moveDown(0.5);
    });
    
    // Summary
    doc.moveDown();
    const totalCost = records.reduce((sum, r) => sum + (r.cost || 0), 0);
    doc.fontSize(12).fillColor('#0B3D91').text('Summary');
    doc.fontSize(10).fillColor('#000');
    doc.text(`Total Services: ${records.length}`);
    doc.text(`Total Cost: £${totalCost.toFixed(2)}`);
    doc.text(`Average Cost: £${(totalCost / records.length).toFixed(2)}`);
  }
  
  // Footer
  doc.moveDown(3);
  doc.fontSize(8).fillColor('#999').text('Generated by Glovbox - www.glovbox.net', { align: 'center' });
  doc.text(new Date().toLocaleDateString('en-GB'), { align: 'center' });
  
  doc.end();
});

// SERVICE RECORDS (with photo support)
app.post('/api/upload-receipt', authenticateToken, upload.single('receipt'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ success: true, url: `/receipts/${req.file.filename}`, filename: req.file.filename });
  } catch {
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/user/service-records', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  const records = user.serviceRecords?.[req.query.vehicleReg] || [];
  res.json({success:true, records});
});

app.post('/api/user/service-records', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  
  const {vehicleReg, date, mileage, type, cost, garage, description, receiptUrl} = req.body;
  const record = {
    id: Date.now().toString(),
    date, mileage: parseInt(mileage), type,
    cost: parseFloat(cost) || 0,
    garage, description, receiptUrl: receiptUrl || null,
    addedAt: new Date().toISOString()
  };
  
  if (!user.serviceRecords) user.serviceRecords = {};
  if (!user.serviceRecords[vehicleReg]) user.serviceRecords[vehicleReg] = [];
  user.serviceRecords[vehicleReg].push(record);
  
  // Auto-add to cost tracking if cost > 0
  if (record.cost > 0) {
    const month = date.slice(0, 7);
    if (!user.costTracking) user.costTracking = {};
    if (!user.costTracking[month]) user.costTracking[month] = {};
    if (!user.costTracking[month]['maintenance']) user.costTracking[month]['maintenance'] = 0;
    user.costTracking[month]['maintenance'] += record.cost;
  }
  
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

// ACCOUNT SETTINGS
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

// MOT CENTRES (with phone numbers and opening hours)
app.get('/api/mot-centres', async (req, res) => {
  const {postcode} = req.query;
  if (!postcode) return res.status(400).json({error:'Postcode required'});
  if (!GOOGLE_MAPS_API_KEY) return res.status(503).json({error:'Maps API unavailable'});
  
  try {
    // Step 1: Geocode postcode
    const geo = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(postcode)},UK&key=${GOOGLE_MAPS_API_KEY}`);
    if (!geo.data.results.length) return res.status(400).json({error:'Invalid postcode'});
    
    const loc = geo.data.results[0].geometry.location;
    
    // Step 2: Search for MOT centres
    const places = await axios.get(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=8000&type=car_repair&keyword=MOT&key=${GOOGLE_MAPS_API_KEY}`);
    
    // Step 3: Get detailed info (phone & hours) for each place
    const detailedCentres = await Promise.all(
      places.data.results.slice(0, 10).map(async (place) => {
        try {
          // Get place details
          const details = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,opening_hours&key=${GOOGLE_MAPS_API_KEY}`);
          
          return {
            name: place.name,
            address: place.vicinity,
            rating: place.rating || 'N/A',
            isOpenNow: place.opening_hours?.open_now || false,
            phone: details.data.result?.formatted_phone_number || null,
            hours: details.data.result?.opening_hours?.weekday_text || null
          };
        } catch (error) {
          // If details fetch fails, return basic info
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
  } catch (error) {
    console.error('MOT search error:', error);
    res.status(500).json({error:'Search failed'});
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  GLOVBOX - COMPLETE PHASE 1          ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port: ${port}                        `);
  console.log('║  ✓ All Existing Features             ║');
  console.log('║  ✓ Cost Tracking                     ║');
  console.log('║  ✓ AI Insights                       ║');
  console.log('║  ✓ Health Scores                     ║');
  console.log('║  ✓ PDF Export                        ║');
  console.log('║  ✓ Notifications                     ║');
  console.log(`║  Users: ${users.size}                         `);
  console.log('╚══════════════════════════════════════╝\n');
});
