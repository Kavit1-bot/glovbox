const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const stripe = require('stripe');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DVLA_API_KEY = process.env.DVLA_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const stripeClient = stripe(STRIPE_SECRET_KEY);
const DB_FILE = path.join(__dirname, 'glovbox-db.json');

// Load database from file
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

// Save database to file
async function saveDB(users) {
  try {
    const obj = Object.fromEntries(users);
    await fs.writeFile(DB_FILE, JSON.stringify(obj, null, 2));
    console.log('💾 Database saved');
  } catch (error) {
    console.error('❌ Error saving database:', error.message);
  }
}

let users = new Map();

// Initialize database on startup
(async () => {
  users = await loadDB();
  console.log(`📊 Loaded ${users.size} user accounts`);
})();

// Brevo email functions
async function sendBrevoEmail(to, subject, htmlContent) {
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
  return `<!DOCTYPE html><html><body style="font-family:Arial;margin:0;padding:20px;background:#F8FAFC;"><div style="max-width:600px;margin:0 auto;"><div style="background:#0B3D91;color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;"><h1 style="margin:0;">🚗 ${urgency}MOT Reminder</h1></div><div style="background:white;padding:30px;border-radius:0 0 8px 8px;"><p>Hi ${userName || 'there'},</p><div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:16px;margin:20px 0;border-radius:4px;"><strong>Your ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) MOT expires in ${daysUntil} days!</strong></div><p><strong>Expiry Date:</strong> ${vehicle.motExpiryDate}</p><p>Don't get caught out - book your MOT today to avoid:</p><ul><li>£1,000 fine</li><li>Points on your licence</li><li>Invalidated insurance</li></ul><p style="text-align:center;margin:30px 0;"><a href="https://www.glovbox.net/mot-search.html" style="background:#FF6B35;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">Find MOT Centre Near You</a></p><p>Best regards,<br>The Glovbox Team</p></div><div style="text-align:center;margin-top:20px;font-size:12px;color:#64748B;"><p>Glovbox - Your One-Stop Shop for MOT, Insurance & Road Tax</p><p><a href="https://www.glovbox.net/dashboard.html" style="color:#0B3D91;">Manage Your Vehicles</a> | <a href="https://www.glovbox.net" style="color:#0B3D91;">www.glovbox.net</a></p></div></div></body></html>`;
}

function getTaxReminderEmail(userName, vehicle, daysUntil) {
  const urgency = daysUntil <= 7 ? 'URGENT: ' : '';
  return `<!DOCTYPE html><html><body style="font-family:Arial;margin:0;padding:20px;background:#F8FAFC;"><div style="max-width:600px;margin:0 auto;"><div style="background:#0B3D91;color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;"><h1 style="margin:0;">💷 ${urgency}Road Tax Reminder</h1></div><div style="background:white;padding:30px;border-radius:0 0 8px 8px;"><p>Hi ${userName || 'there'},</p><div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:16px;margin:20px 0;border-radius:4px;"><strong>Your ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber}) road tax expires in ${daysUntil} days!</strong></div><p><strong>Due Date:</strong> ${vehicle.taxDueDate}</p><p>Driving without road tax could result in:</p><ul><li>£80 fine</li><li>Vehicle clamping</li><li>Vehicle impounding</li><li>Court prosecution</li></ul><p style="text-align:center;margin:30px 0;"><a href="https://www.gov.uk/vehicle-tax" style="background:#0B3D91;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">Pay Tax on GOV.UK</a></p><p>Best regards,<br>The Glovbox Team</p></div><div style="text-align:center;margin-top:20px;font-size:12px;color:#64748B;"><p>Glovbox - Your One-Stop Shop for MOT, Insurance & Road Tax</p><p><a href="https://www.glovbox.net/dashboard.html" style="color:#0B3D91;">Manage Your Vehicles</a> | <a href="https://www.glovbox.net" style="color:#0B3D91;">www.glovbox.net</a></p></div></div></body></html>`;
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

// API Routes
app.post('/api/test-reminder', async (req, res) => {
  const {email, type = 'mot'} = req.body;
  if (!email) return res.status(400).json({error:'Email required'});
  const testVehicle = {make:'Ford',model:'Fiesta',registrationNumber:'TEST123',motExpiryDate:'2026-03-15',taxDueDate:'2026-04-20'};
  const html = type === 'mot' ? getMotReminderEmail('Test User', testVehicle, 14) : getTaxReminderEmail('Test User', testVehicle, 14);
  await sendBrevoEmail(email, type === 'mot' ? '🚗 TEST: MOT Reminder' : '💷 TEST: Road Tax Reminder', html);
  res.json({success:true, message:'Test email sent!'});
});

app.post('/api/check-reminders', async (req, res) => {
  await checkAndSendReminders();
  res.json({success:true});
});

app.get('/api/vehicle/:registration', async (req, res) => {
  const reg = req.params.registration.toUpperCase().replace(/\s/g,'');
  try {
    const response = await axios.post('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {registrationNumber:reg}, {headers:{'x-api-key':DVLA_API_KEY,'Content-Type':'application/json'}});
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status||500).json({error:'Vehicle not found'});
  }
});

app.get('/api/mot-centres', async (req, res) => {
  const {postcode} = req.query;
  if (!postcode) return res.status(400).json({error:'Postcode required'});
  try {
    const geo = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(postcode)},UK&key=${GOOGLE_MAPS_API_KEY}`);
    if (!geo.data.results.length) return res.status(400).json({error:'Invalid postcode'});
    const loc = geo.data.results[0].geometry.location;
    const places = await axios.get(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=8000&type=car_repair&keyword=MOT&key=${GOOGLE_MAPS_API_KEY}`);
    const centres = places.data.results.slice(0,10).map(p=>({name:p.name,address:p.vicinity,rating:p.rating||'N/A',ratingsCount:p.user_ratings_total||0,distance:'~5 miles',phoneNumber:'Call for booking',isOpenNow:p.opening_hours?.open_now||false,openingHours:[]}));
    res.json({centres});
  } catch (error) {
    res.status(500).json({error:'Error searching centres'});
  }
});

