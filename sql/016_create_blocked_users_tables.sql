-- Migration: Create blocked_users and user_reports tables
-- Run this to create tables for blocking and reporting users

-- Create blocked_users table
CREATE TABLE IF NOT EXISTS blocked_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (blocker_id, blocked_id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker 
  ON blocked_users (blocker_id);

CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked 
  ON blocked_users (blocked_id);

-- Create user_reports table
CREATE TABLE IF NOT EXISTS user_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reasons TEXT[] NOT NULL,
  additional_info TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(50) DEFAULT 'pending',
  UNIQUE (reporter_id, reported_id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_reports_reporter 
  ON user_reports (reporter_id);

CREATE INDEX IF NOT EXISTS idx_user_reports_reported 
  ON user_reports (reported_id);

CREATE INDEX IF NOT EXISTS idx_user_reports_status 
  ON user_reports (status);

