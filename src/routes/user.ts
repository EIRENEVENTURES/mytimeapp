// backend/src/routes/user.ts
import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { pool } from '../db';

const router = Router();

/**
 * Example protected route - requires authentication
 * GET /user/me - Get current user profile
 */
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    // req.user is set by authenticateToken middleware
    const userId = req.user!.id;

    const { rows } = await pool.query(
      'SELECT id, email, display_name, role, created_at FROM users WHERE id = $1',
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = rows[0];
    return res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error('Get user error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;

