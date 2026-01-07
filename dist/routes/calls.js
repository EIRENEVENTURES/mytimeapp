"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Call routes with Agora integration
 * Server-driven state machine, cost controls, and security
 */
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = require("../db");
const socket_1 = require("../socket");
const crypto_1 = require("crypto");
const router = (0, express_1.Router)();
// Agora configuration (should be in env)
const AGORA_APP_ID = process.env.AGORA_APP_ID || '';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';
// Cost controls
const MAX_CONCURRENT_CALLS_PER_USER = 1;
const CALL_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CALL_HARD_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours max call duration
const DAILY_CALL_MINUTE_CAP = 1440; // 24 hours worth of minutes
const CALL_INITIATION_RATE_LIMIT_MS = 10000; // 10 seconds between calls
/**
 * Generate Agora RTC token (short-lived, ≤120s)
 */
function generateAgoraToken(channelName, uid, role = 'publisher', expirationTime = 120 // 120 seconds default
) {
    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
        throw new Error('Agora credentials not configured');
    }
    // Try to use proper Agora token generation if available
    try {
        const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
        const timestamp = Math.floor(Date.now() / 1000) + expirationTime;
        return RtcTokenBuilder.buildTokenWithUid(AGORA_APP_ID, AGORA_APP_CERTIFICATE, channelName, parseInt(uid) || 0, role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER, timestamp);
    }
    catch (error) {
        // Fallback to simplified token if agora-access-token is not installed
        console.warn('[Calls] agora-access-token not installed, using simplified token. Install it for production: npm install agora-access-token');
        const timestamp = Math.floor(Date.now() / 1000) + expirationTime;
        const token = Buffer.from(JSON.stringify({
            app_id: AGORA_APP_ID,
            channel: channelName,
            uid,
            role,
            expire: timestamp,
        })).toString('base64');
        return token;
    }
}
/**
 * Ensure call tables exist
 */
