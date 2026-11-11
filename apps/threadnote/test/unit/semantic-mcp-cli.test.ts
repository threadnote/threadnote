import * as HostProfile from '../../src/semantic/host_profile.js';
import {isJsonObject} from '@threadnote/platform/json';
import {readFileSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Path,
  Option,
  Stdio,
  Stream,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from 'effect';
import {Command} from 'effect/cli';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {
  semanticCapabilities,
  formatSemanticCapabilities,
  readSemanticAgentQueryInput,
} from '../../src/effect/semantic_cli.js';
import {threadnoteCommand} from '../../src/effect/cli.js';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {registerSemanticTool, registerSemanticQueryTool} from '../../src/mcp/server/semantic.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestClock} from 'effect/testing';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {ResourceStore} from '@threadnote/store/resource-store';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {canonicalFileUri, type Observation} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {compileContextBrief, compileSemanticContextKnowledge} from '../../src/context_brief/index.js';
import {runSemanticAgentQueryWith, type SemanticAgentQueryHost} from '../../src/semantic/agent_queries.js';
import {semanticHostProfileName} from '../../src/semantic/host_profile.js';
import {LspFault} from '../../src/semantic/lsp_transport.js';
import type {SemanticContextKnowledgeV1} from '@threadnote/context/types';
import {projectContextBriefAgentView} from '@threadnote/context/projector';
import {makeSemanticAgentDiskQueries} from '../../src/semantic/agent_query_store.js';
import type {SemanticSession} from '../../src/semantic/provider.js';
import {ReadyRecallReadWorkerAdmission} from '../../src/recall/ready_read_boundary.js';
import {loadRecallIndexData} from '@threadnote/recall/index';

// This fixture grants protocol tests only their own current profile bytes; native ACL proof is tested separately.
const protocolProfiles = new Map<
  string,
  {readonly account: string; readonly user: string; readonly worktree: string}
>();
const protocolProfileKey = (config: RuntimeConfig, worktree: string) =>
  JSON.stringify([config.agentContextHome, config.account, config.user, worktree]);
const nativeReadProfile = HostProfile.readSemanticHostProfile;
let restoreProtocolProfiles: (() => void) | undefined;
const trustProtocolProfile = (config: RuntimeConfig, worktree: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (!restoreProtocolProfiles) {
        const spy = vi.spyOn(HostProfile, 'readSemanticHostProfile').mockImplementation((current, requested) => {
          const owned = protocolProfiles.get(protocolProfileKey(current, requested));
          if (!owned) return nativeReadProfile(current, requested);
          const reject = (reason: typeof HostProfile.SemanticHostProfileFault.prototype.reason) =>
            HostProfile.SemanticHostProfileFault.make({reason});
          return Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            if (current.account !== owned.account || current.user !== owned.user) return yield* reject('untrusted');
            if (requested !== owned.worktree) return yield* reject('incompatible');
            if ((yield* fs.realPath(current.agentContextHome)) !== current.agentContextHome)
              return yield* reject('untrusted');
            const file = path.join(
              current.agentContextHome,
              'semantic',
              'profiles',
              semanticHostProfileName(current, requested),
            );
            if (!(yield* fs.exists(file))) return yield* reject('missing');
            const bytes = yield* fs.readFile(file);
            if (bytes.length > 16384) return yield* reject('invalid');
            const text = yield* Effect.try({
              try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
              catch: () => reject('invalid'),
            });
            const value = yield* Effect.try({try: () => JSON.parse(text), catch: () => reject('invalid')});
            const profile = yield* Schema.decodeUnknownEffect(HostProfile.SemanticHostProfile, {
              onExcessProperty: 'error',
            })(value).pipe(Effect.mapError(() => reject('invalid')));
            if (profile.worktree !== requested) return yield* reject('incompatible');
            if (!profile.enabled) return yield* reject('disabled');
            return {home: current.agentContextHome, profile, digest: sha256HexSync(text)};
          }).pipe(
            Effect.mapError(error =>
              Schema.is(HostProfile.SemanticHostProfileFault)(error) ? error : reject('untrusted'),
            ),
          );
        });
        restoreProtocolProfiles = () => spy.mockRestore();
      }
      protocolProfiles.set(protocolProfileKey(config, worktree), {
        account: config.account,
        user: config.user,
        worktree,
      });
    }),
    () =>
      Effect.sync(() => {
        protocolProfiles.delete(protocolProfileKey(config, worktree));
        if (protocolProfiles.size === 0) {
          restoreProtocolProfiles?.();
          restoreProtocolProfiles = undefined;
        }
      }),
  );

const memoryByUri = <A extends {readonly uri: string}>(cards: readonly A[], uri: string) =>
  Option.getOrUndefined(EffectArray.findFirst(cards, card => card.uri === uri));

const citationFailureEvidence = (candidate: unknown, gaps: unknown) => {
  const selected: Record<string, unknown> = {};
  if (isJsonObject(candidate)) {
    for (const key of [
      'freshness',
      'freshnessBasis',
      'preciseStatus',
      'citationSummary',
      'citationReceipts',
      'codeRelations',
      'citationErrorCount',
    ])
      if (key in candidate) selected[key] = candidate[key];
  }
  return EffectString.slice(0, 2048)(JSON.stringify({candidate: selected, gaps}));
};

