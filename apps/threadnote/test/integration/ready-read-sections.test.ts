import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {readLocalMemoryRecordsByUri} from '@threadnote/memory/local-path';
import {loadRecallIndexData, readRecallExactMatches} from '@threadnote/recall/index';
import {emptyRecallSemanticScoresResult, prepareRecallSections} from '@threadnote/recall/runtime';
import {recallReadySectionsOptionsSchema, type RecallReadySectionsOptions} from '@threadnote/recall/read_boundary';
import {
  decodeRecallReadySectionsResult,
  encodeRecallReadySectionsResult,
  recallReadySectionsResultSchema,
  readyRecallRerankerScores,
  serveRecallSections as serveWireRecallSections,
} from '@threadnote/recall/sections_read';
import type {RecallCandidate} from '@threadnote/recall/rank';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {RECALL_READY_READ_OUTPUT_BYTES, serveRecallReadyRead} from '../../src/recall/ready_read_worker.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

// Ranking equality needs one wall-clock instant; native lease/deadline clocks remain live.
const fixedRankingTime = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const now = Date.UTC(2026, 10, 4, 12);
    return yield* program.pipe(
      Effect.provideService(Clock.Clock, {
        currentTimeMillis: Effect.succeed(now),
        currentTimeMillisUnsafe: () => now,
        currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
        currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: duration => clock.sleep(duration),
      }),
    );
  });
const query = 'zebra exact preparation';
const body = (status: 'active' | 'archived' = 'active', project = 'allowed', text = query) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status,
      project,
      topic: query,
      memoryId: 'tn_sections_alpha',
      sourceAgentClient: 'test',
      timestamp: '2026-11-04T00:00:00.000Z',
    },
    text,
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'ready-sections-'});
  const config = {account: 'local', user: 'test', agentContextHome: home};
  const uri = 'threadnote://user/test/memories/durable/alpha.md';
  const filename = path.join(home, 'data/local/user/test/memories/durable/alpha.md');
  yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
  yield* fs.writeFileString(filename, body());
  const index = yield* loadRecallIndexData(config, {includeInactive: false});
  const options = {
    mode: 'baseline' as const,
    allowExactRescue: true,
    allowSemanticRescue: true,
    feedbackQuery: query,
    includeInactive: false,
    limit: 4,
    query,
    eligibility: {
      kind: 'candidate-policy',
      authority: 'any',
      projects: {mode: 'allow-projects-and-projectless', projects: ['allowed']},
    } as const,
    exact: {terms: ['zebra'], uriScopes: ['threadnote://user/test/memories'], limitPerTerm: 25},
  } satisfies RecallReadySectionsOptions;
  return {fs, path, config, uri, filename, index, options};
});

const wireResult = (value: unknown) => decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(value)));
const serveRecallSections = (...args: Parameters<typeof serveWireRecallSections>) =>
  serveWireRecallSections(...args).pipe(Effect.flatMap(wireResult));

const transportFixture = (
  expansionCandidates: readonly RecallCandidate[],
  connectionCandidates: readonly RecallCandidate[],
): typeof recallReadySectionsResultSchema.Type => ({
  ranked: EffectArray.map(expansionCandidates, candidate => ({
    category: 'memories' as const,
    contextType: 'MEMORY',
    score: 0.5,
    snippet: '',
    uri: candidate.uri,
  })),
  confidence: {level: 'high', margin: 0.25, score: 0.75, reason: 'transport fixture'},
  semanticSection: 'Rendered selected window.',
  expansionCandidates,
  memoryConnections: {
    candidates: connectionCandidates,
    connections: [],
    premises: [],
    coverage: {
      version: 1,
      connectionCount: 0,
      premiseCount: 0,
      resultCount: connectionCandidates.length,
      truncated: false,
    },
    diagnostics: {
      canonicalMismatches: 0,
      canonicalRereads: 0,
      rawLinkRows: 0,
      refreshRepairs: 0,
      truncatedSeedOrdinals: [],
    },
  },
  operationalWarnings: [],
  semantic: {},
  exactMatches: [],
});

