import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

// Vercel serverless runtime cap. This cron paginates through Clerk users and
// deletes stale records, which can take longer than the default 10s on Hobby.
// 60s is the Hobby-plan maximum; raise if migrated to Pro and needed.
export const maxDuration = 60;

type ClerkUserMetadataLike = {
  id: string;
  createdAt: number;
  privateMetadata?: {
    trialPhoneNumber?: string;
  };
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function hasVerifiedTrialPhone(user: ClerkUserMetadataLike): boolean {
  const phone = user.privateMetadata?.trialPhoneNumber;
  return typeof phone === 'string' && phone.trim().length > 0;
}

function isAuthorizedRequest(request: Request): boolean {
  const configuredSecret = process.env.UNVERIFIED_ACCOUNT_CLEANUP_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = request.headers.get('x-cleanup-secret');
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;

  if (!configuredSecret && !cronSecret) {
    return false;
  }

  const matchesCleanupSecret = Boolean(configuredSecret) && (providedSecret === configuredSecret || bearerToken === configuredSecret);
  const matchesCronSecret = Boolean(cronSecret) && bearerToken === cronSecret;

  return matchesCleanupSecret || matchesCronSecret;
}

async function runCleanup() {
  if (!process.env.UNVERIFIED_ACCOUNT_CLEANUP_SECRET && !process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Missing UNVERIFIED_ACCOUNT_CLEANUP_SECRET or CRON_SECRET.' }, { status: 500 });
  }

  if (process.env.UNVERIFIED_ACCOUNT_CLEANUP_ENABLED !== 'true') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'cleanup_disabled' }, { status: 200 });
  }

  const maxAgeHours = parsePositiveInt(process.env.UNVERIFIED_ACCOUNT_MAX_AGE_HOURS, 24);
  const batchSize = Math.min(parsePositiveInt(process.env.UNVERIFIED_ACCOUNT_CLEANUP_BATCH_SIZE, 100), 500);
  const cutoffTimestamp = Date.now() - maxAgeHours * 60 * 60 * 1000;

  const client = await clerkClient();
  let offset = 0;
  let scanned = 0;
  const staleUserIds: string[] = [];

  while (true) {
    const page = await client.users.getUserList({
      limit: batchSize,
      offset,
      orderBy: '+created_at',
    });

    const users = page.data as unknown as ClerkUserMetadataLike[];

    if (users.length === 0) {
      break;
    }

    scanned += users.length;

    for (const user of users) {
      if (user.createdAt > cutoffTimestamp) {
        continue;
      }

      if (hasVerifiedTrialPhone(user)) {
        continue;
      }

      staleUserIds.push(user.id);
    }

    offset += users.length;

    if (users.length < batchSize) {
      break;
    }
  }

  for (const clerkId of staleUserIds) {
    await client.users.deleteUser(clerkId);
    await prisma.user.deleteMany({ where: { clerkId } });
  }

  return NextResponse.json(
    {
      ok: true,
      cutoffHours: maxAgeHours,
      scanned,
      deleted: staleUserIds.length,
      deletedUserIds: staleUserIds,
    },
    { status: 200 }
  );
}

export async function POST(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  return runCleanup();
}

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  return runCleanup();
}
