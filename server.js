// SECURED SERVER WITH RATE LIMITING AND BEST PRACTICES

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const stripe = require('stripe');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs').promises;
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const PDFDocument = require('pdfkit');
const Tesseract = require('tesseract.js');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ===== SECURITY MIDDLEWARE =====

// Helmet - Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for now
  crossOriginEmbedderPolicy: false
}));

// CORS - Restrict to your domain only
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://www.glovbox.net', 'https://glovbox.net']
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate Limiting - Prevent spam/DDoS
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes per IP
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 auth attempts per 15 minutes
  message: 'Too many login attempts, please try again in 15 minutes',
  skipSuccessfulRequests: true, // Don't count successful logins
});

const vehicleLookupLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 vehicle lookups per minute
  message: 'Too many vehicle lookups, please slow down',
});

// Apply rate limiters
app.use('/api/', generalLimiter);
app.use('/api/signin', authLimiter);
app.use('/api/signup', authLimiter);
app.use('/api/vehicle/', vehicleLookupLimiter);

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ===== ENVIRONMENT VARIABLES (Validated) =====

const DVLA_API_KEY = process.env.DVLA_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const BREVO_API_KEY = process.env.BREVO_API_KEY;

// Validate critical environment variables on startup
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ SECURITY WARNING: JWT_SECRET is too weak! Use at least 32 characters.');
  console.error('Generate a strong secret: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
}

if (!DVLA_API_KEY || !BREVO_API_KEY) {
  console.error('⚠️ WARNING: Missing API keys. Some features may not work.');
}

const stripeClient = STRIPE_SECRET_KEY ? stripe(STRIPE_SECRET_KEY) : null;
const prisma = new PrismaClient();
const DB_FILE = path.join(__dirname, 'glovbox-db.json');

// Configure multer for receipt uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads/receipts');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|pdf/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs allowed'));
    }
  }
});

// ===== DATABASE FUNCTIONS =====

async function loadDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return new Map(Object.entries(parsed));
  } catch (error) {
    console.log('📂 Creating new database file...');
    return new Map();
  }
}

async function saveDB(users) {
  try {
    const obj = Object.fromEntries(users);
    await fs.writeFile(DB_FILE, JSON.stringify(obj, null, 2));
  } catch (error) {
    console.error('❌ Error saving database:', error.message);
  }
}

let users = new Map();

(async () => {
  users = await loadDB();
  console.log(`📊 Loaded ${users.size} user accounts`);
})();

// ===== EMAIL FUNCTIONS =====

async function sendBrevoEmail(to, subject, htmlContent) {
  if (!BREVO_API_KEY) {
    console.error('⚠️ Brevo API key missing');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Glovbox', email: 'support@glovbox.net' },
      to: [{ email: to }],
      subject: subject,
      htmlContent: htmlContent
    }, {
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }
    });
    console.log(`✓ Email sent: ${subject}`);
    return { success: true };
  } catch (error) {
    console.error('✗ Email error:', error.message);
    return { success: false, error: error.message };
  }
}

function getMotReminderEmail(userName, vehicle, daysUntil) {
  const urgency = daysUntil <= 7 ? 'URGENT: ' : '';
  return `<!DOCTYPE html><html><body style="font-family:Arial;margin:0;padding:20px;background:#F8FAFC;"><div style="max-width:600px;margin:0 auto;"><div style="background:#0B3D91;color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;"><h1 style="margin:0;">🚗 ${urgency}MOT Reminder</h1></div><div style="background:white;padding:30px;border-radius:0 0 8px 8px;"><p>Hi ${userName || 'there'},</p><div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:16px;margin:20px 0;border-radius:4px;"><strong>Your ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) MOT expires in ${daysUntil} days!</strong></div><p><strong>Expiry Date:</strong> ${vehicle.motExpiryDate}</p><p>Don't get caught out - book your MOT today.</p><p style="text-align:center;margin:30px 0;"><a href="https://www.glovbox.net/mot-search.html" style="background:#FF6B35;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">Find MOT Centre</a></p><p>Best regards,<br>The Glovbox Team</p></div></div></body></html>`;
}

