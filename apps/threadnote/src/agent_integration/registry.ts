import {Effect, FileSystem, Path, Predicate, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {parseMcpToolset, type McpToolset} from '../mcp/toolset.js';
import type {AgentClient, ClaudeMcpScope} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ensureDirectory, readFileIfExists} from '../utils.js';
import {errorMessage} from '@threadnote/platform/errors';

export const AGENT_INTEGRATION_REGISTRY_VERSION = 2;
export const AGENT_INTEGRATION_ARTIFACT_VERSION = 1;
export const AGENT_CLIENTS = ['codex', 'claude', 'cursor', 'copilot', 'omp'] as const;

const AGENT_INTEGRATION_REGISTRY_PATH = 'integrations/agents.json';
const AGENT_INTEGRATION_LOCK_PATH = 'locks/agent-integrations.lock';
const AGENT_INTEGRATION_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;

export interface AgentIntegrationMcpReceipt {
  readonly artifactProfile?: 'codex-cloud-personal' | 'cursor-cloud-personal' | 'default';
  readonly cwd?: string;
  readonly external?: boolean;
  readonly hostRoot?: string;
  readonly name: string;
  readonly repair: boolean;
  readonly scope?: ClaudeMcpScope;
  readonly toolset?: McpToolset;
  readonly transport?: 'cli';
}

export interface AgentIntegrationHostReceipt {
  readonly artifactVersion: typeof AGENT_INTEGRATION_ARTIFACT_VERSION;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly installedVersion: string;
  readonly mcp: AgentIntegrationMcpReceipt;
  readonly status: 'current' | 'pending';
}

export interface AgentIntegrationRegistry {
  readonly hosts: Partial<Record<AgentClient, AgentIntegrationHostReceipt>>;
  readonly surfaces?: Readonly<Record<string, AgentSurfaceReceipt>>;
  readonly physicalArtifacts?: Readonly<Record<string, readonly string[]>>;
  readonly legacyInstructionsMigrated: boolean;
  readonly version: typeof AGENT_INTEGRATION_REGISTRY_VERSION;
}

export interface AgentSurfaceReceipt {
  readonly adapterVersion: 1;
  readonly surfaceId: string;
  readonly agentId: string;
  readonly root: string;
  readonly skillRoot: string;
  readonly scope?: 'user' | 'project' | 'local';
  readonly cwd?: string;
  readonly installedVersion: string;
  readonly status: 'pending' | 'current';
  readonly artifacts: Readonly<Record<string, string>>;
  readonly artifactDescriptors: readonly AgentSurfaceArtifactReceipt[];
  readonly strategy: {
    readonly kind: 'json';
    readonly codec: 'json' | 'jsonc';
    readonly container: string;
  };
  readonly mcp: {
    readonly root?: string;
    readonly path: string;
    readonly name: string;
    readonly hash: string;
    readonly toolset: McpToolset;
    readonly createdContainer: boolean;
    readonly createdFile: boolean;
  };
}

export interface AgentSurfaceArtifactReceipt {
  readonly hash: string;
  readonly kind: 'block' | 'file';
  readonly name: string;
  readonly path: string;
}

export interface AgentSetupCompletion {
  readonly _tag: 'AgentSetupCompletion';
  readonly supportedAgentReuse: boolean;
}

type RegistrationStatus = 'current' | 'pending' | undefined;

export function setupCompletionForRegistrationStates(
  targetStatus: RegistrationStatus,
  otherStatuses: readonly RegistrationStatus[],
): AgentSetupCompletion | undefined {
  return targetStatus === 'current'
    ? undefined
    : {_tag: 'AgentSetupCompletion', supportedAgentReuse: otherStatuses.includes('current')};
}

export function setupCompletionForSuccessfulInstall(
  registry: AgentIntegrationRegistry,
  target: {readonly host: AgentClient} | {readonly surface: string},
): AgentSetupCompletion | undefined {
  const targetStatus =
    'host' in target ? registry.hosts[target.host]?.status : registry.surfaces?.[target.surface]?.status;
  const otherStatuses = [
    ...Object.entries(registry.hosts)
      .filter(([id]) => !('host' in target) || id !== target.host)
      .map(([, receipt]) => receipt?.status),
    ...Object.entries(registry.surfaces ?? {})
      .filter(([id]) => !('surface' in target) || id !== target.surface)
      .map(([, receipt]) => receipt.status),
  ];
  return setupCompletionForRegistrationStates(targetStatus, otherStatuses);
}

export function isAgentSetupCompletion(value: unknown): value is AgentSetupCompletion {
  return Predicate.isObject(value) && value._tag === 'AgentSetupCompletion';
}

