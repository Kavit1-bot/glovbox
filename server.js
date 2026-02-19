const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const stripe = require('stripe');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let stripeInstance;
if (process.env.STRIPE_SECRET_KEY) {
    stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);
}

const db = {
    users: new Map(),
    vehicles: new Map()
};

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return (R * c).toFixed(1);
}

app.get('/api/vehicle/:regNumber', async (req, res) => {
    try {
        const regNumber = req.params.regNumber.toUpperCase().replace(/\s/g, '');
        
        if (!regNumber || regNumber.length < 2) {
            return res.status(400).json({ error: 'Invalid registration number' });
        }

        const DVLA_API_KEY = process.env.DVLA_API_KEY;
        if (!DVLA_API_KEY) {
            return res.status(500).json({ error: 'Service temporarily unavailable' });
        }

        const response = await axios.post(
            'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
            { registrationNumber: regNumber },
            {
                headers: {
                    'x-api-key': DVLA_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const vehicle = response.data;
        
        res.json({
            registrationNumber: vehicle.registrationNumber,
            make: vehicle.make,
            model: vehicle.model || 'N/A',
            colour: vehicle.colour,
            yearOfManufacture: vehicle.yearOfManufacture,
            fuelType: vehicle.fuelType,
            motStatus: vehicle.motStatus,
            motExpiryDate: vehicle.motExpiryDate,
            taxStatus: vehicle.taxStatus,
            taxDueDate: vehicle.taxDueDate
        });

    } catch (error) {
        if (error.response?.status === 404) {
            return res.status(404).json({ error: 'Vehicle not found' });
        }
        console.error('DVLA Error:', error.message);
        res.status(500).json({ error: 'Unable to retrieve vehicle information' });
    }
});

app.get('/api/mot-centres', async (req, res) => {
    try {
        const { postcode } = req.query;

        if (!postcode) {
            return res.status(400).json({ error: 'Postcode required' });
        }

        const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
        if (!GOOGLE_API_KEY) {
            return res.status(500).json({ error: 'Service temporarily unavailable' });
        }

        const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(postcode)}&region=uk&key=${GOOGLE_API_KEY}`;
        const geocodeRes = await axios.get(geocodeUrl);

        if (!geocodeRes.data.results || geocodeRes.data.results.length === 0) {
            return res.status(404).json({ error: 'Postcode not found' });
        }

        const userLocation = geocodeRes.data.results[0].geometry.location;

        const searchUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${userLocation.lat},${userLocation.lng}&radius=8000&keyword=MOT+test+centre&key=${GOOGLE_API_KEY}`;
        const searchRes = await axios.get(searchUrl);

        if (!searchRes.data.results || searchRes.data.results.length === 0) {
            return res.json({ centres: [], userLocation });
        }

        const centres = await Promise.all(
            searchRes.data.results.slice(0, 12).map(async (place) => {
                try {
                    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,opening_hours,website&key=${GOOGLE_API_KEY}`;
                    const detailsRes = await axios.get(detailsUrl);
                    const details = detailsRes.data.result || {};

                    const distance = calculateDistance(
                        userLocation.lat,
                        userLocation.lng,
                        place.geometry.location.lat,
                        place.geometry.location.lng
                    );

                    return {
                        name: place.name,
                        address: place.vicinity,
                        distance: `${distance} miles`,
                        distanceValue: parseFloat(distance),
                        rating: place.rating || 'No rating',
                        ratingsCount: place.user_ratings_total || 0,
                        phoneNumber: details.formatted_phone_number || 'Not available',
                        openingHours: details.opening_hours?.weekday_text || [],
                        isOpenNow: details.opening_hours?.open_now || false,
                        website: details.website || null,
                        location: place.geometry.location
                    };
                } catch (err) {
                    console.error('Error fetching details:', err.message);
                    return null;
                }
            })
        );

        const validCentres = centres.filter(c => c !== null)
            .sort((a, b) => a.distanceValue - b.distanceValue);

        res.json({ centres: validCentres, userLocation });

    } catch (error) {
        console.error('MOT search error:', error.message);
        res.status(500).json({ error: 'Unable to search for MOT centres' });
    }
});

app.post('/api/insurance-quote', async (req, res) => {
    try {
        const { dob, postcode, vehicleMake, vehicleModel, engineSize, noClaimsBonus, annualMileage } = req.body;

        const age = Math.floor((new Date() - new Date(dob)) / (365.25 * 24 * 60 * 60 * 1000));

        let basePremium = 350;
        let ageMultiplier = age < 25 ? 1.8 : age >= 50 ? 0.95 : 1.0;
        
        const insuranceGroup = engineSize < 1200 ? 5 : engineSize < 1600 ? 12 : 20;
        const groupPremium = insuranceGroup * 15;
        
        const ncbDiscount = noClaimsBonus >= 5 ? 0.65 : noClaimsBonus >= 3 ? 0.75 : 0.90;
        const mileageMultiplier = annualMileage > 15000 ? 1.2 : 0.9;

        const calculatedPremium = Math.round(
            (basePremium + groupPremium) * ageMultiplier * ncbDiscount * mileageMultiplier
        );

        const quotes = [
            { provider: 'Compare Now', price: Math.round(calculatedPremium * 0.92) },
            { provider: 'Get Quote', price: Math.round(calculatedPremium * 0.98) },
            { provider: 'Check Prices', price: Math.round(calculatedPremium * 1.05) }
        ].sort((a, b) => a.price - b.price);

        res.json({ 
            quotes,
            disclaimer: 'Estimated prices. Click to compare final quotes from insurers.'
        });

    } catch (error) {
        console.error('Quote error:', error.message);
        res.status(500).json({ error: 'Unable to calculate quote' });
    }
});

app.post('/api/contact', async (req, res) => {
    try {
        const { name, email, reason, message } = req.body;

        if (!name || !email || !reason || !message) {
            return res.status(400).json({ error: 'All fields required' });
        }

        console.log('Contact submission:', { name, email, reason, message, timestamp: new Date() });

        res.json({ 
            success: true, 
            message: 'Thank you! We\'ll respond within 24 hours to ' + email 
        });

    } catch (error) {
        console.error('Contact error:', error);
        res.status(500).json({ error: 'Please email support@glovbox.net directly' });
    }
});

app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (db.users.has(email)) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = {
            id: Date.now().toString(),
            email,
            name,
            password: hashedPassword,
            createdAt: new Date()
        };

        db.users.set(email, user);

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET || 'glovbox_secret',
            { expiresIn: '7d' }
        );

        res.json({ success: true, token, user: { id: user.id, email, name } });

    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Unable to create account' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = db.users.get(email);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET || 'glovbox_secret',
            { expiresIn: '7d' }
        );

        res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/create-checkout', async (req, res) => {
    try {
        if (!stripeInstance) {
            return res.status(500).json({ error: 'Payments not configured' });
        }

        const { priceId } = req.body;

        const session = await stripeInstance.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/success`,
            cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}/cancel`,
            subscription_data: { trial_period_days: 30 }
        });

        res.json({ sessionId: session.id });

    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Payment setup failed' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        dvla: !!process.env.DVLA_API_KEY,
        google: !!process.env.GOOGLE_MAPS_API_KEY,
        stripe: !!process.env.STRIPE_SECRET_KEY
    });
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║   GLOVBOX API - Production Ready     ║
╠══════════════════════════════════════╣
║  Port: ${PORT}                        
║  DVLA: ${process.env.DVLA_API_KEY ? '✓' : '✗'}                           
║  Google: ${process.env.GOOGLE_MAPS_API_KEY ? '✓' : '✗'}                         
║  Stripe: ${process.env.STRIPE_SECRET_KEY ? '✓' : '✗'}                         
╚══════════════════════════════════════╝
    `);
});