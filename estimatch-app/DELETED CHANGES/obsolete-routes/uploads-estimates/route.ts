import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    {
      error: 'Deprecated endpoint. Use POST /api/comparisons to upload and create a comparison.',
    },
    { status: 410 }
  );
}
