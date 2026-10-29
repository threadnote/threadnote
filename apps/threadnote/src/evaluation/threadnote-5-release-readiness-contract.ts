import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';

export const THREADNOTE_5_RELEASE_READINESS_VERSION = 1 as const;
export const THREADNOTE_5_RELEASE_READINESS_SUITE = 'threadnote-5-release-readiness' as const;
export const THREADNOTE_5_RELEASE_EVIDENCE_SUITE = 'threadnote-5-release-readiness-evidence' as const;

export const THREADNOTE_5_RELEASE_SCENARIOS = [
  'solo',
  'two-agent',
  'git-shared',
  'offline',
  'dirty-worktree',
  'interrupted-resumed',
  'upgrade-downgrade',
  'provider-neutral-proposal',
  'verified-procedures',
  'health-maintenance',
  'structured-closeout',
  'stale-citation',
  'contradiction-triage',
  'projection-drift',
  'output-budgets',
] as const;

export const THREADNOTE_5_RELEASE_METRICS = [
  'time-to-first-cited-correct-plan',
  'estimated-tokens-to-first-cited-correct-plan',
  'setup-success-rate',
  'wrong-memory-rate',
  'second-agent-reuse-rate',
  'knowledge-delta-completion-rate',
  'health-resolution-rate',
] as const;

export const THREADNOTE_5_RELEASE_SUBSYSTEMS = [
  'activation',
  'closeout',
  'context-brief',
  'context-check',
  'context-health',
  'git-proposal',
  'guidance',
  'migration',
  'procedure',
  'recall',
  'sharing',
  'value-report',
] as const;

export type Threadnote5ReleaseScenario = (typeof THREADNOTE_5_RELEASE_SCENARIOS)[number];
export type Threadnote5ReleaseMetric = (typeof THREADNOTE_5_RELEASE_METRICS)[number];
export type Threadnote5ReleaseSubsystem = (typeof THREADNOTE_5_RELEASE_SUBSYSTEMS)[number];
export type Threadnote5EvidenceClass = 'fixture-replay' | 'release-candidate';
export type Threadnote5ObservationOutcome = 'failed' | 'passed' | 'unknown';

export const THREADNOTE_5_BASELINE_COMMIT = '80ca4acdb7347a4d00b0381f3757a5ac984d9fbf' as const;
export const THREADNOTE_5_BASELINE_VERSION = '4.7.8' as const;
export const THREADNOTE_5_BASELINE_COMPARABLE_METRICS = [
  'time-to-first-cited-correct-plan',
  'estimated-tokens-to-first-cited-correct-plan',
  'wrong-memory-rate',
] as const satisfies readonly Threadnote5ReleaseMetric[];
export const THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS = [
  'setup-success-rate',
  'second-agent-reuse-rate',
  'knowledge-delta-completion-rate',
  'health-resolution-rate',
] as const satisfies readonly Threadnote5ReleaseMetric[];

export interface Threadnote5BaselineComparisonPolicyV1 {
  readonly commit: typeof THREADNOTE_5_BASELINE_COMMIT;
  readonly comparableMetricIds: readonly Threadnote5ReleaseMetric[];
  readonly id: 'threadnote-4.7.x';
  readonly notApplicableMetricIds: readonly Threadnote5ReleaseMetric[];
  readonly version: typeof THREADNOTE_5_BASELINE_VERSION;
}

export const APPROVED_THREADNOTE_5_BASELINE_COMPARISON: Threadnote5BaselineComparisonPolicyV1 = {
  commit: THREADNOTE_5_BASELINE_COMMIT,
  comparableMetricIds: THREADNOTE_5_BASELINE_COMPARABLE_METRICS,
  id: 'threadnote-4.7.x',
  notApplicableMetricIds: THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS,
  version: THREADNOTE_5_BASELINE_VERSION,
};

export interface Threadnote5MetricDefinitionV1 {
  readonly direction: 'higher' | 'lower';
  readonly id: Threadnote5ReleaseMetric;
  readonly kind: 'mean' | 'rate';
  readonly threshold: number;
  readonly thresholdKind: 'maximum' | 'minimum';
  readonly unit: 'milliseconds' | 'ratio' | 'tokens';
}

export interface Threadnote5ScenarioContractV1 {
  readonly id: Threadnote5ReleaseScenario;
  readonly metricIds: readonly Threadnote5ReleaseMetric[];
  readonly metricMinimums: readonly {
    readonly id: Threadnote5ReleaseMetric;
    readonly minimumEligibleCount: number;
  }[];
  readonly requiredAssertions: readonly string[];
  readonly subsystems: readonly Threadnote5ReleaseSubsystem[];
}

export interface Threadnote5ReleaseReadinessFixtureV1 {
  readonly baselineComparison: Threadnote5BaselineComparisonPolicyV1;
  readonly metrics: readonly Threadnote5MetricDefinitionV1[];
  readonly networkAllowed: false;
  readonly scenarios: readonly Threadnote5ScenarioContractV1[];
  readonly suite: typeof THREADNOTE_5_RELEASE_READINESS_SUITE;
  readonly version: typeof THREADNOTE_5_RELEASE_READINESS_VERSION;
}

export interface Threadnote5SourceV1 {
  readonly commit: string;
  readonly executableSha256: string;
  readonly id: 'threadnote-4.7.x' | 'threadnote-5.0.0';
  readonly version: string;
}

