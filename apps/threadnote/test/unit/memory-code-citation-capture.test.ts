import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {createCodeGraphWorksetRoutingProjection} from '@threadnote/graph/workset_catalog/projection';
import {
  publishCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  stageCodeGraphWorksetCatalogGeneration,
} from '@threadnote/graph/workset_catalog/store';
import {CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION} from '@threadnote/graph/workset_catalog/types';
import {codeGraphWorksetManifestDigest} from '@threadnote/graph/workset_catalog/workset';
import type {
  CodeGraphEffectiveSnapshotCitationEvidence,
  CodeGraphEffectiveSnapshotCitationEvidenceRequest,
} from '@threadnote/graph/citation/primitives';
import {
  CodeGraphStoreBusyError,
  type CodeGraphInventoryFile,
  type CodeGraphStatus,
  type CodeGraphStoreFailure,
  type CodeGraphSymbol,
} from '@threadnote/graph/types';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {ApplicationLayer, StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {
  captureMemoryCodeCitations,
  MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND,
  MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND,
  MemoryCodeCitationCaptureError,
} from '@threadnote/context/citation/capture';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {captureMemoryCodeCitationsForMcp} from '../../src/mcp/memory_code_citation.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerStoreTool} from '../../src/mcp/server/store.js';
import {listDeferredCodeAnchorIntents} from '../../src/memory/deferred/code_anchor.js';
import {DeferredCodeAnchorRefreshScheduler} from '../../src/memory/deferred/code_anchor_scheduler.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const SOURCE = 'export function value() {\n  return "😀";\n}\n';
const SOURCE_HASH = codeGraphCommittedFileContentHash('sha1', new TextEncoder().encode(SOURCE));
const REPOSITORY_ID = Effect2.pipe('1', EffectString.repeat(64));
const COMMIT = Effect2.pipe('2', EffectString.repeat(40));
const SNAPSHOT_ID = `cgsn_${Effect2.pipe('3', EffectString.repeat(40))}`;
const SYMBOL_ID = `cgs_${Effect2.pipe('4', EffectString.repeat(32))}`;
const MODULE_ID = `cgs_${Effect2.pipe('6', EffectString.repeat(32))}`;

describe('memory code citation capture and validation', () => {
  effectIt.effect('registered remember_context retains private busy intents and refuses strict and shared writes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registered-citation-busy-'});
      const root = path.join(home, 'repository');
      yield* fs.makeDirectory(root);
      const config = {...CONFIG, agentContextHome: home, manifestPath: path.join(home, 'manifest.yaml')};
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const fixture = citationFixture(root, {
        acquireLease: () => Effect.fail(CodeGraphStoreBusyError.of('fixture writer busy')),
        statusFor: () => status,
      });
      // Persisted routes require real identity-shaped digests, unlike capture-only fixtures.
      const status: CodeGraphStatus = {
        ...fixture.status,
        identity: {...fixture.status.identity, worktreeId: Effect2.pipe('e', EffectString.repeat(64))},
        readySnapshot: {...fixture.status.readySnapshot!, worktreeId: Effect2.pipe('e', EffectString.repeat(64))},
      };
      let refreshes = 0;
      const scheduler = DeferredCodeAnchorRefreshScheduler.of({schedule: () => Effect.sync(() => void refreshes++)});
      const server = new EffectMcpServerAdapter('citation-busy-test', '1.0.0', '');
      registerStoreTool(server, config, 'remember_context', 'Store memory.');
      const store = yield* ResourceStore;
      const invoke = (citationPolicy: 'defer' | 'require-current' | undefined, topic: string) =>
        server
          .invokeTool('remember_context', {
            callerCwd: root,
            codeRefs: ['src/value.ts'],
            kind: 'handoff',
            text: 'Retain the intended source invariant.',
            topic,
            ...(citationPolicy === undefined ? {} : {citationPolicy}),
          })
          .pipe(provideTestLayer(fixture.layer), Effect.provideService(DeferredCodeAnchorRefreshScheduler, scheduler));
      for (const [policy, topic] of [
        [undefined, 'default'],
        ['defer', 'explicit'],
      ] as const) {
        const result = yield* invoke(policy, topic);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          citationsFinalized: false,
          memoryStored: true,
          pendingCodeRefs: 1,
          recovery: {action: 'retry-capture', retryCondition: 'after-writer-available'},
        });
        expect(JSON.stringify(result.structuredContent)).not.toMatch(/graph index|workset prepare|preparation/u);
        if (!Effect2.Predicate.isObject(result.structuredContent))
          throw new Error('Expected a structured citation response.');
        const uri = String(result.structuredContent.memoryUri);
        const content = yield* store.read({account: config.account, home, user: config.user}, uri);
        expect(parseMemoryDocument(uri, content)?.metadata.codeCitations ?? []).toEqual([]);
        expect(content).toContain('Retain the intended source invariant.');
      }
      const refused = yield* invoke('require-current', 'strict');
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({code: 'graph-writer-busy', writeApplied: false});
      const sharedRoot = `threadnote://user/${config.user}/memories/shared/default`;
      const sharedUri = `${sharedRoot}/durable/existing.md`;
      const sharedBody = '# Existing shared invariant\n\nPreserve canonical shared bytes.\n';
      const location = {account: config.account, home, user: config.user};
      yield* store.write(location, sharedUri, sharedBody, {mode: 'create'});
      const sharedServer = new EffectMcpServerAdapter('shared-citation-busy-test', '1.0.0', '');
      registerStoreTool(sharedServer, config, 'remember_context', 'Store shared memory.', {
        mode: 'shared-read-write',
        shares: [{root: sharedRoot, team: 'default'}],
      });
      for (const policy of [undefined, 'require-current', 'defer'] as const) {
        const shared = yield* sharedServer
          .invokeTool('remember_context', {
            callerCwd: root,
            codeRefs: ['src/value.ts'],
            kind: 'durable',
            replaceUri: sharedUri,
            text: 'Attempted shared replacement.',
            ...(policy === undefined ? {} : {citationPolicy: policy}),
          })
          .pipe(provideTestLayer(fixture.layer), Effect.provideService(DeferredCodeAnchorRefreshScheduler, scheduler));
        expect(shared.isError).toBe(true);
        if (policy === 'defer') {
          expect(JSON.stringify(shared.content)).toContain('cannot write shared memory');
        } else {
          expect(shared.structuredContent).toMatchObject({code: 'graph-writer-busy', writeApplied: false});
        }
        expect(yield* store.read(location, sharedUri)).toBe(sharedBody);
      }
      const intents = yield* listDeferredCodeAnchorIntents(config);
      expect(intents).toHaveLength(2);
      expect(
        EffectArray.every(intents, entry => entry.kind === 'valid' && entry.intent.codeRefs[0] === 'src/value.ts'),
      ).toBe(true);
      expect(refreshes).toBe(0);
      expect(fixture.evidenceCalls()).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('MCP memory writes refuse a busy writer before reading citation evidence', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-citation-writer-'});
      const fixture = citationFixture(root, {
        acquireLease: (_database, _snapshot, _duration, options) => {
          expect(options?.waitTimeoutMilliseconds).toBe(0);
          return Effect.fail(CodeGraphStoreBusyError.of('fixture writer busy'));
        },
      });
      const result = yield* captureMemoryCodeCitationsForMcp(
        CONFIG,
        {callerCwd: root, refs: ['src/value.ts']},
        'remember_context',
      ).pipe(provideTestLayer(fixture.layer));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
      expect(result.failure).toMatchObject({retryable: true});
      expect(result.error.isError).toBe(true);
      expect(result.error.structuredContent).toMatchObject({
        code: 'graph-writer-busy',
        indexingStarted: false,
        retryCondition: 'after-writer-available',
        recovery: {retry: 'same-request'},
        state: 'blocked',
        writeApplied: false,
      });
      expect(fixture.evidenceCalls()).toBe(0);
      expect(fixture.leases()).toEqual({acquired: 0, released: 0});
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('captures exact file and symbol evidence and reuses snapshot-scoped validation receipts', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-capture-'});
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      yield* fs.writeFileString(path.join(root, 'src', 'value.ts'), SOURCE);

      const fixture = citationFixture(root);
      const citations = yield* captureMemoryCodeCitations(CONFIG, {
        callerCwd: root,
        refs: ['src/value.ts', MODULE_ID, SYMBOL_ID],
      }).pipe(provideTestLayer(fixture.layer));

      // A module-root cgs_ reference intentionally becomes the same file
      // citation as its path, then canonical citation IDs deduplicate it.
      expect(citations).toHaveLength(2);
      expect(citations[0]).toMatchObject({
        fileContentHash: {algorithm: 'sha256', value: SOURCE_HASH},
        path: 'src/value.ts',
        repositoryId: REPOSITORY_ID,
        repositoryIdentityKind: 'remote',
        sourceCommit: COMMIT,
        sourceDirty: false,
        sourceSnapshotId: SNAPSHOT_ID,
        target: {kind: 'file'},
      });
      expect(citations[1]).toMatchObject({
        path: 'src/value.ts',
        target: {
          fragmentCanonicalization: 'utf8-source-span-v1',
          kind: 'symbol',
          nodeId: SYMBOL_ID,
          span: fixture.symbol.span,
        },
      });

      const candidate = {
        citationErrorCount: 0,
        codeCitations: citations,
        excerpt: 'The value helper is the stable boundary.',
        kind: 'durable' as const,
        project: 'threadnote',
        rank: 0,
        topic: 'value-helper',
        uri: 'threadnote://user/test/memories/durable/projects/threadnote/value-helper.md',
      };
      const first = yield* validateContextBriefMemoryCitations(CONFIG, {callerCwd: root, kind: 'repository'}, [
        candidate,
      ]).pipe(provideTestLayer(Layer.merge(fixture.layer, CodeGraphLanguagePackRegistry.layer)));
      const callsAfterFirstValidation = fixture.evidenceCalls();
      yield* TestClock.adjust('1 second');
      const second = yield* validateContextBriefMemoryCitations(CONFIG, {callerCwd: root, kind: 'repository'}, [
        candidate,
      ]).pipe(provideTestLayer(Layer.merge(fixture.layer, CodeGraphLanguagePackRegistry.layer)));

      expect(
        Effect2.Option.getOrUndefined(
          Effect2.Option.map(Effect2.Option.fromNullishOr(first[0]?.receipts), __effectOptionalArrayReceiver =>
            EffectArray.map(__effectOptionalArrayReceiver, receipt => receipt.status),
          ),
        ),
      ).toEqual(['exact', 'exact']);
      expect(first[0]?.cacheHits).toBeUndefined();
      expect(
        new Set(
          Effect2.Option.getOrUndefined(
            Effect2.Option.map(Effect2.Option.fromNullishOr(first[0]?.receipts), __effectOptionalArrayReceiver =>
              EffectArray.map(__effectOptionalArrayReceiver, receipt => receipt.observedAt),
            ),
          ),
        ).size,
      ).toBe(1);
      expect(
        new Set(
          Effect2.Option.getOrUndefined(
            Effect2.Option.map(Effect2.Option.fromNullishOr(second[0]?.receipts), __effectOptionalArrayReceiver =>
              EffectArray.map(__effectOptionalArrayReceiver, receipt => receipt.observedAt),
            ),
          ),
        ).size,
      ).toBe(1);
      expect(second[0]?.receipts[0]?.observedAt).not.toBe(first[0]?.receipts[0]?.observedAt);
      expect(
        Effect2.Option.getOrUndefined(
          Effect2.Option.map(Effect2.Option.fromNullishOr(first[0]?.receipts), __effectOptionalArrayReceiver =>
            EffectArray.every(
              __effectOptionalArrayReceiver,
              receipt => receipt.snapshotCompletedAt === '2026-08-26T00:00:00.000Z',
            ),
          ),
        ),
      ).toBe(true);
      expect(second[0]?.cacheHits).toBe(2);
      expect(fixture.evidenceCalls()).toBe(callsAfterFirstValidation);
      expect(fixture.leases()).toEqual({acquired: 3, released: 3});
      expect(fixture.validationSessions()).toBe(2);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('requires path references to be present in the exact-current graph', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-unindexed-path-'});
      const fixture = citationFixture(root);

      const failure = yield* captureMemoryCodeCitations(CONFIG, {
        callerCwd: root,
        refs: ['.github/workflows/ci.yml'],
      }).pipe(provideTestLayer(fixture.layer), Effect.flip);

      expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
      if (!Schema.is(MemoryCodeCitationCaptureError)(failure)) return;
      expect(failure.message).toBe(
        'Code citation path is not present in the exact current graph: .github/workflows/ci.yml. Use a graph-indexed repository-relative path.',
      );
      expect(failure.message).not.toContain(root);
      expect(failure.recovery).toBeUndefined();
      expect(failure.failureCode).toBe('code-reference-unresolved');
      expect(fixture.leases()).toEqual({acquired: 1, released: 1});
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('preserves classified graph-store retryability across the citation capture boundary', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-retryable-store-'});
      const fixture = citationFixture(root, {
        evidenceFailure: CodeGraphStoreBusyError.of('fixture reader is busy'),
      });

      const failure = yield* captureMemoryCodeCitations(CONFIG, {
        callerCwd: root,
        refs: ['src/value.ts'],
      }).pipe(provideTestLayer(fixture.layer), Effect.flip);

      expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
      if (!Schema.is(MemoryCodeCitationCaptureError)(failure)) return;
      expect(failure.retryable).toBe(true);
      expect(failure.failureCode).toBeUndefined();
      expect(failure.recovery).toBeUndefined();
      expect(fixture.leases()).toEqual({acquired: 1, released: 1});
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('rejects a caller checkout swap at the post-capture identity fence', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-identity-fence-'});
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      yield* fs.writeFileString(path.join(root, 'src', 'value.ts'), SOURCE);
      let statusCalls = 0;
      function statusFor() {
        statusCalls += 1;
        const expectedStatus = fixture.status;
        if (statusCalls !== 2) return expectedStatus;
        const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
        return {
          ...expectedStatus,
          identity: {
            ...expectedStatus.identity,
            repositoryId,
            worktreeId: 'swapped-worktree',
          },
          readySnapshot: {
            ...expectedStatus.readySnapshot!,
            repositoryId,
            worktreeId: 'swapped-worktree',
          },
        };
      }
      const fixture = citationFixture(root, {statusFor});

      const failure = yield* captureMemoryCodeCitations(CONFIG, {
        callerCwd: root,
        expectedCallerIdentity: {
          repositoryId: REPOSITORY_ID,
          worktreeId: fixture.status.identity.worktreeId,
        },
        refs: ['src/value.ts'],
      }).pipe(provideTestLayer(fixture.layer), Effect.flip);

      expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
      expect(String(failure)).toContain('Repository graph or worktree changed while code citations were captured');
      expect(fixture.evidenceCalls()).toBe(1);
      expect(statusCalls).toBe(2);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('routes qualified-reference recovery through its published Workset before unchanged retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-qualified-recovery-'});
      const caller = path.join(root, 'caller');
      const sibling = path.join(root, 'sibling');
      const home = path.join(root, 'home');
      yield* fs.makeDirectory(caller, {recursive: true});
      yield* fs.makeDirectory(path.join(sibling, 'src'), {recursive: true});
      yield* fs.makeDirectory(home, {recursive: true});
      yield* fs.writeFileString(path.join(sibling, 'src', 'value.ts'), SOURCE);
      const project = {
        name: 'sibling',
        path: sibling,
        seed: [] as const,
        uri: 'threadnote://resources/repos/sibling',
      };
      const workset = {name: 'citation-routing', projects: [project], unresolvedProjects: [] as const};
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      yield* fs.writeFileString(
        manifestPath,
        EffectArray.join(
          [
            'version: 1',
            'projects:',
            '  - name: sibling',
            `    path: ${JSON.stringify(sibling)}`,
            '    uri: threadnote://resources/repos/sibling',
            '    seed: []',
            'worksets:',
            '  - name: citation-routing',
            '    projects:',
            '      - sibling',
            '',
          ],
          '\n',
        ),
      );
      const staged = yield* stageCodeGraphWorksetCatalogGeneration(home, {
        manifestDigest: codeGraphWorksetManifestDigest(workset),
        members: [{projection: routingProjection(), repositoryKey: project.name}],
        worksetName: workset.name,
      });
      yield* publishCodeGraphWorksetCatalogGeneration(home, {
        generationId: staged.id,
        worksetName: workset.name,
      });
      const qualified = yield* registerCodeGraphQualifiedRef(home, {nodeId: SYMBOL_ID, repositoryId: REPOSITORY_ID});
      let siblingCurrent = false;
      let swapCallerAfterCapture = false;
      let callerFences = 0;
      const fixture = citationFixture(sibling, {
        statusFor: (cwd, observeWorktree) => {
          if (cwd === caller) {
            const status = callerStatus(caller);
            if (observeWorktree === true) callerFences += 1;
            return swapCallerAfterCapture && callerFences === 2
              ? {...status, identity: {...status.identity, worktreeId: 'swapped-caller'}}
              : status;
          }
          return observeWorktree === false || siblingCurrent
            ? fixture.status
            : {...fixture.status, freshness: 'stale', stale: true};
        },
      });
      const config = {...CONFIG, agentContextHome: home, manifestPath};

      const failure = yield* captureMemoryCodeCitations(config, {
        callerCwd: caller,
        refs: [qualified.ref],
      }).pipe(provideTestLayer(fixture.layer), Effect.flip);
      expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
      if (!Schema.is(MemoryCodeCitationCaptureError)(failure)) return;
      expect(failure.recovery?.preparation).toEqual({
        action: 'prepare-workset',
        arguments: [workset.name],
        command: MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND,
        target: 'workset',
      });
      expect(failure.message).toContain(`Workset ${JSON.stringify(workset.name)}`);
      expect(failure.message).not.toContain(sibling);
      expect(JSON.stringify(failure.recovery)).not.toContain(sibling);

      siblingCurrent = true;
      const citations = yield* captureMemoryCodeCitations(config, {
        callerCwd: caller,
        expectedCallerIdentity: callerStatus(caller).identity,
        expectedProjectScope: {kind: 'full'},
        refs: [qualified.ref],
      }).pipe(provideTestLayer(fixture.layer));
      expect(citations).toMatchObject([{path: 'src/value.ts', target: {kind: 'symbol', nodeId: SYMBOL_ID}}]);

      swapCallerAfterCapture = true;
      callerFences = 0;
      const evidenceBeforeSwap = fixture.evidenceCalls();
      const swapped = yield* captureMemoryCodeCitations(config, {
        callerCwd: caller,
        expectedCallerIdentity: callerStatus(caller).identity,
        expectedProjectScope: {kind: 'full'},
        refs: [qualified.ref],
      }).pipe(provideTestLayer(fixture.layer), Effect.flip);
      expect(String(swapped)).toContain('caller repository identity changed during capture');
      expect(fixture.evidenceCalls()).toBe(evidenceBeforeSwap + 1);
      expect(callerFences).toBe(2);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  fcEffectProp(
    effectIt,
    'returns bounded manual recovery for every non-exact graph admission state',
    {
      status: fc
        .record({
          freshness: fc.constantFrom('current' as const, 'deferred' as const, 'stale' as const),
          hasReadySnapshot: fc.boolean(),
          stale: fc.boolean(),
        })
        .filter(value => !value.hasReadySnapshot || value.stale || value.freshness !== 'current'),
    },
    ({status}) =>
      Effect.gen(function* () {
        const fixture = citationFixture('/fixture', {
          freshness: status.freshness,
          stale: status.stale,
          withoutReadySnapshot: !status.hasReadySnapshot,
        });
        const failure = yield* captureMemoryCodeCitations(CONFIG, {
          callerCwd: '/fixture',
          refs: ['src/value.ts'],
        }).pipe(provideTestLayer(fixture.layer), Effect.flip);

        expect(failure).toBeInstanceOf(MemoryCodeCitationCaptureError);
        if (!Schema.is(MemoryCodeCitationCaptureError)(failure)) return;
        expect(failure.recovery).toEqual({
          code: status.hasReadySnapshot ? 'exact-current-evidence-unavailable' : 'ready-graph-unavailable',
          indexingStarted: false,
          observedGraph: {
            freshness: status.freshness,
            readySnapshot: status.hasReadySnapshot ? 'available' : 'absent',
            stale: status.stale,
          },
          preparation: {
            action: 'index-current-graph',
            arguments: [],
            command: MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND,
            target: 'callerCwd',
          },
          recovery: 'prepare-current-graph',
          retryCondition: 'after-current-graph-ready',
          retryable: true,
          type: 'memory-code-citation-capture-recovery',
          version: 1,
        });
        expect(JSON.stringify(failure.recovery)).not.toContain('/fixture');
      }).pipe(provideTestLayer(StandaloneBrokerLayer)),
    {fastCheck: {numRuns: 36}},
  );
});

function citationFixture(
  root: string,
  statusOptions: {
    readonly acquireLease?: CodeGraphStoreShape['acquireSnapshotLease'];
    readonly evidenceFailure?: CodeGraphStoreFailure;
    readonly freshness?: CodeGraphStatus['freshness'];
    readonly stale?: boolean;
    readonly statusFor?: (cwd: string, observeWorktree: boolean | undefined) => CodeGraphStatus;
    readonly withoutReadySnapshot?: boolean;
  } = {},
) {
  const file: CodeGraphInventoryFile = {
    blobId: 'fixture-blob',
    contentHash: SOURCE_HASH,
    language: 'typescript',
    mode: '100644',
    path: 'src/value.ts',
    size: new TextEncoder().encode(SOURCE).byteLength,
    source: 'commit',
  };
  const symbol: CodeGraphSymbol = {
    contentHash: SOURCE_HASH,
    exported: true,
    id: SYMBOL_ID,
    kind: 'function',
    language: 'typescript',
    name: 'value',
    path: file.path,
    qualifiedName: 'value',
    signature: 'export function value(): string',
    span: {column: 1, endColumn: 2, endLine: 3, line: 1},
  };
  const moduleSymbol: CodeGraphSymbol = {
    ...symbol,
    id: MODULE_ID,
    kind: 'module',
    name: file.path,
    qualifiedName: file.path,
    signature: undefined,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
  const status: CodeGraphStatus = {
    databasePath: `${root}/graph.sqlite`,
    freshness: statusOptions.freshness ?? 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'fixture-checkout',
      displayName: 'example/threadnote',
      gitCommonDirectory: `${root}/.git`,
      headCommit: COMMIT,
      objectFormat: 'sha1',
      remoteIdentity: 'https://github.com/example/threadnote.git',
      repoRoot: root,
      repositoryId: REPOSITORY_ID,
      worktreeId: 'fixture-worktree',
    },
    languagePacks: [],
    ...(statusOptions.withoutReadySnapshot
      ? {}
      : {
          readySnapshot: {
            commit: COMMIT,
            completedAt: '2026-08-26T00:00:00.000Z',
            dirty: false,
            edgeCount: 0,
            extractorSet: 'fixture-extractor-set',
            fileCount: 1,
            graphContentId: `cgc_${Effect2.pipe('5', EffectString.repeat(40))}`,
            id: SNAPSHOT_ID,
            repositoryId: REPOSITORY_ID,
            state: 'ready' as const,
            symbolCount: 1,
            worktreeId: 'fixture-worktree',
          },
        }),
    stale: statusOptions.stale ?? false,
  };
  let evidenceCalls = 0;
  let acquired = 0;
  let released = 0;
  let validationSessions = 0;
  const evidence = (request: CodeGraphEffectiveSnapshotCitationEvidenceRequest) => {
    evidenceCalls += 1;
    const paths = [
      ...new Set([
        ...(request.paths ?? []),
        ...EffectArray.map(request.fileRelocationFallbacks ?? [], item => item.path),
      ]),
    ];
    const contentHashes = [
      ...new Set([
        ...(request.contentHashes ?? []),
        ...EffectArray.map(
          EffectArray.filter(request.fileRelocationFallbacks ?? [], item => item.path !== file.path),
          item => item.contentHash,
        ),
      ]),
    ];
    return {
      fileInventoryCoverage: 'complete',
      filesByContentHashes: EffectArray.map(contentHashes, contentHash => ({
        contentHash,
        files: contentHash === SOURCE_HASH ? [file] : [],
        truncated: false,
      })),
      filesByPaths: EffectArray.map(paths, repositoryPath => ({
        ...(repositoryPath === file.path ? {file} : {}),
        path: repositoryPath,
      })),
      symbolsByIds: EffectArray.filter([moduleSymbol, symbol], candidate =>
        (request.symbolIds ?? []).includes(candidate.id),
      ),
      symbolsBySemanticLocators: EffectArray.map(request.semanticLocators ?? [], locator => ({
        locator,
        symbols: [symbol],
        truncated: false,
      })),
    } satisfies CodeGraphEffectiveSnapshotCitationEvidence;
  };
  const store = {
    acquireSnapshotLease: statusOptions.acquireLease ?? (() => Effect.sync(() => `lease-${++acquired}`)),
    effectiveSnapshotCitationEvidence: (
      _databasePath: string,
      _snapshotId: string,
      request: CodeGraphEffectiveSnapshotCitationEvidenceRequest,
    ) =>
      statusOptions.evidenceFailure === undefined
        ? Effect.sync(() => evidence(request))
        : Effect.fail(statusOptions.evidenceFailure),
    releaseSnapshotLease: () => Effect.sync(() => void ++released),
  } satisfies Partial<CodeGraphStoreShape>;
  const withStatusSession: NonNullable<Parameters<typeof CodeGraphQueryService.of>[0]['withStatusSession']> = (
    _home,
    _cwd,
    _expected,
    _options,
    use,
  ) => Effect.sync(() => void ++validationSessions).pipe(Effect.andThen(use(status)));
  const query = {
    status: (_home: string, cwd: string, options?: {readonly observeWorktree?: boolean}) =>
      Effect.sync(() => statusOptions.statusFor?.(cwd, options?.observeWorktree) ?? status),
    statusForPublishedIdentity: (
      _home: string,
      cwd: string,
      _expected: unknown,
      options?: {readonly observeWorktree?: boolean},
    ) => Effect.sync(() => statusOptions.statusFor?.(cwd, options?.observeWorktree) ?? status),
    withStatusSession,
  } satisfies Partial<Parameters<typeof CodeGraphQueryService.of>[0]>;
  return {
    evidenceCalls: () => evidenceCalls,
    layer: Layer.merge(Layer.mock(CodeGraphStore, store), Layer.mock(CodeGraphQueryService, query)),
    leases: () => ({acquired, released}),
    status,
    symbol,
    validationSessions: () => validationSessions,
  };
}

function routingProjection() {
  return createCodeGraphWorksetRoutingProjection({
    checkoutId: Effect2.pipe('7', EffectString.repeat(64)),
    commitId: COMMIT,
    componentCount: 1,
    extractorGeneration: 13,
    projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
    repositoryId: REPOSITORY_ID,
    snapshotDigest: Effect2.pipe('8', EffectString.repeat(64)),
    snapshotId: SNAPSHOT_ID,
    symbols: [
      {
        exported: true,
        kind: 'function',
        language: 'typescript',
        lookupKeys: ['value'],
        name: 'value',
        nodeId: SYMBOL_ID,
        path: 'src/value.ts',
        qualifiedName: 'value',
        span: {column: 1, endColumn: 2, endLine: 3, line: 1},
        terms: [{term: 'value', weight: 4}],
      },
    ],
    worktreeId: Effect2.pipe('9', EffectString.repeat(64)),
  });
}

function callerStatus(root: string): CodeGraphStatus {
  const repositoryId = Effect2.pipe('a', EffectString.repeat(64));
  return {
    databasePath: `${root}/graph.sqlite`,
    freshness: 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'caller-checkout',
      displayName: 'example/caller',
      gitCommonDirectory: `${root}/.git`,
      headCommit: COMMIT,
      objectFormat: 'sha1',
      remoteIdentity: 'https://github.com/example/caller.git',
      repoRoot: root,
      repositoryId,
      worktreeId: 'caller-worktree',
    },
    languagePacks: [],
    readySnapshot: {
      commit: COMMIT,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'fixture-extractor-set',
      fileCount: 0,
      id: `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}`,
      repositoryId,
      state: 'ready',
      symbolCount: 0,
      worktreeId: 'caller-worktree',
    },
    stale: false,
  };
}

const CONFIG: RuntimeConfig = {
  account: 'test',
  agentContextHome: '/threadnote-home',
  agentId: 'test-agent',
  manifestPath: '/manifest.yaml',
  user: 'test-user',
};
