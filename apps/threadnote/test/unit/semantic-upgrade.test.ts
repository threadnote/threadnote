import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {canonicalFileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {makeSemanticAdmission, SemanticCompatibilityFault} from '../../src/semantic/coordinator.js';
import {
  inspectSemanticHostProfile,
  readSemanticHostProfile,
  semanticHostProfileName,
  writeSemanticHostProfile,
} from '../../src/semantic/host_profile.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, cryptoLayer, TestSystemInfoLayer);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'semantic-upgrade-'}));
  return {fs, path, directory};
});

describe.skipIf(process.platform === 'win32')('semantic mutable state compatibility', () => {
  effectIt.effect.prop(
    'unsupported versions and unknown fields refuse every ledger mutation without changing original bytes',
    [
      Schema.Boolean,
      Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 20})),
      Schema.String.check(Schema.isMaxLength(32)),
    ],
    ([futureVersion, version, payload]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const admission = yield* makeSemanticAdmission({directory: f.directory});
          const reservation = yield* admission.acquire(sha256HexSync('workspace'), 2000);
          const file = f.path.join(f.directory, 'admission-v1.json');
          const ledger = JSON.parse(yield* f.fs.readFileString(file));
          if (futureVersion) ledger.version = version;
          else if (version % 3 === 0) ledger.slots[0].owner.future = payload;
          else if (version % 3 === 1) ledger.slots[0].future = payload;
          else ledger.future = payload;
          const original = JSON.stringify(ledger, null, 1) + '\n';
          yield* f.fs.writeFileString(file, original, {mode: 0o600});
          for (const operation of [
            admission.status.pipe(Effect.asVoid),
            admission.acquire(sha256HexSync('other'), 100).pipe(Effect.asVoid),
            reservation.release(true),
          ]) {
            const rejected = yield* operation.pipe(Effect.result);
            expect(rejected._tag).toBe('Failure');
            if (rejected._tag === 'Failure') expect(Schema.is(SemanticCompatibilityFault)(rejected.failure)).toBe(true);
            expect(yield* f.fs.readFileString(file)).toBe(original);
          }
        }),
      ).pipe(provideTestLayer(layer), TestClock.withLive),
    {arbitrary: {runs: 20}},
  );

  effectIt.effect.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'profile changes are explicit and resumable while future config, memories and recovery records remain unchanged',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const home = f.path.join(f.directory, 'home');
        const root = f.path.join(f.directory, 'project');
        yield* f.fs.makeDirectory(home, {mode: 0o700});
        yield* f.fs.makeDirectory(root);
        const worktree = canonicalFileUri((yield* f.path.toFileUrl(root)).href);
        const config: RuntimeConfig = {
          account: 'local',
          user: 'test',
          agentId: 'test',
          agentContextHome: home,
          manifestPath: f.path.join(home, 'manifest.json'),
        };
        const profile = {version: 1, enabled: true, worktree, catalog: {}};
        const first = yield* writeSemanticHostProfile(config, worktree, profile);
        expect(yield* writeSemanticHostProfile(config, worktree, profile)).toMatchObject({
          changed: false,
          digest: first.digest,
        });
        const knowledge = f.path.join(home, 'memory.md');
        const recovery = f.path.join(home, 'semantic', 'recovery-sentinel.json');
        yield* f.fs.writeFileString(knowledge, 'existing citation and memory');
        yield* f.fs.writeFileString(recovery, '{"state":"unknown","laterEdit":"retain"}');
        const pending = f.path.join(home, 'semantic', 'profiles', '.setup-interrupted');
        yield* f.fs.makeDirectory(pending, {mode: 0o700});
        yield* f.fs.writeFileString(f.path.join(pending, 'profile.json'), 'incomplete');
        const disabled = yield* writeSemanticHostProfile(config, worktree, {...profile, enabled: false}, first.digest);
        expect(disabled.changed).toBe(true);
        expect((yield* readSemanticHostProfile(config, worktree).pipe(Effect.result))._tag).toBe('Failure');
        expect((yield* inspectSemanticHostProfile(config, worktree)).profile.enabled).toBe(false);
        expect(yield* f.fs.readFileString(knowledge)).toBe('existing citation and memory');
        expect(yield* f.fs.readFileString(recovery)).toBe('{"state":"unknown","laterEdit":"retain"}');
        const file = f.path.join(home, 'semantic', 'profiles', semanticHostProfileName(config, worktree));
        const future = JSON.stringify({...profile, version: 9, future: 'preserve'});
        yield* f.fs.writeFileString(file, future, {mode: 0o600});
        expect(
          (yield* writeSemanticHostProfile(config, worktree, profile, sha256HexSync(future)).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* f.fs.readFileString(file)).toBe(future);
      }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});
