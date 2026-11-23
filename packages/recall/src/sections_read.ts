import {Array as EffectArray, Effect, Option, Schema, String as EffectString} from 'effect';
import {readLocalMemoryRecordsByUri} from '@threadnote/memory/local-path';
import {isReadCleanupUnconfirmed, ReadDeadlineExceeded} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {stripFragment} from '@threadnote/platform/string-boundaries';
import {SystemInfo} from '@threadnote/platform/system';
import {isExternalResourceMetadata} from '@threadnote/store/external-resource';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/workspace/manifest';
import {recallCandidateIsValid} from './candidate_validation.js';
import {readRecallBodyBm25, readRecallExactMatches, RecallReadyReadUnavailable} from './index.js';
import {withReadyRecallMaintenanceScope} from './index/maintenance.js';
import {isConnectionResult, type RecallMemoryConnectionsResult} from './memory/connections.js';
import {
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  recallReadyReadRequestSchema,
  recallReadySectionsSemanticSchema,
  recallSemanticPreflightSchema,
  type RecallReadySectionsOptions,
} from './read_boundary.js';
import {originalQueryRequestsRecency, type RecallCandidate} from './rank.js';
import {reciprocalRankFusion, RECALL_FUSION_WINDOW} from './rank-fusion.js';
import {formatRecallHits, type RecallHit, type RecallSections} from './results.js';
import {
  emptyRecallSemanticScoresResult,
  prepareRecallSectionsWithoutInference,
  recallCrossScopeLaneBudgets,
  warmRecallReranker,
  type PrepareRecallSectionsInput,
  type RecallRerankerCache,
  type RecallRuntimeConfig,
  type RecallSemanticScoresResult,
} from './runtime.js';
import {
  lexicalReadFailureWarning,
  mergeRecallOperationalWarnings,
  RECALL_LEXICAL_READ_FAILURE_REASONS,
  recallReadFailureReason,
  recallReadPhaseOutcome,
  recallReadStateWarnings,
  type RecallOperationalWarning,
} from './warning.js';

export {RECALL_FUSION_WINDOW} from './rank-fusion.js';

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
  fused: optional(Schema.Boolean),
  semanticPreflight: optional(recallSemanticPreflightSchema),
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
    Schema.Union([
      Schema.Struct({
        code: Schema.Literals([
          'lexical_index_unavailable',
          'lexical_index_stale',
          'lexical_maintenance_unavailable',
          'lexical_read_budget_exhausted',
        ]),
        message: Schema.String,
        remediation: Schema.String,
      }),
      Schema.Struct({
        code: Schema.Literal('lexical_read_failed'),
        reason: Schema.Literals(RECALL_LEXICAL_READ_FAILURE_REASONS),
        message: Schema.String,
        remediation: Schema.String,
      }),
    ]),
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
  const semantic = input.semantic === undefined ? emptyRecallSemanticScoresResult() : semanticFromWire(input.semantic);
  const scores = new Map(input.rerankerScores ?? []);
  // The worker never runs inference. Every read ranks with the parent's cached scores, so refinement keeps them.
  const prepare = (selection = input.candidateUris) =>
    prepareRecallSectionsWithoutInference(
      config,
      {
        ...input,
        candidateUris: selection,
        closingCandidateUris: input.mode === 'closing' ? selection : undefined,
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
  const initial = yield* prepare();
  const fusion: FusedReadyRanks | undefined =
    input.mode === 'closing' && input.fuseLocalMemories === true
      ? yield* fuseReadyMemoryRanks(config, input, initial, prepare)
      : undefined;
  const prepared = fusion?.retryNative ? yield* prepare() : initial;
  const fused = fusion?.ranked;
  const {generations: _generations, semanticResult: completedSemantic, ...sections} = prepared;
  return encodeRecallReadySectionsResult({
    ...sections,
    ...(fused === undefined
      ? {}
      : {fused: true, ranked: fused, semanticSection: formatRecallHits(fused, input.limit, sections.confidence)}),
    operationalWarnings: mergeRecallOperationalWarnings(warnings, prepared.operationalWarnings),
    semantic: semanticToWire(completedSemantic),
    exactMatches,
  });
}, withReadyRecallMaintenanceScope);

