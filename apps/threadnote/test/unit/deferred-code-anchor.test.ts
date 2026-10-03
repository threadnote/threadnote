import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path, PlatformError, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {fcProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import type {CodeGraphInventoryFile, CodeGraphStatus} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  discardDeferredCodeAnchorIntent,
  discardOtherDeferredCodeAnchorIntents,
  deferredCodeAnchorDoctorCheck,
  findUrisWithDeferredCodeAnchorIntents,
  finalizeDeferredCodeAnchors,
  finalizeDeferredCodeAnchorsForRoute,
  hasDeferredCodeAnchorIntent,
  listDeferredCodeAnchorIntents,
  stageDeferredCodeAnchorIntent,
  type DeferredCodeAnchorWriteRequest,
  type DeferredCodeAnchorFinalizationRoute,
  withDeferredCodeAnchorMutationLocks,
} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {
  ensurePrivateDeferredCodeAnchorDirectory,
  quarantinePrivateDeferredCodeAnchorRouteEntry,
  writePrivateDeferredCodeAnchorFile,
} from '@threadnote/threadnote/memory/deferred/code_anchor_private_fs';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {deferredCodeAnchorCaptureFailureItem} from '@threadnote/threadnote/memory/deferred/code_anchor_failure';
import {finalizedDeferredCodeAnchorUris} from '@threadnote/threadnote/memory/deferred/code_anchor_finalization';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const MEMORY_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/deferred.md';
const TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS = 5_000;

