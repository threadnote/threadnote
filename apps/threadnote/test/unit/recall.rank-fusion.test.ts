import {it as effectIt} from '@effect/vitest';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {SystemInfo} from '@threadnote/platform/system';
import {recordRecallFeedback} from '@threadnote/recall/feedback';
import {loadRecallIndex} from '@threadnote/recall/index';
import {RECALL_BODY_FUSION_NOTICE} from '@threadnote/recall/sections_read';
import {ResourceStore} from '@threadnote/store/resource-store';
import {Array as EffectArray, DateTime, Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {registerSearchTool} from '../../src/mcp/server/recall.js';
import {runRecall} from '../../src/memory/commands.js';
import {withRecallBodyShareScope} from '../../src/recall/rank_fusion_scope.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const pointers = Schema.Struct({results: Schema.Array(Schema.Struct({uri: Schema.String}))});

effectIt.effect(
  'fuses local memory ranks by default for CLI and MCP while retaining limits and threshold control',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-fusion-'});
      const config = {
        account: 'local',
        agentContextHome: home,
        agentId: 'fixture',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'fixture',
      };
      const query = 'orbital gearbox calibration';
      const store = yield* ResourceStore;
      const target = 'threadnote://user/fixture/memories/durable/projects';
      const projectlessUri = 'threadnote://user/fixture/memories/durable/projectless.md';
      const ids = Array.from({length: 14}, (_, index) => EffectString.padStart(2, '0')(String(index)));
      yield* store.mutate(
        {account: config.account, home, user: config.user},
        EffectArray.map([...ids, 'blocked'], id => {
          const project = id === '00' ? undefined : id === 'blocked' ? 'foreign' : 'space';
          const body = `# Orbital gearbox calibration\n\nStation ${id} stores its orbital gearbox calibration sheet.\n`;
          return {
            type: 'write' as const,
            uri: project === undefined ? projectlessUri : `${target}/${project}/${id}.md`,
            options: {mode: 'create' as const},
            content: formatMemoryDocument(
              'MEMORY',
              {
                kind: 'durable',
                project,
                topic: 'orbital-gearbox-calibration',
                status: 'active',
                timestamp: '2026-10-16T00:00:00.000Z',
                sourceAgentClient: 'test',
              },
              body,
            ),
          };
        }),
      );
      yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
      const preferredUri = `${target}/space/09.md`;
      yield* recordRecallFeedback(home, {
        action: 'useful',
        project: 'space',
        query,
        uri: preferredUri,
        timestamp: DateTime.formatIso(yield* DateTime.now),
      });
      const registry = new EffectMcpServerRegistry();
      registerSearchTool(registry, config, 'recall_context', 'Recall', {heartbeatMilliseconds: 10_000});
      const system = yield* SystemInfo;
      const withRanking = <A, E, R>(ranking: string | undefined, program: Effect.Effect<A, E, R>) =>
        program.pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...system,
              environment: () => ({...system.environment(), THREADNOTE_RECALL_RANKING: ranking}),
            }),
          ),
        );

      for (const limit of [undefined, 5, 10]) {
        const options = {query, project: 'space', callerCwd: home, inferScope: false};
        const cli = yield* withRanking(
          undefined,
          captureConsole(runRecall(config, {...options, nodeLimit: limit === undefined ? undefined : String(limit)})),
        );
        const cliUris = EffectArray.map(cli.value.ranked, result => result.uri);
        expect(cliUris).toHaveLength(limit ?? 12);
        expect(cli.output).toContain(RECALL_BODY_FUSION_NOTICE);
        expect(cli.output).not.toContain('/foreign/');
        const mcp = yield* withRanking(
          undefined,
          registry.invokeTool('recall_context', {
            ...options,
            ...(limit === undefined ? {} : {nodeLimit: limit}),
            responseFormat: 'dual',
          }),
        );
        const result = yield* Schema.decodeUnknownEffect(pointers)(mcp.structuredContent);
        const compact = (uri: string) => EffectString.replace(/^threadnote:\/\/user\/fixture\/(?=memories\/)/, '')(uri);
        expect(EffectArray.map(result.results, entry => compact(entry.uri))).toEqual(
          EffectArray.map(cliUris.slice(0, result.results.length), compact),
        );
      }

      const base = {query, project: 'space', callerCwd: home, inferScope: false};
      const enabled = yield* withRanking('fusion', captureConsole(runRecall(config, base)));
      const hybrid = yield* withRanking('hybrid', captureConsole(runRecall(config, base)));
      expect(hybrid.value.ranked).toHaveLength(12);
      expect(hybrid.output).not.toContain(RECALL_BODY_FUSION_NOTICE);
      expect(enabled.output).toContain(RECALL_BODY_FUSION_NOTICE);
      expect(hybrid.value.ranked[0]?.uri).toBe(preferredUri);
      expect(EffectArray.map(enabled.value.ranked.slice(0, 10), hit => hit.uri)).toContain(projectlessUri);
      expect(EffectArray.map(hybrid.value.ranked, hit => hit.uri)).not.toContain(projectlessUri);
      const explicit = yield* withRanking('fusion', captureConsole(runRecall(config, {...base, threshold: '1'})));
      expect(explicit.value.ranked).toHaveLength(0);
      expect(explicit.output).not.toContain(RECALL_BODY_FUSION_NOTICE);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect('rejects shared BM25 scope if local team membership changes before publication', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-fusion-membership-'});
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'fixture',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'fixture',
    };
    const directory = path.join(home, 'share');
    yield* fs.makeDirectory(directory);
    const file = path.join(directory, 'teams.json');
    yield* fs.writeFileString(
      file,
      JSON.stringify({version: 1, teams: {verified: {remote: 'https://example.invalid/team/repo.git'}}}),
    );
    const observed: Array<{roots: readonly string[]; membershipChanged: boolean}> = [];
    const result = yield* withRecallBodyShareScope(config, (roots, membershipChanged) =>
      Effect.gen(function* () {
        observed.push({roots, membershipChanged});
        yield* fs.writeFileString(file, JSON.stringify({version: 1, teams: {}}));
        return roots;
      }),
    );
    expect(observed).toEqual([
      {roots: ['threadnote://user/fixture/memories/shared/verified'], membershipChanged: false},
      {roots: [], membershipChanged: true},
    ]);
    expect(result).toEqual([]);
  }).pipe(provideTestLayer(ApplicationLayer)),
);
