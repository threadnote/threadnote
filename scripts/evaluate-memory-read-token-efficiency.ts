import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  memoryReadMcpStructuredContent,
  memoryReadMcpText,
  projectMemoryRead,
  type MemoryReadMcpResponseFormat,
  type MemoryReadResource,
} from '@threadnote/memory/read/projection';

const responseFormat: MemoryReadMcpResponseFormat = process.argv.includes('--agent')
  ? 'agent'
  : process.argv.includes('--text')
    ? 'text'
    : 'dual';

const uri = 'threadnote://user/fixture/memories/durable/projects/fixture/decision.md';
const citation = JSON.stringify({
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'src/decision.ts',
  repositoryId: 'b'.repeat(64),
  sourceCommit: 'c'.repeat(40),
  target: {kind: 'file'},
  version: 1,
});
const citedMemory = [
  'MEMORY',
  'kind: durable',
  'status: active',
  'project: fixture',
  'topic: decision',
  ...Array.from({length: 8}, () => `code_citation: ${citation}`),
  '',
  '# Decision',
  'Preserve exact-current citation evidence. '.repeat(80),
  '## Verification',
  'Check a current source before applying the decision. '.repeat(32),
].join('\n');
const cases = [
  {name: 'short', text: 'MEMORY\nkind: handoff\nstatus: active\n\n# Next step\nCheck the current source.\n'},
  {name: 'citation-heavy', text: citedMemory},
  {name: 'unicode-long', text: `${citedMemory}\n${'é🙂 precise evidence\n'.repeat(600)}`},
] as const;
const caseHash = sha256HexSync(JSON.stringify(cases));
const baseline = JSON.parse(
  await Bun.file(
    new URL(
      '../apps/threadnote/test/evaluation/baselines/memory-read-token-efficiency-v1/baseline.json',
      import.meta.url,
    ),
  ).text(),
) as {
  readonly caseHash: string;
  readonly cases: readonly {readonly name: string; readonly totalBytes: number}[];
};
if (caseHash !== baseline.caseHash) throw new Error('Memory read token-efficiency fixture changed from the baseline.');
const results = cases.map(fixture => {
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
    ? results.map(result => {
        const previous = baseline.cases.find(candidate => candidate.name === result.name);
        if (previous === undefined) throw new Error(`Missing baseline case ${result.name}.`);
        return {
          name: result.name,
          reducedBytes: previous.totalBytes - result.totalBytes,
          reductionPercent: Math.round((10000 * (previous.totalBytes - result.totalBytes)) / previous.totalBytes) / 100,
        };
      })
    : undefined;
if (responseFormat === 'agent' && comparison?.some(result => result.reducedBytes <= 0)) {
  throw new Error('Agent projection must be smaller than the frozen dual baseline for every case.');
}

process.stdout.write(
  `${JSON.stringify({caseHash, cases: results, ...(comparison ? {comparison} : {}), responseFormat, version: 1}, null, 2)}\n`,
);
