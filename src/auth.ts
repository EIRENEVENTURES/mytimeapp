import { Router, Request, Response } from 'express';
import { pool } from './db';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const router = Router();

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

const ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TTL_DAYS = 7;

function generateTokens(userId: string, email: string, role: string) {
  if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new Error('JWT secrets are not configured');
  }

  const payload: JwtPayload = { sub: userId, email, role };

  const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_TTL_SECONDS,
  });

  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TTL_DAYS * 24 * 60 * 60,
  });

  const refreshExpiresAt = new Date();
  refreshExpiresAt.setDate(refreshExpiresAt.getDate() + REFRESH_TTL_DAYS);

  return { accessToken, refreshToken, refreshExpiresAt };
}

router.post('/signup', async (req: Request, res: Response) => {
  const { email, password, displayName } = req.body ?? {};

  if (!email || !password || !displayName) {
    return res.status(400).json({ message: 'email, password and displayName are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [
      String(email).toLowerCase(),
    ]);
    const existingCount = existing.rowCount ?? 0;
    if (existingCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Email already in use' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, role`,
      [String(email).toLowerCase(), passwordHash, displayName],
    );
    const user = rows[0];

    const { accessToken, refreshToken, refreshExpiresAt } = generateTokens(
      user.id,
      user.email,
      user.role,
    );

    await client.query(
      `INSERT INTO sessions (user_id, refresh_token, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, req.headers['user-agent'] ?? null, req.ip, refreshExpiresAt],
    );

    await client.query('COMMIT');

    return res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ message: 'email and password are required' });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, email, password_hash, display_name, role
       FROM users
       WHERE email = $1 AND is_active = TRUE`,
      [String(email).toLowerCase()],
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(String(password), user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const { accessToken, refreshToken, refreshExpiresAt } = generateTokens(
      user.id,
      user.email,
      user.role,
    );

    await client.query(
      `INSERT INTO sessions (user_id, refresh_token, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, req.headers['user-agent'] ?? null, req.ip, refreshExpiresAt],
    );

    await client.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ message: 'refreshToken is required' });
  }

  const client = await pool.connect();
  try {
    const now = new Date();
    const { rows } = await client.query(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at,
              u.email, u.role, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token = $1`,
      [refreshToken],
    );
    const row = rows[0];
    if (
      !row ||
      row.revoked_at ||
      new Date(row.expires_at).getTime() <= now.getTime()
    ) {
      return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }

    const { accessToken, refreshToken: newRefresh, refreshExpiresAt } = generateTokens(
      row.user_id,
      row.email,
      row.role,
    );

    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1`, [row.id]);
    await client.query(
      `INSERT INTO sessions (user_id, refresh_token, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.user_id, newRefresh, req.headers['user-agent'] ?? null, req.ip, refreshExpiresAt],
    );

    return res.json({
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      },
      accessToken,
      refreshToken: newRefresh,
    });
  } catch (err) {
    console.error('Refresh error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/logout', async (req: Request, res: Response) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ message: 'refreshToken is required' });
  }

  try {
    await pool.query(
      `UPDATE sessions
       SET revoked_at = NOW()
       WHERE refresh_token = $1 AND revoked_at IS NULL`,
      [refreshToken],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Logout error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;


