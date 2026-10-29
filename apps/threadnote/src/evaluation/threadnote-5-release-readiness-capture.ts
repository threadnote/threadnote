import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  parseThreadnote5TrustedSourceV1,
  THREADNOTE_5_RELEASE_SCENARIOS,
  threadnote5CaptureManifestForEvidence,
  threadnote5CaptureManifestHash,
  threadnote5ObservationReceiptHash,
  threadnote5ObservationTranscriptHash,
  threadnote5ReleaseEvidenceHash,
  threadnote5ReleaseReadinessFixtureHash,
  threadnote5SourceHash,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseEvidenceV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5RuntimeIdentityV1,
} from './threadnote-5-release-readiness-contract.js';
import {
  deriveThreadnote5LocalScenarioClaims,
  verifyThreadnote5LocalSubsystemReceipts,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from './threadnote-5-release-readiness-receipts.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const THREADNOTE_5_RELEASE_CAPTURE_VERSION = 1 as const;
const MAX_RUNTIME_BOUNDARIES_BYTES = 256 * 1024;

export interface Threadnote5ScenarioRuntimeBoundaryV1 {
  readonly postRuntime: Threadnote5RuntimeIdentityV1;
  readonly preRuntime: Threadnote5RuntimeIdentityV1;
  readonly scenario: Threadnote5ReleaseScenario;
}

export interface Threadnote5ReleaseCandidateCaptureV1 {
  readonly authorityManifestHash: string;
  readonly evidence: Threadnote5ReleaseEvidenceV1;
  readonly retainedSubsystemReceipts: readonly Threadnote5LocalSubsystemReceiptRecordV1[];
  readonly version: typeof THREADNOTE_5_RELEASE_CAPTURE_VERSION;
}

export function canonicalizeThreadnote5CaptureOutputPathsV1(input: {
  readonly canonicalReceiptsOutputPath: string;
  readonly evidenceOutputPath: string;
  readonly resolvePath: (path: string) => string;
}): {readonly canonicalReceiptsOutputPath: string; readonly evidenceOutputPath: string} {
  const canonicalReceiptsOutputPath = input.resolvePath(input.canonicalReceiptsOutputPath);
  const evidenceOutputPath = input.resolvePath(input.evidenceOutputPath);
  if (canonicalReceiptsOutputPath === evidenceOutputPath) {
    throw new Error('Release capture evidence and canonical receipts outputs must be different files.');
  }
  return {canonicalReceiptsOutputPath, evidenceOutputPath};
}

export function captureThreadnote5ReleaseCandidateV1(input: {
  readonly authorityManifest: unknown;
  readonly candidate: unknown;
  readonly expectedAuthorityManifestSha256: string;
  readonly fixture: unknown;
  readonly retainedSubsystemReceipts: unknown;
  readonly runtimeBoundaries: unknown;
}): Threadnote5ReleaseCandidateCaptureV1 {
  const fixture = parseThreadnote5ReleaseReadinessFixtureV1(input.fixture);
  const candidate = parseThreadnote5TrustedSourceV1(input.candidate, 'candidate');
  const runtimeBoundaries = new Map(
    EffectArray.map(
      canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(
        candidate,
        EffectArray.map(fixture.scenarios, item => item.id),
        input.runtimeBoundaries,
      ),
      boundary => [boundary.scenario, boundary] as const,
    ),
  );
  const derived = deriveThreadnote5LocalScenarioClaims({
    authorityManifest: input.authorityManifest,
    candidate,
    expectedAuthorityManifestSha256: input.expectedAuthorityManifestSha256,
    retainedRecords: input.retainedSubsystemReceipts,
  });
  const expectedRecordCount = EffectArray.reduce(
    fixture.scenarios,
    0,
    (sum, scenario) => sum + scenario.subsystems.length,
  );
  if (fixture.scenarios.length !== 15 || expectedRecordCount !== 24 || derived.records.length !== expectedRecordCount) {
    throw new Error('Production capture requires exactly 15 observations and 24 source records.');
  }
  const claims = new Map(EffectArray.map(derived.scenarios, scenario => [scenario.scenario, scenario] as const));
  for (const contract of fixture.scenarios) {
    const scenarioClaims = claims.get(contract.id);
    if (scenarioClaims === undefined) throw new Error(`Production capture lacks source claims for ${contract.id}.`);
    for (const record of EffectArray.filter(derived.records, item => item.scenario === contract.id)) {
      const count = sourceTrialCount(record);
      const contributesToMetric = scenarioClaims.metricContributingKinds.includes(record.kind);
      if ((!contributesToMetric && count !== 1) || (contributesToMetric && count < 10)) {
        throw new Error(
          `Production capture source ${contract.id}/${record.kind} has invalid ${
            contributesToMetric ? 'measured' : 'static'
          } trial cardinality.`,
        );
      }
    }
  }
  let previousTranscriptDigest: string | null = null;
  const sourceHash = threadnote5SourceHash(candidate);
  const candidateObservations = EffectArray.map(fixture.scenarios, (contract, index) => {
    const scenarioClaims = claims.get(contract.id);
    if (scenarioClaims === undefined || scenarioClaims.missingKinds.length > 0) {
      throw new Error(`Production capture lacks complete source authority for ${contract.id}.`);
    }
    const receipts = EffectArray.map(contract.subsystems, kind => {
      const receipt = EffectOption.getOrUndefined(
        EffectArray.findFirst(scenarioClaims.subsystemReceipts, item => item.kind === kind),
      );
      if (receipt === undefined) throw new Error(`Production capture lacks ${kind} evidence for ${contract.id}.`);
      return receipt;
    });
    if (
      scenarioClaims.subsystemReceipts.length !== contract.subsystems.length ||
      !sameStrings(scenarioClaims.assertions, contract.requiredAssertions)
    ) {
      throw new Error(`Production capture source claims do not match the ${contract.id} contract.`);
    }
    const measurements = EffectArray.map(contract.metricIds, id => {
      const measurement = EffectOption.getOrUndefined(
        EffectArray.findFirst(scenarioClaims.measurements, item => item.id === id),
      );
      const minimum = EffectOption.getOrUndefined(
        EffectArray.findFirst(contract.metricMinimums, item => item.id === id),
      );
      if (
        measurement === undefined ||
        minimum === undefined ||
        measurementEligibleCount(measurement) < minimum.minimumEligibleCount
      ) {
        throw new Error(`Production capture metric ${id} lacks its required trial cardinality for ${contract.id}.`);
      }
      return measurement;
    });
    if (scenarioClaims.measurements.length !== contract.metricIds.length) {
      throw new Error(`Production capture has surplus or mislabeled metrics for ${contract.id}.`);
    }
    const transcript = {
      assertionResults: EffectArray.map(contract.requiredAssertions, id => ({id, observed: true})),
      measurements,
      outcome: 'passed' as const,
      reason: null,
    };
    const transcriptDigest = threadnote5ObservationTranscriptHash(transcript);
    const runtime = runtimeBoundaries.get(contract.id)!;
    const observation = sealObservation({
      attestation: {
        postRuntime: runtime.postRuntime,
        preRuntime: runtime.preRuntime,
        previousTranscriptDigest,
        subsystemReceipts: receipts,
        transcriptDigest,
      },
      observationId: `obs_${Effect.pipe(
        sha256HexSync(`threadnote-5-release-observation-id-v1\0${sourceHash}\0${contract.id}\0${index}`),
        EffectString.slice(0, 32),
      )}`,
      scenario: contract.id,
      sourceHash,
      transcript,
      version: 1,
    });
    previousTranscriptDigest = transcriptDigest;
    return observation;
  });
  const baseline = {reason: 'not-captured', sourceFamily: '4.7.x', state: 'unavailable'} as const;
  const fixtureHash = threadnote5ReleaseReadinessFixtureHash(fixture);
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId: 'threadnote-5-local-task-loop-adapter-v1',
    baseline,
    candidateObservations,
    fixtureHash,
    mode: 'release-candidate',
  });
  const evidenceWithoutHash = {
    baseline,
    candidate,
    candidateObservations,
    capture: {manifest, manifestHash: threadnote5CaptureManifestHash(manifest)},
    fixtureHash,
    suite: 'threadnote-5-release-readiness-evidence' as const,
    version: 1 as const,
  };
  const evidence = parseThreadnote5ReleaseEvidenceV1(
    {...evidenceWithoutHash, evidenceHash: threadnote5ReleaseEvidenceHash(evidenceWithoutHash)},
    fixture,
  );
  const verification = verifyThreadnote5LocalSubsystemReceipts({
    authorityManifest: input.authorityManifest,
    candidate,
    expectedAuthorityManifestSha256: input.expectedAuthorityManifestSha256,
    observations: evidence.candidateObservations,
    retainedRecords: derived.records,
  });
  if (verification.state !== 'verified') {
    throw new Error(`Production capture did not survive source replay: ${verification.reason}.`);
  }
  return {
    authorityManifestHash: derived.authorityManifestHash,
    evidence,
    retainedSubsystemReceipts: derived.records,
    version: THREADNOTE_5_RELEASE_CAPTURE_VERSION,
  };
}

