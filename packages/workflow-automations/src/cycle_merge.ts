import {Array as EffectArray, String as EffectString, Option as EffectOption} from 'effect';
import {Schema, Record as EffectRecord} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';
import {nativeCycleHasControl, nativeCyclePhaseHash, type NativeCyclePlan} from './cycle.js';
import type {NativeCycleRuntime} from './cycle_runtime.js';
import type {NativeCycleSnapshot} from './cycle_review.js';

const object = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const paths = Schema.Array(text).check(Schema.isMaxLength(8192));
const entry = Schema.Struct({
  mode: Schema.String.check(Schema.isPattern(/^(?:000000|100644|100755|120000|160000)$/u)),
  blob: object,
});
const evidence = Schema.Array(
  Schema.Struct({path: text, baseline: entry, oldBase: entry, currentBase: entry, head: entry}),
).check(Schema.isMaxLength(8192));
const pin = Schema.String.check(
  Schema.isPattern(/^refs\/threadnote\/cycles\/(?:merge-prior|merge-head|merge-old-base|merge-base)\/[a-f0-9]{64}$/u),
);

export const NativeCycleOrdinaryMergeInputSchema = Schema.Struct({
  priorHead: object,
  currentBaseHead: object,
  currentHead: object,
  fromBaseBranch: text,
  planDocumentHash: digest,
  phaseOwnedPaths: Schema.Array(
    Schema.Struct({phaseId: id, paths: Schema.Array(text).check(Schema.isBetweenLength(1, 256))}),
  ).check(Schema.isBetweenLength(1, 128)),
});
export type NativeCycleOrdinaryMergeInput = typeof NativeCycleOrdinaryMergeInputSchema.Type;
export const NativeCycleOrdinaryMergeReceiptSchema = Schema.Struct({
  ...NativeCycleOrdinaryMergeInputSchema.fields,
  format: Schema.Literal('threadnote-native-ordinary-merge-qualification'),
  version: Schema.Literal(1),
  priorSnapshotId: id,
  priorTree: object,
  priorDeclaredBaseHead: object,
  priorDeclaredBaseTree: object,
  currentBaseTree: object,
  baselineHead: object,
  toBaseBranch: text,
  expectedRevision: digest,
  reason: text,
  authority: text,
  capturedBaselinePaths: paths,
  currentBaseChangedPaths: paths,
  inheritedUpstreamOnlyPaths: paths,
  currentBaseEvidence: evidence,
  upstreamEvidence: evidence,
  mergeBases: Schema.Struct({bases: object, prior: object, current: object}),
  priorHeadRef: pin,
  currentHeadRef: pin,
  priorBaseRef: pin,
  currentBaseRef: pin,
  receiptDigest: digest,
});
export type NativeCycleOrdinaryMergeReceipt = typeof NativeCycleOrdinaryMergeReceiptSchema.Type;

const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-ordinary-merge', message});
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const safe = (path: string) =>
  !nativeCycleHasControl(path) &&
  !/[\\:*?[\]]/u.test(path) &&
  EffectArray.every(EffectString.split(path, '/'), part => !!part && part !== '.' && part !== '..');
const ordered = (values: readonly string[]) =>
  EffectArray.every(values, (value, i) => safe(value) && (i === 0 || values[i - 1] < value));
const sameEntry = (a: {mode: string; blob: string}, b: {mode: string; blob: string}) =>
  a.mode === b.mode && a.blob === b.blob;

/** The caller supplies the complete owner map; permissions come only from the reviewed plan. */
export function validateNativeCycleMergeOwners(
  plan: NativeCyclePlan,
  input: Pick<NativeCycleOrdinaryMergeInput, 'planDocumentHash' | 'phaseOwnedPaths'>,
  changed: readonly string[],
) {
  if (input.planDocumentHash !== plan.source.documentHash || changed.length > 256 || !ordered(changed))
    fail('Use the current verified plan and a bounded canonical current-base path set.');
  if (!ordered(EffectArray.map(input.phaseOwnedPaths, owner => owner.phaseId))) fail('Use unique sorted phase owners.');
  for (const owner of input.phaseOwnedPaths) {
    const phase = EffectOption.getOrUndefined(EffectArray.findFirst(plan.phases, item => item.id === owner.phaseId));
    if (
      !phase ||
      !owner.paths.length ||
      !ordered(owner.paths) ||
      owner.paths.length > 256 ||
      EffectArray.some(owner.paths, path => !changed.includes(path) || !phase.allowedPaths.includes(path))
    )
      fail('Every owner requires explicit literal permission in the reviewed plan.');
  }
  for (const path of changed) {
    const permitted = EffectArray.map(
      EffectArray.filter(plan.phases, phase => phase.allowedPaths.includes(path)),
      phase => phase.id,
    ).sort();
    const declared = EffectArray.map(
      EffectArray.filter(input.phaseOwnedPaths, owner => owner.paths.includes(path)),
      owner => owner.phaseId,
    );
    if (!permitted.length || !same(permitted, declared)) fail('Name every reviewed owner of every changed path.');
  }
}

