import {getLlama} from 'node-llama-cpp';
import {Array as EffectArray, Console, Effect, Option as EffectOption, pipe, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {normalizeVector, searchExactVectors} from '@threadnote/inference/vector-search';
import {sha256HexSync} from '@threadnote/platform/sha256';

const SymbolSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  qualifiedName: Schema.String,
  signature: Schema.optional(Schema.String),
  packageName: Schema.optional(Schema.String),
  path: Schema.String,
  documentation: Schema.optional(Schema.String),
});
const QuerySchema = Schema.Struct({
  id: Schema.String,
  answerable: Schema.Boolean,
  query: Schema.String,
  relevant: Schema.Array(Schema.String),
});
const FixtureSchema = Schema.Struct({
  id: Schema.String,
  queryPolicy: Schema.String,
  folds: Schema.Struct({
    train: Schema.Array(Schema.String),
    validation: Schema.Array(Schema.String),
    test: Schema.Array(Schema.String),
  }),
  families: Schema.Array(
    Schema.Struct({id: Schema.String, symbols: Schema.Array(SymbolSchema), queries: Schema.Array(QuerySchema)}),
  ),
});
type SymbolRow = typeof SymbolSchema.Type & {readonly family: string};
type QueryRow = typeof QuerySchema.Type & {readonly family: string};
type Fold = 'train' | 'validation' | 'test';
type VectorSet = {readonly docs: Map<string, number[]>; readonly queries: Map<string, number[]>};
type EmbeddedModel = {
  readonly revision: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly expectedSize: number;
  readonly actualSize: number;
  readonly dimensions: number;
  readonly configs: Map<string, VectorSet>;
};
type Observation = {
  readonly id: string;
  readonly family: string;
  readonly fold: Fold;
  readonly answerable: boolean;
  readonly relevant: readonly string[];
  readonly topScore: number;
  readonly reciprocalRank: number;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly relevantScore: readonly {readonly id: string; readonly score: number}[];
};
type Summary = {
  readonly queryCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly mrr: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly threshold: number;
  readonly answerableGateRecall: number | null;
  readonly positiveGateCount: {readonly found: number; readonly total: number};
  readonly answerableAnyCandidateAcceptance: number | null;
  readonly answerableAnyCandidateCount: {readonly accepted: number; readonly total: number};
  readonly hardNegativeFalsePositiveRate: number | null;
  readonly hardNegativeFalsePositiveCount: {readonly falsePositives: number; readonly total: number};
  readonly positiveTopRelevantScore: {
    readonly min: number | null;
    readonly median: number | null;
    readonly max: number | null;
  };
  readonly negativeTopScore: {readonly min: number | null; readonly median: number | null; readonly max: number | null};
  readonly perFamily?: Record<string, Summary>;
  readonly observations: readonly Observation[];
};
type Gate = {readonly threshold: number; readonly targetRecallSpecificity: number; readonly f1: number};
type Candidate = {
  readonly config: string;
  readonly trainGate: Gate;
  readonly train: Summary;
  readonly validation: Summary;
};

