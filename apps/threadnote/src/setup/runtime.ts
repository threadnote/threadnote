import {Clock, Console, Effect, FileSystem, Path} from 'effect';
import {agentAdapterStatus, runAgentAdapterAction} from '../agent_integration/adapter_actions.js';
import type {AgentAdapter, AgentAdapterStatus} from '../agent_integration/adapters/contract.js';
import {resolveAgentHostPaths} from '../agent_integration/host_paths.js';
import {
  agentIntegrationRegistryPath,
  isAgentSetupCompletion,
  readAgentIntegrationRegistry,
  type AgentSurfaceReceipt,
} from '../agent_integration/registry.js';
import {runCodeGraphIndex} from '../code_graph/commands.js';
import {worktreeBuildRequestState} from '@threadnote/graph/inventory';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {compileSetupSourceVerificationBrief} from '../context_brief/index.js';
import {retrieveContextBriefGraphEvidence} from '@threadnote/context/graph/evidence';
import {planContextBrief} from '@threadnote/context/planner';
import {hasCurrentCursorHooks, hasManagedCursorHooks} from '../cursor/hooks.js';
import {CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, USER_MANIFEST_NAME} from '../constants.js';
import {hasCurrentCodexHooks, hasManagedCodexHooks} from '../codex/hooks.js';
import {
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefRequestV1,
  type ProjectedContextBriefV1,
} from '@threadnote/context/types';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {hasCurrentClaudeHooks, hasManagedClaudeHooks, runHooksInstall} from '../hooks.js';
import {collectDoctorChecks, runInstall} from '../lifecycle.js';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {hasCurrentOmpHooks, hasManagedOmpHooks} from '../omp_hooks.js';
import {refreshRecallDerivedIndexesFromSelection} from '@threadnote/recall/mcp/refresh';
import {runInitManifest, runSeed} from '../seeding.js';
import type {DoctorCheck} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {readFileIfExists, resolveRepoName} from '../utils.js';
import {
  SETUP_MAX_DURATION_MILLISECONDS,
  SetupOperationError,
  type SetupOperationKind,
  type SetupReceiptOperationV1,
  type SetupReceiptVerificationV1,
} from './contract.js';
import type {SetupOperationOutcome, SetupOrchestratorDependencies} from './index.js';

type EffectEnvironment<Value> =
  Value extends Effect.Effect<unknown, unknown, infer Requirements> ? Requirements : never;
type ProductionSetupServices =
  | EffectEnvironment<ReturnType<typeof verifyContextBrief>>
  | EffectEnvironment<ReturnType<typeof verifyDoctor>>
  | EffectEnvironment<ReturnType<typeof ensureCore>>
  | EffectEnvironment<ReturnType<typeof ensureHooks>>
  | EffectEnvironment<ReturnType<typeof ensureManifest>>
  | EffectEnvironment<ReturnType<typeof ensureSurface>>
  | EffectEnvironment<ReturnType<typeof indexGraph>>
  | EffectEnvironment<ReturnType<typeof inspectReversible>>
  | EffectEnvironment<ReturnType<typeof removeHooks>>
  | EffectEnvironment<ReturnType<typeof removeSurface>>
  | EffectEnvironment<ReturnType<typeof seedSetupProject>>;

export const productionSetupDependencies: SetupOrchestratorDependencies<ProductionSetupServices> = {
  contextBrief: (config, projectRoot, task) => verifyContextBrief(config, projectRoot, task),
  doctor: config => verifyDoctor(config),
  ensureCore: (config, apply) => ensureCore(config, apply),
  ensureHooks: (config, adapter, apply) => ensureHooks(config, adapter, apply),
  ensureManifest: (config, projectRoot, apply) => ensureManifest(config, projectRoot, apply),
  ensureSurface: (config, adapter, projectRoot, apply, scope) =>
    ensureSurface(config, adapter, projectRoot, apply, scope),
  indexGraph: (config, projectRoot, apply) => indexGraph(config, projectRoot, apply),
  inspectReversible: (config, adapter, projectRoot, kind, scope) =>
    inspectReversible(config, adapter, projectRoot, kind, scope),
  removeHooks: (config, adapter, operation) => removeHooks(config, adapter, operation),
  removeSurface: (config, adapter, projectRoot, scope) => removeSurface(config, adapter, projectRoot, scope),
  seedProject: (config, projectRoot, apply) => seedSetupProject(config, projectRoot, apply),
};

