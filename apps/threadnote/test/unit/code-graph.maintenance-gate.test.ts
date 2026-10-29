import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {expect} from 'vitest';
import {
  awaitCodeGraphWorktreeBuilds,
  codeGraphWorktreeBuildActive,
  withCodeGraphMaintenanceIntent,
  withCodeGraphTargetWorktreeLock,
} from '@threadnote/graph/maintenance/gate';
import {codeGraphLayout, codeGraphWorktreeLockPath} from '@threadnote/graph/layout';
import {compactCodeGraphStorage} from '@threadnote/graph/storage';
import {purgeCodeGraphSnapshot} from '@threadnote/graph/snapshot/purge';
import {CodeGraphStore} from '@threadnote/graph/store';

import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
const worktreeId = Effect2.pipe('b', EffectString.repeat(64));
const scopeId = `code-graph-scope:${Effect2.pipe('c', EffectString.repeat(64))}`;
const layer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

effectIt.effect('recognizes exact scoped builders for probes, drains, compaction, purge and target mutation', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scoped-maintenance-'});
    const layout = codeGraphLayout(path, home, checkoutId, worktreeId);
    yield* (yield* CodeGraphStore).initialize(layout.databasePath);
    const lock = codeGraphWorktreeLockPath(path, home, checkoutId, worktreeId, scopeId);
    yield* fs.makeDirectory(path.dirname(lock), {recursive: true});
    for (const name of [
      `${Effect2.pipe('d', EffectString.repeat(64))}.lock.recovery`,
      `${Effect2.pipe('d', EffectString.repeat(64))}.scope-bad.lock`,
      'unrelated.lock',
    ]) {
      yield* fs.writeFileString(path.join(path.dirname(lock), name), 'malformed');
    }
    expect(yield* codeGraphWorktreeBuildActive(home, checkoutId)).toBe(false);
    yield* withCodeGraphTargetWorktreeLock(
      home,
      checkoutId,
      worktreeId,
      Effect.gen(function* () {
        expect(yield* codeGraphWorktreeBuildActive(home, checkoutId)).toBe(true);
        expect((yield* awaitCodeGraphWorktreeBuilds(home, checkoutId, 0).pipe(Effect.exit))._tag).toBe('Failure');
        expect(yield* withCodeGraphTargetWorktreeLock(home, checkoutId, worktreeId, Effect.succeed('full'))).toBe(
          'full',
        );
        expect(
          (yield* withCodeGraphTargetWorktreeLock(home, checkoutId, worktreeId, Effect.void, scopeId).pipe(Effect.exit))
            ._tag,
        ).toBe('Failure');
        expect(yield* compactCodeGraphStorage(home, checkoutId, {dryRun: false, force: true})).toMatchObject({
          action: 'deferred',
          reason: 'active-build',
        });
        const purge = yield* purgeCodeGraphSnapshot(
          home,
          {checkoutId, snapshotId: `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}`},
          {apply: true, approvalDigest: `sha256:${Effect2.pipe('f', EffectString.repeat(64))}`},
        ).pipe(Effect.exit);
        expect(purge._tag).toBe('Failure');
      }),
      scopeId,
    );
    expect(yield* codeGraphWorktreeBuildActive(home, checkoutId)).toBe(false);
    yield* withCodeGraphMaintenanceIntent(home, awaitCodeGraphWorktreeBuilds(home, checkoutId, 0));
  }).pipe(provideTestLayer(layer)),
);