export interface Threadnote5MeanMeasurementV1 {
  readonly id: Threadnote5ReleaseMetric;
  readonly sampleCount: number;
  readonly total: number;
}

export interface Threadnote5RateMeasurementV1 {
  readonly eligibleCount: number;
  readonly id: Threadnote5ReleaseMetric;
  readonly positiveCount: number;
}

export type Threadnote5MeasurementV1 = Threadnote5MeanMeasurementV1 | Threadnote5RateMeasurementV1;

export interface Threadnote5ObservationTranscriptV1 {
  readonly assertionResults: readonly {readonly id: string; readonly observed: boolean}[];
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly outcome: Threadnote5ObservationOutcome;
  readonly reason: 'contract-failed' | 'evidence-incomplete' | 'not-observed' | null;
}

export interface Threadnote5SubsystemReceiptV1 {
  readonly digest: string;
  readonly kind: Threadnote5ReleaseSubsystem;
}

export interface Threadnote5RuntimeIdentityV1 {
  readonly executableSha256: string;
  readonly sourceCommit: string;
}

export interface Threadnote5ObservationAttestationV1 {
  readonly postRuntime: Threadnote5RuntimeIdentityV1;
  readonly preRuntime: Threadnote5RuntimeIdentityV1;
  readonly previousTranscriptDigest: string | null;
  readonly subsystemReceipts: readonly Threadnote5SubsystemReceiptV1[];
  readonly transcriptDigest: string;
}

export interface Threadnote5ObservationV1 {
  readonly attestation: Threadnote5ObservationAttestationV1;
  readonly observationId: string;
  readonly receiptHash: string;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly sourceHash: string;
  readonly transcript: Threadnote5ObservationTranscriptV1;
  readonly version: typeof THREADNOTE_5_RELEASE_READINESS_VERSION;
}

export interface Threadnote5CaptureManifestEntryV1 {
  readonly observationId: string;
  readonly receiptHash: string;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly sourceHash: string;
  readonly subsystemReceipts: readonly Threadnote5SubsystemReceiptV1[];
  readonly transcriptDigest: string;
}

export interface Threadnote5CaptureManifestV1 {
  readonly adapterId: 'sealed-fixture-replay-v1' | 'threadnote-5-local-task-loop-adapter-v1';
  readonly entries: readonly Threadnote5CaptureManifestEntryV1[];
  readonly fixtureHash: string;
  readonly mode: Threadnote5EvidenceClass;
  readonly version: typeof THREADNOTE_5_RELEASE_READINESS_VERSION;
}

export interface Threadnote5CaptureV1 {
  readonly manifest: Threadnote5CaptureManifestV1;
  readonly manifestHash: string;
}

export type Threadnote5BaselineV1 =
  | {
      readonly reason: 'not-captured' | 'source-unavailable';
      readonly sourceFamily: '4.7.x';
      readonly state: 'unavailable';
    }
  | {
      readonly observations: readonly Threadnote5ObservationV1[];
      readonly source: Threadnote5SourceV1;
      readonly state: 'available';
    };

export interface Threadnote5ReleaseEvidenceV1 {
  readonly baseline: Threadnote5BaselineV1;
  readonly candidate: Threadnote5SourceV1;
  readonly candidateObservations: readonly Threadnote5ObservationV1[];
  readonly capture: Threadnote5CaptureV1;
  readonly evidenceHash: string;
  readonly fixtureHash: string;
  readonly suite: typeof THREADNOTE_5_RELEASE_EVIDENCE_SUITE;
  readonly version: typeof THREADNOTE_5_RELEASE_READINESS_VERSION;
}

export const APPROVED_THREADNOTE_5_METRICS: readonly Threadnote5MetricDefinitionV1[] = [
  {
    direction: 'lower',
    id: 'time-to-first-cited-correct-plan',
    kind: 'mean',
    threshold: 600_000,
    thresholdKind: 'maximum',
    unit: 'milliseconds',
  },
  {
    direction: 'lower',
    id: 'estimated-tokens-to-first-cited-correct-plan',
    kind: 'mean',
    threshold: 1_500,
    thresholdKind: 'maximum',
    unit: 'tokens',
  },
  {
    direction: 'higher',
    id: 'setup-success-rate',
    kind: 'rate',
    threshold: 0.9,
    thresholdKind: 'minimum',
    unit: 'ratio',
  },
  {
    direction: 'lower',
    id: 'wrong-memory-rate',
    kind: 'rate',
    threshold: 0,
    thresholdKind: 'maximum',
    unit: 'ratio',
  },
  {
    direction: 'higher',
    id: 'second-agent-reuse-rate',
    kind: 'rate',
    threshold: 1,
    thresholdKind: 'minimum',
    unit: 'ratio',
  },
  {
    direction: 'higher',
    id: 'knowledge-delta-completion-rate',
    kind: 'rate',
    threshold: 0.9,
    thresholdKind: 'minimum',
    unit: 'ratio',
  },
  {
    direction: 'higher',
    id: 'health-resolution-rate',
    kind: 'rate',
    threshold: 1,
    thresholdKind: 'minimum',
    unit: 'ratio',
  },
] as const;

