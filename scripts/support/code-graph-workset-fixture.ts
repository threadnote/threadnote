import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ScriptError} from '../effect/errors.js';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {Effect, FileSystem, Layer, ManagedRuntime, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const platformRuntime = ManagedRuntime.make(Layer.merge(BunFileSystem.layer, BunPath.layer));
const fileSystem = platformRuntime.runSync(FileSystem.FileSystem);
const pathService = platformRuntime.runSync(Path.Path);
const {dirname, join, relative, resolve} = pathService;

export const CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION = 1 as const;
/** Default correctness/evaluation matrix from the product plan. */
export const CODE_GRAPH_WORKSET_FIXTURE_SIZES = [1, 8, 32, 64, 128] as const;
/** Additional performance gate that is intentionally not part of the default evaluation matrix. */
export const CODE_GRAPH_WORKSET_FIXTURE_BENCHMARK_SIZES = [50] as const;
/** Every size accepted by the generator and emitted as a prefix workset by a max-size fixture. */
export const CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES = [1, 8, 32, 50, 64, 128] as const;

export type CodeGraphWorksetFixtureSize = (typeof CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES)[number];
export type CodeGraphWorksetFixtureState = 'clean' | 'cold' | 'dirty' | 'failed' | 'missing' | 'stale' | 'worktree';
export type CodeGraphWorksetFixtureStateProfile = 'all-clean' | 'mixed';
export type CodeGraphWorksetFixtureQueryCategory =
  'concept' | 'impact' | 'imports' | 'callers' | 'no-answer' | 'package' | 'path' | 'schema' | 'symbol';

export interface CodeGraphWorksetFixtureSymbolExpectation {
  readonly repositoryId: string;
  readonly symbol: string;
}

export interface CodeGraphWorksetFixtureEdgeExpectation {
  readonly provenance: string;
  readonly relation: string;
  readonly source: CodeGraphWorksetFixtureSymbolExpectation;
  readonly target: CodeGraphWorksetFixtureSymbolExpectation;
}

export interface CodeGraphWorksetFixtureFile {
  readonly content: string;
  readonly digest: string;
  readonly path: string;
}

export interface CodeGraphWorksetFixtureRepositoryPlan {
  readonly archetype: string;
  readonly archetypeTags: readonly string[];
  readonly contentDigest: string;
  readonly files: readonly CodeGraphWorksetFixtureFile[];
  readonly packageName: string;
  readonly projectName: string;
  readonly remoteUrl: string;
  readonly repositoryKey: string;
  readonly state: CodeGraphWorksetFixtureState;
}

export interface CodeGraphWorksetFixtureMemberPlan {
  readonly archetypeId: string;
  readonly expectedState: 'current' | 'deferred' | 'failed' | 'missing' | 'stale';
  readonly id: string;
  readonly ordinal: number;
  readonly worktree: {
    readonly isolation?: {
      readonly forbiddenMemberIds: readonly string[];
      readonly key: string;
    };
    readonly state: 'clean' | 'dirty';
  };
}

export interface CodeGraphWorksetFixtureArchetypeMetadata {
  readonly description: string;
  readonly id: string;
  readonly sha256: string;
  readonly tags: readonly string[];
}

export interface CodeGraphWorksetFixtureQuery {
  readonly answerable: boolean;
  readonly category: CodeGraphWorksetFixtureQueryCategory;
  readonly distractorRepositoryKeys: readonly string[];
  readonly expectedEdges: readonly CodeGraphWorksetFixtureEdgeExpectation[];
  readonly expectedRepositories: readonly string[];
  readonly expectedSymbols: readonly CodeGraphWorksetFixtureSymbolExpectation[];
  readonly id: string;
  readonly operation: 'impact' | 'path' | 'query';
  readonly query: string;
  readonly relevantRepositoryKeys: readonly string[];
  readonly sizes: readonly CodeGraphWorksetFixtureSize[];
  readonly text: string;
}

export interface CodeGraphWorksetFixtureIdentity {
  readonly archetypeDigests: Readonly<Record<string, string>>;
  readonly generator: 'threadnote-code-graph-workset-fixture';
  readonly generatorVersion: typeof CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION;
  readonly id: string;
  readonly membershipDigest: string;
  readonly querySpecificationDigest: string;
  readonly repositoryCount: CodeGraphWorksetFixtureSize;
  readonly stateProfile: CodeGraphWorksetFixtureStateProfile;
  readonly worksetName: string;
}

export interface CodeGraphWorksetFixturePlan {
  readonly allowedAuthoritativeEdges: readonly CodeGraphWorksetFixtureEdgeExpectation[];
  readonly identity: CodeGraphWorksetFixtureIdentity;
  readonly members: readonly CodeGraphWorksetFixtureMemberPlan[];
  readonly queries: readonly CodeGraphWorksetFixtureQuery[];
  readonly repositories: readonly CodeGraphWorksetFixtureRepositoryPlan[];
  readonly version: 1;
  readonly workset: {
    readonly description: string;
    readonly name: string;
  };
  readonly worksets: readonly {
    readonly description: string;
    readonly name: string;
    readonly repositoryKeys: readonly string[];
    readonly size: CodeGraphWorksetFixtureSize;
  }[];
}

export interface CreateCodeGraphWorksetFixturePlanOptions {
  readonly repositoryStates?: Readonly<Record<string, CodeGraphWorksetFixtureState>>;
  readonly stateProfile?: CodeGraphWorksetFixtureStateProfile;
  readonly worksetName?: string;
}

export interface MaterializeCodeGraphWorksetFixtureOptions {
  readonly concurrency?: number;
}

export interface PrepareCodeGraphWorksetFixtureOptions
  extends CreateCodeGraphWorksetFixturePlanOptions, MaterializeCodeGraphWorksetFixtureOptions {
  readonly root?: string;
  readonly size: CodeGraphWorksetFixtureSize;
}

export interface MaterializedCodeGraphWorksetFixtureRepository {
  readonly archetype: string;
  readonly contentDigest: string;
  readonly exists: boolean;
  readonly headCommit?: string;
  readonly path: string;
  readonly projectName: string;
  readonly readyCommit?: string;
  readonly remoteUrl: string;
  readonly repositoryKey: string;
  readonly siblingWorktreePath?: string;
  readonly state: CodeGraphWorksetFixtureState;
}

export interface PreparedCodeGraphWorksetFixture {
  readonly home: string;
  readonly identity: CodeGraphWorksetFixtureIdentity;
  readonly manifestPath: string;
  readonly metadataPath: string;
  readonly plan: CodeGraphWorksetFixturePlan;
  readonly repositories: readonly MaterializedCodeGraphWorksetFixtureRepository[];
  readonly repositoriesRoot: string;
  readonly root: string;
}

interface FixtureArchetype {
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
  readonly id: string;
  readonly tags: readonly string[];
}

const REPOSITORY_KEY_TOKEN = '__REPOSITORY_KEY__';
const REPOSITORY_SYMBOL_TOKEN = '__REPOSITORY_SYMBOL__';
const PROJECT_NAME_TOKEN = '__PROJECT_NAME__';
const PACKAGE_NAME_TOKEN = '__PACKAGE_NAME__';
const PRODUCER_PACKAGE = '@threadnote-fixture/session-contract';
const FIXED_GIT_EPOCH_SECONDS = 1_704_067_200;

const TYPESCRIPT_CONFIG = `${JSON.stringify(
  {compilerOptions: {module: 'NodeNext', moduleResolution: 'NodeNext', strict: true}, include: ['src/**/*.ts']},
  undefined,
  2,
)}\n`;

const ARCHETYPES = [
  {
    description: 'Authoritative package, schema, API, and message producer.',
    files: {
      'README.md':
        '# Session contract producer\n\n' +
        'The session contract owns tenant-session resolution and publishes the TenantSessionChanged message.\n',
      'contracts/messages.asyncapi.yaml':
        'asyncapi: 2.6.0\n' +
        'info:\n  title: Tenant session events\n  version: 1.0.0\n' +
        'channels:\n  tenant.session.changed:\n    publish:\n      message:\n        name: TenantSessionChanged\n',
      'contracts/openapi.yaml':
        'openapi: 3.1.0\n' +
        'info:\n  title: Tenant Session API\n  version: 1.0.0\n' +
        'paths:\n  /v1/tenant-sessions/{tenantId}:\n    get:\n      operationId: getTenantSession\n      responses:\n        "200":\n          description: Tenant session\n',
      'contracts/schema.graphql':
        'type TenantSession { tenantId: ID!, sessionId: ID!, active: Boolean! }\n' +
        'type Query { tenantSession(tenantId: ID!): TenantSession }\n',
      'threadnote/session/v1/session.proto':
        'syntax = "proto3";\n' +
        'package threadnote.session.v1;\n' +
        'message TenantSessionRequest { string tenant_id = 1; }\n' +
        'message TenantSession { string tenant_id = 1; string session_id = 2; }\n' +
        'service SessionDirectory { rpc ResolveTenantSession(TenantSessionRequest) returns (TenantSession); }\n',
      'package.json': `${JSON.stringify(
        {
          exports: {'.': './src/session.ts'},
          name: PRODUCER_PACKAGE,
          private: true,
          type: 'module',
          version: '1.0.0',
        },
        undefined,
        2,
      )}\n`,
      'src/session.ts':
        "export const TENANT_SESSION_CHANGED_TOPIC = 'tenant.session.changed';\n" +
        'export interface TenantSession { active: boolean; sessionId: string; tenantId: string }\n' +
        'export function resolveTenantSession(tenantId: string): TenantSession {\n' +
        '  return {active: true, sessionId: `session-${tenantId}`, tenantId};\n' +
        '}\n',
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'contract-producer',
    tags: ['producer', 'graphql', 'http', 'message', 'openapi', 'protobuf'],
  },
  {
    description: 'Workspace package consumer with declared package and local workspace dependencies.',
    files: {
      'README.md':
        '# Session workspace consumer\n\n' +
        'The application resolves tenant sessions through the declared session-contract package.\n',
      'package.json': `${JSON.stringify(
        {
          name: PACKAGE_NAME_TOKEN,
          private: true,
          type: 'module',
          version: '1.0.0',
          workspaces: ['packages/*'],
        },
        undefined,
        2,
      )}\n`,
      'packages/app/package.json': `${JSON.stringify(
        {
          dependencies: {'@threadnote-fixture/session-client': 'workspace:*'},
          name: `${PACKAGE_NAME_TOKEN}-app`,
          private: true,
          version: '1.0.0',
        },
        undefined,
        2,
      )}\n`,
      'packages/app/src/bootstrap.ts':
        "import {loadSession} from '../../session-client/src/client.js';\n" +
        'export const bootstrapTenant = (tenantId: string) => loadSession(tenantId);\n',
      'packages/session-client/package.json': `${JSON.stringify(
        {
          dependencies: {[PRODUCER_PACKAGE]: '1.0.0'},
          name: '@threadnote-fixture/session-client',
          private: true,
          version: '1.0.0',
        },
        undefined,
        2,
      )}\n`,
      'packages/session-client/src/client.ts':
        `import {resolveTenantSession} from '${PRODUCER_PACKAGE}';\n` +
        'export const loadSession = (tenantId: string) => resolveTenantSession(tenantId);\n',
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'workspace-consumer',
    tags: ['consumer', 'package-dependency', 'workspace-dependency'],
  },
  {
    description: 'GraphQL operation consumer of the authoritative producer schema.',
    files: {
      'README.md':
        '# GraphQL session client\n\nThis client requests TenantSession fields from the contract producer.\n',
      'package.json': `${JSON.stringify(
        {dependencies: {[PRODUCER_PACKAGE]: '1.0.0'}, name: PACKAGE_NAME_TOKEN, private: true, version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'src/session-query.graphql':
        'query TenantSessionByTenant($tenantId: ID!) {\n' +
        '  tenantSession(tenantId: $tenantId) { tenantId sessionId active }\n' +
        '}\n',
      'src/session-query.ts':
        "export const tenantSessionOperation = 'TenantSessionByTenant';\n" +
        'export const tenantSessionVariables = (tenantId: string) => ({tenantId});\n',
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'graphql-consumer',
    tags: ['consumer', 'graphql', 'package-dependency'],
  },
  {
    description: 'Protobuf client importing the producer contract by its declared package path.',
    files: {
      'README.md': '# Protobuf session client\n\nThe worker calls SessionDirectory.ResolveTenantSession.\n',
      'package.json': `${JSON.stringify(
        {dependencies: {[PRODUCER_PACKAGE]: '1.0.0'}, name: PACKAGE_NAME_TOKEN, private: true, version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'proto/session_client.proto':
        'syntax = "proto3";\n' +
        'package threadnote.session.client.v1;\n' +
        'import "threadnote/session/v1/session.proto";\n' +
        'message SessionLookup { threadnote.session.v1.TenantSessionRequest request = 1; }\n',
      'src/client.ts':
        "export const sessionDirectoryMethod = 'threadnote.session.v1.SessionDirectory/ResolveTenantSession';\n",
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'protobuf-consumer',
    tags: ['consumer', 'package-dependency', 'protobuf'],
  },
  {
    description: 'OpenAPI and concrete HTTP route consumer.',
    files: {
      'README.md': '# Tenant session HTTP gateway\n\nThe gateway calls the producer Tenant Session API.\n',
      'openapi/session-gateway.yaml':
        'openapi: 3.1.0\n' +
        'info:\n  title: Tenant Session Gateway\n  version: 1.0.0\n' +
        'paths:\n  /internal/tenant-session/{tenantId}:\n    get:\n      operationId: proxyTenantSession\n' +
        '      x-upstream-operation: getTenantSession\n      responses:\n        "200":\n          description: Session\n',
      'package.json': `${JSON.stringify(
        {dependencies: {[PRODUCER_PACKAGE]: '1.0.0'}, name: PACKAGE_NAME_TOKEN, private: true, version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'src/gateway.ts':
        'export async function fetchTenantSession(baseUrl: string, tenantId: string): Promise<unknown> {\n' +
        '  return fetch(`${baseUrl}/v1/tenant-sessions/${tenantId}`).then(response => response.json());\n' +
        '}\n',
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'openapi-http-consumer',
    tags: ['consumer', 'http', 'openapi', 'package-dependency'],
  },
  {
    description: 'Message consumer bound to the producer event topic.',
    files: {
      'README.md': '# Tenant session event worker\n\nConsumes TenantSessionChanged from tenant.session.changed.\n',
      'asyncapi.yaml':
        'asyncapi: 2.6.0\n' +
        'info:\n  title: Tenant session projection worker\n  version: 1.0.0\n' +
        'channels:\n  tenant.session.changed:\n    subscribe:\n      message:\n        name: TenantSessionChanged\n',
      'package.json': `${JSON.stringify(
        {dependencies: {[PRODUCER_PACKAGE]: '1.0.0'}, name: PACKAGE_NAME_TOKEN, private: true, version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'src/worker.ts':
        "export const subscribedTopic = 'tenant.session.changed';\n" +
        'export interface TenantSessionChanged { sessionId: string; tenantId: string }\n' +
        'export const projectSession = (event: TenantSessionChanged) => `${event.tenantId}:${event.sessionId}`;\n',
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'message-consumer',
    tags: ['consumer', 'message', 'package-dependency'],
  },
  {
    description: 'Same-name distractor with no package or contract relationship.',
    files: {
      'README.md':
        '# Unrelated browser preference fixture\n\n' +
        'This repository deliberately uses a colliding function name for a local display preference.\n',
      'package.json': `${JSON.stringify(
        {name: PACKAGE_NAME_TOKEN, private: true, type: 'module', version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'src/preferences.ts':
        'export function resolveTenantSession(theme: string): string {\n' +
        '  return `local-preview-${theme}`;\n' +
        '}\n',
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'same-name-distractor',
    tags: ['distractor', 'same-name'],
  },
  {
    description: 'Explicitly unrelated member used with whole-workset no-answer queries.',
    files: {
      'README.md': '# Static archive utilities\n\nContains checksum helpers for offline archive bundles.\n',
      'package.json': `${JSON.stringify(
        {name: PACKAGE_NAME_TOKEN, private: true, type: 'module', version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'src/archive.ts':
        "export const archiveChecksum = (chunks: readonly string[]) => chunks.join(':').length.toString(16);\n",
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'no-answer-member',
    tags: ['no-answer', 'unrelated'],
  },
  {
    description: 'Low-signal support repository used to scale large worksets.',
    files: {
      'README.md': '# Fixture support package\n\nProvides a deterministic health marker for PROJECT_NAME.\n',
      'package.json': `${JSON.stringify(
        {name: PACKAGE_NAME_TOKEN, private: true, type: 'module', version: '1.0.0'},
        undefined,
        2,
      )}\n`,
      'src/health.ts':
        `/** Deterministic repository marker ${REPOSITORY_KEY_TOKEN}:ready. */\n` +
        `export const ${REPOSITORY_SYMBOL_TOKEN} = '${REPOSITORY_KEY_TOKEN}:ready';\n` +
        `export const isRepositoryHealthy = () => ${REPOSITORY_SYMBOL_TOKEN}.endsWith(':ready');\n`,
      'tsconfig.json': TYPESCRIPT_CONFIG,
    },
    id: 'support',
    tags: ['support', 'unrelated'],
  },
] as const satisfies readonly FixtureArchetype[];

const CORE_ARCHETYPE_IDS = [
  'contract-producer',
  'workspace-consumer',
  'graphql-consumer',
  'protobuf-consumer',
  'openapi-http-consumer',
  'message-consumer',
  'same-name-distractor',
  'no-answer-member',
] as const;
const SCALE_ARCHETYPE_IDS = ['same-name-distractor', 'support', 'no-answer-member', 'support'] as const;
const MIXED_STATES = ['clean', 'dirty', 'missing', 'stale', 'failed', 'worktree', 'cold', 'clean'] as const;

const ARCHETYPE_BY_ID = new Map(EffectArray.map(ARCHETYPES, archetype => [archetype.id, archetype]));

export const CODE_GRAPH_WORKSET_ARCHETYPE_DIGESTS = Object.freeze(
  EffectRecord.fromEntries(EffectArray.map(ARCHETYPES, archetype => [archetype.id, digest(canonicalJson(archetype))])),
);

/** Path-independent producer metadata consumed by the versioned evaluation fixture schema. */
export const CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES: readonly CodeGraphWorksetFixtureArchetypeMetadata[] = Object.freeze(
  EffectArray.map(ARCHETYPES, archetype => ({
    description: archetype.description,
    id: archetype.id,
    sha256: CODE_GRAPH_WORKSET_ARCHETYPE_DIGESTS[archetype.id],
    tags: archetype.tags,
  })),
);

export function createCodeGraphWorksetFixturePlan(
  size: CodeGraphWorksetFixtureSize,
  options: CreateCodeGraphWorksetFixturePlanOptions = {},
): CodeGraphWorksetFixturePlan {
  assertFixtureSize(size);
  const stateProfile = options.stateProfile ?? 'all-clean';
  const worksetName = options.worksetName ?? `code-graph-workset-${size}`;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(worksetName)) {
    throw ScriptError.make({message: `Invalid code graph workset fixture name: ${worksetName}.`});
  }

  const knownRepositoryKeys = new Set(Array.from({length: size}, (_, index) => repositoryKey(index)));
  for (const [key, state] of EffectRecord.toEntries(options.repositoryStates ?? {})) {
    if (!knownRepositoryKeys.has(key)) {
      throw ScriptError.make({message: `Unknown code graph workset fixture repository: ${key}.`});
    }
    assertFixtureState(state);
  }

  const repositories = Array.from({length: size}, (_, index) => {
    const key = repositoryKey(index);
    const archetype = archetypeForIndex(index);
    const packageName = archetype.id === 'contract-producer' ? PRODUCER_PACKAGE : `@threadnote-fixture/${key}`;
    const projectName = `workset-${key}`;
    const files = EffectArray.map(
      EffectRecord.toEntries(archetype.files).sort(([left], [right]) =>
        Effect2.pipe(left, EffectString.localeCompare(right)),
      ),
      ([path, template]) => {
        const content = applyRepositoryTemplate(template, {packageName, projectName, repositoryKey: key});
        return {content, digest: digest(content), path};
      },
    );
    const state = options.repositoryStates?.[key] ?? stateForIndex(index, stateProfile);
    return {
      archetype: archetype.id,
      archetypeTags: archetype.tags,
      contentDigest: digest(canonicalJson(EffectArray.map(files, file => ({digest: file.digest, path: file.path})))),
      files,
      packageName,
      projectName,
      remoteUrl: `https://fixture.threadnote.invalid/code-graph-workset-v1/${key}.git`,
      repositoryKey: key,
      state,
    } satisfies CodeGraphWorksetFixtureRepositoryPlan;
  });
  const members = EffectArray.map(repositories, (repository, index) => evaluationMemberPlan(repository, index));
  const queries = fixtureQueries(repositories);
  const allowedAuthoritativeEdges = uniqueEdges(EffectArray.flatMap(queries, query => query.expectedEdges));
  const worksets = EffectArray.map(
    EffectArray.filter(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES, worksetSize => worksetSize <= size),
    worksetSize => ({
      description: `Deterministic ${worksetSize}-repository code graph evaluation workset`,
      name: worksetSize === size ? worksetName : `code-graph-workset-${worksetSize}`,
      repositoryKeys: EffectArray.map(repositories.slice(0, worksetSize), repository => repository.repositoryKey),
      size: worksetSize,
    }),
  );
  const usedArchetypes = [...new Set(EffectArray.map(repositories, repository => repository.archetype))].sort();
  const archetypeDigests = EffectRecord.fromEntries(
    EffectArray.map(usedArchetypes, id => [id, CODE_GRAPH_WORKSET_ARCHETYPE_DIGESTS[id]]),
  );
  const membershipDigest = digest(canonicalJson(EffectArray.map(repositories, repository => repository.repositoryKey)));
  const querySpecificationDigest = digest(canonicalJson(queries));
  const identitySeed = {
    archetypeDigests,
    generator: 'threadnote-code-graph-workset-fixture',
    generatorVersion: CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION,
    membershipDigest,
    querySpecificationDigest,
    repositories: EffectArray.map(repositories, repository => ({
      archetype: repository.archetype,
      contentDigest: repository.contentDigest,
      projectName: repository.projectName,
      remoteUrl: repository.remoteUrl,
      repositoryKey: repository.repositoryKey,
      state: repository.state,
    })),
    repositoryCount: size,
    stateProfile,
    worksetName,
    worksets,
  };
  const identity = {
    archetypeDigests,
    generator: 'threadnote-code-graph-workset-fixture',
    generatorVersion: CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION,
    id: `cgwf_${Effect2.pipe(digest(canonicalJson(identitySeed)), EffectString.slice(0, 32))}`,
    membershipDigest,
    querySpecificationDigest,
    repositoryCount: size,
    stateProfile,
    worksetName,
  } as const satisfies CodeGraphWorksetFixtureIdentity;

  return {
    allowedAuthoritativeEdges,
    identity,
    members,
    queries,
    repositories,
    version: 1,
    workset: {
      description: `Deterministic ${size}-repository code graph evaluation workset`,
      name: worksetName,
    },
    worksets,
  };
}

export async function prepareCodeGraphWorksetFixture(
  options: PrepareCodeGraphWorksetFixtureOptions,
): Promise<PreparedCodeGraphWorksetFixture> {
  const plan = createCodeGraphWorksetFixturePlan(options.size, options);
  const root = options.root
    ? resolve(options.root)
    : await makeTempDirectory(`threadnote-code-graph-workset-${options.size}-`);
  try {
    return await materializeCodeGraphWorksetFixture(root, plan, {concurrency: options.concurrency});
  } catch (error) {
    if (!options.root) {
      await rm(root, {force: true, recursive: true});
    }
    throw error;
  }
}

export async function materializeCodeGraphWorksetFixture(
  requestedRoot: string,
  plan: CodeGraphWorksetFixturePlan,
  options: MaterializeCodeGraphWorksetFixtureOptions = {},
): Promise<PreparedCodeGraphWorksetFixture> {
  const root = resolve(requestedRoot);
  await mkdir(root, {recursive: true, mode: 0o700});
  const existingEntries = await readdir(root);
  if (existingEntries.length > 0) {
    throw ScriptError.make({message: `Code graph workset fixture root must be empty: ${root}.`});
  }
  const concurrency = options.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw ScriptError.make({message: 'Code graph workset fixture concurrency must be an integer from 1 through 32.'});
  }

  const home = join(root, 'home');
  const repositoriesRoot = join(root, 'repositories');
  const worktreesRoot = join(root, 'worktrees');
  const manifestPath = join(root, 'seed-manifest.yaml');
  const metadataPath = join(root, 'fixture-identity.json');
  const isolatedGitConfig = join(root, 'empty-global-gitconfig');
  await Promise.all([
    mkdir(home, {recursive: true, mode: 0o700}),
    mkdir(repositoriesRoot, {recursive: true}),
    mkdir(worktreesRoot, {recursive: true}),
    writeFile(isolatedGitConfig, '', {encoding: 'utf8', mode: 0o600}),
  ]);

  const repositories = await mapConcurrent(plan.repositories, concurrency, repository =>
    materializeRepository(repository, {isolatedGitConfig, repositoriesRoot, worktreesRoot}),
  );
  await writeFile(manifestPath, renderSeedManifest(plan, repositoriesRoot), 'utf8');
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        allowedAuthoritativeEdges: plan.allowedAuthoritativeEdges,
        identity: plan.identity,
        members: plan.members,
        queries: plan.queries,
        repositories: EffectArray.map(repositories, repository => ({
          ...repository,
          path: relative(root, repository.path),
          siblingWorktreePath: repository.siblingWorktreePath
            ? relative(root, repository.siblingWorktreePath)
            : undefined,
        })),
        version: 1,
        workset: plan.workset,
        worksets: plan.worksets,
      },
      undefined,
      2,
    )}\n`,
    {encoding: 'utf8', mode: 0o600},
  );

  return {home, identity: plan.identity, manifestPath, metadataPath, plan, repositories, repositoriesRoot, root};
}

export async function removePreparedCodeGraphWorksetFixture(fixture: PreparedCodeGraphWorksetFixture): Promise<void> {
  await rm(fixture.root, {force: true, recursive: true});
}

/**
 * Runs the caller's snapshot build at the stale member's reviewed commit, then restores the fixture's newer `main`.
 * The resulting ready snapshot is therefore stale relative to the repository HEAD without the generator importing or
 * invoking Threadnote's indexer.
 */
export async function establishCodeGraphWorksetStaleReadySnapshot<Result>(
  repository: MaterializedCodeGraphWorksetFixtureRepository,
  buildReadySnapshot: (repositoryPath: string) => Promise<Result>,
): Promise<Result> {
  if (repository.state !== 'stale' || !repository.readyCommit || !repository.headCommit) {
    throw ScriptError.make({
      message: `Repository ${repository.repositoryKey} is not a materialized stale fixture member.`,
    });
  }
  await fixtureCheckout(repository.path, [
    '-c',
    'advice.detachedHead=false',
    'checkout',
    '-q',
    '--detach',
    repository.readyCommit,
  ]);
  try {
    return await buildReadySnapshot(repository.path);
  } finally {
    await fixtureCheckout(repository.path, ['checkout', '-q', 'main']);
  }
}

function archetypeForIndex(index: number): FixtureArchetype {
  const id =
    index < CORE_ARCHETYPE_IDS.length
      ? CORE_ARCHETYPE_IDS[index]
      : SCALE_ARCHETYPE_IDS[(index - CORE_ARCHETYPE_IDS.length) % SCALE_ARCHETYPE_IDS.length];
  const archetype = id ? ARCHETYPE_BY_ID.get(id) : undefined;
  if (!archetype) {
    throw ScriptError.make({message: `Missing code graph workset fixture archetype for repository ${index}.`});
  }
  return archetype;
}

function stateForIndex(index: number, profile: CodeGraphWorksetFixtureStateProfile): CodeGraphWorksetFixtureState {
  return profile === 'mixed' ? (MIXED_STATES[index % MIXED_STATES.length] ?? 'clean') : 'clean';
}

function evaluationMemberPlan(
  repository: CodeGraphWorksetFixtureRepositoryPlan,
  index: number,
): CodeGraphWorksetFixtureMemberPlan {
  const expectedState =
    repository.state === 'failed'
      ? 'failed'
      : repository.state === 'missing'
        ? 'missing'
        : repository.state === 'stale'
          ? 'stale'
          : repository.state === 'cold'
            ? 'deferred'
            : 'current';
  return {
    archetypeId: repository.archetype,
    expectedState,
    id: repository.repositoryKey,
    ordinal: index + 1,
    worktree: {
      state: repository.state === 'dirty' ? 'dirty' : 'clean',
    },
  };
}

function fixtureQueries(
  repositories: readonly CodeGraphWorksetFixtureRepositoryPlan[],
): readonly CodeGraphWorksetFixtureQuery[] {
  const keys = (...archetypes: readonly string[]) =>
    EffectArray.map(
      EffectArray.filter(
        repositories,
        (repository, __effectArrayIndex) =>
          __effectArrayIndex in repositories && archetypes.includes(repository.archetype),
      ),
      repository => repository.repositoryKey,
    );
  const producer = keys('contract-producer');
  const workspaceConsumer = keys('workspace-consumer');
  const distractors = keys('same-name-distractor');
  const graphqlConsumer = keys('graphql-consumer');
  const protobufConsumer = keys('protobuf-consumer');
  const httpConsumer = keys('openapi-http-consumer');
  const messageConsumer = keys('message-consumer');
  const allSizes = EffectArray.filter(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES, size => size <= repositories.length);
  const sizesFor = (repositoryKeys: readonly string[]) =>
    EffectArray.filter(allSizes, size =>
      EffectArray.every(
        repositoryKeys,
        key => Number.parseInt(Effect2.pipe(key, EffectString.slice('repo-'.length)), 10) < size,
      ),
    );
  const ref = (repositoryId: string, symbol: string): CodeGraphWorksetFixtureSymbolExpectation => ({
    repositoryId,
    symbol,
  });
  const producerResolver = producer[0] ? ref(producer[0], 'src/session.ts#resolveTenantSession') : undefined;
  const consumerCaller = workspaceConsumer[0]
    ? ref(workspaceConsumer[0], 'packages/session-client/src/client.ts#loadSession')
    : undefined;
  const protobufProducerFile = producer[0]
    ? ref(producer[0], 'threadnote/session/v1/session.proto#session.proto')
    : undefined;
  const protobufConsumerImport = protobufConsumer[0]
    ? ref(protobufConsumer[0], 'proto/session_client.proto#session.proto')
    : undefined;
  const dependencyEdge =
    producerResolver && consumerCaller
      ? ({
          provenance: 'declared',
          relation: 'imports',
          source: consumerCaller,
          target: producerResolver,
        } satisfies CodeGraphWorksetFixtureEdgeExpectation)
      : undefined;
  const callerEdge =
    producerResolver && consumerCaller
      ? ({
          provenance: 'resolved',
          relation: 'calls',
          source: consumerCaller,
          target: producerResolver,
        } satisfies CodeGraphWorksetFixtureEdgeExpectation)
      : undefined;
  const protobufBridgeEdge =
    protobufProducerFile && protobufConsumerImport
      ? ({
          provenance: 'declared',
          relation: 'imports',
          source: protobufConsumerImport,
          target: protobufProducerFile,
        } satisfies CodeGraphWorksetFixtureEdgeExpectation)
      : undefined;
  const makeQuery = (
    category: CodeGraphWorksetFixtureQueryCategory,
    id: string,
    text: string,
    relevantRepositoryKeys: readonly string[],
    expectedSymbols: readonly CodeGraphWorksetFixtureSymbolExpectation[],
    expectedEdges: readonly CodeGraphWorksetFixtureEdgeExpectation[] = [],
    queryDistractors: readonly string[] = [],
  ): CodeGraphWorksetFixtureQuery => ({
    answerable: true,
    category,
    distractorRepositoryKeys: queryDistractors,
    expectedEdges,
    expectedRepositories: relevantRepositoryKeys,
    expectedSymbols,
    id,
    operation: category === 'impact' ? 'impact' : category === 'path' ? 'path' : 'query',
    query: text,
    relevantRepositoryKeys,
    sizes: sizesFor(relevantRepositoryKeys),
    text,
  });
  const queries: CodeGraphWorksetFixtureQuery[] = [
    makeQuery(
      'symbol',
      'symbol-resolve-tenant-session',
      'resolveTenantSession',
      producer,
      producerResolver ? [producerResolver] : [],
      [],
      distractors,
    ),
    makeQuery(
      'symbol',
      'qualified-session-resolver',
      'session.ts#resolveTenantSession',
      producer,
      producerResolver ? [producerResolver] : [],
      [],
      distractors,
    ),
    makeQuery(
      'package',
      'package-session-contract',
      PRODUCER_PACKAGE,
      [...producer, ...workspaceConsumer],
      [
        ...EffectArray.map(producer, key => ref(key, `package.json#${PRODUCER_PACKAGE}`)),
        ...EffectArray.map(workspaceConsumer, key =>
          ref(key, 'packages/session-client/package.json#@threadnote-fixture/session-client'),
        ),
      ],
      dependencyEdge ? [dependencyEdge] : [],
    ),
    makeQuery(
      'schema',
      'graphql-tenant-session',
      'TenantSessionByTenant TenantSession tenantSession',
      [...producer, ...graphqlConsumer],
      [
        ...EffectArray.map(producer, key => ref(key, 'contracts/schema.graphql#TenantSession')),
        ...EffectArray.map(graphqlConsumer, key => ref(key, 'src/session-query.ts#tenantSessionOperation')),
      ],
    ),
    makeQuery(
      'schema',
      'protobuf-session-directory',
      'threadnote.session.v1.SessionDirectory ResolveTenantSession',
      [...producer, ...protobufConsumer],
      [
        ...EffectArray.map(producer, key => ref(key, 'threadnote/session/v1/session.proto#SessionDirectory')),
        ...EffectArray.map(protobufConsumer, key => ref(key, 'proto/session_client.proto#SessionLookup')),
      ],
      protobufBridgeEdge ? [protobufBridgeEdge] : [],
    ),
    makeQuery(
      'schema',
      'openapi-tenant-session',
      'getTenantSession /v1/tenant-sessions/{tenantId}',
      [...producer, ...httpConsumer],
      [
        ...EffectArray.map(producer, key => ref(key, 'contracts/openapi.yaml#/v1/tenant-sessions/{tenantId}')),
        ...EffectArray.map(httpConsumer, key => ref(key, 'openapi/session-gateway.yaml#proxyTenantSession')),
      ],
    ),
    makeQuery(
      'schema',
      'message-tenant-session-changed',
      'TenantSessionChanged tenant.session.changed',
      [...producer, ...messageConsumer],
      [
        ...EffectArray.map(producer, key => ref(key, 'contracts/messages.asyncapi.yaml#tenant.session.changed')),
        ...EffectArray.map(messageConsumer, key => ref(key, 'src/worker.ts#TenantSessionChanged')),
      ],
    ),
    makeQuery(
      'concept',
      'concept-session-contract-owner',
      'where is tenant session resolution and its API contract owned?',
      producer,
      producerResolver ? [producerResolver] : [],
    ),
  ];
  // Every large prefix contains a unique relevant symbol near its tail. These
  // queries make manifest-prefix admission and fixed repository caps visible
  // in the baseline instead of letting an always-first producer mask the
  // cross-repository routing gap.
  for (const targetSize of [32, 50, 64, 128] as const) {
    const target = repositories[targetSize - 1];
    if (!target) continue;
    if (target.archetype !== 'support') {
      throw ScriptError.make({
        message: `Scale-tail fixture repository ${target.repositoryKey} must use the support archetype.`,
      });
    }
    const markerSymbol = repositoryMarkerSymbol(target.repositoryKey);
    queries.push(
      makeQuery(
        'symbol',
        `tail-repository-marker-${targetSize}`,
        `${markerSymbol} ${target.repositoryKey}:ready`,
        [target.repositoryKey],
        [ref(target.repositoryKey, `src/health.ts#${markerSymbol}`)],
      ),
    );
  }
  if (producerResolver && consumerCaller && dependencyEdge && callerEdge) {
    queries.push(
      makeQuery(
        'imports',
        'imports-session-contract',
        'imports of resolveTenantSession from @threadnote-fixture/session-contract',
        [...producer, ...workspaceConsumer],
        [producerResolver, consumerCaller],
        [dependencyEdge],
        distractors,
      ),
      makeQuery(
        'callers',
        'callers-session-resolver',
        'callers of resolveTenantSession from @threadnote-fixture/session-contract',
        [...producer, ...workspaceConsumer],
        [producerResolver, consumerCaller],
        [callerEdge],
        distractors,
      ),
      makeQuery(
        'impact',
        'impact-session-contract',
        'impact of changing resolveTenantSession',
        [...producer, ...workspaceConsumer],
        [producerResolver, consumerCaller],
        [callerEdge],
        distractors,
      ),
      makeQuery(
        'path',
        'path-bootstrap-to-session',
        'path from loadSession to resolveTenantSession',
        [...producer, ...workspaceConsumer],
        [producerResolver, consumerCaller],
        [callerEdge],
        distractors,
      ),
    );
  }
  queries.push({
    answerable: false,
    category: 'no-answer',
    distractorRepositoryKeys: [],
    expectedEdges: [],
    expectedRepositories: [],
    expectedSymbols: [],
    id: 'no-answer-quantum-marzipan',
    operation: 'query',
    query: 'quantumMarzipanLeaseCoordinator',
    relevantRepositoryKeys: [],
    sizes: allSizes,
    text: 'quantumMarzipanLeaseCoordinator',
  });
  const minimumMembersByQuery = new Map<string, number>([
    ['package-session-contract', 2],
    ['graphql-tenant-session', 3],
    ['protobuf-session-directory', 4],
    ['openapi-tenant-session', 5],
    ['message-tenant-session-changed', 6],
    ['imports-session-contract', 2],
    ['callers-session-resolver', 2],
    ['impact-session-contract', 2],
    ['path-bootstrap-to-session', 2],
  ]);
  return EffectArray.filter(queries, query => repositories.length >= (minimumMembersByQuery.get(query.id) ?? 1));
}

function uniqueEdges(
  edges: readonly CodeGraphWorksetFixtureEdgeExpectation[],
): readonly CodeGraphWorksetFixtureEdgeExpectation[] {
  const seen = new Set<string>();
  return EffectArray.filter(edges, edge => {
    const key = canonicalJson(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function materializeRepository(
  repository: CodeGraphWorksetFixtureRepositoryPlan,
  paths: {readonly isolatedGitConfig: string; readonly repositoriesRoot: string; readonly worktreesRoot: string},
): Promise<MaterializedCodeGraphWorksetFixtureRepository> {
  const repositoryPath = join(paths.repositoriesRoot, repository.repositoryKey);
  const base = {
    archetype: repository.archetype,
    contentDigest: repository.contentDigest,
    path: repositoryPath,
    projectName: repository.projectName,
    remoteUrl: repository.remoteUrl,
    repositoryKey: repository.repositoryKey,
    state: repository.state,
  } as const;
  if (repository.state === 'missing') {
    return {...base, exists: false};
  }

  await writeRepositoryFiles(repositoryPath, repository.files);
  if (repository.state === 'failed') {
    await writeFile(
      join(repositoryPath, '.threadnote-fixture-failure.json'),
      `${JSON.stringify({expected: 'repository-open-failure', repositoryKey: repository.repositoryKey, version: 1})}\n`,
      'utf8',
    );
    return {...base, exists: true};
  }

  const gitEnvironment = gitEnvironmentFor(paths.isolatedGitConfig, repository.repositoryKey, 0);
  await runGit(repositoryPath, ['-c', 'init.defaultBranch=main', 'init', '-q'], gitEnvironment);
  await runGit(repositoryPath, ['remote', 'add', 'origin', repository.remoteUrl], gitEnvironment);
  await runGit(repositoryPath, ['add', '--all'], gitEnvironment);
  await commit(repositoryPath, `fixture ${repository.repositoryKey}`, gitEnvironment);
  const readyCommit = await gitHead(repositoryPath, gitEnvironment);

  if (repository.state === 'dirty') {
    await appendFile(
      join(repositoryPath, 'README.md'),
      `\nDirty worktree marker for ${repository.repositoryKey}; this line is intentionally uncommitted.\n`,
      'utf8',
    );
    await mkdir(join(repositoryPath, 'src'), {recursive: true});
    await writeFile(
      join(repositoryPath, 'src', 'dirty-only.ts'),
      `export const dirtyOnlySymbol = '${repository.repositoryKey}:dirty';\n`,
      'utf8',
    );
    return {...base, exists: true, headCommit: readyCommit, readyCommit};
  }

  if (repository.state === 'stale') {
    await writeFile(
      join(repositoryPath, 'src', 'stale-revision.ts'),
      `export const staleReadySuccessor = '${repository.repositoryKey}:head-after-ready';\n`,
      'utf8',
    );
    const nextEnvironment = gitEnvironmentFor(paths.isolatedGitConfig, repository.repositoryKey, 1);
    await runGit(repositoryPath, ['add', '--all'], nextEnvironment);
    await commit(repositoryPath, `advance ${repository.repositoryKey} after ready snapshot`, nextEnvironment);
    return {...base, exists: true, headCommit: await gitHead(repositoryPath, nextEnvironment), readyCommit};
  }

  if (repository.state === 'worktree') {
    const siblingWorktreePath = join(paths.worktreesRoot, `${repository.repositoryKey}-sibling`);
    await runGit(
      repositoryPath,
      ['worktree', 'add', '-q', '-b', `fixture-sibling-${repository.repositoryKey}`, siblingWorktreePath, 'HEAD'],
      gitEnvironment,
    );
    await writeFile(
      join(siblingWorktreePath, 'src', 'worktree-only.ts'),
      `export const siblingOnlySymbol = '${repository.repositoryKey}:sibling-worktree';\n`,
      'utf8',
    );
    return {...base, exists: true, headCommit: readyCommit, readyCommit, siblingWorktreePath};
  }

  return {...base, exists: true, headCommit: readyCommit, readyCommit};
}

async function writeRepositoryFiles(root: string, files: readonly CodeGraphWorksetFixtureFile[]): Promise<void> {
  await mkdir(root, {recursive: true});
  for (const file of files) {
    if (
      Effect2.pipe(file.path, EffectString.startsWith('/')) ||
      Effect2.pipe(file.path, EffectString.split('/')).includes('..')
    ) {
      throw ScriptError.make({message: `Unsafe code graph workset fixture path: ${file.path}.`});
    }
    const target = join(root, file.path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, file.content, 'utf8');
  }
}

function renderSeedManifest(plan: CodeGraphWorksetFixturePlan, repositoriesRoot: string): string {
  const projects = EffectArray.join(
    EffectArray.map(
      plan.repositories,
      repository =>
        `  - name: ${repository.projectName}\n` +
        `    path: ${JSON.stringify(join(repositoriesRoot, repository.repositoryKey))}\n` +
        `    uri: threadnote://resources/repos/${repository.projectName}\n` +
        '    seed:\n' +
        '      - README.md\n' +
        '      - package.json\n',
    ),
    '',
  );
  const projectByKey = new Map(
    EffectArray.map(plan.repositories, repository => [repository.repositoryKey, repository.projectName]),
  );
  const worksets = EffectArray.join(
    EffectArray.map(plan.worksets, workset => {
      const members = EffectArray.join(
        EffectArray.map(workset.repositoryKeys, key => {
          const project = projectByKey.get(key);
          if (!project) {
            throw ScriptError.make({message: `Workset ${workset.name} references unknown fixture repository ${key}.`});
          }
          return `      - ${project}\n`;
        }),
        '',
      );
      return (
        `  - name: ${workset.name}\n` +
        `    description: ${JSON.stringify(workset.description)}\n` +
        '    projects:\n' +
        members
      );
    }),
    '',
  );
  return 'version: 1\n' + 'projects:\n' + projects + 'worksets:\n' + worksets;
}

async function commit(repositoryPath: string, message: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await runGit(
    repositoryPath,
    [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message,
    ],
    environment,
  );
}

async function gitHead(repositoryPath: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGit(repositoryPath, ['rev-parse', 'HEAD'], environment);
  return Effect2.pipe(result.stdout, EffectString.trim);
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{readonly stderr: string; readonly stdout: string}> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 16 * 1_048_576,
    windowsHide: true,
  });
  return {stderr: result.stderr, stdout: result.stdout};
}

function gitEnvironmentFor(isolatedGitConfig: string, key: string, revision: number): NodeJS.ProcessEnv {
  const repositoryIndex = Number.parseInt(Effect2.pipe(key, EffectString.slice('repo-'.length)), 10);
  const timestamp = new Date((FIXED_GIT_EPOCH_SECONDS + repositoryIndex * 4 + revision) * 1_000).toISOString();
  return {
    ...process.env,
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
    GIT_CONFIG_GLOBAL: isolatedGitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from({length: Math.min(concurrency, Math.max(1, inputs.length))}, async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input !== undefined) {
        output[index] = await operation(input);
      }
    }
  });
  await Promise.all(workers);
  return output;
}

function applyRepositoryTemplate(
  template: string,
  values: {readonly packageName: string; readonly projectName: string; readonly repositoryKey: string},
): string {
  return Effect2.pipe(template, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(
      __effectPipeInput,
      EffectString.replaceAll(REPOSITORY_KEY_TOKEN, values.repositoryKey),
    );
    const __effectPipeStage1 = Effect2.pipe(
      __effectPipeStage0,
      EffectString.replaceAll(REPOSITORY_SYMBOL_TOKEN, repositoryMarkerSymbol(values.repositoryKey)),
    );
    const __effectPipeStage2 = Effect2.pipe(
      __effectPipeStage1,
      EffectString.replaceAll(PROJECT_NAME_TOKEN, values.projectName),
    );
    const __effectPipeStage3 = Effect2.pipe(
      __effectPipeStage2,
      EffectString.replaceAll(PACKAGE_NAME_TOKEN, values.packageName),
    );
    return __effectPipeStage3;
  });
}

function repositoryMarkerSymbol(key: string): string {
  const suffix = EffectArray.join(
    EffectArray.map(
      Effect2.pipe(key, EffectString.split('-')),
      segment =>
        `${Effect2.pipe(segment, EffectString.slice(0, 1), EffectString.toUpperCase)}${Effect2.pipe(segment, EffectString.slice(1))}`,
    ),
    '',
  );
  return `repositoryHealthMarker${suffix}`;
}

function repositoryKey(index: number): string {
  return `repo-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`;
}

function assertFixtureSize(size: number): asserts size is CodeGraphWorksetFixtureSize {
  if (!(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES as readonly number[]).includes(size)) {
    throw ScriptError.make({message: `Unsupported code graph workset fixture size: ${size}.`});
  }
}

function assertFixtureState(state: string): asserts state is CodeGraphWorksetFixtureState {
  if (!['clean', 'cold', 'dirty', 'failed', 'missing', 'stale', 'worktree'].includes(state)) {
    throw ScriptError.make({message: `Unsupported code graph workset fixture state: ${state}.`});
  }
}

function digest(value: string): string {
  return sha256HexSync(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (EffectArray.isArray(value)) {
    return EffectArray.map(value, canonicalValue);
  }
  if (value !== null && typeof value === 'object') {
    return EffectRecord.fromEntries(
      EffectArray.map(
        EffectRecord.toEntries(value).sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right))),
        ([key, nested]) => [key, canonicalValue(nested)],
      ),
    );
  }
  return value;
}

// Kept as small exported probes for downstream evaluation harnesses that validate state setup without indexing.
export async function readCodeGraphWorksetFixtureFile(
  fixture: PreparedCodeGraphWorksetFixture,
  repositoryKey: string,
  path: string,
): Promise<string> {
  const repository = EffectOption.getOrUndefined(
    EffectArray.findFirst(fixture.repositories, candidate => candidate.repositoryKey === repositoryKey),
  );
  if (!repository?.exists) {
    throw ScriptError.make({message: `Code graph workset fixture repository is unavailable: ${repositoryKey}.`});
  }
  return readFile(join(repository.path, path), 'utf8');
}

export async function codeGraphWorksetFixturePathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function fixtureCheckout(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'},
    maxBuffer: 16 * 1_048_576,
    windowsHide: true,
  });
}

interface FixtureCommandOptions {
  readonly cwd?: string;
  readonly encoding?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
  readonly windowsHide?: boolean;
}

async function execFileAsync(
  executable: string,
  args: readonly string[],
  options: FixtureCommandOptions = {},
): Promise<{readonly stderr: string; readonly stdout: string}> {
  const subprocess = Bun.spawn({
    cmd: [executable, ...args],
    ...(options.cwd === undefined ? {} : {cwd: options.cwd}),
    ...(options.env === undefined ? {} : {env: options.env}),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
    new Response(subprocess.stdout).text(),
  ]);
  const maximumOutputBytes = options.maxBuffer;
  if (
    maximumOutputBytes !== undefined &&
    Buffer.byteLength(stderr, 'utf8') + Buffer.byteLength(stdout, 'utf8') > maximumOutputBytes
  ) {
    throw ScriptError.make({message: `Command output exceeded ${maximumOutputBytes} bytes: ${executable}.`});
  }
  if (exitCode !== 0) {
    throw ScriptError.make({
      message: Effect2.pipe(stderr, EffectString.trim) || `${executable} exited with status ${exitCode}.`,
    });
  }
  return {stderr, stdout};
}

function access(path: string): Promise<void> {
  return runFileSystem(fileSystem.access(path));
}

function appendFile(path: string, data: string, _encoding?: string): Promise<void> {
  return runFileSystem(fileSystem.writeFileString(path, data, {flag: 'a'}));
}

function makeTempDirectory(prefix: string): Promise<string> {
  return runFileSystem(fileSystem.makeTempDirectory({prefix}));
}

function mkdir(path: string, options: {readonly mode?: number; readonly recursive?: boolean} = {}): Promise<void> {
  return runFileSystem(fileSystem.makeDirectory(path, options));
}

function readFile(path: string, encoding?: string): Promise<string> {
  return runFileSystem(fileSystem.readFileString(path, encoding));
}

function readdir(path: string): Promise<readonly string[]> {
  return runFileSystem(fileSystem.readDirectory(path));
}

function rm(path: string, options: {readonly force?: boolean; readonly recursive?: boolean} = {}): Promise<void> {
  return runFileSystem(fileSystem.remove(path, options));
}

function writeFile(
  path: string,
  data: string,
  options: string | {readonly encoding?: string; readonly mode?: number} = {},
): Promise<void> {
  const mode = typeof options === 'string' ? undefined : options.mode;
  return runFileSystem(fileSystem.writeFileString(path, data, mode === undefined ? undefined : {mode}));
}

function runFileSystem<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}
