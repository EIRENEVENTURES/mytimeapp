-- Migration: Add chat rate settings to users table

ALTER TABLE users
ADD COLUMN IF NOT EXISTS chat_rate_per_second NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS chat_rate_charging_enabled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS chat_auto_end_inactivity BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS chat_inactivity_timeout_minutes INTEGER DEFAULT 5;