export function canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(
  candidateValue: unknown,
  scenarios: readonly Threadnote5ReleaseScenario[],
  value: unknown,
): readonly Threadnote5ScenarioRuntimeBoundaryV1[] {
  const candidate = parseThreadnote5TrustedSourceV1(candidateValue, 'candidate');
  if (
    !EffectArray.isArray(value) ||
    value.length !== scenarios.length ||
    new TextEncoder().encode(canonicalJson(value)).byteLength > MAX_RUNTIME_BOUNDARIES_BYTES
  ) {
    throw new Error('Production capture runtime boundaries must exactly cover all scenarios within size limits.');
  }
  const expectedRuntime = {executableSha256: candidate.executableSha256, sourceCommit: candidate.commit};
  const boundaries = EffectArray.map(value, parseRuntimeBoundary);
  if (
    new Set(EffectArray.map(boundaries, item => item.scenario)).size !== boundaries.length ||
    !sameStrings(
      EffectArray.map(boundaries, item => item.scenario),
      scenarios,
    ) ||
    EffectArray.some(
      boundaries,
      item =>
        canonicalJson(item.preRuntime) !== canonicalJson(expectedRuntime) ||
        canonicalJson(item.postRuntime) !== canonicalJson(expectedRuntime),
    )
  ) {
    throw new Error('Production capture runtime boundaries are missing, duplicated, mislabeled, or drifting.');
  }
  const order = new Map(EffectArray.map(scenarios, (item, index) => [item, index] as const));
  return [...boundaries].sort((left, right) => order.get(left.scenario)! - order.get(right.scenario)!);
}