describe('deferred code-anchor outbox', () => {
  effectIt.effect('persists a verified selected project scope while legacy requests remain unselected', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const originalQuery = yield* CodeGraphQueryService;
        const observed = yield* originalQuery.status(fixture.config.agentContextHome, fixture.repository, {
          observeWorktree: true,
          requestMaintenance: false,
        });
        const scoped = selectedProjectStatus(observed, 'app-a', 'code-graph-scope:app-a');
        const selected = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Selected scope.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: {...deferredRequest(fixture.repository, ['apps/a/index.ts']), project: 'app-a'},
        }).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({...originalQuery, status: () => Effect.succeed(scoped)}),
          ),
        );
        expect(selected.project).toBe('app-a');
        expect(selected.projectScope).toEqual({
          closureDigest: 'b'.repeat(64),
          definitionDigest: 'a'.repeat(64),
          project: 'app-a',
          scopeKey: 'code-graph-scope:app-a',
        });
        const selectedContent = yield* fixture.fs.readFileString((yield* fixtureIntentPaths(fixture))[0]);
        expect(JSON.parse(selectedContent)).toMatchObject({project: 'app-a', projectScope: selected.projectScope});

        const legacyUri = 'threadnote://user/tester/memories/durable/projects/threadnote/legacy.md';
        const legacyMetadata = {...fixture.metadata, memoryId: 'tn_deferred_legacy', topic: 'legacy'};
        const legacy = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(legacyMetadata, 'Unselected compatibility.'),
          memoryMetadata: legacyMetadata,
          memoryUri: legacyUri,
          request: deferredRequest(fixture.repository, ['src/legacy.ts']),
        }).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({...originalQuery, status: () => Effect.succeed(observed)}),
          ),
        );
        expect(legacy.project).toBeUndefined();
        expect(legacy.projectScope).toBeUndefined();
        const legacyPath = (yield* fixtureIntentPaths(fixture)).find(path => path.includes(legacy.intentId));
        const legacyContent = JSON.parse(yield* fixture.fs.readFileString(legacyPath!)) as Record<string, unknown>;
        expect(legacyContent).not.toHaveProperty('project');
        expect(legacyContent).not.toHaveProperty('projectScope');
        const loadedLegacy = (yield* listDeferredCodeAnchorIntents(fixture.config)).find(
          entry => entry.kind === 'valid' && entry.intent.intentId === legacy.intentId,
        );
        expect(loadedLegacy).toMatchObject({intent: {intentId: legacy.intentId}});
        if (loadedLegacy?.kind === 'valid') {
          expect(loadedLegacy.intent.project).toBeUndefined();
          expect(loadedLegacy.intent.projectScope).toBeUndefined();
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('fails closed before citation lookup when a selected sibling scope changes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const store = yield* ResourceStore;
        const content = memoryContent(fixture.metadata, 'Scope must not cross-resolve.');
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const originalQuery = yield* CodeGraphQueryService;
        const observed = yield* originalQuery.status(fixture.config.agentContextHome, fixture.repository, {
          observeWorktree: true,
          requestMaintenance: false,
        });
        const initial = selectedProjectStatus(observed, 'app-a', 'code-graph-scope:app-a');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: {...deferredRequest(fixture.repository, ['apps/a/index.ts']), project: 'app-a'},
        }).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({...originalQuery, status: () => Effect.succeed(initial)}),
          ),
        );

        const sibling = selectedProjectStatus(observed, 'app-a', 'code-graph-scope:app-a-reconfigured');
        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({...originalQuery, status: () => Effect.succeed(sibling)}),
          ),
        );
        expect(receipt.items).toEqual([
          expect.objectContaining({code: 'citation-capture-failed', memoryUri: MEMORY_URI, state: 'failed'}),
        ]);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('fails closed when a selected project changes between full and scoped graph expectations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fullFixture = yield* makeFixture();
        const fullStore = yield* ResourceStore;
        const fullContent = memoryContent(fullFixture.metadata, 'Full project scope must remain full.');
        yield* fullStore.write(resourceStoreLocation(fullFixture.config), MEMORY_URI, fullContent, {mode: 'create'});
        const fullQuery = yield* CodeGraphQueryService;
        const fullObserved = yield* fullQuery.status(fullFixture.config.agentContextHome, fullFixture.repository, {
          observeWorktree: true,
          requestMaintenance: false,
        });
        yield* stageDeferredCodeAnchorIntent(fullFixture.config, {
          memoryContent: fullContent,
          memoryMetadata: fullFixture.metadata,
          memoryUri: MEMORY_URI,
          request: {...deferredRequest(fullFixture.repository, ['apps/a/missing.ts']), project: 'app-a'},
        }).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({
              ...fullQuery,
              status: () => Effect.succeed(selectedFullProjectStatus(fullObserved, 'app-a')),
            }),
          ),
        );
        const fullIntent = (yield* listDeferredCodeAnchorIntents(fullFixture.config)).find(
          entry => entry.kind === 'valid',
        );
        expect(fullIntent).toMatchObject({kind: 'valid', intent: {projectScope: {kind: 'full'}}});
        const graph = yield* exactCurrentCitationGraph(fullFixture, []);
        if (fullIntent?.kind === 'valid') {
          expect(graph.status.identity.repositoryId).toBe(fullIntent.intent.repositoryId);
          expect(graph.status.identity.worktreeId).toBe(fullIntent.intent.worktreeId);
        }
        const fullStatus = selectedFullProjectStatus(graph.status, 'app-a');
        const scopedStatus = selectedProjectStatus(graph.status, 'app-a', 'code-graph-scope:app-a');
        // Admission precedes the scope precheck, citation before/after fences,
        // and scope postcheck. Exercise each remaining fence independently.
        for (const transitionRead of [2, 3, 4, 5]) {
          const statusReads = yield* Ref.make(0);
          const fullToScopedToFull = yield* finalizeDeferredCodeAnchors(fullFixture.config).pipe(
            Effect.provideService(
              CodeGraphQueryService,
              CodeGraphQueryService.of({
                ...graph.query,
                status: () =>
                  Ref.updateAndGet(statusReads, count => count + 1).pipe(
                    Effect.map(count => (count === transitionRead ? scopedStatus : fullStatus)),
                  ),
              }),
            ),
            Effect.provideService(CodeGraphStore, graph.store),
          );
          expect(fullToScopedToFull.items).toEqual([
            expect.objectContaining({code: 'citation-capture-failed', memoryUri: MEMORY_URI, state: 'failed'}),
          ]);
          expect(yield* Ref.get(statusReads)).toBe(transitionRead);
          expect(yield* hasDeferredCodeAnchorIntent(fullFixture.config, MEMORY_URI)).toBe(true);
        }

        const scopedFixture = yield* makeFixture();
        const scopedStore = yield* ResourceStore;
        const scopedContent = memoryContent(scopedFixture.metadata, 'Scoped project must remain scoped.');
        yield* scopedStore.write(resourceStoreLocation(scopedFixture.config), MEMORY_URI, scopedContent, {
          mode: 'create',
        });
        const scopedQuery = yield* CodeGraphQueryService;
        const scopedObserved = yield* scopedQuery.status(
          scopedFixture.config.agentContextHome,
          scopedFixture.repository,
          {
            observeWorktree: true,
            requestMaintenance: false,
          },
        );
        yield* stageDeferredCodeAnchorIntent(scopedFixture.config, {
          memoryContent: scopedContent,
          memoryMetadata: scopedFixture.metadata,
          memoryUri: MEMORY_URI,
          request: {...deferredRequest(scopedFixture.repository, ['apps/a/index.ts']), project: 'app-a'},
        }).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({
              ...scopedQuery,
              status: () => Effect.succeed(selectedProjectStatus(scopedObserved, 'app-a', 'code-graph-scope:app-a')),
            }),
          ),
        );
        const scopedToFull = yield* finalizeDeferredCodeAnchors(scopedFixture.config).pipe(
          Effect.provideService(
            CodeGraphQueryService,
            CodeGraphQueryService.of({
              ...scopedQuery,
              status: () => Effect.succeed(selectedFullProjectStatus(scopedObserved, 'app-a')),
            }),
          ),
        );
        expect(scopedToFull.items).toEqual([
          expect.objectContaining({code: 'citation-capture-failed', memoryUri: MEMORY_URI, state: 'failed'}),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps outside-project-graph failure explicit during deferred finalization', () =>
    Effect.sync(() => {
      expect(
        deferredCodeAnchorCaptureFailureItem(
          MemoryCodeCitationCaptureError.of('outside', undefined, 'outside-project-graph'),
          MEMORY_URI,
        ),
      ).toMatchObject({code: 'outside-project-graph', recoveryAction: 'replace-memory-code-refs', state: 'failed'});
    }),
  );

  fcProp(
    effectIt,
    'selects each finalized URI once in receipt order for one derived-index refresh',
    {
      items: fc.array(
        fc.record({
          memoryUri: fc.option(
            fc.constantFrom(
              'threadnote://user/tester/memories/a.md',
              'threadnote://user/tester/memories/b.md',
              'threadnote://user/tester/memories/c.md',
            ),
            {nil: undefined},
          ),
          state: fc.constantFrom('conflict' as const, 'failed' as const, 'finalized' as const, 'pending' as const),
        }),
        {maxLength: 80},
      ),
    },
    ({items}) => {
      const selected = finalizedDeferredCodeAnchorUris(items);
      expect(new Set(selected).size).toBe(selected.length);
      expect(selected.every(uri => items.some(item => item.state === 'finalized' && item.memoryUri === uri))).toBe(
        true,
      );
      expect(finalizedDeferredCodeAnchorUris(items)).toEqual(selected);
      for (const [index, uri] of selected.entries()) {
        if (index === selected.length - 1) break;
        expect(items.findIndex(item => item.state === 'finalized' && item.memoryUri === uri)).toBeLessThan(
          items.findIndex(item => item.state === 'finalized' && item.memoryUri === selected[index + 1]),
        );
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  effectIt.effect('serializes canonical user aliases behind parent intent cleanup', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const parentUri = 'threadnote://user/tester/memories/durable/projects/threadnote';
        const childUri = `${parentUri}/deferred.md`;
        const ownerEntered = yield* Deferred.make<void>();
        const releaseOwner = yield* Deferred.make<void>();
        const contenderAttempted = yield* Deferred.make<void>();
        const contenderEntered = yield* Deferred.make<void>();
        const events: string[] = [];
        const owner = yield* withDeferredCodeAnchorMutationLocks(
          fixture.fs,
          fixture.config,
          [parentUri],
          Effect.gen(function* () {
            events.push('parent-remove');
            yield* Deferred.succeed(ownerEntered, undefined);
            yield* Deferred.await(releaseOwner);
            events.push('parent-intent-cleanup');
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(ownerEntered);

        const contender = yield* Deferred.succeed(contenderAttempted, undefined).pipe(
          Effect.andThen(
            withDeferredCodeAnchorMutationLocks(
              fixture.fs,
              {...fixture.config, user: 'TESTER'},
              [childUri],
              Effect.sync(() => {
                events.push('descendant-store');
              }).pipe(Effect.tap(() => Deferred.succeed(contenderEntered, undefined))),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(contenderAttempted);
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(contenderEntered)).toBe(false);
        yield* Deferred.succeed(releaseOwner, undefined);
        yield* Fiber.join(owner);
        yield* Fiber.join(contender);
        expect(events).toEqual(['parent-remove', 'parent-intent-cleanup', 'descendant-store']);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('uses the same raw account and canonical user identity as personal memory storage', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const config = {...fixture.config, account: 'Team A', user: 'TESTER'};
        yield* stageDeferredCodeAnchorIntent(config, {
          memoryContent: memoryContent(fixture.metadata, 'Account identity alignment.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/account-identity.ts']),
        });

        const expected = fixture.path.join(
          fixture.config.agentContextHome,
          'data',
          'Team A',
          'user',
          'tester',
          'private',
          'deferred-code-anchors',
          'v1',
        );
        expect(yield* fixture.fs.exists(expected)).toBe(true);
        expect(yield* fixture.fs.exists(fixture.path.join(fixture.config.agentContextHome, 'data', 'team-a'))).toBe(
          false,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps the previous recovery intent until a staged replacement is committed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'First revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/first.ts']),
        });
        const second = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Replacement revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/second.ts']),
        });

        expect(first.intentId).not.toBe(second.intentId);
        const stagedPaths = yield* fixtureIntentPaths(fixture);
        expect(stagedPaths).toHaveLength(2);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({
          detail: expect.stringMatching(
            /^2 private code-anchor intent\(s\) are pending finalization across 1 worktree\(s\): [0-9a-f]{12} present matching$/u,
          ),
          name: 'deferred code anchors',
          status: 'warn',
        });
        if (process.platform !== 'win32') {
          expect((yield* fixture.fs.stat(fixture.outbox)).mode & 0o777).toBe(0o700);
          for (const intentPath of stagedPaths) {
            expect((yield* fixture.fs.stat(intentPath)).mode & 0o777).toBe(0o600);
          }
        }
        expect(
          yield* findUrisWithDeferredCodeAnchorIntents(fixture.config, [
            MEMORY_URI,
            'threadnote://user/tester/memories/durable/projects/threadnote/unrelated.md',
          ]),
        ).toEqual(new Set([MEMORY_URI]));

        yield* discardOtherDeferredCodeAnchorIntents(fixture.config, MEMORY_URI, second.intentId);
        const remaining = yield* fixtureIntentPaths(fixture);
        expect(remaining).toHaveLength(1);
        expect(yield* fixture.fs.readFileString(remaining[0])).toContain(second.intentId);

        const shardedPath = remaining[0];
        const shardedName = fixture.path.basename(shardedPath);
        const legacyDuplicateName = `${yield* sha256Hex(MEMORY_URI)}-${second.intentId}.json`;
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.outbox, legacyDuplicateName),
          yield* fixture.fs.readFileString(shardedPath),
          {mode: 0o600},
        );
        yield* discardOtherDeferredCodeAnchorIntents(fixture.config, MEMORY_URI, second.intentId);
        const deduplicated = yield* fixtureIntentPaths(fixture);
        expect(deduplicated.map(candidate => fixture.path.basename(candidate))).toEqual([shardedName]);
        expect(shardedName).toMatch(/-b[a-f0-9]{32}\.json$/u);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('fails closed instead of repairing an existing non-private outbox through a path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.makeDirectory(fixture.outbox, {recursive: true, mode: 0o700});
        if (process.platform === 'win32') return;
        yield* fixture.fs.chmod(fixture.outbox, 0o777);

        const failure = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Non-private root must remain untouched.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/private-root.ts']),
        }).pipe(Effect.flip);

        expect(String(failure)).toContain('private directory');
        expect((yield* fixture.fs.stat(fixture.outbox)).mode & 0o777).toBe(0o777);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('recovers native directory identity when Effect omits the inode', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const inodeOmittingFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          stat: target => fixture.fs.stat(target).pipe(Effect.map(info => ({...info, ino: Option.none()}))),
        });

        const staged = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Native inode fallback.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/native-inode.ts']),
        }).pipe(Effect.provideService(FileSystem.FileSystem, inodeOmittingFileSystem));

        expect(staged.intentId).toMatch(/^tnca_[a-f0-9]{32}$/u);
        expect(yield* fixtureIntentPaths(fixture)).toHaveLength(1);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not chmod an outside target after an AlreadyExists directory race', () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        const fixture = yield* makeFixture();
        const parent = fixture.path.join(fixture.config.agentContextHome, 'private-parent');
        const target = fixture.path.join(parent, 'child');
        const outside = fixture.path.join(fixture.config.agentContextHome, 'outside-directory');
        yield* fixture.fs.makeDirectory(parent, {mode: 0o700});
        yield* fixture.fs.makeDirectory(outside, {mode: 0o755});
        yield* fixture.fs.chmod(outside, 0o755);
        yield* fixture.fs.writeFileString(fixture.path.join(outside, 'sentinel.txt'), 'outside\n', {mode: 0o600});
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          makeDirectory: (directory, options) =>
            directory === target
              ? fixture.fs.symlink(outside, target).pipe(Effect.andThen(fixture.fs.makeDirectory(directory, options)))
              : fixture.fs.makeDirectory(directory, options),
        });

        const failure = yield* ensurePrivateDeferredCodeAnchorDirectory(racingFileSystem, target, [parent]).pipe(
          Effect.flip,
        );

        expect(String(failure)).toContain('must not be a link');
        expect((yield* fixture.fs.stat(outside)).mode & 0o777).toBe(0o755);
        expect(yield* fixture.fs.readFileString(fixture.path.join(outside, 'sentinel.txt'))).toBe('outside\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not chmod an outside target when a fresh quarantine slot is swapped', () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Quarantine race fixture.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/quarantine-race.ts']),
        });
        const markerPath = yield* fixtureRepositoryRouteMarkerPath(fixture);
        const laneRoot = fixture.path.dirname(markerPath);
        const queueRoot = fixture.path.dirname(laneRoot);
        const routeRoot = fixture.path.dirname(queueRoot);
        const sourceAncestors = [fixture.outbox, routeRoot, queueRoot, laneRoot];
        const queueAncestors = [fixture.outbox, routeRoot, queueRoot];
        const poison = fixture.path.join(laneRoot, 'poison.ref');
        yield* fixture.fs.writeFileString(poison, 'poison\n', {mode: 0o600});
        const outside = fixture.path.join(fixture.config.agentContextHome, 'outside-quarantine-directory');
        yield* fixture.fs.makeDirectory(outside, {mode: 0o755});
        yield* fixture.fs.chmod(outside, 0o755);
        yield* fixture.fs.writeFileString(fixture.path.join(outside, 'sentinel.txt'), 'outside\n', {mode: 0o600});
        let swapped = false;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          makeDirectory: (directory, options) => {
            if (swapped || !fixture.path.basename(directory).startsWith('q-')) {
              return fixture.fs.makeDirectory(directory, options);
            }
            swapped = true;
            return fixture.fs
              .makeDirectory(directory, options)
              .pipe(
                Effect.andThen(fixture.fs.remove(directory, {recursive: true})),
                Effect.andThen(fixture.fs.symlink(outside, directory)),
              );
          },
        });

        const failure = yield* quarantinePrivateDeferredCodeAnchorRouteEntry(
          racingFileSystem,
          fixture.path,
          poison,
          sourceAncestors,
          queueAncestors,
        ).pipe(Effect.flip);

        expect(String(failure)).toContain('must not be a link');
        expect(swapped).toBe(true);
        expect((yield* fixture.fs.stat(outside)).mode & 0o777).toBe(0o755);
        expect(yield* fixture.fs.readFileString(fixture.path.join(outside, 'sentinel.txt'))).toBe('outside\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not mutate a symlink target swapped in after private-file publication', () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        const fixture = yield* makeFixture();
        const parent = fixture.path.join(fixture.config.agentContextHome, 'private-write-parent');
        const target = fixture.path.join(parent, 'intent.json');
        const displaced = fixture.path.join(parent, 'displaced.json');
        const outside = fixture.path.join(fixture.config.agentContextHome, 'outside-write-target.json');
        yield* fixture.fs.makeDirectory(parent, {mode: 0o700});
        yield* fixture.fs.writeFileString(outside, 'outside\n', {mode: 0o644});
        yield* fixture.fs.chmod(outside, 0o644);
        let swapped = false;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          readLink: path => {
            if (path !== target || swapped) return fixture.fs.readLink(path);
            swapped = true;
            return fixture.fs
              .rename(target, displaced)
              .pipe(Effect.andThen(fixture.fs.symlink(outside, target)), Effect.andThen(fixture.fs.readLink(target)));
          },
        });

        const failure = yield* writePrivateDeferredCodeAnchorFile(
          racingFileSystem,
          fixture.path,
          target,
          'private\n',
          'race fixture',
          [parent],
        ).pipe(Effect.flip);

        expect(String(failure)).toContain('must not be a symbolic link');
        expect(swapped).toBe(true);
        expect((yield* fixture.fs.stat(outside)).mode & 0o777).toBe(0o644);
        expect(yield* fixture.fs.readFileString(outside)).toBe('outside\n');
        expect(yield* fixture.fs.readFileString(displaced)).toBe('private\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('takes the absent-route fast path without graph or canonical reads', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/pending.ts']),
        });
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.outbox, `${'0'.repeat(64)}-tnca_corrupt.json`),
          '{not-json}\n',
          {mode: 0o600},
        );

        let graphReads = 0;
        let intentOpens = 0;
        let memoryReads = 0;
        const query = yield* CodeGraphQueryService;
        const store = yield* ResourceStore;
        const unreadableQuery = CodeGraphQueryService.of({
          ...query,
          status: () =>
            Effect.sync(() => {
              graphReads += 1;
              throw new Error('unexpected graph read');
            }),
        });
        const unreadableStore = ResourceStore.of({
          ...store,
          read: (location, uri) =>
            Effect.sync(() => {
              memoryReads += 1;
              return undefined;
            }).pipe(Effect.andThen(store.read(location, uri))),
        });
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (target, options) => {
            if (target.endsWith('.json')) intentOpens += 1;
            return fixture.fs.open(target, options);
          },
        });
        const receipt = yield* finalizeDeferredCodeAnchorsForRoute(
          fixture.config,
          {
            callerCwd: fixture.repository,
            kind: 'repository',
            repositoryId: 'f'.repeat(64),
            worktreeId: 'e'.repeat(64),
          },
          {limit: 1},
        ).pipe(
          Effect.provideService(CodeGraphQueryService, unreadableQuery),
          Effect.provideService(FileSystem.FileSystem, observedFileSystem),
          Effect.provideService(ResourceStore, unreadableStore),
        );

        expect(receipt).toEqual({
          conflictCount: 0,
          failedCount: 0,
          finalizedCount: 0,
          matchedCount: 0,
          pendingCount: 0,
          scannedCount: 0,
          state: 'completed',
          type: 'threadnote-deferred-code-anchor-route-finalization',
          version: 1,
        });
        expect(graphReads).toBe(0);
        expect(intentOpens).toBe(0);
        expect(memoryReads).toBe(0);
        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(
            fixture.config,
            {kind: 'workset', name: 'test'},
            {waitTimeoutMilliseconds: 5_001},
          ),
        ).toMatchObject({state: 'failed', scannedCount: 0});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('routes exact workset and repository identities while retaining legacy v1 intent filenames', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending workset revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredWorksetRequest(fixture.repository, ['src/workset.ts'], 'platform'),
        });
        const [intentPath] = yield* fixtureIntentPaths(fixture);
        const name = fixture.path.basename(intentPath);
        expect(name).toMatch(/^[a-f0-9]{32}-tnca_[a-f0-9]{32}-b[a-f0-9]{32}\.json$/u);
        expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(131);
        const representativeWindowsOutbox =
          'C:\\Users\\threadnote\\AppData\\Local\\threadnote\\data\\local\\user\\tester\\private\\deferred-code-anchors\\v1\\i\\u' +
          'a'.repeat(32) +
          '\\';
        expect(new TextEncoder().encode(`${representativeWindowsOutbox}${name}`).byteLength).toBeLessThanOrEqual(260);
        expect(name).not.toContain('platform');
        expect(name).not.toContain('src/workset.ts');
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        const repositoryRoute: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: fixture.repository,
          kind: 'repository',
          repositoryId: intent.repositoryId,
          worktreeId: intent.worktreeId,
        };

        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, {kind: 'workset', name: 'other'}),
        ).toMatchObject({matchedCount: 0, scannedCount: 0, state: 'completed'});

        const digest = yield* sha256Hex(MEMORY_URI);
        yield* fixture.fs.rename(intentPath, fixture.path.join(fixture.outbox, `${digest}.json`));
        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(
            fixture.config,
            {kind: 'workset', name: 'platform'},
            {passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS},
          ),
        ).toMatchObject({
          conflictCount: 1,
          matchedCount: 1,
          scannedCount: 1,
          state: 'completed',
        });
        expect(yield* fixtureIntentPaths(fixture)).toEqual([]);

        const repositoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/deferred-repository.md';
        const repositoryMetadata = {
          ...fixture.metadata,
          memoryId: 'tn_deferred_repository',
          topic: 'deferred-repository',
        };
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(repositoryMetadata, 'Pending repository revision.'),
          memoryMetadata: repositoryMetadata,
          memoryUri: repositoryUri,
          request: deferredWorksetRequest(fixture.repository, ['src/repository.ts'], 'platform'),
        });
        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, repositoryRoute, {
            passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS,
          }),
        ).toMatchObject({conflictCount: 1, matchedCount: 1, scannedCount: 1, state: 'completed'});

        const qualifiedUri = 'threadnote://user/tester/memories/durable/projects/threadnote/deferred-qualified.md';
        const qualifiedMetadata = {
          ...fixture.metadata,
          memoryId: 'tn_deferred_qualified',
          topic: 'deferred-qualified',
        };
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(qualifiedMetadata, 'Pending qualified revision.'),
          memoryMetadata: qualifiedMetadata,
          memoryUri: qualifiedUri,
          request: deferredRequest(fixture.repository, [`cgr_${'a'.repeat(40)}`]),
        });
        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(
            fixture.config,
            {kind: 'workset', name: 'another-workset'},
            {passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS},
          ),
        ).toMatchObject({conflictCount: 1, matchedCount: 1, scannedCount: 1, state: 'completed'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('prioritizes a requested backlink while rotating the bounded route window', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const store = yield* ResourceStore;
        for (let index = 0; index < 3; index += 1) {
          const uri = `threadnote://user/tester/memories/durable/projects/threadnote/deferred-${index}.md`;
          const metadata = {...fixture.metadata, memoryId: `tn_deferred_${index}`, topic: `deferred-${index}`};
          const content = memoryContent(metadata, `Pending revision ${index}.`);
          yield* stageDeferredCodeAnchorIntent(fixture.config, {
            memoryContent: content,
            memoryMetadata: metadata,
            memoryUri: uri,
            request: deferredRequest(fixture.repository, [`src/pending-${index}.ts`]),
          });
          yield* store.write(resourceStoreLocation(fixture.config), uri, content, {mode: 'create'});
        }

        const addressed = yield* Effect.forEach(yield* fixtureIntentPaths(fixture), intentPath =>
          fixture.fs.readFileString(intentPath).pipe(
            Effect.map(content => ({
              intent: JSON.parse(content) as {
                codeRefs: string[];
                memoryUri: string;
                repositoryId: string;
                worktreeId: string;
              },
              name: fixture.path.basename(intentPath),
            })),
          ),
        );
        const preferred = addressed[addressed.length - 1].intent;
        const route: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: fixture.repository,
          kind: 'repository',
          repositoryId: preferred.repositoryId,
          worktreeId: preferred.worktreeId,
        };
        const observedReads: string[] = [];
        const instrumentedStore = ResourceStore.of({
          ...store,
          read: (location, uri) =>
            Effect.sync(() => {
              if (uri.includes('/deferred-')) observedReads.push(uri);
            }).pipe(Effect.andThen(store.read(location, uri))),
        });
        const run = (preferredCodeRefs: readonly string[] = []) =>
          finalizeDeferredCodeAnchorsForRoute(fixture.config, route, {
            limit: 1,
            passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS,
            preferredCodeRefs,
          }).pipe(Effect.provideService(ResourceStore, instrumentedStore));

        expect(yield* run(preferred.codeRefs)).toMatchObject({
          matchedCount: 3,
          pendingCount: 1,
          scannedCount: 1,
          state: 'contended',
        });
        expect(observedReads[0]).toBe(preferred.memoryUri);
        for (let opportunity = 0; opportunity < 12; opportunity += 1) {
          expect(yield* run()).toMatchObject({pendingCount: 1, scannedCount: 1, state: 'contended'});
        }
        expect(new Set(observedReads.slice(1))).toEqual(new Set(addressed.map(entry => entry.intent.memoryUri)));
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('bounds routed intent opens while promoting a requested backlink outside the fair window', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const store = yield* ResourceStore;
        for (let index = 0; index < 12; index += 1) {
          const uri = `threadnote://user/tester/memories/durable/projects/threadnote/deferred-bounded-${index}.md`;
          const metadata = {
            ...fixture.metadata,
            memoryId: `tn_deferred_bounded_${index}`,
            topic: `deferred-bounded-${index}`,
          };
          yield* stageDeferredCodeAnchorIntent(fixture.config, {
            memoryContent: memoryContent(metadata, `Pending bounded revision ${index}.`),
            memoryMetadata: metadata,
            memoryUri: uri,
            request: deferredRequest(fixture.repository, [`src/bounded-${index}.ts`]),
          });
        }

        const addressed = yield* Effect.forEach(yield* fixtureIntentPaths(fixture), intentPath =>
          fixture.fs.readFileString(intentPath).pipe(
            Effect.map(
              content =>
                JSON.parse(content) as {
                  codeRefs: string[];
                  memoryUri: string;
                  repositoryId: string;
                  worktreeId: string;
                },
            ),
          ),
        );
        const preferred = addressed[4];
        const route: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: fixture.repository,
          kind: 'repository',
          repositoryId: preferred.repositoryId,
          worktreeId: preferred.worktreeId,
        };
        let intentOpens = 0;
        const observedReads: string[] = [];
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (target, options) => {
            if (target.endsWith('.json')) intentOpens += 1;
            return fixture.fs.open(target, options);
          },
        });
        const observedStore = ResourceStore.of({
          ...store,
          read: (location, uri) =>
            Effect.sync(() => {
              if (uri.includes('/deferred-bounded-')) observedReads.push(uri);
            }).pipe(Effect.andThen(store.read(location, uri))),
        });

        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, route, {
            limit: 1,
            passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS,
            preferredCodeRefs: preferred.codeRefs,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, observedFileSystem),
            Effect.provideService(ResourceStore, observedStore),
          ),
        ).toMatchObject({conflictCount: 1, scannedCount: 1, state: 'contended'});
        expect(observedReads[0]).toBe(preferred.memoryUri);
        expect(intentOpens).toBeLessThanOrEqual(16);
        expect(intentOpens).toBeLessThan(24);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('returns a contended receipt when another process-shaped route pass owns the lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const store = yield* ResourceStore;
        const content = memoryContent(fixture.metadata, 'Pending revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/pending.ts']),
        });
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const [intentPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        const route: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: fixture.repository,
          kind: 'repository',
          repositoryId: intent.repositoryId,
          worktreeId: intent.worktreeId,
        };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blockingStore = ResourceStore.of({
          ...store,
          read: (location, uri) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(store.read(location, uri)),
            ),
        });
        const owner = yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, route, {
          passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS,
        }).pipe(Effect.provideService(ResourceStore, blockingStore), Effect.forkScoped);
        yield* Deferred.await(entered);

        expect(yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, route)).toMatchObject({
          matchedCount: 1,
          scannedCount: 0,
          state: 'contended',
        });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(owner)).toMatchObject({pendingCount: 1, scannedCount: 1, state: 'contended'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('interrupts the complete opportunistic pass at its total deadline without losing the intent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture().pipe(TestClock.withLive);
        const store = yield* ResourceStore;
        const content = memoryContent(fixture.metadata, 'Pending deadline revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/deadline.ts']),
        });
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const [intentPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        const entered = yield* Deferred.make<void>();
        const blockedStore = ResourceStore.of({
          ...store,
          read: (location, uri) =>
            uri === MEMORY_URI
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.andThen(store.read(location, uri)),
                )
              : store.read(location, uri),
        });
        const attemptedUris: string[] = [];
        const fiber = yield* finalizeDeferredCodeAnchorsForRoute(
          fixture.config,
          {
            callerCwd: fixture.repository,
            kind: 'repository',
            repositoryId: intent.repositoryId,
            worktreeId: intent.worktreeId,
          },
          {
            limit: 1,
            onAttemptedUri: uri => {
              attemptedUris.push(uri);
            },
            passTimeoutMilliseconds: 100,
          },
        ).pipe(Effect.provideService(ResourceStore, blockedStore), Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust('100 millis');

        expect(yield* Fiber.join(fiber)).toMatchObject({
          matchedCount: 1,
          scannedCount: 0,
          state: 'contended',
        });
        expect(attemptedUris).toEqual([MEMORY_URI]);
        expect(yield* fixtureIntentPaths(fixture)).toHaveLength(1);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reconciles a canonical citation commit interrupted by the opportunistic pass deadline', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture().pipe(TestClock.withLive);
        yield* fixture.fs.makeDirectory(fixture.path.join(fixture.repository, 'src'));
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.repository, 'src', 'deadline.ts'),
          'export const deadline = "committed";\n',
        );
        yield* runCommandEffect('git', ['add', '.'], {cwd: fixture.repository}).pipe(TestClock.withLive);
        yield* runCommandEffect(
          'git',
          [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '--quiet',
            '--message',
            'add deadline fixture',
          ],
          {cwd: fixture.repository},
        ).pipe(TestClock.withLive);
        const store = yield* ResourceStore;
        const indexer = yield* CodeGraphIndexer;
        // Publish first so wrap-heal cannot consume the later-staged intent.
        yield* indexer
          .index({cwd: fixture.repository, ensureVectors: false, threadnoteHome: fixture.config.agentContextHome})
          .pipe(TestClock.withLive);
        const content = memoryContent(fixture.metadata, 'Committed before the foreground deadline.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/deadline.ts']),
        });
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const [intentPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        const committed = yield* Deferred.make<void>();
        const postCommitStore = ResourceStore.of({
          ...store,
          write: (location, uri, value, options) =>
            uri === MEMORY_URI
              ? store.write(location, uri, value, options).pipe(
                  Effect.tap(() => Deferred.succeed(committed, undefined)),
                  Effect.andThen(Effect.never),
                )
              : store.write(location, uri, value, options),
        });
        const fiber = yield* finalizeDeferredCodeAnchorsForRoute(
          fixture.config,
          {
            callerCwd: fixture.repository,
            kind: 'repository',
            repositoryId: intent.repositoryId,
            worktreeId: intent.worktreeId,
          },
          {limit: 1, passTimeoutMilliseconds: 100},
        ).pipe(Effect.provideService(ResourceStore, postCommitStore), Effect.forkScoped);
        yield* Deferred.await(committed);
        yield* TestClock.adjust('100 millis');

        expect(yield* Fiber.join(fiber)).toMatchObject({matchedCount: 1, scannedCount: 0, state: 'contended'});
        expect(yield* fixtureIntentPaths(fixture)).toEqual([]);
        const finalized = parseMemoryDocument(
          MEMORY_URI,
          yield* store.read(resourceStoreLocation(fixture.config), MEMORY_URI),
        );
        expect(finalized?.metadata).toMatchObject({
          codeCitations: [{path: 'src/deadline.ts'}],
          memoryId: fixture.metadata.memoryId,
          status: fixture.metadata.status,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('cleans a crash-orphaned opaque route marker without deriving intent deletion authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Orphaned before canonical commit.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/orphan.ts']),
        });
        const [intentPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        yield* fixture.fs.remove(intentPath, {force: true});
        const markersBefore = (yield* fixture.fs.readDirectory(fixture.outbox, {recursive: true})).filter(name =>
          name.endsWith('.ref'),
        );
        expect(markersBefore.length).toBeGreaterThan(0);

        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(
            fixture.config,
            {
              callerCwd: fixture.repository,
              kind: 'repository',
              repositoryId: intent.repositoryId,
              worktreeId: intent.worktreeId,
            },
            {preferredCodeRefs: ['src/orphan.ts']},
          ),
        ).toMatchObject({matchedCount: 0, scannedCount: 0, state: 'completed'});
        expect(
          (yield* fixture.fs.readDirectory(fixture.outbox, {recursive: true})).filter(name => name.endsWith('.ref')),
        ).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('cleans poisoned marker pages without deleting an address-mismatched canonical intent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending behind a poisoned marker page.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/later-page.ts']),
        });
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        const pendingContent = yield* fixture.fs.readFileString(pendingPath);
        const intent = JSON.parse(pendingContent) as {repositoryId: string; worktreeId: string};
        const markerPath = yield* fixtureRepositoryRouteMarkerPath(fixture);
        const laneRoot = fixture.path.dirname(markerPath);
        const stagedMarker = fixture.path.join(fixture.config.agentContextHome, 'staged-valid-route-marker.ref');
        yield* fixture.fs.rename(markerPath, stagedMarker);
        yield* fixture.fs.remove(laneRoot, {recursive: true});
        yield* fixture.fs.makeDirectory(laneRoot, {mode: 0o700});
        const mismatchedName = `${'0'.repeat(32)}-tnca_${'0'.repeat(32)}-b${'0'.repeat(32)}`;
        const mismatchedDirectory = fixture.path.join(fixture.outbox, 'i', `u${'0'.repeat(32)}`);
        const mismatchedIntentPath = fixture.path.join(mismatchedDirectory, `${mismatchedName}.json`);
        const mismatchedMarkerPath = fixture.path.join(laneRoot, `${mismatchedName}.ref`);
        yield* fixture.fs.makeDirectory(mismatchedDirectory, {recursive: true, mode: 0o700});
        yield* fixture.fs.writeFileString(mismatchedIntentPath, pendingContent, {mode: 0o600});
        yield* fixture.fs.makeDirectory(mismatchedMarkerPath, {mode: 0o700});
        yield* fixture.fs.writeFileString(
          fixture.path.join(mismatchedMarkerPath, 'address-shaped-sentinel.txt'),
          'address-shaped-sentinel\n',
          {mode: 0o600},
        );
        const unexpectedEntry = fixture.path.join(laneRoot, '000-unexpected-entry');
        const poisonedMarkers = [mismatchedMarkerPath, unexpectedEntry];
        yield* fixture.fs.writeFileString(unexpectedEntry, 'unexpected\n', {mode: 0o600});
        const nonPrivateMarker = fixture.path.join(laneRoot, '001-non-private.ref');
        poisonedMarkers.push(nonPrivateMarker);
        yield* fixture.fs.writeFileString(nonPrivateMarker, 'non-private-marker\n', {mode: 0o600});
        if (process.platform !== 'win32') yield* fixture.fs.chmod(nonPrivateMarker, 0o644);
        const invalidDirectory = fixture.path.join(laneRoot, '002-invalid-directory.ref');
        poisonedMarkers.push(invalidDirectory);
        yield* fixture.fs.makeDirectory(invalidDirectory, {mode: 0o700});
        yield* fixture.fs.writeFileString(
          fixture.path.join(invalidDirectory, 'non-address-shaped-sentinel.txt'),
          'non-address-shaped-sentinel\n',
          {mode: 0o600},
        );
        const outsideSentinel = fixture.path.join(fixture.config.agentContextHome, 'outside-route-entry-sentinel.txt');
        yield* fixture.fs.writeFileString(outsideSentinel, 'outside-route-entry-sentinel\n', {mode: 0o600});
        const symlinkMarker = fixture.path.join(laneRoot, '003-invalid-symlink.ref');
        poisonedMarkers.push(symlinkMarker);
        yield* fixture.fs.symlink(outsideSentinel, symlinkMarker);
        if (process.platform !== 'win32') {
          const fifoMarker = fixture.path.join(laneRoot, '004-invalid-fifo.ref');
          poisonedMarkers.push(fifoMarker);
          yield* runCommandEffect('mkfifo', [fifoMarker]);
        }
        for (let index = 0; index < 8; index += 1) {
          poisonedMarkers.push(fixture.path.join(laneRoot, `0bad-${index}.ref`));
          yield* fixture.fs.writeFileString(fixture.path.join(laneRoot, `0bad-${index}.ref`), '1\n', {mode: 0o600});
        }
        yield* fixture.fs.rename(stagedMarker, markerPath);
        const route: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: fixture.repository,
          kind: 'repository',
          repositoryId: intent.repositoryId,
          worktreeId: intent.worktreeId,
        };

        const receipts = [];
        for (let opportunity = 0; opportunity < 8; opportunity += 1) {
          receipts.push(yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, route, {limit: 1}));
          if (
            !(yield* fixture.fs.exists(pendingPath)) &&
            !(yield* fixture.fs.exists(mismatchedMarkerPath)) &&
            !(yield* Effect.forEach(poisonedMarkers, marker => fixture.fs.exists(marker), {concurrency: 4})).some(
              Boolean,
            )
          ) {
            break;
          }
        }
        expect(receipts.some(receipt => receipt.conflictCount === 1 && receipt.scannedCount === 1)).toBe(true);
        expect(receipts.some(receipt => receipt.state === 'contended')).toBe(true);
        expect(receipts.every(receipt => receipt.state !== 'failed')).toBe(true);
        expect(yield* fixture.fs.readFileString(mismatchedIntentPath)).toBe(pendingContent);
        expect(yield* fixture.fs.readFileString(outsideSentinel)).toBe('outside-route-entry-sentinel\n');
        expect(yield* fixture.fs.exists(mismatchedMarkerPath)).toBe(false);
        expect(
          (yield* Effect.forEach(poisonedMarkers, marker => fixture.fs.exists(marker), {concurrency: 4})).some(Boolean),
        ).toBe(false);
        expect(yield* fixture.fs.exists(pendingPath)).toBe(false);
        const quarantineRoot = fixture.path.join(fixture.path.dirname(laneRoot), '.quarantine-v1');
        const quarantined = yield* fixture.fs.readDirectory(quarantineRoot, {recursive: true});
        expect(quarantined.filter(entry => fixture.path.basename(entry) === 'entry')).toHaveLength(
          poisonedMarkers.length,
        );
        expect(quarantined.some(entry => entry.includes('0bad-'))).toBe(false);
        const addressSentinel = quarantined.find(
          entry => fixture.path.basename(entry) === 'address-shaped-sentinel.txt',
        );
        const nonAddressSentinel = quarantined.find(
          entry => fixture.path.basename(entry) === 'non-address-shaped-sentinel.txt',
        );
        expect(yield* fixture.fs.readFileString(fixture.path.join(quarantineRoot, addressSentinel!))).toBe(
          'address-shaped-sentinel\n',
        );
        expect(yield* fixture.fs.readFileString(fixture.path.join(quarantineRoot, nonAddressSentinel!))).toBe(
          'non-address-shaped-sentinel\n',
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('continues from a poisoned route lane to later valid work in the same protected pass', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending in a later route lane.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/later-lane.ts']),
        });
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        const markerPath = yield* fixtureRepositoryRouteMarkerPath(fixture);
        const laneRoot = fixture.path.dirname(markerPath);
        const laterLane = fixture.path.join(fixture.path.dirname(laneRoot), '7');
        yield* fixture.fs.makeDirectory(laterLane, {mode: 0o700});
        yield* fixture.fs.rename(markerPath, fixture.path.join(laterLane, fixture.path.basename(markerPath)));
        const poisonedMarker = fixture.path.join(laneRoot, '000-poison.ref');
        yield* fixture.fs.writeFileString(poisonedMarker, '1\n', {mode: 0o600});

        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, {
            callerCwd: fixture.repository,
            kind: 'repository',
            repositoryId: intent.repositoryId,
            worktreeId: intent.worktreeId,
          }),
        ).toMatchObject({conflictCount: 1, matchedCount: 1, scannedCount: 1, state: 'completed'});
        expect(yield* fixture.fs.exists(poisonedMarker)).toBe(false);
        expect(yield* fixture.fs.exists(pendingPath)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reports a malformed private intent instead of silently skipping it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.makeDirectory(fixture.outbox, {recursive: true, mode: 0o700});
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.outbox, `${'a'.repeat(64)}-tnca_corrupt.json`),
          '{not-json}\n',
          {mode: 0o600},
        );

        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toEqual({
          detail:
            '1 malformed or unreadable private intent(s); run `threadnote finalize-code-refs` for a bounded failure receipt',
          name: 'deferred code anchors',
          status: 'fail',
        });

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          conflictCount: 0,
          failedCount: 1,
          finalizedCount: 0,
          items: [
            {
              code: 'invalid-intent',
              reason: 'Private deferred code-anchor intent is unreadable or malformed.',
              state: 'failed',
            },
          ],
          pendingCount: 0,
          scannedCount: 1,
        });
        expect(receipt.items[0]).not.toHaveProperty('memoryUri');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps a valid intent when canonical memory observation fails transiently', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/pending.ts']),
        });
        const store = yield* ResourceStore;
        const failingStore = ResourceStore.of({
          ...store,
          read: (_location, uri) =>
            Effect.fail(
              ResourceIoFailed.make({
                cause: new Error('synthetic transient failure'),
                message: 'synthetic transient failure',
                operation: 'read',
                uri,
              }),
            ),
        });

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(ResourceStore, failingStore),
        );
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [
            {
              code: 'finalization-error',
              memoryUri: MEMORY_URI,
              reason: 'Deferred code-anchor finalization failed safely; retry or run threadnote doctor --dry-run.',
              state: 'failed',
            },
          ],
          scannedCount: 1,
        });
        expect(yield* fixtureIntentPaths(fixture)).toHaveLength(1);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps model-facing capture failures free of private locators and checkout paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const privateLocator = 'cgs_private_locator_that_must_not_escape';
        const content = memoryContent(fixture.metadata, 'Pending revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, [privateLocator]),
        });
        const store = yield* ResourceStore;
        yield* store.write(
          {
            account: fixture.config.account,
            home: fixture.config.agentContextHome,
            user: fixture.config.user,
          },
          MEMORY_URI,
          content,
          {mode: 'create'},
        );

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);

        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [
            {
              code: 'citation-capture-failed',
              memoryUri: MEMORY_URI,
              reason: 'Code citation capture failed safely; retry or run threadnote doctor --dry-run.',
              state: 'failed',
            },
          ],
        });
        expect(JSON.stringify(receipt)).not.toContain(privateLocator);
        expect(JSON.stringify(receipt)).not.toContain(fixture.repository);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('discards a missing caller checkout without rebinding or citing the memory', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const content = memoryContent(fixture.metadata, 'Pending deleted worktree revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/deleted-worktree.ts']),
        });
        const store = yield* ResourceStore;
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const [intentPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        yield* fixture.fs.remove(fixture.repository, {recursive: true});

        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, {
            callerCwd: fixture.repository,
            kind: 'repository',
            repositoryId: intent.repositoryId,
            worktreeId: 'c'.repeat(64),
          }),
        ).toMatchObject({matchedCount: 0, scannedCount: 0, state: 'completed'});
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(true);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({status: 'warn'});

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          conflictCount: 1,
          failedCount: 0,
          pendingCount: 0,
          items: [
            {
              memoryUri: MEMORY_URI,
              reason: 'caller-checkout-missing',
              state: 'conflict',
            },
          ],
        });
        expect(JSON.stringify(receipt)).not.toContain('src/deleted-worktree.ts');
        expect(JSON.stringify(receipt)).not.toContain(fixture.repository);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(false);
        const deleted = parseMemoryDocument(
          MEMORY_URI,
          yield* store.read(resourceStoreLocation(fixture.config), MEMORY_URI),
        );
        expect(deleted).toMatchObject({
          body: 'Pending deleted worktree revision.',
          metadata: {memoryId: fixture.metadata.memoryId, status: 'active'},
        });
        expect(deleted?.metadata.codeCitations?.length ?? 0).toBe(0);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({
          detail: 'no pending private code-anchor intents',
          status: 'ok',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps doctor attribution warning-only when caller checkout observation fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending inaccessible worktree revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/inaccessible-worktree.ts']),
        });
        const unavailableCheckoutFs = FileSystem.FileSystem.of({
          ...fixture.fs,
          exists: target =>
            target === fixture.repository
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    description: 'permission denied',
                    method: 'exists',
                    module: 'FileSystem',
                    pathOrDescriptor: target,
                  }),
                )
              : fixture.fs.exists(target),
        });

        expect(
          yield* deferredCodeAnchorDoctorCheck(fixture.config).pipe(
            Effect.provideService(FileSystem.FileSystem, unavailableCheckoutFs),
          ),
        ).toMatchObject({
          detail: expect.stringMatching(/checkout unobserved\/read failure$/),
          status: 'warn',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('discards a present checkout whose repository identity changed, not as a deleted cwd', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const content = memoryContent(fixture.metadata, 'Pending identity-mismatch revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/identity-changed.ts']),
        });
        const store = yield* ResourceStore;
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const originalQuery = yield* CodeGraphQueryService;
        const observed = yield* originalQuery.status(fixture.config.agentContextHome, fixture.repository, {
          observeWorktree: true,
          requestMaintenance: false,
        });
        const mismatchedQuery = CodeGraphQueryService.of({
          ...originalQuery,
          status: () =>
            Effect.succeed({
              ...observed,
              identity: {...observed.identity, worktreeId: 'f'.repeat(64)},
            }),
        });

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(CodeGraphQueryService, mismatchedQuery),
        );
        expect(receipt).toMatchObject({
          conflictCount: 1,
          failedCount: 0,
          pendingCount: 0,
          items: [
            {
              memoryUri: MEMORY_URI,
              reason: 'caller-repository-identity-changed',
              state: 'conflict',
            },
          ],
        });
        expect(receipt.items[0]?.reason).not.toBe('caller-checkout-missing');
        expect(yield* fixture.fs.exists(fixture.repository)).toBe(true);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(false);
        expect(
          parseMemoryDocument(MEMORY_URI, yield* store.read(resourceStoreLocation(fixture.config), MEMORY_URI))
            ?.metadata.codeCitations?.length ?? 0,
        ).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps a retryable exact-current-graph gap pending instead of discarding it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const content = memoryContent(fixture.metadata, 'Pending graph-readiness revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/pending-index.ts']),
        });
        const store = yield* ResourceStore;
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const originalQuery = yield* CodeGraphQueryService;
        const observed = yield* originalQuery.status(fixture.config.agentContextHome, fixture.repository, {
          observeWorktree: true,
          requestMaintenance: false,
        });
        const unreadinessQuery = CodeGraphQueryService.of({
          ...originalQuery,
          status: () =>
            Effect.succeed({
              ...observed,
              freshness: 'stale' as const,
              readySnapshot: undefined,
              stale: true,
            }),
        });

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(CodeGraphQueryService, unreadinessQuery),
        );
        expect(receipt).toMatchObject({
          conflictCount: 0,
          pendingCount: 1,
          items: [
            {
              memoryUri: MEMORY_URI,
              recoveryAction: 'prepare-current-graph',
              retryable: true,
              state: 'pending',
            },
          ],
        });
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(true);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({status: 'warn'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('finalizes the still-present exact-current subset and discards the unresolved remainder', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const presentPath = 'src/present.ts';
        const missingPath = 'src/deleted-feature.ts';
        const source = 'export const present = true;\n';
        yield* fixture.fs.makeDirectory(fixture.path.join(fixture.repository, 'src'), {recursive: true});
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, presentPath), source);
        const content = memoryContent(fixture.metadata, 'Pending subset revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, [presentPath, missingPath]),
        });
        const store = yield* ResourceStore;
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const graph = yield* exactCurrentCitationGraph(fixture, [
          inventoryFile(presentPath, source, fixture.path.join(fixture.repository, presentPath)),
        ]);

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(CodeGraphQueryService, graph.query),
          Effect.provideService(CodeGraphStore, graph.store),
        );
        expect(receipt).toMatchObject({
          conflictCount: 0,
          failedCount: 0,
          finalizedCount: 1,
          pendingCount: 0,
          items: [{citationCount: 1, memoryUri: MEMORY_URI, state: 'finalized'}],
        });
        expect(JSON.stringify(receipt)).not.toContain(missingPath);
        expect(JSON.stringify(receipt)).not.toContain(fixture.repository);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(false);
        expect(
          parseMemoryDocument(MEMORY_URI, yield* store.read(resourceStoreLocation(fixture.config), MEMORY_URI)),
        ).toMatchObject({
          body: 'Pending subset revision.',
          metadata: {
            codeCitations: [expect.objectContaining({path: presentPath, target: {kind: 'file'}})],
            memoryId: fixture.metadata.memoryId,
            status: 'active',
          },
        });
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({status: 'ok'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('classifies exact-graph locator misses with privacy-safe correction guidance', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const privateLocator = '.github/workflows/private-release.yml';
        const content = memoryContent(fixture.metadata, 'Pending correction revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, [privateLocator]),
        });
        const store = yield* ResourceStore;
        yield* store.write(resourceStoreLocation(fixture.config), MEMORY_URI, content, {mode: 'create'});
        const graph = yield* exactCurrentCitationGraph(fixture, []);

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(CodeGraphQueryService, graph.query),
          Effect.provideService(CodeGraphStore, graph.store),
        );

        expect(receipt).toMatchObject({
          conflictCount: 1,
          failedCount: 0,
          pendingCount: 0,
          items: [
            {
              memoryUri: MEMORY_URI,
              reason: 'code-references-absent',
              state: 'conflict',
            },
          ],
        });
        expect(receipt.items[0]).not.toHaveProperty('recoveryAction');
        expect(JSON.stringify(receipt)).not.toContain(privateLocator);
        expect(JSON.stringify(receipt)).not.toContain(fixture.repository);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(false);
        expect(
          parseMemoryDocument(MEMORY_URI, yield* store.read(resourceStoreLocation(fixture.config), MEMORY_URI))
            ?.metadata.codeCitations?.length ?? 0,
        ).toBe(0);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({status: 'ok'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rotates bounded scans so an early permanent failure cannot starve later intents', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/later.ts']),
        });
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.outbox, `${'0'.repeat(64)}.json`), '{not-json}\n', {
          mode: 0o600,
        });

        expect(yield* finalizeDeferredCodeAnchors(fixture.config, {limit: 1})).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
        expect(yield* finalizeDeferredCodeAnchors(fixture.config, {limit: 1})).toMatchObject({
          conflictCount: 1,
          items: [{memoryUri: MEMORY_URI, reason: 'canonical-memory-missing', state: 'conflict'}],
          scannedCount: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('quarantines a poisoned legacy prefix so bounded automatic recovery reaches later intents', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.makeDirectory(fixture.outbox, {recursive: true, mode: 0o700});
        for (let index = 0; index < 48; index += 1) {
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.outbox, `${index.toString(16).padStart(64, '0')}-poison.json`),
            '{not-json}\n',
            {mode: 0o600},
          );
        }
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending after poisoned legacy prefix.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/after-poison.ts']),
        });
        const [intentPath] = (yield* fixtureIntentPaths(fixture)).filter(path =>
          path.includes(`${fixture.path.sep}i${fixture.path.sep}`),
        );
        const intent = JSON.parse(yield* fixture.fs.readFileString(intentPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        yield* fixture.fs.rename(intentPath, fixture.path.join(fixture.outbox, `${yield* sha256Hex(MEMORY_URI)}.json`));
        const route: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: fixture.repository,
          kind: 'repository',
          repositoryId: intent.repositoryId,
          worktreeId: intent.worktreeId,
        };

        let recovered = false;
        for (let attempt = 0; attempt < 4 && !recovered; attempt += 1) {
          const receipt = yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, route, {
            limit: 1,
            passTimeoutMilliseconds: TEST_ROUTE_PASS_TIMEOUT_MILLISECONDS,
          });
          recovered = receipt.conflictCount === 1;
        }

        expect(recovered).toBe(true);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(false);
        const quarantined = (yield* fixture.fs.readDirectory(fixture.outbox, {recursive: true})).filter(name =>
          name.endsWith(`${fixture.path.sep}entry`),
        );
        expect(quarantined).toHaveLength(48);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toMatchObject({status: 'fail'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('fails closed without following symlinked item ancestors during publication lookup or cleanup', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const boundary of ['i', 'u'] as const) {
          const fixture = yield* makeFixture();
          yield* stageDeferredCodeAnchorIntent(fixture.config, {
            memoryContent: memoryContent(fixture.metadata, `Pending ${boundary} symlink revision.`),
            memoryMetadata: fixture.metadata,
            memoryUri: MEMORY_URI,
            request: deferredRequest(fixture.repository, [`src/${boundary}-ancestor-link.ts`]),
          });
          const [pendingPath] = yield* fixtureIntentPaths(fixture);
          const itemRoot = fixture.path.join(fixture.outbox, 'i');
          const ancestor = boundary === 'i' ? itemRoot : fixture.path.dirname(pendingPath);
          const outside = fixture.path.join(fixture.config.agentContextHome, `outside-${boundary}-items`);
          yield* fixture.fs.rename(ancestor, outside);
          const sentinel = fixture.path.join(outside, 'outside-sentinel.txt');
          yield* fixture.fs.writeFileString(sentinel, `${boundary}-sentinel\n`, {mode: 0o600});
          yield* fixture.fs.symlink(outside, ancestor);

          const lookupFailure = yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI).pipe(Effect.flip);
          expect(String(lookupFailure)).toContain('private directory must not be a link');
          const cleanupFailure = yield* discardDeferredCodeAnchorIntent(fixture.config, MEMORY_URI).pipe(Effect.flip);
          expect(String(cleanupFailure)).toContain('private directory must not be a link');
          expect(yield* fixture.fs.readFileString(sentinel)).toBe(`${boundary}-sentinel\n`);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('fails closed without deleting through non-private item ancestors', () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (process.platform === 'win32') return;
        for (const boundary of ['i', 'u'] as const) {
          const fixture = yield* makeFixture();
          yield* stageDeferredCodeAnchorIntent(fixture.config, {
            memoryContent: memoryContent(fixture.metadata, `Pending ${boundary} mode revision.`),
            memoryMetadata: fixture.metadata,
            memoryUri: MEMORY_URI,
            request: deferredRequest(fixture.repository, [`src/${boundary}-ancestor-mode.ts`]),
          });
          const [pendingPath] = yield* fixtureIntentPaths(fixture);
          const itemRoot = fixture.path.join(fixture.outbox, 'i');
          const ancestor = boundary === 'i' ? itemRoot : fixture.path.dirname(pendingPath);
          const sentinel = fixture.path.join(ancestor, 'outside-sentinel.txt');
          yield* fixture.fs.writeFileString(sentinel, `${boundary}-mode-sentinel\n`, {mode: 0o600});
          yield* fixture.fs.chmod(ancestor, 0o755);

          const lookupFailure = yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI).pipe(Effect.flip);
          expect(String(lookupFailure)).toContain('private directory is not private');
          const cleanupFailure = yield* discardDeferredCodeAnchorIntent(fixture.config, MEMORY_URI).pipe(Effect.flip);
          expect(String(cleanupFailure)).toContain('private directory is not private');
          expect(yield* fixture.fs.readFileString(sentinel)).toBe(`${boundary}-mode-sentinel\n`);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refuses a pending intent whose file permissions are no longer private', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/private.ts']),
        });
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        yield* fixture.fs.chmod(pendingPath, 0o644);

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not follow a pending-intent symbolic link', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/symlink.ts']),
        });
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        const movedPath = fixture.path.join(fixture.config.agentContextHome, 'outside-intent.json');
        yield* fixture.fs.rename(pendingPath, movedPath);
        yield* fixture.fs.symlink(movedPath, pendingPath);

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
        expect(yield* fixture.fs.readFileString(movedPath)).toContain('src/symlink.ts');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refuses a symbolic link at the private outbox boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const outside = fixture.path.join(fixture.config.agentContextHome, 'outside-outbox');
        yield* fixture.fs.makeDirectory(fixture.path.dirname(fixture.outbox), {recursive: true});
        yield* fixture.fs.makeDirectory(outside);
        yield* fixture.fs.symlink(outside, fixture.outbox);

        const failure = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/outbox-link.ts']),
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('Deferred code-anchor outbox must not be a symbolic link');
        expect(yield* fixture.fs.readDirectory(outside)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not follow a symlinked route lane or alter its outside target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending route-ancestor revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/route-ancestor-link.ts']),
        });
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as {
          repositoryId: string;
          worktreeId: string;
        };
        const markerPath = yield* fixtureRepositoryRouteMarkerPath(fixture);
        const laneRoot = fixture.path.dirname(markerPath);
        const outside = fixture.path.join(fixture.config.agentContextHome, 'outside-route-lane');
        yield* fixture.fs.rename(laneRoot, outside);
        const sentinel = fixture.path.join(outside, 'outside-sentinel.txt');
        yield* fixture.fs.writeFileString(sentinel, 'route-sentinel\n', {mode: 0o600});
        yield* fixture.fs.symlink(outside, laneRoot);

        expect(
          yield* finalizeDeferredCodeAnchorsForRoute(fixture.config, {
            callerCwd: fixture.repository,
            kind: 'repository',
            repositoryId: intent.repositoryId,
            worktreeId: intent.worktreeId,
          }),
        ).toMatchObject({scannedCount: 0, state: 'failed'});
        expect(yield* fixture.fs.readFileString(sentinel)).toBe('route-sentinel\n');
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MEMORY_URI)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rejects an intent whose content no longer matches its addressed URI', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/tampered.ts']),
        });
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        const intent = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as Record<string, unknown>;
        intent.memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/other.md';
        yield* fixture.fs.writeFileString(pendingPath, `${JSON.stringify(intent)}\n`, {mode: 0o600});

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('binds the caller checkout and recovery receipt into the intent address', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const stage = () =>
          stageDeferredCodeAnchorIntent(fixture.config, {
            memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
            memoryMetadata: fixture.metadata,
            memoryUri: MEMORY_URI,
            request: deferredRequest(fixture.repository, ['src/tampered-context.ts']),
          });
        yield* stage();
        const [pendingPath] = yield* fixtureIntentPaths(fixture);
        const callerTamper = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as Record<string, unknown>;
        callerTamper.callerCwd = fixture.config.agentContextHome;
        yield* fixture.fs.writeFileString(pendingPath, `${JSON.stringify(callerTamper)}\n`, {mode: 0o600});
        expect(yield* finalizeDeferredCodeAnchors(fixture.config)).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
        });

        yield* stage();
        const recoveryTamper = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as {
          recovery: {observedGraph: {stale: boolean}};
        };
        recoveryTamper.recovery.observedGraph.stale = false;
        yield* fixture.fs.writeFileString(pendingPath, `${JSON.stringify(recoveryTamper)}\n`, {mode: 0o600});
        expect(yield* finalizeDeferredCodeAnchors(fixture.config)).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

