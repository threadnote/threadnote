import {Console, Effect, Path, Schema} from 'effect';
import {THREADNOTE_MCP_CLIENT_ENV} from '../constants.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import type {JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {isJsonObject, readFileIfExists} from '../utils.js';
import {planAgentSurface, type SurfaceInstallOptions} from './surface_plan.js';
import type {
  AgentAdapter,
  AgentAdapterActionOptions,
  AgentAdapterDefinition,
  AgentAdapterStatusContext,
  JsonAgentStrategy,
} from './adapters/contract.js';
import {
  atomicAgentWrite,
  assertAgentTargetNotSymlink,
  extractManagedBlock,
  removeAgentTargetIfUnchanged,
  removeArtifact,
  writeArtifact,
  type AgentArtifact,
} from './index.js';
import {
  agentJsonHasComments,
  agentServerContainer,
  createdAgentContainerParents,
  sameAgentContainer,
  type AgentJsonContainer,
  jsonServerDisabled,
  mergeAgentServer,
  parseAgentJson,
  removeAgentServer,
  writeAgentServer,
} from './json_config.js';
import {
  artifactHasOtherConsumers,
  emptyAgentIntegrationRegistry,
  readAgentIntegrationRegistry,
  setupCompletionForSuccessfulInstall,
  withAgentIntegrationLock,
  writeAgentIntegrationRegistry,
  type AgentIntegrationRegistry,
  type AgentSurfaceReceipt,
} from './registry.js';

export class AgentSurfaceError extends Schema.TaggedError<AgentSurfaceError>()('AgentSurfaceError', {
  message: Schema.String,
}) {}

function attempt<A>(body: () => A) {
  return Effect.try({try: body, catch: cause => AgentSurfaceError.make({message: errorMessage(cause)})});
}

export {planAgentSurface} from './surface_plan.js';

