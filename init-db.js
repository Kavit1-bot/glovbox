// AUTOMATIC DATABASE INITIALIZATION SCRIPT
// Run this on your computer with: node init-db.js

const { Client } = require('pg');
require('dotenv').config();

const SQL = `
-- Create Users table
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create Vehicles table
CREATE TABLE IF NOT EXISTS "Vehicle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "yearOfManufacture" INTEGER,
    "colour" TEXT,
    "fuelType" TEXT,
    "engineCapacity" INTEGER,
    "motStatus" TEXT,
    "motExpiryDate" TEXT,
    "taxStatus" TEXT,
    "taxDueDate" TEXT,
    "currentMileage" INTEGER DEFAULT 0,
    "lastServiceMileage" INTEGER DEFAULT 0,
    "lastMotReminder" TEXT,
    "lastTaxReminder" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Vehicle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create ServiceRecords table
CREATE TABLE IF NOT EXISTS "ServiceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "mileageAtService" INTEGER NOT NULL,
    "garageName" TEXT,
    "garageAddress" TEXT,
    "garagePhone" TEXT,
    "serviceType" TEXT NOT NULL,
    "description" TEXT,
    "totalCost" DOUBLE PRECISION,
    "receiptImageUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User"("email");
CREATE INDEX IF NOT EXISTS "Vehicle_userId_idx" ON "Vehicle"("userId");
CREATE INDEX IF NOT EXISTS "Vehicle_registrationNumber_idx" ON "Vehicle"("registrationNumber");
CREATE INDEX IF NOT EXISTS "ServiceRecord_vehicleId_idx" ON "ServiceRecord"("vehicleId");
CREATE INDEX IF NOT EXISTS "ServiceRecord_serviceDate_idx" ON "ServiceRecord"("serviceDate");

-- Create Prisma migrations table
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);

-- Insert migration record
INSERT INTO "_prisma_migrations" 
("id", "checksum", "migration_name", "started_at", "applied_steps_count")
VALUES 
('manual-init', 'manual-init', '00000000000000_manual_init', NOW(), 1)
ON CONFLICT DO NOTHING;
`;

async function initDatabase() {
  const DATABASE_URL = process.env.DATABASE_URL;
  
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not found in .env file!');
    console.log('\n📝 Add this to your .env file:');
    console.log('DATABASE_URL="postgresql://postgres:PASSWORD@HOST:PORT/railway"');
    process.exit(1);
  }

  console.log('🔌 Connecting to database...');
  
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Connected to database!');
    
    console.log('🗄️  Creating tables...');
    await client.query(SQL);
    
    console.log('✅ Database initialized successfully!');
    console.log('\n📊 Checking tables...');
    
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    console.log('\n✅ Tables created:');
    result.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name}`);
    });
    
    console.log('\n🎉 ALL DONE! Your database is ready!');
    console.log('🚀 Now restart your Glovbox service in Railway');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initDatabase();
