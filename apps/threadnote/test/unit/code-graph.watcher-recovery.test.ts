import {succeedUndefined} from '@threadnote/platform/optional';
import {it as effectIt} from '@effect/vitest';
import {Context, Crypto, Deferred, Effect, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {codeGraphLayout, codeGraphRefreshDemandPath} from '@threadnote/graph/layout';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphObservability} from '@threadnote/graph/runtime_ports';
import {CodeGraphScopeRoutingError} from '@threadnote/graph/scope/routing';
import {
  adoptCodeGraphBackgroundDemand,
  completeCodeGraphBackgroundDemand,
  deferCodeGraphBackgroundDemand,
  failCodeGraphBackgroundDemand,
  registerCodeGraphBackgroundDemand,
  CodeGraphRefreshDemandSuperseded,
} from '@threadnote/graph/refresh/demand';
import {
  CodeGraphWatcher,
  driveCodeGraphBackgroundDemand,
  makeCodeGraphResumeScheduler,
  makeCodeGraphWatcher,
  type CodeGraphPreparedRefreshDemand,
} from '@threadnote/graph/watcher';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {completeCodeGraphReadyReadRefresh} from '@threadnote/threadnote/mcp/server/code_graph/ready_read';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

const identity = {
  caseMode: 'sensitive' as const,
  checkoutId: 'a'.repeat(64),
  worktreeId: 'b'.repeat(64),
  repositoryId: 'c'.repeat(64),
  displayName: 'fixture',
  gitCommonDirectory: '/fixture/.git',
  headCommit: 'd'.repeat(40),
  objectFormat: 'sha1' as const,
  repoRoot: '/fixture',
};

const persistedDriverFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const demandIdentity = {checkoutId: identity.checkoutId, worktreeId: identity.worktreeId, threadnoteHome: home};
  const target: CodeGraphPreparedRefreshDemand['target'] = {
    admissionFingerprint: 'e'.repeat(64),
    demandIdentity,
    identity,
    layout: codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId),
    overlay: {dirty: false},
    requestKey: '1'.repeat(64),
  };
  const sidecar = codeGraphRefreshDemandPath(path, home, identity.checkoutId, identity.worktreeId);
  return {fs, home, target, readState: fs.readFileString(sidecar).pipe(Effect.map(raw => JSON.parse(raw)))};
});

