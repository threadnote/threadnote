import {Array as EffectArray, Effect, Schema} from 'effect';
import {observationKey} from './contracts.js';
import {createSemanticProposal, type SemanticProposal} from './proposals.js';
import {sameOwnedView, OwnedView} from './views.js';
import {
  ApplyBinding,
  ApplyFault,
  ApplyPlan,
  type ApplyTarget,
  type ApplyConflict,
  type ApplyJournal,
  type ApplyReceipt,
  type ApplyResult,
  applyReceipt,
  createApplyJournal,
  restoreApplyJournal,
  updateApplyJournal,
  validApplyAcknowledgement,
  validateApplyJournalAdvance,
} from './journal.js';

export type ApplyCheck =
  {readonly status: 'ok'; readonly current: OwnedView} | {readonly status: 'conflict'; readonly reason: ApplyConflict};
export type ApplyAcknowledgement =
  | {readonly status: 'applied'; readonly current: OwnedView}
  | {readonly status: 'conflict'; readonly reason: ApplyConflict}
  | {readonly status: 'unknown'};

/** Trusted host ports, never a public request schema or evidence that a writer is qualified.
 * withOperation serializes operation identity reuse, including recovery. withTarget holds
 * the canonical resource lock through check, durable intent, mutation and result recording.
 * All participating writers/ownership changes must share that boundary. persist acknowledges
 * durable storage. Its failure may follow a commit, but all I/O must settle before it returns;
 * load then observes that settled durable state. Every journal writer shares withOperation.
 * Adapters must preserve revisions and historical applied acknowledgements, rejecting stale
 * or equal-revision divergent replacements. The core checks transitions while holding that gate;
 * it does not assume an independently available storage CAS. mutate revalidates authority under
 * that same lock. An unknown acknowledgement never becomes success from byte equality alone.
 */
export interface ApplyPorts<R = never> {
  readonly withOperation: <A>(operation: string, effect: Effect.Effect<A, unknown, R>) => Effect.Effect<A, unknown, R>;
  readonly withTarget: <A>(target: ApplyTarget, effect: Effect.Effect<A, unknown, R>) => Effect.Effect<A, unknown, R>;
  readonly load: (binding: ApplyBinding) => Effect.Effect<unknown | undefined, unknown, R>;
  readonly persist: (journal: ApplyJournal) => Effect.Effect<void, unknown, R>;
  /** Re-evaluate current task/workspace authorization for every exact target, not analysis-profile permission. */
  readonly authorize: (plan: ApplyPlan) => Effect.Effect<boolean, unknown, R>;
  /** No target writes; includes canonical paths, physical identity, writable scope and explicit disk/buffer eligibility. */
  readonly check: (target: ApplyTarget) => Effect.Effect<ApplyCheck, unknown, R>;
  readonly mutate: (target: ApplyTarget, afterText: string) => Effect.Effect<ApplyAcknowledgement, unknown, R>;
  readonly inspect: (target: ApplyTarget) => Effect.Effect<OwnedView | null, unknown, R>;
  /** Invalidate semantic/graph observations for all possibly touched resources; never rewrite memory. */
  readonly invalidate: (plan: ApplyPlan) => Effect.Effect<void, unknown, R>;
}

const safeFailure = (error: unknown) =>
  ApplyFault.make({reason: Schema.is(ApplyFault)(error) ? error.reason : 'unavailable'});
const validate = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: error => ApplyFault.make({reason: Schema.is(ApplyFault)(error) ? error.reason : 'invalid-input'}),
  });