export const resolveSetupRuntimeConfig = Effect.fn('setup.resolveRuntimeConfig')(function* (config: RuntimeConfig) {
  if (config.manifestSource !== 'bundled-example') return config;
  const path = yield* Path.Path;
  return {
    ...config,
    manifestPath: path.join(config.agentContextHome, USER_MANIFEST_NAME),
    manifestSource: 'user' as const,
  };
});

const inspectReversible = Effect.fn('setup.inspectReversible')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  projectRoot: string,
  kind: SetupOperationKind,
  scope?: 'user' | 'project' | 'local',
) {
  if (kind === 'manifest.ensure') {
    const beforeHash = yield* fileHash(config.manifestPath);
    return operationOutcome(
      beforeHash === undefined ? 'setup-created' : 'preexisting',
      beforeHash,
      undefined,
      config.manifestPath,
    );
  }
  if (kind === 'surface.ensure') {
    const registry = yield* readAgentIntegrationRegistry(config);
    const effectiveScope = scope ?? adapter.json?.defaultScope ?? 'user';
    if (!agentSurfaceTargetMatches(registry?.surfaces?.[adapter.catalog.id], effectiveScope, projectRoot))
      return yield* SetupOperationError.make({
        message: `${adapter.catalog.displayName} targets another scope or repository.`,
      });
    const status = yield* agentAdapterStatus(config, adapter);
    const registryPath = yield* agentIntegrationRegistryPath(config);
    return {
      beforeHash: yield* fileHash(registryPath),
      ownership: status.state === 'absent' ? 'setup-created' : 'preexisting',
      status: status.state === 'current' ? 'already-current' : 'applied',
      subsystemReceiptRef: registryPath,
    } satisfies SetupOperationOutcome;
  }
  if (kind === 'surface.hooks' && adapter.hooks?.kind === 'legacy-client') {
    const registry = adapter.hooks.client === 'omp' ? yield* readAgentIntegrationRegistry(config) : undefined;
    const hostRoot = registry?.hosts.omp?.mcp.hostRoot;
    const hookPath = yield* setupHookPath(adapter.hooks.client, hostRoot);
    const [current, present] = yield* Effect.all([
      managedHooksAreCurrent(adapter.hooks.client, hostRoot),
      managedHooksArePresent(adapter.hooks.client, hostRoot),
    ]);
    return {
      beforeHash: yield* fileHash(hookPath),
      ownership: present ? 'preexisting' : 'setup-created',
      status: current ? 'already-current' : 'applied',
      subsystemReceiptRef: hookPath,
    } satisfies SetupOperationOutcome;
  }
  return yield* SetupOperationError.make({message: `Setup operation ${kind} has no reversible inspection.`});
});

const ensureCore = Effect.fn('setup.ensureCore')(function* (config: RuntimeConfig, apply: boolean) {
  const path = yield* Path.Path;
  const receiptPath = path.join(config.agentContextHome, 'layout.json');
  const beforeHash = yield* fileHash(receiptPath);
  yield* runInstall(config, {
    dryRun: !apply,
    printNextSteps: false,
    skipReleaseLifecycle: true,
    start: false,
  });
  const afterHash = apply ? yield* fileHash(receiptPath) : undefined;
  return operationOutcome(
    beforeHash === undefined ? 'setup-created' : 'preexisting',
    beforeHash,
    afterHash,
    receiptPath,
  );
});

