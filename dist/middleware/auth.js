"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateToken = authenticateToken;
exports.requireRole = requireRole;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("../db");
/**
 * Authentication middleware to verify JWT access token
 */
async function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    if (!token) {
        console.log('[Auth] No token provided for', req.method, req.path);
        res.status(401).json({ message: 'Access token required' });
        return;
    }
    if (!process.env.JWT_ACCESS_SECRET) {
        console.error('[Auth] JWT_ACCESS_SECRET not configured');
        res.status(500).json({ message: 'Server configuration error' });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_ACCESS_SECRET);
        // First, verify user exists and is active (SELECT query)
        const { rows } = await db_1.pool.query('SELECT id, email, role, is_active FROM users WHERE id = $1', [decoded.sub]);
        if (rows.length === 0) {
            console.log('[Auth] User not found:', decoded.sub, 'for', req.method, req.path);
            res.status(401).json({ message: 'User not found' });
            return;
        }
        const user = rows[0];
        // Check if user is active
        if (!user.is_active) {
            console.log('[Auth] User is inactive:', decoded.sub, 'for', req.method, req.path);
            res.status(401).json({ message: 'User account is inactive' });
            return;
        }
        // Update last_seen_at for activity tracking (non-blocking - don't fail auth if this fails)
        db_1.pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [decoded.sub]).catch((err) => {
            // Log error but don't fail authentication
            console.error('[Auth] Failed to update last_seen_at for user:', decoded.sub, err);
        });
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
        };
        next();
    }
    catch (err) {
        if (err instanceof jsonwebtoken_1.default.TokenExpiredError) {
            console.log('[Auth] Token expired for', req.method, req.path);
            res.status(401).json({ message: 'Token expired' });
            return;
        }
        if (err instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            console.log('[Auth] Invalid token for', req.method, req.path, ':', err.message);
            res.status(401).json({ message: 'Invalid token' });
            return;
        }
        console.error('[Auth] Authentication error for', req.method, req.path, ':', err);
        res.status(500).json({ message: 'Authentication error' });
    }
}
/**
 * Optional: Role-based authorization middleware
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ message: 'Authentication required' });
            return;
        }
        if (!allowedRoles.includes(req.user.role)) {
            res.status(403).json({ message: 'Insufficient permissions' });
            return;
        }
        next();
    };
}