describe('watcher admitted-attempt recovery', () => {
  effectIt.effect('consumes one prepared claim across two persisted retry deadlines without replay or spin', () =>
    Effect.gen(function* () {
      const {target, home, readState} = yield* persistedDriverFixture;
      type DemandServices = Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo;
      const services = yield* Effect.context<DemandServices>();
      const bind = <A, E>(effect: Effect.Effect<A, E, DemandServices>) => effect.pipe(Effect.provide(services));
      const registration = yield* registerCodeGraphBackgroundDemand(target.demandIdentity, target.requestKey);
      const deferred = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const completed = yield* Deferred.make<void>();
      let attempts = 0;
      let deferrals = 0;
      const deadlines: number[] = [];
      const watcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        options =>
          driveCodeGraphBackgroundDemand({
            prepared: options.refreshDemandPrepared,
            observe: Effect.succeed(target),
            recover: () => Effect.void,
            register: observed => bind(registerCodeGraphBackgroundDemand(observed.demandIdentity, observed.requestKey)),
            defer: (observed, token, blocked) =>
              bind(deferCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey, blocked)).pipe(
                Effect.tap(state => {
                  if (state.desired?.retry === undefined) return Effect.die('expected persisted retry');
                  deadlines.push(state.desired.retry.notBefore);
                  expect(state.desired?.retry?.attempt).toBe(++deferrals);
                  return Deferred.succeed(deferred[deferrals - 1], undefined);
                }),
              ),
            fail: (observed, token) =>
              bind(failCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey)),
            complete: (observed, token) =>
              bind(completeCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey)),
            isSuperseded: Schema.is(CodeGraphRefreshDemandSuperseded),
            onRefreshed: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
            run: (observed, token) =>
              bind(
                Effect.gen(function* () {
                  expect(
                    yield* adoptCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey),
                  ).toBe(true);
                  expect((yield* readState).active).toMatchObject({targetToken: token, targetKey: observed.requestKey});
                  if (++attempts <= 2)
                    return yield* CodeGraphRefreshDemandSuperseded.make({message: 'unchanged transient rejection'});
                  return {symbols: 1, edges: 0};
                }),
              ),
          }),
      );
      yield* watcher.refresh({
        cwd: identity.repoRoot,
        key: identity.worktreeId,
        threadnoteHome: home,
        admissionClass: 'background',
        refreshDemandPrepared: {registration, target} satisfies CodeGraphPreparedRefreshDemand,
      });
      yield* Deferred.await(deferred[0]);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(249);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(1);
      yield* Deferred.await(deferred[1]);
      expect(attempts).toBe(2);
      expect(deadlines).toEqual([250, 750]);
      yield* TestClock.adjust(499);
      expect(attempts).toBe(2);
      yield* TestClock.adjust(1);
      yield* Deferred.await(completed);
      expect(attempts).toBe(3);
      expect((yield* readState).active).toBeUndefined();
      expect((yield* readState).desired).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('consumes a genuinely new queued prepared claim before the older retry deadline', () =>
    Effect.gen(function* () {
      const {target, home, readState} = yield* persistedDriverFixture;
      type DemandServices = Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo;
      const services = yield* Effect.context<DemandServices>();
      const bind = <A, E>(effect: Effect.Effect<A, E, DemandServices>) => effect.pipe(Effect.provide(services));
      const first = yield* registerCodeGraphBackgroundDemand(target.demandIdentity, target.requestKey);
      const deferred = yield* Deferred.make<void>();
      const deferredNewer = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let latest = target;
      const attempts: string[] = [];
      const watcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        options =>
          driveCodeGraphBackgroundDemand({
            prepared: options.refreshDemandPrepared,
            observe: Effect.sync(() => latest),
            recover: () => Effect.void,
            register: observed => bind(registerCodeGraphBackgroundDemand(observed.demandIdentity, observed.requestKey)),
            defer: (observed, token) =>
              bind(deferCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey)).pipe(
                Effect.tap(() =>
                  Deferred.succeed(observed.requestKey === target.requestKey ? deferred : deferredNewer, undefined),
                ),
              ),
            fail: (observed, token) =>
              bind(failCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey)),
            complete: (observed, token) =>
              bind(completeCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey)),
            isSuperseded: Schema.is(CodeGraphRefreshDemandSuperseded),
            onRefreshed: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
            run: (observed, token) =>
              bind(
                Effect.gen(function* () {
                  expect(
                    yield* adoptCodeGraphBackgroundDemand(observed.demandIdentity, token, observed.requestKey),
                  ).toBe(true);
                  attempts.push(observed.requestKey);
                  if (attempts.length <= 2)
                    return yield* CodeGraphRefreshDemandSuperseded.make({message: 'retry old target'});
                  return {symbols: 1, edges: 0};
                }),
              ),
          }),
      );
      const options = {
        cwd: identity.repoRoot,
        key: identity.worktreeId,
        threadnoteHome: home,
        admissionClass: 'background' as const,
      };
      yield* watcher.refresh({...options, refreshDemandPrepared: {registration: first, target}});
      yield* Deferred.await(deferred);
      yield* TestClock.adjust(0);
      latest = {...target, requestKey: '2'.repeat(64)};
      const newer = yield* registerCodeGraphBackgroundDemand(latest.demandIdentity, latest.requestKey);
      expect(newer.type).toBe('claimed');
      yield* watcher.refresh({...options, refreshDemandPrepared: {registration: newer, target: latest}});
      yield* Deferred.await(deferredNewer);
      expect(attempts).toEqual([target.requestKey, latest.requestKey]);
      yield* TestClock.adjust(249);
      expect(attempts).toHaveLength(2);
      yield* TestClock.adjust(1);
      yield* Deferred.await(completed);
      expect(attempts).toEqual([target.requestKey, latest.requestKey, latest.requestKey]);
      yield* TestClock.adjust(1_000);
      expect(attempts).toHaveLength(3);
      expect((yield* readState).active).toBeUndefined();
      expect((yield* readState).desired).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  // The detached worker port captures its clock at layer construction, so this
  // real process boundary needs live time around both the layer and the test.
  effectIt.effect(
    'recovers a blocked route after manifest repair through ordinary stale ready reads',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-watcher-recovery-');
        const cwd = path.join(root, 'repository');
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(path.join(cwd, 'apps', 'docs'), {recursive: true});
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(
          path.join(cwd, 'package.json'),
          JSON.stringify({name: 'fixture', workspaces: ['apps/*']}),
        );
        yield* fs.writeFileString(path.join(cwd, 'apps', 'docs', 'package.json'), JSON.stringify({name: 'docs'}));
        yield* fs.writeFileString(path.join(cwd, 'apps', 'docs', 'source.ts'), 'export const docs = 1;\n');
        for (const args of [
          ['init', '-q'],
          ['add', '.'],
          ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
        ])
          yield* runCommandEffect('git', ['-C', cwd, ...args]);
        const project = {
          name: 'docs',
          uri: 'threadnote://resources/repos/docs',
          path: cwd,
          seed: [],
          graph: {closure: 'dependencies' as const, roots: ['apps/docs']},
        };
        const manifestPath = path.join(home, 'manifest.json');
        const manifest = JSON.stringify({version: 1, projects: [project]});
        yield* fs.writeFileString(manifestPath, manifest);
        const indexer = yield* CodeGraphIndexer;
        const observability = yield* CodeGraphObservability;
        const store = yield* CodeGraphStore;
        const failed = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        let attempts = 0;
        const context = yield* Layer.build(
          Layer.fresh(CodeGraphWatcher.layer).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  CodeGraphIndexer,
                  CodeGraphIndexer.of({
                    ...indexer,
                    index: request =>
                      ++attempts === 1
                        ? CodeGraphScopeRoutingError.make({message: 'child saw a changed manifest'})
                        : indexer.index(request),
                  }),
                ),
                Layer.succeed(CodeGraphStore, CodeGraphStore.of({...store, readySnapshot: () => succeedUndefined})),
                Layer.succeed(
                  CodeGraphObservability,
                  CodeGraphObservability.of({
                    ...observability,
                    backgroundFailure: () => Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
                  }),
                ),
              ),
            ),
          ),
        );
        const watcher = Context.get(context, CodeGraphWatcher);
        const requests = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        let requestCount = 0;
        const scheduleRequest = yield* makeCodeGraphResumeScheduler(options =>
          watcher.request(options).pipe(Effect.tap(() => Deferred.succeed(requests[requestCount++], undefined))),
        );
        const target = {
          cwd,
          manifestPath,
          project,
          threadnoteHome: home,
          onRefreshed: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        };
        const key = 'recovery';
        const awaitSignal = (signal: Deferred.Deferred<void>, label: string) =>
          Deferred.await(signal).pipe(
            Effect.timeout('5 seconds'),
            Effect.catchCause(() => Effect.die(label)),
          );
        yield* watcher.ensure({...target, key});
        const read = Effect.gen(function* () {
          const refreshStatus = Option.getOrUndefined(yield* watcher.cachedStatus(key, target));
          return yield* completeCodeGraphReadyReadRefresh({
            backgroundRefreshRequested: true,
            ensureWatcher: true,
            key,
            target,
            refreshStatus,
            watcher: {...watcher, scheduleRequest},
          });
        });
        yield* read;
        yield* awaitSignal(requests[0], 'request 1 did not complete');
        yield* awaitSignal(failed, 'initial child failure was not reported');
        const cached = Option.getOrUndefined(yield* watcher.cachedStatus(key, target));
        expect(cached).toMatchObject({state: 'deferred', failure: {retryable: false, reobserveTarget: true}});
        yield* read;
        yield* awaitSignal(requests[1], 'unchanged request 2 did not complete');
        expect(attempts).toBe(1);
        yield* fs.writeFileString(manifestPath, `${manifest}\n`);
        yield* read;
        yield* awaitSignal(requests[2], 'repaired request 3 did not complete');
        yield* awaitSignal(ready, 'repaired child did not refresh');
        expect(attempts).toBe(2);
        expect(Option.getOrUndefined(yield* watcher.cachedStatus(key, target))).toMatchObject({state: 'ready'});
        expect((yield* watcher.metrics).activeWatches).toBe(1);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 30_000},
  );
});
