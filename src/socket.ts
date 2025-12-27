/**
 * Socket.IO setup and event handlers
 */
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { pool } from './db';
import { setUserPresence, setTypingStatus } from './redis';

// Store io instance for use in routes
let ioInstance: Server | null = null;

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

interface MessageData {
  recipientId: string;
  content: string;
  replyToMessageId?: string;
}

interface TypingData {
  recipientId: string;
  isTyping: boolean;
}

// Store user socket connections (userId -> socketId)
const userSockets = new Map<string, string>();

// Store conversation rooms (userId -> Set of socketIds)
const conversationRooms = new Map<string, Set<string>>();

/**
 * Authenticate socket connection using JWT token
 */
function authenticateSocket(socket: AuthenticatedSocket, token: string): string | null {
  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error('JWT_SECRET not configured');
      return null;
    }

    const decoded = jwt.verify(token, jwtSecret) as { id: string; email: string };
    socket.userId = decoded.id;
    return decoded.id;
  } catch (error) {
    console.error('Socket authentication error:', error);
    return null;
  }
}

/**
 * Get conversation room ID for two users
 */
function getConversationRoomId(userId1: string, userId2: string): string {
  // Sort user IDs to ensure consistent room ID
  const [id1, id2] = [userId1, userId2].sort();
  return `conversation:${id1}:${id2}`;
}

/**
 * Setup Socket.IO event handlers
 */
export function setupSocketIO(io: Server): void {
  ioInstance = io;
  io.use((socket: AuthenticatedSocket, next) => {
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

  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.userId!;
    console.log(`User ${userId} connected via WebSocket`);

    // Store user socket connection
    userSockets.set(userId, socket.id);

    // Update presence in Redis
    setUserPresence(userId, true).catch((err) =>
      console.error('Failed to update presence:', err)
    );

    // Join user's personal room for direct messages
    socket.join(`user:${userId}`);

    // Handle conversation join
    socket.on('conversation:join', ({ userId: otherUserId }: { userId: string }) => {
      const roomId = getConversationRoomId(userId, otherUserId);
      socket.join(roomId);

      if (!conversationRooms.has(roomId)) {
        conversationRooms.set(roomId, new Set());
      }
      conversationRooms.get(roomId)!.add(socket.id);

      console.log(`User ${userId} joined conversation with ${otherUserId}`);
    });

    // Handle conversation leave
    socket.on('conversation:leave', ({ userId: otherUserId }: { userId: string }) => {
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
    socket.on('message:send', async (data: MessageData) => {
      try {
        // Validate data
        if (!data.recipientId || !data.content) {
          socket.emit('error', { message: 'Recipient ID and content are required' });
          return;
        }

        // Use message service for business logic
        const { createMessage } = await import('./services/messageService');
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
      } catch (error) {
        console.error('Error handling message:send:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Handle typing status (store in Redis, emit via WebSocket)
    socket.on('typing', async (data: TypingData) => {
      try {
        // Store typing status in Redis
        await setTypingStatus(userId, data.recipientId, data.isTyping);

        const roomId = getConversationRoomId(userId, data.recipientId);
        
        // Emit minimal payload (just user ID and status)
        if (data.isTyping) {
          io.to(roomId).except(socket.id).emit('typing:start', { userId });
        } else {
          io.to(roomId).except(socket.id).emit('typing:stop', { userId });
        }
      } catch (error) {
        console.error('Error handling typing:', error);
      }
    });

    // Handle message status updates (delivered/read)
    socket.on('message:status', async (data: { messageId: string; status: 'delivered' | 'read' }) => {
      try {
        // Update message status in database
        await pool.query(
          `UPDATE messages SET status = $1 WHERE id = $2 AND recipient_id = $3`,
          [data.status, data.messageId, userId]
        );

        // Get message sender
        const { rows } = await pool.query(
          `SELECT sender_id FROM messages WHERE id = $1`,
          [data.messageId]
        );

        if (rows.length > 0) {
          const senderId = rows[0].sender_id;
          // Notify sender of status update
          io.to(`user:${senderId}`).emit('message:status', {
            messageId: data.messageId,
            status: data.status,
          });
        }
      } catch (error) {
        console.error('Error handling message:status:', error);
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
      userSockets.delete(userId);

      // Update presence in Redis (user went offline)
      setUserPresence(userId, false).catch((err) =>
        console.error('Failed to update presence:', err)
      );

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
 * Emit message to users (called from REST API routes)
 * Uses minimal payload (message ID only) - client fetches full message if needed
 */
export function emitMessageToUsers(
  senderId: string,
  recipientId: string,
  message: { id: string } | any // Accept minimal payload or full message
): void {
  if (!ioInstance) return;

  // Minimal payload: only message ID for initial notification
  // Client can fetch full message via reconciliation endpoint if needed
  const minimalPayload = typeof message === 'object' && 'id' in message
    ? { id: message.id }
    : { id: message.id || message };

  // Emit to sender (best effort)
  try {
    ioInstance.to(`user:${senderId}`).emit('message:new', minimalPayload);
  } catch (err) {
    console.error('Failed to emit to sender:', err);
  }

  // Emit to recipient if online (best effort)
  if (userSockets.has(recipientId)) {
    try {
      ioInstance.to(`user:${recipientId}`).emit('message:new', minimalPayload);
    } catch (err) {
      console.error('Failed to emit to recipient:', err);
    }
  }
}

/**
 * Emit message status update
 */
export function emitMessageStatus(
  messageId: string,
  status: 'delivered' | 'read',
  senderId: string
): void {
  if (!ioInstance) return;

  ioInstance.to(`user:${senderId}`).emit('message:status', {
    messageId,
    status,
  });
}

