import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/db';

async function main() {
  const email = `test_${Date.now()}@example.com`;
  console.log('Testing signup flow for', email);

  const password_hash = await bcrypt.hash('secret12', 12);
  console.log('bcrypt ok');

  const user = await prisma.user.create({ data: { email, password_hash } });
  console.log('user created', user.id);

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing');
  const token = jwt.sign({ id: user.id, email: user.email }, secret, { expiresIn: '7d' });
  console.log('jwt ok, token length', token.length);

  await prisma.user.delete({ where: { id: user.id } });
  console.log('cleanup ok');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
