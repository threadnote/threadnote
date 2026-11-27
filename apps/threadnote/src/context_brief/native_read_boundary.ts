import {
  Array as EffectArray,
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Record as EffectRecord,
  Schema,
  Scope,
} from 'effect';
import * as EffectString from 'effect/String';
import {assertMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {CodeGraphProjectCoverageSchema} from '@threadnote/graph/types';
import {CodeGraphScopeRoutingError} from '@threadnote/graph/scope/routing';
import {
  CommandCleanupUnconfirmed,
  CommandExecutor,
  CommandTimedOut,
  type CommandDeferredInput,
  type CommandExecutionError,
  type CommandResult,
} from '@threadnote/platform/command';
import {isJsonObject} from '@threadnote/platform/json';
import type {CodeGraphNavigationProof} from '@threadnote/graph/types';
import {NAVIGATION_INPUT_LIMITS, NAVIGATION_ROLES} from '@threadnote/context/navigation/model';
import {NAVIGATION_CONTINUATION_LOCATORS} from '@threadnote/context/navigation/continuation';
import {
  ReadDeadlineExceeded,
  hasReadCleanupUnconfirmed,
  readDeadlineRemaining,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {Evidence, FileUri, Position} from '@threadnote/semantic/contracts';
import {
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  type SemanticContextSourceBindingV1,
  type SemanticContextSymbolTarget,
} from '@threadnote/context/types';
import {unavailableContextBriefCodeLinkedMemoryEvidence} from '@threadnote/context/memory-evidence';
import {
  parseVerifiedProcedureEvidenceList,
  type VerifiedProcedureEvidence,
} from '@threadnote/context/procedure/selection';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ContextBriefRuntimeCompilerSources} from './index.js';
import {
  admitNavigationRead,
  NAVIGATION_SEMANTIC_ANCHORS,
  navigationReadContainsCwd,
} from '@threadnote/context/navigation/read';
import {ReadyRecallReadWorkerAdmission} from '../recall/ready_read_boundary.js';

import {CONTEXT_BRIEF_NATIVE_READ_WORKER_ARGUMENT} from '../worker_protocol.js';
export const CONTEXT_BRIEF_NATIVE_READ_INPUT_BYTES = 2 * 1024 * 1024;
export const CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES = 2 * 1024 * 1024;
const CLEANUP_AND_DECODE_RESERVE_MILLISECONDS = 1_100;
/** An unused prestarted worker stops after this; its request deadline, not this, bounds a request. */
const PRESTARTED_WORKER_IDLE_MILLISECONDS = 30_000;
/** The graph status and attach reads completed. */
export const CONTEXT_BRIEF_NATIVE_READ_STATUS_PROGRESS = JSON.stringify({protocol: 1, progress: 'status-observed'});
const scopedReadyPrefix = 'scoped-ready:';
const scopedReadyEnd = 'scoped-ready-complete';
const scopedReadyOutputBytes = CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES / 2;
const text = Schema.String.check(Schema.isMaxLength(64 * 1024));
const shortText = Schema.String.check(Schema.isMaxLength(4096));
const count = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1_000_000}));
const optional = Schema.optionalKey;
const strings = Schema.Array(text).check(Schema.isMaxLength(512));
const mode = Schema.Literals(['brief', 'locate', 'explain', 'trace', 'impact', 'resume']);
const graphRelation = Schema.Literals([
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
]);
const repositoryScope = Schema.Struct({
  kind: Schema.Literal('repository'),
  callerCwd: shortText,
  project: optional(shortText),
});
const scope = Schema.Union([
  repositoryScope,
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
  relation: graphRelation,
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
const scopedReadyProgress = Schema.Struct({
  binding: shortText,
  value: graphEvidence,
});
const decodeScopedReadyProgress = Schema.decodeUnknownOption(Schema.fromJsonString(scopedReadyProgress), {
  onExcessProperty: 'error',
});

export function encodeContextBriefScopedReadyProgress(
  request: ContextBriefNativeReadRequest,
  value: typeof graphEvidence.Type,
): Uint8Array | undefined {
  const payload = JSON.stringify({binding: contextBriefNativeReadBinding(request), value});
  // The command observer only forwards complete, bounded lines. Split between code points.
  const chunks = Option.getOrElse(EffectString.match(/[\s\S]{1,1000}/gu)(payload), () => []);
  const output = new TextEncoder().encode(
    `${EffectArray.join(
      EffectArray.map(chunks, chunk => scopedReadyPrefix + chunk),
      '\n',
    )}\n${scopedReadyEnd}\n`,
  );
  return output.byteLength <= scopedReadyOutputBytes ? output : undefined;
}

function observeScopedReadyProgress(request: ContextBriefNativeReadRequest, onStatusObserved: () => void) {
  const chunks: string[] = [];
  let size = 0;
  let unavailable = false;
  let completed = false;
  return {
    line(line: string) {
      if (line === CONTEXT_BRIEF_NATIVE_READ_STATUS_PROGRESS) {
        onStatusObserved();
        unavailable = true;
      }
      if (unavailable) return;
      if (line === scopedReadyEnd && !completed) {
        completed = true;
      } else if (EffectString.startsWith(scopedReadyPrefix)(line) && !completed) {
        size += new TextEncoder().encode(line).byteLength + 1;
        if (size <= scopedReadyOutputBytes) chunks.push(EffectString.slice(scopedReadyPrefix.length)(line));
        else unavailable = true;
      } else if (!completed || line === scopedReadyEnd || EffectString.startsWith(scopedReadyPrefix)(line)) {
        unavailable = true;
      }
    },
    evidence() {
      if (unavailable || !completed || request.operation !== 'graph' || request.plan.scope.kind !== 'repository')
        return undefined;
      const decoded = Option.getOrUndefined(decodeScopedReadyProgress(EffectArray.join(chunks, '')));
      const value = decoded?.value;
      if (
        decoded?.binding !== contextBriefNativeReadBinding(request) ||
        value === undefined ||
        value.cards.length === 0 ||
        value.citationValidationFence !== undefined ||
        value.sourceExcerpts !== undefined ||
        value.resolvedSnapshots.length !== 1 ||
        value.resolvedSnapshots[0]?.freshness !== 'stale' ||
        value.coverage.complete ||
        value.coverage.readyRepositories !== 1 ||
        value.coverage.states.stale !== 1 ||
        value.projectCoverage?.kind !== 'project' ||
        value.projectCoverage.completeness !== 'partial' ||
        value.projectCoverage.negativeProof !== 'unavailable'
      )
        return undefined;
      return value;
    },
  };
}
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
    'extraction-unavailable',
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
const navigationLimits = NAVIGATION_INPUT_LIMITS;
const navigationScope = Schema.Struct({
  repository: shortText,
  worktree: shortText,
  project: shortText,
  view: Schema.Struct({
    kind: Schema.Literals(['disk', 'overlay', 'editor']),
    id: shortText,
    owner: shortText,
    epoch: count,
  }),
});
const navigationBasis = Schema.Literals([
  'qualified-semantic',
  'structural',
  'inspected-source',
  'inference',
  'memory',
]);
const navigationRole = Schema.Literals(NAVIGATION_ROLES);
const navigationInput = Schema.Struct({
  scope: navigationScope,
  target: Schema.Union([
    Schema.Struct({kind: Schema.Literal('task')}),
    Schema.Struct({
      kind: Schema.Literals(['anchors', 'ambiguous']),
      candidateIds: Schema.Array(shortText).check(Schema.isMaxLength(navigationLimits.anchors)),
    }),
  ]),
  candidates: Schema.Array(
    Schema.Struct({
      id: shortText,
      sourceId: shortText,
      startLine: count,
      endLine: count,
      roles: Schema.Array(navigationRole).check(Schema.isMaxLength(NAVIGATION_ROLES.length)),
      reason: text,
      relevance: Schema.Finite,
      basis: Schema.Array(navigationBasis).check(Schema.isMaxLength(5)),
      support: Schema.Literals(['evidenced', 'candidate']),
      possibleEffect: optional(
        Schema.Struct({
          kind: Schema.Literals(['in-memory', 'durable-write', 'external']),
          target: text,
          condition: optional(text),
        }),
      ),
      testAssociation: optional(Schema.Literals(['source-supported', 'name-only'])),
    }),
  ).check(Schema.isMaxLength(navigationLimits.candidates)),
  sources: Schema.Array(
    Schema.Struct({
      ...navigationScope.fields,
      id: shortText,
      path: shortText,
      contentHash: shortText,
      freshness: Schema.Literals(['verified-current', 'stale', 'deferred', 'unverified']),
      snapshot: optional(shortText),
    }),
  ).check(Schema.isMaxLength(navigationLimits.sources)),
  links: Schema.Array(
    Schema.Struct({
      from: shortText,
      to: shortText,
      relation: graphRelation,
      basis: navigationBasis,
      compatibility: Schema.Literals(['verified', 'unknown', 'conflict']),
      reason: text,
    }),
  ).check(Schema.isMaxLength(navigationLimits.links)),
  coverage: Schema.Struct({
    status: Schema.Literals(['complete', 'partial', 'empty', 'unsupported', 'unavailable', 'timeout']),
    description: text,
  }),
  roleGaps: optional(
    Schema.Array(
      Schema.Struct({
        role: navigationRole,
        status: Schema.Literals(['unknown', 'unavailable', 'omitted', 'not-applicable']),
        reason: text,
        sourceProof: optional(
          Schema.Struct({sourceId: shortText, span: Schema.Struct({startLine: count, endLine: count})}),
        ),
      }),
    ).check(Schema.isMaxLength(2 * NAVIGATION_ROLES.length)),
  ),
  gaps: optional(Schema.Array(shortText).check(Schema.isMaxLength(navigationLimits.gaps))),
  followUps: optional(
    Schema.Array(
      Schema.Struct({kind: Schema.Literals(['read-source', 'query']), selector: shortText, reason: text}),
    ).check(Schema.isMaxLength(navigationLimits.followUps)),
  ),
});
/**
 * Proof shapes are checked here only as JSON objects. The parent admits them right after decode through
 * parseNavigationFacts (admitNavigationRead); nothing reads them before that admission.
 */
const navigationProof = Schema.declare<CodeGraphNavigationProof>((value): value is CodeGraphNavigationProof =>
  isJsonObject(value),
);
const navigationSnapshot = Schema.Struct({
  commit: shortText,
  dirty: Schema.Boolean,
  id: shortText,
  worktreeId: shortText,
});
const navigationMemory = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ok'),
    memory: memoryEvidence,
    memoryProjects: optional(
      Schema.Union([
        Schema.Struct({mode: Schema.Literal('allow-projects-and-projectless'), projects: strings}),
        Schema.Struct({mode: Schema.Literals(['projectless-only', 'deny-all'])}),
      ]),
    ),
    observedAt: shortText,
  }),
  Schema.Struct({
    status: Schema.Literal('unavailable'),
    gaps: Schema.Array(shortText).check(Schema.isMaxLength(navigationLimits.gaps)),
  }),
]);
const navigationRead = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ok'),
    identity: Schema.Struct({
      branch: optional(shortText),
      caseMode: Schema.Literals(['insensitive', 'sensitive']),
      checkoutId: shortText,
      displayName: shortText,
      gitCommonDirectory: shortText,
      headCommit: shortText,
      objectFormat: Schema.Literals(['sha1', 'sha256']),
      remoteIdentity: optional(shortText),
      repoRoot: shortText,
      repositoryId: shortText,
      worktreeId: shortText,
    }),
    observation: Schema.Struct({
      repository: Schema.Struct({repositoryId: shortText, displayName: shortText}),
      snapshot: navigationSnapshot,
      freshness: Schema.Literals(['current', 'deferred', 'stale']),
    }),
    repositoryIdentityKind: Schema.Literals(['local', 'remote']),
    input: navigationInput,
    proofLocators: Schema.Array(
      Schema.Struct({
        scope: navigationScope,
        snapshot: navigationSnapshot,
        sourceId: shortText,
        accepted: Schema.Struct({
          path: shortText,
          contentHash: shortText,
          proof: navigationProof,
          basis: Schema.Literal('source-syntactic'),
        }),
        target: text,
        condition: text,
      }),
    ).check(Schema.isMaxLength(96)),
    proofContext: Schema.Struct({
      symbols: Schema.Array(
        Schema.Struct({id: shortText, kind: shortText, span, path: shortText, contentHash: shortText}),
      ).check(Schema.isMaxLength(navigationLimits.candidates)),
      edges: Schema.Array(
        Schema.Struct({id: shortText, sourceId: optional(shortText), relation: graphRelation, targetName: shortText}),
      ).check(Schema.isMaxLength(navigationLimits.links)),
    }),
    anchors: Schema.Array(
      Schema.Struct({candidateId: shortText, path: shortText, contentHash: shortText, name: shortText, span}),
    ).check(Schema.isMaxLength(NAVIGATION_SEMANTIC_ANCHORS)),
    memory: optional(navigationMemory),
  }),
  Schema.Struct({
    status: Schema.Literal('unavailable'),
    gaps: Schema.Array(shortText).check(Schema.isMaxLength(navigationLimits.gaps)),
  }),
]);
const navigationRequest = Schema.Struct({
  scope: repositoryScope,
  task: text,
  codeRefs: Schema.Array(shortText).check(Schema.isMaxLength(CONTEXT_BRIEF_MAXIMUM_CODE_REFS)),
  maximumEstimatedTokens: count,
  followUp: optional(
    Schema.Array(Schema.Struct({nodeId: shortText, path: shortText})).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(NAVIGATION_CONTINUATION_LOCATORS),
    ),
  ),
  semanticFloorAt: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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
  Schema.Struct({...sharedRequest, operation: Schema.Literal('navigation'), request: navigationRequest}),
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
    ok: Schema.Literal(true),
    operation: Schema.Literal('navigation'),
    value: navigationRead,
  }),
  Schema.Struct({
    ...responseFields,
    ok: Schema.Literal(false),
    operation: Schema.Literals(['graph', 'linked', 'memory', 'citations', 'procedures', 'navigation']),
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

/**
 * Parent-owned execution only. Missing budget never creates a fresh five second window. Each read starts one spare
 * single-use worker, so the next read's worker loads its code while this read runs (slow hosts spend seconds there).
 * The request deadline still starts at the request, and a process never serves two requests. The scope stops an
 * unused spare and checks the owned exit of every worker it started.
 */
const makeNativeReadExecutor = Effect.fn('contextBrief.makeNativeReadExecutor')(function* (
  home: string,
  eager = false,
  /** False for a caller with one read: a spare it would never use costs a process start. */
  prestartSpare = true,
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const scope = yield* Effect.scope;
  const name = EffectString.toLowerCase(
    EffectString.split('/')(EffectString.replaceAll('\\', '/')(system.executablePath)).at(-1) ?? '',
  );
  const args = [
    ...(name === 'bun' || name === 'bun.exe' ? [system.developmentEntrypoint] : []),
    CONTEXT_BRIEF_NATIVE_READ_WORKER_ARGUMENT,
  ];
  const started = new Set<Worker>();
  const prestart = Effect.gen(function* () {
    const deferred = yield* Deferred.make<CommandDeferredInput>();
    const lines: {sink?: (line: string) => void} = {};
    const fiber = yield* command
      .execute(system.executablePath, args, {
        env: {...system.environment(), THREADNOTE_HOME: home},
        deferredInput: deferred,
        maxOutputBytes: CONTEXT_BRIEF_NATIVE_READ_OUTPUT_BYTES,
        timeoutMs: PRESTARTED_WORKER_IDLE_MILLISECONDS,
        forceKillAfterMilliseconds: 0,
        sensitiveOutput: true,
        verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
        onStdoutLine: line => lines.sink?.(line),
      })
      .pipe(Effect.forkIn(scope));
    const worker = {deferred, fiber, lines};
    started.add(worker);
    return worker;
  });
  type Worker = {
    readonly deferred: Deferred.Deferred<CommandDeferredInput>;
    readonly fiber: Fiber.Fiber<CommandResult, CommandExecutionError>;
    readonly lines: {sink?: (line: string) => void};
  };
  // Stopping a worker still requires its confirmed owned exit. A worker stopped before its request started no Git
  // child, so on Windows only an unconfirmed exit, not every failure, is a cleanup failure here.
  const retire = (worker: Worker) =>
    Fiber.interrupt(worker.fiber).pipe(
      Effect.andThen(Fiber.await(worker.fiber)),
      Effect.flatMap(exit => {
        started.delete(worker);
        return Exit.isFailure(exit) && hasReadCleanupUnconfirmed(exit.cause)
          ? Effect.fail(ContextBriefNativeReadFailed.make({reason: 'cleanup-unconfirmed'}))
          : Effect.void;
      }),
    );
  // An eager executor starts its spare at once, so a caller can load it before the brief's deadline starts.
  let spare: Worker | undefined = eager ? yield* prestart : undefined;
  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => {
      spare = undefined;
      return Effect.forEach([...started], worker => Effect.result(retire(worker))).pipe(
        Effect.flatMap(results =>
          EffectArray.some(results, result => result._tag === 'Failure')
            ? Effect.die(ContextBriefNativeReadFailed.make({reason: 'cleanup-unconfirmed'}))
            : Effect.void,
        ),
      );
    }),
  );
  // Taking a worker and handing it the request cannot be interrupted; only the wait for its result can. An interrupted
  // read (its deadline) interrupts its worker and keeps that worker's cleanup failure.
  const run = (input: Uint8Array, timeoutMs: number, line?: (line: string) => void) =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        let worker = spare;
        spare = undefined;
        if (worker !== undefined && worker.fiber.pollUnsafe() !== undefined) {
          yield* retire(worker);
          worker = undefined;
        }
        worker ??= yield* prestart;
        if (prestartSpare && spare === undefined) {
          const next = yield* prestart;
          if (spare === undefined) spare = next;
        }
        worker.lines.sink = line;
        yield* Deferred.succeed(worker.deferred, {input, timeoutMs});
        const exit = yield* Effect.exit(restore(Fiber.join(worker.fiber)));
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
          yield* Fiber.interrupt(worker.fiber);
          const owned = yield* Fiber.await(worker.fiber);
          started.delete(worker);
          return yield* Effect.failCause(Exit.isFailure(owned) ? Cause.combine(exit.cause, owned.cause) : exit.cause);
        }
        started.delete(worker);
        return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
      }),
    );
  return (
    request: ContextBriefNativeReadRequest,
    deadline: ReadDeadline,
    progress?: {readonly line: (line: string) => void; readonly joinedDeadline: () => void},
  ) =>
    Effect.gen(function* () {
      const input = yield* Effect.try({
        try: () => new TextEncoder().encode(JSON.stringify(request)),
        catch: () => ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'}),
      });
      if (input.byteLength > CONTEXT_BRIEF_NATIVE_READ_INPUT_BYTES)
        return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
      if (request.config.agentContextHome !== home)
        return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
      const timeoutMs = yield* readDeadlineRemaining(deadline, CLEANUP_AND_DECODE_RESERVE_MILLISECONDS);
      if (timeoutMs <= 0) return yield* ReadDeadlineExceeded.make({});
      const result = yield* run(input, timeoutMs, progress?.line).pipe(
        Effect.mapError(error => {
          if (Schema.is(CommandCleanupUnconfirmed)(error))
            return ContextBriefNativeReadFailed.make({reason: 'cleanup-unconfirmed'});
          if (Schema.is(CommandTimedOut)(error)) {
            // A Windows watchdog confirms only the worker leader. Its Git descendants may still be running.
            if (system.platform !== 'win32') progress?.joinedDeadline();
            return ReadDeadlineExceeded.make({});
          }
          return ContextBriefNativeReadFailed.make({
            reason: system.platform === 'win32' ? 'cleanup-unconfirmed' : 'worker-failed',
          });
        }),
      );
      // A graph worker prints its progress line first; the response is always the last line.
      const final = EffectString.split('\n')(EffectString.trimEnd(result.stdout)).at(-1) ?? '';
      const response = yield* Schema.decodeEffect(Schema.fromJsonString(contextBriefNativeReadResponseSchema), {
        onExcessProperty: 'error',
      })(final).pipe(
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
        if (response.failure === 'budget-exhausted') {
          progress?.joinedDeadline();
          return yield* ReadDeadlineExceeded.make({});
        }
        if (response.routing !== undefined) return yield* CodeGraphScopeRoutingError.make(response.routing);
        return yield* ContextBriefNativeReadFailed.make({reason: 'worker-failed'});
      }
      return response;
    });
});

