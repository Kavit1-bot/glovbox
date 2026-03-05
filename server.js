// GLOVBOX SERVER - SECURE VERSION
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const cron = require("node-cron");
const fs = require("fs").promises;
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const PDFDocument = require("pdfkit");

require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: process.env.SITE_URL || "https://www.glovbox.net",
    credentials: true,
  })
);

app.use(express.json());
app.use(express.static("public"));
app.use("/receipts", express.static("receipts"));

/* =============================
   ENVIRONMENT VARIABLES
============================= */

const DVLA_API_KEY = process.env.DVLA_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MARKETCHECK_API_KEY = process.env.MARKETCHECK_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const SITE_URL = process.env.SITE_URL || "https://www.glovbox.net";

if (!DVLA_API_KEY) console.warn("⚠ DVLA_API_KEY missing");
if (!GOOGLE_MAPS_API_KEY) console.warn("⚠ GOOGLE_MAPS_API_KEY missing");
if (!MARKETCHECK_API_KEY) console.warn("⚠ MARKETCHECK_API_KEY missing");
if (!BREVO_API_KEY) console.warn("⚠ BREVO_API_KEY missing (emails disabled)");

/* =============================
   RATE LIMITING
============================= */

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
});

app.use("/api/", generalLimiter);
app.use("/api/signin", authLimiter);
app.use("/api/signup", authLimiter);

/* =============================
   FILE UPLOAD
============================= */

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, "receipts");
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const safeName =
      Date.now() +
      "-" +
      crypto.randomBytes(6).toString("hex") +
      path.extname(file.originalname);
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },

  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".pdf"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG or PDF files allowed"));
    }
  },
});

/* =============================
   DATABASE
============================= */

const DB_FILE = path.join(__dirname, "glovbox-db.json");

async function loadDB() {
  try {
    const data = await fs.readFile(DB_FILE, "utf8");
    return new Map(Object.entries(JSON.parse(data)));
  } catch {
    return new Map();
  }
}

async function saveDB(users) {
  await fs.writeFile(DB_FILE, JSON.stringify(Object.fromEntries(users), null, 2));
}

let users = new Map();

(async () => {
  users = await loadDB();
  console.log(`📊 Loaded ${users.size} users`);
})();

/* =============================
   AUTH
============================= */

function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token" });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" });

    req.userEmail = decoded.email;
    next();
  });
}

/* =============================
   EMAIL
============================= */

async function sendEmail(to, subject, htmlContent) {
  if (!BREVO_API_KEY) return;

  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: "Glovbox", email: "noreply@glovbox.net" },
        to: [{ email: to }],
        subject,
        htmlContent,
      },
      {
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

/* =============================
   SIGNUP
============================= */

app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  if (users.has(email))
    return res.status(400).json({ error: "Email already registered" });

  const hashedPassword = await bcrypt.hash(password, 10);

  users.set(email, {
    name,
    email,
    password: hashedPassword,
    createdAt: new Date().toISOString(),
    vehicles: [],
  });

  await saveDB(users);

  res.json({ message: "Account created" });
});

/* =============================
   LOGIN
============================= */

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;

  const user = users.get(email);

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    token,
    user: { name: user.name, email: user.email },
  });
});

/* =============================
   DVLA VEHICLE LOOKUP
============================= */

app.get("/api/vehicle/:reg", authenticateToken, async (req, res) => {
  const reg = req.params.reg.toUpperCase().replace(/\s/g, "");

  try {
    const response = await axios.post(
      "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
      { registrationNumber: reg },
      {
        headers: {
          "x-api-key": DVLA_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch {
    res.status(404).json({ error: "Vehicle not found" });
  }
});

/* =============================
   GOOGLE GEOCODE (SECURE)
============================= */

app.get("/api/geocode", async (req, res) => {
  const { postcode } = req.query;

  if (!postcode) {
    return res.status(400).json({ error: "Postcode required" });
  }

  try {
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          address: postcode + ",UK",
          key: GOOGLE_MAPS_API_KEY,
        },
      }
    );

    const location = response.data.results?.[0]?.geometry?.location;

    if (!location) {
      return res.status(404).json({ error: "Location not found" });
    }

    res.json({
      lat: location.lat,
      lng: location.lng,
    });
  } catch (err) {
    console.error("Geocode error:", err.message);
    res.status(500).json({ error: "Geocode failed" });
  }
});

/* =============================
   MARKET VALUE API
============================= */

app.get("/api/vehicle/:reg/market-value", authenticateToken, async (req, res) => {
  const reg = req.params.reg.toUpperCase().replace(/\s/g, "");

  try {
    const response = await axios.get(
      "https://mc-api.marketcheck.com/v2/search/car/active",
      {
        params: {
          api_key: MARKETCHECK_API_KEY,
          rows: 20,
          country: "UK",
        },
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Market value lookup failed" });
  }
});

/* =============================
   FILE UPLOAD
============================= */

app.post("/api/upload-receipt", authenticateToken, upload.single("receipt"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  res.json({
    url: `/receipts/${req.file.filename}`,
  });
});

/* =============================
   SERVER START
============================= */

app.listen(port, "0.0.0.0", () => {
  console.log("");
  console.log("🚗 GLOVBOX SERVER RUNNING");
  console.log("Port:", port);
  console.log("Users:", users.size);
  console.log("");
});