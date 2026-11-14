import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {WorkflowAutomationError} from './contracts.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {nativeCycleCanonicalJson, nativeCycleHasControl} from './cycle.js';
import {
  NativeCycleInvalidTailMergeReceiptSchema,
  NativeCycleOrdinaryMergeReceiptSchema,
  NativeCycleSameLabelRebasedBaseReceiptSchema,
  nativeCycleInvalidTailMergeReceiptDigest,
} from './cycle_merge.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export {
  NativeCycleSameLabelRebasedBaseInputSchema,
  nativeCycleQualificationEvidenceDigest,
  nativeCycleQualificationHistory,
  nativeCycleSameLabelRebasedBaseReceiptDigest,
  validateNativeCycleSameLabelRebasedBaseReceipt,
  NativeCycleOrdinaryMergeInputSchema,
  NativeCycleInvalidTailMergeReceiptSchema,
  nativeCycleInvalidTailMergeReceiptDigest,
  validateNativeCycleInvalidTailMergeReceipt,
  nativeCycleMergeReceiptDigest,
  validateNativeCycleMergeOwners,
  validateNativeCycleMergeReceipt,
} from './cycle_merge.js';
export type {
  NativeCycleSameLabelRebasedBaseInput,
  NativeCycleSameLabelRebasedBaseReceipt,
  NativeCycleInvalidTailMergeReceipt,
  NativeCycleOrdinaryMergeInput,
  NativeCycleOrdinaryMergeReceipt,
} from './cycle_merge.js';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const text = (maximum = 4096) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-cycle-review', message});
};

export const NativeCycleRebaseInputSchema = Schema.Struct({
  preRebaseHead: gitObject,
  ontoHead: gitObject,
  rebasedHead: gitObject,
});
export type NativeCycleRebaseInput = typeof NativeCycleRebaseInputSchema.Type;
const rebaseReceipt = Schema.Struct({
  ...NativeCycleRebaseInputSchema.fields,
  reason: text(),
  authority: text(),
  receiptDigest: digest,
  beforeRef: Schema.String.check(Schema.isPattern(/^refs\/threadnote\/cycles\/rebase-before\/[a-f0-9]{64}$/u)),
  afterRef: Schema.String.check(Schema.isPattern(/^refs\/threadnote\/cycles\/rebase-after\/[a-f0-9]{64}$/u)),
});

export const NativeCycleBaseRequalificationInputSchema = Schema.Struct({
  preRebaseHead: gitObject,
  ontoHead: gitObject,
  rebasedHead: gitObject,
  fromBaseBranch: text(),
});
export type NativeCycleBaseRequalificationInput = typeof NativeCycleBaseRequalificationInputSchema.Type;
const baseRequalificationReceipt = Schema.Struct({
  ...NativeCycleBaseRequalificationInputSchema.fields,
  toBaseBranch: text(),
  priorDeclaredBaseHead: gitObject,
  reason: text(),
  authority: text(),
  receiptDigest: digest,
  beforeRef: Schema.String.check(Schema.isPattern(/^refs\/threadnote\/cycles\/requalification-before\/[a-f0-9]{64}$/u)),
  afterRef: Schema.String.check(Schema.isPattern(/^refs\/threadnote\/cycles\/requalification-after\/[a-f0-9]{64}$/u)),
  priorBaseRef: Schema.String.check(
    Schema.isPattern(/^refs\/threadnote\/cycles\/requalification-base\/[a-f0-9]{64}$/u),
  ),
});

const retainedCommitRef = Schema.String.check(
  Schema.isPattern(/^refs\/threadnote\/cycles\/(?:snapshot-head|snapshot-base|merge-head|merge-base)\/[a-f0-9]{64}$/u),
);
const comparisonEvidence = Schema.Struct({
  version: Schema.Literal(1),
  baseBranch: text(),
  baseTree: gitObject,
  sourceRef: retainedCommitRef,
  baseRef: retainedCommitRef,
});
const unreviewedRebaseRecovery = Schema.Struct({
  version: Schema.Literal(1),
  priorHead: gitObject,
  priorBaseHead: gitObject,
  fromBaseBranch: text(),
  toBaseBranch: text(),
  authority: text(),
  receiptDigest: digest,
});

