import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type EmailOptInPostBody = {
  enrolled?: boolean;
  neverShowAgain?: boolean;
};

const ENROLLED_VALUE = 'ENROLLED';

export async function GET() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const rows = await prisma.$queryRaw<
    Array<{
      emailOptIn: string | null;
      emailOptInPromptDismissedAt: string | null;
    }>
  >`
    SELECT
      email_opt_in AS "emailOptIn",
      email_opt_in_prompt_dismissed_at::text AS "emailOptInPromptDismissedAt"
    FROM users
    WHERE clerk_id = ${clerkId}
    LIMIT 1
  `;

  const appUser = rows[0] ?? null;

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  return NextResponse.json(
    {
      emailOptIn: appUser.emailOptIn === ENROLLED_VALUE,
      neverShowAgain: appUser.emailOptInPromptDismissedAt !== null,
    },
    { status: 200 }
  );
}

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: EmailOptInPostBody;

  try {
    body = (await request.json()) as EmailOptInPostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const shouldUpdateEnrolled = typeof body.enrolled === 'boolean';
  const shouldUpdateNeverShowAgain = body.neverShowAgain === true;

  if (!shouldUpdateEnrolled && !shouldUpdateNeverShowAgain) {
    return NextResponse.json(
      { error: 'Provide at least one valid preference field to update.' },
      { status: 400 }
    );
  }

  const existingRows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM users
    WHERE clerk_id = ${clerkId}
    LIMIT 1
  `;

  const appUser = existingRows[0] ?? null;

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  const enrolledValue = body.enrolled === true;

  await prisma.$executeRaw`
    UPDATE users
    SET
      email_opt_in = CASE
        WHEN ${shouldUpdateEnrolled}::boolean THEN CASE WHEN ${enrolledValue}::boolean THEN ${ENROLLED_VALUE} ELSE NULL END
        ELSE email_opt_in
      END,
      email_opt_in_prompt_dismissed_at = CASE
        WHEN ${shouldUpdateNeverShowAgain}::boolean THEN NOW()
        WHEN ${shouldUpdateEnrolled}::boolean AND ${enrolledValue}::boolean THEN NULL
        ELSE email_opt_in_prompt_dismissed_at
      END,
      updated_at = NOW()
    WHERE id = ${appUser.id}
  `;

  const updatedRows = await prisma.$queryRaw<
    Array<{
      emailOptIn: string | null;
      emailOptInPromptDismissedAt: string | null;
    }>
  >`
    SELECT
      email_opt_in AS "emailOptIn",
      email_opt_in_prompt_dismissed_at::text AS "emailOptInPromptDismissedAt"
    FROM users
    WHERE id = ${appUser.id}
    LIMIT 1
  `;

  const updatedUser = updatedRows[0];

  return NextResponse.json(
    {
      emailOptIn: updatedUser.emailOptIn === ENROLLED_VALUE,
      neverShowAgain: updatedUser.emailOptInPromptDismissedAt !== null,
    },
    { status: 200 }
  );
}
