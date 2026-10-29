import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import {describe, expect} from 'vitest';
import {handleManagerAttentionRequest, managerAttentionProjectRoot} from '@threadnote/threadnote/manager/attention';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {localUserMemoriesRoot} from '../../src/memory/migrations.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Manager attention API', () => {
  effectIt.effect('opens spaced project names without selecting their slug-shaped neighbor', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-spaced-project-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/manifest.yaml`,
        user: 'tester',
      };
      const memories = yield* localUserMemoriesRoot(config);
      const reviews = `${home}/threadnote/candidates/v1/reviews`;
      yield* fs.makeDirectory(memories, {recursive: true});
      yield* fs.makeDirectory(reviews, {recursive: true});
      for (const [index, project] of ['Example Project', 'Example-Project'].entries()) {
        yield* fs.writeFileString(
          `${memories}/${index}.md`,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              project,
              sourceAgentClient: 'synthetic',
              timestamp: '2026-10-19T00:00:00.000Z',
            },
            'Synthetic project fact.',
          ),
        );
        yield* fs.writeFileString(
          `${reviews}/review-${index}.json`,
          JSON.stringify({
            version: 2,
            reviewId: `review-${index}`,
            revision: 1,
            project,
            topic: 'scope',
            task: 'Synthetic review',
            createdAt: '2026-10-19T00:00:00.000Z',
            codeCitations: [],
            auditEvents: [],
            candidates: [
              {
                candidateId: `candidate-${index}`,
                state: 'pending',
                categories: ['decision'],
                comparison: 'new',
                confidence: 1,
                proposedText: 'Synthetic proposal',
                reason: 'Review',
                recommendation: 'create',
              },
            ],
          }),
        );
      }
      const call = (route: string) =>
        handleManagerAttentionRequest({
          config,
          method: 'GET',
          url: new URL(`http://manager.test/api/${route}?project=Example%20Project`),
        });
      expect(yield* call('reviews')).toMatchObject({
        status: 200,
        body: {
          project: 'Example Project',
          pendingCount: 1,
          items: [{project: 'Example Project', reviewId: 'review-0'}],
        },
      });
      expect(yield* call('context-health')).toMatchObject({
        status: 200,
        body: {
          project: 'Example Project',
          recordsScanned: 1,
        },
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('scans health records once while retaining inactive and other-project relation targets', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-health-corpus-'});
      const repository = `${home}/repository`;
      yield* fs.makeDirectory(repository);
      expect((yield* runBinaryCommandEffect('git', ['init', '--quiet', repository])).exitCode).toBe(0);
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/seed-manifest.yaml`,
        user: 'tester',
      };
      yield* fs.writeFileString(
        config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      const root = yield* localUserMemoriesRoot(config);
      yield* fs.makeDirectory(root, {recursive: true});
      const uri = (name: string) => `threadnote://user/tester/memories/${name}.md`;
      const documents = [
        {
          name: 'current',
          project: 'threadnote',
          status: 'active' as const,
          relations: EffectArray.map(['inactive', 'other', 'absent'], name => ({
            type: 'references' as const,
            uri: uri(name),
          })),
        },
        {name: 'inactive', project: 'threadnote', status: 'archived' as const, relations: []},
        {name: 'other', project: 'other', status: 'active' as const, relations: []},
      ];
      for (const document of documents) {
        yield* fs.writeFileString(
          `${root}/${document.name}.md`,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: document.status,
              project: document.project,
              relations: document.relations,
              sourceAgentClient: 'synthetic',
              timestamp: '2026-10-04T00:00:00.000Z',
              topic: document.name,
            },
            'Synthetic relation authority.',
          ),
        );
      }
      const reads = new Map<string, number>();
      const response = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/context-health?project=threadnote'),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, ...args) =>
            fs.readFileString(file, ...args).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (EffectArray.some(documents, document => file === `${root}/${document.name}.md`)) {
                    reads.set(file, (reads.get(file) ?? 0) + 1);
                  }
                }),
              ),
            ),
        }),
      );
      expect(response?.status).toBe(200);
      if (response?.status !== 200 || !('findings' in response.body)) throw new Error('Expected health report');
      const findings = response.body.findings;
      const relations = EffectArray.filter(
        findings,
        (finding, index) =>
          index in findings && Effect2.pipe(finding.category, EffectString.startsWith('relation-target-')),
      );
      expect(relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'relation-target-inactive',
            repair: expect.objectContaining({targetUri: uri('inactive')}),
          }),
          expect.objectContaining({
            category: 'relation-target-missing',
            repair: expect.objectContaining({targetUri: uri('absent')}),
          }),
        ]),
      );
      expect(EffectArray.some(relations, finding => finding.repair.targetUri === uri('other'))).toBe(false);
      expect(EffectArray.map(documents, document => reads.get(`${root}/${document.name}.md`))).toEqual([1, 1, 1]);
    }).pipe(TestClock.withLive, Effect.scoped, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('separates pending, deferred, and completed reviews without changing the total attention count', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-review-tabs-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/seed-manifest.yaml`,
        user: 'tester',
      };
      const directory = `${home}/threadnote/candidates/v1/reviews`;
      yield* fs.makeDirectory(directory, {recursive: true});
      const states = ['pending', 'applying', 'deferred', 'applied', 'rejected', 'conflict'];
      const review = {
        version: 2,
        reviewId: 'review-tabs',
        revision: 1,
        project: 'threadnote',
        topic: 'tabs',
        task: 'Synthetic review',
        createdAt: '2026-10-07T00:00:00Z',
        codeCitations: [],
        auditEvents: [],
        candidates: EffectArray.map(states, state => ({
          candidateId: state,
          state,
          categories: ['decision'],
          comparison: 'new',
          confidence: 0.9,
          proposedText: 'Synthetic proposed knowledge',
          reason: 'Reusable decision',
          recommendation: 'create',
        })),
      };
      yield* fs.writeFileString(`${directory}/review-tabs.json`, JSON.stringify(review));
      yield* fs.writeFileString(
        `${directory}/other-project.json`,
        JSON.stringify({...review, reviewId: 'other-project', project: 'unrelated'}),
      );
      for (const [view, expected] of [
        ['pending', ['pending', 'applying']],
        ['deferred', ['deferred']],
        ['history', ['applied', 'rejected', 'conflict']],
      ] as const) {
        const response = yield* handleManagerAttentionRequest({
          config,
          method: 'GET',
          url: new URL(`http://manager.test/api/reviews?project=threadnote&view=${view}`),
        });
        if (response?.status !== 200 || !('items' in response.body) || !response.body.items)
          throw new Error('Expected review inbox');
        expect(
          EffectArray.flatMap(response.body.items, item =>
            EffectArray.map(item.candidates, candidate => candidate.state),
          ),
        ).toEqual(expected);
        expect(response.body.pendingCount).toBe(3);
      }
      for (const view of ['pending', 'deferred', 'history']) {
        const response = yield* handleManagerAttentionRequest({
          config,
          method: 'GET',
          url: new URL(`http://manager.test/api/reviews?project=&view=${view}`),
        });
        if (response?.status !== 200 || !('items' in response.body) || !response.body.items)
          throw new Error('Expected All review inbox');
        expect(response.body.project).toBe('');
        expect(response.body.pendingCount).toBe(6);
        expect(EffectArray.map(response.body.items, item => item.project).sort()).toEqual(['threadnote', 'unrelated']);
      }
      const allHealth = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/context-health?project='),
      });
      expect(allHealth?.status).toBe(400);
      const invalid = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=threadnote&view=unknown'),
      });
      expect(invalid?.status).toBe(400);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('returns a project-scoped empty review inbox from local state', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-attention-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/seed-manifest.yaml`,
        user: 'tester',
      };
      const response = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=threadnote'),
      });
      expect(response).toEqual({
        body: {items: [], pendingCount: 0, project: 'threadnote', version: 1},
        status: 200,
      });
    }).pipe(Effect.scoped, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects traversal-like project names before reading local state', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerAttentionRequest({
        config: {
          account: 'local',
          agentContextHome: '/unread',
          agentId: 'threadnote',
          manifestPath: '/unread/seed-manifest.yaml',
          user: 'tester',
        },
        method: 'GET',
        url: new URL('http://manager.test/api/context-health?project=../outside'),
      });
      expect(response).toEqual({
        body: {code: 'invalid-project', error: 'Select a valid project to inspect its attention queue.'},
        status: 400,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('marks repository evidence unavailable for memory-only and unresolved projects', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-attention-root-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/seed-manifest.yaml`,
        user: 'tester',
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const memoryOnly = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/context-health?project=threadnote'),
      });
      expect(memoryOnly?.status).toBe(200);
      expect(memoryOnly?.body).toMatchObject({
        project: 'threadnote',
        repositoryEvidence: {reason: 'project-not-configured', state: 'unavailable'},
        semanticCompleteness: {eligibleRecords: 0, state: 'complete', unknownRecords: 0},
        status: 'unknown',
      });

      yield* fs.writeFileString(
        config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(`${home}/missing`)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      expect(yield* managerAttentionProjectRoot(config, 'threadnote')).toEqual({
        reason: 'repository-unavailable',
        state: 'unavailable',
      });

      yield* fs.writeFileString(config.manifestPath, 'projects: [unterminated\n');
      expect(yield* managerAttentionProjectRoot(config, 'threadnote')).toEqual({
        reason: 'manifest-unavailable',
        state: 'unavailable',
      });
    }).pipe(Effect.scoped, provideTestLayer(ApplicationLayer)),
  );
});
