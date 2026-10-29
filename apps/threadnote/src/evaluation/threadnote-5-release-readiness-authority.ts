import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseThreadnote5TrustedSourceV1, type Threadnote5SourceV1} from './threadnote-5-release-readiness-contract.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const THREADNOTE_5_LOCAL_AUTHORITY_MANIFEST_VERSION = 1 as const;
const MAX_AUTHORITY_ENTRIES = 64;
const MAX_APPROVALS = 3;
const MAX_COMMAND_RESULTS = 32;

export interface Threadnote5GitProposalAuthorityV1 {
  readonly recordDigest: string;
  readonly trials: readonly {
    readonly approvals: readonly {
      readonly applyAuditDigest: string;
      readonly approvedContentHash: string;
      readonly candidateId: string;
      readonly sourceUriHash: string;
    }[];
    readonly proposalHash: string;
    readonly providerApiCallCount: number;
    readonly reviewId: string;
    readonly revision: number;
  }[];
  readonly type: 'git-proposal-review';
}

export interface Threadnote5ProcedureAuthorityV1 {
  readonly artifactId: string;
  readonly automaticExecutionCount: number;
  readonly commandResults: readonly {
    readonly commandId: string;
    readonly exitCode: number;
    readonly outputDigest: string;
  }[];
  readonly receiptDigest: string;
  readonly recordDigest: string;
  readonly semanticVersion: string;
  readonly type: 'procedure-verification';
}

export interface Threadnote5ActivationVerificationAuthorityV1 {
  readonly recordDigest: string;
  readonly trials: readonly {
    readonly activationId: string;
    readonly attestationDigest: string | null;
    readonly finalReceiptRevision: string;
    readonly offlineObservationDigest: string | null;
    readonly resumeBoundaryRevision: string | null;
  }[];
  readonly type: 'activation-verification';
}

export interface Threadnote5ContextBriefPlanAuthorityV1 {
  readonly recordDigest: string;
  readonly trials: readonly {
    readonly attemptDigest: string;
    readonly firstPlanCorrect: true;
    readonly firstPlanSourceCited: true;
  }[];
  readonly type: 'context-brief-plan-citation';
}

export interface Threadnote5ValueReportAuthorityV1 {
  readonly recordDigest: string;
  readonly trials: readonly {
    readonly feedbackEventDigest: string;
    readonly laneId: string;
    readonly offlineObservationDigest: string | null;
  }[];
  readonly type: 'value-report-verification';
}

export interface Threadnote5ExternalReceiptAuthorityV1 {
  readonly assertions: readonly string[];
  readonly recordDigest: string;
  readonly type: 'context-check-read-fence' | 'guidance-stale-precondition-rejection' | 'migration-execution';
}

export interface Threadnote5ContextHealthReadOnlyAuthorityV1 {
  readonly aggregate: {
    readonly networkActivityCount: number;
    readonly teamSnapshots: readonly {
      readonly postHead: string;
      readonly postIndexDigest: string;
      readonly postWorktreeDigest: string;
      readonly preHead: string;
      readonly preIndexDigest: string;
      readonly preWorktreeDigest: string;
      readonly team: string;
    }[];
    readonly writeActivityCount: number;
  };
  readonly recordDigest: string;
  readonly schedule: {
    readonly networkActivityCount: number;
    readonly writeActivityCount: number;
  };
  readonly type: 'context-health-read-only';
}

export type Threadnote5LocalAuthorityEntryV1 =
  | Threadnote5ActivationVerificationAuthorityV1
  | Threadnote5ContextBriefPlanAuthorityV1
  | Threadnote5ContextHealthReadOnlyAuthorityV1
  | Threadnote5GitProposalAuthorityV1
  | Threadnote5ProcedureAuthorityV1
  | Threadnote5ValueReportAuthorityV1
  | Threadnote5ExternalReceiptAuthorityV1;

export interface Threadnote5LocalAuthorityManifestV1 {
  readonly candidate: Threadnote5SourceV1;
  readonly entries: readonly Threadnote5LocalAuthorityEntryV1[];
  readonly version: typeof THREADNOTE_5_LOCAL_AUTHORITY_MANIFEST_VERSION;
}