export function installJsonAgentSurface(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: SurfaceInstallOptions = {},
) {
  const install = Effect.gen(function* () {
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    if (path.resolve(config.agentContextHome) !== path.join(system.homeDirectory, '.threadnote')) {
      return yield* AgentSurfaceError.make({
        message: 'Managed surfaces require the personal ~/.threadnote data home, including project artifact scopes.',
      });
    }
    const registry = (yield* readAgentIntegrationRegistry(config)) ?? emptyAgentIntegrationRegistry(false);
    const id = adapter.catalog.id;
    const previous = registry.surfaces?.[id];
    const setupCompletion = setupCompletionForSuccessfulInstall(registry, {surface: id});
    const plan = yield* planAgentSurface(config, adapter, options, previous);
    if (previous !== undefined && !receiptMatchesPlan(previous, plan)) {
      return yield* AgentSurfaceError.make({
        message:
          `${id} was installed with a different adapter contract. ` +
          'A versioned adapter migration is required before repair can continue.',
      });
    }
    const raw = plan.mcpContent;
    const parsed =
      raw === undefined ? plan.emptyDocument : yield* attempt(() => parseAgentJson(raw, adapter.json?.codec));
    const strategy = plan.adapter.json!;
    const container = agentServerContainer(parsed, plan.container);
    const current = isJsonObject(container) ? container[plan.name] : undefined;
    const peers = Object.values(registry.surfaces ?? {}).filter(
      receipt =>
        receipt.surfaceId !== id &&
        receipt.mcp.path === plan.mcpPath &&
        receipt.mcp.name === plan.name &&
        sameAgentContainer(receipt.strategy.container, plan.container),
    );
    if (peers.some(receipt => receipt.agentId !== adapter.catalog.agentId || receipt.mcp.toolset !== plan.toolset))
      return yield* AgentSurfaceError.make({
        message: 'Shared MCP consumers require the same agent identity and toolset.',
      });
    if (
      current !== undefined &&
      ((!previous && peers.length === 0) ||
        !isOwnedEntry(current, plan.adapter.catalog.agentId, config.agentContextHome))
    ) {
      return yield* AgentSurfaceError.make({
        message: `${plan.mcpPath} already contains an unowned ${plan.name} entry; not replacing it.`,
      });
    }
    const environmentKey = strategy.commandArray ? 'environment' : 'env';
    const currentEnvironment =
      isJsonObject(current) && isJsonObject(current[environmentKey]) ? current[environmentKey] : {};
    const entry = {
      ...(isJsonObject(current) ? current : {}),
      ...plan.entry,
      [environmentKey]: {
        ...currentEnvironment,
        ...(isJsonObject(plan.entry[environmentKey]) ? plan.entry[environmentKey] : {}),
      },
      ...(isJsonObject(current) && current.enabled === false ? {enabled: false} : {}),
      ...(isJsonObject(current) && current.disabled === true ? {disabled: true} : {}),
    };
    const next = yield* attempt(() => mergeAgentServer(parsed, plan.container, plan.name, entry));
    if (!options.apply) {
      yield* Console.log(
        `Would merge ${typeof plan.container === 'string' ? plan.container : plan.container.join('.')}.${plan.name} in ${plan.mcpPath}`,
      );
      for (const artifact of plan.artifacts) yield* Console.log(`Would install ${artifact.name}: ${artifact.path}`);
      return;
    }
    yield* assertSurfaceTargets(plan);
    const receipt: AgentSurfaceReceipt = {
      adapterVersion: plan.adapter.adapterVersion,
      surfaceId: id,
      agentId: plan.adapter.catalog.agentId,
      root: plan.root,
      skillRoot: plan.skillRoot,
      scope: plan.scope,
      cwd: plan.cwd,
      installedVersion: yield* getThreadnoteVersion(),
      status: 'pending',
      artifacts: Object.fromEntries(plan.artifacts.map(artifact => [artifact.path, artifact.hash])),
      artifactDescriptors: plan.artifacts.map(({hash, kind, name, path}) => ({hash, kind, name, path})),
      strategy: {codec: strategy.codec ?? 'json', container: plan.container, kind: 'json'},
      mcp: {
        root: plan.mcpRoot,
        path: plan.mcpPath,
        name: plan.name,
        hash: yield* sha256Hex(JSON.stringify(entry)),
        toolset: plan.toolset,
        createdContainer: previous?.mcp.createdContainer ?? peers[0]?.mcp.createdContainer ?? container === undefined,
        createdContainerParents:
          previous?.mcp.createdContainerParents ??
          peers[0]?.mcp.createdContainerParents ??
          createdAgentContainerParents(parsed, plan.container),
        createdFile: previous?.mcp.createdFile ?? peers[0]?.mcp.createdFile ?? raw === undefined,
      },
    };
    const surfaces = {...registry.surfaces, [id]: receipt};
    for (const peer of peers) surfaces[peer.surfaceId] = {...peer, mcp: {...peer.mcp, hash: receipt.mcp.hash}};
    const pending = {...registry, surfaces};
    yield* writeAgentIntegrationRegistry(config, pending);
    if (JSON.stringify(next) !== JSON.stringify(parsed))
      yield* atomicAgentWrite(
        plan.mcpPath,
        writeAgentServer(raw, strategy.codec ?? 'json', plan.container, plan.name, next),
        0o600,
        {content: raw},
      );
    for (const artifact of plan.artifacts) yield* writeArtifact(artifact);
    yield* writeAgentIntegrationRegistry(config, {
      ...pending,
      surfaces: {...pending.surfaces, [id]: {...receipt, status: 'current'}},
    });
    yield* Console.log(
      `Installed ${plan.adapter.catalog.displayName}; restart the host. Lifecycle hooks are not installed.`,
    );
    return setupCompletion;
  });
  return options.apply ? withAgentIntegrationLock(config, install) : install;
}

function isOwnedEntry(value: unknown, agentId: string, home: string): value is JsonObject {
  const environment = isJsonObject(value) ? (value.env ?? value.environment) : undefined;
  return (
    isJsonObject(value) &&
    (typeof value.command === 'string' || Array.isArray(value.command)) &&
    isJsonObject(environment) &&
    environment[THREADNOTE_MCP_CLIENT_ENV] === agentId &&
    environment.THREADNOTE_HOME === home
  );
}

