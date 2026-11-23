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
import {closeRecallWithShareScope} from '../../src/recall/rank_fusion_scope.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const pointers = Schema.Struct({
  rankerVersion: Schema.String,
  results: Schema.Array(Schema.Struct({uri: Schema.String, aliases: Schema.optionalKey(Schema.Array(Schema.String))})),
});

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
        expect(result.rankerVersion).toBe('hybrid-v8+body-rrf-v1');
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
      const hybridMcp = yield* withRanking(
        'hybrid',
        registry.invokeTool('recall_context', {...base, responseFormat: 'dual'}),
      );
      expect(hybridMcp.structuredContent).toMatchObject({rankerVersion: 'hybrid-v8'});
      expect(enabled.output).toContain(RECALL_BODY_FUSION_NOTICE);
      expect(hybrid.value.ranked[0]?.uri).toBe(preferredUri);
      expect(EffectArray.map(enabled.value.ranked.slice(0, 10), hit => hit.uri)).toContain(projectlessUri);
      expect(EffectArray.map(hybrid.value.ranked, hit => hit.uri)).not.toContain(projectlessUri);
      const explicit = yield* withRanking('fusion', captureConsole(runRecall(config, {...base, threshold: '1'})));
      expect(explicit.value.ranked).toHaveLength(0);
      expect(explicit.output).not.toContain(RECALL_BODY_FUSION_NOTICE);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect('excludes revoked shared representatives, aliases, and references from ordinary recall', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-revoked-share-'});
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'fixture',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'fixture',
    };
    const shareDirectory = path.join(home, 'share');
    yield* fs.makeDirectory(shareDirectory);
    const teams = path.join(shareDirectory, 'teams.json');
    yield* fs.writeFileString(
      teams,
      JSON.stringify({version: 1, teams: {removed: {remote: 'https://example.invalid/team/repo.git'}}}),
    );
    const memoryRoot = 'threadnote://user/fixture/memories';
    const personal = `${memoryRoot}/durable/projects/space/calibration.md`;
    const alias = `${memoryRoot}/shared/removed/durable/projects/space/calibration.md`;
    const shared = `${memoryRoot}/shared/removed/durable/projects/space/shared-only.md`;
    const store = yield* ResourceStore;
    const location = {account: config.account, home, user: config.user};
    const metadata = {
      kind: 'durable',
      project: 'space',
      schemaVersion: 10,
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-10-16T00:00:00.000Z',
      topic: 'orbital-gearbox-calibration',
      keywords: ['TX-FALLBACK-MARKER'],
    } as const;
    const body = '# Orbital gearbox calibration\n\nUse the calibration sheet at station five.';
    const linked = {
      ...metadata,
      memoryId: 'tn_00000000000000000000000000000001',
      references: [shared],
    };
    yield* store.mutate(
      location,
      EffectArray.map([personal, alias, shared], uri => ({
        type: 'write' as const,
        uri,
        options: {mode: 'create' as const},
        content:
          uri === shared
            ? formatMemoryDocument(
                'MEMORY',
                {...metadata, keywords: ['TX-FALLBACK-MARKER', 'REVOKED-ONLY-MARKER']},
                `${body} The team retains a second calibration sheet.`,
              )
            : formatMemoryDocument('MEMORY', linked, body),
      })),
    );
    yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
    const registry = new EffectMcpServerRegistry();
    registerSearchTool(registry, config, 'recall_context', 'Recall', {heartbeatMilliseconds: 10_000});
    const base = {query: 'orbital gearbox calibration', project: 'space', callerCwd: home, inferScope: false};
    const before = yield* registry.invokeTool('recall_context', {...base, responseFormat: 'dual'});
    const initial = yield* Schema.decodeUnknownEffect(pointers)(before.structuredContent);
    expect(initial.results).toEqual(expect.arrayContaining([expect.objectContaining({aliases: expect.any(Array)})]));
    expect(JSON.stringify(initial.results)).toContain('shared/removed');

    // Simulate the published team removal with a failed mirror cleanup.
    yield* fs.writeFileString(teams, JSON.stringify({version: 1, teams: {}}));
    expect(yield* store.read(location, alias)).toContain('calibration sheet');
    expect(yield* store.read(location, shared)).toContain('second calibration sheet');
    for (const query of [base.query, 'TX-FALLBACK-MARKER']) {
      const cli = yield* captureConsole(runRecall(config, {...base, query}));
      expect(EffectArray.map(cli.value.ranked, hit => hit.uri)).toEqual([personal]);
      expect(JSON.stringify(cli.value.ranked)).not.toContain('shared/removed');
      expect(cli.output).not.toContain('shared/removed');
      const reply = yield* registry.invokeTool('recall_context', {...base, query, responseFormat: 'dual'});
      const response = yield* Schema.decodeUnknownEffect(pointers)(reply.structuredContent);
      expect(response.results).toHaveLength(1);
      expect(response.rankerVersion).toBe(query === base.query ? 'hybrid-v8+body-rrf-v1' : 'hybrid-v8');
      expect(JSON.stringify(reply)).not.toContain('shared/removed');
    }
    const absent = yield* registry.invokeTool('recall_context', {
      ...base,
      query: 'REVOKED-ONLY-MARKER',
      responseFormat: 'dual',
    });
    expect(absent.structuredContent).toMatchObject({
      rankerVersion: 'hybrid-v8',
      results: [],
      confidence: {level: 'no_answer'},
    });
    expect(JSON.stringify(absent)).not.toContain('shared/removed');
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
    const observed: Array<readonly string[] | undefined> = [];
    const result = yield* closeRecallWithShareScope(config, [], 10, true, (_uris, _closing, roots) =>
      Effect.gen(function* () {
        observed.push(roots);
        yield* fs.writeFileString(file, JSON.stringify({version: 1, teams: {}}));
        return roots;
      }),
    );
    expect(observed).toEqual([['threadnote://user/fixture/memories/shared/verified'], []]);
    expect(result.result).toEqual([]);
  }).pipe(provideTestLayer(ApplicationLayer)),
);
