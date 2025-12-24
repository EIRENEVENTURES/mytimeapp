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

    // Mark messages as read (messages sent to current user from other user)
    await pool.query(
      `UPDATE messages 
       SET status = 'read' 
       WHERE recipient_id = $1 
         AND sender_id = $2 
         AND status != 'read'`,
      [currentUserId, otherUserId],
    );

    const { rows } = await pool.query(
      `SELECT 
        id,
        sender_id,
        recipient_id,
        content,
        status,
        created_at
       FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2)
          OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC`,
      [currentUserId, otherUserId],
    );

    return res.json({
      messages: rows.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        recipientId: m.recipient_id,
        content: m.content,
        status: m.status,
        createdAt: m.created_at,
      })),
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
    const { recipientId, content } = req.body;

    if (!recipientId || !content || !content.trim()) {
      return res.status(400).json({ message: 'Recipient ID and content are required' });
    }

    // Verify recipient exists
    const recipientCheck = await pool.query('SELECT id FROM users WHERE id = $1', [recipientId]);
    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recipient not found' });
    }

    // Insert message
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content, status)
       VALUES ($1, $2, $3, 'sent')
       RETURNING id, sender_id, recipient_id, content, status, created_at`,
      [senderId, recipientId, content.trim()],
    );

    const message = rows[0];

    // Mark as delivered immediately (in real app, this would be done via push notification)
    await pool.query(
      `UPDATE messages SET status = 'delivered' WHERE id = $1`,
      [message.id],
    );

    // Return updated message
    const { rows: updatedRows } = await pool.query(
      `SELECT id, sender_id, recipient_id, content, status, created_at
       FROM messages WHERE id = $1`,
      [message.id],
    );

    return res.json({
      message: {
        id: updatedRows[0].id,
        senderId: updatedRows[0].sender_id,
        recipientId: updatedRows[0].recipient_id,
        content: updatedRows[0].content,
        status: updatedRows[0].status,
        createdAt: updatedRows[0].created_at,
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

    // Verify recipient exists
    const recipientCheck = await pool.query('SELECT id FROM users WHERE id = $1', [recipientId]);
    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recipient not found' });
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

    // Create message with attachment
    const { rows: messageRows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content, status, has_attachments)
       VALUES ($1, $2, $3, 'sent', TRUE)
       RETURNING id, sender_id, recipient_id, content, status, created_at`,
      [senderId, recipientId, fileName], // Use filename as content placeholder
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

    // Mark as delivered
    await pool.query(`UPDATE messages SET status = 'delivered' WHERE id = $1`, [message.id]);

    return res.json({
      message: {
        id: message.id,
        senderId: message.sender_id,
        recipientId: message.recipient_id,
        content: message.content,
        status: 'delivered',
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

    // Get all unique conversations (users the current user has messaged or received messages from)
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
      last_messages AS (
        SELECT DISTINCT ON (partner_id)
          partner_id,
          m.id as message_id,
          m.content,
          m.status,
          m.created_at,
          m.sender_id
        FROM conversation_partners cp
        CROSS JOIN LATERAL (
          SELECT id, content, status, created_at, sender_id
          FROM messages
          WHERE (sender_id = $1 AND recipient_id = cp.partner_id)
             OR (sender_id = cp.partner_id AND recipient_id = $1)
          ORDER BY created_at DESC
          LIMIT 1
        ) m
        ORDER BY partner_id, m.created_at DESC
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
      ORDER BY lm.created_at DESC NULLS LAST`,
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

export default router;