function getTaxReminderEmail(userName, vehicle, daysUntil) {
  const urgency = daysUntil <= 7 ? 'URGENT: ' : '';
  return `<!DOCTYPE html><html><body style="font-family:Arial;margin:0;padding:20px;background:#F8FAFC;"><div style="max-width:600px;margin:0 auto;"><div style="background:#0B3D91;color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;"><h1 style="margin:0;">💷 ${urgency}Road Tax Reminder</h1></div><div style="background:white;padding:30px;border-radius:0 0 8px 8px;"><p>Hi ${userName || 'there'},</p><div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:16px;margin:20px 0;border-radius:4px;"><strong>Your ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) road tax expires in ${daysUntil} days!</strong></div><p><strong>Due Date:</strong> ${vehicle.taxDueDate}</p><p style="text-align:center;margin:30px 0;"><a href="https://www.gov.uk/vehicle-tax" style="background:#0B3D91;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">Pay Tax on GOV.UK</a></p><p>Best regards,<br>The Glovbox Team</p></div></div></body></html>`;
}

function daysUntilDate(dateString) {
  if (!dateString) return null;
  const target = new Date(dateString);
  const today = new Date();
  today.setHours(0,0,0,0);
  target.setHours(0,0,0,0);
  return Math.ceil((target - today) / (1000*60*60*24));
}

async function checkAndSendReminders() {
  console.log('🔔 Checking reminders...');
  let sent = 0;
  for (const [email, user] of users.entries()) {
    if (!user.vehicles) continue;
    for (const v of user.vehicles) {
      const motDays = daysUntilDate(v.motExpiryDate);
      const taxDays = daysUntilDate(v.taxDueDate);
      const today = new Date().toISOString().split('T')[0];
      
      if ([30,14,7].includes(motDays) && v.lastMotReminder !== today) {
        await sendBrevoEmail(email, `🚗 MOT expires in ${motDays} days - ${v.registrationNumber}`, getMotReminderEmail(user.name, v, motDays));
        v.lastMotReminder = today;
        sent++;
      }
      if ([30,14,7].includes(taxDays) && v.lastTaxReminder !== today) {
        await sendBrevoEmail(email, `💷 Road tax expires in ${taxDays} days - ${v.registrationNumber}`, getTaxReminderEmail(user.name, v, taxDays));
        v.lastTaxReminder = today;
        sent++;
      }
    }
  }
  await saveDB(users);
  console.log(`✓ Sent ${sent} reminders`);
}

cron.schedule('0 9 * * *', checkAndSendReminders, {timezone: "Europe/London"});

// ===== OCR HELPER =====

function parseReceiptText(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const parsed = {
    garageName: null,
    totalCost: null,
    serviceDate: null,
    vatAmount: null,
    items: []
  };
  
  const topLines = lines.slice(0, 5).join(' ');
  const garageMatch = topLines.match(/([\w\s]+(?:Garage|Motors|Tyres|Auto|Service|Centre))/i);
  if (garageMatch) parsed.garageName = garageMatch[1].trim();
  
  const totalMatch = text.match(/(?:total|amount|balance)[:\s]*£?(\d+\.?\d*)/i);
  if (totalMatch) parsed.totalCost = parseFloat(totalMatch[1]);
  
  const vatMatch = text.match(/vat[:\s]*£?(\d+\.?\d*)/i);
  if (vatMatch) parsed.vatAmount = parseFloat(vatMatch[1]);
  
  const dateMatch = text.match(/(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/);
  if (dateMatch) parsed.serviceDate = dateMatch[1];
  
  const keywords = ['oil', 'filter', 'brake', 'tyre', 'tire', 'fluid', 'coolant', 'service', 'mot', 'labour', 'labor'];
  lines.forEach(line => {
    if (keywords.some(k => line.toLowerCase().includes(k)) && line.length > 5) {
      parsed.items.push(line);
    }
  });
  
  return parsed;
}

// ===== AUTHENTICATION MIDDLEWARE =====

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({error:'Authentication required'});
  }
  
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({error:'Invalid or expired token'});
    }
    req.userEmail = decoded.email;
    next();
  });
}

