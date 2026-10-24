import {Context, Effect} from 'effect';
import type {NativeOperation, NativeWorkflowState} from '@threadnote/workflow-automations/native';
import type {WorkflowBinding, WorkflowJournal, WorkflowOperation} from './protocol.js';

/** Request-local memoization of immutable images, never file metadata or scope authority. */
export interface WorkflowReadCache {
  readonly compactJournal?: boolean;
  native?: {
    readonly file: string;
    readonly bytes: string;
    readonly state: NativeWorkflowState;
    readonly revision: string;
  };
  journal?: {readonly file: string; readonly bytes: string; readonly state: WorkflowJournal};
  integrity?: {readonly state: WorkflowJournal; readonly manifest: string | undefined; readonly sharedRoots: string};
  readonly operations: WeakMap<WorkflowOperation, {readonly binding: WorkflowBinding; readonly key: string}>;
  readonly executor: WeakMap<NativeOperation, {readonly intentDigest: string; readonly bodyDigest?: string}>;
}

export const CurrentWorkflowReadCache = Context.Reference<WorkflowReadCache | undefined>(
  'threadnote/CurrentWorkflowReadCache',
  {defaultValue: () => undefined},
);

const immutableImages = new WeakSet<object>();

export function immutableWorkflowImage<A>(value: A): A {
  if (value !== null && typeof value === 'object' && !immutableImages.has(value)) {
    for (const child of Object.values(value)) immutableWorkflowImage(child);
    Object.freeze(value);
    immutableImages.add(value);
  }
  return value;
}

export function withWorkflowReadCache<A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: {readonly compactJournal?: boolean} = {},
) {
  return Effect.suspend(() =>
    program.pipe(
      Effect.provideService(CurrentWorkflowReadCache, {
        ...options,
        operations: new WeakMap(),
        executor: new WeakMap(),
      }),
    ),
  );
}
