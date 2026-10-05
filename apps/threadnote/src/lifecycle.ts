import {hasManagedCursorHooks} from './cursor/hooks.js';
import {Console, Effect, FileSystem, Path, Result, Schema} from 'effect';
import {
  repairRegisteredAgentAdapters,
  removeRegisteredAgentAdaptersInTransaction,
} from './agent_integration/adapter_actions.js';
import {agentAdapterDoctorChecks} from './agent_integration/adapter_actions.js';
import {
  migrateLegacyAgentIntegrations,
  readAgentIntegrationRegistry,
  registeredAgentClients,
  repairableAgentClients,
  removeAgentIntegrationsInTransaction,
  repairAgentIntegrations,
} from './agent_integration/index.js';
import {type AgentIntegrationRegistry, withAgentIntegrationLock} from './agent_integration/registry.js';
import {startProgress, withProgressLine} from './cli_ui.js';
import {commandShimCheck, installCommandShim, removeCommandShim} from './command-shim.js';
import {sha256FileHex} from '@threadnote/platform/digest';
import {hasManagedClaudeHooks, runHooksInstall} from './hooks.js';
import {withSetupMutationLock} from './setup/lock.js';
import {hasManagedOmpHooks} from './omp_hooks.js';
import {localAiDoctorCheck} from './effect/local-ai.js';
import {SystemInfo} from '@threadnote/platform/system';
import {
  activeInstalledVersion,
  activateStandaloneRelease,
  pruneStandaloneReleases,
  withStandaloneInstallationLock,
} from './installations.js';
import {
  inferConfiguredMcpClients,
  isPersonalThreadnoteHome,
  mcpConfigurationChecks,
  removeMcpConfigs,
  removeMcpSnippets,
  resolveMcpClients,
  runMcpInstall,
} from './mcp/index.js';
import {legacyProcessDoctorCheck} from './process/diagnostics.js';
import {maybeRunPostUpdateAfterRepair} from './release/index.js';
import {imageProjectionDoctorCheck} from './image_projection/config.js';
import {
  TELEMETRY_CONSENT_VERSION,
  readTelemetryConfiguration,
  readTelemetryConsentRenewal,
  telemetryEnvironmentOptOut,
} from './telemetry/config.js';
import {
  currentRecallCorpusGeneration,
  loadRecallIndexData,
  recallIndexStatus,
  type RecallIndexProgress,
  type RecallIndexStatus,
} from '@threadnote/recall/index';
import {readSeedManifest, uriSegment} from '@threadnote/workspace/manifest';
import {deferredCodeAnchorDoctorCheck} from './memory/deferred/code_anchor.js';
import {migrateThreadnoteStorageLayout} from './migration/layout.js';
import {applyLegacyInstallationCleanup, planLegacyInstallationCleanup} from './migration/legacy-installations.js';
import {stopVerifiedLegacyLocalAi} from './migration/legacy-runtime.js';
import {migrateLegacyLocalModels} from './migration/models.js';
import {provisionCoreEmbedding} from './models/core-embedding.js';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {
  ensureVectorIndex,
  type VectorIndexProgress,
  VectorCorpusGenerationChanged,
  type VectorIndexGenerationReadiness,
  vectorIndexGenerationReadiness,
  vectorIndexMatchesGeneration,
  vectorIndexStatus,
} from '@threadnote/recall/vector-index';
import {
  codeGraphDoctorCheck,
  type CodeGraphMaintenanceProgress,
  type CodeGraphRepairCompletion,
  repairCodeGraphIndexes,
} from '@threadnote/graph/maintenance';
import {formatCodeGraphDoctorProgressLine, formatCodeGraphRepairProgressLine} from '@threadnote/graph/cli/progress';
import {
  isThreadnoteStorageLayoutReceipt,
  threadnoteStorageLayout,
  THREADNOTE_STORAGE_LAYOUT_VERSION,
} from '@threadnote/store/layout';
import type {
  AgentClient,
  DoctorCheck,
  DoctorOptions,
  ForgetOptions,
  InstallOptions,
  RepairOptions,
  StartOptions,
  UninstallOptions,
} from './types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {assertSafeThreadnoteHomeForErase, formatStatus} from './utils.js';
import {errorMessage} from '@threadnote/platform/errors';
import {memoryFrontmatterField, memoryUriProjectSegment} from '@threadnote/recall/results';
import {toolRoot} from '@threadnote/workspace/installation';

