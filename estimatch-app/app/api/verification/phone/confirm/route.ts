import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';

type ConfirmPhoneVerificationBody = {
  countryCode?: string;
  phoneNumber?: string;
  code?: string;
};

type ClerkEmailAddress = {
  id: string;
  emailAddress: string;
};

type ClerkUserLike = {
  firstName?: string | null;
  lastName?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: ClerkEmailAddress[];
};

function normalizeCountryCode(value: string | undefined): string | null {
  if (!value) return '+1';

  const trimmed = value.trim();
  const normalized = trimmed.startsWith('+') ? `+${trimmed.slice(1).replace(/\D/g, '')}` : `+${trimmed.replace(/\D/g, '')}`;

  if (!/^\+[1-9]\d{0,3}$/.test(normalized)) return null;
  return normalized;
}

function normalizePhoneNumber(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return null;
  return digits;
}

function normalizeCode(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 10) return null;
  return digits;
}

function getTwilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !verifyServiceSid) {
    throw new Error('Twilio Verify is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.');
  }

  return { accountSid, authToken, verifyServiceSid };
}

function getPrimaryEmail(user: ClerkUserLike): string | null {
  const addresses = user.emailAddresses ?? [];
  if (!addresses.length) return null;

  if (user.primaryEmailAddressId) {
    const primary = addresses.find((email) => email.id === user.primaryEmailAddressId);
    if (primary?.emailAddress) return primary.emailAddress;
  }

  return addresses[0]?.emailAddress ?? null;
}

function getFullName(user: ClerkUserLike): string | null {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return fullName.length ? fullName : null;
}

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: ConfirmPhoneVerificationBody;

  try {
    body = (await request.json()) as ConfirmPhoneVerificationBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const countryCode = normalizeCountryCode(body.countryCode);
  const localPhone = normalizePhoneNumber(body.phoneNumber);
  const code = normalizeCode(body.code);

  if (!countryCode || !localPhone || !code) {
    return NextResponse.json({ error: 'Enter a valid phone number and verification code.' }, { status: 400 });
  }

  const e164 = `${countryCode}${localPhone}`;

  try {
    const { accountSid, authToken, verifyServiceSid } = getTwilioConfig();
    const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const response = await fetch(`https://verify.twilio.com/v2/Services/${verifyServiceSid}/VerificationCheck`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: e164,
        Code: code,
      }).toString(),
    });

    const payload = (await response.json()) as { message?: string; status?: string };

    if (!response.ok) {
      return NextResponse.json(
        { error: payload.message ?? 'Failed to verify code. Please try again.' },
        { status: 400 }
      );
    }

    if (payload.status !== 'approved') {
      return NextResponse.json({ error: 'Invalid or expired verification code.' }, { status: 400 });
    }

    const existingUserWithPhone = await prisma.$queryRaw<{ clerkId: string }[]>`
      SELECT clerk_id AS "clerkId"
      FROM users
      WHERE phone_number = ${e164}
        AND clerk_id <> ${clerkId}
      LIMIT 1
    `;

    if (existingUserWithPhone.length > 0) {
      return NextResponse.json(
        { error: 'This phone number is already associated with an account.' },
        { status: 409 }
      );
    }

    const client = await clerkClient();

    const clerkUser = (await client.users.getUser(clerkId)) as unknown as ClerkUserLike;
    const email = getPrimaryEmail(clerkUser);

    if (!email) {
      return NextResponse.json({ error: 'A primary email is required to verify this account.' }, { status: 409 });
    }

    await client.users.updateUserMetadata(clerkId, {
      publicMetadata: {
        phoneVerifiedForTrial: true,
      },
      privateMetadata: {
        trialPhoneNumber: e164,
        trialPhoneHash: null,
        phoneVerifiedAt: new Date().toISOString(),
      },
    });

    const fullName = getFullName(clerkUser);
    const newUserId = randomUUID();
    const nowIso = new Date().toISOString();

    await prisma.$executeRaw`
      INSERT INTO users (id, clerk_id, email, full_name, phone_number, created_at, updated_at)
      VALUES (${newUserId}, ${clerkId}, ${email}, ${fullName}, ${e164}, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (clerk_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        phone_number = EXCLUDED.phone_number,
        updated_at = NOW()
    `;

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to verify phone number.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
