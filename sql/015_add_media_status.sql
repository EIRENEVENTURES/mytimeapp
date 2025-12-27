-- Migration: Add media_status column to messages table
-- Supports: pending, completed, failed states for media uploads

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS media_status VARCHAR(20) DEFAULT NULL;

-- Add index for querying pending/failed media
CREATE INDEX IF NOT EXISTS idx_messages_media_status ON messages (media_status) WHERE media_status IS NOT NULL;

-- Add media_status to message_attachments for tracking
ALTER TABLE message_attachments
ADD COLUMN IF NOT EXISTS media_status VARCHAR(20) DEFAULT 'completed';

