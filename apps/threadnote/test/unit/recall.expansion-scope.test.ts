import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {loadRecallExpansionVocabulary} from '@threadnote/recall/runtime';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {loadRecallIndex} from '@threadnote/recall/index';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import {runRecall} from '../../src/memory/commands.js';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {registerSearchTool} from '../../src/mcp/server/recall.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const expansion = vi.hoisted(() => ({
  calls: [] as Array<{scopes: readonly string[] | undefined; vocabulary: readonly string[]}>,
}));
vi.mock('@threadnote/recall/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/recall/runtime')>();
  return {
    ...actual,
    loadRecallExpansionVocabulary: (...args: Parameters<typeof actual.loadRecallExpansionVocabulary>) =>
      actual.loadRecallExpansionVocabulary(...args).pipe(
        Effect.tap(vocabulary =>
          Effect.sync(() => {
            expansion.calls.push({scopes: args[1].allowedUriScopes, vocabulary});
          }),
        ),
      ),
  };
});

effectIt.effect(
  'CLI and MCP expansion use hard URI boundaries and retain eligible sibling vocabulary',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-expansion-scope-'});
      const repo = path.join(home, 'repo');
      yield* fs.makeDirectory(repo);
      yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repo});
      const config = {
        account: 'local',
        agentContextHome: home,
        agentId: 'fixture',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'fixture',
      };
      yield* fs.writeFileString(
        config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: EffectArray.map(['product', 'product-mobile'], name => ({
            name,
            path: repo,
            seed: [],
            uri: `threadnote://resources/repos/${name}`,
          })),
        }),
      );
      const store = yield* ResourceStore;
      const records = EffectArray.map(['product', 'product-mobile', 'foreign'], project => ({
        project,
        topic: `${project}-distinctive-hint`,
        uri: `threadnote://user/fixture/memories/durable/projects/${project}/hint.md`,
      }));
      yield* store.mutate(
        {account: 'local', home, user: 'fixture'},
        EffectArray.map(records, record => ({
          type: 'write' as const,
          uri: record.uri,
          options: {mode: 'create' as const},
          content: formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              project: record.project,
              topic: record.topic,
              timestamp: '2026-10-16T00:00:00.000Z',
              sourceAgentClient: 'test',
            },
            'Synthetic guidance for expansion.',
          ),
        })),
      );
      yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
      const pinnedVocabulary = yield* loadRecallExpansionVocabulary(config, {
        allowedUriScopes: [records[1].uri],
        eligibility: deriveRecallEligibilityPolicy({originalQuery: 'Product', pinnedHardUri: true}),
        includeInactive: false,
        project: 'product',
      });
      expect(
        EffectArray.some(pinnedVocabulary, term =>
          Effect2.pipe(term, EffectString.includes('product-mobile-distinctive-hint')),
        ),
      ).toBe(true);
      expect(
        EffectArray.some(
          pinnedVocabulary,
          term =>
            Effect2.pipe(term, EffectString.includes('foreign-distinctive-hint')) ||
            Effect2.pipe(term, EffectString.includes('product-distinctive-hint')),
        ),
      ).toBe(false);
      const registry = new EffectMcpServerRegistry();
      registerSearchTool(registry, config, 'recall_context', 'Recall', {
        heartbeatMilliseconds: 10_000,
        sharedSyncDelayMilliseconds: 0,
      });
      for (const uri of [undefined, records[1].uri]) {
        for (const surface of ['cli', 'mcp'] as const) {
          expansion.calls.length = 0;
          const input = {callerCwd: repo, query: 'Product quizzicalzx', ...(uri === undefined ? {} : {uri})};
          if (surface === 'cli') yield* captureConsole(runRecall(config, input));
          else {
            const result = yield* registry.invokeTool('recall_context', input);
            expect(result.isError).not.toBe(true);
          }
          expect(expansion.calls).toHaveLength(1);
          const call = expansion.calls[0];
          expect(call.scopes).toEqual(uri === undefined ? undefined : [uri]);
          expect(
            EffectArray.some(call.vocabulary, term =>
              Effect2.pipe(term, EffectString.includes('product-mobile-distinctive-hint')),
            ),
          ).toBe(uri === undefined);
          expect(
            EffectArray.some(call.vocabulary, term =>
              Effect2.pipe(term, EffectString.includes('foreign-distinctive-hint')),
            ),
          ).toBe(false);
          expect(
            EffectArray.some(call.vocabulary, term =>
              Effect2.pipe(term, EffectString.includes('product-distinctive-hint')),
            ),
          ).toBe(uri === undefined);
        }
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  30_000,
);
