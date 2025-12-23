// backend/src/routes/messages.ts
import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { pool } from '../db';

const router = Router();

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

export default router;