const fixturePath = `${import.meta.dir}/../packages/graph/test/evaluation/gemma2-graph-calibration.fixture.json`;
const args = process.argv.slice(2);
function requiredOption(name: string): string {
  const position = args.indexOf(name);
  const value = args[position + 1];
  if (position < 0 || value === undefined || pipe(value, EffectString.startsWith('--')))
    throw new Error(`${name} requires a value.`);
  return value;
}
if (args.length !== 4 || !args.includes('--models-dir') || !args.includes('--output')) {
  throw new Error(
    'Usage: bun scripts/evaluate-gemma2-graph-calibration.ts --models-dir <existing-absolute-directory> --output <absolute-artifact.json>',
  );
}
const modelsDirectory = requiredOption('--models-dir');
const outputPath = requiredOption('--output');
if (!pipe(modelsDirectory, EffectString.startsWith('/')) || !pipe(outputPath, EffectString.startsWith('/'))) {
  throw new Error('--models-dir and --output must be absolute paths to isolated locations.');
}
const fixtureFile = Bun.file(fixturePath);
const fixture = Schema.decodeUnknownSync(FixtureSchema)(await fixtureFile.json());
const sourceSha256 = sha256HexSync(new Uint8Array(await Bun.file(import.meta.path).arrayBuffer()));
const fixtureSha256 = sha256HexSync(new Uint8Array(await fixtureFile.arrayBuffer()));
const modelPaths = new Map([
  ['embeddinggemma-2-q8', `${modelsDirectory}/embeddinggemma-2-Q8_0.gguf`],
  ['bge-small-en-v1.5-q8', `${modelsDirectory}/bge-small-en-v1.5-q8_0.gguf`],
]);
const gemmaPrompts = [
  {id: 'official-default', query: 'task: search result | query: ', document: 'title: none | text: '},
  {id: 'code-retrieval', query: 'task: code retrieval | query: ', document: 'title: none | text: '},
  {id: 'search-result-title', query: 'task: search result | query: ', document: 'title: {{title}} | text: '},
  {id: 'code-retrieval-title', query: 'task: code retrieval | query: ', document: 'title: {{title}} | text: '},
];
const symbols: SymbolRow[] = [];
const queries: QueryRow[] = [];
const familyFold = new Map<string, Fold>();
for (const fold of ['train', 'validation', 'test'] as const) {
  for (const family of fixture.folds[fold]) familyFold.set(family, fold);
}
for (const family of fixture.families) {
  for (const symbol of family.symbols) symbols.push({...symbol, family: family.id});
  for (const query of family.queries) queries.push({...query, family: family.id});
}
function foldOf(family: string): Fold {
  const fold = familyFold.get(family);
  if (!fold) throw new Error(`Fixture family ${family} has no fold.`);
  return fold;
}
function projectSymbol(symbol: SymbolRow): string {
  const parts = [`${symbol.kind} ${symbol.qualifiedName}`];
  if (symbol.signature) parts.push(`signature: ${symbol.signature}`);
  if (symbol.packageName) parts.push(`package: ${symbol.packageName}`);
  parts.push(`path: ${symbol.path}`);
  if (symbol.documentation) parts.push(`documentation: ${pipe(symbol.documentation, EffectString.slice(0, 1024))}`);
  return EffectArray.join(parts, '\n');
}
function modelManifest(id: string) {
  return EffectOption.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.id === id));
}
async function actualModelHash(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyModel(id: string) {
  const manifest = modelManifest(id);
  const path = modelPaths.get(id);
  if (!path) throw new Error(`Missing local model path for ${id}.`);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Missing local model: ${path}`);
  const actualSize = file.size;
  if (actualSize !== manifest.size)
    throw new Error(`${id} size ${actualSize} does not match manifest ${manifest.size}.`);
  const actualSha256 = await actualModelHash(path);
  if (actualSha256 !== manifest.sha256)
    throw new Error(`${id} SHA-256 ${actualSha256} does not match manifest ${manifest.sha256}.`);
  return {manifest, path, actualSize, actualSha256};
}
const verifiedGemma = await verifyModel('embeddinggemma-2-q8');
const verifiedBge = await verifyModel('bge-small-en-v1.5-q8');
async function embed(id: string, verified: Awaited<ReturnType<typeof verifyModel>>): Promise<EmbeddedModel> {
  const {manifest, path, actualSize, actualSha256} = verified;
  const llama = await getLlama();
  try {
    const model = await llama.loadModel({modelPath: path});
    try {
      const context = await model.createEmbeddingContext({contextSize: manifest.contextLimit});
      try {
        const configs =
          id === 'embeddinggemma-2-q8'
            ? gemmaPrompts
            : [
                {
                  id: 'manifest-default',
                  query: manifest.promptPrefixes?.query ?? '',
                  document: manifest.promptPrefixes?.document ?? '',
                },
              ];
        const output = new Map<string, VectorSet>();
        for (const config of configs) {
          const docs = new Map<string, number[]>();
          const queryVectors = new Map<string, number[]>();
          for (const symbol of symbols) {
            const documentPrefix = config.document.includes('{{title}}')
              ? config.document.replace('{{title}}', symbol.qualifiedName)
              : config.document;
            const result = await context.getEmbeddingFor(`${documentPrefix}${projectSymbol(symbol)}`);
            docs.set(symbol.id, [...normalizeVector(result.vector)]);
          }
          for (const query of queries) {
            const result = await context.getEmbeddingFor(`${config.query}${query.query}`);
            queryVectors.set(query.id, [...normalizeVector(result.vector)]);
          }
          output.set(config.id, {docs, queries: queryVectors});
        }
        return {
          revision: manifest.revision,
          expectedSha256: manifest.sha256,
          actualSha256,
          expectedSize: manifest.size,
          actualSize,
          dimensions: manifest.dimensions,
          configs: output,
        };
      } finally {
        await context.dispose();
      }
    } finally {
      await model.dispose();
    }
  } finally {
    await llama.dispose();
  }
}
const embedded = new Map<string, EmbeddedModel>();
embedded.set('embeddinggemma-2-q8', await embed('embeddinggemma-2-q8', verifiedGemma));
embedded.set('bge-small-en-v1.5-q8', await embed('bge-small-en-v1.5-q8', verifiedBge));
function getEmbedded(id: string): EmbeddedModel {
  const model = embedded.get(id);
  if (!model) throw new Error(`Missing embedded model ${id}.`);
  return model;
}
function observations(modelId: string, configId: string, querySet: readonly QueryRow[]): Observation[] {
  const model = getEmbedded(modelId);
  const vectors = model.configs.get(configId);
  if (!vectors) throw new Error(`Missing embedding config ${configId}.`);
  const records: {id: string; vector: number[]}[] = [];
  for (const symbol of symbols) {
    const vector = vectors.docs.get(symbol.id);
    if (!vector) throw new Error(`Missing vector ${symbol.id}.`);
    records.push({id: symbol.id, vector});
  }
  const rows: Observation[] = [];
  for (const query of querySet) {
    const vector = vectors.queries.get(query.id);
    if (!vector) throw new Error(`Missing query vector ${query.id}.`);
    const ranked = searchExactVectors(vector, records, {dimensions: model.dimensions, limit: records.length});
    let rank = -1;
    for (let index = 0; index < ranked.length; index++) {
      if (query.relevant.includes(ranked[index].id)) {
        rank = index;
        break;
      }
    }
    const relevantScore: {id: string; score: number}[] = [];
    for (const id of query.relevant) {
      let score = -1;
      for (const row of ranked)
        if (row.id === id) {
          score = row.score;
          break;
        }
      relevantScore.push({id, score});
    }
    rows.push({
      id: query.id,
      family: query.family,
      fold: foldOf(query.family),
      answerable: query.answerable,
      relevant: query.relevant,
      topScore: ranked[0]?.score ?? 0,
      reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
      hitAt1: rank === 0,
      hitAt5: rank >= 0 && rank < 5,
      relevantScore,
    });
  }
  return rows;
}
function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / Math.max(1, values.length);
}
function ascending(values: readonly number[]): number[] {
  const sorted: number[] = [];
  for (const value of values) {
    let index = 0;
    while (index < sorted.length && sorted[index] <= value) index++;
    sorted.splice(index, 0, value);
  }
  return sorted;
}
function percentile(values: readonly number[], p: number): number | null {
  const sorted = ascending(values);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
}
function summary(items: readonly Observation[], threshold: number, includeFamilies = true): Summary {
  const positives: Observation[] = [];
  const negatives: Observation[] = [];
  const rr: number[] = [];
  const hits1: number[] = [];
  const hits5: number[] = [];
  const positiveTopRelevant: number[] = [];
  const negativeTop: number[] = [];
  let posGate = 0;
  let positiveAnyCandidate = 0;
  let falsePos = 0;
  for (const item of items) {
    if (item.answerable) {
      positives.push(item);
      rr.push(item.reciprocalRank);
      hits1.push(Number(item.hitAt1));
      hits5.push(Number(item.hitAt5));
      let topRelevant = -Infinity;
      for (const row of item.relevantScore) topRelevant = Math.max(topRelevant, row.score);
      positiveTopRelevant.push(topRelevant);
      if (topRelevant >= threshold) posGate++;
      if (item.topScore >= threshold) positiveAnyCandidate++;
    } else {
      negatives.push(item);
      negativeTop.push(item.topScore);
      if (item.topScore >= threshold) falsePos++;
    }
  }
  const perFamily: Record<string, Summary> = {};
  if (includeFamilies) {
    const grouped = new Map<string, Observation[]>();
    for (const item of items) {
      const group = grouped.get(item.family) ?? [];
      group.push(item);
      grouped.set(item.family, group);
    }
    for (const [family, group] of grouped) perFamily[family] = summary(group, threshold, false);
  }
  return {
    queryCount: items.length,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    mrr: mean(rr),
    hitAt1: mean(hits1),
    hitAt5: mean(hits5),
    threshold,
    answerableGateRecall: positives.length ? posGate / positives.length : null,
    positiveGateCount: {found: posGate, total: positives.length},
    answerableAnyCandidateAcceptance: positives.length ? positiveAnyCandidate / positives.length : null,
    answerableAnyCandidateCount: {accepted: positiveAnyCandidate, total: positives.length},
    hardNegativeFalsePositiveRate: negatives.length ? falsePos / negatives.length : null,
    hardNegativeFalsePositiveCount: {falsePositives: falsePos, total: negatives.length},
    positiveTopRelevantScore: {
      min: percentile(positiveTopRelevant, 0),
      median: percentile(positiveTopRelevant, 0.5),
      max: percentile(positiveTopRelevant, 1),
    },
    negativeTopScore: {
      min: percentile(negativeTop, 0),
      median: percentile(negativeTop, 0.5),
      max: percentile(negativeTop, 1),
    },
    perFamily: includeFamilies ? perFamily : undefined,
    observations: items,
  };
}
function chooseTrainGate(items: readonly Observation[]): Gate {
  const values = new Set<number>([-1, 1.000001]);
  for (const item of items) {
    values.add(item.topScore);
    for (const row of item.relevantScore) values.add(row.score);
  }
  let best: Gate | undefined;
  for (const threshold of ascending([...values])) {
    const result = summary(items, threshold, false);
    let relevantAccepted = 0;
    let anyAccepted = 0;
    for (const item of items) {
      if (item.topScore >= threshold) anyAccepted++;
      if (item.answerable)
        for (const row of item.relevantScore) {
          if (row.score >= threshold) {
            relevantAccepted++;
            break;
          }
        }
    }
    const precision = relevantAccepted / Math.max(1, anyAccepted);
    const recall = result.answerableGateRecall ?? 0;
    const f1 = (2 * precision * recall) / Math.max(1e-12, precision + recall);
    const candidate = {
      threshold,
      targetRecallSpecificity: (recall + 1 - (result.hardNegativeFalsePositiveRate ?? 0)) / 2,
      f1,
    };
    if (
      !best ||
      candidate.targetRecallSpecificity > best.targetRecallSpecificity ||
      (candidate.targetRecallSpecificity === best.targetRecallSpecificity &&
        (candidate.f1 > best.f1 || (candidate.f1 === best.f1 && candidate.threshold < best.threshold)))
    )
      best = candidate;
  }
  if (!best) throw new Error('No train gate candidate.');
  return best;
}
function byFold(fold: Fold): QueryRow[] {
  const rows: QueryRow[] = [];
  for (const query of queries) if (foldOf(query.family) === fold) rows.push(query);
  return rows;
}
const train = byFold('train');
const validationQueries = byFold('validation');
const candidates: Candidate[] = [];
for (const config of gemmaPrompts) {
  const trainRows = observations('embeddinggemma-2-q8', config.id, train);
  const trainGate = chooseTrainGate(trainRows);
  const validationRows = observations('embeddinggemma-2-q8', config.id, validationQueries);
  candidates.push({
    config: config.id,
    trainGate,
    train: summary(trainRows, trainGate.threshold),
    validation: summary(validationRows, trainGate.threshold),
  });
}
function utility(candidate: Candidate): number {
  return (
    ((candidate.validation.answerableGateRecall ?? 0) + 1 - (candidate.validation.hardNegativeFalsePositiveRate ?? 0)) /
    2
  );
}
let selected = candidates[0];
for (const candidate of candidates) {
  if (
    utility(candidate) > utility(selected) ||
    (utility(candidate) === utility(selected) &&
      (candidate.validation.mrr > selected.validation.mrr ||
        (candidate.validation.mrr === selected.validation.mrr &&
          candidate.validation.hitAt5 > selected.validation.hitAt5)))
  )
    selected = candidate;
}
const gemmaModel = getEmbedded('embeddinggemma-2-q8');
const receiptBody = {
  sourceSha256,
  fixtureSha256,
  modelRevision: gemmaModel.revision,
  modelSha256: gemmaModel.expectedSha256,
  modelActualSha256: gemmaModel.actualSha256,
  modelExpectedSize: gemmaModel.expectedSize,
  modelActualSize: gemmaModel.actualSize,
  config: selected.config,
  threshold: selected.trainGate.threshold,
  train: {targetRecallSpecificity: selected.trainGate.targetRecallSpecificity, f1: selected.trainGate.f1},
  validation: {
    targetRecallSpecificity: utility(selected),
    mrr: selected.validation.mrr,
    hitAt5: selected.validation.hitAt5,
  },
};
// This receipt is frozen before evaluating any test-family outcomes.
const receipt = {...receiptBody, sha256: sha256HexSync(JSON.stringify(receiptBody))};
const testQueries = byFold('test');
const gemmaTest = summary(
  observations('embeddinggemma-2-q8', selected.config, testQueries),
  selected.trainGate.threshold,
);
const bgeTest = summary(observations('bge-small-en-v1.5-q8', 'manifest-default', testQueries), 0.64);
const fixedGate = {
  threshold: 0.64,
  gemmaSelected: summary(observations('embeddinggemma-2-q8', selected.config, testQueries), 0.64),
  bge: bgeTest,
};
const models: Record<string, unknown> = {};
for (const [id, value] of embedded)
  models[id] = {
    revision: value.revision,
    sha256: value.expectedSha256,
    actualSha256: value.actualSha256,
    expectedSize: value.expectedSize,
    actualSize: value.actualSize,
    dimensions: value.dimensions,
  };
const output = {
  fixture: {
    path: fixturePath,
    id: fixture.id,
    sha256: fixtureSha256,
    families: fixture.folds,
    symbols: symbols.length,
    queries: queries.length,
  },
  sourceSha256,
  models,
  methodology: {
    documentProjection:
      'kind + qualifiedName; optional signature; optional packageName; path; documentation truncated to 1024 chars',
    normalization: 'production normalizeVector L2; cosine ranking via searchExactVectors',
    gateSelection:
      'train candidate set is distinct train top-score and relevant-score values plus -1 and 1.000001; maximize mean of relevant-candidate gate recall and hard-negative specificity, tie by F1 then lower gate; choose prompt by validation mean of the same retrieval metrics at frozen train gate, tie by MRR then Hit@5',
    finalTest: 'receipt frozen before test-family evaluation; selected Gemma config and BGE .64 control only',
    limitation:
      'synthetic vector-only proxy; no lexical retrieval, graph selector, real repository, production corpus/index, latency, or user-facing quality evaluated',
  },
  candidates,
  frozenSelection: receipt,
  finalTest: {gemma2: gemmaTest, bgeSmall: bgeTest},
  fixedGate,
};
await Bun.write(outputPath, `${JSON.stringify(output, null, 2)}\n`);
Effect.runSync(
  Console.log(
    JSON.stringify(
      {
        output: outputPath,
        frozenSelection: receipt,
        finalTest: {
          gemma2: {
            mrr: gemmaTest.mrr,
            hitAt1: gemmaTest.hitAt1,
            hitAt5: gemmaTest.hitAt5,
            answerableGateRecall: gemmaTest.answerableGateRecall,
            hardNegativeFalsePositiveCount: gemmaTest.hardNegativeFalsePositiveCount,
          },
          bgeSmall: {
            mrr: bgeTest.mrr,
            hitAt1: bgeTest.hitAt1,
            hitAt5: bgeTest.hitAt5,
            answerableGateRecall: bgeTest.answerableGateRecall,
            hardNegativeFalsePositiveCount: bgeTest.hardNegativeFalsePositiveCount,
          },
        },
      },
      null,
      2,
    ),
  ),
);
