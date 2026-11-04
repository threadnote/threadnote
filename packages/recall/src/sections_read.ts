import {Array as EffectArray, Effect, Option, Schema} from 'effect';
import {readLocalMemoryRecordsByUri} from '@threadnote/memory/local-path';
import {isReadCleanupUnconfirmed, ReadDeadlineExceeded} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isExternalResourceMetadata} from '@threadnote/store/external-resource';
import {recallCandidateIsValid} from './candidate_validation.js';
import {readRecallExactMatches, RecallReadyReadUnavailable} from './index.js';
import {withReadyRecallMaintenanceScope} from './index/maintenance.js';
import {
  isConnectionResult,
  readRecallMemoryConnections,
  type RecallMemoryConnectionsResult,
} from './memory/connections.js';
import {
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  recallReadyReadRequestSchema,
  recallReadySectionsSemanticSchema,
  type RecallReadySectionsOptions,
} from './read_boundary.js';
import type {RecallCandidate} from './rank.js';
import type {RecallHit} from './results.js';
import {
  emptyRecallSemanticScoresResult,
  prepareRecallSections,
  prepareRecallSectionsWithoutInference,
  type PrepareRecallSectionsInput,
  type RecallRuntimeConfig,
  type RecallSemanticScoresResult,
} from './runtime.js';
import {lexicalReadFailureWarning, mergeRecallOperationalWarnings, recallReadStateWarnings} from './warning.js';

const optional = Schema.optionalKey;
const strings = Schema.Array(Schema.String).check(Schema.isMaxLength(4096));
const exactMatchesSchema = Schema.Array(Schema.Struct({terms: strings, uri: Schema.String})).check(
  Schema.isMaxLength(4096),
);
const finite = Schema.Finite;
const signals = Schema.Struct({
  authority: finite,
  branch: optional(finite),
  bm25: finite,
  exact: finite,
  feedback: finite,
  field: finite,
  freshness: finite,
  graph: finite,
  kindIntent: finite,
  lifecycle: finite,
  reranker: finite,
  scope: finite,
  semantic: finite,
  temporal: finite,
  workspace: finite,
});
const hitSchema = Schema.Struct({
  category: Schema.Literals(['memories', 'resources', 'skills']),
  contextType: Schema.String,
  equivalentUris: optional(strings),
  external: optional(
    Schema.declare<NonNullable<RecallHit['external']>>(
      (value): value is NonNullable<RecallHit['external']> =>
        isExternalResourceMetadata(value) &&
        value.provider !== undefined &&
        'authority' in value &&
        value.authority === 'external' &&
        'trust' in value &&
        value.trust === 'untrusted' &&
        'fetchedAt' in value &&
        typeof value.fetchedAt === 'number' &&
        Number.isFinite(value.fetchedAt),
    ),
  ),
  identityConflict: optional(Schema.Boolean),
  memoryId: optional(Schema.String),
  exactTerms: optional(strings),
  finalScore: optional(finite),
  rankReasons: optional(
    Schema.Array(Schema.Struct({code: Schema.String, contribution: finite, detail: Schema.String})),
  ),
  rankSignals: optional(signals),
  rankWarnings: optional(strings),
  score: finite,
  snippet: Schema.String,
  uri: Schema.String,
});
export const recallReadySectionsResultSchema = Schema.Struct({
  confidence: optional(
    Schema.Struct({
      level: Schema.Literals(['high', 'low', 'medium', 'no_answer']),
      margin: finite,
      reason: Schema.String,
      score: finite,
    }),
  ),
  ranked: Schema.Array(hitSchema).check(Schema.isMaxLength(4096)),
  semanticSection: optional(Schema.String),
  exactTail: optional(Schema.String),
  expansionCandidates: Schema.Array(Schema.declare<RecallCandidate>(recallCandidateIsValid)).check(
    Schema.isMaxLength(4096),
  ),
  memoryConnections: optional(Schema.declare<RecallMemoryConnectionsResult>(isConnectionResult)),
  operationalWarnings: Schema.Array(
    Schema.Struct({
      code: Schema.Literals([
        'lexical_index_unavailable',
        'lexical_index_stale',
        'lexical_maintenance_unavailable',
        'lexical_read_budget_exhausted',
        'lexical_read_failed',
      ]),
      message: Schema.String,
      remediation: Schema.String,
    }),
  ).check(Schema.isMaxLength(4)),
  semantic: recallReadySectionsSemanticSchema,
  exactMatches: exactMatchesSchema,
});

