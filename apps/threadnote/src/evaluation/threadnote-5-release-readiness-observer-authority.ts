import {Array as EffectArray, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseThreadnote5LocalAuthorityManifestV1,
  threadnote5LocalAuthorityManifestHash,
  type Threadnote5LocalAuthorityEntryV1,
  type Threadnote5LocalAuthorityManifestV1,
} from './threadnote-5-release-readiness-authority.js';
import {
  APPROVED_THREADNOTE_5_SCENARIOS,
  parseThreadnote5TrustedSourceV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import {
  deriveThreadnote5LocalScenarioClaims,
  threadnote5LocalSubsystemReceiptDigest,
  type Threadnote5LocalSourceKindV1,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from './threadnote-5-release-readiness-receipts.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const THREADNOTE_5_OBSERVER_AUTHORITY_REVIEW_VERSION = 1 as const;
const EXPECTED_OBSERVER_ARTIFACTS = 15;
const MAX_RETAINED_RECORD_SET_BYTES = 8 * 1024 * 1024;
type Coverage = {
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly observerKind: string;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly type: Threadnote5LocalAuthorityEntryV1['type'];
};
/** Every listed lane needs an independently reviewed private artifact. */
export const THREADNOTE_5_OBSERVER_AUTHORITY_COVERAGE: readonly Coverage[] = [
  {
    kind: 'activation',
    observerKind: 'activation-challenge-attestation-resume',
    scenario: 'solo',
    type: 'activation-verification',
  },
  {
    kind: 'context-brief',
    observerKind: 'human-citation-correctness',
    scenario: 'solo',
    type: 'context-brief-plan-citation',
  },
  {kind: 'value-report', observerKind: 'wrong-memory-observer', scenario: 'solo', type: 'value-report-verification'},
  {
    kind: 'activation',
    observerKind: 'activation-challenge-attestation-resume',
    scenario: 'two-agent',
    type: 'activation-verification',
  },
  {
    kind: 'value-report',
    observerKind: 'wrong-memory-observer',
    scenario: 'two-agent',
    type: 'value-report-verification',
  },
  {
    kind: 'value-report',
    observerKind: 'wrong-memory-observer',
    scenario: 'git-shared',
    type: 'value-report-verification',
  },
  {kind: 'activation', observerKind: 'offline-network-observer', scenario: 'offline', type: 'activation-verification'},
  {
    kind: 'value-report',
    observerKind: 'offline-network-observer',
    scenario: 'offline',
    type: 'value-report-verification',
  },
  {
    kind: 'context-check',
    observerKind: 'repo-graph-read-fence',
    scenario: 'dirty-worktree',
    type: 'context-check-read-fence',
  },
  {
    kind: 'activation',
    observerKind: 'activation-challenge-attestation-resume',
    scenario: 'interrupted-resumed',
    type: 'activation-verification',
  },
  {
    kind: 'migration',
    observerKind: 'migration-protected-write',
    scenario: 'upgrade-downgrade',
    type: 'migration-execution',
  },
  {
    kind: 'git-proposal',
    observerKind: 'provider-call-review',
    scenario: 'provider-neutral-proposal',
    type: 'git-proposal-review',
  },
  {
    kind: 'procedure',
    observerKind: 'procedure-exit-auto-exec',
    scenario: 'verified-procedures',
    type: 'procedure-verification',
  },
  {
    kind: 'context-health',
    observerKind: 'health-read-only-git-stability',
    scenario: 'health-maintenance',
    type: 'context-health-read-only',
  },
  {
    kind: 'guidance',
    observerKind: 'stale-precondition-rejection',
    scenario: 'projection-drift',
    type: 'guidance-stale-precondition-rejection',
  },
] as const;

interface PrivateObserverArtifactV1 {
  readonly candidate: Threadnote5SourceV1;
  readonly observedAt: string;
  readonly observedAuthority: Threadnote5LocalAuthorityEntryV1;
  readonly provenance: {
    readonly approvalDigest: string;
    readonly observerIdHash: string;
    readonly reviewerIdHash: string;
  };
  readonly runtime: {readonly post: Threadnote5SourceV1; readonly pre: Threadnote5SourceV1};
  readonly version: 1;
}
interface ReviewEnvelope {
  readonly candidate: Threadnote5SourceV1;
  readonly artifacts: readonly {
    readonly artifact: PrivateObserverArtifactV1;
    readonly artifactDigest: string;
    readonly observerKind: string;
    readonly recordDigest: string;
  }[];
  readonly version: 1;
}
export interface Threadnote5ReviewedAuthorityBindingV1 {
  readonly bindingHash: string;
  readonly manifestHash: string;
  readonly reviewArtifactSetHash: string;
  readonly version: 1;
}
export interface Threadnote5ReviewedAuthorityBundleV1 {
  readonly binding: Threadnote5ReviewedAuthorityBindingV1;
  readonly manifest: Threadnote5LocalAuthorityManifestV1;
  readonly version: 1;
}
export interface Threadnote5ReviewedAuthorityPreviewV1 extends Threadnote5ReviewedAuthorityBindingV1 {
  readonly manifest: Threadnote5LocalAuthorityManifestV1;
}

export function previewThreadnote5ReviewedAuthorityManifestV1(input: {
  readonly candidate: unknown;
  readonly retainedRecords: unknown;
  readonly reviews: unknown;
}): Threadnote5ReviewedAuthorityPreviewV1 {
  const candidate = parseThreadnote5TrustedSourceV1(input.candidate, 'candidate');
  assertReviewArtifactCount(input.reviews);
  const records = parseRetainedRecords(input.retainedRecords, candidate);
  const reviews = parseReviews(input.reviews, candidate, records);
  const expected = new Map(
    EffectArray.map(THREADNOTE_5_OBSERVER_AUTHORITY_COVERAGE, item => [coverageKey(item), item] as const),
  );
  const entries: Threadnote5LocalAuthorityEntryV1[] = [];
  const reviewed = new Set<string>();
  for (const review of reviews.artifacts) {
    const record = records.get(review.recordDigest);
    const coverage = record === undefined ? undefined : expected.get(coverageKey(record));
    if (record === undefined || coverage === undefined || review.observerKind !== coverage.observerKind)
      throw new Error('Observer artifact is mislabeled for its required coverage lane.');
    const entry = deriveObservedAuthority(review.artifact, candidate, record);
    if (entry.type !== coverage.type || entry.recordDigest !== record.digest || reviewed.has(coverageKey(record)))
      throw new Error('Observer artifact is duplicated or does not bind its retained source.');
    assertStrictObserverClaims(coverage, entry);
    reviewed.add(coverageKey(record));
    entries.push(entry);
  }
  if (reviewed.size !== expected.size) throw new Error('Observer authority proof coverage is incomplete.');
  const manifest = parseThreadnote5LocalAuthorityManifestV1({candidate, entries, version: 1});
  const manifestHash = threadnote5LocalAuthorityManifestHash(manifest);
  // Replays every retained native artifact and verifies each authority-to-source relationship.
  deriveThreadnote5LocalScenarioClaims({
    authorityManifest: manifest,
    candidate,
    expectedAuthorityManifestSha256: manifestHash,
    retainedRecords: [...records.values()],
  });
  const reviewArtifactSetHash = sha256HexSync(
    `threadnote-5-observer-authority-proof-set-v1\0${canonicalJson(reviews)}`,
  );
  return {
    bindingHash: reviewedAuthorityBindingHash(manifestHash, reviewArtifactSetHash),
    manifest,
    manifestHash,
    reviewArtifactSetHash,
    version: 1,
  };
}

export function verifyThreadnote5ReviewedAuthorityManifestV1(input: {
  readonly bundle: unknown;
  readonly candidate: unknown;
  readonly expectedBindingSha256: string;
  readonly expectedManifestSha256: string;
  readonly expectedReviewArtifactSetSha256: string;
  readonly retainedRecords: unknown;
  readonly reviews: unknown;
}): Threadnote5ReviewedAuthorityPreviewV1 {
  const preview = previewThreadnote5ReviewedAuthorityManifestV1(input);
  if (
    !hash(input.expectedManifestSha256) ||
    !hash(input.expectedReviewArtifactSetSha256) ||
    !hash(input.expectedBindingSha256) ||
    preview.manifestHash !== input.expectedManifestSha256 ||
    preview.reviewArtifactSetHash !== input.expectedReviewArtifactSetSha256 ||
    preview.bindingHash !== input.expectedBindingSha256
  )
    throw new Error('Reviewed authority artifact does not match independently supplied hashes.');
  if (
    canonicalJson(parseThreadnote5ReviewedAuthorityBundleV1(input.bundle)) !==
    canonicalJson(reviewedAuthorityBundleArtifact(preview))
  )
    throw new Error('Reviewed authority bundle differs from canonical observer assembly.');
  return preview;
}

export function reviewedAuthorityBindingHash(manifestHash: string, reviewArtifactSetHash: string): string {
  return sha256HexSync(
    `threadnote-5-observer-authority-binding-v1\0${canonicalJson({manifestHash: hash(manifestHash), reviewArtifactSetHash: hash(reviewArtifactSetHash)})}`,
  );
}

const OBSERVER_SOURCE_KINDS = [
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
] as const satisfies readonly Threadnote5LocalSourceKindV1[];

function isLocalSourceKind(value: unknown): value is Threadnote5LocalSourceKindV1 {
  return typeof value === 'string' && EffectArray.some(OBSERVER_SOURCE_KINDS, kind => kind === value);
}

function isReleaseScenario(value: unknown): value is Threadnote5ReleaseScenario {
  return (
    typeof value === 'string' && EffectArray.some(APPROVED_THREADNOTE_5_SCENARIOS, scenario => scenario.id === value)
  );
}

function parseRetainedRecords(
  value: unknown,
  candidate: Threadnote5SourceV1,
): ReadonlyMap<string, Threadnote5LocalSubsystemReceiptRecordV1> {
  if (!EffectArray.isArray(value) || value.length > 64)
    throw new Error('Observer authority retained records are invalid.');
  if (encodedBytes(value) > MAX_RETAINED_RECORD_SET_BYTES)
    throw new Error('Observer authority retained record set exceeds its encoded byte budget.');
  const allowed = new Set(
    EffectArray.flatMap(APPROVED_THREADNOTE_5_SCENARIOS, scenario =>
      EffectArray.map(scenario.subsystems, kind => coverageKey({kind, scenario: scenario.id})),
    ),
  );
  const records = new Map<string, Threadnote5LocalSubsystemReceiptRecordV1>();
  for (const row of value) {
    const source = exactObject(
      row,
      ['artifact', 'candidate', 'digest', 'kind', 'scenario', 'version'],
      'retained record',
    );
    if (!isLocalSourceKind(source.kind) || !isReleaseScenario(source.scenario))
      throw new Error('Observer authority retained source is unsupported or candidate-drifting.');
    const record: Threadnote5LocalSubsystemReceiptRecordV1 = {
      artifact: source.artifact,
      candidate: parseThreadnote5TrustedSourceV1(source.candidate, 'candidate'),
      digest: hash(source.digest),
      kind: source.kind,
      scenario: source.scenario,
      version: 1,
    };
    if (source.version !== 1 || !sameSource(record.candidate, candidate) || !allowed.has(coverageKey(record)))
      throw new Error('Observer authority retained source is unsupported or candidate-drifting.');
    if (record.digest !== threadnote5LocalSubsystemReceiptDigest(withoutDigest(record)))
      throw new Error('Observer authority retained source digest does not match its native artifact.');
    if (
      records.has(record.digest) ||
      EffectArray.some([...records.values()], item => coverageKey(item) === coverageKey(record))
    )
      throw new Error('Observer authority retained source is duplicated.');
    records.set(record.digest, record);
  }
  if (records.size !== allowed.size)
    throw new Error('Observer authority retained sources are incomplete or contain extra rows.');
  return records;
}

function parseReviews(
  value: unknown,
  candidate: Threadnote5SourceV1,
  records: ReadonlyMap<string, Threadnote5LocalSubsystemReceiptRecordV1>,
): ReviewEnvelope {
  const source = exactObject(value, ['artifacts', 'candidate', 'version'], 'observer authority proof envelope');
  if (source.version !== 1 || !sameSource(parseThreadnote5TrustedSourceV1(source.candidate, 'candidate'), candidate))
    throw new Error('Observer authority proof envelope candidate or version is invalid.');
  if (!EffectArray.isArray(source.artifacts) || source.artifacts.length !== EXPECTED_OBSERVER_ARTIFACTS)
    throw new Error('Observer authority proof set must contain exactly 15 artifacts.');
  const artifacts = EffectArray.map(source.artifacts, value => {
    const row = exactObject(
      value,
      ['artifact', 'artifactDigest', 'observerKind', 'recordDigest'],
      'observer authority artifact',
    );
    const recordDigest = hash(row.recordDigest);
    const record = records.get(recordDigest);
    if (record === undefined) throw new Error('Observer artifact references a missing retained source.');
    const artifact = parsePrivateObserverArtifact(row.artifact, candidate, record);
    const artifactDigest = hash(row.artifactDigest);
    if (artifactDigest !== threadnote5PrivateObserverArtifactDigest(row.artifact))
      throw new Error('Observer artifact digest does not match its private proof.');
    return {artifact, artifactDigest, observerKind: boundedText(row.observerKind, 'observer kind'), recordDigest};
  });
  if (new Set(EffectArray.map(artifacts, item => item.recordDigest)).size !== artifacts.length)
    throw new Error('Observer artifact source digests must be unique.');
  return {
    candidate,
    artifacts: [...artifacts].sort((left, right) =>
      Effect.pipe(left.recordDigest, EffectString.localeCompare(right.recordDigest)),
    ),
    version: 1,
  };
}

function assertReviewArtifactCount(value: unknown): void {
  const source = exactObject(value, ['artifacts', 'candidate', 'version'], 'observer authority proof envelope');
  if (!EffectArray.isArray(source.artifacts) || source.artifacts.length !== EXPECTED_OBSERVER_ARTIFACTS)
    throw new Error('Observer authority proof set must contain exactly 15 artifacts.');
}

function parsePrivateObserverArtifact(
  value: unknown,
  candidate: Threadnote5SourceV1,
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): PrivateObserverArtifactV1 {
  const source = exactObject(
    value,
    ['candidate', 'observedAt', 'observedAuthority', 'provenance', 'runtime', 'version'],
    'private observer artifact',
  );
  const provenance = exactObject(
    source.provenance,
    ['approvalDigest', 'observerIdHash', 'reviewerIdHash'],
    'observer provenance',
  );
  const runtime = exactObject(source.runtime, ['post', 'pre'], 'observer runtime boundaries');
  const observedAt = boundedText(source.observedAt, 'observer timestamp');
  if (
    source.version !== 1 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(observedAt) ||
    Number.isNaN(Date.parse(observedAt))
  )
    throw new Error('Observer artifact version or timestamp is invalid.');
  const parsedCandidate = parseThreadnote5TrustedSourceV1(source.candidate, 'candidate');
  const pre = parseThreadnote5TrustedSourceV1(runtime.pre, 'candidate');
  const post = parseThreadnote5TrustedSourceV1(runtime.post, 'candidate');
  if (!sameSource(parsedCandidate, candidate) || !sameSource(pre, candidate) || !sameSource(post, candidate))
    throw new Error('Observer artifact runtime boundary does not match the exact candidate.');
  const observedAuthority = parseThreadnote5LocalAuthorityManifestV1({
    candidate,
    entries: [source.observedAuthority],
    version: 1,
  }).entries[0];
  if (observedAuthority.recordDigest !== record.digest)
    throw new Error('Observer artifact authority does not bind its native source.');
  return {
    candidate,
    observedAt,
    observedAuthority,
    provenance: {
      approvalDigest: hash(provenance.approvalDigest),
      observerIdHash: hash(provenance.observerIdHash),
      reviewerIdHash: hash(provenance.reviewerIdHash),
    },
    runtime: {post, pre},
    version: 1,
  };
}

function deriveObservedAuthority(
  artifact: PrivateObserverArtifactV1,
  candidate: Threadnote5SourceV1,
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): Threadnote5LocalAuthorityEntryV1 {
  if (
    !sameSource(artifact.candidate, candidate) ||
    !sameSource(artifact.runtime.pre, candidate) ||
    !sameSource(artifact.runtime.post, candidate) ||
    artifact.observedAuthority.recordDigest !== record.digest
  )
    throw new Error('Observer artifact authority/source relationship is invalid.');
  return artifact.observedAuthority;
}
export function reviewedAuthorityBindingArtifact(
  preview: Pick<Threadnote5ReviewedAuthorityPreviewV1, 'bindingHash' | 'manifestHash' | 'reviewArtifactSetHash'>,
): Threadnote5ReviewedAuthorityBindingV1 {
  return {
    bindingHash: hash(preview.bindingHash),
    manifestHash: hash(preview.manifestHash),
    reviewArtifactSetHash: hash(preview.reviewArtifactSetHash),
    version: 1,
  };
}
export function reviewedAuthorityBundleArtifact(
  preview: Threadnote5ReviewedAuthorityPreviewV1,
): Threadnote5ReviewedAuthorityBundleV1 {
  return {
    binding: reviewedAuthorityBindingArtifact(preview),
    manifest: parseThreadnote5LocalAuthorityManifestV1(preview.manifest),
    version: 1,
  };
}
export function parseThreadnote5ReviewedAuthorityBundleV1(value: unknown): Threadnote5ReviewedAuthorityBundleV1 {
  const source = exactObject(value, ['binding', 'manifest', 'version'], 'reviewed authority bundle');
  if (source.version !== 1) throw new Error('Reviewed authority bundle version is invalid.');
  const binding = parseReviewedBinding(source.binding);
  const manifest = parseThreadnote5LocalAuthorityManifestV1(source.manifest);
  if (threadnote5LocalAuthorityManifestHash(manifest) !== binding.manifestHash)
    throw new Error('Reviewed authority bundle manifest hash is invalid.');
  return {binding, manifest, version: 1};
}
function parseReviewedBinding(value: unknown): Threadnote5ReviewedAuthorityBindingV1 {
  const source = exactObject(
    value,
    ['bindingHash', 'manifestHash', 'reviewArtifactSetHash', 'version'],
    'reviewed authority binding',
  );
  if (source.version !== 1) throw new Error('Reviewed authority binding version is invalid.');
  const binding = {
    bindingHash: hash(source.bindingHash),
    manifestHash: hash(source.manifestHash),
    reviewArtifactSetHash: hash(source.reviewArtifactSetHash),
    version: 1 as const,
  };
  if (binding.bindingHash !== reviewedAuthorityBindingHash(binding.manifestHash, binding.reviewArtifactSetHash))
    throw new Error('Reviewed authority binding hash is invalid.');
  return binding;
}
export function threadnote5PrivateObserverArtifactDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-private-observer-artifact-v1\0${canonicalJson(value)}`);
}
function assertStrictObserverClaims(coverage: Coverage, entry: Threadnote5LocalAuthorityEntryV1): void {
  if (entry.type === 'git-proposal-review' && EffectArray.some(entry.trials, trial => trial.providerApiCallCount !== 0))
    throw new Error('Provider-neutral proposal observer evidence records provider API activity.');
  if (
    entry.type === 'procedure-verification' &&
    (entry.automaticExecutionCount !== 0 || EffectArray.some(entry.commandResults, result => result.exitCode !== 0))
  )
    throw new Error('Procedure observer evidence requires zero auto-execution and successful commands.');
  if (
    entry.type === 'context-health-read-only' &&
    (entry.schedule.networkActivityCount !== 0 ||
      entry.schedule.writeActivityCount !== 0 ||
      entry.aggregate.networkActivityCount !== 0 ||
      entry.aggregate.writeActivityCount !== 0 ||
      EffectArray.some(
        entry.aggregate.teamSnapshots,
        snapshot =>
          snapshot.preHead !== snapshot.postHead ||
          snapshot.preIndexDigest !== snapshot.postIndexDigest ||
          snapshot.preWorktreeDigest !== snapshot.postWorktreeDigest,
      ))
  )
    throw new Error('Health observer evidence requires read-only stable Git state with zero network and writes.');
  if (
    coverage.scenario === 'two-agent' &&
    entry.type === 'activation-verification' &&
    EffectArray.some(entry.trials, trial => trial.attestationDigest === null)
  )
    throw new Error('Two-agent activation observer evidence requires an attestation.');
  if (
    coverage.scenario === 'offline' &&
    entry.type === 'activation-verification' &&
    EffectArray.some(entry.trials, trial => trial.offlineObservationDigest === null)
  )
    throw new Error('Offline activation observer evidence requires a network observation.');
  if (
    coverage.scenario === 'interrupted-resumed' &&
    entry.type === 'activation-verification' &&
    EffectArray.some(entry.trials, trial => trial.resumeBoundaryRevision === null)
  )
    throw new Error('Interrupted activation observer evidence requires a resume boundary.');
}
function coverageKey(value: Pick<Coverage, 'kind' | 'scenario'>): string {
  return `${value.scenario}\0${value.kind}`;
}
function withoutDigest(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): Omit<Threadnote5LocalSubsystemReceiptRecordV1, 'digest'> {
  const {digest: _, ...rest} = record;
  return rest;
}
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  const source = value;
  if (canonicalJson(EffectRecord.keys(source).sort()) !== canonicalJson([...keys].sort()))
    throw new Error(`${label} has unsupported or missing fields.`);
  return source;
}
function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Effect.pipe(value, EffectString.trim) !== value ||
    value.length < 1 ||
    value.length > 96
  )
    throw new Error(`${label} is invalid.`);
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error('Observer authority hash is invalid.');
  return value;
}
function sameSource(left: Threadnote5SourceV1, right: Threadnote5SourceV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}
