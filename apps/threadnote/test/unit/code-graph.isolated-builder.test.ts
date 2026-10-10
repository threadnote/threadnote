import {CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV} from '@threadnote/graph/scope/routing';
import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {succeedUndefined} from '@threadnote/platform/optional';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {DateTime, Deferred, Effect, Fiber, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {
  assertIsolatedBuilderPlan,
  awaitOwnedIsolatedBuilderResult,
  codeGraphIsolatedBuilderSpawnPlan,
  codeGraphProgressFromBuildStatus,
  developmentStandaloneScript,
  isCodeGraphIsolatedBuilderHost,
  isolatedBuilderFailureFromStatus,
  isolatedBuilderFailureMessage,
  isolatedBuilderOwnedAdmission,
  isolatedBuilderRequestMatches,
  isolatedBuilderResultFromCompletedStatus,
  runIsolatedCodeGraphIndex,
  shouldAwaitExistingBuilder,
  statusBelongsToChild,
  type CodeGraphIsolatedBuilderSpawnPlan,
} from '@threadnote/graph/isolated/builder';
import type {ObservedCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {
  CodeGraphDiskCapacityPressureError,
  CodeGraphRuntimeReconnectRequiredError,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import type {SystemInfoShape} from '@threadnote/platform/system';
import {runEffect} from '../helpers/effect-runtime.js';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE,
  CodeGraphRefreshDemandSuperseded,
} from '@threadnote/graph/refresh/demand';

function systemInfoStub(overrides: Partial<SystemInfoShape>): SystemInfoShape {
  return {
    ...systemRuntimeBoundaries,
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
    hardwareInfo: Effect.succeed({
      cpuModel: 'test',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'test',
    }),
    homeDirectory: '/home/test',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/opt/threadnote/bin/threadnote'],
    processId: 1,
    processStartIdentity: () => succeedUndefined,
    readLine: () => () => undefined,
    runtimeVersion: 'test',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/tmp',
    userName: 'test',
    ...overrides,
  };
}

describe('isolated code-graph builder host detection', () => {
  it('detects installed and development MCP hosts, not CLI graph index children', () => {
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
      }),
    ).toBe(true);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/usr/local/bin/bun',
        processArguments: ['/usr/local/bin/bun', '/apps/threadnote/src/standalone.ts', 'mcp-server'],
      }),
    ).toBe(true);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote-mcp-server',
        processArguments: ['/opt/threadnote/bin/threadnote-mcp-server'],
      }),
    ).toBe(true);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: [
          '/opt/threadnote/bin/threadnote',
          '/$bunfs/root/threadnote',
          'graph',
          'index',
          '--cwd',
          '/repo',
        ],
      }),
    ).toBe(false);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/usr/local/bin/bun',
        processArguments: [
          '/usr/local/bin/bun',
          '/apps/threadnote/src/standalone.ts',
          'graph',
          'index',
          '--cwd',
          '/repo',
        ],
      }),
    ).toBe(false);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'recall', 'mcp-server'],
      }),
    ).toBe(false);
  });
});

