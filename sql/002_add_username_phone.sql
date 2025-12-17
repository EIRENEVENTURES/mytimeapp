-- Migration: Add username and phone_number columns to users table
-- Run this script to update the users table schema

-- Add username column (unique, nullable initially for existing users)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

-- Add phone_number column (unique, nullable initially for existing users)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;

-- Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users (phone_number) WHERE phone_number IS NOT NULL;

-- Add email_verified column for OTP verification
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Create OTP table for email verification
CREATE TABLE IF NOT EXISTS otp_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  otp_code        TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_verifications (email);
CREATE INDEX IF NOT EXISTS idx_otp_code ON otp_verifications (otp_code);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_verifications (expires_at);

-- Clean up expired OTPs older than 1 hour (optional, can be run periodically)
-- DELETE FROM otp_verifications WHERE expires_at < NOW() - INTERVAL '1 hour';

