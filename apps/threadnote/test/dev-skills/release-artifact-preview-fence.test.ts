import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {afterAll, beforeAll, expect} from 'vitest';
import fc from 'fast-check';
import {ChildProcess, spawn, type ChildProcessWithoutNullStreams} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {TestError} from '@threadnote/testing/test-error';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {DevSkillsSource} from '../../src/dev_skills/manifest.js';
import {applyDevSkills} from '../../src/dev_skills/index.js';
import {handleManagerDevSkillsRequest} from '../../src/manager/dev_skills.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

let harnessDirectory: string | undefined;
let harness: string;
beforeAll(async () => {
  harnessDirectory = await mkdtemp(resolve(tmpdir(), 'threadnote-release-fence-'));
  harness = resolve(harnessDirectory, process.platform === 'win32' ? 'release-artifact.exe' : 'release-artifact');
  const build = await Bun.build({
    entrypoints: [resolve('apps/threadnote/test/dev-skills/release-artifact.ts')],
    compile: {outfile: harness},
  });
  expect(build.success, JSON.stringify(build.logs)).toBe(true);
}, 30_000);
afterAll(async () => {
  if (harnessDirectory) await rm(harnessDirectory, {recursive: true, force: true});
});

const readinessFrame = () => {
  const prefix = [114, 101, 97, 100, 121];
  let matchedBytes = 0;
  let status: 'pending' | 'ready' | 'invalid' = 'pending';
  return {
    push: (chunk: Uint8Array) => {
      for (const byte of chunk) {
        if (status !== 'pending') break;
        if (matchedBytes < prefix.length && byte === prefix[matchedBytes]) matchedBytes++;
        else if (matchedBytes === prefix.length && byte === 13) matchedBytes++;
        else if (matchedBytes >= prefix.length && byte === 10) status = 'ready';
        else status = 'invalid';
      }
      return status;
    },
    snapshot: () => ({matchedBytes, status}),
  };
};
const waitReady = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<void, Error>(resume => {
    const frame = readinessFrame();
    let settled = false;
    const cleanup = () => {
      child.stdout.off('data', ready);
      child.stderr.off('data', stderr);
      child.off('close', failed);
      child.off('error', error);
    };
    const complete = (result: Effect.Effect<void, Error>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(result);
    };
    const ready = (chunk: Buffer) => {
      const status = frame.push(chunk);
      if (status === 'ready') complete(Effect.void);
      else if (status === 'invalid')
        complete(Effect.fail(TestError.make({message: 'Invalid fixture readiness record'})));
    };
    const failed = () => complete(Effect.fail(TestError.make({message: 'Fence child exited before ready'})));
    const error = (cause: Error) => complete(Effect.fail(cause));
    // Drain without retaining or echoing subprocess bytes in failure messages.
    const stderr = () => {};
    child.stdout.on('data', ready);
    child.stderr.on('data', stderr);
    child.once('close', failed);
    child.once('error', error);
    return Effect.sync(() => {
      settled = true;
      cleanup();
    });
  }).pipe(Effect.timeout('5 seconds'));
const waitExit = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<void, TestError>(resume => {
    const closed = (code: number | null) =>
      resume(code === 0 ? Effect.void : Effect.fail(TestError.make({message: `Fence child exit ${code}`})));
    if (child.exitCode !== null) {
      closed(child.exitCode);
      return;
    }
    child.once('close', closed);
    return Effect.sync(() => {
      child.off('close', closed);
    });
  });
