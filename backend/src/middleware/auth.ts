import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// JWT_SECRET is read after dotenv.config() runs in server.ts
const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env variable is not set');
  return secret;
};

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(token, getSecret()) as { id: string; email: string };
    authReq.user = decoded;
    next();
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
