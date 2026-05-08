import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

const BUG_REPORT_TO = 'raganharrison97@gmail.com';
const MAX_IMAGES = 3;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function mimeToExt(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('RESEND_API_KEY is not configured.');
    return NextResponse.json({ error: 'Email service is not configured.' }, { status: 500 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Request must be multipart form data.' }, { status: 400 });
  }

  const name = (formData.get('name') as string | null)?.trim();
  const email = (formData.get('email') as string | null)?.trim();
  const message = (formData.get('message') as string | null)?.trim();

  if (!name || !email || !message) {
    return NextResponse.json({ error: 'Name, email, and message are required.' }, { status: 400 });
  }

  // Collect image attachments
  const imageFiles = formData.getAll('images').filter(
    (entry): entry is File => entry instanceof File
  );

  if (imageFiles.length > MAX_IMAGES) {
    return NextResponse.json({ error: `Maximum ${MAX_IMAGES} images allowed.` }, { status: 400 });
  }

  const attachments: { filename: string; content: string }[] = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];

    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Invalid image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP.` },
        { status: 400 }
      );
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return NextResponse.json(
        { error: `Image "${file.name}" exceeds 5MB limit.` },
        { status: 400 }
      );
    }

    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    attachments.push({
      filename: `screenshot-${i + 1}.${mimeToExt(file.type)}`,
      content: base64,
    });
  }

  // Build email HTML
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px;">
      <h2 style="color: #1a1a1a; margin-bottom: 4px;">Bug Report from ScopeSplit</h2>
      <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" />
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <p><strong>Clerk ID:</strong> ${escapeHtml(userId)}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" />
      <p><strong>Description:</strong></p>
      <p style="white-space: pre-wrap; color: #333;">${escapeHtml(message)}</p>
      ${attachments.length > 0 ? `<hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" /><p style="color: #888; font-size: 13px;">${attachments.length} screenshot(s) attached.</p>` : ''}
    </div>
  `;

  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ScopeSplit Bug Reports <bugs@scopesplit.com>',
        to: [BUG_REPORT_TO],
        reply_to: email,
        subject: `[Bug Report] from ${name}`,
        html: htmlBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    });

    if (!resendResponse.ok) {
      const resendError = await resendResponse.text();
      console.error('Resend API error:', resendResponse.status, resendError);
      return NextResponse.json({ error: 'Failed to send bug report email.' }, { status: 502 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Bug report email failed:', error);
    return NextResponse.json({ error: 'Failed to send bug report.' }, { status: 500 });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
