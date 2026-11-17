import {Array as EffectArray, String as EffectString, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';
import {nativeCycleHasControl, nativeCyclePhaseHash, type NativeCyclePlan} from './cycle.js';
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

/** Separate invalid-tail proof preserves the existing owned immutable retention refs. */
export const NativeCycleInvalidTailMergeReceiptSchema = Schema.Struct({
  ...NativeCycleOrdinaryMergeReceiptSchema.fields,
  format: Schema.Literal('threadnote-native-invalid-tail-merge-qualification'),
  basisSnapshotId: id,
  basisReviewDigest: digest,
  basisAttemptId: id,
  taskRefDigest: digest,
  predecessorRefDigest: digest,
  operationDigest: digest,
});
export type NativeCycleInvalidTailMergeReceipt = typeof NativeCycleInvalidTailMergeReceiptSchema.Type;

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
  input: NativeCycleOrdinaryMergeInput,
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

export function nativeCycleInvalidTailMergeReceiptDigest(
  snapshot: NativeCycleSnapshot,
  receipt: Omit<NativeCycleInvalidTailMergeReceipt, 'receiptDigest'>,
): string {
  const ordinary = {...receipt, format: 'threadnote-native-ordinary-merge-qualification' as const};
  return sha256HexSync(
    JSON.stringify([
      'threadnote-native-invalid-tail-merge-v1',
      nativeCycleMergeReceiptDigest(snapshot, ordinary),
      receipt.basisSnapshotId,
      receipt.basisReviewDigest,
      receipt.basisAttemptId,
      receipt.taskRefDigest,
      receipt.predecessorRefDigest,
      receipt.operationDigest,
    ]),
  );
}

export function validateNativeCycleInvalidTailMergeReceipt(
  snapshot: NativeCycleSnapshot,
  prior: NativeCycleSnapshot,
  plans: readonly NativeCyclePlan[],
  baselineHead: string,
) {
  const proof = snapshot.invalidTailMergeQualificationV1;
  if (
    !proof ||
    snapshot.version !== 3 ||
    snapshot.baseRequalification ||
    snapshot.ordinaryMergeQualificationV1 ||
    snapshot.previous !== prior.snapshotId ||
    snapshot.phaseHash !== prior.phaseHash ||
    snapshot.supersedes ||
    proof.fromBaseBranch !== proof.toBaseBranch
  )
    return fail('Use the distinct same-label invalid-tail merge witness and owned immutable retention refs.');
  const ordinary = {...proof, format: 'threadnote-native-ordinary-merge-qualification' as const};
  const adapted = {
    ...snapshot,
    version: 2 as const,
    invalidTailMergeQualificationV1: undefined,
    ordinaryMergeQualificationV1: {...ordinary, receiptDigest: nativeCycleMergeReceiptDigest(snapshot, ordinary)},
  };
  validateNativeCycleMergeReceipt(adapted, prior, plans, baselineHead);
  if (proof.receiptDigest !== nativeCycleInvalidTailMergeReceiptDigest(snapshot, proof))
    return fail('Invalid-tail merge receipt digest changed.');
}