const ensureManifest = Effect.fn('setup.ensureManifest')(function* (
  config: RuntimeConfig,
  projectRoot: string,
  apply: boolean,
) {
  const beforeHash = yield* fileHash(config.manifestPath);
  yield* runInitManifest(config, {
    dryRun: !apply,
    path: config.manifestPath,
    repo: [projectRoot],
    setupLockHeld: apply,
  });
  const afterHash = apply ? yield* fileHash(config.manifestPath) : undefined;
  return operationOutcome(
    beforeHash === undefined ? 'setup-created' : 'preexisting',
    beforeHash,
    afterHash,
    config.manifestPath,
  );
});

export const seedSetupProject = Effect.fn('setup.seedProject')(function* (
  config: RuntimeConfig,
  projectRoot: string,
  apply: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(config.manifestPath))) {
    yield* Console.log('Would seed curated project context after creating the manifest.');
    return {ownership: 'setup-created', status: 'applied'} satisfies SetupOperationOutcome;
  }
  const manifest = yield* readSeedManifest(config.manifestPath);
  const resolvedProjectRoot = path.resolve(yield* expandPath(projectRoot));
  let project: (typeof manifest.projects)[number] | undefined;
  for (const candidate of manifest.projects) {
    if (path.resolve(yield* expandPath(candidate.path)) !== resolvedProjectRoot) continue;
    project = candidate;
    break;
  }
  if (!project && !apply) {
    yield* Console.log('Would seed curated project context after merging the repository into the manifest.');
    return {ownership: 'preexisting', status: 'applied'} satisfies SetupOperationOutcome;
  }
  if (!project)
    return yield* SetupOperationError.make({message: 'The setup project is absent from the seed manifest.'});
  yield* runSeed(config, {dryRun: !apply, only: [project.name]});
  if (apply) yield* refreshRecallDerivedIndexesFromSelection(config, []);
  return {ownership: 'preexisting', status: 'applied'} satisfies SetupOperationOutcome;
});

export const ensureSurface = Effect.fn('setup.ensureSurface')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  projectRoot: string,
  apply: boolean,
  scope?: 'user' | 'project' | 'local',
) {
  const before = yield* agentAdapterStatus(config, adapter);
  const registryPath = yield* agentIntegrationRegistryPath(config);
  const beforeHash = yield* fileHash(registryPath);
  const effectiveScope = scope ?? adapter.json?.defaultScope ?? 'user';
  if (adapter.kind === 'json') {
    const registry = yield* readAgentIntegrationRegistry(config);
    const recorded = registry?.surfaces?.[adapter.catalog.id];
    if (!agentSurfaceTargetMatches(recorded, effectiveScope, projectRoot))
      return yield* SetupOperationError.make({
        message: `${adapter.catalog.displayName} is already installed for another scope or repository; remove it before changing targets.`,
      });
  }
  const action = setupSurfaceAction(before);
  if (action === 'unsupported')
    return yield* SetupOperationError.make({message: `${adapter.catalog.displayName}: ${before.detail}`});
  if (action === 'reuse') {
    yield* Console.log(`${adapter.catalog.displayName} surface is already current.`);
    return {
      beforeHash,
      afterHash: beforeHash,
      ownership: 'preexisting',
      status: 'already-current',
      subsystemReceiptRef: registryPath,
      supportedAgentReuse: true,
    } satisfies SetupOperationOutcome;
  }
  const result = yield* runAgentAdapterAction(config, adapter, action, apply, scope, projectRoot, apply);
  if (!apply)
    return {
      beforeHash,
      ownership: before.state === 'absent' ? 'setup-created' : 'preexisting',
      status: 'applied',
      subsystemReceiptRef: registryPath,
    } satisfies SetupOperationOutcome;
  const after = yield* agentAdapterStatus(config, adapter);
  if (after.state !== 'current')
    return yield* SetupOperationError.make({message: `${adapter.catalog.displayName} did not become current.`});
  return {
    beforeHash,
    afterHash: yield* fileHash(registryPath),
    ownership: before.state === 'absent' ? 'setup-created' : 'preexisting',
    status: 'applied',
    subsystemReceiptRef: registryPath,
    supportedAgentReuse: isAgentSetupCompletion(result) && result.supportedAgentReuse,
  } satisfies SetupOperationOutcome;
});

