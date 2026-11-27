import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Context, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {describe, expect} from 'vitest';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {CodeGraphStore} from '@threadnote/graph/store';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {admitNavigationRead, readNavigationEvidence} from '../../src/navigation/read.js';

const platform = Layer.effect(
  SystemInfo,
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return SystemInfo.of({
      ...system,
      developmentEntrypoint: yield* path.fromFileUrl(
        new URL('../../../../apps/threadnote/src/standalone.ts', import.meta.url),
      ),
      environment: () => ({...system.environment(), THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'}),
    });
  }),
).pipe(Layer.provideMerge(citationPlatformLayer));
const ports = Layer.mergeAll(
  Layer.succeed(CodeGraphProcessActivity, {withActivity: (_role, _operation, program) => program}),
  Layer.succeed(CodeGraphObservability, {
    makeBuildReporter: () =>
      Effect.succeed({
        observeExtractedFactBytes: () => Effect.void,
        observeInventory: () => Effect.void,
        observeOverlay: () => Effect.void,
        progress: () => Effect.void,
        terminal: () => Effect.void,
      }),
    makeWorksetReporter: Effect.succeed({
      failure: () => Effect.void,
      progress: () => Effect.void,
      terminal: () => Effect.void,
    }),
    backgroundFailure: () => Effect.void,
  }),
  Layer.succeed(CodeGraphEmbeddingIndex, {
    check: () => Effect.succeed({state: 'unavailable' as const, reason: 'fixture vectors disabled'}),
    ensure: () => Effect.die('No model in navigation read fixture'),
    search: () => Effect.succeed(new Map()),
  }),
  FetchHttpClient.layer,
);
const base = Layer.mergeAll(platform, ports);
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const dependencies = Layer.mergeAll(
  CodeGraphMaintenanceCoordinator.layer.pipe(Layer.provideMerge(storeLayer)),
  CodeGraphParserPool.layer.pipe(Layer.provideMerge(base)),
  TreeSitterRuntime.layer.pipe(Layer.provideMerge(base)),
  CodeGraphLanguagePackRegistry.layer,
);

/** A repository with no project manifest, where `hub` has more than eight structural neighbours. */
const CALLERS = 10;
const source = EffectArray.join(
  [
    'def hub(path):',
    '    return path',
    '',
    ...EffectArray.flatMap(EffectArray.range(0, CALLERS - 1), index => [
      `def caller_${index}(path):`,
      '    return hub(path)',
      '',
    ]),
  ],
  '\n',
);

effectIt.layer(dependencies)('navigation read from a prepared graph', it => {
  describe('readNavigationEvidence', () => {
    it.effect('answers a project-less request and a code ref with more than eight neighbours', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'navigation-read-'});
          const cwd = path.join(root, 'repository');
          const home = path.join(root, 'home');
          yield* fs.makeDirectory(cwd);
          yield* fs.makeDirectory(home);
          yield* fs.writeFileString(path.join(cwd, 'hub.py'), source);
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
          yield* git(['init', '--quiet']);
          yield* git(['add', '.']);
          yield* git([
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-qm',
            'fixture',
          ]);
          const indexer = Context.get(yield* Layer.build(CodeGraphIndexer.layer), CodeGraphIndexer);
          yield* indexer.index({cwd, threadnoteHome: home, sourceOnly: true, vectorPolicy: 'off'});
          const query = Context.get(
            yield* Layer.build(CodeGraphQueryService.layer).pipe(Effect.provideService(CodeGraphIndexer, indexer)),
            CodeGraphQueryService,
          );
          const status = yield* query.status(home, cwd, {requestMaintenance: false});
          const found = yield* query.inspect({
            cwd,
            threadnoteHome: home,
            operation: 'query',
            query: 'hub',
            nodeLimit: 4,
            edgeLimit: 4,
            refresh: false,
            requestMaintenance: false,
            strictFreshness: false,
            statusObservation: observationFromCodeGraphStatus(status),
          });
          const hub = Option.getOrThrow(EffectArray.findFirst(found.nodes, node => node.name === 'hub'));
          const config = {
            account: 'local',
            agentContextHome: home,
            agentId: 'fixture',
            manifestPath: path.join(home, 'manifest.yaml'),
            user: 'fixture',
          };
          const read = (codeRefs: readonly string[]) =>
            Effect.gen(function* () {
              const deadline = yield* makeReadDeadline(30_000);
              return yield* readNavigationEvidence(
                config,
                {
                  scope: {kind: 'repository', callerCwd: cwd},
                  task: 'Which function returns the path for every caller?',
                  codeRefs,
                  maximumEstimatedTokens: 1250,
                },
                deadline,
              ).pipe(Effect.provideService(CodeGraphQueryService, query));
            });
          const taskOnly = yield* read([]);
          expect(taskOnly.status).toBe('ok');
          if (taskOnly.status !== 'ok') return;
          expect(taskOnly.input.scope.project).toBe('repository');
          expect(admitNavigationRead(taskOnly)).toBe(taskOnly);
          const anchored = yield* read([hub.id]);
          expect(anchored.status).toBe('ok');
          if (anchored.status !== 'ok') return;
          expect(anchored.input.candidates.length).toBeGreaterThan(8);
          expect(anchored.input.target).toEqual({kind: 'anchors', candidateIds: [hub.id]});
          expect(admitNavigationRead(anchored)).toBe(anchored);
        }),
      ),
    );
  });
});
