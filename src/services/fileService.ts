/**
 * File service - handles file uploads and storage
 * Centralized file handling with size limits and validation
 */
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads');

// WhatsApp-standard file size limits (in bytes) - HARD GATES
export const FILE_SIZE_LIMITS = {
  image: {
    soft: 5 * 1024 * 1024, // 5MB - soft compress
    hard: 10 * 1024 * 1024, // 10MB - hard limit (reject if larger)
  },
  video: {
    hard: 2 * 1024 * 1024 * 1024, // 2GB - hard limit
  },
  audio: {
    hard: 100 * 1024 * 1024, // 100MB - hard limit
  },
  document: {
    hard: 2 * 1024 * 1024 * 1024, // 2GB - hard limit
  },
  thumbnail: {
    hard: 10 * 1024, // 10KB - mandatory max for thumbnails
  },
  default: {
    hard: 5 * 1024 * 1024, // 5MB default
  },
};

// Get hard limit for file type (for rejection before upload)
export function getHardLimit(fileType: string): number {
  const limits = FILE_SIZE_LIMITS[fileType as keyof typeof FILE_SIZE_LIMITS];
  if (!limits) return FILE_SIZE_LIMITS.default.hard;
  if ('hard' in limits) return limits.hard;
  return FILE_SIZE_LIMITS.default.hard;
}

// Get soft limit for file type (for compression threshold)
export function getSoftLimit(fileType: string): number | null {
  const limits = FILE_SIZE_LIMITS[fileType as keyof typeof FILE_SIZE_LIMITS];
  if (!limits || !('soft' in limits)) return null;
  return limits.soft;
}

// Allowed MIME types
export const ALLOWED_MIME_TYPES = {
  image: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

/**
 * Validate file before upload (HARD GATE - reject if invalid)
 * This must be called BEFORE any upload starts
 */
export function validateFileBeforeUpload(
  fileSize: number,
  mimeType?: string,
): { valid: boolean; error?: string } {
  const fileType = getFileType(mimeType);
  const hardLimit = getHardLimit(fileType);

  // HARD GATE: Reject oversized files immediately
  if (fileSize > hardLimit) {
    const limitMB = (hardLimit / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File size (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of ${limitMB}MB for ${fileType} files`,
    };
  }

  // Validate MIME type if provided
  if (mimeType && !isAllowedMimeType(mimeType, fileType)) {
    return {
      valid: false,
      error: `File type ${mimeType} is not allowed for ${fileType} files`,
    };
  }

  return { valid: true };
}

/**
 * Upload file to blob storage or local filesystem
 * NOTE: File should be validated with validateFileBeforeUpload() first
 */
export async function uploadFile(
  fileName: string,
  fileBuffer: Buffer,
  mimeType?: string,
): Promise<string> {
  // Double-check validation (safety net)
  const validation = validateFileBeforeUpload(fileBuffer.length, mimeType);
  if (!validation.valid) {
    throw new Error(validation.error || 'File validation failed');
  }

  const useBlobStorage = process.env.USE_BLOB_STORAGE === 'true';
  const blobReadWriteToken = process.env.BLOB_READ_WRITE_TOKEN;

  if (useBlobStorage && blobReadWriteToken) {
    // Upload to Vercel Blob Storage
    try {
      const { put } = await import('@vercel/blob');
      const blob = await put(fileName, fileBuffer, {
        access: 'public',
        contentType: mimeType || 'application/octet-stream',
        token: blobReadWriteToken,
      });
      return blob.url;
    } catch (error) {
      console.error('Vercel Blob storage upload failed, falling back to local:', error);
      // Fallback to local storage
      return uploadToLocal(fileName, fileBuffer);
    }
  } else {
    // Save to local filesystem
    return uploadToLocal(fileName, fileBuffer);
  }
}

/**
 * Upload file to local filesystem
 */
async function uploadToLocal(fileName: string, fileBuffer: Buffer): Promise<string> {
  // Ensure uploads directory exists
  if (!existsSync(UPLOADS_DIR)) {
    await mkdir(UPLOADS_DIR, { recursive: true });
  }

  const filePath = join(UPLOADS_DIR, fileName);
  await writeFile(filePath, fileBuffer);
  return `/uploads/${fileName}`;
}

/**
 * Get file type from MIME type
 */
function getFileType(mimeType?: string): 'image' | 'video' | 'audio' | 'document' | 'default' {
  if (!mimeType) return 'default';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word')) return 'document';
  return 'default';
}

/**
 * Check if MIME type is allowed for file type
 */
function isAllowedMimeType(mimeType: string, fileType: string): boolean {
  const allowed = ALLOWED_MIME_TYPES[fileType as keyof typeof ALLOWED_MIME_TYPES];
  if (!allowed) return true; // Allow unknown types for default
  return allowed.includes(mimeType);
}

/**
 * Generate unique filename
 */
export function generateUniqueFileName(originalFileName: string, prefix?: string): string {
  const fileExt = originalFileName.split('.').pop() || '';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const prefixStr = prefix ? `${prefix}-` : '';
  return `${prefixStr}${timestamp}-${random}.${fileExt}`;
}

/**
 * Convert base64 to buffer
 */
export function base64ToBuffer(fileData: string): Buffer {
  if (fileData.startsWith('data:')) {
    // Base64 with data URI prefix
    const base64Data = fileData.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  } else {
    // Plain base64
    return Buffer.from(fileData, 'base64');
  }
}

