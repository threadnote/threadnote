import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  ACTIVATION_APPROVAL_KINDS,
  activationReceiptRevisionV1,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  type ActivationApprovalV1,
  type ActivationPlanV1,
  type ActivationReceiptV1,
} from '../activation/contract.js';
import {activationReceiptTransitionMatchesV1, createActivationReceiptV1} from '../activation/receipt.js';
import {previewActivationResumeV1} from '../activation/planner.js';
import {
  parseSecondSurfaceProofReceiptV1,
  secondSurfaceProofMatchesContextV1,
  type SecondSurfaceProofReceiptV1,
} from '../activation/second/surface.js';
import {activationValueEventsV1} from '../activation/value.js';
import {readActivationStateV1} from '../activation/store.js';
import {
  parseSecondSurfaceProofAttestationV1,
  parseSecondSurfaceProofChallengeV1,
  readSecondSurfaceProofChallengeV1,
  verifySecondSurfaceProofAttestationV1,
} from '../activation/second/surface_store.js';
import {readLocalValueEvents, type LocalValueEventV1} from '../value_report/events.js';
import {
  buildKnowledgeDeltaGitProposalV1,
  type KnowledgeDeltaGitProposalInputV1,
} from '../git_proposal/knowledge_delta.js';
import {
  isMemoryCandidate,
  parseCandidateReview,
  type CandidateReview,
  type LegacyMemoryCandidate,
  type MemoryCandidate,
} from '@threadnote/memory/candidate';
import {deriveThreadnote5HealthClaimsV1} from './threadnote-5-release-readiness-health.js';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {
  parseProcedureManifest,
  parseProcedureVerificationReceipt,
  procedureStatus,
} from '@threadnote/context/procedure/contract';
import {
  parseThreadnote5TrustedSourceV1,
  THREADNOTE_5_RELEASE_SCENARIOS,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import {parseContextCheckReportJson} from '@threadnote/context/check';
import {
  guidanceBlock,
  parseGuidanceReceiptV2,
  renderManagedGuidanceBlock,
  stripThreadnoteManagedGuidance,
  upsertGuidanceBlock,
} from '../guidance/index.js';
import {
  parseThreadnote5LocalAuthorityManifestV1,
  threadnote5ActivationAttestationDigest,
  threadnote5ActivationOfflineObservationDigest,
  threadnote5ApplyAuditDigest,
  threadnote5ApprovedSourceUriHash,
  threadnote5LocalAuthorityManifestHash,
  threadnote5ProcedureVerificationReceiptDigest,
  type Threadnote5LocalAuthorityEntryV1,
} from './threadnote-5-release-readiness-authority.js';
import {
  deriveThreadnote5ContextBriefClaims,
  type Threadnote5FirstBriefLinkV1,
} from './threadnote-5-release-readiness-context-brief.js';
import {
  deriveThreadnote5ValueReportClaims,
  type Threadnote5ActivationValueLinkV1,
  type Threadnote5FeedbackTrialLinkV1,
} from './threadnote-5-release-readiness-value-report.js';
import {
  allowedKeys,
  boundedArray,
  compareText,
  exactObject,
  hash,
  integerIn,
  isoInstant,
  nonEmptyText,
  object,
  text,
  unique,
} from './threadnote-5-release-readiness-validation.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ActivationApprovalSchema = Schema.Struct({
  approvalHash: Schema.String,
  approved: Schema.Literal(true),
  kind: Schema.Literals(ACTIVATION_APPROVAL_KINDS),
  operationId: Schema.String,
  planHash: Schema.String,
  receiptRevision: Schema.String,
  reviewRevisionHash: Schema.String,
  type: Schema.Literal('threadnote-activation-approval'),
  version: Schema.Literal(1),
});
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const ReviewedSharedMemoryMutationSchema = withRest(
  Schema.Struct({
    approval: withRest(
      Schema.Struct({
        expectedSourceContentHash: Schema.String,
        reviewId: Schema.String,
        revision: Schema.Finite,
        share: Schema.Literal(true),
      }),
    ),
    candidateId: Schema.String,
    expectedTarget: Schema.Union([
      withRest(Schema.Struct({state: Schema.Literal('absent')})),
      withRest(
        Schema.Struct({
          content: Schema.String,
          contentHash: Schema.String,
          state: Schema.Literal('present'),
        }),
      ),
    ]),
    operation: Schema.Literals(['create', 'replace']),
    sourceContent: Schema.String,
    sourceUri: Schema.String,
  }),
);
const ProcedureStatusInputSchema = withRest(
  Schema.Struct({
    availableArtifact: Schema.optionalKey(
      Schema.Struct({
        id: Schema.String,
        semanticVersion: Schema.String,
        sha256: Schema.String,
      }),
    ),
    capabilities: Schema.Array(Schema.String),
    localArtifactSha256: Schema.optionalKey(Schema.String),
    receipt: Schema.optionalKey(Schema.Unknown),
    surfaceIds: Schema.Array(Schema.String),
  }),
);
import type {
  Threadnote5LocalSourceKindV1,
  Threadnote5LocalSubsystemReceiptRecordV1,
  Threadnote5OfflineNetworkObserverV1,
  Threadnote5ScenarioReceiptVerificationV1,
  Threadnote5LocalReceiptVerificationV1,
  Threadnote5DerivedLocalReceiptSetV1,
  DerivedClaims,
  Threadnote5SecondSurfaceLinkV1,
  Threadnote5SharedDecisionLinkV1,
  Threadnote5DerivedCorrelationsV1,
  Threadnote5LocalReceiptAdapterV1,
} from './threadnote-5-release-readiness-receipts-contracts.js';
import {
  unknownFor,
  contentFreeRecord,
  withoutDigest,
  sameSource,
  encodedBytes,
  compareMeasurement,
  isSourceKind,
  releaseScenario,
} from './threadnote-5-release-readiness-receipts/helpers.js';
export type {
  Threadnote5LocalSourceKindV1,
  Threadnote5LocalSubsystemReceiptRecordV1,
  Threadnote5OfflineNetworkObserverV1,
  Threadnote5ScenarioReceiptVerificationV1,
  Threadnote5LocalReceiptVerificationV1,
  Threadnote5DerivedScenarioClaimsV1,
  Threadnote5DerivedLocalReceiptSetV1,
} from './threadnote-5-release-readiness-receipts-contracts.js';
export const THREADNOTE_5_LOCAL_SUBSYSTEM_RECEIPT_VERSION = 1 as const;

const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORD_SET_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 64;

/**
 * Captures only replayable activation evidence from the production stores. The receipt history
 * is supplied by the harness because the production store deliberately retains just its latest
 * receipt; the helper verifies the live final state, local value events, and (when present)
 * the private HMAC challenge before returning a serializable capture.
 */
export const captureThreadnote5ActivationTrialV1 = Effect.fn('releaseReadiness.captureActivationTrial')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: {
    readonly activationId: string;
    readonly approvals?: readonly ActivationApprovalV1[];
    readonly challengeId?: string;
    readonly receiptChain: readonly unknown[];
    readonly offlineObserver?: Threadnote5OfflineNetworkObserverV1;
    readonly resumeBoundaryRevision?: string;
  },
) {
  const beforeAttempts = input.offlineObserver?.attemptedNetworkActivityCount();
  const state = yield* readActivationStateV1(config, input.activationId);
  if (state === undefined) throw new Error('Activation capture requires retained production state.');
  const receiptChain = EffectArray.map(input.receiptChain, parseActivationReceiptV1);
  if (canonicalJson(receiptChain.at(-1)) !== canonicalJson(state.receipt)) {
    throw new Error('Activation capture chain does not end at the live production state.');
  }
  const approvals = input.approvals ?? [];
  verifyActivationReceiptChain(state.plan, receiptChain, approvals);
  const eventIds = new Set(EffectArray.map(activationValueEventsV1(state.receipt), event => event.eventId));
  const events = EffectArray.filter(
    yield* readLocalValueEvents(config.agentContextHome),
    (event): event is Extract<LocalValueEventV1, {readonly kind: 'activation'}> =>
      event.kind === 'activation' && eventIds.has(event.eventId),
  );
  const afterAttempts = input.offlineObserver?.attemptedNetworkActivityCount();
  if (beforeAttempts !== undefined && (beforeAttempts !== 0 || afterAttempts !== 0)) {
    throw new Error('Offline activation capture observed network activity.');
  }
  if (
    input.resumeBoundaryRevision !== undefined &&
    !resumeBoundaryIsVerified(receiptChain, input.resumeBoundaryRevision)
  ) {
    throw new Error('Activation capture resume boundary is not an intermediate retained receipt.');
  }
  const challenge =
    input.challengeId === undefined ? undefined : yield* readSecondSurfaceProofChallengeV1(config, input.challengeId);
  if (challenge !== undefined) {
    if (challenge.receipt === undefined) throw new Error('Second-surface capture requires a completed live challenge.');
    yield* verifySecondSurfaceProofAttestationV1(config, challenge, challenge.receipt);
  }
  const offlineObservation =
    beforeAttempts === undefined
      ? undefined
      : {
          afterAttemptCount: afterAttempts!,
          afterRevision: state.receipt.revision,
          beforeAttemptCount: beforeAttempts,
          beforeRevision: receiptChain[0].revision,
        };
  const trial = {
    approvals,
    events,
    ...(offlineObservation === undefined ? {} : {offlineObservation}),
    receiptChain,
    ...(input.resumeBoundaryRevision === undefined ? {} : {resumeBoundaryRevision: input.resumeBoundaryRevision}),
    state,
    ...(challenge === undefined ? {} : {secondSurface: {challenge}}),
  };
  return {
    authorityTrial: {
      activationId: state.plan.activationId,
      attestationDigest: challenge?.receipt === undefined ? null : threadnote5ActivationAttestationDigest(challenge),
      finalReceiptRevision: state.receipt.revision,
      offlineObservationDigest:
        offlineObservation === undefined ? null : threadnote5ActivationOfflineObservationDigest(offlineObservation),
      resumeBoundaryRevision: input.resumeBoundaryRevision ?? null,
    },
    trial,
  };
});

