import {
  mkdir as boundaryMkdir,
  rename as boundaryRename,
  readFile as boundaryReadFile,
  writeFile as boundaryWriteFile,
} from '@threadnote/testing/node-fs-promises';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseResourceId} from '@threadnote/store/resource-id';
import {recallIndexStatus} from '@threadnote/recall/index';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {
  CurrentHandoffSaveSpawn,
  inspectHandoffSaveOperation,
  launchOwnedHandoffSave,
} from '../../src/memory/handoff_save_operation.js';
import {
  eligibleOwnedHandoff,
  handoffSaveReceiptSchema,
  type HandoffSaveReceipt,
} from '../../src/memory/handoff_save_contract.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Drain the child stream's OS callback turn without advancing the Effect test clock.
import {setImmediate} from 'node:timers';
import fc from 'fast-check';

const receiptDirectory = (config: {agentContextHome: string; account: string; user: string}) =>
  config.agentContextHome +
  '/memory-operations/handoff-save-v1/' +
  sha256HexSync(JSON.stringify([config.account])) +
  '/' +
  sha256HexSync(JSON.stringify([config.account, config.user]));
// Promise filesystem work here is an OS protocol interception boundary in the child-process fixture.
function rewriteReadyDirectory(
  stdout: ReadableStream<Uint8Array>,
  config: {agentContextHome: string; account: string; user: string},
  recorded: {bytes?: string; operationId?: string},
) {
  const decoder = new TextDecoder();
  let pending = '';
  let replaced = false;
  return stdout.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(bytes, controller) {
        pending += decoder.decode(bytes, {stream: true});
        for (;;) {
          const index = Option.getOrElse(EffectString.indexOf('\n')(pending), () => -1);
          if (index < 0) break;
          const line = EffectString.slice(0, index)(pending);
          pending = EffectString.slice(index + 1)(pending);
          const frame: unknown = JSON.parse(line);
          if (
            !replaced &&
            typeof frame === 'object' &&
            frame !== null &&
            'type' in frame &&
            frame.type === 'ready' &&
            'operationId' in frame &&
            typeof frame.operationId === 'string'
          ) {
            replaced = true;
            recorded.operationId = frame.operationId;
            const directory = receiptDirectory(config);
            recorded.bytes = await boundaryReadFile(directory + '/' + frame.operationId + '.json', 'utf8');
            await boundaryRename(directory, directory + '.original');
            await boundaryMkdir(directory, {mode: 0o700});
            await boundaryWriteFile(directory + '/' + frame.operationId + '.json', recorded.bytes, {mode: 0o600});
          }
          controller.enqueue(new TextEncoder().encode(line + '\n'));
        }
      },
    }),
  );
}

const source = {
  version: 1 as const,
  commit: EffectString.repeat(40)('a'),
  tree: EffectString.repeat(40)('b'),
  bun: Bun.version,
  target: 'fixture',
};
const platform = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
      ),
    ),
  ),
);
const fixture = Effect.gen(function* () {
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({prefix: 'handoff-parent-'});
  const system = yield* SystemInfo;
  const config = {
    agentContextHome: home,
    account: 'local',
    user: 'tester',
    agentId: 'test',
    manifestPath: home + '/manifest.json',
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: value => {
      controller = value;
    },
  });
  let resolveExit: (value: number) => void = () => {};
  const exited = new Promise<number>(resolve => {
    resolveExit = resolve;
  });
  let operationId = '';
  let go = 0;
  let kills = 0;
  let onRequest = () => {};
  let onGo = () => {};
  let closed = false;
  let closeOnKill = true;
  let observeIdentity = () => Effect.succeed('fixture-start');
  const emit = (frame: object) => {
    if (!closed) controller.enqueue(new TextEncoder().encode(JSON.stringify({operationId, source, ...frame}) + '\n'));
  };
  const close = () => {
    if (!closed) {
      closed = true;
      controller.close();
      resolveExit(0);
    }
  };
  const ready = () => emit({type: 'ready', processId: system.processId, processStartIdentity: 'fixture-start'});
  const receipt = (): HandoffSaveReceipt => ({
    format: 'threadnote-handoff-save',
    version: 1,
    operationId,
    account: 'local',
    user: 'tester',
    source,
    processId: system.processId,
    processStartIdentity: 'fixture-start',
    intentDigest: 'fixture',
    stage: 'complete',
    sequence: 4,
    updatedAt: Date.now(),
    goPossible: true,
    authorized: true,
    possiblyApplied: true,
    canonicalObserved: true,
    lexicalVerified: true,
    result: {
      memoryUri: 'threadnote://user/tester/memories/handoffs/active/threadnote/fixture.md',
      replacementCleanupPending: false,
    },
  });
  const spawn = () => ({
    pid: system.processId,
    stdout,
    exited,
    kill: () => {
      kills++;
      if (closeOnKill) close();
    },
    stdin: {
      write: (line: string) => {
        const frame: unknown = JSON.parse(line);
        if (typeof frame !== 'object' || frame === null) throw new Error('Invalid test request');
        if ('args' in frame && 'operationId' in frame && typeof frame.operationId === 'string') {
          operationId = frame.operationId;
          onRequest();
        } else if ('type' in frame && frame.type === 'go') {
          go++;
          onGo();
        }
        return line.length;
      },
      flush: () => 0,
      end: () => {},
    },
  });
  const launch = launchOwnedHandoffSave(config, {kind: 'handoff', text: 'A small handoff'}).pipe(
    Effect.provideService(CurrentHandoffSaveSpawn, spawn),
    Effect.provideService(SystemInfo, {
      ...system,
      canonicalProcessStartIdentity: () => observeIdentity(),
    }),
  );
  return {
    launch,
    ready,
    emit,
    receipt,
    close,
    go: () => go,
    kills: () => kills,
    holdUnapprovedExit: () => {
      closeOnKill = false;
    },
    onIdentity: (fn: () => Effect.Effect<string>) => {
      observeIdentity = fn;
    },
    onRequest: (fn: () => void) => {
      onRequest = fn;
    },
    onGo: (fn: () => void) => {
      onGo = fn;
    },
  };
});
const withSource = <A, E, R>(program: Effect.Effect<A, E, R>, live = true) =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.stubGlobal('THREADNOTE_RUNTIME_SOURCE_IDENTITY', source)),
    () => program,
    () => Effect.sync(() => vi.unstubAllGlobals()),
  ).pipe(
    program => (live ? TestClock.withLive(program) : program),
    program =>
      Effect.scoped(
        Layer.build(platform).pipe(Effect.flatMap(context => program.pipe(Effect.provideContext(context)))),
      ),
  );

