import {Array as EffectArray, Effect, Option, Record as EffectRecord, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {assertMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {CodeGraphProjectCoverageSchema} from '@threadnote/graph/types';
import {CodeGraphScopeRoutingError} from '@threadnote/graph/scope/routing';
import {CommandCleanupUnconfirmed, CommandExecutor, CommandTimedOut} from '@threadnote/platform/command';
import {isJsonObject} from '@threadnote/platform/json';
import {ReadDeadlineExceeded, readDeadlineRemaining, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {Evidence, FileUri, Position} from '@threadnote/semantic/contracts';
import type {SemanticContextSourceBindingV1, SemanticContextSymbolTarget} from '@threadnote/context/types';
import {unavailableContextBriefCodeLinkedMemoryEvidence} from '@threadnote/context/memory-evidence';
import {
  parseVerifiedProcedureEvidenceList,
  type VerifiedProcedureEvidence,
} from '@threadnote/context/procedure/selection';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ContextBriefRuntimeCompilerSources} from './index.js';
import {ReadyRecallReadWorkerAdmission} from '../recall/ready_read_boundary.js';

import {CONTEXT_BRIEF_NATIVE_READ_WORKER_ARGUMENT} from '../worker_protocol.js';
export const CONTEXT_BRIEF_NATIVE_READ_INPUT_BYTES = 2 * 1024 * 1024;
export const CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES = 2 * 1024 * 1024;
const CLEANUP_AND_DECODE_RESERVE_MILLISECONDS = 1_100;
const text = Schema.String.check(Schema.isMaxLength(64 * 1024));
const shortText = Schema.String.check(Schema.isMaxLength(4096));
const count = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1_000_000}));
const optional = Schema.optionalKey;
const strings = Schema.Array(text).check(Schema.isMaxLength(512));
const mode = Schema.Literals(['brief', 'locate', 'explain', 'trace', 'impact', 'resume']);
const scope = Schema.Union([
  Schema.Struct({kind: Schema.Literal('repository'), callerCwd: shortText, project: optional(shortText)}),
  Schema.Struct({kind: Schema.Literal('workset'), name: shortText, project: optional(shortText)}),
]);
const runtimeConfigSchema = Schema.Struct({
  account: shortText,
  agentContextHome: shortText,
  agentId: shortText,
  manifestPath: shortText,
  user: shortText,
  agentIdSource: optional(
    Schema.Literals([
      'codex-cloud-command',
      'codex-cloud-profile',
      'cursor-cloud-command',
      'cursor-cloud-profile',
      'environment',
      'system',
    ]),
  ),
  userSource: optional(
    Schema.Literals([
      'codex-cloud-command',
      'codex-cloud-profile',
      'cursor-cloud-command',
      'cursor-cloud-profile',
      'environment',
      'system',
    ]),
  ),
  manifestSource: optional(Schema.Literals(['bundled-example', 'configured', 'user'])),
});
const fence = Schema.Union([
  Schema.Struct({kind: Schema.Literal('repository'), repositoryId: shortText, snapshotId: shortText}),
  Schema.Struct({
    kind: Schema.Literal('workset'),
    workset: shortText,
    generation: Schema.Struct({digest: shortText, id: shortText}),
  }),
]);
const citation = Schema.declare<MemoryCodeCitationV1>((value): value is MemoryCodeCitationV1 => {
  try {
    assertMemoryCodeCitation(value);
    return true;
  } catch {
    return false;
  }
});
const actionCard = Schema.Struct({appliesTo: text, invariant: text, avoid: optional(text), verify: optional(text)});
const continuationCard = Schema.Struct({
  anchors: optional(text),
  attempted: optional(text),
  avoidRepeat: optional(text),
  blockers: optional(text),
  decisions: optional(text),
  graphQuery: optional(text),
  graphQuestion: optional(text),
  observations: optional(text),
  invariants: optional(text),
  nextStep: optional(text),
  rationale: optional(text),
  risks: optional(text),
  task: optional(text),
  unresolved: optional(text),
  verification: optional(text),
});
const authority = Schema.Literals([
  'agent_generated',
  'canonical_repo',
  'external',
  'reviewed_shared',
  'user_approved',
]);
const memoryTrust = Schema.Literals(['approved', 'inferred', 'untrusted']);
const candidate = Schema.Struct({
  actionCard: optional(actionCard),
  continuationCard: optional(continuationCard),
  authority: optional(authority),
  codeCitations: Schema.Array(citation).check(Schema.isMaxLength(8)),
  codeLinkMatches: optional(
    Schema.Array(
      Schema.Struct({
        anchorNodeId: optional(shortText),
        anchorOrdinal: count,
        anchorPath: shortText,
        citationId: shortText,
        matchKind: Schema.Literals(['file-content', 'file-path', 'symbol-locator', 'symbol-node']),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
  lexicallySelected: optional(Schema.Literal(true)),
  citationErrorCount: count,
  topicMaintenance: optional(
    Schema.Struct({
      coverage: Schema.Literal('declared-only'),
      excerptOrdinal: count,
      excerptRole: Schema.Literals(['descriptive', 'normative', 'historical']),
      historicalParagraphs: count,
      normativeParagraphs: count,
      unresolvedParagraphs: count,
      attention: Schema.Literals(['none', 'pending-review', 'review-unavailable']),
      reviewId: optional(shortText),
    }),
  ),
  topicMaintenanceInvalid: optional(Schema.Literal(true)),
  excerpt: text,
  kind: Schema.Literals(['durable', 'handoff']),
  memoryId: optional(shortText),
  project: optional(shortText),
  rank: count,
  sourceCommit: optional(shortText),
  topic: optional(shortText),
  trust: optional(memoryTrust),
  uri: text,
});
const candidates = Schema.Array(candidate).check(Schema.isMaxLength(128));
const graphPlan = Schema.Struct({
  codeRefs: Schema.Array(shortText).check(Schema.isMaxLength(8)),
  detail: Schema.Literals(['compact', 'source']),
  edgeLimit: count,
  evidenceCards: count,
  maximumEstimatedTokens: count,
  mode,
  nodeLimit: count,
  query: text,
  scope,
  sourceMaximumBytes: count,
});
const linkedPlan = Schema.Struct({
  candidateLimit: count,
  codeRefs: Schema.Array(shortText).check(Schema.isMaxLength(8)),
  project: optional(shortText),
  query: text,
  scope,
});
const counters = Schema.Struct({
  remaining: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 64})),
  primaryRemaining: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 64})),
});
const semanticRange = Schema.Struct({start: Position, end: Position});
const semanticTarget = Schema.Struct({
  evidence: Evidence,
  uri: FileUri,
  range: semanticRange,
  selectionRange: optional(semanticRange),
});
const semanticBinding = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.Literal('document'),
  observation: shortText,
  semanticContent: shortText,
  graph: Schema.Struct({repositoryId: shortText, snapshotId: shortText, path: shortText, contentHash: shortText}),
});
const semanticState = Schema.Struct({
  binding: Schema.NullOr(semanticBinding),
  repositoryIdentityKind: Schema.NullOr(Schema.Literals(['local', 'remote'])),
  selection: Schema.Struct({nodeId: Schema.NullOr(shortText), gap: optional(shortText)}),
});
export interface ContextBriefNativeSemanticState {
  binding: SemanticContextSourceBindingV1 | null;
  repositoryIdentityKind: 'local' | 'remote' | null;
  selection: {readonly nodeId: string | null; readonly gap?: string};
}
export interface ContextBriefNativeSemanticRead {
  readonly evidence: Evidence;
  readonly target: SemanticContextSymbolTarget | null;
  readonly state: ContextBriefNativeSemanticState;
}
const sharedRequest = {
  protocol: Schema.Literal(1),
  config: runtimeConfigSchema,
  // Relative allowance only; the parent's immutable clock and watchdog remain authoritative.
  remainingMilliseconds: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 5000})),
};