export const APPROVED_THREADNOTE_5_SCENARIOS: readonly Threadnote5ScenarioContractV1[] = [
  {
    id: 'solo',
    metricIds: [
      'time-to-first-cited-correct-plan',
      'estimated-tokens-to-first-cited-correct-plan',
      'setup-success-rate',
      'wrong-memory-rate',
    ],
    metricMinimums: [
      {id: 'time-to-first-cited-correct-plan', minimumEligibleCount: 10},
      {id: 'estimated-tokens-to-first-cited-correct-plan', minimumEligibleCount: 10},
      {id: 'setup-success-rate', minimumEligibleCount: 10},
      {id: 'wrong-memory-rate', minimumEligibleCount: 10},
    ],
    requiredAssertions: ['first-plan-source-cited', 'first-plan-correct', 'local-setup-complete'],
    subsystems: ['activation', 'context-brief', 'value-report'],
  },
  {
    id: 'two-agent',
    metricIds: ['wrong-memory-rate', 'second-agent-reuse-rate'],
    metricMinimums: [
      {id: 'wrong-memory-rate', minimumEligibleCount: 10},
      {id: 'second-agent-reuse-rate', minimumEligibleCount: 10},
    ],
    requiredAssertions: [
      'two-surfaces-connected',
      'second-surface-reused-decision',
      'activation-receipt-reused-by-value-report',
    ],
    subsystems: ['activation', 'recall', 'value-report'],
  },
  {
    id: 'git-shared',
    metricIds: ['wrong-memory-rate'],
    metricMinimums: [{id: 'wrong-memory-rate', minimumEligibleCount: 10}],
    requiredAssertions: ['git-shared-decision-retrieved'],
    subsystems: ['sharing', 'recall', 'value-report'],
  },
  {
    id: 'offline',
    metricIds: ['wrong-memory-rate'],
    metricMinimums: [{id: 'wrong-memory-rate', minimumEligibleCount: 10}],
    requiredAssertions: ['network-attempts-zero', 'local-flow-complete'],
    subsystems: ['activation', 'value-report'],
  },
  {
    id: 'dirty-worktree',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: ['dirty-evidence-not-current', 'outcome-unknown'],
    subsystems: ['context-check'],
  },
  {
    id: 'interrupted-resumed',
    metricIds: ['knowledge-delta-completion-rate'],
    metricMinimums: [{id: 'knowledge-delta-completion-rate', minimumEligibleCount: 10}],
    requiredAssertions: ['resume-receipt-accepted', 'completed-step-not-repeated'],
    subsystems: ['activation', 'closeout'],
  },
  {
    id: 'upgrade-downgrade',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: ['upgrade-readable', 'downgrade-readable-or-safe-refusal', 'destructive-mutations-zero'],
    subsystems: ['migration'],
  },
  {
    id: 'provider-neutral-proposal',
    metricIds: ['knowledge-delta-completion-rate'],
    metricMinimums: [{id: 'knowledge-delta-completion-rate', minimumEligibleCount: 10}],
    requiredAssertions: ['provider-apis-zero', 'proposal-provider-neutral', 'proposal-review-approved'],
    subsystems: ['git-proposal'],
  },
  {
    id: 'verified-procedures',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: [
      'procedure-receipt-current',
      'procedure-dependencies-compatible',
      'procedure-never-auto-executed',
    ],
    subsystems: ['procedure'],
  },
  {
    id: 'health-maintenance',
    metricIds: ['health-resolution-rate'],
    metricMinimums: [{id: 'health-resolution-rate', minimumEligibleCount: 10}],
    requiredAssertions: [
      'health-issue-detected',
      'health-resolution-recorded',
      'local-scheduled-invocation-read-only',
      'configured-git-team-aggregation-read-only',
    ],
    subsystems: ['context-health'],
  },
  {
    id: 'structured-closeout',
    metricIds: ['knowledge-delta-completion-rate'],
    metricMinimums: [{id: 'knowledge-delta-completion-rate', minimumEligibleCount: 10}],
    requiredAssertions: [
      'decisions-rationale-present',
      'constraints-present',
      'verification-present',
      'invalidations-present',
      'unresolved-risks-present',
    ],
    subsystems: ['closeout'],
  },
  {
    id: 'stale-citation',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: ['changed-never-current', 'missing-never-current', 'unknown-remains-distinct'],
    subsystems: ['context-health'],
  },
  {
    id: 'contradiction-triage',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: [
      'contradiction-category-observed',
      'possible-duplicate-category-observed',
      'manual-review-required',
      'ordering-stable',
    ],
    subsystems: ['context-health'],
  },
  {
    id: 'projection-drift',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: ['unmanaged-text-preserved', 'apply-previewed', 'content-precondition-checked'],
    subsystems: ['guidance'],
  },
  {
    id: 'output-budgets',
    metricIds: [],
    metricMinimums: [],
    requiredAssertions: ['context-brief-800-to-1500-estimated-tokens', 'knowledge-delta-items-at-most-three'],
    subsystems: ['context-brief', 'closeout'],
  },
] as const;

