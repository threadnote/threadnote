import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
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

// This composes both public entrypoints, storage, indexing, and canonical rereads.
effectIt.effect(
  'CLI and MCP retain same-checkout siblings through finite lexical windows and explicit controls',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-scope-flow-'});
      const repo = path.join(home, 'repo');
      const component = path.join(repo, 'apps/mobile');
      yield* fs.makeDirectory(component, {recursive: true});
      yield* fs.writeFileString(path.join(component, 'package.json'), '{"name":"product-mobile"}');
      yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repo});
      yield* runCommandEffect('git', ['remote', 'add', 'origin', 'https://example.invalid/team/legacy-repo.git'], {
        cwd: repo,
      });
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
          worksets: [
            {name: 'web-only', projects: ['product']},
            {name: 'empty', projects: []},
          ],
        }),
      );
      const mobileUri = 'threadnote://user/fixture/memories/handoffs/active/product-mobile/gearbox-calibration.md';
      const legacyUri = 'threadnote://user/fixture/memories/handoffs/active/legacy-repo/gearbox-calibration.md';
      const records = [
        {uri: mobileUri, project: 'product-mobile', scope: 'apps/mobile'},
        {uri: legacyUri, project: 'legacy-repo', scope: 'apps/billing'},
        ...Array.from({length: 280}, (_, index) => ({
          uri: `threadnote://user/fixture/memories/durable/projects/foreign/gearbox-${index}.md`,
          project: 'foreign',
          scope: 'apps/mobile',
        })),
      ];
      const store = yield* ResourceStore;
      yield* store.mutate(
        {account: config.account, home, user: config.user},
        EffectArray.map(records, record => ({
          type: 'write' as const,
          uri: record.uri,
          options: {mode: 'create' as const},
          content: formatMemoryDocument(
            'MEMORY',
            {
              kind: 'handoff',
              project: record.project,
              workspaceScope: record.scope,
              topic: 'orbital-gearbox-calibration',
              status: 'active',
              timestamp: '2026-10-16T00:00:00.000Z',
              sourceAgentClient: 'test',
            },
            'Orbital gearbox calibration uses a guarded service boundary in the mobile Product assistant.',
          ),
        })),
      );
      yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
      const registry = new EffectMcpServerRegistry();
      registerSearchTool(registry, config, 'recall_context', 'Recall', {
        heartbeatMilliseconds: 10_000,
        sharedSyncDelayMilliseconds: 0,
      });
      const base = {callerCwd: component, query: 'orbital gearbox calibration', nodeLimit: '3'};
      for (const query of [
        base.query,
        'Product mobile orbital gearbox calibration',
        'web-only orbital gearbox calibration',
      ]) {
        const cli = yield* captureConsole(runRecall(config, {...base, query}));
        expect(EffectArray.map(cli.value.ranked, hit => hit.uri)).toEqual(
          expect.arrayContaining([mobileUri, legacyUri]),
        );
        expect(
          EffectArray.some(cli.value.ranked, hit => Effect2.pipe(hit.uri, EffectString.includes('/foreign/'))),
        ).toBe(false);
        expect(cli.output).toContain('workspace-checkout');
        const mcp = yield* registry.invokeTool('recall_context', {
          ...base,
          nodeLimit: 3,
          query,
          responseFormat: 'dual',
        });
        expect(mcp.isError).not.toBe(true);
        expect(JSON.stringify(mcp.structuredContent)).toContain(
          Effect2.pipe(mobileUri, EffectString.split('/memories/'))[1],
        );
        expect(JSON.stringify(mcp.structuredContent)).toContain(
          Effect2.pipe(legacyUri, EffectString.split('/memories/'))[1],
        );
        expect(JSON.stringify(mcp.structuredContent)).not.toContain('/foreign/');
        expect(mcp.structuredContent).toMatchObject({projectBoundary: {reason: 'workspace-checkout'}});
      }
      for (const options of [
        {project: 'product-mobile'},
        {project: 'product-mobile', inferScope: false},
        {uri: mobileUri, project: 'product'},
      ]) {
        const cli = yield* captureConsole(runRecall(config, {...base, ...options}));
        expect(EffectArray.map(cli.value.ranked, hit => hit.uri)).toEqual([mobileUri]);
        const mcp = yield* registry.invokeTool('recall_context', {
          ...base,
          ...options,
          nodeLimit: 3,
          responseFormat: 'dual',
        });
        expect(mcp.isError).not.toBe(true);
        expect(JSON.stringify(mcp.structuredContent)).toContain(
          Effect2.pipe(mobileUri, EffectString.split('/memories/'))[1],
        );
        expect(JSON.stringify(mcp.structuredContent)).not.toContain(
          Effect2.pipe(legacyUri, EffectString.split('/memories/'))[1],
        );
      }
      for (const options of [
        {workset: 'empty'},
        {workset: 'web-only', project: 'product-mobile'},
        {project: 'mobile'},
        {query: 'unmatched-qzxw'},
      ]) {
        const cli = yield* captureConsole(runRecall(config, {...base, ...options}));
        expect(cli.value.ranked).toHaveLength(0);
        expect(cli.output).toContain('Project boundary:');
        const mcp = yield* registry.invokeTool('recall_context', {...base, ...options, nodeLimit: 3});
        expect(mcp.isError).not.toBe(true);
        expect(
          EffectArray.some(
            mcp.content,
            content =>
              content.type === 'text' && Effect2.pipe(content.text, EffectString.includes('Project boundary:')),
          ),
        ).toBe(true);
      }
      const global = yield* captureConsole(runRecall(config, {...base, inferScope: false}));
      expect(
        EffectArray.some(global.value.ranked, hit => Effect2.pipe(hit.uri, EffectString.includes('/foreign/'))),
      ).toBe(true);
      const globalMcp = yield* registry.invokeTool('recall_context', {
        ...base,
        nodeLimit: 3,
        inferScope: false,
        responseFormat: 'dual',
      });
      expect(JSON.stringify(globalMcp.structuredContent)).toContain('/foreign/');
      expect(globalMcp.structuredContent).toMatchObject({
        projectBoundary: {mode: 'unrestricted', reason: 'inference-disabled'},
      });
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  30_000,
);
