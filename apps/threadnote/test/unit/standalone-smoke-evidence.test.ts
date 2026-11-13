import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {
  writeSmokeFailureEvidence,
  SMOKE_EVIDENCE_FILENAME,
  SMOKE_EVIDENCE_MAX_BYTES,
} from '../../../../scripts/smoke-self-contained-evidence.js';
import {fixtureLifecycle} from '../../../../scripts/fixture-lifecycle.js';

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
    yield* writeSmokeFailureEvidence({
      ...f,
      progress: {stage: 'worker-drain', completed: false, elapsedMilliseconds: 600_000},
    });
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
    });
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
    yield* writeSmokeFailureEvidence({...f, progress: {stage: 'setup', completed: false, elapsedMilliseconds: 1}});
    const text = yield* f.fs.readFileString(f.path.join(f.outputDirectory, SMOKE_EVIDENCE_FILENAME));
    expect(text).not.toContain('private-secret-sentinel');
    expect(JSON.parse(text)).toMatchObject({control: {status: 'unavailable'}, receipt: {status: 'unavailable'}});
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
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}