export function parseThreadnote5ReleaseReadinessFixtureV1(value: unknown): Threadnote5ReleaseReadinessFixtureV1 {
  const fixture = record(value, 'release-readiness fixture');
  exactKeys(fixture, ['baselineComparison', 'metrics', 'networkAllowed', 'scenarios', 'suite', 'version']);
  if (fixture.version !== THREADNOTE_5_RELEASE_READINESS_VERSION) invalid('fixture version must be 1');
  if (fixture.suite !== THREADNOTE_5_RELEASE_READINESS_SUITE) invalid('fixture suite is invalid');
  if (fixture.networkAllowed !== false) invalid('release-readiness fixture must prohibit network access');
  if (!EffectArray.isArray(fixture.metrics) || !EffectArray.isArray(fixture.scenarios))
    invalid('fixture arrays are required');
  const baselineComparison = parseBaselineComparisonPolicy(fixture.baselineComparison);
  const metrics = EffectArray.map(fixture.metrics, parseMetricDefinition);
  const scenarios = EffectArray.map(fixture.scenarios, parseScenarioContract);
  if (canonicalJson(metrics) !== canonicalJson(APPROVED_THREADNOTE_5_METRICS)) {
    invalid('fixture metrics differ from the approved release contract');
  }
  if (canonicalJson(scenarios) !== canonicalJson(APPROVED_THREADNOTE_5_SCENARIOS)) {
    invalid('fixture scenarios differ from the approved release contract');
  }
  return {
    baselineComparison,
    metrics,
    networkAllowed: false,
    scenarios,
    suite: THREADNOTE_5_RELEASE_READINESS_SUITE,
    version: 1,
  };
}

export function threadnote5ReleaseReadinessFixtureHash(value: unknown): string {
  return sha256HexSync(
    `threadnote-5-release-readiness-fixture-v1\0${canonicalJson(parseThreadnote5ReleaseReadinessFixtureV1(value))}`,
  );
}

export function parseThreadnote5ReleaseEvidenceV1(
  value: unknown,
  fixture: Threadnote5ReleaseReadinessFixtureV1,
): Threadnote5ReleaseEvidenceV1 {
  const evidence = record(value, 'release-readiness evidence');
  exactKeys(evidence, [
    'baseline',
    'candidate',
    'candidateObservations',
    'capture',
    'evidenceHash',
    'fixtureHash',
    'suite',
    'version',
  ]);
  if (evidence.version !== 1 || evidence.suite !== THREADNOTE_5_RELEASE_EVIDENCE_SUITE) {
    invalid('evidence version or suite is invalid');
  }
  const fixtureHash = hash(evidence.fixtureHash, 'fixture hash');
  if (fixtureHash !== threadnote5ReleaseReadinessFixtureHash(fixture)) invalid('evidence fixture hash does not match');
  const candidate = parseSource(evidence.candidate, 'candidate');
  const candidateObservations = parseObservations(evidence.candidateObservations, candidate, fixture);
  const baseline = parseBaseline(evidence.baseline, fixture);
  const capture = parseCapture(evidence.capture, fixtureHash);
  const expectedManifest = threadnote5CaptureManifestForEvidence({
    adapterId: capture.manifest.adapterId,
    baseline,
    candidateObservations,
    fixtureHash,
    mode: capture.manifest.mode,
  });
  if (canonicalJson(capture.manifest) !== canonicalJson(expectedManifest)) {
    invalid('capture manifest does not match the retained observation attestations');
  }
  const projection = {
    baseline,
    candidate,
    candidateObservations,
    capture,
    fixtureHash,
    suite: THREADNOTE_5_RELEASE_EVIDENCE_SUITE,
    version: THREADNOTE_5_RELEASE_READINESS_VERSION,
  } as const;
  const evidenceHash = hash(evidence.evidenceHash, 'evidence hash');
  if (evidenceHash !== threadnote5ReleaseEvidenceHash(projection)) invalid('evidence hash does not match');
  return {...projection, evidenceHash};
}

export function threadnote5SourceHash(source: Threadnote5SourceV1): string {
  return sha256HexSync(`threadnote-5-release-source-v1\0${canonicalJson(source)}`);
}

export function parseThreadnote5TrustedSourceV1(value: unknown, role: 'baseline' | 'candidate'): Threadnote5SourceV1 {
  return parseSource(value, role);
}

export function threadnote5ObservationTranscriptHash(transcript: Threadnote5ObservationTranscriptV1): string {
  return sha256HexSync(`threadnote-5-release-transcript-v1\0${canonicalJson(transcript)}`);
}

export function threadnote5ObservationReceiptHash(observation: Omit<Threadnote5ObservationV1, 'receiptHash'>): string {
  return sha256HexSync(`threadnote-5-release-observation-v1\0${canonicalJson(observation)}`);
}

export function threadnote5CaptureManifestForEvidence(input: {
  readonly adapterId: Threadnote5CaptureManifestV1['adapterId'];
  readonly baseline: Threadnote5BaselineV1;
  readonly candidateObservations: readonly Threadnote5ObservationV1[];
  readonly fixtureHash: string;
  readonly mode: Threadnote5EvidenceClass;
}): Threadnote5CaptureManifestV1 {
  const observations = [
    ...input.candidateObservations,
    ...(input.baseline.state === 'available' ? input.baseline.observations : []),
  ].sort(compareObservationIdentity);
  return {
    adapterId: input.adapterId,
    entries: EffectArray.map(observations, observation => ({
      observationId: observation.observationId,
      receiptHash: observation.receiptHash,
      scenario: observation.scenario,
      sourceHash: observation.sourceHash,
      subsystemReceipts: observation.attestation.subsystemReceipts,
      transcriptDigest: observation.attestation.transcriptDigest,
    })),
    fixtureHash: input.fixtureHash,
    mode: input.mode,
    version: THREADNOTE_5_RELEASE_READINESS_VERSION,
  };
}

