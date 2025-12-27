"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processImage = processImage;
exports.processVideo = processVideo;
exports.processAudio = processAudio;
exports.generateThumbnail = generateThumbnail;
exports.stripImageMetadata = stripImageMetadata;
exports.needsCompression = needsCompression;
/**
 * Media Processing Service - WhatsApp-standard quality control
 * Handles compression, resizing, format conversion, and thumbnail generation
 *
 * CRITICAL: All processing is async and non-blocking
 * Media processing must NEVER break chat speed
 */
const fileService_1 = require("./fileService");
const DEFAULT_OPTIONS = {
    maxDimension: 2048,
    quality: 85,
    stripMetadata: true,
    generateThumbnail: true,
};
/**
 * Process image: resize, compress, convert format, strip metadata, generate thumbnails
 */
async function processImage(imageBuffer, mimeType, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    // For now, return original with metadata about processing needed
    // In production, use sharp or similar library for actual processing
    // This is a placeholder that shows the structure
    const softLimit = (0, fileService_1.getSoftLimit)('image');
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
async function processVideo(videoBuffer, mimeType, options = {}) {
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
async function processAudio(audioBuffer, mimeType, options = {}) {
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
async function generateThumbnail(imageBuffer, maxSize = 10 * 1024) {
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
async function stripImageMetadata(imageBuffer) {
    // In production, use sharp or similar to remove EXIF
    // For now, return original
    return imageBuffer;
}
/**
 * Check if file needs compression based on soft limit
 */
function needsCompression(fileType, fileSize) {
    const softLimit = (0, fileService_1.getSoftLimit)(fileType);
    if (!softLimit)
        return false;
    return fileSize > softLimit;
}