type NativeReadExecute = Effect.Success<ReturnType<typeof makeNativeReadExecutor>>;
/**
 * A native read executor that a caller started before the brief, in its own scope, for one agent home. A semantic
 * query starts it before its provider request, so the brief's first read finds a loaded worker.
 */
export class ContextBriefNativeReadWorkers extends Context.Service<
  ContextBriefNativeReadWorkers,
  {readonly home: string; readonly execute: NativeReadExecute}
>()('@threadnote/threadnote/context_brief/native_read_boundary/ContextBriefNativeReadWorkers') {}

/** Start one native read worker for `home` in the caller's scope; none without ready-read worker admission. */
export const prestartContextBriefNativeReadWorkers = Effect.fn('contextBrief.prestartNativeReadWorkers')(function* (
  home: string,
) {
  if (Option.isNone(yield* Effect.serviceOption(ReadyRecallReadWorkerAdmission))) return undefined;
  return ContextBriefNativeReadWorkers.of({home, execute: yield* makeNativeReadExecutor(home, true)});
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
  NavigationR = never,
>(
  config: RuntimeConfig,
  sources: ContextBriefRuntimeCompilerSources<GraphR, MemoryR, CitationR, ProjectR, NavigationR>,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly includeProcedureEvidence?: boolean;
    readonly semantic?: ContextBriefNativeSemanticRead;
    /** Only for a new executor; a shared prestarted executor keeps its own spare policy. */
    readonly prestartSpare?: boolean;
  } = {},
) {
  if (Option.isNone(yield* Effect.serviceOption(ReadyRecallReadWorkerAdmission))) return sources;
  const safeConfig = yield* Schema.decodeEffect(runtimeConfigSchema)(config);
  const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const shared = yield* Effect.serviceOption(ContextBriefNativeReadWorkers);
  const execute =
    Option.isSome(shared) && shared.value.home === safeConfig.agentContextHome
      ? shared.value.execute
      : yield* makeNativeReadExecutor(safeConfig.agentContextHome, false, options.prestartSpare);
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
        const progress = observeScopedReadyProgress(request, () => {
          if (budget) budget.statusObserved = true;
        });
        let joinedDeadline = false;
        const response = yield* execute(request, remaining.deadline, {
          line: progress.line,
          joinedDeadline: () => {
            joinedDeadline = true;
          },
        }).pipe(Effect.result);
        if (response._tag === 'Failure') {
          if (
            joinedDeadline &&
            Schema.is(ReadDeadlineExceeded)(response.failure) &&
            (yield* readDeadlineRemaining(remaining.deadline)) > 0
          ) {
            const ready = progress.evidence();
            if (ready !== undefined) return ready;
          }
          return yield* response.failure;
        }
        if (response.success.operation !== 'graph')
          return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
        if (options.semantic) {
          if (!response.success.semantic) return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
          options.semantic.state.binding = response.success.semantic.binding;
          options.semantic.state.repositoryIdentityKind = response.success.semantic.repositoryIdentityKind;
          options.semantic.state.selection = response.success.semantic.selection;
        }
        if (budget) {
          budget.remaining = Math.min(admittedCounters.remaining, response.success.counters.remaining);
          budget.primaryRemaining = Math.min(
            admittedCounters.primaryRemaining,
            response.success.counters.primaryRemaining,
          );
        }
        return response.success.value;
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
    ...(sources.navigationEvidence === undefined
      ? {}
      : {
          // The same executor serves the navigate lane, so take/spare/handoff and cleanup mapping are unchanged.
          navigationEvidence: (request, deadline) =>
            Effect.gen(function* () {
              const remaining = yield* requireRemaining(deadline);
              const response = yield* execute(
                {
                  protocol: 1,
                  config: safeConfig,
                  operation: 'navigation',
                  request,
                  remainingMilliseconds: remaining.remainingMilliseconds,
                },
                remaining.deadline,
              );
              if (response.operation !== 'navigation')
                return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
              const admitted = yield* Effect.try({
                try: () => admitNavigationRead(response.value),
                catch: () => ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'}),
              });
              // The semantic join uses identity.repoRoot, so the reported root must contain the request cwd.
              if (!(yield* navigationReadContainsCwd(admitted, request.scope.callerCwd).pipe(Effect.provide(files))))
                return yield* ContextBriefNativeReadFailed.make({reason: 'invalid-protocol'});
              return admitted;
            }),
        }),
  } satisfies ContextBriefRuntimeCompilerSources<GraphR, MemoryR, CitationR, ProjectR, NavigationR>;
});