describe('isolated code-graph builder spawn plan', () => {
  it('resolves the development fallback to the repository standalone entrypoint', () => {
    expect(
      Option.getOrThrow(
        developmentStandaloneScript(
          systemInfoStub({
            executablePath: '/usr/local/bin/bun',
            processArguments: ['/usr/local/bin/bun'],
          }),
        ),
      ),
    ).toBe(Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url)));
  });

  it('reuses completed results only for exact request-key equality', () => {
    const status = {request: {key: 'request-a'}} as ObservedCodeGraphBuildStatus;
    expect(isolatedBuilderRequestMatches(status, 'request-a')).toBe(true);
    expect(isolatedBuilderRequestMatches(status, 'request-b')).toBe(false);
    expect(isolatedBuilderRequestMatches(status, undefined)).toBe(false);
  });

  it('retains detached child ownership while startup status is not yet published', () => {
    const child = {exited: Promise.resolve(0), kill: () => undefined, processId: 77};
    expect(isolatedBuilderOwnedAdmission(undefined, child, 'prior-build')).toEqual({
      child,
      mode: 'starting',
      priorBuildId: 'prior-build',
    });
    expect(
      isolatedBuilderOwnedAdmission({buildId: 'owned-build'} as ObservedCodeGraphBuildStatus, child, 'prior-build'),
    ).toEqual({child, mode: 'spawned', observedBuildId: 'owned-build', priorBuildId: 'prior-build'});
  });

  it('checks runtime compatibility before observing or spawning a child', async () => {
    const identity: RepositoryIdentity = {
      caseMode: 'sensitive',
      checkoutId: 'a'.repeat(64),
      displayName: 'fixture/repository',
      gitCommonDirectory: '/fixture/repository/.git',
      headCommit: 'b'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: '/fixture/repository',
      repositoryId: 'c'.repeat(64),
      worktreeId: 'd'.repeat(64),
    };
    const failure = CodeGraphRuntimeReconnectRequiredError.of();
    let spawnCalls = 0;

    await expect(
      runEffect(
        runIsolatedCodeGraphIndex({
          assertRuntimeSchemaCompatible: databasePath => {
            expect(databasePath).toContain(identity.checkoutId);
            return Effect.fail(failure);
          },
          cwd: identity.repoRoot,
          resolveIdentity: () => Effect.succeed(identity),
          spawn: () => {
            spawnCalls += 1;
            throw TestError.make({message: 'spawn must not run'});
          },
          threadnoteHome: '/fixture/home',
        }),
      ),
    ).rejects.toBe(failure);
    expect(spawnCalls).toBe(0);
  });

  it('reinvokes CLI graph index with --no-vectors, home, and cwd', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(
      systemInfoStub({
        environment: () => ({
          PATH: '/usr/bin',
          THREADNOTE_HOME: '/old-home',
          THREADNOTE_TELEMETRY_SESSION_ID: 'tns_000102030405060708090a0b0c0d0e0f',
          THREADNOTE_TELEMETRY_CONSENT_GENERATION: 'tng_000102030405060708090a0b0c0d0e0f',
        }),
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
      }),
      {cwd: '/repo/worktree', threadnoteHome: '/home/.threadnote'},
    );
    expect(plan.executable).toBe('/opt/threadnote/bin/threadnote');
    expect(plan.arguments).toEqual([
      '--home',
      '/home/.threadnote',
      'graph',
      'index',
      '--no-vectors',
      '--cwd',
      '/repo/worktree',
    ]);
    expect(plan.environment).toEqual({
      PATH: '/usr/bin',
      THREADNOTE_CODE_GRAPH_BUILDER_ADMISSION_CLASS: 'current-required',
      THREADNOTE_HOME: '/home/.threadnote',
      THREADNOTE_TELEMETRY_CHILD: 'graph-builder',
      THREADNOTE_TELEMETRY_CONSENT_GENERATION: 'tng_000102030405060708090a0b0c0d0e0f',
      THREADNOTE_TELEMETRY_SESSION_ID: 'tns_000102030405060708090a0b0c0d0e0f',
    });
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('forwards background builder admission to isolated graph-index children', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(systemInfoStub({}), {
      admissionClass: 'background',
      cwd: '/repo/worktree',
      threadnoteHome: '/home/.threadnote',
    });
    expect(plan.environment.THREADNOTE_CODE_GRAPH_BUILDER_ADMISSION_CLASS).toBe('background');
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('forwards the exact Manager manifest and project together to the isolated child', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(systemInfoStub({}), {
      cwd: '/repo/worktree',
      project: 'docs',
      manifestPath: '/synthetic/selected manifest.yaml',
      manifestRevision: 'a'.repeat(64),
      full: true,
      threadnoteHome: '/home/.threadnote',
    });
    expect(plan.environment[CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV]).toBe('a'.repeat(64));
    expect(plan.arguments).toEqual([
      '--home',
      '/home/.threadnote',
      '--manifest',
      '/synthetic/selected manifest.yaml',
      'graph',
      'index',
      '--full',
      '--no-vectors',
      '--project',
      'docs',
      '--cwd',
      '/repo/worktree',
    ]);
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('clears inherited Manager manifest revision fencing for an unrelated isolated child', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(
      systemInfoStub({environment: () => ({[CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV]: 'stale-revision'})}),
      {cwd: '/repo/worktree', threadnoteHome: '/home/.threadnote'},
    );
    expect(plan.environment[CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV]).toBeUndefined();
  });

  it('forwards the selected project to isolated graph-index children', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(systemInfoStub({}), {
      cwd: '/repo/worktree',
      project: 'payments',
      threadnoteHome: '/home/.threadnote',
    });
    expect(plan.arguments).toEqual([
      '--home',
      '/home/.threadnote',
      'graph',
      'index',
      '--no-vectors',
      '--project',
      'payments',
      '--cwd',
      '/repo/worktree',
    ]);
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('preserves bounded admission metadata while mirroring queued child progress', () => {
    const queue = {admissionClass: 'background' as const, enqueuedAt: '2026-09-17T12:00:00.000Z', position: 3, size: 4};
    expect(
      codeGraphProgressFromBuildStatus({
        counters: {},
        phase: 'waiting',
        subphase: 'home-builder-cap',
        scheduling: {queue},
      }),
    ).toEqual({phase: 'waiting', reason: 'home-builder-cap', admission: queue});
    expect(
      codeGraphProgressFromBuildStatus({
        counters: {},
        phase: 'waiting',
        subphase: 'database-writer',
        scheduling: {queue, admittedAt: '2026-09-17T12:00:01.000Z'},
      }),
    ).toEqual({phase: 'waiting', reason: 'database-writer'});
  });

  it('forwards a Manager full rebuild without disabling vectors', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(systemInfoStub({}), {
      cwd: '/repo/worktree',
      full: true,
      noVectors: false,
      threadnoteHome: '/home/.threadnote',
    });

    expect(plan.arguments).toEqual([
      '--home',
      '/home/.threadnote',
      'graph',
      'index',
      '--full',
      '--cwd',
      '/repo/worktree',
    ]);
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('keeps production plans valid across host shapes (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('/repo', '/tmp/worktree'),
        fc.constantFrom('/home/.threadnote', '/tmp/tn-home'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (cwd, home, bunHost, full, noVectors) => {
          const plan = codeGraphIsolatedBuilderSpawnPlan(
            systemInfoStub({
              executablePath: bunHost ? '/usr/local/bin/bun' : '/opt/threadnote/bin/threadnote',
              processArguments: bunHost
                ? ['/usr/local/bin/bun', '/apps/threadnote/src/standalone.ts', 'mcp-server']
                : ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
            }),
            {cwd, full, noVectors, threadnoteHome: home},
          );
          expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
          const graphAt = plan.arguments.indexOf('graph');
          expect(plan.arguments[graphAt + 1]).toBe('index');
          expect(plan.arguments.includes('--full')).toBe(full);
          expect(plan.arguments.includes('--no-vectors')).toBe(noVectors);
          expect(plan.arguments[plan.arguments.indexOf('--cwd') + 1]).toBe(cwd);
          expect(plan.arguments[plan.arguments.indexOf('--home') + 1]).toBe(home);
        },
      ),
      {numRuns: 40},
    );
  });

  it('rejects MCP launcher, mcp-server prefix, and missing graph index', () => {
    const base: CodeGraphIsolatedBuilderSpawnPlan = {
      arguments: ['--home', '/home', 'graph', 'index', '--cwd', '/repo'],
      environment: {},
      executable: '/opt/threadnote/bin/threadnote',
    };
    expect(() => assertIsolatedBuilderPlan({...base, executable: '/opt/threadnote/bin/threadnote-mcp-server'})).toThrow(
      /must not spawn the MCP launcher/,
    );
    expect(() =>
      assertIsolatedBuilderPlan({...base, arguments: ['mcp-server', 'graph', 'index', '--cwd', '/repo']}),
    ).toThrow(/must not spawn an MCP server/);
    expect(() => assertIsolatedBuilderPlan({...base, arguments: ['--home', '/home', '--cwd', '/repo']})).toThrow(
      /must invoke `graph index`/,
    );
  });
});