class LifecycleOperationError extends Schema.TaggedError<LifecycleOperationError>()('LifecycleOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const LAYOUT_RECEIPT = 'layout.json';
export const RECALL_INDEX_MAINTENANCE_GENERATION_RETRY_LIMIT = 2;

export function recallIndexMaintenanceShouldRetry(error: unknown, completedRetries: number): boolean {
  return (
    Number.isSafeInteger(completedRetries) &&
    completedRetries >= 0 &&
    completedRetries < RECALL_INDEX_MAINTENANCE_GENERATION_RETRY_LIMIT &&
    Schema.is(VectorCorpusGenerationChanged)(error)
  );
}

export const verifyRecallIndexMaintenanceReadiness = Effect.fn('lifecycle.verifyRecallIndexMaintenanceReadiness')(
  function* <VectorError, VectorRequirements, LexicalError, LexicalRequirements>(input: {
    readonly manifestId: string;
    readonly readLexicalStatus: () => Effect.Effect<RecallIndexStatus, LexicalError, LexicalRequirements>;
    readonly readVectorReadiness: () => Effect.Effect<VectorIndexGenerationReadiness, VectorError, VectorRequirements>;
    readonly requestedGeneration: string;
  }) {
    const vectorReadiness = yield* input.readVectorReadiness();
    if (vectorReadiness !== 'current') {
      return yield* LifecycleOperationError.make({
        message: `The vector recall index is ${vectorReadiness} after maintenance.`,
      });
    }
    const lexicalStatus = yield* input.readLexicalStatus();
    if (lexicalStatus.ready && lexicalStatus.generation === input.requestedGeneration) return;
    if (
      lexicalStatus.reason === 'canonical documents changed; run `threadnote repair`' ||
      (lexicalStatus.ready && lexicalStatus.generation !== input.requestedGeneration)
    ) {
      return yield* VectorCorpusGenerationChanged.make({
        message: 'The lexical recall corpus changed while vector work was in progress.',
        modelId: input.manifestId,
        requestedGeneration: input.requestedGeneration,
      });
    }
    return yield* LifecycleOperationError.make({
      message: `The lexical recall index is not ready after maintenance: ${lexicalStatus.reason ?? 'unknown state'}.`,
    });
  },
);

interface RunInstallOptions extends InstallOptions {
  readonly skipRecallIndexes?: boolean;
  readonly skipReleaseLifecycle?: boolean;
}

interface RunRepairOptions extends RepairOptions {
  readonly skipAgentIntegrations?: boolean;
  readonly skipReleaseLifecycle?: boolean;
}

interface RunDoctorOptions extends DoctorOptions {
  readonly codeGraphCheck?: DoctorCheck;
}

interface CollectDoctorOptions extends RunDoctorOptions {
  readonly onCodeGraphProgress?: (progress: CodeGraphMaintenanceProgress) => Effect.Effect<void, unknown>;
  readonly withCodeGraphProgressLine?: boolean;
}

export const runDoctor = Effect.fn('lifecycle.doctor')(function* (config: RuntimeConfig, options: RunDoctorOptions) {
  const system = yield* SystemInfo;
  yield* Console.log('Running Threadnote doctor checks.');
  const checks = yield* collectDoctorChecks(
    config,
    {
      ...options,
      withCodeGraphProgressLine: true,
    },
    system.platform,
  );
  for (const check of checks) {
    yield* Console.log(`${formatStatus(check.status)} ${check.name}: ${check.detail}`);
  }
  const failureCount = checks.filter(check => check.status === 'fail').length;
  const warningCount = checks.filter(check => check.status === 'warn').length;
  yield* Console.log(`\nSummary: ${failureCount} failure(s), ${warningCount} warning(s)`);
  if (options.strict === true && failureCount > 0) {
    yield* Effect.sync(() => system.setExitCode(1));
  }
});

export const collectDoctorChecks = Effect.fn('lifecycle.collectDoctorChecks')(function* (
  config: RuntimeConfig,
  options: CollectDoctorOptions = {},
  currentPlatform?: NodeJS.Platform,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const platform = currentPlatform ?? system.platform;
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user));
  const lexicalStatus = yield* recallIndexStatus(config, false).pipe(
    Effect.catch(cause =>
      Effect.succeed({
        documentCount: 0,
        ready: false,
        reason: errorMessage(cause),
      } satisfies RecallIndexStatus),
    ),
  );
  const checks: DoctorCheck[] = [
    {detail: options.dryRun ? 'dry run; no writes' : 'read-only checks', name: 'mode', status: 'ok'},
    {
      detail: platform,
      name: 'platform',
      status: ['darwin', 'linux', 'win32'].includes(platform) ? 'ok' : 'warn',
    },
    {
      detail: `v${system.runtimeVersion}; embedded in the Threadnote executable`,
      name: 'bun runtime',
      status: 'ok',
    },
  ];
  checks.push(yield* safeDoctorCheck('threadnote shim', commandShimCheck()));
  checks.push(yield* safeDoctorCheck('standalone process lifecycle', legacyProcessDoctorCheck(config)));
  checks.push(
    yield* safeDoctorCheck(
      'Threadnote home',
      fs.exists(config.agentContextHome).pipe(
        Effect.map(exists => ({
          detail: config.agentContextHome,
          name: 'Threadnote home',
          status: exists ? ('ok' as const) : ('warn' as const),
        })),
      ),
    ),
  );
  checks.push(
    yield* safeDoctorCheck('storage layout', layoutReceiptCheck(fs, path, config.agentContextHome)),
    yield* safeDoctorCheck('seed manifest', manifestCheck(config.manifestPath)),
    yield* safeDoctorCheck('local generation model', localAiDoctorCheck(config)),
    yield* telemetryDoctorCheck(config),
    yield* imageProjectionDoctorCheck(config),
  );
  const inferredMcpClients = yield* inferConfiguredMcpClients(config).pipe(Effect.orElseSucceed(() => []));
  checks.push(...(yield* safeDoctorChecks('MCP configuration', mcpConfigurationChecks(config, inferredMcpClients))));
  checks.push(
    recallIndexCheck(lexicalStatus),
    yield* safeDoctorCheck('embedding model', embeddingModelCheck(config)),
    yield* safeDoctorCheck('vector recall index', vectorRecallIndexCheck(config, lexicalStatus)),
    yield* safeDoctorCheck(
      'native code graph',
      options.withCodeGraphProgressLine === true && options.codeGraphCheck === undefined
        ? withProgressLine(formatCodeGraphDoctorProgressLine({current: 0, phase: 'checking', total: 1}), update =>
            codeGraphDoctorCheck(
              config.agentContextHome,
              progress => update(formatCodeGraphDoctorProgressLine(progress)),
              options.codeGraphCheck,
            ),
          )
        : codeGraphDoctorCheck(config.agentContextHome, options.onCodeGraphProgress, options.codeGraphCheck),
    ),
    yield* safeDoctorCheck('memory project consistency', memoryProjectConsistencyCheck(config)),
    yield* safeDoctorCheck('deferred code anchors', deferredCodeAnchorDoctorCheck(config)),
  );
  checks.push(...(yield* safeDoctorChecks('agent integrations', agentAdapterDoctorChecks(config, inferredMcpClients))));
  if (config.agentContextHome.endsWith('.openviking')) {
    checks.push({
      detail: 'THREADNOTE_HOME still targets a legacy .openviking directory; run `threadnote migrate`',
      name: 'legacy home override',
      status: 'fail',
    });
  }
  checks.push(
    yield* safeDoctorCheck(
      'canonical store',
      fs.exists(layout.canonicalRoot).pipe(
        Effect.map(exists => ({
          detail: layout.canonicalRoot,
          name: 'canonical store',
          status: exists ? ('ok' as const) : ('warn' as const),
        })),
      ),
    ),
  );
  return checks;
});

