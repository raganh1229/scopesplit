import { writeFileSync, appendFileSync } from 'fs';

function getTraceFile(comparisonId: string): string {
  return `scripts/pipeline-trace-${comparisonId}.txt`;
}

function isEnabled(): boolean {
  // Hard-guard: never write to the local filesystem in production (Vercel's
  // runtime filesystem is read-only outside /tmp). This prevents EROFS crashes
  // even if DUMP_PIPELINE_TRACE is accidentally left enabled in prod env.
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.DUMP_PIPELINE_TRACE === 'true';
}

export function traceReset(comparisonId: string): void {
  if (!isEnabled()) return;
  const traceFile = getTraceFile(comparisonId);
  writeFileSync(traceFile, `PIPELINE TRACE — ${comparisonId} — ${new Date().toISOString()}\n\n`);
}

export function traceStep(comparisonId: string, stepName: string, content: string): void {
  if (!isEnabled()) return;
  const traceFile = getTraceFile(comparisonId);
  const section = [
    '════════════════════════════════════════════════════════════════',
    `  ${stepName}`,
    '════════════════════════════════════════════════════════════════',
    '',
    content,
    '',
    '',
  ].join('\n');
  appendFileSync(traceFile, section);
}
