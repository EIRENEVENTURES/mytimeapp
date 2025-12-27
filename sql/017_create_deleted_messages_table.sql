-- Migration: Create deleted_messages table for soft delete tracking
-- Run this to create table for tracking messages deleted by users

-- Create deleted_messages table
CREATE TABLE IF NOT EXISTS deleted_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_deleted_messages_message_id 
  ON deleted_messages (message_id);

CREATE INDEX IF NOT EXISTS idx_deleted_messages_user_id 
  ON deleted_messages (user_id);

CREATE INDEX IF NOT EXISTS idx_deleted_messages_user_message 
  ON deleted_messages (user_id, message_id);

