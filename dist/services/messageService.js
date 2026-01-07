"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMessage = createMessage;
/**
 * Message service - handles message persistence and business logic
 * Separated from socket/HTTP concerns for better testability and maintainability
 */
const db_1 = require("../db");
const redis_1 = require("../redis");
/**
 * Create a new message
 * Returns the created message
 */
async function createMessage(params) {
    const { senderId, recipientId, content, replyToMessageId, idempotencyKey } = params;
    try {
        // Check idempotency if key provided
        if (idempotencyKey) {
            const existing = await db_1.pool.query(`SELECT id, sender_id, recipient_id, content, status, created_at, reply_to_message_id
         FROM messages WHERE idempotency_key = $1`, [idempotencyKey]);
            if (existing.rows.length > 0) {
                const msg = existing.rows[0];
                return {
                    id: msg.id,
                    senderId: msg.sender_id,
                    recipientId: msg.recipient_id,
                    content: msg.content,
                    status: msg.status,
                    createdAt: msg.created_at,
                    replyToMessageId: msg.reply_to_message_id,
                };
            }
        }
        // Check if recipient exists
        const recipientCheck = await db_1.pool.query(`SELECT id FROM users WHERE id = $1`, [recipientId]);
        if (recipientCheck.rows.length === 0) {
            throw new Error('Recipient not found');
        }
        // Determine initial status based on recipient presence
        // Wrap Redis call in try-catch to handle Redis failures gracefully
        let recipientOnline = false;
        try {
            recipientOnline = await (0, redis_1.isUserOnline)(recipientId);
        }
        catch (redisErr) {
            console.error('Redis error checking user online status, defaulting to offline:', redisErr);
            // Default to offline if Redis fails
        }
        const initialStatus = recipientOnline ? 'delivered' : 'sent';
        // Insert message
        const { rows } = await db_1.pool.query(`INSERT INTO messages (sender_id, recipient_id, content, status, reply_to_message_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sender_id, recipient_id, content, status, created_at, reply_to_message_id, is_forwarded, is_edited`, [senderId, recipientId, content.trim(), initialStatus, replyToMessageId || null, idempotencyKey || null]);
        const message = rows[0];
        // Update unread counter for recipient (async, non-blocking)
        // IMPORTANT: Increment unread count ONLY for the RECIPIENT, not the sender
        // A message is unread until the recipient actually reads it, regardless of online status
        // "delivered" just means it reached the device, but it's still unread until opened
        // recipientId = the user who RECEIVED the message (should see the badge)
        // senderId = the user who SENT the message (should NOT see the badge)
        console.log(`Incrementing unread count: recipientId=${recipientId}, senderId=${senderId}`);
        (0, redis_1.incrementUnreadCount)(recipientId, senderId).catch((err) => console.error('Failed to increment unread count:', err));
        return {
            id: message.id,
            senderId: message.sender_id,
            recipientId: message.recipient_id,
            content: message.content,
            status: message.status,
            createdAt: message.created_at,
            replyToMessageId: message.reply_to_message_id,
            isForwarded: message.is_forwarded || false,
            isEdited: message.is_edited || false,
            isPinned: false, // New messages are never pinned initially (pinning is tracked in pinned_messages table)
        };
    }
    catch (err) {
        console.error('createMessage error:', {
            message: err.message,
            stack: err.stack,
            code: err.code,
            constraint: err.constraint,
            params: { senderId, recipientId, contentLength: content?.length },
        });
        throw err; // Re-throw to let route handler deal with it
    }
}
