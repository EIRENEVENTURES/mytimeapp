import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter from './auth';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});


