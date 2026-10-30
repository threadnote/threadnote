import {Array as EffectArray} from 'effect';
import {Cause, Context, Effect, Exit, FileSystem} from 'effect';
import type {CommandExecutor, CommandOptions, CommandExecutionError} from '@threadnote/platform/command';
import {ChildProcessSpawner, make as makeSpawner} from 'effect/process/ChildProcessSpawner';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export type Phase = 'outside-query' | 'initial' | 'evidence' | 'closing';
interface Frame {
  readonly sample: number;
  readonly phase: Phase;
  readonly origin: number;
  readonly commandId?: number;
  readonly active: {value: boolean};
  readonly canonicalIndex?: string;
  readonly sourceRoot?: string;
}
const CurrentFrame = Context.Reference<Frame | undefined>('citationDiagnostic/frame', {defaultValue: () => undefined});
export interface Event {
  readonly sample: number;
  readonly phase: Phase;
  readonly kind: 'command' | 'spawn' | 'child-exit' | 'file' | 'store' | 'phase' | 'semantic';
  readonly operation: string;
  readonly commandId?: number;
  readonly start: number;
  readonly milliseconds: number;
  readonly outcome: 'success' | 'typed-error' | 'defect' | 'interrupted';
  readonly deferredMilliseconds?: number;
  readonly bytes?: number;
}

/** Closed labels only: never retain an executable path, arguments, or command output. */
export function commandOperation(executable: string, args: readonly string[], privateIndex: boolean): string {
  if (!/(?:^|[/\\])git(?:\.exe)?$/i.test(executable)) return 'other-command';
  if (args.includes('status'))
    return privateIndex
      ? 'private-untracked-status'
      : args.includes('--untracked-files=no')
        ? 'canonical-tracked-status'
        : 'raw-canonical-status';
  if (args.includes('rev-parse')) return args.includes('info/exclude') ? 'info-exclude-path' : 'identity-metadata';
  if (args.includes('config'))
    return args.includes('core.ignorecase')
      ? 'config-ignorecase'
      : args.includes('core.excludesFile')
        ? 'config-excludes'
        : 'other-git-config';
  if (args.includes('remote')) return 'remote-identity';
  if (args.includes('symbolic-ref')) return 'branch';
  if (args.includes('update-index')) return 'private-index-initialization';
  return 'other-git';
}

export function intervalUnion(events: readonly Pick<Event, 'start' | 'milliseconds'>[]): number {
  const intervals = EffectArray.map(events, event => [event.start, event.start + event.milliseconds] as const).sort(
    (a, b) => a[0] - b[0],
  );
  let total = 0;
  let end = -Infinity;
  for (const [start, next] of intervals) {
    if (start > end) total += next - start;
    else if (next > end) total += next - end;
    end = Math.max(end, next);
  }
  return total;
}

