-- Migration: Create message_attachments table for storing media, links, and documents

CREATE TABLE IF NOT EXISTS message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('media', 'link', 'document', 'contact', 'audio', 'video', 'image')),
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size BIGINT, -- Size in bytes
  mime_type TEXT, -- e.g., 'image/jpeg', 'application/pdf', 'video/mp4'
  thumbnail_url TEXT, -- For images/videos
  metadata JSONB, -- Additional metadata (dimensions, duration, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments (message_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_type ON message_attachments (type);
CREATE INDEX IF NOT EXISTS idx_message_attachments_created_at ON message_attachments (created_at DESC);

-- Add attachment_id to messages table for quick reference
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN NOT NULL DEFAULT FALSE;

-- Create index for messages with attachments
CREATE INDEX IF NOT EXISTS idx_messages_has_attachments ON messages (has_attachments) WHERE has_attachments = TRUE;

