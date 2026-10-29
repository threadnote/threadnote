import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {observeCodeGraphAdmissionEnvironment} from '@threadnote/graph/admission_freshness';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphBuildRequestKey} from '@threadnote/graph/indexer/build';
import {inventoryRepository, worktreeBuildRequestState} from '@threadnote/graph/inventory';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {
  adoptCodeGraphBackgroundDemand,
  beginCodeGraphBackgroundPublication,
  CodeGraphRefreshDemandSuperseded,
  completeCodeGraphBackgroundDemand,
  recoverCodeGraphBackgroundDemand,
  registerCodeGraphBackgroundDemand,
  resumeCodeGraphBackgroundDemand,
} from '@threadnote/graph/refresh/demand';
import {
  codeGraphRefreshDemandLockPath,
  codeGraphRefreshDemandPath,
  codeGraphWorktreeSpawnLockPath,
} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {runIsolatedCodeGraphIndexSnapshot} from '@threadnote/graph/isolated/index';
import {runIsolatedCodeGraphIndex} from '@threadnote/graph/isolated/builder';
import {resolveCodeGraphRefreshRoute} from '@threadnote/graph/scope/routing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
const worktreeId = Effect2.pipe('b', EffectString.repeat(64));
const firstKey = Effect2.pipe('1', EffectString.repeat(64));
const secondKey = Effect2.pipe('2', EffectString.repeat(64));
const scopeA = `code-graph-scope:${Effect2.pipe('c', EffectString.repeat(64))}`;
const scopeB = `code-graph-scope:${Effect2.pipe('d', EffectString.repeat(64))}`;
const TestLayer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