type SectionsResult = typeof recallReadySectionsResultSchema.Type;
type WireCandidate = Omit<RecallCandidate, 'text'> & {readonly text: number};
type WireConnections = Omit<RecallMemoryConnectionsResult, 'candidates'> & {
  readonly candidates: readonly WireCandidate[];
};
const textReference = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 8191}));
const isWireCandidate = (value: unknown): value is WireCandidate =>
  typeof value === 'object' &&
  value !== null &&
  'text' in value &&
  Schema.is(textReference)(value.text) &&
  recallCandidateIsValid({...value, text: ''});
const sectionsWireSchema = Schema.Struct({
  ...recallReadySectionsResultSchema.fields,
  texts: Schema.Array(Schema.String).check(Schema.isMaxLength(8192)),
  expansionCandidates: Schema.Array(Schema.declare<WireCandidate>(isWireCandidate)).check(Schema.isMaxLength(4096)),
  memoryConnections: optional(
    Schema.declare<WireConnections>(
      (value): value is WireConnections =>
        typeof value === 'object' &&
        value !== null &&
        'candidates' in value &&
        EffectArray.isArray(value.candidates) &&
        value.candidates.length <= 4096 &&
        EffectArray.every(value.candidates, isWireCandidate) &&
        isConnectionResult({...value, candidates: []}),
    ),
  ),
});

/** Lossless transport sharing only: equal URIs never establish equal text. */
export function encodeRecallReadySectionsResult(value: SectionsResult) {
  const texts: string[] = [];
  const references = new Map<string, number>();
  const candidate = ({text, ...fields}: RecallCandidate): WireCandidate => {
    let reference = references.get(text);
    if (reference === undefined) {
      reference = texts.length;
      references.set(text, reference);
      texts.push(text);
    }
    return {...fields, text: reference};
  };
  return {
    ...value,
    expansionCandidates: EffectArray.map(value.expansionCandidates, candidate),
    ...(value.memoryConnections
      ? {
          memoryConnections: {
            ...value.memoryConnections,
            candidates: EffectArray.map(value.memoryConnections.candidates, candidate),
          },
        }
      : {}),
    texts,
  };
}

export const decodeRecallReadySectionsResult = Effect.fn('recall.decodeSectionsResult')(function* (value: unknown) {
  const {texts, ...sections} = yield* Schema.decodeUnknownEffect(sectionsWireSchema, {onExcessProperty: 'error'})(
    value,
  );
  const candidate = (entry: WireCandidate) => ({...entry, text: texts[entry.text]});
  // The original domain guard also rejects out-of-table references; no missing text is substituted.
  return yield* Schema.decodeUnknownEffect(recallReadySectionsResultSchema, {onExcessProperty: 'error'})({
    ...sections,
    expansionCandidates: EffectArray.map(sections.expansionCandidates, candidate),
    ...(sections.memoryConnections
      ? {
          memoryConnections: {
            ...sections.memoryConnections,
            candidates: EffectArray.map(sections.memoryConnections.candidates, candidate),
          },
        }
      : {}),
  });
});

