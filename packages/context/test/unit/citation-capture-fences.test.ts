import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import fc from 'fast-check';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import {CodeGraphStoreBusyError, type CodeGraphStatus} from '@threadnote/graph/types';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../../src/citation/capture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const SOURCE = 'export const value = 1;\n';
const REPOSITORY_ID = Effect2.pipe('1', EffectString.repeat(64));
const COMMIT = Effect2.pipe('2', EffectString.repeat(40));
const CONFIG: RuntimeConfig = {
  account: 'test',
  agentContextHome: '/threadnote-home',
  agentId: 'test',
  manifestPath: '/manifest.yaml',
  user: 'test',
};
const system = SystemInfo.of({
  architecture: 'x64',
  availableDiskBytes: () => Effect.die('unexpected disk capacity query'),
  currentDirectory: () => process.cwd(),
  environment: () => process.env,
  developmentEntrypoint: '/test/threadnote.ts',
  intendedChildEnvironment: environment => environment,
  executablePath: process.execPath,
  homeDirectory: process.env.HOME ?? '/tmp',
  hardwareInfo: Effect.succeed({cpuModel: 'test', memoryBytes: 1, effectiveMemoryBytes: 1, operatingSystem: 'test'}),
  isProcessRunning: () => false,
  memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
  processStartIdentity: () => Effect.as(Effect.void, undefined),
  runtimeVersion: Bun.version,
  pathDelimiter: process.platform === 'win32' ? ';' : ':',
  platform: process.platform,
  processId: process.pid,
  processArguments: process.argv,
  readLine: () => () => undefined,
  signalProcess: () => undefined,
  setExitCode: () => undefined,
  setEnvironmentVariable: () => undefined,
  stdinIsTTY: false,
  stdoutIsTTY: false,
  tempDirectory: '/tmp',
  userName: 'test',
});
const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: () => Effect.die('unexpected commit fallback'),
      executeStreaming: () => Effect.die('unexpected commit fallback'),
    }),
  ),
  Layer.succeed(SystemInfo, system),
);

function captureQueryService(
  status: () => Effect.Effect<CodeGraphStatus>,
): Parameters<typeof CodeGraphQueryService.of>[0] {
  const unexpected = () => Effect.die(new Error('Unexpected code graph query in citation capture test.'));
  return {
    attachSharedReadySnapshot: unexpected,
    inspect: unexpected,
    purge: unexpected,
    status,
    statusForIdentity: unexpected,
    statusForPublishedIdentity: unexpected,
  };
}

type CaptureStore = Pick<
  CodeGraphStoreShape,
  'acquireSnapshotLease' | 'effectiveSnapshotCitationEvidence' | 'releaseSnapshotLease'
>;

function captureStoreShape(adapter: CaptureStore): CodeGraphStoreShape {
  // @ts-expect-error -- Capture fixtures implement only the lease and evidence operations called by this module.
  return adapter;
}

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

    test.effect('keeps internal capture waiting for its writer without reading unleased evidence', () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const available = yield* Deferred.make<void>();
        let evidenceReads = 0;
        const fixture = yield* captureFixture({
          writer: {entered, available},
          onEvidence: () => evidenceReads++,
        });
        const capture = yield* fixture.capture().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(evidenceReads).toBe(0);
        yield* Deferred.succeed(available, undefined);
        const citations = yield* Fiber.join(capture);
        expect(citations).toHaveLength(1);
        expect(evidenceReads).toBe(1);
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

    fcEffectProp(
      test,
      'retries denied leases without reading evidence and preserves capture identity',
      {denials: fc.integer({min: 1, max: 6})},
      ({denials}) =>
        Effect.gen(function* () {
          let evidenceReads = 0;
          const fixture = yield* captureFixture({
            deniedAcquisitions: denials,
            onEvidence: () => evidenceReads++,
          });
          for (let attempt = 0; attempt < denials; attempt++) {
            const failure = yield* fixture.capture(0).pipe(Effect.flip);
            expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
            expect(failure).toMatchObject({retryable: true});
            if (Schema.is(MemoryCodeCitationCaptureError)(failure)) {
              expect(failure.recovery).toMatchObject({
                code: 'graph-writer-busy',
                recovery: 'retry-capture',
                retryCondition: 'after-writer-available',
              });
            }
            expect(evidenceReads).toBe(0);
            expect(fixture.leases()).toEqual({acquired: 0, released: 0});
          }
          const first = yield* fixture.capture(0);
          const replay = yield* fixture.capture(0);
          expect(replay).toEqual(first);
          expect(evidenceReads).toBe(2);
          expect(fixture.leases()).toEqual({acquired: 2, released: 2});
        }),
      {fastCheck: {numRuns: 12}},
    );

    test.effect('returns captured evidence when a writer prevents immediate lease release', () =>
      Effect.gen(function* () {
        const fixture = yield* captureFixture({denyRelease: true});
        const citations = yield* fixture.capture(0);
        expect(citations).toHaveLength(1);
        expect(fixture.leases()).toEqual({acquired: 1, released: 1});
        expect(fixture.writerWaits()).toEqual([0, 0]);
      }),
    );
  });
});