export function nativeCycleMergeReceiptDigest(
  snapshot: NativeCycleSnapshot,
  receipt: Omit<NativeCycleOrdinaryMergeReceipt, 'receiptDigest'>,
): string {
  // Tuples give stable ordering across canonical state serialization and schema decoding.
  const tuple = (items: NativeCycleOrdinaryMergeReceipt['upstreamEvidence']) =>
    EffectArray.map(items, item => [
      item.path,
      ...EffectArray.map([item.baseline, item.oldBase, item.currentBase, item.head], value => [value.mode, value.blob]),
    ]);
  return sha256HexSync(
    JSON.stringify([
      'threadnote-native-ordinary-merge-v1',
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
      snapshot.previous,
      snapshot.supersedes,
      snapshot.previousTree,
      snapshot.acceptedHead,
      snapshot.pinnedRef,
      receipt.format,
      receipt.version,
      receipt.priorHead,
      receipt.currentBaseHead,
      receipt.currentHead,
      receipt.fromBaseBranch,
      receipt.planDocumentHash,
      EffectArray.map(receipt.phaseOwnedPaths, owner => [owner.phaseId, owner.paths]),
      receipt.priorSnapshotId,
      receipt.priorTree,
      receipt.priorDeclaredBaseHead,
      receipt.priorDeclaredBaseTree,
      receipt.currentBaseTree,
      receipt.baselineHead,
      receipt.toBaseBranch,
      receipt.expectedRevision,
      receipt.reason,
      receipt.authority,
      receipt.capturedBaselinePaths,
      receipt.currentBaseChangedPaths,
      receipt.inheritedUpstreamOnlyPaths,
      tuple(receipt.currentBaseEvidence),
      tuple(receipt.upstreamEvidence),
      receipt.mergeBases.bases,
      receipt.mergeBases.prior,
      receipt.mergeBases.current,
      receipt.priorHeadRef,
      receipt.currentHeadRef,
      receipt.priorBaseRef,
      receipt.currentBaseRef,
    ]),
  );
}