async function ensureCallTables() {
    await db_1.pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id VARCHAR(255) UNIQUE NOT NULL,
      caller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_type VARCHAR(20) NOT NULL CHECK (call_type IN ('audio', 'video')),
      state VARCHAR(20) NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'calling', 'ringing', 'connected', 'reconnecting', 'ended', 'missed', 'rejected')),
      channel_name VARCHAR(255) NOT NULL,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER DEFAULT 0,
      cost_credits DECIMAL(10, 4) DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_receiver ON calls(receiver_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id);
    CREATE INDEX IF NOT EXISTS idx_calls_state ON calls(state, updated_at)
  `).catch(() => { });
    await db_1.pool.query(`
    CREATE TABLE IF NOT EXISTS call_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id VARCHAR(255) NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      state_before VARCHAR(20),
      state_after VARCHAR(20),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_call_events_call_id ON call_events(call_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_call_events_user ON call_events(user_id, created_at DESC)
  `).catch(() => { });
    await db_1.pool.query(`
    CREATE TABLE IF NOT EXISTS call_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id VARCHAR(255) NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_call_tokens_call_id ON call_tokens(call_id);
    CREATE INDEX IF NOT EXISTS idx_call_tokens_user ON call_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_call_tokens_expires ON call_tokens(expires_at)
  `).catch(() => { });
}
/**
 * Log call event (append-only)
 */
async function logCallEvent(callId, userId, eventType, stateBefore, stateAfter, metadata) {
    await db_1.pool.query(`INSERT INTO call_events (call_id, user_id, event_type, state_before, state_after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`, [callId, userId, eventType, stateBefore, stateAfter, metadata ? JSON.stringify(metadata) : null]);
}
/**
 * Check if user has active call
 */
async function hasActiveCall(userId) {
    const result = await db_1.pool.query(`SELECT id FROM calls 
     WHERE (caller_id = $1 OR receiver_id = $1) 
     AND state IN ('calling', 'ringing', 'connected', 'reconnecting')
     LIMIT 1`, [userId]);
    return result.rows.length > 0;
}
/**
 * Check call initiation rate limit
 */
async function checkRateLimit(userId) {
    const result = await db_1.pool.query(`SELECT created_at FROM call_events 
     WHERE user_id = $1 AND event_type = 'initiate'
     ORDER BY created_at DESC LIMIT 1`, [userId]);
    if (result.rows.length === 0)
        return true;
    const lastCall = new Date(result.rows[0].created_at).getTime();
    const now = Date.now();
    return (now - lastCall) >= CALL_INITIATION_RATE_LIMIT_MS;
}
/**
 * POST /calls/initiate
 * Initiate a call (server creates call_id, generates token, signals receiver)
 */
router.post('/initiate', auth_1.authenticateToken, async (req, res) => {
    try {
        await ensureCallTables();
        const callerId = req.user.id;
        const { receiverId, callType = 'audio' } = req.body;
        if (!receiverId) {
            return res.status(400).json({ error: 'receiverId is required' });
        }
        if (callType !== 'audio' && callType !== 'video') {
            return res.status(400).json({ error: 'callType must be audio or video' });
        }
        // Cost controls: max concurrent calls
        if (await hasActiveCall(callerId)) {
            return res.status(429).json({ error: 'User already has an active call' });
        }
        // Rate limiting
        if (!(await checkRateLimit(callerId))) {
            return res.status(429).json({ error: 'Call initiation rate limit exceeded' });
        }
        // Check if receiver exists
        const receiverCheck = await db_1.pool.query(`SELECT id FROM users WHERE id = $1`, [receiverId]);
        if (receiverCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Receiver not found' });
        }
        // Generate call_id (server-driven)
        const callId = `call_${(0, crypto_1.randomUUID)()}`;
        const channelName = `channel_${callId}`;
        // Create call record
        const callResult = await db_1.pool.query(`INSERT INTO calls (call_id, caller_id, receiver_id, call_type, state, channel_name, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, call_id, caller_id, receiver_id, call_type, state, channel_name, created_at`, [callId, callerId, receiverId, callType, 'calling', channelName]);
        const call = callResult.rows[0];
        // Generate short-lived token for caller (≤120s)
        const token = generateAgoraToken(channelName, callerId, 'publisher', 120);
        const expiresAt = new Date(Date.now() + 120 * 1000);
        // Store token
        await db_1.pool.query(`INSERT INTO call_tokens (call_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`, [callId, callerId, token, expiresAt]);
        // Log event
        await logCallEvent(callId, callerId, 'initiate', 'idle', 'calling', { callType });
        // Update call state to 'ringing' when receiver is notified
        await db_1.pool.query(`UPDATE calls SET state = 'ringing' WHERE call_id = $1`, [callId]);
        // Emit WebSocket event to receiver
        const io = (0, socket_1.getIoInstance)();
        if (io) {
            io.to(`user:${receiverId}`).emit('call:incoming', {
                callId,
                callerId,
                callType,
                channelName,
                timestamp: new Date().toISOString(),
            });
            // Also emit to caller for confirmation
            io.to(`user:${callerId}`).emit('call:initiated', {
                callId,
                receiverId,
                callType,
                channelName,
                token,
                expiresAt: expiresAt.toISOString(),
            });
        }
        // TODO: Send push notification to receiver
        res.json({
            callId,
            channelName,
            token,
            expiresAt: expiresAt.toISOString(),
            callType,
        });
    }
    catch (error) {
        console.error('Initiate call error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * POST /calls/:callId/accept
 * Receiver accepts the call
 */
router.post('/:callId/accept', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { callId } = req.params;
        const callResult = await db_1.pool.query(`SELECT * FROM calls WHERE call_id = $1 AND receiver_id = $2`, [callId, userId]);
        if (callResult.rows.length === 0) {
            return res.status(404).json({ error: 'Call not found' });
        }
        const call = callResult.rows[0];
        if (call.state !== 'ringing' && call.state !== 'calling') {
            return res.status(400).json({ error: `Call is not in a valid state: ${call.state}` });
        }
        // Update call state
        await db_1.pool.query(`UPDATE calls SET state = 'connected', started_at = COALESCE(started_at, NOW()) WHERE call_id = $1`, [callId]);
        // Generate token for receiver
        const token = generateAgoraToken(call.channel_name, userId, 'publisher', 120);
        const expiresAt = new Date(Date.now() + 120 * 1000);
        await db_1.pool.query(`INSERT INTO call_tokens (call_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`, [callId, userId, token, expiresAt]);
        // Log event
        await logCallEvent(callId, userId, 'accept', call.state, 'connected');
        // Emit WebSocket events
        const io = (0, socket_1.getIoInstance)();
        if (io) {
            io.to(`user:${call.caller_id}`).emit('call:accepted', {
                callId,
                receiverId: userId,
                token,
                expiresAt: expiresAt.toISOString(),
            });
            io.to(`user:${userId}`).emit('call:accepted', {
                callId,
                callerId: call.caller_id,
                token,
                expiresAt: expiresAt.toISOString(),
            });
        }
        res.json({
            callId,
            channelName: call.channel_name,
            token,
            expiresAt: expiresAt.toISOString(),
        });
    }
    catch (error) {
        console.error('Accept call error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * POST /calls/:callId/reject
 * Receiver rejects the call
 */
router.post('/:callId/reject', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { callId } = req.params;
        const callResult = await db_1.pool.query(`SELECT * FROM calls WHERE call_id = $1 AND (caller_id = $2 OR receiver_id = $2)`, [callId, userId]);
        if (callResult.rows.length === 0) {
            return res.status(404).json({ error: 'Call not found' });
        }
        const call = callResult.rows[0];
        const previousState = call.state;
        // Update call state
        await db_1.pool.query(`UPDATE calls SET state = 'rejected', ended_at = NOW() WHERE call_id = $1`, [callId]);
        // Log event
        await logCallEvent(callId, userId, 'reject', previousState, 'rejected');
        // Emit WebSocket events
        const io = (0, socket_1.getIoInstance)();
        if (io) {
            const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
            io.to(`user:${otherUserId}`).emit('call:rejected', { callId });
            io.to(`user:${userId}`).emit('call:rejected', { callId });
        }
        res.json({ success: true });
    }
    catch (error) {
        console.error('Reject call error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * POST /calls/:callId/end
 * End a call
 */
router.post('/:callId/end', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { callId } = req.params;
        const callResult = await db_1.pool.query(`SELECT * FROM calls WHERE call_id = $1 AND (caller_id = $2 OR receiver_id = $2)`, [callId, userId]);
        if (callResult.rows.length === 0) {
            return res.status(404).json({ error: 'Call not found' });
        }
        const call = callResult.rows[0];
        const previousState = call.state;
        // Calculate duration
        const startedAt = call.started_at ? new Date(call.started_at) : new Date();
        const durationSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
        // Update call state
        await db_1.pool.query(`UPDATE calls SET state = 'ended', ended_at = NOW(), duration_seconds = $1 WHERE call_id = $2`, [durationSeconds, callId]);
        // Log event
        await logCallEvent(callId, userId, 'end', previousState, 'ended', { durationSeconds });
        // Emit WebSocket events
        const io = (0, socket_1.getIoInstance)();
        if (io) {
            const otherUserId = call.caller_id === userId ? call.receiver_id : call.caller_id;
            io.to(`user:${otherUserId}`).emit('call:ended', { callId, durationSeconds });
            io.to(`user:${userId}`).emit('call:ended', { callId, durationSeconds });
        }
        res.json({ success: true, durationSeconds });
    }
    catch (error) {
        console.error('End call error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * POST /calls/:callId/token
 * Get or refresh Agora token (short-lived, ≤120s)
 */
router.post('/:callId/token', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { callId } = req.params;
        const callResult = await db_1.pool.query(`SELECT * FROM calls WHERE call_id = $1 AND (caller_id = $2 OR receiver_id = $2)`, [callId, userId]);
        if (callResult.rows.length === 0) {
            return res.status(404).json({ error: 'Call not found' });
        }
        const call = callResult.rows[0];
        // Generate new token (no reuse)
        const token = generateAgoraToken(call.channel_name, userId, 'publisher', 120);
        const expiresAt = new Date(Date.now() + 120 * 1000);
        // Store token
        await db_1.pool.query(`INSERT INTO call_tokens (call_id, user_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`, [callId, userId, token, expiresAt]);
        res.json({
            token,
            expiresAt: expiresAt.toISOString(),
        });
    }
    catch (error) {
        console.error('Get token error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * GET /calls/history
 * Get call history for current user
 */
router.get('/history', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const offset = parseInt(req.query.offset) || 0;
        const result = await db_1.pool.query(`SELECT 
        c.id,
        c.call_id,
        c.caller_id,
        c.receiver_id,
        c.call_type,
        c.state,
        c.started_at,
        c.ended_at,
        c.duration_seconds,
        c.cost_credits,
        c.created_at,
        caller.display_name as caller_name,
        receiver.display_name as receiver_name
       FROM calls c
       LEFT JOIN users caller ON c.caller_id = caller.id
       LEFT JOIN users receiver ON c.receiver_id = receiver.id
       WHERE c.caller_id = $1 OR c.receiver_id = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`, [userId, limit, offset]);
        res.json({
            calls: result.rows.map((row) => ({
                id: row.id,
                callId: row.call_id,
                callerId: row.caller_id,
                receiverId: row.receiver_id,
                callType: row.call_type,
                state: row.state,
                startedAt: row.started_at,
                endedAt: row.ended_at,
                durationSeconds: row.duration_seconds,
                costCredits: row.cost_credits,
                createdAt: row.created_at,
                callerName: row.caller_name,
                receiverName: row.receiver_name,
                isIncoming: row.receiver_id === userId,
            })),
        });
    }
    catch (error) {
        console.error('Get call history error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * GET /calls/:callId
 * Get call details
 */
router.get('/:callId', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { callId } = req.params;
        const result = await db_1.pool.query(`SELECT * FROM calls WHERE call_id = $1 AND (caller_id = $2 OR receiver_id = $2)`, [callId, userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Call not found' });
        }
        res.json({ call: result.rows[0] });
    }
    catch (error) {
        console.error('Get call error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * GET /calls/config/agora-app-id
 * Get Agora App ID for client configuration
 */
router.get('/config/agora-app-id', auth_1.authenticateToken, async (req, res) => {
    try {
        if (!AGORA_APP_ID) {
            return res.status(503).json({
                error: 'Agora service not configured',
                appId: ''
            });
        }
        res.json({ appId: AGORA_APP_ID });
    }
    catch (error) {
        console.error('Get Agora config error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
exports.default = router;
