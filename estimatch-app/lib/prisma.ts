import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/app/generated/prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function hasNotesDelegate(client: PrismaClient): boolean {
  return typeof (client as PrismaClient & { comparisonNote?: { findMany?: unknown } }).comparisonNote?.findMany === 'function';
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!;
  // Use an explicit Pool with SSL — Supabase's session-mode pooler requires
  // encrypted connections and will reject the pg default (no SSL) at the
  // protocol level, surfacing as ECONNREFUSED.
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

const cached = globalForPrisma.prisma;
const prismaClient = cached && hasNotesDelegate(cached) ? cached : createPrismaClient();

export const prisma = prismaClient;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
