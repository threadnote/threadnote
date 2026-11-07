import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {
  NativeCyclePlanSchema,
  NativeCycleStateSchema,
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  nativeCyclePhaseHash,
} from './cycle.js';
import {
  NativeCycleSnapshotSchema,
  NativeCycleReviewSchema,
  validateNativeCycleReviewHistory,
  validateNativeCycleReview,
  nativeCycleRebaseReceiptDigest,
  nativeCycleBaseRequalificationReceiptDigest,
  validateNativeCycleMergeReceipt,
  validateNativeCycleSameLabelRebasedBaseReceipt,
} from './cycle_review.js';
import {WorkflowAutomationError} from './contracts.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
export const NativeCycleStoredSnapshotSchema = Schema.Struct({
  snapshot: NativeCycleSnapshotSchema,
  incoming: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      source: Schema.Literals(['upstream', 'preserved']),
      tree: gitObject,
      mode: Schema.String.check(Schema.isPattern(/^(?:000000|100644|100755|120000|160000)$/u)),
      blob: gitObject,
      commit: gitObject,
    }),
  ).check(Schema.isMaxLength(8192)),
});
export const NativeCycleRuntimeSchema = Schema.Struct({
  state: NativeCycleStateSchema,
  plans: Schema.Array(NativeCyclePlanSchema).check(Schema.isBetweenLength(1, 64)),
  baselines: Schema.Record(
    id,
    Schema.Struct({
      repo: Schema.String,
      head: gitObject,
      tree: gitObject,
      preservedFiles: Schema.Array(Schema.String).check(Schema.isMaxLength(8192)),
      pinnedRef: Schema.String,
    }),
  ),
  reviewLimits: Schema.Record(id, Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 5, maximum: 256}))),
  reviewExpansions: Schema.Array(
    Schema.Struct({
      phaseId: id,
      from: Schema.Finite,
      to: Schema.Finite,
      authority: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    }),
  ).check(Schema.isMaxLength(256)),
  snapshots: Schema.Array(NativeCycleStoredSnapshotSchema).check(Schema.isMaxLength(256)),
  reviews: Schema.Array(Schema.Struct({snapshotId: id, report: NativeCycleReviewSchema})).check(
    Schema.isMaxLength(256),
  ),
  attempts: Schema.Array(
    Schema.Struct({
      id,
      snapshotId: id,
      digest,
      status: Schema.Literals(['accepted', 'invalid']),
      message: Schema.String.check(Schema.isMaxLength(4096)),
      // Retain bounded failed reports as evidence; never turn malformed coverage into an empty review.
      report: Schema.String.check(Schema.isMaxLength(65_536)),
      authority: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
    }),
  ).check(Schema.isMaxLength(512)),
});
export type NativeCycleRuntime = typeof NativeCycleRuntimeSchema.Type;

/** Counts accepted reports continuously across every snapshot for the phase. */
export function nativeCyclePhaseReviewUsage(runtime: NativeCycleRuntime, phaseId: string) {
  const count = EffectArray.filter(
    runtime.reviews,
    item =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, entry => entry.snapshot.snapshotId === item.snapshotId),
      )?.snapshot.phaseId === phaseId,
  ).length;
  const limit = runtime.reviewLimits[phaseId] ?? 5;
  return {count, limit, exhausted: count >= limit};
}

export function nativeCycleHasBasePlanTransition(
  plans: NativeCycleRuntime['plans'],
  prior: typeof NativeCycleSnapshotSchema.Type,
  phaseHash: string,
  fromBaseBranch: string,
  toBaseBranch: string,
): boolean {
  if (fromBaseBranch === toBaseBranch) return false;
  let fromFound = false;
  for (const plan of plans) {
    const phase = EffectArray.findFirst(plan.phases, item => item.id === prior.phaseId);
    if (phase._tag === 'None') continue;
    const hash = nativeCyclePhaseHash(plan, prior.phaseId);
    if (fromFound && phase.value.baseBranch === toBaseBranch && hash === phaseHash) return true;
    if (phase.value.baseBranch === fromBaseBranch && hash === prior.phaseHash) fromFound = true;
  }
  return false;
}

