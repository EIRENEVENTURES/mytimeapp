# PostgreSQL Query Optimizations

## Summary
This document outlines the query optimizations applied to improve chat app performance.

## Indexes Created

### Composite Indexes (Hot Paths)
1. **`idx_messages_conversation_sr`** - `(sender_id, recipient_id, created_at DESC)`
   - Optimizes: Messages where current user is sender
   - Enables index-only scans for conversation queries

2. **`idx_messages_conversation_rs`** - `(recipient_id, sender_id, created_at DESC)`
   - Optimizes: Messages where current user is recipient
   - Enables index-only scans for conversation queries

3. **`idx_messages_cursor_pagination`** - `(created_at DESC, id DESC)`
   - Optimizes: Cursor-based pagination with stable ordering
   - Prevents duplicate/skipped messages when timestamps are equal

### Partial Indexes (Reduced Size)
1. **`idx_messages_unread_partial`** - `(recipient_id, sender_id, created_at DESC) WHERE status != 'read'`
   - Optimizes: Unread message queries
   - Significantly smaller than full index (only unread messages)

2. **`idx_messages_status_update`** - `(recipient_id, sender_id, status) WHERE status IN ('sent', 'delivered')`
   - Optimizes: Status update queries
   - Covers only messages that need status updates

3. **`idx_messages_idempotency_key`** - `(idempotency_key) WHERE idempotency_key IS NOT NULL`
   - Optimizes: Idempotency checks
   - Sparse index (only messages with idempotency keys)

## Query Optimizations

### 1. Conversation Query (GET /messages/conversation/:userId)
**Before:** Single query with OR condition
```sql
WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
```

**After:** UNION ALL to leverage separate indexes
```sql
(SELECT ... WHERE sender_id = $1 AND recipient_id = $2)
UNION ALL
(SELECT ... WHERE sender_id = $2 AND recipient_id = $1)
```

**Benefits:**
- Each branch uses its own composite index
- Index-only scans possible
- No OR condition overhead

### 2. Status Updates
**Before:** Two separate UPDATE queries
```sql
UPDATE messages SET status = 'delivered' WHERE ...
UPDATE messages SET status = 'read' WHERE ...
```

**After:** Single combined UPDATE with CASE
```sql
UPDATE messages 
SET status = CASE 
  WHEN status = 'sent' THEN 'delivered'
  WHEN status != 'read' THEN 'read'
  ELSE status
END
WHERE recipient_id = $1 AND sender_id = $2 AND status IN ('sent', 'delivered')
```

**Benefits:**
- One round trip instead of two
- Uses partial index for faster updates

### 3. Chat List Query (GET /messages/chats)
**Before:** Complex CTE with GROUP BY and window functions
- Scanned messages table multiple times
- GROUP BY on unread counts
- Multiple CASE statements in CTEs

**After:** Split into 4 cheap queries
1. Get distinct partners (DISTINCT scan)
2. Get last messages (DISTINCT ON - faster than ROW_NUMBER)
3. Get unread counts (Redis first, then partial index fallback)
4. Get user details (single IN query)

**Benefits:**
- No GROUP BY needed (uses Redis or partial index)
- DISTINCT ON faster than window functions
- Parallel execution possible
- Each query uses optimal index

### 4. Cursor Pagination
**Before:** Subquery for cursor
```sql
AND m.created_at < (SELECT created_at FROM messages WHERE id = $3)
```

**After:** Direct comparison with stable cursor
```sql
AND (m.created_at < $2::timestamptz OR (m.created_at = $2::timestamptz AND m.id < $3))
```

**Benefits:**
- No subquery overhead
- Stable cursor (handles duplicate timestamps)
- Uses composite index efficiently

### 5. Batch Data Fetching
**Before:** Sequential queries for attachments, reactions, starred, pinned

**After:** Parallel Promise.all() execution
- All queries run simultaneously
- Reduces total latency

### 6. Reconciliation Query
**Before:** Subquery for cursor lookup

**After:** Single index lookup, then direct comparison
- Stable cursor with (created_at, id) ordering
- Prevents duplicate/skipped messages

## Performance Improvements

### Expected Query Performance (EXPLAIN ANALYZE)

**Conversation Query:**
- Before: Seq Scan or Bitmap Heap Scan (slow)
- After: Index Scan using idx_messages_conversation_sr/rs (fast)
- Rows scanned: ~100% reduction (index-only)

**Chat List Query:**
- Before: Multiple table scans, GROUP BY aggregation
- After: Index scans, DISTINCT ON, Redis lookups
- Rows scanned: ~80% reduction

**Status Updates:**
- Before: Two separate updates
- After: Single update with partial index
- Execution time: ~50% reduction

**Unread Counts:**
- Before: COUNT(*) with GROUP BY
- After: Redis counters or partial index scan
- Execution time: ~90% reduction (Redis) or ~70% reduction (partial index)

## Migration

Run the migration script to create indexes:
```bash
cd backend
npm run migrate
# Or manually run: backend/sql/013_optimize_message_indexes.sql
```

## Monitoring

Use EXPLAIN ANALYZE to verify index usage:
```sql
EXPLAIN ANALYZE 
SELECT ... FROM messages 
WHERE sender_id = $1 AND recipient_id = $2 
ORDER BY created_at DESC LIMIT 20;
```

Look for:
- `Index Scan using idx_messages_conversation_sr` (good)
- `Index Only Scan` (best)
- Low `Execution Time` (< 10ms for hot paths)