describe('owned handoff parent protocol', () => {
  effectIt.effect(
    'refuses a stalled pre-go worker within the production readiness window and never sends late go',
    () =>
      withSource(
        Effect.gen(function* () {
          const f = yield* fixture;
          const started = yield* Clock.currentTimeMillis;
          const result = yield* f.launch;
          expect(result.structuredContent).toMatchObject({state: 'not-started', authorized: false});
          expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(3_750);
          f.ready();
          yield* Effect.sleep(20);
          expect(f.go()).toBe(0);
          expect(f.kills()).toBe(1);
        }),
      ),
  );
  effectIt.effect('returns pending after go without stopping a child whose final result is held', () =>
    withSource(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.onRequest(f.ready);
        const started = yield* Clock.currentTimeMillis;
        const result = yield* f.launch;
        expect(result.structuredContent).toMatchObject({state: 'pending', authorized: true});
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_750);
        expect(f.go()).toBe(1);
        expect(f.kills()).toBe(0);
        f.close();
      }),
    ),
  );
  effectIt.effect('requires actual child exit after a verified terminal frame before returning saved', () =>
    withSource(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.onRequest(f.ready);
        f.onGo(() => {
          f.emit({type: 'result', receipt: f.receipt()});
          f.close();
        });
        expect((yield* f.launch).structuredContent).toMatchObject({state: 'complete', memoryUri: expect.any(String)});
        expect(f.go()).toBe(1);
        expect(f.kills()).toBe(0);
      }),
    ),
  );
  effectIt.effect('a verified result held before actual child exit cannot complete the first response', () =>
    withSource(
      Effect.gen(function* () {
        const f = yield* fixture;
        const resultSent = Promise.withResolvers<void>();
        f.onRequest(f.ready);
        f.onGo(() => {
          f.emit({type: 'result', receipt: f.receipt()});
          resultSent.resolve();
        });
        const parent = yield* f.launch.pipe(Effect.forkChild);
        yield* Effect.promise(() => resultSent.promise);
        yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
        expect(yield* Effect.sync(() => parent.pollUnsafe())).toBeUndefined();
        yield* TestClock.adjust(1000);
        expect((yield* Fiber.join(parent)).structuredContent).toMatchObject({state: 'pending', authorized: true});
        expect(f.kills()).toBe(0);
        f.close();
        expect((yield* Fiber.join(parent)).structuredContent).toMatchObject({state: 'pending', authorized: true});
      }),
      false,
    ),
  );
  effectIt.effect('uncertain go write keeps the child authorized and never claims not-started', () =>
    withSource(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.onRequest(f.ready);
        f.onGo(() => {
          throw new Error('Go transport failed after observing its write.');
        });
        expect((yield* f.launch).structuredContent).toMatchObject({state: 'pending', authorized: true});
        expect(f.go()).toBe(1);
        expect(f.kills()).toBe(0);
        f.close();
      }),
    ),
  );
  for (const boundary of ['before-go', 'after-go'] as const)
    effectIt.effect(`request interruption ${boundary} preserves exact child ownership`, () =>
      withSource(
        Effect.gen(function* () {
          const f = yield* fixture;
          const observed = Promise.withResolvers<void>();
          if (boundary === 'after-go') {
            f.onRequest(f.ready);
            f.onGo(() => observed.resolve());
          } else f.onRequest(() => observed.resolve());
          const parent = yield* f.launch.pipe(Effect.forkChild);
          yield* Effect.promise(() => observed.promise);
          yield* Fiber.interrupt(parent);
          expect(f.go()).toBe(boundary === 'after-go' ? 1 : 0);
          expect(f.kills()).toBe(boundary === 'after-go' ? 0 : 1);
          f.close();
        }),
      ),
    );
  for (const fault of ['wrong-process', 'duplicate-ready', 'wrong-source'] as const)
    effectIt.effect(`rejects ${fault} without authorization`, () =>
      withSource(
        Effect.gen(function* () {
          const f = yield* fixture;
          f.onRequest(() => {
            if (fault === 'duplicate-ready') {
              f.ready();
              f.ready();
            } else if (fault === 'wrong-source')
              f.emit({
                type: 'ready',
                processId: process.pid,
                processStartIdentity: 'fixture-start',
                source: {...source, commit: 'old'},
              });
            else f.emit({type: 'ready', processId: process.pid, processStartIdentity: 'reused-instance'});
          });
          expect((yield* f.launch).structuredContent).toMatchObject({state: 'not-started', authorized: false});
          expect(f.go()).toBe(0);
          expect(f.kills()).toBe(1);
        }),
      ),
    );
  effectIt.effect('keeps shared, foreign and identity-alias replacements on the synchronous route', () =>
    Effect.sync(() => {
      const args = {kind: 'handoff', text: 'handoff'};
      for (const replaceUri of [
        'threadnote://shared/team/memories/handoffs/test.md',
        'threadnote://memory/tn_identity',
        'threadnote://user/another/memories/handoffs/test.md',
        'threadnote://user/tester/memories/durable/test.md',
        'viking://user/tester/memories/handoffs/test.md',
      ])
        expect(eligibleOwnedHandoff({...args, replaceUri}, 'tester')).toBe(false);
      expect(
        eligibleOwnedHandoff(
          {...args, replaceUri: 'threadnote://user/tester/memories/handoffs/active/project/test.md'},
          'tester',
        ),
      ).toBe(true);
    }),
  );
  fcEffectProp(
    effectIt,
    'citation or non-handoff input never enters the narrow owned-save route',
    {
      text: fc.string({maxLength: 200}),
      cited: fc.boolean(),
      kind: fc.constantFrom('handoff', 'durable', 'preference'),
    },
    ({text, cited, kind}) =>
      Effect.sync(() => {
        const args = {text, kind, ...(cited ? {codeRefs: ['source.ts']} : {})};
        expect(eligibleOwnedHandoff(args)).toBe(kind === 'handoff' && !cited);
        expect(eligibleOwnedHandoff({...args, text: EffectString.repeat(16_385)('é')})).toBe(false);
      }),
    {fastCheck: {numRuns: 20}},
  );
  fcEffectProp(
    effectIt,
    'one-owner generated state-machine histories preserve refusal, authorization and actual exit',
    {
      initial: fc.constantFrom('ready', 'old-source', 'pid-reuse', 'early-result', 'expiry', 'cancel'),
      beforeGo: fc.array(fc.constantFrom('duplicate-ready', 'old-source', 'early-result'), {maxLength: 2}),
      afterGo: fc.constantFrom(
        ['result', 'check', 'exit'],
        ['result', 'deadline', 'late-ready', 'exit'],
        ['duplicate-ready', 'result', 'exit'],
        ['old-result', 'deadline', 'exit'],
        ['cancel', 'result', 'exit'],
        ['exit'],
        ['deadline', 'late-ready', 'result', 'exit'],
      ),
      lateFrames: fc.integer({min: 1, max: 3}),
    },
    ({initial, beforeGo, afterGo, lateFrames}) =>
      withSource(
        Effect.gen(function* () {
          const f = yield* fixture;
          f.holdUnapprovedExit();
          const identityObserved = yield* Deferred.make<void>();
          const identityGate = yield* Deferred.make<string>();
          f.onIdentity(() =>
            Deferred.succeed(identityObserved, undefined).pipe(Effect.andThen(Deferred.await(identityGate))),
          );
          const requested = Promise.withResolvers<void>(),
            granted = Promise.withResolvers<void>();
          f.onRequest(() => requested.resolve());
          f.onGo(() => granted.resolve());
          const parent = yield* f.launch.pipe(Effect.forkChild);
          yield* Effect.promise(() => requested.promise);
          // One independent model persists across commands for this exact owner.
          const model = {
            authorized: false,
            refused: false,
            interrupted: false,
            result: false,
            exited: false,
            broken: false,
          };
          let firstResponse: string | undefined;
          const flush = Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
          const observe = Effect.gen(function* () {
            yield* flush;
            const outcome = yield* Effect.sync(() => parent.pollUnsafe());
            if (outcome === undefined) return;
            if (outcome._tag === 'Failure') {
              expect(model.interrupted).toBe(true);
              return;
            }
            const actual = outcome.value;
            const encoded = JSON.stringify(actual);
            if (firstResponse !== undefined) expect(encoded).toBe(firstResponse);
            else {
              firstResponse = encoded;
              expect(actual.structuredContent).toMatchObject({
                state: model.refused
                  ? 'not-started'
                  : model.result && model.exited && !model.broken
                    ? 'complete'
                    : 'pending',
              });
            }
            expect(f.go()).toBe(model.authorized ? 1 : 0);
          });
          if (initial === 'cancel') {
            model.refused = true;
            model.interrupted = true;
            yield* Fiber.interrupt(parent);
          } else if (initial === 'expiry') {
            model.refused = true;
            yield* TestClock.adjust(3000);
            yield* Fiber.join(parent);
          } else {
            if (initial === 'early-result') f.emit({type: 'result', receipt: f.receipt()});
            else if (initial === 'old-source')
              f.emit({
                type: 'ready',
                processId: process.pid,
                processStartIdentity: 'fixture-start',
                source: {...source, commit: 'old'},
              });
            else if (initial === 'pid-reuse')
              f.emit({type: 'ready', processId: process.pid, processStartIdentity: 'different-instance'});
            else f.ready();
            if (initial === 'ready' || initial === 'pid-reuse') {
              yield* Deferred.await(identityObserved);
              for (const command of beforeGo) {
                if (command === 'duplicate-ready') f.ready();
                else if (command === 'old-source')
                  f.emit({
                    type: 'ready',
                    processId: process.pid,
                    processStartIdentity: 'fixture-start',
                    source: {...source, commit: 'old'},
                  });
                else f.emit({type: 'result', receipt: f.receipt()});
                model.refused = true;
                yield* flush;
              }
              if (initial === 'pid-reuse') model.refused = true;
              yield* Deferred.succeed(identityGate, 'fixture-start');
              if (!model.refused) {
                yield* Effect.promise(() => granted.promise);
                model.authorized = true;
              } else yield* Fiber.join(parent);
            } else {
              model.refused = true;
              yield* Fiber.join(parent);
            }
          }
          if (model.authorized)
            for (const command of afterGo) {
              if (command === 'result') {
                f.emit({type: 'result', receipt: f.receipt()});
                if (!model.broken) model.result = true;
              } else if (command === 'exit') {
                f.close();
                model.exited = true;
                if (!model.result) model.broken = true;
              } else if (command === 'cancel') {
                model.interrupted = true;
                yield* Fiber.interrupt(parent);
              } else if (command === 'deadline') yield* TestClock.adjust(1000);
              else if (command === 'check') {
                yield* flush;
                expect(yield* Effect.sync(() => parent.pollUnsafe())).toBeUndefined();
                expect(model.exited).toBe(false);
              } else {
                if (command === 'old-result')
                  f.emit({type: 'result', receipt: f.receipt(), source: {...source, commit: 'old'}});
                else f.ready();
                // Once a valid result is latched the reader waits only for actual exit.
                if (!model.result) model.broken = true;
              }
              yield* observe;
            }
          if (!model.interrupted) {
            yield* TestClock.adjust(1000);
            yield* Fiber.join(parent);
          }
          yield* observe;
          // A refused process is deliberately still alive here, so these frames reach its reader.
          for (let index = 0; index < lateFrames; index++) {
            f.ready();
            f.emit({type: 'result', receipt: f.receipt()});
            yield* flush;
          }
          expect(f.go()).toBe(model.authorized ? 1 : 0);
          expect(f.kills()).toBe(model.authorized ? 0 : 1);
          yield* observe;
          f.close();
        }),
        false,
      ),
    {fastCheck: {numRuns: 32}},
  );
});

