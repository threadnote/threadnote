import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV, resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {runCodeGraphIndex} from '@threadnote/threadnote/code_graph/commands';
import {CliOutput} from '@threadnote/threadnote/effect/cli/output';
import {prepareManagerGraphIndexScope} from '@threadnote/threadnote/manager/graph/projects';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const layer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* runBinaryCommandEffect('git', ['init', '-q', root]);
  const config: RuntimeConfig = {
    account: 'local',
    agentId: 'test',
    user: 'test',
    agentContextHome: path.join(root, 'home'),
    manifestPath: path.join(root, 'manifest.json'),
  };
  const project = {
    name: 'docs',
    seed: [],
    path: root,
    uri: 'threadnote://resources/repos/docs',
    graph: {roots: ['apps/docs'], closure: 'dependencies' as const},
  };
  const raw = JSON.stringify({version: 1, projects: [project]});
  yield* fs.writeFileString(config.manifestPath, raw);
  return {fs, root, config, project, raw};
});

describe('graph scope manifest revision fencing', () => {
  effectIt.effect('routes from the exact bytes whose revision was selected', () =>
    Effect.gen(function* () {
      const {config, project, root, raw} = yield* fixture;
      expect(yield* resolveCodeGraphScopeRoute(config.manifestPath, root, 'docs', sha256HexSync(raw))).toEqual({
        state: 'selected',
        project,
      });
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );

  effectIt.effect('rejects a manifest change between Manager catalog validation and scope routing', () =>
    Effect.gen(function* () {
      const {config, fs, root, raw, project} = yield* fixture;
      const changed = JSON.stringify({
        version: 1,
        projects: [{...project, graph: {...project.graph, roots: ['apps/other']}}],
      });
      let reads = 0;
      const failure = yield* prepareManagerGraphIndexScope(config, root, {
        project: 'docs',
        expectedRevision: sha256HexSync(raw),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) =>
            file === config.manifestPath
              ? Effect.sync(() => (++reads === 1 ? raw : changed))
              : fs.readFileString(file, encoding),
        }),
        Effect.flip,
      );
      expect(failure).toMatchObject({message: 'Configured graph manifest changed. Refresh Manager before indexing.'});
      expect(reads).toBe(2);
      expect(yield* fs.readFileString(config.manifestPath)).toBe(raw);
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );

  effectIt.effect('rejects changed or deleted manifests before either Index or forced Reindex can mutate a graph', () =>
    Effect.gen(function* () {
      const {config, fs, root, raw, project} = yield* fixture;
      const system = yield* SystemInfo;
      let builds = 0;
      const unexpected = () =>
        Effect.sync(() => {
          builds++;
        }).pipe(Effect.andThen(Effect.die('unexpected index')));
      const indexer = CodeGraphIndexer.of({index: unexpected, ensureCommit: unexpected});
      const output = CliOutput.of({
        drain: Effect.void,
        flush: Effect.void,
        enqueueError: () => {},
        enqueueOutput: () => {},
        writeError: () => Effect.void,
        writeFinal: () => Effect.void,
      });
      for (const mode of ['changed', 'deleted'] as const) {
        const changed = JSON.stringify({
          version: 1,
          projects: [{...project, graph: {...project.graph, roots: ['apps/other']}}],
        });
        if (mode === 'changed') yield* fs.writeFileString(config.manifestPath, changed);
        else yield* fs.remove(config.manifestPath);
        for (const full of [false, true]) {
          const failure = yield* runCodeGraphIndex(config, {cwd: root, project: 'docs', full, json: true}).pipe(
            Effect.provideService(CodeGraphIndexer, indexer),
            Effect.provideService(CliOutput, output),
            Effect.provideService(SystemInfo, {
              ...system,
              environment: () => ({
                ...system.environment(),
                [CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV]: sha256HexSync(raw),
              }),
            }),
            Effect.flip,
          );
          expect(failure).toMatchObject({
            message: 'Configured graph manifest changed. Refresh Manager before indexing.',
          });
          expect(builds).toBe(0);
        }
        expect(yield* fs.exists(config.agentContextHome)).toBe(false);
        if (mode === 'changed') expect(yield* fs.readFileString(config.manifestPath)).toBe(changed);
        else expect(yield* fs.exists(config.manifestPath)).toBe(false);
      }
    }).pipe(TestClock.withLive, provideTestLayer(layer)),
  );
});
