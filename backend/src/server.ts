import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import groupsRoutes from './routes/groups';
import expensesRoutes from './routes/expenses';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/groups', groupsRoutes);
app.use('/expenses', expensesRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