type PreparedRecallSections = Effect.Success<ReturnType<typeof prepareRecallSectionsWithoutInference>>;
type FusedReadyRanks = {readonly ranked?: readonly RecallHit[]; readonly retryNative?: boolean};

const fuseReadyMemoryRanks = Effect.fn('recall.fuseReadyMemoryRanks')(function* <R>(
  config: RecallRuntimeConfig,
  input: Extract<RecallReadySectionsOptions, {mode: 'closing'}>,
  prepared: PreparedRecallSections,
  prepare: (selection: readonly string[]) => Effect.Effect<PreparedRecallSections, unknown, R>,
) {
  const generation = prepared.generations[0];
  // A body match cannot overrule the native whole-query abstention decision.
  if (
    prepared.confidence?.level === 'no_answer' ||
    generation === undefined ||
    prepared.generations.length !== 1 ||
    prepared.operationalWarnings.length > 0
  )
    return undefined;
  const localRoot = `threadnote://user/${uriSegment(config.user)}/memories/`;
  const localUri = (uri: string) =>
    EffectString.startsWith(localRoot)(uri) &&
    (!EffectString.startsWith(`${localRoot}shared/`)(uri) ||
      EffectArray.some(input.allowedSharedUriScopes ?? [], scope => resourceIdIsWithin(uri, scope)));
  const isLocalMemory = (hit: RecallHit) => hit.category === 'memories' && localUri(hit.uri);
  const native = EffectArray.filter(prepared.ranked, isLocalMemory);
  if (native.length === 0) return undefined;

  const readBody = (workspaceScopeMode?: 'hierarchy' | 'sibling') =>
    readRecallBodyBm25(config, {
      allowedSharedUriScopes: input.allowedSharedUriScopes,
      allowedUriScopes: input.allowedUriScopes,
      eligibility: input.eligibility,
      includeInactive: false,
      project: input.eligibility === undefined ? input.project : undefined,
      query: input.feedbackQuery,
      workspaceScope: input.workspaceScope,
      workspaceScopeMode,
    }).pipe(
      Effect.catchIf(
        error => !isReadCleanupUnconfirmed(error),
        () => Effect.void,
      ),
    );
  const body = yield* readBody();
  if (body?.generation !== generation) return {retryNative: true} satisfies FusedReadyRanks;
  const room = RECALL_FUSION_WINDOW - body.uris.length;
  const siblings = input.workspaceScope && room > 0 ? yield* readBody('sibling') : undefined;
  if (input.workspaceScope && room > 0 && siblings?.generation !== generation)
    return {retryNative: true} satisfies FusedReadyRanks;
  const bodyUris = [
    ...body.uris,
    ...(siblings?.uris.slice(0, Math.min(room, recallCrossScopeLaneBudgets(input.limit).crossScopeReserve)) ?? []),
  ];
  if (bodyUris.length === 0) return undefined;

  const byUri = new Map(EffectArray.map(native, hit => [stripFragment(hit.uri), hit] as const));
  const aliases = new Map<string, string>();
  for (const hit of native) {
    for (const uri of hit.equivalentUris ?? []) {
      if (localUri(uri) && !byUri.has(uri)) aliases.set(uri, stripFragment(hit.uri));
    }
  }
  const bodyRanks = EffectArray.map(bodyUris, uri => aliases.get(uri) ?? uri);
  const additional = EffectArray.filter(bodyRanks, uri => !byUri.has(uri));
  const nativeRanks = [...byUri.keys()];
  if (additional.length > 0) {
    // Check new candidates with the same canonical reads, scope and relevance gate as native results.
    const admitted = yield* prepare([...new Set([...input.candidateUris, ...additional])]).pipe(
      Effect.catchIf(
        error => !isReadCleanupUnconfirmed(error),
        () => Effect.void,
      ),
    );
    if (
      admitted?.generations.length !== 1 ||
      admitted.generations[0] !== generation ||
      admitted.operationalWarnings.length > 0
    )
      return {retryNative: true} satisfies FusedReadyRanks;
    const nativeMemoryIds = new Set(EffectArray.map(native, hit => hit.memoryId));
    const required = new Set(additional);
    for (const hit of admitted.ranked) {
      if (
        !isLocalMemory(hit) ||
        hit.identityConflict ||
        (hit.memoryId !== undefined && nativeMemoryIds.has(hit.memoryId))
      )
        continue;
      for (const uri of [stripFragment(hit.uri), ...(hit.equivalentUris ?? [])]) {
        if (required.has(uri) && localUri(uri)) byUri.set(uri, hit);
      }
    }
  }

  const proximity = (hit: RecallHit) => (input.workspaceScope ? hit.rankSignals?.workspace : undefined);
  const queues = new Map<number | undefined, RecallHit[]>();
  for (const tier of new Set(EffectArray.map([...byUri.values()], proximity))) {
    const inTier = (uri: string) => {
      const hit = byUri.get(uri);
      return hit !== undefined && proximity(hit) === tier;
    };
    const nativeTier = EffectArray.filter(nativeRanks, inTier);
    const bodyTier = input.workspaceScope ? EffectArray.filter(bodyRanks, inTier) : bodyRanks;
    const local = new Map<string, RecallHit>();
    for (const uri of [...reciprocalRankFusion(nativeTier, bodyTier), ...nativeTier]) {
      const hit = byUri.get(uri);
      if (hit !== undefined) local.set(stripFragment(hit.uri), hit);
    }
    queues.set(tier, [...local.values()]);
  }
  // Preserve the native slots for workspace proximity and other evidence kinds.
  const slots = EffectArray.map(prepared.ranked, hit =>
    isLocalMemory(hit) ? (queues.get(proximity(hit))?.shift() ?? hit) : hit,
  );
  return {ranked: [...slots, ...EffectArray.flatMap([...queues.values()], hits => hits)]} satisfies FusedReadyRanks;
});