function preparePlan(
  binding: ApplyBinding,
  proposal: SemanticProposal,
  owners: readonly OwnedView[],
  digest: (text: string) => string,
) {
  const copy = createSemanticProposal(proposal, digest);
  const checked = Schema.decodeSync(ApplyBinding, {onExcessProperty: 'error'})(binding);
  if (
    checked.proposal !== copy.digest ||
    copy.evidence.basis !== 'semantic' ||
    (copy.version === 2 && copy.qualification !== 'qualified-text-only') ||
    owners.length !== copy.targets.length ||
    copy.targets.length === 0
  )
    throw ApplyFault.make({reason: 'invalid-input'});
  const plan = Schema.decodeSync(ApplyPlan, {onExcessProperty: 'error'})({
    binding: checked,
    targets: EffectArray.map(copy.targets, (target, index) => ({
      before: owners[index],
      after: digest(target.afterText),
      sourceKind: target.precondition.sourceKind,
      physicalIdentity: target.precondition.physicalIdentity,
    })),
  });
  for (const [index, target] of copy.targets.entries()) {
    if (
      observationKey(plan.targets[index].before.observation) !== observationKey(target.observation) ||
      target.observation.worktree !== checked.worktree ||
      target.precondition.owner !== target.observation.view.owner ||
      (target.precondition.sourceKind === 'disk'
        ? target.observation.view.kind !== 'disk' || target.precondition.physicalIdentity === null
        : target.observation.view.kind === 'disk')
    )
      throw ApplyFault.make({reason: 'invalid-input'});
  }
  // Journal construction owns and validates all nested binding/target data before any asynchronous port.
  return {proposal: copy, plan: createApplyJournal(plan).plan};
}

const conflict = (target: ApplyTarget, check: ApplyCheck): ApplyConflict | undefined =>
  check.status === 'conflict'
    ? check.reason
    : sameOwnedView(target.before, check.current)
      ? undefined
      : 'source-changed';
const withResult = (journal: ApplyJournal, index: number, result: ApplyResult) =>
  updateApplyJournal(journal, {
    results: EffectArray.map(journal.results, (prior, i) => (i === index ? result : prior)),
  });

/** All callers hold the operation gate; every attempted write settles before another load. */
const persist = <R>(ports: ApplyPorts<R>, journal: ApplyJournal) =>
  Effect.gen(function* () {
    const raw = yield* ports.load(journal.plan.binding);
    if (raw !== undefined) {
      const previous = yield* validate(() => restoreApplyJournal(raw, journal.plan));
      if (JSON.stringify(previous) === JSON.stringify(journal)) return;
      yield* validate(() => validateApplyJournalAdvance(previous, journal));
    } else if (
      journal.revision > 1 ||
      EffectArray.some(journal.results, result => result.state !== 'unwritten' && result.state !== 'conflict')
    )
      return yield* ApplyFault.make({reason: 'invalid-journal'});
    yield* ports.persist(journal);
  });

/** Read-only with respect to target resources: reconciliation cannot replay, restore or continue writes. */
const reconcile = <R>(ports: ApplyPorts<R>, journal: ApplyJournal) =>
  Effect.gen(function* () {
    // Persistence can commit and then fail its acknowledgement. Reload before deriving any write,
    // rather than overwriting that committed result with our last acknowledged local intent.
    const loaded = yield* ports.load(journal.plan.binding).pipe(Effect.option);
    if (loaded._tag === 'None' || loaded.value === undefined) return applyReceipt(journal, 'unconfirmed');
    const durable = yield* validate(() => restoreApplyJournal(loaded.value, journal.plan));
    if (
      EffectArray.some(
        journal.results,
        (result, index) =>
          result.state === 'applied' && JSON.stringify(result) !== JSON.stringify(durable.results[index]),
      )
    )
      return applyReceipt(journal, 'unconfirmed');
    let base = durable;
    if (durable.revision < journal.revision) {
      // An unacknowledged intent may not have committed. Preserve its uncertainty, but advance
      // from the actual durable revision and never discard an acknowledged historical result.
      base = {...durable, results: journal.results};
    } else if (durable.revision === journal.revision && JSON.stringify(durable) !== JSON.stringify(journal)) {
      return applyReceipt(journal, 'unconfirmed');
    }
    const observed = yield* Effect.forEach(base.plan.targets, target =>
      ports.inspect(target).pipe(Effect.orElseSucceed(() => null)),
    );
    let current = updateApplyJournal(base, {observed});
    let recorded = yield* persist(ports, current).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (
      current.invalidation === 'pending' &&
      EffectArray.some(current.results, result => ['intent', 'unknown', 'applied'].includes(result.state))
    ) {
      const invalidated = yield* ports.invalidate(current.plan).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (invalidated) {
        current = updateApplyJournal(current, {invalidation: 'complete'});
        recorded = yield* persist(ports, current).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }
    }
    return applyReceipt(current, recorded ? 'recorded' : 'unconfirmed');
  });

