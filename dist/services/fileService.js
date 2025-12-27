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
exports.ALLOWED_MIME_TYPES = exports.FILE_SIZE_LIMITS = void 0;
exports.getHardLimit = getHardLimit;
exports.getSoftLimit = getSoftLimit;
exports.validateFileBeforeUpload = validateFileBeforeUpload;
exports.uploadFile = uploadFile;
exports.generateUniqueFileName = generateUniqueFileName;
exports.base64ToBuffer = base64ToBuffer;
/**
 * File service - handles file uploads and storage
 * Centralized file handling with size limits and validation
 */
const promises_1 = require("fs/promises");
const path_1 = require("path");
const fs_1 = require("fs");
const UPLOADS_DIR = (0, path_1.join)(__dirname, '..', '..', 'uploads');
// WhatsApp-standard file size limits (in bytes) - HARD GATES
exports.FILE_SIZE_LIMITS = {
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
function getHardLimit(fileType) {
    const limits = exports.FILE_SIZE_LIMITS[fileType];
    if (!limits)
        return exports.FILE_SIZE_LIMITS.default.hard;
    if ('hard' in limits)
        return limits.hard;
    return exports.FILE_SIZE_LIMITS.default.hard;
}
// Get soft limit for file type (for compression threshold)
function getSoftLimit(fileType) {
    const limits = exports.FILE_SIZE_LIMITS[fileType];
    if (!limits || !('soft' in limits))
        return null;
    return limits.soft;
}
// Allowed MIME types
exports.ALLOWED_MIME_TYPES = {
    image: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    video: ['video/mp4', 'video/webm', 'video/quicktime'],
    audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm'],
    document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};
/**
 * Validate file before upload (HARD GATE - reject if invalid)
 * This must be called BEFORE any upload starts
 */
function validateFileBeforeUpload(fileSize, mimeType) {
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
async function uploadFile(fileName, fileBuffer, mimeType) {
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
            const { put } = await Promise.resolve().then(() => __importStar(require('@vercel/blob')));
            const blob = await put(fileName, fileBuffer, {
                access: 'public',
                contentType: mimeType || 'application/octet-stream',
                token: blobReadWriteToken,
            });
            return blob.url;
        }
        catch (error) {
            console.error('Vercel Blob storage upload failed, falling back to local:', error);
            // Fallback to local storage
            return uploadToLocal(fileName, fileBuffer);
        }
    }
    else {
        // Save to local filesystem
        return uploadToLocal(fileName, fileBuffer);
    }
}
/**
 * Upload file to local filesystem
 */
async function uploadToLocal(fileName, fileBuffer) {
    // Ensure uploads directory exists
    if (!(0, fs_1.existsSync)(UPLOADS_DIR)) {
        await (0, promises_1.mkdir)(UPLOADS_DIR, { recursive: true });
    }
    const filePath = (0, path_1.join)(UPLOADS_DIR, fileName);
    await (0, promises_1.writeFile)(filePath, fileBuffer);
    return `/uploads/${fileName}`;
}
/**
 * Get file type from MIME type
 */
function getFileType(mimeType) {
    if (!mimeType)
        return 'default';
    if (mimeType.startsWith('image/'))
        return 'image';
    if (mimeType.startsWith('video/'))
        return 'video';
    if (mimeType.startsWith('audio/'))
        return 'audio';
    if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word'))
        return 'document';
    return 'default';
}
/**
 * Check if MIME type is allowed for file type
 */
function isAllowedMimeType(mimeType, fileType) {
    const allowed = exports.ALLOWED_MIME_TYPES[fileType];
    if (!allowed)
        return true; // Allow unknown types for default
    return allowed.includes(mimeType);
}
/**
 * Generate unique filename
 */
function generateUniqueFileName(originalFileName, prefix) {
    const fileExt = originalFileName.split('.').pop() || '';
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const prefixStr = prefix ? `${prefix}-` : '';
    return `${prefixStr}${timestamp}-${random}.${fileExt}`;
}
/**
 * Convert base64 to buffer
 */
function base64ToBuffer(fileData) {
    if (fileData.startsWith('data:')) {
        // Base64 with data URI prefix
        const base64Data = fileData.split(',')[1];
        return Buffer.from(base64Data, 'base64');
    }
    else {
        // Plain base64
        return Buffer.from(fileData, 'base64');
    }
}