/** Read-only and fail-soft: doctor never creates consent state or contacts the configured endpoint. */
export const telemetryDoctorCheck = Effect.fn('lifecycle.telemetryDoctorCheck')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  const loaded = yield* Effect.result(readTelemetryConfiguration(config));
  if (Result.isFailure(loaded)) {
    const renewal = yield* readTelemetryConsentRenewal(config).pipe(Effect.orElseSucceed(() => undefined));
    if (renewal !== undefined) {
      return {
        detail: `disabled; consent v${renewal.consentVersion} needs explicit renewal for v${TELEMETRY_CONSENT_VERSION}; run \`threadnote telemetry enable\`, then \`threadnote telemetry enable --apply\` after review`,
        name: 'anonymous telemetry',
        status: 'warn' as const,
      };
    }
    return {
      detail: 'invalid or unreadable configuration; telemetry fails closed',
      name: 'anonymous telemetry',
      status: 'warn' as const,
    };
  }
  if (loaded.success?.enabled !== true) {
    return {
      detail: 'disabled; no telemetry is sent',
      name: 'anonymous telemetry',
      status: 'ok' as const,
    };
  }
  const optOut = telemetryEnvironmentOptOut(system.environment());
  return {
    detail:
      optOut === undefined
        ? `enabled by explicit consent${loaded.success.autoAccept === true ? ' with automatic future scope acceptance' : ''}; endpoint ${loaded.success.endpoint}`
        : `persisted consent enabled but suppressed by ${optOut}`,
    name: 'anonymous telemetry',
    status: 'ok' as const,
  };
});

function safeDoctorCheck<R>(
  name: string,
  check: Effect.Effect<DoctorCheck, unknown, R>,
): Effect.Effect<DoctorCheck, never, R> {
  return check.pipe(
    Effect.catch(cause =>
      Effect.succeed({
        detail: errorMessage(cause),
        name,
        status: 'fail' as const,
      }),
    ),
  );
}

function safeDoctorChecks<R>(
  name: string,
  checks: Effect.Effect<readonly DoctorCheck[], unknown, R>,
): Effect.Effect<readonly DoctorCheck[], never, R> {
  return checks.pipe(
    Effect.catch(cause => Effect.succeed([{detail: errorMessage(cause), name, status: 'fail' as const}])),
  );
}