export const NativeCycleSnapshotSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-cycle-snapshot'),
  version: Schema.Literals([1, 2, 3]),
  snapshotId: id,
  phaseId: id,
  phaseHash: digest,
  repo: text(),
  head: gitObject,
  baseTree: gitObject,
  scopeBase: gitObject,
  declaredBaseHead: gitObject,
  scopeFiles: Schema.Array(text()).check(Schema.isMaxLength(8192)),
  tree: gitObject,
  previous: Schema.optionalKey(id),
  supersedes: Schema.optionalKey(id),
  previousTree: Schema.optionalKey(gitObject),
  comparisonEvidence: Schema.optionalKey(comparisonEvidence),
  unreviewedSupersession: Schema.optionalKey(
    Schema.Struct({
      reason: text(),
      rebaseRecovery: Schema.optionalKey(unreviewedRebaseRecovery),
    }),
  ),
  acceptedHead: Schema.optionalKey(gitObject),
  rebase: Schema.optionalKey(rebaseReceipt),
  baseRequalification: Schema.optionalKey(baseRequalificationReceipt),
  sameLabelRebasedBaseIntegrationV1: Schema.optionalKey(NativeCycleSameLabelRebasedBaseReceiptSchema),
  ordinaryMergeQualificationV1: Schema.optionalKey(NativeCycleOrdinaryMergeReceiptSchema),
  invalidTailMergeQualificationV1: Schema.optionalKey(NativeCycleInvalidTailMergeReceiptSchema),
  files: Schema.Array(text()).check(Schema.isMaxLength(8192)),
  pinnedRef: text(),
}).check(
  Schema.makeFilter(snapshot =>
    (snapshot.version === 3) !==
      !!(snapshot.sameLabelRebasedBaseIntegrationV1 || snapshot.invalidTailMergeQualificationV1) ||
    (snapshot.sameLabelRebasedBaseIntegrationV1 &&
      (snapshot.invalidTailMergeQualificationV1 ||
        snapshot.ordinaryMergeQualificationV1 ||
        snapshot.baseRequalification ||
        snapshot.rebase ||
        snapshot.unreviewedSupersession)) ||
    (snapshot.invalidTailMergeQualificationV1 &&
      (snapshot.sameLabelRebasedBaseIntegrationV1 ||
        snapshot.baseRequalification ||
        snapshot.ordinaryMergeQualificationV1 ||
        snapshot.rebase ||
        snapshot.unreviewedSupersession ||
        !snapshot.previous ||
        !snapshot.previousTree ||
        snapshot.supersedes !== undefined)) ||
    (snapshot.version === 2) !== !!snapshot.ordinaryMergeQualificationV1 ||
    (snapshot.ordinaryMergeQualificationV1 && (snapshot.baseRequalification || snapshot.rebase)) ||
    (snapshot.rebase && snapshot.baseRequalification)
      ? 'Use the dedicated manifest version for each mutually exclusive snapshot qualification.'
      : snapshot.unreviewedSupersession &&
          (!snapshot.supersedes ||
            snapshot.previous !== undefined ||
            snapshot.previousTree !== undefined ||
            snapshot.baseRequalification !== undefined ||
            snapshot.ordinaryMergeQualificationV1 !== undefined ||
            snapshot.sameLabelRebasedBaseIntegrationV1 !== undefined ||
            !Effect.pipe(snapshot.unreviewedSupersession.reason, EffectString.trim))
        ? 'An unreviewed supersession requires one explicit superseded snapshot and reason.'
        : undefined,
  ),
);
export type NativeCycleSnapshot = typeof NativeCycleSnapshotSchema.Type;

