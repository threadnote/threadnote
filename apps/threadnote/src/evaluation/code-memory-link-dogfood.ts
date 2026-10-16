import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeMemoryLinkAgentAbManifestV1} from './code-memory-link-agent-ab.js';
import {
  assertUniqueCodeMemoryLinkAttestations,
  createCodeMemoryLinkInvocationAttestationV1,
  parseCodeMemoryLinkInvocationAttestationV1,
  type CodeMemoryLinkInvocationAttestationV1,
  type CodeMemoryLinkRuntimeIdentityV1,
} from './code-memory-link-attestation.js';
import {CODE_MEMORY_LINK_DOGFOOD_APPROVED_EVIDENCE_HASHES} from './code-memory-link-approvals.js';
import {Predicate} from 'effect';

export {CODE_MEMORY_LINK_DOGFOOD_APPROVED_EVIDENCE_HASHES} from './code-memory-link-approvals.js';

export const CODE_MEMORY_LINK_DOGFOOD_VERSION = 2 as const;
export const CODE_MEMORY_LINK_DOGFOOD_CASE_IDS = [
  'task-only-memory',
  'file-backlink',
  'symbol-backlink',
  'multi-anchor',
  'no-backlink',
  'stale-graph-abstention',
] as const;
export const CODE_MEMORY_LINK_DOGFOOD_MAXIMUM_BUDGET_TOKENS = 1_500 as const;
export const CODE_MEMORY_LINK_DOGFOOD_MAXIMUM_DURABLE_RECEIPT_MILLISECONDS = 10_000 as const;
export const CODE_MEMORY_LINK_DEFERRED_ANCHOR_CASE_ID = 'deferred-anchor-lifecycle' as const;

export type CodeMemoryLinkDogfoodCaseId = (typeof CODE_MEMORY_LINK_DOGFOOD_CASE_IDS)[number];

export interface CodeMemoryLinkDogfoodGraphStatusV1 {
  readonly readySnapshotCommit: string;
  readonly readySnapshotDirty: boolean;
  readonly readySnapshotId: string;
  readonly stale: boolean;
}

export interface CodeMemoryLinkDogfoodObservationV1 {
  readonly attestation: CodeMemoryLinkInvocationAttestationV1;
  readonly budgetTokens: number;
  readonly codeAnchorCoverageComplete: boolean | null;
  readonly directCodeCitationMatches: number;
  readonly duplicateMemoryCount: number;
  readonly estimatedTokens: number;
  readonly falseCurrentCount: number;
  /** Projection of an independently invoked `graph status --json`, never a harness-supplied assertion. */
  readonly graphStatus: CodeMemoryLinkDogfoodGraphStatusV1 | null;
  readonly id: CodeMemoryLinkDogfoodCaseId;
  readonly memoryMatches: number;
  readonly outputVersion: 2 | 3 | 4 | 5;
  readonly requestedAnchors: number;
  readonly resolvedAnchors: number;
  readonly responseBytes: number;
}

export type CodeMemoryLinkDogfoodObservationSummaryV1 = Omit<CodeMemoryLinkDogfoodObservationV1, 'attestation'>;

export interface CodeMemoryLinkDeferredAnchorObservationV2 {
  readonly attestation: CodeMemoryLinkInvocationAttestationV1;
  readonly canonicalBodyPreserved: boolean;
  readonly canonicalIdentityPreserved: boolean;
  readonly canonicalLifecyclePreserved: boolean;
  readonly canonicalTimestampsPreserved: boolean;
  readonly citationsFinalizedAfterPrepare: boolean;
  readonly directMatchesAfterFinalize: number;
  readonly directMatchesBeforeFinalize: number;
  readonly deferredReceiptGuidanceObserved: boolean;
  readonly durableReceiptMilliseconds: number;
  readonly falseCurrentCount: number;
  readonly finalizedBacklinkTargetsStoredMemory: boolean;
  readonly finalization: {
    readonly citationCount: number;
    readonly conflictCount: number;
    readonly failedCount: number;
    readonly finalizedCount: number;
    readonly pendingCount: number;
    readonly scannedCount: number;
  };
  readonly graphStatusAfterStore: CodeMemoryLinkDogfoodGraphStatusV1;
  readonly indexingStartedByWrite: boolean;
  readonly memoryStored: boolean;
  readonly pendingIntentCountAfterFinalize: number;
  readonly pendingIntentCountAfterStore: number;
  readonly pendingMemoryRecallableByTask: boolean;
  readonly restartBoundary: boolean;
  readonly strictIndexingStartedByWrite: boolean;
  readonly strictMemoryStored: boolean;
  readonly strictReceiptMilliseconds: number;
  readonly strictRecoveryGuidanceObserved: boolean;
  readonly strictWriteRejected: boolean;
}