export const runInstall = Effect.fn('lifecycle.install')(function* (config: RuntimeConfig, options: RunInstallOptions) {
  const dryRun = options.dryRun === true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const releaseRoot = options.skipReleaseLifecycle === true ? undefined : yield* toolRoot();
  if (releaseRoot !== undefined) {
    const legacyCleanup = yield* planLegacyInstallationCleanup();
    yield* withStandaloneInstallationLock(
      Effect.gen(function* () {
        yield* activateStandaloneRelease(releaseRoot, dryRun);
        yield* applyLegacyInstallationCleanup(legacyCleanup, dryRun);
        yield* installCommandShim(dryRun);
      }),
      dryRun,
    );
  }
  const layoutMigration = yield* migrateThreadnoteStorageLayout({
    apply: !dryRun,
    home: config.agentContextHome,
  });
  if (layoutMigration.action === 'dry_run') {
    yield* Console.log(
      `Would migrate ${layoutMigration.accounts} account(s) from the beta.1 canonical-store layout into ~/.threadnote/data.`,
    );
  } else if (layoutMigration.action === 'would_repair_marker') {
    yield* Console.log('Would restore the current Threadnote storage layout marker from its completed receipt.');
  } else if (layoutMigration.action === 'migrated' || layoutMigration.action === 'resumed') {
    yield* Console.log(
      `${layoutMigration.action === 'resumed' ? 'Resumed' : 'Migrated'} ${layoutMigration.accounts} account(s) into the Threadnote storage layout.`,
    );
  } else if (layoutMigration.action === 'repaired_marker') {
    yield* Console.log('Restored the current Threadnote storage layout marker from its completed receipt.');
  }
  const modelMigration = yield* migrateLegacyLocalModels({
    apply: !dryRun,
    home: config.agentContextHome,
  });
  if (modelMigration.action === 'dry_run') {
    yield* Console.log(`Would preserve installed local model(s): ${modelMigration.models.join(', ')}.`);
  } else if (modelMigration.action === 'migrated' || modelMigration.action === 'resumed') {
    yield* Console.log(`Preserved installed local model(s): ${modelMigration.models.join(', ')}.`);
  }
  yield* stopVerifiedLegacyLocalAi({dryRun});
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user));
  const directories = [
    layout.home,
    layout.canonicalRoot,
    layout.cacheRoot,
    layout.indexesRoot,
    layout.locksRoot,
    layout.logsRoot,
    layout.migrationRoot,
    layout.modelsRoot,
    layout.resourcesRoot,
    layout.sharesRoot,
    layout.temporaryRoot,
    layout.userMemoriesRoot,
  ];
  if (dryRun) {
    for (const directory of directories) yield* Console.log(`Would ensure private directory: ${directory}`);
    yield* Console.log(`Would write storage layout v${THREADNOTE_STORAGE_LAYOUT_VERSION} receipt.`);
  } else {
    for (const directory of directories) {
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    }
    yield* writeLayoutReceipt(fs, path, config.agentContextHome);
  }
  const embedding = yield* provisionCoreEmbedding(config, {dryRun});
  if (dryRun && options.skipRecallIndexes !== true) {
    yield* Console.log(
      `Would build the lexical SQLite index and ${embedding.manifest.id} vector index from canonical documents.`,
    );
  } else if (!dryRun && options.skipRecallIndexes !== true) {
    const {documentCount, vectors} = yield* maintainRecallIndexes(config, embedding.manifest, false);
    yield* Console.log(
      `Recall indexes ready: ${documentCount} lexical document(s), ${vectors.chunkCount} vector chunk(s).`,
    );
  }
  if (options.start !== false) {
    yield* Console.log(
      'Threadnote 4 uses local storage and a supervised on-demand inference worker; no background server is required.',
    );
  }
  if (options.printNextSteps !== false) {
    yield* Console.log(
      dryRun
        ? 'Dry run complete. Run without --dry-run to initialize the Threadnote home.'
        : 'Install complete. Semantic recall is ready. Next: `threadnote seed` to add repository resources.',
    );
  }
  if (releaseRoot !== undefined) {
    yield* withStandaloneInstallationLock(pruneStandaloneReleases(releaseRoot, dryRun), dryRun);
  }
  return embedding;
});

export const runRepair = Effect.fn('lifecycle.repair')(function* (config: RuntimeConfig, options: RunRepairOptions) {
  const dryRun = options.dryRun === true;
  yield* Console.log('Repairing the self-contained Threadnote home.');
  const embedding = yield* runInstall(config, {
    dryRun,
    printNextSteps: false,
    skipRecallIndexes: true,
    skipReleaseLifecycle: options.skipReleaseLifecycle,
    start: false,
  });
  if (!dryRun) {
    yield* maintainRecallIndexes(config, embedding.manifest, true).pipe(
      Effect.tap(({documentCount, vectors}) =>
        Console.log(
          `Rebuilt recall indexes for ${documentCount} document(s) and ${vectors.chunkCount} vector chunk(s).`,
        ),
      ),
      Effect.mapError(cause =>
        LifecycleOperationError.make({message: `Recall index repair failed: ${errorMessage(cause)}`}),
      ),
    );
  } else {
    yield* Console.log('Would validate and rebuild the derived lexical and vector recall indexes.');
  }
  if (options.coreOnly === true) {
    yield* Console.log('Skipping host instructions, hooks, and MCP client repair (--core-only).');
  }
  if (options.skipAgentIntegrations !== true && options.coreOnly !== true) {
    const inferredMcpClients = yield* inferConfiguredMcpClients(config);
    yield* migrateLegacyAgentIntegrations(config, inferredMcpClients, dryRun);
    const repairedIntegrationClients = yield* repairAgentIntegrations(config, dryRun);
    if (options.mcp === undefined || ['all', 'available'].includes(options.mcp.trim().toLowerCase())) {
      yield* repairRegisteredAgentAdapters(config, dryRun);
    }
    const registry = yield* readAgentIntegrationRegistry(config);
    const registeredClients = registry === undefined ? inferredMcpClients : registeredAgentClients(registry);
    const repairableClients = repairableAgentClients(registry);
    const receipts = Object.fromEntries(
      registeredClients.flatMap(agent =>
        registry?.hosts[agent]?.mcp === undefined ? [] : [[agent, registry.hosts[agent].mcp]],
      ),
    );
    const requestedMcpClients = options.mcp ?? (repairableClients.length === 0 ? 'none' : repairableClients.join(','));
    const mcpClients = yield* resolveMcpClients(requestedMcpClients, 'repair', receipts);
    yield* repairRegisteredMcpClients(config, registry, mcpClients, dryRun);
    if (
      repairedIntegrationClients.length === 0 &&
      registeredClients.length === 0 &&
      Object.keys(registry?.surfaces ?? {}).length === 0
    ) {
      yield* Console.log('No agent integrations are registered; skipping host-specific repair.');
    }
    if (yield* hasManagedClaudeHooks()) {
      yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun});
    }
    const ompHostRoot = registry?.hosts.omp?.mcp.hostRoot;
    if (yield* hasManagedOmpHooks(ompHostRoot)) {
      yield* runHooksInstall(config, 'omp', {apply: !dryRun, dryRun, hostRoot: ompHostRoot});
    }
  }
  let completion: CodeGraphRepairCompletion | undefined;
  yield* withProgressLine(
    formatCodeGraphRepairProgressLine({current: 0, phase: 'checking', total: 1}, dryRun),
    update =>
      repairCodeGraphIndexes(
        config.agentContextHome,
        dryRun,
        progress => update(formatCodeGraphRepairProgressLine(progress, dryRun)),
        result => Effect.sync(() => void (completion = result)),
        {migrateSchema: true, mode: options.deep === true ? 'deep' : 'quick'},
      ),
  ).pipe(
    Effect.mapError(cause =>
      LifecycleOperationError.make({message: `Native code graph repair failed: ${errorMessage(cause)}`}),
    ),
  );
  if (completion !== undefined) {
    yield* Console.log(codeGraphRepairSummaryMessage(completion.summary, dryRun));
    yield* runDoctor(config, {codeGraphCheck: completion.doctorCheck, dryRun, strict: false});
  }
  if (options.postUpdate !== false) {
    yield* maybeRunPostUpdateAfterRepair(config, {dryRun});
  }
});