describe('codeGraphProgressFromBuildStatus', () => {
  const cases = [
    {
      description: 'registering',
      input: {
        counters: {},
        phase: 'registering' as const,
        registration: {
          activity: {elapsedMilliseconds: 250, generations: 2, keys: 400, stage: 'loading-cache' as const},
        },
      },
      expected: {
        activity: {elapsedMilliseconds: 250, generations: 2, keys: 400, stage: 'loading-cache'},
        phase: 'registering',
      },
    },
    {
      description: 'scanning counters',
      input: {
        counters: {accepted: 2, completed: 5, excluded: 1, skipped: 0, total: 10},
        phase: 'scanning' as const,
      },
      expected: {
        accepted: 2,
        completed: 5,
        excluded: 1,
        phase: 'scanning',
        skipped: 0,
        total: 10,
        unit: 'files',
      },
    },
    {
      description: 'materializing counters',
      input: {counters: {completed: 3, reused: 1, total: 9}, phase: 'materializing' as const},
      expected: {completed: 3, phase: 'materializing', reused: 1, total: 9, unit: 'files'},
    },
    {
      description: 'disk-capacity waiting',
      input: {counters: {}, phase: 'waiting' as const, subphase: 'disk-capacity'},
      expected: {phase: 'waiting', reason: 'disk-capacity'},
    },
  ] as const;

  for (const testCase of cases) {
    it(`maps ${testCase.description}`, () => {
      expect(codeGraphProgressFromBuildStatus(testCase.input)).toEqual(testCase.expected);
    });
  }

  it('keeps phase variants valid and filters unsupported waiting reasons (property)', () => {
    const phases = [
      'registering',
      'waiting',
      'reclaiming',
      'scanning',
      'materializing',
      'resolving',
      'activating',
      'embedding',
    ] as const;
    const allowedWaiting = new Set([
      'database-writer',
      'disk-capacity',
      'home-builder-cap',
      'repository-lock',
      'request-lock',
      'snapshot-build',
    ]);
    fc.assert(
      fc.property(
        fc.constantFrom(...phases),
        fc.nat({max: 100}),
        fc.option(fc.string({maxLength: 24}), {nil: undefined}),
        (phase, n, subphase) => {
          const progress = codeGraphProgressFromBuildStatus({
            counters: {
              accepted: n,
              completed: n,
              edges: n,
              embedded: n,
              excluded: n,
              pagesCompleted: n,
              resolved: n,
              reused: n,
              rowsDeleted: n,
              skipped: n,
              symbols: n,
              total: n + 1,
            },
            phase,
            subphase: phase === 'resolving' ? 'complete' : subphase,
          });
          expect(progress.phase).toBe(phase);
          if (progress.phase === 'waiting') {
            if (progress.reason !== undefined) expect(allowedWaiting.has(progress.reason)).toBe(true);
          }
          if (progress.phase === 'scanning' || progress.phase === 'materializing') {
            expect(progress.unit).toBe('files');
            expect(progress.total).toBe(n + 1);
          }
          if (progress.phase === 'embedding') expect(progress.unit).toBe('symbols');
          if (progress.phase === 'reclaiming') expect(progress.unit).toBe('snapshots');
        },
      ),
      {numRuns: 80},
    );
  });
});

