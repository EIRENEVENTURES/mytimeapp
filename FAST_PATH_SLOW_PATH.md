# Fast Path vs Slow Path Implementation (WhatsApp Pattern)

This document describes how the chat system implements the Fast Path / Slow Path pattern for optimal performance and user trust.

## 🟢 FAST PATH Operations

**Principle**: Must be cheap, predictable, always safe. Must succeed even under peak load.

### 1. Message Sending

**Before**: Media upload blocked message creation
**After**: Message created immediately, media uploaded async

```typescript
// FAST PATH: Create message immediately
const message = await createMessage({...});

// ACK immediately
emitMessageToUsers(senderId, recipientId, { id: message.id });
return res.json({ message });

// SLOW PATH: Queue media upload (non-blocking)
queueMediaUpload({ messageId: message.id, ... });
```

**Benefits**:
- User sees message immediately
- Media upload failures don't block messaging
- Message appears in chat instantly

### 2. Chat Open

**Optimizations**:
- Load only last 20-30 messages initially
- Use index-only queries (no heavy joins)
- Only fetch attachments for messages with `has_attachments` flag
- Parallel batch queries for reactions/starred/pinned

```typescript
// FAST PATH: Index-only message query
SELECT id, sender_id, recipient_id, content, status, created_at, has_attachments
FROM messages
WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
ORDER BY created_at DESC
LIMIT 21; // Fetch one extra to check for more

// Only fetch attachments for messages that need them
const messagesWithAttachments = messages.filter(m => m.has_attachments);
if (messagesWithAttachments.length > 0) {
  // Batch fetch attachments
}
```

**Benefits**:
- Chat opens in < 100ms
- No blocking on media downloads
- Progressive loading of attachments

### 3. WebSocket Payloads

**Before**: Full message objects sent over WebSocket
**After**: Minimal payloads (IDs only)

```typescript
// FAST PATH: Emit only message ID
emitMessageToUsers(senderId, recipientId, { id: message.id });

// Client fetches full message if needed (reconciliation endpoint)
```

**Benefits**:
- Reduced network traffic
- Faster delivery
- Better scalability

### 4. Typing Status

**Implementation**: Redis-based, non-blocking

```typescript
// FAST PATH: Set typing status (non-blocking)
setTypingStatus(userId, recipientId, true).catch(err => 
  console.error('Failed:', err)
);

// FAST PATH: Get typing status (Redis lookup)
const isTyping = await getTypingStatus(userId, recipientId);
```

**Benefits**:
- No database queries
- Sub-millisecond response
- Automatic expiration (3 seconds)

## 🟡 SLOW PATH Operations

**Principle**: Allowed to be heavier, async, or eventual. Must NEVER block fast path.

### 1. Media Upload

**Implementation**: Async queue, retryable

```typescript
// SLOW PATH: Queue media upload (non-blocking)
queueMediaUpload({
  messageId: message.id,
  fileData,
  fileName,
  ...
});

// Processed asynchronously
async function uploadMediaAsync(job) {
  // Can take time, can fail, can retry
  const fileUrl = await uploadFile(...);
  await createAttachmentRecord(...);
}
```

**Benefits**:
- Doesn't block message sending
- Can retry on failure
- Can be moved to job queue in future

### 2. Media Download

**Implementation**: Progressive loading, placeholders first

- Show placeholder immediately
- Download full media in background
- Update UI when ready

### 3. Reconciliation

**Implementation**: Background sync endpoint

```typescript
// SLOW PATH: Reconciliation endpoint
GET /messages/reconcile?since=<messageId>

// Returns messages since cursor
// Can be called periodically or on reconnect
```

**Benefits**:
- Doesn't block UI
- Can run in background
- Handles offline scenarios

### 4. History Pagination

**Implementation**: Cursor-based, async loading

- Load older messages on scroll
- Non-blocking
- Can be cancelled if user scrolls away

## 🔴 Anti-Patterns Removed

### ❌ Media Upload on Message Send Path
**Fixed**: Message created first, media uploaded async

### ❌ Full Message Payload over WebSocket
**Fixed**: Only IDs sent, client fetches if needed

### ❌ Heavy SQL on Chat Open
**Fixed**: Index-only queries, batch fetching, selective attachment loading

### ❌ UI Waiting for Network
**Fixed**: Optimistic updates, placeholders, progressive loading

### ❌ Retry Storms on Reconnect
**Fixed**: Reconciliation endpoint, idempotent writes

## Performance Metrics

### Fast Path Targets
- Message send: < 50ms (including DB write)
- Chat open: < 100ms (first 20 messages)
- WebSocket delivery: < 10ms
- Typing status: < 5ms (Redis lookup)

### Slow Path Characteristics
- Media upload: Can take seconds, retryable
- Reconciliation: Background, doesn't block UI
- History pagination: On-demand, cancellable

## Mental Model

**Fast Path → User Trust**
- User sees message immediately
- Chat opens instantly
- Typing indicators are real-time
- System feels responsive

**Slow Path → Data Completeness**
- Media uploads complete eventually
- All messages sync eventually
- Full history available on demand
- System is eventually consistent

## Future Improvements

1. **Job Queue**: Move media uploads to Bull/BullMQ for better retry handling
2. **CDN**: Serve media from CDN for faster downloads
3. **Progressive Media**: Stream large videos progressively
4. **Background Sync**: Automatic reconciliation in background
5. **Offline Queue**: Queue messages when offline, sync on reconnect

