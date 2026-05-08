import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type StartPhoneVerificationBody = {
  countryCode?: string;
  phoneNumber?: string;
  channel?: 'sms' | 'call';
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

function getTwilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !verifyServiceSid) {
    throw new Error('Twilio Verify is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.');
  }

  return { accountSid, authToken, verifyServiceSid };
}

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: StartPhoneVerificationBody;

  try {
    body = (await request.json()) as StartPhoneVerificationBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const countryCode = normalizeCountryCode(body.countryCode);
  const localPhone = normalizePhoneNumber(body.phoneNumber);
  const channel = body.channel === 'call' ? 'call' : 'sms';

  if (!countryCode || !localPhone) {
    return NextResponse.json({ error: 'Enter a valid country code and phone number.' }, { status: 400 });
  }

  const e164 = `${countryCode}${localPhone}`;

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

  try {
    const { accountSid, authToken, verifyServiceSid } = getTwilioConfig();
    const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const response = await fetch(`https://verify.twilio.com/v2/Services/${verifyServiceSid}/Verifications`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: e164,
        Channel: channel,
      }).toString(),
    });

    const payload = (await response.json()) as { message?: string };

    if (!response.ok) {
      return NextResponse.json(
        { error: payload.message ?? 'Failed to send verification code. Please try again.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      destination: e164,
      channel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start phone verification.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
