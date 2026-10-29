import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {startManagerTestServer as startServer} from '../helpers/manager-test-server.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {existsSync} from '@threadnote/testing/node-fs';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Console, Deferred, Effect, Fiber, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  consolidationAgentScript,
  memoryTree,
  parseDoctorChecksFromOutput,
  readManagedMemory,
  resourcesTree,
} from '@threadnote/threadnote/manager/index';
import {
  removeManagerSharedMemorySource,
  storeManagerPersonalMemoryMove,
} from '@threadnote/threadnote/manager/memory/move';
import {
  managerProjectOptions,
  pruneSelectedMemoryUris,
  selectableMemoryUris,
  type TreeNode,
} from '@threadnote/manager/ui';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as lifecycle from '@threadnote/threadnote/lifecycle';
import * as memory from '@threadnote/threadnote/memory/index';
import * as seeding from '@threadnote/threadnote/seeding';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {withSharedRepositoryLock} from '@threadnote/threadnote/effect/share/lock';
import * as automaticCompaction from '@threadnote/graph/automatic/compaction';
import * as isolatedIndex from '@threadnote/graph/isolated/index';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {makeCodeGraphBuildReporter} from '@threadnote/graph/build_status';
import {
  readCodeGraphLocalAssociation,
  recordVerifiedCodeGraphLocalAssociation,
} from '@threadnote/graph/local_provenance';
import {CodeGraphStore} from '@threadnote/graph/store';
import {withCodeGraphMaintenanceIntent, withCodeGraphTargetWorktreeLock} from '@threadnote/graph/maintenance/gate';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import type {CodeGraphWorkspace} from '@threadnote/graph/languages/types';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphEdge,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {runEffect} from '../helpers/effect-runtime.js';
import {
  createMemoryCodeCitation,
  MEMORY_SCHEMA_VERSION,
  MAX_SUPPORTED_MEMORY_SCHEMA_VERSION,
} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {readMemoryWithRelocations} from '@threadnote/memory/relocation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import {Option as EffectOption} from 'effect';

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const TreeNodeJsonSchema = Schema.StructWithRest(Schema.Struct({uri: Schema.String}), [JsonRecordSchema]);
function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

const MANAGER_GRAPH_SNAPSHOT_ID = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const MANAGER_GRAPH_REPLACEMENT_SNAPSHOT_ID = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;

vi.mock('@threadnote/threadnote/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/lifecycle')>();
  return {
    ...actual,
    runRepair: vi.fn((_config, options) => Console.log(options.dryRun ? 'repair dry run' : 'repair applied')),
  };
});

vi.mock('@threadnote/threadnote/memory/index', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/memory/index')>();
  return {
    ...actual,
    runArchive: vi.fn(() => Effect.void),
    runForget: vi.fn(() => Effect.void),
    runRecall: vi.fn((_config, options) => Console.log(`recall result: ${options.query}`)),
  };
});

vi.mock('@threadnote/threadnote/seeding', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/seeding')>();
  return {
    ...actual,
    runSeed: vi.fn((_config: RuntimeConfig, options: {readonly dryRun?: boolean}) =>
      Console.log(options.dryRun ? 'seed dry run' : 'seed applied'),
    ),
    runSeedSkills: vi.fn((_config: RuntimeConfig, options: {readonly dryRun?: boolean}) =>
      Console.log(options.dryRun ? 'seed skills dry run' : 'seed skills applied'),
    ),
  };
});

vi.mock('@threadnote/graph/automatic/compaction', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/graph/automatic/compaction')>();
  return {...actual, compactCodeGraphStorageIsolated: vi.fn(actual.compactCodeGraphStorageIsolated)};
});

vi.mock('@threadnote/graph/isolated/index', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/graph/isolated/index')>();
  return {...actual, runIsolatedCodeGraphIndexSnapshot: vi.fn(actual.runIsolatedCodeGraphIndexSnapshot)};
});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-'));
  const root = join(home, 'data', 'local', 'user', 'denys', 'memories');
  await mkdir(join(root, 'durable', 'projects', 'threadnote'), {recursive: true});
  await writeFile(
    join(root, 'durable', 'projects', 'threadnote', 'manager-ui.md'),
    EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: manager-ui',
        'source_agent_client: codex',
        'timestamp: 2026-06-05T00:00:00.000Z',
        '',
        'Manager UI feature notes.',
      ],
      '\n',
    ),
  );
  await writeFile(join(root, 'durable', 'projects', 'threadnote', '.abstract.md'), 'generated');
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'manifest.yaml'),
    user: 'denys',
  };
}

async function makeSharedManagerRuntime(): Promise<{
  readonly canonicalPath: string;
  readonly config: RuntimeConfig;
  readonly content: string;
  readonly uri: string;
  readonly worktreePath: string;
}> {
  const config = await makeRuntime();
  const worktree = join(config.agentContextHome, 'share', 'worktrees', 'default');
  const remote = join(config.agentContextHome, 'share', 'remote.git');
  const gitdir = join(worktree, '.git');
  const relativePath = join('durable', 'projects', 'threadnote', 'shared-manager.md');
  const canonicalPath = join(
    config.agentContextHome,
    'data',
    'local',
    'user',
    config.user,
    'memories',
    'shared',
    'default',
    relativePath,
  );
  const worktreePath = join(worktree, relativePath);
  const content = managerCitedMemory('Shared Manager original.', false, 'remote');
  await mkdir(join(canonicalPath, '..'), {recursive: true});
  await mkdir(join(worktreePath, '..'), {recursive: true});
  await writeFile(canonicalPath, content);
  await writeFile(worktreePath, content);
  await mkdir(join(config.agentContextHome, 'share', 'teams'), {recursive: true});
  execFileSync('git', ['init', '--bare', '-q', remote], {stdio: 'pipe'});
  initializeGitRepository(worktree);
  execFileSync('git', ['-C', worktree, 'config', 'user.name', 'Threadnote Test'], {stdio: 'pipe'});
  execFileSync('git', ['-C', worktree, 'config', 'user.email', 'test@threadnote.local'], {stdio: 'pipe'});
  execFileSync('git', ['-C', worktree, 'add', '--', relativePath], {stdio: 'pipe'});
  execFileSync(
    'git',
    [
      '-C',
      worktree,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'shared fixture',
    ],
    {stdio: 'pipe'},
  );
  execFileSync('git', ['-C', worktree, 'remote', 'add', 'origin', remote], {stdio: 'pipe'});
  execFileSync('git', ['-C', worktree, 'push', '-qu', 'origin', 'HEAD'], {stdio: 'pipe'});
  await writeFile(
    join(config.agentContextHome, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-08-26T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote,
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  return {
    canonicalPath,
    config,
    content,
    uri: 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared-manager.md',
    worktreePath,
  };
}

function managerCitedMemory(body: string, sourceDirty: boolean, repositoryIdentityKind: 'local' | 'remote'): string {
  const citation = createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
    path: 'apps/threadnote/src/manager/index.ts',
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    repositoryIdentityKind,
    sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
    sourceDirty,
    sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
    target: {kind: 'file'},
    version: 1,
  });
  return formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      memoryId: 'tn_manager_cited',
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'manager',
      status: 'active',
      timestamp: '2026-08-26T00:00:00.000Z',
      topic: 'shared-manager',
    },
    body,
  );
}

async function seedManagerGraph(config: RuntimeConfig, snapshotId = MANAGER_GRAPH_SNAPSHOT_ID): Promise<string> {
  const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'acme/platform',
    gitCommonDirectory: join(config.agentContextHome, 'repository', '.git'),
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    remoteIdentity: 'github.com/acme/platform',
    repoRoot: join(config.agentContextHome, 'repository'),
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
  };
  const generatedSymbols = Array.from({length: 520}, (_, index) => {
    const suffix = Effect2.pipe(index.toString(), EffectString.padStart(4, '0'));
    return graphSymbol(
      `generated-${suffix}`,
      `generatedFunction${suffix}`,
      `packages/app/src/generated/${suffix}.ts`,
      '@acme/app',
      'function',
      'cgp_app',
    );
  });
  const files: readonly CodeGraphInventoryFile[] = [
    graphFile('packages/app/src/index.ts', 'app-index'),
    graphFile('packages/app/src/view.ts', 'app-view'),
    graphFile('packages/core/src/api.ts', 'core-api'),
    ...EffectArray.map(generatedSymbols, symbol => graphFile(symbol.path, symbol.id)),
  ];
  const symbols: readonly CodeGraphSymbol[] = [
    graphSymbol('app', 'App', 'packages/app/src/index.ts', '@acme/app', 'class', 'cgp_app'),
    graphSymbol('view', 'renderView', 'packages/app/src/view.ts', '@acme/app', 'function', 'cgp_app'),
    graphSymbol('api', 'createApi', 'packages/core/src/api.ts', '@acme/core', 'function', 'cgp_core'),
    ...generatedSymbols,
  ];
  const workspace: CodeGraphWorkspace = {
    diagnostics: [],
    fingerprint: 'manager-workspace',
    projects: [
      {
        buildSystem: 'node',
        dependencies: ['cgp_core'],
        dependencyDetails: [{evidence: 'package.json', provenance: 'declared', targetId: 'cgp_core'}],
        diagnostics: [],
        id: 'cgp_app',
        kind: 'package',
        languages: ['typescript'],
        name: '@acme/app',
        provenance: 'declared',
        resolutionDomain: 'typescript',
        root: 'packages/app',
        sourceRoots: ['packages/app/src'],
        workspaceId: 'cgw_root',
        workspaceRoots: ['.'],
      },
      {
        buildSystem: 'node',
        dependencies: [],
        dependencyDetails: [],
        diagnostics: [],
        id: 'cgp_core',
        kind: 'package',
        languages: ['typescript'],
        name: '@acme/core',
        provenance: 'declared',
        resolutionDomain: 'typescript',
        root: 'packages/core',
        sourceRoots: ['packages/core/src'],
        workspaceId: 'cgw_root',
        workspaceRoots: ['.'],
      },
    ],
    workspaces: [
      {
        buildSystem: 'node',
        diagnostics: [],
        id: 'cgw_root',
        name: 'platform',
        provenance: 'declared',
        root: '.',
      },
    ],
  };
  const edges: readonly CodeGraphEdge[] = [
    graphEdge('app-view', 'app', 'App', 'view', 'renderView', 'calls'),
    graphEdge('app-api', 'app', 'App', 'api', 'createApi', 'imports'),
    ...Array.from({length: 1_600}, (_, index) => {
      const source = generatedSymbols[index % generatedSymbols.length];
      const target = generatedSymbols[(index * 17 + 1) % generatedSymbols.length];
      return graphEdge(`generated-edge-${index}`, source.id, source.name, target.id, target.name, 'calls');
    }),
  ];
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: edges.length,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: files.length,
    id: snapshotId,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: symbols.length,
    worktreeId: identity.worktreeId,
  };
  await runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
      yield* store.initialize(layout.databasePath);
      yield* store.withSession(
        layout.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(layout.databasePath, files);
          yield* store.stageWorkspaceCatalog(layout.databasePath, workspace);
          yield* store.stageActivationFacts(layout.databasePath, symbols, edges);
          yield* store.activateStaged(layout.databasePath, identity, snapshot);
        }),
      );
      yield* store.promote(layout.databasePath, identity, snapshot.id);
    }),
  );
  return checkoutId;
}

async function promoteManagerGraphReplacement(config: RuntimeConfig): Promise<string> {
  const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'acme/platform',
    gitCommonDirectory: join(config.agentContextHome, 'repository', '.git'),
    headCommit: Effect2.pipe('2', EffectString.repeat(40)),
    objectFormat: 'sha1',
    remoteIdentity: 'github.com/acme/platform',
    repoRoot: join(config.agentContextHome, 'repository'),
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
  };
  const symbol = graphSymbol('replacement', 'Replacement', 'src/replacement.ts', '@acme/new', 'class', 'cgp_new');
  const file = graphFile(symbol.path, symbol.id);
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: 0,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: 1,
    id: MANAGER_GRAPH_REPLACEMENT_SNAPSHOT_ID,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
  await runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
      yield* store.activate(layout.databasePath, identity, snapshot, [file], [symbol], []);
      yield* store.promote(layout.databasePath, identity, snapshot.id);
    }),
  );
  return snapshot.id;
}

function graphFile(path: string, hash: string): CodeGraphInventoryFile {
  return {
    blobId: hash,
    contentHash: Effect2.pipe(hash, EffectString.padEnd(64, '0')),
    language: 'typescript',
    mode: '100644',
    path,
    size: 100,
    source: 'commit',
  };
}

function graphSymbol(
  id: string,
  name: string,
  path: string,
  packageName: string,
  kind: string,
  resolutionScopeId: string,
): CodeGraphSymbol {
  return {
    contentHash: Effect2.pipe(id, EffectString.padEnd(64, '0')),
    documentation: `Documentation for ${name}.`,
    exported: true,
    id,
    kind,
    language: 'typescript',
    name,
    packageName,
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    resolutionScopeId,
    signature: `export ${kind} ${name}`,
    span: {column: 3, endColumn: 12, endLine: 9, line: 7},
  };
}

function graphEdge(
  id: string,
  sourceId: string,
  sourceName: string,
  targetId: string,
  targetName: string,
  relation: CodeGraphEdge['relation'],
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'packages/app/src/index.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation,
    sourceId,
    sourceName,
    targetId,
    targetName,
  };
}

function fileNode(uri: string, name: string, isSystem = false): TreeNode {
  return {
    isDir: false,
    isShared: false,
    isSystem,
    name,
    relativePath: `durable/projects/threadnote/${name}`,
    uri,
  };
}

async function fetchManagerGraphActionWhenAvailable(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await testHttpFetch(url, init);
    if (response.status !== 409) return response;
    const body = decodeJson(
      Schema.StructWithRest(
        Schema.Struct({
          code: Schema.optionalKey(Schema.String),
          retryAfterMilliseconds: Schema.optionalKey(Schema.Finite),
        }),
        [JsonRecordSchema],
      ),
      await response.clone().json(),
    );
    if (body.code !== 'graph-view-busy' || attempt === 2) return response;
    await new Promise(resolve => setTimeout(resolve, body.retryAfterMilliseconds ?? 1_000));
  }
  throw TestError.make({message: 'Manager graph action retry budget was exhausted.'});
}

