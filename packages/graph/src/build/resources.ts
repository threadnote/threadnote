import {Effect, Ref, Schema} from 'effect';

export const CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT = 4;
export const CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT = 32 * 1_024 * 1_024 * 1_024;

export type CodeGraphBuildResource =
  'checkout-writer' | 'home-builder-slot' | 'home-preparation-slot' | 'prepared-spool-budget';

export interface CodeGraphBuildResourceState {
  readonly legacyBuilder: boolean;
  readonly preparation: boolean;
  readonly preparedBytes: number;
  readonly preparedSpools: number;
  readonly writer: boolean;
}

export type CodeGraphBuildResourceEvent =
  | {readonly type: 'acquire-legacy-builder'}
  | {readonly type: 'release-legacy-builder'}
  | {readonly type: 'acquire-preparation'}
  | {readonly type: 'release-preparation'}
  | {readonly bytes: number; readonly type: 'acquire-prepared-spool'}
  | {readonly bytes: number; readonly type: 'release-prepared-spool'}
  | {readonly type: 'acquire-writer'}
  | {readonly type: 'release-writer'};

export const EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE: CodeGraphBuildResourceState = {
  legacyBuilder: false,
  preparation: false,
  preparedBytes: 0,
  preparedSpools: 0,
  writer: false,
};

export class CodeGraphBuildResourceOrderError extends Schema.TaggedError<CodeGraphBuildResourceOrderError, {readonly brand: unique symbol}>()(
  'CodeGraphBuildResourceOrderError',
  {message: Schema.String},
) {}

export function transitionCodeGraphBuildResourceState(
  state: CodeGraphBuildResourceState,
  event: CodeGraphBuildResourceEvent,
): CodeGraphBuildResourceState {
  switch (event.type) {
    case 'acquire-legacy-builder':
      if (state.legacyBuilder || state.preparation) {
        throw orderError('Legacy builder admission cannot overlap itself or scoped preparation.');
      }
      return {...state, legacyBuilder: true};
    case 'release-legacy-builder':
      if (!state.legacyBuilder) throw orderError('Legacy builder admission was released without an active lease.');
      return {...state, legacyBuilder: false};
    case 'acquire-preparation':
      if (state.legacyBuilder || state.preparation || state.writer) {
        throw orderError('Preparation cannot overlap legacy admission, itself, or a checkout writer.');
      }
      return {...state, preparation: true};
    case 'release-preparation':
      if (!state.preparation) throw orderError('Preparation was released without an active lease.');
      return {...state, preparation: false};
    case 'acquire-prepared-spool': {
      assertPreparedBytes(event.bytes);
      if (state.preparedSpools >= CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT) {
        throw orderError('Prepared spool count budget was exceeded.');
      }
      const nextBytes = Math.min(Number.MAX_SAFE_INTEGER, state.preparedBytes + event.bytes);
      if (
        state.preparedSpools > 0 &&
        (event.bytes > CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT || nextBytes > CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT)
      ) {
        throw orderError('Prepared spool byte budget was exceeded.');
      }
      return {...state, preparedBytes: nextBytes, preparedSpools: state.preparedSpools + 1};
    }
    case 'release-prepared-spool':
      assertPreparedBytes(event.bytes);
      if (state.preparedSpools <= 0 || state.preparedBytes < event.bytes) {
        throw orderError('Prepared spool budget was released without an active reservation.');
      }
      return {
        ...state,
        preparedBytes: state.preparedBytes - event.bytes,
        preparedSpools: state.preparedSpools - 1,
      };
    case 'acquire-writer':
      if (state.preparation || state.writer) throw orderError('Checkout writer acquisition violated resource order.');
      return {...state, writer: true};
    case 'release-writer':
      if (!state.writer) throw orderError('Checkout writer was released without an active lease.');
      return {...state, writer: false};
  }
}

export function codeGraphBuildResource(state: CodeGraphBuildResourceState): CodeGraphBuildResource | undefined {
  if (state.writer) return 'checkout-writer';
  if (state.preparation) return 'home-preparation-slot';
  if (state.legacyBuilder) return 'home-builder-slot';
  if (state.preparedSpools > 0) return 'prepared-spool-budget';
  return undefined;
}

export const makeCodeGraphBuildResourceCoordinator = Effect.fn('codeGraph.buildResources.make')(function* (
  observe: (resource: CodeGraphBuildResource | undefined) => Effect.Effect<void, never>,
) {
  const state = yield* Ref.make(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
  const transition = (event: CodeGraphBuildResourceEvent) =>
    Ref.modify(state, current => {
      const next = transitionCodeGraphBuildResourceState(current, event);
      return [next, next] as const;
    }).pipe(Effect.flatMap(next => observe(codeGraphBuildResource(next))));
  return {
    acquireLegacyBuilder: transition({type: 'acquire-legacy-builder'}),
    acquirePreparation: transition({type: 'acquire-preparation'}),
    acquirePreparedSpool: (bytes: number) => transition({bytes, type: 'acquire-prepared-spool'}),
    acquireWriter: transition({type: 'acquire-writer'}),
    assertWriterMayWait: Ref.get(state).pipe(
      Effect.flatMap(current =>
        current.preparation
          ? Effect.fail(orderError('A checkout writer cannot be awaited while preparation is held.'))
          : Effect.void,
      ),
    ),
    current: Ref.get(state),
    releaseLegacyBuilder: transition({type: 'release-legacy-builder'}),
    releasePreparation: transition({type: 'release-preparation'}),
    releasePreparedSpool: (bytes: number) => transition({bytes, type: 'release-prepared-spool'}),
    releaseWriter: transition({type: 'release-writer'}),
  } as const;
});

export type CodeGraphBuildResourceCoordinator = Effect.Success<
  ReturnType<typeof makeCodeGraphBuildResourceCoordinator>
>;

function assertPreparedBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw orderError('Prepared spool byte reservation is invalid.');
}

function orderError(message: string): CodeGraphBuildResourceOrderError {
  return CodeGraphBuildResourceOrderError.make({message});
}