/** Validate persisted conservation and provenance without granting any new path permission. */
export function validateNativeCycleMergeReceipt(
  snapshot: NativeCycleSnapshot,
  prior: NativeCycleSnapshot,
  plans: readonly NativeCyclePlan[],
  baselineHead: string,
) {
  const receipt = snapshot.ordinaryMergeQualificationV1;
  if (!receipt || snapshot.version !== 2 || snapshot.baseRequalification)
    return fail('Use the dedicated version2 merge manifest.');
  const plan = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      plans,
      item =>
        item.source.documentHash === receipt.planDocumentHash &&
        EffectArray.some(
          item.phases,
          phase =>
            phase.id === snapshot.phaseId &&
            nativeCyclePhaseHash(item, phase.id) === snapshot.phaseHash &&
            phase.baseBranch === receipt.toBaseBranch,
        ),
    ),
  );
  if (
    !plan ||
    !EffectArray.some(plans, item =>
      EffectArray.some(
        item.phases,
        phase =>
          phase.id === prior.phaseId &&
          nativeCyclePhaseHash(item, phase.id) === prior.phaseHash &&
          phase.baseBranch === receipt.fromBaseBranch,
      ),
    )
  )
    fail('Retain both reviewed plan bindings.');
  validateNativeCycleMergeOwners(plan!, receipt, receipt.currentBaseChangedPaths);
  if (!EffectArray.some(receipt.phaseOwnedPaths, owner => owner.phaseId === snapshot.phaseId))
    fail('The selected phase must own a nonempty current-base patch.');
  if (
    receipt.priorSnapshotId !== prior.snapshotId ||
    receipt.priorHead !== prior.head ||
    receipt.priorTree !== prior.tree ||
    receipt.priorDeclaredBaseHead !== prior.declaredBaseHead ||
    receipt.currentBaseHead !== snapshot.declaredBaseHead ||
    receipt.currentHead !== snapshot.head ||
    receipt.currentBaseTree !== snapshot.scopeBase ||
    receipt.baselineHead !== baselineHead ||
    snapshot.acceptedHead !== snapshot.head ||
    receipt.priorDeclaredBaseHead === receipt.currentBaseHead ||
    receipt.mergeBases.bases !== receipt.priorDeclaredBaseHead ||
    receipt.mergeBases.prior !== prior.head ||
    receipt.mergeBases.current !== snapshot.declaredBaseHead ||
    !EffectString.trim(receipt.reason) ||
    !EffectString.trim(receipt.authority) ||
    !same(receipt.capturedBaselinePaths, snapshot.files) ||
    !same(receipt.currentBaseChangedPaths, snapshot.scopeFiles) ||
    !ordered(receipt.capturedBaselinePaths) ||
    !ordered(receipt.inheritedUpstreamOnlyPaths) ||
    !same(
      [...receipt.currentBaseChangedPaths, ...receipt.inheritedUpstreamOnlyPaths].sort(),
      receipt.capturedBaselinePaths,
    ) ||
    !same(
      EffectArray.map(receipt.currentBaseEvidence, item => item.path),
      receipt.currentBaseChangedPaths,
    ) ||
    !same(
      EffectArray.map(receipt.upstreamEvidence, item => item.path),
      receipt.inheritedUpstreamOnlyPaths,
    )
  )
    fail('Merge provenance or the disjoint exhaustive path partition changed.');
  for (const item of [...receipt.currentBaseEvidence, ...receipt.upstreamEvidence]) {
    for (const value of [item.baseline, item.oldBase, item.currentBase, item.head])
      if ((value.mode === '000000') !== /^0+$/u.test(value.blob))
        fail('Absent tree entries require the zero object identity.');
    if (
      receipt.currentBaseChangedPaths.includes(item.path)
        ? sameEntry(item.currentBase, item.head)
        : !sameEntry(item.currentBase, item.head) ||
          sameEntry(item.oldBase, item.currentBase) ||
          sameEntry(item.baseline, item.head)
    )
      fail('Every path requires positive mode and object evidence for its partition.');
  }
  if (receipt.receiptDigest !== nativeCycleMergeReceiptDigest(snapshot, receipt)) fail('Merge receipt digest changed.');
}

export const NativeCycleSameLabelRebasedBaseInputSchema = Schema.Struct({
  priorSnapshotId: id,
  expectedPriorEntryDigest: digest,
  expectedPriorReviewDigest: digest,
  currentBaseHead: object,
  currentHead: object,
  sameBaseBranch: text,
  authorityKind: Schema.Literal('same-label-upstream-rebase-integration'),
  planDocumentHash: digest,
  phaseOwnedPaths: NativeCycleOrdinaryMergeInputSchema.fields.phaseOwnedPaths,
});
export type NativeCycleSameLabelRebasedBaseInput = typeof NativeCycleSameLabelRebasedBaseInputSchema.Type;
export const NativeCycleSameLabelRebasedBaseReceiptSchema = Schema.Struct({
  ...NativeCycleOrdinaryMergeReceiptSchema.fields,
  ...NativeCycleSameLabelRebasedBaseInputSchema.fields,
  format: Schema.Literal('threadnote-native-same-label-rebased-base-integration'),
  independentReviewRequired: Schema.Literal(true),
  runId: id,
  generation: text,
  bindingId: digest,
  project: text,
  repo: text,
  commonDirectory: text,
  worktreeDirectory: text,
  gitDirectory: text,
  phaseBranch: text,
  priorScopeBase: object,
  priorScopeRef: Schema.String.check(Schema.isPattern(/^refs\/threadnote\/cycles\/merge-scope\/[a-f0-9]{64}$/u)),
  mergeBases: Schema.Struct({prior: object, current: object}),
  priorPinnedRef: text,
  baselineTree: object,
  baselinePinnedRef: text,
  history: Schema.Struct({
    baselines: Schema.Array(id).check(Schema.isMaxLength(128)),
    snapshots: Schema.Array(id).check(Schema.isMaxLength(256)),
    reviews: Schema.Array(id).check(Schema.isMaxLength(256)),
    attempts: Schema.Array(id).check(Schema.isMaxLength(512)),
    plans: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 64})),
    expansions: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 256})),
    digest,
  }),
  historicalMergeBases: Schema.Array(object).check(Schema.isMaxLength(256)),
  sourceEvidence: Schema.Array(
    Schema.Struct({
      path: text,
      baseline: entry,
      declaredBase: entry,
      priorScope: entry,
      prior: entry,
      currentBase: entry,
      head: entry,
    }),
  ).check(Schema.isMaxLength(8192)),
  reconciliationPaths: paths,
  reconciliationEvidence: Schema.Array(
    Schema.Struct({
      path: text,
      baseline: entry,
      declaredBase: entry,
      priorScope: entry,
      prior: entry,
      currentBase: entry,
      head: entry,
    }),
  ).check(Schema.isMaxLength(8192)),
});
export type NativeCycleSameLabelRebasedBaseReceipt = typeof NativeCycleSameLabelRebasedBaseReceiptSchema.Type;

