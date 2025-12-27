-- Optimize message queries with composite and partial indexes
-- Run this migration to improve query performance

-- Add idempotency_key column for idempotent message writes
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Add unique constraint on idempotency_key (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'messages_idempotency_key_key'
  ) THEN
    ALTER TABLE messages 
    ADD CONSTRAINT messages_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END $$;

-- Composite index for conversation queries (hot path - chat open)
-- Covers: WHERE (sender_id, recipient_id) OR (recipient_id, sender_id) ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sr 
ON messages (sender_id, recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_rs 
ON messages (recipient_id, sender_id, created_at DESC);

-- Partial index for unread messages (reduces index size significantly)
-- Covers: WHERE recipient_id = $1 AND status != 'read'
CREATE INDEX IF NOT EXISTS idx_messages_unread_partial 
ON messages (recipient_id, sender_id, created_at DESC) 
WHERE status != 'read';

-- Index for status updates (delivered/read)
CREATE INDEX IF NOT EXISTS idx_messages_status_update 
ON messages (recipient_id, sender_id, status) 
WHERE status IN ('sent', 'delivered');

-- Index for idempotency key lookups
CREATE INDEX IF NOT EXISTS idx_messages_idempotency_key 
ON messages (idempotency_key) 
WHERE idempotency_key IS NOT NULL;

-- Composite index for cursor pagination (stable cursor with id)
-- Ensures deterministic ordering when created_at is equal
CREATE INDEX IF NOT EXISTS idx_messages_cursor_pagination 
ON messages (created_at DESC, id DESC);

-- Index for message attachments (already exists but ensure it's optimal)
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id_created 
ON message_attachments (message_id, created_at);

-- Index for message reactions
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id 
ON message_reactions (message_id);

-- Index for starred messages lookup
CREATE INDEX IF NOT EXISTS idx_starred_messages_user_message 
ON starred_messages (user_id, message_id);

-- Index for pinned messages lookup
CREATE INDEX IF NOT EXISTS idx_pinned_messages_user_message 
ON pinned_messages (user_id, message_id);

-- Analyze tables to update statistics
ANALYZE messages;
ANALYZE message_attachments;
ANALYZE message_reactions;
ANALYZE starred_messages;
ANALYZE pinned_messages;

