/**
 * Media service - handles async media uploads (SLOW PATH)
 * Media uploads should NEVER block message sending
 * 
 * Supports:
 * - Chunked uploads (pause/resume)
 * - Quality control (compression, resizing)
 * - Media pending state
 * - Cancellable uploads
 */
import { pool } from '../db';
import { uploadFile, generateUniqueFileName, base64ToBuffer, validateFileBeforeUpload } from './fileService';
import { processImage, processVideo, processAudio, generateThumbnail } from './mediaProcessingService';

export interface MediaUploadJob {
  messageId: string;
  fileData: string;
  fileName: string;
  mimeType?: string;
  type: string;
  metadata?: any;
  thumbnailUrl?: string | null;
  chunkIndex?: number; // For chunked uploads
  totalChunks?: number; // For chunked uploads
  uploadId?: string; // For resumable uploads
}

// Track upload progress (in-memory, could be Redis in production)
const uploadProgress = new Map<string, {
  messageId: string;
  chunks: Map<number, Buffer>;
  totalChunks: number;
  uploadedChunks: Set<number>;
}>();

// Track cancellable uploads
const cancellableUploads = new Map<string, { cancelled: boolean }>();

/**
 * Upload media asynchronously (SLOW PATH)
 * This runs off the fast path and can retry on failure
 * Supports quality control, chunked uploads, and media pending state
 */
