/**
 * Message service - handles message persistence and business logic
 * Separated from socket/HTTP concerns for better testability and maintainability
 */
import { pool } from '../db';
import { isUserOnline, incrementUnreadCount } from '../redis';

export interface CreateMessageParams {
  senderId: string;
  recipientId: string;
  content: string;
  replyToMessageId?: string | null;
  idempotencyKey?: string | null;
}

export interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  status: 'sent' | 'delivered' | 'read';
  createdAt: Date;
  replyToMessageId: string | null;
  isForwarded?: boolean;
  isEdited?: boolean;
  isPinned?: boolean;
}

/**
 * Create a new message
 * Returns the created message
 */
export async function createMessage(params: CreateMessageParams): Promise<Message> {
  const { senderId, recipientId, content, replyToMessageId, idempotencyKey } = params;

  try {
    // Check idempotency if key provided
    if (idempotencyKey) {
      const existing = await pool.query(
        `SELECT id, sender_id, recipient_id, content, status, created_at, reply_to_message_id
         FROM messages WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
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
    const recipientCheck = await pool.query(`SELECT id FROM users WHERE id = $1`, [recipientId]);
    if (recipientCheck.rows.length === 0) {
      throw new Error('Recipient not found');
    }

    // Determine initial status based on recipient presence
    // Wrap Redis call in try-catch to handle Redis failures gracefully
    let recipientOnline = false;
    try {
      recipientOnline = await isUserOnline(recipientId);
    } catch (redisErr) {
      console.error('Redis error checking user online status, defaulting to offline:', redisErr);
      // Default to offline if Redis fails
    }
    const initialStatus = recipientOnline ? 'delivered' : 'sent';

    // Insert message
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content, status, reply_to_message_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sender_id, recipient_id, content, status, created_at, reply_to_message_id, is_forwarded, is_edited`,
      [senderId, recipientId, content.trim(), initialStatus, replyToMessageId || null, idempotencyKey || null],
    );

    const message = rows[0];

    // Update unread counter for recipient (async, non-blocking)
    // IMPORTANT: Increment unread count for the RECIPIENT, not the sender
    // A message is unread until the recipient actually reads it, regardless of online status
    // "delivered" just means it reached the device, but it's still unread until opened
    incrementUnreadCount(recipientId, senderId).catch((err) =>
      console.error('Failed to increment unread count:', err)
    );

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
  } catch (err: any) {
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

