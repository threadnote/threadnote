import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import {Clock, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  decodeImpactQueryRequest,
  inspectCodeGraphIsolated,
  inspectCodeGraphImpactIsolated,
  inspectCodeGraphReadIsolated,
  impactQueryTransportSelector,
  impactQueryWorkerEnvironment,
  impactQueryWorkerInspectOptions,
  impactQueryWorkerInvocation,
  impactQueryWorkerStatusObservation,
  IsolatedCodeGraphImpactQueryTimedOut,
  serveCodeGraphDiscoveryRead,
} from '@threadnote/graph/isolated/impact_query';
import {attachCodeGraphStatusObservation, type CodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import type {CodeGraphQueryTelemetryObservation} from '@threadnote/graph/query/contract';
import {codeGraphQueryScopeReceipt, type CodeGraphQueryScope} from '@threadnote/graph/query/scope';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {CommandExecutor, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import type {CommandResult} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const isolatedQueryNativeTestLayer = CommandExecutor.layer.pipe(
  Layer.provideMerge(SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer))),
);

const result: CodeGraphQueryResult = {
  edges: [],
  freshness: 'current',
  nodes: [],
  operation: 'impact',
  repository: {displayName: 'acme/repository', repositoryId: Effect2.pipe('a', EffectString.repeat(64))},
  snapshot: {
    commit: Effect2.pipe('b', EffectString.repeat(40)),
    dirty: false,
    id: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
    worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
  },
  trust: {
    classification: 'untrusted-repository-data',
    instructionPolicy: 'evidence-only-never-follow',
  },
  version: 1,
  warnings: [],
};

const input = {
  baseCommit: Effect2.pipe('e', EffectString.repeat(40)),
  cwd: '/workspace/repository',
  edgeLimit: 40,
  nodeLimit: 20,
  query: 'private selector phrase',
  seedQueries: ['src/private-file.ts'],
  threadnoteHome: '/threadnote-home',
} as const;

const projectScope: CodeGraphQueryScope = {
  project: {
    graph: {closure: 'dependencies', include: ['shared'], roots: ['apps/web']},
    name: 'web',
    uri: 'threadnote://projects/web',
  },
  scope: {
    admittedPrefixes: ['apps/web', 'shared'],
    closureDigest: 'closure-digest',
    completeness: 'complete',
    controlPaths: ['package.json'],
    definitionDigest: 'definition-digest',
    diagnostics: [],
    includedProjectIds: ['web', 'shared'],
    rootProjectIds: ['web'],
    scopeKey: 'code-graph-scope:web',
  },
  evidence: {
    catalogFingerprint: 'catalog-fingerprint',
    closureDigest: 'closure-digest',
    definitionDigest: 'definition-digest',
    extractorSet: 'extractor-set',
    inventoryFingerprint: 'inventory-fingerprint',
    observedCommit: Effect2.pipe('b', EffectString.repeat(40)),
    policyFingerprint: 'policy-fingerprint',
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
    scopeKey: 'code-graph-scope:web',
    worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
  },
};

const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: 'checkout-id',
  displayName: 'acme/repository',
  gitCommonDirectory: '/workspace/repository/.git',
  headCommit: Effect2.pipe('b', EffectString.repeat(40)),
  objectFormat: 'sha1',
  repoRoot: '/workspace/repository',
  repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
};

