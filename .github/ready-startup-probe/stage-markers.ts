import {appendFileSync} from 'node:fs';

const log = process.env.THREADNOTE_STARTUP_PROBE_LOG;
const marks: Record<string, number> = {};

export function markProbe(stage: string): void {
  if (!log) return;
  const now = performance.now();
  if (stage === 'entry') {
    process.once('exit', () =>
      appendFileSync(log, JSON.stringify({
        pid: process.pid,
        request: process.env.THREADNOTE_STARTUP_PROBE_REQUEST,
        timeOrigin: performance.timeOrigin,
        marks,
      }) + '\n'),
    );
  }
  marks[stage] = now;
}