export async function uploadMediaAsync(job: MediaUploadJob): Promise<void> {
  const { messageId, fileData, fileName, mimeType, type, metadata, thumbnailUrl, uploadId } = job;

  // Check if upload was cancelled
  if (uploadId && cancellableUploads.get(uploadId)?.cancelled) {
    console.log('Upload cancelled for', uploadId);
    return;
  }

  try {
    // Mark media as pending in database
    await pool.query(
      `UPDATE messages SET media_status = 'pending' WHERE id = $1`,
      [messageId]
    );

    const fileBuffer = base64ToBuffer(fileData);
    const fileSize = fileBuffer.length;

    // Process media based on type (quality control)
    let processedBuffer = fileBuffer;
    let processedMimeType = mimeType;
    let thumbnailBuffer: Buffer | null = null;

    if (type === 'image') {
      const processed = await processImage(fileBuffer, mimeType || 'image/jpeg');
      processedBuffer = processed.full || fileBuffer;
      processedMimeType = `image/${processed.format}`;
      
      // Generate thumbnail (mandatory, <10KB)
      thumbnailBuffer = await generateThumbnail(processedBuffer);
    } else if (type === 'video') {
      // Video processing is expensive - for now use original
      // In production, this would transcode on edge/worker
      const processed = await processVideo(fileBuffer, mimeType || 'video/mp4');
      processedBuffer = processed.original || fileBuffer;
      
      // Use provided thumbnail or generate from video
      if (thumbnailUrl) {
        thumbnailBuffer = base64ToBuffer(thumbnailUrl);
      }
    } else if (type === 'audio') {
      const processed = await processAudio(fileBuffer, mimeType || 'audio/mpeg');
      processedBuffer = processed.original || fileBuffer;
      processedMimeType = `audio/${processed.format}`;
    }

    // Generate unique filename
    const uniqueFileName = generateUniqueFileName(fileName);
    
    // Upload processed file (can take time, can fail)
    const fileUrl = await uploadFile(uniqueFileName, processedBuffer, processedMimeType);

    // Upload thumbnail if generated
    let thumbnailFileUrl = null;
    if (thumbnailBuffer) {
      const thumbnailFileName = generateUniqueFileName('thumb.jpg', 'thumb');
      thumbnailFileUrl = await uploadFile(thumbnailFileName, thumbnailBuffer, 'image/jpeg');
    } else if (thumbnailUrl && type === 'video') {
      // Use provided thumbnail
      const thumbnailFileName = generateUniqueFileName('thumb.jpg', 'thumb');
      const providedThumbnailBuffer = base64ToBuffer(thumbnailUrl);
      thumbnailFileUrl = await uploadFile(thumbnailFileName, providedThumbnailBuffer, 'image/jpeg');
    }

    // Create attachment record
    await pool.query(
      `INSERT INTO message_attachments (
        message_id, type, file_name, file_url, file_size, mime_type, thumbnail_url, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        messageId,
        type,
        fileName,
        fileUrl,
        processedBuffer.length,
        processedMimeType || null,
        thumbnailFileUrl,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    // Mark message as having attachments and media completed
    await pool.query(
      `UPDATE messages SET has_attachments = TRUE, media_status = 'completed' WHERE id = $1`,
      [messageId]
    );

    // Clean up upload tracking
    if (uploadId) {
      uploadProgress.delete(uploadId);
      cancellableUploads.delete(uploadId);
    }
  } catch (error) {
    console.error('Media upload failed for message', messageId, error);
    
    // Mark media as failed (but don't break chat flow)
    await pool.query(
      `UPDATE messages SET media_status = 'failed' WHERE id = $1`,
      [messageId]
    ).catch(() => {}); // Don't fail if this fails

    // Clean up upload tracking
    if (uploadId) {
      uploadProgress.delete(uploadId);
      cancellableUploads.delete(uploadId);
    }

    // Don't throw - this is async, failures are acceptable
    // Could implement retry queue here in the future
  }
}

/**
 * Queue media upload job for async processing
 * Returns immediately without waiting for upload
 * NON-BLOCKING - never blocks chat flow
 */
export async function queueMediaUpload(job: MediaUploadJob): Promise<void> {
  // Process immediately but don't block caller (setImmediate = next tick)
  // In production, this would use a job queue (Bull, BullMQ, etc.)
  setImmediate(async () => {
    try {
      await uploadMediaAsync(job);
    } catch (error) {
      console.error('Queued media upload failed:', error);
      // Failures are acceptable - message already exists, media can retry
    }
  });
}

/**
 * Handle chunked upload (for large files)
 * Supports pause/resume
 */
export async function uploadChunk(job: MediaUploadJob): Promise<{ progress: number; complete: boolean; messageId?: string }> {
  const { uploadId, chunkIndex, totalChunks, fileData, messageId, fileName, mimeType, type, metadata, thumbnailUrl } = job;

  if (!uploadId || chunkIndex === undefined || totalChunks === undefined) {
    throw new Error('Chunked upload requires uploadId, chunkIndex, and totalChunks');
  }

  // Check if cancelled
  if (cancellableUploads.get(uploadId)?.cancelled) {
    throw new Error('Upload cancelled');
  }

  // Initialize or get upload progress
  if (!uploadProgress.has(uploadId)) {
    uploadProgress.set(uploadId, {
      messageId: messageId || '',
      chunks: new Map(),
      totalChunks,
      uploadedChunks: new Set(),
    });
  } else if (messageId && !uploadProgress.get(uploadId)!.messageId) {
    // Update messageId if provided and not set
    uploadProgress.get(uploadId)!.messageId = messageId;
  }

  const progress = uploadProgress.get(uploadId)!;
  const chunkBuffer = base64ToBuffer(fileData);

  // Store chunk
  progress.chunks.set(chunkIndex, chunkBuffer);
  progress.uploadedChunks.add(chunkIndex);

  // Check if all chunks received
  const complete = progress.uploadedChunks.size === totalChunks;

  if (complete) {
    // Reassemble file
    const chunks: Buffer[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = progress.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }
      chunks.push(chunk);
    }
    const fullBuffer = Buffer.concat(chunks);

    // Validate complete file size
    const { validateFileBeforeUpload } = await import('./fileService');
    const validation = validateFileBeforeUpload(fullBuffer.length, mimeType);
    if (!validation.valid) {
      throw new Error(validation.error || 'File validation failed');
    }

    // Process complete file (non-blocking)
    const fullJob: MediaUploadJob = {
      messageId: progress.messageId,
      fileData: fullBuffer.toString('base64'),
      fileName: fileName || 'upload',
      mimeType,
      type: type || 'document',
      metadata,
      thumbnailUrl,
      uploadId,
    };

    // Queue for processing (non-blocking)
    queueMediaUpload(fullJob);
  }

  return {
    progress: (progress.uploadedChunks.size / totalChunks) * 100,
    complete,
    messageId: progress.messageId || undefined,
  };
}

/**
 * Cancel an upload (non-blocking)
 */
export function cancelUpload(uploadId: string): void {
  const upload = cancellableUploads.get(uploadId);
  if (upload) {
    upload.cancelled = true;
  } else {
    cancellableUploads.set(uploadId, { cancelled: true });
  }
  
  // Clean up progress tracking
  uploadProgress.delete(uploadId);
}

/**
 * Get upload progress
 */
export function getUploadProgress(uploadId: string): number | null {
  const progress = uploadProgress.get(uploadId);
  if (!progress) return null;
  return (progress.uploadedChunks.size / progress.totalChunks) * 100;
}