const refreshDemandActiveStateSchema = Schema.StructWithRest(
  Schema.Struct({active: Schema.Record(Schema.String, Schema.Unknown)}),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const refreshDemandObservedStateSchema = Schema.StructWithRest(
  Schema.Struct({
    active: Schema.optional(Schema.Unknown),
    desired: Schema.optional(
      Schema.StructWithRest(Schema.Struct({targetKey: Schema.String}), [Schema.Record(Schema.String, Schema.Unknown)]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

describe('code graph refresh demand sidecar', () => {
  fcEffectProp(
    effectIt,
    'keeps distinct scope paths deterministic and every recovery component within NAME_MAX',
    [fc.uniqueArray(fc.integer({min: 0, max: 1000}), {minLength: 2, maxLength: 8})] as const,
    ([values]) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const paths = EffectArray.flatMap(values, value => {
          const scope = `code-graph-scope:${Effect2.pipe(value.toString(16), EffectString.padStart(64, '0'))}`;
          const data = codeGraphRefreshDemandPath(path, '/private/home', checkoutId, worktreeId, scope);
          const lock = codeGraphRefreshDemandLockPath(path, '/private/home', checkoutId, worktreeId, scope);
          const spawn = codeGraphWorktreeSpawnLockPath(path, '/private/home', checkoutId, worktreeId, scope);
          expect(data).toBe(codeGraphRefreshDemandPath(path, '/private/home', checkoutId, worktreeId, scope));
          for (const component of [
            data,
            `${lock}.recovery-${Effect2.pipe('f', EffectString.repeat(64))}`,
            `${spawn}.recovery-${Effect2.pipe('f', EffectString.repeat(64))}`,
          ])
            expect(new TextEncoder().encode(path.basename(component)).length).toBeLessThanOrEqual(255);
          return [data, lock, spawn];
        });
        expect(new Set(paths).size).toBe(paths.length);
      }).pipe(provideTestLayer(TestLayer)),
    {fastCheck: {numRuns: 25}},
  );

  effectIt.effect(
    'isolates coalescing sidecars by exact configured view while preserving the legacy full filename',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-scopes-'});
          const full = {checkoutId, threadnoteHome: home, worktreeId};
          const first = {...full, scopeId: scopeA};
          const second = {...full, scopeId: scopeB};

          expect((yield* registerCodeGraphBackgroundDemand(first, firstKey)).type).toBe('claimed');
          expect((yield* registerCodeGraphBackgroundDemand(second, secondKey)).type).toBe('claimed');

          const fullPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
          const firstPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId, scopeA);
          const secondPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId, scopeB);
          expect(fullPath).toContain(`-${worktreeId}.json`);
          expect(firstPath).not.toBe(secondPath);
          expect(firstPath).not.toBe(fullPath);
          expect(Effect2.pipe(firstPath, EffectString.split('/')).at(-1)?.length).toBeLessThan(200);
          expect(Effect2.pipe(secondPath, EffectString.split('/')).at(-1)?.length).toBeLessThan(200);
          const lock = codeGraphRefreshDemandLockPath(path, home, checkoutId, worktreeId, scopeA);
          const spawn = codeGraphWorktreeSpawnLockPath(path, home, checkoutId, worktreeId, scopeA);
          expect(path.dirname(lock)).toBe(path.dirname(firstPath));
          expect(firstPath).toMatch(/\.json$/u);
          expect(lock).toMatch(/\.lock$/u);
          expect(new Set([firstPath, lock, spawn]).size).toBe(3);
          for (const file of [
            firstPath,
            `${lock}.recovery-${Effect2.pipe('f', EffectString.repeat(64))}`,
            `${spawn}.recovery-${Effect2.pipe('f', EffectString.repeat(64))}`,
          ]) {
            expect(new TextEncoder().encode(path.basename(file)).length).toBeLessThanOrEqual(255);
          }
          expect(yield* fs.exists(firstPath)).toBe(true);
          expect(yield* fs.exists(secondPath)).toBe(true);
          expect(yield* fs.exists(fullPath)).toBe(false);
        }),
      ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('attaches equivalent host routes to one scoped claim while a sibling scope remains independent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-equivalent-routes-'});
        const rootExplicit = {checkoutId, scopeId: scopeA, threadnoteHome: home, worktreeId};
        const nestedInferred = {...rootExplicit};
        const sibling = {...rootExplicit, scopeId: scopeB};

        const claimed = yield* registerCodeGraphBackgroundDemand(rootExplicit, firstKey);
        const attached = yield* registerCodeGraphBackgroundDemand(nestedInferred, firstKey);
        const siblingClaimed = yield* registerCodeGraphBackgroundDemand(sibling, firstKey);

        expect(claimed.type).toBe('claimed');
        expect(attached).toMatchObject({
          type: 'attached',
          target: {targetKey: firstKey, targetToken: claimed.target.targetToken},
        });
        expect(siblingClaimed.type).toBe('claimed');
        expect(siblingClaimed.target.targetToken).not.toBe(claimed.target.targetToken);
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('persists full and scoped demand below an owner-controlled legacy home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-legacy-home-'});
        yield* fs.chmod(home, 0o755);
        const full = {checkoutId, threadnoteHome: home, worktreeId};
        const scoped = {...full, scopeId: scopeA};

        expect((yield* registerCodeGraphBackgroundDemand(full, firstKey)).type).toBe('claimed');
        expect((yield* registerCodeGraphBackgroundDemand(scoped, secondKey)).type).toBe('claimed');

        const fullPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        const scopedPath = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId, scopeA);
        expect((yield* fs.stat(home)).mode & 0o777).toBe(0o755);
        expect((yield* fs.stat(path.dirname(path.dirname(scopedPath)))).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(path.dirname(scopedPath))).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(fullPath)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(scopedPath)).mode & 0o777).toBe(0o600);
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('rejects a refresh-demand home writable by another principal', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-shared-home-'});
        yield* fs.chmod(home, 0o775);

        const failure = yield* Effect.flip(
          registerCodeGraphBackgroundDemand({checkoutId, threadnoteHome: home, worktreeId}, firstKey),
        );
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  fcEffectProp(
    effectIt,
    'accepts exactly the group/other permission modes that cannot mutate the home',
    [fc.integer({max: 0o77, min: 0})] as const,
    ([sharedBits]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          if (system.platform === 'win32') return;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-mode-'});
          yield* fs.chmod(home, 0o700 | sharedBits);
          const registration = registerCodeGraphBackgroundDemand(
            {checkoutId, threadnoteHome: home, worktreeId},
            firstKey,
          );

          if ((sharedBits & 0o022) === 0) {
            expect((yield* registration).type).toBe('claimed');
          } else {
            const failure = yield* Effect.flip(registration);
            expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
          }
        }),
      ).pipe(provideTestLayer(TestLayer)),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect('rejects a refresh-demand home not owned by the current user', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        if (system.platform === 'win32' || system.userId === undefined) return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-foreign-home-'});

        const failure = yield* Effect.flip(
          registerCodeGraphBackgroundDemand({checkoutId, threadnoteHome: home, worktreeId}, firstKey).pipe(
            Effect.provideService(SystemInfo, {...system, userId: system.userId + 1}),
          ),
        );
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('recovers a stranded scoped demand lock and its recovery guard', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-recovery-'});
      const identity = {checkoutId, scopeId: scopeA, threadnoteHome: home, worktreeId};
      const lock = codeGraphRefreshDemandLockPath(path, home, checkoutId, worktreeId, scopeA);
      yield* fs.makeDirectory(path.dirname(lock), {recursive: true, mode: 0o700});
      const owner = JSON.stringify({
        processId: 2_000_000_000,
        processStartIdentity: 'dead',
        token: 'stranded',
        version: 1,
      });
      yield* fs.writeFileString(lock, owner, {mode: 0o600});
      yield* fs.writeFileString(`${lock}.recovery`, owner, {mode: 0o600});
      expect((yield* registerCodeGraphBackgroundDemand(identity, firstKey)).type).toBe('claimed');
      expect(yield* fs.exists(lock)).toBe(false);
      expect(yield* fs.exists(`${lock}.recovery`)).toBe(false);
      expect(yield* fs.readDirectory(path.dirname(lock))).toHaveLength(1);
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('keeps a live pre-status claimant and recovers it after the exact process dies', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-live-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');

        const retained = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(retained.active?.targetToken).toBe(claimed.target.targetToken);

        const sidecar = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        const persisted = yield* Schema.decodeUnknownEffect(refreshDemandActiveStateSchema)(
          JSON.parse(yield* fs.readFileString(sidecar)),
        );
        const persistedWithDeadClaim = {
          ...persisted,
          active: {
            ...persisted.active,
            claimOwner: {processId: 2_000_000_000, processStartIdentity: 'dead-process'},
          },
        };
        yield* fs.writeFileString(sidecar, `${JSON.stringify(persistedWithDeadClaim)}\n`, {flag: 'w', mode: 0o600});

        const recovered = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(recovered.active).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('never admits a target when resume acquires an idle sidecar lane', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-resume-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');
        yield* completeCodeGraphBackgroundDemand(identity, claimed.target.targetToken, firstKey);

        const absent = yield* resumeCodeGraphBackgroundDemand(identity, secondKey, {liveness: 'inactive'});
        expect(absent).toBeUndefined();
        const retained = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(retained.active).toBeUndefined();
        expect(retained.desired).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('queues the latest observed target while a live admitted lane is active', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-converge-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');

        const queued = yield* resumeCodeGraphBackgroundDemand(identity, secondKey, {
          liveness: 'active',
          owner: claimed.state.active?.claimOwner,
          requestKey: firstKey,
        });
        expect(queued).toMatchObject({
          type: 'queued',
          state: {active: {targetKey: firstKey}, desired: {targetKey: secondKey}},
        });
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('does not displace a live publisher when status evidence is stale', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-publishing-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claimed = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(claimed.type).toBe('claimed');
        expect(yield* beginCodeGraphBackgroundPublication(identity, claimed.target.targetToken, firstKey)).toBe(
          'publish',
        );

        const resumed = yield* resumeCodeGraphBackgroundDemand(identity, firstKey, {liveness: 'inactive'});
        expect(resumed).toMatchObject({
          type: 'attached',
          target: {phase: 'publishing', targetToken: claimed.target.targetToken},
        });
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('bounds live-process authority to the pre-status startup grace', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-owner-grace-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        yield* TestClock.adjust(30_001);

        const recovered = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(recovered.active).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('preserves an adopted child during the bounded pre-status window', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-adopted-grace-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const claim = yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        expect(yield* adoptCodeGraphBackgroundDemand(identity, claim.target.targetToken, firstKey)).toBe(true);

        const retained = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(retained.active).toMatchObject({
          phase: 'preparing',
          targetToken: claim.target.targetToken,
        });
        yield* TestClock.adjust(30_001);
        const expired = yield* recoverCodeGraphBackgroundDemand(identity, {liveness: 'inactive'});
        expect(expired.active).toBeUndefined();
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('refuses a linked sidecar without reading or writing its outside target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-link-'});
        const outside = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-outside-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const sidecar = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        const outsideTarget = path.join(outside, 'target.json');
        yield* fs.writeFileString(outsideTarget, 'outside-marker\n', {mode: 0o600});
        yield* fs.symlink(outsideTarget, sidecar);

        const failure = yield* Effect.flip(registerCodeGraphBackgroundDemand(identity, firstKey));
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
        expect(yield* fs.readFileString(outsideTarget)).toBe('outside-marker\n');
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('refuses a linked lock file before reading or writing its outside target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-lock-link-'});
        const outside = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-lock-outside-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        const lockPath = codeGraphRefreshDemandLockPath(path, home, checkoutId, worktreeId);
        const outsideTarget = path.join(outside, 'lock');
        yield* fs.writeFileString(outsideTarget, 'outside-lock-marker\n', {mode: 0o600});
        yield* fs.symlink(outsideTarget, lockPath);

        const failure = yield* Effect.flip(registerCodeGraphBackgroundDemand(identity, firstKey));
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);
        expect(yield* fs.readFileString(outsideTarget)).toBe('outside-lock-marker\n');
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('reconstructs an oversized sidecar through the bounded stable-file reader', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-bounded-'});
        const identity = {checkoutId, threadnoteHome: home, worktreeId};
        yield* registerCodeGraphBackgroundDemand(identity, firstKey);
        const sidecar = codeGraphRefreshDemandPath(path, home, checkoutId, worktreeId);
        yield* fs.writeFileString(sidecar, Effect2.pipe('x', EffectString.repeat(8 * 1024 + 1)), {
          flag: 'w',
          mode: 0o600,
        });

        const reconstructed = yield* registerCodeGraphBackgroundDemand(identity, secondKey);
        expect(reconstructed.type).toBe('claimed');
        expect(reconstructed.state.active?.targetKey).toBe(secondKey);
        expect(Number((yield* fs.stat(sidecar)).size)).toBeLessThan(8 * 1024);
      }),
    ).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect(
    'adopts the parent scoped demand through the actual isolated CLI route',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-cli-route-'});
        const repository = path.join(home, 'repository');
        const nested = path.join(repository, 'apps', 'docs');
        yield* fs.makeDirectory(nested, {recursive: true});
        yield* fs.makeDirectory(path.join(repository, 'apps', 'web'), {recursive: true});
        yield* fs.writeFileString(
          path.join(repository, 'package.json'),
          JSON.stringify({name: 'fixture', workspaces: ['apps/*']}),
        );
        for (const name of ['docs', 'web']) {
          yield* fs.writeFileString(path.join(repository, 'apps', name, 'package.json'), JSON.stringify({name}));
          yield* fs.writeFileString(path.join(repository, 'apps', name, 'source.ts'), `export const ${name} = 1;\n`);
        }
        yield* Effect.sync(() => {
          runGit(repository, ['init', '--quiet']);
          runGit(repository, ['config', 'user.email', 'test@example.invalid']);
          runGit(repository, ['config', 'user.name', 'Threadnote Test']);
          runGit(repository, ['add', '.']);
          runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
        });
        const manifestPath = path.join(home, 'manifest.json');
        const projects = EffectArray.map(['docs', 'web'], name => ({
          name,
          path: repository,
          seed: [],
          uri: `threadnote://resources/repos/${name}`,
          graph: {closure: 'dependencies', roots: [`apps/${name}`]},
        }));
        yield* fs.writeFileString(manifestPath, JSON.stringify({version: 1, projects}));
        const route = yield* resolveCodeGraphRefreshRoute(manifestPath, nested);
        expect(route.route.state).toBe('selected');
        if (route.route.state !== 'selected') return yield* Effect.die('expected scoped route');
        const identity = yield* resolveRepositoryIdentity(nested);
        const observed = yield* inventoryRepository(identity, {
          project: route.route.project,
          includeOverlay: false,
          scopeObservationOnly: true,
          languagePacks: BUILTIN_LANGUAGE_PACK_REGISTRY,
        });
        const overlay = yield* worktreeBuildRequestState(identity, home, observed.scope);
        const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
        const targetKey = codeGraphBuildRequestKey(
          identity,
          overlay,
          BUILTIN_LANGUAGE_PACK_REGISTRY,
          undefined,
          false,
          environment,
          observed.scope,
        );
        const demandIdentity = {
          checkoutId: identity.checkoutId,
          worktreeId: identity.worktreeId,
          scopeId: observed.scope?.scopeKey,
          threadnoteHome: home,
        };
        const claim = yield* registerCodeGraphBackgroundDemand(demandIdentity, targetKey);
        expect(claim.type).toBe('claimed');
        const launch = {
          admissionClass: 'background' as const,
          assertRuntimeSchemaCompatible: () => Effect.void,
          cwd: nested,
          manifestPath,
          manifestRevision: route.manifestRevision,
          scopeRoute: route.route.state,
          project: route.route.project,
          scopeId: observed.scope?.scopeKey,
          refreshDemandToken: claim.target.targetToken,
          requestKey: targetKey,
          threadnoteHome: home,
        };
        const result = yield* runIsolatedCodeGraphIndex(launch);
        expect(result.symbols).toBeGreaterThan(0);
        expect(result.requestKey).toBe(targetKey);
        const state = JSON.parse(
          yield* fs.readFileString(
            codeGraphRefreshDemandPath(path, home, identity.checkoutId, identity.worktreeId, observed.scope?.scopeKey),
          ),
        );
        expect(state.active).toMatchObject({targetKey, targetToken: claim.target.targetToken, phase: 'publishing'});
        expect(yield* fs.exists(codeGraphRefreshDemandPath(path, home, identity.checkoutId, identity.worktreeId))).toBe(
          false,
        );
        const store = yield* CodeGraphStore;
        let scopeDatabaseReads = 0;
        const instrumented = CodeGraphStore.of({
          ...store,
          loadScopeApplicability: (...args) => {
            scopeDatabaseReads++;
            return store.loadScopeApplicability(...args);
          },
          readySnapshot: (...args) => {
            scopeDatabaseReads++;
            return store.readySnapshot(...args);
          },
        });
        const indexerContext = yield* Layer.build(
          Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, instrumented))),
        );
        const indexer = Context.get(indexerContext, CodeGraphIndexer);
        const rejected = yield* indexer
          .index({
            cwd: nested,
            project: route.route.project,
            ensureVectors: false,
            refreshDemandToken: `cgdq_${Effect2.pipe('f', EffectString.repeat(32))}`,
            threadnoteHome: home,
          })
          .pipe(Effect.flip);
        expect(Schema.is(CodeGraphRefreshDemandSuperseded)(rejected)).toBe(true);
        expect(scopeDatabaseReads).toBe(0);
        const recovered = yield* runIsolatedCodeGraphIndexSnapshot({
          cwd: nested,
          manifestPath,
          threadnoteHome: home,
          ensureVectors: false,
        });
        expect(recovered.snapshot.id).toBe(result.snapshotId);
        expect(recovered.snapshot.scopeId).toBe(observed.scope?.scopeKey);

        const manifestBytes = yield* fs.readFileString(manifestPath);
        yield* fs.writeFileString(manifestPath, `${manifestBytes}\n`);
        const drifted = yield* runIsolatedCodeGraphIndex({...launch, requestKey: secondKey}).pipe(Effect.flip);
        expect(drifted).toMatchObject({_tag: 'CodeGraphScopeRoutingError'});
        yield* fs.writeFileString(manifestPath, manifestBytes);

        const ambiguous = yield* resolveCodeGraphRefreshRoute(manifestPath, repository).pipe(Effect.flip);
        expect(ambiguous).toMatchObject({_tag: 'CodeGraphScopeRoutingError'});
        const linked = path.join(home, 'linked');
        yield* Effect.sync(() => runGit(repository, ['worktree', 'add', '--quiet', '-b', 'linked', linked]));
        const linkedRoute = yield* resolveCodeGraphRefreshRoute(manifestPath, path.join(linked, 'apps', 'docs'));
        expect(linkedRoute.route).toEqual(route.route);
        const linkedIdentity = yield* resolveRepositoryIdentity(linked);
        expect(linkedIdentity.checkoutId).toBe(identity.checkoutId);
        expect(linkedIdentity.worktreeId).not.toBe(identity.worktreeId);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {timeout: 30_000},
  );

  effectIt.effect('stops a real indexer at the publication checkpoint after a newer target is queued', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-refresh-demand-indexer-'});
          const repository = path.join(home, 'repository');
          yield* fs.makeDirectory(repository);
          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const value = 1;\n');
          yield* Effect.sync(() => {
            runGit(repository, ['init', '--quiet']);
            runGit(repository, ['config', 'user.email', 'test@example.invalid']);
            runGit(repository, ['config', 'user.name', 'Threadnote Test']);
            runGit(repository, ['add', 'source.ts']);
            runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
          });

          const identity = yield* resolveRepositoryIdentity(repository);
          const overlay = yield* worktreeBuildRequestState(identity, home);
          const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
          const targetKey = codeGraphBuildRequestKey(
            identity,
            overlay,
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            undefined,
            false,
            environment,
          );
          const demandIdentity = {
            checkoutId: identity.checkoutId,
            threadnoteHome: home,
            worktreeId: identity.worktreeId,
          };
          const claim = yield* registerCodeGraphBackgroundDemand(demandIdentity, targetKey);
          expect(claim.type).toBe('claimed');
          yield* registerCodeGraphBackgroundDemand(demandIdentity, secondKey);

          const indexer = yield* CodeGraphIndexer;
          const failure = yield* Effect.flip(
            indexer.index({
              admissionClass: 'background',
              cwd: repository,
              ensureVectors: false,
              refreshDemandToken: claim.target.targetToken,
              threadnoteHome: home,
            }),
          );
          expect(Schema.is(CodeGraphRefreshDemandSuperseded)(failure)).toBe(true);

          const sidecar = codeGraphRefreshDemandPath(path, home, identity.checkoutId, identity.worktreeId);
          const state = yield* Schema.decodeUnknownEffect(refreshDemandObservedStateSchema)(
            JSON.parse(yield* fs.readFileString(sidecar)),
          );
          expect(state.active).toBeUndefined();
          expect(state.desired?.targetKey).toBe(secondKey);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({cmd: ['git', '-C', cwd, ...args], stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) throw TestError.make({message: result.stderr.toString()});
}