const withNativeFence = <A, E, R>(root: string, program: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const environment = system.environment();
      const child = spawn(harness, ['--hold-account-lock', root], {
        env: {
          ...environment,
          HOME: resolve(root, 'user'),
          USERPROFILE: resolve(root, 'user'),
          THREADNOTE_HOME: resolve(root, 'data'),
          TMPDIR: root,
          TMP: root,
          TEMP: root,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      return child;
    }),
    child => waitReady(child).pipe(Effect.andThen(program)),
    child =>
      Effect.sync(() => {
        if (!child.stdin.destroyed) child.stdin.end('release\n');
      }).pipe(
        Effect.andThen(waitExit(child)),
        Effect.timeout('5 seconds'),
        Effect.ensuring(
          Effect.sync(() => {
            if (child.exitCode === null) child.kill();
          }),
        ),
      ),
  );

const awaitFenceAdmission = <A, E>(entered: Deferred.Deferred<void>, observer: Fiber.Fiber<A, E>) =>
  Effect.raceFirst(Deferred.await(entered), Fiber.join(observer));

const makeFixture = Effect.gen(function* () {
  const f = yield* fixture();
  const home = f.path.join(f.root, 'data');
  const user = f.path.join(f.root, 'user');
  const lock = resourceAccountMutationLockPath(f.path, home, 'local');
  for (const directory of [user, f.runtime, f.path.dirname(lock)])
    yield* f.fs.makeDirectory(directory, {recursive: true});
  const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.yaml')};
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SystemInfo, {...f.system, homeDirectory: user}),
      Effect.provideService(DevSkillsSource, {root: f.source, runtimeVersion: '5.3.0-beta.4'}),
    );
  const inventory = Effect.all({user: snapshot(user), data: snapshot(home), runtime: snapshot(f.runtime)});
  return {...f, home, user, lock, config, run, inventory};
});
const changed = (before: Record<string, Record<string, string>>, after: Record<string, Record<string, string>>) =>
  Object.keys(before).flatMap(name =>
    [...new Set([...Object.keys(before[name]), ...Object.keys(after[name])])]
      .filter(key => before[name][key] !== after[name][key])
      .map(key => `${name}/${key}`),
  );
const observedFileSystem = (
  fs: FileSystem.FileSystem,
  lock: string,
  attempted: Deferred.Deferred<void>,
  acquired?: {readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void>},
): FileSystem.FileSystem => ({
  ...fs,
  writeFileString: (file, data, options) =>
    (file === lock ? Deferred.succeed(attempted, undefined).pipe(Effect.asVoid) : Effect.void).pipe(
      Effect.andThen(fs.writeFileString(file, data, options)),
      Effect.andThen(
        file === lock && acquired
          ? Deferred.succeed(acquired.entered, undefined).pipe(Effect.andThen(Deferred.await(acquired.release)))
          : Effect.void,
      ),
    ),
});