const fixtureIntentPaths = Effect.fn('deferredCodeAnchorTest.intentPaths')(function* (fixture: {
  readonly fs: FileSystem.FileSystem;
  readonly outbox: string;
  readonly path: Path.Path;
}) {
  return (yield* fixture.fs.readDirectory(fixture.outbox, {recursive: true}))
    .filter(name => name.endsWith('.json'))
    .map(name => fixture.path.join(fixture.outbox, name))
    .sort();
});

const fixtureRepositoryRouteMarkerPath = Effect.fn('deferredCodeAnchorTest.repositoryRouteMarker')(function* (fixture: {
  readonly fs: FileSystem.FileSystem;
  readonly outbox: string;
  readonly path: Path.Path;
}) {
  const relative = (yield* fixture.fs.readDirectory(fixture.outbox, {recursive: true})).find(entry => {
    const segments = entry.split(fixture.path.sep);
    return (
      segments.length === 4 &&
      segments[0] === 'r' &&
      /^r[a-f0-9]{32}$/u.test(segments[1] ?? '') &&
      segments[2] === '0' &&
      segments[3]?.endsWith('.ref') === true
    );
  });
  if (relative === undefined) return yield* Effect.die(new Error('Repository route marker fixture is missing.'));
  return fixture.path.join(fixture.outbox, relative);
});

