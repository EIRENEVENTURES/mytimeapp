/**
 * Redis client for caching and real-time data
 * Used for: presence, typing status, unread counters, message fan-out
 */
import Redis from 'ioredis';

let redisClient: Redis | null = null;

/**
 * Get or create Redis client
 */
export function getRedisClient(): Redis | null {
  if (redisClient) {
    return redisClient;
  }

  // Only connect if REDIS_URL is provided (optional for development)
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('REDIS_URL not configured - Redis features disabled');
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err);
    });

    redisClient.on('connect', () => {
      console.log('Redis connected');
    });

    return redisClient;
  } catch (error) {
    console.error('Failed to create Redis client:', error);
    return null;
  }
}

/**
 * Presence management
 */
export async function setUserPresence(userId: string, isOnline: boolean): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = `presence:${userId}`;
  if (isOnline) {
    await client.setex(key, 120, '1'); // Expire after 2 minutes
  } else {
    await client.del(key);
  }
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const key = `presence:${userId}`;
    const result = await client.exists(key);
    return result === 1;
  } catch (err) {
    console.error('Redis error checking user online status:', err);
    return false; // Default to offline if Redis fails
  }
}

/**
 * Typing status management
 */
export async function setTypingStatus(
  userId: string,
  recipientId: string,
  isTyping: boolean
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = `typing:${recipientId}:${userId}`;
  if (isTyping) {
    await client.setex(key, 3, '1'); // Expire after 3 seconds
  } else {
    await client.del(key);
  }
}

export async function getTypingUsers(recipientId: string): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];

  const pattern = `typing:${recipientId}:*`;
  const keys = await client.keys(pattern);
  return keys.map((key) => key.split(':')[2]);
}

export async function getTypingStatus(userId: string, recipientId: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  const key = `typing:${recipientId}:${userId}`;
  const result = await client.get(key);
  return result === '1';
}

/**
 * Unread counter management
 */
export async function incrementUnreadCount(recipientId: string, senderId: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  // Key format: unread:RECIPIENT_ID:SENDER_ID
  // This means: "How many unread messages did SENDER_ID send to RECIPIENT_ID"
  // Only RECIPIENT_ID should see this count in their badge
  const key = `unread:${recipientId}:${senderId}`;
  console.log(`[Redis] Incrementing unread count: key=${key} (recipient=${recipientId}, sender=${senderId})`);
  await client.incr(key);
  await client.expire(key, 86400 * 7); // Expire after 7 days
}

export async function resetUnreadCount(recipientId: string, senderId: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = `unread:${recipientId}:${senderId}`;
  await client.del(key);
}

export async function getUnreadCount(recipientId: string, senderId: string): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  const key = `unread:${recipientId}:${senderId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

export async function getAllUnreadCounts(recipientId: string): Promise<Map<string, number>> {
  const client = getRedisClient();
  if (!client) return new Map();

  // Pattern: unread:RECIPIENT_ID:*
  // This finds all keys where recipientId is the recipient
  // Returns Map<senderId, count> - how many unread messages each sender sent to this recipient
  const pattern = `unread:${recipientId}:*`;
  const keys = await client.keys(pattern);
  const counts = new Map<string, number>();

  if (keys.length === 0) {
    console.log(`[Redis] No unread counts found for recipient ${recipientId}`);
    return counts;
  }

  const values = await client.mget(...keys);
  keys.forEach((key, index) => {
    // Key format: unread:RECIPIENT_ID:SENDER_ID
    // Extract senderId (the person who sent the messages)
    const senderId = key.split(':')[2];
    const count = values[index] ? parseInt(values[index]!, 10) : 0;
    if (count > 0) {
      counts.set(senderId, count);
      console.log(`[Redis] Found ${count} unread messages from ${senderId} to ${recipientId}`);
    }
  });

  console.log(`[Redis] Total unread counts for recipient ${recipientId}:`, Array.from(counts.entries()));
  return counts;
}

/**
 * Message fan-out queue (for async delivery)
 */
export async function queueMessageFanOut(
  messageId: string,
  senderId: string,
  recipientId: string
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = `fanout:${messageId}`;
  await client.setex(
    key,
    60,
    JSON.stringify({ senderId, recipientId }) // Expire after 60 seconds
  );
}

/**
 * Cleanup on shutdown
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