describe('shouldAwaitExistingBuilder and statusBelongsToChild', () => {
  it('elects exactly one owner for every cross-host observe-then-spawn permutation', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({max: 10_000, min: 2}), {maxLength: 20, minLength: 1}), callers => {
        let status: ObservedCodeGraphBuildStatus | undefined;
        let owners = 0;
        const waiters: number[] = [];
        for (const processId of callers) {
          if (shouldAwaitExistingBuilder(status, processId)) {
            waiters.push(processId);
            continue;
          }
          owners += 1;
          status = {
            observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
            owner: {processId, runtime: 'bun', runtimeVersion: '1'},
          } as ObservedCodeGraphBuildStatus;
        }

        expect(owners).toBe(1);
        const completedSnapshotId = 'owner-snapshot';
        expect(waiters.map(() => completedSnapshotId)).toEqual(callers.slice(1).map(() => completedSnapshotId));
      }),
      {numRuns: 100},
    );
  });

  it('awaits active and stalled foreign builders only', () => {
    const livenessValues = ['abandoned', 'active', 'completed', 'failed', 'stalled'] as const;
    fc.assert(
      fc.property(fc.constantFrom(...livenessValues), fc.integer({min: 1, max: 1000}), (liveness, ownerPid) => {
        const status = {
          observation: {heartbeatAgeMilliseconds: 0, liveness},
          owner: {processId: ownerPid, runtime: 'bun' as const, runtimeVersion: '1'},
        } as ObservedCodeGraphBuildStatus;
        expect(shouldAwaitExistingBuilder(status, 99)).toBe(
          (liveness === 'active' || liveness === 'stalled') && ownerPid !== 99,
        );
      }),
      {numRuns: 40},
    );
  });

  it('matches child ownership by pid and rejects the prior build id', () => {
    const status = {
      buildId: 'old-build',
      owner: {processId: 7, runtime: 'bun' as const, runtimeVersion: '1'},
    } as ObservedCodeGraphBuildStatus;
    expect(statusBelongsToChild(status, 7, 'old-build')).toBe(false);
    expect(statusBelongsToChild({...status, buildId: 'new-build'}, 7, 'old-build')).toBe(true);
    expect(statusBelongsToChild({...status, buildId: 'old-build'}, 8, 'old-build')).toBe(false);
    expect(statusBelongsToChild({...status, buildId: 'new-build'}, 8, 'old-build')).toBe(false);
    expect(statusBelongsToChild({...status, buildId: 'other-build'}, 7, 'old-build', 'new-build')).toBe(false);
  });
});

