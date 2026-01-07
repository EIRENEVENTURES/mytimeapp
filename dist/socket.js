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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocketIO = setupSocketIO;
exports.getIoInstance = getIoInstance;
exports.emitMessageToUsers = emitMessageToUsers;
exports.emitMessageStatus = emitMessageStatus;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("./db");
const redis_1 = require("./redis");
// Store io instance for use in routes
let ioInstance = null;
// Store user socket connections (userId -> socketId)
const userSockets = new Map();
// Store conversation rooms (userId -> Set of socketIds)
const conversationRooms = new Map();
/**
 * Authenticate socket connection using JWT token
 */
function authenticateSocket(socket, token) {
    try {
        // Use JWT_ACCESS_SECRET to match the secret used for signing access tokens
        const jwtSecret = process.env.JWT_ACCESS_SECRET;
        if (!jwtSecret) {
            console.error('JWT_ACCESS_SECRET not configured');
            return null;
        }
        // Token payload uses 'sub' for user ID (not 'id'), matching auth.ts structure
        const decoded = jsonwebtoken_1.default.verify(token, jwtSecret);
        socket.userId = decoded.sub;
        return decoded.sub;
    }
    catch (error) {
        console.error('Socket authentication error:', error);
        return null;
    }
}
/**
 * Get conversation room ID for two users
 */
function getConversationRoomId(userId1, userId2) {
    // Sort user IDs to ensure consistent room ID
    const [id1, id2] = [userId1, userId2].sort();
    return `conversation:${id1}:${id2}`;
}
/**
 * Setup Socket.IO event handlers
 */