export type ReadyRecallSectionsInput = Omit<
  PrepareRecallSectionsInput<never>,
  'readRecords' | 'readMemoryConnections' | 'passes' | 'exactMatches' | 'semanticGenerationMismatchPolicy'
> & {
  readonly allowedSharedUriScopes?: readonly string[];
  readonly fuseLocalMemories?: boolean;
  readonly exact?: {
    readonly terms: readonly string[];
    readonly uriScopes: readonly string[];
    readonly limitPerTerm: number;
  };
};

class InvalidRecallRanking extends Schema.TaggedError<InvalidRecallRanking, {readonly brand: unique symbol}>()(
  'InvalidRecallRanking',
  {
    message: Schema.String,
  },
) {}

export const shouldFuseLocalMemoryRecall = Effect.fn('recall.shouldFuseLocalMemoryRecall')(function* (options: {
  readonly query: string;
  readonly memoryRefs?: readonly string[];
  readonly includeArchived?: boolean;
  readonly pinnedOrRestricted?: boolean;
  readonly workset?: string;
}) {
  const environment = (yield* SystemInfo).environment();
  const configured = EffectString.trim(environment.THREADNOTE_RECALL_RANKING ?? '') || 'fusion';
  if (configured !== 'fusion' && configured !== 'hybrid')
    return yield* InvalidRecallRanking.make({message: 'THREADNOTE_RECALL_RANKING must be fusion or hybrid.'});
  return (
    configured === 'fusion' &&
    options.query.length > 0 &&
    !options.memoryRefs?.length &&
    !options.includeArchived &&
    !options.pinnedOrRestricted &&
    !options.workset &&
    !originalQueryRequestsRecency(options.query)
  );
});

export const RECALL_BODY_FUSION_NOTICE = 'Memory order uses reciprocal rank fusion with body BM25.';

export function limitRecallSectionDisplay<A extends Pick<RecallSections, 'confidence' | 'ranked' | 'semanticSection'>>(
  sections: A,
  limit: number,
): A {
  return {...sections, semanticSection: formatRecallHits(sections.ranked, limit, sections.confidence)};
}