export function threadnote5CaptureManifestHash(manifest: Threadnote5CaptureManifestV1): string {
  return sha256HexSync(`threadnote-5-release-capture-manifest-v1\0${canonicalJson(manifest)}`);
}

export function threadnote5ReleaseEvidenceHash(evidence: Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'>): string {
  const sort = (observations: readonly Threadnote5ObservationV1[]) =>
    [...observations].sort(compareObservationIdentity);
  const normalized = {
    ...evidence,
    baseline:
      evidence.baseline.state === 'available'
        ? {...evidence.baseline, observations: sort(evidence.baseline.observations)}
        : evidence.baseline,
    candidateObservations: sort(evidence.candidateObservations),
  };
  return sha256HexSync(`threadnote-5-release-evidence-v1\0${canonicalJson(normalized)}`);
}

function parseMetricDefinition(value: unknown): Threadnote5MetricDefinitionV1 {
  const metric = record(value, 'metric definition');
  exactKeys(metric, ['direction', 'id', 'kind', 'threshold', 'thresholdKind', 'unit']);
  return {
    direction: literal(metric.direction, ['higher', 'lower'] as const, 'metric direction'),
    id: literal(metric.id, THREADNOTE_5_RELEASE_METRICS, 'metric id'),
    kind: literal(metric.kind, ['mean', 'rate'] as const, 'metric kind'),
    threshold: finite(metric.threshold, 'metric threshold'),
    thresholdKind: literal(metric.thresholdKind, ['maximum', 'minimum'] as const, 'metric threshold kind'),
    unit: literal(metric.unit, ['milliseconds', 'ratio', 'tokens'] as const, 'metric unit'),
  };
}

function parseBaselineComparisonPolicy(value: unknown): Threadnote5BaselineComparisonPolicyV1 {
  const policy = record(value, 'baseline comparison policy');
  exactKeys(policy, ['commit', 'comparableMetricIds', 'id', 'notApplicableMetricIds', 'version']);
  const commit = matching(policy.commit, /^[0-9a-f]{40}$/u, 'baseline comparison commit');
  const version = matching(policy.version, /^4\.7\.8$/u, 'baseline comparison version');
  if (commit !== THREADNOTE_5_BASELINE_COMMIT || version !== THREADNOTE_5_BASELINE_VERSION) {
    invalid('baseline comparison policy differs from the approved release contract');
  }
  const parsed: Threadnote5BaselineComparisonPolicyV1 = {
    commit,
    comparableMetricIds: EffectArray.map(
      stringArray(policy.comparableMetricIds, 'baseline comparable metric ids'),
      id => literal(id, THREADNOTE_5_RELEASE_METRICS, 'baseline comparable metric id'),
    ),
    id: literal(policy.id, ['threadnote-4.7.x'] as const, 'baseline comparison source id'),
    notApplicableMetricIds: EffectArray.map(
      stringArray(policy.notApplicableMetricIds, 'baseline not-applicable metric ids'),
      id => literal(id, THREADNOTE_5_RELEASE_METRICS, 'baseline not-applicable metric id'),
    ),
    version,
  };
  if (canonicalJson(parsed) !== canonicalJson(APPROVED_THREADNOTE_5_BASELINE_COMPARISON)) {
    invalid('baseline comparison policy differs from the approved release contract');
  }
  return parsed;
}

function parseScenarioContract(value: unknown): Threadnote5ScenarioContractV1 {
  const scenario = record(value, 'scenario contract');
  exactKeys(scenario, ['id', 'metricIds', 'metricMinimums', 'requiredAssertions', 'subsystems']);
  const metricIds = EffectArray.map(stringArray(scenario.metricIds, 'scenario metric ids'), id =>
    literal(id, THREADNOTE_5_RELEASE_METRICS, 'scenario metric id'),
  );
  if (!EffectArray.isArray(scenario.metricMinimums)) invalid('scenario metric minimums must be an array');
  const metricMinimums = EffectArray.map(scenario.metricMinimums, parseMetricMinimum);
  if (canonicalJson(EffectArray.map(metricMinimums, minimum => minimum.id)) !== canonicalJson(metricIds)) {
    invalid('scenario metric minimums must exactly match its metric ids');
  }
  return {
    id: literal(scenario.id, THREADNOTE_5_RELEASE_SCENARIOS, 'scenario id'),
    metricIds,
    metricMinimums,
    requiredAssertions: stringArray(scenario.requiredAssertions, 'scenario assertions'),
    subsystems: EffectArray.map(stringArray(scenario.subsystems, 'scenario subsystems'), value =>
      literal(value, THREADNOTE_5_RELEASE_SUBSYSTEMS, 'scenario subsystem'),
    ),
  };
}

function parseMetricMinimum(value: unknown): {
  readonly id: Threadnote5ReleaseMetric;
  readonly minimumEligibleCount: number;
} {
  const minimum = record(value, 'scenario metric minimum');
  exactKeys(minimum, ['id', 'minimumEligibleCount']);
  return {
    id: literal(minimum.id, THREADNOTE_5_RELEASE_METRICS, 'scenario metric minimum id'),
    minimumEligibleCount: boundedInteger(minimum.minimumEligibleCount, 'scenario minimum eligible count', 1, 10_000),
  };
}