export class Collector {
  readonly events: Event[] = [];
  dropped = 0;
  lateEvents = 0;
  lateInvocationEvents = 0;
  teardownEvents = 0;
  private teardown = false;
  private sequence = 0;
  constructor(readonly maximumEvents = 100_000) {}
  beginTeardown() {
    this.teardown = true;
  }
  private recordLate(kind: Event['kind']) {
    this.lateEvents++;
    if (this.teardown && (kind === 'file' || kind === 'store')) this.teardownEvents++;
    else this.lateInvocationEvents++;
  }
  sample<A, E, R>(
    sample: number,
    effect: Effect.Effect<A, E, R>,
    paths: Pick<Frame, 'canonicalIndex' | 'sourceRoot'> = {},
  ) {
    return Effect.suspend(() => {
      const active = {value: true};
      return this.measure('phase', 'observation-inclusive', effect).pipe(
        Effect.provideService(CurrentFrame, {
          sample,
          phase: 'outside-query',
          origin: performance.now(),
          active,
          ...paths,
        }),
        Effect.ensuring(
          Effect.sync(() => {
            active.value = false;
          }),
        ),
      );
    });
  }
  phase<A, E, R>(phase: Phase, effect: Effect.Effect<A, E, R>) {
    return Effect.gen({self: this}, function* () {
      const current = yield* CurrentFrame;
      return yield* this.measure('phase', phase, effect).pipe(
        Effect.provideService(CurrentFrame, current === undefined ? undefined : {...current, phase}),
      );
    });
  }
  measure<A, E, R>(
    kind: Event['kind'],
    operation: string,
    effect: Effect.Effect<A, E, R>,
    deferredAt?: number,
  ): Effect.Effect<A, E, R> {
    return Effect.gen({self: this}, function* () {
      const frame = yield* CurrentFrame;
      if (frame === undefined) return yield* effect;
      if (!frame.active.value) {
        this.recordLate(kind);
        return yield* effect;
      }
      const started = performance.now();
      let bytes: number | undefined;
      return yield* effect.pipe(
        Effect.tap(value =>
          Effect.sync(() => {
            if (value instanceof Uint8Array) bytes = value.byteLength;
            else if (typeof value === 'string' && kind === 'file') bytes = new TextEncoder().encode(value).byteLength;
          }),
        ),
        Effect.onExit(exit =>
          Effect.sync(() => {
            if (!frame.active.value) this.recordLate(kind);
            const event: Event = {
              sample: frame.sample,
              phase: frame.phase,
              kind,
              operation,
              ...(frame.commandId === undefined ? {} : {commandId: frame.commandId}),
              start: started - frame.origin,
              milliseconds: performance.now() - started,
              outcome: Exit.isSuccess(exit)
                ? 'success'
                : Cause.hasInterrupts(exit.cause)
                  ? 'interrupted'
                  : Cause.hasDies(exit.cause)
                    ? 'defect'
                    : 'typed-error',
              ...(deferredAt === undefined ? {} : {deferredMilliseconds: started - deferredAt}),
              ...(bytes === undefined ? {} : {bytes}),
            };
            if (this.events.length < this.maximumEvents) this.events.push(event);
            else this.dropped += 1;
          }),
        ),
      );
    });
  }
  command(executor: CommandExecutor['Service']): CommandExecutor['Service'] {
    const wrap =
      <A>(
        method: 'execute' | 'executeBytes',
        delegate: (
          executable: string,
          args: readonly string[],
          options?: CommandOptions,
        ) => Effect.Effect<A, CommandExecutionError>,
      ) =>
      (
        executable: string,
        args: readonly string[],
        options?: CommandOptions,
      ): Effect.Effect<A, CommandExecutionError> => {
        const constructed = performance.now();
        return Effect.gen({self: this}, function* () {
          const frame = yield* CurrentFrame;
          if (frame === undefined) return yield* delegate.call(executor, executable, args, options);
          return yield* this.measure(
            'command',
            commandOperation(executable, args, options?.trustedGitIndexFile !== undefined),
            delegate.call(executor, executable, args, options),
            constructed,
          ).pipe(Effect.provideService(CurrentFrame, {...frame, commandId: ++this.sequence}));
        });
      };
    return {
      ...executor,
      execute: wrap('execute', executor.execute),
      ...(executor.executeBytes === undefined ? {} : {executeBytes: wrap('executeBytes', executor.executeBytes)}),
    };
  }