const makeFixture = Effect.fn('deferredCodeAnchorTest.makeFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-deferred-anchor-'});
  const repository = path.join(home, 'repository');
  yield* fs.makeDirectory(repository);
  yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository});
  yield* runCommandEffect(
    'git',
    [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '--quiet',
      '--message',
      'fixture',
    ],
    {cwd: repository},
  );
  const manifestPath = path.join(home, 'seed-manifest.yaml');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath,
    user: 'tester',
  };
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: 'tn_deferred_test',
    project: 'threadnote',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-08-29T00:00:00.000Z',
    topic: 'deferred',
    visibility: 'personal',
  };
  return {
    config,
    fs,
    metadata,
    outbox: path.join(home, 'data', 'local', 'user', 'tester', 'private', 'deferred-code-anchors', 'v1'),
    path,
    repository,
  };
});

function deferredRequest(callerCwd: string, codeRefs: readonly string[]): DeferredCodeAnchorWriteRequest {
  return {
    callerCwd,
    codeRefs,
    recovery: {
      code: 'ready-graph-unavailable' as const,
      indexingStarted: false as const,
      observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
      preparation: {
        action: 'index-current-graph' as const,
        arguments: [] as const,
        command: 'threadnote graph index --no-vectors' as const,
        target: 'callerCwd' as const,
      },
      recovery: 'prepare-current-graph' as const,
      retryCondition: 'after-current-graph-ready' as const,
      retryable: true as const,
      type: 'memory-code-citation-capture-recovery' as const,
      version: 1 as const,
    },
  };
}