export function nativeCycleRebaseReceiptDigest(
  snapshot: NativeCycleSnapshot,
  receipt: Omit<NonNullable<NativeCycleSnapshot['rebase']>, 'receiptDigest'>,
): string {
  return sha256HexSync(
    JSON.stringify([
      'threadnote-native-initial-rebase-v1',
      snapshot.snapshotId,
      snapshot.phaseId,
      snapshot.phaseHash,
      snapshot.repo,
      snapshot.head,
      snapshot.baseTree,
      snapshot.tree,
      snapshot.scopeBase,
      snapshot.declaredBaseHead,
      snapshot.files,
      snapshot.scopeFiles,
      receipt.preRebaseHead,
      receipt.ontoHead,
      receipt.rebasedHead,
      receipt.reason,
      receipt.authority,
      receipt.beforeRef,
      receipt.afterRef,
    ]),
  );
}

export function nativeCycleBaseRequalificationReceiptDigest(
  snapshot: NativeCycleSnapshot,
  receipt: Omit<NonNullable<NativeCycleSnapshot['baseRequalification']>, 'receiptDigest'>,
): string {
  return sha256HexSync(
    JSON.stringify([
      'threadnote-native-base-requalification-v1',
      snapshot.snapshotId,
      snapshot.phaseId,
      snapshot.phaseHash,
      snapshot.repo,
      snapshot.head,
      snapshot.baseTree,
      snapshot.tree,
      snapshot.scopeBase,
      snapshot.declaredBaseHead,
      snapshot.files,
      snapshot.scopeFiles,
      snapshot.previous ?? snapshot.supersedes,
      snapshot.previousTree,
      snapshot.acceptedHead,
      receipt.preRebaseHead,
      receipt.ontoHead,
      receipt.rebasedHead,
      receipt.fromBaseBranch,
      receipt.toBaseBranch,
      receipt.priorDeclaredBaseHead,
      receipt.reason,
      receipt.authority,
      receipt.beforeRef,
      receipt.afterRef,
      receipt.priorBaseRef,
    ]),
  );
}

export function nativeCycleUnreviewedRecoveryDigest(snapshot: NativeCycleSnapshot): string {
  const recovery = snapshot.unreviewedSupersession?.rebaseRecovery;
  return sha256HexSync(
    JSON.stringify([
      'threadnote-unreviewed-rebase-recovery-v1',
      snapshot.snapshotId,
      snapshot.phaseId,
      snapshot.phaseHash,
      snapshot.repo,
      snapshot.head,
      snapshot.tree,
      snapshot.baseTree,
      snapshot.scopeBase,
      snapshot.declaredBaseHead,
      snapshot.files,
      snapshot.scopeFiles,
      snapshot.supersedes,
      snapshot.acceptedHead,
      snapshot.comparisonEvidence,
      snapshot.unreviewedSupersession?.reason,
      recovery?.priorHead,
      recovery?.priorBaseHead,
      recovery?.fromBaseBranch,
      recovery?.toBaseBranch,
      recovery?.authority,
    ]),
  );
}

const findingSchema = Schema.Struct({
  id,
  file: text(),
  line: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  body: text(8192),
  trigger: text(),
  impact: text(),
  evidence: text(),
  severity: Schema.Literals(['critical', 'important', 'minor', 'informational']),
  category: Schema.Literals([
    'security',
    'performance',
    'architecture',
    'quality',
    'flaky-test',
    'devex',
    'correctness',
  ]),
  confidence: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 100})),
  state: Schema.Literals(['new', 'carried', 'resolved', 'rejected']),
  reason: Schema.optionalKey(text()),
});
export const NativeCycleReviewSchema = Schema.Struct({
  snapshotId: id,
  phaseHash: digest,
  snapshotTree: gitObject,
  status: Schema.Literal('complete'),
  mode: Schema.Literals(['full', 'incremental']),
  selected: Schema.Array(id).check(Schema.isBetweenLength(1, 16)),
  lanes: Schema.Array(Schema.Struct({name: id, status: Schema.Literal('complete')})).check(
    Schema.isBetweenLength(1, 16),
  ),
  findings: Schema.Array(findingSchema).check(Schema.isMaxLength(512)),
});
export type NativeCycleReview = typeof NativeCycleReviewSchema.Type;
export type NativeCycleAcceptedReview = {
  readonly snapshot: NativeCycleSnapshot;
  readonly review: NativeCycleReview;
};