function setupSocketIO(io) {
    ioInstance = io;
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        const userId = socket.handshake.auth?.userId;
        if (!token) {
            return next(new Error('Authentication token required'));
        }
        const authenticatedUserId = authenticateSocket(socket, token);
        if (!authenticatedUserId) {
            return next(new Error('Invalid authentication token'));
        }
        // Verify userId matches token
        if (userId && userId !== authenticatedUserId) {
            return next(new Error('User ID mismatch'));
        }
        next();
    });
    io.on('connection', (socket) => {
        const userId = socket.userId;
        console.log(`User ${userId} connected via WebSocket`);
        // Store user socket connection
        userSockets.set(userId, socket.id);
        // Update presence in Redis
        (0, redis_1.setUserPresence)(userId, true).catch((err) => console.error('Failed to update presence:', err));
        // Join user's personal room for direct messages
        socket.join(`user:${userId}`);
        // Handle conversation join
        socket.on('conversation:join', ({ userId: otherUserId }) => {
            const roomId = getConversationRoomId(userId, otherUserId);
            socket.join(roomId);
            if (!conversationRooms.has(roomId)) {
                conversationRooms.set(roomId, new Set());
            }
            conversationRooms.get(roomId).add(socket.id);
            console.log(`User ${userId} joined conversation with ${otherUserId}`);
        });
        // Handle conversation leave
        socket.on('conversation:leave', ({ userId: otherUserId }) => {
            const roomId = getConversationRoomId(userId, otherUserId);
            socket.leave(roomId);
            const room = conversationRooms.get(roomId);
            if (room) {
                room.delete(socket.id);
                if (room.size === 0) {
                    conversationRooms.delete(roomId);
                }
            }
            console.log(`User ${userId} left conversation with ${otherUserId}`);
        });
        // Handle message sending (optional - can still use REST API)
        // Note: This is kept for backward compatibility, but REST API is preferred
        socket.on('message:send', async (data) => {
            try {
                // Validate data
                if (!data.recipientId || !data.content) {
                    socket.emit('error', { message: 'Recipient ID and content are required' });
                    return;
                }
                // Use message service for business logic
                const { createMessage } = await Promise.resolve().then(() => __importStar(require('./services/messageService')));
                const message = await createMessage({
                    senderId: userId,
                    recipientId: data.recipientId,
                    content: data.content,
                    replyToMessageId: data.replyToMessageId || null,
                });
                // Format message for client (minimal payload - ID only for fan-out)
                const messageData = {
                    id: message.id,
                    senderId: message.senderId,
                    recipientId: message.recipientId,
                    content: message.content,
                    status: message.status,
                    createdAt: message.createdAt.toISOString(),
                    replyToMessageId: message.replyToMessageId,
                    isForwarded: message.isForwarded || false,
                    isEdited: message.isEdited || false,
                    isPinned: message.isPinned || false,
                };
                // Emit minimal payload (ID only) - client should fetch full message if needed
                socket.emit('message:new', { id: message.id });
                io.to(`user:${data.recipientId}`).emit('message:new', { id: message.id });
            }
            catch (error) {
                console.error('Error handling message:send:', error);
                socket.emit('error', { message: 'Failed to send message' });
            }
        });
        // Handle typing status (store in Redis, emit via WebSocket)
        socket.on('typing', async (data) => {
            try {
                // Store typing status in Redis
                await (0, redis_1.setTypingStatus)(userId, data.recipientId, data.isTyping);
                const roomId = getConversationRoomId(userId, data.recipientId);
                // Emit minimal payload (just user ID and status)
                if (data.isTyping) {
                    io.to(roomId).except(socket.id).emit('typing:start', { userId });
                }
                else {
                    io.to(roomId).except(socket.id).emit('typing:stop', { userId });
                }
            }
            catch (error) {
                console.error('Error handling typing:', error);
            }
        });
        // Handle message status updates (delivered/read)
        socket.on('message:status', async (data) => {
            try {
                // Update message status in database
                await db_1.pool.query(`UPDATE messages SET status = $1 WHERE id = $2 AND recipient_id = $3`, [data.status, data.messageId, userId]);
                // Get message sender
                const { rows } = await db_1.pool.query(`SELECT sender_id FROM messages WHERE id = $1`, [data.messageId]);
                if (rows.length > 0) {
                    const senderId = rows[0].sender_id;
                    // Notify sender of status update
                    io.to(`user:${senderId}`).emit('message:status', {
                        messageId: data.messageId,
                        status: data.status,
                    });
                }
            }
            catch (error) {
                console.error('Error handling message:status:', error);
            }
        });
        // Handle disconnection
        socket.on('disconnect', () => {
            console.log(`User ${userId} disconnected`);
            userSockets.delete(userId);
            // Update presence in Redis (user went offline)
            (0, redis_1.setUserPresence)(userId, false).catch((err) => console.error('Failed to update presence:', err));
            // Clean up conversation rooms
            conversationRooms.forEach((room, roomId) => {
                room.delete(socket.id);
                if (room.size === 0) {
                    conversationRooms.delete(roomId);
                }
            });
        });
    });
}
/**
 * Get the Socket.IO instance (for use in routes)
 */
function getIoInstance() {
    return ioInstance;
}
/**
 * Emit message to users (called from REST API routes)
 * Uses minimal payload (message ID only) - client fetches full message if needed
 */
function emitMessageToUsers(senderId, recipientId, message // Accept minimal payload or full message
) {
    if (!ioInstance)
        return;
    // Minimal payload: only message ID for initial notification
    // Client can fetch full message via reconciliation endpoint if needed
    const minimalPayload = typeof message === 'object' && 'id' in message
        ? { id: message.id }
        : { id: message.id || message };
    // Emit to sender (best effort)
    try {
        ioInstance.to(`user:${senderId}`).emit('message:new', minimalPayload);
    }
    catch (err) {
        console.error('Failed to emit to sender:', err);
    }
    // Emit to recipient if online (best effort)
    if (userSockets.has(recipientId)) {
        try {
            ioInstance.to(`user:${recipientId}`).emit('message:new', minimalPayload);
        }
        catch (err) {
            console.error('Failed to emit to recipient:', err);
        }
    }
}
/**
 * Emit message status update
 */
function emitMessageStatus(messageId, status, senderId) {
    if (!ioInstance)
        return;
    ioInstance.to(`user:${senderId}`).emit('message:status', {
        messageId,
        status,
    });
}