// These examples exercise the actual isolated child and original MCP save handler.
// The fixture controls filesystem boundaries; it does not replace canonical storage.
for (const hold of ['journal', 'metadata', 'prepared', 'authorized', 'uri-lock', 'lexical', 'recall-demand'] as const)
  effectIt.effect(`real child returns bounded truthful admission while ${hold} is held`, () =>
    withSource(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-real-child-'});
        const config = {
          agentContextHome: home,
          account: 'local',
          user: 'tester',
          agentId: 'test',
          manifestPath: home + '/manifest.json',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
        const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
          const created = Bun.spawn({
            cmd: [
              system.executablePath,
              Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
            ],
            env: {...options.environment, THREADNOTE_TEST_HANDOFF_HOLD_STAGE: hold},
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
          });
          child = created;
          return created;
        };
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis;
              const result = yield* launchOwnedHandoffSave(config, {
                kind: 'handoff',
                project: 'threadnote',
                topic: 'bounded-save',
                text: 'Required-stage fixture.',
              }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn));
              const preGo = hold === 'journal' || hold === 'metadata' || hold === 'prepared';
              expect(result.structuredContent).toMatchObject({
                state: preGo ? 'not-started' : 'pending',
                authorized: !preGo,
              });
              expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(preGo ? 3_750 : 4_750);
              expect(yield* fs.readFileString(home + '/fixture-held-stage')).toBe(hold);
              if (!preGo) expect(child?.exitCode).toBeNull();
            }),
          () =>
            Effect.promise(async () => {
              if (child) {
                if (child.exitCode === null) child.kill('SIGKILL');
                await child.exited;
              }
            }),
        );
      }),
    ),
  );

