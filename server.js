const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const DVLA_API_KEY = process.env.DVLA_API_KEY || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage (temporary - replace with real DB)
const users = [];
const vehicles = [];

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({error: 'No token'});
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({error: 'Invalid token'});
    }
    req.user = user;
    next();
  });
}

console.log('🚀 Starting Glovbox Server...');
console.log('📍 GOOGLE_MAPS_API_KEY:', GOOGLE_MAPS_API_KEY ? 'Set ✅' : 'Missing ❌');

// ===== PUBLIC ENDPOINTS (NO AUTH) =====

// Homepage - Public vehicle lookup
app.get('/api/vehicle-public/:reg', async (req, res) => {
  const reg = req.params.reg.toUpperCase().replace(/\s/g, '');
  
  try {
    const response = await axios.get(`https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles`, {
      method: 'POST',
      headers: {
        'x-api-key': DVLA_API_KEY,
        'Content-Type': 'application/json'
      },
      data: { registrationNumber: reg }
    });
    
    res.json(response.data);
  } catch (error) {
    res.status(404).json({error: 'Vehicle not found'});
  }
});

// Sign up
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  
  if (!name || !email || !password) {
    return res.status(400).json({error: 'All fields required'});
  }
  
  if (users.find(u => u.email === email)) {
    return res.status(400).json({error: 'Email already registered'});
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now(),
    name,
    email,
    password: hashedPassword,
    createdAt: new Date()
  };
  
  users.push(user);
  res.json({message: 'Account created! Please sign in.'});
});

// Sign in
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;
  
  const user = users.find(u => u.email === email);
  if (!user) {
    return res.status(401).json({error: 'Invalid credentials'});
  }
  
  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(401).json({error: 'Invalid credentials'});
  }
  
  const token = jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({
    token,
    user: {
      name: user.name,
      email: user.email
    }
  });
});

// ===== PROTECTED ENDPOINTS (REQUIRE AUTH) =====

// GEOCODE - This is the critical one!
app.get('/api/geocode', authenticateToken, async (req, res) => {
  const { postcode } = req.query;
  
  console.log('🔍 Geocode request:', postcode);
  
  if (!postcode) {
    return res.status(400).json({error: 'Postcode required'});
  }
  
  if (!GOOGLE_MAPS_API_KEY) {
    console.error('❌ GOOGLE_MAPS_API_KEY not set!');
    return res.status(500).json({error: 'Google Maps API key not configured'});
  }
  
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: postcode + ', UK',
        key: GOOGLE_MAPS_API_KEY
      }
    });
    
    console.log('📍 Google API status:', response.data.status);
    
    if (response.data.status !== 'OK' || !response.data.results || response.data.results.length === 0) {
      console.log('❌ Location not found for:', postcode);
      return res.status(404).json({error: 'Location not found'});
    }
    
    const location = response.data.results[0].geometry.location;
    console.log('✅ Location found:', location);
    
    res.json({ lat: location.lat, lng: location.lng });
    
  } catch (error) {
    console.error('❌ Geocoding error:', error.message);
    res.status(500).json({error: 'Geocoding failed'});
  }
});

// MOT Centres
app.get('/api/mot-centres', authenticateToken, async (req, res) => {
  const { lat, lng } = req.query;
  
  if (!lat || !lng) {
    return res.status(400).json({error: 'Lat/lng required'});
  }
  
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
      params: {
        location: `${lat},${lng}`,
        radius: 5000,
        keyword: 'MOT test centre',
        key: GOOGLE_MAPS_API_KEY
      }
    });
    
    const centres = response.data.results.slice(0, 10).map(place => ({
      name: place.name,
      address: place.vicinity,
      rating: place.rating || 'N/A',
      placeId: place.place_id
    }));
    
    res.json({ centres });
  } catch (error) {
    res.status(500).json({error: 'Failed to find centres'});
  }
});

// User vehicles
app.get('/api/user/vehicles', authenticateToken, (req, res) => {
  const userVehicles = vehicles.filter(v => v.userId === req.user.id);
  res.json({ vehicles: userVehicles });
});

app.post('/api/user/vehicles', authenticateToken, async (req, res) => {
  const { registration } = req.body;
  const reg = registration.toUpperCase().replace(/\s/g, '');
  
  try {
    const response = await axios.post(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      { registrationNumber: reg },
      {
        headers: {
          'x-api-key': DVLA_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const vehicle = {
      id: Date.now(),
      userId: req.user.id,
      registration: reg,
      make: response.data.make,
      model: response.data.model || '',
      year: response.data.yearOfManufacture,
      colour: response.data.colour,
      motStatus: response.data.motStatus,
      motExpiryDate: response.data.motExpiryDate,
      taxStatus: response.data.taxStatus,
      taxDueDate: response.data.taxDueDate,
      addedAt: new Date()
    };
    
    vehicles.push(vehicle);
    res.json({ vehicle, message: 'Vehicle added' });
    
  } catch (error) {
    res.status(400).json({error: 'Failed to add vehicle'});
  }
});

// Serve HTML files
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  GLOVBOX - MINIMAL WORKING SERVER    ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                        `);
  console.log('║  ✅ Public Vehicle Lookup            ║');
  console.log('║  ✅ MOT Search with Geocoding        ║');
  console.log('║  ✅ User Authentication              ║');
  console.log('║  ✅ Vehicle Management               ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('📊 Users:', users.length);
  console.log('🚗 Vehicles:', vehicles.length);
});
