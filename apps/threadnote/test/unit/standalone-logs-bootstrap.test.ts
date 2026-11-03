import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {execFile} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {THREADNOTE_STORAGE_LAYOUT_VERSION} from '@threadnote/store/layout';
import {systemLayer} from '../../src/effect/runtime-bootstrap.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const execute = promisify(execFile);
const checkout = resolve(import.meta.dirname, '../../../..');
const standalone = resolve(checkout, 'apps/threadnote/src/standalone.ts');
const platform = Layer.mergeAll(BunServices.layer, systemLayer);
const emptyAdmission = JSON.stringify({version: 1, foreground: [], pending: [], quietUntil: 0});

const fixture = (control: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-logs-bootstrap-'});
    const user = path.join(root, 'user');
    const home = path.join(root, 'data');
    const directory = path.join(home, 'locks', 'inference-idle-v1');
    const state = path.join(directory, 'state.json');
    const guard = path.join(directory, 'guard.lock');
    yield* fs.makeDirectory(user);
    yield* fs.makeDirectory(directory, {recursive: true});
    yield* fs.makeDirectory(path.join(home, 'logs'));
    yield* fs.writeFileString(
      path.join(home, 'layout.json'),
      JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION}),
    );
    yield* fs.writeFileString(state, control);
    yield* fs.writeFileString(path.join(directory, 'initialized'), '1\n');
    const log = path.join(home, 'logs', 'threadnote.log');
    yield* fs.writeFileString(log, '', {mode: 0o600});
    const before = (yield* fs.readDirectory(home)).sort();
    const environment = {
      PATH: system.environment().PATH ?? '',
      HOME: user,
      USERPROFILE: user,
      XDG_CONFIG_HOME: path.join(user, '.config'),
      THREADNOTE_HOME: home,
      THREADNOTE_INSTALL_ROOT: path.join(root, 'installation'),
      THREADNOTE_AUTO_MODEL_SETUP: 'off',
      CI: '1',
      NO_COLOR: '1',
    };
    const run = (args: readonly string[]) =>
      fromPromiseInterruptibleAwaiting(
        () =>
          execute(process.execPath, [standalone, '--home', home, ...args], {
            cwd: checkout,
            env: environment,
            timeout: 15_000,
            maxBuffer: 64 * 1024,
          }).then(
            output => ({code: 0, stdout: output.stdout, stderr: output.stderr}),
            (cause: unknown) => {
              if (
                typeof cause !== 'object' ||
                cause === null ||
                !('code' in cause) ||
                typeof cause.code !== 'number' ||
                !('stdout' in cause) ||
                typeof cause.stdout !== 'string' ||
                !('stderr' in cause) ||
                typeof cause.stderr !== 'string'
              ) {
                throw cause;
              }
              return {code: cause.code, stdout: cause.stdout, stderr: cause.stderr};
            },
          ),
        cause => TestError.make({cause, message: 'Could not run the isolated logs bootstrap CLI.'}),
      );
    const assertLogs = Effect.gen(function* () {
      const result = yield* run(['logs']);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Threadnote logs: ${path.join(home, 'logs')}`);
      expect(result.stdout).toContain(`- ${log} (`);
      expect(result.stdout).toContain('Retention: 1048576 bytes per file, 5 rotated files.');
      expect(result.stdout).toContain('Review files before sharing.');
      expect(yield* fs.readFileString(state)).toBe(control);
      // Static support startup creates neither runtime registrations nor worker/cache directories.
      expect((yield* fs.readDirectory(home)).sort()).toEqual(before);
      const entries = pipe(
        yield* fs.readFileString(log),
        EffectString.trim,
        EffectString.split('\n'),
        EffectArray.map(line => JSON.parse(line)),
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({operation: 'logs', event: 'invocation.started'});
      expect(entries[1]).toMatchObject({operation: 'logs', event: 'invocation.finished', outcome: 'success'});
      expect(entries[1].invocationId).toBe(entries[0].invocationId);
    });
    return {fs, state, guard, assertLogs, run};
  });

describe('standalone logs support bootstrap', () => {
  effectIt.effect('does not depend on malformed inference admission metadata', () =>
    Effect.gen(function* () {
      const f = yield* fixture('{invalid-state\n');
      yield* f.assertLogs;
      // A different command still takes ordinary foreground admission and refuses this control state.
      const control = yield* f.run(['version']);
      expect(control.code).toBe(1);
      expect(control.stdout).toBe('');
      expect(yield* f.fs.readFileString(f.state)).toBe('{invalid-state\n');
    }).pipe(provideTestLayer(platform), TestClock.withLive),
  );

  effectIt.effect('leaves a live held inference guard and its state untouched', () =>
    Effect.gen(function* () {
      const f = yield* fixture(emptyAdmission);
      yield* withExclusiveFileLock(
        f.fs,
        f.guard,
        {retryIntervalMilliseconds: 10, staleAfterMilliseconds: 5_000, waitTimeoutMilliseconds: 1_000},
        Effect.gen(function* () {
          const owner = yield* f.fs.readFileString(f.guard);
          yield* f.assertLogs;
          expect(yield* f.fs.readFileString(f.guard)).toBe(owner);
        }),
      );
      expect(yield* f.fs.exists(f.guard)).toBe(false);
    }).pipe(provideTestLayer(platform), TestClock.withLive),
  );

  effectIt.effect('retains normal command validation on the support route', () =>
    Effect.gen(function* () {
      const f = yield* fixture('{invalid-state\n');
      const result = yield* f.run(['logs', '--unexpected-option']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unexpected-option');
      expect(yield* f.fs.readFileString(f.state)).toBe('{invalid-state\n');
    }).pipe(provideTestLayer(platform), TestClock.withLive),
  );

  fcEffectProp(
    effectIt,
    'preserves arbitrary small inference-control payloads while listing support logs',
    {control: fc.string({maxLength: 96})},
    ({control}) =>
      Effect.gen(function* () {
        const f = yield* fixture(control);
        yield* f.assertLogs;
      }).pipe(provideTestLayer(platform), TestClock.withLive),
    {fastCheck: {numRuns: 8}, timeout: 30_000},
  );
});
