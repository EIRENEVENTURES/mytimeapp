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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = require("path");
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const auth_1 = __importDefault(require("./auth"));
const user_1 = __importDefault(require("./routes/user"));
const messages_1 = __importDefault(require("./routes/messages"));
const socket_1 = require("./socket");
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: '*',
        credentials: true,
    },
    transports: ['websocket', 'polling'],
});
const port = process.env.PORT || 4000;
app.use((0, cors_1.default)({ origin: '*', credentials: true }));
app.use(express_1.default.json({ limit: '50mb' })); // Increase limit for file uploads
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve uploaded files (only if not using blob storage)
// Use the same path resolution as in messages.ts to ensure consistency
// __dirname in compiled code will be dist/src, so we go up two levels to get to backend root
// In source code, __dirname is src, so we also go up two levels
if (process.env.USE_BLOB_STORAGE !== 'true') {
    const uploadsDir = (0, path_1.join)(__dirname, '..', '..', 'uploads');
    const { existsSync } = require('fs');
    if (existsSync(uploadsDir)) {
        app.use('/uploads', express_1.default.static(uploadsDir));
        console.log('Serving local uploads from:', uploadsDir);
    }
    else {
        console.warn('WARNING: Uploads directory does not exist:', uploadsDir);
        console.warn('Files will be saved but not served. Consider using blob storage in production.');
    }
}
else {
    console.log('Blob storage enabled - not serving local uploads');
}
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// Public routes
app.use('/auth', auth_1.default);
// Protected routes (require authentication)
app.use('/user', user_1.default);
app.use('/messages', messages_1.default);
// Setup Socket.IO
(0, socket_1.setupSocketIO)(io);
// Initialize Redis connection
const redis_1 = require("./redis");
(0, redis_1.getRedisClient)();
httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://localhost:${port}`);
    console.log(`WebSocket server ready`);
});
// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    const { closeRedis } = await Promise.resolve().then(() => __importStar(require('./redis')));
    await closeRedis();
    httpServer.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});
