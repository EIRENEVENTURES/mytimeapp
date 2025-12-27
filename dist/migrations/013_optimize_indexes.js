"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optimizeMessageIndexes = optimizeMessageIndexes;
/**
 * Migration: Optimize message indexes for performance
 * Run this to create optimized indexes for chat queries
 */
const db_1 = require("../db");
async function optimizeMessageIndexes() {
    const client = await db_1.pool.connect();
    try {
        await client.query('BEGIN');
        // Add idempotency_key column if it doesn't exist
        await client.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)
    `);
        // Add unique constraint on idempotency_key if it doesn't exist
        const constraintExists = await client.query(`
      SELECT 1 FROM pg_constraint 
      WHERE conname = 'messages_idempotency_key_key'
    `);
        if (constraintExists.rows.length === 0) {
            await client.query(`
        ALTER TABLE messages 
        ADD CONSTRAINT messages_idempotency_key_key UNIQUE (idempotency_key)
      `);
        }
        // Composite indexes for conversation queries (hot path)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_sr 
      ON messages (sender_id, recipient_id, created_at DESC)
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_rs 
      ON messages (recipient_id, sender_id, created_at DESC)
    `);
        // Partial index for unread messages (reduces index size)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_unread_partial 
      ON messages (recipient_id, sender_id, created_at DESC) 
      WHERE status != 'read'
    `);
        // Index for status updates
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_status_update 
      ON messages (recipient_id, sender_id, status) 
      WHERE status IN ('sent', 'delivered')
    `);
        // Index for idempotency key lookups
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_idempotency_key 
      ON messages (idempotency_key) 
      WHERE idempotency_key IS NOT NULL
    `);
        // Composite index for stable cursor pagination
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_cursor_pagination 
      ON messages (created_at DESC, id DESC)
    `);
        // Optimize attachment lookups
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id_created 
      ON message_attachments (message_id, created_at)
    `);
        // Analyze tables to update statistics
        await client.query('ANALYZE messages');
        await client.query('ANALYZE message_attachments');
        await client.query('ANALYZE message_reactions');
        await client.query('ANALYZE starred_messages');
        await client.query('ANALYZE pinned_messages');
        await client.query('COMMIT');
        console.log('Message indexes optimized successfully');
    }
    catch (error) {
        await client.query('ROLLBACK');
        console.error('Error optimizing indexes:', error);
        throw error;
    }
    finally {
        client.release();
    }
}
