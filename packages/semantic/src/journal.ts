import {Array as EffectArray, Record as EffectRecord, Schema} from 'effect';
import {Counter, Digest, FileUri, Identifier} from './contracts.js';
import {OwnedView} from './views.js';

export const ApplyBinding = Schema.Struct({
  operation: Identifier,
  principal: Identifier,
  worktree: FileUri,
  proposal: Digest,
});
export type ApplyBinding = typeof ApplyBinding.Type;
export const ApplyTarget = Schema.Struct({
  before: OwnedView,
  after: Digest,
  sourceKind: Schema.Literals(['disk', 'overlay']),
  physicalIdentity: Schema.NullOr(Schema.String),
});
export type ApplyTarget = typeof ApplyTarget.Type;
export const ApplyPlan = Schema.Struct({
  binding: ApplyBinding,
  targets: Schema.Array(ApplyTarget).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ApplyPlan = typeof ApplyPlan.Type;
export const ApplyConflict = Schema.Literals([
  'authorization',
  'source-changed',
  'ownership',
  'path',
  'readonly',
  'unqualified-writer',
]);
export type ApplyConflict = typeof ApplyConflict.Type;
export const ApplyResult = Schema.Union([
  Schema.Struct({state: Schema.Literals(['unwritten', 'intent', 'unknown'])}),
  Schema.Struct({state: Schema.Literal('applied'), current: OwnedView}),
  Schema.Struct({state: Schema.Literal('conflict'), reason: ApplyConflict}),
]);
export type ApplyResult = typeof ApplyResult.Type;
/** Private recovery data. It carries identities, never an executable grant or source images. */
export const ApplyJournal = Schema.Struct({
  version: Schema.Literal(1),
  revision: Counter,
  plan: ApplyPlan,
  results: Schema.Array(ApplyResult),
  observed: Schema.Array(Schema.NullOr(OwnedView)),
  invalidation: Schema.Literals(['pending', 'complete']),
}).check(
  Schema.makeFilter(journal => {
    const targets = journal.plan.targets;
    if (journal.results.length !== targets.length || journal.observed.length !== targets.length) return false;
    if (new Set(EffectArray.map(targets, target => target.before.observation.uri)).size !== targets.length)
      return false;
    const preflightConflict =
      EffectArray.filter(journal.results, result => result.state === 'conflict').length === 1 &&
      EffectArray.every(journal.results, result => result.state === 'unwritten' || result.state === 'conflict');
    let stopped = false;
    for (const [index, result] of journal.results.entries()) {
      if (targets[index].before.observation.worktree !== journal.plan.binding.worktree) return false;
      if (stopped && result.state !== 'unwritten' && !preflightConflict) return false;
      if (result.state !== 'applied') stopped = true;
      if (result.state === 'applied' && !validApplyAcknowledgement(targets[index], result.current)) return false;
      const observed = journal.observed[index];
      if (observed && observed.observation.uri !== targets[index].before.observation.uri) return false;
    }
    return true;
  }),
);
export type ApplyJournal = typeof ApplyJournal.Type;

export class ApplyFault extends Schema.TaggedError<ApplyFault, {readonly brand: unique symbol}>()('ApplyFault', {
  reason: Schema.Literals(['invalid-input', 'invalid-journal', 'identity-conflict', 'unauthorized', 'unavailable']),
}) {}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of EffectRecord.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** A qualified writer must additionally enforce its own versioned acknowledgement protocol. */
export function validApplyAcknowledgement(target: ApplyTarget, current: OwnedView): boolean {
  const before = target.before;
  const expected = before.observation;
  const actual = current.observation;
  return (
    Schema.is(OwnedView)(current) &&
    current.authority === before.authority &&
    current.fence === before.fence &&
    actual.content === target.after &&
    actual.uri === expected.uri &&
    actual.repository === expected.repository &&
    actual.worktree === expected.worktree &&
    actual.project === expected.project &&
    actual.configuration === expected.configuration &&
    actual.toolchain === expected.toolchain &&
    actual.provider.id === expected.provider.id &&
    actual.provider.version === expected.provider.version &&
    actual.provider.generation === expected.provider.generation &&
    actual.view.kind === expected.view.kind &&
    actual.view.id === expected.view.id &&
    actual.view.owner === expected.view.owner &&
    (expected.documentVersion === null
      ? actual.documentVersion === null
      : actual.documentVersion !== null && actual.documentVersion > expected.documentVersion)
  );
}

/** Strict restoration copies caller-owned data and validates its operation/target binding. */
export function restoreApplyJournal(raw: unknown, expected?: ApplyPlan): ApplyJournal {
  try {
    const journal = Schema.decodeUnknownSync(ApplyJournal, {onExcessProperty: 'error'})(raw);
    if (expected && JSON.stringify(journal.plan) !== JSON.stringify(expected))
      throw ApplyFault.make({reason: 'identity-conflict'});
    return immutable(structuredClone(journal));
  } catch (error) {
    throw ApplyFault.make({reason: Schema.is(ApplyFault)(error) ? error.reason : 'invalid-journal'});
  }
}

/** Check a settled transition under the operation gate; this is not a storage CAS primitive. */
export function validateApplyJournalAdvance(previous: ApplyJournal, next: ApplyJournal): void {
  if (
    JSON.stringify(previous.plan) !== JSON.stringify(next.plan) ||
    next.revision !== previous.revision + 1 ||
    EffectArray.some(
      previous.results,
      (result, index) => result.state === 'applied' && JSON.stringify(result) !== JSON.stringify(next.results[index]),
    )
  )
    throw ApplyFault.make({reason: 'invalid-journal'});
}

export function createApplyJournal(plan: ApplyPlan): ApplyJournal {
  return restoreApplyJournal({
    version: 1,
    revision: 0,
    plan,
    results: EffectArray.map(plan.targets, () => ({state: 'unwritten'})),
    observed: EffectArray.map(plan.targets, () => null),
    invalidation: 'pending',
  });
}

export function updateApplyJournal(
  journal: ApplyJournal,
  change: Partial<Pick<ApplyJournal, 'results' | 'observed' | 'invalidation'>>,
): ApplyJournal {
  return restoreApplyJournal({...journal, ...change, revision: journal.revision + 1}, journal.plan);
}

/** Deliberately omits paths, owner identifiers, capabilities, source text and exception messages. */
export function applyReceipt(journal: ApplyJournal, durability: 'recorded' | 'unconfirmed' = 'recorded') {
  const unknown = EffectArray.some(journal.results, result => result.state === 'intent' || result.state === 'unknown');
  const written = EffectArray.filter(journal.results, result => result.state === 'applied').length;
  return immutable({
    version: 1 as const,
    operation: journal.plan.binding.operation,
    proposal: journal.plan.binding.proposal,
    status: unknown
      ? 'indeterminate'
      : written === journal.results.length
        ? 'applied'
        : written
          ? 'partial'
          : 'conflict',
    targets: EffectArray.map(journal.results, (result, index) => {
      const observed = journal.observed[index];
      const content = observed?.observation.content ?? null;
      const target = journal.plan.targets[index];
      return {
        index,
        state: result.state,
        ...(result.state === 'conflict' ? {reason: result.reason} : {}),
        observed:
          content === null
            ? 'unavailable'
            : content === target.after
              ? 'intended'
              : content === target.before.observation.content
                ? 'original'
                : 'diverged',
        content,
        ownership:
          observed === null
            ? 'unavailable'
            : observed.authority === target.before.authority &&
                observed.fence === target.before.fence &&
                observed.observation.view.owner === target.before.observation.view.owner &&
                observed.observation.view.id === target.before.observation.view.id
              ? 'same'
              : 'changed',
      };
    }),
    invalidation: journal.invalidation,
    durability,
    diagnostics: 'not-run' as const,
    tests: 'not-run' as const,
  });
}
export type ApplyReceipt = ReturnType<typeof applyReceipt>;