// Prepare the actual standalone dispatch before native reads allocate their shared deadline.
// The setup command owns Bun.build's uncancellable Promise; the fixture scope owns every output.
const bundledContextWorker = (root: string, home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const command = yield* CommandExecutor;
    const directory = path.join(root, 'context-worker-bundle');
    const bundled = path.join(directory, 'standalone.js');
    yield* command.execute(
      system.executablePath,
      [
        '--eval',
        `const result = await Bun.build(${JSON.stringify({
          entrypoints: [Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url))],
          outdir: directory,
          naming: 'standalone.js',
          target: 'bun',
          format: 'esm',
          minify: true,
        })});
if (!result.success || !result.outputs.some(output => output.path === ${JSON.stringify(bundled)}))
  throw new Error('Context worker bundle failed.');`,
      ],
      {
        env: {...system.environment(), THREADNOTE_HOME: home},
        timeoutMs: 5000,
        maxOutputBytes: 16 * 1024,
        forceKillAfterMilliseconds: 0,
        verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
      },
    );
    return {...system, developmentEntrypoint: bundled};
  });

/** Actual graph, canonical memory reads and citation validation; only the provider RPC is a stable fixture. */
const memoryContextFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-semantic-memory-'}));
  const home = path.join(root, 'home');
  const repository = path.join(root, 'repository');
  yield* fs.makeDirectory(repository);
  yield* fs.makeDirectory(path.join(home, 'semantic', 'profiles'), {recursive: true, mode: 0o700});
  const contextSystem = Option.isSome(yield* Effect.serviceOption(ReadyRecallReadWorkerAdmission))
    ? yield* bundledContextWorker(root, home)
    : yield* SystemInfo;
  const file = path.join(repository, 'main.ts');
  const source = (value: number) => `export class Alpha {\n  run() { return ${value}; }\n  other() { return 7; }\n}\n`;
  yield* fs.writeFileString(file, source(42));
  const manifestPath = path.join(home, 'manifest.json');
  yield* fs.writeFileString(manifestPath, JSON.stringify({version: 1, projects: []}));
  const config: RuntimeConfig = {
    account: 'local',
    user: 'tester',
    agentId: 'semantic-test',
    agentContextHome: home,
    manifestPath,
    manifestSource: 'bundled-example',
  };
  const worktree = canonicalFileUri((yield* path.toFileUrl(repository)).href);
  yield* trustProtocolProfile(config, worktree);
  const uri = canonicalFileUri((yield* path.toFileUrl(file)).href);
  yield* fs.writeFileString(
    path.join(home, 'semantic', 'profiles', semanticHostProfileName(config, worktree)),
    JSON.stringify({
      version: 1,
      enabled: true,
      worktree,
      catalog: {
        candidate: {
          runtime: '/fixture/node',
          runtimeDigest: sha256HexSync('node'),
          runtimeVersion: '24.19.0',
          sdkDirectory: '/fixture/typescript',
          sdkTreeDigest: sha256HexSync('typescript'),
          serverDirectory: '/fixture/server',
          serverTreeDigest: sha256HexSync('server'),
        },
      },
    }),
    {mode: 0o600},
  );
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
  yield* git(['init', '--quiet']);
  const commit = Effect.gen(function* () {
    yield* git(['add', '.']);
    yield* git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ]);
  });
  yield* commit;
  const indexer = yield* CodeGraphIndexer;
  const query = yield* CodeGraphQueryService;
  const publish = indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home});
  yield* publish;
  const nodes = yield* query.inspect({
    threadnoteHome: home,
    cwd: repository,
    operation: 'query',
    query: 'main.ts',
    nodeLimit: 40,
    edgeLimit: 1,
    refresh: false,
    requestMaintenance: false,
  });
  const method = (name: string) => {
    const matches = EffectArray.filter(nodes.nodes, node => node.name === name && node.kind === 'method');
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  const run = method('run');
  const other = method('other');
  let renamed = false;
  let expectedSource = source(43);
  let closingReply: Observation | undefined;
  let definitionRange = {
    start: {line: run.span.line - 1, character: run.span.column - 1},
    end: {line: run.span.endLine - 1, character: run.span.endColumn - 1},
  };
  const resources = yield* ResourceStore;
  const location = {account: config.account, home, user: config.user};
  const stored = new Map<string, string>();
  const remember = (name: string, nodeId: string, body: string, inferred = false, project = 'repository') =>
    Effect.gen(function* () {
      const citations = yield* captureMemoryCodeCitations(config, {callerCwd: repository, refs: [nodeId]});
      expect(citations).toHaveLength(1);
      const memoryUri = `threadnote://user/tester/memories/durable/projects/${project}/${name}.md`;
      const metadata: MemoryMetadata = {
        kind: 'durable',
        memoryId: `tn_${name}`,
        topic: name,
        project,
        status: 'active',
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: 'test',
        timestamp: '2026-11-04T00:00:00.000Z',
        codeCitations: citations,
        authority: inferred ? 'agent_generated' : 'user_approved',
        trust: inferred ? 'inferred' : 'approved',
      };
      const content = formatMemoryDocument('MEMORY', metadata, body);
      yield* resources.write(location, memoryUri, content, {mode: 'create'});
      stored.set(memoryUri, content);
      return memoryUri;
    });
  let compilerCalls = 0;
  let lastKnowledge: SemanticContextKnowledgeV1 | undefined;
  const context: NonNullable<
    SemanticAgentQueryHost<Effect.Services<ReturnType<typeof compileSemanticContextKnowledge>>>['context']
  > = (currentConfig, input, evidence, target) =>
    compileSemanticContextKnowledge(currentConfig, input, evidence, target).pipe(
      Effect.provideService(SystemInfo, contextSystem),
      Effect.tap(knowledge =>
        Effect.sync(() => {
          compilerCalls++;
          lastKnowledge = knowledge;
          expect(knowledge.binding?.scope).toBe('document');
          expect(knowledge.memorySelection?.scope).toBe('symbol-and-file');
          if (renamed) expect(knowledge.memorySelection?.nodeId).not.toBe(run.id);
          else expect(knowledge.memorySelection?.nodeId).toBe(run.id);
        }),
      ),
    );
  const host: SemanticAgentQueryHost<Effect.Services<ReturnType<typeof compileSemanticContextKnowledge>>> = {
    runtimeIdentity: Effect.succeed(sha256HexSync('stable-provider-runtime')),
    context,
    connect: () =>
      Effect.succeed({
        request: body =>
          Effect.gen(function* () {
            const observed: Observation = {
              version: 1,
              repository: sha256HexSync(worktree),
              worktree,
              project: worktree,
              uri,
              content: sha256HexSync(yield* fs.readFile(file)),
              configuration: sha256HexSync('configuration'),
              toolchain: sha256HexSync('toolchain'),
              provider: {id: 'typescript-language-server', version: 'fixture', generation: 1},
              view: {kind: 'disk', id: 'fixture', owner: 'fixture', epoch: 0},
              documentVersion: null,
              projectEpoch: 1,
            };
            if (body.operation === 'agent-observe')
              return yield* Schema.decodeEffect(Schema.Json)(closingReply ?? observed);
            if (body.operation !== 'agent-query') return yield* LspFault.make({code: 'protocol'});
            return yield* Schema.decodeEffect(Schema.Json)({
              version: 1,
              status: 'ok',
              evidence: {
                basis: 'semantic',
                observation: observed,
                scope: 'document',
                completeness: 'partial',
                limitations: ['Stable provider fixture; graph and canonical memory are real'],
              },
              items:
                body.request.operation === 'definition'
                  ? [{uri, range: definitionRange}]
                  : [renamed ? 'Alpha.renamedRun(): number' : 'Alpha.run(): number'],
              offset: 0,
              remaining: 0,
              next: null,
            });
          }).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'}))),
      }),
  };
  const request = {
    callerCwd: repository,
    file: 'main.ts',
    language: 'typescript',
    operation: 'context',
    task: 'Understand Alpha.run and its invariant',
    position: {line: 1, character: 3},
    budgetTokens: 1500,
    maxBytes: 8192,
    maxItems: 20,
    milliseconds: 30000,
  };
  const ask = Effect.gen(function* () {
    const result = yield* runSemanticAgentQueryWith(host, config, request);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Real context composition failed');
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(4500);
    expect(result.items).toHaveLength(1);
    const item = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        kind: Schema.Literal('context'),
        semantic: Schema.Array(Schema.String),
        knowledge: Schema.Unknown,
      }),
    )(result.items[0]);
    expect(item.semantic).toEqual([renamed ? 'Alpha.renamedRun(): number' : 'Alpha.run(): number']);
    if (lastKnowledge === undefined) throw new Error('Semantic handler did not invoke the actual context compiler');
    const publicKnowledge = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        scope: Schema.Literal('document'),
        memorySelection: Schema.Struct({scope: Schema.Literal('symbol-and-file'), nodeId: Schema.String}),
        brief: Schema.Struct({
          durableDecisions: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                uri: Schema.String,
                excerpt: Schema.String,
                actionCard: Schema.optionalKey(Schema.Unknown),
                authority: Schema.optionalKey(Schema.String),
                memoryTrust: Schema.optionalKey(Schema.String),
                freshness: Schema.String,
                freshnessBasis: Schema.String,
              }),
            ),
          ),
          output: Schema.optionalKey(
            Schema.Struct({truncated: Schema.Boolean, omissions: Schema.Record(Schema.String, Schema.Finite)}),
          ),
        }),
      }),
    )(item.knowledge);
    if (renamed) expect(publicKnowledge.memorySelection.nodeId).not.toBe(run.id);
    else expect(publicKnowledge.memorySelection.nodeId).toBe(run.id);
    return {result, knowledge: lastKnowledge, publicKnowledge};
  });
  const unchanged = Effect.gen(function* () {
    for (const [memoryUri, content] of stored) expect(yield* resources.read(location, memoryUri)).toBe(content);
    expect(yield* fs.readFileString(file)).toBe(expectedSource);
    expect(compilerCalls).toBeGreaterThan(0);
  });
  const update = Effect.gen(function* () {
    yield* fs.writeFileString(file, source(43));
    yield* commit;
    yield* publish;
  });
  const addReference = Effect.gen(function* () {
    expectedSource = source(43) + 'const instance = new Alpha();\ninstance.run();\n';
    yield* fs.writeFileString(file, expectedSource);
    yield* commit;
    yield* publish;
  });
  const rename = Effect.gen(function* () {
    const methodLine = '  renamedRun() { return 43; }';
    expectedSource =
      '// External editor rename\nexport class Alpha {\n' +
      methodLine +
      '\n  other() { return 7; }\n}\nconst instance = new Alpha();\ninstance.renamedRun();\n';
    yield* fs.writeFileString(file, expectedSource);
    yield* commit;
    yield* publish;
    // The provider fixture supplies the full authored definition, independently of graph naming/caret heuristics.
    definitionRange = {start: {line: 2, character: 2}, end: {line: 2, character: methodLine.length}};
    request.position = {line: 6, character: 12};
    request.task = 'Understand Alpha.renamedRun and its invariant';
    renamed = true;
  });
  const document = compileContextBrief(config, {
    task: 'Inspect the decision attached to Alpha.run in main.ts',
    scope: {kind: 'repository', callerCwd: repository},
    codeRefs: ['main.ts'],
    mode: 'explain',
    budgetTokens: 1500,
    responseFormat: 'agent',
  }).pipe(Effect.map(projected => projectContextBriefAgentView(projected.structuredContent, true)));
  const diagnostics = Effect.gen(function* () {
    let attached: Observation | undefined;
    let diagnosticCalls = 0;
    const evidence = (observed: Observation) => ({
      basis: 'semantic' as const,
      observation: observed,
      scope: 'document',
      completeness: 'partial' as const,
      limitations: ['Stable diagnostic provider fixture'],
    });
    const api: SemanticSession = {
      upsert: () => Effect.die('The disk coordinator owns attachment'),
      query: () => Effect.die('Diagnostics must not issue navigation queries'),
      diagnostics: observed =>
        Effect.sync(() => {
          diagnosticCalls++;
          const items = EffectArray.map([0, 1], code => ({
            id: sha256HexSync(JSON.stringify([observed.content, code])),
            range: definitionRange,
            code,
            category: 'warning',
            message: renamed ? `renamedRun diagnostic ${code}` : `run diagnostic ${code}`,
          }));
          return {
            observation: observed,
            evidence: evidence(observed),
            items,
            added: items,
            remaining: [],
            resolved: [],
          };
        }),
      project: () => Effect.die('The coordinator owns project verification'),
      observation: () => Effect.succeed(attached),
      available: Effect.succeed(true),
      invalidate: Effect.void,
      close: Effect.die('No provider process exists in this fixture'),
    };
    const coordinator: Parameters<typeof makeSemanticAgentDiskQueries>[0] = {
      attach: seed =>
        Effect.sync(() => {
          attached = {
            ...seed,
            configuration: sha256HexSync('configuration'),
            toolchain: sha256HexSync('toolchain'),
            provider: {...seed.provider, version: 'fixture', generation: 1},
            projectEpoch: 1,
          };
          return {
            observation: attached,
            status: 'experimental' as const,
            completeness: 'partial' as const,
            edits: 'preparation-only' as const,
            project: undefined,
          };
        }),
      observe: observed => fs.readFile(file).pipe(Effect.map(bytes => ({...observed, content: sha256HexSync(bytes)}))),
      use: (_observed, _milliseconds, action) => action(api),
    };
    const disk = yield* makeSemanticAgentDiskQueries(coordinator, worktree, sha256HexSync('stable-provider-runtime'));
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof disk.query>>>();
    const diagnosticHost: SemanticAgentQueryHost = {
      runtimeIdentity: host.runtimeIdentity,
      connect: () =>
        Effect.succeed({
          request: body => {
            if (body.operation !== 'agent-query') return Effect.die('Unexpected diagnostic endpoint operation');
            return disk.query(body.request).pipe(
              Effect.provide(services),
              Effect.flatMap(value => Schema.decodeUnknownEffect(Schema.Json)(value)),
              Effect.mapError(() => LspFault.make({code: 'protocol'})),
            );
          },
        }),
    };
    const input = {
      callerCwd: repository,
      file: 'main.ts',
      language: 'typescript',
      operation: 'diagnostics',
      maxItems: 1,
      maxBytes: 8192,
    };
    return {
      read: (cursor?: import('@threadnote/semantic/views').Continuation) =>
        runSemanticAgentQueryWith(diagnosticHost, config, {...input, ...(cursor ? {cursor} : {})}),
      calls: () => diagnosticCalls,
    };
  });
  return {
    remember,
    ask,
    run,
    other,
    update,
    unchanged,
    addReference,
    rename,
    document,
    prepareMemory: loadRecallIndexData(config, {includeInactive: false}),
    diagnostics,
    rawContext: runSemanticAgentQueryWith(host, config, request),
    closing: (value: Observation | undefined) => {
      closingReply = value;
    },
    node: (nodeId: string) =>
      query.inspect({
        threadnoteHome: home,
        cwd: repository,
        operation: 'node',
        nodeId,
        refresh: false,
        requestMaintenance: false,
      }),
    sourceHash: () => sha256HexSync(expectedSource),
  };
});

