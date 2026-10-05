import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {retrieveContextBriefCodeLinkedMemoryEvidence} from '@threadnote/threadnote/context_brief/memory_evidence';
import {planContextBrief} from '@threadnote/context/planner';
import {runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  isDeferredCodeAnchorIntentFilename,
  stageDeferredCodeAnchorIntent,
  type DeferredCodeAnchorRouteFinalizationReceiptV1,
} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Context Brief deferred code-anchor recovery', () => {
  for (const interruptFirstAdmission of [false, true]) {
    effectIt.effect(
      interruptFirstAdmission
        ? 'recovers a pre-write deadline in the first brief after direct graph publication'
        : 'returns the backlink in the first brief after a direct graph publication bypassed the CLI hook',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-autoheal-'});
            const repository = path.join(root, 'repository');
            const home = path.join(root, 'home');
            const manifestPath = path.join(home, 'seed-manifest.yaml');
            yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
            yield* fs.makeDirectory(home, {recursive: true});
            yield* fs.writeFileString(
              path.join(repository, 'src', 'index.ts'),
              'export function deferredBacklinkTarget(): string { return "ready"; }\n',
            );
            yield* fs.writeFileString(path.join(repository, 'package.json'), '{"name":"autoheal-fixture"}\n');
            yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
            yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository}).pipe(TestClock.withLive);
            yield* runCommandEffect('git', ['add', '.'], {cwd: repository}).pipe(TestClock.withLive);
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
                'fixture',
              ],
              {cwd: repository},
            ).pipe(TestClock.withLive);

            const config: RuntimeConfig = {
              account: 'local',
              agentContextHome: home,
              agentId: 'threadnote',
              manifestPath,
              user: 'tester',
            };
            const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/context-brief-autoheal.md';
            const metadata: MemoryMetadata = {
              kind: 'durable',
              memoryId: 'tn_context_brief_autoheal',
              project: 'threadnote',
              schemaVersion: MEMORY_SCHEMA_VERSION,
              sourceAgentClient: 'test',
              status: 'active',
              timestamp: '2026-08-30T00:00:00.000Z',
              topic: 'context-brief-autoheal',
              visibility: 'personal',
            };
            const body = 'The deferred backlink must appear in the first post-ready Context Brief.';
            const content = formatMemoryDocument('MEMORY', metadata, body);
            const store = yield* ResourceStore;
            const location = {account: config.account, home, user: config.user} as const;
            const indexer = yield* CodeGraphIndexer;
            // Index before staging so wrap-heal cannot consume the intent; this
            // example is the missed-wakeup path after a ready graph already exists.
            yield* indexer
              .index({cwd: repository, ensureVectors: false, threadnoteHome: home})
              .pipe(TestClock.withLive);
            yield* store.write(location, memoryUri, content, {mode: 'create'});
            yield* stageDeferredCodeAnchorIntent(config, {
              memoryContent: content,
              memoryMetadata: metadata,
              memoryUri,
              request: {
                callerCwd: repository,
                codeRefs: ['src/index.ts'],
                recovery: {
                  code: 'ready-graph-unavailable',
                  indexingStarted: false,
                  observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
                  preparation: {
                    action: 'index-current-graph',
                    arguments: [],
                    command: 'threadnote graph index --no-vectors',
                    target: 'callerCwd',
                  },
                  recovery: 'prepare-current-graph',
                  retryCondition: 'after-current-graph-ready',
                  retryable: true,
                  type: 'memory-code-citation-capture-recovery',
                  version: 1,
                },
              },
            });
            const pendingRoot = path.join(
              home,
              'data',
              'local',
              'user',
              'tester',
              'private',
              'deferred-code-anchors',
              'v1',
            );
            expect(
              (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
                isDeferredCodeAnchorIntentFilename(path.basename(name)),
              ),
            ).toHaveLength(1);

            const plan = planContextBrief({
              codeRefs: ['src/index.ts'],
              scope: {callerCwd: repository, kind: 'repository'},
              task: 'Find the decision attached to deferredBacklinkTarget.',
            });
            const entered = yield* Deferred.make<void>();
            let interruptedAdmission = false;
            const contendedStore = ResourceStore.of({
              ...store,
              read: (location, uri) =>
                Effect.suspend(() => {
                  if (interruptFirstAdmission && !interruptedAdmission && uri === memoryUri) {
                    interruptedAdmission = true;
                    return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
                  }
                  return store.read(location, uri);
                }),
            });
            const receipts: DeferredCodeAnchorRouteFinalizationReceiptV1[] = [];
            const query = yield* CodeGraphQueryService;
            const liveQuery = CodeGraphQueryService.of({
              ...query,
              status: (...args) => query.status(...args).pipe(TestClock.withLive),
            });
            const firstRetrieve = retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors, {
              onFinalizationReceipt: receipt => {
                receipts.push(receipt);
              },
            }).pipe(
              Effect.provideService(ResourceStore, contendedStore),
              Effect.provideService(CodeGraphQueryService, liveQuery),
            );
            // Real repository observations need live Git/lease timing; route
            // deadlines stay deterministic regardless of runner load.
            const firstFiber = yield* firstRetrieve.pipe(Effect.forkScoped);
            if (interruptFirstAdmission) {
              yield* Deferred.await(entered);
              yield* TestClock.adjust('750 millis');
            }
            const first = yield* Fiber.join(firstFiber);
            // Count/state-only receipts retain the failed boundary without exposing memory content or locators.
            expect(first.codeAnchorCoverage, JSON.stringify(receipts)).toEqual({
              complete: true,
              matchedMemories: 1,
              requested: 1,
              resolved: 1,
            });
            const receiptStates = receipts.map(receipt => receipt.state);
            if (interruptFirstAdmission) {
              expect(receiptStates).toEqual(['contended', 'completed']);
            } else {
              // A busy CI runner can briefly contend on the route lock even
              // without the injected interruption. Recovery in this first
              // brief is the contract, with at most one bounded retry.
              expect([['completed'], ['contended', 'completed']]).toContainEqual(receiptStates);
            }
            expect(first.gaps).not.toContain('code-anchor-recall-unavailable');
            expect(first.candidates).toMatchObject([
              {
                codeLinkMatches: [{anchorOrdinal: 0, anchorPath: 'src/index.ts', matchKind: 'file-path'}],
                uri: memoryUri,
              },
            ]);
            expect(
              (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
                isDeferredCodeAnchorIntentFilename(path.basename(name)),
              ),
            ).toEqual([]);
            const finalized = parseMemoryDocument(memoryUri, yield* store.read(location, memoryUri));
            expect(finalized?.body).toBe(body);
            expect(finalized?.metadata).toMatchObject({
              codeCitations: [{path: 'src/index.ts'}],
              memoryId: metadata.memoryId,
              status: metadata.status,
              timestamp: metadata.timestamp,
              visibility: metadata.visibility,
            });

            const second = yield* retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors).pipe(
              TestClock.withLive,
            );
            expect(second.candidates.map(candidate => candidate.uri)).toEqual([memoryUri]);
            expect(
              (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
                isDeferredCodeAnchorIntentFilename(path.basename(name)),
              ),
            ).toEqual([]);
          }),
        ).pipe(provideTestLayer(ApplicationLayer)),
      60_000,
    );
  }
});