app.post('/api/signup', async (req, res) => {
  const {name,email,password} = req.body;
  if (users.has(email)) return res.status(400).json({error:'Email already registered'});
  const hash = await bcrypt.hash(password, 10);
  const user = {name,email,password:hash,vehicles:[],createdAt:new Date().toISOString()};
  users.set(email, user);
  await saveDB(users);
  const token = jwt.sign({email}, JWT_SECRET);
  res.json({token, user:{name,email}});
});

app.post('/api/signin', async (req, res) => {
  const {email,password} = req.body;
  const user = users.get(email);
  if (!user) return res.status(401).json({error:'Invalid credentials'});
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({error:'Invalid credentials'});
  const token = jwt.sign({email}, JWT_SECRET);
  res.json({token, user:{name:user.name,email}});
});

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token provided'});
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({error:'Invalid token'});
    req.userEmail = decoded.email;
    next();
  });
}

// Get user's vehicles
app.get('/api/user/vehicles', authenticateToken, (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  res.json({vehicles: user.vehicles || []});
});

// Add vehicle to user account
app.post('/api/user/vehicles', authenticateToken, async (req, res) => {
  const {registrationNumber, nickname} = req.body;
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  
  try {
    const response = await axios.post('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {registrationNumber}, {headers:{'x-api-key':DVLA_API_KEY,'Content-Type':'application/json'}});
    const vehicleData = response.data;
    const vehicle = {...vehicleData, nickname, addedAt: new Date().toISOString()};
    
    if (!user.vehicles) user.vehicles = [];
    user.vehicles.push(vehicle);
    await saveDB(users);
    res.json({success:true, vehicle});
  } catch (error) {
    res.status(500).json({error:'Error adding vehicle'});
  }
});

// Remove vehicle
app.delete('/api/user/vehicles/:reg', authenticateToken, async (req, res) => {
  const user = users.get(req.userEmail);
  if (!user) return res.status(404).json({error:'User not found'});
  user.vehicles = user.vehicles.filter(v => v.registrationNumber !== req.params.reg);
  await saveDB(users);
  res.json({success:true});
});

app.listen(port, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   GLOVBOX API - Production Ready     ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port: ${port}                        `);
  console.log(`║  DVLA: ${DVLA_API_KEY?'✓':'✗'}                           `);
  console.log(`║  Google: ${GOOGLE_MAPS_API_KEY?'✓':'✗'}                         `);
  console.log(`║  Stripe: ${STRIPE_SECRET_KEY?'✓':'✗'}                         `);
  console.log(`║  Brevo: ${BREVO_API_KEY?'✓':'✗'}                          `);
  console.log('║  Reminders: Active (9am daily)       ║');
  console.log(`║  Users: ${users.size} accounts loaded          `);
  console.log('╚══════════════════════════════════════╝\n');
});