function captureFixture(
  options: {
    readonly deniedAcquisitions?: number;
    readonly denyRelease?: boolean;
    readonly onEvidence?: () => void;
    readonly statusFor?: (status: CodeGraphStatus) => CodeGraphStatus;
    readonly writer?: {readonly entered: Deferred.Deferred<void>; readonly available: Deferred.Deferred<void>};
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
        id: `cgsn_${Effect2.pipe('3', EffectString.repeat(40))}`,
        repositoryId: REPOSITORY_ID,
        state: 'ready',
        symbolCount: 0,
        worktreeId: 'fixture-worktree',
      },
    };
    let observations = 0;
    let acquired = 0;
    let released = 0;
    let deniedAcquisitions = options.deniedAcquisitions ?? 0;
    const writerWaits: (number | undefined)[] = [];
    const query = CodeGraphQueryService.of(
      captureQueryService(() =>
        Effect.sync(() => {
          observations += 1;
          return options.statusFor?.(status) ?? status;
        }),
      ),
    );
    const store = CodeGraphStore.of(
      captureStoreShape({
        acquireSnapshotLease: (_database, _snapshot, _duration, writerOptions) =>
          Effect.gen(function* () {
            writerWaits.push(writerOptions?.waitTimeoutMilliseconds);
            if (options.writer) {
              const denied =
                writerOptions?.waitTimeoutMilliseconds === 0 && !(yield* Deferred.isDone(options.writer.available));
              yield* Deferred.succeed(options.writer.entered, undefined);
              if (denied) return yield* CodeGraphStoreBusyError.of('fixture writer busy');
              yield* Deferred.await(options.writer.available);
            }
            if (deniedAcquisitions-- > 0) return yield* CodeGraphStoreBusyError.of('fixture writer busy');
            return `lease-${++acquired}`;
          }),
        releaseSnapshotLease: (_database, _token, writerOptions) =>
          Effect.suspend(() => {
            writerWaits.push(writerOptions?.waitTimeoutMilliseconds);
            released++;
            return options.denyRelease ? Effect.fail(CodeGraphStoreBusyError.of('fixture writer busy')) : Effect.void;
          }),
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
      }),
    );
    return {
      capture: (writerWaitTimeoutMilliseconds?: number) =>
        captureMemoryCodeCitations(CONFIG, {
          callerCwd: root,
          refs: ['src/value.ts'],
          expectedCallerIdentity: status.identity,
          expectedProjectScope: {kind: 'full'},
          writerWaitTimeoutMilliseconds,
        }).pipe(Effect.provideService(CodeGraphQueryService, query), Effect.provideService(CodeGraphStore, store)),
      observations: () => observations,
      leases: () => ({acquired, released}),
      writerWaits: () => writerWaits,
    };
  });
}

function changedStatus(status: CodeGraphStatus, change: string): CodeGraphStatus {
  switch (change) {
    case 'repository':
      return {...status, identity: {...status.identity, repositoryId: Effect2.pipe('b', EffectString.repeat(64))}};
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
              closureDigest: Effect2.pipe('a', EffectString.repeat(64)),
              completeness: 'complete',
              controlPaths: [],
              definitionDigest: Effect2.pipe('b', EffectString.repeat(64)),
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
