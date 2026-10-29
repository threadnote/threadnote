import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import {createCodeGraphWorksetRoutingProjection} from '@threadnote/graph/workset_catalog/projection';
import {
  publishCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  stageCodeGraphWorksetCatalogGeneration,
} from '@threadnote/graph/workset_catalog/store';
import {CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION} from '@threadnote/graph/workset_catalog/types';
import {codeGraphWorksetManifestDigest} from '@threadnote/graph/workset_catalog/workset';
import {resolveCodeGraphQualifiedRefTargets} from '@threadnote/graph/workset/query_v2';

import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('batched repository-qualified reference routing', () => {
  effectIt.effect('probes only the caller and cited members of a current published generation', () => {
    const repositoriesByCwd = new Map<string, string>();
    let statusCalls = 0;
    const queryLayer = Layer.mock(CodeGraphQueryService, {
      status: (_home: string, cwd: string) =>
        Effect.sync(() => {
          statusCalls += 1;
          return status(cwd, repositoriesByCwd.get(cwd)!);
        }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-qualified-ref-batch-'});
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(home, {recursive: true});
        const projects = Array.from({length: 128}, (_, index) => {
          const cwd = path.join(root, `project-${index}`);
          const repositoryId = Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'));
          repositoriesByCwd.set(cwd, repositoryId);
          return {cwd, index, repositoryId};
        });
        yield* Effect.forEach(projects, project => fs.makeDirectory(project.cwd, {recursive: true}), {concurrency: 16});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(
          manifestPath,
          EffectArray.join(
            [
              'version: 1',
              'projects:',
              ...EffectArray.flatMap(projects, project => [
                `  - name: project-${project.index}`,
                `    path: ${JSON.stringify(project.cwd)}`,
                `    uri: threadnote://resources/repos/project-${project.index}`,
                '    seed: []',
              ]),
              'worksets:',
              '  - name: citation-routing',
              '    projects:',
              '      - project-5',
              '      - project-77',
              '',
            ],
            '\n',
          ),
        );
        const config: RuntimeConfig = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          manifestPath,
          user: 'test-user',
        };
        const routedProjects = EffectArray.map([projects[5], projects[77]], project => ({
          name: `project-${project.index}`,
          path: project.cwd,
          seed: [] as const,
          uri: `threadnote://resources/repos/project-${project.index}`,
        }));
        const workset = {name: 'citation-routing', projects: routedProjects, unresolvedProjects: [] as const};
        const staged = yield* stageCodeGraphWorksetCatalogGeneration(home, {
          manifestDigest: codeGraphWorksetManifestDigest(workset),
          members: EffectArray.map(routedProjects, (project, index) => ({
            projection: routingProjection(projects[index === 0 ? 5 : 77].repositoryId, index),
            repositoryKey: project.name,
          })),
          worksetName: workset.name,
        });
        yield* publishCodeGraphWorksetCatalogGeneration(home, {
          generationId: staged.id,
          worksetName: workset.name,
        });
        const first = yield* registerCodeGraphQualifiedRef(home, {
          nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
          repositoryId: projects[5].repositoryId,
        });
        const second = yield* registerCodeGraphQualifiedRef(home, {
          nodeId: `cgs_${Effect2.pipe('b', EffectString.repeat(32))}`,
          repositoryId: projects[77].repositoryId,
        });
        const callerRef = yield* registerCodeGraphQualifiedRef(home, {
          nodeId: `cgs_${Effect2.pipe('c', EffectString.repeat(32))}`,
          repositoryId: projects[0].repositoryId,
        });

        const resolved = yield* resolveCodeGraphQualifiedRefTargets(
          config,
          [first.ref, second.ref, callerRef.ref, first.ref],
          projects[0].cwd,
        );

        expect(EffectArray.map(resolved, target => target.cwd)).toEqual([
          projects[5].cwd,
          projects[77].cwd,
          projects[0].cwd,
          projects[5].cwd,
        ]);
        expect(EffectArray.map(resolved, target => target.route)).toEqual([
          {kind: 'workset', name: 'citation-routing'},
          {kind: 'workset', name: 'citation-routing'},
          {kind: 'caller'},
          {kind: 'workset', name: 'citation-routing'},
        ]);
        expect(statusCalls).toBe(3);
      }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, queryLayer))),
    );
  });
});

function routingProjection(repositoryId: string, seed: number) {
  const digest = (value: string) => sha256HexSync(`${seed}:${value}`);
  return createCodeGraphWorksetRoutingProjection({
    checkoutId: digest('checkout'),
    commitId: Effect2.pipe(digest('commit'), EffectString.slice(0, 40)),
    componentCount: 1,
    extractorGeneration: 13,
    projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
    repositoryId,
    snapshotDigest: digest('snapshot-digest'),
    snapshotId: `cgsn_${Effect2.pipe(digest('snapshot'), EffectString.slice(0, 40))}`,
    symbols: [
      {
        exported: true,
        kind: 'function',
        language: 'typescript',
        lookupKeys: [`fixture.symbol.${seed}`],
        name: `symbol${seed}`,
        nodeId: `cgs_${Effect2.pipe(digest('node'), EffectString.slice(0, 40))}`,
        path: `src/symbol-${seed}.ts`,
        qualifiedName: `fixture.symbol${seed}`,
        span: {column: 1, endColumn: 10, endLine: 1, line: 1},
        terms: [{term: `symbol-${seed}`, weight: 4}],
      },
    ],
    worktreeId: digest('worktree'),
  });
}

function status(cwd: string, repositoryId: string): CodeGraphStatus {
  return {
    databasePath: `${cwd}/graph.sqlite`,
    freshness: 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: `checkout-${repositoryId}`,
      displayName: repositoryId,
      gitCommonDirectory: `${cwd}/.git`,
      headCommit: Effect2.pipe('c', EffectString.repeat(40)),
      objectFormat: 'sha1',
      repoRoot: cwd,
      repositoryId,
      worktreeId: repositoryId,
    },
    languagePacks: [],
    readySnapshot: {
      commit: Effect2.pipe('c', EffectString.repeat(40)),
      dirty: false,
      edgeCount: 0,
      extractorSet: 'native-code-graph-13',
      fileCount: 1,
      id: `cgsn_${Effect2.pipe(repositoryId, EffectString.slice(0, 40))}`,
      repositoryId,
      state: 'ready',
      symbolCount: 1,
      worktreeId: repositoryId,
    },
    stale: false,
  };
}