describe('isolated builder exit contracts', () => {
  it('rehydrates typed capacity evidence from a failed child status', () => {
    const evidence = {
      activeReservations: [{bytes: 20, role: 'durable' as const}],
      calibrationIdentity: 'fixture-v1',
      decisionLayer: 'bounded-write-reservation' as const,
      estimateBasis: 'final-fact-bytes-and-row-count' as const,
      filesystems: [{availableBytes: 10, requiredBytes: 30, role: 'durable' as const}],
      modelVersion: 2,
      recovery: 'free-space' as const,
      retryable: false,
    };
    const failure = isolatedBuilderFailureFromStatus(
      {
        capacity: {
          code: 'no-space',
          evidence,
          operation: 'stage persistent code graph facts',
        },
        summary: 'Capacity is insufficient.',
      },
      'fallback',
    );

    expect(failure).toEqual(CodeGraphDiskCapacityPressureError.of('stage persistent code graph facts', evidence));
  });

  effectIt.effect('surfaces summaries and rejects missing results', () =>
    Effect.gen(function* () {
      expect(isolatedBuilderFailureMessage(1, 'lock contended', 'ignored')).toBe('lock contended');
      expect(isolatedBuilderFailureMessage(2, undefined, '  boom  ')).toBe(
        'isolated graph index exited with code 2: boom',
      );
      expect(isolatedBuilderFailureMessage(3, undefined, undefined)).toBe('isolated graph index exited with code 3');

      expect(
        yield* isolatedBuilderResultFromCompletedStatus({
          result: {dirty: false, edges: 4, files: 1, snapshotId: 'snap', symbols: 2},
        }),
      ).toEqual({dirty: false, edges: 4, files: 1, snapshotId: 'snap', symbols: 2});
      expect(String(yield* Effect.flip(isolatedBuilderResultFromCompletedStatus(undefined)))).toMatch(
        /finished without writing a build result/,
      );
    }),
  );

  effectIt.effect('waits for the exact owned result during a bounded post-exit grace', () =>
    Effect.gen(function* () {
      const ownedPending = {
        buildId: 'owned-build',
        owner: {processId: 7, runtime: 'bun' as const, runtimeVersion: '1'},
      } as ObservedCodeGraphBuildStatus;
      const ownedCompleted = {
        ...ownedPending,
        result: {dirty: false, edges: 41, files: 3, snapshotId: 'snapshot', symbols: 29},
      } as ObservedCodeGraphBuildStatus;
      const statuses = [undefined, ownedPending, ownedCompleted] as const;
      let reads = 0;
      const result = yield* awaitOwnedIsolatedBuilderResult(
        Effect.sync(() => statuses[Math.min(reads++, statuses.length - 1)]),
        7,
        'prior-build',
        undefined,
        {pollMilliseconds: 100, timeoutMilliseconds: 500},
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(200);

      expect(yield* Fiber.join(result)).toEqual({
        dirty: false,
        edges: 41,
        files: 3,
        snapshotId: 'snapshot',
        symbols: 29,
      });
      expect(reads).toBe(3);
    }),
  );

  effectIt.effect('fails at the grace deadline when only unrelated results are visible', () =>
    Effect.gen(function* () {
      let reads = 0;
      const unrelated = {
        buildId: 'other-build',
        owner: {processId: 8, runtime: 'bun' as const, runtimeVersion: '1'},
        result: {dirty: false, edges: 999, files: 1, snapshotId: 'other', symbols: 999},
      } as ObservedCodeGraphBuildStatus;
      const outcome = yield* awaitOwnedIsolatedBuilderResult(
        Effect.sync(() => {
          reads += 1;
          return unrelated;
        }),
        7,
        'prior-build',
        'owned-build',
        {pollMilliseconds: 100, timeoutMilliseconds: 300},
      ).pipe(
        Effect.match({
          onFailure: error => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => 'unexpected success',
        }),
        Effect.forkChild,
      );

      yield* TestClock.adjust(300);

      expect(yield* Fiber.join(outcome)).toMatch(/finished without writing a build result/);
      expect(reads).toBe(4);
    }),
  );

  effectIt.effect('remains interruptible while awaiting the result sidecar', () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* awaitOwnedIsolatedBuilderResult(
        Effect.sync(() => {
          reads += 1;
          return undefined;
        }),
        7,
        'prior-build',
        'owned-build',
        {pollMilliseconds: 100, timeoutMilliseconds: 2_000},
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(100);
      expect(reads).toBe(2);
      yield* Fiber.interrupt(result);
      yield* TestClock.adjust(2_000);
      expect(reads).toBe(2);
    }),
  );

  fcEffectProp(
    effectIt,
    'never accepts a foreign, prior, or different-build result while polling (property)',
    {
      sequence: fc.array(fc.constantFrom('absent', 'foreign', 'prior', 'different-build', 'owned-pending'), {
        maxLength: 12,
      }),
    },
    ({sequence}) =>
      Effect.gen(function* () {
        const statusFor = (kind: (typeof sequence)[number]): ObservedCodeGraphBuildStatus | undefined => {
          if (kind === 'absent') return undefined;
          const buildId =
            kind === 'prior' ? 'prior-build' : kind === 'different-build' ? 'different-build' : 'owned-build';
          const processId = kind === 'foreign' ? 8 : 7;
          return {
            buildId,
            owner: {processId, runtime: 'bun' as const, runtimeVersion: '1'},
            ...(kind === 'owned-pending'
              ? {}
              : {result: {dirty: false, edges: 999, files: 1, snapshotId: kind, symbols: 999}}),
          } as ObservedCodeGraphBuildStatus;
        };
        const ownedCompleted = {
          buildId: 'owned-build',
          owner: {processId: 7, runtime: 'bun' as const, runtimeVersion: '1'},
          result: {dirty: false, edges: 41, files: 3, snapshotId: 'owned', symbols: 29},
        } as ObservedCodeGraphBuildStatus;
        const statuses = [...sequence.map(statusFor), ownedCompleted];
        let reads = 0;

        expect(
          yield* awaitOwnedIsolatedBuilderResult(
            Effect.sync(() => statuses[Math.min(reads++, statuses.length - 1)]),
            7,
            'prior-build',
            'owned-build',
            {pollMilliseconds: 0, timeoutMilliseconds: 10_000},
          ),
        ).toEqual({dirty: false, edges: 41, files: 3, snapshotId: 'owned', symbols: 29});
        expect(reads).toBe(statuses.length);
      }),
    {fastCheck: {numRuns: 60}},
  );
});