const span = Schema.Struct({column: count, endColumn: count, endLine: count, line: count});
const graphCard = Schema.Struct({
  id: shortText,
  rank: count,
  reason: text,
  ref: shortText,
  repositoryKey: shortText,
  symbol: Schema.Struct({
    kind: shortText,
    language: shortText,
    line: count,
    name: text,
    packageName: optional(shortText),
    path: shortText,
    qualifiedName: text,
  }),
});
const graphContract = Schema.Struct({
  authority: Schema.Literals(['authoritative', 'supporting']),
  evidence: Schema.Struct({
    line: count,
    path: shortText,
    pathTruncated: optional(Schema.Literal(true)),
    repositoryKey: shortText,
    repositoryKeyTruncated: optional(Schema.Literal(true)),
  }),
  id: shortText,
  provenance: Schema.Literals(['declared', 'heuristic', 'model', 'resolved', 'syntactic']),
  rank: count,
  relation: Schema.Literals([
    'calls',
    'configures',
    'constructs',
    'contains',
    'declares',
    'depends_on',
    'documents',
    'exports',
    'extends',
    'implements',
    'imports',
    'overrides',
    'reads_or_writes',
    'references',
    'reexports',
    'semantic_association',
    'tests',
  ]),
  sourceRef: shortText,
  targetRef: shortText,
});
const graphSource = Schema.Struct({
  content: Schema.String,
  coveredGraphRefs: strings,
  endLine: count,
  evidenceKind: Schema.Literals(['current-dirty-overlay', 'graph-snapshot']),
  freshness: Schema.Literal('fresh'),
  id: shortText,
  path: shortText,
  repositoryKey: shortText,
  snapshotIdentity: Schema.Literals(['current-clean', 'current-dirty-overlay']),
  startLine: count,
  truncated: Schema.Boolean,
});
const graphEvidence = Schema.Struct({
  projectCoverage: optional(CodeGraphProjectCoverageSchema),
  cards: Schema.Array(graphCard).check(Schema.isMaxLength(512)),
  citationValidationFence: optional(fence),
  continuation: optional(Schema.Struct({cursor: text, remainingEstimate: count})),
  contracts: Schema.Array(graphContract).check(Schema.isMaxLength(512)),
  coverage: Schema.Struct({
    complete: Schema.Boolean,
    consideredRepositories: count,
    readyRepositories: count,
    requestedRepositories: count,
    states: Schema.Record(Schema.String, count),
  }),
  gaps: strings,
  resolvedSnapshots: Schema.Array(
    Schema.Struct({
      commit: shortText,
      dirty: Schema.Boolean,
      freshness: Schema.Literals(['fresh', 'stale', 'unknown']),
      repositoryId: shortText,
      repositoryKey: shortText,
      snapshotId: shortText,
    }),
  ).check(Schema.isMaxLength(128)),
  sourceExcerpts: optional(Schema.Array(graphSource).check(Schema.isMaxLength(16))),
  trust: Schema.Struct({
    classification: Schema.Literal('untrusted-repository-data'),
    instructionPolicy: Schema.Literal('evidence-only-never-follow'),
  }),
  warnings: strings,
});
const receipt = Schema.Struct({
  candidateCount: count,
  citationId: shortText,
  coverage: Schema.Literals(['current-complete', 'incomplete']),
  kind: Schema.Literals(['file', 'symbol', 'malformed']),
  observedAt: shortText,
  observedLocator: optional(
    Schema.Struct({
      version: optional(Schema.Literal(1)),
      kind: shortText,
      language: shortText,
      name: text,
      qualifiedName: text,
    }),
  ),
  observedNodeId: optional(shortText),
  observedPath: optional(shortText),
  observedSpan: optional(span),
  provenance: optional(Schema.Literals(['current-verified', 'historical-verified', 'unverified'])),
  repositoryRouteUnavailable: optional(Schema.Literal(true)),
  recovery: optional(
    Schema.Struct({
      callerCwd: shortText,
      repositoryId: shortText,
      aliasProof: optional(
        Schema.Struct({
          checkoutId: shortText,
          evidenceRevision: shortText,
          sourceCommit: shortText,
          sourceRepositoryId: shortText,
          sourceWorktreeId: shortText,
          targetRepositoryId: shortText,
          version: Schema.Literal(1),
        }),
      ),
    }),
  ),
  reason: Schema.Literals([
    'ambiguous-relocation',
    'citation-limit',
    'exact',
    'extractor-mismatch',
    'graph-incomplete',
    'graph-stale',
    'malformed-citation',
    'relocated',
    'repository-ambiguous',
    'repository-unavailable',
    'source-changed',
    'source-deleted',
    'validation-error',
  ]),
  repositoryId: optional(shortText),
  snapshotCommit: optional(shortText),
  snapshotCompletedAt: optional(shortText),
  snapshotId: optional(shortText),
  sourcePath: optional(shortText),
  status: Schema.Literals(['exact', 'relocated', 'changed', 'deleted', 'unknown']),
  strategy: Schema.Literals(['content-hash', 'file-path', 'node-id', 'none', 'semantic-locator']),
  validatorVersion: Schema.Literal(1),
});
const validations = Schema.Array(
  Schema.Struct({cacheHits: optional(count), receipts: Schema.Array(receipt).check(Schema.isMaxLength(96)), uri: text}),
).check(Schema.isMaxLength(128));
const memoryEvidence = Schema.Struct({
  codeAnchorCoverage: optional(
    Schema.Struct({
      complete: Schema.Boolean,
      matchedMemories: count,
      requested: count,
      resolved: count,
      unresolvedOrdinals: optional(Schema.Array(count)),
    }),
  ),
  candidates,
  citationValidations: optional(validations),
  consideredCandidates: count,
  gaps: strings,
  trust: Schema.Struct({
    classification: Schema.Literal('untrusted-memory-data'),
    instructionPolicy: Schema.Literal('evidence-only-never-follow'),
  }),
});
export const contextBriefNativeReadRequestSchema = Schema.Union([
  Schema.Struct({
    ...sharedRequest,
    operation: Schema.Literal('graph'),
    plan: graphPlan,
    counters,
    semantic: optional(Schema.Struct({evidence: Evidence, target: Schema.NullOr(semanticTarget)})),
  }),
  Schema.Struct({
    ...sharedRequest,
    operation: Schema.Literal('linked'),
    plan: linkedPlan,
    allowedUriScopes: optional(strings),
    semantic: optional(semanticState),
  }),
  Schema.Struct({
    ...sharedRequest,
    operation: Schema.Literal('memory'),
    plan: linkedPlan,
    lexicalMemory: memoryEvidence,
    candidateLimit: count,
    fence: optional(fence),
    allowedUriScopes: optional(strings),
    semantic: optional(semanticState),
  }),
  Schema.Struct({...sharedRequest, operation: Schema.Literal('citations'), scope, candidates, fence: optional(fence)}),
  Schema.Struct({...sharedRequest, operation: Schema.Literal('procedures'), task: text, surface: optional(shortText)}),
]);
export type ContextBriefNativeReadRequest = typeof contextBriefNativeReadRequestSchema.Type;