/** Sorted object keys, original array order, and JSON primitives; independent of codec field ordering. */
const canonicalEvidence = (value: unknown): unknown => {
  if (EffectArray.isArray(value)) return EffectArray.map(value, canonicalEvidence);
  if (value !== null && typeof value === 'object')
    return EffectRecord.fromEntries(
      EffectArray.map(
        EffectArray.filter(
          EffectRecord.toEntries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ([, item]) => item !== undefined,
        ),
        ([key, item]) => [key, canonicalEvidence(item)] as const,
      ),
    );
  return value;
};
export const nativeCycleQualificationEvidenceDigest = (domain: string, value: unknown): string =>
  sha256HexSync(JSON.stringify(['threadnote-native-same-label-rebased-base-v1', domain, canonicalEvidence(value)]));

export function nativeCycleQualificationHistory(runtime: NativeCycleRuntime) {
  const history = {
    baselines: EffectRecord.keys(runtime.baselines).sort(),
    snapshots: EffectArray.map(runtime.snapshots, item => item.snapshot.snapshotId),
    reviews: EffectArray.map(runtime.reviews, item => item.snapshotId),
    attempts: EffectArray.map(runtime.attempts, item => item.id),
    plans: runtime.plans.length,
    expansions: runtime.reviewExpansions.length,
  };
  return {
    ...history,
    digest: nativeCycleQualificationEvidenceDigest('history', [
      runtime.baselines,
      runtime.snapshots,
      runtime.reviews,
      runtime.attempts,
      runtime.plans,
      runtime.reviewExpansions,
      runtime.reviewLimits,
    ]),
  };
}
export function nativeCycleSameLabelRebasedBaseReceiptDigest(
  snapshot: NativeCycleSnapshot,
  receipt: Omit<NativeCycleSameLabelRebasedBaseReceipt, 'receiptDigest'>,
): string {
  const {sameLabelRebasedBaseIntegrationV1: _witness, ...source} = snapshot;
  const {receiptDigest: _digest, ...proof} = {...receipt, receiptDigest: ''};
  return nativeCycleQualificationEvidenceDigest('receipt', [source, proof]);
}

