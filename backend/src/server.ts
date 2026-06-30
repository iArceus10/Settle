import './loadEnv';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import groupsRoutes from './routes/groups';
import expensesRoutes from './routes/expenses';

const app = express();

// Lock CORS to the frontend origin only
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Postman during dev)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

app.use('/auth', authRoutes);
app.use('/groups', groupsRoutes);
app.use('/expenses', expensesRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