/** Resolve source ancestry separately from the most recent accepted finding ledger. */
export function nativeCycleReviewBasis(
  snapshot: NativeCycleSnapshot,
  retained: readonly NativeCycleSnapshot[],
  accepted: readonly {readonly snapshotId: string; readonly report: NativeCycleReview}[],
): {readonly previous?: NativeCycleAcceptedReview; readonly findingBasis?: NativeCycleAcceptedReview | null} {
  const snapshots = new Map(EffectArray.map(retained, (item, index) => [item.snapshotId, {item, index}]));
  const reviews = new Map(EffectArray.map(accepted, entry => [entry.snapshotId, entry.report]));
  if (snapshots.size !== retained.length || reviews.size !== accepted.length)
    return fail('Review ancestry contains duplicate retained identities.');
  const visited = new Set([snapshot.snapshotId]);
  let current = snapshot;
  let currentIndex = snapshots.get(snapshot.snapshotId)?.index ?? retained.length;
  while (current.previous || current.supersedes) {
    const predecessor = current.previous ?? current.supersedes;
    const entry = predecessor ? snapshots.get(predecessor) : undefined;
    if (!entry || visited.has(entry.item.snapshotId) || entry.index >= currentIndex)
      return fail('Review ancestry requires an acyclic retained source chain.');
    const prior = entry.item;
    if (
      (current.previous && current.supersedes) ||
      (current.unreviewedSupersession &&
        !current.unreviewedSupersession.rebaseRecovery &&
        current.tree === prior.tree) ||
      current.phaseId !== prior.phaseId ||
      current.baseTree !== prior.baseTree ||
      current.repo !== prior.repo ||
      (current.previous && (current.previousTree !== prior.tree || current.phaseHash !== prior.phaseHash)) ||
      (current.supersedes &&
        (current.unreviewedSupersession
          ? current.phaseHash !== prior.phaseHash
          : current.phaseHash === prior.phaseHash)) ||
      (current.head !== prior.head && current.acceptedHead !== current.head)
    )
      return fail('Review ancestry does not match its retained source boundaries.');
    const report = reviews.get(prior.snapshotId);
    if (report) {
      if (
        current.unreviewedSupersession ||
        report.snapshotId !== prior.snapshotId ||
        report.snapshotTree !== prior.tree ||
        report.phaseHash !== prior.phaseHash
      )
        return fail('Accepted review basis does not match its retained source.');
      const basis = {snapshot: prior, review: report};
      return snapshot.unreviewedSupersession ? {findingBasis: basis} : {previous: basis};
    }
    if (!snapshot.unreviewedSupersession) return fail('Prior review evidence is required.');
    visited.add(prior.snapshotId);
    current = prior;
    currentIndex = entry.index;
  }
  return snapshot.unreviewedSupersession ? {findingBasis: null} : {};
}

/** Review recording mode follows snapshot lineage; it never limits independent review scope. */
export const nativeCycleReviewRecordingMode = (snapshot: NativeCycleSnapshot): 'full' | 'incremental' =>
  snapshot.previous &&
  snapshot.version !== 3 &&
  !snapshot.baseRequalification &&
  !snapshot.ordinaryMergeQualificationV1 &&
  !snapshot.sameLabelRebasedBaseIntegrationV1 &&
  !snapshot.invalidTailMergeQualificationV1
    ? 'incremental'
    : 'full';

const blocking = (finding: NativeCycleReview['findings'][number]) =>
  ['critical', 'important'].includes(finding.severity) && ['new', 'carried'].includes(finding.state);
