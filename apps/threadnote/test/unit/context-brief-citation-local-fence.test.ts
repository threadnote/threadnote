import * as EffectStruct from 'effect/Struct';
import * as EffectString from 'effect/String';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's symlink API lacks the junction type required for unprivileged Windows fixtures.
import {symlinkSync} from 'node:fs';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Crypto, Deferred, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {RepositoryIdentityExpectation, CodeGraphSemanticStatus, CodeGraphStatus} from '@threadnote/graph/types';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor, CommandOutputLimitExceeded, runCommandEffect} from '@threadnote/platform/command';

import {
  contextBriefCitationScaleExtractorSet,
  prepareContextBriefCitationScaleRepositories,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-fixture';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {provideTestLayer} from '../helpers/effect-layer.js';

const systemLayer = TestSystemInfoLayer;
const commandLayer = TestCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const platformLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const fixtureLayer = Layer.mergeAll(
  CodeGraphStore.layer.pipe(Layer.provideMerge(platformLayer)),
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
);
const SOURCE_PATH = 'src/context-brief-scale/local-100k/tnscalelocal100krun000/000.ts';
const mutations = [
  'worktree',
  'head',
  'remote',
  'caller-route',
  'checkout-route',
  'policy',
  'receipt',
  'provenance',
  'snapshot',
] as const;
type Mutation = (typeof mutations)[number] | 'none' | 'legacy-service' | 'no-ready';

const scenario = (
  mutation: Mutation,
  suffix = 0,
  overlapObservations = false,
  overlapIdentity = false,
  failInitialProbe = false,
  semanticState?: CodeGraphSemanticStatus['state'],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const packs = yield* CodeGraphLanguagePackRegistry;
    const fixtureContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto | SystemInfo>();
    const command = yield* CommandExecutor;
    const admissionStarted = yield* Deferred.make<void>();
    const overlayStarted = yield* Deferred.make<void>();
    const identityStarted = yield* Deferred.make<void>();
    const worktreeStarted = yield* Deferred.make<void>();
    const overlapIdentityReads = (args: readonly string[]) =>
      Effect.gen(function* () {
        if (!overlapIdentity) return;
        // Status shares the initial metadata batch, then overlaps the remaining
        // identity reads. Blocking that prerequisite batch would deadlock the
        // fixture before either observation can reach its intended overlap.
        if (args.includes('config') && args.includes('core.ignorecase')) {
          yield* Deferred.succeed(identityStarted, undefined);
          yield* Deferred.await(worktreeStarted);
        }
        if (args.includes('--porcelain=v2')) {
          yield* Deferred.succeed(worktreeStarted, undefined);
          yield* Deferred.await(identityStarted);
        }
      });
    let probeFailed = false;
    let fallbackReads = 0;
    const observedCommand = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) =>
        Effect.gen(function* () {
          yield* overlapIdentityReads(args);
          if (failInitialProbe && !probeFailed && args.includes('--porcelain=v2')) {
            probeFailed = true;
            return yield* CommandOutputLimitExceeded.make({
              executable,
              args,
              message: 'Synthetic initial probe limit',
              maxOutputBytes: 65_536,
            });
          }
          if (args.includes('--porcelain=v1')) fallbackReads += 1;
          if (overlapObservations && args.includes('--git-path') && args.includes('info/exclude')) {
            yield* Deferred.succeed(admissionStarted, undefined);
            yield* Deferred.await(overlayStarted);
          }
          if (overlapObservations && (args.includes('--porcelain=v1') || args.includes('--porcelain=v2'))) {
            yield* Deferred.succeed(overlayStarted, undefined);
            yield* Deferred.await(admissionStarted);
          }
          return yield* command.execute(executable, args, options);
        }),
      executeBytes:
        command.executeBytes === undefined
          ? undefined
          : (executable, args, options) =>
              overlapIdentityReads(args).pipe(Effect.andThen(command.executeBytes!(executable, args, options))),
    });
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-local-fence-'});
    const home = path.join(root, 'home');
    const [repository] = yield* prepareContextBriefCitationScaleRepositories(
      fs,
      path,
      home,
      root,
      {
        citationCount: 1,
        citedRepositories: 1,
        id: 'local-100k',
        maximumBriefP95Milliseconds: 1_500,
        maximumValidationP95Milliseconds: 250,
        selectedMemories: 1,
        worksetMembers: 1,
      },
      1,
    );
    const replacement = {...repository.status.readySnapshot, id: 'cgsn_1111111111111111111111111111111111111111'};
    const layout = codeGraphLayout(path, home, repository.checkoutId, repository.worktreeId);
    if (mutation === 'snapshot') {
      yield* store.activate(
        repository.databasePath,
        repository.status.identity,
        replacement,
        [
          {
            blobId: EffectString.slice(0, 40)(sha256HexSync(SOURCE_PATH)),
            contentHash: sha256HexSync(SOURCE_PATH),
            language: 'typescript',
            mode: '100644',
            path: SOURCE_PATH,
            size: new TextEncoder().encode(SOURCE_PATH).byteLength,
            source: 'commit',
          },
        ],
        [],
        [],
        [],
      );
      yield* store.promote(repository.databasePath, repository.status.identity, repository.snapshotId);
    }
    const caller = path.join(root, 'caller');
    // A junction is also available without elevated symlink privileges on Windows.
    yield* directoryLink(repository.root, caller);
    const clone = path.join(root, 'clone');
    if (mutation === 'caller-route' || mutation === 'checkout-route') {
      yield* git(root, ['clone', '--quiet', repository.root, clone]);
      yield* git(clone, ['remote', 'set-url', 'origin', repository.status.identity.remoteIdentity!]);
    }
    const citation = createMemoryCodeCitation({
      extractorSet: contextBriefCitationScaleExtractorSet(),
      fileContentHash: {algorithm: 'sha256', value: sha256HexSync(SOURCE_PATH)},
      path: SOURCE_PATH,
      repositoryId: repository.repositoryId,
      repositoryIdentityKind: 'remote',
      sourceCommit: repository.status.identity.headCommit,
      sourceDirty: false,
      sourceGraphContentId: repository.status.readySnapshot.graphContentId,
      sourceSnapshotId: repository.snapshotId,
      target: {kind: 'file'},
      version: 1,
    });
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'test',
    };
    let evidenceRead = false;
    let evidenceBatches = 0;
    let replacementReads = 0;
    let sessions = 0;
    let leases = 0;
    let expectedCalls = 0;
    let ordinaryFinalCalls = 0;
    const mutate = Effect.gen(function* () {
      evidenceRead = true;
      evidenceBatches += 1;
      if (mutation === 'snapshot') {
        yield* store
          .promote(repository.databasePath, repository.status.identity, replacement.id)
          .pipe(Effect.provideContext(fixtureContext));
        yield* recordCodeGraphSnapshotAdmission(
          layout,
          replacement,
          yield* observeCodeGraphAdmissionEnvironment(repository.status.identity),
          packs,
          false,
        );
      }
      if (mutation === 'worktree') yield* fs.writeFileString(path.join(repository.root, SOURCE_PATH), 'changed');
      if (mutation === 'head')
        yield* git(repository.root, [
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '--allow-empty',
          '-qm',
          'next',
        ]);
      if (mutation === 'remote')
        yield* git(repository.root, ['remote', 'set-url', 'origin', `https://example.invalid/changed-${suffix}.git`]);
      if (mutation === 'caller-route') {
        yield* fs.remove(caller);
        yield* directoryLink(clone, caller);
      }
      if (mutation === 'checkout-route') {
        yield* fs.rename(path.join(repository.root, '.git'), path.join(root, 'saved-git'));
        yield* fs.writeFileString(path.join(repository.root, '.git'), `gitdir: ${path.join(clone, '.git')}\n`);
      }
      if (mutation === 'policy')
        yield* fs.writeFileString(path.join(repository.root, '.git', 'info', 'exclude'), `changed-${suffix}.ts\n`);
      if (mutation === 'receipt')
        yield* fs.remove(
          path.join(
            codeGraphLayout(path, home, repository.checkoutId, repository.worktreeId).repositoryRoot,
            'admission',
          ),
          {recursive: true},
        );
    });
    const observedStore = CodeGraphStore.of({
      ...store,
      readySnapshot: (...args) =>
        mutation === 'no-ready'
          ? succeedUndefined
          : store.readySnapshot(...args).pipe(
              Effect.map(snapshot => {
                if (mutation !== 'snapshot' || !evidenceRead || !snapshot) return snapshot;
                replacementReads += 1;
                expect(snapshot.id).toBe(replacement.id);
                return snapshot;
              }),
            ),
      acquireSnapshotLease: (...args) =>
        store.acquireSnapshotLease(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              leases += 1;
            }),
          ),
        ),
      releaseSnapshotLease: (...args) =>
        store.releaseSnapshotLease(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              leases -= 1;
            }),
          ),
        ),
      effectiveSnapshotCitationEvidence: (...args) =>
        store
          .effectiveSnapshotCitationEvidence(...args)
          .pipe(
            Effect.tap(() =>
              mutate.pipe(
                Effect.provideService(CommandExecutor, command),
                Effect.provideContext(fixtureContext),
                Effect.orDie,
              ),
            ),
          ),
      snapshotPackProvenance: (...args) =>
        store
          .snapshotPackProvenance(...args)
          .pipe(Effect.map(provenance => (evidenceRead && mutation === 'provenance' ? undefined : provenance))),
      withSession: (databasePath, effect, options) =>
        Effect.sync(() => {
          sessions += 1;
        }).pipe(Effect.andThen(store.withSession(databasePath, effect, options))),
    });
    let semanticChecks = 0;
    const unexpected = () => Effect.die(new Error('Citation validation must not index or maintain graphs.'));
    const unexpectedSemantic = () =>
      Effect.sync(() => {
        semanticChecks += 1;
      }).pipe(Effect.andThen(unexpected()));
    const dependencies = Layer.mergeAll(
      platformLayer,
      Layer.succeed(CommandExecutor, observedCommand),
      Layer.succeed(CodeGraphStore, observedStore),
      Layer.succeed(CodeGraphLanguagePackRegistry, packs),
      Layer.succeed(CodeGraphIndexer, CodeGraphIndexer.of({ensureCommit: unexpected, index: unexpected})),
      Layer.succeed(
        CodeGraphMaintenanceCoordinator,
        CodeGraphMaintenanceCoordinator.of({
          kickOrdinary: unexpected,
          kickReconciliation: unexpected,
          kickResidual: unexpected,
          request: unexpected,
          tick: unexpected,
        }),
      ),
      Layer.succeed(
        CodeGraphEmbeddingIndex,
        CodeGraphEmbeddingIndex.of({
          check: unexpectedSemantic,
          ensure: unexpected,
          search: () => Effect.succeed(new Map()),
        }),
      ),
    );
    const validations = yield* Effect.gen(function* () {
      const query = yield* CodeGraphQueryService;
      const expected: RepositoryIdentityExpectation = repository.status.identity;
      const retainSemanticState = (status: CodeGraphStatus) => {
        expect(status.semantic).toBeUndefined();
        if (mutation === 'snapshot' && evidenceRead) {
          expect(status).toMatchObject({freshness: 'current', stale: false, readySnapshot: {id: replacement.id}});
        }
        return semanticState === undefined ? status : Object.assign(status, {semantic: {state: semanticState}});
      };
      const observed = CodeGraphQueryService.of({
        ...query,
        withStatusSession: (home, cwd, expected, options, use) => {
          expect(options.observeSemantic).toBe(false);
          return query.withStatusSession!(home, cwd, expected, options, status => use(retainSemanticState(status)));
        },
        status: (...args: Parameters<typeof query.status>) =>
          Effect.sync(() => {
            ordinaryFinalCalls += 1;
          }).pipe(Effect.andThen(query.status(...args).pipe(Effect.map(retainSemanticState)))),
        statusForPublishedIdentity: (...args: Parameters<typeof query.statusForPublishedIdentity>) =>
          Effect.sync(() => {
            expectedCalls += 1;
            expect(evidenceRead).toBe(true);
            expect(leases).toBe(1);
            expect(args[1]).toBe(caller);
            expect(args[2]).toMatchObject(expected);
            expect(args[3]).toMatchObject({observeWorktree: true, observeSemantic: false, requestMaintenance: false});
          }).pipe(Effect.andThen(query.statusForPublishedIdentity(...args).pipe(Effect.map(retainSemanticState)))),
      });
      const custom =
        mutation === 'legacy-service' ? EffectStruct.omit(observed, ['statusForPublishedIdentity']) : observed;
      return yield* validateContextBriefMemoryCitations(config, {callerCwd: caller, kind: 'repository'}, [
        {
          citationErrorCount: 0,
          codeCitations: [citation],
          excerpt: 'fixture',
          kind: 'durable',
          rank: 0,
          uri: `threadnote://user/test/memories/durable/projects/fixture/${mutation}-${suffix}.md`,
        },
      ]).pipe(
        Effect.provideService(
          CodeGraphQueryService,
          // @ts-expect-error This fixture models a legacy service that predates statusForPublishedIdentity.
          CodeGraphQueryService.of(custom),
        ),
      );
    }).pipe(provideTestLayer(CodeGraphQueryService.layer.pipe(Layer.provideMerge(dependencies))));
    const receipts = EffectArray.flatMap(validations, value => value.receipts);
    expect(receipts).toHaveLength(1);
    const exact = mutation === 'none' || mutation === 'legacy-service';
    expect(receipts[0].status).toBe(exact ? 'exact' : 'unknown');
    if (exact) expect(receipts[0].coverage).toBe('current-complete');
    if (mutation === 'snapshot') {
      expect(replacementReads).toBeGreaterThan(0);
      expect(receipts[0].reason).toBe('graph-stale');
    }
    expect(evidenceBatches).toBe(mutation === 'no-ready' ? 0 : 1);
    expect(expectedCalls).toBe(mutation === 'legacy-service' || mutation === 'no-ready' ? 0 : 1);
    expect(ordinaryFinalCalls).toBe(mutation === 'legacy-service' ? 1 : 0);
    expect(sessions).toBe(1);
    expect(semanticChecks).toBe(0);
    expect(leases).toBe(0);
    if (overlapIdentity) {
      expect(yield* Deferred.isDone(identityStarted)).toBe(true);
      expect(yield* Deferred.isDone(worktreeStarted)).toBe(true);
    }
    if (failInitialProbe) {
      expect(probeFailed).toBe(true);
      expect(fallbackReads).toBeGreaterThan(0);
    }
  }).pipe(provideTestLayer(fixtureLayer), TestClock.withLive);