function parseRuntimeBoundary(value: unknown): Threadnote5ScenarioRuntimeBoundaryV1 {
  const source = exactObject(value, ['postRuntime', 'preRuntime', 'scenario'], 'runtime boundary');
  return {
    postRuntime: parseRuntime(source.postRuntime, 'post-run runtime'),
    preRuntime: parseRuntime(source.preRuntime, 'pre-run runtime'),
    scenario: scenario(source.scenario),
  };
}

function parseRuntime(value: unknown, label: string): Threadnote5RuntimeIdentityV1 {
  const source = exactObject(value, ['executableSha256', 'sourceCommit'], label);
  return {
    executableSha256: matching(source.executableSha256, /^[0-9a-f]{64}$/u, `${label} executable hash`),
    sourceCommit: matching(source.sourceCommit, /^[0-9a-f]{40}$/u, `${label} source commit`),
  };
}

function sealObservation(observation: Omit<Threadnote5ObservationV1, 'receiptHash'>): Threadnote5ObservationV1 {
  return {...observation, receiptHash: threadnote5ObservationReceiptHash(observation)};
}

function measurementEligibleCount(measurement: Threadnote5MeasurementV1): number {
  return 'sampleCount' in measurement ? measurement.sampleCount : measurement.eligibleCount;
}

function sourceTrialCount(record: Threadnote5LocalSubsystemReceiptRecordV1): number {
  if (!Predicate.isObject(record.artifact))
    throw new Error(`Production capture source ${record.kind} has no structured artifact.`);
  const artifact = record.artifact;
  const values =
    record.kind === 'activation' || record.kind === 'recall' || record.kind === 'sharing'
      ? artifact.trials
      : record.kind === 'closeout'
        ? artifact.reviews
        : record.kind === 'context-brief'
          ? artifact.attempts
          : record.kind === 'git-proposal' || record.kind === 'procedure'
            ? artifact.attempts
            : record.kind === 'value-report'
              ? artifact.feedbackTrials
              : record.kind === 'context-health'
                ? record.scenario === 'health-maintenance'
                  ? artifact.repairs
                  : artifact.reports
                : [record.artifact];
  if (!EffectArray.isArray(values)) throw new Error(`Production capture source ${record.kind} has no bounded trials.`);
  return values.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const source = value;
  if (canonicalJson(EffectRecord.keys(source).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  return source;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function scenario(value: unknown): Threadnote5ReleaseScenario {
  const result =
    typeof value === 'string'
      ? EffectOption.getOrUndefined(
          EffectArray.findFirst(THREADNOTE_5_RELEASE_SCENARIOS, candidate => candidate === value),
        )
      : undefined;
  if (result === undefined) throw new Error('Runtime boundary scenario is invalid.');
  return result;
}