function deferredWorksetRequest(
  callerCwd: string,
  codeRefs: readonly string[],
  workset: string,
): DeferredCodeAnchorWriteRequest {
  return {
    callerCwd,
    codeRefs,
    recovery: {
      code: 'ready-graph-unavailable',
      indexingStarted: false,
      observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
      preparation: {
        action: 'prepare-workset',
        arguments: [workset],
        command: 'threadnote workset prepare',
        target: 'workset',
      },
      recovery: 'prepare-current-graph',
      retryCondition: 'after-current-graph-ready',
      retryable: true,
      type: 'memory-code-citation-capture-recovery',
      version: 1,
    },
  };
}

function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {account: config.account, home: config.agentContextHome, user: config.user} as const;
}

function memoryContent(metadata: MemoryMetadata, body: string): string {
  return formatMemoryDocument('MEMORY', metadata, body);
}

function inventoryFile(repositoryPath: string, source: string, absolutePath: string): CodeGraphInventoryFile {
  const bytes = new TextEncoder().encode(source);
  return {
    blobId: absolutePath,
    contentHash: codeGraphCommittedFileContentHash('sha1', bytes),
    language: 'typescript',
    mode: '100644',
    path: repositoryPath,
    size: bytes.byteLength,
    source: 'commit',
  };
}

