/**
 * File service - handles file uploads and storage
 * Centralized file handling with size limits and validation
 */
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads');

// File size limits (in bytes)
export const FILE_SIZE_LIMITS = {
  image: 5 * 1024 * 1024, // 5MB
  video: 50 * 1024 * 1024, // 50MB
  audio: 20 * 1024 * 1024, // 20MB
  document: 10 * 1024 * 1024, // 10MB
  default: 5 * 1024 * 1024, // 5MB default
};

// Allowed MIME types
export const ALLOWED_MIME_TYPES = {
  image: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

/**
 * Upload file to blob storage or local filesystem
 */
export async function uploadFile(
  fileName: string,
  fileBuffer: Buffer,
  mimeType?: string,
): Promise<string> {
  // Validate file size
  const fileType = getFileType(mimeType);
  const maxSize = FILE_SIZE_LIMITS[fileType] || FILE_SIZE_LIMITS.default;
  if (fileBuffer.length > maxSize) {
    throw new Error(`File size exceeds limit of ${maxSize / (1024 * 1024)}MB`);
  }

  // Validate MIME type if provided
  if (mimeType && !isAllowedMimeType(mimeType, fileType)) {
    throw new Error(`File type ${mimeType} is not allowed for ${fileType}`);
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

