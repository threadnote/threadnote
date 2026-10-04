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

describe('Manager attention API', () => {
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
          relations: ['inactive', 'other', 'absent'].map(name => ({type: 'references' as const, uri: uri(name)})),
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
                  if (documents.some(document => file === `${root}/${document.name}.md`)) {
                    reads.set(file, (reads.get(file) ?? 0) + 1);
                  }
                }),
              ),
            ),
        }),
      );
      expect(response?.status).toBe(200);
      if (response?.status !== 200 || !('findings' in response.body)) throw new Error('Expected health report');
      const relations = response.body.findings.filter(finding => finding.category.startsWith('relation-target-'));
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
      expect(relations.some(finding => finding.repair.targetUri === uri('other'))).toBe(false);
      expect(documents.map(document => reads.get(`${root}/${document.name}.md`))).toEqual([1, 1, 1]);
    }).pipe(TestClock.withLive, Effect.scoped, provideTestLayer(ApplicationLayer)),
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