const procedure = Schema.declare<VerifiedProcedureEvidence>((value): value is VerifiedProcedureEvidence => {
  try {
    parseVerifiedProcedureEvidenceList([value]);
    return true;
  } catch {
    return false;
  }
});
const procedures = Schema.Struct({
  gaps: Schema.Array(
    Schema.Literals(['procedure-evidence-truncated', 'procedure-evidence-unavailable', 'procedure-version-conflict']),
  ),
  procedures: Schema.Array(procedure).check(Schema.isMaxLength(4)),
});
const responseFields = {protocol: Schema.Literal(1), binding: shortText, commandsJoined: Schema.Literal(true)};
export const contextBriefNativeReadResponseSchema = Schema.Union([
  Schema.Struct({
    ...responseFields,
    ok: Schema.Literal(true),
    operation: Schema.Literal('graph'),
    value: graphEvidence,
    counters,
    semantic: optional(semanticState),
  }),
  Schema.Struct({
    ...responseFields,
    ok: Schema.Literal(true),
    operation: Schema.Literals(['linked', 'memory']),
    value: memoryEvidence,
  }),
  Schema.Struct({
    ...responseFields,
    ok: Schema.Literal(true),
    operation: Schema.Literal('citations'),
    value: validations,
  }),
  Schema.Struct({
    ...responseFields,
    ok: Schema.Literal(true),
    operation: Schema.Literal('procedures'),
    value: procedures,
  }),
  Schema.Struct({
    ...responseFields,
    ok: Schema.Literal(false),
    operation: Schema.Literals(['graph', 'linked', 'memory', 'citations', 'procedures']),
    failure: Schema.Literals(['budget-exhausted', 'worker-failed']),
    routing: optional(
      Schema.Struct({
        message: text,
        projects: optional(Schema.Array(Schema.Struct({name: shortText, roots: strings}))),
      }),
    ),
  }),
]);
export type ContextBriefNativeReadResponse = typeof contextBriefNativeReadResponseSchema.Type;