export function threadnote5LocalSubsystemReceiptDigest(
  record: Omit<Threadnote5LocalSubsystemReceiptRecordV1, 'digest'>,
): string {
  return sha256HexSync(`threadnote-5-local-subsystem-receipt-v1\0${canonicalJson(record)}`);
}

/** Content-free, portable output for persistence or stdout. Input paths and private artifacts are intentionally absent. */
export function threadnote5LocalReceiptVerificationArtifact(verification: Threadnote5LocalReceiptVerificationV1): {
  readonly verification: Threadnote5LocalReceiptVerificationV1;
  readonly verificationHash: string;
  readonly version: 1;
} {
  return {
    verification,
    verificationHash: sha256HexSync(`threadnote-5-local-receipt-verification-v1\0${canonicalJson(verification)}`),
    version: 1,
  };
}

/** Replays the same source-native adapters as verification and exposes only the claims needed to seal observations. */
export function deriveThreadnote5LocalScenarioClaims(input: {
  readonly authorityManifest: unknown;
  readonly candidate: Threadnote5SourceV1;
  readonly expectedAuthorityManifestSha256: string;
  readonly retainedRecords: unknown;
}): Threadnote5DerivedLocalReceiptSetV1 {
  const candidate = parseThreadnote5TrustedSourceV1(input.candidate, 'candidate');
  if (!EffectArray.isArray(input.retainedRecords)) throw new Error('Retained subsystem records must be an array.');
  if (input.retainedRecords.length > MAX_RECORDS || encodedBytes(input.retainedRecords) > MAX_RECORD_SET_BYTES) {
    throw new Error('Retained subsystem record set exceeds its bounds.');
  }
  const records = EffectArray.map(input.retainedRecords, parseRecord);
  if (
    !unique(EffectArray.map(records, record => record.digest)) ||
    !unique(EffectArray.map(records, record => `${record.scenario}\0${record.kind}`)) ||
    EffectArray.some(records, record => !sameSource(record.candidate, candidate))
  ) {
    throw new Error('Retained subsystem records are duplicated or candidate-mismatched.');
  }
  const authority = resolveAuthority(
    records,
    candidate,
    input.authorityManifest,
    input.expectedAuthorityManifestSha256,
  );
  if (authority.manifestHash === null) throw new Error('Production capture requires external authority.');
  const derivedByDigest = new Map<string, DerivedClaims>();
  for (const record of records) {
    if (record.digest !== threadnote5LocalSubsystemReceiptDigest(withoutDigest(record))) {
      throw new Error('Retained subsystem record digest does not match its source artifact.');
    }
    derivedByDigest.set(record.digest, deriveClaims(record, authority.byRecordDigest.get(record.digest)));
  }
  const feedbackTrials = EffectArray.flatMap(
    [...derivedByDigest.values()],
    claims => claims.correlations?.feedbackTrials ?? [],
  );
  if (
    !unique(EffectArray.map(feedbackTrials, trial => trial.feedbackEventDigest)) ||
    !unique(EffectArray.map(feedbackTrials, trial => trial.laneId))
  ) {
    throw new Error('Production capture feedback events and scenario lanes must be globally unique.');
  }
  const order = new Map(
    EffectArray.map(THREADNOTE_5_RELEASE_SCENARIOS, (scenario, index) => [scenario, index] as const),
  );
  const sortedRecords = [...records].sort((left, right) => {
    const scenarioOrder = order.get(left.scenario)! - order.get(right.scenario)!;
    return scenarioOrder === 0 ? compareText(left.kind, right.kind) : scenarioOrder;
  });
  const scenarios = EffectArray.map(
    [...new Set(EffectArray.map(sortedRecords, record => record.scenario))],
    scenario => {
      const scenarioRecords = EffectArray.filter(sortedRecords, record => record.scenario === scenario);
      const collected = collectScenarioClaims(
        scenario,
        EffectArray.map(scenarioRecords, record => ({
          digest: record.digest,
          kind: record.kind,
        })),
        derivedByDigest,
      );
      return {
        assertions: [...collected.assertions].sort(compareText),
        measurements: [...collected.measurements].sort(compareMeasurement),
        metricContributingKinds: EffectArray.map(
          EffectArray.filter(scenarioRecords, record =>
            isMetricLaneSource(scenario, derivedByDigest.get(record.digest)),
          ),
          record => record.kind,
        ),
        missingKinds: [...new Set(collected.missingKinds)].sort(compareText),
        scenario,
        subsystemReceipts: EffectArray.map(scenarioRecords, record => ({
          digest: record.digest,
          kind: record.kind,
        })),
      };
    },
  );
  return {
    authorityManifestHash: authority.manifestHash,
    records: sortedRecords,
    scenarios,
  };
}

function isMetricLaneSource(scenario: Threadnote5ReleaseScenario, claims: DerivedClaims | undefined): boolean {
  if (claims === undefined) return false;
  return (
    claims.measurements.length > 0 ||
    (claims.correlations !== undefined &&
      (scenario === 'solo' || scenario === 'two-agent' || scenario === 'git-shared' || scenario === 'offline'))
  );
}

/** Parses private local artifacts, replays shipped pure APIs, and returns content-free verification only. */
export function verifyThreadnote5LocalSubsystemReceipts(input: {
  readonly authorityManifest?: unknown;
  readonly candidate: Threadnote5SourceV1;
  readonly expectedAuthorityManifestSha256?: string;
  readonly observations: readonly Threadnote5ObservationV1[];
  readonly retainedRecords: unknown;
}): Threadnote5LocalReceiptVerificationV1 {
  let candidate: Threadnote5SourceV1;
  try {
    candidate = parseThreadnote5TrustedSourceV1(input.candidate, 'candidate');
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }
  if (!EffectArray.isArray(input.retainedRecords)) return unknownFor(input.observations, 'records-unavailable');
  let recordSetBytes: number;
  try {
    recordSetBytes = encodedBytes(input.retainedRecords);
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }
  if (input.retainedRecords.length > MAX_RECORDS || recordSetBytes > MAX_RECORD_SET_BYTES) {
    return unknownFor(input.observations, 'records-invalid');
  }

  let records: readonly Threadnote5LocalSubsystemReceiptRecordV1[];
  try {
    records = EffectArray.map(input.retainedRecords, parseRecord);
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }
  if (
    !unique(EffectArray.map(records, record => record.digest)) ||
    !unique(EffectArray.map(records, record => `${record.scenario}\0${record.kind}`)) ||
    EffectArray.some(records, record => !sameSource(record.candidate, candidate))
  ) {
    return unknownFor(input.observations, 'records-mismatched');
  }

  const expected = new Map<
    string,
    {
      readonly kind: Threadnote5LocalSourceKindV1;
      readonly scenario: Threadnote5ReleaseScenario;
    }
  >();
  for (const observation of input.observations) {
    for (const receipt of observation.attestation.subsystemReceipts) {
      if (isSourceKind(receipt.kind))
        expected.set(receipt.digest, {
          kind: receipt.kind,
          scenario: observation.scenario,
        });
    }
  }
  if (
    records.length !== expected.size ||
    EffectArray.some(records, record => {
      const reference = expected.get(record.digest);
      return reference?.kind !== record.kind || reference.scenario !== record.scenario;
    })
  ) {
    return unknownFor(input.observations, 'records-mismatched');
  }

  const derivedByDigest = new Map<string, DerivedClaims>();
  let authorityManifestHash: string | null;
  try {
    const authority = resolveAuthority(
      records,
      candidate,
      input.authorityManifest,
      input.expectedAuthorityManifestSha256,
    );
    authorityManifestHash = authority.manifestHash;
    for (const record of records) {
      if (record.digest !== threadnote5LocalSubsystemReceiptDigest(withoutDigest(record))) {
        return unknownFor(input.observations, 'records-mismatched');
      }
      derivedByDigest.set(record.digest, deriveClaims(record, authority.byRecordDigest.get(record.digest)));
    }
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }

  let claimsMismatch = false;
  const scenarios = EffectArray.map(input.observations, observation => {
    const result = verifyObservation(observation, derivedByDigest);
    claimsMismatch ||= result.claimsMismatch;
    return result.verification;
  });
  if (claimsMismatch) return {reason: 'records-mismatched', scenarios, state: 'unknown'};
  if (EffectArray.some(scenarios, scenario => scenario.state !== 'verified')) {
    return {reason: 'verifier-incomplete', scenarios, state: 'unknown'};
  }
  const recordsHash = sha256HexSync(
    `threadnote-5-local-subsystem-records-v1\0${canonicalJson({
      authorityManifestHash,
      records: EffectArray.map(records, contentFreeRecord).sort((left, right) =>
        Effect2.pipe(left.digest, EffectString.localeCompare(right.digest)),
      ),
    })}`,
  );
  return {
    authorityManifestHash,
    receiptCount: records.length,
    recordsHash,
    scenarios,
    state: 'verified',
  };
}