const removeSurface = Effect.fn('setup.removeSurface')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  projectRoot: string,
  scope?: 'user' | 'project' | 'local',
) {
  if (adapter.kind !== 'json')
    return yield* SetupOperationError.make({message: 'Only receipt-managed JSON surfaces support setup rollback.'});
  const effectiveScope = scope ?? adapter.json?.defaultScope ?? 'user';
  const registry = yield* readAgentIntegrationRegistry(config);
  const recorded = registry?.surfaces?.[adapter.catalog.id];
  if (!agentSurfaceTargetMatches(recorded, effectiveScope, projectRoot))
    return yield* SetupOperationError.make({
      message: `${adapter.catalog.displayName} now targets another scope or repository; refusing automatic rollback.`,
    });
  const before = yield* agentAdapterStatus(config, adapter);
  if (before.state === 'absent')
    return {ownership: 'setup-created', status: 'already-current'} satisfies SetupOperationOutcome;
  if (before.state !== 'current')
    return yield* SetupOperationError.make({
      message: `${adapter.catalog.displayName} changed after setup; refusing automatic rollback.`,
    });
  yield* runAgentAdapterAction(config, adapter, 'remove', true, scope, projectRoot, true);
  const after = yield* agentAdapterStatus(config, adapter);
  if (after.state !== 'absent')
    return yield* SetupOperationError.make({message: `${adapter.catalog.displayName} rollback did not complete.`});
  return {ownership: 'setup-created', status: 'applied'} satisfies SetupOperationOutcome;
});

const ensureHooks = Effect.fn('setup.ensureHooks')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  apply: boolean,
) {
  if (adapter.hooks?.kind !== 'legacy-client')
    return yield* SetupOperationError.make({message: 'Managed hooks require an adapter hook strategy.'});
  const registry = adapter.hooks.client === 'omp' ? yield* readAgentIntegrationRegistry(config) : undefined;
  const hostRoot = registry?.hosts.omp?.mcp.hostRoot;
  const hookPath = yield* setupHookPath(adapter.hooks.client, hostRoot);
  const beforeManaged = yield* managedHooksArePresent(adapter.hooks.client, hostRoot);
  const beforeCurrent = yield* managedHooksAreCurrent(adapter.hooks.client, hostRoot);
  const beforeHash = yield* fileHash(hookPath);
  if (beforeCurrent) {
    yield* Console.log(`${adapter.catalog.displayName} hooks are already current.`);
    return {
      afterHash: beforeHash,
      beforeHash,
      ownership: 'preexisting',
      status: 'already-current',
      subsystemReceiptRef: hookPath,
    } satisfies SetupOperationOutcome;
  }
  yield* runHooksInstall(config, adapter.hooks.client, {
    apply,
    dryRun: !apply,
    hostRoot,
    setupLockHeld: apply,
  });
  if (apply && !(yield* managedHooksAreCurrent(adapter.hooks.client, hostRoot)))
    return yield* SetupOperationError.make({message: `${adapter.catalog.displayName} hooks did not become current.`});
  return {
    ...(apply ? {afterHash: yield* fileHash(hookPath)} : {}),
    ...(beforeHash === undefined ? {} : {beforeHash}),
    ownership: beforeManaged ? 'preexisting' : 'setup-created',
    status: 'applied',
    subsystemReceiptRef: hookPath,
  } satisfies SetupOperationOutcome;
});