export function migrateAgentIntegrationRegistry(
  registry: Omit<AgentIntegrationRegistry, 'version'> & {readonly version: 1 | 2},
): AgentIntegrationRegistry {
  const physicalArtifacts: Record<string, string[]> = {};
  for (const [consumer, receipt] of [
    ...Object.entries(registry.hosts).map(([id, receipt]) => [`legacy:${id}`, receipt] as const),
    ...Object.entries(registry.surfaces ?? {}).map(([id, receipt]) => [id, receipt] as const),
  ]) {
    for (const target of Object.keys(receipt.artifacts)) (physicalArtifacts[target] ??= []).push(consumer);
  }
  for (const consumers of Object.values(physicalArtifacts)) consumers.sort();
  return {
    ...registry,
    version: AGENT_INTEGRATION_REGISTRY_VERSION,
    surfaces: registry.surfaces ?? {},
    physicalArtifacts,
  };
}

export function artifactHasOtherConsumers(
  registry: AgentIntegrationRegistry,
  target: string,
  consumer: string,
  excludedConsumers: ReadonlySet<string> = new Set(),
): boolean {
  return (migrateAgentIntegrationRegistry(registry).physicalArtifacts?.[target] ?? []).some(
    owner => owner !== consumer && !excludedConsumers.has(owner),
  );
}

class AgentIntegrationRegistryError extends Schema.TaggedError<AgentIntegrationRegistryError>()(
  'AgentIntegrationRegistryError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const readAgentIntegrationRegistry = Effect.fn('agentIntegrations.readRegistry')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const target = yield* agentIntegrationRegistryPath(config);
  const content = yield* readFileIfExists(target);
  if (content === undefined) return undefined;
  const parsed = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: cause => AgentIntegrationRegistryError.make({message: `Could not parse ${target}: ${errorMessage(cause)}`}),
  });
  if (!isAgentIntegrationRegistry(parsed)) {
    return yield* AgentIntegrationRegistryError.make({message: `${target} is not a valid agent integration registry.`});
  }
  return migrateAgentIntegrationRegistry(parsed);
});

export function registeredAgentClients(registry: AgentIntegrationRegistry | undefined): readonly AgentClient[] {
  return AGENT_CLIENTS.filter(agent => registry?.hosts[agent] !== undefined);
}

export function repairableAgentClients(registry: AgentIntegrationRegistry | undefined): readonly AgentClient[] {
  return registeredAgentClients(registry).filter(agent => registry?.hosts[agent]?.mcp.repair === true);
}

export function emptyAgentIntegrationRegistry(legacyInstructionsMigrated: boolean): AgentIntegrationRegistry {
  return {hosts: {}, legacyInstructionsMigrated, version: AGENT_INTEGRATION_REGISTRY_VERSION};
}

export function withAgentIntegrationHost(
  registry: AgentIntegrationRegistry,
  agent: AgentClient,
  receipt: AgentIntegrationHostReceipt,
): AgentIntegrationRegistry {
  return {...registry, hosts: {...registry.hosts, [agent]: receipt}};
}

export const agentIntegrationRegistryPath = Effect.fn('agentIntegrations.registryPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, AGENT_INTEGRATION_REGISTRY_PATH);
});

export const writeAgentIntegrationRegistry = Effect.fn('agentIntegrations.writeRegistry')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  registry: AgentIntegrationRegistry,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const target = yield* agentIntegrationRegistryPath(config);
  const temporary = path.join(path.dirname(target), `.agents.${system.processId}.tmp`);
  yield* ensureDirectory(path.dirname(target), false);
  yield* fs.writeFileString(temporary, `${JSON.stringify(migrateAgentIntegrationRegistry(registry), undefined, 2)}\n`, {
    mode: 0o600,
  });
  yield* fs.rename(temporary, target);
});

export function withAgentIntegrationLock<A, E, R>(
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* withExclusiveFileLock(
      fs,
      path.join(config.agentContextHome, AGENT_INTEGRATION_LOCK_PATH),
      AGENT_INTEGRATION_LOCK_OPTIONS,
      effect,
    );
  });
}

function isAgentIntegrationRegistry(value: unknown): value is AgentIntegrationRegistry {
  if (
    !Predicate.isObject(value) ||
    (value.version !== 1 && value.version !== AGENT_INTEGRATION_REGISTRY_VERSION) ||
    !Predicate.isObject(value.hosts)
  )
    return false;
  if (typeof value.legacyInstructionsMigrated !== 'boolean') return false;
  for (const [agent, receipt] of Object.entries(value.hosts)) {
    if (!isAgentClient(agent) || !isHostReceipt(receipt)) return false;
  }
  if (value.surfaces !== undefined) {
    if (!Predicate.isObject(value.surfaces)) return false;
    for (const [id, receipt] of Object.entries(value.surfaces)) {
      if (!isSurfaceReceipt(id, receipt)) return false;
    }
  }
  return true;
}