effectIt.effect('demonstrates the unfenced full inventory refusing an actual settled-reader lock interleaving', () =>
  Effect.gen(function* () {
    const f = yield* makeFixture;
    const attempted = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const before = yield* f.inventory;
    const fs = observedFileSystem(f.fs, f.lock, attempted, {entered, release});
    const reader = yield* readSettledCanonicalMutationGeneration(fs, f.path, f.home, 'local').pipe(Effect.forkChild);
    yield* Effect.gen(function* () {
      yield* Deferred.await(entered);
      const after = yield* f.inventory;
      const equality = yield* Effect.sync(() => expect(after).toEqual(before)).pipe(Effect.exit);
      expect(Exit.isFailure(equality)).toBe(true);
      expect(changed(before, after)).toEqual(['data/locks/resources/local/mutations.lock']);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    expect(yield* Fiber.join(reader)).toBe('');
    expect(yield* f.fs.exists(f.lock)).toBe(false);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('fences the full Manager update preview while the actual settled reader waits on the exact token', () =>
  Effect.gen(function* () {
    const f = yield* makeFixture;
    const selector = {agent: 'antigravity-cli', scope: 'user' as const};
    yield* f.run(applyDevSkills(f.config, 'install', selector));
    const outside = yield* f.inventory;
    const attempted = yield* Deferred.make<void>();
    const fs = observedFileSystem(f.fs, f.lock, attempted);
    let completed = false;
    const reader = yield* withNativeFence(
      f.root,
      Effect.gen(function* () {
        const token = yield* f.fs.readFileString(f.lock);
        const before = yield* f.inventory;
        const reader = yield* readSettledCanonicalMutationGeneration(fs, f.path, f.home, 'local').pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(attempted);
        const preview = yield* f.run(
          handleManagerDevSkillsRequest({
            config: f.config,
            method: 'POST',
            url: new URL('http://127.0.0.1/api/dev-skills/preview'),
            body: Effect.succeed({action: 'update', selector}),
          }),
        );
        expect(preview?.status).toBe(200);
        expect(preview?.body).toMatchObject({action: 'update', canApply: true});
        expect(yield* f.inventory).toEqual(before);
        expect(yield* f.fs.readFileString(f.lock)).toBe(token);
        expect(completed).toBe(false);
        return reader;
      }),
    );
    expect(yield* Fiber.join(reader)).toBe('');
    expect(completed).toBe(true);
    expect(yield* f.inventory).toEqual(outside);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('interrupting the observation releases the native fixture token and admits the settled reader', () =>
  Effect.gen(function* () {
    const f = yield* makeFixture;
    const entered = yield* Deferred.make<void>();
    const observer = yield* withNativeFence(
      f.root,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* awaitFenceAdmission(entered, observer);
    yield* Fiber.interrupt(observer);
    expect(yield* f.fs.exists(f.lock)).toBe(false);
    expect(yield* readSettledCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe('');
    expect(yield* f.fs.exists(f.lock)).toBe(false);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);

fcEffectProp(
  effectIt,
  'preview fence preserves body outcomes, exact owner token and immutable full inventory',
  {
    bodyFails: fc.boolean(),
    interruptReader: fc.boolean(),
    value: fc.integer(),
  },
  input =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.fs.writeFileString(f.path.join(f.home, 'canonical-fixture.txt'), String(input.value));
      const outside = yield* f.inventory;
      const attempted = yield* Deferred.make<void>();
      const fs = observedFileSystem(f.fs, f.lock, attempted);
      const original = TestError.make({message: 'original controlled preview failure'});
      let reader: Fiber.Fiber<string, unknown> | undefined;
      const result = yield* withNativeFence(
        f.root,
        Effect.gen(function* () {
          const token = yield* f.fs.readFileString(f.lock);
          const before = yield* f.inventory;
          reader = yield* readSettledCanonicalMutationGeneration(fs, f.path, f.home, 'local').pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          if (input.interruptReader) yield* Fiber.interrupt(reader);
          expect(yield* f.fs.readFileString(f.lock)).toBe(token);
          expect(yield* f.inventory).toEqual(before);
          if (input.bodyFails) return yield* original;
          return input.value;
        }),
      ).pipe(Effect.exit);
      expect(result).toEqual(
        yield* (input.bodyFails ? Effect.fail(original) : Effect.succeed(input.value)).pipe(Effect.exit),
      );
      if (reader) {
        const outcome = yield* Fiber.await(reader);
        expect(Exit.isSuccess(outcome)).toBe(!input.interruptReader);
      }
      expect(yield* f.fs.exists(f.lock)).toBe(false);
      expect(yield* f.inventory).toEqual(outside);
    }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
  {fastCheck: {numRuns: 16}},
);

// Event-only child double: the constructor does not spawn an operating-system process.
const protocolChild = () => {
  const child = new ChildProcess() as ChildProcessWithoutNullStreams;
  Object.defineProperties(child, {stdout: {value: new ChildProcess()}, stderr: {value: new ChildProcess()}});
  return child;
};
const expectNoProtocolListeners = (child: ChildProcessWithoutNullStreams) => {
  expect(child.stdout.listenerCount('data')).toBe(0);
  expect(child.stderr.listenerCount('data')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
};

effectIt.effect('readiness protocol accepts exact LF and CRLF across every split without waiting for its cap', () =>
  Effect.gen(function* () {
    for (const frame of ['ready\n', 'ready\r\n']) {
      for (let split = 0; split <= frame.length; split++) {
        const child = protocolChild();
        const waiting = yield* waitReady(child).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        child.stdout.emit('data', Buffer.from(frame.slice(0, split)));
        child.stdout.emit('data', Buffer.from(frame.slice(split)));
        yield* TestClock.adjust('5 seconds');
        expect(yield* Fiber.await(waiting)).toEqual(Exit.void);
        expectNoProtocolListeners(child);
      }
    }
  }),
);

effectIt.effect('incomplete readiness retains the original five-second cap and cleans its listeners', () =>
  Effect.gen(function* () {
    const child = protocolChild();
    const waiting = yield* waitReady(child).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    child.stdout.emit('data', Buffer.from('ready\r'));
    yield* TestClock.adjust('5 seconds');
    const result = yield* Fiber.await(waiting);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({_tag: 'TimeoutError'});
    expectNoProtocolListeners(child);
  }),
);

effectIt.effect('observer failure reaches pending admission with its original cause', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const original = TestError.make({message: 'controlled observer failure before admission'});
    const observer = yield* Effect.fail(original).pipe(Effect.forkChild);
    yield* Fiber.await(observer);
    const admission = yield* awaitFenceAdmission(entered, observer).pipe(Effect.timeout('1 millis'), Effect.forkChild);
    yield* TestClock.adjust('1 millis');
    expect(yield* Fiber.await(admission)).toEqual(Exit.fail(original));
  }),
);

effectIt.effect('readiness protocol refuses false, malformed and oversized records without exposing bytes', () =>
  Effect.gen(function* () {
    for (const frame of ['notready\n', 'readyX\n', 'ready\rX\n', 'ready\r\r\n', '/private/body/token'.repeat(1024)]) {
      const child = protocolChild();
      const waiting = yield* waitReady(child).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      child.stderr.emit('data', Buffer.from('/private/error/credential'));
      child.stdout.emit('data', Buffer.from(frame));
      const result = yield* Fiber.await(waiting);
      expect(Exit.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('/private');
      expect(JSON.stringify(result)).not.toContain('credential');
      expectNoProtocolListeners(child);
    }
  }),
);

effectIt.effect('readiness protocol preserves early spawn failure and refuses early close with listener cleanup', () =>
  Effect.gen(function* () {
    const original = new Error('controlled spawn error');
    for (const event of ['error', 'close'] as const) {
      const child = protocolChild();
      const waiting = yield* waitReady(child).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      if (event === 'error') child.emit('error', original);
      else child.emit('close', 0, null);
      const result = yield* Fiber.await(waiting);
      if (event === 'error') expect(result).toEqual(Exit.fail(original));
      else expect(Exit.isFailure(result)).toBe(true);
      expectNoProtocolListeners(child);
    }
  }),
);

effectIt.effect(
  'readiness interruption removes listeners and pending admission cancellation leaves its holder owned',
  () =>
    Effect.gen(function* () {
      const child = protocolChild();
      const waiting = yield* waitReady(child).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      const result = yield* Fiber.await(waiting);
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
      expectNoProtocolListeners(child);
      const entered = yield* Deferred.make<void>();
      let released = false;
      const observer = yield* Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            released = true;
          }),
        ),
        Effect.forkChild,
      );
      const admission = yield* awaitFenceAdmission(entered, observer).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(admission);
      expect(released).toBe(false);
      yield* Fiber.interrupt(observer);
      expect(released).toBe(true);
    }),
);

fcEffectProp(
  effectIt,
  'readiness framing is chunk independent, bounded, private and nonmutating',
  {
    bytes: fc.oneof(
      fc.uint8Array({maxLength: 128}),
      fc
        .constantFrom('ready\n', 'ready\r\n', 'ready', 'ready\r', 'notready\n', '/private/body/token')
        .map(value => Buffer.from(value)),
    ),
    cuts: fc.array(fc.integer({min: 0, max: 128}), {maxLength: 16}),
    ending: fc.constantFrom('close', 'error', 'interrupt'),
  },
  input =>
    Effect.gen(function* () {
      const before = Buffer.from(input.bytes);
      const cutsBefore = [...input.cuts];
      const text = Buffer.from(input.bytes).toString('latin1');
      const newline = text.indexOf('\n');
      const line = newline < 0 ? text : text.slice(0, newline);
      const expected =
        newline >= 0
          ? line === 'ready' || line === 'ready\r'
            ? 'ready'
            : 'invalid'
          : 'ready\r'.startsWith(line)
            ? 'pending'
            : 'invalid';
      const frame = readinessFrame();
      const initial = frame.snapshot();
      const child = protocolChild();
      const waiting = yield* waitReady(child).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const cuts = [...input.cuts.map(value => Math.min(value, input.bytes.length)), input.bytes.length].sort(
        (a, b) => a - b,
      );
      let start = 0;
      for (const end of cuts) {
        const chunk = input.bytes.subarray(start, end);
        frame.push(chunk);
        child.stdout.emit('data', chunk);
        start = end;
      }
      const snapshot = frame.snapshot();
      expect(snapshot.status).toBe(expected);
      expect(snapshot.matchedBytes).toBeLessThanOrEqual(6);
      expect(Object.keys(snapshot).sort()).toEqual(['matchedBytes', 'status']);
      expect(initial).toEqual({matchedBytes: 0, status: 'pending'});
      const original = new Error('controlled protocol error');
      if (expected === 'pending') {
        if (input.ending === 'interrupt') yield* Fiber.interrupt(waiting);
        else if (input.ending === 'error') child.emit('error', original);
        else child.emit('close', 0, null);
      }
      const result = yield* Fiber.await(waiting);
      expect(Exit.isSuccess(result)).toBe(expected === 'ready');
      if (expected === 'pending' && input.ending === 'error') expect(result).toEqual(Exit.fail(original));
      if (expected === 'pending' && input.ending === 'interrupt')
        expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
      expectNoProtocolListeners(child);
      expect(Buffer.from(input.bytes)).toEqual(before);
      expect(input.cuts).toEqual(cutsBefore);
      expect(JSON.stringify(snapshot)).not.toContain('/private');
    }),
  {fastCheck: {numRuns: 20}},
);