effectIt.effect('real children exit normally and a later save retains the first complete result', () =>
  withSource(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-history-'});
      const config = {
        agentContextHome: home,
        account: 'local',
        user: 'tester',
        agentId: 'test',
        manifestPath: home + '/manifest.json',
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const children: Bun.Subprocess<'pipe', 'pipe', 'ignore'>[] = [];
      const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
        const child = Bun.spawn({
          cmd: [
            system.executablePath,
            Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
          ],
          env: options.environment,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        });
        children.push(child);
        return child;
      };
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            let first: string | undefined;
            for (const topic of ['first', 'second']) {
              const result = yield* launchOwnedHandoffSave(config, {
                kind: 'handoff',
                project: 'threadnote',
                topic,
                text: 'Exact ' + topic + ' handoff body.',
              }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn));
              const admitted = yield* Schema.decodeUnknownEffect(Schema.Struct({operationId: Schema.String}))(
                result.structuredContent,
              );
              if (!first) first = admitted.operationId;
              const child = children[children.length - 1];
              expect(yield* Effect.promise(() => child.exited).pipe(Effect.timeout('5 seconds'))).toBe(0);
              const status = yield* inspectHandoffSaveOperation(config, admitted.operationId);
              const completed = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  state: Schema.Literal('complete'),
                  memoryUri: Schema.String,
                  canonicalObserved: Schema.Literal(true),
                  lexicalVerified: Schema.Literal(true),
                }),
              )(status.structuredContent);
              const resource = parseResourceId(completed.memoryUri);
              expect(
                yield* fs.readFileString(path.join(home, 'data', 'local', 'user', ...resource.segments)),
              ).toContain('Exact ' + topic + ' handoff body.');
              expect((yield* recallIndexStatus(config, false)).ready).toBe(true);
            }
            expect((yield* inspectHandoffSaveOperation(config, first!)).structuredContent).toMatchObject({
              state: 'complete',
              alive: false,
            });
          }),
        () =>
          Effect.promise(async () => {
            for (const child of children) {
              if (child.exitCode === null) child.kill('SIGKILL');
              await child.exited;
            }
          }),
      );
    }),
  ),
);