function verifyObservation(
  observation: Threadnote5ObservationV1,
  derivedByDigest: ReadonlyMap<string, DerivedClaims>,
): {
  readonly claimsMismatch: boolean;
  readonly verification: Threadnote5ScenarioReceiptVerificationV1;
} {
  const {assertions, measurements, missingKinds, verifiedKinds} = collectScenarioClaims(
    observation.scenario,
    observation.attestation.subsystemReceipts,
    derivedByDigest,
  );
  if (!unique(EffectArray.map(measurements, measurement => measurement.id))) {
    return {
      claimsMismatch: true,
      verification: scenarioVerification(observation.scenario, verifiedKinds, ['duplicate-derived-metric']),
    };
  }
  const incomplete = missingKinds.length > 0;
  const expectedAssertions = EffectArray.map(
    EffectArray.filter(observation.transcript.assertionResults, result => result.observed),
    result => result.id,
  );
  const claimsMismatch =
    !incomplete &&
    (observation.transcript.outcome !== 'passed' ||
      canonicalJson([...assertions].sort(compareText)) !== canonicalJson([...expectedAssertions].sort(compareText)) ||
      canonicalJson([...measurements].sort(compareMeasurement)) !==
        canonicalJson([...observation.transcript.measurements].sort(compareMeasurement)));
  return {
    claimsMismatch,
    verification: scenarioVerification(
      observation.scenario,
      verifiedKinds,
      claimsMismatch ? ['derived-claims-mismatch'] : missingKinds,
    ),
  };
}

function collectScenarioClaims(
  scenario: Threadnote5ReleaseScenario,
  receipts: readonly {readonly digest: string; readonly kind: string}[],
  derivedByDigest: ReadonlyMap<string, DerivedClaims>,
): {
  readonly assertions: ReadonlySet<string>;
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds: readonly string[];
  readonly verifiedKinds: readonly string[];
} {
  const verifiedKinds: string[] = [];
  const missingKinds: string[] = [];
  const assertions = new Set<string>();
  const measurements: Threadnote5MeasurementV1[] = [];
  const correlationsByKind = new Map<Threadnote5LocalSourceKindV1, Threadnote5DerivedCorrelationsV1>();
  for (const receipt of receipts) {
    if (!isSourceKind(receipt.kind)) {
      missingKinds.push(receipt.kind);
      continue;
    }
    const derived = derivedByDigest.get(receipt.digest);
    if (derived === undefined) {
      missingKinds.push(receipt.kind);
      continue;
    }
    verifiedKinds.push(receipt.kind);
    for (const assertion of derived.assertions) assertions.add(assertion);
    if (derived.correlations !== undefined) correlationsByKind.set(receipt.kind, derived.correlations);
    measurements.push(...derived.measurements);
    missingKinds.push(...(derived.missingKinds ?? []));
  }
  const correlated = correlateScenarioClaims(scenario, correlationsByKind);
  for (const assertion of correlated.assertions) assertions.add(assertion);
  measurements.push(...correlated.measurements);
  missingKinds.push(...correlated.missingKinds);
  const verifiedKindSet = new Set(verifiedKinds);
  return {
    assertions,
    measurements,
    missingKinds: EffectArray.filter(missingKinds, kind => !verifiedKindSet.has(kind)),
    verifiedKinds,
  };
}

function correlateScenarioClaims(
  scenario: Threadnote5ReleaseScenario,
  correlations: ReadonlyMap<Threadnote5LocalSourceKindV1, Threadnote5DerivedCorrelationsV1>,
): {
  readonly assertions: readonly string[];
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds: readonly string[];
} {
  const feedback = correlations.get('value-report')?.feedbackTrials;
  if (scenario === 'two-agent') {
    const activation = correlations.get('activation');
    const recall = correlations.get('recall');
    const value = correlations.get('value-report');
    if (
      !sameCorrelationSet(activation?.secondSurfaceProofs, recall?.secondSurfaceProofs) ||
      !sameCorrelationSet(activation?.activationValues, value?.activationValues) ||
      !sameLaneSet(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(recall?.secondSurfaceProofs), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, proof => proof.proofHash),
          ),
        ),
        feedback,
      )
    ) {
      return {
        assertions: [],
        measurements: [],
        missingKinds: ['cross-record-correlation'],
      };
    }
    return {
      assertions: ['second-surface-reused-decision', 'activation-receipt-reused-by-value-report'],
      measurements: [],
      missingKinds: [],
    };
  }
  if (scenario === 'git-shared') {
    const sharing = correlations.get('sharing')?.sharedDecisions;
    const recallProofs = correlations.get('recall')?.secondSurfaceProofs;
    const recall = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(recallProofs), __effectArrayReceiver2 =>
        EffectArray.map(__effectArrayReceiver2, sharedDecisionLink),
      ),
    );
    return sameCorrelationSet(sharing, recall) &&
      (feedback === undefined ||
        sameLaneSet(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(recallProofs), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, proof => proof.proofHash),
            ),
          ),
          feedback,
        ))
      ? {
          assertions: ['git-shared-decision-retrieved'],
          measurements: [],
          missingKinds: [],
        }
      : {
          assertions: [],
          measurements: [],
          missingKinds: ['cross-record-correlation'],
        };
  }
  if (scenario === 'solo') {
    const firstBriefs = correlations.get('activation')?.firstBriefs;
    const contextBriefs = correlations.get('context-brief')?.firstBriefs;
    if (firstBriefs === undefined || contextBriefs === undefined || feedback === undefined) {
      return {assertions: [], measurements: [], missingKinds: []};
    }
    if (
      !sameStringSet(
        EffectArray.map(firstBriefs, item => item.laneId),
        EffectArray.map(contextBriefs, item => item.laneId),
      ) ||
      !sameLaneSet(
        EffectArray.map(firstBriefs, item => item.laneId),
        feedback,
      )
    ) {
      return {
        assertions: [],
        measurements: [],
        missingKinds: ['cross-record-correlation'],
      };
    }
    return {
      assertions: [],
      measurements: [
        {
          id: 'time-to-first-cited-correct-plan',
          sampleCount: firstBriefs.length,
          total: EffectArray.reduce(firstBriefs, 0, (sum, item) => sum + item.durationMilliseconds),
        },
      ],
      missingKinds: [],
    };
  }
  if (scenario === 'offline') {
    const firstBriefs = correlations.get('activation')?.firstBriefs;
    if (feedback === undefined) return {assertions: [], measurements: [], missingKinds: []};
    if (
      !sameLaneSet(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(firstBriefs), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, item => item.laneId),
          ),
        ),
        feedback,
      ) ||
      EffectArray.some(feedback, item => !item.offlineVerified)
    ) {
      return {
        assertions: [],
        measurements: [],
        missingKinds: ['cross-record-correlation'],
      };
    }
    return {assertions: [], measurements: [], missingKinds: []};
  }
  return {assertions: [], measurements: [], missingKinds: []};
}

function sameLaneSet(
  lanes: readonly string[] | undefined,
  feedback: readonly Threadnote5FeedbackTrialLinkV1[] | undefined,
) {
  if (lanes === undefined || feedback === undefined || lanes.length === 0 || lanes.length !== feedback.length)
    return false;
  return (
    canonicalJson([...lanes].sort(compareText)) ===
    canonicalJson(EffectArray.map(feedback, item => item.laneId).sort(compareText))
  );
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined || left.length === 0 || left.length !== right.length) return false;
  return canonicalJson([...left].sort(compareText)) === canonicalJson([...right].sort(compareText));
}

function sameCorrelationSet<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === undefined || right === undefined || left.length === 0 || left.length !== right.length) return false;
  const canonical = (values: readonly T[]) => EffectArray.map(values, value => canonicalJson(value)).sort(compareText);
  return canonicalJson(canonical(left)) === canonicalJson(canonical(right));
}

function sharedDecisionLink(proof: Threadnote5SecondSurfaceLinkV1): Threadnote5SharedDecisionLinkV1 {
  const {proofHash: _, ...link} = proof;
  return link;
}

function scenarioVerification(
  scenario: Threadnote5ReleaseScenario,
  verifiedKinds: readonly string[],
  missingKinds: readonly string[],
): Threadnote5ScenarioReceiptVerificationV1 {
  const missing = [...new Set(missingKinds)].sort();
  return {
    missingKinds: missing,
    scenario,
    state: missing.length === 0 ? 'verified' : 'unknown',
    verifiedKinds: [...new Set(verifiedKinds)].sort(),
  };
}

