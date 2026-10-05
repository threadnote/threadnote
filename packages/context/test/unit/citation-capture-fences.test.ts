import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../../src/citation/capture.js';

const SOURCE = 'export const value = 1;\n';
const REPOSITORY_ID = '1'.repeat(64);
const COMMIT = '2'.repeat(40);
const CONFIG: RuntimeConfig = {
  account: 'test',
  agentContextHome: '/threadnote-home',
  agentId: 'test',
  manifestPath: '/manifest.yaml',
  user: 'test',
};
const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(CommandExecutor, {execute: () => Effect.die('unexpected commit fallback')} as never),
  Layer.succeed(SystemInfo, {environment: () => process.env, platform: process.platform} as never),
);

describe('local citation capture fences', () => {
  it.layer(PlatformLayer)(test => {
    test.effect('uses one before/after observation pair for expected local caller identity and scope', () =>
      Effect.gen(function* () {
        const fixture = yield* captureFixture();
        const citations = yield* fixture.capture();
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({path: 'src/value.ts', repositoryId: REPOSITORY_ID});
        expect(fixture.observations()).toBe(2);
        expect(fixture.leases()).toEqual({acquired: 1, released: 1});
      }),
    );

    fcEffectProp(
      test,
      'fails closed when local provenance changes at either capture fence',
      {
        fence: fc.constantFrom('before' as const, 'after' as const),
        change: fc.constantFrom('repository', 'worktree', 'scope', 'stale', 'freshness', 'snapshot'),
      },
      ({fence, change}) =>
        Effect.gen(function* () {
          let evidenceRead = false;
          const fixture = yield* captureFixture({
            onEvidence: () => {
              evidenceRead = true;
            },
            statusFor: status => (fence === 'before' || evidenceRead ? changedStatus(status, change) : status),
          });
          const failure = yield* fixture.capture().pipe(Effect.flip);
          expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
          expect(evidenceRead).toBe(fence === 'after');
          expect(fixture.leases()).toEqual(fence === 'after' ? {acquired: 1, released: 1} : {acquired: 0, released: 0});
        }),
      {fastCheck: {numRuns: 36}},
    );
  });
});

function captureFixture(
  options: {
    readonly onEvidence?: () => void;
    readonly statusFor?: (status: CodeGraphStatus) => CodeGraphStatus;
  } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-capture-fences-'});
    const root = yield* fs.realPath(temporaryRoot);
    yield* fs.makeDirectory(path.join(root, 'src'));
    yield* fs.writeFileString(path.join(root, 'src/value.ts'), SOURCE);
    const status: CodeGraphStatus = {
      databasePath: path.join(root, 'graph.sqlite'),
      freshness: 'current',
      stale: false,
      languagePacks: [],
      identity: {
        caseMode: 'sensitive',
        checkoutId: 'fixture-checkout',
        displayName: 'fixture',
        gitCommonDirectory: path.join(root, '.git'),
        headCommit: COMMIT,
        objectFormat: 'sha1',
        repoRoot: root,
        repositoryId: REPOSITORY_ID,
        worktreeId: 'fixture-worktree',
      },
      readySnapshot: {
        commit: COMMIT,
        dirty: false,
        edgeCount: 0,
        extractorSet: 'fixture-extractors',
        fileCount: 1,
        id: `cgsn_${'3'.repeat(40)}`,
        repositoryId: REPOSITORY_ID,
        state: 'ready',
        symbolCount: 0,
        worktreeId: 'fixture-worktree',
      },
    };
    let observations = 0;
    let acquired = 0;
    let released = 0;
    const query = CodeGraphQueryService.of({
      status: () =>
        Effect.sync(() => {
          observations += 1;
          return options.statusFor?.(status) ?? status;
        }),
    } as unknown as Parameters<typeof CodeGraphQueryService.of>[0]);
    const store = CodeGraphStore.of({
      acquireSnapshotLease: () => Effect.sync(() => `lease-${++acquired}`),
      releaseSnapshotLease: () => Effect.sync(() => void ++released),
      effectiveSnapshotCitationEvidence: () =>
        Effect.sync(() => {
          options.onEvidence?.();
          return {
            fileInventoryCoverage: 'complete',
            filesByContentHashes: [],
            symbolsByIds: [],
            symbolsBySemanticLocators: [],
            filesByPaths: [
              {
                path: 'src/value.ts',
                file: {
                  blobId: 'fixture-blob',
                  contentHash: codeGraphCommittedFileContentHash('sha1', new TextEncoder().encode(SOURCE)),
                  language: 'typescript',
                  mode: '100644',
                  path: 'src/value.ts',
                  size: new TextEncoder().encode(SOURCE).byteLength,
                  source: 'commit',
                },
              },
            ],
          };
        }),
    } as unknown as CodeGraphStoreShape);
    return {
      capture: () =>
        captureMemoryCodeCitations(CONFIG, {
          callerCwd: root,
          refs: ['src/value.ts'],
          expectedCallerIdentity: status.identity,
          expectedProjectScope: {kind: 'full'},
        }).pipe(Effect.provideService(CodeGraphQueryService, query), Effect.provideService(CodeGraphStore, store)),
      observations: () => observations,
      leases: () => ({acquired, released}),
    };
  });
}

function changedStatus(status: CodeGraphStatus, change: string): CodeGraphStatus {
  switch (change) {
    case 'repository':
      return {...status, identity: {...status.identity, repositoryId: 'b'.repeat(64)}};
    case 'worktree':
      return {...status, identity: {...status.identity, worktreeId: 'swapped-worktree'}};
    case 'stale':
      return {...status, stale: true};
    case 'freshness':
      return {...status, freshness: 'deferred'};
    case 'snapshot':
      return {...status, readySnapshot: undefined};
    case 'scope':
      return attachCodeGraphStatusObservation(
        {...status},
        {
          identity: status.identity,
          projectScope: {
            project: {name: 'scoped', uri: 'threadnote://resources/repos/scoped'},
            scope: {
              admittedPrefixes: ['src'],
              closureDigest: 'a'.repeat(64),
              completeness: 'complete',
              controlPaths: [],
              definitionDigest: 'b'.repeat(64),
              diagnostics: [],
              includedProjectIds: [],
              rootProjectIds: [],
              scopeKey: 'scoped',
            },
          },
        },
      );
    default:
      throw new Error(`Unexpected provenance change: ${change}`);
  }
}