describe('complete ready sections', () => {
  fcEffectProp(
    effectIt,
    'round trips every candidate field and exact text even when URI identities repeat',
    {texts: fc.array(fc.string({maxLength: 256}), {minLength: 1, maxLength: 12})},
    ({texts}) =>
      Effect.gen(function* () {
        const candidates = EffectArray.map(texts, (text, index) => ({
          uri: 'threadnote://user/test/memories/durable/repeated.md',
          text,
          fields: {topic: `topic ${index}`, identifiers: [text]},
          semantic: index / 12,
        }));
        const original = transportFixture(candidates, [...candidates].reverse());
        const encoded = encodeRecallReadySectionsResult(original);
        const decoded = yield* wireResult(encoded);
        expect(decoded).toEqual(original);
        expect(encoded.texts.length).toBe(new Set(texts).size);
        expect(decoded.expansionCandidates).not.toBe(original.expansionCandidates);
        const witness = (entries: readonly RecallCandidate[]) =>
          readyRecallRerankerScores({
            rerankerCache: {
              scores: new Map(EffectArray.map(entries, entry => [`${entry.uri}\u0000${entry.text}`, 1])),
              unavailable: false,
            },
          });
        expect(witness(decoded.expansionCandidates)).toEqual(witness(candidates));
      }),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect('keeps the combined connection payload lossless when separately bounded old parts fit', () =>
    Effect.gen(function* () {
      const filler = EffectString.repeat(420 * 1024)('z');
      const candidates = Array.from({length: 32}, (_, index) => ({
        uri: `threadnote://user/test/memories/durable/large-${index}.md`,
        text: `${index} ${filler}`,
      }));
      const original = transportFixture(candidates, candidates.slice(0, 8));
      const envelope = (operation: string, value: unknown) => ({
        protocol: 1,
        binding: EffectString.repeat(64)('a'),
        operation,
        observations: [],
        outcome: 'success',
        value,
      });
      const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      expect(
        bytes(
          envelope('batch', [
            {
              candidates,
              corpusStatistics: {
                averageDocumentLength: 1,
                documentCount: 32,
                totalDocumentLength: 32,
                documentFrequency: {zebra: 32},
              },
              generation: 'generation',
              queryExhaustive: true,
              readState: {freshness: 'current', maintenance: 'unneeded'},
            },
          ]),
        ),
      ).toBeLessThan(RECALL_READY_READ_OUTPUT_BYTES);
      expect(bytes(envelope('memory-connections', original.memoryConnections))).toBeLessThan(
        RECALL_READY_READ_OUTPUT_BYTES,
      );
      expect(bytes(envelope('sections', original))).toBeGreaterThan(RECALL_READY_READ_OUTPUT_BYTES);
      const encoded = encodeRecallReadySectionsResult(original);
      expect(bytes(envelope('sections', encoded))).toBeLessThan(RECALL_READY_READ_OUTPUT_BYTES);
      expect(yield* wireResult(encoded)).toEqual(original);
    }),
  );

  effectIt.effect('rejects missing, nonfinite, fractional and out-of-table text references', () =>
    Effect.gen(function* () {
      const encoded = encodeRecallReadySectionsResult(
        transportFixture([{uri: 'threadnote://test', text: 'exact'}], []),
      );
      for (const text of [undefined, -1, 0.5, Infinity, 1, 8192, 'exact']) {
        const result = yield* decodeRecallReadySectionsResult({
          ...encoded,
          expansionCandidates: [{uri: 'threadnote://test', text}],
        }).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
      }
    }),
  );

  fcEffectProp(
    effectIt,
    'preserves direct ranking and exact evidence across bounded queries, limits and scopes',
    {limit: fc.integer({min: 1, max: 5}), query: fc.constantFrom(query, 'zebra', 'unmatched'), denied: fc.boolean()},
    input =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const options = {
          ...f.options,
          limit: input.limit,
          query: input.query,
          allowedUriScopes: input.denied ? ['threadnote://user/foreign/memories'] : undefined,
        };
        const exactMatches = yield* readRecallExactMatches(f.config, {
          ...options.exact,
          includeInactive: false,
          eligibility: options.eligibility,
        });
        const direct = yield* prepareRecallSections(f.config, {
          ...options,
          allowReranker: false,
          passes: [],
          exactMatches,
          semanticResult: Option.some(emptyRecallSemanticScoresResult()),
          readRecords: uris => readLocalMemoryRecordsByUri(f.config, uris),
        });
        const response = yield* serveRecallReadyRead({
          operation: 'sections',
          config: f.config,
          options: yield* Schema.decodeUnknownEffect(recallReadySectionsOptionsSchema)(
            JSON.parse(JSON.stringify(options)),
          ),
        });
        expect(response.outcome).toBe('success');
        if (response.outcome !== 'success') return yield* Effect.die('Expected successful sections.');
        const composite = yield* wireResult(response.value);
        expect(composite.ranked).toEqual(direct.ranked);
        expect(composite.confidence).toEqual(direct.confidence);
        expect(composite.expansionCandidates).toEqual(direct.expansionCandidates);
        expect(composite.exactMatches).toEqual(exactMatches);
        if (input.denied) expect(composite.ranked).toEqual([]);
      }).pipe(fixedRankingTime, provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 8}},
  );

  for (const mutation of ['archive', 'project', 'delete'] as const) {
    effectIt.effect(`closes only current canonical scope after ${mutation}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const baseline = yield* serveRecallSections(f.config, f.options);
        expect(baseline.ranked[0]?.uri).toBe(f.uri);
        if (mutation === 'delete') yield* f.fs.remove(f.filename);
        else
          yield* f.fs.writeFileString(
            f.filename,
            body(mutation === 'archive' ? 'archived' : 'active', mutation === 'project' ? 'denied' : 'allowed'),
          );
        const closing = yield* serveRecallSections(f.config, {
          ...f.options,
          mode: 'closing',
          candidateUris: [f.uri],
          semantic: {},
          rerankerScores: [],
        });
        expect(closing.ranked).toEqual([]);
        expect(closing.semanticSection ?? '').not.toContain(f.uri);
        expect(closing.confidence?.level).toBe('no_answer');
      }).pipe(fixedRankingTime, provideTestLayer(ApplicationLayer), TestClock.withLive),
    );
  }

  effectIt.effect('matches cached reranker evidence to exact current text without sending text keys', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const baseline = yield* serveRecallSections(f.config, f.options);
      const candidate = Option.getOrThrow(
        EffectArray.findFirst(baseline.expansionCandidates, value => value.uri === f.uri),
      );
      const rerankerScores = readyRecallRerankerScores({
        rerankerCache: {
          scores: new Map([[`${candidate.uri}\u0000${candidate.text}`, 1]]),
          unavailable: false,
        },
      });
      expect(JSON.stringify(rerankerScores)).not.toContain(candidate.text);
      const options = {...f.options, mode: 'closing' as const, candidateUris: [f.uri], semantic: {}, rerankerScores};
      const scored = yield* serveRecallSections(f.config, options);
      expect(scored.confidence?.score).toBeGreaterThan(baseline.confidence?.score ?? 1);
      yield* f.fs.writeFileString(f.filename, body('active', 'allowed', `${query} changed current text`));
      yield* loadRecallIndexData(f.config, {includeInactive: false, forceRefresh: true});
      const stale = yield* serveRecallSections(f.config, options);
      const lexical = yield* serveRecallSections(f.config, {...options, rerankerScores: []});
      expect(stale.ranked).toEqual(lexical.ranked);
      expect(stale.confidence).toEqual(lexical.confidence);
    }).pipe(fixedRankingTime, provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('checks semantic generation after canonical hydration inside the complete operation', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let changed = false;
      const rebuildContext = yield* Effect.context<Effect.Services<ReturnType<typeof loadRecallIndexData>>>();
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        readFileString: (...args) =>
          Effect.gen(function* () {
            const content = yield* f.fs.readFileString(...args);
            if (args[0] === f.filename && !changed) {
              changed = true;
              yield* f.fs.writeFileString(
                f.filename,
                body('active', 'allowed', `${query} generation advanced during hydration`),
              );
              yield* loadRecallIndexData(f.config, {includeInactive: false, forceRefresh: true}).pipe(
                Effect.setContext(rebuildContext),
                Effect.orDie,
              );
            }
            return content;
          }).pipe(Effect.orDie),
      });
      const closing = yield* serveRecallSections(f.config, {
        ...f.options,
        mode: 'closing',
        candidateUris: [f.uri],
        semantic: {corpusGeneration: f.index.generation, scores: [[f.uri, 1]]},
        rerankerScores: [],
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      expect(changed).toBe(true);
      expect(closing.semantic.scores).toBeUndefined();
      expect(closing.ranked[0]?.uri).toBe(f.uri);
    }).pipe(fixedRankingTime, provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps arbitrary canonical hydration callbacks on the direct preparation API', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let calls = 0;
      const direct = yield* prepareRecallSections(f.config, {
        ...f.options,
        allowReranker: false,
        passes: [],
        exactMatches: [],
        semanticResult: Option.some(emptyRecallSemanticScoresResult()),
        readRecords: () =>
          Effect.sync(() => {
            calls++;
            return [];
          }),
      });
      expect(calls).toBeGreaterThan(0);
      expect(direct.ranked).toEqual([]);
    }).pipe(fixedRankingTime, provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rejects executable options, excess fields and nonfinite score witnesses', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const {exact: _exact, ...common} = f.options;
      const closing = {...common, mode: 'closing', candidateUris: [f.uri], semantic: {}, rerankerScores: []};
      for (const extra of [
        {allowReranker: true},
        {readRecords: 'callback'},
        {semantic: {scores: [[f.uri, Infinity]]}},
        {rerankerScores: [[EffectString.repeat(64)('0'), NaN]]},
      ]) {
        const decoded = yield* Schema.decodeUnknownEffect(recallReadySectionsOptionsSchema, {
          onExcessProperty: 'error',
        })({...closing, ...extra}).pipe(Effect.result);
        expect(decoded._tag).toBe('Failure');
      }
    }).pipe(fixedRankingTime, provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});