/** The expected value must be reviewed/supplied outside the manifest; the manifest never nominates its own trust. */
export function threadnote5LocalAuthorityManifestHash(value: unknown): string {
  return sha256HexSync(
    `threadnote-5-local-authority-manifest-v1\0${canonicalJson(parseThreadnote5LocalAuthorityManifestV1(value))}`,
  );
}

export function threadnote5ApplyAuditDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-candidate-apply-audit-v1\0${canonicalJson(value)}`);
}

export function threadnote5ApprovedSourceUriHash(value: string): string {
  return sha256HexSync(`threadnote-5-approved-source-uri-v1\0${value}`);
}

export function threadnote5ProcedureVerificationReceiptDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-procedure-verification-receipt-v1\0${canonicalJson(value)}`);
}

export function threadnote5ActivationAttestationDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-activation-attestation-v1\0${canonicalJson(value)}`);
}

export function threadnote5ActivationOfflineObservationDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-activation-offline-observation-v1\0${canonicalJson(value)}`);
}

export function threadnote5ContextBriefAttemptDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-context-brief-attempt-v1\0${canonicalJson(value)}`);
}

export function threadnote5RecallFeedbackEventDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-recall-feedback-event-v1\0${canonicalJson(value)}`);
}

export function threadnote5ValueReportOfflineObservationDigest(value: unknown): string {
  return sha256HexSync(`threadnote-5-value-report-offline-observation-v1\0${canonicalJson(value)}`);
}

export function parseThreadnote5LocalAuthorityManifestV1(value: unknown): Threadnote5LocalAuthorityManifestV1 {
  const source = exactObject(value, ['candidate', 'entries', 'version'], 'local authority manifest');
  if (source.version !== 1 || !EffectArray.isArray(source.entries) || source.entries.length > MAX_AUTHORITY_ENTRIES) {
    throw new Error('Local authority manifest version or entry count is invalid.');
  }
  const entries = EffectArray.map(source.entries, parseEntry).sort((left, right) =>
    Effect.pipe(left.recordDigest, EffectString.localeCompare(right.recordDigest)),
  );
  if (new Set(EffectArray.map(entries, entry => entry.recordDigest)).size !== entries.length) {
    throw new Error('Local authority manifest record digests must be unique.');
  }
  return {
    candidate: parseThreadnote5TrustedSourceV1(source.candidate, 'candidate'),
    entries,
    version: THREADNOTE_5_LOCAL_AUTHORITY_MANIFEST_VERSION,
  };
}

