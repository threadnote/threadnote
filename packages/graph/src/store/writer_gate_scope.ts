import type {Effect, Scope} from 'effect';

type WriterCallback = () => Effect.Effect<void, never>;

export interface CodeGraphScopedWriter {
  readonly acquire: Effect.Effect<void>;
  readonly observeRelease: Effect.Effect<void>;
}

export type CodeGraphScopedWriterFactory = (scope: Scope.Scope) => CodeGraphScopedWriter;

const resourceFactories = new WeakMap<object, CodeGraphScopedWriterFactory>();
const callbackFactories = new WeakMap<
  WriterCallback,
  {
    readonly released: WriterCallback;
    readonly makeGate: CodeGraphScopedWriterFactory;
  }
>();

export function registerCodeGraphWriterResource(resource: object, makeGate: CodeGraphScopedWriterFactory): void {
  resourceFactories.set(resource, makeGate);
}

export function codeGraphWriterResourceFactory(resource: object): CodeGraphScopedWriterFactory | undefined {
  return resourceFactories.get(resource);
}

export function registerCodeGraphWriterCallbacks(
  acquired: WriterCallback,
  released: WriterCallback,
  makeGate: CodeGraphScopedWriterFactory,
): void {
  callbackFactories.set(acquired, {released, makeGate});
}

export function codeGraphWriterGateFactory(
  callbacks:
    | {
        readonly onWriterAcquired?: WriterCallback;
        readonly onWriterReleased?: WriterCallback;
      }
    | undefined,
): CodeGraphScopedWriterFactory | undefined {
  const acquired = callbacks?.onWriterAcquired;
  if (acquired === undefined) return undefined;
  const registered = callbackFactories.get(acquired);
  if (registered === undefined || registered.released !== callbacks?.onWriterReleased) return undefined;
  return registered.makeGate;
}