const LOCAL_RECEIPT_ADAPTERS: readonly Threadnote5LocalReceiptAdapterV1[] = [
  {
    acceptedScenarios: ['solo', 'two-agent', 'offline', 'interrupted-resumed'],
    authorityType: () => 'activation-verification',
    derive: (record, authority) => deriveActivation(record.scenario, record.artifact, authority),
    kind: 'activation',
    requiredAuthority: ['activation-live-verification-authority'],
  },
  {
    acceptedScenarios: ['structured-closeout', 'interrupted-resumed', 'output-budgets'],
    derive: record => deriveCloseout(record.scenario, record.artifact, record.candidate),
    kind: 'closeout',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['solo', 'output-budgets'],
    derive: (record, authority) =>
      deriveThreadnote5ContextBriefClaims(record.scenario, record.artifact, record.candidate, authority),
    kind: 'context-brief',
    requiredAuthority: ['context-brief-plan-citation-authority'],
    authorityType: record => (record.scenario === 'solo' ? 'context-brief-plan-citation' : undefined),
  },
  {
    acceptedScenarios: ['dirty-worktree'],
    derive: (record, authority) => deriveContextCheck(record.artifact, record.candidate, authority),
    kind: 'context-check',
    requiredAuthority: ['context-check-read-fence-authority'],
    authorityType: () => 'context-check-read-fence',
  },
  {
    acceptedScenarios: ['stale-citation', 'contradiction-triage', 'health-maintenance'],
    authorityType: record => (record.scenario === 'health-maintenance' ? 'context-health-read-only' : undefined),
    derive: (record, authority) => deriveThreadnote5HealthClaimsV1(record.scenario, record.artifact, authority),
    kind: 'context-health',
    requiredAuthority: ['context-health-schedule-authority', 'context-health-team-aggregate-authority'],
  },
  {
    acceptedScenarios: ['projection-drift'],
    derive: (record, authority) => deriveGuidance(record.artifact, record.candidate, authority),
    kind: 'guidance',
    requiredAuthority: ['guidance-stale-precondition-rejection-authority'],
    authorityType: record =>
      object(record.artifact, 'guidance capture').stalePrecondition === true
        ? 'guidance-stale-precondition-rejection'
        : undefined,
  },
  {
    acceptedScenarios: ['upgrade-downgrade'],
    derive: (record, authority) => deriveMigration(record.artifact, record.candidate, authority),
    kind: 'migration',
    requiredAuthority: ['migration-execution-authority'],
    authorityType: () => 'migration-execution',
  },
  {
    acceptedScenarios: ['verified-procedures'],
    derive: (record, authority) => deriveProcedure(record.artifact, record.candidate, authority),
    kind: 'procedure',
    requiredAuthority: ['procedure-execution-authority'],
    authorityType: () => 'procedure-verification',
  },
  {
    acceptedScenarios: ['solo', 'two-agent', 'git-shared', 'offline'],
    authorityType: () => 'value-report-verification',
    derive: (record, authority) => deriveThreadnote5ValueReportClaims(record.scenario, record.artifact, authority),
    kind: 'value-report',
    requiredAuthority: ['value-report-trial-authority'],
  },
  {
    acceptedScenarios: ['two-agent', 'git-shared'],
    derive: record => deriveRecall(record.scenario, record.artifact),
    kind: 'recall',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['git-shared'],
    derive: record => deriveSharing(record.artifact),
    kind: 'sharing',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['provider-neutral-proposal'],
    derive: (record, authority) => deriveProposal(record.artifact, record.candidate, authority),
    kind: 'git-proposal',
    requiredAuthority: ['git-proposal-review-authority'],
    authorityType: () => 'git-proposal-review',
  },
];

const LOCAL_RECEIPT_ADAPTER_BY_KIND = new Map(
  EffectArray.map(LOCAL_RECEIPT_ADAPTERS, adapter => [adapter.kind, adapter] as const),
);

/** Adapter declarations are exported so capture tooling can reject a mislabeled source before persistence. */
export const THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS = EffectArray.map(LOCAL_RECEIPT_ADAPTERS, adapter => ({
  acceptedScenarios: [...adapter.acceptedScenarios],
  kind: adapter.kind,
  requiredAuthority: [...adapter.requiredAuthority],
}));

function deriveClaims(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const adapter = LOCAL_RECEIPT_ADAPTER_BY_KIND.get(record.kind);
  if (adapter === undefined || !adapter.acceptedScenarios.includes(record.scenario)) {
    throw new Error('Subsystem receipt adapter does not accept this scenario.');
  }
  return adapter.derive(record, authority);
}

/**
 * Replays the retained activation state rather than accepting a terminal receipt as proof.
 * A receipt update can complete exactly one planned operation, so a skipped, repeated, or
 * disconnected revision is rejected before it can contribute a readiness claim.
 */
function deriveActivation(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['trials'], 'activation capture');
  const trialValues = boundedArray(source.trials, 'activation trials', 1, MAX_ATTEMPTS);
  const authorityTrials = authority?.type === 'activation-verification' ? authority.trials : [];
  if (authority?.type !== 'activation-verification') {
    return {
      assertions: [],
      measurements: [],
      missingKinds: ['activation-live-verification-authority'],
    };
  }
  if (authorityTrials.length !== trialValues.length) {
    throw new Error('Activation authority must exactly cover its captured trials.');
  }
  const trials = EffectArray.map(trialValues, trial => {
    const activationId = object(object(trial, 'activation trial').state, 'activation state').plan;
    const plan = parseActivationPlanV1(activationId);
    return parseActivationTrial(
      trial,
      scenario,
      EffectOption.getOrUndefined(
        EffectArray.findFirst(authorityTrials, candidate => candidate.activationId === plan.activationId),
      ),
    );
  });
  if (!unique(EffectArray.map(trials, trial => trial.plan.activationId)))
    throw new Error('Activation trials must be unique.');
  const completed = EffectArray.filter(trials, trial => trial.finalReceipt.status === 'completed').length;
  if (scenario === 'solo') {
    return {
      assertions: EffectArray.every(trials, trial => trial.finalReceipt.firstBrief !== undefined)
        ? ['local-setup-complete']
        : [],
      correlations: {
        firstBriefs: EffectArray.map(trials, trial => trial.firstBriefLink!),
      },
      measurements: [
        {
          eligibleCount: trials.length,
          id: 'setup-success-rate',
          positiveCount: completed,
        },
      ],
    };
  }
  if (scenario === 'two-agent') {
    if (EffectArray.some(trials, trial => !trial.secondSurfaceVerified)) {
      throw new Error('Two-agent activation trial lacks a bound second-surface proof.');
    }
    return {
      assertions: ['two-surfaces-connected'],
      correlations: {
        activationValues: EffectArray.map(trials, activationValueLink),
        secondSurfaceProofs: EffectArray.map(trials, trial => trial.secondSurfaceLink!),
      },
      measurements: [],
    };
  }
  if (scenario === 'offline') {
    if (EffectArray.some(trials, trial => !trial.offlineObserved || trial.finalReceipt.status !== 'completed')) {
      throw new Error('Offline activation trial is incomplete or lacks a zero-attempt network observer.');
    }
    return {
      assertions: ['local-flow-complete', 'network-attempts-zero'],
      correlations: {
        firstBriefs: EffectArray.map(trials, trial => trial.firstBriefLink!),
      },
      measurements: [],
    };
  }
  if (EffectArray.some(trials, trial => !trial.interruptionVerified)) {
    throw new Error('Interrupted activation trial lacks a retained pre-resume receipt.');
  }
  return {
    assertions: ['completed-step-not-repeated', 'resume-receipt-accepted'],
    measurements: [],
  };
}

interface ParsedActivationTrialV1 {
  readonly finalReceipt: ActivationReceiptV1;
  readonly firstBriefLink?: Threadnote5FirstBriefLinkV1;
  readonly interruptionVerified: boolean;
  readonly offlineObserved: boolean;
  readonly plan: ActivationPlanV1;
  readonly secondSurfaceLink?: Threadnote5SecondSurfaceLinkV1;
  readonly secondSurfaceVerified: boolean;
}

function parseActivationTrial(
  value: unknown,
  scenario: Threadnote5ReleaseScenario,
  authority:
    Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'activation-verification'}>['trials'][number] | undefined,
): ParsedActivationTrialV1 {
  const trial = object(value, 'activation trial');
  if (
    !allowedKeys(trial, [
      'approvals',
      'events',
      'offlineObservation',
      'receiptChain',
      'resumeBoundaryRevision',
      'secondSurface',
      'state',
    ])
  ) {
    throw new Error('Activation trial has unsupported fields.');
  }
  const state = exactObject(trial.state, ['plan', 'receipt'], 'activation state');
  const plan = parseActivationPlanV1(state.plan);
  const finalReceipt = parseActivationReceiptV1(state.receipt);
  const chain = EffectArray.map(
    boundedArray(trial.receiptChain, 'activation receipt chain', 1, 16),
    parseActivationReceiptV1,
  );
  const approvals = EffectArray.map(
    boundedArray(trial.approvals, 'activation approvals', 0, 16),
    parseActivationApproval,
  );
  if (canonicalJson(chain.at(-1)) !== canonicalJson(finalReceipt)) {
    throw new Error('Activation receipt chain does not end at the retained state.');
  }
  verifyActivationReceiptChain(plan, chain, approvals);
  if (
    authority === undefined ||
    authority.finalReceiptRevision !== finalReceipt.revision ||
    authority.activationId !== plan.activationId
  ) {
    throw new Error('Activation trial is not covered by its independent authority.');
  }
  const secondSurfaceLink =
    scenario === 'two-agent' && trial.secondSurface !== undefined
      ? verifySecondSurfaceCapture(trial.secondSurface, plan, chain, finalReceipt, authority?.attestationDigest ?? null)
      : undefined;
  const secondSurfaceVerified = secondSurfaceLink !== undefined;
  const offlineObserved =
    scenario === 'offline' && trial.offlineObservation !== undefined
      ? verifyOfflineObservation(trial.offlineObservation, chain, authority?.offlineObservationDigest ?? null)
      : false;
  const interruptionVerified =
    scenario === 'interrupted-resumed' &&
    typeof trial.resumeBoundaryRevision === 'string' &&
    authority?.resumeBoundaryRevision === trial.resumeBoundaryRevision &&
    resumeBoundaryIsVerified(chain, trial.resumeBoundaryRevision);
  if (scenario === 'two-agent' && !secondSurfaceVerified)
    throw new Error('Activation second-surface evidence is absent.');
  if (scenario === 'offline' && !offlineObserved) throw new Error('Activation offline observer is absent.');
  if (scenario === 'interrupted-resumed' && !interruptionVerified) {
    throw new Error('Activation resume evidence is absent.');
  }
  const firstBriefLink = activationFirstBriefLink(plan, chain);
  if ((scenario === 'solo' || scenario === 'offline') && firstBriefLink === undefined) {
    throw new Error('Activation trial lacks a first Context Brief receipt.');
  }
  return {
    finalReceipt,
    ...(firstBriefLink === undefined ? {} : {firstBriefLink}),
    interruptionVerified,
    offlineObserved,
    plan,
    secondSurfaceLink,
    secondSurfaceVerified,
  };
}