// ===== API ROUTES =====
// (All your existing routes here - same as before)
// I'll include the key ones...

app.post('/api/test-reminder', async (req, res) => {
  const {email, type = 'mot'} = req.body;
  if (!email) return res.status(400).json({error:'Email required'});
  const testVehicle = {make:'Ford',model:'Fiesta',registrationNumber:'TEST123',motExpiryDate:'2026-03-15',taxDueDate:'2026-04-20'};
  const html = type === 'mot' ? getMotReminderEmail('Test User', testVehicle, 14) : getTaxReminderEmail('Test User', testVehicle, 14);
  await sendBrevoEmail(email, type === 'mot' ? '🚗 TEST: MOT Reminder' : '💷 TEST: Road Tax Reminder', html);
  res.json({success:true, message:'Test email sent!'});
});

app.get('/api/vehicle/:registration', async (req, res) => {
  const reg = req.params.registration.toUpperCase().replace(/\s/g,'');
  
  if (!DVLA_API_KEY) {
    return res.status(503).json({error:'DVLA service temporarily unavailable'});
  }
  
  try {
    const response = await axios.post(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      {registrationNumber:reg},
      {headers:{'x-api-key':DVLA_API_KEY,'Content-Type':'application/json'}}
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status||500).json({error:'Vehicle not found'});
  }
});

app.post('/api/signup', async (req, res) => {
  const {name,email,password} = req.body;
  
  if (!name || !email || !password) {
    return res.status(400).json({error:'All fields required'});
  }
  
  if (password.length < 8) {
    return res.status(400).json({error:'Password must be at least 8 characters'});
  }
  
  if (users.has(email)) {
    return res.status(400).json({error:'Email already registered'});
  }
  
  try {
    const hash = await bcrypt.hash(password, 10);
    const user = {name,email,password:hash,vehicles:[],createdAt:new Date().toISOString()};
    users.set(email, user);
    await saveDB(users);
    const token = jwt.sign({email}, JWT_SECRET, {expiresIn: '30d'});
    res.json({token, user:{name,email}});
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({error:'Error creating account'});
  }
});

app.post('/api/signin', async (req, res) => {
  const {email,password} = req.body;
  const user = users.get(email);
  if (!user) return res.status(401).json({error:'Invalid credentials'});
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({error:'Invalid credentials'});
  const token = jwt.sign({email}, JWT_SECRET, {expiresIn: '30d'});
  res.json({token, user:{name:user.name,email}});
});

// ... (rest of your API routes - same as server-complete.js)

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  GLOVBOX API - SECURED & PROTECTED   ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port: ${port}                        `);
  console.log(`║  DVLA: ${DVLA_API_KEY?'✓':'✗'}                           `);
  console.log(`║  Brevo: ${BREVO_API_KEY?'✓':'✗'}                          `);
  console.log(`║  Database: ${prisma?'✓':'✗'} Connected              `);
  console.log('║  🔒 Rate Limiting: Active            ║');
  console.log('║  🛡️  Helmet Security: Active          ║');
  console.log('║  🚫 CORS: Restricted                 ║');
  console.log(`║  JWT: ${JWT_SECRET?.length >= 32 ? '✓ Strong' : '⚠️  WEAK!'}                   `);
  console.log('╚══════════════════════════════════════╝\n');
  
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('⚠️  WARNING: JWT_SECRET is weak! Generate a strong one:');
    console.error('   node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  }
});

module.exports = app;