function initializeGitRepository(root: string): void {
  execFileSync('git', ['init', '-q', root], {stdio: 'pipe'});
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    {stdio: 'pipe'},
  );
}

function differentGraphIdentity(value: string): string {
  return `${Effect2.pipe(value, EffectString.startsWith('f')) ? 'e' : 'f'}${Effect2.pipe(value, EffectString.slice(1))}`;
}

describe('manager catalog', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
    vi.mocked(memory.runArchive).mockReset();
    vi.mocked(memory.runForget).mockReset();
    vi.mocked(memory.runRecall)
      .mockReset()
      .mockImplementation((_config, options) =>
        Console.log(`recall result: ${options.query}`).pipe(
          Effect.as({queryExpansions: [], ranked: [], totalRanked: 0, warnings: []}),
        ),
      );
  });

  it('maps local memory files into Threadnote URIs with parsed metadata', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    const tree = await runEffect(memoryTree(config));
    const project = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(tree.children), __effectArrayReceiver =>
        EffectOption.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver, child => child.name === 'durable')),
      ),
    )?.children?.[0]?.children?.[0];
    const leaf = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(project?.children), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(__effectArrayReceiver, child => child.name === 'manager-ui.md'),
        ),
      ),
    );

    expect(leaf?.uri).toBe('threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md');
    expect(leaf?.metadata?.project).toBe('threadnote');
    expect(leaf?.metadata?.topic).toBe('manager-ui');
  });

  it('maps seeded resources into a read-only resources tree', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'data', config.account, 'resources');
    await mkdir(join(root, 'agent-skills', 'codex-global'), {recursive: true});
    await writeFile(join(root, 'agent-skills', 'codex-global', 'threadnote-abc123.md'), 'Skill body');

    const tree = await runEffect(resourcesTree(config));
    const skill = EffectOption.getOrUndefined(
      EffectOption.map(
        EffectOption.fromNullishOr(
          EffectOption.getOrUndefined(
            EffectOption.map(
              EffectOption.fromNullishOr(
                EffectOption.getOrUndefined(
                  EffectOption.map(EffectOption.fromNullishOr(tree.children), __effectArrayReceiver =>
                    EffectOption.getOrUndefined(
                      EffectArray.findFirst(__effectArrayReceiver, child => child.name === 'agent-skills'),
                    ),
                  ),
                )?.children,
              ),
              __effectArrayReceiver2 =>
                EffectOption.getOrUndefined(
                  EffectArray.findFirst(__effectArrayReceiver2, child => child.name === 'codex-global'),
                ),
            ),
          )?.children,
        ),
        __effectArrayReceiver3 =>
          EffectOption.getOrUndefined(
            EffectArray.findFirst(__effectArrayReceiver3, child => child.name === 'threadnote-abc123.md'),
          ),
      ),
    );

    expect(tree.name).toBe('resources');
    expect(tree.uri).toBe('threadnote://resources');
    expect(skill?.uri).toBe('threadnote://resources/agent-skills/codex-global/threadnote-abc123.md');
    expect(skill?.metadata).toBeUndefined();
  });

  effectIt.effect('shows external content resources without sync receipts or empty state folders', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'manager-external-tree-'});
        const config = runtimeConfigForTest({agentContextHome: home, account: 'local', user: 'denys'});
        const resources = path.join(home, 'data', 'local', 'resources');
        const source = path.join(resources, 'external', 'superhuman', 'selected');
        const page = path.join(source, 'docs', 'document', 'pages', 'canvas');
        const empty = path.join(source, 'docs', 'empty');
        const pocket = path.join(resources, 'external', 'pocket', 'saved', 'docs', 'article', 'pages', 'main');
        const local = path.join(resources, 'agent-skills', 'codex-global');
        yield* fs.makeDirectory(page, {recursive: true});
        yield* fs.makeDirectory(empty, {recursive: true});
        yield* fs.makeDirectory(pocket, {recursive: true});
        yield* fs.makeDirectory(local, {recursive: true});
        yield* fs.writeFileString(path.join(page, 'page.md'), 'Imported page');
        yield* fs.writeFileString(path.join(pocket, 'article.md'), 'Imported article');
        yield* fs.writeFileString(path.join(local, 'settings.json'), '{}');
        yield* fs.writeFileString(path.join(source, '.access.json'), '{}');
        yield* fs.writeFileString(path.join(source, 'docs', 'document', '.manifest.json'), '{}');
        yield* fs.writeFileString(path.join(empty, '.manifest.json'), '{}');
        const tree = yield* resourcesTree(config);
        const names = (node: typeof tree): readonly string[] => [
          node.name,
          ...EffectArray.flatMap(node.children ?? [], names),
        ];
        expect(names(tree)).toContain('page.md');
        expect(names(tree)).toContain('article.md');
        expect(names(tree)).toContain('settings.json');
        expect(names(tree)).not.toContain('.access.json');
        expect(names(tree)).not.toContain('.manifest.json');
        expect(names(tree)).not.toContain('empty');
      }),
    ).pipe(provideTestLayer(BunServices.layer)),
  );

  it('reads a memory document and returns content plus metadata', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    const result = await runEffect(
      readManagedMemory(config, 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md'),
    );

    expect(result.content).toContain('Manager UI feature notes.');
    expect(result.record?.metadata.kind).toBe('durable');
    expect(result.node.isSystem).toBe(false);
  });

  it('resolves a stable memory identity to the canonical Library node', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const canonicalPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'manager-ui.md',
    );
    await writeFile(
      canonicalPath,
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: manager-ui',
          'source_agent_client: codex',
          'timestamp: 2026-06-05T00:00:00.000Z',
          'schema_version: 5',
          'memory_id: tn_manager_ui',
          '',
          'Manager UI feature notes.',
        ],
        '\n',
      ),
    );

    const result = await runEffect(readManagedMemory(config, 'threadnote://memory/tn_manager_ui'));

    expect(result.node.uri).toBe('threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md');
    expect(result.record?.metadata.memoryId).toBe('tn_manager_ui');
    expect(result.content).toContain('Manager UI feature notes.');
  });

  it('skips symlinked memory entries and rejects direct symlink reads', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'data', 'local', 'user', 'denys', 'memories');
    const secretPath = join(config.agentContextHome, 'local-secret.txt');
    const linkPath = join(root, 'durable', 'projects', 'threadnote', 'leak.md');
    await writeFile(secretPath, 'do not expose through manager\n', 'utf8');
    await symlink(secretPath, linkPath);

    const tree = await runEffect(memoryTree(config));
    const project = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(tree.children), __effectArrayReceiver =>
        EffectOption.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver, child => child.name === 'durable')),
      ),
    )?.children?.[0]?.children?.[0];

    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(project?.children), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, child => child.name),
        ),
      ),
    ).not.toContain('leak.md');
    await expect(
      runEffect(readManagedMemory(config, 'threadnote://user/denys/memories/durable/projects/threadnote/leak.md')),
    ).rejects.toThrow(/regular memory files/);
  });
});

describe('manager UI selection helpers', () => {
  function selectionTree(): TreeNode {
    return {
      children: [
        fileNode('threadnote://user/denys/memories/durable/projects/threadnote/first.md', 'first.md'),
        fileNode('threadnote://user/denys/memories/durable/projects/threadnote/second.md', 'second.md'),
        fileNode('threadnote://user/denys/memories/durable/projects/threadnote/.abstract.md', '.abstract.md', true),
      ],
      isDir: true,
      isShared: false,
      isSystem: false,
      name: 'threadnote',
      relativePath: 'durable/projects/threadnote',
      uri: 'threadnote://user/denys/memories/durable/projects/threadnote',
    };
  }

  it('limits folder selection to visible filtered memory files', () => {
    const tree = selectionTree();

    expect(selectableMemoryUris(tree, {filter: 'first', showSystem: false})).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
    ]);
    expect(selectableMemoryUris(tree, {filter: '', showSystem: false})).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
      'threadnote://user/denys/memories/durable/projects/threadnote/second.md',
    ]);
  });

  it('prunes hidden selected memories before bulk actions', () => {
    const tree = selectionTree();
    const selected = new Set([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
      'threadnote://user/denys/memories/durable/projects/threadnote/second.md',
      'threadnote://user/denys/memories/durable/projects/threadnote/.abstract.md',
    ]);

    expect([...pruneSelectedMemoryUris(selected, tree, {filter: 'first', showSystem: false})]).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/first.md',
    ]);

    const visibleOnly = new Set(['threadnote://user/denys/memories/durable/projects/threadnote/first.md']);
    expect(pruneSelectedMemoryUris(visibleOnly, tree, {filter: 'first', showSystem: false})).toBe(visibleOnly);
  });

  it('collects distinct project selector options from nested memory metadata', () => {
    const first = fileNode('threadnote://user/denys/memories/durable/projects/threadnote/first.md', 'first.md');
    const second = fileNode('threadnote://user/denys/memories/handoffs/other/second.md', 'second.md');
    const tree: TreeNode = {
      ...selectionTree(),
      children: [
        {
          ...first,
          metadata: {
            kind: 'durable',
            project: 'Threadnote',
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-05T00:00:00.000Z',
          },
        },
        {
          ...second,
          metadata: {
            kind: 'handoff',
            project: 'threadnote',
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-05T00:00:00.000Z',
          },
        },
      ],
    };

    expect(managerProjectOptions(tree)).toEqual(['Threadnote']);
  });
});