function activationFirstBriefLink(
  plan: ActivationPlanV1,
  chain: readonly ActivationReceiptV1[],
): Threadnote5FirstBriefLinkV1 | undefined {
  const receipt = EffectOption.getOrUndefined(EffectArray.findFirst(chain, item => item.firstBrief !== undefined));
  if (receipt?.firstBrief === undefined) return undefined;
  const identity = {
    activationId: plan.activationId,
    activationReceiptRevision: receipt.revision,
    completedAt: receipt.firstBrief.completedAt,
  };
  return {
    ...identity,
    durationMilliseconds: receipt.firstBrief.durationMilliseconds,
    laneId: sha256HexSync(`threadnote-5-first-brief-lane-v1\0${canonicalJson(identity)}`),
  };
}

function verifyActivationReceiptChain(
  plan: ActivationPlanV1,
  chain: readonly ActivationReceiptV1[],
  approvals: readonly ActivationApprovalV1[],
): void {
  const initial = chain[0];
  if (canonicalJson(initial) !== canonicalJson(createActivationReceiptV1(plan, initial.startedAt))) {
    throw new Error('Activation receipt chain must begin with the initial persisted receipt.');
  }
  const approvalsByHash = new Map(EffectArray.map(approvals, approval => [approval.approvalHash, approval] as const));
  if (approvalsByHash.size !== approvals.length) throw new Error('Activation approvals must be unique.');
  const usedApprovals = new Set<string>();
  for (let index = 0; index < chain.length; index += 1) {
    const receipt = chain[index];
    if (
      receipt.activationId !== plan.activationId ||
      receipt.planHash !== plan.planHash ||
      activationReceiptRevisionV1(receipt) !== receipt.revision ||
      receipt.operations.length !== plan.operations.length ||
      EffectArray.some(
        receipt.operations,
        (operation, operationIndex) =>
          operation.id !== plan.operations[operationIndex]?.id ||
          operation.kind !== plan.operations[operationIndex]?.kind ||
          operation.inputHash !== plan.operations[operationIndex]?.inputHash,
      )
    ) {
      throw new Error('Activation receipt does not bind to the parsed plan.');
    }
    if (index === 0) continue;
    const previous = chain[index - 1];
    const resume = previewActivationResumeV1(plan, previous);
    const operation =
      resume.status === 'completed' || resume.status === 'drifted'
        ? undefined
        : EffectOption.getOrUndefined(
            EffectArray.findFirst(receipt.operations, candidate => candidate.id === resume.operationId),
          );
    const approvalHash = operation?.approvalHash;
    const approval = approvalHash === undefined ? undefined : approvalsByHash.get(approvalHash);
    if (!activationReceiptTransitionMatchesV1(plan, previous, receipt, approval)) {
      throw new Error('Activation receipt update is not a production-valid transition.');
    }
    if (approvalHash !== undefined) usedApprovals.add(approvalHash);
  }
  if (usedApprovals.size !== approvals.length) throw new Error('Activation approval evidence is unused.');
}

function parseActivationApproval(value: unknown): ActivationApprovalV1 {
  const source = exactObject(
    value,
    [
      'approvalHash',
      'approved',
      'kind',
      'operationId',
      'planHash',
      'receiptRevision',
      'reviewRevisionHash',
      'type',
      'version',
    ],
    'activation approval',
  );
  return Schema.decodeUnknownSync(ActivationApprovalSchema)(source);
}

function verifySecondSurfaceCapture(
  value: unknown,
  plan: ActivationPlanV1,
  chain: readonly ActivationReceiptV1[],
  receipt: ActivationReceiptV1,
  authorityDigest: string | null,
): Threadnote5SecondSurfaceLinkV1 | undefined {
  const capture = exactObject(value, ['challenge'], 'second-surface capture');
  const challenge = parseSecondSurfaceProofChallengeV1(capture.challenge);
  if (challenge.receipt === undefined || authorityDigest !== threadnote5ActivationAttestationDigest(challenge)) {
    return undefined;
  }
  const attestation = parseSecondSurfaceProofAttestationV1(challenge.receipt);
  const proof = parseSecondSurfaceProofReceiptV1(attestation.proof);
  if (!secondSurfaceProofMatchesContextV1(challenge.context, proof)) return undefined;
  const proofTransition = EffectOption.getOrElse(
    EffectArray.findFirstIndex(
      chain,
      __effectArrayValue =>
        !!(receipt =>
          EffectArray.some(
            receipt.operations,
            operation => operation.kind === 'secondary.prove' && operation.status === 'verified',
          ))(__effectArrayValue),
    ),
    () => -1,
  );
  const proofPrevious = proofTransition > 0 ? chain[proofTransition - 1] : undefined;
  if (
    challenge.context.activationId !== plan.activationId ||
    challenge.context.activationReceiptRevision !== proofPrevious?.revision ||
    EffectOption.getOrUndefined(
      EffectArray.findFirst(receipt.operations, operation => operation.kind === 'secondary.prove'),
    )?.subsystemReceiptHash !== proof.proofHash
  ) {
    return undefined;
  }
  return secondSurfaceLink(proof);
}

function verifyOfflineObservation(
  value: unknown,
  chain: readonly ActivationReceiptV1[],
  authorityDigest: string | null,
): boolean {
  const observation = exactObject(
    value,
    ['afterAttemptCount', 'afterRevision', 'beforeAttemptCount', 'beforeRevision'],
    'offline network observation',
  );
  return (
    observation.beforeAttemptCount === 0 &&
    observation.afterAttemptCount === 0 &&
    observation.beforeRevision === chain[0]?.revision &&
    observation.afterRevision === chain.at(-1)?.revision &&
    authorityDigest === threadnote5ActivationOfflineObservationDigest(observation)
  );
}

function resumeBoundaryIsVerified(chain: readonly ActivationReceiptV1[], boundaryRevision: string): boolean {
  const boundaryIndex = EffectOption.getOrElse(
    EffectArray.findFirstIndex(chain, receipt => receipt.revision === boundaryRevision),
    () => -1,
  );
  return boundaryIndex > 0 && boundaryIndex < chain.length - 1;
}

function deriveRecall(_scenario: Threadnote5ReleaseScenario, value: unknown): DerivedClaims {
  const source = exactObject(value, ['trials'], 'recall capture');
  const trials = EffectArray.map(boundedArray(source.trials, 'recall trials', 1, MAX_ATTEMPTS), trial => {
    const item = exactObject(trial, ['proof'], 'recall trial');
    return parseSecondSurfaceProofReceiptV1(item.proof);
  });
  if (!unique(EffectArray.map(trials, trial => trial.proofHash))) throw new Error('Recall trials must be unique.');
  return {
    assertions: [],
    correlations: {
      secondSurfaceProofs: EffectArray.map(trials, secondSurfaceLink),
    },
    measurements: [],
  };
}

function deriveSharing(value: unknown): DerivedClaims {
  const source = exactObject(value, ['trials'], 'sharing capture');
  const links = EffectArray.map(boundedArray(source.trials, 'sharing trials', 1, MAX_ATTEMPTS), trial => {
    const item = exactObject(trial, ['decision', 'plan', 'receipt'], 'sharing trial');
    const plan = parseActivationPlanV1(item.plan);
    const receipt = parseActivationReceiptV1(item.receipt);
    const publication = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        receipt.operations,
        operation => operation.kind === 'decision.publish' || operation.kind === 'decision.propose',
      ),
    );
    const next = previewActivationResumeV1(plan, receipt);
    const decision = exactObject(
      item.decision,
      ['canonicalUri', 'contentHash', 'memoryId', 'publicationReceiptHash'],
      'shared decision',
    );
    if (
      receipt.planHash !== plan.planHash ||
      publication === undefined ||
      (publication.status !== 'applied' && publication.status !== 'already-current') ||
      publication.subsystemReceiptHash !== decision.publicationReceiptHash ||
      next.status === 'completed' ||
      next.status === 'drifted' ||
      next.operationId !== 'secondary-proof' ||
      !hash(decision.contentHash) ||
      !hash(decision.publicationReceiptHash) ||
      !nonEmptyText(decision.canonicalUri, 1_024) ||
      !nonEmptyText(decision.memoryId, 160)
    ) {
      throw new Error('Sharing capture has no completed activation publication receipt.');
    }
    return {
      activationId: plan.activationId,
      activationReceiptRevision: receipt.revision,
      decisionCanonicalUri: decision.canonicalUri,
      decisionContentHash: decision.contentHash,
      decisionMemoryId: decision.memoryId,
      publicationReceiptHash: decision.publicationReceiptHash,
    };
  });
  if (!unique(EffectArray.map(links, link => `${link.activationId}\0${link.activationReceiptRevision}`))) {
    throw new Error('Sharing trials must be unique.');
  }
  return {
    assertions: [],
    correlations: {sharedDecisions: links},
    measurements: [],
  };
}

function activationValueLink(trial: ParsedActivationTrialV1): Threadnote5ActivationValueLinkV1 {
  return {
    activationId: trial.plan.activationId,
    finalReceiptRevision: trial.finalReceipt.revision,
  };
}

function secondSurfaceLink(proof: SecondSurfaceProofReceiptV1): Threadnote5SecondSurfaceLinkV1 {
  return {
    activationId: proof.activationId,
    activationReceiptRevision: proof.activationReceiptRevision,
    decisionCanonicalUri: proof.decisionCanonicalUri,
    decisionContentHash: proof.decisionContentHash,
    decisionMemoryId: proof.decisionMemoryId,
    proofHash: proof.proofHash,
    publicationReceiptHash: proof.publicationReceiptHash,
  };
}