export const repairRegisteredMcpClients = Effect.fn('lifecycle.repairRegisteredMcpClients')(function* (
  config: RuntimeConfig,
  registry: AgentIntegrationRegistry | undefined,
  mcpClients: readonly AgentClient[],
  dryRun: boolean,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const personalHome = isPersonalThreadnoteHome(config.agentContextHome, system.homeDirectory, (...parts) =>
    path.resolve(...parts),
  );
  for (const client of mcpClients) {
    const receipt = registry?.hosts[client];
    if (!personalHome && (client === 'cursor' || client === 'copilot')) {
      yield* Console.log(`Skipping ${client} MCP repair for non-personal THREADNOTE_HOME.`);
      continue;
    }
    if (receipt?.mcp.repair !== true || receipt.mcp.toolset === undefined) {
      yield* Console.log(
        `WARN ${client} MCP settings predate repair receipts; run threadnote mcp-install ${client} --apply to manage them.`,
      );
      continue;
    }
    yield* runMcpInstall(config, client, {
      apply: !dryRun,
      cwd: receipt.mcp.cwd,
      dryRunApplyCommand: 'threadnote repair',
      hostRoot: receipt.mcp.hostRoot,
      name: receipt.mcp.name,
      project: client === 'cursor' || client === 'copilot' || client === 'omp' ? receipt.mcp.cwd : undefined,
      scope: receipt.mcp.scope,
      toolset: receipt.mcp.toolset,
    });
  }
});

export const runDevelopmentInstallIntegrationActivation = Effect.fn(
  'lifecycle.developmentInstallIntegrationActivation',
)(function* (config: RuntimeConfig, expectedVersion: string) {
  const requireExpectedActive = Effect.gen(function* () {
    if ((yield* activeInstalledVersion()) !== expectedVersion) {
      return yield* LifecycleOperationError.make({
        message: 'The active release changed during development integration activation.',
      });
    }
  });
  yield* requireExpectedActive;
  const inferredMcpClients = yield* inferConfiguredMcpClients(config);
  yield* migrateLegacyAgentIntegrations(config, inferredMcpClients, false);
  yield* repairAgentIntegrations(config, false);
  yield* repairRegisteredAgentAdapters(config, false);
  const incomplete = (yield* agentAdapterDoctorChecks(config, inferredMcpClients, {
    includeRetainedUnsupported: false,
  })).filter(check => check.status !== 'ok');
  if (incomplete.length > 0) {
    return yield* LifecycleOperationError.make({
      message: `Development agent integration activation remains incomplete: ${incomplete
        .map(check => check.name)
        .join(', ')}.`,
    });
  }
  yield* requireExpectedActive;
});

/**
 * Repairs version-derived state while the development installer owns the
 * installation lock. Unlike ordinary repair, this never activates or prunes a
 * release, changes no host integration, and fails if the installer's exact
 * target is not active.
 */
export const runDevelopmentInstallRepair = Effect.fn('lifecycle.developmentInstallRepair')(function* (
  config: RuntimeConfig,
  expectedVersion: string,
) {
  const requireExpectedActive = Effect.gen(function* () {
    if ((yield* activeInstalledVersion()) !== expectedVersion) {
      return yield* LifecycleOperationError.make({
        message: 'The active release changed during development installer repair.',
      });
    }
  });
  yield* requireExpectedActive;
  yield* runRepair(config, {
    mcp: 'none',
    skipAgentIntegrations: true,
    postUpdate: false,
    skipReleaseLifecycle: true,
  });
  yield* requireExpectedActive;
});

export function runDevelopmentInstallMaintenance(
  config: RuntimeConfig,
  expectedVersion: string,
  activateIntegrations: boolean,
) {
  return activateIntegrations
    ? runDevelopmentInstallIntegrationActivation(config, expectedVersion)
    : runDevelopmentInstallRepair(config, expectedVersion);
}