describe('isolated code graph impact query', () => {
  it('keeps request content out of process arguments and the inherited environment', () => {
    const installed = impactQueryWorkerInvocation(
      systemInfoStub({
        executablePath: '/opt/threadnote/bin/threadnote-mcp-server',
        processArguments: ['/opt/threadnote/bin/threadnote-mcp-server'],
      }),
    );
    const development = impactQueryWorkerInvocation(
      systemInfoStub({
        executablePath: '/opt/bin/bun',
        processArguments: ['/opt/bin/bun', '/workspace/apps/threadnote/src/standalone.ts', 'mcp-server'],
      }),
    );
    const environment = impactQueryWorkerEnvironment(
      {
        HOME: '/bootstrap-home',
        PATH: '/bootstrap-bin',
        THREADNOTE_PRIVATE_SELECTOR: input.query,
      },
      input.threadnoteHome,
    );

    expect(installed).toEqual({
      arguments: ['--threadnote-code-graph-impact-query-worker'],
      executable: '/opt/threadnote/bin/threadnote-mcp-server',
    });
    expect(development).toEqual({
      arguments: ['/workspace/apps/threadnote/src/standalone.ts', '--threadnote-code-graph-impact-query-worker'],
      executable: '/opt/bin/bun',
    });
    expect(
      impactQueryWorkerInvocation(
        systemInfoStub({
          executablePath: '/opt/bin/bun',
          processArguments: ['/opt/bin/bun'],
        }),
      ),
    ).toEqual({
      arguments: [
        Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url)),
        '--threadnote-code-graph-impact-query-worker',
      ],
      executable: '/opt/bin/bun',
    });
    expect(JSON.stringify([installed, development, environment])).not.toContain(input.query);
    expect(environment).toEqual({
      HOME: '/bootstrap-home',
      PATH: '/bootstrap-bin',
      THREADNOTE_CODE_GRAPH_IMPACT_QUERY_WORKER: '1',
      THREADNOTE_HOME: input.threadnoteHome,
    });
  });

  effectIt.effect('round-trips one bounded private stdin request and validates the worker response', () =>
    Effect.gen(function* () {
      let observed:
        | {
            readonly arguments: readonly string[];
            readonly executable: string;
            readonly options: CommandOptions | undefined;
          }
        | undefined;
      const command = CommandExecutor.of({
        execute: (executable, arguments_, options) =>
          Effect.sync(() => {
            observed = {arguments: arguments_, executable, options};
            return commandResult(JSON.stringify({ok: true, protocol: 1, result}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });

      const actual = yield* inspectCodeGraphImpactIsolated(input).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
      );

      expect(actual).toEqual(result);
      expect(observed?.arguments).toEqual([
        '/apps/threadnote/src/standalone.ts',
        '--threadnote-code-graph-impact-query-worker',
      ]);
      expect(observed?.options?.timeoutMs).toBe(20_000);
      expect(observed?.options?.maxOutputBytes).toBe(2 * 1_024 * 1_024);
      expect(JSON.stringify([observed?.arguments, observed?.options?.env])).not.toContain(input.query);
      const request = decodeImpactQueryRequest(new TextDecoder().decode(observed?.options?.input));
      expect(request).toMatchObject({...input, protocol: 1, query: 'changed paths'});
    }),
  );

  effectIt.effect('round-trips ordinary query reads through the isolated worker', () =>
    Effect.gen(function* () {
      let encodedRequest: Uint8Array | undefined;
      const queryResult = {...result, operation: 'query' as const};
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            encodedRequest = options?.input;
            return commandResult(JSON.stringify({ok: true, protocol: 1, result: queryResult}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });

      const actual = yield* inspectCodeGraphIsolated({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'query',
        projectScope,
        query: input.query,
        readySnapshotId: result.snapshot.id,
        threadnoteHome: input.threadnoteHome,
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      expect(actual).toEqual(queryResult);
      expect(decodeImpactQueryRequest(new TextDecoder().decode(encodedRequest))).toMatchObject({
        operation: 'query',
        projectScopeReceipt: codeGraphQueryScopeReceipt(projectScope),
        query: input.query,
        readySnapshotId: result.snapshot.id,
      });
    }),
  );

  it('reuses the parent ready snapshot and compact scope receipt in the worker', () => {
    const projectScopeReceipt = codeGraphQueryScopeReceipt(projectScope)!;
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'query',
        projectScopeReceipt,
        protocol: 1,
        query: input.query,
        readySnapshotId: result.snapshot.id,
        threadnoteHome: input.threadnoteHome,
      }),
    );

    expect(request).toBeDefined();
    expect(impactQueryWorkerStatusObservation(request!, identity)).toEqual({
      borrowedSnapshotId: result.snapshot.id,
      identity,
    });
    expect(impactQueryWorkerInspectOptions(request!, input.threadnoteHome)).toMatchObject({
      deferProjectScopePresentation: true,
      readyScopeReceipt: projectScopeReceipt,
    });
  });

  effectIt.effect('keeps very large monorepo scope manifests out of the isolated request', () =>
    Effect.gen(function* () {
      let encodedRequest: Uint8Array | undefined;
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            encodedRequest = options?.input;
            return commandResult(JSON.stringify({ok: true, protocol: 1, result: {...result, operation: 'node'}}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });
      const largeProjectScope: CodeGraphQueryScope = {
        ...projectScope,
        scope: {
          ...projectScope.scope!,
          admittedPrefixes: Array.from(
            {length: 10_000},
            (_, index) =>
              `packages/team-${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}/src/very-long-project-component`,
          ),
          controlPaths: Array.from({length: 10_000}, (_, index) => `packages/team-${index}/package.json`),
          includedProjectIds: Array.from({length: 10_000}, (_, index) => `workspace-project-${index}`),
        },
      };

      yield* inspectCodeGraphIsolated({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
        nodeLimit: input.nodeLimit,
        operation: 'node',
        projectScope: largeProjectScope,
        readySnapshotId: result.snapshot.id,
        threadnoteHome: input.threadnoteHome,
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      expect(encodedRequest).toBeDefined();
      expect(encodedRequest!.byteLength).toBeLessThan(4_096);
      expect(decodeImpactQueryRequest(new TextDecoder().decode(encodedRequest))).toMatchObject({
        operation: 'node',
        projectScopeReceipt: codeGraphQueryScopeReceipt(largeProjectScope),
      });
    }),
  );

  effectIt.effect('accepts every canonical borrowed ready-snapshot identity', () =>
    Effect.gen(function* () {
      const observedSnapshotIds: string[] = [];
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            const request = decodeImpactQueryRequest(new TextDecoder().decode(options?.input));
            observedSnapshotIds.push(request?.borrowedSnapshotId ?? 'missing');
            return commandResult(JSON.stringify({ok: true, protocol: 1, result: {...result, operation: 'query'}}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });
      const snapshotIds = [
        `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}`,
        `cgsn_${Effect2.pipe('b', EffectString.repeat(40))}-direct`,
        `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}-full-${Effect2.pipe('d', EffectString.repeat(16))}`,
      ];

      for (const borrowedSnapshotId of snapshotIds) {
        yield* inspectCodeGraphIsolated({
          borrowedSnapshotId,
          cwd: input.cwd,
          edgeLimit: input.edgeLimit,
          nodeLimit: input.nodeLimit,
          operation: 'query',
          query: input.query,
          threadnoteHome: input.threadnoteHome,
        }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));
      }

      expect(observedSnapshotIds).toEqual(snapshotIds);
    }),
  );

  effectIt.effect('replays bounded worker query-stage telemetry in the parent process', () =>
    Effect.gen(function* () {
      const observed: CodeGraphQueryTelemetryObservation[] = [];
      const command = CommandExecutor.of({
        execute: () =>
          Effect.succeed(
            commandResult(
              JSON.stringify({
                ok: true,
                protocol: 1,
                result: {...result, operation: 'query'},
                telemetry: [
                  {
                    disposition: 'fallback',
                    durationMilliseconds: 17,
                    outcome: 'success',
                    phase: 'graph.query.execute',
                    stage: 'query-worktree-observation',
                  },
                  {
                    disposition: 'skipped',
                    durationMilliseconds: 0,
                    outcome: 'success',
                    phase: 'graph.query.execute',
                    stage: 'query-strict-reobservation',
                  },
                ],
              }),
            ),
          ),
        executeStreaming: () => Effect.die('unused'),
      });
      const onTelemetryObservation = (observation: CodeGraphQueryTelemetryObservation) =>
        Effect.sync(() => {
          observed.push(observation);
        });

      yield* inspectCodeGraphIsolated(
        {
          cwd: input.cwd,
          edgeLimit: input.edgeLimit,
          nodeLimit: input.nodeLimit,
          operation: 'query',
          query: input.query,
          threadnoteHome: input.threadnoteHome,
        },
        {onTelemetryObservation},
      ).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      expect(observed).toEqual([
        {
          disposition: 'fallback',
          durationMilliseconds: 17,
          outcome: 'success',
          phase: 'graph.query.execute',
          stage: 'query-worktree-observation',
        },
        {
          disposition: 'skipped',
          durationMilliseconds: 0,
          outcome: 'success',
          phase: 'graph.query.execute',
          stage: 'query-strict-reobservation',
        },
      ]);
    }),
  );

  effectIt.effect('rejects a worker response for a different inspection operation', () =>
    Effect.gen(function* () {
      const command = CommandExecutor.of({
        execute: () => Effect.succeed(commandResult(JSON.stringify({ok: true, protocol: 1, result}))),
        executeStreaming: () => Effect.die('unused'),
      });

      const failure = yield* inspectCodeGraphIsolated({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'query',
        query: input.query,
        threadnoteHome: input.threadnoteHome,
      }).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
        Effect.flip,
      );

      expect(failure._tag).toBe('IsolatedCodeGraphImpactQueryError');
    }),
  );

  effectIt.effect('returns a typed timeout while an asynchronous child remains stuck', () =>
    Effect.gen(function* () {
      const command = CommandExecutor.of({
        execute: () => Effect.never,
        executeStreaming: () => Effect.die('unused'),
      });
      const fiber = yield* inspectCodeGraphImpactIsolated(input, {timeoutMilliseconds: 100}).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
        Effect.forkChild,
      );
      yield* TestClock.adjust(101);
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(IsolatedCodeGraphImpactQueryTimedOut);
    }),
  );

  effectIt.effect('completes and reaps native isolated query workers across response and timeout boundaries', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-isolated-query-worker-'});
      const responseMarker = path.join(directory, 'response.pid');
      const timeoutMarker = path.join(directory, 'timeout.pid');
      const responseScript = path.join(directory, 'response-worker.ts');
      const timeoutScript = path.join(directory, 'timeout-worker.ts');
      yield* fs.writeFileString(responseScript, nativeIsolatedQueryWorkerFixture(responseMarker, 'respond'));
      yield* fs.writeFileString(timeoutScript, nativeIsolatedQueryWorkerFixture(timeoutMarker, 'block'));

      const invoke = (script: string, timeoutMilliseconds: number) =>
        inspectCodeGraphIsolated(
          {
            cwd: input.cwd,
            edgeLimit: input.edgeLimit,
            nodeLimit: input.nodeLimit,
            operation: 'query',
            query: input.query,
            threadnoteHome: directory,
          },
          {timeoutMilliseconds},
        ).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            developmentEntrypoint: script,
            processArguments: [system.executablePath, 'test.ts'],
          }),
        );

      const responseStartedAt = yield* Clock.currentTimeMillis;
      const response = yield* invoke(responseScript, 2_000);
      expect(response).toEqual({...result, operation: 'query'});
      expect((yield* Clock.currentTimeMillis) - responseStartedAt).toBeLessThan(2_000);
      const responsePid = Number(yield* fs.readFileString(responseMarker));
      expect(system.isProcessRunning(responsePid)).toBe(false);

      const timeoutStartedAt = yield* Clock.currentTimeMillis;
      const timeoutFiber = yield* invoke(timeoutScript, 1_000).pipe(Effect.forkChild);
      const timeoutPid = yield* waitForNativeWorkerPid(fs, timeoutMarker);
      const timeout = yield* Fiber.join(timeoutFiber).pipe(Effect.flip);
      expect(timeout).toBeInstanceOf(IsolatedCodeGraphImpactQueryTimedOut);
      expect(system.isProcessRunning(timeoutPid)).toBe(false);
      const timeoutDuration = (yield* Clock.currentTimeMillis) - timeoutStartedAt;
      expect(timeoutDuration).toBeGreaterThanOrEqual(1_500);
      expect(timeoutDuration).toBeLessThan(3_000);
    }).pipe(TestClock.withLive, provideTestLayer(isolatedQueryNativeTestLayer)),
  );

  effectIt.effect('bounds changed-path content while retaining its exact coverage count', () =>
    Effect.gen(function* () {
      let encodedRequest: Uint8Array | undefined;
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            encodedRequest = options?.input;
            return commandResult(JSON.stringify({ok: true, protocol: 1, result}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });
      const seedQueries = Array.from({length: 201}, (_, index) => `src/file-${index}.ts`);

      yield* inspectCodeGraphImpactIsolated({
        ...input,
        query: Effect2.pipe('src/private-path.ts ', EffectString.repeat(4_000)),
        seedQueries,
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      const request = decodeImpactQueryRequest(new TextDecoder().decode(encodedRequest));
      expect(request?.query).toBe('changed paths');
      expect(request?.seedQueries).toEqual(seedQueries.slice(0, 200));
      expect(request?.seedQueryCount).toBe(201);
    }),
  );

  fcProp(
    effectIt,
    'round-trips SHA-1/SHA-256 bases and every bounded path set without changing order or content (property)',
    {
      baseCommit: fc.oneof(gitObjectId(40), gitObjectId(64)),
      query: fc.string({maxLength: 80}).filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
      seeds: fc.array(
        fc.string({maxLength: 80, minLength: 1}).filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
        {
          maxLength: 30,
        },
      ),
    },
    ({baseCommit, query, seeds}) => {
      fc.pre(query !== '' || seeds.length > 0);
      const request = {
        baseCommit,
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'impact' as const,
        protocol: 1,
        query,
        seedQueries: seeds,
        seedQueryCount: seeds.length,
        threadnoteHome: '/threadnote-home',
      };
      expect(decodeImpactQueryRequest(JSON.stringify(request))).toEqual(request);
    },
    {fastCheck: {numRuns: 80}},
  );

  fcProp(
    effectIt,
    'round-trips every local inspection operation without changing its selector contract (property)',
    {
      operation: fc.constantFrom('query', 'node', 'neighbors', 'explain', 'path', 'impact'),
      overlay: fc.record({
        dirty: fc.boolean(),
        fingerprint: fc.option(
          fc.string({maxLength: 64, minLength: 1}).filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
          {nil: undefined},
        ),
      }),
      prefixes: fc.array(
        fc.string({maxLength: 120, minLength: 1}).filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
        {maxLength: 200},
      ),
      snapshotHash: gitObjectId(40),
      selector: fc
        .string({maxLength: 80, minLength: 1})
        .filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
      strictFreshness: fc.option(fc.boolean(), {nil: undefined}),
    },
    ({operation, overlay, prefixes, selector, snapshotHash, strictFreshness}) => {
      const operationFields =
        operation === 'query' || operation === 'impact'
          ? {query: selector}
          : operation === 'node' || operation === 'neighbors'
            ? {nodeId: selector, query: ''}
            : operation === 'path'
              ? {from: selector, query: '', to: `${selector}-target`}
              : {query: '', symbol: selector};
      const parentScope = {
        ...projectScope,
        scope: {...projectScope.scope!, admittedPrefixes: prefixes},
      };
      const request = {
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation,
        overlay,
        projectScopeReceipt: codeGraphQueryScopeReceipt(parentScope),
        protocol: 1,
        readySnapshotId: `cgsn_${snapshotHash}`,
        ...(strictFreshness === undefined ? {} : {strictFreshness}),
        threadnoteHome: '/threadnote-home',
        ...operationFields,
      };
      expect(request.projectScopeReceipt).toEqual(codeGraphQueryScopeReceipt(projectScope));
      const decoded = decodeImpactQueryRequest(JSON.stringify(request));
      expect(decoded).toEqual(JSON.parse(JSON.stringify(request)));
      expect(impactQueryWorkerInspectOptions(decoded!, '/threadnote-home')).toMatchObject({
        operation,
        readyScopeReceipt: codeGraphQueryScopeReceipt(parentScope),
        strictFreshness: strictFreshness ?? (operation === 'path' || operation === 'impact'),
      });
      expect(impactQueryWorkerStatusObservation(decoded!, identity)).toMatchObject({
        overlay: JSON.parse(JSON.stringify(overlay)),
      });
    },
    {fastCheck: {numRuns: 80}},
  );

  it('uses a fixed selector for seed-based impact instead of duplicating an unbounded changed-path list', () => {
    const oversizedLegacySelector = Effect2.pipe('src/very-long-private-path.ts ', EffectString.repeat(3_000));
    expect(impactQueryTransportSelector(oversizedLegacySelector, ['src/a.ts'])).toBe('changed paths');
    expect(impactQueryTransportSelector('cgs_symbol', undefined)).toBe('cgs_symbol');
  });

  it('keeps the bounded worker on ready-only base evidence', () => {
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        ...input,
        operation: 'impact',
        protocol: 1,
        query: 'changed paths',
        seedQueryCount: input.seedQueries.length,
      }),
    );
    expect(request).toBeDefined();
    expect(impactQueryWorkerInspectOptions(request!, input.threadnoteHome)).toMatchObject({
      baseCommit: input.baseCommit,
      baseCommitPolicy: 'ready-only',
      refresh: false,
      requestMaintenance: false,
      strictFreshness: true,
    });
  });

  it('reconstructs operation-specific ready-only inspect options', () => {
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        cwd: input.cwd,
        direction: 'incoming',
        edgeLimit: input.edgeLimit,
        nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
        nodeLimit: input.nodeLimit,
        operation: 'neighbors',
        protocol: 1,
        query: '',
        threadnoteHome: input.threadnoteHome,
      }),
    );
    expect(request).toBeDefined();
    expect(impactQueryWorkerInspectOptions(request!, input.threadnoteHome)).toMatchObject({
      direction: 'incoming',
      nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
      operation: 'neighbors',
      refresh: false,
      requestMaintenance: false,
      strictFreshness: false,
    });
  });

  it('rejects NUL-bearing, over-count, and non-SHA protocol fields', () => {
    const request = {
      cwd: '/workspace/repository',
      edgeLimit: 40,
      nodeLimit: 20,
      operation: 'impact',
      protocol: 1,
      query: 'selector',
      threadnoteHome: '/threadnote-home',
    };
    expect(decodeImpactQueryRequest(JSON.stringify({...request, query: 'private\0selector'}))).toBeUndefined();
    expect(
      decodeImpactQueryRequest(JSON.stringify({...request, seedQueries: Array.from({length: 201}, () => 'src/a.ts')})),
    ).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...request, baseCommit: 'main'}))).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...request, strictFreshness: 'yes'}))).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...request, overlay: {dirty: 'no'}}))).toBeUndefined();
    expect(
      decodeImpactQueryRequest(JSON.stringify({...request, overlay: {dirty: true, fingerprint: 'a\0b'}})),
    ).toBeUndefined();
  });

  it('rejects discovery requests that also carry parent-selected snapshots', () => {
    const base = {
      cwd: '/workspace/repository',
      discover: true,
      edgeLimit: 40,
      nodeLimit: 20,
      operation: 'query',
      protocol: 1,
      query: 'selector',
      threadnoteHome: '/threadnote-home',
    };
    expect(decodeImpactQueryRequest(JSON.stringify({...base, readySnapshotId: result.snapshot.id}))).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...base, borrowedSnapshotId: result.snapshot.id}))).toBeUndefined();
    expect(
      decodeImpactQueryRequest(
        JSON.stringify({...base, projectScopeReceipt: codeGraphQueryScopeReceipt(projectScope)}),
      ),
    ).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...base, discover: 'yes'}))).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...base, discover: true, strictFreshness: false}))).toBeUndefined();
  });
  it('preserves non-strict reads and the parent worktree observation in the worker', () => {
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        borrowedSnapshotId: result.snapshot.id,
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'impact',
        overlay: {dirty: false},
        protocol: 1,
        query: 'src/a.ts',
        seedQueries: ['src/a.ts'],
        seedQueryCount: 1,
        strictFreshness: false,
        threadnoteHome: input.threadnoteHome,
      }),
    );
    expect(request).toBeDefined();
    expect(request).toMatchObject({overlay: {dirty: false}, strictFreshness: false});
    expect(impactQueryWorkerStatusObservation(request!, identity)).toEqual({
      borrowedSnapshotId: result.snapshot.id,
      identity,
      overlay: {dirty: false},
    });
    expect(impactQueryWorkerInspectOptions(request!, input.threadnoteHome)).toMatchObject({
      operation: 'impact',
      refresh: false,
      requestMaintenance: false,
      strictFreshness: false,
    });
  });
});

