import {Array as EffectArray, String as EffectString} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Option, Path} from 'effect';
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
} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

import {recallReadMaintenanceLayer} from '../../src/recall/read_maintenance.js';
import {runRecallLexicalWorkerUnit} from '../../src/recall/embedding_worker.js';
import {readRecallLexicalScope} from '@threadnote/recall/background/lexical-demand';

describe('Context Brief deferred code-anchor recovery', () => {
  for (const interruptFirstAdmission of [false, true]) {
    effectIt.effect(
      interruptFirstAdmission
        ? 'retains original anchor intent after an interrupted background attempt and completes it on retry'
        : 'returns deferred evidence promptly and heals backlinks through the owned background route',
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
            yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository});
            yield* runCommandEffect('git', ['add', '.'], {cwd: repository});
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
            );

            const config: RuntimeConfig = {
              account: 'local',
              agentContextHome: home,
              agentId: 'threadnote',
              manifestPath,
              user: 'tester',
            };
            const memoryUri = 'threadnote://user/tester/memories/durable/projects/repository/context-brief-autoheal.md';
            const metadata: MemoryMetadata = {
              kind: 'durable',
              memoryId: 'tn_context_brief_autoheal',
              project: 'repository',
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
            yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home});
            yield* store.write(location, memoryUri, content, {mode: 'create'});
            const staged = {
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
                  type: 'memory-code-citation-capture-recovery' as const,
                  version: 1 as const,
                },
              },
            } as const;
            yield* stageDeferredCodeAnchorIntent(config, staged);
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
              EffectArray.filter(
                yield* fs.readDirectory(pendingRoot, {recursive: true}),
                __effectArrayValue =>
                  !!(name => isDeferredCodeAnchorIntentFilename(path.basename(name)))(__effectArrayValue),
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
            const query = yield* CodeGraphQueryService;
            const liveQuery = query;
            const firstRetrieve = retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors).pipe(
              Effect.provideService(ResourceStore, contendedStore),
              Effect.provideService(CodeGraphQueryService, liveQuery),
              Effect.timeout('2 seconds'),
            );
            const first = yield* firstRetrieve;
            expect(first.candidates).toEqual([]);
            expect(first.gaps).toContain('code-anchor-recall-unavailable');
            expect(interruptedAdmission).toBe(false);
            const directory = path.join(home, 'recall', 'lexical-demand-v1');
            const scopes = yield* Effect.forEach(yield* fs.readDirectory(directory), filename =>
              readRecallLexicalScope(home, filename),
            );
            const scope = Option.getOrUndefined(
              EffectArray.findFirst(scopes, scope => scope?.work?.kind === 'anchors'),
            );
            expect(scope).toBeDefined();
            const port = yield* Layer.build(recallReadMaintenanceLayer).pipe(
              Effect.provideService(ResourceStore, contendedStore),
              Effect.provideService(CodeGraphQueryService, liveQuery),
            );
            if (interruptFirstAdmission) {
              const worker = yield* runRecallLexicalWorkerUnit(scope!).pipe(Effect.provide(port), Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* Fiber.interrupt(worker);
            }
            const completed = yield* runRecallLexicalWorkerUnit(scope!).pipe(Effect.provide(port));
            expect(completed.state).toBe('complete');
            // The home host gives the newly enqueued lexical work its own turn.
            yield* runRecallLexicalWorkerUnit({...config, includeInactive: false});
            expect(
              EffectArray.filter(
                yield* fs.readDirectory(pendingRoot, {recursive: true}),
                __effectArrayValue =>
                  !!(name => isDeferredCodeAnchorIntentFilename(path.basename(name)))(__effectArrayValue),
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

            const second = yield* retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors);
            expect(EffectArray.map(second.candidates, candidate => candidate.uri)).toEqual([memoryUri]);
            expect(second.gaps).not.toContain('code-anchor-recall-unavailable');
            expect(
              EffectArray.filter(
                yield* fs.readDirectory(pendingRoot, {recursive: true}),
                __effectArrayValue =>
                  !!(name => isDeferredCodeAnchorIntentFilename(path.basename(name)))(__effectArrayValue),
              ),
            ).toEqual([]);
            // A later intent in the same route must not be hidden by a completed
            // demand or by the preceding empty-route read.
            const laterUri = EffectString.replace('autoheal.md', 'autoheal-later.md')(memoryUri);
            const laterMetadata = {...metadata, memoryId: 'tn_context_brief_autoheal_later'};
            const laterContent = formatMemoryDocument('MEMORY', laterMetadata, body);
            yield* store.write(location, laterUri, laterContent, {mode: 'create'});
            yield* stageDeferredCodeAnchorIntent(config, {
              ...staged,
              memoryContent: laterContent,
              memoryMetadata: laterMetadata,
              memoryUri: laterUri,
            });
            const pendingAgain = yield* retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors);
            expect(pendingAgain.gaps).toContain('code-anchor-recall-unavailable');
            const laterScopes = yield* Effect.forEach(yield* fs.readDirectory(directory), filename =>
              readRecallLexicalScope(home, filename),
            );
            expect(laterScopes).toHaveLength(scopes.length);
            const laterScope = Option.getOrUndefined(
              EffectArray.findFirst(laterScopes, scope => scope?.work?.kind === 'anchors'),
            );
            expect(yield* runRecallLexicalWorkerUnit(laterScope!).pipe(Effect.provide(port))).toMatchObject({
              state: 'complete',
            });
            yield* runRecallLexicalWorkerUnit({...config, includeInactive: false});
            const healedAgain = yield* retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors);
            expect(EffectArray.map(healedAgain.candidates, candidate => candidate.uri)).toContain(laterUri);
            expect(healedAgain.gaps).not.toContain('code-anchor-recall-unavailable');
          }),
        ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
      60_000,
    );
  }
});
