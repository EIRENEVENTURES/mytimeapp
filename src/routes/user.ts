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
      `SELECT id,
              email,
              display_name,
              role,
              created_at,
              username,
              phone_number,
              date_of_birth,
              city,
              country,
              bio,
              credit_per_second,
              specialty,
              links,
              ratings
       FROM users
       WHERE id = $1`,
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get follower count (users who added this user as a contact)
    const followersResult = await pool.query(
      `SELECT COUNT(*)::int as count
       FROM contacts
       WHERE contact_user_id = $1`,
      [userId],
    );
    const followers = followersResult.rows[0]?.count ?? 0;

    // Get following count (users that this user added as contacts)
    const followingResult = await pool.query(
      `SELECT COUNT(*)::int as count
       FROM contacts
       WHERE user_id = $1`,
      [userId],
    );
    const following = followingResult.rows[0]?.count ?? 0;

    const user = rows[0];
    return res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      createdAt: user.created_at,
      username: user.username,
      phoneNumber: user.phone_number,
      dateOfBirth: user.date_of_birth
        ? (user.date_of_birth as Date).toISOString().slice(0, 10)
        : null,
      city: user.city,
      country: user.country,
      bio: user.bio,
      creditPerSecond: user.credit_per_second,
      specialty: user.specialty,
      links: user.links,
      ratings: user.ratings,
      followers,
      following,
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
  const {
    username,
    phoneNumber,
    dateOfBirth,
    city,
    country,
    bio,
    creditPerSecond,
    specialty,
    links,
  } = req.body ?? {};

  if (
    typeof username === 'undefined' &&
    typeof phoneNumber === 'undefined' &&
    typeof dateOfBirth === 'undefined' &&
    typeof city === 'undefined' &&
    typeof country === 'undefined' &&
    typeof bio === 'undefined' &&
    typeof creditPerSecond === 'undefined' &&
    typeof specialty === 'undefined' &&
    typeof links === 'undefined'
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

    // Load current user to enforce non-editable username/phone once set
    const currentResult = await client.query(
      `SELECT username, phone_number FROM users WHERE id = $1`,
      [userId],
    );
    if (currentResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found' });
    }
    const currentUser = currentResult.rows[0];

    const requestedUsername =
      typeof username === 'undefined' || username === null || username === ''
        ? undefined
        : String(username).trim();
    const requestedPhone =
      typeof phoneNumber === 'undefined' || phoneNumber === null || phoneNumber === ''
        ? undefined
        : String(phoneNumber).trim();

    // If username already exists, it cannot be changed
    if (
      currentUser.username &&
      typeof requestedUsername !== 'undefined' &&
      requestedUsername.toLowerCase() !== String(currentUser.username).toLowerCase()
    ) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ message: 'Username cannot be changed once it has been set' });
    }

    // If phone number already exists, it cannot be changed
    if (
      currentUser.phone_number &&
      typeof requestedPhone !== 'undefined' &&
      requestedPhone !== String(currentUser.phone_number)
    ) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ message: 'Phone number cannot be changed once it has been set' });
    }

    // Check username uniqueness if provided (for first-time set or same value)
    if (typeof requestedUsername !== 'undefined') {
      const existingUsername = await client.query(
        `SELECT id FROM users
         WHERE LOWER(username) = LOWER($1) AND id <> $2`,
        [requestedUsername, userId],
      );
      if (existingUsername.rowCount && existingUsername.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Username is already taken' });
      }
    }

    // Check phone uniqueness if provided (for first-time set or same value)
    if (typeof requestedPhone !== 'undefined') {
      const existingPhone = await client.query(
        `SELECT id FROM users
         WHERE phone_number = $1 AND id <> $2`,
        [requestedPhone, userId],
      );
      if (existingPhone.rowCount && existingPhone.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Phone number is already in use' });
      }
    }

    // Prepare values for update
    const usernameValue =
      typeof requestedUsername === 'undefined' ? undefined : requestedUsername || null;
    const phoneValue =
      typeof requestedPhone === 'undefined' ? undefined : requestedPhone || null;
    const cityValue = typeof city === 'undefined' ? null : String(city).trim() || null;
    const countryValue =
      typeof country === 'undefined' ? null : String(country).trim() || null;
    const bioValue = typeof bio === 'undefined' ? null : String(bio).trim() || null;
    const specialtyValue =
      typeof specialty === 'undefined' ? null : String(specialty).trim() || null;
    const linksValue = typeof links === 'undefined' ? null : String(links).trim() || null;

    let creditValue: number | null = null;
    if (
      typeof creditPerSecond !== 'undefined' &&
      creditPerSecond !== null &&
      creditPerSecond !== ''
    ) {
      const num = Number(creditPerSecond);
      if (!Number.isFinite(num) || num < 0) {
        await client.query('ROLLBACK');
        return res
          .status(400)
          .json({ message: 'Credit per second must be a non-negative number' });
      }
      creditValue = num;
    }

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

    if (typeof usernameValue !== 'undefined') {
      updates.push(`username = $${paramIndex}`);
      values.push(usernameValue);
      paramIndex++;
    }
    if (typeof phoneValue !== 'undefined') {
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
    if (typeof bio !== 'undefined') {
      updates.push(`bio = $${paramIndex}`);
      values.push(bioValue);
      paramIndex++;
    }
    if (typeof creditPerSecond !== 'undefined') {
      updates.push(`credit_per_second = $${paramIndex}`);
      values.push(creditValue);
      paramIndex++;
    }
    if (typeof specialty !== 'undefined') {
      updates.push(`specialty = $${paramIndex}`);
      values.push(specialtyValue);
      paramIndex++;
    }
    if (typeof links !== 'undefined') {
      updates.push(`links = $${paramIndex}`);
      values.push(linksValue);
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
       RETURNING id,
                 email,
                 display_name,
                 role,
                 created_at,
                 username,
                 phone_number,
                 date_of_birth,
                 city,
                 country,
                 bio,
                 credit_per_second,
                 specialty,
                 links,
                 ratings`,
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
      dateOfBirth: user.date_of_birth
        ? (user.date_of_birth as Date).toISOString().slice(0, 10)
        : null,
      city: user.city,
      country: user.country,
      bio: user.bio,
      creditPerSecond: user.credit_per_second,
      specialty: user.specialty,
      links: user.links,
      ratings: user.ratings,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update profile error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

/**
 * GET /user/search?q=...&limit=20&cursor=0
 *
 * Search for users by username or display name.
 * - q: search string (required, trimmed, case-insensitive)
 * - limit: max items per page (default 20, max 50)
 * - cursor: numeric offset for pagination (default 0)
 *
 * Returns: { users: [...], nextCursor: number | null }
 */
router.get('/search', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rawQuery = (req.query.q as string | undefined)?.trim() ?? '';
    const limitParam = Number(req.query.limit ?? 20);
    const cursorParam = Number(req.query.cursor ?? 0);

    if (!rawQuery) {
      return res.json({ users: [], nextCursor: null });
    }

    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(limitParam, 50))
      : 20;
    const offset = Number.isFinite(cursorParam) && cursorParam >= 0 ? cursorParam : 0;

    const pattern = `%${rawQuery.toLowerCase()}%`;

    // Fetch one extra record to know if there are more pages
    const { rows } = await pool.query(
      `
      SELECT
        id,
        display_name,
        username,
        specialty,
        credit_per_second,
        ratings,
        country,
        last_seen_at
      FROM users
      WHERE is_active = TRUE
        AND (
          LOWER(username) LIKE $1
          OR LOWER(display_name) LIKE $1
        )
      ORDER BY ratings DESC NULLS LAST, display_name ASC
      LIMIT $2 OFFSET $3
      `,
      [pattern, limit + 1, offset],
    );

    const hasMore = rows.length > limit;
    const users = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? offset + limit : null;

    const now = Date.now();

    return res.json({
      users: users.map((u) => {
        let activityStatus: 'online' | 'recent' | 'offline' = 'offline';
        if (u.last_seen_at) {
          const lastSeen = new Date(u.last_seen_at as Date).getTime();
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

        return {
          id: u.id,
          displayName: u.display_name,
          username: u.username,
          specialty: u.specialty,
          creditPerSecond: u.credit_per_second,
          ratings: u.ratings,
          country: u.country,
          activityStatus,
        };
      }),
      nextCursor,
    });
  } catch (err) {
    console.error('User search error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /user/me/contacts/:contactId
 * Add another user as a contact for the current user.
 */
router.post(
  '/me/contacts/:contactId',
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { contactId } = req.params;

    if (!contactId) {
      return res.status(400).json({ message: 'Contact id is required' });
    }

    if (contactId === userId) {
      return res.status(400).json({ message: 'You cannot add yourself as a contact' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        'SELECT id, display_name, is_active FROM users WHERE id = $1',
        [contactId],
      );

      if (rows.length === 0 || rows[0].is_active === false) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'User not found or inactive' });
      }

      const contactName = rows[0].display_name as string;

      await client.query(
        `
        INSERT INTO contacts (user_id, contact_user_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, contact_user_id) DO NOTHING
        `,
        [userId, contactId],
      );

      await client.query('COMMIT');

      return res.json({
        success: true,
        message: `${contactName} has been added to your contact list`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Add contact error', err);
      return res.status(500).json({ message: 'Failed to add contact' });
    } finally {
      client.release();
    }
  },
);

export default router;