function deriveContextCheck(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const capture = exactObject(
    value,
    ['graphEvidence', 'readFence', 'reportJson', 'repositoryEvidence'],
    'Context Check capture',
  );
  const report = parseContextCheckReportJson(text(capture.reportJson, 'Context Check report JSON', 256 * 1024));
  const repository = captureBoundary(capture.repositoryEvidence, candidate, 'repository evidence', ['dirty']);
  const graph = captureBoundary(capture.graphEvidence, candidate, 'graph evidence', ['state']);
  const fence = captureBoundary(capture.readFence, candidate, 'Context Check read fence', ['state']);
  const reportProvesUnknownOutcome =
    (report.version === 1 &&
      report.exitClassification === 'invalid-or-required-evidence-unavailable' &&
      report.exitCode === 2) ||
    (report.version === 2 && report.exitClassification === 'clean-with-evidence-warning' && report.exitCode === 0);
  if (
    repository.dirty !== true ||
    graph.state !== 'incomplete' ||
    fence.state !== 'unknown' ||
    report.evidenceStatus !== 'unavailable' ||
    !reportProvesUnknownOutcome
  ) {
    throw new Error('Context Check capture does not prove dirty evidence is non-current and the outcome is unknown.');
  }
  if (authority?.type !== 'context-check-read-fence' || !authority.assertions.includes('dirty-evidence-not-current')) {
    return {
      assertions: [],
      measurements: [],
      missingKinds: ['context-check-read-fence-authority'],
    };
  }
  return {
    assertions: ['dirty-evidence-not-current', 'outcome-unknown'],
    measurements: [],
  };
}

function deriveGuidance(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const capture = exactObject(
    value,
    ['after', 'afterText', 'before', 'beforeText', 'candidate', 'current', 'preview', 'sources', 'stalePrecondition'],
    'guidance capture',
  );
  if (!sameSource(parseThreadnote5TrustedSourceV1(capture.candidate, 'candidate'), candidate)) {
    throw new Error('Guidance capture candidate identity is mismatched.');
  }
  const current = guidanceReceipt(capture.current, 'current GuidanceReceiptV2');
  const expected = {
    project: current.project,
    repositoryId: current.repositoryId,
    targetIdentity: current.targetIdentity,
    targetPath: current.targetPath,
  };
  const before = parseGuidanceReceiptV2(capture.before, expected);
  const after = parseGuidanceReceiptV2(capture.after, expected);
  const preview = parseGuidanceReceiptV2(capture.preview, expected);
  if (!EffectArray.isArray(capture.sources) || capture.sources.length === 0 || capture.sources.length > 64) {
    throw new Error('Guidance capture must retain bounded source receipts.');
  }
  const sources = EffectArray.map(capture.sources, source => {
    const entry = exactObject(source, ['contentHash', 'text', 'uri'], 'guidance source');
    const contentHash = text(entry.contentHash, 'guidance source hash', 64);
    const sourceText = text(entry.text, 'guidance source text', 60 * 1024);
    if (!hash(contentHash) || sha256HexSync(sourceText) !== contentHash)
      throw new Error('Guidance source content hash is invalid.');
    return {
      contentHash,
      text: sourceText,
      uri: text(entry.uri, 'guidance source URI', 4_096),
    };
  });
  if (!unique(EffectArray.map(sources, source => source.uri)))
    throw new Error('Guidance capture source URIs must be unique.');
  const beforeText = text(capture.beforeText, 'guidance before text', 256 * 1024);
  const capturedAfterText = text(capture.afterText, 'guidance after text', 256 * 1024);
  const block = renderManagedGuidanceBlock(sources);
  const afterText = upsertGuidanceBlock(beforeText, block);
  const beforeBlock = guidanceBlock(beforeText);
  const projectedSources = EffectArray.map(
    [...sources].sort((left, right) => compareText(left.uri, right.uri)),
    ({contentHash, uri}) => ({contentHash, uri}),
  );
  if (
    beforeBlock === undefined ||
    stripThreadnoteManagedGuidance(beforeText) !== stripThreadnoteManagedGuidance(afterText) ||
    capturedAfterText !== afterText ||
    sha256HexSync(beforeBlock) !== before.expectedManagedBlockHash ||
    sha256HexSync(block) !== after.expectedManagedBlockHash ||
    canonicalJson(projectedSources) !== canonicalJson(after.sources)
  ) {
    throw new Error('Guidance capture does not prove preservation and managed-block preconditions.');
  }
  if (
    canonicalJson(before) !== canonicalJson(current) ||
    canonicalJson(preview) !== canonicalJson(after) ||
    before.state !== 'current' ||
    after.state !== 'current' ||
    typeof capture.stalePrecondition !== 'boolean'
  ) {
    throw new Error('Guidance capture cannot replay its source, preview, and receipt transition.');
  }
  const staleMissing =
    capture.stalePrecondition &&
    (authority?.type !== 'guidance-stale-precondition-rejection' ||
      !authority.assertions.includes('stale-precondition-rejected'));
  return {
    assertions: ['unmanaged-text-preserved', 'apply-previewed', 'content-precondition-checked'],
    measurements: [],
    ...(staleMissing ? {missingKinds: ['guidance-stale-precondition-rejection-authority']} : {}),
  };
}

function deriveMigration(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const capture = exactObject(value, ['baseline', 'candidate', 'downgrade', 'upgrade'], 'migration capture');
  const baseline = parseThreadnote5TrustedSourceV1(capture.baseline, 'baseline');
  const capturedCandidate = parseThreadnote5TrustedSourceV1(capture.candidate, 'candidate');
  if (!sameSource(capturedCandidate, candidate)) throw new Error('Migration capture candidate identity is mismatched.');
  const upgrade = migrationExecution(capture.upgrade, baseline, candidate, 'upgrade');
  const downgrade = migrationExecution(capture.downgrade, candidate, baseline, 'downgrade');
  if (authority?.type !== 'migration-execution' || !authority.assertions.includes('migration-runtime-executed')) {
    return {
      assertions: [],
      measurements: [],
      missingKinds: ['migration-execution-authority'],
    };
  }
  const assertions = [
    ...(upgrade.outcome === 'readable' ? ['upgrade-readable'] : []),
    ...(downgrade.outcome === 'readable' || downgrade.outcome === 'safe-refusal'
      ? ['downgrade-readable-or-safe-refusal']
      : []),
    ...(upgrade.protectedWriteCount === 0 && downgrade.protectedWriteCount === 0 ? ['destructive-mutations-zero'] : []),
  ];
  return {assertions, measurements: []};
}

function guidanceReceipt(value: unknown, label: string) {
  const raw = object(value, label);
  return parseGuidanceReceiptV2(value, {
    project: text(raw.project, `${label} project`, 256),
    repositoryId: text(raw.repositoryId, `${label} repository id`, 4_096),
    targetIdentity: text(raw.targetIdentity, `${label} target identity`, 4_096),
    targetPath: text(raw.targetPath, `${label} target path`, 1_024),
  });
}

function captureBoundary(
  value: unknown,
  candidate: Threadnote5SourceV1,
  label: string,
  required: readonly string[],
): Record<string, unknown> {
  const boundary = object(value, label);
  if (
    !allowedKeys(boundary, ['candidate', 'digest', ...required]) ||
    EffectRecord.keys(boundary).length !== required.length + 2
  ) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  if (
    !hash(boundary.digest) ||
    !sameSource(parseThreadnote5TrustedSourceV1(boundary.candidate, 'candidate'), candidate)
  ) {
    throw new Error(`${label} is not bound to the candidate.`);
  }
  return boundary;
}

function migrationExecution(
  value: unknown,
  from: Threadnote5SourceV1,
  to: Threadnote5SourceV1,
  label: string,
): {
  readonly outcome: 'readable' | 'safe-refusal';
  readonly protectedWriteCount: number;
} {
  const execution = exactObject(
    value,
    ['afterDigest', 'beforeDigest', 'from', 'outcome', 'protectedWriteCount', 'to'],
    `${label} migration execution`,
  );
  if (
    !hash(execution.beforeDigest) ||
    !hash(execution.afterDigest) ||
    !sameSource(
      parseThreadnote5TrustedSourceV1(execution.from, from.id === 'threadnote-4.7.x' ? 'baseline' : 'candidate'),
      from,
    ) ||
    !sameSource(
      parseThreadnote5TrustedSourceV1(execution.to, to.id === 'threadnote-4.7.x' ? 'baseline' : 'candidate'),
      to,
    ) ||
    !integerIn(execution.protectedWriteCount, 0, MAX_ATTEMPTS) ||
    (execution.outcome !== 'readable' && execution.outcome !== 'safe-refusal')
  ) {
    throw new Error(`${label} migration execution is invalid.`);
  }
  return {
    outcome: execution.outcome,
    protectedWriteCount: execution.protectedWriteCount,
  };
}

function deriveCloseout(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  candidate: Threadnote5SourceV1,
): DerivedClaims {
  const source = exactObject(value, ['reviews'], 'closeout artifact');
  const reviews = EffectArray.map(boundedArray(source.reviews, 'closeout reviews', 1, MAX_ATTEMPTS), review =>
    strictCandidateReview(review, candidate),
  );
  if (!unique(EffectArray.map(reviews, review => review.reviewId))) throw new Error('Closeout trials must be unique.');
  const completed = EffectArray.filter(reviews, review =>
    EffectArray.some(review.candidates, candidate => candidateIsApplied(candidate, review)),
  ).length;
  if (scenario === 'structured-closeout') {
    return {
      assertions: [
        'decisions-rationale-present',
        'constraints-present',
        'verification-present',
        'invalidations-present',
        'unresolved-risks-present',
      ],
      measurements: [
        {
          eligibleCount: reviews.length,
          id: 'knowledge-delta-completion-rate',
          positiveCount: completed,
        },
      ],
    };
  }
  if (scenario === 'output-budgets') {
    return {
      assertions: ['knowledge-delta-items-at-most-three'],
      measurements: [],
      missingKinds: ['context-brief'],
    };
  }
  return {
    assertions: [],
    measurements:
      scenario === 'interrupted-resumed'
        ? [
            {
              eligibleCount: reviews.length,
              id: 'knowledge-delta-completion-rate',
              positiveCount: completed,
            },
          ]
        : [],
    missingKinds: ['activation'],
  };
}