const semanticToWire = (value: RecallSemanticScoresResult) => ({
  corpusGeneration: Option.getOrUndefined(value.corpusGeneration),
  scores: Option.isSome(value.scores) ? EffectArray.fromIterable(value.scores.value) : undefined,
  warning: Option.getOrUndefined(value.warning),
});
const semanticFromWire = (value: typeof recallReadySectionsSemanticSchema.Type): RecallSemanticScoresResult => ({
  corpusGeneration: Option.fromUndefinedOr(value.corpusGeneration),
  scores: value.scores === undefined ? Option.none() : Option.some(new Map(value.scores)),
  warning: Option.fromUndefinedOr(value.warning),
});

/** Content-bound evidence only; the wire never carries the cache's full canonical text keys. */
export const readyRecallRerankerScores = (input: Pick<PrepareRecallSectionsInput<never>, 'rerankerCache'>) =>
  EffectArray.map(
    EffectArray.fromIterable(input.rerankerCache?.scores ?? []),
    ([key, score]) => [sha256HexSync(key), score] as const,
  );

/** Runs with the worker's real services and no read boundary or model capabilities. */
export const serveRecallSections = Effect.fn('recall.serveSections')(function* (
  config: RecallRuntimeConfig,
  input: RecallReadySectionsOptions,
) {
  let warnings: ReturnType<typeof recallReadStateWarnings> = [];
  const exactMatches =
    input.mode === 'baseline' && input.exact && input.exact.terms.length > 0
      ? yield* readRecallExactMatches(config, {
          ...input.exact,
          includeInactive: input.includeInactive,
          eligibility: input.eligibility,
          onReadState: state => {
            warnings = mergeRecallOperationalWarnings(warnings, recallReadStateWarnings(state));
          },
        }).pipe(
          Effect.catchIf(
            error => !isReadCleanupUnconfirmed(error),
            error => {
              warnings = mergeRecallOperationalWarnings(warnings, [lexicalReadFailureWarning(error)]);
              return Effect.succeed([]);
            },
          ),
        )
      : [];
  const semantic = input.mode === 'closing' ? semanticFromWire(input.semantic) : emptyRecallSemanticScoresResult();
  const scores = new Map(input.mode === 'closing' ? input.rerankerScores : []);
  const prepared = yield* prepareRecallSectionsWithoutInference(
    config,
    {
      ...input,
      allowReranker: false,
      candidateUris: input.mode === 'closing' ? input.candidateUris : undefined,
      closingCandidateUris: input.mode === 'closing' ? input.candidateUris : undefined,
      exactMatches,
      passes: [],
      readRecords: uris => readLocalMemoryRecordsByUri(config, uris),
    },
    semantic,
    candidates =>
      EffectArray.map(candidates, candidate => {
        const score = scores.get(sha256HexSync(`${candidate.uri}\u0000${candidate.text}`));
        return score === undefined ? candidate : {...candidate, reranker: score};
      }),
  );
  const {semanticResult: completedSemantic, ...sections} = prepared;
  return encodeRecallReadySectionsResult({
    ...sections,
    operationalWarnings: mergeRecallOperationalWarnings(warnings, prepared.operationalWarnings),
    semantic: semanticToWire(completedSemantic),
    exactMatches,
  });
}, withReadyRecallMaintenanceScope);

export type ReadyRecallSectionsInput = Omit<
  PrepareRecallSectionsInput<never>,
  'readRecords' | 'readMemoryConnections' | 'passes' | 'exactMatches' | 'allowReranker'
> & {
  readonly exact?: {
    readonly terms: readonly string[];
    readonly uriScopes: readonly string[];
    readonly limitPerTerm: number;
  };
};