const discoverySnapshot = {
  commit: Effect2.pipe('b', EffectString.repeat(40)),
  dirty: false,
  edgeCount: 7,
  extractorSet: 'extractors',
  fileCount: 11,
  id: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
  repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  state: 'ready' as const,
  symbolCount: 13,
  worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
};

function discoveryStatus(
  overrides: Partial<CodeGraphStatus> = {},
  observation: CodeGraphStatusObservation = {identity, projectScope},
): CodeGraphStatus {
  return attachCodeGraphStatusObservation(
    {
      databasePath: '/workspace/graph.sqlite',
      freshness: 'current',
      identity,
      languagePacks: [],
      readySnapshot: discoverySnapshot,
      stale: false,
      ...overrides,
    },
    observation,
  );
}

function discoveryService(
  seen: {status: number; attach: number; allowBorrowedStale?: boolean; inspectOptions?: unknown},
  inspectResult: CodeGraphQueryResult,
  status: CodeGraphStatus,
  attachedStatus: CodeGraphStatus = status,
  selectAttachedStatus: (allowBorrowedStale: boolean | undefined) => CodeGraphStatus = () => attachedStatus,
) {
  return CodeGraphQueryService.of({
    attachSharedReadySnapshot: (_threadnoteHome, _identity, _status, options) => {
      seen.attach += 1;
      seen.allowBorrowedStale = options?.allowBorrowedStale;
      return Effect.succeed(selectAttachedStatus(options?.allowBorrowedStale));
    },
    inspect: options => {
      seen.inspectOptions = options;
      return Effect.succeed(inspectResult);
    },
    purge: () => Effect.die('Unexpected graph purge.'),
    status: () => {
      seen.status += 1;
      return Effect.succeed(status);
    },
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
}

describe('isolated code graph discovery reads', () => {
  const request = {
    cwd: '/workspace/repository',
    discover: true as const,
    edgeLimit: 40,
    nodeLimit: 20,
    operation: 'neighbors' as const,
    nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
    protocol: 1 as const,
    query: '',
    threadnoteHome: '/threadnote-home',
  };

  effectIt.effect('keeps discovery selection and inspection inside the status session', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0};
      const ready = discoveryStatus();
      const service = discoveryService(seen, {...result, operation: 'neighbors'}, ready);
      let active = false;
      let sessions = 0;
      const actual = yield* serveCodeGraphDiscoveryRead(request).pipe(
        Effect.provideService(CodeGraphQueryService, {
          ...service,
          status: () => Effect.die('Discovery must use the status session.'),
          withStatusSession: (_home, _cwd, _expected, options, use) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active = true;
                sessions += 1;
              }),
              () => {
                expect(options).toMatchObject({observeWorktree: false, requestMaintenance: false});
                return use(ready);
              },
              () =>
                Effect.sync(() => {
                  active = false;
                }),
            ),
          inspect: options => {
            expect(active).toBe(true);
            return service.inspect(options);
          },
        }),
      );
      expect(actual.result?.operation).toBe('neighbors');
      expect(sessions).toBe(1);
      expect(active).toBe(false);
    }),
  );

  effectIt.effect('runs status, selection, and read off-thread with a status summary', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0, inspectOptions: undefined as unknown};
      const neighbors = {...result, operation: 'neighbors' as const};
      const service = discoveryService(seen, neighbors, discoveryStatus());

      const actual = yield* serveCodeGraphDiscoveryRead(request).pipe(
        Effect.provideService(CodeGraphQueryService, service),
      );

      expect(seen.status).toBe(1);
      expect(seen.attach).toBe(0);
      expect(actual.status).toEqual({
        stale: false,
        readySnapshotId: discoverySnapshot.id,
        surface: {
          freshness: 'current',
          selection: 'active',
          snapshot: {edgeCount: 7, fileCount: 11, symbolCount: 13},
        },
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
        repoRoot: '/workspace/repository',
      });
      expect(actual.result).toEqual(neighbors);
      expect(seen.inspectOptions).toMatchObject({
        operation: 'neighbors',
        refresh: false,
        requestMaintenance: false,
      });
    }),
  );

  effectIt.effect('carries persisted refresh continuity from the resolved cross-host identity', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0, inspectOptions: undefined as unknown};
      const neighbors = {...result, operation: 'neighbors' as const};
      const service = discoveryService(seen, neighbors, discoveryStatus());
      let observedIdentity: unknown;
      const refresh = {
        currentTargetToken: `cgdq_${Effect2.pipe('1', EffectString.repeat(32))}`,
        latestDesiredToken: `cgdq_${Effect2.pipe('2', EffectString.repeat(32))}`,
        state: 'active' as const,
        type: 'code-graph-refresh-continuity' as const,
        version: 1 as const,
      };

      const actual = yield* serveCodeGraphDiscoveryRead(request, {
        observeRefresh: demandIdentity =>
          Effect.sync(() => {
            observedIdentity = demandIdentity;
            return refresh;
          }),
      }).pipe(Effect.provideService(CodeGraphQueryService, service));

      expect(observedIdentity).toEqual({
        checkoutId: identity.checkoutId,
        scopeId: projectScope.scope?.scopeKey,
        threadnoteHome: request.threadnoteHome,
        worktreeId: identity.worktreeId,
      });
      expect(actual.status?.refresh).toEqual(refresh);
    }),
  );

  effectIt.effect('keeps ready evidence when persisted refresh observation fails', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0, inspectOptions: undefined as unknown};
      const neighbors = {...result, operation: 'neighbors' as const};
      const service = discoveryService(seen, neighbors, discoveryStatus());

      const actual = yield* serveCodeGraphDiscoveryRead(request, {
        observeRefresh: () => Effect.fail(TestError.make({message: 'fixture continuity failure'})),
      }).pipe(Effect.provideService(CodeGraphQueryService, service));

      expect(actual.result).toEqual(neighbors);
      expect(actual.status?.refresh).toBeUndefined();
    }),
  );

  effectIt.effect('re-attaches stale snapshots before reading', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0, inspectOptions: undefined as unknown};
      const stale = discoveryStatus({stale: true, freshness: 'stale'});
      const neighbors = {...result, operation: 'neighbors' as const, freshness: 'stale' as const};
      const service = discoveryService(seen, neighbors, stale);

      const actual = yield* serveCodeGraphDiscoveryRead(request).pipe(
        Effect.provideService(CodeGraphQueryService, service),
      );

      expect(seen.attach).toBe(1);
      expect(actual.status).toEqual({
        stale: true,
        readySnapshotId: discoverySnapshot.id,
        surface: {
          freshness: 'stale',
          selection: 'active',
          snapshot: {edgeCount: 7, fileCount: 11, symbolCount: 13},
        },
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
        repoRoot: '/workspace/repository',
      });
      expect(actual.result).toEqual(neighbors);
    }),
  );

  effectIt.effect('serves a borrowed stale ready snapshot when the active pointer is cold', () =>
    Effect.gen(function* () {
      const seen = {
        status: 0,
        attach: 0,
        allowBorrowedStale: undefined as boolean | undefined,
        inspectOptions: undefined as unknown,
      };
      const cold = discoveryStatus({readySnapshot: undefined, stale: true, freshness: 'stale'});
      const borrowed = discoveryStatus(
        {stale: true, freshness: 'stale'},
        {borrowedSnapshotId: discoverySnapshot.id, identity, projectScope},
      );
      const neighbors = {...result, operation: 'neighbors' as const, freshness: 'stale' as const};
      const service = discoveryService(seen, neighbors, cold, borrowed);

      const actual = yield* serveCodeGraphDiscoveryRead(request).pipe(
        Effect.provideService(CodeGraphQueryService, service),
      );

      expect(seen.attach).toBe(1);
      expect(seen.allowBorrowedStale).toBe(true);
      expect(actual.status).toMatchObject({
        stale: true,
        readySnapshotId: discoverySnapshot.id,
        surface: {freshness: 'stale', selection: 'borrowed'},
      });
      expect(actual.result).toEqual(neighbors);
    }),
  );

  effectIt.effect('refuses stale borrowed snapshots for strict path and impact reads', () =>
    Effect.gen(function* () {
      for (const operation of ['path', 'impact'] as const) {
        const seen = {
          status: 0,
          attach: 0,
          allowBorrowedStale: undefined as boolean | undefined,
          inspectOptions: undefined as unknown,
        };
        const cold = discoveryStatus({readySnapshot: undefined, stale: true, freshness: 'stale'});
        const borrowed = discoveryStatus(
          {stale: true, freshness: 'stale'},
          {borrowedSnapshotId: discoverySnapshot.id, identity, projectScope},
        );
        const missing = discoveryStatus({readySnapshot: undefined, stale: true, freshness: 'stale'});
        const service = discoveryService(seen, {...result, operation}, cold, borrowed, allowBorrowedStale =>
          allowBorrowedStale ? borrowed : missing,
        );
        const request = {
          cwd: input.cwd,
          discover: true as const,
          edgeLimit: input.edgeLimit,
          nodeLimit: input.nodeLimit,
          operation,
          protocol: 1 as const,
          query: operation === 'impact' ? 'src/a.ts' : '',
          threadnoteHome: input.threadnoteHome,
          ...(operation === 'path' ? {from: 'src/a.ts', to: 'src/b.ts'} : {}),
        };

        const actual = yield* serveCodeGraphDiscoveryRead(request).pipe(
          Effect.provideService(CodeGraphQueryService, service),
        );

        expect(seen.attach).toBe(1);
        expect(seen.allowBorrowedStale).toBe(false);
        expect(seen.inspectOptions).toBeUndefined();
        expect(actual).toEqual({
          unavailable: 'no-ready-snapshot',
          identity: {repoRoot: '/workspace/repository', worktreeId: Effect2.pipe('d', EffectString.repeat(64))},
        });
      }
    }),
  );

  effectIt.effect('reports a missing snapshot without reading', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0, inspectOptions: undefined as unknown};
      const missing = discoveryStatus({readySnapshot: undefined, stale: true, freshness: 'stale'});
      const service = discoveryService(seen, {...result, operation: 'neighbors' as const}, missing);

      const actual = yield* serveCodeGraphDiscoveryRead(request).pipe(
        Effect.provideService(CodeGraphQueryService, service),
      );

      expect(seen.inspectOptions).toBeUndefined();
      expect(actual).toEqual({
        unavailable: 'no-ready-snapshot',
        identity: {repoRoot: '/workspace/repository', worktreeId: Effect2.pipe('d', EffectString.repeat(64))},
      });
    }),
  );

  effectIt.effect('filters seeds to the discovered project scope before reading', () =>
    Effect.gen(function* () {
      const seen = {status: 0, attach: 0, inspectOptions: undefined as unknown};
      const impact = {...result, operation: 'impact' as const};
      const service = discoveryService(seen, impact, discoveryStatus());
      const seeds = ['apps/web/a.ts', 'other/a.ts'];

      const actual = yield* serveCodeGraphDiscoveryRead({
        cwd: '/workspace/repository',
        discover: true,
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'impact',
        protocol: 1,
        query: 'apps/web/a.ts',
        seedQueries: seeds,
        seedQueryCount: seeds.length,
        threadnoteHome: '/threadnote-home',
      }).pipe(Effect.provideService(CodeGraphQueryService, service));

      expect(seen.inspectOptions).toMatchObject({seedQueries: ['apps/web/a.ts'], seedQueryCount: 1});
      expect(actual).toEqual({
        result: impact,
        status: {
          stale: false,
          readySnapshotId: discoverySnapshot.id,
          surface: {
            freshness: 'current',
            selection: 'active',
            snapshot: {edgeCount: 7, fileCount: 11, symbolCount: 13},
          },
          worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
          repoRoot: '/workspace/repository',
        },
      });
    }),
  );

  effectIt.effect('returns the worker status summary alongside the result', () =>
    Effect.gen(function* () {
      let encodedRequest: Uint8Array | undefined;
      const neighbors = {...result, operation: 'neighbors' as const};
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            encodedRequest = options?.input;
            return commandResult(
              JSON.stringify({
                ok: true,
                protocol: 1,
                result: neighbors,
                status: {
                  refresh: {
                    currentTargetToken: `cgdq_${Effect2.pipe('1', EffectString.repeat(32))}`,
                    state: 'active',
                    type: 'code-graph-refresh-continuity',
                    version: 1,
                  },
                  stale: false,
                  readySnapshotId: discoverySnapshot.id,
                  surface: {
                    freshness: 'current',
                    selection: 'active',
                    snapshot: {edgeCount: 7, fileCount: 11, symbolCount: 13},
                  },
                  worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
                  repoRoot: '/workspace/repository',
                },
                telemetry: [],
              }),
            );
          }),
        executeStreaming: () => Effect.die('unused'),
      });

      const actual = yield* inspectCodeGraphReadIsolated({
        cwd: input.cwd,
        discover: true,
        edgeLimit: input.edgeLimit,
        nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
        nodeLimit: input.nodeLimit,
        operation: 'neighbors',
        threadnoteHome: input.threadnoteHome,
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      if ('unavailable' in actual) {
        return yield* Effect.die(`expected a successful discovery read, got ${actual.unavailable}`);
      }
      expect(actual.result).toEqual(neighbors);
      expect(actual.status).toEqual({
        refresh: {
          currentTargetToken: `cgdq_${Effect2.pipe('1', EffectString.repeat(32))}`,
          state: 'active',
          type: 'code-graph-refresh-continuity',
          version: 1,
        },
        stale: false,
        readySnapshotId: discoverySnapshot.id,
        surface: {
          freshness: 'current',
          selection: 'active',
          snapshot: {edgeCount: 7, fileCount: 11, symbolCount: 13},
        },
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
        repoRoot: '/workspace/repository',
      });
      const decoded = decodeImpactQueryRequest(new TextDecoder().decode(encodedRequest));
      expect(decoded).toMatchObject({discover: true, operation: 'neighbors'});
      expect(decoded?.readySnapshotId).toBeUndefined();
    }),
  );

  effectIt.effect('fails closed when a discovery response omits its status summary', () =>
    Effect.gen(function* () {
      const neighbors = {...result, operation: 'neighbors' as const};
      const command = CommandExecutor.of({
        execute: () =>
          Effect.succeed(commandResult(JSON.stringify({ok: true, protocol: 1, result: neighbors, telemetry: []}))),
        executeStreaming: () => Effect.die('unused'),
      });

      const failure = yield* inspectCodeGraphReadIsolated({
        cwd: input.cwd,
        discover: true,
        edgeLimit: input.edgeLimit,
        nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
        nodeLimit: input.nodeLimit,
        operation: 'neighbors',
        threadnoteHome: input.threadnoteHome,
      }).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
        Effect.flip,
      );

      expect(failure._tag).toBe('IsolatedCodeGraphImpactQueryError');
    }),
  );

  effectIt.effect('returns the worker no-snapshot verdict with its identity', () =>
    Effect.gen(function* () {
      const identity = {repoRoot: '/workspace/repository', worktreeId: Effect2.pipe('d', EffectString.repeat(64))};
      const command = CommandExecutor.of({
        execute: () =>
          Effect.succeed(
            commandResult(
              JSON.stringify({ok: false, protocol: 1, telemetry: [], unavailable: 'no-ready-snapshot', identity}),
            ),
          ),
        executeStreaming: () => Effect.die('unused'),
      });

      const actual = yield* inspectCodeGraphReadIsolated({
        cwd: input.cwd,
        discover: true,
        edgeLimit: input.edgeLimit,
        nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
        nodeLimit: input.nodeLimit,
        operation: 'neighbors',
        threadnoteHome: input.threadnoteHome,
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      expect(actual).toEqual({unavailable: 'no-ready-snapshot', identity});
    }),
  );

  effectIt.effect('rejects malformed status summaries and unknown unavailability markers', () =>
    Effect.gen(function* () {
      const neighbors = {...result, operation: 'neighbors' as const};
      const broker = (stdout: string) =>
        CommandExecutor.of({
          execute: () => Effect.succeed(commandResult(stdout)),
          executeStreaming: () => Effect.die('unused'),
        });
      const read = (command: ReturnType<typeof broker>) =>
        inspectCodeGraphReadIsolated({
          cwd: input.cwd,
          discover: true,
          edgeLimit: input.edgeLimit,
          nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
          nodeLimit: input.nodeLimit,
          operation: 'neighbors',
          threadnoteHome: input.threadnoteHome,
        }).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(SystemInfo, systemInfoStub({})),
          Effect.flip,
        );
      const badStatus = yield* read(
        broker(
          JSON.stringify({
            ok: true,
            protocol: 1,
            result: neighbors,
            status: {stale: 'yes', readySnapshotId: discoverySnapshot.id},
            telemetry: [],
          }),
        ),
      );
      expect(badStatus._tag).toBe('IsolatedCodeGraphImpactQueryError');
      const badRefresh = yield* read(
        broker(
          JSON.stringify({
            ok: true,
            protocol: 1,
            result: neighbors,
            status: {
              refresh: {
                currentTargetToken: '/private/repository',
                state: 'active',
                type: 'code-graph-refresh-continuity',
                version: 1,
              },
              stale: false,
              surface: {
                freshness: 'current',
                selection: 'active',
                snapshot: {edgeCount: 7, fileCount: 11, symbolCount: 13},
              },
              worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
              repoRoot: '/workspace/repository',
            },
            telemetry: [],
          }),
        ),
      );
      expect(badRefresh._tag).toBe('IsolatedCodeGraphImpactQueryError');
      const badMarker = yield* read(
        broker(JSON.stringify({ok: false, protocol: 1, telemetry: [], unavailable: 'bogus'})),
      );
      expect(badMarker._tag).toBe('IsolatedCodeGraphImpactQueryError');
      const missingIdentity = yield* read(
        broker(JSON.stringify({ok: false, protocol: 1, telemetry: [], unavailable: 'no-ready-snapshot'})),
      );
      expect(missingIdentity._tag).toBe('IsolatedCodeGraphImpactQueryError');
    }),
  );

  fcProp(
    effectIt,
    'round-trips discovery requests without changing selectors or flags (property)',
    {
      operation: fc.constantFrom('query', 'node', 'neighbors', 'explain', 'path', 'impact'),
      query: fc.string({maxLength: 80}).filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
      seeds: fc.array(
        fc.string({maxLength: 80, minLength: 1}).filter(value => !Effect2.pipe(value, EffectString.includes('\0'))),
        {
          maxLength: 10,
        },
      ),
    },
    ({operation, query, seeds}) => {
      if (operation === 'query') fc.pre(query !== '');
      if (operation === 'impact') fc.pre(query !== '' || seeds.length > 0);
      const operationFields =
        operation === 'query' || operation === 'impact'
          ? {
              query,
              ...(operation === 'impact' && seeds.length > 0 ? {seedQueries: seeds, seedQueryCount: seeds.length} : {}),
            }
          : operation === 'node' || operation === 'neighbors'
            ? {nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`, query: ''}
            : operation === 'path'
              ? {from: query === '' ? 'a' : query, query: '', to: `${query === '' ? 'a' : query}-target`}
              : {query: '', symbol: query === '' ? 's' : query};
      const request = {
        cwd: '/workspace/repository',
        discover: true,
        edgeLimit: 40,
        nodeLimit: 20,
        operation,
        protocol: 1,
        threadnoteHome: '/threadnote-home',
        ...operationFields,
      };
      expect(decodeImpactQueryRequest(JSON.stringify(request))).toEqual(JSON.parse(JSON.stringify(request)));
    },
    {fastCheck: {numRuns: 80}},
  );
});

function nativeIsolatedQueryWorkerFixture(marker: string, mode: 'block' | 'respond'): string {
  const queryResult = JSON.stringify({...result, operation: 'query'});
  return `
    await Bun.stdin.text();
    await Bun.write(${JSON.stringify(marker)}, String(process.pid));
    process.stderr.write('drain'.repeat(16_384));
    if (${JSON.stringify(mode)} === 'respond') {
      process.stdout.write(JSON.stringify({ok: true, protocol: 1, result: ${queryResult}, telemetry: []}));
    } else {
      process.on('SIGTERM', () => undefined);
      setInterval(() => undefined, 1_000);
    }
  `;
}

function waitForNativeWorkerPid(fs: FileSystem.FileSystem, marker: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (yield* fs.exists(marker)) {
        const pid = Number(yield* fs.readFileString(marker));
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
      }
      yield* Effect.sleep(10);
    }
    return yield* Effect.die('Native isolated query worker did not signal readiness.');
  });
}

function commandResult(stdout: string): CommandResult {
  return {exitCode: 0, stderr: '', stdout};
}

function gitObjectId(length: 40 | 64): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length})
    .map(characters => EffectArray.join(characters, ''));
}

function systemInfoStub(overrides: Partial<SystemInfoShape>): SystemInfoShape {
  return {
    ...systemRuntimeBoundaries,
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({HOME: '/bootstrap-home', PATH: '/bootstrap-bin'}),
    executablePath: '/opt/bin/bun',
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
    processArguments: ['/opt/bin/bun', '/apps/threadnote/src/standalone.ts', 'mcp-server'],
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
