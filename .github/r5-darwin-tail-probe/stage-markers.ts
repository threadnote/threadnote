import {appendFileSync} from 'node:fs';

const path = process.env.THREADNOTE_DARWIN_VECTOR_PROBE_LOG;
const milestones = new Set([
  'worker.entry', 'vector-state.decoded', 'vector-scores.decoded', 'vector.enter',
  'payload.end', 'open-lexical.begin', 'open-lexical.end', 'native-call.begin', 'native-call.end',
  'canonical.begin', 'selector.begin', 'validation.begin', 'validation.end', 'canonical.end',
  'closing-corpus.begin', 'closing-corpus.end', 'request.written',
]);

export function markProbe(event: string): void {
  if (!path || !milestones.has(event)) return;
  const usage = process.resourceUsage();
  const mark = {pid: process.pid, sample: process.env.THREADNOTE_DARWIN_VECTOR_PROBE_CONTEXT,
    event, milliseconds: performance.now(), userMicros: usage.userCPUTime, systemMicros: usage.systemCPUTime};
  appendFileSync(path, JSON.stringify(mark) + '\n');
}