export class ContextBriefNativeReadFailed extends Schema.TaggedError<
  ContextBriefNativeReadFailed,
  {readonly brand: unique symbol}
>()('ContextBriefNativeReadFailed', {
  reason: Schema.Literals(['invalid-protocol', 'worker-failed', 'cleanup-unconfirmed']),
}) {}

export function contextBriefNativeReadBinding(request: ContextBriefNativeReadRequest): string {
  return sha256HexSync(
    JSON.stringify(Schema.encodeSync(contextBriefNativeReadRequestSchema)(request), (_key, value: unknown) =>
      isJsonObject(value)
        ? EffectRecord.fromEntries(
            EffectRecord.toEntries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          )
        : value,
    ),
  );
}

/** Parent-owned execution only. Missing budget never creates a fresh five second window. */
const makeNativeReadExecutor = Effect.fn('contextBrief.makeNativeReadExecutor')(function* () {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const name = EffectString.toLowerCase(
    EffectString.split('/')(EffectString.replaceAll('\\', '/')(system.executablePath)).at(-1) ?? '',
  );
  const args = [
    ...(name === 'bun' || name === 'bun.exe' ? [system.developmentEntrypoint] : []),
    CONTEXT_BRIEF_NATIVE_READ_WORKER_ARGUMENT,
  ];
  return (request: ContextBriefNativeReadRequest, deadline: ReadDeadline) =>
    Effect.gen(function* () {
      const input = yield* Effect.try({
        try: () => new TextEncoder().encode(JSON.stringify(request)),
        catch: () => ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'}),
      });
      if (input.byteLength > CONTEXT_BRIEF_NATIVE_READ_INPUT_BYTES)
        return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
      const timeoutMs = yield* readDeadlineRemaining(deadline, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS);
      if (timeoutMs <= 0) return yield* ReadDeadlineExceeded.make({});
      const result = yield* command
        .execute(system.executablePath, args, {
          env: {...system.environment(), THREADNOTE_HOME: request.config.agentContextHome},
          input,
          maxOutputBytes: CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES,
          timeoutMs,
          forceKillAfterMilliseconds: 0,
          sensitiveOutput: true,
          verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
        })
        .pipe(
          Effect.mapError(error =>
            Schema.is(CommandCleanupUnconfirmed)(error)
              ? ContextBriefNativeReadFailed.make({reason: 'cleanup-unconfirmed'})
              : Schema.is(CommandTimedOut)(error)
                ? ReadDeadlineExceeded.make({})
                : ContextBriefNativeReadFailed.make({
                    reason: system.platform === 'win32' ? 'cleanup-unconfirmed' : 'worker-failed',
                  }),
          ),
        );
      const response = yield* Schema.decodeEffect(Schema.fromJsonString(contextBriefNativeReadResponseSchema), {
        onExcessProperty: 'error',
      })(result.stdout).pipe(
        Effect.mapError(() =>
          ContextBriefNativeReadFailed.make({
            reason: system.platform === 'win32' ? 'cleanup-unconfirmed' : 'invalid-protocol',
          }),
        ),
      );
      if (response.binding !== contextBriefNativeReadBinding(request) || response.operation !== request.operation)
        return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
      if ((yield* readDeadlineRemaining(deadline)) <= 0) return yield* ReadDeadlineExceeded.make({});
      if (!response.ok) {
        if (response.failure === 'budget-exhausted') return yield* ReadDeadlineExceeded.make({});
        if (response.routing !== undefined) return yield* CodeGraphScopeRoutingError.make(response.routing);
        return yield* ContextBriefNativeReadFailed.make({reason: 'worker-failed'});
      }
      return response;
    });
});