const removeHooks = Effect.fn('setup.removeHooks')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  operation: SetupReceiptOperationV1,
) {
  if (adapter.hooks?.kind !== 'legacy-client')
    return yield* SetupOperationError.make({message: 'Setup receipt references an unavailable hook strategy.'});
  if (
    operation.ownershipEvidence !== 'successful-mutation' ||
    operation.subsystemReceiptRef === undefined ||
    operation.afterHash === undefined
  )
    return yield* SetupOperationError.make({message: 'Hook rollback lacks exact setup ownership evidence.'});
  const path = yield* Path.Path;
  const recordedPath = operation.subsystemReceiptRef;
  const hostRoot = adapter.hooks.client === 'omp' ? path.dirname(path.dirname(path.dirname(recordedPath))) : undefined;
  if ((yield* setupHookPath(adapter.hooks.client, hostRoot)) !== recordedPath)
    return yield* SetupOperationError.make({message: 'Hook rollback target does not match its setup receipt.'});
  const currentHash = yield* fileHash(recordedPath);
  if (currentHash === undefined)
    return {ownership: 'setup-created', status: 'already-current'} satisfies SetupOperationOutcome;
  if (currentHash !== operation.afterHash)
    return yield* SetupOperationError.make({
      message: `${adapter.catalog.displayName} hooks changed after setup; refusing automatic rollback.`,
    });
  const present = yield* managedHooksArePresent(adapter.hooks.client, hostRoot);
  if (!present) return {ownership: 'setup-created', status: 'already-current'} satisfies SetupOperationOutcome;
  if (!(yield* managedHooksAreCurrent(adapter.hooks.client, hostRoot)))
    return yield* SetupOperationError.make({
      message: `${adapter.catalog.displayName} hooks changed after setup; refusing automatic rollback.`,
    });
  yield* runHooksInstall(config, adapter.hooks.client, {
    apply: true,
    dryRun: false,
    hostRoot,
    remove: true,
    setupLockHeld: true,
  });
  if (yield* managedHooksArePresent(adapter.hooks.client, hostRoot))
    return yield* SetupOperationError.make({message: `${adapter.catalog.displayName} hook rollback did not complete.`});
  return {ownership: 'setup-created', status: 'applied'} satisfies SetupOperationOutcome;
});

const setupHookPath = Effect.fn('setup.hookPath')(function* (
  client: NonNullable<AgentAdapter['hooks']>['client'],
  hostRoot?: string,
) {
  if (client === 'claude') return yield* expandPath(CLAUDE_SETTINGS_PATH);
  if (client === 'codex') return yield* expandPath(CODEX_HOOKS_PATH);
  if (client === 'cursor') return yield* expandPath('~/.cursor/hooks.json');
  if (client === 'omp') return (yield* resolveAgentHostPaths('omp', hostRoot))!.hookPath;
  return yield* SetupOperationError.make({message: `${client} has no managed setup hook path.`});
});

const managedHooksAreCurrent = Effect.fn('setup.managedHooksAreCurrent')(function* (
  client: NonNullable<AgentAdapter['hooks']>['client'],
  hostRoot?: string,
) {
  if (client === 'claude') return yield* hasCurrentClaudeHooks();
  if (client === 'codex') return yield* hasCurrentCodexHooks();
  if (client === 'cursor') return yield* hasCurrentCursorHooks();
  if (client === 'omp') return yield* hasCurrentOmpHooks(hostRoot);
  return false;
});

const managedHooksArePresent = Effect.fn('setup.managedHooksArePresent')(function* (
  client: NonNullable<AgentAdapter['hooks']>['client'],
  hostRoot?: string,
) {
  if (client === 'claude') return yield* hasManagedClaudeHooks();
  if (client === 'codex') return yield* hasManagedCodexHooks();
  if (client === 'cursor') return yield* hasManagedCursorHooks();
  if (client === 'omp') return yield* hasManagedOmpHooks(hostRoot);
  return false;
});

