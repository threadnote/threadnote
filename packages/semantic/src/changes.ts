import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import {Schema} from 'effect';
import {Counter, Digest, Identifier} from './contracts.js';
import {sameOwnedView, OwnedView} from './views.js';
export const ChangeTarget = Schema.Struct({before: OwnedView, after: Digest});
export const ChangeProposal = Schema.Struct({
  version: Schema.Literal(1),
  id: Identifier,
  digest: Digest,
  targets: Schema.Array(ChangeTarget).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ChangeProposal = typeof ChangeProposal.Type;
export const ChangeState = Schema.Struct({
  version: Schema.Literal(1),
  operation: Identifier,
  proposal: ChangeProposal,
  status: Schema.Literals(['prepared', 'applying', 'applied', 'conflict', 'partial', 'indeterminate']),
  written: Counter,
  pendingIntent: Schema.Boolean,
}).check(
  Schema.makeFilter(state => {
    if (
      new Set(EffectArray.map(state.proposal.targets, t => t.before.observation.uri)).size !==
      state.proposal.targets.length
    )
      return false;
    if (state.status === 'applied') return state.written === state.proposal.targets.length && !state.pendingIntent;
    if (state.written >= state.proposal.targets.length) return false;
    if (state.status === 'prepared' || state.status === 'conflict') return state.written === 0 && !state.pendingIntent;
    if (state.status === 'partial') return state.written > 0 && !state.pendingIntent;
    if (state.status === 'indeterminate') return state.pendingIntent;
    return true;
  }),
);
export type ChangeState = typeof ChangeState.Type;
export type ChangeEvent =
  | {
      readonly type: 'begin';
      readonly current: readonly OwnedView[];
    }
  | {
      readonly type: 'intent';
      readonly index: number;
      readonly current: OwnedView;
    }
  | {
      readonly type: 'ack';
      readonly index: number;
      readonly outcome: 'applied';
      readonly content: string;
    }
  | {
      readonly type: 'ack';
      readonly index: number;
      readonly outcome: 'conflict';
    }
  | {
      readonly type: 'ack';
      readonly index: number;
      readonly outcome: 'unknown';
    }
  | {
      readonly type: 'interrupted';
    };
export type ChangeTransition =
  | {
      readonly status: 'accepted';
      readonly state: ChangeState;
    }
  | {
      readonly status: 'invalid-transition';
      readonly state: ChangeState;
    };
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of EffectRecord.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** A state model, not authorization, a lock, a durable journal, or a filesystem writer. */
export function prepareChange(operation: string, proposal: ChangeProposal): ChangeState {
  Schema.decodeSync(Identifier)(operation);
  Schema.decodeSync(ChangeProposal)(proposal);
  const resources = EffectArray.map(proposal.targets, t => t.before.observation.uri);
  if (new Set(resources).size !== resources.length) throw new Error('Duplicate change target.');
  // Copy nested values so a caller cannot change the retained preconditions.
  return freeze({
    version: 1,
    operation,
    proposal: structuredClone(proposal),
    status: 'prepared',
    written: 0,
    pendingIntent: false,
  });
}
export function advanceChange(state: ChangeState, event: ChangeEvent): ChangeTransition {
  if (!Schema.is(ChangeState)(state)) return {status: 'invalid-transition', state};
  const accepted = (change: Partial<ChangeState>): ChangeTransition => ({
    status: 'accepted',
    // Restored schema values may still be caller-owned and mutable.
    state: freeze(structuredClone({...state, ...change})),
  });
  const invalid = (): ChangeTransition => ({
    status: 'invalid-transition',
    state,
  });
  const conflict = (): ChangeTransition =>
    accepted({
      status: state.written > 0 ? 'partial' : 'conflict',
      pendingIntent: false,
    });
  if (event.type === 'begin') {
    if (state.status !== 'prepared') return invalid();
    if (
      event.current.length !== state.proposal.targets.length ||
      EffectArray.some(state.proposal.targets, (t, i) => !sameOwnedView(t.before, event.current[i]))
    )
      return conflict();
    return accepted({status: 'applying'});
  }
  // A duplicate acknowledgement can arrive after completion or while a later target is in flight.
  if (
    event.type === 'ack' &&
    event.index >= 0 &&
    Number.isSafeInteger(event.index) &&
    event.index < state.written &&
    event.outcome === 'applied' &&
    state.proposal.targets[event.index]?.after === event.content
  )
    return accepted({});
  if (state.status !== 'applying') return invalid();
  if (event.type === 'interrupted')
    return accepted({
      status: state.pendingIntent ? 'indeterminate' : state.written > 0 ? 'partial' : 'conflict',
    });
  if (event.type === 'intent') {
    if (state.pendingIntent || event.index !== state.written) return invalid();
    if (!sameOwnedView(state.proposal.targets[event.index].before, event.current)) return conflict();
    return accepted({pendingIntent: true});
  }
  if (!state.pendingIntent || event.index !== state.written) return invalid();
  if (event.outcome === 'conflict') return conflict();
  if (event.outcome === 'unknown' || event.content !== state.proposal.targets[event.index].after)
    return accepted({status: 'indeterminate'});
  const written = state.written + 1;
  return accepted({
    written,
    pendingIntent: false,
    status: written === state.proposal.targets.length ? 'applied' : 'applying',
  });
}