function parseEntry(value: unknown): Threadnote5LocalAuthorityEntryV1 {
  const source = object(value, 'local authority entry');
  if (source.type === 'context-health-read-only') {
    exactKeys(source, ['aggregate', 'recordDigest', 'schedule', 'type'], 'context health read-only authority');
    return {
      aggregate: parseHealthAggregateAuthority(source.aggregate),
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      schedule: parseHealthExecutionAuthority(source.schedule, 'context health schedule authority'),
      type: 'context-health-read-only',
    };
  }
  if (source.type === 'activation-verification') {
    exactKeys(source, ['recordDigest', 'trials', 'type'], 'activation verification authority');
    if (
      !EffectArray.isArray(source.trials) ||
      source.trials.length < 1 ||
      source.trials.length > MAX_AUTHORITY_ENTRIES
    ) {
      throw new Error('Activation verification authority trials are out of bounds.');
    }
    const trials = EffectArray.map(source.trials, parseActivationVerificationTrial).sort((left, right) =>
      Effect.pipe(left.activationId, EffectString.localeCompare(right.activationId)),
    );
    unique(
      EffectArray.map(trials, trial => trial.activationId),
      'activation verification authority activation IDs',
    );
    return {
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      trials,
      type: 'activation-verification',
    };
  }
  if (source.type === 'context-brief-plan-citation') {
    exactKeys(source, ['recordDigest', 'trials', 'type'], 'Context Brief plan authority');
    if (
      !EffectArray.isArray(source.trials) ||
      source.trials.length < 1 ||
      source.trials.length > MAX_AUTHORITY_ENTRIES
    ) {
      throw new Error('Context Brief plan authority trials are out of bounds.');
    }
    const trials = EffectArray.map(source.trials, parseContextBriefTrial).sort((left, right) =>
      Effect.pipe(left.attemptDigest, EffectString.localeCompare(right.attemptDigest)),
    );
    unique(
      EffectArray.map(trials, trial => trial.attemptDigest),
      'Context Brief authority attempt digests',
    );
    return {
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      trials,
      type: 'context-brief-plan-citation',
    };
  }
  if (source.type === 'git-proposal-review') {
    exactKeys(source, ['recordDigest', 'trials', 'type'], 'Git proposal authority');
    if (
      !EffectArray.isArray(source.trials) ||
      source.trials.length < 1 ||
      source.trials.length > MAX_AUTHORITY_ENTRIES
    ) {
      throw new Error('Git proposal authority trials are out of bounds.');
    }
    const trials = EffectArray.map(source.trials, parseGitProposalTrial).sort((left, right) =>
      Effect.pipe(left.proposalHash, EffectString.localeCompare(right.proposalHash)),
    );
    unique(
      EffectArray.map(trials, trial => trial.proposalHash),
      'Git proposal authority proposal hashes',
    );
    return {
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      trials,
      type: 'git-proposal-review',
    };
  }
  if (source.type === 'procedure-verification') {
    exactKeys(
      source,
      [
        'artifactId',
        'automaticExecutionCount',
        'commandResults',
        'receiptDigest',
        'recordDigest',
        'semanticVersion',
        'type',
      ],
      'procedure authority',
    );
    if (!EffectArray.isArray(source.commandResults) || source.commandResults.length > MAX_COMMAND_RESULTS) {
      throw new Error('Procedure authority command results are out of bounds.');
    }
    const commandResults = EffectArray.map(source.commandResults, parseCommandResult);
    unique(
      EffectArray.map(commandResults, result => result.commandId),
      'procedure authority command IDs',
    );
    return {
      artifactId: boundedText(source.artifactId, 'procedure artifact ID', 128),
      automaticExecutionCount: boundedInteger(
        source.automaticExecutionCount,
        'automatic execution count',
        0,
        1_000_000,
      ),
      commandResults,
      receiptDigest: hash(source.receiptDigest, 'procedure receipt digest'),
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      semanticVersion: boundedText(source.semanticVersion, 'procedure semantic version', 128),
      type: 'procedure-verification',
    };
  }
  if (source.type === 'value-report-verification') {
    exactKeys(source, ['recordDigest', 'trials', 'type'], 'Value Report authority');
    if (
      !EffectArray.isArray(source.trials) ||
      source.trials.length < 1 ||
      source.trials.length > MAX_AUTHORITY_ENTRIES
    ) {
      throw new Error('Value Report authority trials are out of bounds.');
    }
    const trials = EffectArray.map(source.trials, parseValueReportTrial).sort((left, right) =>
      Effect.pipe(left.feedbackEventDigest, EffectString.localeCompare(right.feedbackEventDigest)),
    );
    unique(
      EffectArray.map(trials, trial => trial.feedbackEventDigest),
      'Value Report authority feedback-event digests',
    );
    unique(
      EffectArray.map(trials, trial => trial.laneId),
      'Value Report authority lane IDs',
    );
    return {
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      trials,
      type: 'value-report-verification',
    };
  }
  if (
    source.type === 'context-check-read-fence' ||
    source.type === 'guidance-stale-precondition-rejection' ||
    source.type === 'migration-execution'
  ) {
    exactKeys(source, ['assertions', 'recordDigest', 'type'], 'external receipt authority');
    if (!EffectArray.isArray(source.assertions) || source.assertions.length < 1 || source.assertions.length > 8) {
      throw new Error('External receipt authority assertions are out of bounds.');
    }
    const assertions = EffectArray.map(source.assertions, value =>
      matching(value, /^[a-z0-9][a-z0-9-]{0,95}$/u, 'authority assertion'),
    );
    unique(assertions, 'external receipt authority assertions');
    const expectedAssertions = {
      'context-check-read-fence': ['dirty-evidence-not-current', 'outcome-unknown'],
      'guidance-stale-precondition-rejection': ['stale-precondition-rejected'],
      'migration-execution': ['migration-runtime-executed'],
    } as const;
    if (canonicalJson([...assertions].sort()) !== canonicalJson(expectedAssertions[source.type])) {
      throw new Error('External receipt authority assertions are invalid for its type.');
    }
    return {
      assertions: [...assertions].sort(),
      recordDigest: hash(source.recordDigest, 'authority record digest'),
      type: source.type,
    };
  }
  throw new Error('Local authority entry type is unsupported.');
}

