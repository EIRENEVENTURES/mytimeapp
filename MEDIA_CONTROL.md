# WhatsApp-Standard File Size & Quality Control

This document describes the implementation of WhatsApp-standard file size limits and quality control.

## 1️⃣ File Size Limits (Hard Gates)

### Limits by Type

| Type | Soft Limit | Hard Limit | Behavior |
|------|------------|------------|----------|
| **Images** | 5MB | 10MB | Auto-resize if > 5MB, reject if > 10MB |
| **Videos** | N/A | 2GB | Re-encode on client/edge |
| **Audio** | N/A | 100MB | Compress to Opus/AAC |
| **Documents** | N/A | 2GB | No preview, direct upload |
| **Thumbnails** | N/A | 10KB | Mandatory max size |

### Implementation

```typescript
// HARD GATE: Validate BEFORE upload starts
const validation = validateFileBeforeUpload(fileSize, mimeType);
if (!validation.valid) {
  return res.status(400).json({ message: validation.error });
}

// Message created immediately (FAST PATH)
// Media upload queued async (SLOW PATH)
```

**Rules**:
- ✅ Reject oversized files before upload starts
- ✅ Never allow raw uploads without validation
- ✅ Never rely on user judgment

## 2️⃣ Quality Control Rules

### Images

**Processing**:
- Resize to max dimension (2048px default)
- Convert to WebP/JPEG
- Strip metadata (EXIF)
- Generate thumbnail (<10KB, mandatory)

**Formats Generated**:
- `original`: Original file (if within limits)
- `full`: Processed full-size image
- `medium`: Medium quality (if needed)
- `thumbnail`: <10KB thumbnail (mandatory)

### Videos

**Processing**:
- Transcode on client or edge (not blocking)
- Reduce bitrate, resolution, frame rate
- Generate preview frame
- Generate thumbnail from preview

**Formats**:
- Streamable format only (MP4/H.264)
- Preview frame as thumbnail

### Audio

**Processing**:
- Normalize audio levels
- Compress to Opus (preferred) or AAC
- Cap duration if needed

**Formats**:
- Opus (preferred)
- AAC (fallback)

## 3️⃣ Upload Behavior (Non-Negotiable)

### Chunked Uploads

**Characteristics**:
- Max 2-3 parallel chunks
- Pause/resume supported
- Temp files cleaned aggressively
- Uploads MUST be cancellable

**Implementation**:
```typescript
// Chunked upload endpoint
POST /messages/upload
{
  chunkIndex: 0,
  totalChunks: 10,
  uploadId: "unique-upload-id",
  fileData: "base64-chunk-data",
  ...
}

// Cancel upload
POST /messages/upload/cancel
{
  uploadId: "unique-upload-id"
}

// Get progress
GET /messages/upload/progress/:uploadId
```

**Features**:
- ✅ Chunks stored in memory (Redis in production)
- ✅ Progress tracking
- ✅ Cancellable at any time
- ✅ Resume from last chunk

## 4️⃣ Delivery Rules

### Message Send ≠ Media Upload Completion

**Pattern**:
1. **FAST PATH**: Create message immediately
2. **SLOW PATH**: Upload media asynchronously
3. **State**: Message can exist with "media pending"

**Database Schema**:
```sql
ALTER TABLE messages ADD COLUMN media_status VARCHAR(20);
-- Values: 'pending', 'completed', 'failed'
```

**Message States**:
- `pending`: Media is being uploaded
- `completed`: Media upload finished successfully
- `failed`: Media upload failed (message still exists)

**Client Behavior**:
- Show message immediately with "media pending" indicator
- Update UI when media completes
- Handle failures gracefully (retry or show error)

### Media Failures Must Not Break Chat Flow

**Implementation**:
```typescript
// Media upload failure doesn't break chat
try {
  await uploadMediaAsync(job);
} catch (error) {
  // Mark as failed, but message exists
  await pool.query(
    `UPDATE messages SET media_status = 'failed' WHERE id = $1`,
    [messageId]
  );
  // Chat continues normally
}
```

## 5️⃣ Enhancement Rule (Critical)

> **If media handling can break chat speed, it is implemented incorrectly.**
> **WhatsApp protects chat speed at all costs.**

### Fast Path Guarantees

✅ Message creation: < 50ms
✅ Chat open: < 100ms
✅ WebSocket delivery: < 10ms
✅ Media validation: < 5ms (before upload)

### Slow Path Characteristics

✅ Media upload: Can take seconds (async)
✅ Media processing: Can take minutes (edge/worker)
✅ Chunked uploads: Can pause/resume
✅ Failures: Don't block chat

## Implementation Files

1. **`backend/src/services/fileService.ts`**
   - File size limits (WhatsApp standards)
   - Pre-upload validation
   - Hard gates

2. **`backend/src/services/mediaProcessingService.ts`**
   - Quality control (resize, compress, convert)
   - Thumbnail generation
   - Format conversion

3. **`backend/src/services/mediaService.ts`**
   - Async media uploads
   - Chunked upload support
   - Cancellable uploads
   - Media pending state

4. **`backend/src/routes/messages.ts`**
   - Upload endpoints
   - Chunked upload handling
   - Cancel/progress endpoints

5. **`backend/sql/015_add_media_status.sql`**
   - Database migration for media_status

## Future Enhancements

1. **Edge Processing**: Move video/audio processing to edge functions
2. **Job Queue**: Use Bull/BullMQ for better retry handling
3. **CDN**: Serve processed media from CDN
4. **Progressive Upload**: Stream large files progressively
5. **Client-Side Processing**: Compress images on client before upload

