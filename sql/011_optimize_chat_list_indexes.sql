-- Migration: Add indexes to optimize chat list queries

-- Composite index for faster conversation partner lookup
CREATE INDEX IF NOT EXISTS idx_messages_user_conversations 
  ON messages (sender_id, recipient_id, created_at DESC)
  WHERE sender_id IS NOT NULL AND recipient_id IS NOT NULL;

-- Index for unread count queries
CREATE INDEX IF NOT EXISTS idx_messages_unread 
  ON messages (recipient_id, status, created_at DESC)
  WHERE status != 'read';

-- Index for faster last message lookup per conversation
CREATE INDEX IF NOT EXISTS idx_messages_conversation_latest 
  ON messages ((LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id)), created_at DESC);

