/**
 * Media Processing Service - WhatsApp-standard quality control
 * Handles compression, resizing, format conversion, and thumbnail generation
 * 
 * CRITICAL: All processing is async and non-blocking
 * Media processing must NEVER break chat speed
 */
import { FILE_SIZE_LIMITS, getSoftLimit } from './fileService';

export interface ProcessedMedia {
  original?: Buffer;
  full?: Buffer;
  medium?: Buffer;
  thumbnail?: Buffer;
  format: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface MediaProcessingOptions {
  maxDimension?: number; // Max width/height for images (default 2048px)
  quality?: number; // Compression quality 0-100 (default 85)
  stripMetadata?: boolean; // Remove EXIF/metadata (default true)
  generateThumbnail?: boolean; // Generate thumbnail (default true)
}

const DEFAULT_OPTIONS: MediaProcessingOptions = {
  maxDimension: 2048,
  quality: 85,
  stripMetadata: true,
  generateThumbnail: true,
};

/**
 * Process image: resize, compress, convert format, strip metadata, generate thumbnails
 */
export async function processImage(
  imageBuffer: Buffer,
  mimeType: string,
  options: MediaProcessingOptions = {},
): Promise<ProcessedMedia> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // For now, return original with metadata about processing needed
  // In production, use sharp or similar library for actual processing
  // This is a placeholder that shows the structure
  
  const softLimit = getSoftLimit('image');
  const needsCompression = softLimit && imageBuffer.length > softLimit;

  return {
    original: imageBuffer,
    full: imageBuffer, // Will be processed in production
    thumbnail: needsCompression ? imageBuffer.slice(0, Math.min(10 * 1024, imageBuffer.length)) : undefined,
    format: mimeType.includes('webp') ? 'webp' : 'jpeg',
    // width/height would be extracted from image in production
  };
}

/**
 * Process video: transcode, reduce quality, generate preview frame
 * NOTE: Video processing is expensive and should run on edge/worker
 */
export async function processVideo(
  videoBuffer: Buffer,
  mimeType: string,
  options: MediaProcessingOptions = {},
): Promise<ProcessedMedia> {
  // Video processing is complex and should be done on edge/worker
  // For now, return metadata about processing needed
  
  return {
    original: videoBuffer,
    format: 'mp4', // Target format
    // Preview frame would be extracted in production
    // Thumbnail would be generated from preview frame
  };
}

/**
 * Process audio: normalize, compress to Opus/AAC, cap duration if needed
 */
export async function processAudio(
  audioBuffer: Buffer,
  mimeType: string,
  options: MediaProcessingOptions = {},
): Promise<ProcessedMedia> {
  // Audio processing should normalize and compress
  // Target formats: Opus (preferred) or AAC
  
  return {
    original: audioBuffer,
    format: mimeType.includes('opus') ? 'opus' : 'aac',
    // Duration would be extracted in production
  };
}

/**
 * Generate thumbnail from image (mandatory, <10KB)
 */
export async function generateThumbnail(
  imageBuffer: Buffer,
  maxSize: number = 10 * 1024, // 10KB max
): Promise<Buffer> {
  // In production, use sharp to:
  // 1. Resize to max 200x200px
  // 2. Compress to JPEG
  // 3. Ensure <10KB
  
  // For now, return a slice (placeholder)
  return imageBuffer.slice(0, Math.min(maxSize, imageBuffer.length));
}

/**
 * Strip metadata from image (EXIF, etc.)
 */
export async function stripImageMetadata(imageBuffer: Buffer): Promise<Buffer> {
  // In production, use sharp or similar to remove EXIF
  // For now, return original
  return imageBuffer;
}

/**
 * Check if file needs compression based on soft limit
 */
export function needsCompression(fileType: string, fileSize: number): boolean {
  const softLimit = getSoftLimit(fileType);
  if (!softLimit) return false;
  return fileSize > softLimit;
}

