import {appendFileSync} from 'node:fs';

const path = process.env.THREADNOTE_DARWIN_VECTOR_PROBE_LOG;
const marks: unknown[] = [];

export function markProbe(event: string): void {
  if (!path) return;
  const time = performance.now();
  const r = process.resourceUsage();
  if (!marks.length) {
    process.once('exit', () => appendFileSync(path, JSON.stringify({
      pid: process.pid, sample: process.env.THREADNOTE_DARWIN_VECTOR_PROBE_CONTEXT,
      timeOrigin: performance.timeOrigin, marks
    }) + '\n'));
  }
  marks.push([event, time, r.userCPUTime, r.systemCPUTime, r.voluntaryContextSwitches, r.involuntaryContextSwitches, r.majorPageFault]);
}