describe('isolated builder cross-host spawn admission', () => {
  effectIt.effect('transports supersession before the child can publish build status', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-isolated-superseded-'))),
        home =>
          Effect.gen(function* () {
            const identity: RepositoryIdentity = {
              caseMode: 'sensitive',
              checkoutId: 'a'.repeat(64),
              displayName: 'fixture/repository',
              gitCommonDirectory: '/fixture/repository/.git',
              headCommit: 'b'.repeat(40),
              objectFormat: 'sha1',
              repoRoot: '/fixture/repository',
              repositoryId: 'c'.repeat(64),
              worktreeId: 'd'.repeat(64),
            };
            const failure = yield* Effect.flip(
              runIsolatedCodeGraphIndex({
                assertRuntimeSchemaCompatible: () => Effect.void,
                cwd: identity.repoRoot,
                readStatus: succeedUndefined,
                resolveIdentity: () => Effect.succeed(identity),
                project: {
                  graph: {closure: 'dependencies', roots: ['apps/payments']},
                  name: 'payments',
                  uri: 'threadnote://resources/repos/payments',
                },
                spawn: plan => {
                  expect(plan.arguments).toContain('--project');
                  expect(plan.arguments[plan.arguments.indexOf('--project') + 1]).toBe('payments');
                  return {
                    exited: Promise.resolve(CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE),
                    kill: () => undefined,
                    processId: 77,
                  };
                },
                threadnoteHome: home,
              }),
            );
            expect(failure).toBeInstanceOf(CodeGraphRefreshDemandSuperseded);
          }),
        home => Effect.sync(() => rmSync(home, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('reports a database writer including the child owner while build status is unavailable', () =>
    Effect.forEach([process.pid + 1, process.pid], childProcessId =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-isolated-writer-progress-'});
          const identity: RepositoryIdentity = {
            caseMode: 'sensitive',
            checkoutId: 'a'.repeat(64),
            displayName: 'fixture/repository',
            gitCommonDirectory: '/fixture/repository/.git',
            headCommit: 'b'.repeat(40),
            objectFormat: 'sha1',
            repoRoot: '/fixture/repository',
            repositoryId: 'c'.repeat(64),
            worktreeId: 'd'.repeat(64),
          };
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          yield* fs.makeDirectory(path.dirname(layout.databaseWriteLockPath), {recursive: true});
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const observed = yield* Deferred.make<void>();
          const writer = yield* Effect.forkChild(
            withExclusiveFileLock(
              fs,
              layout.databaseWriteLockPath,
              {
                onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
                retryIntervalMilliseconds: 5,
                staleAfterMilliseconds: 120_000,
                waitTimeoutMilliseconds: 5_000,
              },
              Deferred.await(release),
            ),
          );
          yield* Deferred.await(acquired);
          const timestamp = DateTime.formatIso(yield* DateTime.now);
          const activeStatus = {
            buildId: 'owned-build',
            counters: {},
            identity: {
              checkoutId: identity.checkoutId,
              commit: identity.headCommit,
              repositoryId: identity.repositoryId,
              worktreeId: identity.worktreeId,
            },
            observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
            owner: {processId: childProcessId, runtime: 'bun' as const, runtimeVersion: '1'},
            phase: 'registering' as const,
            schemaVersion: 2,
            state: 'running' as const,
            timestamps: {
              heartbeatAt: timestamp,
              lastProgressAt: timestamp,
              phaseStartedAt: timestamp,
              startedAt: timestamp,
              updatedAt: timestamp,
            },
          } as unknown as ObservedCodeGraphBuildStatus;
          let spawned = false;
          let supplied = false;
          const child = yield* runIsolatedCodeGraphIndex({
            assertRuntimeSchemaCompatible: () => Effect.void,
            cwd: identity.repoRoot,
            onProgress: progress =>
              progress.phase === 'waiting' && progress.reason === 'database-writer'
                ? Deferred.succeed(observed, undefined).pipe(Effect.asVoid)
                : Effect.void,
            readStatus: Effect.sync(() => {
              if (!spawned || supplied) return undefined;
              supplied = true;
              return activeStatus;
            }),
            resolveIdentity: () => Effect.succeed(identity),
            spawn: () => {
              spawned = true;
              return {
                exited: new Promise<number>(() => undefined),
                kill: () => undefined,
                processId: childProcessId,
              };
            },
            threadnoteHome: home,
          }).pipe(Effect.forkChild);
          yield* Effect.raceFirst(Deferred.await(observed), Fiber.join(child));
          yield* Fiber.interrupt(child);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(writer);
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('spawns once for concurrent callers on one worktree and attaches the waiter', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-isolated-spawn-'))),
        home =>
          Effect.gen(function* () {
            const identity: RepositoryIdentity = {
              caseMode: 'sensitive',
              checkoutId: 'a'.repeat(64),
              displayName: 'fixture/repository',
              gitCommonDirectory: '/fixture/repository/.git',
              headCommit: 'b'.repeat(40),
              objectFormat: 'sha1',
              repoRoot: '/fixture/repository',
              repositoryId: 'c'.repeat(64),
              worktreeId: 'd'.repeat(64),
            };
            let status: ObservedCodeGraphBuildStatus | undefined;
            let resolveExit: ((code: number) => void) | undefined;
            let spawnCalls = 0;
            const waiterAttached = yield* Deferred.make<void>();
            const activeStatus = {
              buildId: 'owned-build',
              counters: {},
              identity: {
                checkoutId: identity.checkoutId,
                commit: identity.headCommit,
                repositoryId: identity.repositoryId,
                worktreeId: identity.worktreeId,
              },
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
              owner: {processId: 77, runtime: 'bun' as const, runtimeVersion: '1'},
              phase: 'registering' as const,
              request: {key: 'request-a'},
              schemaVersion: 2,
              state: 'running' as const,
              timestamps: {
                heartbeatAt: DateTime.formatIso(yield* DateTime.now),
                lastProgressAt: DateTime.formatIso(yield* DateTime.now),
                phaseStartedAt: DateTime.formatIso(yield* DateTime.now),
                startedAt: DateTime.formatIso(yield* DateTime.now),
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            } as unknown as ObservedCodeGraphBuildStatus;
            const options = {
              assertRuntimeSchemaCompatible: () => Effect.void,
              cwd: identity.repoRoot,
              readStatus: Effect.sync(() => status),
              resolveIdentity: () => Effect.succeed(identity),
              requestKey: 'request-a',
              spawn: () => {
                spawnCalls += 1;
                status = activeStatus;
                return {
                  exited: new Promise<number>(resolve => {
                    resolveExit = resolve;
                  }),
                  kill: () => undefined,
                  processId: 77,
                };
              },
              threadnoteHome: home,
            };

            const owner = yield* runIsolatedCodeGraphIndex(options).pipe(Effect.forkChild);
            while (spawnCalls < 1 || resolveExit === undefined) yield* Effect.yieldNow;
            const waiter = yield* runIsolatedCodeGraphIndex({
              ...options,
              onProgress: progress =>
                progress.phase === 'registering'
                  ? Deferred.succeed(waiterAttached, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            }).pipe(Effect.forkChild);
            yield* Deferred.await(waiterAttached);
            status = {
              ...activeStatus,
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'completed'},
              result: {dirty: false, edges: 11, files: 2, snapshotId: 'snapshot', symbols: 7},
              state: 'completed',
            };
            resolveExit(0);

            expect(yield* Effect.all([Fiber.join(owner), Fiber.join(waiter)], {concurrency: 'unbounded'})).toEqual([
              {
                dirty: false,
                edges: 11,
                files: 2,
                requestKey: 'request-a',
                snapshotId: 'snapshot',
                symbols: 7,
              },
              {
                dirty: false,
                edges: 11,
                files: 2,
                requestKey: 'request-a',
                snapshotId: 'snapshot',
                symbols: 7,
              },
            ]);
            expect(spawnCalls).toBe(1);
          }),
        home => Effect.sync(() => rmSync(home, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('serializes differing request targets and never reuses the first result as fresh', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-isolated-targets-'))),
        home =>
          Effect.gen(function* () {
            const identity: RepositoryIdentity = {
              caseMode: 'sensitive',
              checkoutId: 'a'.repeat(64),
              displayName: 'fixture/repository',
              gitCommonDirectory: '/fixture/repository/.git',
              headCommit: 'b'.repeat(40),
              objectFormat: 'sha1',
              repoRoot: '/fixture/repository',
              repositoryId: 'c'.repeat(64),
              worktreeId: 'd'.repeat(64),
            };
            let status: ObservedCodeGraphBuildStatus | undefined;
            const exits: Array<(code: number) => void> = [];
            let spawnCalls = 0;
            const runningStatus = (ordinal: number) =>
              ({
                buildId: `owned-build-${ordinal}`,
                counters: {},
                identity: {
                  checkoutId: identity.checkoutId,
                  commit: identity.headCommit,
                  repositoryId: identity.repositoryId,
                  worktreeId: identity.worktreeId,
                },
                observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
                owner: {processId: 77 + ordinal, runtime: 'bun' as const, runtimeVersion: '1'},
                phase: 'registering' as const,
                request: {key: ordinal === 0 ? 'request-a' : 'request-b'},
                schemaVersion: 2,
                state: 'running' as const,
                timestamps: {
                  heartbeatAt: new Date().toISOString(),
                  lastProgressAt: new Date().toISOString(),
                  phaseStartedAt: new Date().toISOString(),
                  startedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              }) as unknown as ObservedCodeGraphBuildStatus;
            const common = {
              assertRuntimeSchemaCompatible: () => Effect.void,
              cwd: identity.repoRoot,
              readStatus: Effect.sync(() => status),
              resolveIdentity: () => Effect.succeed(identity),
              spawn: () => {
                const ordinal = spawnCalls++;
                status = runningStatus(ordinal);
                return {
                  exited: new Promise<number>(resolve => exits.push(resolve)),
                  kill: () => undefined,
                  processId: 77 + ordinal,
                };
              },
              threadnoteHome: home,
            };

            const owner = yield* runIsolatedCodeGraphIndex({...common, requestKey: 'request-a'}).pipe(Effect.forkChild);
            while (spawnCalls < 1 || exits[0] === undefined) yield* Effect.yieldNow;
            const waiter = yield* runIsolatedCodeGraphIndex({...common, requestKey: 'request-b'}).pipe(
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            status = {
              ...runningStatus(0),
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'completed'},
              result: {dirty: false, edges: 11, files: 2, snapshotId: 'snapshot-a', symbols: 7},
              state: 'completed',
            };
            exits[0](0);

            expect(yield* Fiber.join(owner)).toEqual({
              dirty: false,
              edges: 11,
              files: 2,
              requestKey: 'request-a',
              snapshotId: 'snapshot-a',
              symbols: 7,
            });
            while (spawnCalls < 2 || exits[1] === undefined) yield* Effect.yieldNow;
            status = {
              ...runningStatus(1),
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'completed'},
              result: {dirty: true, edges: 13, files: 1, snapshotId: 'snapshot-b', symbols: 9},
              state: 'completed',
            };
            exits[1](0);

            expect(yield* Fiber.join(waiter)).toEqual({
              dirty: true,
              edges: 13,
              files: 1,
              requestKey: 'request-b',
              snapshotId: 'snapshot-b',
              symbols: 9,
            });
            expect(spawnCalls).toBe(2);
          }),
        home => Effect.sync(() => rmSync(home, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});