  spawner(original: ChildProcessSpawner['Service']): ChildProcessSpawner['Service'] {
    return makeSpawner(command =>
      this.measure('spawn', 'spawn-to-handle', original.spawn(command)).pipe(
        Effect.map(handle => {
          // The caller consumes the same streams and existing exit effect exactly once.
          // Proxy delegates every field except the observed exit effect without copying handle internals.
          const exitCode = this.measure('child-exit', 'handle-to-exit-observation', handle.exitCode);
          return new Proxy(handle, {
            get: (target, property, receiver) =>
              property === 'exitCode' ? exitCode : Reflect.get(target, property, receiver),
          });
        }),
      ),
    );
  }
  fileOperation(file: unknown, paths: Pick<Frame, 'canonicalIndex' | 'sourceRoot'> = {}): string {
    if (typeof file !== 'string') return 'other';
    const normalize = (value: string) =>
      Effect2.pipe(value, EffectString.replaceAll('\\', '/'), EffectString.replace(/^\/private\/var\//, '/var/'));
    const normalized = normalize(file);
    if (paths.canonicalIndex && normalized === normalize(paths.canonicalIndex)) return 'canonical-index';
    if (
      Effect2.pipe(normalized, EffectString.includes('/git-untracked-v3/')) ||
      Effect2.pipe(normalized, EffectString.includes('/git-status/'))
    )
      return Effect2.pipe(normalized, EffectString.endsWith('/index'))
        ? 'private-index'
        : Effect2.pipe(normalized, EffectString.includes('.status.lock'))
          ? 'private-lock'
          : 'private-receipt';
    if (Effect2.pipe(normalized, EffectString.includes('/local-context/'))) return 'association';
    if (/(?:\.threadnoteignore(?:\.local)?|\.gitignore|\/info\/exclude|\/git\/ignore)$/.test(normalized))
      return 'ignore-policy';
    if (paths.sourceRoot && Effect2.pipe(normalized, EffectString.startsWith(normalize(paths.sourceRoot) + '/src/')))
      return 'cited-source';
    return 'other';
  }
  filesystem(fs: FileSystem.FileSystem): FileSystem.FileSystem {
    const selected = new Set([
      'readFile',
      'readFileString',
      'stat',
      'exists',
      'readLink',
      'realPath',
      'open',
      'makeDirectory',
      'remove',
      'writeFileString',
      'chmod',
      'rename',
    ]);
    return new Proxy(fs, {
      get: (target, property, receiver) => {
        const method = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !selected.has(property) || typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          const effect = Reflect.apply(method, target, args);
          if (!Effect.isEffect(effect)) return effect;
          return Effect.flatMap(CurrentFrame, frame =>
            frame === undefined
              ? effect
              : this.measure('file', `${property}:${this.fileOperation(args[0], frame)}`, effect),
          );
        };
      },
    });
  }
  store<T extends object>(store: T): T {
    const selected = new Set([
      'readySnapshot',
      'snapshotPackProvenance',
      'acquireSnapshotLease',
      'releaseSnapshotLease',
      'effectiveSnapshotCitationEvidence',
      'withSession',
    ]);
    return new Proxy(store, {
      get: (target, property, receiver) => {
        const method = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !selected.has(property) || typeof method !== 'function') return method;
        return (...args: unknown[]) => this.measure('store', property, Reflect.apply(method, target, args));
      },
    });
  }
}

export function summarize(events: readonly Event[]) {
  const command = EffectArray.filter(events, event => event.kind === 'command');
  const files = EffectArray.filter(events, event => event.kind === 'file');
  const store = EffectArray.filter(events, event => event.kind === 'store' && event.operation !== 'withSession');
  const semantic = EffectArray.filter(events, event => event.kind === 'semantic');
  return {
    semanticMetadataChecks: semantic.length,
    semanticMetadataCheckWallUnion: intervalUnion(semantic),
    commandWallUnion: intervalUnion(command),
    fileWallUnion: intervalUnion(files),
    storeLeafWallUnion: intervalUnion(store),
    combinedLeafWallUnion: intervalUnion([...command, ...files, ...store]),
    byPhase: EffectRecord.fromEntries(
      EffectArray.map(['outside-query', 'initial', 'evidence', 'closing'] as const, phase => [
        phase,
        {
          commandWallUnion: intervalUnion(EffectArray.filter(command, event => event.phase === phase)),
          fileWallUnion: intervalUnion(EffectArray.filter(files, event => event.phase === phase)),
          storeLeafWallUnion: intervalUnion(EffectArray.filter(store, event => event.phase === phase)),
        },
      ]),
    ),
  };
}
