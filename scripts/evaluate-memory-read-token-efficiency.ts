import {Array as EffectArray, Option as EffectOption} from 'effect';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  memoryReadMcpStructuredContent,
  memoryReadMcpText,
  projectMemoryRead,
  type MemoryReadMcpResponseFormat,
  type MemoryReadResource,
} from '@threadnote/memory/read/projection';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const responseFormat: MemoryReadMcpResponseFormat = process.argv.includes('--agent')
  ? 'agent'
  : process.argv.includes('--text')
    ? 'text'
    : 'dual';

const uri = 'threadnote://user/fixture/memories/durable/projects/fixture/decision.md';
const citation = JSON.stringify({
  fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
  path: 'src/decision.ts',
  repositoryId: Effect.pipe('b', EffectString.repeat(64)),
  sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
  target: {kind: 'file'},
  version: 1,
});
const citedMemory = EffectArray.join(
  [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: fixture',
    'topic: decision',
    ...Array.from({length: 8}, () => `code_citation: ${citation}`),
    '',
    '# Decision',
    Effect.pipe('Preserve exact-current citation evidence. ', EffectString.repeat(80)),
    '## Verification',
    Effect.pipe('Check a current source before applying the decision. ', EffectString.repeat(32)),
  ],
  '\n',
);
const cases = [
  {name: 'short', text: 'MEMORY\nkind: handoff\nstatus: active\n\n# Next step\nCheck the current source.\n'},
  {name: 'citation-heavy', text: citedMemory},
  {name: 'unicode-long', text: `${citedMemory}\n${Effect.pipe('é🙂 precise evidence\n', EffectString.repeat(600))}`},
] as const;
const caseHash = sha256HexSync(JSON.stringify(cases));
const baselineValue: unknown = JSON.parse(
  await Bun.file(
    new URL(
      '../apps/threadnote/test/evaluation/baselines/memory-read-token-efficiency-v1/baseline.json',
      import.meta.url,
    ),
  ).text(),
);
if (!isMemoryReadBaseline(baselineValue)) throw new Error('Memory read token-efficiency baseline is invalid.');
const baseline = baselineValue;
if (caseHash !== baseline.caseHash) throw new Error('Memory read token-efficiency fixture changed from the baseline.');
function isMemoryReadBaseline(value: unknown): value is {
  readonly caseHash: string;
  readonly cases: readonly {readonly name: string; readonly totalBytes: number}[];
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('caseHash' in value) ||
    typeof value.caseHash !== 'string' ||
    !('cases' in value) ||
    !EffectArray.isArray(value.cases)
  )
    return false;
  return EffectArray.every(
    value.cases,
    item =>
      typeof item === 'object' &&
      item !== null &&
      'name' in item &&
      typeof item.name === 'string' &&
      'totalBytes' in item &&
      typeof item.totalBytes === 'number',
  );
}

const results = EffectArray.map(cases, fixture => {
  const resources: readonly MemoryReadResource[] = [{text: fixture.text, uri}];
  const read = projectMemoryRead(resources);
  const structuredContent = memoryReadMcpStructuredContent(read, responseFormat);
  const measurement = measureAgentToolResponse({structuredContent, text: memoryReadMcpText(read, responseFormat)});
  return {
    name: fixture.name,
    contentBytes: read.structuredContent.contentBytes,
    estimatedTokens: measurement.estimatedTokens,
    structuredBytes: measurement.structuredBytes,
    textBytes: measurement.textBytes,
    totalBytes: measurement.totalBytes,
  };
});
if (responseFormat === 'dual' && JSON.stringify(results) !== JSON.stringify(baseline.cases)) {
  throw new Error('Dual-channel memory read projection changed from the frozen baseline.');
}
const comparison =
  responseFormat !== 'dual'
    ? EffectArray.map(results, result => {
        const previous = EffectOption.getOrUndefined(
          EffectArray.findFirst(baseline.cases, candidate => candidate.name === result.name),
        );
        if (previous === undefined) throw new Error(`Missing baseline case ${result.name}.`);
        return {
          name: result.name,
          reducedBytes: previous.totalBytes - result.totalBytes,
          reductionPercent: Math.round((10000 * (previous.totalBytes - result.totalBytes)) / previous.totalBytes) / 100,
        };
      })
    : undefined;
if (
  responseFormat === 'agent' &&
  EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(comparison), __effectArrayReceiver =>
      EffectArray.some(__effectArrayReceiver, result => result.reducedBytes <= 0),
    ),
  )
) {
  throw new Error('Agent projection must be smaller than the frozen dual baseline for every case.');
}

process.stdout.write(
  `${JSON.stringify({caseHash, cases: results, ...(comparison ? {comparison} : {}), responseFormat, version: 1}, null, 2)}\n`,
);