function parseCapture(value: unknown, fixtureHash: string): Threadnote5CaptureV1 {
  const capture = record(value, 'capture');
  exactKeys(capture, ['manifest', 'manifestHash']);
  const manifest = parseCaptureManifest(capture.manifest);
  if (manifest.fixtureHash !== fixtureHash) invalid('capture manifest fixture hash does not match');
  const manifestHash = hash(capture.manifestHash, 'capture manifest hash');
  if (manifestHash !== threadnote5CaptureManifestHash(manifest)) invalid('capture manifest hash does not match');
  return {manifest, manifestHash};
}

function parseCaptureManifest(value: unknown): Threadnote5CaptureManifestV1 {
  const manifest = record(value, 'capture manifest');
  exactKeys(manifest, ['adapterId', 'entries', 'fixtureHash', 'mode', 'version']);
  if (manifest.version !== 1) invalid('capture manifest version must be 1');
  const mode = literal(manifest.mode, ['fixture-replay', 'release-candidate'] as const, 'capture mode');
  const adapterId = literal(
    manifest.adapterId,
    ['sealed-fixture-replay-v1', 'threadnote-5-local-task-loop-adapter-v1'] as const,
    'capture adapter',
  );
  if (
    (mode === 'fixture-replay' && adapterId !== 'sealed-fixture-replay-v1') ||
    (mode === 'release-candidate' && adapterId !== 'threadnote-5-local-task-loop-adapter-v1')
  ) {
    invalid('capture mode and adapter do not match');
  }
  if (!EffectArray.isArray(manifest.entries) || manifest.entries.length > THREADNOTE_5_RELEASE_SCENARIOS.length * 2) {
    invalid('capture manifest entries must be a bounded array');
  }
  const entries = EffectArray.map(manifest.entries, parseCaptureManifestEntry);
  unique(
    EffectArray.map(entries, entry => entry.observationId),
    'capture manifest observation ids',
  );
  unique(
    EffectArray.map(entries, entry => entry.receiptHash),
    'capture manifest observation receipt hashes',
  );
  unique(
    EffectArray.flatMap(entries, entry => EffectArray.map(entry.subsystemReceipts, receipt => receipt.digest)),
    'capture manifest subsystem receipt digests',
  );
  return {
    adapterId,
    entries,
    fixtureHash: hash(manifest.fixtureHash, 'capture manifest fixture hash'),
    mode,
    version: THREADNOTE_5_RELEASE_READINESS_VERSION,
  };
}

function parseCaptureManifestEntry(value: unknown): Threadnote5CaptureManifestEntryV1 {
  const entry = record(value, 'capture manifest entry');
  exactKeys(entry, ['observationId', 'receiptHash', 'scenario', 'sourceHash', 'subsystemReceipts', 'transcriptDigest']);
  if (!EffectArray.isArray(entry.subsystemReceipts)) invalid('capture manifest subsystem receipts must be an array');
  return {
    observationId: matching(entry.observationId, /^obs_[0-9a-f]{32}$/u, 'manifest observation id'),
    receiptHash: hash(entry.receiptHash, 'manifest observation receipt hash'),
    scenario: literal(entry.scenario, THREADNOTE_5_RELEASE_SCENARIOS, 'manifest scenario'),
    sourceHash: hash(entry.sourceHash, 'manifest source hash'),
    subsystemReceipts: EffectArray.map(entry.subsystemReceipts, parseSubsystemReceipt),
    transcriptDigest: hash(entry.transcriptDigest, 'manifest transcript digest'),
  };
}

function parseBaseline(value: unknown, fixture: Threadnote5ReleaseReadinessFixtureV1): Threadnote5BaselineV1 {
  const baseline = record(value, 'baseline');
  const state = literal(baseline.state, ['available', 'unavailable'] as const, 'baseline state');
  if (state === 'unavailable') {
    exactKeys(baseline, ['reason', 'sourceFamily', 'state']);
    if (baseline.sourceFamily !== '4.7.x') invalid('baseline source family must be 4.7.x');
    return {
      reason: literal(baseline.reason, ['not-captured', 'source-unavailable'] as const, 'baseline reason'),
      sourceFamily: '4.7.x',
      state,
    };
  }
  exactKeys(baseline, ['observations', 'source', 'state']);
  const source = parseSource(baseline.source, 'baseline');
  return {observations: parseObservations(baseline.observations, source, fixture), source, state};
}

function parseSource(value: unknown, role: 'baseline' | 'candidate'): Threadnote5SourceV1 {
  const source = record(value, `${role} source`);
  exactKeys(source, ['commit', 'executableSha256', 'id', 'version']);
  const commit = matching(source.commit, /^[0-9a-f]{40}$/u, `${role} commit`);
  const id = literal(source.id, ['threadnote-4.7.x', 'threadnote-5.0.0'] as const, `${role} source id`);
  const version = matching(
    source.version,
    role === 'candidate' ? new RegExp(`^5\\.0\\.0-local\\.g${commit}$`, 'u') : /^4\.7\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    `${role} version`,
  );
  if ((role === 'candidate' && id !== 'threadnote-5.0.0') || (role === 'baseline' && id !== 'threadnote-4.7.x')) {
    invalid(`${role} source id is invalid`);
  }
  if (role === 'baseline' && (commit !== THREADNOTE_5_BASELINE_COMMIT || version !== THREADNOTE_5_BASELINE_VERSION)) {
    invalid('baseline source must match the exact 4.7.8 release');
  }
  return {commit, executableSha256: hash(source.executableSha256, `${role} executable hash`), id, version};
}