describe('semantic context with canonical citation-backed memory', () => {
  effectIt.effect(
    'invalidates pre-rename reads while keeping old citations visibly unresolved without rewriting memory',
    () =>
      Effect.gen(function* () {
        const f = yield* memoryContextFixture;
        yield* f.update;
        yield* f.addReference;
        yield* f.remember('before-rename', f.run.id, 'Applies to: Alpha.run\nInvariant: ORIGINAL_RUN_CONSTRAINT.');
        yield* f.prepareMemory;
        const before = yield* f.ask;
        const beforeImage = structuredClone(before.result);
        expect(JSON.stringify(before.publicKnowledge)).toContain('ORIGINAL_RUN_CONSTRAINT');
        const diagnostics = yield* f.diagnostics;
        const first = yield* diagnostics.read();
        expect(first.status).toBe('ok');
        if (first.status !== 'ok' || first.next === null) throw new Error('Expected retained pre-rename diagnostics');
        const firstImage = structuredClone(first);
        expect(first.evidence.observation.content).toBe(before.result.evidence.observation.content);
        expect(diagnostics.calls()).toBe(1);

        // This is an external editor action, not a Threadnote rename/apply request.
        yield* f.rename;
        const oldPage = yield* diagnostics.read(first.next);
        expect(oldPage.status).toBe('stale');
        expect(oldPage.evidence).toBeNull();
        expect(diagnostics.calls()).toBe(1);

        // An earlier provider observation cannot close a newly composed context read.
        f.closing(before.result.evidence.observation);
        const oldProof = yield* f.rawContext;
        expect(oldProof.status).toBe('stale');
        expect(oldProof.evidence).toBeNull();
        f.closing(undefined);
        const after = yield* f.ask;
        expect(after.result.evidence.observation.content).toBe(f.sourceHash());
        expect(after.result.evidence.observation.content).not.toBe(before.result.evidence.observation.content);
        expect(after.knowledge.binding?.semanticContent).toBe(f.sourceHash());
        expect(after.knowledge.binding?.graph.snapshotId).not.toBe(before.knowledge.binding?.graph.snapshotId);
        expect(after.knowledge.memorySelection?.nodeId).not.toBe(f.run.id);
        const selected = yield* f.node(after.publicKnowledge.memorySelection.nodeId);
        expect(selected.nodes).toHaveLength(1);
        expect(selected.nodes[0]).toMatchObject({
          name: 'renamedRun',
          kind: 'method',
          path: 'main.ts',
          span: {line: 3, column: 3, endLine: 3, endColumn: 30},
        });
        expect(JSON.stringify(after.publicKnowledge)).not.toContain('ORIGINAL_RUN_CONSTRAINT');
        expect(after.knowledge.gaps).toContain('semantic-symbol-memory-coverage-incomplete');

        const freshDiagnostics = yield* diagnostics.read();
        expect(freshDiagnostics.status).toBe('ok');
        if (freshDiagnostics.status !== 'ok') throw new Error('Expected fresh post-rename diagnostics');
        expect(freshDiagnostics.evidence.observation.content).toBe(after.result.evidence.observation.content);
        expect(freshDiagnostics.evidence.observation.uri).toBe(after.result.evidence.observation.uri);
        expect(freshDiagnostics.items).not.toEqual(first.items);
        expect(JSON.stringify(freshDiagnostics.items)).toContain('renamedRun diagnostic');
        expect(diagnostics.calls()).toBe(2);
        expect(before.result).toEqual(beforeImage);
        expect(first).toEqual(firstImage);

        // The document projection exposes the old citation; new-symbol context safely excludes that constraint.
        const document = yield* f.document;
        const unresolved = memoryByUri(document.durableDecisions ?? [], 'threadnote://memory/tn_before-rename');
        expect(unresolved, JSON.stringify(unresolved)).toMatchObject({
          freshness: 'unknown',
          freshnessBasis: 'code-citations',
          authority: 'user_approved',
          memoryTrust: 'approved',
          preciseStatus: 'unknown',
          citationSummary: {unknown: 1},
        });
        expect(
          EffectArray.some(
            document.stalenessAndConflicts ?? [],
            issue =>
              issue.kind === 'unknown-memory-freshness' && issue.uris.includes('threadnote://memory/tn_before-rename'),
          ),
        ).toBe(true);
        yield* f.unchanged;
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 20000},
  );

  effectIt.effect(
    'selects the exact current constraint, labels stale decisions and excludes another method',
    () =>
      Effect.gen(function* () {
        const f = yield* memoryContextFixture;
        const stale = yield* f.remember('stale', f.run.id, 'Applies to: Alpha.run\nInvariant: OLD_DECISION_42.');
        yield* f.update;
        const current = yield* f.remember('current', f.run.id, 'Applies to: Alpha.run\nInvariant: KEEP_CURRENT_43.');
        yield* f.remember('unrelated', f.other.id, 'Applies to: Alpha.other\nInvariant: NEVER_FOR_RUN.');
        yield* f.remember(
          'foreign',
          f.run.id,
          'Applies to: Alpha.run\nInvariant: NEVER_FOREIGN_PROJECT.',
          false,
          'foreign',
        );
        yield* f.prepareMemory;
        const {knowledge, publicKnowledge} = yield* f.ask;
        expect(knowledge.binding?.scope).toBe('document');
        expect(knowledge.memorySelection?.nodeId).toBe(f.run.id);
        const cards = knowledge.brief?.durableDecisions ?? [];
        expect(
          memoryByUri(cards, 'threadnote://memory/tn_current'),
          citationFailureEvidence(memoryByUri(cards, 'threadnote://memory/tn_current'), knowledge.gaps),
        ).toMatchObject({
          freshness: 'fresh',
          authority: 'user_approved',
          memoryTrust: 'approved',
          freshnessBasis: 'code-citations',
        });
        expect(JSON.stringify(publicKnowledge)).toContain('KEEP_CURRENT_43');
        expect(JSON.stringify(publicKnowledge)).not.toContain('NEVER_FOR_RUN');
        expect(JSON.stringify(publicKnowledge)).not.toContain('NEVER_FOREIGN_PROJECT');
        expect(memoryByUri(cards, 'threadnote://memory/tn_stale')).toMatchObject({freshness: 'stale'});
        const visible = publicKnowledge.brief.durableDecisions ?? [];
        expect(memoryByUri(visible, 'threadnote://memory/tn_current')).toMatchObject({
          freshness: 'fresh',
          authority: 'user_approved',
          memoryTrust: 'approved',
          freshnessBasis: 'code-citations',
        });
        const historical = memoryByUri(visible, 'threadnote://memory/tn_stale');
        expect(historical).toMatchObject({freshness: 'stale', freshnessBasis: 'code-citations'});
        expect(publicKnowledge.brief.output?.truncated).toBe(true);
        expect(
          EffectArray.some(EffectRecord.values(publicKnowledge.brief.output?.omissions ?? {}), count => count > 0),
        ).toBe(true);
        expect(JSON.stringify(knowledge.brief)).not.toContain('NEVER_FOR_RUN');
        expect(knowledge.gaps).toContain('semantic-symbol-memory-coverage-incomplete');
        expect(current).not.toBe(stale);
        yield* f.unchanged;
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 20000},
  );

  effectIt.effect(
    'keeps code useful without memory and never promotes inferred guidance to approved',
    () =>
      Effect.gen(function* () {
        const f = yield* memoryContextFixture;
        yield* f.update;
        yield* f.prepareMemory;
        const empty = yield* f.ask;
        expect(empty.knowledge.brief?.durableDecisions ?? []).toEqual([]);
        expect(JSON.stringify(empty.publicKnowledge)).not.toContain('Invariant:');
        yield* f.remember('inferred', f.run.id, 'Applies to: Alpha.run\nInvariant: PROPOSED_ONLY.', true);
        yield* f.remember('file', 'main.ts', 'Applies to: main.ts\nInvariant: KEEP_FILE_CONSTRAINT.');
        yield* f.prepareMemory;
        const {knowledge, publicKnowledge} = yield* f.ask;
        const proposal = memoryByUri(knowledge.brief?.durableDecisions ?? [], 'threadnote://memory/tn_inferred');
        expect(proposal, citationFailureEvidence(proposal, knowledge.gaps)).toMatchObject({
          authority: 'agent_generated',
          memoryTrust: 'inferred',
          freshness: 'fresh',
        });
        expect(JSON.stringify(publicKnowledge)).toContain('PROPOSED_ONLY');
        expect(JSON.stringify(publicKnowledge)).toContain('KEEP_FILE_CONSTRAINT');
        expect(JSON.stringify(publicKnowledge)).toContain('agent_generated');
        expect(JSON.stringify(publicKnowledge)).toContain('inferred');
        expect(
          memoryByUri(publicKnowledge.brief.durableDecisions ?? [], 'threadnote://memory/tn_inferred'),
        ).toMatchObject({authority: 'agent_generated', memoryTrust: 'inferred', freshness: 'fresh'});
        yield* f.unchanged;
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 20000},
  );
});

describe('semantic capability discovery', () => {
  it('reports only selected candidates without inferring installed or qualified support', () => {
    const result = semanticCapabilities();
    expect(result.scope).toBe('distribution-catalog');
    expect(result.status).toBe('ok');
    expect(EffectArray.map(result.providers, provider => provider.id)).toEqual([
      'typescript-language-server',
      'basedpyright',
      'gopls',
      'rust-analyzer',
      'jdtls',
    ]);
    expect(EffectArray.flatMap(result.providers, provider => provider.languages).sort()).toEqual([
      'go',
      'java',
      'javascript',
      'javascriptreact',
      'python',
      'rust',
      'typescript',
      'typescriptreact',
    ]);
    expect(result.readiness).toEqual({
      installation: 'not-assessed',
      project: 'not-assessed',
      queries: 'requires-host-profile',
    });
    expect(result.readSurface.operations).toContain('diagnostics');
    expect(result.readSurface.operations).toContain('context');
    expect(result.readSurface.pending).not.toContain('context');
    expect(result.readSurface.pending).not.toContain('diagnostics');
    for (const provider of result.providers) {
      expect(provider.productionQualified).toBe(false);
      expect(provider.license.disposition).toBe('release-gated');
      expect(provider.qualification).toBe('pending');
    }
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(8192);
    expect(formatSemanticCapabilities(result)).toContain('installation and project not assessed');
  });

  it('exposes effective bounded proposal limits and continuation semantics', () => {
    const surface = semanticCapabilities().readSurface.changeSurface;
    expect(surface).toMatchObject({
      actions: ['prepare', 'status', 'preflight', 'apply', 'recover'],
      readOnly: false,
      writerAuthorityRequired: true,
      writer: {
        admission: 'local-cli-only-task-and-closed-disk-assertion',
        authorization: 'distinct-secret-writer-capability',
        source: 'closed-disk-only-qualified-host',
        editor: 'qualified-integration-required',
        recovery: 'observational-no-source-replay',
        qualification: 'host-platform-and-runtime-proof-required',
      },
    });
    expect(surface.limits).toMatchObject({
      request: {
        maxRequestBytes: 65536,
        minPageBytes: 1024,
        maxPageBytes: 8388608,
        defaultPageBytes: 8192,
        defaultMilliseconds: 10000,
        maxMilliseconds: 45000,
        maxSourceBytes: 4194304,
      },
      store: {maxBlobBytes: 8388608, maxRetainedBytes: 16777216, maxProposals: 32, ttlMilliseconds: 600000},
      closure: {
        maxFiles: 256,
        maxRetainedBytes: 8388608,
        maxEdits: 100000,
        maxProjectFiles: 100000,
        maxRecomputeRounds: 2,
      },
      proposal: {
        maxTargets: 1000,
        maxEditsPerTarget: 10000,
        maxProposalBytes: 8388608,
        maxPageBytes: 8388608,
        pageChunkCodePoints: 512,
      },
      effectiveTargetCount: 256,
      session: {
        queriesPerSession: 4,
        queuedPerSession: 32,
        providersPerHome: 8,
        providersPerWorkspace: 4,
        importsPerHome: 2,
      },
    });
    expect(surface.continuation).toMatchObject({
      offset: 'pass-page.next-to-status; null-means-complete',
      lifetime: 'absolute-ttl; retrieval-does-not-renew; restart-is-stale',
    });
  });

  it('binds runtime candidates to the selected versioned ledger without promoting unqualified pilots', () => {
    const ledger = Schema.decodeUnknownSync(
      Schema.Struct({
        selectedProviders: Schema.Record(Schema.String, Schema.String),
        providers: Schema.Array(
          Schema.Struct({id: Schema.String, version: Schema.String, productionQualified: Schema.Boolean}),
        ),
      }),
    )(
      JSON.parse(
        readFileSync(new URL('../../../../config/semantic-providers/qualification-lock.json', import.meta.url), 'utf8'),
      ),
    );
    const result = semanticCapabilities();
    expect(
      EffectRecord.fromEntries(
        EffectArray.flatMap(result.providers, provider =>
          EffectArray.map(
            EffectArray.filter(provider.languages, language => EffectRecord.has(ledger.selectedProviders, language)),
            language => [language, provider.id] as const,
          ),
        ),
      ),
    ).toEqual(ledger.selectedProviders);
    for (const language of ['typescriptreact', 'javascriptreact']) {
      const provider = Option.getOrUndefined(
        EffectArray.findFirst(result.providers, candidate => candidate.languages.includes(language)),
      );
      expect(provider?.id).toBe('typescript-language-server');
      expect(provider?.candidateVersion).toBe('6.0.2');
      expect(provider?.productionQualified).toBe(false);
      expect(provider?.qualification).toBe('pending');
    }
    for (const [language, id] of EffectRecord.toEntries(ledger.selectedProviders)) {
      const provider = Option.getOrUndefined(
        EffectArray.findFirst(result.providers, candidate => candidate.languages.includes(language)),
      );
      const pinned = Option.getOrUndefined(EffectArray.findFirst(ledger.providers, candidate => candidate.id === id));
      expect(provider?.id).toBe(id);
      expect(provider?.candidateVersion).toBe(pinned?.version);
      expect(provider?.productionQualified).toBe(pinned?.productionQualified);
    }
  });

  it('distinguishes deferred Kotlin from an unsupported language without selecting an alternative provider', () => {
    const deferred = semanticCapabilities({language: 'kotlin'});
    expect(deferred.status).toBe('deferred');
    expect(deferred.providers).toEqual([]);
    expect(deferred.reason).toContain('Kotlin is deferred');
    const unsupported = semanticCapabilities({language: 'ruby'});
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.providers).toEqual([]);
    expect(formatSemanticCapabilities(unsupported)).toContain('No selected provider');
  });

  it('rejects unbounded, malformed and execution-bearing discovery input', () => {
    for (const input of [
      {language: ''},
      {language: 'java\n'},
      {language: EffectString.repeat(513)('x')},
      {executable: '/repo/run'},
      {apply: true},
    ]) {
      expect(() => semanticCapabilities(input)).toThrow();
    }
  });

  it('keeps filtered results deterministic, independent and confined to the requested language', () => {
    const full = semanticCapabilities();
    fc.assert(
      fc.property(
        fc.constantFrom(
          'typescript',
          'javascript',
          'typescriptreact',
          'javascriptreact',
          'python',
          'go',
          'rust',
          'java',
        ),
        language => {
          const result = semanticCapabilities({language});
          expect(result.status).toBe('ok');
          expect(result.providers).toHaveLength(1);
          expect(result.providers[0].languages).toEqual([language]);
          expect(result.providers[0].id).toBe(
            Option.getOrUndefined(
              EffectArray.findFirst(full.providers, provider => provider.languages.includes(language)),
            )?.id,
          );
          const original = structuredClone(result);
          result.providers[0].languages.push('foreign');
          result.providers[0].candidateVersion = 'forged';
          expect(semanticCapabilities({language})).toEqual(original);
          expect(semanticCapabilities()).toEqual(full);
        },
      ),
      {numRuns: 32},
    );
  });

  effectIt.effect('CLI JSON and registered MCP return the same canonical catalog and compact meaning', () =>
    Effect.gen(function* () {
      const cli = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})([
          'semantic',
          'capabilities',
          '--language',
          'java',
          '--json',
        ]),
      ).pipe(provideTestLayer(ApplicationLayer));
      const registry = new EffectMcpServerRegistry();
      registerSemanticTool(registry);
      const mcp = yield* registry
        .invokeTool('semantic_capabilities', {language: 'java'})
        .pipe(provideTestLayer(ApplicationLayer));
      const canonical = JSON.parse(cli.output);
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toEqual(canonical);
      expect(mcp.content).toEqual([
        {type: 'text', text: formatSemanticCapabilities(semanticCapabilities({language: 'java'}))},
      ]);
    }),
  );
  effectIt.effect('CLI and MCP expose the same unsupported query with one compact default payload', () =>
    Effect.gen(function* () {
      const request = {callerCwd: '/unused', file: 'source.kt', language: 'kotlin', operation: 'symbols'};
      const cli = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})(['semantic', 'query', '--json']),
      ).pipe(
        provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(JSON.stringify(request)))})),
        provideTestLayer(ApplicationLayer),
      );
      const registry = new EffectMcpServerRegistry();
      registerSemanticQueryTool(registry, {
        account: 'local',
        user: 'test',
        agentId: 'test',
        agentContextHome: '/unused',
        manifestPath: '/unused/manifest.json',
      });
      const canonical = JSON.parse(cli.output);
      const agent = yield* registry.invokeTool('semantic_query', {request}).pipe(provideTestLayer(ApplicationLayer));
      expect(agent.structuredContent).toBeUndefined();
      expect(agent.content).toEqual([{type: 'text', text: JSON.stringify(canonical)}]);
      const dual = yield* registry
        .invokeTool('semantic_query', {request, responseFormat: 'dual'})
        .pipe(provideTestLayer(ApplicationLayer));
      expect(dual.content).toEqual(agent.content);
      expect(dual.structuredContent).toEqual(canonical);
    }),
  );
  effectIt.effect('CLI and MCP share the owned-view lifecycle and reject malformed scope identically', () =>
    Effect.gen(function* () {
      const request = {
        action: 'close',
        callerCwd: 'relative',
        handle: {id: sha256HexSync('id'), capability: sha256HexSync('secret')},
      };
      const cli = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})(['semantic', 'view', '--json']),
      ).pipe(
        provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(JSON.stringify(request)))})),
        provideTestLayer(ApplicationLayer),
      );
      const registry = new EffectMcpServerRegistry();
      registerSemanticQueryTool(registry, {
        account: 'local',
        user: 'test',
        agentId: 'test',
        agentContextHome: '/unused',
        manifestPath: '/unused/manifest.json',
      });
      const result = yield* registry.invokeTool('semantic_view', {request}).pipe(provideTestLayer(ApplicationLayer));
      const canonical = JSON.parse(cli.output);
      expect(canonical).toMatchObject({version: 1, status: 'invalid-request', evidence: null});
      expect(result.content).toEqual([{type: 'text', text: JSON.stringify(canonical)}]);
      expect(JSON.stringify(result)).not.toContain(request.handle.capability);
    }),
  );
  effectIt.effect('CLI and MCP change actions share strict refusal semantics without disclosing capabilities', () =>
    Effect.gen(function* () {
      const handle = {
        id: sha256HexSync('proposal-id'),
        digest: sha256HexSync('proposal-digest'),
        capability: sha256HexSync('private-read'),
      };
      const writer = {operation: sha256HexSync('writer-operation'), capability: sha256HexSync('private-writer')};
      for (const action of ['prepare', 'status', 'preflight', 'apply', 'recover']) {
        const request =
          action === 'prepare'
            ? {
                version: 1,
                callerCwd: 'relative',
                operation: 'rename',
                file: 'a.ts',
                language: 'typescript',
                position: {line: 0, character: 0},
                newName: 'renamed',
              }
            : action === 'apply' || action === 'recover'
              ? {version: 1, callerCwd: 'relative', writer}
              : {version: 1, callerCwd: 'relative', handle};
        const cli = yield* captureConsole(
          Command.runWith(threadnoteCommand, {version: 'test'})(['semantic', 'change', action, '--json']),
        ).pipe(
          provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(JSON.stringify(request)))})),
          provideTestLayer(ApplicationLayer),
        );
        const registry = new EffectMcpServerRegistry();
        registerSemanticQueryTool(registry, {
          account: 'local',
          user: 'test',
          agentId: 'test',
          agentContextHome: '/unused',
          manifestPath: '/unused/manifest.json',
        });
        const result = yield* registry
          .invokeTool('semantic_change_' + action, {request})
          .pipe(provideTestLayer(ApplicationLayer));
        const canonical = JSON.parse(cli.output);
        expect(canonical).toMatchObject({version: 1, status: 'invalid-request', applicable: false});
        expect(result.structuredContent).toEqual(canonical);
        expect(result.content).toEqual([{type: 'text', text: JSON.stringify(canonical)}]);
        expect(JSON.stringify(result)).not.toContain(handle.capability);
        expect(JSON.stringify(result)).not.toContain(writer.capability);
        expect(cli.output).not.toContain(writer.capability);
      }
    }),
  );
  effectIt.effect('writer boundaries reject forged grants and keep admission local to CLI', () =>
    Effect.gen(function* () {
      const registry = new EffectMcpServerRegistry();
      registerSemanticQueryTool(registry, {
        account: 'local',
        user: 'test',
        agentId: 'test',
        agentContextHome: '/unused',
        manifestPath: '/unused/manifest.json',
      });
      const handle = {
        id: sha256HexSync('read-id'),
        digest: sha256HexSync('read-digest'),
        capability: sha256HexSync('read-secret'),
      };
      const writer = {operation: sha256HexSync('operation'), capability: sha256HexSync('writer-secret')};
      for (const action of ['apply', 'recover']) {
        for (const grant of [{handle}, {writer, taskAuthorization: 'forged'}, {writer: {...writer, admitted: true}}]) {
          const request = {version: 1, callerCwd: '/unused', ...grant};
          const cli = yield* captureConsole(
            Command.runWith(threadnoteCommand, {version: 'test'})(['semantic', 'change', action, '--json']),
          ).pipe(
            provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(JSON.stringify(request)))})),
            provideTestLayer(ApplicationLayer),
          );
          const result = yield* registry
            .invokeTool('semantic_change_' + action, {request})
            .pipe(provideTestLayer(ApplicationLayer));
          const canonical = JSON.parse(cli.output);
          expect(canonical).toMatchObject({version: 1, status: 'invalid-request', applicable: false});
          expect(result.structuredContent).toEqual(canonical);
          for (const secret of [handle.capability, writer.capability]) {
            expect(JSON.stringify(result)).not.toContain(secret);
            expect(cli.output).not.toContain(secret);
          }
        }
      }
      const admission = {
        version: 1,
        callerCwd: 'relative',
        handle,
        taskAuthorization: 'task',
        diskOwnership: 'closed-disk',
      };
      const cli = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})(['semantic', 'change', 'admit', '--json']),
      ).pipe(
        provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(JSON.stringify(admission)))})),
        provideTestLayer(ApplicationLayer),
      );
      expect(JSON.parse(cli.output)).toMatchObject({version: 1, status: 'invalid-request', applicable: false});
      expect(cli.output).not.toContain(handle.capability);
      const absent = yield* registry
        .invokeTool('semantic_change_admit', {request: admission})
        .pipe(Effect.flip, provideTestLayer(ApplicationLayer));
      if (typeof absent !== 'object' || absent === null || !('message' in absent))
        throw new Error('Missing unknown-tool refusal');
      expect(typeof absent.message).toBe('string');
      expect(absent.message).toContain('Unknown memory operation');
    }),
  );
  effectIt.effect(
    'stdin rejects oversized, malformed UTF-8 and incomplete JSON while preserving split codepoints',
    () =>
      Effect.gen(function* () {
        for (const bytes of [new Uint8Array(65537), new Uint8Array([0xff]), new TextEncoder().encode('{')]) {
          expect(
            yield* readSemanticAgentQueryInput.pipe(provideTestLayer(Stdio.layerTest({stdin: Stream.make(bytes)}))),
          ).toBeNull();
        }
        const bytes = new TextEncoder().encode(JSON.stringify({file: 'é.ts'}));
        const split = bytes.indexOf(0xc3) + 1;
        expect(
          yield* readSemanticAgentQueryInput.pipe(
            provideTestLayer(Stdio.layerTest({stdin: Stream.make(bytes.slice(0, split), bytes.slice(split))})),
          ),
        ).toEqual({file: 'é.ts'});
      }),
  );
});