const indexGraph = Effect.fn('setup.indexGraph')(function* (
  config: RuntimeConfig,
  projectRoot: string,
  apply: boolean,
) {
  if (!apply) {
    yield* Console.log(`Would build a current code graph for ${projectRoot}.`);
    return {ownership: 'preexisting', status: 'applied'} satisfies SetupOperationOutcome;
  }
  yield* runCodeGraphIndex(config, {cwd: projectRoot, noVectors: true});
  return {ownership: 'preexisting', status: 'applied'} satisfies SetupOperationOutcome;
});

const verifyDoctor = Effect.fn('setup.verifyDoctor')(function* (config: RuntimeConfig) {
  const system = yield* SystemInfo;
  const checks = yield* collectDoctorChecks(config, {}, system.platform);
  yield* printDoctorChecks(checks);
  if (checks.some(check => check.status === 'fail'))
    return yield* SetupOperationError.make({message: 'Threadnote doctor reported a failed check.'});
  return {ownership: 'preexisting', status: 'verified'} satisfies SetupOperationOutcome;
});

export interface SetupSourceVerificationDependencies<Requirements = never> {
  readonly compileFinal: (
    request: ContextBriefRequestV1,
  ) => Effect.Effect<ProjectedContextBriefV1, unknown, Requirements>;
  readonly graphLocator: (
    request: ContextBriefRequestV1,
  ) => Effect.Effect<ContextBriefGraphEvidenceV1, unknown, Requirements>;
  readonly resolveProject: (projectRoot: string) => Effect.Effect<string | undefined, unknown, Requirements>;
  readonly sourceHash: (projectRoot: string) => Effect.Effect<string, unknown, Requirements>;
}

export const verifySetupSourceVerificationWith = Effect.fn('setup.verifySourceVerificationWith')(function* <
  Requirements = never,
>(dependencies: SetupSourceVerificationDependencies<Requirements>, projectRoot: string, task: string) {
  const startedAt = yield* Clock.currentTimeMillis;
  const sourceHashBefore = yield* dependencies.sourceHash(projectRoot);
  const project = yield* dependencies.resolveProject(projectRoot);
  if (project === undefined) {
    return yield* SetupOperationError.make({
      message: 'Final Context Brief did not contain stable, fresh, complete source evidence for the setup repository.',
    });
  }
  const locator = yield* dependencies.graphLocator(setupContextBriefRequest(projectRoot, task, project));
  const anchor = setupContextBriefAnchor(locator);
  if (anchor === undefined) {
    return yield* SetupOperationError.make({
      message: 'Final Context Brief did not contain stable, fresh, complete source evidence for the setup repository.',
    });
  }
  const projected = yield* dependencies.compileFinal(setupContextBriefRequest(projectRoot, task, project, anchor));
  const completedAt = yield* Clock.currentTimeMillis;
  const sourceHashAfter = yield* dependencies.sourceHash(projectRoot);
  const brief = projected.structuredContent;
  if (!setupBriefIsSourceVerified(brief) || sourceHashBefore !== sourceHashAfter) {
    return yield* SetupOperationError.make({
      message: 'Final Context Brief did not contain stable, fresh, complete source evidence for the setup repository.',
    });
  }
  const verification: SetupReceiptVerificationV1 = {
    contextBriefHash: yield* sha256Hex(JSON.stringify(brief)),
    durationMilliseconds: Math.min(SETUP_MAX_DURATION_MILLISECONDS, Math.max(0, Math.round(completedAt - startedAt))),
    freshness: 'fresh',
    graphCards: brief.graph.cards.length,
    graphContracts: brief.graph.contracts.length,
    readyRepositories: 1,
    repositorySourceHash: sourceHashAfter,
    requestedRepositories: 1,
    sourceVerified: true,
  };
  return {
    finalOutput: projected.text,
    ownership: 'preexisting',
    status: 'verified',
    verification,
  } satisfies SetupOperationOutcome;
});

