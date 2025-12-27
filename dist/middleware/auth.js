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
        res.status(401).json({ message: 'Access token required' });
        return;
    }
    if (!process.env.JWT_ACCESS_SECRET) {
        res.status(500).json({ message: 'Server configuration error' });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_ACCESS_SECRET);
        // Verify user still exists and is active, and update last_seen_at for activity tracking
        const { rows } = await db_1.pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1 AND is_active = TRUE RETURNING id, email, role', [decoded.sub]);
        if (rows.length === 0) {
            res.status(401).json({ message: 'User not found or inactive' });
            return;
        }
        const user = rows[0];
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
        };
        next();
    }
    catch (err) {
        if (err instanceof jsonwebtoken_1.default.TokenExpiredError) {
            res.status(401).json({ message: 'Token expired' });
            return;
        }
        if (err instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            res.status(401).json({ message: 'Invalid token' });
            return;
        }
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
