import {Schema} from 'effect';
import {
  NativeCyclePlanSchema,
  NativeCycleStateSchema,
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  nativeCyclePhaseHash,
} from './cycle.js';
import {NativeCycleSnapshotSchema, NativeCycleReviewSchema, validateNativeCycleReviewHistory} from './cycle_review.js';
import {WorkflowAutomationError} from './contracts.js';

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

export function decodeNativeCycleRuntime(input: unknown): NativeCycleRuntime {
  const runtime = Schema.decodeUnknownSync(NativeCycleRuntimeSchema, {onExcessProperty: 'error'})(input);
  decodeNativeCycleState(runtime.state);
  runtime.plans.forEach(decodeNativeCyclePlan);
  function fail(message: string): never {
    throw WorkflowAutomationError.make({code: 'invalid-cycle-state', message});
  }
  const snapshots = new Map(runtime.snapshots.map(entry => [entry.snapshot.snapshotId, entry]));
  const reviews = new Map(runtime.reviews.map(entry => [entry.snapshotId, entry.report]));
  if (
    snapshots.size !== runtime.snapshots.length ||
    reviews.size !== runtime.reviews.length ||
    new Set(runtime.attempts.map(attempt => attempt.id)).size !== runtime.attempts.length
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
      !expansion.authority.trim()
    )
      fail('Review expansion lost its phase, prior budget or explicit authority.');
    limits[expansion.phaseId] = expansion.to;
  }
  if (JSON.stringify(Object.entries(limits).sort()) !== JSON.stringify(Object.entries(runtime.reviewLimits).sort()))
    fail('Review limits differ from their continuous authorization history.');
  for (const [phaseId, baseline] of Object.entries(runtime.baselines)) {
    if (!runtime.state.phases[phaseId] || new Set(baseline.preservedFiles).size !== baseline.preservedFiles.length)
      fail('The pre-implementation baseline lost its phase or preserved-work manifest.');
  }
  for (const {snapshot, incoming} of runtime.snapshots) {
    const baseline = runtime.baselines[snapshot.phaseId];
    if (!baseline || baseline.tree !== snapshot.baseTree || baseline.repo !== snapshot.repo)
      fail('Snapshot baseline differs from its pre-implementation source pin.');
    if (
      !runtime.state.phases[snapshot.phaseId] ||
      !runtime.plans.some(
        plan =>
          plan.phases.some(phase => phase.id === snapshot.phaseId) &&
          nativeCyclePhaseHash(plan, snapshot.phaseId) === snapshot.phaseHash,
      ) ||
      new Set(snapshot.files).size !== snapshot.files.length ||
      new Set(snapshot.scopeFiles).size !== snapshot.scopeFiles.length ||
      snapshot.scopeFiles.some(file => !snapshot.files.includes(file)) ||
      new Set(incoming.map(item => item.path)).size !== incoming.length ||
      incoming.some(
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
    validateNativeCycleReviewHistory(
      snapshot,
      report,
      previous && priorReport ? {snapshot: previous, review: priorReport} : undefined,
    );
  }
  if (runtime.attempts.some(attempt => !snapshots.has(attempt.snapshotId))) fail('Review attempt snapshot is missing.');
  return runtime;
}