describe('Context Brief local citation closing observation', () => {
  const semanticStates = [
    'not-requested',
    'queued',
    'embedding',
    'ready',
    'deferred',
    'blocked',
    'unavailable',
  ] as const;
  effectIt.effect('preserves structural receipts across every semantic readiness state', () =>
    Effect.gen(function* () {
      for (const state of semanticStates) yield* scenario('none', 0, false, false, false, state);
    }),
  );
  fcEffectProp(
    effectIt,
    'keeps semantic readiness independent of between-observation source mutations',
    {
      state: fc.constantFrom(...semanticStates),
      mutation: fc.constantFrom('none' as const, ...mutations),
      suffix: fc.nat(100000),
    },
    ({state, mutation, suffix}) => scenario(mutation, suffix, false, false, false, state),
    {fastCheck: {numRuns: 8}},
  );

  effectIt.effect('returns unknown coverage for a missing ready snapshot when the optional probe is unavailable', () =>
    scenario('no-ready', 0, false, false, true),
  );
  effectIt.effect('retains the policy-aware worktree fallback when the optional initial probe exceeds its bound', () =>
    scenario('none', 0, false, false, true),
  );
  effectIt.effect(
    'overlaps initial identity completion and worktree observations while retaining the closing fence',
    () => scenario('none', 0, false, true),
  );
  effectIt.effect('overlaps initial admission and worktree reads without skipping the closing fence', () =>
    scenario('none', 0, true),
  );
  effectIt.effect('reobserves a locally discovered identity after evidence within its lease and session', () =>
    scenario('none'),
  );
  effectIt.effect('preserves full status fallback for custom services without expected-identity support', () =>
    scenario('legacy-service'),
  );
  for (const mutation of mutations) {
    effectIt.effect(`rejects a between-observation ${mutation} change`, () => scenario(mutation));
  }
  fcEffectProp(
    effectIt,
    'preserves fail-closed mutation outcomes when initial observations overlap',
    {mutation: fc.constantFrom(...mutations), suffix: fc.nat(100_000)},
    ({mutation, suffix}) => scenario(mutation, suffix, true, true),
    {fastCheck: {numRuns: 8}},
  );
  fcEffectProp(
    effectIt,
    'rejects independently changed remote identities',
    {suffix: fc.nat(100_000)},
    ({suffix}) => scenario('remote', suffix),
    {fastCheck: {numRuns: 5}},
  );
});

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 16_384, timeoutMs: 10_000});
}

function directoryLink(target: string, link: string) {
  return Effect.sync(() => symlinkSync(target, link, 'junction'));
}
