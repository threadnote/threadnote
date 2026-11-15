import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {expect} from 'vitest';
import {
  writeSmokeFailureEvidence,
  SMOKE_EVIDENCE_FILENAME,
  SMOKE_EVIDENCE_MAX_BYTES,
} from '../../../../scripts/smoke-self-contained-evidence.js';
import {fixtureLifecycle} from '../../../../scripts/fixture-lifecycle.js';
import {provideScriptLayer} from '../../../../scripts/effect/errors.js';
import {ScriptSystemInfoLayer} from '../../../../scripts/effect/system-layer.js';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'smoke-evidence-'});
  const home = path.join(root, 'home');
  const directory = path.join(home, 'locks', 'recall');
  const outputDirectory = path.join(root, 'evidence');
  yield* fs.makeDirectory(directory, {recursive: true});
  return {fs, path, home, directory, outputDirectory};
});

effectIt.effect('writes a bounded allowlisted failure summary outside the fixture home', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const secret = 'private-path-token-memory-sentinel';
    yield* f.fs.writeFileString(
      f.path.join(f.directory, 'embedding-worker-v1.json.launch-v2.json'),
      JSON.stringify({
        protocol: 2,
        runtimeVersion: '5.3.7',
        secret,
        starting: {nonce: secret},
        fixture: {
          phase: 'closing',
          root: secret,
          launches: [
            {nonce: secret},
            {nonce: secret, owner: {processId: 123, token: secret, processStartIdentity: secret}},
          ],
        },
      }),
    );
    yield* f.fs.writeFileString(
      f.path.join(f.directory, 'embedding-worker-v1.json'),
      JSON.stringify({protocol: 2, version: secret, processId: 123, token: secret}),
    );
    const registrations = f.path.join(f.home, 'runtime', 'processes');
    yield* f.fs.makeDirectory(registrations, {recursive: true});
    for (const processId of [456, 457, 458, 459, 460])
      yield* f.fs.writeFileString(
        f.path.join(registrations, `${processId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          processId,
          parentProcessId: 77,
          role: 'cli',
          currentOperation: 'recall-embedding',
          processStartIdentity: secret,
          token: secret,
          displayContext: {launchDirectory: secret},
        }),
      );
    yield* f.fs.writeFileString(
      f.path.join(registrations, '461.json'),
      JSON.stringify({
        schemaVersion: 1,
        processId: 461,
        parentProcessId: 77,
        role: 'mcp',
        currentOperation: 'recall-embedding',
      }),
    );
    yield* f.fs.writeFileString(
      f.path.join(registrations, '462.json'),
      JSON.stringify({
        schemaVersion: 1,
        processId: 463,
        parentProcessId: 77,
        role: 'cli',
        currentOperation: 'recall-embedding',
      }),
    );
    const foreign = f.path.join(f.home, '..', 'other-home', 'runtime', 'processes');
    yield* f.fs.makeDirectory(foreign, {recursive: true});
    yield* f.fs.writeFileString(f.path.join(foreign, '999.json'), secret);
    const actual = yield* SystemInfo;
    const probed: number[] = [];
    const system = SystemInfo.of({
      ...actual,
      isProcessRunning: pid => {
        probed.push(pid);
        if (pid === 459) throw new Error(secret);
        return pid !== 457;
      },
      canonicalProcessStartIdentity: pid =>
        Effect.succeed(pid === 456 ? secret : pid === 460 ? 'different-birth' : undefined),
      processStartIdentity: () => succeedUndefined,
    });
    yield* writeSmokeFailureEvidence({
      ...f,
      progress: {stage: 'worker-drain', completed: false, elapsedMilliseconds: 600_000},
    }).pipe(Effect.provideService(SystemInfo, system));
    const text = yield* f.fs.readFileString(f.path.join(f.outputDirectory, SMOKE_EVIDENCE_FILENAME));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SMOKE_EVIDENCE_MAX_BYTES);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      stage: 'worker-drain',
      control: {
        fixturePhase: 'closing',
        launchCount: 2,
        ownerlessCount: 1,
        owners: [{registered: false}, {registered: true, processId: 123}],
      },
      receipt: {status: 'read', processId: 123},
      lock: {status: 'missing'},
      runtimeProcesses: {
        status: 'read',
        informationalOnly: true,
        truncated: false,
        registrations: [
          {
            processId: 456,
            parentProcessId: 77,
            role: 'cli',
            currentOperation: 'recall-embedding',
            live: true,
            birthMatch: true,
          },
          {processId: 457, live: false, birthMatch: 'unknown'},
          {processId: 458, live: true, birthMatch: 'unknown'},
          {processId: 459, live: 'unknown', birthMatch: 'unknown'},
          {processId: 460, live: true, birthMatch: false},
        ],
      },
    });
    expect(probed.sort()).toEqual([456, 457, 458, 459, 460]);
    expect(text).not.toContain(f.home);
    expect(yield* f.fs.exists(f.path.join(f.home, SMOKE_EVIDENCE_FILENAME))).toBe(false);
  }).pipe(provideFixtureLayer(BunServices.layer), TestClock.withLive),
);

effectIt.effect('refuses oversized and symlink evidence without copying bytes or following targets', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const target = f.path.join(f.directory, 'private-target');
    yield* f.fs.writeFileString(
      target,
      JSON.stringify({protocol: 2, version: '5.3.7', processId: 123, token: 'private-secret-sentinel'}),
    );
    yield* f.fs.symlink(target, f.path.join(f.directory, 'embedding-worker-v1.json'));
    yield* f.fs.writeFileString(
      f.path.join(f.directory, 'embedding-worker-v1.json.launch-v2.json'),
      EffectString.repeat(65_537)('x'),
    );
    const registrations = f.path.join(f.home, 'runtime', 'processes');
    yield* f.fs.makeDirectory(registrations, {recursive: true});
    yield* f.fs.symlink(target, f.path.join(registrations, '123.json'));
    yield* f.fs.writeFileString(f.path.join(registrations, '124.json'), EffectString.repeat(16_385)('x'));
    yield* f.fs.writeFileString(f.path.join(registrations, '125.json'), '{malformed');
    yield* writeSmokeFailureEvidence({...f, progress: {stage: 'setup', completed: false, elapsedMilliseconds: 1}});
    const text = yield* f.fs.readFileString(f.path.join(f.outputDirectory, SMOKE_EVIDENCE_FILENAME));
    expect(text).not.toContain('private-secret-sentinel');
    expect(JSON.parse(text)).toMatchObject({control: {status: 'unavailable'}, receipt: {status: 'unavailable'}});
    expect(JSON.parse(text).runtimeProcesses).toMatchObject({status: 'read', registrations: []});
    yield* f.fs.remove(registrations, {recursive: true});
    yield* f.fs.symlink(f.directory, registrations);
    yield* writeSmokeFailureEvidence({...f, progress: {stage: 'setup', completed: false, elapsedMilliseconds: 1}});
    const linked = JSON.parse(yield* f.fs.readFileString(f.path.join(f.outputDirectory, SMOKE_EVIDENCE_FILENAME)));
    expect(linked.runtimeProcesses).toEqual({status: 'unavailable', informationalOnly: true});
  }).pipe(provideFixtureLayer(BunServices.layer), TestClock.withLive),
);

effectIt.effect('diagnostic write failure preserves the original body and cleanup causes', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const blocked = f.path.join(f.outputDirectory, 'blocked');
    yield* f.fs.makeDirectory(f.outputDirectory, {recursive: true});
    yield* f.fs.writeFileString(blocked, 'not a directory');
    const result = yield* Effect.exit(
      fixtureLifecycle(Effect.die('body-defect'), Effect.fail('cleanup-failed')).pipe(
        Effect.onExit(exit =>
          Exit.isFailure(exit)
            ? writeSmokeFailureEvidence({
                ...f,
                outputDirectory: blocked,
                progress: {stage: 'worker-drain', completed: false, elapsedMilliseconds: 1},
              })
            : Effect.void,
        ),
      ),
    );
    const message = Exit.isFailure(result) ? Cause.pretty(result.cause) : '';
    expect(message).toContain('body-defect');
    expect(message).toContain('cleanup-failed');
    expect(message).not.toContain('NotADirectory');
  }).pipe(provideFixtureLayer(BunServices.layer), TestClock.withLive),
);

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    provideScriptLayer(program, Layer.merge(layer, ScriptSystemInfoLayer));
}