export const agentSurfaceStatus = Effect.fn('agentSurfaces.status')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  context: AgentAdapterStatusContext,
) {
  const receipt = context.registry?.surfaces?.[adapter.catalog.id];
  if (!adapter.json)
    return {
      state: adapter.catalog.tier === 'manual' ? ('manual' as const) : ('unsupported' as const),
      detail: adapter.catalog.caveats.join(' '),
    };
  if (!receipt) return {state: 'absent' as const, detail: 'No managed installation receipt.'};
  if (receipt.status === 'pending')
    return {state: 'stale' as const, detail: 'Installation is incomplete; repair will retry.'};
  const plan = yield* planAgentSurface(config, adapter, {}, receipt);
  if (!receiptMatchesPlan(receipt, plan)) {
    return {state: 'stale' as const, detail: 'Installed adapter contract requires a versioned migration.'};
  }
  const raw = plan.mcpContent;
  const parsed = yield* attempt(() => parseAgentJson(raw, receipt.strategy.codec));
  if (jsonServerDisabled(parsed, receipt.strategy.container, receipt.mcp.name, adapter.json.policyGlobs))
    return {state: 'disabled' as const, detail: 'Host configuration disables the server; review host policy.'};
  const container = agentServerContainer(parsed, receipt.strategy.container);
  const entry = isJsonObject(container) ? container[receipt.mcp.name] : undefined;
  const environmentKey = adapter.json.commandArray ? 'environment' : 'env';
  if (
    !entry ||
    (yield* sha256Hex(JSON.stringify(entry))) !== receipt.mcp.hash ||
    !isJsonObject(entry) ||
    JSON.stringify(entry.command) !== JSON.stringify(plan.entry.command) ||
    JSON.stringify(entry.args) !== JSON.stringify(plan.entry.args) ||
    !isJsonObject(entry[environmentKey]) ||
    !isJsonObject(plan.entry[environmentKey]) ||
    Object.entries(plan.entry[environmentKey]).some(
      ([key, value]) => !isJsonObject(entry[environmentKey]) || entry[environmentKey][key] !== value,
    )
  ) {
    return {state: 'stale' as const, detail: 'MCP entry is missing or changed.'};
  }
  for (const artifact of plan.artifacts) {
    const current = yield* readFileIfExists(artifact.path);
    if (
      current === undefined ||
      (artifact.kind === 'file'
        ? current !== artifact.content
        : extractManagedBlock(current) !== extractManagedBlock(artifact.content)) ||
      receipt.artifacts[artifact.path] !== artifact.hash
    )
      return {state: 'stale' as const, detail: `${artifact.name} is missing or changed.`};
  }
  if (adapter.json.unverifiedPolicyFile !== undefined) {
    const path = yield* Path.Path;
    if ((yield* readFileIfExists(path.join(receipt.root, adapter.json.unverifiedPolicyFile))) !== undefined) {
      return {
        state: 'stale' as const,
        detail: 'Separate host enablement policy exists; verify server state with the host CLI.',
      };
    }
  }
  return {
    state: 'current' as const,
    detail: 'Managed files match. Host runtime, higher-precedence policy and lifecycle hooks are not verified.',
  };
});

export function removeJsonAgentSurface(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: AgentAdapterActionOptions,
) {
  const remove = Effect.gen(function* () {
    if (!adapter.json)
      return yield* AgentSurfaceError.make({message: `No managed JSON installer for ${adapter.catalog.id}.`});
    const registry = options.registry ?? (yield* readAgentIntegrationRegistry(config));
    if (!registry) return;
    return yield* removeAgentSurfaceFromRegistry(config, adapter, registry, options.apply, options.excludedConsumers);
  });
  return options.apply && !options.inTransaction ? withAgentIntegrationLock(config, remove) : remove;
}

const removeAgentSurfaceFromRegistry = Effect.fn('agentSurfaces.removeFromRegistry')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  registry: AgentIntegrationRegistry,
  apply: boolean,
  excludedConsumers: ReadonlySet<string> = new Set(),
) {
  const receipt = registry.surfaces?.[adapter.catalog.id];
  if (!receipt) return registry;
  const plan = yield* planAgentSurface(config, adapter, {}, receipt);
  if (!receiptMatchesPlan(receipt, plan))
    return yield* AgentSurfaceError.make({message: 'Installed adapter contract requires a versioned migration.'});
  if (apply) yield* assertSurfaceTargets(plan);
  const raw = plan.mcpContent;
  const parsed = yield* attempt(() => parseAgentJson(raw, receipt.strategy.codec));
  const container = agentServerContainer(parsed, receipt.strategy.container);
  const entry = isJsonObject(container) ? container[receipt.mcp.name] : undefined;
  if (
    entry !== undefined &&
    (!isOwnedEntry(entry, receipt.agentId, config.agentContextHome) ||
      (yield* sha256Hex(JSON.stringify(entry))) !== receipt.mcp.hash)
  ) {
    return yield* AgentSurfaceError.make({
      message: 'MCP entry changed since installation; leaving its receipt and files intact.',
    });
  }
  if (!apply) yield* Console.log(`Would remove owned MCP entry from ${receipt.mcp.path}`);
  else if (
    entry !== undefined &&
    !Object.values(registry.surfaces ?? {}).some(
      peer =>
        peer.surfaceId !== receipt.surfaceId &&
        peer.mcp.path === receipt.mcp.path &&
        peer.mcp.name === receipt.mcp.name &&
        sameAgentContainer(peer.strategy.container, receipt.strategy.container) &&
        !excludedConsumers.has(peer.surfaceId),
    )
  ) {
    const next = removeAgentServer(
      parsed,
      receipt.strategy.container,
      receipt.mcp.name,
      receipt.mcp.createdContainer,
      receipt.mcp.createdContainerParents,
    );
    const rendered = writeAgentServer(raw, receipt.strategy.codec, receipt.strategy.container, receipt.mcp.name, next);
    if (
      receipt.mcp.createdFile &&
      Object.keys(next).length === 0 &&
      (receipt.strategy.codec === 'json' || !agentJsonHasComments(rendered))
    )
      yield* removeAgentTargetIfUnchanged(receipt.mcp.path, raw!);
    else yield* atomicAgentWrite(receipt.mcp.path, rendered, 0o600, {content: raw});
  }
  for (const artifact of receipt.artifactDescriptors) {
    if (!artifactHasOtherConsumers(registry, artifact.path, adapter.catalog.id, excludedConsumers)) {
      yield* removeReceiptArtifact(artifact, !apply);
    }
  }
  const surfaces = {...registry.surfaces};
  delete surfaces[adapter.catalog.id];
  const nextRegistry = {...registry, surfaces};
  if (apply) {
    yield* writeAgentIntegrationRegistry(config, nextRegistry);
  }
  return nextRegistry;
});