effectIt.effect(
  'one live worker excludes another user in the same account while other accounts remain independent',
  () =>
    withSource(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-account-owner-'});
        const base = {
          agentContextHome: home,
          account: 'local',
          user: 'tester',
          agentId: 'test',
          manifestPath: home + '/manifest.json',
        };
        yield* fs.writeFileString(base.manifestPath, 'version: 1\nprojects: []\n');
        const children: Bun.Subprocess<'pipe', 'pipe', 'ignore'>[] = [];
        const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
          const child = Bun.spawn({
            cmd: [
              system.executablePath,
              Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
            ],
            env: {...options.environment, THREADNOTE_TEST_HANDOFF_HOLD_STAGE: 'uri-lock'},
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
          });
          children.push(child);
          return child;
        };
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              for (const [config, authorized] of [
                [base, true],
                [{...base, user: 'another'}, false],
                [{...base, account: 'separate'}, true],
              ] as const) {
                const result = yield* launchOwnedHandoffSave(config, {
                  kind: 'handoff',
                  topic: 'account-owner',
                  text: 'Scoped ownership.',
                }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn));
                expect(result.structuredContent).toMatchObject({
                  state: authorized ? 'pending' : 'not-started',
                  authorized,
                });
              }
              expect(children[0].exitCode).toBeNull();
              expect(children[2].exitCode).toBeNull();
            }),
          () =>
            Effect.promise(async () => {
              for (const child of children) {
                if (child.exitCode === null) child.kill('SIGKILL');
                await child.exited;
              }
            }),
        );
      }),
    ),
  {timeout: 15_000},
);

for (const fault of ['redirected-private-directory', 'removed-home'] as const)
  effectIt.effect(`fails closed for ${fault} without recreating or writing outside the home`, () =>
    withSource(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-path-authority-'});
        const home = root + '/home',
          outside = root + '/outside';
        yield* fs.makeDirectory(home);
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(outside + '/sentinel', 'preserve');
        const config = {
          agentContextHome: home,
          account: 'local',
          user: 'tester',
          agentId: 'test',
          manifestPath: home + '/manifest.json',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        if (fault === 'removed-home') yield* fs.remove(home, {recursive: true});
        else yield* fs.symlink(outside, home + '/memory-operations');
        let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
        const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
          const created = Bun.spawn({
            cmd: [
              system.executablePath,
              Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
            ],
            env: options.environment,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
          });
          child = created;
          return created;
        };
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              const result = yield* launchOwnedHandoffSave(config, {
                kind: 'handoff',
                text: 'Do not mutate a redirected home.',
              }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn));
              expect(result.structuredContent).toMatchObject({state: 'not-started', authorized: false});
              expect(yield* fs.readFileString(outside + '/sentinel')).toBe('preserve');
              expect(yield* fs.readDirectory(outside)).toEqual(['sentinel']);
              if (fault === 'removed-home') expect(yield* fs.exists(home)).toBe(false);
            }),
          () =>
            Effect.promise(async () => {
              if (child) {
                if (child.exitCode === null) child.kill('SIGKILL');
                await child.exited;
              }
            }),
        );
      }),
    ),
  );

effectIt.effect('a copied prepared receipt cannot transfer the original worker to a replacement directory', () =>
  withSource(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-original-scope-'});
      const config = {
        agentContextHome: home,
        account: 'local',
        user: 'tester',
        agentId: 'test',
        manifestPath: home + '/manifest.json',
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const recorded: {bytes?: string; operationId?: string} = {};
      let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
      const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
        const raw = Bun.spawn({
          cmd: [
            system.executablePath,
            Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
          ],
          env: options.environment,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        });
        child = raw;
        return {
          pid: raw.pid,
          stdin: raw.stdin,
          stdout: rewriteReadyDirectory(raw.stdout, config, recorded),
          exited: raw.exited,
          kill: (signal?: NodeJS.Signals) => raw.kill(signal),
        };
      };
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const result = yield* launchOwnedHandoffSave(config, {
              kind: 'handoff',
              project: 'threadnote',
              topic: 'scope-copy',
              text: 'Must not cross the copied journal.',
            }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn));
            expect(result.structuredContent).toMatchObject({state: 'pending', authorized: true});
            if (child) yield* Effect.promise(() => child!.exited).pipe(Effect.timeout('5 seconds'));
            expect(recorded.operationId).toBeDefined();
            expect(recorded.bytes).toBeDefined();
            const directory = receiptDirectory(config);
            expect(yield* fs.readDirectory(directory)).toEqual([recorded.operationId + '.json']);
            expect(yield* fs.readFileString(directory + '/' + recorded.operationId + '.json')).toBe(recorded.bytes);
            expect(yield* fs.exists(home + '/data/local/user/tester/memories/handoffs')).toBe(false);
          }),
        () =>
          Effect.promise(async () => {
            if (child) {
              if (child.exitCode === null) child.kill('SIGKILL');
              await child.exited;
            }
          }),
      );
    }),
  ),
);