const safePath = (value: string) =>
  value.length > 0 &&
  !/[\\:]/u.test(value) &&
  !nativeCycleHasControl(value) &&
  !Effect.pipe(value, EffectString.startsWith('/')) &&
  EffectArray.every(Effect.pipe(value, EffectString.split('/')), part => part !== '' && part !== '.' && part !== '..');

export const nativeCycleOrchestratorLane = 'orchestrator';
export const nativeCycleCorrectnessLane = 'correctness';

export function validateNativeCycleReview(
  snapshot: NativeCycleSnapshot,
  input: unknown,
  previous?: NativeCycleAcceptedReview,
  findingBasis?: NativeCycleAcceptedReview | null,
) {
  const result = validateNativeCycleReviewHistory(snapshot, input, previous, findingBasis);
  if (
    snapshot.version === 3 &&
    (result.review.selected.includes('self') || EffectArray.some(result.review.lanes, lane => lane.name === 'self'))
  )
    fail('Same-label qualification requires independent current-source reviewers.');
  if (
    result.review.selected.includes(nativeCycleOrchestratorLane) ||
    EffectArray.some(result.review.lanes, lane => lane.name === nativeCycleOrchestratorLane)
  )
    fail('The orchestrator must not review source. Use independent correctness and simplicity review lanes.');
  if (!result.review.selected.includes(nativeCycleCorrectnessLane))
    fail('Select the required correctness review lane and include its complete report.');
  if (!result.review.selected.includes('simplicity'))
    fail('Select the required simplicity review lane and include its complete report.');
  return result;
}

