import { writeFileSync, appendFileSync } from 'fs';

const TRACE_FILE = 'scripts/pipeline-trace.txt';

function isEnabled(): boolean {
  // Hard-guard: never write to the local filesystem in production (Vercel's
  // runtime filesystem is read-only outside /tmp). This prevents EROFS crashes
  // even if DUMP_PIPELINE_TRACE is accidentally left enabled in prod env.
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.DUMP_PIPELINE_TRACE === 'true';
}

export function traceReset(): void {
  if (!isEnabled()) return;
  writeFileSync(TRACE_FILE, `PIPELINE TRACE — ${new Date().toISOString()}\n\n`);
}

export function traceStep(stepName: string, content: string): void {
  if (!isEnabled()) return;
  const section = [
    '════════════════════════════════════════════════════════════════',
    `  ${stepName}`,
    '════════════════════════════════════════════════════════════════',
    '',
    content,
    '',
    '',
  ].join('\n');
  appendFileSync(TRACE_FILE, section);
}