const exactCurrentCitationGraph = Effect.fn('deferredCodeAnchorTest.exactCurrentGraph')(function* (
  fixture: {
    readonly config: RuntimeConfig;
    readonly repository: string;
  },
  files: readonly CodeGraphInventoryFile[],
) {
  const originalQuery = yield* CodeGraphQueryService;
  const observed = yield* originalQuery.status(fixture.config.agentContextHome, fixture.repository, {
    observeWorktree: true,
    requestMaintenance: false,
  });
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const exactStatus: CodeGraphStatus = {
    ...observed,
    freshness: 'current',
    readySnapshot: {
      commit: observed.identity.headCommit,
      completedAt: '2026-08-30T00:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: 'fixture-extractor-set',
      fileCount: files.length,
      graphContentId: `cgc_${'a'.repeat(40)}`,
      id: `cgsn_${'b'.repeat(40)}`,
      repositoryId: observed.identity.repositoryId,
      state: 'ready',
      symbolCount: 0,
      worktreeId: observed.identity.worktreeId,
    },
    stale: false,
  };
  return {
    query: CodeGraphQueryService.of({
      ...originalQuery,
      status: () => Effect.succeed(exactStatus),
    }),
    status: exactStatus,
    store: CodeGraphStore.of({
      acquireSnapshotLease: () => Effect.succeed('fixture-lease'),
      effectiveSnapshotCitationEvidence: (
        _databasePath: string,
        _snapshotId: string,
        request: {readonly paths?: readonly string[]},
      ) =>
        Effect.succeed({
          fileInventoryCoverage: 'complete',
          filesByContentHashes: [],
          filesByPaths: (request.paths ?? []).map(path => ({file: filesByPath.get(path), path})),
          symbolsByIds: [],
          symbolsBySemanticLocators: [],
        }),
      releaseSnapshotLease: () => Effect.void,
    } as unknown as CodeGraphStoreShape),
  };
});