/** App-owned defaults only: arbitrary callback-based preparation remains a separate API. */
export const prepareDefaultRecallSections = Effect.fn('recall.prepareDefaultSections')(function* (
  config: RecallRuntimeConfig,
  input: Omit<PrepareRecallSectionsInput<never>, 'readRecords' | 'readMemoryConnections'> &
    Pick<ReadyRecallSectionsInput, 'exact'>,
) {
  if (input.allowReranker !== false) {
    const prepared = yield* prepareRecallSections(config, {
      ...input,
      readRecords: uris => readLocalMemoryRecordsByUri(config, uris),
      readMemoryConnections: options => readRecallMemoryConnections(config, options),
    });
    return {...prepared, exactMatches: input.exactMatches};
  }
  const {allowReranker: _allowReranker, passes: _passes, exactMatches: _exactMatches, ...ready} = input;
  return yield* readReadyRecallSections(config, ready);
});

/** Explicit app-owned canonical reader. Custom callback callers keep prepareRecallSections. */
export const readReadyRecallSections = Effect.fn('recall.readReadySections')(function* (
  config: RecallRuntimeConfig,
  input: ReadyRecallSectionsInput,
) {
  const invalid = () => RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
  const {
    semanticResult,
    rerankerCache,
    closingCandidateUris,
    candidateUris: _candidateUris,
    semanticGenerationMismatchPolicy: _mismatchPolicy,
    exact,
    ...fields
  } = input;
  const options =
    closingCandidateUris === undefined
      ? {...fields, mode: 'baseline', exact}
      : {
          ...fields,
          mode: 'closing',
          candidateUris: closingCandidateUris,
          semantic: semanticToWire(Option.getOrElse(semanticResult ?? Option.none(), emptyRecallSemanticScoresResult)),
          rerankerScores: readyRecallRerankerScores({rerankerCache}),
        };
  const result = yield* Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(recallReadyReadRequestSchema, {onExcessProperty: 'error'})(
      JSON.parse(
        JSON.stringify({
          operation: 'sections',
          config: {
            account: config.account,
            user: config.user,
            agentContextHome: config.agentContextHome,
            manifestPath: config.manifestPath,
          },
          options,
        }),
      ),
    ).pipe(Effect.mapError(invalid));
    if (request.operation !== 'sections') return yield* invalid();
    const boundary = yield* Effect.serviceOption(RecallReadyReadBoundary);
    const value = Option.isNone(boundary)
      ? yield* serveRecallSections(config, request.options)
      : yield* boundary.value.read(request).pipe(
          Effect.flatMap(response =>
            Effect.gen(function* () {
              if (response.operation !== 'sections') return yield* invalid();
              if (response.outcome === 'unavailable')
                return yield* RecallReadyReadUnavailable.make({
                  message: 'No readable ready lexical snapshot is available.',
                });
              if (response.outcome !== 'success')
                return yield* RecallReadyReadBoundaryError.make({reason: 'worker-failed'});
              return response.value;
            }),
          ),
        );
    return yield* decodeRecallReadySectionsResult(JSON.parse(JSON.stringify(value))).pipe(Effect.mapError(invalid));
  }).pipe(
    Effect.catchIf(
      error => !isReadCleanupUnconfirmed(error),
      error =>
        Effect.gen(function* () {
          if (
            closingCandidateUris === undefined &&
            Schema.is(RecallReadyReadBoundaryError)(error) &&
            error.reason === 'budget-exhausted'
          )
            return yield* ReadDeadlineExceeded.make({});
          const failure =
            Schema.is(RecallReadyReadBoundaryError)(error) && error.reason === 'budget-exhausted'
              ? RecallReadyReadUnavailable.make({
                  reason: 'budget-exhausted',
                  message: 'The lexical read budget is exhausted.',
                })
              : error;
          return {
            ranked: [],
            expansionCandidates: [],
            exactMatches: [],
            semantic: {},
            operationalWarnings: [lexicalReadFailureWarning(failure)],
            confidence: undefined,
            semanticSection: undefined,
            exactTail: undefined,
            memoryConnections: undefined,
          };
        }),
    ),
  );
  return {
    ...result,
    semanticSection: result.semanticSection,
    exactTail: result.exactTail,
    semanticResult: semanticFromWire(result.semantic),
  };
});
