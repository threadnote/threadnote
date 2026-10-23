import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {spawn, type ChildProcessWithoutNullStreams} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
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

const harness = 'apps/threadnote/test/dev-skills/release-artifact.py';
const holderProgram = `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('release_fence_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with module.hold_account_mutation_lock(Path(sys.argv[2])):
    print('ready',flush=True)
    if sys.stdin.readline() != 'release\\n': raise RuntimeError('Invalid fixture release token')
`;

const waitReady = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<void, Error>(resume => {
    let output = '';
    let errors = '';
    const ready = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-1024);
      if (output.includes('ready\n')) resume(Effect.void);
    };
    const failed = () => resume(Effect.fail(TestError.make({message: `Fence child exited before ready: ${errors}`})));
    const error = (cause: Error) => resume(Effect.fail(cause));
    const stderr = (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-1024);
    };
    child.stdout.on('data', ready);
    child.stderr.on('data', stderr);
    child.once('close', failed);
    child.once('error', error);
    return Effect.sync(() => {
      child.stdout.off('data', ready);
      child.stderr.off('data', stderr);
      child.off('close', failed);
      child.off('error', error);
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
const withPythonFence = <A, E, R>(root: string, program: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const environment = system.environment();
      const python = environment.THREADNOTE_TEST_PYTHON ?? (system.platform === 'win32' ? 'python' : 'python3');
      const child = spawn(python, ['-B', '-c', holderProgram, resolve(harness), root], {
        env: {
          ...environment,
          HOME: resolve(root, 'user'),
          USERPROFILE: resolve(root, 'user'),
          THREADNOTE_HOME: resolve(root, 'data'),
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: '',
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
    const reader = yield* withPythonFence(
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

effectIt.effect('interrupting the observation releases the Python fixture token and admits the settled reader', () =>
  Effect.gen(function* () {
    const f = yield* makeFixture;
    const entered = yield* Deferred.make<void>();
    const observer = yield* withPythonFence(
      f.root,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
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
      const result = yield* withPythonFence(
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
