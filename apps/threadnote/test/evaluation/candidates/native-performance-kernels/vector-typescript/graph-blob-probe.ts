// Bounded adapter diagnostic, not a replacement for end-to-end retrieval evidence.
import {Array as EffectArray, String as EffectString} from 'effect';
import {searchExactVectorBlobs, type VectorSearchResult} from '@threadnote/inference/vector-search';
import {sha256HexSync} from '@threadnote/platform/sha256';

const [referenceRoot, countText, distribution, output] = process.argv.slice(2);
const count = Number(countText);
if (!referenceRoot || !output || ![10_000, 100_000].includes(count) || !['dense', 'tied'].includes(distribution)) {
  throw new Error('Expected reference checkout, 10000|100000, dense|tied and output path.');
}
const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {stdout: 'pipe', stderr: 'pipe'});
  const text = await new Response(child.stdout).text();
  if (await child.exited) throw new Error('Git provenance check failed.');
  return EffectString.trim(text);
};
const cwd = process.cwd();
const identity = async () => ({
  referenceCommit: await git(referenceRoot, 'rev-parse', 'HEAD'),
  candidateCommit: await git(cwd, 'rev-parse', 'HEAD'),
  referenceStatus: await git(referenceRoot, 'status', '--porcelain'),
  candidateStatus: await git(cwd, 'status', '--porcelain'),
});
const opening = await identity();
if (opening.referenceStatus || opening.candidateStatus) throw new Error('Probe requires clean source checkouts.');
const reference: typeof import('@threadnote/inference/vector-search') = await import(
  Bun.pathToFileURL(`${referenceRoot}/packages/inference/src/vector-search.ts`).href
);
const dimensions = 384;
const query = Array.from({length: dimensions}, (_, index) => (index === 0 ? 1 : 0));
const records = Array.from({length: count}, (_, index) => {
  const components = Array.from({length: dimensions}, (_, n) =>
    n === 0 ? 1 : distribution === 'tied' ? 0 : (((index + n * 17) % 11) - 5) / 100,
  );
  const inverse = 1 / Math.sqrt(EffectArray.reduce(components, 0, (sum, value) => sum + value * value));
  const vector = new Uint8Array(dimensions * 4 + 1).subarray(1);
  const view = new DataView(vector.buffer, vector.byteOffset, vector.byteLength);
  EffectArray.forEach(components, (value, n) => view.setFloat32(n * 4, value * inverse, true));
  return {id: `symbol-${EffectString.padStart(6, '0')(String(index))}`, vector};
});
const fixtureDigest = sha256HexSync(
  EffectArray.join(
    EffectArray.map(records, record => sha256HexSync(record.vector)),
    '',
  ),
);
const compare = (a: VectorSearchResult, b: VectorSearchResult) =>
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const evaluate = (arm: 'reference' | 'candidate'): readonly VectorSearchResult[] => {
  let best: readonly VectorSearchResult[] = [];
  for (let cursor = 0; cursor < records.length; cursor += 400) {
    const page = records.slice(cursor, cursor + 400);
    // Mirror only the existing graph adapter's canonical finite/magnitude check;
    // both scorers below are imported from their actual immutable checkouts.
    const options = {dimensions, limit: 25, minimumScore: 0.64};
    let matches: readonly VectorSearchResult[];
    if (arm === 'reference') {
      const checked = EffectArray.map(page, record => {
        const view = new DataView(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength);
        const decoded = Array.from({length: dimensions}, (_, n) => view.getFloat32(n * 4, true));
        if (EffectArray.some(decoded, value => !Number.isFinite(value))) throw new Error('Non-finite fixture.');
        const magnitude = Math.sqrt(EffectArray.reduce(decoded, 0, (sum, value) => sum + value * value));
        if (Math.abs(magnitude - 1) > 0.002) throw new Error('Non-unit fixture.');
        return {id: record.id, vector: decoded};
      });
      matches = reference.searchExactVectors(query, checked, options);
    } else {
      const checked = EffectArray.map(page, record => {
        const view = new DataView(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength);
        let magnitude = 0;
        for (let n = 0; n < dimensions; n += 1) {
          const component = view.getFloat32(n * 4, true);
          if (!Number.isFinite(component)) throw new Error('Non-finite fixture.');
          magnitude += component * component;
        }
        if (Math.abs(Math.sqrt(magnitude) - 1) > 0.002) throw new Error('Non-unit fixture.');
        return {id: record.id, vector: record.vector};
      });
      matches = searchExactVectorBlobs(query, checked, options);
    }
    best = [...best, ...matches].sort(compare).slice(0, 25);
  }
  return best;
};
const observed: {pair: number; arm: string; sample: number; milliseconds: number; digest: string}[] = [];
for (let pair = 1; pair <= 3; pair += 1) {
  for (let sample = 0; sample <= 30; sample += 1) {
    const order = (sample + pair) % 2 ? (['reference', 'candidate'] as const) : (['candidate', 'reference'] as const);
    const digests: string[] = [];
    for (const arm of order) {
      const start = performance.now();
      const result = evaluate(arm);
      const milliseconds = performance.now() - start;
      const digest = sha256HexSync(JSON.stringify(result));
      observed.push({pair, arm, sample, milliseconds, digest});
      digests.push(digest);
    }
    if (digests[0] !== digests[1]) throw new Error('Exact adapter parity failed.');
  }
}
const closing = await identity();
if (JSON.stringify(opening) !== JSON.stringify(closing)) throw new Error('Source changed during probe.');
await Bun.write(
  output,
  JSON.stringify(
    {
      kind: 'graph-blob-adapter-diagnostic',
      version: 1,
      opening,
      closing,
      environment: {runtime: Bun.version, platform: process.platform, architecture: process.arch},
      fixture: {count, dimensions, distribution, digest: fixtureDigest, pageSize: 400, limit: 25, minimumScore: 0.64},
      limitations: [
        'Synthetic precomputed query/document vectors; no model inference, SQL, graph eligibility or end-to-end request is measured.',
        'Validation and page merge are mirrored adapter operations; actual scorer implementations are imported from the declared clean checkouts.',
        'One process, counterbalanced serial calls; pair sample0 is first adapter use for that pair, not cold process/model/cache.',
        'No process-tree RSS claim or native adoption claim; end-to-end recall evidence is captured separately by the existing runner.',
      ],
      observed,
    },
    null,
    2,
  ),
);