function deriveProposal(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['attempts'], 'Git proposal artifact');
  const attempts = boundedArray(source.attempts, 'Git proposal attempts', 1, MAX_ATTEMPTS);
  const authorityTrials: Array<
    Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'git-proposal-review'}>['trials'][number]
  > = [];
  for (const attemptValue of attempts) {
    const attempt = exactObject(attemptValue, ['artifact', 'input', 'proposal', 'review'], 'Git proposal attempt');
    if (typeof attempt.artifact !== 'string') throw new Error('Git proposal artifact must be text.');
    const review = strictCandidateReview(attempt.review, candidate);
    const input = exactObject(attempt.input, ['baseCommit', 'mutations', 'project', 'target'], 'Git proposal input');
    const mutations = EffectArray.map(boundedArray(input.mutations, 'Git proposal mutations', 1, 3), mutation =>
      Schema.decodeUnknownSync(ReviewedSharedMemoryMutationSchema)(mutation),
    );
    for (const mutation of mutations) assertMutationApproval(review, mutation);
    const target = exactObject(input.target, ['repositoryId', 'team'], 'Git proposal target');
    const rebuilt = buildKnowledgeDeltaGitProposalV1({
      baseCommit: text(input.baseCommit, 'Git proposal base commit', 64),
      delta: projectKnowledgeDeltaV1(review),
      mutations,
      project: text(input.project, 'Git proposal project', 256),
      target: {
        repositoryId: text(target.repositoryId, 'Git proposal repository id', 256),
        team: text(target.team, 'Git proposal team', 256),
      },
    });
    if (attempt.artifact !== rebuilt.artifact || canonicalJson(attempt.proposal) !== canonicalJson(rebuilt.proposal)) {
      throw new Error('Git proposal does not reconstruct from its reviewed source evidence.');
    }
    const approvals = EffectArray.map(mutations, mutation => {
      const applyEvent = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          review.auditEvents,
          event => event.action === 'apply' && event.candidateId === mutation.candidateId,
        ),
      );
      if (applyEvent === undefined) throw new Error('Git proposal approval has no apply audit event.');
      return {
        applyAuditDigest: threadnote5ApplyAuditDigest(applyEvent),
        approvedContentHash: mutation.approval.expectedSourceContentHash,
        candidateId: mutation.candidateId,
        sourceUriHash: threadnote5ApprovedSourceUriHash(mutation.sourceUri),
      };
    }).sort((left, right) => Effect2.pipe(left.candidateId, EffectString.localeCompare(right.candidateId)));
    authorityTrials.push({
      approvals,
      proposalHash: rebuilt.proposal.proposalHash,
      providerApiCallCount: 0,
      reviewId: review.reviewId,
      revision: review.revision,
    });
  }
  if (!unique(EffectArray.map(authorityTrials, trial => trial.proposalHash)))
    throw new Error('Git proposal trials must be unique.');
  if (authority === undefined) {
    return {
      assertions: ['proposal-provider-neutral'],
      measurements: [],
      missingKinds: ['git-proposal-review-authority', 'provider-call-audit'],
    };
  }
  if (
    authority.type !== 'git-proposal-review' ||
    canonicalJson(authority.trials) !==
      canonicalJson(
        [...authorityTrials].sort((left, right) =>
          Effect2.pipe(left.proposalHash, EffectString.localeCompare(right.proposalHash)),
        ),
      ) ||
    EffectArray.some(authority.trials, trial => trial.providerApiCallCount !== 0)
  ) {
    throw new Error('Git proposal authority does not match independently reviewed apply/provider evidence.');
  }
  return {
    assertions: ['provider-apis-zero', 'proposal-provider-neutral', 'proposal-review-approved'],
    measurements: [
      {
        eligibleCount: attempts.length,
        id: 'knowledge-delta-completion-rate',
        positiveCount: attempts.length,
      },
    ],
  };
}

function deriveProcedure(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['attempts'], 'procedure artifact');
  const attempts = boundedArray(source.attempts, 'procedure attempts', 1, 1);
  let expectedAuthority:
    | Omit<
        Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'procedure-verification'}>,
        'recordDigest' | 'type'
      >
    | undefined;
  for (const attemptValue of attempts) {
    const attempt = exactObject(attemptValue, ['artifactText', 'manifest', 'statusInput'], 'procedure attempt');
    if (typeof attempt.artifactText !== 'string') throw new Error('Procedure artifact text is required.');
    const manifest = parseProcedureManifest(attempt.manifest);
    const statusInput = Schema.decodeUnknownSync(ProcedureStatusInputSchema)(attempt.statusInput);
    const receipt = parseProcedureVerificationReceipt(object(statusInput, 'procedure status input').receipt);
    if (
      sha256HexSync(attempt.artifactText) !== manifest.artifact.sha256 ||
      manifest.dependencies.length !== 0 ||
      receipt.threadnoteVersion !== candidate.version ||
      procedureStatus(manifest, {
        ...statusInput,
        localArtifactSha256: sha256HexSync(attempt.artifactText),
      }) !== 'current'
    ) {
      throw new Error('Procedure evidence is not current and dependency-compatible for this candidate.');
    }
    expectedAuthority = {
      artifactId: manifest.artifact.id,
      automaticExecutionCount: 0,
      commandResults: EffectArray.map(manifest.verification.commands, command => ({
        commandId: command.id,
        exitCode: 0,
        outputDigest: '',
      })),
      receiptDigest: threadnote5ProcedureVerificationReceiptDigest(receipt),
      semanticVersion: manifest.artifact.semanticVersion,
    };
  }
  if (authority === undefined) {
    return {
      assertions: ['procedure-dependencies-compatible'],
      measurements: [],
      missingKinds: ['procedure-execution-authority'],
    };
  }
  if (authority.type !== 'procedure-verification' || expectedAuthority === undefined) {
    throw new Error('Procedure authority type does not match its source record.');
  }
  if (
    authority.artifactId !== expectedAuthority.artifactId ||
    authority.semanticVersion !== expectedAuthority.semanticVersion ||
    authority.receiptDigest !== expectedAuthority.receiptDigest ||
    authority.automaticExecutionCount !== 0 ||
    canonicalJson(
      EffectArray.map(authority.commandResults, result => ({
        commandId: result.commandId,
        exitCode: result.exitCode,
      })),
    ) !==
      canonicalJson(
        EffectArray.map(expectedAuthority.commandResults, result => ({
          commandId: result.commandId,
          exitCode: 0,
        })),
      ) ||
    EffectArray.some(authority.commandResults, result => result.exitCode !== 0)
  ) {
    throw new Error('Procedure authority does not prove explicit successful verification without auto-execution.');
  }
  return {
    assertions: ['procedure-receipt-current', 'procedure-dependencies-compatible', 'procedure-never-auto-executed'],
    measurements: [],
  };
}

function strictCandidateReview(value: unknown, candidate: Threadnote5SourceV1): CandidateReview {
  const source = object(value, 'candidate review');
  if (
    !allowedKeys(source, [
      'auditEvents',
      'candidates',
      'codeCitations',
      'createdAt',
      'outcome',
      'project',
      'reviewId',
      'revision',
      'sourceAgentClient',
      'sourceCommit',
      'sourceSessionId',
      'structuredCloseout',
      'task',
      'topic',
      'version',
    ]) ||
    source.version !== 2 ||
    typeof source.reviewId !== 'string' ||
    !/^review-[0-9a-f]{16}$/u.test(source.reviewId) ||
    !integerIn(source.revision, 1, 10_000) ||
    !isoInstant(source.createdAt) ||
    !nonEmptyText(source.outcome, 4_000) ||
    !nonEmptyText(source.project, 256) ||
    !nonEmptyText(source.sourceAgentClient, 256) ||
    source.sourceCommit !== candidate.commit ||
    !nonEmptyText(source.task, 4_000) ||
    !nonEmptyText(source.topic, 256) ||
    !EffectArray.isArray(source.candidates) ||
    source.candidates.length < 1 ||
    source.candidates.length > 3 ||
    !EffectArray.isArray(source.auditEvents) ||
    source.auditEvents.length < 1 ||
    source.auditEvents.length > 100 ||
    !EffectArray.isArray(source.codeCitations)
  ) {
    throw new Error('Candidate review is not a bounded v2 review.');
  }
  strictStructuredCloseout(source.structuredCloseout);
  const review = parseCandidateReview(value);
  if (review.auditEvents.length !== source.auditEvents.length)
    throw new Error('Candidate review contains invalid audit events.');
  const ids = EffectArray.map(review.candidates, candidate => candidate.candidateId);
  if (
    !unique(ids) ||
    !EffectArray.every(review.candidates, candidate => candidateIsReviewedDecision(candidate, review))
  ) {
    throw new Error('Candidate review does not contain valid durable decision candidates.');
  }
  if (!EffectArray.every(review.auditEvents, event => strictAuditEvent(event, review, new Set(ids)))) {
    throw new Error('Candidate review audit history is malformed or crosses review identities.');
  }
  if (
    !EffectArray.some(
      review.auditEvents,
      event => event.action === 'create_review' && event.reviewId === review.reviewId && event.revision === 1,
    )
  ) {
    throw new Error('Candidate review has no source create-review audit event.');
  }
  const closeout = review.structuredCloseout;
  if (
    closeout === undefined ||
    Effect2.pipe(closeout.rationale, EffectString.trim).length === 0 ||
    closeout.constraints.length === 0 ||
    closeout.verificationPerformed.length === 0 ||
    closeout.knowledgeInvalidated.length === 0 ||
    closeout.unresolvedRisks.length === 0
  ) {
    throw new Error('Candidate review does not contain the exact five structured-closeout fields.');
  }
  return review;
}