function isSurfaceReceipt(id: string, value: unknown): value is AgentSurfaceReceipt {
  if (
    !Predicate.isObject(value) ||
    value.surfaceId !== id ||
    value.adapterVersion !== 1 ||
    typeof value.agentId !== 'string' ||
    typeof value.root !== 'string' ||
    !value.root ||
    typeof value.skillRoot !== 'string' ||
    !value.skillRoot ||
    typeof value.installedVersion !== 'string' ||
    (value.status !== 'pending' && value.status !== 'current') ||
    !Predicate.isObject(value.artifacts) ||
    !Array.isArray(value.artifactDescriptors) ||
    !Predicate.isObject(value.strategy) ||
    !Predicate.isObject(value.mcp)
  )
    return false;
  const artifacts = value.artifacts as Record<string, unknown>;
  return (
    value.strategy.kind === 'json' &&
    (value.strategy.codec === 'json' || value.strategy.codec === 'jsonc') &&
    (value.scope === undefined || value.scope === 'user' || value.scope === 'project' || value.scope === 'local') &&
    (value.cwd === undefined || (typeof value.cwd === 'string' && value.cwd.length > 0)) &&
    ((value.scope !== 'project' && value.scope !== 'local') || typeof value.cwd === 'string') &&
    typeof value.strategy.container === 'string' &&
    value.strategy.container.length > 0 &&
    typeof value.mcp.path === 'string' &&
    value.mcp.path.length > 0 &&
    (value.mcp.root === undefined || (typeof value.mcp.root === 'string' && value.mcp.root.length > 0)) &&
    typeof value.mcp.name === 'string' &&
    typeof value.mcp.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.mcp.hash) &&
    (value.mcp.toolset === 'core' || value.mcp.toolset === 'full') &&
    typeof value.mcp.createdContainer === 'boolean' &&
    typeof value.mcp.createdFile === 'boolean' &&
    Object.values(artifacts).every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) &&
    value.artifactDescriptors.every(
      artifact =>
        Predicate.isObject(artifact) &&
        typeof artifact.path === 'string' &&
        artifact.path.length > 0 &&
        typeof artifact.name === 'string' &&
        artifact.name.length > 0 &&
        (artifact.kind === 'block' || artifact.kind === 'file') &&
        typeof artifact.hash === 'string' &&
        /^[0-9a-f]{64}$/.test(artifact.hash) &&
        artifacts[artifact.path] === artifact.hash,
    )
  );
}

function isHostReceipt(value: unknown): value is AgentIntegrationHostReceipt {
  if (!Predicate.isObject(value) || !Predicate.isObject(value.mcp) || !Predicate.isObject(value.artifacts))
    return false;
  if (
    value.artifactVersion !== AGENT_INTEGRATION_ARTIFACT_VERSION ||
    typeof value.installedVersion !== 'string' ||
    (value.status !== 'current' && value.status !== 'pending') ||
    typeof value.mcp.name !== 'string' ||
    typeof value.mcp.repair !== 'boolean'
  ) {
    return false;
  }
  if (value.mcp.toolset !== undefined) {
    try {
      if (typeof value.mcp.toolset !== 'string') return false;
      parseMcpToolset(value.mcp.toolset);
    } catch {
      return false;
    }
  }
  if (
    value.mcp.artifactProfile !== undefined &&
    value.mcp.artifactProfile !== 'default' &&
    value.mcp.artifactProfile !== 'cursor-cloud-personal' &&
    value.mcp.artifactProfile !== 'codex-cloud-personal'
  ) {
    return false;
  }
  if (
    value.mcp.transport !== undefined &&
    (value.mcp.transport !== 'cli' || value.mcp.repair || value.mcp.artifactProfile !== 'codex-cloud-personal')
  )
    return false;
  if (value.mcp.external !== undefined && typeof value.mcp.external !== 'boolean') return false;
  if (value.mcp.hostRoot !== undefined && (typeof value.mcp.hostRoot !== 'string' || value.mcp.hostRoot.length === 0)) {
    return false;
  }
  if (value.mcp.repair && value.mcp.toolset === undefined) return false;
  if (
    value.mcp.scope !== undefined &&
    value.mcp.scope !== 'local' &&
    value.mcp.scope !== 'project' &&
    value.mcp.scope !== 'user'
  ) {
    return false;
  }
  if (value.mcp.cwd !== undefined && (typeof value.mcp.cwd !== 'string' || value.mcp.cwd.length === 0)) return false;
  if (
    value.mcp.repair &&
    (value.mcp.scope === 'local' || value.mcp.scope === 'project') &&
    value.mcp.cwd === undefined
  ) {
    return false;
  }
  return Object.values(value.artifacts).every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));
}

function isAgentClient(value: string): value is AgentClient {
  return AGENT_CLIENTS.some(client => client === value);
}
