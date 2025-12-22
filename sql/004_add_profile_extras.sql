-- Migration: Add extended profile fields to users table

ALTER TABLE users
ADD COLUMN IF NOT EXISTS bio TEXT,
ADD COLUMN IF NOT EXISTS credit_per_second NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS specialty TEXT,
ADD COLUMN IF NOT EXISTS links TEXT,
ADD COLUMN IF NOT EXISTS ratings NUMERIC(3, 2);