const maintainRecallIndexes = Effect.fn('lifecycle.maintainRecallIndexes')(function* (
  config: RuntimeConfig,
  manifest: LocalModelManifest,
  forceRefresh: boolean,
) {
  return yield* Effect.acquireUseRelease(
    startProgress(`${forceRefresh ? 'Rebuilding' : 'Building'} lexical recall index from canonical documents.`),
    progress =>
      Effect.gen(function* () {
        const updateProgress = (message: string) => progress.update(message).pipe(Effect.ignore);
        for (
          let completedRetries = 0;
          completedRetries <= RECALL_INDEX_MAINTENANCE_GENERATION_RETRY_LIMIT;
          completedRetries += 1
        ) {
          const attempt = yield* Effect.gen(function* () {
            const index = yield* loadRecallIndexData(config, {
              forceRefresh,
              includeInactive: false,
              onProgress: state => updateProgress(recallProgressMessage(state)),
            });
            yield* updateProgress(
              `Preparing vector recall index for ${index.candidates.length} lexical document(s) with ${manifest.id}.`,
            );
            const vectors = yield* ensureVectorIndex(config, manifest, index.candidates, {
              corpusGeneration: index.generation,
              currentCorpusGeneration: () => currentRecallCorpusGeneration(config),
              onProgress: state => updateProgress(vectorProgressMessage(state)),
            });
            yield* verifyRecallIndexMaintenanceReadiness({
              manifestId: manifest.id,
              readLexicalStatus: () => recallIndexStatus(config, false),
              readVectorReadiness: () =>
                vectorIndexGenerationReadiness(config.agentContextHome, manifest, index.generation),
              requestedGeneration: index.generation,
            });
            return {documentCount: index.candidates.length, vectors};
          }).pipe(Effect.result);
          if (Result.isSuccess(attempt)) return attempt.success;
          if (!recallIndexMaintenanceShouldRetry(attempt.failure, completedRetries)) {
            return yield* Effect.fail(attempt.failure);
          }
          yield* updateProgress('Canonical documents changed during vector work; rebuilding current recall indexes.');
        }
        return yield* Effect.die(new Error('Recall index maintenance retry loop exhausted without a result.'));
      }),
    progress => progress.stop,
  );
});

function vectorProgressMessage(progress: VectorIndexProgress): string {
  if (progress.phase === 'activating') {
    return `Activating vector recall index with ${progress.chunkCount} chunk(s).`;
  }
  const percentage = progress.total === 0 ? 100 : Math.floor((progress.completed / progress.total) * 100);
  return `Building vector recall index: ${progress.completed}/${progress.total} new chunk(s) embedded (${percentage}%), ${progress.reused} unchanged chunk(s) reused.`;
}

function recallProgressMessage(progress: RecallIndexProgress): string {
  if (progress.phase === 'activating') {
    return `Activating lexical recall index with ${progress.documentCount} document(s).`;
  }
  const percentage = progress.total === 0 ? 100 : Math.floor((progress.completed / progress.total) * 100);
  if (progress.phase === 'indexing') {
    return `Building lexical recall index: ${progress.completed}/${progress.total} changed document(s) indexed (${percentage}%; ${progress.scanned} canonical document(s) scanned).`;
  }
  return `Writing lexical recall postings: ${progress.completed}/${progress.total} changed document(s) (${percentage}%), ${progress.removed} stale document(s) removed.`;
}

function codeGraphRepairSummaryMessage(
  summary: {
    readonly databases: number;
    readonly deferredDatabases: number;
    readonly discarded: number;
    readonly migratedDatabases: number;
    readonly obsoleteStoreBytes: number;
    readonly obsoleteStoreCheckouts: number;
    readonly obsoleteStoreFiles: number;
    readonly removedIncompleteSnapshots: number;
    readonly removedTemporaryFiles: number;
    readonly unsafeObsoleteEntries: number;
  },
  dryRun: boolean,
): string {
  return (
    `${dryRun ? 'Would repair' : 'Repaired'} ${summary.databases} native code graph database(s): ` +
    (summary.deferredDatabases > 0 ? `${summary.deferredDatabases} deferred, ` : '') +
    (summary.migratedDatabases > 0 ? `${summary.migratedDatabases} schema migration(s), ` : '') +
    `${summary.discarded} disposable rebuild(s), ` +
    `${summary.removedIncompleteSnapshots} incomplete snapshot(s), ` +
    `${summary.removedTemporaryFiles} temporary graph file(s).` +
    (summary.obsoleteStoreFiles > 0
      ? ` Preserved ${summary.obsoleteStoreFiles} obsolete store file(s), ${summary.obsoleteStoreBytes} byte(s), ` +
        `across ${summary.obsoleteStoreCheckouts} checkout(s); remove explicitly with \`threadnote graph purge --obsolete\`.`
      : '') +
    (summary.unsafeObsoleteEntries > 0
      ? ` ${summary.unsafeObsoleteEntries} unsafe obsolete-shaped entry/entries require manual review.`
      : '')
  );
}

export const runStart = Effect.fn('lifecycle.start')(function* (_config: RuntimeConfig, options: StartOptions) {
  yield* Console.log(
    options.dryRun
      ? 'Would verify the self-contained runtime; no daemon would be started.'
      : 'Threadnote is self-contained and starts on demand; no daemon is required.',
  );
});

export const runStop = Effect.fn('lifecycle.stop')(function* (_config: RuntimeConfig, options: ForgetOptions) {
  yield* Console.log(
    options.dryRun
      ? 'Would stop no services; Threadnote owns no daemon.'
      : 'No Threadnote daemon is running. Native resources exit with their CLI, MCP, or manager process.',
  );
});