export function recoverSemanticChange<R>(
  binding: ApplyBinding,
  ports: ApplyPorts<R>,
): Effect.Effect<ApplyReceipt, ApplyFault, R> {
  return validate(() => Schema.decodeSync(ApplyBinding, {onExcessProperty: 'error'})(binding)).pipe(
    Effect.flatMap(checked =>
      ports.withOperation(
        checked.operation,
        Effect.gen(function* () {
          const raw = yield* ports.load(checked);
          const journal = yield* validate(() => restoreApplyJournal(raw));
          if (JSON.stringify(journal.plan.binding) !== JSON.stringify(checked))
            return yield* ApplyFault.make({reason: 'identity-conflict'});
          if (!(yield* ports.authorize(journal.plan))) return yield* ApplyFault.make({reason: 'unauthorized'});
          return yield* reconcile(ports, journal);
        }),
      ),
    ),
    Effect.mapError(safeFailure),
  );
}

/** Core guarded application only. No host grant, OS lock, durable storage or editor integration is implemented here. */
export function applySemanticChange<R>(
  input: {readonly binding: ApplyBinding; readonly proposal: SemanticProposal; readonly owners: readonly OwnedView[]},
  ports: ApplyPorts<R>,
  digest: (text: string) => string,
): Effect.Effect<ApplyReceipt, ApplyFault, R> {
  return validate(() => preparePlan(input.binding, input.proposal, input.owners, digest)).pipe(
    Effect.flatMap(({plan, proposal}) =>
      ports.withOperation(
        plan.binding.operation,
        Effect.gen(function* () {
          if (!(yield* ports.authorize(plan))) return yield* ApplyFault.make({reason: 'unauthorized'});
          const stored = yield* ports.load(plan.binding);
          if (stored !== undefined) {
            const prior = yield* validate(() => restoreApplyJournal(stored, plan));
            return yield* reconcile(ports, prior);
          }
          let journal = createApplyJournal(plan);
          // All targets pass before the first intent or source mutation. The per-target boundary repeats these checks.
          for (const [index, target] of plan.targets.entries()) {
            const reason = conflict(target, yield* ports.check(target));
            if (reason) {
              const results: ApplyResult[] = EffectArray.map(plan.targets, (_, i) =>
                i === index ? {state: 'conflict', reason} : {state: 'unwritten'},
              );
              journal = updateApplyJournal(journal, {results});
              yield* persist(ports, journal);
              return yield* reconcile(ports, journal);
            }
          }
          if (!(yield* ports.authorize(plan))) return yield* ApplyFault.make({reason: 'unauthorized'});
          yield* persist(ports, journal);
          for (const [index, target] of plan.targets.entries()) {
            const result = yield* ports
              .withTarget(
                target,
                Effect.gen(function* () {
                  const reason = !(yield* ports.authorize(plan))
                    ? 'authorization'
                    : conflict(target, yield* ports.check(target));
                  if (reason) return {state: 'conflict', reason} as const;
                  const intent = withResult(journal, index, {state: 'intent'});
                  journal = intent;
                  yield* persist(ports, intent);
                  const acknowledgement = yield* ports
                    .mutate(target, proposal.targets[index].afterText)
                    .pipe(Effect.orElseSucceed((): ApplyAcknowledgement => ({status: 'unknown'})));
                  const next: ApplyResult =
                    acknowledgement.status === 'applied' && validApplyAcknowledgement(target, acknowledgement.current)
                      ? {state: 'applied', current: acknowledgement.current}
                      : acknowledgement.status === 'conflict'
                        ? {state: 'conflict', reason: acknowledgement.reason}
                        : {state: 'unknown'};
                  const completed = withResult(journal, index, next);
                  // A persistence failure leaves the durable intent as the recovery basis, never a fabricated success.
                  yield* persist(ports, completed);
                  journal = completed;
                  return next;
                }),
              )
              .pipe(Effect.orElseSucceed((): ApplyResult => ({state: 'unknown'})));
            if (result.state !== 'applied') {
              if (result.state === 'conflict') {
                journal = withResult(journal, index, result);
                yield* persist(ports, journal);
              }
              return yield* reconcile(ports, journal);
            }
          }
          return yield* reconcile(ports, journal);
        }),
      ),
    ),
    Effect.mapError(safeFailure),
  );
}