effectIt.effect(
  'history pressure retires only an old dead terminal receipt and its cancel marker',
  () =>
    withSource(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-history-pressure-'});
        const config = {
          agentContextHome: home,
          account: 'local',
          user: 'tester',
          agentId: 'test',
          manifestPath: home + '/manifest.json',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        const children: Bun.Subprocess<'pipe', 'pipe', 'ignore'>[] = [];
        const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
          const child = Bun.spawn({
            cmd: [
              system.executablePath,
              Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
            ],
            env: options.environment,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
          });
          children.push(child);
          return child;
        };
        const save = (topic: string) =>
          launchOwnedHandoffSave(config, {
            kind: 'handoff',
            project: 'threadnote',
            topic,
            text: 'History pressure ' + topic,
          }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn));
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              const first = yield* save('original');
              const firstId = yield* Schema.decodeUnknownEffect(Schema.Struct({operationId: Schema.String}))(
                first.structuredContent,
              );
              expect(yield* Effect.promise(() => children[0].exited).pipe(Effect.timeout('5 seconds'))).toBe(0);
              const directory = receiptDirectory(config);
              const original = yield* fs.readFileString(directory + '/' + firstId.operationId + '.json');
              const decoded: unknown = yield* Effect.try(() => JSON.parse(original));
              const basis = yield* Schema.decodeUnknownEffect(handoffSaveReceiptSchema)(decoded);
              let oldest = '';
              let protectedId = '';
              let protectedBytes = '';
              for (let index = 1; index <= 63; index++) {
                const operationId = '00000000-0000-4000-8000-' + EffectString.padStart(12, '0')(String(index));
                const guarded = index === 63;
                const record = {
                  ...basis,
                  operationId,
                  updatedAt: basis.updatedAt - index,
                  ...(guarded
                    ? {
                        stage: 'authorized' as const,
                        canonicalObserved: false,
                        lexicalVerified: false,
                        result: undefined,
                        response: undefined,
                      }
                    : {}),
                };
                const bytes = JSON.stringify(record);
                yield* fs.writeFileString(directory + '/' + operationId + '.json', bytes);
                yield* fs.writeFileString(directory + '/' + operationId + '.cancel', operationId);
                if (index === 62) oldest = operationId;
                if (guarded) {
                  protectedId = operationId;
                  protectedBytes = bytes;
                }
              }
              const second = yield* save('next');
              expect(
                (yield* Schema.decodeUnknownEffect(Schema.Struct({state: Schema.Literals(['complete', 'pending'])}))(
                  second.structuredContent,
                )).state,
              ).toMatch(/complete|pending/u);
              expect(yield* Effect.promise(() => children[1].exited).pipe(Effect.timeout('5 seconds'))).toBe(0);
              expect(yield* fs.exists(directory + '/' + oldest + '.json')).toBe(false);
              expect(yield* fs.exists(directory + '/' + oldest + '.cancel')).toBe(false);
              expect(yield* fs.readFileString(directory + '/' + protectedId + '.json')).toBe(protectedBytes);
              expect(yield* fs.readFileString(directory + '/' + protectedId + '.cancel')).toBe(protectedId);
              expect(yield* fs.readFileString(directory + '/' + firstId.operationId + '.json')).toBe(original);
              expect(
                EffectArray.filter(yield* fs.readDirectory(directory), name => /^[a-f0-9-]{36}\.json$/u.test(name)),
              ).toHaveLength(64);
            }),
          () =>
            Effect.promise(async () => {
              for (const child of children) {
                if (child.exitCode === null) child.kill('SIGKILL');
                await child.exited;
              }
            }),
        );
      }),
    ),
  {timeout: 12_000},
);