describe('manager http API', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(automaticCompaction.compactCodeGraphStorageIsolated).mockClear();
    vi.mocked(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).mockClear();
    vi.mocked(lifecycle.runRepair)
      .mockReset()
      .mockImplementation((_config, options) => Console.log(options.dryRun ? 'repair dry run' : 'repair applied'));
    vi.mocked(memory.runArchive).mockReset();
    vi.mocked(memory.runForget).mockReset();
    vi.mocked(seeding.runSeed).mockClear();
    vi.mocked(seeding.runSeedSkills).mockClear();
  });

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('serves source Manager HTML and CSS from the package static directory', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const [htmlResponse, cssResponse, editorCssResponse] = await Promise.all([
        testHttpFetch(`${server.url}/`),
        testHttpFetch(`${server.url}/app.css`),
        testHttpFetch(`${server.url}/editor.css`),
      ]);

      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get('content-type')).toContain('text/html');
      expect(await htmlResponse.text()).toContain('<title>Threadnote Manager</title>');
      expect(cssResponse.status).toBe(200);
      expect(cssResponse.headers.get('content-type')).toContain('text/css');
      expect(await cssResponse.text()).toContain(':root');
      expect(editorCssResponse.status).toBe(200);
      expect(await editorCssResponse.text()).toContain('.mdxeditor');
    } finally {
      await server.close();
    }
  });

  it('requires the session token for API requests', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const rejected = await testHttpFetch(`${server.url}/api/tree`);
      expect(rejected.status).toBe(401);

      const accepted = await testHttpFetch(`${server.url}/api/tree`, {headers: {authorization: 'Bearer secret'}});
      const body = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            resourcesTree: Schema.optionalKey(TreeNodeJsonSchema),
            tree: Schema.optionalKey(TreeNodeJsonSchema),
          }),
          [JsonRecordSchema],
        ),
        await accepted.json(),
      );
      expect(accepted.status).toBe(200);
      expect(body.tree?.uri).toBe('threadnote://user/denys/memories');
      expect(body.resourcesTree?.uri).toBe('threadnote://resources');
    } finally {
      await server.close();
    }
  });

  it('answers Manager heartbeat requests locally with the same session-token protection', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const rejected = await testHttpFetch(`${server.url}/api/health`);
      expect(rejected.status).toBe(401);

      const accepted = await testHttpFetch(`${server.url}/api/health`, {
        headers: {authorization: 'Bearer secret'},
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({status: 'ok'});
    } finally {
      await server.close();
    }
  });

  it('serves an empty memory tree from a fresh Threadnote home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-fresh-'));
    homes.push(home);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'denys',
    };
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/tree`, {headers: {authorization: 'Bearer secret'}});
      const body = decodeJson(
        Schema.StructWithRest(Schema.Struct({tree: Schema.optionalKey(TreeNodeJsonSchema)}), [JsonRecordSchema]),
        await response.json(),
      );

      expect(response.status).toBe(200);
      expect(body.tree).toMatchObject({
        children: [],
        isDir: true,
        name: 'memories',
        relativePath: '',
        uri: 'threadnote://user/denys/memories',
      });
    } finally {
      await server.close();
    }
  });

  effectIt.effect('serializes raw personal Manager saves with the managed-memory URI lock', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* Effect.promise(makeRuntime);
          homes.push(config.agentContextHome);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const uri = 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md';
          const memoryPath = path.join(
            config.agentContextHome,
            'data',
            'local',
            'user',
            'denys',
            'memories',
            'durable',
            'projects',
            'threadnote',
            'manager-ui.md',
          );
          const original = yield* fs.readFileString(memoryPath);
          const updated = EffectArray.join(
            [
              'MEMORY',
              'kind: durable',
              'status: active',
              'project: threadnote',
              'topic: manager-ui',
              'source_agent_client: manager',
              'timestamp: 2026-08-20T00:00:00.000Z',
              '',
              'Serialized Manager edit.',
            ],
            '\n',
          );
          const server = yield* Effect.promise(() => startServer(config, 'secret'));
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* withMemoryUriLocks(
            fs,
            config.agentContextHome,
            [uri],
            Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(acquired);

          yield* Effect.gen(function* () {
            const requestCompleted = yield* Deferred.make<void>();
            const request = yield* Effect.promise(() =>
              testHttpFetch(`${server.url}/api/memory/save`, {
                body: JSON.stringify({replaceUri: uri, text: updated}),
                headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
                method: 'POST',
              }),
            ).pipe(Effect.ensuring(Deferred.succeed(requestCompleted, undefined)), Effect.forkScoped);
            yield* Effect.sleep(100);

            expect(yield* Deferred.isDone(requestCompleted)).toBe(false);
            expect(yield* fs.readFileString(memoryPath)).toBe(original);

            yield* Deferred.succeed(release, undefined);
            const response = yield* Fiber.join(request);
            expect(response.status).toBe(200);
            expect(yield* fs.readFileString(memoryPath)).toBe(updated);
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(release, undefined).pipe(
                Effect.andThen(Fiber.await(owner)),
                Effect.andThen(Effect.promise(() => server.close())),
                Effect.asVoid,
              ),
            ),
          );
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('rejects a stale raw personal Manager save and preserves the current bytes', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const uri = 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md';
    const memoryPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'manager-ui.md',
    );
    const openedContent = await readFile(memoryPath, 'utf8');
    const concurrent = Effect2.pipe(openedContent, EffectString.replace('feature notes', 'concurrent notes'));
    const stale = Effect2.pipe(openedContent, EffectString.replace('feature notes', 'stale notes'));
    const server = await startServer(config, 'secret');
    try {
      await writeFile(memoryPath, concurrent);
      const response = await testHttpFetch(`${server.url}/api/memory/save`, {
        body: JSON.stringify({expectedContent: openedContent, replaceUri: uri, text: stale}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({error: expect.stringContaining('changed after it was opened')});
      expect(await readFile(memoryPath, 'utf8')).toBe(concurrent);
    } finally {
      await server.close();
    }
  });

  it('refuses raw personal Manager saves that read or introduce a future schema', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const uri = 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md';
    const memoryPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'manager-ui.md',
    );
    const original = await readFile(memoryPath, 'utf8');
    const server = await startServer(config, 'secret');
    const requestSave = (text: string) =>
      testHttpFetch(`${server.url}/api/memory/save`, {
        body: JSON.stringify({replaceUri: uri, text}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
    try {
      const futureIncoming = Effect2.pipe(
        original,
        EffectString.replace('status: active', 'status: active\nschema_version: 999999999999'),
      );
      const rejectedIncoming = await requestSave(futureIncoming);
      expect(rejectedIncoming.status).toBe(500);
      expect(await rejectedIncoming.json()).toMatchObject({error: expect.stringContaining('newer than supported')});
      expect(await readFile(memoryPath, 'utf8')).toBe(original);

      const futureExisting = Effect2.pipe(
        original,
        EffectString.replace(
          'status: active',
          `status: active\nschema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
        ),
      );
      await writeFile(memoryPath, futureExisting);
      const rejectedExisting = await requestSave(
        Effect2.pipe(original, EffectString.replace('feature notes', 'replacement notes')),
      );
      expect(rejectedExisting.status).toBe(500);
      expect(await rejectedExisting.json()).toMatchObject({error: expect.stringContaining('newer than supported')});
      expect(await readFile(memoryPath, 'utf8')).toBe(futureExisting);
    } finally {
      await server.close();
    }
  });

  it('keeps legacy CRLF and CR Manager edits on the guarded raw-save path', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const uri = 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md';
    const memoryPath = join(
      config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'manager-ui.md',
    );
    const originalLf = await readFile(memoryPath, 'utf8');
    const server = await startServer(config, 'secret');
    try {
      for (const newline of ['\r\n', '\r']) {
        const original = Effect2.pipe(originalLf, EffectString.replaceAll('\n', newline));
        const updated = Effect2.pipe(
          original,
          EffectString.replace('Manager UI feature notes.', 'Legacy Manager raw edit.'),
        );
        await writeFile(memoryPath, original);
        const response = await testHttpFetch(`${server.url}/api/memory/save`, {
          body: JSON.stringify({replaceUri: uri, text: updated}),
          headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
          method: 'POST',
        });
        expect(response.status, await response.text()).toBe(200);
        expect(await readFile(memoryPath, 'utf8')).toBe(updated);
      }
    } finally {
      await server.close();
    }
  });

  it('preserves immutable code citations when Manager moves a personal memory', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/citation-source.md';
    const targetUri = 'threadnote://user/denys/memories/durable/projects/threadnote/citation-target.md';
    const memoriesRoot = join(config.agentContextHome, 'data', 'local', 'user', 'denys', 'memories');
    const sourcePath = join(memoriesRoot, 'durable', 'projects', 'threadnote', 'citation-source.md');
    const targetPath = join(memoriesRoot, 'durable', 'projects', 'threadnote', 'citation-target.md');
    const original = `${managerCitedMemory('Personal cited memory.', false, 'remote')}\n`;
    await writeFile(sourcePath, original);
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          topic: 'citation-target',
          uri: sourceUri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      expect(JSON.parse(responseBody)).toMatchObject({targetUri});
      expect(existsSync(sourcePath)).toBe(false);

      const moved = await readFile(targetPath, 'utf8');
      const originalRecord = parseMemoryDocument(sourceUri, original);
      const movedRecord = parseMemoryDocument(targetUri, moved);
      expect(movedRecord?.body).toBe('Personal cited memory.');
      expect(movedRecord?.metadata.codeCitations).toEqual(originalRecord?.metadata.codeCitations);
      expect(movedRecord?.metadata.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
      expect(await runEffect(readMemoryWithRelocations(config, sourceUri))).toMatchObject({
        canonicalUri: targetUri,
        requestedUri: sourceUri,
      });
    } finally {
      await server.close();
    }
  });

  it('preserves immutable code citations when Manager moves a shared memory to personal storage', async () => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const sourceContent = `${fixture.content}\n`;
    await writeFile(fixture.canonicalPath, sourceContent);
    await writeFile(fixture.worktreePath, sourceContent);
    const sourceWorktree = join(fixture.config.agentContextHome, 'share', 'worktrees', 'default');
    execFileSync('git', ['-C', sourceWorktree, 'add', '--', 'durable'], {stdio: 'pipe'});
    execFileSync(
      'git',
      [
        '-C',
        sourceWorktree,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'preserve terminal newline',
      ],
      {stdio: 'pipe'},
    );
    execFileSync('git', ['-C', sourceWorktree, 'push', '-q'], {stdio: 'pipe'});
    const targetUri = 'threadnote://user/denys/memories/durable/projects/threadnote/shared-to-personal.md';
    const targetPath = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'shared-to-personal.md',
    );
    const server = await startServer(fixture.config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          topic: 'shared-to-personal',
          uri: fixture.uri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      expect(JSON.parse(responseBody)).toMatchObject({targetUri});
      expect(existsSync(fixture.canonicalPath)).toBe(false);
      expect(existsSync(fixture.worktreePath)).toBe(false);

      const moved = await readFile(targetPath, 'utf8');
      expect(parseMemoryDocument(targetUri, moved)?.metadata.codeCitations).toEqual(
        parseMemoryDocument(fixture.uri, sourceContent)?.metadata.codeCitations,
      );
      expect(await runEffect(readMemoryWithRelocations(fixture.config, fixture.uri))).toMatchObject({
        canonicalUri: targetUri,
        requestedUri: fixture.uri,
      });
    } finally {
      await server.close();
    }
  });

  effectIt.effect('preserves a shared source when its staged personal target changes before cleanup', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(makeSharedManagerRuntime);
          homes.push(fixture.config.agentContextHome);
          const fs = yield* FileSystem.FileSystem;
          const targetUri = 'threadnote://user/denys/memories/durable/projects/threadnote/shared-to-personal-race.md';
          const targetPath = join(
            fixture.config.agentContextHome,
            'data',
            'local',
            'user',
            'denys',
            'memories',
            'durable',
            'projects',
            'threadnote',
            'shared-to-personal-race.md',
          );
          const remote = join(fixture.config.agentContextHome, 'share', 'remote.git');
          const storedUri = yield* storeManagerPersonalMemoryMove(
            fixture.config,
            fixture.uri,
            fixture.content,
            {
              kind: 'durable',
              project: 'threadnote',
              sourceAgentClient: 'manager',
              status: 'active',
              topic: 'shared-to-personal-race',
            },
            false,
          );
          expect(storedUri).toBe(targetUri);
          const staged = yield* readManagedMemory(fixture.config, targetUri);
          const concurrentTarget = Effect2.pipe(
            staged.content,
            EffectString.replace('Shared Manager original.', 'Concurrent target edit.'),
          );
          yield* fs.writeFileString(targetPath, concurrentTarget);

          const failure = yield* withSharedRepositoryLock(
            fixture.config,
            removeManagerSharedMemorySource(fixture.config, fixture.uri, fixture.content, targetUri, staged.content),
          ).pipe(Effect.flip);

          expect(String(failure)).toContain('changed before shared source removal');
          expect(yield* fs.readFileString(fixture.canonicalPath)).toBe(fixture.content);
          expect(yield* fs.readFileString(fixture.worktreePath)).toBe(fixture.content);
          expect(yield* fs.readFileString(targetPath)).toBe(concurrentTarget);
          const remoteSource = yield* Effect.sync(() =>
            execFileSync('git', ['--git-dir', remote, 'show', 'HEAD:durable/projects/threadnote/shared-manager.md'], {
              encoding: 'utf8',
            }),
          );
          expect(remoteSource).toBe(fixture.content);
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('preserves immutable code citations when Manager relocates shared memory within a team', async () => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const sourceContent = `${fixture.content}\n`;
    await writeFile(fixture.canonicalPath, sourceContent);
    await writeFile(fixture.worktreePath, sourceContent);
    const targetUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/shared-relocated.md';
    const targetCanonicalPath = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'shared',
      'default',
      'durable',
      'projects',
      'threadnote',
      'shared-relocated.md',
    );
    const targetWorktreePath = join(
      fixture.config.agentContextHome,
      'share',
      'worktrees',
      'default',
      'durable',
      'projects',
      'threadnote',
      'shared-relocated.md',
    );
    const commitsBefore = Number.parseInt(
      Effect2.pipe(
        execFileSync(
          'git',
          ['-C', fixture.config.agentContextHome + '/share/worktrees/default', 'rev-list', '--count', 'HEAD'],
          {
            encoding: 'utf8',
          },
        ),
        EffectString.trim,
      ),
      10,
    );
    const server = await startServer(fixture.config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          team: 'default',
          topic: 'shared-relocated',
          uri: fixture.uri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      expect(JSON.parse(responseBody)).toMatchObject({targetUri});
      expect(existsSync(fixture.canonicalPath)).toBe(false);
      expect(existsSync(fixture.worktreePath)).toBe(false);

      const canonical = await readFile(targetCanonicalPath, 'utf8');
      expect(await readFile(targetWorktreePath, 'utf8')).toBe(canonical);
      const movedRecord = parseMemoryDocument(targetUri, canonical);
      expect(movedRecord?.metadata.codeCitations).toEqual(
        parseMemoryDocument(fixture.uri, sourceContent)?.metadata.codeCitations,
      );
      expect(movedRecord?.metadata.topic).toBe('shared-relocated');
      expect(movedRecord?.metadata.visibility).toBe('shared');
      expect(
        Number.parseInt(
          Effect2.pipe(
            execFileSync(
              'git',
              ['-C', fixture.config.agentContextHome + '/share/worktrees/default', 'rev-list', '--count', 'HEAD'],
              {encoding: 'utf8'},
            ),
            EffectString.trim,
          ),
          10,
        ),
      ).toBe(commitsBefore + 1);
    } finally {
      await server.close();
    }
  });

  it('finishes an idempotent same-team move after Git relocation committed before canonical cleanup', async () => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const worktree = join(fixture.config.agentContextHome, 'share', 'worktrees', 'default');
    const targetUri = 'threadnote://user/denys/memories/shared/default/durable/projects/threadnote/recovered-move.md';
    const targetRelativePath = join('durable', 'projects', 'threadnote', 'recovered-move.md');
    const targetCanonicalPath = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'shared',
      'default',
      targetRelativePath,
    );
    const targetWorktreePath = join(worktree, targetRelativePath);
    const source = parseMemoryDocument(fixture.uri, fixture.content)!;
    const targetContent = formatMemoryDocument(
      'MEMORY',
      {...source.metadata, project: 'threadnote', topic: 'recovered-move', visibility: 'shared'},
      source.body,
    );
    await mkdir(join(targetCanonicalPath, '..'), {recursive: true});
    await mkdir(join(targetWorktreePath, '..'), {recursive: true});
    await writeFile(targetCanonicalPath, targetContent);
    await writeFile(targetWorktreePath, targetContent);
    await rm(fixture.worktreePath);
    execFileSync('git', ['-C', worktree, 'add', '-A', '--', 'durable'], {stdio: 'pipe'});
    execFileSync(
      'git',
      [
        '-C',
        worktree,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'partially completed shared move',
      ],
      {stdio: 'pipe'},
    );
    execFileSync('git', ['-C', worktree, 'push', '-q'], {stdio: 'pipe'});

    const server = await startServer(fixture.config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          team: 'default',
          topic: 'recovered-move',
          uri: fixture.uri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      expect(JSON.parse(responseBody)).toMatchObject({targetUri});
      expect(existsSync(fixture.canonicalPath)).toBe(false);
      expect(await readFile(targetCanonicalPath, 'utf8')).toBe(targetContent);
      expect(await readFile(targetWorktreePath, 'utf8')).toBe(targetContent);
      expect(await runEffect(readMemoryWithRelocations(fixture.config, fixture.uri))).toMatchObject({
        canonicalUri: targetUri,
        requestedUri: fixture.uri,
      });
    } finally {
      await server.close();
    }
  });

  it.each([
    {identity: 'remote' as const, sourceDirty: true, blocker: 'dirty worktree'},
    {identity: 'local' as const, sourceDirty: false, blocker: 'portable remote repository identity'},
  ])('blocks $blocker citations before a Manager move mutates personal memory', async candidate => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/blocked-source.md';
    const personalRoot = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    const sourcePath = join(personalRoot, 'blocked-source.md');
    const personalTargetPath = join(personalRoot, 'blocked-target.md');
    const sharedTargetPath = join(
      fixture.config.agentContextHome,
      'share',
      'worktrees',
      'default',
      'durable',
      'projects',
      'threadnote',
      'blocked-target.md',
    );
    const original = managerCitedMemory('Citation must remain personal.', candidate.sourceDirty, candidate.identity);
    await writeFile(sourcePath, original);
    const server = await startServer(fixture.config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          team: 'default',
          topic: 'blocked-target',
          uri: sourceUri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({error: expect.stringContaining(candidate.blocker)});
      expect(await readFile(sourcePath, 'utf8')).toBe(original);
      expect(existsSync(personalTargetPath)).toBe(false);
      expect(existsSync(sharedTargetPath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('blocks a changed-target Manager share while the original memory has pending code citations', async () => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/pending-source.md';
    const personalRoot = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    const sourcePath = join(personalRoot, 'pending-source.md');
    const stagedPath = join(personalRoot, 'pending-target.md');
    const sharedTargetPath = join(
      fixture.config.agentContextHome,
      'share',
      'worktrees',
      'default',
      'durable',
      'projects',
      'threadnote',
      'pending-target.md',
    );
    const original = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        memoryId: 'tn_manager_pending_source',
        project: 'threadnote',
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-08-30T00:00:00.000Z',
        topic: 'pending-source',
        visibility: 'personal',
      },
      'Pending citations must remain private.',
    );
    await writeFile(sourcePath, original);
    const pendingRoot = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'private',
      'deferred-code-anchors',
      'v1',
    );
    const pendingPath = join(pendingRoot, `${sha256HexSync(sourceUri)}.json`);
    await mkdir(pendingRoot, {recursive: true, mode: 0o700});
    await writeFile(pendingPath, '{}\n', {mode: 0o600});

    const server = await startServer(fixture.config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          team: 'default',
          topic: 'pending-target',
          uri: sourceUri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(500);
      expect(responseBody).toContain('code citations are still pending');
      expect(await readFile(sourcePath, 'utf8')).toBe(original);
      expect(existsSync(pendingPath)).toBe(true);
      expect(existsSync(stagedPath)).toBe(false);
      expect(existsSync(sharedTargetPath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('preserves the personal source when a staged Manager publish fails scrubber policy', async () => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/scrubbed-source.md';
    const personalRoot = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    const sourcePath = join(personalRoot, 'scrubbed-source.md');
    const personalTargetPath = join(personalRoot, 'scrubbed-target.md');
    const sharedCanonicalTargetPath = join(
      fixture.config.agentContextHome,
      'data',
      'local',
      'user',
      'denys',
      'memories',
      'shared',
      'default',
      'durable',
      'projects',
      'threadnote',
      'scrubbed-target.md',
    );
    const sharedWorktreeTargetPath = join(
      fixture.config.agentContextHome,
      'share',
      'worktrees',
      'default',
      'durable',
      'projects',
      'threadnote',
      'scrubbed-target.md',
    );
    const original = `${managerCitedMemory(
      'Credential sk-abcdefghijklmnopqr1234 must remain personal.',
      false,
      'remote',
    )}\n`;
    await writeFile(sourcePath, original);
    const server = await startServer(fixture.config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/memory/move`, {
        body: JSON.stringify({
          confirm: true,
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          team: 'default',
          topic: 'scrubbed-target',
          uri: sourceUri,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(500);
      expect(responseBody).toContain('possible API key');
      expect(await readFile(sourcePath, 'utf8')).toBe(original);
      expect(existsSync(personalTargetPath)).toBe(false);
      expect(existsSync(sharedCanonicalTargetPath)).toBe(false);
      expect(existsSync(sharedWorktreeTargetPath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  effectIt.effect('rejects a staged publish when its original changes before the publication fence', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeSharedManagerRuntime);
        homes.push(fixture.config.agentContextHome);
        const fs = yield* FileSystem.FileSystem;
        const sourceUri = 'threadnote://user/denys/memories/durable/projects/threadnote/racing-source.md';
        const personalRoot = join(
          fixture.config.agentContextHome,
          'data',
          'local',
          'user',
          'denys',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        const sourcePath = join(personalRoot, 'racing-source.md');
        const stagedPath = join(personalRoot, 'racing-target.md');
        const sharedCanonicalTargetPath = join(
          fixture.config.agentContextHome,
          'data',
          'local',
          'user',
          'denys',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'threadnote',
          'racing-target.md',
        );
        const sharedWorktreeTargetPath = join(
          fixture.config.agentContextHome,
          'share',
          'worktrees',
          'default',
          'durable',
          'projects',
          'threadnote',
          'racing-target.md',
        );
        const original = `${managerCitedMemory('Original move body.', false, 'remote')}\n`;
        const concurrent = Effect2.pipe(
          original,
          EffectString.replace('Original move body.', 'Concurrent source edit.'),
        );
        yield* fs.writeFileString(sourcePath, original);
        const server = yield* Effect.promise(() => startServer(fixture.config, 'secret'));
        const repositoryLockAcquired = yield* Deferred.make<void>();
        const releaseRepositoryLock = yield* Deferred.make<void>();
        const repositoryLockOwner = yield* withSharedRepositoryLock(
          fixture.config,
          Deferred.succeed(repositoryLockAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRepositoryLock)),
          ),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(repositoryLockAcquired);

        yield* Effect.gen(function* () {
          const moveRequest = yield* Effect.promise(() =>
            testHttpFetch(`${server.url}/api/memory/move`, {
              body: JSON.stringify({
                confirm: true,
                kind: 'durable',
                project: 'threadnote',
                status: 'active',
                team: 'default',
                topic: 'racing-target',
                uri: sourceUri,
              }),
              headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
              method: 'POST',
            }),
          ).pipe(Effect.forkScoped);
          let staged = false;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            staged = yield* fs.exists(stagedPath);
            if (staged) break;
            yield* Effect.sleep(10);
          }
          expect(staged).toBe(true);

          const saveResponse = yield* Effect.promise(() =>
            testHttpFetch(`${server.url}/api/memory/save`, {
              body: JSON.stringify({expectedContent: original, replaceUri: sourceUri, text: concurrent}),
              headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
              method: 'POST',
            }),
          );
          expect(saveResponse.status, yield* Effect.promise(() => saveResponse.text())).toBe(200);

          yield* Deferred.succeed(releaseRepositoryLock, undefined);
          const moveResponse = yield* Fiber.join(moveRequest);
          const moveBody = yield* Effect.promise(() => moveResponse.text());
          expect(moveResponse.status, moveBody).toBe(500);
          expect(moveBody).toContain('changed before publication');
          expect(yield* fs.readFileString(sourcePath)).toBe(concurrent);
          expect(yield* fs.exists(stagedPath)).toBe(false);
          expect(yield* fs.exists(sharedCanonicalTargetPath)).toBe(false);
          expect(yield* fs.exists(sharedWorktreeTargetPath)).toBe(false);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(releaseRepositoryLock, undefined).pipe(
              Effect.andThen(Fiber.await(repositoryLockOwner)),
              Effect.andThen(Effect.promise(() => server.close())),
              Effect.asVoid,
            ),
          ),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('applies citation sharing policy and exact CAS to raw shared Manager saves', async () => {
    const fixture = await makeSharedManagerRuntime();
    homes.push(fixture.config.agentContextHome);
    const server = await startServer(fixture.config, 'secret');
    const requestSave = (text: string, expectedContent?: string) =>
      testHttpFetch(`${server.url}/api/memory/save`, {
        body: JSON.stringify({expectedContent, replaceUri: fixture.uri, text}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
    try {
      const opened = await testHttpFetch(`${server.url}/api/memory?uri=${encodeURIComponent(fixture.uri)}`, {
        headers: {authorization: 'Bearer secret'},
      });
      const openedMemory = decodeJson(
        Schema.StructWithRest(Schema.Struct({content: Schema.String}), [JsonRecordSchema]),
        await opened.json(),
      );
      expect(opened.status).toBe(200);
      expect(openedMemory).toMatchObject({content: fixture.content});

      const cleanUpdate = managerCitedMemory('Shared Manager clean update.', false, 'remote');
      const missingRevision = await requestSave(cleanUpdate);
      expect(missingRevision.status).toBe(500);
      expect(await missingRevision.text()).toContain('require the original content');
      expect(await readFile(fixture.canonicalPath, 'utf8')).toBe(fixture.content);
      expect(await readFile(fixture.worktreePath, 'utf8')).toBe(fixture.content);

      const accepted = await requestSave(cleanUpdate, openedMemory.content);
      const acceptedBody = await accepted.text();
      expect(accepted.status, acceptedBody).toBe(200);
      expect(await readFile(fixture.canonicalPath, 'utf8')).toBe(cleanUpdate);
      expect(await readFile(fixture.worktreePath, 'utf8')).toBe(cleanUpdate);

      const refreshed = await testHttpFetch(`${server.url}/api/memory?uri=${encodeURIComponent(fixture.uri)}`, {
        headers: {authorization: 'Bearer secret'},
      });
      const refreshedMemory = decodeJson(
        Schema.StructWithRest(Schema.Struct({content: Schema.String}), [JsonRecordSchema]),
        await refreshed.json(),
      );
      const malformed = Effect2.pipe(
        cleanUpdate,
        EffectString.replace(/^code_citation: .*$/mu, '  code_citation: {not-json}'),
      );
      const nearCanonical = Effect2.pipe(cleanUpdate, EffectString.replace(/^code_citation:/mu, 'code_citation :'));
      const blocked = [
        {reason: 'dirty worktree cannot be shared', text: managerCitedMemory('Dirty update.', true, 'remote')},
        {
          reason: 'portable remote repository identity',
          text: managerCitedMemory('Local identity update.', false, 'local'),
        },
        {reason: 'malformed code citation metadata', text: malformed},
        {reason: 'malformed code citation metadata', text: nearCanonical},
        {
          reason: 'possible API key',
          text: managerCitedMemory('Secret sk-abcdefghijklmnopqr1234 must not cross the boundary.', false, 'remote'),
        },
        {
          reason: 'possible macOS home path',
          text: managerCitedMemory(
            'Local evidence: /Users/alice/work/threadnote/apps/threadnote/src/manager/index.ts',
            false,
            'remote',
          ),
        },
        {
          reason: 'metadata must match its canonical shared URI',
          text: Effect2.pipe(cleanUpdate, EffectString.replace('project: threadnote', 'project: other-project')),
        },
      ];
      for (const candidate of blocked) {
        const rejected = await requestSave(candidate.text, refreshedMemory.content);
        expect(rejected.status).toBe(500);
        expect(await rejected.json()).toMatchObject({error: expect.stringContaining(candidate.reason)});
        expect(await readFile(fixture.canonicalPath, 'utf8')).toBe(cleanUpdate);
        expect(await readFile(fixture.worktreePath, 'utf8')).toBe(cleanUpdate);
      }

      const concurrent = managerCitedMemory('Concurrent shared update.', false, 'remote');
      await writeFile(fixture.canonicalPath, concurrent);
      await writeFile(fixture.worktreePath, concurrent);
      const stale = await requestSave(
        managerCitedMemory('Stale Manager update.', false, 'remote'),
        refreshedMemory.content,
      );
      expect(stale.status).toBe(500);
      expect(await stale.json()).toMatchObject({error: expect.stringContaining('changed after it was opened')});
      expect(await readFile(fixture.canonicalPath, 'utf8')).toBe(concurrent);
      expect(await readFile(fixture.worktreePath, 'utf8')).toBe(concurrent);
    } finally {
      await server.close();
    }
  });

  it('requires the session token for process inventory and termination without signaling', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    const kill = vi.spyOn(process, 'kill');
    try {
      const inventory = await testHttpFetch(`${server.url}/api/processes`);
      const termination = await testHttpFetch(`${server.url}/api/processes/terminate`, {
        body: JSON.stringify({
          confirm: true,
          processId: 123_456,
          processRef: `tnp_${Effect2.pipe('a', EffectString.repeat(64))}`,
        }),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      });
      expect(inventory.status).toBe(401);
      expect(termination.status).toBe(401);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      await server.close();
    }
  });

  it('keeps authenticated process inventory available during graph maintenance', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await runEffect(
        withCodeGraphMaintenanceIntent(
          config.agentContextHome,
          Effect.promise(() =>
            testHttpFetch(`${server.url}/api/processes`, {headers: {authorization: 'Bearer secret'}}),
          ),
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({processes: expect.any(Array), schemaVersion: 1});
    } finally {
      await server.close();
    }
  });

  it('serves active graph jobs without requiring a graph database read', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const seeded = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity: RepositoryIdentity = {
          caseMode: 'sensitive',
          checkoutId: Effect2.pipe('f', EffectString.repeat(64)),
          displayName: 'acme/large-monorepo',
          gitCommonDirectory: join(config.agentContextHome, 'large-repository', '.git'),
          headCommit: Effect2.pipe('1', EffectString.repeat(40)),
          objectFormat: 'sha1',
          remoteIdentity: 'github.com/acme/large-monorepo',
          repoRoot: join(config.agentContextHome, 'large-repository'),
          repositoryId: Effect2.pipe('d', EffectString.repeat(64)),
          worktreeId: Effect2.pipe('e', EffectString.repeat(64)),
        };
        const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'waiting'});
        return {databasePath: layout.databasePath, worktreeId: identity.worktreeId};
      }),
    );
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const statusResponse = await testHttpFetch(`${server.url}/api/graphs/status`, {headers});
      const status = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            builds: Schema.Array(Schema.StructWithRest(Schema.Struct({state: Schema.String}), [JsonRecordSchema])),
            catalogRevision: Schema.optionalKey(Schema.String),
            queuedWorktreeIds: Schema.Array(Schema.String),
          }),
          [JsonRecordSchema],
        ),
        await statusResponse.json(),
      );
      expect(statusResponse.status).toBe(200);
      expect(status.builds).toEqual([expect.objectContaining({state: 'queued'})]);
      expect(status.queuedWorktreeIds).toEqual([seeded.worktreeId]);
      expect(status.catalogRevision).toBeUndefined();
      expect(existsSync(seeded.databasePath)).toBe(false);

      const catalogResponse = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const catalog = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            builds: Schema.Array(Schema.StructWithRest(Schema.Struct({state: Schema.String}), [JsonRecordSchema])),
            catalogRevision: Schema.String,
            repositories: Schema.Array(Schema.Unknown),
          }),
          [JsonRecordSchema],
        ),
        await catalogResponse.json(),
      );
      expect(catalog).toMatchObject({builds: [expect.objectContaining({state: 'queued'})], repositories: []});
      expect(catalog.catalogRevision).toMatch(/^[0-9a-f]{64}$/u);
      expect(existsSync(seeded.databasePath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('invalidates an open Manager catalog when another process removes a view', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const checkoutId = await seedManagerGraph(config);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const initialResponse = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const initial = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            catalogRevision: Schema.String,
            repositories: Schema.Array(
              Schema.StructWithRest(Schema.Struct({views: Schema.Array(Schema.Unknown)}), [JsonRecordSchema]),
            ),
          }),
          [JsonRecordSchema],
        ),
        await initialResponse.json(),
      );
      expect(initialResponse.status).toBe(200);
      expect(initial.repositories[0]?.views).toHaveLength(1);

      const removal = await runEffect(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const layout = codeGraphLayout(
            path,
            config.agentContextHome,
            checkoutId,
            Effect2.pipe('c', EffectString.repeat(64)),
          );
          return yield* store.removeView(
            layout.databasePath,
            Effect2.pipe('c', EffectString.repeat(64)),
            MANAGER_GRAPH_SNAPSHOT_ID,
          );
        }),
      );
      expect(removal.state).toBe('removed');

      const statusResponse = await testHttpFetch(`${server.url}/api/graphs/status`, {headers});
      const status = decodeJson(
        Schema.StructWithRest(Schema.Struct({catalogRevision: Schema.optionalKey(Schema.String)}), [JsonRecordSchema]),
        await statusResponse.json(),
      );
      expect(statusResponse.status).toBe(200);
      expect(status.catalogRevision).toMatch(/^[0-9a-f]{64}$/u);
      expect(status.catalogRevision).not.toBe(initial.catalogRevision);

      const refreshedResponse = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const refreshed = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({catalogRevision: Schema.String, repositories: Schema.Array(Schema.Unknown)}),
          [JsonRecordSchema],
        ),
        await refreshedResponse.json(),
      );
      expect(refreshedResponse.status).toBe(200);
      expect(refreshed.catalogRevision).toBe(status.catalogRevision);
      expect(refreshed.repositories).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('serves bounded repository and project graph visualizations', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repositoryId = await seedManagerGraph(config);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const catalogResponse = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const catalog = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            repositories: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  defaultViewId: Schema.String,
                  displayName: Schema.String,
                  id: Schema.String,
                  views: Schema.Array(
                    Schema.StructWithRest(
                      Schema.Struct({
                        id: Schema.String,
                        localAssociation: Schema.StructWithRest(
                          Schema.Struct({available: Schema.Boolean, state: Schema.String}),
                          [JsonRecordSchema],
                        ),
                        projects: Schema.Array(
                          Schema.StructWithRest(
                            Schema.Struct({id: Schema.String, symbolCount: Schema.optionalKey(Schema.Finite)}),
                            [JsonRecordSchema],
                          ),
                        ),
                      }),
                      [JsonRecordSchema],
                    ),
                  ),
                }),
                [JsonRecordSchema],
              ),
            ),
          }),
          [JsonRecordSchema],
        ),
        await catalogResponse.json(),
      );
      expect(catalogResponse.status).toBe(200);
      expect(catalog.repositories).toHaveLength(1);
      expect(catalog.repositories[0]).toMatchObject({
        defaultViewId: `${repositoryId}.${Effect2.pipe('c', EffectString.repeat(64))}`,
        displayName: 'acme/platform',
        id: Effect2.pipe('b', EffectString.repeat(64)),
      });
      expect(catalog.repositories[0]?.views[0]).toMatchObject({
        checkoutId: repositoryId,
        localAssociation: {available: false, state: 'legacy-unknown'},
        worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
      });
      expect(catalog.repositories[0]?.views[0]?.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({id: 'cgp_app'}), expect.objectContaining({id: 'cgp_core'})]),
      );

      const catalogPageResponse = await testHttpFetch(
        `${server.url}/api/graphs/page?repository=${repositoryId}&snapshot=${MANAGER_GRAPH_SNAPSHOT_ID}&offset=0&workspaceOffset=0&query=core`,
        {headers},
      );
      const catalogPage = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            query: Schema.String,
            repository: Schema.StructWithRest(
              Schema.Struct({
                localAssociation: Schema.StructWithRest(
                  Schema.Struct({available: Schema.Boolean, state: Schema.String}),
                  [JsonRecordSchema],
                ),
                projects: Schema.Array(Schema.StructWithRest(Schema.Struct({id: Schema.String}), [JsonRecordSchema])),
                snapshot: Schema.StructWithRest(Schema.Struct({id: Schema.String}), [JsonRecordSchema]),
              }),
              [JsonRecordSchema],
            ),
          }),
          [JsonRecordSchema],
        ),
        await catalogPageResponse.json(),
      );
      expect(catalogPageResponse.status).toBe(200);
      expect(catalogPage.query).toBe('core');
      expect(catalogPage.repository.localAssociation).toEqual({available: false, state: 'legacy-unknown'});
      expect(catalogPage.repository.snapshot.id).toBe(MANAGER_GRAPH_SNAPSHOT_ID);
      expect(EffectArray.map(catalogPage.repository.projects, project => project.id)).toEqual(['cgp_core']);

      const viewsPageResponse = await testHttpFetch(
        `${server.url}/api/graphs/views?repository=${repositoryId}&offset=0`,
        {
          headers,
        },
      );
      const viewsPage = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            hasMore: Schema.Boolean,
            repositories: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  views: Schema.Array(
                    Schema.StructWithRest(
                      Schema.Struct({
                        id: Schema.String,
                        localAssociation: Schema.StructWithRest(
                          Schema.Struct({available: Schema.Boolean, state: Schema.String}),
                          [JsonRecordSchema],
                        ),
                      }),
                      [JsonRecordSchema],
                    ),
                  ),
                }),
                [JsonRecordSchema],
              ),
            ),
          }),
          [JsonRecordSchema],
        ),
        await viewsPageResponse.json(),
      );
      expect(viewsPageResponse.status).toBe(200);
      expect(viewsPage.hasMore).toBe(false);
      expect(viewsPage.repositories[0]?.views[0]?.id).toBe(
        `${repositoryId}.${Effect2.pipe('c', EffectString.repeat(64))}`,
      );
      expect(viewsPage.repositories[0]?.views[0]?.localAssociation).toEqual({
        available: false,
        state: 'legacy-unknown',
      });

      const unpinnedCatalogPage = await testHttpFetch(`${server.url}/api/graphs/page?repository=${repositoryId}`, {
        headers,
      });
      expect(unpinnedCatalogPage.status).toBe(500);

      const overviewResponse = await testHttpFetch(`${server.url}/api/graph?repository=${repositoryId}&project=all`, {
        headers,
      });
      const overview = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            edges: Schema.Array(
              Schema.StructWithRest(Schema.Struct({count: Schema.Finite, relation: Schema.String}), [JsonRecordSchema]),
            ),
            mode: Schema.String,
            nodes: Schema.Array(
              Schema.StructWithRest(Schema.Struct({id: Schema.String, type: Schema.String}), [JsonRecordSchema]),
            ),
          }),
          [JsonRecordSchema],
        ),
        await overviewResponse.json(),
      );
      expect(overviewResponse.status).toBe(200);
      expect(overview.mode).toBe('overview');
      expect(overview.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({id: 'cgp_app', type: 'project'}),
          expect.objectContaining({id: 'cgp_core', type: 'project'}),
        ]),
      );
      expect(overview.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({count: 1, relation: 'depends_on'}),
          expect.objectContaining({count: 1, relation: 'imports'}),
        ]),
      );

      const detailStartedAt = performance.now();
      const detailResponse = await testHttpFetch(
        `${server.url}/api/graph?repository=${repositoryId}&project=${encodeURIComponent('cgp_app')}`,
        {headers},
      );
      const detailElapsedMilliseconds = performance.now() - detailStartedAt;
      const detailText = await detailResponse.text();
      const detail = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            edges: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({relation: Schema.String, sourceId: Schema.String, targetId: Schema.String}),
                [JsonRecordSchema],
              ),
            ),
            mode: Schema.String,
            nodes: Schema.Array(
              Schema.StructWithRest(Schema.Struct({degree: Schema.Finite, id: Schema.String, type: Schema.String}), [
                JsonRecordSchema,
              ]),
            ),
            paging: Schema.StructWithRest(
              Schema.Struct({edgeLimit: Schema.Finite, hasMore: Schema.Boolean, nodeLimit: Schema.Finite}),
              [JsonRecordSchema],
            ),
          }),
          [JsonRecordSchema],
        ),
        JSON.parse(detailText),
      );
      expect(detailResponse.status).toBe(200);
      expect(detail.mode).toBe('detail');
      expect(detail.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({degree: 2, id: 'app', type: 'symbol'}),
          expect.objectContaining({degree: 1, id: 'view', type: 'symbol'}),
          expect.objectContaining({degree: 1, id: 'api', type: 'symbol'}),
        ]),
      );
      expect(detail.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({relation: 'calls'}),
          expect.objectContaining({relation: 'imports'}),
        ]),
      );
      expect(detail.nodes.length).toBeLessThanOrEqual(240);
      expect(detail.edges.length).toBeLessThanOrEqual(640);
      const detailNodeIds = new Set(EffectArray.map(detail.nodes, node => node.id));
      expect(
        EffectArray.every(detail.edges, edge => detailNodeIds.has(edge.sourceId) && detailNodeIds.has(edge.targetId)),
      ).toBe(true);
      expect(detail.paging).toEqual({edgeLimit: 640, hasMore: true, nodeLimit: 240});
      expect(new TextEncoder().encode(detailText).byteLength).toBeLessThan(500_000);
      expect(detailElapsedMilliseconds).toBeLessThan(1_500);

      const expandedStartedAt = performance.now();
      const expandedResponse = await testHttpFetch(
        `${server.url}/api/graph?repository=${repositoryId}&project=${encodeURIComponent('cgp_app')}&nodeLimit=999999&edgeLimit=999999`,
        {headers},
      );
      const expandedElapsedMilliseconds = performance.now() - expandedStartedAt;
      const expandedText = await expandedResponse.text();
      const expanded = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            edges: Schema.Array(Schema.Unknown),
            nodes: Schema.Array(Schema.Unknown),
            paging: Schema.StructWithRest(Schema.Struct({edgeLimit: Schema.Finite, nodeLimit: Schema.Finite}), [
              JsonRecordSchema,
            ]),
          }),
          [JsonRecordSchema],
        ),
        JSON.parse(expandedText),
      );
      expect(expandedResponse.status).toBe(200);
      expect(expanded.paging).toMatchObject({edgeLimit: 1_500, nodeLimit: 500});
      expect(expanded.nodes.length).toBeLessThanOrEqual(500);
      expect(expanded.edges.length).toBeLessThanOrEqual(1_500);
      expect(new TextEncoder().encode(expandedText).byteLength).toBeLessThan(1_250_000);
      expect(expandedElapsedMilliseconds).toBeLessThan(2_000);

      const queryStartedAt = performance.now();
      const queryResponse = await testHttpFetch(
        `${server.url}/api/graph/query?repository=${repositoryId}&snapshot=${MANAGER_GRAPH_SNAPSHOT_ID}&query=${encodeURIComponent('App')}&nodeLimit=999999&edgeLimit=999999`,
        {headers},
      );
      const queryElapsedMilliseconds = performance.now() - queryStartedAt;
      const queryText = await queryResponse.text();
      const query = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            edges: Schema.Array(
              Schema.StructWithRest(Schema.Struct({sourceId: Schema.String, targetId: Schema.String}), [
                JsonRecordSchema,
              ]),
            ),
            nodes: Schema.Array(
              Schema.StructWithRest(Schema.Struct({id: Schema.String, score: Schema.optionalKey(Schema.Finite)}), [
                JsonRecordSchema,
              ]),
            ),
            paging: Schema.StructWithRest(Schema.Struct({edgeLimit: Schema.Finite, nodeLimit: Schema.Finite}), [
              JsonRecordSchema,
            ]),
            query: Schema.StructWithRest(
              Schema.Struct({matchedNodes: Schema.Finite, state: Schema.String, text: Schema.String}),
              [JsonRecordSchema],
            ),
            repository: Schema.StructWithRest(
              Schema.Struct({snapshot: Schema.StructWithRest(Schema.Struct({id: Schema.String}), [JsonRecordSchema])}),
              [JsonRecordSchema],
            ),
          }),
          [JsonRecordSchema],
        ),
        JSON.parse(queryText),
      );
      expect(queryResponse.status).toBe(200);
      expect(query.query).toMatchObject({matchedNodes: query.nodes.length, state: 'ready', text: 'App'});
      expect(query.repository.snapshot.id).toBe(MANAGER_GRAPH_SNAPSHOT_ID);
      expect(query.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id: 'app'})]));
      expect(EffectArray.some(query.nodes, node => typeof node.score === 'number')).toBe(true);
      const queryNodeIds = new Set(EffectArray.map(query.nodes, node => node.id));
      expect(
        EffectArray.every(query.edges, edge => queryNodeIds.has(edge.sourceId) && queryNodeIds.has(edge.targetId)),
      ).toBe(true);
      expect(query.paging).toMatchObject({edgeLimit: 500, nodeLimit: 200});
      expect(new TextEncoder().encode(queryText).byteLength).toBeLessThan(500_000);
      expect(queryElapsedMilliseconds).toBeLessThan(2_500);

      const unpinnedQueryResponse = await testHttpFetch(
        `${server.url}/api/graph/query?repository=${repositoryId}&query=${encodeURIComponent('App')}`,
        {headers},
      );
      expect(unpinnedQueryResponse.status).toBe(500);

      const nodeResponse = await testHttpFetch(
        `${server.url}/api/graph/node?repository=${repositoryId}&node=${encodeURIComponent('app')}`,
        {headers},
      );
      const node = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            node: Schema.StructWithRest(
              Schema.Struct({
                documentation: Schema.optionalKey(Schema.String),
                path: Schema.String,
                span: Schema.StructWithRest(Schema.Struct({column: Schema.Finite, line: Schema.Finite}), [
                  JsonRecordSchema,
                ]),
              }),
              [JsonRecordSchema],
            ),
            relationships: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  direction: Schema.String,
                  evidencePath: Schema.String,
                  provenance: Schema.String,
                  related: Schema.StructWithRest(
                    Schema.Struct({id: Schema.optionalKey(Schema.String), label: Schema.String}),
                    [JsonRecordSchema],
                  ),
                  relation: Schema.String,
                }),
                [JsonRecordSchema],
              ),
            ),
            stats: Schema.StructWithRest(
              Schema.Struct({
                incoming: Schema.Finite,
                outgoing: Schema.Finite,
                relations: Schema.Array(
                  Schema.StructWithRest(Schema.Struct({count: Schema.Finite, relation: Schema.String}), [
                    JsonRecordSchema,
                  ]),
                ),
                sampledEdges: Schema.Finite,
                summaryTruncated: Schema.Boolean,
                truncated: Schema.Boolean,
              }),
              [JsonRecordSchema],
            ),
          }),
          [JsonRecordSchema],
        ),
        await nodeResponse.json(),
      );
      expect(nodeResponse.status).toBe(200);
      expect(node.node).toMatchObject({
        documentation: 'Documentation for App.',
        path: 'packages/app/src/index.ts',
        span: {column: 3, line: 7},
      });
      expect(node.stats).toMatchObject({
        incoming: 0,
        outgoing: 2,
        sampledEdges: 2,
        summaryTruncated: false,
        truncated: false,
      });
      expect(node.stats.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({count: 1, relation: 'calls'}),
          expect.objectContaining({count: 1, relation: 'imports'}),
        ]),
      );
      expect(node.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'outgoing',
            evidencePath: 'packages/app/src/index.ts',
            provenance: 'resolved',
            related: expect.objectContaining({id: 'view', label: 'renderView'}),
            relation: 'calls',
          }),
        ]),
      );

      const analysisResponse = await testHttpFetch(`${server.url}/api/graph/analysis?repository=${repositoryId}`, {
        headers,
      });
      const analysis = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            statistics: Schema.StructWithRest(
              Schema.Struct({analyzedEdgeCount: Schema.Finite, analyzedNodeCount: Schema.Finite}),
              [JsonRecordSchema],
            ),
            trust: Schema.StructWithRest(Schema.Struct({classification: Schema.String}), [JsonRecordSchema]),
          }),
          [JsonRecordSchema],
        ),
        await analysisResponse.json(),
      );
      expect(analysisResponse.status).toBe(200);
      expect(analysis.statistics).toMatchObject({analyzedEdgeCount: 1_602, analyzedNodeCount: 523});
      expect(analysis.trust.classification).toBe('untrusted-repository-data');
    } finally {
      await server.close();
    }
  });

  it('isolated-indexes an explicit Context recovery workspace only after the authenticated action', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repositoryRoot = join(config.agentContextHome, 'context-recovery-project');
    initializeGitRepository(repositoryRoot);
    const identity = await runEffect(resolveRepositoryIdentity(repositoryRoot));
    const snapshot: CodeGraphSnapshot = {
      commit: identity.headCommit,
      completedAt: '2026-08-31T00:00:00.000Z',
      dirty: false,
      edgeCount: 21,
      extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
      fileCount: 12,
      id: `cgsn_${Effect2.pipe('7', EffectString.repeat(40))}-context-recovery`,
      repositoryId: identity.repositoryId,
      state: 'ready',
      symbolCount: 40,
      worktreeId: identity.worktreeId,
    };
    vi.mocked(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).mockReturnValueOnce(
      Effect.succeed({durationMs: 1, identity, snapshot}),
    );
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const response = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'index-cwd', cwd: repositoryRoot}),
        headers,
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        output: 'Ready in an isolated process · 12 files · 40 symbols · 21 edges',
      });
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenCalledWith({
        cwd: identity.repoRoot,
        expectedIdentity: {
          checkoutId: identity.checkoutId,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        },
        force: false,
        manifestPath: config.manifestPath,
        threadnoteHome: config.agentContextHome,
      });

      const rejected = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'index-cwd', cwd: 'relative/project'}),
        headers,
        method: 'POST',
      });
      expect(rejected.status).toBe(500);
      expect(await rejected.json()).toEqual({error: 'Supply cwd as an absolute local worktree path.'});

      const unavailable = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'index-cwd', cwd: config.agentContextHome}),
        headers,
        method: 'POST',
      });
      expect(unavailable.status).toBe(500);
      const unavailableBody = await unavailable.json();
      expect(unavailableBody).toEqual({
        error: 'The selected workspace is not an available local Git repository. Check its path and retry.',
      });
      expect(JSON.stringify(unavailableBody)).not.toContain(config.agentContextHome);
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('chooses a configured scope before repository Index or Reindex starts and rejects stale or foreign choices', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repositoryRoot = join(config.agentContextHome, 'scoped-repository');
    const foreignRoot = join(config.agentContextHome, 'foreign-repository');
    initializeGitRepository(repositoryRoot);
    initializeGitRepository(foreignRoot);
    const identity = await runEffect(resolveRepositoryIdentity(repositoryRoot));
    const projects = [
      {
        name: 'docs',
        path: repositoryRoot,
        uri: 'threadnote://resources/repos/docs',
        seed: [],
        graph: {roots: ['apps/docs'], closure: 'dependencies'},
      },
      {
        name: 'docs-mobile',
        path: repositoryRoot,
        uri: 'threadnote://resources/repos/docs-mobile',
        seed: [],
        graph: {roots: ['apps/docs-mobile'], closure: 'dependencies'},
      },
      {
        name: 'foreign',
        path: foreignRoot,
        uri: 'threadnote://resources/repos/foreign',
        seed: [],
        graph: {roots: ['src'], closure: 'dependencies'},
      },
    ];
    const manifest = JSON.stringify({version: 1, projects});
    await writeFile(config.manifestPath, manifest);
    const server = await startServer(config, 'secret');
    const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
    const target = {
      action: 'index',
      checkoutId: identity.checkoutId,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
      cwd: repositoryRoot,
    };
    const post = (body: object, authenticated = true) =>
      testHttpFetch(`${server.url}/api/graphs/action`, {
        method: 'POST',
        headers: authenticated ? headers : {'content-type': 'application/json'},
        body: JSON.stringify(body),
      });
    try {
      expect((await post(target, false)).status).toBe(401);
      for (const action of [target, {...target, full: true}]) {
        const response = await post(action);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          scopeSelection: {
            expectedRevision: sha256HexSync(manifest),
            projects: [
              {name: 'docs', roots: ['apps/docs']},
              {name: 'docs-mobile', roots: ['apps/docs-mobile']},
            ],
          },
        });
      }
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).not.toHaveBeenCalled();
      const stale = await post({
        ...target,
        project: 'docs',
        expectedRevision: Effect2.pipe('0', EffectString.repeat(64)),
      });
      expect(stale.status).toBe(409);
      const foreign = await post({...target, project: 'foreign', expectedRevision: sha256HexSync(manifest)});
      expect(foreign.status).not.toBe(200);
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).not.toHaveBeenCalled();
      const snapshot = {
        commit: identity.headCommit,
        dirty: false,
        fileCount: 1,
        symbolCount: 2,
        edgeCount: 0,
        id: `cgsn_${Effect2.pipe('3', EffectString.repeat(40))}`,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
        state: 'ready',
        extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
      } as const;
      vi.mocked(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).mockReturnValue(
        Effect.succeed({durationMs: 1, identity, snapshot}),
      );
      for (const [index, project] of projects.slice(0, 2).entries()) {
        const selected = await post({
          ...target,
          full: true,
          project: project.name,
          expectedRevision: sha256HexSync(manifest),
        });
        expect(selected.status).toBe(200);
        expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenNthCalledWith(index + 1, {
          cwd: identity.repoRoot,
          expectedIdentity: {
            checkoutId: identity.checkoutId,
            repositoryId: identity.repositoryId,
            worktreeId: identity.worktreeId,
          },
          force: true,
          manifestPath: config.manifestPath,
          manifestRevision: sha256HexSync(manifest),
          project: {name: project.name, uri: project.uri, graph: project.graph},
          threadnoteHome: config.agentContextHome,
        });
      }
      const configured = await post({
        action: 'index-project',
        project: 'docs',
        expectedRevision: sha256HexSync(manifest),
      });
      expect(configured.status).toBe(200);
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({project: {name: 'docs', uri: projects[0].uri, graph: projects[0].graph}}),
      );
      expect(await readFile(config.manifestPath, 'utf8')).toBe(manifest);
    } finally {
      await server.close();
      vi.mocked(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).mockReset();
    }
  });

  it('exposes and isolated-indexes a configured project before any graph database exists', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repositoryRoot = join(config.agentContextHome, 'configured-project');
    const secondRepositoryRoot = join(config.agentContextHome, 'second-project');
    initializeGitRepository(repositoryRoot);
    initializeGitRepository(secondRepositoryRoot);
    const identity = await runEffect(resolveRepositoryIdentity(repositoryRoot));
    const secondIdentity = await runEffect(resolveRepositoryIdentity(secondRepositoryRoot));
    const manifestFor = (projectPath: string): string =>
      EffectArray.join(
        [
          'version: 1',
          'projects:',
          '  - name: configured-project',
          `    path: ${JSON.stringify(projectPath)}`,
          '    uri: threadnote://resources/repos/configured-project',
          '    seed: []',
          '    graph:',
          '      roots: [src]',
          '      closure: dependencies',
          '',
        ],
        '\n',
      );
    await writeFile(config.manifestPath, manifestFor(repositoryRoot));
    const snapshot: CodeGraphSnapshot = {
      commit: identity.headCommit,
      completedAt: '2026-08-27T12:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
      fileCount: 1,
      id: `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}-direct`,
      repositoryId: identity.repositoryId,
      state: 'ready',
      symbolCount: 2,
      worktreeId: identity.worktreeId,
    };
    const secondSnapshot = {
      ...snapshot,
      commit: secondIdentity.headCommit,
      id: `cgsn_${Effect2.pipe('8', EffectString.repeat(40))}-direct`,
      repositoryId: secondIdentity.repositoryId,
      worktreeId: secondIdentity.worktreeId,
    } satisfies CodeGraphSnapshot;
    vi.mocked(isolatedIndex.runIsolatedCodeGraphIndexSnapshot)
      .mockReturnValueOnce(Effect.succeed({durationMs: 1, identity, snapshot}))
      .mockReturnValueOnce(Effect.succeed({durationMs: 1, identity: secondIdentity, snapshot: secondSnapshot}))
      .mockReturnValueOnce(Effect.succeed({durationMs: 1, identity, snapshot}));
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const response = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const catalog = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            configuredProjects: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  graphState: Schema.String,
                  name: Schema.String,
                  path: Schema.String,
                  scopeId: Schema.optionalKey(Schema.String),
                }),
                [JsonRecordSchema],
              ),
            ),
            manifestRevision: Schema.String,
            repositories: Schema.Array(Schema.Unknown),
          }),
          [JsonRecordSchema],
        ),
        await response.json(),
      );
      expect(response.status).toBe(200);
      expect(catalog.repositories).toEqual([]);
      expect(catalog.configuredProjects).toEqual([
        {
          folder: 'configured-project',
          graphState: 'not-indexed',
          name: 'configured-project',
          path: repositoryRoot,
          scopeId: `code-graph-scope:${sha256HexSync('threadnote://resources/repos/configured-project')}`,
        },
      ]);
      expect(catalog.manifestRevision).toMatch(/^[0-9a-f]{64}$/);

      const indexResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index-project',
          expectedRevision: catalog.manifestRevision,
          project: 'configured-project',
        }),
        headers,
        method: 'POST',
      });
      expect(indexResponse.status).toBe(200);
      expect(await indexResponse.json()).toEqual({
        output: 'Ready in an isolated process · 1 files · 2 symbols · 0 edges',
      });
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenNthCalledWith(1, {
        cwd: identity.repoRoot,
        expectedIdentity: {
          checkoutId: identity.checkoutId,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        },
        force: false,
        manifestPath: config.manifestPath,
        manifestRevision: catalog.manifestRevision,
        project: {
          name: 'configured-project',
          uri: 'threadnote://resources/repos/configured-project',
          graph: {roots: ['src'], closure: 'dependencies'},
        },
        threadnoteHome: config.agentContextHome,
      });
      expect(await runEffect(readCodeGraphLocalAssociation(config.agentContextHome, identity))).toMatchObject({
        path: identity.repoRoot,
        state: 'verified',
      });

      await runEffect(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
          const symbol = graphSymbol(
            'configured-symbol',
            'configuredSymbol',
            'src/index.ts',
            'configured-project',
            'function',
            'configured-project',
          );
          const secondSymbol = graphSymbol(
            'configured-second-symbol',
            'configuredSecondSymbol',
            symbol.path,
            'configured-project',
            'function',
            'configured-project',
          );
          yield* store.activate(
            layout.databasePath,
            identity,
            snapshot,
            [graphFile(symbol.path, symbol.id)],
            [symbol, secondSymbol],
            [],
          );
          yield* store.promote(layout.databasePath, identity, snapshot.id);
        }),
      );
      const refreshedCatalogResponse = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const refreshedCatalog = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            configuredProjects: Schema.Array(
              Schema.StructWithRest(Schema.Struct({graphState: Schema.String, name: Schema.String}), [
                JsonRecordSchema,
              ]),
            ),
          }),
          [JsonRecordSchema],
        ),
        await refreshedCatalogResponse.json(),
      );
      expect(refreshedCatalogResponse.status).toBe(200);
      expect(refreshedCatalog.configuredProjects).toEqual([
        expect.objectContaining({graphState: 'ready', name: 'configured-project'}),
      ]);

      const nestedSymlink = join(repositoryRoot, 'linked-project');
      await symlink(secondRepositoryRoot, nestedSymlink, 'dir');
      await writeFile(config.manifestPath, manifestFor(nestedSymlink));
      const symlinkCatalogResponse = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      const symlinkCatalog = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            configuredProjects: Schema.Array(
              Schema.StructWithRest(Schema.Struct({graphState: Schema.String, name: Schema.String}), [
                JsonRecordSchema,
              ]),
            ),
            manifestRevision: Schema.String,
          }),
          [JsonRecordSchema],
        ),
        await symlinkCatalogResponse.json(),
      );
      expect(symlinkCatalogResponse.status).toBe(200);
      expect(symlinkCatalog.configuredProjects).toEqual([
        expect.objectContaining({graphState: 'not-indexed', name: 'configured-project'}),
      ]);
      const symlinkIndexResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index-project',
          expectedRevision: symlinkCatalog.manifestRevision,
          project: 'configured-project',
        }),
        headers,
        method: 'POST',
      });
      expect(symlinkIndexResponse.status).toBe(200);
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenNthCalledWith(2, {
        cwd: secondIdentity.repoRoot,
        expectedIdentity: {
          checkoutId: secondIdentity.checkoutId,
          repositoryId: secondIdentity.repositoryId,
          worktreeId: secondIdentity.worktreeId,
        },
        force: false,
        manifestPath: config.manifestPath,
        manifestRevision: symlinkCatalog.manifestRevision,
        project: {
          name: 'configured-project',
          uri: 'threadnote://resources/repos/configured-project',
          graph: {roots: ['src'], closure: 'dependencies'},
        },
        threadnoteHome: config.agentContextHome,
      });

      const staleResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index-project',
          expectedRevision: Effect2.pipe('0', EffectString.repeat(64)),
          project: 'configured-project',
        }),
        headers,
        method: 'POST',
      });
      expect(staleResponse.status).toBe(409);
      expect(await staleResponse.json()).toEqual({
        code: 'graph-project-stale',
        error: 'Configured projects changed. Refresh Manager before choosing a project to index.',
        retryAfterMilliseconds: 0,
      });

      const existingIndexResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index',
          checkoutId: identity.checkoutId,
          cwd: repositoryRoot,
          full: true,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        }),
        headers,
        method: 'POST',
      });
      expect(existingIndexResponse.status).toBe(200);
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenNthCalledWith(3, {
        cwd: identity.repoRoot,
        expectedIdentity: {
          checkoutId: identity.checkoutId,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        },
        force: true,
        manifestPath: config.manifestPath,
        manifestRevision: symlinkCatalog.manifestRevision,
        threadnoteHome: config.agentContextHome,
      });

      const unsafeManifest = manifestFor(`${secondRepositoryRoot}\t`);
      await writeFile(config.manifestPath, unsafeManifest);
      const unsafeResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index-project',
          expectedRevision: sha256HexSync(unsafeManifest),
          project: 'configured-project',
        }),
        headers,
        method: 'POST',
      });
      expect(unsafeResponse.status).toBe(409);
      expect(await unsafeResponse.json()).toEqual({
        code: 'graph-project-unavailable',
        error: 'Configured projects could not be read. Refresh Manager and retry.',
        retryAfterMilliseconds: 0,
      });
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenCalledTimes(3);

      const foreignManifest = manifestFor('C:\\foreign\\configured-project');
      await writeFile(config.manifestPath, foreignManifest);
      const foreignResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index-project',
          expectedRevision: sha256HexSync(foreignManifest),
          project: 'configured-project',
        }),
        headers,
        method: 'POST',
      });
      const foreign = await foreignResponse.json();
      expect(foreignResponse.status).toBe(409);
      expect(foreign).toEqual({
        code: 'graph-project-unavailable',
        error:
          'The selected configured project is not an available local Git repository. Check its manifest path and retry.',
        retryAfterMilliseconds: 0,
      });
      expect(JSON.stringify(foreign)).not.toContain('foreign\\configured-project');
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenCalledTimes(3);

      const missingManifest = manifestFor(repositoryRoot);
      await writeFile(config.manifestPath, missingManifest);
      await rm(repositoryRoot, {force: true, recursive: true});
      const unavailableResponse = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index-project',
          expectedRevision: sha256HexSync(missingManifest),
          project: 'configured-project',
        }),
        headers,
        method: 'POST',
      });
      const unavailable = await unavailableResponse.json();
      expect(unavailableResponse.status).toBe(409);
      expect(unavailable).toEqual({
        code: 'graph-project-unavailable',
        error:
          'The selected configured project is not an available local Git repository. Check its manifest path and retry.',
        retryAfterMilliseconds: 0,
      });
      expect(JSON.stringify(unavailable)).not.toContain(repositoryRoot);
      expect(isolatedIndex.runIsolatedCodeGraphIndexSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
    }
  });

  it('serves home-wide graph diagnostics and safety-gated lifecycle actions', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await seedManagerGraph(config);
    const orphanedCheckoutId = Effect2.pipe('d', EffectString.repeat(64));
    const orphanedRoot = join(config.agentContextHome, 'indexes', 'code-graph', 'repositories', orphanedCheckoutId);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const diagnosticsResponse = await testHttpFetch(`${server.url}/api/graphs/diagnostics?analyze=true`, {headers});
      const diagnostics = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            databases: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  health: Schema.StructWithRest(Schema.Struct({integrity: Schema.String}), [JsonRecordSchema]),
                  views: Schema.Array(
                    Schema.StructWithRest(
                      Schema.Struct({
                        localAssociation: Schema.StructWithRest(
                          Schema.Struct({available: Schema.Boolean, state: Schema.String}),
                          [JsonRecordSchema],
                        ),
                      }),
                      [JsonRecordSchema],
                    ),
                  ),
                }),
                [JsonRecordSchema],
              ),
            ),
            mode: Schema.StructWithRest(Schema.Struct({analyze: Schema.Boolean, deep: Schema.Boolean}), [
              JsonRecordSchema,
            ]),
            summary: Schema.StructWithRest(
              Schema.Struct({databaseCount: Schema.Finite, readySnapshotCount: Schema.Finite}),
              [JsonRecordSchema],
            ),
            type: Schema.String,
            version: Schema.Finite,
          }),
          [JsonRecordSchema],
        ),
        await diagnosticsResponse.json(),
      );
      expect(diagnosticsResponse.status).toBe(200);
      expect(diagnostics).toMatchObject({
        mode: {analyze: true, deep: false},
        summary: {databaseCount: 1, readySnapshotCount: 1},
        type: 'code-graph-diagnostics',
        version: 2,
      });
      expect(diagnostics.databases[0]).toMatchObject({health: {integrity: 'ok'}});
      expect(diagnostics.databases[0]?.views[0]?.localAssociation).toEqual({
        available: false,
        state: 'legacy-unknown',
      });

      const repairPreview = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'repair', dryRun: true}),
        headers,
        method: 'POST',
      });
      const repairOutput = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await repairPreview.json(),
      );
      expect(repairPreview.status).toBe(200);
      expect(repairOutput.output).toContain('Would repair 1 native code graph database(s)');

      const purgePreview = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge-all', dryRun: true}),
        headers,
        method: 'POST',
      });
      expect(purgePreview.status).toBe(200);
      expect(await purgePreview.json()).toMatchObject({output: expect.stringContaining('Would remove derived')});

      const refusedPurge = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge-all'}),
        headers,
        method: 'POST',
      });
      expect(refusedPurge.status).toBe(500);
      expect(await refusedPurge.json()).toMatchObject({error: 'Set confirm=true for this action.'});

      const relativeTarget = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index',
          checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
          cwd: '.',
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
        }),
        headers,
        method: 'POST',
      });
      expect(relativeTarget.status).toBe(500);
      expect(await relativeTarget.json()).toMatchObject({error: 'Supply cwd as an absolute local worktree path.'});

      const missingRepositoryIdentity = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'index',
          checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
          cwd: config.agentContextHome,
          worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
        }),
        headers,
        method: 'POST',
      });
      expect(missingRepositoryIdentity.status).toBe(500);
      expect(await missingRepositoryIdentity.json()).toMatchObject({error: 'Provide repositoryId.'});

      await mkdir(orphanedRoot, {recursive: true});
      await writeFile(join(orphanedRoot, 'graph-v3.sqlite'), 'incompatible disposable graph\n');
      const targetedPreview = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge', checkoutId: orphanedCheckoutId, dryRun: true}),
        headers,
        method: 'POST',
      });
      expect(targetedPreview.status).toBe(200);
      expect(await targetedPreview.json()).toMatchObject({
        output: `Would remove derived code graph index for checkout ${Effect2.pipe(orphanedCheckoutId, EffectString.slice(0, 12))}.`,
      });
      expect(existsSync(orphanedRoot)).toBe(true);

      const refusedTargetedPurge = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge', checkoutId: orphanedCheckoutId}),
        headers,
        method: 'POST',
      });
      expect(refusedTargetedPurge.status).toBe(500);
      expect(await refusedTargetedPurge.json()).toMatchObject({error: 'Set confirm=true for this action.'});

      const targetedPurge = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({action: 'purge', checkoutId: orphanedCheckoutId, confirm: true}),
        headers,
        method: 'POST',
      });
      expect(targetedPurge.status).toBe(200);
      expect(await targetedPurge.json()).toMatchObject({
        output: `Removed derived code graph index for checkout ${Effect2.pipe(orphanedCheckoutId, EffectString.slice(0, 12))}.`,
      });
      expect(existsSync(orphanedRoot)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('applies a verified isolated graph compaction through the authenticated Manager route', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'manager-compaction-worktree');
    initializeGitRepository(root);
    const identity = await runEffect(resolveRepositoryIdentity(root));
    vi.mocked(automaticCompaction.compactCodeGraphStorageIsolated).mockReturnValueOnce(
      Effect.succeed({action: 'compacted', checkoutId: identity.checkoutId, reclaimedBytes: 1_048_576}),
    );
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'compact',
          checkoutId: identity.checkoutId,
          confirm: true,
          cwd: root,
          force: true,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        output: 'Compacted the selected graph in an isolated process and reclaimed 1,048,576 bytes.',
      });
      expect(automaticCompaction.compactCodeGraphStorageIsolated).toHaveBeenCalledWith(
        config.agentContextHome,
        identity.checkoutId,
        {force: true, operation: 'compact'},
      );
    } finally {
      await server.close();
    }
  });

  it('previews and applies an exact authenticated graph view removal with an approval digest', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const snapshotId = `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}-direct`;
    const checkoutId = await seedManagerGraph(config, snapshotId);
    const worktreeId = Effect2.pipe('c', EffectString.repeat(64));
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const target = {action: 'remove-view', checkoutId, expectedSnapshotId: snapshotId, worktreeId};
      const unauthorized = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, dryRun: true}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      });
      expect(unauthorized.status).toBe(401);

      const catalog = await testHttpFetch(`${server.url}/api/graphs`, {headers});
      expect(catalog.status).toBe(200);
      const preview = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, dryRun: true}),
        headers,
        method: 'POST',
      });
      const prepared = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            approvalDigest: Schema.String,
            output: Schema.String,
            result: Schema.StructWithRest(
              Schema.Struct({
                applied: Schema.Boolean,
                state: Schema.String,
                type: Schema.String,
                version: Schema.Finite,
              }),
              [JsonRecordSchema],
            ),
          }),
          [JsonRecordSchema],
        ),
        await preview.json(),
      );
      expect(preview.status).toBe(200);
      expect(prepared).toMatchObject({
        approvalDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        output: expect.stringContaining('Would remove native code graph view'),
        result: {applied: false, state: 'ready', type: 'code-graph-view-removal', version: 1},
      });
      expect(JSON.stringify(prepared)).not.toContain(config.agentContextHome);

      const refused = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, confirm: true}),
        headers,
        method: 'POST',
      });
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({
        error: 'Preview this exact graph view removal and provide its approval digest before applying.',
      });

      const applied = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, approvalDigest: prepared.approvalDigest, confirm: true}),
        headers,
        method: 'POST',
      });
      const result = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            approvalDigest: Schema.String,
            output: Schema.String,
            result: Schema.StructWithRest(Schema.Struct({applied: Schema.Boolean, state: Schema.String}), [
              JsonRecordSchema,
            ]),
          }),
          [JsonRecordSchema],
        ),
        await applied.json(),
      );
      expect(applied.status).toBe(200);
      expect(result).toMatchObject({
        approvalDigest: prepared.approvalDigest,
        output: expect.stringContaining('Removed native code graph view'),
        result: {applied: true, state: 'removed'},
      });
      expect(JSON.stringify(result)).not.toContain(config.agentContextHome);
      const databasePath = join(
        config.agentContextHome,
        'indexes',
        'code-graph',
        'repositories',
        checkoutId,
        'graph-v3.sqlite',
      );
      const database = new (await import('bun:sqlite')).Database(databasePath, {readonly: true});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
      database.close();

      const retried = await fetchManagerGraphActionWhenAvailable(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...target, approvalDigest: prepared.approvalDigest, confirm: true}),
        headers,
        method: 'POST',
      });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({result: {applied: true, state: 'already-removed'}});

      const stalePreview = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          ...target,
          dryRun: true,
          expectedSnapshotId: `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}-direct`,
        }),
        headers,
        method: 'POST',
      });
      expect(stalePreview.status).toBe(200);
      const stale = await stalePreview.json();
      expect(stale).toMatchObject({result: {observedState: 'removed', state: 'stale-target'}});
      expect(JSON.stringify(stale)).not.toContain(config.agentContextHome);
    } finally {
      await server.close();
    }
  });

  effectIt.effect('maps a busy graph view target to a fixed path-free retry response', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* Effect.promise(makeRuntime);
        homes.push(config.agentContextHome);
        const snapshotId = `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}-direct`;
        const checkoutId = yield* Effect.promise(() => seedManagerGraph(config, snapshotId));
        const worktreeId = Effect2.pipe('c', EffectString.repeat(64));
        const server = yield* Effect.promise(() => startServer(config, 'secret'));
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* withCodeGraphTargetWorktreeLock(
          config.agentContextHome,
          checkoutId,
          worktreeId,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(provideTestLayer(ApplicationLayer), Effect.forkScoped);
        yield* Effect.gen(function* () {
          const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
          const target = {action: 'remove-view', checkoutId, expectedSnapshotId: snapshotId, worktreeId};
          const preview = yield* Effect.promise(() =>
            testHttpFetch(`${server.url}/api/graphs/action`, {
              body: JSON.stringify({...target, dryRun: true}),
              headers,
              method: 'POST',
            }),
          );
          const prepared = decodeJson(
            Schema.StructWithRest(Schema.Struct({approvalDigest: Schema.String}), [JsonRecordSchema]),
            yield* Effect.promise(() => preview.json()),
          );
          yield* Deferred.await(acquired);
          const response = yield* Effect.promise(() =>
            testHttpFetch(`${server.url}/api/graphs/action`, {
              body: JSON.stringify({...target, approvalDigest: prepared.approvalDigest, confirm: true}),
              headers,
              method: 'POST',
            }),
          );
          expect(response.status).toBe(409);
          const busy = yield* Effect.promise(() => response.json());
          expect(busy).toEqual({
            code: 'graph-view-busy',
            error: 'The selected graph view is busy. Retry after the active graph operation completes.',
            retryAfterMilliseconds: 1_000,
          });
          expect(JSON.stringify(busy)).not.toContain(config.agentContextHome);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(release, undefined).pipe(
              Effect.andThen(Fiber.await(owner)),
              Effect.andThen(Effect.promise(() => server.close())),
            ),
          ),
        );
      }),
    ),
  );

  it('rejects mismatched Manager graph identities before a targeted action starts', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'manager-action-worktree');
    initializeGitRepository(root);
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret', 'content-type': 'application/json'};
      const expected = {
        checkoutId: identity.checkoutId,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      };
      for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
        const response = await testHttpFetch(`${server.url}/api/graphs/action`, {
          body: JSON.stringify({
            ...expected,
            [component]: differentGraphIdentity(expected[component]),
            action: 'index',
            cwd: root,
          }),
          headers,
          method: 'POST',
        });
        expect(response.status, component).toBe(500);
        expect(await response.json(), component).toEqual({
          error: 'The supplied worktree path does not match the selected graph identity.',
        });
      }

      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.com/changed.git'], {
        stdio: 'pipe',
      });
      const changedOrigin = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({...expected, action: 'compact', cwd: root, dryRun: true}),
        headers,
        method: 'POST',
      });
      expect(changedOrigin.status).toBe(500);
      expect(await changedOrigin.json()).toEqual({
        error: 'The supplied worktree path does not match the selected graph identity.',
      });
    } finally {
      await server.close();
    }
  });

  it('live-revalidates fresh persisted and Manager graph target fallbacks after origin drift', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const root = join(config.agentContextHome, 'manager-fallback-worktree');
    initializeGitRepository(root);
    const identity = await runEffect(resolveRepositoryIdentity(root));
    await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
        yield* recordVerifiedCodeGraphLocalAssociation(config.agentContextHome, identity);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'waiting'});
      }),
    );
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.com/changed.git'], {
      stdio: 'pipe',
    });

    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/graphs/action`, {
        body: JSON.stringify({
          action: 'compact',
          checkoutId: identity.checkoutId,
          dryRun: true,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'The selected graph has no current local worktree target. Supply cwd and refresh graph diagnostics.',
      });
    } finally {
      await server.close();
    }
  });

  it('returns a busy response for graph APIs when maintenance starts after Manager', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const [response, statusResponse] = await runEffect(
        withCodeGraphMaintenanceIntent(
          config.agentContextHome,
          Effect.all(
            [
              Effect.promise(() =>
                testHttpFetch(`${server.url}/api/graphs/diagnostics`, {headers: {authorization: 'Bearer secret'}}),
              ),
              Effect.promise(() =>
                testHttpFetch(`${server.url}/api/graphs/status`, {headers: {authorization: 'Bearer secret'}}),
              ),
            ] as const,
            {concurrency: 'unbounded'},
          ),
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Native code graph repair or maintenance is in progress'),
      });
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        builds: [],
        maintenance: {operation: 'graph-maintenance', phase: 'working'},
      });
    } finally {
      await server.close();
    }
  });

  it('rejects stale graph reads after promotion and serves the refreshed current view', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const checkoutId = await seedManagerGraph(config);
    const server = await startServer(config, 'secret');
    try {
      const headers = {authorization: 'Bearer secret'};
      const catalog = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            repositories: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  defaultViewId: Schema.String,
                  views: Schema.Array(
                    Schema.StructWithRest(
                      Schema.Struct({
                        id: Schema.String,
                        snapshot: Schema.StructWithRest(Schema.Struct({id: Schema.String}), [JsonRecordSchema]),
                      }),
                      [JsonRecordSchema],
                    ),
                  ),
                }),
                [JsonRecordSchema],
              ),
            ),
          }),
          [JsonRecordSchema],
        ),
        await (await testHttpFetch(`${server.url}/api/graphs`, {headers})).json(),
      );
      const view = catalog.repositories[0].views[0];
      const originalSnapshotId = view.snapshot.id;
      expect(originalSnapshotId).toBe(MANAGER_GRAPH_SNAPSHOT_ID);
      const replacementSnapshotId = await promoteManagerGraphReplacement(config);
      const staleUrls = [
        `${server.url}/api/graph?repository=${checkoutId}&snapshot=${originalSnapshotId}&project=cgp_app`,
        `${server.url}/api/graph/node?repository=${checkoutId}&snapshot=${originalSnapshotId}&node=app`,
        `${server.url}/api/graph/analysis?repository=${checkoutId}&snapshot=${originalSnapshotId}`,
        `${server.url}/api/graph/query?repository=${checkoutId}&snapshot=${originalSnapshotId}&query=App`,
        `${server.url}/api/graphs/page?repository=${checkoutId}&snapshot=${originalSnapshotId}&query=app`,
      ];
      for (const url of staleUrls) {
        const stale = await testHttpFetch(url, {headers});
        expect(stale.status, url).toBe(409);
        expect(await stale.json(), url).toEqual({
          code: 'graph-view-stale',
          error: 'The selected graph view changed or was removed. Refresh the graph catalog.',
          retryAfterMilliseconds: 0,
        });
      }

      const currentGraph = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            repository: Schema.StructWithRest(
              Schema.Struct({snapshot: Schema.StructWithRest(Schema.Struct({id: Schema.String}), [JsonRecordSchema])}),
              [JsonRecordSchema],
            ),
          }),
          [JsonRecordSchema],
        ),
        await (await testHttpFetch(`${server.url}/api/graph?repository=${checkoutId}&project=all`, {headers})).json(),
      );
      expect(currentGraph.repository.snapshot.id).toBe(replacementSnapshotId);
    } finally {
      await server.close();
    }
  });

  it('returns per-item bulk results without hiding failures', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(memory.runArchive).mockImplementation((_config, uri) => {
      if (Effect2.pipe(uri, EffectString.endsWith('bad.md'))) {
        return Effect.fail(TestError.make({message: 'archive failed'}));
      }
      return Effect.void;
    });
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/bulk`, {
        body: JSON.stringify({
          action: 'archive',
          confirm: true,
          uris: [
            'threadnote://user/denys/memories/durable/projects/threadnote/good.md',
            'threadnote://user/denys/memories/durable/projects/threadnote/bad.md',
          ],
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            results: Schema.Array(
              Schema.StructWithRest(Schema.Struct({ok: Schema.Boolean, error: Schema.optionalKey(Schema.String)}), [
                JsonRecordSchema,
              ]),
            ),
          }),
          [JsonRecordSchema],
        ),
        await response.json(),
      );
      expect(response.status).toBe(200);
      expect(EffectArray.map(body.results, item => item.ok)).toEqual([true, false]);
      expect(body.results[1]?.error).toContain('archive failed');
    } finally {
      await server.close();
    }
  });

  it('reads a memory URI through the generic read endpoint', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/read`, {
        body: JSON.stringify({uri: 'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            content: Schema.String,
            localMemory: Schema.optionalKey(
              Schema.StructWithRest(
                Schema.Struct({node: Schema.StructWithRest(Schema.Struct({uri: Schema.String}), [JsonRecordSchema])}),
                [JsonRecordSchema],
              ),
            ),
          }),
          [JsonRecordSchema],
        ),
        await response.json(),
      );

      expect(response.status).toBe(200);
      expect(body.content).toContain('Manager UI feature notes.');
      expect(body.localMemory?.node.uri).toBe(
        'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md',
      );
    } finally {
      await server.close();
    }
  });

  it('runs recall through the scoped manager Effect runtime', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/recall`, {
        body: JSON.stringify({query: 'manager context'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await response.json(),
      );

      expect(response.status).toBe(200);
      expect(body.output).toBe('recall result: manager context');
      expect(vi.mocked(memory.runRecall)).toHaveBeenCalledWith(config, {
        nodeLimit: undefined,
        project: undefined,
        query: 'manager context',
      });
    } finally {
      await server.close();
    }
  });

  it('adds scope diagnostics to compact output', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/compact`, {
        body: JSON.stringify({project: 'threadnote', topic: 'manager-ui'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await response.json(),
      );

      expect(response.status).toBe(200);
      expect(body.output).toContain('Scope summary:');
      expect(body.output).toContain('- active records matching topic: 1');
      expect(body.output).toContain('Dry-run memory hygiene plan for project threadnote, topic manager-ui');
      expect(body.output).toContain('Records scanned: 1');
    } finally {
      await server.close();
    }
  });

  it('audits shared memories for merge review without planning shared mutations', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sharedPath = join(
      config.agentContextHome,
      'data',
      config.account,
      'user',
      config.user,
      'memories',
      'shared',
      'platform',
      'durable',
      'projects',
      'threadnote',
      'manager-ui.md',
    );
    await mkdir(join(sharedPath, '..'), {recursive: true});
    await writeFile(
      sharedPath,
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: manager-ui',
          'source_agent_client: shared-test',
          'timestamp: 2026-06-06T00:00:00.000Z',
          '',
          'Reviewed shared Manager UI notes.',
        ],
        '\n',
      ),
    );
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/compact`, {
        body: JSON.stringify({project: 'threadnote', topic: 'manager-ui'}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await response.json(),
      );

      expect(response.status).toBe(200);
      expect(body.output).toContain('Records scanned: 2');
      expect(body.output).toContain('same project/topic spans multiple memory scopes');
      expect(body.output).toContain('threadnote://user/denys/memories/shared/platform/');
      expect(body.output).toContain('Archive expired/stale active memories (0):\n- none');
      expect(body.output).toContain('Forget exact duplicates (0):\n- none');
    } finally {
      await server.close();
    }
  });

  it('removes a personal project folder recursively', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const projectPath = join(
      config.agentContextHome,
      'data',
      config.account,
      'user',
      config.user,
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    const server = await startServer(config, 'secret');
    try {
      const response = await testHttpFetch(`${server.url}/api/folder/remove`, {
        body: JSON.stringify({
          confirm: true,
          uri: 'threadnote://user/denys/memories/durable/projects/threadnote',
        }),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await response.json(),
      );

      expect(response.status).toBe(200);
      expect(body.output).toContain('Removed folder: threadnote://user/denys/memories/durable/projects/threadnote');
      expect(body.output).toContain('Forgot 2 files.');
      expect(EffectArray.map(vi.mocked(memory.runForget).mock.calls, call => call[1]).sort()).toEqual([
        'threadnote://user/denys/memories/durable/projects/threadnote/.abstract.md',
        'threadnote://user/denys/memories/durable/projects/threadnote/manager-ui.md',
      ]);
      await expect(stat(projectPath)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await server.close();
    }
  });

  it('requires confirmation for non-dry-run repair and returns repair output', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const rejected = await testHttpFetch(`${server.url}/api/doctor/repair`, {
        body: JSON.stringify({}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(rejected.status).toBe(500);
      expect(vi.mocked(lifecycle.runRepair)).not.toHaveBeenCalled();

      const accepted = await testHttpFetch(`${server.url}/api/doctor/repair`, {
        body: JSON.stringify({confirm: true}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const body = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await accepted.json(),
      );

      expect(accepted.status).toBe(200);
      expect(body.output).toBe('repair applied');
      expect(vi.mocked(lifecycle.runRepair)).toHaveBeenCalledWith(config, {dryRun: false});
    } finally {
      await server.close();
    }
  });

  it('keeps captured output isolated across concurrent requests', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(lifecycle.runRepair).mockImplementation((_config, options) =>
      Effect.gen(function* () {
        const label = options.dryRun ? 'dry run' : 'applied';
        yield* Console.log(`${label} start`);
        yield* Effect.sleep('10 millis');
        yield* Console.log(`${label} end`);
      }),
    );
    const server = await startServer(config, 'secret');
    try {
      const request = (path: string, body: object) =>
        testHttpFetch(`${server.url}${path}`, {
          body: JSON.stringify(body),
          headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
          method: 'POST',
        }).then(async response =>
          decodeJson(
            Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
            await response.json(),
          ),
        );
      const [dryRun, applied] = await Promise.all([
        request('/api/doctor/repair-dry-run', {}),
        request('/api/doctor/repair', {confirm: true}),
      ]);

      expect(dryRun.output).toBe('dry run start\ndry run end');
      expect(applied.output).toBe('applied start\napplied end');
    } finally {
      await server.close();
    }
  });

  it('runs seed and seed-skills in write mode by default', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const server = await startServer(config, 'secret');
    try {
      const seedResponse = await testHttpFetch(`${server.url}/api/seed`, {
        body: JSON.stringify({confirm: true}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const seedBody = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await seedResponse.json(),
      );
      expect(seedResponse.status).toBe(200);
      expect(seedBody.output).toBe('seed applied');
      expect(vi.mocked(seeding.runSeed)).toHaveBeenCalledWith(config, {dryRun: false});

      const skillsResponse = await testHttpFetch(`${server.url}/api/seed`, {
        body: JSON.stringify({confirm: true, skills: true}),
        headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      const skillsBody = decodeJson(
        Schema.StructWithRest(Schema.Struct({output: Schema.String}), [JsonRecordSchema]),
        await skillsResponse.json(),
      );
      expect(skillsResponse.status).toBe(200);
      expect(skillsBody.output).toBe('seed skills applied');
      expect(vi.mocked(seeding.runSeedSkills)).toHaveBeenCalledWith(config, {dryRun: false});
    } finally {
      await server.close();
    }
  });
});

describe('manager doctor output parsing', () => {
  it('parses plain and colored CLI doctor rows', () => {
    const checks = parseDoctorChecksFromOutput(
      EffectArray.join(
        [
          'OK  mode: read-only checks',
          '\u001b[33mWARN\u001b[0m threadnote shim: /tmp/threadnote points elsewhere',
          'FAIL manifest: missing manifest',
          '',
          'Summary: 1 failure(s), 1 warning(s)',
        ],
        '\n',
      ),
    );

    expect(checks).toEqual([
      {detail: 'read-only checks', name: 'mode', status: 'ok'},
      {detail: '/tmp/threadnote points elsewhere', name: 'threadnote shim', status: 'warn'},
      {detail: 'missing manifest', name: 'manifest', status: 'fail'},
    ]);
  });
});

describe('manager consolidation agents', () => {
  it('uses the current codex exec CLI flags', () => {
    const script = consolidationAgentScript('codex', '/Applications/Codex CLI/codex');

    expect(script).toBe(
      '\'/Applications/Codex CLI/codex\' exec --sandbox read-only --skip-git-repo-check --json --output-last-message "$2" - < "$1"',
    );
    expect(script).not.toContain('--ask-for-approval');
  });

  it('uses claude print mode for Claude consolidation', () => {
    expect(consolidationAgentScript('claude', '/usr/local/bin/claude')).toBe(
      '/usr/local/bin/claude --print --permission-mode default < "$1"',
    );
  });
});
