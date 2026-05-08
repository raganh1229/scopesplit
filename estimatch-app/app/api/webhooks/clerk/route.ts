import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyWebhook, type WebhookEvent } from '@clerk/nextjs/webhooks';
import prisma from '@/lib/prisma';

type ClerkEmailAddress = {
  id: string;
  email_address: string;
};

type ClerkUserEventData = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  primary_email_address_id: string | null;
  email_addresses: ClerkEmailAddress[];
  public_metadata?: {
    phoneVerifiedForTrial?: boolean;
  };
};

function shouldDeferUserSyncUntilPhoneVerified(): boolean {
  return process.env.DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED !== 'false';
}

function isPhoneVerifiedForTrial(data: ClerkUserEventData): boolean {
  return data.public_metadata?.phoneVerifiedForTrial === true;
}

function getPrimaryEmail(data: ClerkUserEventData): string | null {
  if (!data.email_addresses.length) return null;

  if (data.primary_email_address_id) {
    const primary = data.email_addresses.find(
      (email) => email.id === data.primary_email_address_id
    );

    if (primary?.email_address) return primary.email_address;
  }

  return data.email_addresses[0]?.email_address ?? null;
}

function getFullName(data: ClerkUserEventData): string | null {
  const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  return fullName.length ? fullName : null;
}

async function syncUser(data: ClerkUserEventData) {
  if (shouldDeferUserSyncUntilPhoneVerified() && !isPhoneVerifiedForTrial(data)) {
    return;
  }

  const email = getPrimaryEmail(data);
  const fullName = getFullName(data);

  if (email) {
    await prisma.user.upsert({
      where: { clerkId: data.id },
      update: {
        email,
        fullName,
      },
      create: {
        clerkId: data.id,
        email,
        fullName,
      },
    });

    return;
  }

  const existingUser = await prisma.user.findUnique({
    where: { clerkId: data.id },
    select: { id: true },
  });

  if (!existingUser) {
    console.warn(`Clerk webhook skipped user sync for ${data.id}: no email in payload.`);
    return;
  }

  await prisma.user.update({
    where: { clerkId: data.id },
    data: { fullName },
  });
}

export async function POST(request: NextRequest) {
  let event: WebhookEvent;

  try {
    event = await verifyWebhook(request);
  } catch (error) {
    console.error('Clerk webhook verification failed:', error);
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await syncUser(event.data as ClerkUserEventData);
        break;

      case 'user.deleted': {
        const clerkId = (event.data as { id?: string | null })?.id;
        if (clerkId) {
          await prisma.user.deleteMany({ where: { clerkId } });
        }
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Clerk webhook handler failed:', error);
    return NextResponse.json({ error: 'Webhook handler failed.' }, { status: 500 });
  }
}