const requireRemaining = Effect.fn('contextBrief.requireNativeRemaining')(function* (deadline?: ReadDeadline) {
  if (deadline === undefined) return yield* ReadDeadlineExceeded.make({});
  const remainingMilliseconds = yield* readDeadlineRemaining(deadline, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS);
  if (remainingMilliseconds <= 0) return yield* ReadDeadlineExceeded.make({});
  return {deadline, remainingMilliseconds: Math.min(5000, remainingMilliseconds)};
});

/** The normal compiler stays in the parent, preserving completed lexical memory on graph failure. */
export const withNativeContextBriefReadSources = Effect.fn('contextBrief.withNativeReadSources')(function* <
  GraphR,
  MemoryR,
  CitationR,
  ProjectR,
>(
  config: RuntimeConfig,
  sources: ContextBriefRuntimeCompilerSources<GraphR, MemoryR, CitationR, ProjectR>,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly includeProcedureEvidence?: boolean;
    readonly semantic?: ContextBriefNativeSemanticRead;
  } = {},
) {
  if (Option.isNone(yield* Effect.serviceOption(ReadyRecallReadWorkerAdmission))) return sources;
  const execute = yield* makeNativeReadExecutor();
  const safeConfig = yield* Schema.decodeEffect(runtimeConfigSchema)(config);
  return {
    ...sources,
    graphEvidence: (plan, budget) =>
      Effect.gen(function* () {
        const remaining = yield* requireRemaining(budget?.deadline);
        const admittedCounters = {remaining: budget?.remaining ?? 2, primaryRemaining: budget?.primaryRemaining ?? 17};
        if (admittedCounters.primaryRemaining <= 0) return yield* ReadDeadlineExceeded.make({});
        const request: ContextBriefNativeReadRequest = {
          protocol: 1,
          config: safeConfig,
          operation: 'graph',
          plan,
          counters: admittedCounters,
          ...(options.semantic === undefined
            ? {}
            : {semantic: {evidence: options.semantic.evidence, target: options.semantic.target}}),
          remainingMilliseconds: remaining.remainingMilliseconds,
        };
        // A lost response cannot prove which traversals completed. Reserve the
        // remaining count allowance until a joined worker returns its counters.
        if (budget) {
          budget.remaining = 0;
          budget.primaryRemaining = 0;
        }
        if (options.semantic) {
          options.semantic.state.binding = null;
          options.semantic.state.repositoryIdentityKind = null;
          options.semantic.state.selection = {nodeId: null, gap: 'semantic-symbol-target-unavailable'};
        }
        const response = yield* execute(request, remaining.deadline);
        if (response.operation !== 'graph')
          return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
        if (options.semantic) {
          if (!response.semantic) return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
          options.semantic.state.binding = response.semantic.binding;
          options.semantic.state.repositoryIdentityKind = response.semantic.repositoryIdentityKind;
          options.semantic.state.selection = response.semantic.selection;
        }
        if (budget) {
          budget.remaining = Math.min(admittedCounters.remaining, response.counters.remaining);
          budget.primaryRemaining = Math.min(admittedCounters.primaryRemaining, response.counters.primaryRemaining);
        }
        return response.value;
      }),
    ...(sources.codeLinkedMemoryEvidence === undefined
      ? {}
      : {
          codeLinkedMemoryEvidence: (plan, deadline) =>
            Effect.gen(function* () {
              const semantic = options.semantic?.state;
              if (semantic && (!semantic.selection.nodeId || !semantic.binding || !semantic.repositoryIdentityKind))
                return unavailableContextBriefCodeLinkedMemoryEvidence(
                  1,
                  semantic.selection.gap ?? 'semantic-symbol-target-unavailable',
                );
              const remaining = yield* requireRemaining(deadline);
              const response = yield* execute(
                {
                  protocol: 1,
                  config: safeConfig,
                  operation: 'linked',
                  plan,
                  ...(options.allowedUriScopes === undefined ? {} : {allowedUriScopes: options.allowedUriScopes}),
                  ...(semantic === undefined ? {} : {semantic}),
                  remainingMilliseconds: remaining.remainingMilliseconds,
                },
                remaining.deadline,
              );
              if (response.operation !== 'linked')
                return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
              return response.value;
            }),
        }),
    memoryEvidenceAfterGraph: (plan, lexicalMemory, fence, deadline) =>
      Effect.gen(function* () {
        const remaining = yield* requireRemaining(deadline);
        const response = yield* execute(
          {
            protocol: 1,
            config: safeConfig,
            operation: 'memory',
            plan: plan.codeAnchors,
            lexicalMemory,
            candidateLimit: plan.memory.candidateLimit,
            ...(fence === undefined ? {} : {fence}),
            ...(options.allowedUriScopes === undefined ? {} : {allowedUriScopes: options.allowedUriScopes}),
            ...(options.semantic === undefined ? {} : {semantic: options.semantic.state}),
            remainingMilliseconds: remaining.remainingMilliseconds,
          },
          remaining.deadline,
        );
        if (response.operation !== 'memory')
          return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
        return response.value;
      }),
    citationValidation: (scope, candidates, fence, deadline) =>
      Effect.gen(function* () {
        const remaining = yield* requireRemaining(deadline);
        if (EffectArray.every(candidates, candidate => candidate.codeCitations.length === 0)) return [];
        const response = yield* execute(
          {
            protocol: 1,
            config: safeConfig,
            operation: 'citations',
            scope,
            candidates,
            ...(fence === undefined ? {} : {fence}),
            remainingMilliseconds: remaining.remainingMilliseconds,
          },
          remaining.deadline,
        );
        if (response.operation !== 'citations')
          return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
        return response.value;
      }),
    ...(sources.procedureEvidence === undefined || options.includeProcedureEvidence === false
      ? {}
      : {
          procedureEvidence: (plan, deadline) =>
            Effect.gen(function* () {
              const remaining = yield* requireRemaining(deadline);
              const response = yield* execute(
                {
                  protocol: 1,
                  config: safeConfig,
                  operation: 'procedures',
                  task: plan.task,
                  ...(plan.surface === undefined ? {} : {surface: plan.surface}),
                  remainingMilliseconds: remaining.remainingMilliseconds,
                },
                remaining.deadline,
              );
              if (response.operation !== 'procedures')
                return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
              return response.value;
            }),
        }),
  } satisfies ContextBriefRuntimeCompilerSources<GraphR, MemoryR, CitationR, ProjectR>;
});
