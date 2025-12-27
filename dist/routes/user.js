"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/user.ts
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = require("../db");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const fs_1 = require("fs");
const router = (0, express_1.Router)();
// Ensure uploads directory exists (only for local storage)
const UPLOADS_DIR = (0, path_1.join)(__dirname, '..', '..', 'uploads');
const ensureUploadsDir = async () => {
    if (process.env.USE_BLOB_STORAGE !== 'true') {
        if (!(0, fs_1.existsSync)(UPLOADS_DIR)) {
            await (0, promises_1.mkdir)(UPLOADS_DIR, { recursive: true });
        }
    }
};
ensureUploadsDir();
// Blob storage upload function for Vercel Blob Storage
async function uploadToBlobStorage(fileName, buffer, contentType) {
    try {
        // Dynamic import to avoid loading if not using blob storage
        const { put } = await Promise.resolve().then(() => __importStar(require('@vercel/blob')));
        const blob = await put(fileName, buffer, {
            access: 'public',
            contentType: contentType || 'application/octet-stream',
            token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        return blob.url;
    }
    catch (error) {
        console.error('Vercel Blob upload error:', error);
        throw new Error(`Failed to upload to Vercel Blob: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
/**
 * GET /user/me - Get current user profile
 */
router.get('/me', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { rows } = await db_1.pool.query(`SELECT id,
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
              ratings,
              profile_picture
       FROM users
       WHERE id = $1`, [userId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        // Get follower count (users who added this user as a contact)
        const followersResult = await db_1.pool.query(`SELECT COUNT(*)::int as count
       FROM contacts
       WHERE contact_user_id = $1`, [userId]);
        const followers = followersResult.rows[0]?.count ?? 0;
        // Get following count (users that this user added as contacts)
        const followingResult = await db_1.pool.query(`SELECT COUNT(*)::int as count
       FROM contacts
       WHERE user_id = $1`, [userId]);
        const following = followingResult.rows[0]?.count ?? 0;
        const user = rows[0];
        // Get full URL for profile picture
        let profilePictureUrl = user.profile_picture ?? null;
        if (profilePictureUrl && !profilePictureUrl.startsWith('http')) {
            // If it's a local path, construct full URL
            const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
            profilePictureUrl = `${baseUrl}${profilePictureUrl}`;
        }
        return res.json({
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role,
            createdAt: user.created_at,
            username: user.username ?? null,
            phoneNumber: user.phone_number ?? null,
            dateOfBirth: user.date_of_birth
                ? user.date_of_birth.toISOString().slice(0, 10)
                : null,
            city: user.city ?? null,
            country: user.country ?? null,
            bio: user.bio ?? null,
            creditPerSecond: user.credit_per_second ?? null,
            specialty: user.specialty ?? null,
            links: user.links ?? null,
            ratings: user.ratings ?? null,
            profilePicture: profilePictureUrl,
            followers,
            following,
        });
    }
    catch (err) {
        console.error('Get user error', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
});
/**
 * PUT /user/me - Update editable profile fields
 * Allowed fields: username, phoneNumber, dateOfBirth, city, country
 */
router.put('/me', auth_1.authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { username, phoneNumber, dateOfBirth, city, country, bio, creditPerSecond, specialty, links, } = req.body ?? {};
    if (typeof username === 'undefined' &&
        typeof phoneNumber === 'undefined' &&
        typeof dateOfBirth === 'undefined' &&
        typeof city === 'undefined' &&
        typeof country === 'undefined' &&
        typeof bio === 'undefined' &&
        typeof creditPerSecond === 'undefined' &&
        typeof specialty === 'undefined' &&
        typeof links === 'undefined') {
        return res.status(400).json({ message: 'No profile fields provided to update' });
    }
    if (username && String(username).trim().length < 3) {
        return res
            .status(400)
            .json({ message: 'Username must be at least 3 characters long' });
    }
    const client = await db_1.pool.connect();
    try {
        await client.query('BEGIN');
        // Load current user to enforce non-editable username/phone once set
        const currentResult = await client.query(`SELECT username, phone_number FROM users WHERE id = $1`, [userId]);
        if (currentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'User not found' });
        }
        const currentUser = currentResult.rows[0];
        const requestedUsername = typeof username === 'undefined' || username === null || username === ''
            ? undefined
            : String(username).trim();
        const requestedPhone = typeof phoneNumber === 'undefined' || phoneNumber === null || phoneNumber === ''
            ? undefined
            : String(phoneNumber).trim();
        // If username already exists, it cannot be changed
        if (currentUser.username &&
            typeof requestedUsername !== 'undefined' &&
            requestedUsername.toLowerCase() !== String(currentUser.username).toLowerCase()) {
            await client.query('ROLLBACK');
            return res
                .status(400)
                .json({ message: 'Username cannot be changed once it has been set' });
        }
        // If phone number already exists, it cannot be changed
        if (currentUser.phone_number &&
            typeof requestedPhone !== 'undefined' &&
            requestedPhone !== String(currentUser.phone_number)) {
            await client.query('ROLLBACK');
            return res
                .status(400)
                .json({ message: 'Phone number cannot be changed once it has been set' });
        }
        // Check username uniqueness if provided (for first-time set or same value)
        if (typeof requestedUsername !== 'undefined') {
            const existingUsername = await client.query(`SELECT id FROM users
         WHERE LOWER(username) = LOWER($1) AND id <> $2`, [requestedUsername, userId]);
            if (existingUsername.rowCount && existingUsername.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'Username is already taken' });
            }
        }
        // Check phone uniqueness if provided (for first-time set or same value)
        if (typeof requestedPhone !== 'undefined') {
            const existingPhone = await client.query(`SELECT id FROM users
         WHERE phone_number = $1 AND id <> $2`, [requestedPhone, userId]);
            if (existingPhone.rowCount && existingPhone.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'Phone number is already in use' });
            }
        }
        // Prepare values for update
        const usernameValue = typeof requestedUsername === 'undefined' ? undefined : requestedUsername || null;
        const phoneValue = typeof requestedPhone === 'undefined' ? undefined : requestedPhone || null;
        const cityValue = typeof city === 'undefined' ? null : String(city).trim() || null;
        const countryValue = typeof country === 'undefined' ? null : String(country).trim() || null;
        const bioValue = typeof bio === 'undefined' ? null : String(bio).trim() || null;
        const specialtyValue = typeof specialty === 'undefined' ? null : String(specialty).trim() || null;
        const linksValue = typeof links === 'undefined' ? null : String(links).trim() || null;
        let creditValue = null;
        if (typeof creditPerSecond !== 'undefined' &&
            creditPerSecond !== null &&
            creditPerSecond !== '') {
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
        let dateValue = null;
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
        const updates = [];
        const values = [];
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
        const { rows } = await client.query(`UPDATE users
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
                 ratings`, values);
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
                ? user.date_of_birth.toISOString().slice(0, 10)
                : null,
            city: user.city,
            country: user.country,
            bio: user.bio,
            creditPerSecond: user.credit_per_second,
            specialty: user.specialty,
            links: user.links,
            ratings: user.ratings,
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('Update profile error', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
    finally {
        client.release();
    }
});
/**
 * GET /user/search?q=...&limit=20&cursor=...
 *
 * Search for users by username or display name.
 * - q: search string (required, trimmed, case-insensitive)
 * - limit: max items per page (default 20, max 50)
 * - cursor: user ID for cursor-based pagination (optional)
 *
 * Returns: { users: [...], nextCursor: string | null }
 */
router.get('/search', auth_1.authenticateToken, async (req, res) => {
    try {
        const rawQuery = req.query.q?.trim() ?? '';
        const limitParam = Number(req.query.limit ?? 20);
        const cursor = req.query.cursor;
        if (!rawQuery) {
            return res.json({ users: [], nextCursor: null });
        }
        const limit = Number.isFinite(limitParam)
            ? Math.max(1, Math.min(limitParam, 50))
            : 20;
        const pattern = `%${rawQuery.toLowerCase()}%`;
        const currentUserId = req.user.id;
        // Build cursor-based query
        let query = `
      SELECT
        id,
        display_name,
        username,
        specialty,
        credit_per_second,
        ratings,
        country,
        bio,
        last_seen_at,
        profile_picture,
        COALESCE(chat_rate_charging_enabled, FALSE) as chat_rate_charging_enabled
      FROM users
      WHERE is_active = TRUE
        AND id != $1
        AND (
          LOWER(username) LIKE $2
          OR LOWER(display_name) LIKE $2
        )
    `;
        const params = [currentUserId, pattern];
        // Add cursor condition if provided
        if (cursor) {
            // Get cursor user's ratings and display_name for stable cursor
            const cursorResult = await db_1.pool.query(`SELECT ratings, display_name FROM users WHERE id = $1`, [cursor]);
            if (cursorResult.rows.length > 0) {
                const cursorUser = cursorResult.rows[0];
                query += ` AND (
          (ratings < $${params.length + 1}::numeric) OR
          (ratings = $${params.length + 1}::numeric AND display_name > $${params.length + 2})
        )`;
                params.push(cursorUser.ratings || 0, cursorUser.display_name);
            }
        }
        query += ` ORDER BY ratings DESC NULLS LAST, display_name ASC LIMIT $${params.length + 1}`;
        params.push(limit + 1); // Fetch one extra to check for more
        const { rows } = await db_1.pool.query(query, params);
        const hasMore = rows.length > limit;
        const users = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore && users.length > 0 ? users[users.length - 1].id : null;
        const now = Date.now();
        // Get all contact IDs for the current user
        const contactsResult = await db_1.pool.query(`SELECT contact_user_id FROM contacts WHERE user_id = $1`, [currentUserId]);
        const contactIds = new Set(contactsResult.rows.map((row) => row.contact_user_id));
        // Get followers count for each user
        const userIds = users.map((u) => u.id);
        const followersMap = new Map();
        if (userIds.length > 0) {
            const followersResult = await db_1.pool.query(`SELECT contact_user_id, COUNT(*)::int as count
         FROM contacts
         WHERE contact_user_id = ANY($1::uuid[])
         GROUP BY contact_user_id`, [userIds]);
            followersResult.rows.forEach((row) => {
                followersMap.set(row.contact_user_id, row.count);
            });
        }
        return res.json({
            users: users.map((u) => {
                let activityStatus = 'offline';
                if (u.last_seen_at) {
                    const lastSeen = new Date(u.last_seen_at).getTime();
                    const diffMs = now - lastSeen;
                    const diffMinutes = diffMs / (1000 * 60);
                    const diffDays = diffMs / (1000 * 60 * 60 * 24);
                    if (diffMinutes <= 2) {
                        activityStatus = 'online';
                    }
                    else if (diffDays <= 3) {
                        activityStatus = 'recent';
                    }
                    else {
                        activityStatus = 'offline';
                    }
                }
                // Get full URL for profile picture
                let profilePictureUrl = u.profile_picture ?? null;
                if (profilePictureUrl && !profilePictureUrl.startsWith('http')) {
                    const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
                    profilePictureUrl = `${baseUrl}${profilePictureUrl}`;
                }
                return {
                    id: u.id,
                    displayName: u.display_name,
                    username: u.username,
                    specialty: u.specialty,
                    creditPerSecond: u.credit_per_second,
                    ratings: u.ratings,
                    country: u.country,
                    bio: u.bio,
                    profilePicture: profilePictureUrl,
                    activityStatus,
                    isFollowing: contactIds.has(u.id),
                    followers: followersMap.get(u.id) ?? 0,
                    rateChargingEnabled: u.chat_rate_charging_enabled ?? false,
                };
            }),
            nextCursor,
        });
    }
    catch (err) {
        console.error('User search error', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
});
/**
 * POST /user/me/contacts/:contactId
 * Add another user as a contact for the current user.
 */
router.post('/me/contacts/:contactId', auth_1.authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { contactId } = req.params;
    if (!contactId) {
        return res.status(400).json({ message: 'Contact id is required' });
    }
    if (contactId === userId) {
        return res.status(400).json({ message: 'You cannot add yourself as a contact' });
    }
    const client = await db_1.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT id, display_name, is_active FROM users WHERE id = $1', [contactId]);
        if (rows.length === 0 || rows[0].is_active === false) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'User not found or inactive' });
        }
        const contactName = rows[0].display_name;
        // Check if contact already exists
        const existingContact = await client.query(`SELECT id FROM contacts WHERE user_id = $1 AND contact_user_id = $2`, [userId, contactId]);
        if (existingContact.rowCount && existingContact.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: `${contactName} is already in your contact list`,
            });
        }
        await client.query(`
        INSERT INTO contacts (user_id, contact_user_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, contact_user_id) DO NOTHING
        `, [userId, contactId]);
        await client.query('COMMIT');
        return res.json({
            success: true,
            message: `${contactName} has been added to your contact list`,
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('Add contact error', err);
        return res.status(500).json({ message: 'Failed to add contact' });
    }
    finally {
        client.release();
    }
});
/**
 * DELETE /user/me/contacts/:contactId
 * Remove a user from the current user's contacts.
 */
router.delete('/me/contacts/:contactId', auth_1.authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { contactId } = req.params;
    if (!contactId) {
        return res.status(400).json({ message: 'Contact id is required' });
    }
    if (contactId === userId) {
        return res.status(400).json({ message: 'You cannot remove yourself as a contact' });
    }
    const client = await db_1.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT id, display_name FROM users WHERE id = $1', [contactId]);
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'User not found' });
        }
        const contactName = rows[0].display_name;
        // Check if contact exists
        const existingContact = await client.query(`SELECT id FROM contacts WHERE user_id = $1 AND contact_user_id = $2`, [userId, contactId]);
        if (!existingContact.rowCount || existingContact.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: `${contactName} is not in your contact list`,
            });
        }
        // Delete the contact
        await client.query(`DELETE FROM contacts WHERE user_id = $1 AND contact_user_id = $2`, [userId, contactId]);
        await client.query('COMMIT');
        return res.json({
            success: true,
            message: `${contactName} has been removed from your contact list`,
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('Remove contact error', err);
        return res.status(500).json({ message: 'Failed to remove contact' });
    }
    finally {
        client.release();
    }
});
/**
 * GET /user/me/chat-rate - Get current user's chat rate configuration
 */
router.get('/me/chat-rate', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { rows } = await db_1.pool.query(`SELECT 
        COALESCE(chat_rate_per_second, credit_per_second, 0)::numeric as rate_per_second,
        COALESCE(chat_rate_charging_enabled, FALSE) as rate_charging_enabled,
        COALESCE(chat_auto_end_inactivity, FALSE) as auto_end_inactivity,
        COALESCE(chat_inactivity_timeout_minutes, 5)::int as inactivity_timeout_minutes
       FROM users
       WHERE id = $1`, [userId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const user = rows[0];
        return res.json({
            ratePerSecond: Number(user.rate_per_second) ?? 0,
            rateChargingEnabled: user.rate_charging_enabled ?? false,
            autoEndInactivity: user.auto_end_inactivity ?? false,
            inactivityTimeoutMinutes: user.inactivity_timeout_minutes ?? 5,
        });
    }
    catch (err) {
        console.error('Get chat rate config error', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
});
/**
 * PUT /user/me/chat-rate - Update chat rate configuration
 */
router.put('/me/chat-rate', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { ratePerSecond, rateChargingEnabled, autoEndInactivity, inactivityTimeoutMinutes } = req.body;
        // Validate ratePerSecond
        const rate = ratePerSecond != null ? Number(ratePerSecond) : null;
        if (rate != null && (isNaN(rate) || rate < 0)) {
            return res.status(400).json({ message: 'Rate per second must be a non-negative number' });
        }
        // Validate inactivityTimeoutMinutes
        const timeout = inactivityTimeoutMinutes != null ? Number(inactivityTimeoutMinutes) : null;
        if (timeout != null && (isNaN(timeout) || timeout < 1 || timeout > 5)) {
            return res
                .status(400)
                .json({ message: 'Inactivity timeout must be between 1 and 5 minutes' });
        }
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;
        if (rate != null) {
            // Update both chat_rate_per_second and credit_per_second to keep them in sync
            updateFields.push(`chat_rate_per_second = $${paramIndex}`);
            updateFields.push(`credit_per_second = $${paramIndex}`);
            updateValues.push(rate);
            paramIndex++;
        }
        if (typeof rateChargingEnabled === 'boolean') {
            updateFields.push(`chat_rate_charging_enabled = $${paramIndex}`);
            updateValues.push(rateChargingEnabled);
            paramIndex++;
        }
        if (typeof autoEndInactivity === 'boolean') {
            updateFields.push(`chat_auto_end_inactivity = $${paramIndex}`);
            updateValues.push(autoEndInactivity);
            paramIndex++;
        }
        if (timeout != null) {
            updateFields.push(`chat_inactivity_timeout_minutes = $${paramIndex}`);
            updateValues.push(timeout);
            paramIndex++;
        }
        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }
        updateValues.push(userId);
        const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
        await db_1.pool.query(query, updateValues);
        return res.json({
            success: true,
            message: 'Chat rate configuration updated successfully',
        });
    }
    catch (err) {
        console.error('Update chat rate config error', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
});
/**
 * POST /user/me/profile-picture
 * Upload profile picture (display picture)
 */
router.post('/me/profile-picture', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { fileData, fileName, mimeType } = req.body;
        if (!fileData || !fileName) {
            return res.status(400).json({ message: 'File data and file name are required' });
        }
        // Validate file type (only images)
        const validImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        const fileMimeType = mimeType || 'image/jpeg';
        if (!validImageTypes.includes(fileMimeType)) {
            return res.status(400).json({ message: 'Only image files are allowed for profile pictures' });
        }
        // Generate unique filename
        const fileExt = fileName.split('.').pop() || 'jpg';
        const uniqueFileName = `profile-${userId}-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        // Handle base64 file data
        let fileBuffer;
        if (fileData.startsWith('data:')) {
            // Base64 with data URI prefix
            const base64Data = fileData.split(',')[1];
            fileBuffer = Buffer.from(base64Data, 'base64');
        }
        else {
            // Plain base64
            fileBuffer = Buffer.from(fileData, 'base64');
        }
        // Validate file size (max 5MB)
        const fileSize = fileBuffer.length;
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (fileSize > maxSize) {
            return res.status(400).json({ message: 'Profile picture must be smaller than 5MB' });
        }
        // Upload to Vercel Blob Storage if configured, otherwise save locally
        let fileUrl;
        const useBlobStorage = process.env.USE_BLOB_STORAGE === 'true';
        const blobReadWriteToken = process.env.BLOB_READ_WRITE_TOKEN;
        console.log('Profile picture upload configuration:', {
            useBlobStorage,
            hasToken: !!blobReadWriteToken,
            fileName: uniqueFileName,
        });
        if (useBlobStorage && blobReadWriteToken) {
            // Upload to Vercel Blob Storage
            try {
                const blobUrl = await uploadToBlobStorage(uniqueFileName, fileBuffer, fileMimeType);
                fileUrl = blobUrl;
                console.log('Profile picture uploaded to Vercel Blob Storage:', fileUrl);
            }
            catch (blobError) {
                console.error('Vercel Blob storage upload failed, falling back to local:', blobError);
                // Fallback to local storage
                const filePath = (0, path_1.join)(UPLOADS_DIR, uniqueFileName);
                await (0, promises_1.writeFile)(filePath, fileBuffer);
                fileUrl = `/uploads/${uniqueFileName}`;
                console.log('Profile picture saved locally as fallback:', filePath);
            }
        }
        else {
            // Save to local filesystem
            const filePath = (0, path_1.join)(UPLOADS_DIR, uniqueFileName);
            await (0, promises_1.writeFile)(filePath, fileBuffer);
            fileUrl = `/uploads/${uniqueFileName}`;
            console.log('Profile picture saved locally:', filePath, 'URL:', fileUrl);
        }
        // Update user's profile_picture in database
        const { rows } = await db_1.pool.query(`UPDATE users 
       SET profile_picture = $1 
       WHERE id = $2 
       RETURNING id, profile_picture`, [fileUrl, userId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        // Return the full URL
        let profilePictureUrl = fileUrl;
        if (!fileUrl.startsWith('http')) {
            const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
            profilePictureUrl = `${baseUrl}${fileUrl}`;
        }
        return res.json({
            success: true,
            profilePicture: profilePictureUrl,
            message: 'Profile picture updated successfully',
        });
    }
    catch (err) {
        console.error('Profile picture upload error', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
});
exports.default = router;