function strictStructuredCloseout(value: unknown): void {
  const source = exactObject(
    value,
    ['constraints', 'knowledgeInvalidated', 'rationale', 'type', 'unresolvedRisks', 'verificationPerformed', 'version'],
    'structured closeout',
  );
  if (source.type !== 'structured-closeout' || source.version !== 1 || !nonEmptyText(source.rationale, 4_000)) {
    throw new Error('Structured closeout identity or rationale is invalid.');
  }
  for (const field of ['constraints', 'knowledgeInvalidated', 'unresolvedRisks', 'verificationPerformed'] as const) {
    const items = source[field];
    if (
      !EffectArray.isArray(items) ||
      items.length < 1 ||
      items.length > 32 ||
      !EffectArray.every(items, item => nonEmptyText(item, 2_000) && Effect2.pipe(item, EffectString.trim) === item)
    ) {
      throw new Error(`Structured closeout ${field} must contain bounded non-empty items.`);
    }
  }
}

function candidateIsReviewedDecision(
  candidate: MemoryCandidate | LegacyMemoryCandidate,
  review: CandidateReview,
): boolean {
  if (!isMemoryCandidate(candidate)) return false;
  const source = object(candidate, 'candidate');
  return (
    allowedKeys(source, [
      'applyApprovedAt',
      'applyBodyText',
      'applyContentHash',
      'applyOperation',
      'applyReplaceUri',
      'applyStage',
      'applyTargetUri',
      'candidateId',
      'categories',
      'comparison',
      'confidence',
      'evidence',
      'kind',
      'project',
      'proposedText',
      'reason',
      'recommendation',
      'state',
      'targetContentHash',
      'targetUri',
      'topic',
    ]) &&
    new RegExp(`^${review.reviewId}-[1-3]$`, 'u').test(candidate.candidateId) &&
    candidate.kind === 'durable' &&
    ['contradiction', 'duplicate', 'new', 'possible_duplicate', 'replacement'].includes(candidate.comparison) &&
    ['create', 'manual_review', 'no_action', 'replace'].includes(candidate.recommendation) &&
    ['applied', 'applying', 'conflict', 'deferred', 'pending', 'rejected'].includes(candidate.state) &&
    candidate.project === review.project &&
    candidate.topic === review.topic &&
    Effect2.pipe(candidate.proposedText, EffectString.trim).length > 0 &&
    candidate.proposedText.length <= 66_000 &&
    Effect2.pipe(candidate.reason, EffectString.trim).length > 0 &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    EffectArray.isArray(candidate.evidence) &&
    candidate.evidence.length > 0 &&
    candidate.evidence.length <= 34 &&
    EffectArray.every(candidate.evidence, item => nonEmptyText(item, 4_000)) &&
    EffectArray.isArray(candidate.categories) &&
    candidate.categories.length > 0 &&
    candidate.categories.length <= 4 &&
    unique(candidate.categories) &&
    EffectArray.every(candidate.categories, category =>
      EffectArray.some(['decision', 'handoff', 'invariant', 'preference'], allowed => allowed === category),
    ) &&
    EffectArray.some(candidate.categories, category => category === 'decision' || category === 'invariant') &&
    (candidate.applyApprovedAt === undefined || isoInstant(candidate.applyApprovedAt)) &&
    (candidate.applyBodyText === undefined || nonEmptyText(candidate.applyBodyText, 66_000)) &&
    (candidate.applyContentHash === undefined || hash(candidate.applyContentHash)) &&
    (candidate.applyOperation === undefined ||
      candidate.applyOperation === 'create' ||
      candidate.applyOperation === 'replace') &&
    (candidate.applyReplaceUri === undefined || nonEmptyText(candidate.applyReplaceUri, 4_000)) &&
    (candidate.applyStage === undefined ||
      ['cleanup_pending', 'conflict', 'prepared', 'written'].includes(candidate.applyStage)) &&
    (candidate.applyTargetUri === undefined || nonEmptyText(candidate.applyTargetUri, 4_000)) &&
    (candidate.targetContentHash === undefined || hash(candidate.targetContentHash)) &&
    (candidate.targetUri === undefined || nonEmptyText(candidate.targetUri, 4_000))
  );
}

function strictAuditEvent(
  event: CandidateReview['auditEvents'][number],
  review: CandidateReview,
  candidateIds: ReadonlySet<string>,
): boolean {
  const source = object(event, 'audit event');
  return (
    allowedKeys(source, ['action', 'at', 'candidateId', 'memoryUri', 'reviewId', 'revision']) &&
    event.reviewId === review.reviewId &&
    isoInstant(event.at) &&
    integerIn(event.revision, 1, review.revision) &&
    (event.candidateId === undefined || candidateIds.has(event.candidateId)) &&
    (event.memoryUri === undefined || nonEmptyText(event.memoryUri, 4_000)) &&
    (event.action === 'create_review'
      ? event.revision === 1 && event.candidateId === undefined
      : event.candidateId !== undefined)
  );
}

function candidateIsApplied(candidate: MemoryCandidate | LegacyMemoryCandidate, review: CandidateReview): boolean {
  return (
    isMemoryCandidate(candidate) &&
    candidate.state === 'applied' &&
    hash(candidate.applyContentHash) &&
    nonEmptyText(candidate.applyBodyText, 66_000) &&
    nonEmptyText(candidate.applyTargetUri, 4_000) &&
    (candidate.applyOperation === 'create' || candidate.applyOperation === 'replace') &&
    EffectArray.some(
      review.auditEvents,
      event =>
        event.action === 'apply' &&
        event.candidateId === candidate.candidateId &&
        event.reviewId === review.reviewId &&
        event.revision <= review.revision,
    )
  );
}

function assertMutationApproval(
  review: CandidateReview,
  mutation: KnowledgeDeltaGitProposalInputV1['mutations'][number],
): void {
  const candidate = EffectOption.getOrUndefined(
    EffectArray.findFirst(review.candidates, item => item.candidateId === mutation.candidateId),
  );
  if (
    candidate === undefined ||
    !candidateIsApplied(candidate, review) ||
    mutation.approval.reviewId !== review.reviewId ||
    mutation.approval.revision !== review.revision ||
    mutation.approval.expectedSourceContentHash !== candidate.applyContentHash ||
    mutation.sourceUri !== candidate.applyTargetUri
  ) {
    throw new Error('Git proposal approval is not backed by the candidate apply/audit evidence.');
  }
}

function resolveAuthority(
  records: readonly Threadnote5LocalSubsystemReceiptRecordV1[],
  candidate: Threadnote5SourceV1,
  value: unknown,
  expectedHash: string | undefined,
): {
  readonly byRecordDigest: ReadonlyMap<string, Threadnote5LocalAuthorityEntryV1>;
  readonly manifestHash: string | null;
} {
  if (value === undefined && expectedHash === undefined) return {byRecordDigest: new Map(), manifestHash: null};
  if (value === undefined || expectedHash === undefined || !hash(expectedHash)) {
    throw new Error('Local authority manifest and its independently supplied hash are required together.');
  }
  const manifest = parseThreadnote5LocalAuthorityManifestV1(value);
  const manifestHash = threadnote5LocalAuthorityManifestHash(manifest);
  if (manifestHash !== expectedHash || !sameSource(manifest.candidate, candidate)) {
    throw new Error('Local authority manifest does not match its trusted hash or exact candidate.');
  }
  const authorityRecords = EffectArray.filter(records, record => authorityTypeForRecord(record) !== undefined);
  if (manifest.entries.length !== authorityRecords.length) {
    throw new Error('Local authority manifest must exactly cover authority-dependent source records.');
  }
  const byRecordDigest = new Map(EffectArray.map(manifest.entries, entry => [entry.recordDigest, entry] as const));
  for (const record of authorityRecords) {
    const entry = byRecordDigest.get(record.digest);
    if (entry === undefined || entry.type !== authorityTypeForRecord(record)) {
      throw new Error('Local authority entry is missing or mislabeled for its source record.');
    }
  }
  return {byRecordDigest, manifestHash};
}

function authorityTypeForRecord(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): Threadnote5LocalAuthorityEntryV1['type'] | undefined {
  const adapter = LOCAL_RECEIPT_ADAPTER_BY_KIND.get(record.kind);
  if (adapter === undefined || !adapter.acceptedScenarios.includes(record.scenario)) return undefined;
  return adapter.authorityType?.(record);
}

function parseRecord(value: unknown): Threadnote5LocalSubsystemReceiptRecordV1 {
  if (encodedBytes(value) > MAX_RECORD_BYTES) throw new Error('Subsystem record exceeds the byte limit.');
  const record = exactObject(
    value,
    ['artifact', 'candidate', 'digest', 'kind', 'scenario', 'version'],
    'subsystem record',
  );
  if (record.version !== 1 || !hash(record.digest) || !isSourceKind(record.kind)) {
    throw new Error('Subsystem record identity is invalid.');
  }
  return {
    artifact: record.artifact,
    candidate: parseThreadnote5TrustedSourceV1(record.candidate, 'candidate'),
    digest: record.digest,
    kind: record.kind,
    scenario: releaseScenario(record.scenario),
    version: 1,
  };
}
