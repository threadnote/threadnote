import {Context, Effect} from 'effect';
import {
  makeNativeWorkflowStateDecoder,
  type NativeOperation,
  type NativeWorkflowState,
} from '@threadnote/workflow-automations/native';
import {sha256HexSync} from './native_digest.js';
import {makeRequestCanonicalJson} from './canonical_json.js';
import type {WorkflowBinding, WorkflowJournal, WorkflowOperation} from './protocol.js';
import * as EffectRecord from 'effect/Record';

/** Request-local memoization of immutable images, never file metadata or scope authority. */
export interface WorkflowReadCache {
  readonly compactJournal?: boolean;
  readonly decodeNative: ReturnType<typeof makeNativeWorkflowStateDecoder>;
  readonly stringify: ReturnType<typeof makeRequestCanonicalJson>;
  readonly manifests: {
    readonly binding: WorkflowBinding;
    readonly manifestUri: string;
    readonly content: string;
    readonly artifacts: WorkflowJournal['artifacts'];
  }[];
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
    for (const child of EffectRecord.values(value)) immutableWorkflowImage(child);
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
        decodeNative: makeNativeWorkflowStateDecoder(sha256HexSync),
        stringify: makeRequestCanonicalJson(),
        manifests: [],
        operations: new WeakMap(),
        executor: new WeakMap(),
      }),
    ),
  );
}