export const runUninstall = Effect.fn('lifecycle.uninstall')(function* (
  config: RuntimeConfig,
  options: UninstallOptions,
) {
  const dryRun = options.dryRun === true;
  const uninstall = runUninstallInTransaction(config, options);
  yield* dryRun
    ? uninstall
    : withSetupMutationLock(config.agentContextHome, withAgentIntegrationLock(config, uninstall));
});

const runUninstallInTransaction = Effect.fn('lifecycle.uninstallInTransaction')(function* (
  config: RuntimeConfig,
  options: UninstallOptions,
) {
  const dryRun = options.dryRun === true;
  if (options.eraseMemories === true && options.preserveMemories === true) {
    return yield* LifecycleOperationError.make({
      message: 'Use either --erase-memories or --preserve-memories, not both.',
    });
  }
  const registry = yield* readAgentIntegrationRegistry(config);
  const registeredClients = registeredAgentClients(registry);
  if (
    Object.keys(registry?.surfaces ?? {}).length > 0 &&
    options.mcp !== undefined &&
    !['all', 'available'].includes(options.mcp.trim().toLowerCase())
  ) {
    return yield* LifecycleOperationError.make({
      message:
        'Managed agent surfaces remain outside the requested MCP selection; remove them with threadnote agents remove <surface> --apply first, or uninstall without --mcp.',
    });
  }
  const selectedMcpClients =
    options.mcp ?? (registeredClients.length === 0 ? 'available' : registeredClients.join(','));
  const receipts = Object.fromEntries(
    registeredClients.flatMap(agent =>
      registry?.hosts[agent]?.mcp === undefined ? [] : [[agent, registry.hosts[agent].mcp]],
    ),
  );
  const removedClients = yield* removeMcpConfigs(selectedMcpClients, dryRun, receipts);
  const retainedClients = registeredClients.filter(client => !removedClients.includes(client));
  if (retainedClients.length > 0) {
    const message =
      `Could not remove MCP configuration for ${retainedClients.join(', ')}; ` +
      'preserving command launchers, host artifacts, and receipts for retry.';
    if (dryRun) {
      yield* Console.log(`WARN ${message}`);
      return;
    }
    return yield* LifecycleOperationError.make({message: message});
  }
  yield* removeMcpSnippets(config, dryRun);
  if (yield* hasManagedClaudeHooks()) {
    yield* runHooksInstall(config, 'claude', {apply: !dryRun, dryRun, remove: true, setupLockHeld: !dryRun});
  }
  if (yield* hasManagedCursorHooks()) {
    yield* runHooksInstall(config, 'cursor', {apply: !dryRun, dryRun, remove: true, setupLockHeld: !dryRun});
  }
  const ompHostRoot = registry?.hosts.omp?.mcp.hostRoot;
  if (yield* hasManagedOmpHooks(ompHostRoot)) {
    yield* runHooksInstall(config, 'omp', {
      apply: !dryRun,
      dryRun,
      hostRoot: ompHostRoot,
      remove: true,
      setupLockHeld: !dryRun,
    });
  }
  yield* removeRegisteredAgentAdaptersInTransaction(config, dryRun, true);
  yield* removeCommandShim(dryRun);
  yield* removeAgentIntegrationsInTransaction(config, dryRun);
  if (options.eraseMemories === true) {
    yield* eraseThreadnoteHome(config.agentContextHome, dryRun);
  } else {
    yield* Console.log(`Preserving Threadnote home: ${config.agentContextHome}`);
  }
  yield* Console.log('Uninstall complete. Remove versioned standalone release directories separately if desired.');
});

export const memoryProjectConsistencyCheck = Effect.fn('lifecycle.memoryProjectConsistencyCheck')(function* (
  config: RuntimeConfig,
) {
  const name = 'memory project consistency';
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user));
  if (!(yield* fs.exists(layout.userMemoriesRoot))) {
    return {detail: 'no memories directory yet', name, status: 'ok' as const};
  }
  return yield* Effect.gen(function* () {
    const entries = yield* fs.readDirectory(layout.userMemoriesRoot, {recursive: true});
    const mismatches: string[] = [];
    let checked = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry.endsWith('.summary.md') || entry.endsWith('.overview.md')) continue;
      const uri = `threadnote://user/${uriSegment(config.user)}/memories/${entry.split(path.sep).join('/')}`;
      const pathProject = memoryUriProjectSegment(uri);
      if (!pathProject) continue;
      const content = yield* fs
        .readFileString(path.join(layout.userMemoriesRoot, entry))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (content === undefined) continue;
      checked += 1;
      const frontProject = memoryFrontmatterField(content, 'project');
      if (frontProject && uriSegment(frontProject) !== pathProject) {
        mismatches.push(`${uri} (frontmatter "${frontProject}" vs path "${pathProject}")`);
      }
    }
    if (mismatches.length === 0) {
      return {detail: `${checked} project-scoped memories consistent`, name, status: 'ok' as const};
    }
    const sample = mismatches.slice(0, 3).join('; ');
    const extra = Math.max(0, mismatches.length - 3);
    return {
      detail:
        `${mismatches.length} memory(ies) whose frontmatter project differs from their storage path: ` +
        `${sample}${extra > 0 ? `, +${extra} more` : ''}`,
      name,
      status: 'warn' as const,
    };
  }).pipe(Effect.catch(cause => Effect.succeed({detail: errorMessage(cause), name, status: 'warn' as const})));
});

