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

/**
 * GET /messages/conversation/:userId
 * Get conversation messages between current user and another user
 */
router.get('/conversation/:userId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user!.id;
    const otherUserId = req.params.userId;

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

