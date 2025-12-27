// backend/src/routes/messages.ts
import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { pool } from '../db';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const router = Router();

// Ensure uploads directory exists
const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads');
const ensureUploadsDir = async () => {
  if (!existsSync(UPLOADS_DIR)) {
    await mkdir(UPLOADS_DIR, { recursive: true });
  }
};
ensureUploadsDir();

// In-memory store for typing status (userId -> { typingUserId: timestamp })
// In production, consider using Redis or a database table
const typingStatus = new Map<string, Map<string, number>>();

// Clean up stale typing status (older than 3 seconds)
setInterval(() => {
  const now = Date.now();
  typingStatus.forEach((userMap, userId) => {
    userMap.forEach((timestamp, typingUserId) => {
      if (now - timestamp > 3000) {
        userMap.delete(typingUserId);
      }
    });
    if (userMap.size === 0) {
      typingStatus.delete(userId);
    }
  });
}, 1000);

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

    // First, mark any "sent" messages as "delivered" when user views conversation
    // (This handles the case where user was offline when message was sent)
    await pool.query(
      `UPDATE messages 
       SET status = 'delivered' 
       WHERE recipient_id = $1 
         AND sender_id = $2 
         AND status = 'sent'`,
      [currentUserId, otherUserId],
    );

    // Then mark messages as read (messages sent to current user from other user)
    await pool.query(
      `UPDATE messages 
       SET status = 'read' 
       WHERE recipient_id = $1 
         AND sender_id = $2 
         AND status != 'read'`,
      [currentUserId, otherUserId],
    );

    // Build cursor-based query - load latest messages first, then reverse for chronological order
    // Ensure is_forwarded column exists (for backward compatibility)
    await pool.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE
    `).catch(() => {
      // Column might already exist, ignore error
    });

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
        COALESCE(m.is_forwarded, FALSE) as is_forwarded
       FROM messages m
       WHERE (m.sender_id = $1 AND m.recipient_id = $2)
          OR (m.sender_id = $2 AND m.recipient_id = $1)
    `;
    
    const params: any[] = [currentUserId, otherUserId];
    
    // Add cursor condition if provided
    if (before) {
      // If before is a UUID, use it as message ID cursor
      if (before.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        query += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = $3)`;
        params.push(before);
      } else {
        // Otherwise treat as timestamp
        query += ` AND m.created_at < $3::timestamptz`;
        params.push(before);
      }
    }
    
    query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1); // Fetch one extra to determine if there are more
    
    const { rows } = await pool.query(query, params);
    
    // Check if there are more messages
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    
    // Reverse to get chronological order (oldest first)
    messages.reverse();

    // Get attachments for all messages
    const messageIds = messages.map((r) => r.id);
    let attachmentsMap = new Map();
    if (messageIds.length > 0) {
      const { rows: attachmentRows } = await pool.query(
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
         ORDER BY created_at ASC`,
        [messageIds],
      );
      
      attachmentRows.forEach((att) => {
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
    }

    // Get reactions for all messages
    let reactionsMap = new Map();
    if (messageIds.length > 0) {
      const { rows: reactionRows } = await pool.query(
        `SELECT 
          message_id,
          emoji,
          user_id
         FROM message_reactions
         WHERE message_id = ANY($1::uuid[])`,
        [messageIds],
      );
      
      reactionRows.forEach((r) => {
        if (!reactionsMap.has(r.message_id)) {
          reactionsMap.set(r.message_id, []);
        }
        reactionsMap.get(r.message_id).push({
          emoji: r.emoji,
          userId: r.user_id,
        });
      });
    }

    // Get starred status for current user
    let starredSet = new Set();
    if (messageIds.length > 0) {
      const { rows: starredRows } = await pool.query(
        `SELECT message_id
         FROM starred_messages
         WHERE message_id = ANY($1::uuid[])
           AND user_id = $2`,
        [messageIds, currentUserId],
      );
      starredRows.forEach((s) => starredSet.add(s.message_id));
    }

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
    const { recipientId, content, replyToMessageId } = req.body;

    if (!recipientId || !content || !content.trim()) {
      return res.status(400).json({ message: 'Recipient ID and content are required' });
    }

    // Check if recipient is online (active within last 2 minutes)
    const recipientCheck = await pool.query(
      `SELECT id, last_seen_at FROM users WHERE id = $1`,
      [recipientId]
    );
    
    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recipient not found' });
    }

    const recipient = recipientCheck.rows[0];
    let initialStatus = 'sent'; // Default to sent for offline users
    
    // Check if recipient is online (active within last 2 minutes)
    if (recipient.last_seen_at) {
      const lastSeen = new Date(recipient.last_seen_at as Date).getTime();
      const now = Date.now();
      const diffMinutes = (now - lastSeen) / (1000 * 60);
      
      if (diffMinutes <= 2) {
        // Recipient is online, mark as delivered
        initialStatus = 'delivered';
      }
    }

    // Insert message with appropriate status
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content, status, reply_to_message_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sender_id, recipient_id, content, status, created_at, reply_to_message_id`,
      [senderId, recipientId, content.trim(), initialStatus, replyToMessageId || null],
    );

    const message = rows[0];

    return res.json({
      message: {
        id: message.id,
        senderId: message.sender_id,
        recipientId: message.recipient_id,
        content: message.content,
        status: message.status,
        createdAt: message.created_at,
        replyToMessageId: message.reply_to_message_id,
      },
    });
  } catch (err) {
    console.error('Send message error', err);
    return res.status(500).json({ message: 'Internal server error' });
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
 * Upload a file attachment (image, video, audio, document, etc.)
 */
router.post('/upload', authenticateToken, async (req: Request, res: Response) => {
  try {
    const senderId = req.user!.id;
    const { recipientId, fileData, fileName, mimeType, type, metadata, thumbnailUrl } = req.body;

    if (!recipientId || !fileData || !fileName || !type) {
      return res.status(400).json({ message: 'Recipient ID, file data, file name, and type are required' });
    }

    // Validate type
    const validTypes = ['media', 'link', 'document', 'contact', 'audio', 'video', 'image'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: 'Invalid attachment type' });
    }

    // Generate unique filename
    const fileExt = fileName.split('.').pop() || '';
    const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
    const filePath = join(UPLOADS_DIR, uniqueFileName);

    // Handle base64 file data
    let fileBuffer: Buffer;
    if (fileData.startsWith('data:')) {
      // Base64 with data URI prefix
      const base64Data = fileData.split(',')[1];
      fileBuffer = Buffer.from(base64Data, 'base64');
    } else {
      // Plain base64
      fileBuffer = Buffer.from(fileData, 'base64');
    }

    // Save file
    await writeFile(filePath, fileBuffer);

    // Get file size
    const fileSize = fileBuffer.length;

    // Create file URL (in production, this would be a CDN URL)
    const fileUrl = `/uploads/${uniqueFileName}`;

    // Check if recipient exists and is online (active within last 2 minutes)
    const recipientCheck = await pool.query(
      `SELECT id, last_seen_at FROM users WHERE id = $1`,
      [recipientId]
    );
    
    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recipient not found' });
    }

    const recipient = recipientCheck.rows[0];
    let initialStatus = 'sent'; // Default to sent for offline users
    
    // Check if recipient is online (active within last 2 minutes)
    if (recipient.last_seen_at) {
      const lastSeen = new Date(recipient.last_seen_at as Date).getTime();
      const now = Date.now();
      const diffMinutes = (now - lastSeen) / (1000 * 60);
      
      if (diffMinutes <= 2) {
        // Recipient is online, mark as delivered
        initialStatus = 'delivered';
      }
    }

    // Create message with attachment
    const { rows: messageRows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content, status, has_attachments)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, sender_id, recipient_id, content, status, created_at`,
      [senderId, recipientId, fileName, initialStatus], // Use filename as content placeholder
    );

    const message = messageRows[0];

    // Handle thumbnail if provided
    let thumbnailFileUrl = null;
    if (thumbnailUrl && type === 'video') {
      const thumbnailBase64 = thumbnailUrl.includes(',') ? thumbnailUrl.split(',')[1] : thumbnailUrl;
      const thumbnailBuffer = Buffer.from(thumbnailBase64, 'base64');
      const thumbnailFileName = `thumb-${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
      const thumbnailPath = join(UPLOADS_DIR, thumbnailFileName);
      await writeFile(thumbnailPath, thumbnailBuffer);
      thumbnailFileUrl = `/uploads/${thumbnailFileName}`;
    }

    // Create attachment record
    const { rows: attachmentRows } = await pool.query(
      `INSERT INTO message_attachments (
        message_id, type, file_name, file_url, file_size, mime_type, thumbnail_url, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, type, file_name, file_url, file_size, mime_type, thumbnail_url, metadata, created_at`,
      [
        message.id,
        type,
        fileName,
        fileUrl,
        fileSize,
        mimeType || null,
        thumbnailFileUrl,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    return res.json({
      message: {
        id: message.id,
        senderId: message.sender_id,
        recipientId: message.recipient_id,
        content: message.content,
        status: message.status,
        createdAt: message.created_at,
        attachment: {
          id: attachmentRows[0].id,
          type: attachmentRows[0].type,
          fileName: attachmentRows[0].file_name,
          fileUrl: attachmentRows[0].file_url,
          fileSize: attachmentRows[0].file_size,
          mimeType: attachmentRows[0].mime_type,
          thumbnailUrl: attachmentRows[0].thumbnail_url,
          metadata: attachmentRows[0].metadata,
          createdAt: attachmentRows[0].created_at,
        },
      },
    });
  } catch (err) {
    console.error('Upload file error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /messages/unread-count
 * Get total count of unread messages for the current user
 */
router.get('/unread-count', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;

    const { rows } = await pool.query(
      `SELECT COUNT(*) as unread_count
       FROM messages
       WHERE recipient_id = $1
         AND status != 'read'`,
      [currentUserId],
    );

    const unreadCount = parseInt(rows[0].unread_count, 10) || 0;

    return res.json({ unreadCount });
  } catch (err) {
    console.error('Get unread count error', err);
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

    // Optimized query using window functions for better performance
    const { rows } = await pool.query(
      `WITH conversation_partners AS (
        SELECT DISTINCT
          CASE 
            WHEN sender_id = $1 THEN recipient_id
            ELSE sender_id
          END as partner_id
        FROM messages
        WHERE sender_id = $1 OR recipient_id = $1
      ),
      ranked_messages AS (
        SELECT 
          CASE 
            WHEN sender_id = $1 THEN recipient_id
            ELSE sender_id
          END as partner_id,
          id,
          content,
          status,
          created_at,
          sender_id,
          ROW_NUMBER() OVER (
            PARTITION BY 
              CASE 
                WHEN sender_id = $1 THEN recipient_id
                ELSE sender_id
              END
            ORDER BY created_at DESC
          ) as rn
        FROM messages
        WHERE sender_id = $1 OR recipient_id = $1
      ),
      last_messages AS (
        SELECT 
          partner_id,
          id as message_id,
          content,
          status,
          created_at,
          sender_id
        FROM ranked_messages
        WHERE rn = 1
      ),
      unread_counts AS (
        SELECT 
          CASE 
            WHEN sender_id = $1 THEN recipient_id
            ELSE sender_id
          END as partner_id,
          COUNT(*) as unread_count
        FROM messages
        WHERE recipient_id = $1
          AND status != 'read'
        GROUP BY partner_id
      )
      SELECT 
        u.id as user_id,
        u.display_name,
        u.username,
        lm.content as last_message,
        lm.created_at as last_message_time,
        lm.status as last_message_status,
        lm.sender_id = $1 as is_last_message_from_me,
        COALESCE(uc.unread_count, 0)::int as unread_count
      FROM conversation_partners cp
      INNER JOIN users u ON u.id = cp.partner_id
      LEFT JOIN last_messages lm ON lm.partner_id = cp.partner_id
      LEFT JOIN unread_counts uc ON uc.partner_id = cp.partner_id
      WHERE u.is_active = TRUE
      ORDER BY COALESCE(lm.created_at, '1970-01-01'::timestamptz) DESC`,
      [currentUserId],
    );

    return res.json({
      chats: rows.map((row) => ({
        id: row.user_id,
        userId: row.user_id,
        userName: row.display_name || row.username || 'Unknown',
        userAvatar: null, // Profile pictures are stored locally on mobile, not in DB
        lastMessage: row.last_message,
        lastMessageTime: row.last_message_time,
        lastMessageStatus: row.is_last_message_from_me ? row.last_message_status : undefined,
        unreadCount: row.unread_count || 0,
        isPinned: false, // TODO: Add pinning functionality
        isStarred: false, // TODO: Add starring functionality
      })),
    });
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

    // Store typing status (current user is typing to other user)
    if (!typingStatus.has(otherUserId)) {
      typingStatus.set(otherUserId, new Map());
    }
    const userTypingMap = typingStatus.get(otherUserId)!;
    userTypingMap.set(currentUserId, Date.now());

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

    // Check if other user is typing to current user
    const userTypingMap = typingStatus.get(currentUserId);
    const isTyping = userTypingMap?.has(otherUserId) ?? false;
    const typingTimestamp = userTypingMap?.get(otherUserId) ?? 0;

    // Only return true if typing status is recent (within last 3 seconds)
    const now = Date.now();
    const isRecentlyTyping = isTyping && (now - typingTimestamp) < 3000;

    return res.json({ isTyping: isRecentlyTyping });
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

    // Store typing status: recipientId -> { currentUserId: timestamp }
    if (!typingStatus.has(recipientId)) {
      typingStatus.set(recipientId, new Map());
    }
    const userMap = typingStatus.get(recipientId)!;
    userMap.set(currentUserId, Date.now());

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

    // Check if other user is typing to current user
    const userMap = typingStatus.get(currentUserId);
    if (!userMap) {
      return res.json({ isTyping: false });
    }

    const typingTimestamp = userMap.get(otherUserId);
    if (!typingTimestamp) {
      return res.json({ isTyping: false });
    }

    // Check if typing status is still fresh (within last 3 seconds)
    const now = Date.now();
    const isTyping = now - typingTimestamp < 3000;

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

export default router;