function parseHealthAggregateAuthority(value: unknown): Threadnote5ContextHealthReadOnlyAuthorityV1['aggregate'] {
  const source = exactObject(
    value,
    ['networkActivityCount', 'teamSnapshots', 'writeActivityCount'],
    'context health aggregate authority',
  );
  if (!EffectArray.isArray(source.teamSnapshots) || source.teamSnapshots.length > MAX_AUTHORITY_ENTRIES) {
    throw new Error('Context health aggregate authority team snapshots are out of bounds.');
  }
  const teamSnapshots = EffectArray.map(source.teamSnapshots, parseHealthTeamSnapshot).sort((left, right) =>
    Effect.pipe(left.team, EffectString.localeCompare(right.team)),
  );
  unique(
    EffectArray.map(teamSnapshots, snapshot => snapshot.team),
    'context health authority teams',
  );
  return {
    networkActivityCount: boundedInteger(
      source.networkActivityCount,
      'context health network activity count',
      0,
      1_000_000,
    ),
    teamSnapshots,
    writeActivityCount: boundedInteger(source.writeActivityCount, 'context health write activity count', 0, 1_000_000),
  };
}

function parseHealthExecutionAuthority(
  value: unknown,
  label: string,
): Threadnote5ContextHealthReadOnlyAuthorityV1['schedule'] {
  const source = exactObject(value, ['networkActivityCount', 'writeActivityCount'], label);
  return {
    networkActivityCount: boundedInteger(
      source.networkActivityCount,
      'context health network activity count',
      0,
      1_000_000,
    ),
    writeActivityCount: boundedInteger(source.writeActivityCount, 'context health write activity count', 0, 1_000_000),
  };
}

function parseHealthTeamSnapshot(
  value: unknown,
): Threadnote5ContextHealthReadOnlyAuthorityV1['aggregate']['teamSnapshots'][number] {
  const source = exactObject(
    value,
    ['postHead', 'postIndexDigest', 'postWorktreeDigest', 'preHead', 'preIndexDigest', 'preWorktreeDigest', 'team'],
    'context health team snapshot',
  );
  return {
    postHead: gitCommit(source.postHead, 'context health post HEAD'),
    postIndexDigest: hash(source.postIndexDigest, 'context health post index digest'),
    postWorktreeDigest: hash(source.postWorktreeDigest, 'context health post worktree digest'),
    preHead: gitCommit(source.preHead, 'context health pre HEAD'),
    preIndexDigest: hash(source.preIndexDigest, 'context health pre index digest'),
    preWorktreeDigest: hash(source.preWorktreeDigest, 'context health pre worktree digest'),
    team: matching(source.team, /^[a-z0-9][a-z0-9._-]*$/u, 'context health team'),
  };
}

function parseContextBriefTrial(value: unknown): Threadnote5ContextBriefPlanAuthorityV1['trials'][number] {
  const source = exactObject(
    value,
    ['attemptDigest', 'firstPlanCorrect', 'firstPlanSourceCited'],
    'Context Brief authority trial',
  );
  if (source.firstPlanCorrect !== true || source.firstPlanSourceCited !== true) {
    throw new Error('Context Brief authority trial must independently attest a cited correct plan.');
  }
  return {
    attemptDigest: hash(source.attemptDigest, 'Context Brief attempt digest'),
    firstPlanCorrect: true,
    firstPlanSourceCited: true,
  };
}

