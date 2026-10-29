import {Clock, Console, Effect, Ref, Semaphore} from 'effect';
import type {CodeGraphWorksetPrepareProgressV1} from '../workset_catalog/workset.js';
import {Array as EffectArray} from 'effect';

export const CODE_GRAPH_WORKSET_JSON_PROGRESS_INTERVAL_MILLISECONDS = 2_000;

export interface CodeGraphWorksetJsonProgressState {
  readonly completed: number;
  readonly lastEmittedAtMilliseconds?: number;
  readonly signature?: string;
}

export function codeGraphWorksetJsonProgressDecision(
  state: CodeGraphWorksetJsonProgressState,
  progress: CodeGraphWorksetPrepareProgressV1,
  nowMilliseconds: number,
  intervalMilliseconds = CODE_GRAPH_WORKSET_JSON_PROGRESS_INTERVAL_MILLISECONDS,
): {readonly emit: boolean; readonly state: CodeGraphWorksetJsonProgressState} {
  const signature = EffectArray.join(
    EffectArray.map(
      [
        progress.phase,
        progress.project,
        progress.attempt,
        progress.activity?.phase,
        progress.activity?.subphase,
        progress.activity?.reason,
      ],
      item => (item === null || item === undefined ? '' : String(item)),
    ),
    '/',
  );
  const intervalElapsed =
    state.lastEmittedAtMilliseconds === undefined ||
    nowMilliseconds < state.lastEmittedAtMilliseconds ||
    nowMilliseconds - state.lastEmittedAtMilliseconds >= Math.max(1, intervalMilliseconds);
  const emit =
    state.lastEmittedAtMilliseconds === undefined ||
    signature !== state.signature ||
    progress.member !== undefined ||
    progress.completed > state.completed ||
    progress.phase === 'completed' ||
    progress.phase === 'failed' ||
    intervalElapsed;
  return {
    emit,
    state: emit
      ? {
          completed: Math.max(state.completed, progress.completed),
          lastEmittedAtMilliseconds: nowMilliseconds,
          signature,
        }
      : {...state, completed: Math.max(state.completed, progress.completed)},
  };
}

export const makeCodeGraphWorksetJsonProgressReporter = Effect.fn('codeGraph.command.makeWorksetJsonProgressReporter')(
  function* () {
    const state = yield* Ref.make<CodeGraphWorksetJsonProgressState>({completed: 0});
    const semaphore = yield* Semaphore.make(1);
    return (progress: CodeGraphWorksetPrepareProgressV1) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const decision = codeGraphWorksetJsonProgressDecision(yield* Ref.get(state), progress, now);
          yield* Ref.set(state, decision.state);
          if (decision.emit) yield* Console.error(JSON.stringify(progress));
        }),
      );
  },
);
