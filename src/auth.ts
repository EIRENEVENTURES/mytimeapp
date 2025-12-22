import { Router, Request, Response } from 'express';
import { pool } from './db';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import { authenticateToken } from './middleware/auth';

const router = Router();
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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

// Real-time validation endpoints
router.get('/validate/username/:username', async (req: Request, res: Response) => {
  const { username } = req.params;
  if (!username || username.trim().length === 0) {
    return res.json({ available: false, message: 'Username is required' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [
      username.trim().toLowerCase(),
    ]);
    if (rows.length > 0) {
      return res.json({ available: false, message: 'Username is not available' });
    }
    return res.json({ available: true });
  } catch (err) {
    console.error('Username validation error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/validate/email/:email', async (req: Request, res: Response) => {
  const { email } = req.params;
  if (!email || email.trim().length === 0) {
    return res.json({ available: false, message: 'Email is required' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    if (rows.length > 0) {
      return res.json({
        available: false,
        message: 'Email exists, please sign up with another email',
      });
    }
    return res.json({ available: true });
  } catch (err) {
    console.error('Email validation error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/validate/phone/:phone', async (req: Request, res: Response) => {
  const { phone } = req.params;
  if (!phone || phone.trim().length === 0) {
    return res.json({ available: false, message: 'Phone number is required' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE phone_number = $1', [
      phone.trim(),
    ]);
    if (rows.length > 0) {
      return res.json({
        available: false,
        message: 'Phone number exists, please provide another phone number',
      });
    }
    return res.json({ available: true });
  } catch (err) {
    console.error('Phone validation error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Generate and send OTP
router.post('/otp/send', async (req: Request, res: Response) => {
  const { email } = req.body ?? {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ message: 'Email is required' });
  }

  if (!resend) {
    return res.status(500).json({ message: 'Email service is not configured' });
  }

  const client = await pool.connect();
  try {
    // Generate 4-digit OTP
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 60); // 60 seconds expiry

    // Delete any existing OTPs for this email
    await client.query('DELETE FROM otp_verifications WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);

    // Insert new OTP
    await client.query(
      `INSERT INTO otp_verifications (email, otp_code, expires_at)
       VALUES ($1, $2, $3)`,
      [email.toLowerCase().trim(), otpCode, expiresAt],
    );

    // Send email via Resend
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email - My Time</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%); border-radius: 16px 16px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">My Time</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 16px; color: #1F2937; font-size: 24px; font-weight: 600;">Verify Your Email</h2>
              <p style="margin: 0 0 24px; color: #6B7280; font-size: 16px; line-height: 1.6;">
                Thank you for signing up! Please use the verification code below to complete your registration.
              </p>
              
              <!-- OTP Code Box -->
              <div style="background-color: #F9FAFB; border: 2px dashed #6366F1; border-radius: 12px; padding: 32px; text-align: center; margin: 32px 0;">
                <div style="font-size: 48px; font-weight: 700; color: #6366F1; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                  ${otpCode}
                </div>
              </div>
              
              <p style="margin: 24px 0 0; color: #9CA3AF; font-size: 14px; line-height: 1.6;">
                This code will expire in <strong style="color: #6366F1;">60 seconds</strong>. If you didn't request this code, please ignore this email.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background-color: #F9FAFB; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #9CA3AF; font-size: 12px;">
                © ${new Date().getFullYear()} My Time. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'My Time <onboarding@resend.dev>',
      to: email.toLowerCase().trim(),
      subject: 'Verify Your Email - My Time',
      html: emailHtml,
    });

    return res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('OTP send error', err);
    return res.status(500).json({ message: 'Failed to send OTP' });
  } finally {
    client.release();
  }
});

// Verify OTP
router.post('/otp/verify', async (req: Request, res: Response) => {
  const { email, otpCode } = req.body ?? {};

  if (!email || !otpCode) {
    return res.status(400).json({ message: 'Email and OTP code are required' });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, expires_at, verified
       FROM otp_verifications
       WHERE email = $1 AND otp_code = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [email.toLowerCase().trim(), otpCode],
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'Invalid OTP code' });
    }

    const otpRecord = rows[0];
    const now = new Date();
    const expiresAt = new Date(otpRecord.expires_at);

    if (expiresAt.getTime() <= now.getTime()) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    if (otpRecord.verified) {
      return res.status(400).json({ message: 'OTP has already been used' });
    }

    // Mark OTP as verified
    await client.query('UPDATE otp_verifications SET verified = TRUE WHERE id = $1', [
      otpRecord.id,
    ]);

    return res.json({ success: true, message: 'OTP verified successfully' });
  } catch (err) {
    console.error('OTP verify error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Updated signup endpoint with OTP verification
router.post('/signup', async (req: Request, res: Response) => {
  const { email, password, displayName, username, phoneNumber, otpCode, country } =
    req.body ?? {};

  if (!email || !password || !displayName || !username || !phoneNumber) {
    return res.status(400).json({
      message: 'email, password, displayName, username, and phoneNumber are required',
    });
  }

  if (!otpCode) {
    return res.status(400).json({ message: 'OTP verification is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify OTP first
    const otpResult = await client.query(
      `SELECT id, expires_at, verified
       FROM otp_verifications
       WHERE email = $1 AND otp_code = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [String(email).toLowerCase().trim(), otpCode],
    );

    if (otpResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invalid OTP code' });
    }

    const otpRecord = otpResult.rows[0];
    const now = new Date();
    const expiresAt = new Date(otpRecord.expires_at);

    if (expiresAt.getTime() <= now.getTime()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'OTP has expired' });
    }

    if (otpRecord.verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'OTP has already been used' });
    }

    // Check for existing users
    const existingEmail = await client.query('SELECT id FROM users WHERE email = $1', [
      String(email).toLowerCase().trim(),
    ]);
    if (existingEmail.rowCount && existingEmail.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Email already in use' });
    }

    const existingUsername = await client.query('SELECT id FROM users WHERE username = $1', [
      String(username).trim().toLowerCase(),
    ]);
    if (existingUsername.rowCount && existingUsername.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Username is not available' });
    }

    const existingPhone = await client.query('SELECT id FROM users WHERE phone_number = $1', [
      String(phoneNumber).trim(),
    ]);
    if (existingPhone.rowCount && existingPhone.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Phone number already in use' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, display_name, username, phone_number, email_verified, country)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       RETURNING id, email, display_name, username, phone_number, role, country`,
      [
        String(email).toLowerCase().trim(),
        passwordHash,
        displayName,
        String(username).trim().toLowerCase(),
        String(phoneNumber).trim(),
        country ? String(country).trim() : null,
      ],
    );
    const user = rows[0];

    // Mark OTP as verified
    await client.query('UPDATE otp_verifications SET verified = TRUE WHERE id = $1', [
      otpRecord.id,
    ]);

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

    // Send welcome email
    if (resend) {
      try {
        const welcomeEmailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to My Time</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%); border-radius: 16px 16px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">My Time</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 16px; color: #1F2937; font-size: 24px; font-weight: 600;">Welcome to My Time, ${displayName}! 🎉</h2>
              <p style="margin: 0 0 24px; color: #6B7280; font-size: 16px; line-height: 1.6;">
                We're thrilled to have you join our community! You're now ready to start monetizing your conversations and connecting with people who value your time.
              </p>
              
              <!-- Features Box -->
              <div style="background: linear-gradient(135deg, #F9FAFB 0%, #F3F4F6 100%); border-radius: 12px; padding: 24px; margin: 32px 0;">
                <h3 style="margin: 0 0 16px; color: #1F2937; font-size: 18px; font-weight: 600;">What you can do now:</h3>
                <ul style="margin: 0; padding-left: 20px; color: #4B5563; font-size: 15px; line-height: 1.8;">
                  <li>Set your conversation rates</li>
                  <li>Connect with people who value your expertise</li>
                  <li>Earn money from your time and knowledge</li>
                  <li>Build meaningful connections</li>
                </ul>
              </div>
              
              <!-- CTA Button -->
              <div style="text-align: center; margin: 32px 0;">
                <a href="#" style="display: inline-block; background-color: #6366F1; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 600; font-size: 16px;">Get Started</a>
              </div>
              
              <p style="margin: 24px 0 0; color: #9CA3AF; font-size: 14px; line-height: 1.6;">
                If you have any questions, feel free to reach out to our support team. We're here to help!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background-color: #F9FAFB; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #9CA3AF; font-size: 12px;">
                © ${new Date().getFullYear()} My Time. All rights reserved.
              </p>
              <p style="margin: 8px 0 0; color: #9CA3AF; font-size: 12px;">
                You're receiving this email because you signed up for My Time.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `;

        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'My Time <onboarding@resend.dev>',
          to: email.toLowerCase().trim(),
          subject: 'Welcome to My Time! 🎉',
          html: welcomeEmailHtml,
        });
      } catch (emailErr) {
        // Log but don't fail signup if email fails
        console.error('Welcome email error', emailErr);
      }
    }

    return res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        username: user.username,
        phoneNumber: user.phone_number,
        role: user.role,
        country: user.country,
      },
      accessToken,
      refreshToken,
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Signup error', err);
    if (err.code === '23505') {
      // Unique constraint violation
      return res.status(409).json({ message: 'Username, email, or phone number already in use' });
    }
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const { identifier, email, password } = req.body ?? {};

  const loginId = (identifier ?? email)?.toString().trim();

  if (!loginId || !password) {
    return res
      .status(400)
      .json({ message: 'identifier (email, username, or phone number) and password are required' });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, email, password_hash, display_name, role, username, phone_number
       FROM users
       WHERE is_active = TRUE
         AND (
           LOWER(email) = LOWER($1)
           OR LOWER(username) = LOWER($1)
           OR phone_number = $1
         )`,
      [loginId],
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

// Reset Password (logged-in) - send OTP
router.post('/reset-password/send-otp', authenticateToken, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body ?? {};
  const userId = req.user!.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      message: 'Current password and new password are required',
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  if (!resend) {
    return res.status(500).json({ message: 'Email service is not configured' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT email, password_hash, display_name FROM users WHERE id = $1',
      [userId],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found' });
    }

    const user = rows[0];

    // Verify current password
    const valid = await bcrypt.compare(String(currentPassword), user.password_hash);
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Ensure new password is different from old
    const isSame = await bcrypt.compare(String(newPassword), user.password_hash);
    if (isSame) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ message: 'New password must be different from your previous password' });
    }

    // Generate OTP
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 60); // 60 seconds

    // Clear existing unverified OTPs
    await client.query('DELETE FROM otp_verifications WHERE email = $1 AND verified = FALSE', [
      user.email.toLowerCase().trim(),
    ]);

    await client.query(
      `INSERT INTO otp_verifications (email, otp_code, expires_at)
       VALUES ($1, $2, $3)`,
      [user.email.toLowerCase().trim(), otpCode, expiresAt],
    );

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Password Change - My Time</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%); border-radius: 16px 16px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">My Time</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 16px; color: #1F2937; font-size: 24px; font-weight: 600;">Confirm Your Password Change</h2>
              <p style="margin: 0 0 24px; color: #6B7280; font-size: 16px; line-height: 1.6;">
                Hi ${user.display_name},<br><br>
                We received a request to change the password for your account. Use the verification code below to confirm this change.
              </p>
              <div style="background-color: #F9FAFB; border: 2px dashed #6366F1; border-radius: 12px; padding: 32px; text-align: center; margin: 32px 0;">
                <div style="font-size: 48px; font-weight: 700; color: #6366F1; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                  ${otpCode}
                </div>
              </div>
              <p style="margin: 24px 0 0; color: #9CA3AF; font-size: 14px; line-height: 1.6;">
                This code will expire in <strong style="color: #6366F1;">60 seconds</strong>. If you did not request this change, please secure your account immediately.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 40px; background-color: #F9FAFB; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #9CA3AF; font-size: 12px;">
                © ${new Date().getFullYear()} My Time. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    await resend!.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'My Time <onboarding@resend.dev>',
      to: user.email.toLowerCase().trim(),
      subject: 'Confirm Your Password Change - My Time',
      html: emailHtml,
    });

    await client.query('COMMIT');

    return res.json({ success: true, message: 'Verification code sent to your email' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset password send OTP error', err);
    return res.status(500).json({ message: 'Failed to send verification code' });
  } finally {
    client.release();
  }
});

// Reset Password (logged-in) - confirm with OTP
router.post('/reset-password/confirm', authenticateToken, async (req: Request, res: Response) => {
  const { currentPassword, newPassword, otpCode } = req.body ?? {};
  const userId = req.user!.id;

  if (!currentPassword || !newPassword || !otpCode) {
    return res.status(400).json({
      message: 'Current password, new password and OTP code are required',
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query(
      'SELECT email, password_hash, display_name FROM users WHERE id = $1',
      [userId],
    );

    if (userRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRows[0];

    // Verify current password again
    const valid = await bcrypt.compare(String(currentPassword), user.password_hash);
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Prevent reusing the same password
    const isSame = await bcrypt.compare(String(newPassword), user.password_hash);
    if (isSame) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ message: 'New password must be different from your previous password' });
    }

    // Verify OTP
    const { rows: otpRows } = await client.query(
      `SELECT id, expires_at, verified
       FROM otp_verifications
       WHERE email = $1 AND otp_code = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [user.email.toLowerCase().trim(), otpCode],
    );

    if (otpRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invalid OTP code' });
    }

    const otpRecord = otpRows[0];
    const now = new Date();
    const expiresAt = new Date(otpRecord.expires_at);

    if (expiresAt.getTime() <= now.getTime()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'OTP has expired' });
    }

    if (otpRecord.verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'OTP has already been used' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(String(newPassword), 12);

    // Update password
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      userId,
    ]);

    // Mark OTP as verified
    await client.query('UPDATE otp_verifications SET verified = TRUE WHERE id = $1', [
      otpRecord.id,
    ]);

    await client.query('COMMIT');

    return res.json({ success: true, message: 'Password has been updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset password confirm error', err);
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

// Forgot Password - Send OTP
router.post('/forgot-password/send-otp', async (req: Request, res: Response) => {
  const { email } = req.body ?? {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ message: 'Email is required' });
  }

  if (!resend) {
    return res.status(500).json({ message: 'Email service is not configured' });
  }

  const client = await pool.connect();
  try {
    // Check if user exists
    const { rows } = await client.query('SELECT id, display_name FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);

    if (rows.length === 0) {
      // Don't reveal if email exists for security
      return res.json({ success: true, message: 'If the email exists, an OTP has been sent' });
    }

    const user = rows[0];

    // Generate 4-digit OTP
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 60); // 60 seconds expiry

    // Delete any existing password reset OTPs for this email
    await client.query(
      'DELETE FROM otp_verifications WHERE email = $1 AND verified = FALSE',
      [email.toLowerCase().trim()],
    );

    // Insert new OTP
    await client.query(
      `INSERT INTO otp_verifications (email, otp_code, expires_at)
       VALUES ($1, $2, $3)`,
      [email.toLowerCase().trim(), otpCode, expiresAt],
    );

    // Send email via Resend
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password - My Time</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%); border-radius: 16px 16px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">My Time</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 16px; color: #1F2937; font-size: 24px; font-weight: 600;">Reset Your Password</h2>
              <p style="margin: 0 0 24px; color: #6B7280; font-size: 16px; line-height: 1.6;">
                Hi ${user.display_name},<br><br>
                We received a request to reset your password. Use the verification code below to proceed.
              </p>
              
              <!-- OTP Code Box -->
              <div style="background-color: #F9FAFB; border: 2px dashed #6366F1; border-radius: 12px; padding: 32px; text-align: center; margin: 32px 0;">
                <div style="font-size: 48px; font-weight: 700; color: #6366F1; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                  ${otpCode}
                </div>
              </div>
              
              <p style="margin: 24px 0 0; color: #9CA3AF; font-size: 14px; line-height: 1.6;">
                This code will expire in <strong style="color: #6366F1;">60 seconds</strong>. If you didn't request this code, please ignore this email and your password will remain unchanged.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background-color: #F9FAFB; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #9CA3AF; font-size: 12px;">
                © ${new Date().getFullYear()} My Time. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'My Time <onboarding@resend.dev>',
      to: email.toLowerCase().trim(),
      subject: 'Reset Your Password - My Time',
      html: emailHtml,
    });

    return res.json({ success: true, message: 'If the email exists, an OTP has been sent' });
  } catch (err) {
    console.error('Forgot password OTP send error', err);
    return res.status(500).json({ message: 'Failed to send OTP' });
  } finally {
    client.release();
  }
});

// Forgot Password - Verify OTP and Reset Password
router.post('/forgot-password/reset', async (req: Request, res: Response) => {
  const { email, otpCode, newPassword } = req.body ?? {};

  if (!email || !otpCode || !newPassword) {
    return res.status(400).json({
      message: 'Email, OTP code, and new password are required',
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify OTP
    const otpResult = await client.query(
      `SELECT id, expires_at, verified
       FROM otp_verifications
       WHERE email = $1 AND otp_code = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [email.toLowerCase().trim(), otpCode],
    );

    if (otpResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invalid OTP code' });
    }

    const otpRecord = otpResult.rows[0];
    const now = new Date();
    const expiresAt = new Date(otpRecord.expires_at);

    if (expiresAt.getTime() <= now.getTime()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'OTP has expired' });
    }

    if (otpRecord.verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'OTP has already been used' });
    }

    // Check if user exists
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent reusing the same password
    const { rows: userRows } = await client.query(
      'SELECT password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()],
    );
    if (userRows.length > 0) {
      const isSame = await bcrypt.compare(String(newPassword), userRows[0].password_hash);
      if (isSame) {
        await client.query('ROLLBACK');
        return res
          .status(400)
          .json({ message: 'New password must be different from your previous password' });
      }
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(String(newPassword), 12);

    // Update password
    await client.query('UPDATE users SET password_hash = $1 WHERE email = $2', [
      passwordHash,
      email.toLowerCase().trim(),
    ]);

    // Mark OTP as verified
    await client.query('UPDATE otp_verifications SET verified = TRUE WHERE id = $1', [
      otpRecord.id,
    ]);

    // Revoke all existing sessions for security
    await client.query(
      `UPDATE sessions SET revoked_at = NOW() 
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [rows[0].id],
    );

    await client.query('COMMIT');

    return res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Password reset error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Reset Password (for authenticated users)
router.post('/reset-password', authenticateToken, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body ?? {};
  const userId = req.user!.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      message: 'Current password and new password are required',
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current password hash
    const { rows } = await client.query('SELECT password_hash FROM users WHERE id = $1', [userId]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify current password
    const valid = await bcrypt.compare(String(currentPassword), rows[0].password_hash);
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Prevent reusing the same password
    const isSame = await bcrypt.compare(String(newPassword), rows[0].password_hash);
    if (isSame) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ message: 'New password must be different from your previous password' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(String(newPassword), 12);

    // Update password
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      userId,
    ]);

    await client.query('COMMIT');

    return res.json({ success: true, message: 'Password has been updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Password reset error', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;


