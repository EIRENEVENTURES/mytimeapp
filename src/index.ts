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
app.use('/uploads', express.static(join(__dirname, '..', 'uploads')));

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