for (const beforeGo of [true, false])
  effectIt.effect(
    `real cancellation ${beforeGo ? 'before' : 'after'} go preserves canonical outcome and receipt ownership`,
    () =>
      withSource(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-cancel-'});
          const config = {
            agentContextHome: home,
            account: 'local',
            user: 'tester',
            agentId: 'test',
            manifestPath: home + '/manifest.json',
          };
          yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
          let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
          const spawn = (options: {readonly environment: NodeJS.ProcessEnv}) => {
            const raw = Bun.spawn({
              cmd: [
                system.executablePath,
                Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
              ],
              env: {...options.environment, THREADNOTE_TEST_HANDOFF_HOLD_STAGE: beforeGo ? 'metadata' : 'uri-lock'},
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'ignore',
            });
            child = raw;
            return raw;
          };
          yield* Effect.acquireUseRelease(
            Effect.void,
            () =>
              Effect.gen(function* () {
                const parent = yield* launchOwnedHandoffSave(config, {
                  kind: 'handoff',
                  project: 'threadnote',
                  topic: 'cancelled',
                  text: 'Do not replay a cancelled save.',
                }).pipe(Effect.provideService(CurrentHandoffSaveSpawn, spawn), Effect.forkChild);
                for (let turn = 0; turn < 200 && !(yield* fs.exists(home + '/fixture-held-stage')); turn++)
                  yield* Effect.sleep(10);
                expect(yield* fs.readFileString(home + '/fixture-held-stage')).toBe(beforeGo ? 'metadata' : 'uri-lock');
                const directory = receiptDirectory(config);
                const files = EffectArray.filter(yield* fs.readDirectory(directory), name =>
                  /^[a-f0-9-]{36}\.json$/u.test(name),
                );
                expect(files).toHaveLength(1);
                const operationId = EffectString.slice(0, -5)(files[0]);
                if (!beforeGo)
                  expect((yield* Fiber.join(parent)).structuredContent).toMatchObject({
                    state: 'pending',
                    authorized: true,
                  });
                const receiptBefore = yield* fs.readFileString(directory + '/' + files[0]);
                const cancelled = yield* inspectHandoffSaveOperation(config, operationId, true);
                expect(cancelled.structuredContent).toMatchObject({cancellationRequested: true});
                expect(yield* fs.readFileString(directory + '/' + operationId + '.cancel')).toBe(operationId);
                if (beforeGo) {
                  expect((yield* Fiber.join(parent)).structuredContent).toMatchObject({
                    state: 'not-started',
                    authorized: false,
                  });
                  if (child) yield* Effect.promise(() => child!.exited).pipe(Effect.timeout('5 seconds'));
                } else {
                  expect(child?.exitCode).toBeNull();
                  expect(yield* fs.readFileString(directory + '/' + files[0])).toBe(receiptBefore);
                  yield* inspectHandoffSaveOperation(config, operationId, true);
                  expect(yield* fs.readFileString(directory + '/' + files[0])).toBe(receiptBefore);
                  if (child) {
                    child.kill('SIGKILL');
                    yield* Effect.promise(() => child!.exited);
                  }
                  expect((yield* inspectHandoffSaveOperation(config, operationId)).structuredContent).toMatchObject({
                    state: 'unknown',
                    authorized: true,
                  });
                }
                expect(yield* fs.exists(home + '/data/local/user/tester/memories/handoffs')).toBe(false);
              }),
            () =>
              Effect.promise(async () => {
                if (child) {
                  if (child.exitCode === null) child.kill('SIGKILL');
                  await child.exited;
                }
              }),
          );
        }),
      ),
  );

const actualHandoff = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'handoff-protocol-history-'});
  const config = {
    agentContextHome: home,
    account: 'local',
    user: 'tester',
    agentId: 'test',
    manifestPath: home + '/manifest.json',
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const children: Bun.Subprocess<'pipe', 'pipe', 'ignore'>[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    }),
  );
  const start = (environment: NodeJS.ProcessEnv = {}) =>
    launchOwnedHandoffSave(config, {
      kind: 'handoff',
      project: 'threadnote',
      topic: 'protocol-history',
      text: 'Exact protocol-history canonical body.',
    }).pipe(
      Effect.provideService(CurrentHandoffSaveSpawn, options => {
        const child = Bun.spawn({
          cmd: [
            system.executablePath,
            Bun.fileURLToPath(new URL('../fixtures/handoff-save-worker.ts', import.meta.url)),
          ],
          env: {...options.environment, ...environment},
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        });
        children.push(child);
        return child;
      }),
    );
  return {fs, system, home, config, children, start};
});

for (const stage of ['prepared', 'canonical-observed'] as const)
  effectIt.effect(`real child crash at ${stage} retains truthful outcome without replay`, () =>
    withSource(
      Effect.gen(function* () {
        const f = yield* actualHandoff;
        const result = yield* f.start({THREADNOTE_TEST_HANDOFF_CRASH_STAGE: stage});
        const {operationId} = yield* Schema.decodeUnknownEffect(Schema.Struct({operationId: Schema.String}))(
          result.structuredContent,
        );
        expect(yield* Effect.promise(() => f.children[0].exited).pipe(Effect.timeout('5 seconds'))).toBe(77);
        const directory = receiptDirectory(f.config);
        const before = yield* f.fs.readFileString(directory + '/' + operationId + '.json');
        const applied = stage === 'canonical-observed';
        for (let repeat = 0; repeat < 3; repeat++) {
          expect((yield* inspectHandoffSaveOperation(f.config, operationId)).structuredContent).toMatchObject({
            state: 'unknown',
            authorized: applied,
            possiblyApplied: applied,
            canonicalObserved: false,
            alive: false,
          });
          expect(yield* f.fs.readFileString(directory + '/' + operationId + '.json')).toBe(before);
        }
        const canonical = f.home + '/data/local/user/tester/memories/handoffs/active/threadnote/protocol-history.md';
        expect(yield* f.fs.exists(canonical)).toBe(applied);
        if (applied) expect(yield* f.fs.readFileString(canonical)).toContain('Exact protocol-history canonical body.');
        expect(f.children).toHaveLength(1);
      }),
    ),
  );

