// backend/src/routes/messages.ts
import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { pool } from '../db';
import { emitMessageToUsers } from '../socket';
import {
  isUserOnline,
  setUserPresence,
  incrementUnreadCount,
  resetUnreadCount,
} from '../redis';

const router = Router();

// File handling moved to fileService.ts
// Typing status moved to Redis (see redis.ts)

/**
 * GET /messages/conversation/:userId
 * Get conversation messages between current user and another user
 * Also marks messages as read when the conversation is viewed
 */
router.get('/conversation/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const otherUserId = req.params.userId;

    // Parse pagination parameters (cursor-based)
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 50); // Default 50, max 50
    const before = req.query.before as string | undefined; // Message ID or timestamp to load messages before

    // Optimized: Combine status updates into single query (reduces round trips)
    // Uses partial index for faster updates
    const readResult = await pool.query(
      `WITH updated AS (
        UPDATE messages 
        SET status = CASE 
          WHEN status = 'sent' THEN 'delivered'
          WHEN status != 'read' THEN 'read'
          ELSE status
        END
        WHERE recipient_id = $1 
          AND sender_id = $2 
          AND status IN ('sent', 'delivered')
        RETURNING id, status
      )
      SELECT id FROM updated WHERE status = 'read'`,
      [currentUserId, otherUserId],
    );

    // Reset unread count for this conversation when messages are marked as read
    if (readResult.rows.length > 0) {
      const { resetUnreadCount } = await import('../redis');
      resetUnreadCount(currentUserId, otherUserId).catch((err) =>
        console.error('Failed to reset unread count:', err)
      );
    }

    // Build cursor-based query - load latest messages first, then reverse for chronological order

    // Optimized: Use UNION to leverage separate indexes instead of OR
    // This allows index-only scans on both branches
    let query = `
      (
        SELECT 
          m.id,
          m.sender_id,
          m.recipient_id,
          m.content,
          m.status,
          m.created_at,
          m.reply_to_message_id,
          m.has_attachments,
          COALESCE(m.is_forwarded, FALSE) as is_forwarded,
          COALESCE(m.is_edited, FALSE) as is_edited
        FROM messages m
        WHERE m.sender_id = $1 AND m.recipient_id = $2
    `;
    
    const params: any[] = [currentUserId, otherUserId];
    let paramIndex = 3;
    
    // Add cursor condition if provided (optimized: direct comparison, no subquery)
    if (before) {
      // If before is a UUID, extract timestamp and id for stable cursor
      if (before.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        // Get cursor values from message ID
        const cursorResult = await pool.query(
          `SELECT created_at, id FROM messages WHERE id = $1`,
          [before]
        );
        if (cursorResult.rows.length > 0) {
          const cursor = cursorResult.rows[0];
          query += ` AND (m.created_at < $${paramIndex}::timestamptz OR (m.created_at = $${paramIndex}::timestamptz AND m.id < $${paramIndex + 1}))`;
          params.push(cursor.created_at, cursor.id);
          paramIndex += 2;
        }
      } else {
        // Treat as timestamp
        query += ` AND m.created_at < $${paramIndex}::timestamptz`;
        params.push(before);
        paramIndex++;
      }
    }
    
    query += `)
      UNION ALL
      (
        SELECT 
          m.id,
          m.sender_id,
          m.recipient_id,
          m.content,
          m.status,
          m.created_at,
          m.reply_to_message_id,
          m.has_attachments,
          COALESCE(m.is_forwarded, FALSE) as is_forwarded,
          COALESCE(m.is_edited, FALSE) as is_edited
        FROM messages m
        WHERE m.sender_id = $2 AND m.recipient_id = $1`;
    
    // Add same cursor condition for second branch
    if (before && before.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      if (params.length >= paramIndex) {
        query += ` AND (m.created_at < $${paramIndex - 2}::timestamptz OR (m.created_at = $${paramIndex - 2}::timestamptz AND m.id < $${paramIndex - 1}))`;
      }
    } else if (before) {
      query += ` AND m.created_at < $${paramIndex - 1}::timestamptz`;
    }
    
    query += `
      )
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1}`;
    params.push(limit + 1); // Fetch one extra to determine if there are more
    
    const { rows } = await pool.query(query, params);
    
    // Check if there are more messages
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    
    // Reverse to get chronological order (oldest first)
    messages.reverse();

    // FAST PATH: Only fetch attachments for messages that have the flag (index-only check)
    const messageIds = messages.map((r) => r.id);
    const messagesWithAttachments = messages.filter((m) => m.has_attachments);
    const attachmentMessageIds = messagesWithAttachments.map((m) => m.id);
    
    // Parallel queries for better performance (only fetch what we need)
    const [attachmentsResult, reactionsResult, starredResult, pinnedResult] = await Promise.all([
      // Get attachments (only for messages with has_attachments flag - avoids unnecessary joins)
      attachmentMessageIds.length > 0
        ? pool.query(
            `SELECT 
              message_id,
              id,
              type,
              file_name,
              file_url,
              file_size,
              mime_type,
              thumbnail_url,
              metadata
             FROM message_attachments
             WHERE message_id = ANY($1::uuid[])
             ORDER BY message_id, created_at ASC`,
            [attachmentMessageIds],
          )
        : Promise.resolve({ rows: [] }),
      
      // Get reactions
      messageIds.length > 0
        ? pool.query(
            `SELECT message_id, emoji, user_id
             FROM message_reactions
             WHERE message_id = ANY($1::uuid[])`,
            [messageIds],
          )
        : Promise.resolve({ rows: [] }),
      
      // Get starred status
      messageIds.length > 0
        ? pool.query(
            `SELECT message_id
             FROM starred_messages
             WHERE message_id = ANY($1::uuid[]) AND user_id = $2`,
            [messageIds, currentUserId],
          )
        : Promise.resolve({ rows: [] }),
      
      // Get pinned status (ensure table exists first)
      (async () => {
        if (messageIds.length === 0) return { rows: [] };
        await pool.query(`
          CREATE TABLE IF NOT EXISTS pinned_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (message_id, user_id)
          )
        `).catch(() => {});
        return pool.query(
          `SELECT message_id
           FROM pinned_messages
           WHERE message_id = ANY($1::uuid[]) AND user_id = $2`,
          [messageIds, currentUserId],
        );
      })(),
    ]);

    // Build maps efficiently
    const attachmentsMap = new Map();
    attachmentsResult.rows.forEach((att) => {
      if (!attachmentsMap.has(att.message_id)) {
        attachmentsMap.set(att.message_id, []);
      }
      attachmentsMap.get(att.message_id).push({
        id: att.id,
        type: att.type,
        fileName: att.file_name,
        fileUrl: att.file_url,
        fileSize: att.file_size,
        mimeType: att.mime_type,
        thumbnailUrl: att.thumbnail_url,
        metadata: att.metadata ? (typeof att.metadata === 'string' ? JSON.parse(att.metadata) : att.metadata) : null,
      });
    });

    const reactionsMap = new Map();
    reactionsResult.rows.forEach((r) => {
      if (!reactionsMap.has(r.message_id)) {
        reactionsMap.set(r.message_id, []);
      }
      reactionsMap.get(r.message_id).push({
        emoji: r.emoji,
        userId: r.user_id,
      });
    });

    const starredSet = new Set(starredResult.rows.map((s) => s.message_id));
    const pinnedSet = new Set(pinnedResult.rows.map((p) => p.message_id));

    // Get the oldest message timestamp for next cursor
    const nextCursor = hasMore && messages.length > 0 
      ? messages[0].created_at 
      : null;

    return res.json({
      messages: messages.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        recipientId: m.recipient_id,
        content: m.content,
        status: m.status,
        createdAt: m.created_at,
        replyToMessageId: m.reply_to_message_id ?? null,
        attachments: attachmentsMap.get(m.id) || [],
        reactions: reactionsMap.get(m.id) || [],
        isStarred: starredSet.has(m.id),
        isForwarded: m.is_forwarded || false,
        isEdited: m.is_edited || false,
        isPinned: pinnedSet.has(m.id),
      })),
      hasMore,
      nextCursor,
    });
  } catch (err) {
    console.error('Get conversation error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages
 * Send a new message
 */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const senderId = req.user!.id;
    const { recipientId, content, replyToMessageId, idempotencyKey } = req.body;

    if (!recipientId || !content || !content.trim()) {
      return res.status(400).json({ message: 'Recipient ID and content are required' });
    }

    // Use message service for business logic
    const { createMessage } = await import('../services/messageService');
    const message = await createMessage({
      senderId,
      recipientId,
      content,
      replyToMessageId: replyToMessageId || null,
      idempotencyKey: idempotencyKey || null,
    });

    // Format message for response
    const messageData = {
      id: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
      replyToMessageId: message.replyToMessageId,
    };

    // Emit via WebSocket AFTER persistence (best effort, non-blocking)
    // Use minimal payload: only message ID for initial notification
    emitMessageToUsers(senderId, recipientId, { id: message.id });

    return res.json({
      message: messageData,
    });
  } catch (err: any) {
    console.error('Send message error - Full error details:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      constraint: err.constraint,
      name: err.name,
    });
    
    if (err.message === 'Recipient not found') {
      return res.status(404).json({ message: err.message });
    }
    // Handle unique constraint violation (idempotency key collision)
    if (err.code === '23505' && err.constraint?.includes('idempotency_key')) {
      // Message already exists, fetch and return it
      const { createMessage } = await import('../services/messageService');
      try {
        const existing = await createMessage({
          senderId: req.user!.id,
          recipientId: req.body.recipientId,
          content: req.body.content,
          replyToMessageId: req.body.replyToMessageId || null,
          idempotencyKey: req.body.idempotencyKey || null,
        });
        return res.json({
          message: {
            id: existing.id,
            senderId: existing.senderId,
            recipientId: existing.recipientId,
            content: existing.content,
            status: existing.status,
            createdAt: existing.createdAt.toISOString(),
            replyToMessageId: existing.replyToMessageId,
          },
        });
      } catch (retryErr) {
        console.error('Failed to fetch existing message after idempotency collision:', retryErr);
        // Fall through to error handler
      }
    }
    return res.status(500).json({ 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

/**
 * GET /user/:userId
 * Get user details by ID (for chat interface)
 */
router.get('/user/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const currentUserId = req.user!.id;

    const { rows } = await pool.query(
      `SELECT 
        id,
        display_name,
        username,
        COALESCE(chat_rate_per_second, credit_per_second, 0)::numeric as credit_per_second,
        COALESCE(chat_rate_charging_enabled, FALSE) as chat_rate_charging_enabled,
        last_seen_at
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = rows[0];
    const now = Date.now();
    let activityStatus: 'online' | 'recent' | 'offline' = 'offline';

    if (user.last_seen_at) {
      const lastSeen = new Date(user.last_seen_at as Date).getTime();
      const diffMs = now - lastSeen;
      const diffMinutes = diffMs / (1000 * 60);
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      if (diffMinutes <= 2) {
        activityStatus = 'online';
      } else if (diffDays <= 3) {
        activityStatus = 'recent';
      } else {
        activityStatus = 'offline';
      }
    }

    return res.json({
      id: user.id,
      displayName: user.display_name,
      username: user.username,
      creditPerSecond: Number(user.credit_per_second) ?? 0,
      rateChargingEnabled: user.chat_rate_charging_enabled ?? false,
      activityStatus,
    });
  } catch (err) {
    console.error('Get user error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/upload
 * Upload a file attachment (FAST PATH: create message immediately, SLOW PATH: upload media async)
 * 
 * This endpoint follows the WhatsApp pattern:
 * - FAST PATH: Create message immediately, ACK to client
 * - SLOW PATH: Upload media asynchronously, update message when done
 */
router.post('/upload', authenticateToken, async (req: Request, res: Response) => {
  try {
    const senderId = req.user!.id;
    const { recipientId, fileData, fileName, mimeType, type, metadata, thumbnailUrl, chunkIndex, totalChunks, uploadId } = req.body;

    if (!recipientId || !fileData || !fileName || !type) {
      return res.status(400).json({ message: 'Recipient ID, file data, file name, and type are required' });
    }

    // Validate type
    const validTypes = ['media', 'link', 'document', 'contact', 'audio', 'video', 'image'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: 'Invalid attachment type' });
    }

    // HARD GATE: Validate file size BEFORE upload starts (WhatsApp pattern)
    const { base64ToBuffer, validateFileBeforeUpload } = await import('../services/fileService');
    const fileBuffer = base64ToBuffer(fileData);
    const fileSize = fileBuffer.length;
    
    const validation = validateFileBeforeUpload(fileSize, mimeType);
    if (!validation.valid) {
      return res.status(400).json({ message: validation.error || 'File validation failed' });
    }

    // Handle chunked uploads (for large files > 10MB)
    if (chunkIndex !== undefined && totalChunks !== undefined && uploadId) {
      const { uploadChunk } = await import('../services/mediaService');
      
      // If this is the first chunk, create message FIRST (FAST PATH)
      let messageId: string | undefined;
      if (chunkIndex === 0) {
        const { createMessage } = await import('../services/messageService');
        const message = await createMessage({
          senderId,
          recipientId,
          content: fileName,
          replyToMessageId: null,
        });
        messageId = message.id;

        // Mark as pending
        await pool.query(
          `UPDATE messages SET has_attachments = TRUE, media_status = 'pending' WHERE id = $1`,
          [messageId]
        );

        // Emit via WebSocket immediately
        emitMessageToUsers(senderId, recipientId, { id: message.id });
      }

      // Process chunk
      const result = await uploadChunk({
        messageId: messageId || '', // Use existing messageId if not first chunk
        fileData,
        fileName,
        mimeType,
        type,
        metadata,
        thumbnailUrl,
        chunkIndex,
        totalChunks,
        uploadId,
      });

      // If first chunk, return message + progress
      if (chunkIndex === 0 && messageId) {
        return res.json({
          message: {
            id: messageId,
            senderId,
            recipientId,
            content: fileName,
            status: 'sent',
            createdAt: new Date().toISOString(),
            hasAttachments: true,
            attachmentPending: true,
          },
          uploadProgress: result.progress,
          uploadComplete: result.complete,
          uploadId,
        });
      }

      // Subsequent chunks - return progress only
      return res.json({
        uploadProgress: result.progress,
        uploadComplete: result.complete,
        uploadId,
      });
    }

    // FAST PATH: Create message immediately (don't wait for media upload)
    const { createMessage } = await import('../services/messageService');
    const message = await createMessage({
      senderId,
      recipientId,
      content: fileName, // Use filename as placeholder
      replyToMessageId: null,
    });

    // Mark message as having attachments with pending status (even before upload completes)
    await pool.query(
      `UPDATE messages SET has_attachments = TRUE, media_status = 'pending' WHERE id = $1`,
      [message.id]
    );

    // Emit via WebSocket immediately (minimal payload - ID only)
    emitMessageToUsers(senderId, recipientId, { id: message.id });

    // SLOW PATH: Queue media upload asynchronously (non-blocking)
    const { queueMediaUpload } = await import('../services/mediaService');
    queueMediaUpload({
      messageId: message.id,
      fileData,
      fileName,
      mimeType,
      type,
      metadata,
      thumbnailUrl,
    }).catch((err) => {
      console.error('Failed to queue media upload:', err);
      // Don't fail the request - message is already created
    });

    // Return immediately with message (media will be attached async)
    return res.json({
      message: {
        id: message.id,
        senderId: message.senderId,
        recipientId: message.recipientId,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
        // Attachment will be added asynchronously - client can fetch via reconciliation
        hasAttachments: true,
        attachmentPending: true, // Signal that attachment is being uploaded
      },
    });
  } catch (err) {
    console.error('Upload file error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/upload/cancel
 * Cancel an ongoing upload (non-blocking)
 */
router.post('/upload/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.body;
    
    if (!uploadId) {
      return res.status(400).json({ message: 'Upload ID is required' });
    }

    const { cancelUpload } = await import('../services/mediaService');
    cancelUpload(uploadId);

    return res.json({ success: true, message: 'Upload cancelled' });
  } catch (err) {
    console.error('Cancel upload error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/upload/progress/:uploadId
 * Get upload progress for chunked uploads
 */
router.get('/upload/progress/:uploadId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.params;
    
    const { getUploadProgress } = await import('../services/mediaService');
    const progress = getUploadProgress(uploadId);

    if (progress === null) {
      return res.status(404).json({ message: 'Upload not found' });
    }

    return res.json({ progress, uploadId });
  } catch (err) {
    console.error('Get upload progress error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/unread-count
 * Get count of unique users with unread messages (for HomeScreen badge)
 * This is different from the total unread message count - it counts conversations, not messages
 */
router.get('/unread-count', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const { getAllUnreadCounts } = await import('../redis');

    // Try Redis first (fast)
    // getAllUnreadCounts returns Map<senderId, count> for messages received by currentUserId
    // Count unique users (senders) who have unread messages TO currentUserId
    const redisCounts = await getAllUnreadCounts(currentUserId);
    console.log(`[UnreadCount API] User ${currentUserId} has unread messages from ${redisCounts.size} unique senders:`, Array.from(redisCounts.keys()));
    if (redisCounts.size > 0) {
      // Count unique users (keys in the map), not total messages
      const uniqueUsersCount = redisCounts.size;
      return res.json({ unreadCount: uniqueUsersCount });
    }

    // Fallback to DB if Redis unavailable
    // Count DISTINCT sender_id to get number of unique users with unread messages
    // IMPORTANT: Only count messages where currentUserId is the RECIPIENT
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT sender_id) as unread_users_count
       FROM messages
       WHERE recipient_id = $1
         AND status != 'read'`,
      [currentUserId],
    );

    const unreadCount = parseInt(rows[0].unread_users_count, 10) || 0;
    console.log(`[UnreadCount API] User ${currentUserId} has ${unreadCount} unique senders with unread messages (from DB)`);
    return res.json({ unreadCount });
  } catch (err) {
    console.error('Get unread count error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/reconcile
 * Reconciliation endpoint for clients to sync messages
 * Returns messages since a given timestamp or message ID
 */
router.get('/reconcile', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const since = req.query.since as string; // Message ID or timestamp
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    let query = `
      SELECT 
        m.id,
        m.sender_id,
        m.recipient_id,
        m.content,
        m.status,
        m.created_at,
        m.reply_to_message_id,
        m.has_attachments,
        COALESCE(m.is_forwarded, FALSE) as is_forwarded,
        COALESCE(m.is_edited, FALSE) as is_edited
      FROM messages m
      WHERE (m.sender_id = $1 OR m.recipient_id = $1)
    `;
    const params: any[] = [currentUserId];

    if (since) {
      // If since is a UUID (message ID), use it for stable cursor
      if (since.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        // Get cursor values (single index lookup)
        const cursorResult = await pool.query(
          `SELECT created_at, id FROM messages WHERE id = $1 LIMIT 1`,
          [since]
        );
        if (cursorResult.rows.length > 0) {
          const cursor = cursorResult.rows[0];
          query += ` AND (m.created_at > $2::timestamptz OR (m.created_at = $2::timestamptz AND m.id > $3))`;
          params.push(cursor.created_at, cursor.id);
        }
      } else {
        // Otherwise treat as timestamp
        query += ` AND m.created_at > $2::timestamptz`;
        params.push(since);
      }
    }

    query += ` ORDER BY m.created_at ASC, m.id ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);

    return res.json({
      messages: rows.map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        recipientId: row.recipient_id,
        content: row.content,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        replyToMessageId: row.reply_to_message_id,
        isForwarded: row.is_forwarded,
        isEdited: row.is_edited,
      })),
      hasMore: rows.length === limit,
    });
  } catch (err) {
    console.error('Reconcile error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * PUT /messages/batch-status
 * Batch update message statuses (WhatsApp pattern: reduce network overhead)
 */
router.put('/batch-status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const { messageIds, status } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ message: 'Message IDs array is required' });
    }

    if (!['delivered', 'read'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    // Batch update statuses (optimized single query)
    const { rows } = await pool.query(
      `UPDATE messages 
       SET status = $1
       WHERE id = ANY($2::uuid[])
         AND recipient_id = $3
         AND status != 'read' -- Don't downgrade from read
       RETURNING id`,
      [status, messageIds, currentUserId],
    );

    return res.json({
      updated: rows.length,
      messageIds: rows.map((r) => r.id),
    });
  } catch (err) {
    console.error('Batch status update error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/chats
 * Get list of all conversations with last message, time, and unread count
 */
router.get('/chats', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;

    // Optimized: Split into multiple cheap queries to avoid GROUP BY and complex CTEs
    // Query 1: Get distinct conversation partners (index scan)
    const partnersResult = await pool.query(
      `SELECT DISTINCT
        CASE 
          WHEN sender_id = $1 THEN recipient_id
          ELSE sender_id
        END as partner_id
      FROM messages
      WHERE sender_id = $1 OR recipient_id = $1`,
      [currentUserId],
    );
    
    const partnerIds = partnersResult.rows.map((r) => r.partner_id);
    if (partnerIds.length === 0) {
      return res.json({ chats: [] });
    }

    // Query 2: Get last message per conversation (using DISTINCT ON - faster than window function)
    const lastMessagesResult = await pool.query(
      `SELECT DISTINCT ON (
        CASE 
          WHEN sender_id = $1 THEN recipient_id
          ELSE sender_id
        END
      )
        CASE 
          WHEN sender_id = $1 THEN recipient_id
          ELSE sender_id
        END as partner_id,
        id as message_id,
        content,
        status,
        created_at,
        sender_id
      FROM messages
      WHERE sender_id = $1 OR recipient_id = $1
      ORDER BY 
        CASE 
          WHEN sender_id = $1 THEN recipient_id
          ELSE sender_id
        END,
        created_at DESC`,
      [currentUserId],
    );

    const lastMessagesMap = new Map(
      lastMessagesResult.rows.map((r) => [r.partner_id, r])
    );

    // Query 3: Get unread counts (using partial index - no GROUP BY needed)
    // IMPORTANT: Only count messages where currentUserId is the RECIPIENT (not sender)
    // Use Redis if available, otherwise fallback to DB
    const { getAllUnreadCounts } = await import('../redis');
    let unreadCountsMap: Map<string, number>;
    try {
      // getAllUnreadCounts returns Map<senderId, count> for messages received by currentUserId
      unreadCountsMap = await getAllUnreadCounts(currentUserId);
      console.log(`Unread counts for user ${currentUserId}:`, Array.from(unreadCountsMap.entries()));
    } catch {
      // Fallback: single query with partial index (faster than GROUP BY)
      // Only count messages where currentUserId is the recipient
      const unreadResult = await pool.query(
        `SELECT sender_id, COUNT(*) as unread_count
        FROM messages
        WHERE recipient_id = $1 AND status != 'read'
        GROUP BY sender_id`,
        [currentUserId],
      );
      unreadCountsMap = new Map(
        unreadResult.rows.map((r) => [r.sender_id, parseInt(r.unread_count, 10)])
      );
      console.log(`Unread counts from DB for user ${currentUserId}:`, Array.from(unreadCountsMap.entries()));
    }

    // Query 4: Get user details (single query with IN clause)
    const usersResult = await pool.query(
      `SELECT id, display_name, username
      FROM users
      WHERE id = ANY($1::uuid[]) AND is_active = TRUE`,
      [partnerIds],
    );

    const usersMap = new Map(usersResult.rows.map((u) => [u.id, u]));

    // Combine results
    const chats = partnerIds
      .map((partnerId) => {
        const user = usersMap.get(partnerId);
        if (!user) return null;

        const lastMessage = lastMessagesMap.get(partnerId);
        // unreadCountsMap contains { senderId: count } where senderId sent messages TO currentUserId
        // So for a chat with partnerId, we look up how many unread messages partnerId sent to currentUserId
        // This should ONLY be > 0 if partnerId sent messages to currentUserId (currentUserId is the recipient)
        const unreadCount = unreadCountsMap.get(partnerId) || 0;
        
        // Debug: Log unread count for this chat
        if (unreadCount > 0) {
          console.log(`[ChatList] User ${currentUserId} has ${unreadCount} unread messages from ${partnerId} (${user.display_name || user.username})`);
        }

        return {
          id: user.id,
          userId: user.id,
          userName: user.display_name || user.username || 'Unknown',
          userAvatar: null,
          lastMessage: lastMessage?.content || null,
          lastMessageTime: lastMessage?.created_at || null,
          lastMessageStatus: lastMessage?.sender_id === currentUserId ? lastMessage?.status : undefined,
          unreadCount,
          isPinned: false,
          isStarred: false,
        };
      })
      .filter((chat) => chat !== null)
      .sort((a, b) => {
        const timeA = a?.lastMessageTime || new Date(0);
        const timeB = b?.lastMessageTime || new Date(0);
        return timeB.getTime() - timeA.getTime();
      });

    return res.json({ chats });
  } catch (err) {
    console.error('Get chats error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/typing/:userId
 * Set typing status for a conversation
 */
router.post('/typing/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const otherUserId = req.params.userId;

    if (!otherUserId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Store typing status in Redis (FAST PATH - non-blocking)
    const { setTypingStatus } = await import('../redis');
    setTypingStatus(currentUserId, otherUserId, true).catch((err) =>
      console.error('Failed to set typing status:', err)
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('Set typing status error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/typing/:userId
 * Get typing status for a conversation
 */
router.get('/typing/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const otherUserId = req.params.userId;

    if (!otherUserId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Check typing status from Redis (FAST PATH)
    const { getTypingStatus } = await import('../redis');
    const isTyping = await getTypingStatus(otherUserId, currentUserId);

    return res.json({ isTyping });
  } catch (err) {
    console.error('Get typing status error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/typing/:userId
 * Indicate that the current user is typing to another user
 */
router.post('/typing/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const recipientId = req.params.userId;

    // Store typing status in Redis (FAST PATH - non-blocking)
    const { setTypingStatus } = await import('../redis');
    setTypingStatus(currentUserId, recipientId, true).catch((err) =>
      console.error('Failed to set typing status:', err)
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('Set typing status error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/typing/:userId
 * Check if the other user is typing
 */
router.get('/typing/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const otherUserId = req.params.userId;

    // Check typing status from Redis (FAST PATH)
    const { getTypingStatus } = await import('../redis');
    const isTyping = await getTypingStatus(otherUserId, currentUserId);

    return res.json({ isTyping });
  } catch (err) {
    console.error('Get typing status error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/attachments/:userId
 * Get all attachments (media, links, docs) for a conversation
 */
router.get('/attachments/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const otherUserId = req.params.userId;
    const { type } = req.query; // Optional filter: 'media', 'link', 'document', etc.

    let query = `
      SELECT 
        ma.id,
        ma.type,
        ma.file_name,
        ma.file_url,
        ma.file_size,
        ma.mime_type,
        ma.thumbnail_url,
        ma.metadata,
        ma.created_at,
        m.sender_id,
        m.recipient_id
      FROM message_attachments ma
      INNER JOIN messages m ON ma.message_id = m.id
      WHERE (m.sender_id = $1 AND m.recipient_id = $2)
         OR (m.sender_id = $2 AND m.recipient_id = $1)
    `;

    const params: any[] = [currentUserId, otherUserId];

    if (type && typeof type === 'string') {
      query += ` AND ma.type = $3`;
      params.push(type);
    }

    query += ` ORDER BY ma.created_at DESC`;

    const { rows } = await pool.query(query, params);

    return res.json({
      attachments: rows.map((row) => ({
        id: row.id,
        type: row.type,
        fileName: row.file_name,
        fileUrl: row.file_url,
        fileSize: row.file_size,
        mimeType: row.mime_type,
        thumbnailUrl: row.thumbnail_url,
        metadata: row.metadata,
        createdAt: row.created_at,
        senderId: row.sender_id,
        recipientId: row.recipient_id,
      })),
    });
  } catch (err) {
    console.error('Get attachments error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/:messageId/star
 * Star or unstar a message
 */
router.post('/:messageId/star', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const messageId = req.params.messageId;

    // Check if message exists and user has access
    const { rows: messageRows } = await pool.query(
      `SELECT id FROM messages 
       WHERE id = $1 
         AND (sender_id = $2 OR recipient_id = $2)`,
      [messageId, currentUserId],
    );

    if (messageRows.length === 0) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if already starred
    const { rows: starredRows } = await pool.query(
      `SELECT id FROM starred_messages 
       WHERE message_id = $1 AND user_id = $2`,
      [messageId, currentUserId],
    );

    if (starredRows.length > 0) {
      // Unstar
      await pool.query(
        `DELETE FROM starred_messages 
         WHERE message_id = $1 AND user_id = $2`,
        [messageId, currentUserId],
      );
      return res.json({ isStarred: false });
    } else {
      // Star
      await pool.query(
        `INSERT INTO starred_messages (message_id, user_id) 
         VALUES ($1, $2)`,
        [messageId, currentUserId],
      );
      return res.json({ isStarred: true });
    }
  } catch (err) {
    console.error('Star message error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/:messageId/reaction
 * Add or remove a reaction to a message
 * Note: This route must come after /:messageId/star to avoid route conflicts
 */
router.post('/:messageId/reaction', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const messageId = req.params.messageId;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ message: 'Emoji is required' });
    }

    // Check if message exists and user has access
    const { rows: messageRows } = await pool.query(
      `SELECT id FROM messages 
       WHERE id = $1 
         AND (sender_id = $2 OR recipient_id = $2)`,
      [messageId, currentUserId],
    );

    if (messageRows.length === 0) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if user already has a reaction on this message (any emoji)
    const { rows: existingReactionRows } = await pool.query(
      `SELECT id, emoji FROM message_reactions 
       WHERE message_id = $1 AND user_id = $2`,
      [messageId, currentUserId],
    );

    if (existingReactionRows.length > 0) {
      const existingEmoji = existingReactionRows[0].emoji;
      
      if (existingEmoji === emoji) {
        // Same emoji - remove reaction (toggle off)
        await pool.query(
          `DELETE FROM message_reactions 
           WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
          [messageId, currentUserId, emoji],
        );
        return res.json({ added: false });
      } else {
        // Different emoji - replace existing reaction
        await pool.query(
          `UPDATE message_reactions 
           SET emoji = $3 
           WHERE message_id = $1 AND user_id = $2`,
          [messageId, currentUserId, emoji],
        );
        return res.json({ added: true, replaced: true });
      }
    } else {
      // No existing reaction - add new one
      await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) 
         VALUES ($1, $2, $3)`,
        [messageId, currentUserId, emoji],
      );
      return res.json({ added: true });
    }
  } catch (err) {
    console.error('Reaction error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/forward
 * Forward one or more messages to a recipient
 */
router.post('/forward', authenticateToken, async (req: Request, res: Response) => {
  try {
    const senderId = req.user!.id;
    const { messageIds, recipientId } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ message: 'Message IDs array is required' });
    }

    if (!recipientId) {
      return res.status(400).json({ message: 'Recipient ID is required' });
    }

    // Check if recipient exists
    const recipientCheck = await pool.query(
      `SELECT id, last_seen_at FROM users WHERE id = $1`,
      [recipientId]
    );
    
    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recipient not found' });
    }

    const recipient = recipientCheck.rows[0];
    let initialStatus = 'sent';
    
    // Check if recipient is online (active within last 2 minutes)
    if (recipient.last_seen_at) {
      const lastSeen = new Date(recipient.last_seen_at as Date).getTime();
      const now = Date.now();
      const diffMinutes = (now - lastSeen) / (1000 * 60);
      
      if (diffMinutes <= 2) {
        initialStatus = 'delivered';
      }
    }

    // Get the original messages to forward
    const { rows: originalMessages } = await pool.query(
      `SELECT m.id, m.content, m.reply_to_message_id, m.has_attachments,
              a.id as attachment_id, a.type, a.file_name, a.file_url, a.file_size, 
              a.mime_type, a.thumbnail_url, a.metadata
       FROM messages m
       LEFT JOIN message_attachments a ON m.id = a.message_id
       WHERE m.id = ANY($1::uuid[])
       ORDER BY m.created_at ASC`,
      [messageIds]
    );

    if (originalMessages.length === 0) {
      return res.status(404).json({ message: 'No messages found to forward' });
    }

    // Group messages by message ID to handle attachments
    const messagesMap = new Map();
    originalMessages.forEach((row) => {
      if (!messagesMap.has(row.id)) {
        messagesMap.set(row.id, {
          id: row.id,
          content: row.content,
          replyToMessageId: row.reply_to_message_id,
          hasAttachments: row.has_attachments,
          attachments: [],
        });
      }
      if (row.attachment_id) {
        messagesMap.get(row.id).attachments.push({
          id: row.attachment_id,
          type: row.type,
          fileName: row.file_name,
          fileUrl: row.file_url,
          fileSize: row.file_size,
          mimeType: row.mime_type,
          thumbnailUrl: row.thumbnail_url,
          metadata: row.metadata,
        });
      }
    });

    const messagesToForward = Array.from(messagesMap.values());
    const forwardedMessages = [];

    // Forward each message
    for (const originalMessage of messagesToForward) {
      // Create new message with forwarded content
      // First, ensure is_forwarded column exists (for backward compatibility)
      await pool.query(`
        ALTER TABLE messages 
        ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE
      `).catch(() => {
        // Column might already exist, ignore error
      });

      const { rows: newMessageRows } = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, content, status, reply_to_message_id, has_attachments, is_forwarded)
         VALUES ($1, $2, $3, $4, NULL, $5, TRUE)
         RETURNING id, sender_id, recipient_id, content, status, created_at, reply_to_message_id, is_forwarded`,
        [
          senderId,
          recipientId,
          originalMessage.content,
          initialStatus,
          originalMessage.hasAttachments || false,
        ]
      );

      const newMessage = newMessageRows[0];

      // Forward attachments if any
      if (originalMessage.attachments.length > 0) {
        for (const attachment of originalMessage.attachments) {
          await pool.query(
            `INSERT INTO message_attachments 
             (message_id, type, file_name, file_url, file_size, mime_type, thumbnail_url, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              newMessage.id,
              attachment.type,
              attachment.fileName,
              attachment.fileUrl,
              attachment.fileSize,
              attachment.mimeType,
              attachment.thumbnailUrl,
              attachment.metadata ? JSON.stringify(attachment.metadata) : null,
            ]
          );
        }
      }

      forwardedMessages.push({
        id: newMessage.id,
        senderId: newMessage.sender_id,
        recipientId: newMessage.recipient_id,
        content: newMessage.content,
        status: newMessage.status,
        createdAt: newMessage.created_at,
        replyToMessageId: newMessage.reply_to_message_id,
        isForwarded: newMessage.is_forwarded || true,
      });
    }

    return res.json({
      success: true,
      messages: forwardedMessages,
      count: forwardedMessages.length,
    });
  } catch (err) {
    console.error('Forward messages error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * PATCH /messages/:id
 * Edit a message (only within 15 minutes of sending)
 */
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const messageId = req.params.id;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Content is required' });
    }

    // Get the message
    const { rows: messageRows } = await pool.query(
      `SELECT id, sender_id, created_at, has_attachments
       FROM messages
       WHERE id = $1`,
      [messageId]
    );

    if (messageRows.length === 0) {
      return res.status(404).json({ message: 'Message not found' });
    }

    const message = messageRows[0];

    // Check if user is the sender
    if (message.sender_id !== currentUserId) {
      return res.status(403).json({ message: 'You can only edit your own messages' });
    }

    // Check if message is within 15 minutes
    const messageTime = new Date(message.created_at as Date).getTime();
    const now = Date.now();
    const fifteenMinutes = 15 * 60 * 1000;
    if ((now - messageTime) > fifteenMinutes) {
      return res.status(400).json({ message: 'You can only edit messages within 15 minutes of sending' });
    }

    // Check if message has attachments without caption (content is just filename)
    if (message.has_attachments) {
      const { rows: attachmentRows } = await pool.query(
        `SELECT file_name FROM message_attachments WHERE message_id = $1`,
        [messageId]
      );
      const isJustFilename = attachmentRows.some(att => message.content === att.file_name);
      if (isJustFilename && !content.trim()) {
        return res.status(400).json({ message: 'Cannot edit messages with attachments that have no caption' });
      }
    }

    // Ensure is_edited column exists (for backward compatibility)
    await pool.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS is_edited BOOLEAN NOT NULL DEFAULT FALSE
    `).catch(() => {
      // Column might already exist, ignore error
    });

    // Update the message
    const { rows: updatedRows } = await pool.query(
      `UPDATE messages 
       SET content = $1, updated_at = NOW(), is_edited = TRUE
       WHERE id = $2
       RETURNING id, sender_id, recipient_id, content, status, created_at, reply_to_message_id, is_edited`,
      [content.trim(), messageId]
    );

    return res.json({
      message: {
        id: updatedRows[0].id,
        senderId: updatedRows[0].sender_id,
        recipientId: updatedRows[0].recipient_id,
        content: updatedRows[0].content,
        status: updatedRows[0].status,
        createdAt: updatedRows[0].created_at,
        replyToMessageId: updatedRows[0].reply_to_message_id,
        isEdited: updatedRows[0].is_edited || false,
      },
    });
  } catch (err) {
    console.error('Edit message error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/:id/pin
 * Pin a message
 */
router.post('/:id/pin', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const messageId = req.params.id;

    // Ensure pinned_messages table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (message_id, user_id)
      )
    `).catch(() => {
      // Table might already exist
    });

    // Check if message exists and user has access
    const { rows: messageRows } = await pool.query(
      `SELECT m.id, m.sender_id, m.recipient_id
       FROM messages m
       WHERE m.id = $1 AND (m.sender_id = $2 OR m.recipient_id = $2)`,
      [messageId, currentUserId]
    );

    if (messageRows.length === 0) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Insert or update pinned message
    await pool.query(
      `INSERT INTO pinned_messages (message_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [messageId, currentUserId]
    );

    return res.json({ success: true, isPinned: true });
  } catch (err) {
    console.error('Pin message error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /messages/:id/unpin
 * Unpin a message
 */
router.post('/:id/unpin', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const messageId = req.params.id;

    // Delete pinned message
    await pool.query(
      `DELETE FROM pinned_messages 
       WHERE message_id = $1 AND user_id = $2`,
      [messageId, currentUserId]
    );

    return res.json({ success: true, isPinned: false });
  } catch (err) {
    console.error('Unpin message error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;