function manifestCheck(manifestPath: string) {
  return readSeedManifest(manifestPath).pipe(
    Effect.as({detail: manifestPath, name: 'seed manifest', status: 'ok' as const}),
    Effect.catch(cause =>
      Effect.succeed({
        detail: errorMessage(cause),
        name: 'seed manifest',
        status: 'warn' as const,
      }),
    ),
  );
}

function recallIndexCheck(status: RecallIndexStatus): DoctorCheck {
  if (!status.ready) {
    return {
      detail: status.reason ?? 'not ready; run `threadnote repair`',
      name: 'lexical recall index',
      status: 'fail',
    };
  }
  const skipped = status.skippedOversizedDocumentCount ?? 0;
  return {
    detail:
      `${status.documentCount} canonical document(s); generation ${status.generation ?? 'unknown'}` +
      (skipped > 0 ? `; ${skipped} document(s) over 512 KiB omitted` : ''),
    name: 'lexical recall index',
    status: skipped > 0 ? 'warn' : 'ok',
  };
}

function embeddingModelCheck(config: RuntimeConfig) {
  return Effect.gen(function* () {
    const selection = yield* readModelSelection(config.agentContextHome);
    const modelId = selection.roles.embedding;
    if (!modelId) {
      return {
        detail: 'missing; run `threadnote repair` to install the core embedding model',
        name: 'embedding model',
        status: 'fail' as const,
      };
    }
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(modelId);
    if (manifest.role !== 'embedding') {
      return {detail: `${modelId} is not an embedding model`, name: 'embedding model', status: 'fail' as const};
    }
    const store = yield* LocalModelStore;
    const installed = yield* store.status(config.agentContextHome, manifest);
    if (!installed.installed || installed.bytes !== manifest.size) {
      return {
        detail: `${manifest.id} is not installed or has an unexpected size; run \`threadnote repair\``,
        name: 'embedding model',
        status: 'fail' as const,
      };
    }
    if ((yield* sha256FileHex(installed.path)) !== manifest.sha256) {
      return {
        detail: `${manifest.id} failed verification; run \`threadnote repair\``,
        name: 'embedding model',
        status: 'fail' as const,
      };
    }
    return {
      detail: `${manifest.id}; ${manifest.dimensions ?? 0} dimensions; verified`,
      name: 'embedding model',
      status: 'ok' as const,
    };
  });
}

function vectorRecallIndexCheck(config: RuntimeConfig, lexicalStatus: RecallIndexStatus) {
  return Effect.gen(function* () {
    if (!lexicalStatus.ready || !lexicalStatus.generation) {
      return {
        detail: 'unavailable until the lexical recall index is ready',
        name: 'vector recall index',
        status: 'fail' as const,
      };
    }
    const selection = yield* readModelSelection(config.agentContextHome);
    const modelId = selection.roles.embedding;
    if (!modelId) {
      return {
        detail: 'unavailable until the core embedding model is installed',
        name: 'vector recall index',
        status: 'fail' as const,
      };
    }
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(modelId);
    const status = yield* vectorIndexStatus(config.agentContextHome, manifest);
    const currentGeneration =
      status.ready &&
      (yield* vectorIndexMatchesGeneration(config.agentContextHome, manifest, lexicalStatus.generation));
    return status.ready
      ? currentGeneration
        ? {
            detail: `${status.chunkCount} chunk(s); ${manifest.id}; generation ${status.generation ?? 'unknown'}`,
            name: 'vector recall index',
            status: 'ok' as const,
          }
        : {
            detail: `${manifest.id}; stale; canonical documents changed; run \`threadnote repair\``,
            name: 'vector recall index',
            status: 'fail' as const,
          }
      : {
          detail: `${manifest.id}; ${status.reason ?? 'not built'}; run \`threadnote repair\``,
          name: 'vector recall index',
          status: 'fail' as const,
        };
  });
}

function layoutReceiptCheck(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const receiptPath = path.join(home, LAYOUT_RECEIPT);
    if (!(yield* fs.exists(receiptPath))) {
      return {
        detail: 'missing; run `threadnote install`',
        name: 'storage layout',
        status: 'warn',
      } satisfies DoctorCheck;
    }
    const raw = yield* fs.readFileString(receiptPath);
    const parsed = Result.try(() => JSON.parse(raw) as unknown);
    return Result.isSuccess(parsed) && isThreadnoteStorageLayoutReceipt(parsed.success)
      ? ({
          detail: `version ${THREADNOTE_STORAGE_LAYOUT_VERSION}`,
          name: 'storage layout',
          status: 'ok',
        } satisfies DoctorCheck)
      : ({
          detail: 'invalid or unsupported receipt',
          name: 'storage layout',
          status: 'fail',
        } satisfies DoctorCheck);
  });
}

function writeLayoutReceipt(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const target = path.join(home, LAYOUT_RECEIPT);
    const temporary = path.join(home, `.${LAYOUT_RECEIPT}.${system.processId}.tmp`);
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION}, undefined, 2)}\n`,
      {mode: 0o600},
    );
    yield* fs.rename(temporary, target);
  });
}

function eraseThreadnoteHome(home: string, dryRun: boolean) {
  return Effect.gen(function* () {
    const ownedHome = yield* assertSafeThreadnoteHomeForErase(home);
    if (dryRun) {
      yield* Console.log(`Would erase Threadnote home: ${ownedHome}`);
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(ownedHome, {recursive: true});
    yield* Console.log(`Erased Threadnote home: ${ownedHome}`);
  });
}