function selectedProjectStatus(status: CodeGraphStatus, project: string, scopeKey: string): CodeGraphStatus {
  return attachCodeGraphStatusObservation(
    {
      ...status,
      projectCoverage: {
        completeness: 'complete',
        configuredRoots: ['apps/a'],
        dependencyComponents: 0,
        kind: 'project',
        negativeProof: 'selected-graph-only',
        observedWorktreeCommit: status.identity.headCommit,
        project,
        reusedEquivalentSnapshot: false,
        rootComponents: 1,
      },
    },
    {
      identity: status.identity,
      projectScope: {
        project: {
          graph: {closure: 'dependencies', roots: ['apps/a']},
          name: project,
          uri: `threadnote://projects/${project}`,
        },
        scope: {
          admittedPrefixes: ['apps/a'],
          closureDigest: 'b'.repeat(64),
          completeness: 'complete',
          controlPaths: [],
          definitionDigest: 'a'.repeat(64),
          diagnostics: [],
          includedProjectIds: ['app-a'],
          rootProjectIds: ['app-a'],
          scopeKey,
        },
      },
    },
  );
}

function selectedFullProjectStatus(status: CodeGraphStatus, project: string): CodeGraphStatus {
  return {
    ...status,
    projectCoverage: {
      completeness: 'complete',
      configuredRoots: [],
      dependencyComponents: 0,
      kind: 'full-repository',
      negativeProof: 'selected-graph-only',
      observedWorktreeCommit: status.identity.headCommit,
      project,
      reusedEquivalentSnapshot: false,
      rootComponents: 0,
    },
  };
}
