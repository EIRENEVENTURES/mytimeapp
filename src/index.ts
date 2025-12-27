import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { join } from 'path';
import authRouter from './auth';
import userRouter from './routes/user';
import messagesRouter from './routes/messages';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' })); // Increase limit for file uploads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files
// Use the same path resolution as in messages.ts to ensure consistency
// __dirname in compiled code will be dist/src, so we go up two levels to get to backend root
// In source code, __dirname is src, so we also go up two levels
const uploadsDir = join(__dirname, '..', '..', 'uploads');
app.use('/uploads', express.static(uploadsDir));
console.log('Serving uploads from:', uploadsDir);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Public routes
app.use('/auth', authRouter);

// Protected routes (require authentication)
app.use('/user', userRouter);
app.use('/messages', messagesRouter);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});
