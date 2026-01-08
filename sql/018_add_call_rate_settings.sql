-- Migration: Add call rate settings to users table
-- This migration adds columns for voice/video call rate configuration

ALTER TABLE users
ADD COLUMN IF NOT EXISTS voice_call_rate_per_second NUMERIC(10, 2) DEFAULT 3,
ADD COLUMN IF NOT EXISTS video_call_rate_per_second NUMERIC(10, 2) DEFAULT 5,
ADD COLUMN IF NOT EXISTS call_rate_charging_enabled BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS call_minimum_duration_seconds INTEGER DEFAULT 60,
ADD COLUMN IF NOT EXISTS call_auto_end_inactivity BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS call_inactivity_timeout_minutes INTEGER DEFAULT 10,
ADD COLUMN IF NOT EXISTS call_require_pre_payment BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS call_minimum_balance_required NUMERIC(10, 2) DEFAULT 1000,
ADD COLUMN IF NOT EXISTS call_category VARCHAR(50) DEFAULT 'general',
ADD COLUMN IF NOT EXISTS call_enable_video_rates BOOLEAN NOT NULL DEFAULT TRUE;

-- Add index for call category if needed for filtering
CREATE INDEX IF NOT EXISTS idx_users_call_category ON users(call_category) WHERE call_category IS NOT NULL;