/** The window warm-up only adds cached scores, so it never holds a recall longer than this. */
export const RECALL_RERANKER_WINDOW_WARM_MILLISECONDS = 2_000;

/**
 * Closing ranks only its window with cached scores, so score that window, including semantic-only hits.
 * If the warm-up does not finish in time, closing uses the scores that are already cached.
 */
export function warmRecallRerankerWindow(
  config: Pick<RecallRuntimeConfig, 'agentContextHome'>,
  query: string,
  sections: {readonly ranked: readonly RecallHit[]; readonly expansionCandidates: readonly RecallCandidate[]},
  limit: number,
  cache: RecallRerankerCache,
) {
  const window = new Set(EffectArray.map(sections.ranked.slice(0, limit), hit => stripFragment(hit.uri)));
  return warmRecallReranker(
    config.agentContextHome,
    query,
    EffectArray.filter(sections.expansionCandidates, candidate => window.has(stripFragment(candidate.uri))),
    cache,
  ).pipe(Effect.timeoutOption(RECALL_RERANKER_WINDOW_WARM_MILLISECONDS), Effect.asVoid);
}

/** Refinement is optional: a failed read abandons it, so closing proves the baseline instead of an empty window. */
export function requireRecallRefinementRead<
  A extends {readonly operationalWarnings: readonly RecallOperationalWarning[]},
>(prepared: A) {
  const reason = recallReadFailureReason(prepared.operationalWarnings);
  return reason === undefined ? Effect.succeed(prepared) : Effect.fail(RecallReadyReadBoundaryError.make({reason}));
}

/**
 * Explicit app-owned canonical reader. Custom callback callers keep prepareRecallSections.
 * Every read, including refinement with parent model evidence, is one model-free sections read.
 */
export const readReadyRecallSections = Effect.fn('recall.readReadySections')(function* (
  config: RecallRuntimeConfig,
  input: ReadyRecallSectionsInput,
) {
  const invalid = () => RecallReadyReadBoundaryError.make({reason: 'invalid-protocol'});
  const {
    allowedSharedUriScopes,
    semanticResult,
    rerankerCache,
    closingCandidateUris,
    candidateUris,
    exact,
    fuseLocalMemories,
    ...fields
  } = input;
  const semantic = semanticToWire(Option.getOrElse(semanticResult ?? Option.none(), emptyRecallSemanticScoresResult));
  const rerankerScores = readyRecallRerankerScores({rerankerCache});
  const options =
    closingCandidateUris === undefined
      ? {
          ...fields,
          mode: 'baseline',
          exact,
          candidateUris,
          // Only completed parent evidence crosses, so an initial baseline stays evidence-free.
          ...(semantic.scores === undefined && semantic.warning === undefined ? {} : {semantic}),
          ...(rerankerScores.length === 0 ? {} : {rerankerScores}),
        }
      : {
          ...fields,
          mode: 'closing',
          allowedSharedUriScopes,
          candidateUris: closingCandidateUris,
          fuseLocalMemories,
          semantic,
          rerankerScores,
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
    // Native responses were already parsed from JSON by the owned boundary.
    // Direct serving still normalizes optional own-undefined fields before strict decoding.
    return yield* decodeRecallReadySectionsResult(
      Option.isNone(boundary) ? JSON.parse(JSON.stringify(value)) : value,
    ).pipe(Effect.mapError(invalid));
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
            fused: undefined,
            semanticPreflight: undefined,
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

/** A failed closing proof cannot publish an earlier candidate snapshot. */
export function finalizeReadyRecallClosing(sections: Effect.Success<ReturnType<typeof readReadyRecallSections>>) {
  if (recallReadPhaseOutcome(sections.operationalWarnings) === 'success') return sections;
  return {
    ...sections,
    fused: undefined,
    confidence: undefined,
    ranked: [],
    expansionCandidates: [],
    semanticSection: undefined,
    exactTail: undefined,
    memoryConnections: undefined,
  };
}