export function decodeNativeCycleRuntime(input: unknown): NativeCycleRuntime {
  const runtime = Schema.decodeUnknownSync(NativeCycleRuntimeSchema, {onExcessProperty: 'error'})(input);
  decodeNativeCycleState(runtime.state);
  EffectArray.forEach(runtime.plans, decodeNativeCyclePlan);
  function fail(message: string): never {
    throw WorkflowAutomationError.make({code: 'invalid-cycle-state', message});
  }
  const snapshots = new Map(EffectArray.map(runtime.snapshots, entry => [entry.snapshot.snapshotId, entry]));
  const reviews = new Map(EffectArray.map(runtime.reviews, entry => [entry.snapshotId, entry.report]));
  if (
    snapshots.size !== runtime.snapshots.length ||
    reviews.size !== runtime.reviews.length ||
    new Set(EffectArray.map(runtime.attempts, attempt => attempt.id)).size !== runtime.attempts.length
  )
    fail('Duplicate cycle evidence identity.');
  const limits: Record<string, number> = {};
  for (const expansion of runtime.reviewExpansions) {
    if (
      !runtime.state.phases[expansion.phaseId] ||
      expansion.from !== (limits[expansion.phaseId] ?? 5) ||
      !Number.isSafeInteger(expansion.to) ||
      expansion.to <= expansion.from ||
      expansion.to > 256 ||
      !Effect.pipe(expansion.authority, EffectString.trim)
    )
      fail('Review expansion lost its phase, prior budget or explicit authority.');
    limits[expansion.phaseId] = expansion.to;
  }
  if (
    JSON.stringify(EffectRecord.toEntries(limits).sort()) !==
    JSON.stringify(EffectRecord.toEntries(runtime.reviewLimits).sort())
  )
    fail('Review limits differ from their continuous authorization history.');
  for (const [phaseId, baseline] of EffectRecord.toEntries(runtime.baselines)) {
    if (!runtime.state.phases[phaseId] || new Set(baseline.preservedFiles).size !== baseline.preservedFiles.length)
      fail('The pre-implementation baseline lost its phase or preserved-work manifest.');
  }
  const capturedSnapshots = new Set<string>();
  const capturedPhases = new Set<string>();
  for (const {snapshot, incoming} of runtime.snapshots) {
    const baseline = runtime.baselines[snapshot.phaseId];
    if (!baseline || baseline.tree !== snapshot.baseTree || baseline.repo !== snapshot.repo)
      fail('Snapshot baseline differs from its pre-implementation source pin.');
    if (snapshot.baseRequalification) {
      const receipt = snapshot.baseRequalification;
      const predecessor = snapshot.previous ?? snapshot.supersedes;
      const prior = predecessor ? snapshots.get(predecessor)?.snapshot : undefined;
      if (
        !prior ||
        !capturedSnapshots.has(prior.snapshotId) ||
        !reviews.has(prior.snapshotId) ||
        receipt.preRebaseHead !== prior.head ||
        receipt.priorDeclaredBaseHead !== prior.declaredBaseHead ||
        receipt.ontoHead !== snapshot.declaredBaseHead ||
        receipt.rebasedHead !== snapshot.head ||
        receipt.preRebaseHead === snapshot.head ||
        receipt.priorDeclaredBaseHead === snapshot.declaredBaseHead ||
        snapshot.acceptedHead !== snapshot.head ||
        !EffectString.trim(receipt.reason) ||
        !EffectString.trim(receipt.authority) ||
        !nativeCycleHasBasePlanTransition(
          runtime.plans,
          prior,
          snapshot.phaseHash,
          receipt.fromBaseBranch,
          receipt.toBaseBranch,
        ) ||
        receipt.receiptDigest !== nativeCycleBaseRequalificationReceiptDigest(snapshot, receipt)
      )
        fail('Base requalification lost its reviewed predecessor, approved plan transition or immutable witness.');
    }
    if (snapshot.sameLabelRebasedBaseIntegrationV1)
      validateNativeCycleSameLabelRebasedBaseReceipt(snapshot, runtime, capturedSnapshots.size);
    if (snapshot.ordinaryMergeQualificationV1 || snapshot.sameLabelRebasedBaseIntegrationV1) {
      const predecessor = snapshot.previous ?? snapshot.supersedes;
      const prior = predecessor ? snapshots.get(predecessor)?.snapshot : undefined;
      if (!prior || !capturedSnapshots.has(prior.snapshotId) || !reviews.has(prior.snapshotId))
        fail('Ordinary merge qualification requires its retained reviewed predecessor.');
      if (snapshot.ordinaryMergeQualificationV1)
        validateNativeCycleMergeReceipt(snapshot, prior, runtime.plans, baseline.head);
      const proof = (snapshot.ordinaryMergeQualificationV1 ?? snapshot.sameLabelRebasedBaseIntegrationV1)!;
      const plan = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.plans, item => item.source.documentHash === proof.planDocumentHash),
      )!;
      const phase = EffectOption.getOrUndefined(
        EffectArray.findFirst(plan.phases, item => item.id === snapshot.phaseId),
      )!;
      const expected = EffectArray.filter(proof.upstreamEvidence, item => !phase.allowedPaths.includes(item.path));
      if (
        incoming.length !== expected.length ||
        EffectArray.some(incoming, (item, index) => {
          const entry = expected[index];
          return (
            !entry ||
            item.path !== entry.path ||
            item.source !== 'upstream' ||
            item.commit !== proof.currentBaseHead ||
            item.tree !== proof.currentBaseTree ||
            item.mode !== entry.head.mode ||
            item.blob !== entry.head.blob
          );
        })
      )
        fail('Keep the exact per-phase upstream incoming subset separate from the complete merge proof.');
    }
    capturedSnapshots.add(snapshot.snapshotId);
    if (
      snapshot.rebase &&
      (capturedPhases.has(snapshot.phaseId) ||
        snapshot.previous ||
        snapshot.supersedes ||
        snapshot.rebase.preRebaseHead !== baseline.head ||
        snapshot.acceptedHead !== snapshot.head ||
        snapshot.rebase.preRebaseHead === snapshot.head ||
        snapshot.rebase.receiptDigest !== nativeCycleRebaseReceiptDigest(snapshot, snapshot.rebase) ||
        !EffectString.trim(snapshot.rebase.reason) ||
        !EffectString.trim(snapshot.rebase.authority))
    )
      fail('Rebase evidence belongs only to the original phase baseline and its first snapshot.');
    capturedPhases.add(snapshot.phaseId);
    if (
      !runtime.state.phases[snapshot.phaseId] ||
      !EffectArray.some(
        runtime.plans,
        plan =>
          EffectArray.some(plan.phases, phase => phase.id === snapshot.phaseId) &&
          nativeCyclePhaseHash(plan, snapshot.phaseId) === snapshot.phaseHash,
      ) ||
      new Set(snapshot.files).size !== snapshot.files.length ||
      new Set(snapshot.scopeFiles).size !== snapshot.scopeFiles.length ||
      EffectArray.some(snapshot.scopeFiles, file => !snapshot.files.includes(file)) ||
      new Set(EffectArray.map(incoming, item => item.path)).size !== incoming.length ||
      EffectArray.some(
        incoming,
        item =>
          !snapshot.files.includes(item.path) ||
          (item.source === 'preserved'
            ? !baseline.preservedFiles.includes(item.path) ||
              item.tree !== baseline.tree ||
              item.commit !== baseline.head
            : item.tree !== snapshot.scopeBase),
      )
    )
      fail('Snapshot evidence does not match the phase or incoming manifest.');
    if (snapshot.previous) {
      const previous = snapshots.get(snapshot.previous)?.snapshot;
      if (
        !previous ||
        previous.tree !== snapshot.previousTree ||
        previous.phaseId !== snapshot.phaseId ||
        previous.baseTree !== snapshot.baseTree
      )
        fail('Snapshot history is incomplete.');
    } else if (snapshot.previousTree) fail('Snapshot previous tree has no identity.');
    if (snapshot.supersedes) {
      const prior = snapshots.get(snapshot.supersedes)?.snapshot;
      if (
        !prior ||
        snapshot.previous ||
        prior.phaseId !== snapshot.phaseId ||
        prior.baseTree !== snapshot.baseTree ||
        prior.phaseHash === snapshot.phaseHash
      )
        fail('Material review restart lacks its historical source boundary.');
    }
  }
  for (const {snapshotId, report} of runtime.reviews) {
    const snapshot = snapshots.get(snapshotId)?.snapshot;
    if (!snapshot) fail('Review snapshot is missing.');
    const predecessor = snapshot.previous ?? snapshot.supersedes;
    const previous = predecessor ? snapshots.get(predecessor)?.snapshot : undefined;
    const priorReport = previous ? reviews.get(previous.snapshotId) : undefined;
    if (previous && !priorReport) fail('Review history lost its prior finding ledger.');
    (snapshot.sameLabelRebasedBaseIntegrationV1 ? validateNativeCycleReview : validateNativeCycleReviewHistory)(
      snapshot,
      report,
      previous && priorReport ? {snapshot: previous, review: priorReport} : undefined,
    );
  }
  if (EffectArray.some(runtime.attempts, attempt => !snapshots.has(attempt.snapshotId)))
    fail('Review attempt snapshot is missing.');
  return runtime;
}
