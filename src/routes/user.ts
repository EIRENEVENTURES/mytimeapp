// backend/src/routes/user.ts
import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { pool } from '../db';

const router = Router();

/**
 * GET /user/me - Get current user profile
 */
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const { rows } = await pool.query(
      `SELECT id, email, display_name, role, created_at,
              username, phone_number, date_of_birth, city, country
       FROM users
       WHERE id = $1`,
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
      username: user.username,
      phoneNumber: user.phone_number,
      dateOfBirth: user.date_of_birth,
      city: user.city,
      country: user.country,
    });
  } catch (err) {
    console.error('Get user error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * PUT /user/me - Update editable profile fields
 * Allowed fields: username, phoneNumber, dateOfBirth, city, country
 */
router.put('/me', authenticateToken, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { username, phoneNumber, dateOfBirth, city, country } = req.body ?? {};

  if (
    typeof username === 'undefined' &&
    typeof phoneNumber === 'undefined' &&
    typeof dateOfBirth === 'undefined' &&
    typeof city === 'undefined' &&
    typeof country === 'undefined'
  ) {
    return res.status(400).json({ message: 'No profile fields provided to update' });
  }

  if (username && String(username).trim().length < 3) {
    return res
      .status(400)
      .json({ message: 'Username must be at least 3 characters long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check username uniqueness if provided
    if (typeof username !== 'undefined' && username !== null && username !== '') {
      const existingUsername = await client.query(
        `SELECT id FROM users
         WHERE LOWER(username) = LOWER($1) AND id <> $2`,
        [String(username).trim(), userId],
      );
      if (existingUsername.rowCount && existingUsername.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Username is already taken' });
      }
    }

    // Check phone uniqueness if provided
    if (typeof phoneNumber !== 'undefined' && phoneNumber !== null && phoneNumber !== '') {
      const existingPhone = await client.query(
        `SELECT id FROM users
         WHERE phone_number = $1 AND id <> $2`,
        [String(phoneNumber).trim(), userId],
      );
      if (existingPhone.rowCount && existingPhone.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Phone number is already in use' });
      }
    }

    // Prepare values for update
    const usernameValue =
      typeof username === 'undefined' ? null : String(username).trim() || null;
    const phoneValue =
      typeof phoneNumber === 'undefined' ? null : String(phoneNumber).trim() || null;
    const cityValue = typeof city === 'undefined' ? null : String(city).trim() || null;
    const countryValue =
      typeof country === 'undefined' ? null : String(country).trim() || null;

    // Handle date_of_birth - validate format if provided
    let dateValue: string | null = null;
    if (typeof dateOfBirth !== 'undefined' && dateOfBirth !== null && dateOfBirth !== '') {
      const trimmedDate = String(dateOfBirth).trim();
      if (trimmedDate) {
        // Validate date format YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: 'Date of birth must be in YYYY-MM-DD format' });
        }
        dateValue = trimmedDate;
      }
    }

    // Build dynamic UPDATE query based on what's provided
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (typeof username !== 'undefined') {
      updates.push(`username = $${paramIndex}`);
      values.push(usernameValue);
      paramIndex++;
    }
    if (typeof phoneNumber !== 'undefined') {
      updates.push(`phone_number = $${paramIndex}`);
      values.push(phoneValue);
      paramIndex++;
    }
    if (typeof dateOfBirth !== 'undefined') {
      updates.push(`date_of_birth = $${paramIndex}::date`);
      values.push(dateValue);
      paramIndex++;
    }
    if (typeof city !== 'undefined') {
      updates.push(`city = $${paramIndex}`);
      values.push(cityValue);
      paramIndex++;
    }
    if (typeof country !== 'undefined') {
      updates.push(`country = $${paramIndex}`);
      values.push(countryValue);
      paramIndex++;
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No profile fields provided to update' });
    }

    values.push(userId);

    const { rows } = await client.query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, email, display_name, role, created_at,
                 username, phone_number, date_of_birth, city, country`,
      values,
    );

    await client.query('COMMIT');

    const user = rows[0];
    return res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      createdAt: user.created_at,
      username: user.username,
      phoneNumber: user.phone_number,
      dateOfBirth: user.date_of_birth,
      city: user.city,
      country: user.country,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update profile error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;