function parseValueReportTrial(value: unknown): Threadnote5ValueReportAuthorityV1['trials'][number] {
  const source = exactObject(
    value,
    ['feedbackEventDigest', 'laneId', 'offlineObservationDigest'],
    'Value Report authority trial',
  );
  return {
    feedbackEventDigest: hash(source.feedbackEventDigest, 'feedback event digest'),
    laneId: hash(source.laneId, 'Value Report lane ID'),
    offlineObservationDigest: nullableHash(source.offlineObservationDigest, 'Value Report offline observation digest'),
  };
}

function parseActivationVerificationTrial(
  value: unknown,
): Threadnote5ActivationVerificationAuthorityV1['trials'][number] {
  const source = exactObject(
    value,
    ['activationId', 'attestationDigest', 'finalReceiptRevision', 'offlineObservationDigest', 'resumeBoundaryRevision'],
    'activation verification authority trial',
  );
  return {
    activationId: hash(source.activationId, 'activation ID'),
    attestationDigest: nullableHash(source.attestationDigest, 'activation attestation digest'),
    finalReceiptRevision: hash(source.finalReceiptRevision, 'activation final receipt revision'),
    offlineObservationDigest: nullableHash(source.offlineObservationDigest, 'activation offline observation digest'),
    resumeBoundaryRevision: nullableHash(source.resumeBoundaryRevision, 'activation resume boundary revision'),
  };
}

function parseGitProposalTrial(value: unknown): Threadnote5GitProposalAuthorityV1['trials'][number] {
  const source = exactObject(
    value,
    ['approvals', 'proposalHash', 'providerApiCallCount', 'reviewId', 'revision'],
    'Git proposal authority trial',
  );
  if (
    !EffectArray.isArray(source.approvals) ||
    source.approvals.length < 1 ||
    source.approvals.length > MAX_APPROVALS
  ) {
    throw new Error('Git proposal authority approvals are out of bounds.');
  }
  const approvals = EffectArray.map(source.approvals, parseApproval).sort((left, right) =>
    Effect.pipe(left.candidateId, EffectString.localeCompare(right.candidateId)),
  );
  unique(
    EffectArray.map(approvals, approval => approval.candidateId),
    'Git proposal authority candidate IDs',
  );
  return {
    approvals,
    proposalHash: hash(source.proposalHash, 'proposal hash'),
    providerApiCallCount: boundedInteger(source.providerApiCallCount, 'provider API call count', 0, 1_000_000),
    reviewId: matching(source.reviewId, /^review-[0-9a-f]{16}$/u, 'authority review ID'),
    revision: boundedInteger(source.revision, 'authority review revision', 1, 10_000),
  };
}

function parseApproval(value: unknown): Threadnote5GitProposalAuthorityV1['trials'][number]['approvals'][number] {
  const source = exactObject(
    value,
    ['applyAuditDigest', 'approvedContentHash', 'candidateId', 'sourceUriHash'],
    'Git proposal approval authority',
  );
  return {
    applyAuditDigest: hash(source.applyAuditDigest, 'apply audit digest'),
    approvedContentHash: hash(source.approvedContentHash, 'approved content hash'),
    candidateId: matching(source.candidateId, /^review-[0-9a-f]{16}-[1-3]$/u, 'approved candidate ID'),
    sourceUriHash: hash(source.sourceUriHash, 'approved source URI hash'),
  };
}

function parseCommandResult(value: unknown): Threadnote5ProcedureAuthorityV1['commandResults'][number] {
  const source = exactObject(value, ['commandId', 'exitCode', 'outputDigest'], 'procedure command result');
  return {
    commandId: boundedText(source.commandId, 'procedure command ID', 128),
    exitCode: boundedInteger(source.exitCode, 'procedure command exit code', -255, 255),
    outputDigest: hash(source.outputDigest, 'procedure command output digest'),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const source = object(value, label);
  exactKeys(source, keys, label);
  return source;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (canonicalJson(EffectRecord.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!checkedIsSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is out of bounds.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    Effect.pipe(value, EffectString.trim) !== value ||
    value.length < 1 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const parsed = boundedText(value, label, 256);
  if (!pattern.test(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function hash(value: unknown, label: string): string {
  return matching(value, /^[0-9a-f]{64}$/u, label);
}

function gitCommit(value: unknown, label: string): string {
  return matching(value, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, label);
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}