export function defineJsonAgentAdapter(
  id: string,
  json: JsonAgentStrategy,
  guidance?: AgentAdapterDefinition['guidance'],
): AgentAdapterDefinition {
  const install: AgentAdapterDefinition['actions']['install'] = (config, adapter, options) =>
    installJsonAgentSurface(config, adapter, {
      apply: options.apply,
      cwd: options.cwd,
      toolset: options.toolset,
      scope: options.scope,
    });
  return {
    actions: {
      install,
      repair: (config, adapter, options) =>
        Effect.gen(function* () {
          const registry = options.registry ?? (yield* readAgentIntegrationRegistry(config));
          if (!registry?.surfaces?.[adapter.catalog.id]) {
            return yield* AgentSurfaceError.make({
              message: `No receipt for ${adapter.catalog.id}; use agents install.`,
            });
          }
          yield* install(config, adapter, {...options, registry});
        }),
      remove: removeJsonAgentSurface,
      status: agentSurfaceStatus,
    },
    adapterVersion: 1,
    guidance,
    id,
    json,
    kind: 'json',
  };
}

const assertSurfaceTargets = Effect.fn('agentSurfaces.assertTargets')(function* (plan: {
  readonly root: string;
  readonly skillRoot: string;
  readonly mcpRoot: string;
  readonly mcpPath: string;
  readonly artifacts: readonly AgentArtifact[];
}) {
  const path = yield* Path.Path;
  const targets = [
    [plan.mcpPath, plan.mcpRoot],
    ...plan.artifacts.map(artifact => [artifact.path, artifact.name.startsWith('skill ') ? plan.skillRoot : plan.root]),
  ];
  const checked = new Set<string>();
  for (const [target, root] of targets) {
    let current = target;
    while (!checked.has(current)) {
      checked.add(current);
      yield* assertAgentTargetNotSymlink(current);
      if (current === root || current === path.dirname(current)) break;
      current = path.dirname(current);
    }
  }
});

function receiptMatchesPlan(
  receipt: AgentSurfaceReceipt,
  plan: {
    readonly adapter: AgentAdapter;
    readonly artifacts: readonly AgentArtifact[];
    readonly container: AgentJsonContainer;
  },
): boolean {
  if (
    receipt.adapterVersion !== plan.adapter.adapterVersion ||
    receipt.strategy.kind !== 'json' ||
    receipt.strategy.codec !== (plan.adapter.json?.codec ?? 'json') ||
    !sameAgentContainer(receipt.strategy.container, plan.container)
  ) {
    return false;
  }
  const installed = receipt.artifactDescriptors.map(({kind, path}) => `${kind}:${path}`).sort();
  const current = plan.artifacts.map(({kind, path}) => `${kind}:${path}`).sort();
  return JSON.stringify(installed) === JSON.stringify(current);
}

const removeReceiptArtifact = Effect.fn('agentSurfaces.removeReceiptArtifact')(function* (
  artifact: AgentSurfaceReceipt['artifactDescriptors'][number],
  dryRun: boolean,
) {
  const current = yield* readFileIfExists(artifact.path);
  if (current === undefined) return;
  const currentHash = yield* sha256Hex(current);
  const managedBlock = extractManagedBlock(current);
  if (currentHash !== artifact.hash && managedBlock === undefined) {
    yield* Console.log(`WARN ${artifact.path} changed since installation; not modifying it`);
    return;
  }
  yield* removeArtifact(
    {
      content: currentHash === artifact.hash ? current : managedBlock!,
      hash: artifact.hash,
      kind: artifact.kind,
      name: artifact.name,
      path: artifact.path,
    },
    dryRun,
  );
});
