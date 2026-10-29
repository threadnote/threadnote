import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import type {CodeGraphStatusOptions} from '@threadnote/graph/query/contract';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type ServicePath = 'session' | 'status' | 'legacy';
const SOURCE = 'export const supported = true;\n';

const scenario = (options: {
  readonly manifest: string;
  readonly project?: string;
  readonly service: ServicePath;
  readonly finalChange?: 'snapshot' | 'stale';
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'citation-routing-'});
    const manifestPath = path.join(root, options.manifest);
    const repositoryId = sha256HexSync(root);
    const snapshotId = `cgsn_${Effect2.pipe(repositoryId, EffectString.slice(0, 40))}`;
    yield* fs.writeFileString(path.join(root, 'source.ts'), SOURCE);
    const citation = createMemoryCodeCitation({
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256', value: sha256HexSync(SOURCE)},
      path: 'source.ts',
      repositoryId,
      repositoryIdentityKind: 'local',
      sourceCommit: Effect2.pipe('1', EffectString.repeat(40)),
      sourceDirty: false,
      sourceSnapshotId: snapshotId,
      target: {kind: 'file'},
      version: 1,
    });
    const status: CodeGraphStatus = {
      databasePath: path.join(root, 'graph.sqlite'),
      freshness: 'current',
      stale: false,
      languagePacks: [],
      identity: {
        caseMode: 'sensitive',
        checkoutId: 'checkout',
        displayName: 'test',
        gitCommonDirectory: path.join(root, '.git'),
        headCommit: citation.sourceCommit,
        objectFormat: 'sha1',
        repoRoot: root,
        repositoryId,
        worktreeId: 'worktree',
      },
      readySnapshot: {
        commit: citation.sourceCommit,
        dirty: false,
        edgeCount: 0,
        extractorSet: 'test',
        fileCount: 1,
        id: snapshotId,
        repositoryId,
        state: 'ready',
        symbolCount: 0,
        worktreeId: 'worktree',
      },
    };
    let leased = false;
    let evidenceRead = false;
    const observations: CodeGraphStatusOptions[] = [];
    const observe = (routing?: CodeGraphStatusOptions) =>
      Effect.sync(() => {
        observations.push({...routing});
        if (observations.length > 1) {
          expect(evidenceRead).toBe(true);
          expect(leased).toBe(true);
        }
        if (routing?.manifestPath !== manifestPath || routing.project !== options.project)
          return {...status, freshness: 'stale' as const, stale: true};
        if (evidenceRead && options.finalChange === 'stale') return {...status, stale: true};
        if (evidenceRead && options.finalChange === 'snapshot')
          return {
            ...status,
            readySnapshot: {...status.readySnapshot!, id: `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`},
          };
        return status;
      });
    const query = CodeGraphQueryService.of({
      attachSharedReadySnapshot: () => Effect.die('unused query operation'),
      inspect: () => Effect.die('unused query operation'),
      purge: () => Effect.die('unused query operation'),
      status: (_home, _cwd, routing) => observe(routing),
      statusForIdentity: () => Effect.die('unused query operation'),
      statusForPublishedIdentity: (_home, _cwd, _expected, routing) => observe(routing),
      ...(options.service === 'session'
        ? {
            withStatusSession: (_home, _cwd, _expected, routing, use) => observe(routing).pipe(Effect.flatMap(use)),
          }
        : {}),
    });
    if (options.service === 'legacy') {
      expect(Reflect.deleteProperty(query, 'statusForPublishedIdentity')).toBe(true);
    }
    const store = Layer.mock(CodeGraphStore, {
      acquireSnapshotLease: () =>
        Effect.sync(() => {
          leased = true;
          return 'lease';
        }),
      releaseSnapshotLease: () =>
        Effect.sync(() => {
          leased = false;
        }),
      effectiveSnapshotCitationEvidence: () =>
        Effect.sync(() => {
          evidenceRead = true;
          return {
            fileInventoryCoverage: 'complete',
            filesByContentHashes: [],
            symbolsByIds: [],
            symbolsBySemanticLocators: [],
            filesByPaths: [
              {
                path: citation.path,
                file: {
                  blobId: Effect2.pipe('2', EffectString.repeat(40)),
                  contentHash: citation.fileContentHash.value,
                  language: 'typescript',
                  mode: '100644',
                  path: citation.path,
                  size: SOURCE.length,
                  source: 'worktree',
                },
              },
            ],
          };
        }),
    });
    const services = yield* Layer.build(Layer.merge(Layer.succeed(CodeGraphQueryService, query), store));
    const candidates = [
      {
        uri: 'threadnote://memory/test',
        citationErrorCount: 0,
        codeCitations: [citation],
        excerpt: '',
        kind: 'durable' as const,
        project: 'unrelated-memory-tag',
        rank: 0,
      },
    ];
    const before = JSON.stringify(candidates);
    const validations = yield* validateContextBriefMemoryCitations(
      {account: 'test', agentContextHome: root, agentId: 'test', manifestPath, user: 'test'},
      {kind: 'repository', callerCwd: root, ...(options.project === undefined ? {} : {project: options.project})},
      candidates,
    ).pipe(Effect.provide(services));
    expect(validations[0]?.receipts[0]).toMatchObject(
      options.finalChange === undefined
        ? {status: 'exact', coverage: 'current-complete'}
        : {status: 'unknown', coverage: 'incomplete', reason: 'graph-stale'},
    );
    expect(observations).toHaveLength(2);
    expect(observations[0]).toEqual({
      manifestPath,
      ...(options.project === undefined ? {} : {project: options.project}),
      observeWorktree: true,
      requestMaintenance: false,
    });
    expect(observations[1]).toEqual(observations[0]);
    expect(leased).toBe(false);
    expect(JSON.stringify(candidates)).toBe(before);
  });

describe('citation validation configured routing authority', () => {
  effectIt.layer(
    Layer.mergeAll(
      citationPlatformLayer,
      Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
    ),
  )(it => {
    for (const service of ['session', 'status', 'legacy'] as const) {
      for (const manifest of ['manifest.yaml', 'seed-manifest.yaml']) {
        it.effect(`preserves ${manifest} and graph selector through ${service} and closing observation`, () =>
          scenario({manifest, project: 'selected-scope', service}),
        );
      }
      it.effect(`preserves full repository routing through ${service}`, () =>
        scenario({manifest: 'manifest.yaml', service}),
      );
      for (const finalChange of ['snapshot', 'stale'] as const)
        it.effect(`refuses ${finalChange} at ${service} closing observation`, () =>
          scenario({manifest: 'manifest.yaml', project: 'selected-scope', service, finalChange}),
        );
    }
    fcEffectProp(
      it,
      'preserves arbitrary configured routing without mutating citation provenance',
      {
        suffix: fc.nat(100_000),
        service: fc.constantFrom<ServicePath>('session', 'status', 'legacy'),
      },
      ({suffix, service}) => scenario({manifest: `manifest-${suffix}.yaml`, project: `scope-${suffix}`, service}),
      {fastCheck: {numRuns: 16}},
    );
  });
});