export type CodeMemoryLinkDeferredAnchorObservationSummaryV2 = Omit<
  CodeMemoryLinkDeferredAnchorObservationV2,
  'attestation'
>;

export interface CodeMemoryLinkDogfoodArtifactV1 {
  readonly artifactHash: string;
  readonly candidate: CodeMemoryLinkAgentAbManifestV1['candidate'];
  readonly deferredAnchorLifecycle: CodeMemoryLinkDeferredAnchorObservationV2;
  /** Clean reviewed checkout that executed the dogfood harness around the candidate runtime. */
  readonly harnessCommit: string;
  readonly observations: readonly CodeMemoryLinkDogfoodObservationV1[];
  readonly runId: string;
  readonly version: typeof CODE_MEMORY_LINK_DOGFOOD_VERSION;
}

export interface CodeMemoryLinkDogfoodResultV1 {
  readonly artifactHash: string;
  readonly candidate: CodeMemoryLinkAgentAbManifestV1['candidate'];
  readonly deferredAnchorLifecycle: CodeMemoryLinkDeferredAnchorObservationV2;
  readonly evidenceApproved: boolean;
  readonly harnessCommit: string;
  readonly gate: {
    readonly failures: readonly string[];
    readonly insufficiencies: readonly string[];
    readonly qualityFailures: readonly string[];
    readonly status: 'failed' | 'insufficient' | 'passed';
  };
  readonly observations: readonly CodeMemoryLinkDogfoodObservationV1[];
  readonly version: typeof CODE_MEMORY_LINK_DOGFOOD_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RUN_ID = /^run_[0-9a-f]{16,64}$/u;

export function codeMemoryLinkDogfoodArtifactHash(
  input: Omit<CodeMemoryLinkDogfoodArtifactV1, 'artifactHash'>,
): string {
  const normalized = normalizeArtifact(input);
  return sha256HexSync(`${JSON.stringify(normalized)}\n`);
}

export function parseCodeMemoryLinkDogfoodArtifactV1(value: unknown): CodeMemoryLinkDogfoodArtifactV1 {
  const artifact = record(value, 'dogfood artifact');
  exactKeys(
    artifact,
    ['artifactHash', 'candidate', 'deferredAnchorLifecycle', 'harnessCommit', 'observations', 'runId', 'version'],
    'dogfood artifact',
  );
  const normalized = normalizeArtifact({
    candidate: artifact.candidate,
    deferredAnchorLifecycle: artifact.deferredAnchorLifecycle,
    harnessCommit: artifact.harnessCommit,
    observations: artifact.observations,
    runId: artifact.runId,
    version: artifact.version,
  });
  const artifactHash = matchingString(artifact.artifactHash, HASH, 'dogfood artifact hash');
  if (artifactHash !== codeMemoryLinkDogfoodArtifactHash(normalized)) {
    invalid('dogfood artifact hash does not match its canonical evidence');
  }
  return {...normalized, artifactHash};
}

export function evaluateCodeMemoryLinkDogfood(value: unknown): CodeMemoryLinkDogfoodResultV1 {
  const artifact = parseCodeMemoryLinkDogfoodArtifactV1(value);
  const qualityFailures = qualityGateFailures(artifact.observations, artifact.deferredAnchorLifecycle);
  const evidenceApproved = CODE_MEMORY_LINK_DOGFOOD_APPROVED_EVIDENCE_HASHES.includes(artifact.artifactHash);
  const insufficiencies = evidenceApproved
    ? []
    : ['practical dogfood evidence hash is not in the code-reviewed release allowlist'];
  const failures = [...qualityFailures, ...insufficiencies].sort();
  return {
    artifactHash: artifact.artifactHash,
    candidate: artifact.candidate,
    deferredAnchorLifecycle: artifact.deferredAnchorLifecycle,
    evidenceApproved,
    harnessCommit: artifact.harnessCommit,
    gate: {
      failures,
      insufficiencies,
      qualityFailures,
      status: qualityFailures.length > 0 ? 'failed' : failures.length > 0 ? 'insufficient' : 'passed',
    },
    observations: artifact.observations,
    version: CODE_MEMORY_LINK_DOGFOOD_VERSION,
  };
}

/** Seal one exact-installed practical observation with a recomputable, privacy-safe output projection. */
export function createCodeMemoryLinkDogfoodObservationV1(input: {
  readonly candidate: CodeMemoryLinkDogfoodArtifactV1['candidate'];
  readonly harnessCommit: string;
  readonly invocationNonce: string;
  readonly observation: CodeMemoryLinkDogfoodObservationSummaryV1 | unknown;
  readonly postRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly preRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly runId: string;
}): CodeMemoryLinkDogfoodObservationV1 {
  const candidate = parseCandidate(input.candidate);
  const runId = matchingString(input.runId, RUN_ID, 'dogfood run id');
  const summary = parseObservationSummary(input.observation);
  const sequence = CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.indexOf(summary.id);
  if (sequence < 0) invalid('dogfood observation has an unsupported case id');
  return {
    ...summary,
    attestation: createCodeMemoryLinkInvocationAttestationV1({
      candidate,
      harnessCommit: input.harnessCommit,
      invocation: {caseId: summary.id, runId, sequence},
      invocationNonce: input.invocationNonce,
      outputProjection: summary,
      postRuntime: input.postRuntime,
      preRuntime: input.preRuntime,
      summary,
    }),
  };
}

export function createCodeMemoryLinkDeferredAnchorObservationV2(input: {
  readonly candidate: CodeMemoryLinkDogfoodArtifactV1['candidate'];
  readonly harnessCommit: string;
  readonly invocationNonce: string;
  readonly observation: CodeMemoryLinkDeferredAnchorObservationSummaryV2 | unknown;
  readonly postRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly preRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly runId: string;
}): CodeMemoryLinkDeferredAnchorObservationV2 {
  const candidate = parseCandidate(input.candidate);
  const runId = matchingString(input.runId, RUN_ID, 'dogfood run id');
  const summary = parseDeferredAnchorObservationSummary(input.observation);
  return {
    ...summary,
    attestation: createCodeMemoryLinkInvocationAttestationV1({
      candidate,
      harnessCommit: input.harnessCommit,
      invocation: {
        caseId: CODE_MEMORY_LINK_DEFERRED_ANCHOR_CASE_ID,
        runId,
        sequence: CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.length,
      },
      invocationNonce: input.invocationNonce,
      outputProjection: summary,
      postRuntime: input.postRuntime,
      preRuntime: input.preRuntime,
      summary,
    }),
  };
}

function normalizeArtifact(value: unknown): Omit<CodeMemoryLinkDogfoodArtifactV1, 'artifactHash'> {
  const artifact = record(value, 'dogfood artifact');
  exactKeys(
    artifact,
    ['candidate', 'deferredAnchorLifecycle', 'harnessCommit', 'observations', 'runId', 'version'],
    'dogfood artifact evidence',
  );
  if (artifact.version !== CODE_MEMORY_LINK_DOGFOOD_VERSION) invalid('dogfood artifact version must be 2');
  const candidate = parseCandidate(artifact.candidate);
  const harnessCommit = matchingString(artifact.harnessCommit, COMMIT, 'dogfood harness commit');
  const runId = matchingString(artifact.runId, RUN_ID, 'dogfood run id');
  const observations = parseObservations(artifact.observations, candidate, harnessCommit, runId);
  const deferredAnchorLifecycle = parseDeferredAnchorObservation(
    artifact.deferredAnchorLifecycle,
    candidate,
    harnessCommit,
    runId,
  );
  assertUniqueCodeMemoryLinkAttestations(
    [...observations.map(observation => observation.attestation), deferredAnchorLifecycle.attestation],
    'practical dogfood observations',
  );
  return {
    candidate,
    deferredAnchorLifecycle,
    harnessCommit,
    observations,
    runId,
    version: CODE_MEMORY_LINK_DOGFOOD_VERSION,
  };
}

function parseCandidate(value: unknown): CodeMemoryLinkDogfoodArtifactV1['candidate'] {
  const candidate = record(value, 'dogfood candidate');
  exactKeys(candidate, ['buildIdentityHash', 'commit', 'dirty'], 'dogfood candidate');
  if (candidate.dirty !== false) invalid('dogfood candidate must identify a clean build');
  return {
    buildIdentityHash: matchingString(candidate.buildIdentityHash, HASH, 'dogfood build identity hash'),
    commit: matchingString(candidate.commit, COMMIT, 'dogfood candidate commit'),
    dirty: false,
  };
}

function parseObservations(
  value: unknown,
  candidate: CodeMemoryLinkDogfoodArtifactV1['candidate'],
  harnessCommit: string,
  runId: string,
): readonly CodeMemoryLinkDogfoodObservationV1[] {
  if (!Array.isArray(value) || value.length !== CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.length) {
    invalid(`dogfood observations must contain exactly ${CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.length} cases`);
  }
  const observations = value.map((observation, sequence) =>
    parseObservation(observation, candidate, harnessCommit, runId, sequence),
  );
  if (observations.some((observation, index) => observation.id !== CODE_MEMORY_LINK_DOGFOOD_CASE_IDS[index])) {
    invalid('dogfood observations must use the canonical required case order');
  }
  return observations;
}

function parseDeferredAnchorObservation(
  value: unknown,
  candidate: CodeMemoryLinkDogfoodArtifactV1['candidate'],
  harnessCommit: string,
  runId: string,
): CodeMemoryLinkDeferredAnchorObservationV2 {
  const observation = record(value, 'deferred-anchor dogfood observation');
  const {attestation: attestationInput, ...summaryInput} = observation;
  const summary = parseDeferredAnchorObservationSummary(summaryInput);
  return {
    ...summary,
    attestation: parseCodeMemoryLinkInvocationAttestationV1(attestationInput, {
      candidate,
      harnessCommit,
      invocation: {
        caseId: CODE_MEMORY_LINK_DEFERRED_ANCHOR_CASE_ID,
        runId,
        sequence: CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.length,
      },
      outputProjection: summary,
      summary,
    }),
  };
}

function parseObservation(
  value: unknown,
  candidate: CodeMemoryLinkDogfoodArtifactV1['candidate'],
  harnessCommit: string,
  runId: string,
  sequence: number,
): CodeMemoryLinkDogfoodObservationV1 {
  const observation = record(value, 'dogfood observation');
  exactKeys(
    observation,
    [
      'attestation',
      'budgetTokens',
      'codeAnchorCoverageComplete',
      'directCodeCitationMatches',
      'duplicateMemoryCount',
      'estimatedTokens',
      'falseCurrentCount',
      'graphStatus',
      'id',
      'memoryMatches',
      'outputVersion',
      'requestedAnchors',
      'resolvedAnchors',
      'responseBytes',
    ],
    'dogfood observation',
  );
  const {attestation: attestationInput, ...summaryInput} = observation;
  const summary = parseObservationSummary(summaryInput);
  return {
    ...summary,
    attestation: parseCodeMemoryLinkInvocationAttestationV1(attestationInput, {
      candidate,
      harnessCommit,
      invocation: {caseId: summary.id, runId, sequence},
      outputProjection: summary,
      summary,
    }),
  };
}

function parseObservationSummary(value: unknown): CodeMemoryLinkDogfoodObservationSummaryV1 {
  const observation = record(value, 'dogfood observation summary');
  exactKeys(
    observation,
    [
      'budgetTokens',
      'codeAnchorCoverageComplete',
      'directCodeCitationMatches',
      'duplicateMemoryCount',
      'estimatedTokens',
      'falseCurrentCount',
      'graphStatus',
      'id',
      'memoryMatches',
      'outputVersion',
      'requestedAnchors',
      'resolvedAnchors',
      'responseBytes',
    ],
    'dogfood observation summary',
  );
  const budgetTokens = positiveInteger(observation.budgetTokens, 'dogfood budget tokens');
  if (budgetTokens > CODE_MEMORY_LINK_DOGFOOD_MAXIMUM_BUDGET_TOKENS) invalid('dogfood budget exceeds 1500 tokens');
  const outputVersion = observation.outputVersion;
  if (outputVersion !== 2 && outputVersion !== 3 && outputVersion !== 4 && outputVersion !== 5) {
    invalid('dogfood output version must be 2, 3, or 4');
  }
  const codeAnchorCoverageComplete = observation.codeAnchorCoverageComplete;
  if (codeAnchorCoverageComplete !== null && typeof codeAnchorCoverageComplete !== 'boolean') {
    invalid('dogfood code-anchor coverage must be boolean or null');
  }
  return {
    budgetTokens,
    codeAnchorCoverageComplete,
    directCodeCitationMatches: nonNegativeInteger(observation.directCodeCitationMatches, 'direct matches'),
    duplicateMemoryCount: nonNegativeInteger(observation.duplicateMemoryCount, 'duplicate memories'),
    estimatedTokens: nonNegativeInteger(observation.estimatedTokens, 'estimated tokens'),
    falseCurrentCount: nonNegativeInteger(observation.falseCurrentCount, 'false-current count'),
    graphStatus: parseGraphStatus(observation.graphStatus),
    id: literal(observation.id, CODE_MEMORY_LINK_DOGFOOD_CASE_IDS, 'dogfood case id'),
    memoryMatches: nonNegativeInteger(observation.memoryMatches, 'memory matches'),
    outputVersion,
    requestedAnchors: nonNegativeInteger(observation.requestedAnchors, 'requested anchors'),
    resolvedAnchors: nonNegativeInteger(observation.resolvedAnchors, 'resolved anchors'),
    responseBytes: positiveInteger(observation.responseBytes, 'response bytes'),
  };
}

function parseDeferredAnchorObservationSummary(value: unknown): CodeMemoryLinkDeferredAnchorObservationSummaryV2 {
  const observation = record(value, 'deferred-anchor dogfood observation summary');
  exactKeys(
    observation,
    [
      'canonicalBodyPreserved',
      'canonicalIdentityPreserved',
      'canonicalLifecyclePreserved',
      'canonicalTimestampsPreserved',
      'citationsFinalizedAfterPrepare',
      'directMatchesAfterFinalize',
      'directMatchesBeforeFinalize',
      'deferredReceiptGuidanceObserved',
      'durableReceiptMilliseconds',
      'falseCurrentCount',
      'finalizedBacklinkTargetsStoredMemory',
      'finalization',
      'graphStatusAfterStore',
      'indexingStartedByWrite',
      'memoryStored',
      'pendingIntentCountAfterFinalize',
      'pendingIntentCountAfterStore',
      'pendingMemoryRecallableByTask',
      'restartBoundary',
      'strictIndexingStartedByWrite',
      'strictMemoryStored',
      'strictReceiptMilliseconds',
      'strictRecoveryGuidanceObserved',
      'strictWriteRejected',
    ],
    'deferred-anchor dogfood observation summary',
  );
  const finalization = record(observation.finalization, 'deferred-anchor finalization receipt');
  exactKeys(
    finalization,
    ['citationCount', 'conflictCount', 'failedCount', 'finalizedCount', 'pendingCount', 'scannedCount'],
    'deferred-anchor finalization receipt',
  );
  const graphStatusAfterStore = parseGraphStatus(observation.graphStatusAfterStore);
  if (graphStatusAfterStore === null) invalid('deferred-anchor write must retain its observed graph status');
  return {
    canonicalBodyPreserved: boolean(observation.canonicalBodyPreserved, 'deferred-anchor body preservation'),
    canonicalIdentityPreserved: boolean(
      observation.canonicalIdentityPreserved,
      'deferred-anchor identity preservation',
    ),
    canonicalLifecyclePreserved: boolean(
      observation.canonicalLifecyclePreserved,
      'deferred-anchor lifecycle preservation',
    ),
    canonicalTimestampsPreserved: boolean(
      observation.canonicalTimestampsPreserved,
      'deferred-anchor timestamp preservation',
    ),
    citationsFinalizedAfterPrepare: boolean(
      observation.citationsFinalizedAfterPrepare,
      'deferred-anchor finalized state',
    ),
    directMatchesAfterFinalize: nonNegativeInteger(
      observation.directMatchesAfterFinalize,
      'deferred-anchor direct matches after finalization',
    ),
    directMatchesBeforeFinalize: nonNegativeInteger(
      observation.directMatchesBeforeFinalize,
      'deferred-anchor direct matches before finalization',
    ),
    deferredReceiptGuidanceObserved: boolean(
      observation.deferredReceiptGuidanceObserved,
      'deferred-anchor write receipt guidance',
    ),
    durableReceiptMilliseconds: nonNegativeInteger(
      observation.durableReceiptMilliseconds,
      'deferred-anchor durable receipt milliseconds',
    ),
    falseCurrentCount: nonNegativeInteger(observation.falseCurrentCount, 'deferred-anchor false-current count'),
    finalizedBacklinkTargetsStoredMemory: boolean(
      observation.finalizedBacklinkTargetsStoredMemory,
      'deferred-anchor finalized backlink target',
    ),
    finalization: {
      citationCount: nonNegativeInteger(finalization.citationCount, 'deferred-anchor citation count'),
      conflictCount: nonNegativeInteger(finalization.conflictCount, 'deferred-anchor conflict count'),
      failedCount: nonNegativeInteger(finalization.failedCount, 'deferred-anchor failure count'),
      finalizedCount: nonNegativeInteger(finalization.finalizedCount, 'deferred-anchor finalized count'),
      pendingCount: nonNegativeInteger(finalization.pendingCount, 'deferred-anchor pending count'),
      scannedCount: nonNegativeInteger(finalization.scannedCount, 'deferred-anchor scanned count'),
    },
    graphStatusAfterStore,
    indexingStartedByWrite: boolean(observation.indexingStartedByWrite, 'deferred-anchor indexing-started state'),
    memoryStored: boolean(observation.memoryStored, 'deferred-anchor memory stored state'),
    pendingIntentCountAfterFinalize: nonNegativeInteger(
      observation.pendingIntentCountAfterFinalize,
      'deferred-anchor pending intents after finalization',
    ),
    pendingIntentCountAfterStore: nonNegativeInteger(
      observation.pendingIntentCountAfterStore,
      'deferred-anchor pending intents after store',
    ),
    pendingMemoryRecallableByTask: boolean(
      observation.pendingMemoryRecallableByTask,
      'deferred-anchor pending task recall',
    ),
    restartBoundary: boolean(observation.restartBoundary, 'deferred-anchor restart boundary'),
    strictIndexingStartedByWrite: boolean(
      observation.strictIndexingStartedByWrite,
      'strict cited-write indexing-started state',
    ),
    strictMemoryStored: boolean(observation.strictMemoryStored, 'strict cited-write memory stored state'),
    strictReceiptMilliseconds: nonNegativeInteger(
      observation.strictReceiptMilliseconds,
      'strict cited-write receipt milliseconds',
    ),
    strictRecoveryGuidanceObserved: boolean(
      observation.strictRecoveryGuidanceObserved,
      'strict cited-write recovery guidance',
    ),
    strictWriteRejected: boolean(observation.strictWriteRejected, 'strict cited-write rejection state'),
  };
}

function parseGraphStatus(value: unknown): CodeMemoryLinkDogfoodGraphStatusV1 | null {
  if (value === null) return null;
  const status = record(value, 'dogfood graph status');
  exactKeys(status, ['readySnapshotCommit', 'readySnapshotDirty', 'readySnapshotId', 'stale'], 'dogfood graph status');
  return {
    readySnapshotCommit: matchingString(status.readySnapshotCommit, COMMIT, 'dogfood ready snapshot commit'),
    readySnapshotDirty: boolean(status.readySnapshotDirty, 'dogfood ready snapshot dirty flag'),
    readySnapshotId: matchingString(status.readySnapshotId, /^cgsn_[0-9a-f]{32,64}$/u, 'dogfood ready snapshot id'),
    stale: boolean(status.stale, 'dogfood graph stale status'),
  };
}

function qualityGateFailures(
  observations: readonly CodeMemoryLinkDogfoodObservationV1[],
  deferred: CodeMemoryLinkDeferredAnchorObservationV2,
): string[] {
  const byId = new Map(observations.map(observation => [observation.id, observation]));
  const failures = observations.flatMap(observation => commonFailures(observation));
  expected(byId.get('task-only-memory'), {direct: 0, matches: 1, requested: 0, resolved: 0, version: 2}, failures);
  expected(
    byId.get('file-backlink'),
    {complete: true, direct: 1, matches: 1, requested: 1, resolved: 1, version: 3},
    failures,
  );
  expected(
    byId.get('symbol-backlink'),
    {complete: true, direct: 1, matches: 1, requested: 1, resolved: 1, version: 3},
    failures,
  );
  const multi = byId.get('multi-anchor')!;
  expected(multi, {complete: true, direct: 1, matches: 1, requested: 2, resolved: 2, version: 3}, failures);
  expected(byId.get('no-backlink'), {complete: true, direct: 0, requested: 1, resolved: 1, version: 3}, failures);
  const stale = byId.get('stale-graph-abstention')!;
  expected(stale, {complete: false, direct: 0, requested: 1, resolved: 0, version: 3}, failures);
  if (stale.graphStatus === null || !stale.graphStatus.stale) {
    failures.push('stale-graph-abstention did not independently observe a stale graph');
  } else {
    if (stale.graphStatus.readySnapshotDirty) {
      failures.push('stale-graph-abstention did not start from a clean ready graph snapshot');
    }
    if (stale.graphStatus.readySnapshotCommit !== stale.attestation.harnessCommit) {
      failures.push('stale-graph-abstention graph snapshot does not match the reviewed harness checkout');
    }
  }
  if (!deferred.strictWriteRejected || deferred.strictMemoryStored || !deferred.strictRecoveryGuidanceObserved) {
    failures.push('strict cited write did not reject atomically while exact-current graph evidence was unavailable');
  }
  if (deferred.strictIndexingStartedByWrite || deferred.indexingStartedByWrite) {
    failures.push('strict or deferred memory write started graph indexing');
  }
  if (
    !deferred.memoryStored ||
    !deferred.canonicalBodyPreserved ||
    !deferred.canonicalIdentityPreserved ||
    !deferred.canonicalLifecyclePreserved ||
    !deferred.canonicalTimestampsPreserved ||
    !deferred.pendingMemoryRecallableByTask ||
    !deferred.deferredReceiptGuidanceObserved ||
    !deferred.restartBoundary
  ) {
    failures.push('deferred-anchor lifecycle did not preserve durable memory across a process restart');
  }
  if (
    deferred.pendingIntentCountAfterStore !== 1 ||
    deferred.pendingIntentCountAfterFinalize !== 0 ||
    deferred.finalization.finalizedCount !== 1 ||
    deferred.finalization.citationCount !== 1 ||
    deferred.finalization.scannedCount !== 1 ||
    deferred.finalization.pendingCount !== 0 ||
    deferred.finalization.conflictCount !== 0 ||
    deferred.finalization.failedCount !== 0 ||
    !deferred.citationsFinalizedAfterPrepare
  ) {
    failures.push('deferred-anchor lifecycle did not finalize exactly one private pending intent');
  }
  if (
    deferred.directMatchesBeforeFinalize !== 0 ||
    deferred.directMatchesAfterFinalize < 1 ||
    !deferred.finalizedBacklinkTargetsStoredMemory ||
    deferred.falseCurrentCount !== 0
  ) {
    failures.push('deferred-anchor lifecycle exposed a pending backlink or failed to expose its finalized backlink');
  }
  if (deferred.durableReceiptMilliseconds > CODE_MEMORY_LINK_DOGFOOD_MAXIMUM_DURABLE_RECEIPT_MILLISECONDS) {
    failures.push('deferred-anchor durable memory receipt exceeded 10000 ms');
  }
  if (deferred.strictReceiptMilliseconds > CODE_MEMORY_LINK_DOGFOOD_MAXIMUM_DURABLE_RECEIPT_MILLISECONDS) {
    failures.push('strict cited-write rejection receipt exceeded 10000 ms');
  }
  if (
    !deferred.graphStatusAfterStore.stale ||
    deferred.graphStatusAfterStore.readySnapshotDirty ||
    deferred.graphStatusAfterStore.readySnapshotCommit !== deferred.attestation.harnessCommit
  ) {
    failures.push('deferred-anchor write did not preserve the independently observed stale ready graph');
  }
  return failures.sort();
}

function commonFailures(observation: CodeMemoryLinkDogfoodObservationV1): string[] {
  const failures: string[] = [];
  if (observation.estimatedTokens > observation.budgetTokens) failures.push(`${observation.id} exceeded token budget`);
  if (observation.responseBytes > observation.budgetTokens * 3) failures.push(`${observation.id} exceeded byte budget`);
  if (observation.duplicateMemoryCount > 0) failures.push(`${observation.id} returned duplicate memories`);
  if (observation.falseCurrentCount > 0) failures.push(`${observation.id} made a false-current claim`);
  if (observation.resolvedAnchors > observation.requestedAnchors)
    failures.push(`${observation.id} over-resolved anchors`);
  if (observation.id !== 'stale-graph-abstention' && observation.graphStatus !== null) {
    failures.push(`${observation.id} unexpectedly retained a graph-status observation`);
  }
  return failures;
}

function expected(
  observation: CodeMemoryLinkDogfoodObservationV1 | undefined,
  contract: {
    readonly complete?: boolean;
    readonly direct: number;
    readonly matches?: number;
    readonly requested: number;
    readonly resolved: number;
    readonly version: 2 | 3;
  },
  failures: string[],
): void {
  if (observation === undefined) return;
  if (
    observation.outputVersion !== contract.version ||
    observation.requestedAnchors !== contract.requested ||
    observation.resolvedAnchors !== contract.resolved ||
    observation.directCodeCitationMatches < contract.direct ||
    (contract.direct === 0 && observation.directCodeCitationMatches !== 0) ||
    (contract.matches !== undefined && observation.memoryMatches < contract.matches) ||
    (contract.complete === undefined
      ? observation.codeAnchorCoverageComplete !== null
      : observation.codeAnchorCoverageComplete !== contract.complete)
  ) {
    failures.push(`${observation.id} did not satisfy its practical retrieval contract`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actual.length !== expectedKeys.length || actual.some((key, index) => key !== expectedKeys[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) invalid(`${label} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link dogfood evidence: ${message}.`);
}