effectIt.effect('simultaneous separate homes progress independently and cannot inspect each other operations', () =>
  withSource(
    Effect.gen(function* () {
      const first = yield* actualHandoff,
        second = yield* actualHandoff;
      const results = yield* Effect.all(
        [
          first.start({THREADNOTE_TEST_HANDOFF_HOLD_STAGE: 'uri-lock'}),
          second.start({THREADNOTE_TEST_HANDOFF_HOLD_STAGE: 'uri-lock'}),
        ],
        {concurrency: 2},
      );
      const ids = yield* Effect.forEach(results, result =>
        Schema.decodeUnknownEffect(
          Schema.Struct({
            state: Schema.Literal('pending'),
            authorized: Schema.Literal(true),
            operationId: Schema.String,
          }),
        )(result.structuredContent),
      );
      expect(ids[0].operationId).not.toBe(ids[1].operationId);
      for (const [home, index] of [
        [first, 0],
        [second, 1],
      ] as const) {
        expect(home.children[0].exitCode).toBeNull();
        expect(
          (yield* inspectHandoffSaveOperation(home.config, ids[index].operationId)).structuredContent,
        ).toMatchObject({state: 'pending', authorized: true, alive: true});
        expect(
          (yield* inspectHandoffSaveOperation(home.config, ids[1 - index].operationId)).structuredContent,
        ).toMatchObject({state: 'unknown'});
      }
    }),
  ),
);

for (const observation of ['different-instance', 'unknown'] as const)
  effectIt.effect(`pre-go status cancellation never signals a ${observation} process`, () =>
    withSource(
      Effect.gen(function* () {
        const f = yield* actualHandoff;
        const parent = yield* f.start({THREADNOTE_TEST_HANDOFF_HOLD_STAGE: 'metadata'}).pipe(Effect.forkChild);
        for (let turn = 0; turn < 200 && !(yield* f.fs.exists(f.home + '/fixture-held-stage')); turn++)
          yield* Effect.sleep(10);
        expect(yield* f.fs.readFileString(f.home + '/fixture-held-stage')).toBe('metadata');
        const directory = receiptDirectory(f.config);
        const files = EffectArray.filter(yield* f.fs.readDirectory(directory), file =>
          /^[a-f0-9-]{36}\.json$/u.test(file),
        );
        expect(files).toHaveLength(1);
        const operationId = EffectString.slice(0, -5)(files[0]);
        const before = yield* f.fs.readFileString(directory + '/' + files[0]);
        let signals = 0;
        const status = yield* inspectHandoffSaveOperation(f.config, operationId, true).pipe(
          Effect.provideService(SystemInfo, {
            ...f.system,
            canonicalProcessStartIdentity: pid =>
              pid === f.children[0].pid
                ? Effect.succeed(observation === 'unknown' ? undefined : 'another-instance')
                : f.system.canonicalProcessStartIdentity!(pid),
            signalProcess: () => {
              signals++;
            },
          }),
        );
        expect(status.structuredContent).toMatchObject({
          state: observation === 'unknown' ? 'pending' : 'unknown',
          authorized: false,
          cancellationRequested: true,
        });
        expect(signals).toBe(0);
        expect(f.children[0].exitCode).toBeNull();
        expect(yield* f.fs.readFileString(directory + '/' + files[0])).toBe(before);
        yield* Fiber.interrupt(parent);
      }),
    ),
  );

for (const observation of ['different-instance', 'unknown'] as const)
  effectIt.effect(
    `account intake ${observation === 'unknown' ? 'retains unknown ownership' : 'recovers positively reused PID ownership'}`,
    () =>
      withSource(
        Effect.gen(function* () {
          const f = yield* actualHandoff;
          const path = yield* Path.Path;
          const directory = receiptDirectory(f.config);
          yield* f.fs.makeDirectory(directory, {recursive: true});
          const owner = path.join(path.dirname(directory), 'owner.json');
          const original = JSON.stringify({
            operationId: '00000000-0000-4000-8000-000000000001',
            user: 'tester',
            processId: f.system.processId,
            processStartIdentity: 'positively-old-instance',
          });
          yield* f.fs.writeFileString(owner, original);
          const result = yield* f.start(
            observation === 'unknown' ? {THREADNOTE_TEST_HANDOFF_UNKNOWN_PID: String(f.system.processId)} : {},
          );
          const allowed = observation !== 'unknown';
          expect(result.structuredContent).toMatchObject({
            state: allowed ? expect.stringMatching(/complete|pending/u) : 'not-started',
          });
          const exit = yield* Effect.promise(() => f.children[0].exited).pipe(Effect.timeout('5 seconds'));
          // A refused pre-go child may exit itself or be terminated by its exact parent handle.
          expect(allowed ? [0] : [0, 143]).toContain(exit);
          expect(
            yield* f.fs.exists(
              f.home + '/data/local/user/tester/memories/handoffs/active/threadnote/protocol-history.md',
            ),
          ).toBe(allowed);
          if (!allowed) expect(yield* f.fs.readFileString(owner)).toBe(original);
          else expect(yield* f.fs.readFileString(owner)).not.toBe(original);
        }),
      ),
  );