const verifyContextBrief = Effect.fn('setup.verifyContextBrief')(function* (
  config: RuntimeConfig,
  projectRoot: string,
  task: string,
) {
  return yield* verifySetupSourceVerificationWith(
    {
      compileFinal: request => compileSetupSourceVerificationBrief(config, request),
      graphLocator: request => retrieveContextBriefGraphEvidence(config, planContextBrief(request).graph),
      resolveProject: resolveRepoName,
      sourceHash: setupRepositorySourceHash,
    },
    projectRoot,
    task,
  );
});

export function setupContextBriefRequest(
  projectRoot: string,
  task: string,
  project?: string,
  codeRef?: string,
): ContextBriefRequestV1 {
  return {
    budgetTokens: CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
    ...(codeRef === undefined ? {} : {codeRefs: [codeRef]}),
    mode: codeRef === undefined ? 'brief' : 'locate',
    scope: {callerCwd: projectRoot, kind: 'repository', ...(project === undefined ? {} : {project})},
    task,
  };
}

export function setupContextBriefAnchor(graph: Pick<ContextBriefGraphEvidenceV1, 'cards'>): string | undefined {
  return graph.cards[0]?.ref;
}

function operationOutcome(
  ownership: 'setup-created' | 'preexisting',
  beforeHash: string | undefined,
  afterHash: string | undefined,
  subsystemReceiptRef: string,
): SetupOperationOutcome {
  return {
    ...(afterHash === undefined ? {} : {afterHash}),
    ...(beforeHash === undefined ? {} : {beforeHash}),
    ownership,
    status: beforeHash !== undefined && beforeHash === afterHash ? 'already-current' : 'applied',
    subsystemReceiptRef,
  };
}

const fileHash = Effect.fn('setup.fileHash')(function* (target: string) {
  const content = yield* readFileIfExists(target);
  return content === undefined ? undefined : yield* sha256Hex(content);
});

const printDoctorChecks = Effect.fn('setup.printDoctorChecks')(function* (checks: readonly DoctorCheck[]) {
  for (const check of checks) yield* Console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
});

export function setupSurfaceAction(status: AgentAdapterStatus): 'install' | 'repair' | 'reuse' | 'unsupported' {
  if (status.state === 'current') return 'reuse';
  if (status.state === 'absent') return 'install';
  if (status.state === 'manual' || status.state === 'unsupported') return 'unsupported';
  return 'repair';
}

export function agentSurfaceTargetMatches(
  receipt: Pick<AgentSurfaceReceipt, 'cwd' | 'scope'> | undefined,
  scope: 'user' | 'project' | 'local',
  projectRoot: string,
): boolean {
  const requestedCwd = scope === 'user' ? undefined : projectRoot;
  return receipt === undefined || (receipt.scope === scope && receipt.cwd === requestedCwd);
}

export function setupBriefIsSourceVerified(brief: ProjectedContextBriefV1['structuredContent']): boolean {
  return (
    brief.scope.freshness === 'fresh' &&
    brief.scope.requestedRepositories === 1 &&
    brief.scope.readyRepositories === 1 &&
    brief.coverage.graph.complete &&
    !brief.coverage.gaps.includes('graph-evidence-partial') &&
    !brief.coverage.gaps.includes('graph-query-warning') &&
    brief.coverage.omissions.graphCards === 0 &&
    brief.coverage.omissions.graphContracts === 0 &&
    brief.graph.cards.length + brief.graph.contracts.length > 0
  );
}

export const setupRepositorySourceHash = Effect.fn('setup.repositorySourceHash')(function* (projectRoot: string) {
  const identity = yield* resolveRepositoryIdentity(projectRoot);
  const worktree = yield* worktreeBuildRequestState(identity);
  return yield* sha256Hex(
    JSON.stringify({
      dirty: worktree.dirty,
      fingerprint: worktree.fingerprint,
      headCommit: identity.headCommit,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
    }),
  );
});
