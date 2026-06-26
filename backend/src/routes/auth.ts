import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { z } from 'zod';

const router = Router();

const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env variable is not set');
  return secret;
};

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// Separate schema for login (less prescriptive on password format)
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = signupSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    const password_hash = await bcrypt.hash(password, 12); // 12 rounds for better security
    const user = await prisma.user.create({
      data: { email, password_hash },
    });

    const token = jwt.sign({ id: user.id, email: user.email }, getSecret(), { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues[0]?.message || 'Validation failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    // Constant-time: always compare even if user not found (prevents timing attacks)
    const dummyHash = '$2b$12$invaliddummyhashfortimingprotect';
    const valid = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!user || !valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign({ id: user.id, email: user.email }, getSecret(), { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues[0]?.message || 'Validation failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
