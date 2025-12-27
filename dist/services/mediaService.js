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
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadMediaAsync = uploadMediaAsync;
exports.queueMediaUpload = queueMediaUpload;
exports.uploadChunk = uploadChunk;
exports.cancelUpload = cancelUpload;
exports.getUploadProgress = getUploadProgress;
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
const db_1 = require("../db");
const fileService_1 = require("./fileService");
const mediaProcessingService_1 = require("./mediaProcessingService");
// Track upload progress (in-memory, could be Redis in production)
const uploadProgress = new Map();
// Track cancellable uploads
const cancellableUploads = new Map();
/**
 * Upload media asynchronously (SLOW PATH)
 * This runs off the fast path and can retry on failure
 * Supports quality control, chunked uploads, and media pending state
 */
async function uploadMediaAsync(job) {
    const { messageId, fileData, fileName, mimeType, type, metadata, thumbnailUrl, uploadId } = job;
    // Check if upload was cancelled
    if (uploadId && cancellableUploads.get(uploadId)?.cancelled) {
        console.log('Upload cancelled for', uploadId);
        return;
    }
    try {
        // Mark media as pending in database
        await db_1.pool.query(`UPDATE messages SET media_status = 'pending' WHERE id = $1`, [messageId]);
        const fileBuffer = (0, fileService_1.base64ToBuffer)(fileData);
        const fileSize = fileBuffer.length;
        // Process media based on type (quality control)
        let processedBuffer = fileBuffer;
        let processedMimeType = mimeType;
        let thumbnailBuffer = null;
        if (type === 'image') {
            const processed = await (0, mediaProcessingService_1.processImage)(fileBuffer, mimeType || 'image/jpeg');
            processedBuffer = processed.full || fileBuffer;
            processedMimeType = `image/${processed.format}`;
            // Generate thumbnail (mandatory, <10KB)
            thumbnailBuffer = await (0, mediaProcessingService_1.generateThumbnail)(processedBuffer);
        }
        else if (type === 'video') {
            // Video processing is expensive - for now use original
            // In production, this would transcode on edge/worker
            const processed = await (0, mediaProcessingService_1.processVideo)(fileBuffer, mimeType || 'video/mp4');
            processedBuffer = processed.original || fileBuffer;
            // Use provided thumbnail or generate from video
            if (thumbnailUrl) {
                thumbnailBuffer = (0, fileService_1.base64ToBuffer)(thumbnailUrl);
            }
        }
        else if (type === 'audio') {
            const processed = await (0, mediaProcessingService_1.processAudio)(fileBuffer, mimeType || 'audio/mpeg');
            processedBuffer = processed.original || fileBuffer;
            processedMimeType = `audio/${processed.format}`;
        }
        // Generate unique filename
        const uniqueFileName = (0, fileService_1.generateUniqueFileName)(fileName);
        // Upload processed file (can take time, can fail)
        const fileUrl = await (0, fileService_1.uploadFile)(uniqueFileName, processedBuffer, processedMimeType);
        // Upload thumbnail if generated
        let thumbnailFileUrl = null;
        if (thumbnailBuffer) {
            const thumbnailFileName = (0, fileService_1.generateUniqueFileName)('thumb.jpg', 'thumb');
            thumbnailFileUrl = await (0, fileService_1.uploadFile)(thumbnailFileName, thumbnailBuffer, 'image/jpeg');
        }
        else if (thumbnailUrl && type === 'video') {
            // Use provided thumbnail
            const thumbnailFileName = (0, fileService_1.generateUniqueFileName)('thumb.jpg', 'thumb');
            const providedThumbnailBuffer = (0, fileService_1.base64ToBuffer)(thumbnailUrl);
            thumbnailFileUrl = await (0, fileService_1.uploadFile)(thumbnailFileName, providedThumbnailBuffer, 'image/jpeg');
        }
        // Create attachment record
        await db_1.pool.query(`INSERT INTO message_attachments (
        message_id, type, file_name, file_url, file_size, mime_type, thumbnail_url, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
            messageId,
            type,
            fileName,
            fileUrl,
            processedBuffer.length,
            processedMimeType || null,
            thumbnailFileUrl,
            metadata ? JSON.stringify(metadata) : null,
        ]);
        // Mark message as having attachments and media completed
        await db_1.pool.query(`UPDATE messages SET has_attachments = TRUE, media_status = 'completed' WHERE id = $1`, [messageId]);
        // Clean up upload tracking
        if (uploadId) {
            uploadProgress.delete(uploadId);
            cancellableUploads.delete(uploadId);
        }
    }
    catch (error) {
        console.error('Media upload failed for message', messageId, error);
        // Mark media as failed (but don't break chat flow)
        await db_1.pool.query(`UPDATE messages SET media_status = 'failed' WHERE id = $1`, [messageId]).catch(() => { }); // Don't fail if this fails
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
async function queueMediaUpload(job) {
    // Process immediately but don't block caller (setImmediate = next tick)
    // In production, this would use a job queue (Bull, BullMQ, etc.)
    setImmediate(async () => {
        try {
            await uploadMediaAsync(job);
        }
        catch (error) {
            console.error('Queued media upload failed:', error);
            // Failures are acceptable - message already exists, media can retry
        }
    });
}
/**
 * Handle chunked upload (for large files)
 * Supports pause/resume
 */
async function uploadChunk(job) {
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
    }
    else if (messageId && !uploadProgress.get(uploadId).messageId) {
        // Update messageId if provided and not set
        uploadProgress.get(uploadId).messageId = messageId;
    }
    const progress = uploadProgress.get(uploadId);
    const chunkBuffer = (0, fileService_1.base64ToBuffer)(fileData);
    // Store chunk
    progress.chunks.set(chunkIndex, chunkBuffer);
    progress.uploadedChunks.add(chunkIndex);
    // Check if all chunks received
    const complete = progress.uploadedChunks.size === totalChunks;
    if (complete) {
        // Reassemble file
        const chunks = [];
        for (let i = 0; i < totalChunks; i++) {
            const chunk = progress.chunks.get(i);
            if (!chunk) {
                throw new Error(`Missing chunk ${i}`);
            }
            chunks.push(chunk);
        }
        const fullBuffer = Buffer.concat(chunks);
        // Validate complete file size
        const { validateFileBeforeUpload } = await Promise.resolve().then(() => __importStar(require('./fileService')));
        const validation = validateFileBeforeUpload(fullBuffer.length, mimeType);
        if (!validation.valid) {
            throw new Error(validation.error || 'File validation failed');
        }
        // Process complete file (non-blocking)
        const fullJob = {
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
function cancelUpload(uploadId) {
    const upload = cancellableUploads.get(uploadId);
    if (upload) {
        upload.cancelled = true;
    }
    else {
        cancellableUploads.set(uploadId, { cancelled: true });
    }
    // Clean up progress tracking
    uploadProgress.delete(uploadId);
}
/**
 * Get upload progress
 */
function getUploadProgress(uploadId) {
    const progress = uploadProgress.get(uploadId);
    if (!progress)
        return null;
    return (progress.uploadedChunks.size / progress.totalChunks) * 100;
}