function parseObservations(
  value: unknown,
  source: Threadnote5SourceV1,
  fixture: Threadnote5ReleaseReadinessFixtureV1,
): readonly Threadnote5ObservationV1[] {
  if (!EffectArray.isArray(value) || value.length > fixture.scenarios.length)
    invalid('observations must be a bounded array');
  const observations = EffectArray.map(value, item => parseObservation(item, source, fixture));
  unique(
    EffectArray.map(observations, item => item.observationId),
    'observation ids',
  );
  unique(
    EffectArray.map(observations, item => item.scenario),
    'observation scenarios',
  );
  const order = new Map(EffectArray.map(fixture.scenarios, (scenario, index) => [scenario.id, index]));
  const sorted = observations.sort((left, right) => order.get(left.scenario)! - order.get(right.scenario)!);
  let previousTranscriptDigest: string | null = null;
  const subsystemDigests: string[] = [];
  for (const observation of sorted) {
    if (observation.attestation.previousTranscriptDigest !== previousTranscriptDigest) {
      invalid('observation transcript chain is incomplete or reordered');
    }
    previousTranscriptDigest = observation.attestation.transcriptDigest;
    subsystemDigests.push(...EffectArray.map(observation.attestation.subsystemReceipts, receipt => receipt.digest));
  }
  unique(subsystemDigests, 'subsystem receipt digests');
  return sorted;
}

function parseObservation(
  value: unknown,
  source: Threadnote5SourceV1,
  fixture: Threadnote5ReleaseReadinessFixtureV1,
): Threadnote5ObservationV1 {
  const observation = record(value, 'observation');
  exactKeys(observation, [
    'attestation',
    'observationId',
    'receiptHash',
    'scenario',
    'sourceHash',
    'transcript',
    'version',
  ]);
  if (observation.version !== 1) invalid('observation version must be 1');
  const scenario = literal(observation.scenario, THREADNOTE_5_RELEASE_SCENARIOS, 'observation scenario');
  const contract = EffectOption.getOrUndefined(EffectArray.findFirst(fixture.scenarios, item => item.id === scenario))!;
  const sourceHash = hash(observation.sourceHash, 'observation source hash');
  if (sourceHash !== threadnote5SourceHash(source)) invalid('observation source hash does not match its source');
  const transcript = parseObservationTranscript(observation.transcript, contract, fixture);
  const attestation = parseObservationAttestation(observation.attestation, contract, source, transcript);
  const parsed = {
    attestation,
    observationId: matching(observation.observationId, /^obs_[0-9a-f]{32}$/u, 'observation id'),
    scenario,
    sourceHash,
    transcript,
    version: THREADNOTE_5_RELEASE_READINESS_VERSION,
  } as const;
  const receiptHash = hash(observation.receiptHash, 'observation receipt hash');
  if (receiptHash !== threadnote5ObservationReceiptHash(parsed)) invalid('observation receipt hash does not match');
  return {...parsed, receiptHash};
}

function parseObservationTranscript(
  value: unknown,
  contract: Threadnote5ScenarioContractV1,
  fixture: Threadnote5ReleaseReadinessFixtureV1,
): Threadnote5ObservationTranscriptV1 {
  const transcript = record(value, 'observation transcript');
  exactKeys(transcript, ['assertionResults', 'measurements', 'outcome', 'reason']);
  const outcome = literal(transcript.outcome, ['failed', 'passed', 'unknown'] as const, 'observation outcome');
  if (!EffectArray.isArray(transcript.assertionResults)) invalid('transcript assertion results must be an array');
  const assertionResults = EffectArray.map(transcript.assertionResults, parseAssertionResult);
  if (
    canonicalJson(EffectArray.map(assertionResults, result => result.id)) !== canonicalJson(contract.requiredAssertions)
  ) {
    invalid(`transcript assertions are mislabeled for ${contract.id}`);
  }
  if (!EffectArray.isArray(transcript.measurements)) invalid('transcript measurements must be an array');
  const measurements = EffectArray.map(transcript.measurements, item => parseMeasurement(item, fixture));
  unique(
    EffectArray.map(measurements, item => item.id),
    'transcript metric ids',
  );
  const reason =
    transcript.reason === null
      ? null
      : literal(
          transcript.reason,
          ['contract-failed', 'evidence-incomplete', 'not-observed'] as const,
          'observation reason',
        );
  if (outcome === 'passed') {
    if (reason !== null || EffectArray.some(assertionResults, result => !result.observed)) {
      invalid('passed transcript requires every assertion and no failure reason');
    }
    if (canonicalJson(EffectArray.map(measurements, item => item.id)) !== canonicalJson(contract.metricIds)) {
      invalid(`passed ${contract.id} transcript metrics are mislabeled or incomplete`);
    }
  } else {
    if (EffectArray.some(assertionResults, result => result.observed) || measurements.length > 0) {
      invalid('non-passed transcript cannot claim assertions or measurements');
    }
    if (outcome === 'failed' ? reason !== 'contract-failed' : reason === null || reason === 'contract-failed') {
      invalid('observation outcome and reason do not match');
    }
  }
  return {assertionResults, measurements, outcome, reason};
}