/** Retained records and history are authority; request digests are only CAS expectations. */
export function validateNativeCycleSameLabelRebasedBaseReceipt(
  snapshot: NativeCycleSnapshot,
  runtime: NativeCycleRuntime,
  snapshotIndex: number,
) {
  const proof = snapshot.sameLabelRebasedBaseIntegrationV1;
  const priorEntry = EffectOption.getOrUndefined(
    EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === proof?.priorSnapshotId),
  );
  const review = EffectOption.getOrUndefined(
    EffectArray.findFirst(runtime.reviews, item => item.snapshotId === proof?.priorSnapshotId),
  );
  const prior = priorEntry?.snapshot;
  const baseline = runtime.baselines[snapshot.phaseId];
  const plan = EffectOption.getOrUndefined(
    EffectArray.findFirst(runtime.plans, item => item.source.documentHash === proof?.planDocumentHash),
  );
  const phase = plan
    ? EffectOption.getOrUndefined(EffectArray.findFirst(plan.phases, item => item.id === snapshot.phaseId))
    : undefined;
  if (!proof || snapshot.version !== 3 || !prior || !review || !baseline || !plan || !phase)
    return fail('Retain the reviewed predecessor, original baseline and exact approved plan.');
  const history = proof.history;
  const snapshots = runtime.snapshots.slice(0, snapshotIndex);
  const reviews = runtime.reviews.slice(0, history.reviews.length);
  const attempts = runtime.attempts.slice(0, history.attempts.length);
  const plans = runtime.plans.slice(0, history.plans);
  const expansions = runtime.reviewExpansions.slice(0, history.expansions);
  const phaseSnapshots = EffectArray.filter(snapshots, item => item.snapshot.phaseId === snapshot.phaseId);
  const latest = phaseSnapshots.at(-1)?.snapshot;
  if (latest?.snapshotId !== prior.snapshotId) {
    const priorIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(phaseSnapshots, item => item.snapshot.snapshotId === prior.snapshotId),
      () => -1,
    );
    if (
      !latest ||
      priorIndex < 0 ||
      prior.phaseHash === snapshot.phaseHash ||
      latest.phaseHash === snapshot.phaseHash ||
      EffectArray.some(phaseSnapshots.slice(priorIndex + 1), item =>
        EffectArray.some(reviews, review => review.snapshotId === item.snapshot.snapshotId),
      )
    )
      fail('Continue from the latest retained reviewed source boundary.');
  }
  const limits = EffectRecord.fromEntries(EffectArray.map(expansions, item => [item.phaseId, item.to] as const));
  const baselines = EffectRecord.fromEntries(
    EffectArray.map(history.baselines, id => [id, runtime.baselines[id]] as const),
  );
  if (
    !same(
      EffectArray.map(snapshots, item => item.snapshot.snapshotId),
      history.snapshots,
    ) ||
    !same(
      EffectArray.map(reviews, item => item.snapshotId),
      history.reviews,
    ) ||
    !same(
      EffectArray.map(attempts, item => item.id),
      history.attempts,
    ) ||
    plans.length !== history.plans ||
    expansions.length !== history.expansions ||
    history.digest !==
      nativeCycleQualificationEvidenceDigest('history', [
        baselines,
        snapshots,
        reviews,
        attempts,
        plans,
        expansions,
        limits,
      ]) ||
    !history.snapshots.includes(prior.snapshotId) ||
    !history.reviews.includes(prior.snapshotId) ||
    proof.expectedPriorEntryDigest !== nativeCycleQualificationEvidenceDigest('predecessor-entry', priorEntry) ||
    proof.expectedPriorReviewDigest !== nativeCycleQualificationEvidenceDigest('predecessor-review', review)
  )
    fail('Retained source, reviews, attempts, plans, original baselines or review budget history changed.');
  if (
    proof.runId !== runtime.state.plan.source.binding.runId ||
    proof.generation !== runtime.state.plan.source.binding.generation ||
    proof.bindingId !== plan.source.binding.bindingId ||
    proof.runId !== plan.source.binding.runId ||
    proof.generation !== plan.source.binding.generation ||
    proof.project !== plan.project ||
    proof.repo !== snapshot.repo ||
    proof.repo !== prior.repo ||
    proof.repo !== baseline.repo ||
    proof.worktreeDirectory !== proof.repo ||
    proof.phaseBranch !== phase.branch ||
    proof.sameBaseBranch !== phase.baseBranch ||
    proof.fromBaseBranch !== phase.baseBranch ||
    proof.toBaseBranch !== phase.baseBranch ||
    !EffectArray.some(runtime.plans, item =>
      EffectArray.some(
        item.phases,
        p =>
          p.id === prior.phaseId &&
          nativeCyclePhaseHash(item, p.id) === prior.phaseHash &&
          p.baseBranch === proof.sameBaseBranch &&
          p.branch === proof.phaseBranch &&
          item.source.binding.bindingId === proof.bindingId &&
          item.source.binding.runId === proof.runId &&
          item.source.binding.generation === proof.generation &&
          item.source.binding.profile === plan.source.binding.profile &&
          item.source.binding.team === plan.source.binding.team &&
          item.project === proof.project &&
          item.featureId === plan.featureId,
      ),
    ) ||
    snapshot.phaseHash !== nativeCyclePhaseHash(plan, phase.id) ||
    prior.phaseId !== snapshot.phaseId ||
    (snapshot.previous ?? snapshot.supersedes) !== prior.snapshotId ||
    proof.priorHead !== prior.head ||
    proof.priorTree !== prior.tree ||
    proof.priorScopeBase !== prior.scopeBase ||
    proof.priorPinnedRef !== prior.pinnedRef ||
    proof.priorDeclaredBaseHead !== prior.declaredBaseHead ||
    proof.currentHead !== snapshot.head ||
    proof.currentBaseHead !== snapshot.declaredBaseHead ||
    proof.currentBaseTree !== snapshot.scopeBase ||
    proof.baselineHead !== baseline.head ||
    proof.baselineTree !== baseline.tree ||
    proof.baselinePinnedRef !== baseline.pinnedRef ||
    proof.priorDeclaredBaseHead === proof.currentBaseHead ||
    snapshot.acceptedHead !== snapshot.head ||
    proof.mergeBases.prior !== prior.head ||
    proof.mergeBases.current !== snapshot.declaredBaseHead ||
    proof.authorityKind !== 'same-label-upstream-rebase-integration' ||
    !proof.independentReviewRequired ||
    !EffectString.trim(proof.reason) ||
    !EffectString.trim(proof.authority)
  )
    fail('Same-label integration lost its original identity, retained provenance or explicit authority.');
  validateNativeCycleMergeOwners(plan, proof, proof.currentBaseChangedPaths);
  if (
    !EffectArray.some(proof.phaseOwnedPaths, owner => owner.phaseId === snapshot.phaseId) ||
    !same(proof.currentBaseChangedPaths, snapshot.scopeFiles) ||
    !same(proof.capturedBaselinePaths, snapshot.files) ||
    !ordered(proof.capturedBaselinePaths) ||
    !ordered(proof.inheritedUpstreamOnlyPaths) ||
    !same([...proof.currentBaseChangedPaths, ...proof.inheritedUpstreamOnlyPaths].sort(), snapshot.files) ||
    !same(
      EffectArray.map(proof.currentBaseEvidence, item => item.path),
      proof.currentBaseChangedPaths,
    ) ||
    !same(
      EffectArray.map(proof.upstreamEvidence, item => item.path),
      proof.inheritedUpstreamOnlyPaths,
    ) ||
    !ordered(proof.reconciliationPaths) ||
    !same(
      EffectArray.map(proof.reconciliationEvidence, item => item.path),
      proof.reconciliationPaths,
    )
  )
    fail('Keep complete canonical current-base ownership, source partitions and prior-tree reconciliation.');
  const expectedEvidencePaths = [
    ...new Set([...snapshot.files, ...prior.files, ...prior.scopeFiles, ...proof.reconciliationPaths]),
  ].sort();
  if (
    !same(
      EffectArray.map(proof.sourceEvidence, item => item.path),
      expectedEvidencePaths,
    ) ||
    !same(
      EffectArray.filter(proof.sourceEvidence, item => !sameEntry(item.prior, item.head)),
      proof.reconciliationEvidence,
    )
  )
    fail('Retain full predecessor and current source evidence independently of the current-base permission set.');
  for (const item of [...proof.currentBaseEvidence, ...proof.upstreamEvidence]) {
    const source = EffectOption.getOrUndefined(
      EffectArray.findFirst(proof.sourceEvidence, value => value.path === item.path),
    );
    if (
      !source ||
      !sameEntry(source.baseline, item.baseline) ||
      !sameEntry(source.priorScope, item.oldBase) ||
      !sameEntry(source.currentBase, item.currentBase) ||
      !sameEntry(source.head, item.head)
    )
      fail('Current-base partitions must agree with the full retained source evidence.');

    if (
      proof.currentBaseChangedPaths.includes(item.path)
        ? sameEntry(item.currentBase, item.head)
        : !sameEntry(item.currentBase, item.head) || sameEntry(item.baseline, item.head)
    )
      fail('Current-base partitions require positive tree entry evidence.');
  }
  for (const item of proof.sourceEvidence) {
    for (const value of [item.baseline, item.declaredBase, item.priorScope, item.prior, item.currentBase, item.head])
      if ((value.mode === '000000') !== /^0+$/u.test(value.blob)) fail('Absent entries require zero identities.');
  }
  if (proof.receiptDigest !== nativeCycleSameLabelRebasedBaseReceiptDigest(snapshot, proof))
    fail('Same-label integration receipt digest changed.');
}