/** Revalidate stored evidence without applying later submission requirements to its immutable history. */
export function validateNativeCycleReviewHistory(
  snapshot: NativeCycleSnapshot,
  input: unknown,
  previous?: NativeCycleAcceptedReview,
  findingBasis?: NativeCycleAcceptedReview | null,
) {
  let review: NativeCycleReview;
  try {
    review = Schema.decodeUnknownSync(NativeCycleReviewSchema, {onExcessProperty: 'error'})(input);
  } catch {
    return fail('Every selected review lane and finding must have a complete valid report.');
  }
  if (
    review.snapshotId !== snapshot.snapshotId ||
    review.phaseHash !== snapshot.phaseHash ||
    review.snapshotTree !== snapshot.tree ||
    review.mode !== nativeCycleReviewRecordingMode(snapshot)
  )
    fail('Review source or mode does not match its immutable snapshot.');
  const selected = new Set(review.selected),
    lanes = new Set(EffectArray.map(review.lanes, lane => lane.name));
  if (!selected.has(nativeCycleOrchestratorLane) && !selected.has(nativeCycleCorrectnessLane))
    fail('Select the required correctness review lane and include its complete report.');
  if (
    selected.size !== review.selected.length ||
    lanes.size !== review.lanes.length ||
    selected.size !== lanes.size ||
    EffectArray.some([...selected], name => !lanes.has(name))
  )
    fail('Selected and completed review lanes differ.');
  if ((snapshot.previous || snapshot.supersedes) && !previous && !snapshot.unreviewedSupersession)
    fail('Prior review evidence is required.');
  if (snapshot.unreviewedSupersession && previous)
    fail('Unreviewed supersession cannot claim a prior accepted review.');
  if (snapshot.unreviewedSupersession && findingBasis === undefined)
    fail('Unreviewed supersession requires its retained ancestral finding basis.');
  if (snapshot.previous && snapshot.supersedes) fail('A snapshot has one source predecessor.');
  const invalidTail = snapshot.invalidTailMergeQualificationV1;
  // Admission binds the current source phase to the invalid leaf; this argument is its accepted finding ledger.
  if (
    invalidTail &&
    (!previous ||
      snapshot.version !== 3 ||
      !snapshot.previous ||
      snapshot.supersedes ||
      snapshot.baseRequalification ||
      snapshot.ordinaryMergeQualificationV1 ||
      invalidTail.priorSnapshotId !== snapshot.previous ||
      invalidTail.priorTree !== snapshot.previousTree ||
      invalidTail.currentHead !== snapshot.head ||
      invalidTail.currentBaseHead !== snapshot.declaredBaseHead ||
      invalidTail.currentBaseTree !== snapshot.scopeBase ||
      invalidTail.basisSnapshotId !== previous.snapshot.snapshotId ||
      invalidTail.basisReviewDigest !== sha256HexSync(nativeCycleCanonicalJson(previous.review)) ||
      invalidTail.receiptDigest !== nativeCycleInvalidTailMergeReceiptDigest(snapshot, invalidTail))
  )
    fail('Invalid-tail review requires its exact accepted ledger and witnessed source predecessor.');
  if (
    previous &&
    ((snapshot.invalidTailMergeQualificationV1?.basisSnapshotId ?? snapshot.previous ?? snapshot.supersedes) !==
      previous.snapshot.snapshotId ||
      (snapshot.previous &&
        !snapshot.invalidTailMergeQualificationV1 &&
        snapshot.previousTree !== previous.snapshot.tree) ||
      snapshot.phaseId !== previous.snapshot.phaseId ||
      (!invalidTail &&
        (snapshot.previous
          ? snapshot.phaseHash !== previous.snapshot.phaseHash
          : snapshot.phaseHash === previous.snapshot.phaseHash)) ||
      snapshot.baseTree !== previous.snapshot.baseTree ||
      snapshot.repo !== previous.snapshot.repo ||
      (snapshot.head !== previous.snapshot.head && snapshot.acceptedHead !== snapshot.head))
  )
    fail('Review history does not match the source predecessor.');
  if (
    findingBasis &&
    (!snapshot.unreviewedSupersession ||
      findingBasis.snapshot.phaseId !== snapshot.phaseId ||
      findingBasis.snapshot.baseTree !== snapshot.baseTree ||
      findingBasis.snapshot.repo !== snapshot.repo)
  )
    fail('An ancestral finding ledger belongs only to its source-bound unreviewed supersession.');
  const ledger = findingBasis ?? previous;
  const prior = new Map(
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(ledger?.review.findings), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, finding => [finding.id, finding]),
      ),
    ) ?? [],
  );
  const seen = new Set<string>();
  for (const finding of review.findings) {
    if (
      seen.has(finding.id) ||
      !safePath(finding.file) ||
      EffectArray.some(
        [finding.body, finding.trigger, finding.impact, finding.evidence],
        value => !Effect.pipe(value, EffectString.trim),
      )
    )
      fail('Findings require unique IDs, relative locations and concrete evidence.');
    seen.add(finding.id);
    const old = prior.get(finding.id);
    if (
      (['resolved', 'rejected'].includes(finding.state) || (old && blocking(old) && !blocking(finding))) &&
      !Effect.pipe(finding.reason, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      )
    )
      fail('Resolving, rejecting or downgrading a finding requires evidence.');
    if ((['resolved', 'carried'].includes(finding.state) && !old) || (finding.state === 'new' && old))
      fail('Prior findings must retain their identity and disposition.');
  }
  for (const finding of prior.values())
    if (blocking(finding) && !seen.has(finding.id)) fail('A prior blocker disappeared without a disposition.');
  const active = EffectArrayPipe(review.findings, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (finding, __effectArrayIndex) =>
        __effectArrayIndex in __effectArrayValues && ['new', 'carried'].includes(finding.state),
    ),
  );
  return {
    review,
    summary: {
      snapshotId: snapshot.snapshotId,
      snapshotTree: snapshot.tree,
      phaseHash: snapshot.phaseHash,
      blockingIssueCount: EffectArray.filter(active, blocking).length,
      counts: EffectRecord.fromEntries(
        EffectArray.map(['critical', 'important', 'minor', 'informational'], severity => [
          severity,
          EffectArray.filter(active, finding => finding.severity === severity).length,
        ]),
      ),
      resolved: EffectArray.map(
        EffectArray.filter(review.findings, finding => finding.state === 'resolved'),
        finding => finding.id,
      ),
    },
  };
}