function parseAssertionResult(value: unknown): {readonly id: string; readonly observed: boolean} {
  const result = record(value, 'assertion result');
  exactKeys(result, ['id', 'observed']);
  if (typeof result.observed !== 'boolean') invalid('assertion result observed must be boolean');
  return {id: matching(result.id, /^[a-z0-9][a-z0-9-]{0,63}$/u, 'assertion result id'), observed: result.observed};
}

function parseObservationAttestation(
  value: unknown,
  contract: Threadnote5ScenarioContractV1,
  source: Threadnote5SourceV1,
  transcript: Threadnote5ObservationTranscriptV1,
): Threadnote5ObservationAttestationV1 {
  const attestation = record(value, 'observation attestation');
  exactKeys(attestation, [
    'postRuntime',
    'preRuntime',
    'previousTranscriptDigest',
    'subsystemReceipts',
    'transcriptDigest',
  ]);
  const preRuntime = parseRuntimeIdentity(attestation.preRuntime, source, 'pre-run runtime');
  const postRuntime = parseRuntimeIdentity(attestation.postRuntime, source, 'post-run runtime');
  if (!EffectArray.isArray(attestation.subsystemReceipts)) invalid('subsystem receipts must be an array');
  const subsystemReceipts = EffectArray.map(attestation.subsystemReceipts, parseSubsystemReceipt);
  if (
    canonicalJson(EffectArray.map(subsystemReceipts, receipt => receipt.kind)) !== canonicalJson(contract.subsystems)
  ) {
    invalid(`subsystem receipts are mislabeled for ${contract.id}`);
  }
  unique(
    EffectArray.map(subsystemReceipts, receipt => receipt.digest),
    'observation subsystem receipt digests',
  );
  const transcriptDigest = hash(attestation.transcriptDigest, 'transcript digest');
  if (transcriptDigest !== threadnote5ObservationTranscriptHash(transcript)) {
    invalid('transcript digest does not match its content-free transcript');
  }
  return {
    postRuntime,
    preRuntime,
    previousTranscriptDigest:
      attestation.previousTranscriptDigest === null
        ? null
        : hash(attestation.previousTranscriptDigest, 'previous transcript digest'),
    subsystemReceipts,
    transcriptDigest,
  };
}

function parseRuntimeIdentity(
  value: unknown,
  source: Threadnote5SourceV1,
  label: string,
): Threadnote5RuntimeIdentityV1 {
  const runtime = record(value, label);
  exactKeys(runtime, ['executableSha256', 'sourceCommit']);
  const parsed = {
    executableSha256: hash(runtime.executableSha256, `${label} executable hash`),
    sourceCommit: matching(runtime.sourceCommit, /^[0-9a-f]{40}$/u, `${label} source commit`),
  };
  if (parsed.executableSha256 !== source.executableSha256 || parsed.sourceCommit !== source.commit) {
    invalid(`${label} does not match the exact evaluated source`);
  }
  return parsed;
}

function parseSubsystemReceipt(value: unknown): Threadnote5SubsystemReceiptV1 {
  const receipt = record(value, 'subsystem receipt');
  exactKeys(receipt, ['digest', 'kind']);
  return {
    digest: hash(receipt.digest, 'subsystem receipt digest'),
    kind: literal(receipt.kind, THREADNOTE_5_RELEASE_SUBSYSTEMS, 'subsystem receipt kind'),
  };
}

function parseMeasurement(value: unknown, fixture: Threadnote5ReleaseReadinessFixtureV1): Threadnote5MeasurementV1 {
  const measurement = record(value, 'measurement');
  const id = literal(measurement.id, THREADNOTE_5_RELEASE_METRICS, 'measurement id');
  const definition = EffectOption.getOrUndefined(EffectArray.findFirst(fixture.metrics, item => item.id === id))!;
  if (definition.kind === 'mean') {
    exactKeys(measurement, ['id', 'sampleCount', 'total']);
    return {
      id,
      sampleCount: boundedInteger(measurement.sampleCount, 'measurement sample count', 1, 10_000),
      total: boundedInteger(measurement.total, 'measurement total', 0, 1_000_000_000_000),
    };
  }
  exactKeys(measurement, ['eligibleCount', 'id', 'positiveCount']);
  const eligibleCount = boundedInteger(measurement.eligibleCount, 'measurement eligible count', 1, 10_000);
  const positiveCount = boundedInteger(measurement.positiveCount, 'measurement positive count', 0, eligibleCount);
  return {eligibleCount, id, positiveCount};
}

function compareObservationIdentity(left: Threadnote5ObservationV1, right: Threadnote5ObservationV1): number {
  if (left.sourceHash !== right.sourceHash) return left.sourceHash < right.sourceHash ? -1 : 1;
  return THREADNOTE_5_RELEASE_SCENARIOS.indexOf(left.scenario) - THREADNOTE_5_RELEASE_SCENARIOS.indexOf(right.scenario);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) invalid('object has unsupported or missing fields');
}

function stringArray(value: unknown, label: string): string[] {
  if (!EffectArray.isArray(value)) invalid(`${label} must be an array`);
  return EffectArray.map(value, item => matching(item, /^[a-z0-9][a-z0-9-]{0,63}$/u, label));
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function hash(value: unknown, label: string): string {
  return matching(value, /^[0-9a-f]{64}$/u, label);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function invalid(message: string): never {
  throw new Error(`Invalid Threadnote 5 release-readiness evidence: ${message}.`);
}
