import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// DATABASE_URL is loaded from .env via dotenv.config() in server.ts before this module is evaluated.
// Prisma 7 requires a driver adapter — the url field in schema.prisma is removed.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
