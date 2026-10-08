import {sourceAddFlags} from '../integrations/cli.js';
import {makeContextRuntimeCommand} from './context_cli.js';
import {makeCompactCommand, makeRecallFeedbackCommand, makeValueCommand} from './workflow_cli.js';
import * as hooksCli from './hooks_cli.js';
import {agentsCommandMetadata, makeAgentsCommand} from './agents_cli.js';
import {makeSetupCommand, setupCommandMetadata} from './setup_cli.js';
import {guidanceCommandMetadata, makeGuidanceCommand} from './guidance_cli.js';
import {makeDevelopmentInstallRepairCommand} from './development_install_cli.js';
import {runCursorHook} from '../cursor/hook_runner.js';
import {Console, Effect, Schema} from 'effect';
import {Argument, CliError, Command, Flag} from 'effect/cli';
import {THREADNOTE_MCP_NAME} from '../constants.js';
import {makeComposerAttachFlags} from './composer/attach_flags.js';
import {runHooksInstall, runPreCompactHook, runSessionStartHook} from '../hooks.js';
import {
  runDevelopmentInstallMaintenance,
  runDoctor,
  runInstall,
  runRepair,
  runStart,
  runStop,
  runUninstall,
} from '../lifecycle.js';
import {
  ensureLocalAiStarted,
  readLocalAiSettings,
  runLocalAiDisable,
  runLocalAiEnable,
  runLocalAiInstall,
  runLocalAiModelSwitch,
  runLocalAiStart,
  runLocalAiStatus,
  runLocalAiStop,
  runLocalAiUninstall,
} from './local-ai.js';
import {makeJevCommand} from './jev_cli.js';
import {makeImageProjectionCommand} from './image_projection_cli.js';
import {
  runArchive,
  runCompact,
  runEnrichMemories,
  runExportPack,
  runForget,
  runFinalizeCodeRefs,
  runHandoff,
  runImportPack,
  runList,
  runMigrateLifecycle,
  runMigrateMemories,
  runMigrateProjectNames,
  parseMemoryKind,
  parseMemoryStatus,
  runRead,
  runRecall,
  runRemember,
} from '../memory/index.js';
import {runRecallFeedback} from '../recall/feedback_commands.js';
import {makeCloseoutCommand} from './closeout_cli.js';
import {wakeContextMaintenance} from '../memory/context/maintenance.js';
import {runProcedurePublish, runProcedureStatus, runProcedureVerify} from '../procedure/commands.js';
import {runMcpInstall} from '../mcp/index.js';
import {runObsidianInboxScan} from '../integrations/obsidian/inbox.js';
import {runObsidianOpen} from '../integrations/obsidian/open.js';
import {
  runObsidianProjectionAdd,
  runObsidianProjectionList,
  runObsidianProjectionPublish,
  runObsidianProjectionRemove,
  runObsidianProjectionStatus,
  runObsidianProjectionSync,
} from '../integrations/obsidian/projection.js';
import {
  runSourceAdd,
  runSourceInventory,
  runSourceList,
  runSourceRemove,
  runSourceStatus,
  runSourceSync,
} from '../integrations/source.js';
import {ensureUserManifestRuntimeConfig, getRuntimeConfig} from '../runtime.js';
import {runInitManifest, runSeed, runSeedSkills} from '../seeding.js';
import {makeWorksetCommand} from './workset_cli.js';
import {makeProjectCommand} from './project_cli.js';
import {makeCodeGraphScopeCommand} from './graph_scope_cli.js';
import {
  runShareConflictResolve,
  runShareConflicts,
  runShareConflictShow,
  runShareInit,
  runShareInstallArtifacts,
  runShareList,
  runSharePublish,
  runSharePublishArtifact,
  runSharePublishBundle,
  runShareRemove,
  runShareRename,
  runShareSetAccess,
  runShareSetUrl,
  runShareStatus,
  runShareSync,
  runShareUnpublish,
} from './share.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {maybeNotifyUpdate, maybeRunPostUpdateAfterRepair, runPostUpdate} from '../release/index.js';
import {errorMessage} from '@threadnote/platform/errors';
import {runVersion} from '../release/version/command.js';
import {runManage} from '../manager/index.js';
import {applicationError} from '@threadnote/platform/errors';
import {runHomeMigration} from '../migration/home.js';
import {
  runModelInstall,
  runModelList,
  runModelRemove,
  runModelRuntimeStatus,
  runModelSelect,
  runModelVerify,
} from '../models/commands.js';
import {runIndexPurge, runIndexRebuild, runIndexStatus, runIndexVerify} from '../search/commands.js';
import {runProductionLogs} from './production_log.js';
import {runReportIssue} from '../report_issue.js';
import {
  runCodeGraphAnalysis,
  runCodeGraphCompact,
  runCodeGraphDiagnostics,
  runCodeGraphExport,
  runCodeGraphImpact,
  runCodeGraphIndex,
  runCodeGraphInventory,
  runCodeGraphInspect,
  runCodeGraphPurge,
  runCodeGraphRemoveView,
  runCodeGraphRepair,
  runCodeGraphReport,
  runCodeGraphStatus,
  runCodeGraphWatch,
  runCodeGraphWorksetTopology,
} from '../code_graph/commands.js';
import {
  runCodeGraphCheckpointExport,
  runCodeGraphCheckpointImport,
  runCodeGraphCheckpointInspect,
  runCodeGraphCheckpointVerify,
} from '../code_graph/checkpoint/commands.js';
import {makeComposerCommands} from './composer/cli.js';
import {makeActivationCommand} from './activation_cli.js';
import {makeProcedureCommand} from './procedure_cli.js';
import {makeGraphSharingCommands} from '../code_graph/sharing/cli.js';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_MAXIMUM_ESTIMATED_TOKENS,
  CODE_GRAPH_WORKSET_EVIDENCE_MINIMUM_ESTIMATED_TOKENS,
} from '@threadnote/graph/workset/evidence';
import {runProcessDiagnostics} from '../process/diagnostics.js';
import {runCodeBriefEditHook} from '../context_brief/edit_hook.js';
import {runCodexResumeHook} from '../codex/resume_hook.js';
import {runImageProjectionCommand} from '../image_projection/commands.js';
import {runTelemetryDisable, runTelemetryEnable, runTelemetryStatus} from '../telemetry/commands.js';
import * as valueReportCommands from '../value_report/commands.js';
import {runPilotCommand, withPilotHome} from '../value_report/pilot/commands.js';
import {runKnowledgeDeltaGitProposalExport, runKnowledgeDeltaGitProposalMaterialize} from '../git_proposal/commands.js';
import {makeShareMemoryCommands, publishFlags} from './share/memory_cli.js';
import {initializeAutoUpdatePolicy, runAutoUpdateWorker, runThreadnoteUpdateCommand} from '../release/auto_update.js';
import {
  cursorCloudRuntimeConfig,
  runCursorCloudBootstrap,
  runCursorCloudConfig,
  runCursorCloudVerify,
} from '../cursor/cloud.js';
import {runCursorAttestationCommand} from '../cursor/cloud_attestation.js';
import {
  makeCursorCloudAttestCommand,
  makeCursorCloudIdentityFlags,
  makeCursorCloudModeFlag,
  makeCursorCloudRemoteConfigFlags,
} from './cursor_cloud_cli.js';
import {
  makeCliInvocationInspector,
  normalizeCliArguments,
  type CliInvocationInspection,
  type ProductionLogMode,
} from './cli/invocation.js';
import {
  argument,
  boolean,
  defaultChoice,
  defaultString,
  describeFlag,
  integerFlag,
  negatedBoolean,
  optional,
  optionalArgument,
  optionalChoice,
  optionalString,
  repeatedString,
  requiredChoice,
  requiredString,
  withValueAlias,
} from './cli/flags.js';
import {
  codeGraphCliBounds as graphBounds,
  codeGraphFreshnessFlag as graphFreshness,
  codeGraphStatusFlags,
} from './code_graph_cli_flags.js';

const root = Command.make('threadnote').pipe(
  Command.withSharedFlags({
    home: optionalString('home', 'Override the Threadnote data home; not the standalone installation root'),
    manifest: optionalString('manifest', 'Override THREADNOTE_MANIFEST for this invocation'),
  }),
);
const withRuntimeEffect = <E, R>(
  effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>,
  manifestOverride?: string,
) =>
  Effect.flatMap(root, options =>
    getRuntimeConfig(options, manifestOverride).pipe(
      Effect.mapError(cause => applicationError('load runtime configuration', cause)),
      Effect.flatMap(effect),
    ),
  );
const withMutationRuntimeEffect = <E, R>(effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>) =>
  withRuntimeEffect(config =>
    effect(config).pipe(Effect.tap(() => wakeContextMaintenance(config).pipe(Effect.ignore))),
  );
export type CliRuntimeRunner = typeof withRuntimeEffect;
export type CliMutationRuntimeRunner = typeof withMutationRuntimeEffect;
const withManifestManagementRuntimeEffect = <E, R>(effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>) =>
  withRuntimeEffect(config => ensureUserManifestRuntimeConfig(config).pipe(Effect.flatMap(effect)));
const manage = Command.make(
  'manage',
  {
    open: negatedBoolean('open', 'Start the manager without opening a browser'),
    uiPort: optional(
      describeFlag(
        integerFlag('ui-port').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 65_535})))),
        'Port for the local manager UI; defaults to a random free port',
      ),
    ),
  },
  options => withManifestManagementRuntimeEffect(config => runManage(config, options)),
).pipe(Command.withDescription('Open the local Threadnote web manager'));
const processes = Command.make(
  'processes',
  {
    json: boolean('json', 'Emit versioned machine-readable JSON'),
  },
  options => withRuntimeEffect(config => runProcessDiagnostics(config, options)),
).pipe(
  Command.withDescription('Show privacy-safe roles, relationships, age, operations, and memory for live processes'),
);
const doctor = Command.make(
  'doctor',
  {
    dryRun: boolean('dry-run', 'Show checks without writing anything'),
    strict: boolean('strict', 'Exit non-zero if any check fails'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        yield* runDoctor(config, options);
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(Command.withDescription('Check local prerequisites, config files, manifest shape, and server health'));

const install = Command.make(
  'install',
  {
    dryRun: boolean('dry-run', 'Print the actions without making changes'),
    force: boolean('force', 'Re-assert the Threadnote-owned layout and configuration'),
    start: negatedBoolean('start', 'Skip the local runtime readiness message'),
    withHooks: boolean(
      'with-hooks',
      'Also install agent-side hooks for deterministic handoff snapshots and context preload',
    ),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        yield* runInstall(config, options);
        if (!options.dryRun) yield* initializeAutoUpdatePolicy('automatic');
        yield* maybeRunPostUpdateAfterRepair(config, {dryRun: options.dryRun});
        if (options.withHooks) {
          for (const agent of ['claude', 'codex', 'cursor', 'copilot', 'omp'] as const) {
            yield* Console.log(`\n--- ${agent} hooks ---`);
            yield* runHooksInstall(config, agent, {apply: !options.dryRun, dryRun: options.dryRun});
          }
        }
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(
  Command.withDescription(
    'Initialize the Threadnote data home and maintain the shared standalone installation and user integrations',
  ),
);

const version = Command.make(
  'version',
  {
    allowUntrustedSource: boolean('allow-untrusted-source', 'Allow a non-default release API source'),
    source: optionalString('source', 'GitHub-compatible releases API URL'),
  },
  options => withRuntimeEffect(config => runVersion(config, options)),
).pipe(Command.withDescription('Print the installed Threadnote version, latest release, and release notes'));

const logs = Command.make('logs', {}, () => withRuntimeEffect(runProductionLogs)).pipe(
  Command.withDescription('Show privacy-safe rotating production log files for support'),
);

const telemetryStatus = Command.make('status', {}, () => withRuntimeEffect(config => runTelemetryStatus(config))).pipe(
  Command.withDescription('Show effective consent, endpoint, data categories, and environment opt-outs'),
);
const telemetryEnable = Command.make(
  'enable',
  {
    apply: boolean('apply', 'Persist explicit telemetry consent'),
    autoAccept: boolean('auto-accept', 'Keep telemetry enabled through future data-contract updates'),
    endpoint: optionalString('endpoint', 'OTLP/HTTP traces endpoint; HTTPS required except for loopback'),
  },
  options => withRuntimeEffect(config => runTelemetryEnable(config, options)),
).pipe(Command.withDescription('Preview or enable anonymous CLI and MCP operational telemetry'));

const telemetryDisable = Command.make('disable', {apply: boolean('apply', 'Persist telemetry opt-out')}, options =>
  withRuntimeEffect(config => runTelemetryDisable(config, options)),
).pipe(Command.withDescription('Preview or disable all anonymous operational telemetry'));

const telemetry = Command.make('telemetry').pipe(
  Command.withDescription('Manage optional anonymous CLI and MCP operational telemetry'),
  Command.withSubcommands([telemetryStatus, telemetryEnable, telemetryDisable]),
);

const imageProjection = makeImageProjectionCommand(options =>
  withRuntimeEffect(config => runImageProjectionCommand(config, options)),
);

const reportIssue = Command.make(
  'report-issue',
  {
    approval: optionalString('approval', 'Digest printed by the exact issue preview'),
    apply: boolean('apply', 'Create the GitHub issue after reviewing the preview'),
    body: requiredString('body', 'Public issue description'),
    includeLogs: boolean('include-logs', 'Include bounded privacy-safe production logs in the issue body'),
    title: requiredString('title', 'Public issue title'),
  },
  options => withRuntimeEffect(config => runReportIssue(config, options)),
).pipe(Command.withDescription('Preview or create a support issue in threadnote/threadnote'));

const update = Command.make(
  'update',
  {
    allowUntrustedSource: boolean('allow-untrusted-source', 'Allow a non-default release API source'),
    auto: optionalChoice('auto', ['on', 'off'], 'Persist automatic updates as on or off'),
    beta: boolean('beta', 'Follow the beta channel: install the newest stable or prerelease release'),
    check: boolean('check', 'Only check whether a newer version is available'),
    dryRun: boolean('dry-run', 'Print update and repair commands without running them'),
    force: boolean('force', 'Reinstall the selected standalone release even if already current'),
    json: boolean('json', 'Emit versioned machine-readable status or update-check output'),
    postUpdate: negatedBoolean('post-update', 'Skip post-update migration prompts'),
    repair: negatedBoolean('repair', 'Skip threadnote repair after updating the package'),
    source: optionalString('source', 'GitHub-compatible releases API URL'),
    stable: boolean('stable', 'Switch to the latest stable release'),
    status: boolean('status', 'Show automatic update policy and the last background result'),
    yes: boolean('yes', 'Accept applicable post-update actions without prompting'),
  },
  options => withRuntimeEffect(config => runThreadnoteUpdateCommand(config, options)),
).pipe(Command.withDescription('Install a verified standalone Threadnote release, then repair local integrations'));

const autoUpdateWorker = Command.make('auto-update-worker', {}, () =>
  withRuntimeEffect(config => runAutoUpdateWorker(config).pipe(Effect.asVoid)),
).pipe(Command.withDescription('Run one coordinated automatic update attempt'), Command.unlisted);

const postUpdate = Command.make(
  'post-update',
  {
    dryRun: boolean('dry-run', 'Print post-update actions without running them'),
    fromVersion: requiredString('from-version', 'Version before update'),
    toVersion: requiredString('to-version', 'Version after update'),
    yes: boolean('yes', 'Accept applicable post-update actions without prompting'),
  },
  options => withRuntimeEffect(config => runPostUpdate(config, options)),
).pipe(Command.withDescription('Run packaged post-update action prompts'), Command.unlisted);

const developmentInstallRepair = makeDevelopmentInstallRepairCommand(options =>
  withRuntimeEffect(config =>
    runDevelopmentInstallMaintenance(config, options.expectedVersion, options.activateIntegrations),
  ),
);

const repair = Command.make(
  'repair',
  {
    coreOnly: boolean('core-only', 'Repair core state and indexes without host instructions, hooks, or MCP settings'),
    deep: boolean('deep', 'Run explicit full SQLite integrity, foreign-key, and derived-state cleanup checks'),
    dryRun: boolean('dry-run', 'Print the repair actions without making changes'),
    mcp: defaultString(
      'mcp',
      'MCP clients: available, all, none, codex, claude, cursor, copilot, omp, or comma-separated list',
      'available',
    ),
    postUpdate: negatedBoolean('post-update', 'Skip post-update migration prompts after repair'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        yield* runRepair(config, options);
        if ((yield* readLocalAiSettings(config))?.enabled === true) {
          if (options.dryRun) {
            yield* runLocalAiStart(config, {dryRun: true});
          } else {
            yield* ensureLocalAiStarted(config).pipe(
              Effect.catch(error => Console.warn(`WARN could not repair local AI health: ${errorMessage(error)}`)),
            );
          }
        }
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(Command.withDescription('Repair Threadnote storage, derived indexes, hooks, and MCP configuration'));

const start = Command.make(
  'start',
  {
    dryRun: boolean('dry-run', 'Print the start command without running it'),
    foreground: boolean('foreground', 'Deprecated compatibility flag; Threadnote runs in the invoking process'),
    launchd: boolean('launchd', 'Deprecated compatibility flag; Threadnote has no LaunchAgent'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        const localAiConfigured = (yield* readLocalAiSettings(config))?.enabled === true;
        if (options.foreground && localAiConfigured) {
          yield* runLocalAiStart(config, options);
        }
        yield* runStart(config, options);
        if (!options.foreground && localAiConfigured) {
          yield* runLocalAiStart(config, options);
        }
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(Command.withDescription('Verify runtime readiness (no daemon is required)'));

const stop = Command.make(
  'stop',
  {dryRun: boolean('dry-run', 'Print the stop actions without running them')},
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        if (yield* readLocalAiSettings(config)) {
          yield* runLocalAiStop(config, options);
        }
        yield* runStop(config, options);
      }),
    ),
).pipe(Command.withDescription('Compatibility command; Threadnote owns no daemon'));

const uninstall = Command.make(
  'uninstall',
  {
    dryRun: boolean('dry-run', 'Print uninstall actions without making changes'),
    eraseMemories: boolean('erase-memories', 'Delete THREADNOTE_HOME, including all Threadnote memories and models'),
    mcp: defaultString(
      'mcp',
      'MCP clients to remove: available, all, none, codex, claude, cursor, copilot, omp, or comma-separated list',
      'available',
    ),
    preserveMemories: boolean('preserve-memories', 'Preserve THREADNOTE_HOME and Threadnote memories (default)'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        if (yield* readLocalAiSettings(config)) {
          yield* runLocalAiStop(config, options);
        }
        yield* runUninstall(config, options);
      }),
    ),
).pipe(Command.withDescription('Remove Threadnote setup and optionally erase local memories'));

const localAiInstall = Command.make(
  'install',
  {
    dryRun: boolean('dry-run', 'Print local AI installation actions without making changes'),
    force: boolean('force', 'Re-download and re-verify the managed model'),
    model: optionalString('model', 'Verified model to install: gemma-4-E4B-it-Q4_0'),
    modelPath: optionalString('model-path', 'Deprecated; unmanaged GGUF paths are rejected'),
    start: negatedBoolean('start', 'Deprecated compatibility flag; inference starts locally on demand'),
  },
  options => withRuntimeEffect(config => runLocalAiInstall(config, options)),
).pipe(Command.withDescription('Deprecated alias for models install/select generation'));

const localAiEnable = Command.make(
  'enable',
  {dryRun: boolean('dry-run', 'Print the local AI enable action without changing configuration')},
  options => withRuntimeEffect(config => runLocalAiEnable(config, options)),
).pipe(Command.withDescription('Enable an installed local recall model'));

const localAiDisable = Command.make(
  'disable',
  {dryRun: boolean('dry-run', 'Print the local AI disable action without changing configuration')},
  options => withRuntimeEffect(config => runLocalAiDisable(config, options)),
).pipe(Command.withDescription('Disable local AI recall without removing its model'));

const localAiStart = Command.make(
  'start',
  {dryRun: boolean('dry-run', 'Print the local AI start action without running it')},
  options => withRuntimeEffect(config => runLocalAiStart(config, options)),
).pipe(Command.withDescription('Verify the selected local generation model'));

const localAiStop = Command.make(
  'stop',
  {dryRun: boolean('dry-run', 'Print the local AI stop action without running it')},
  options => withRuntimeEffect(config => runLocalAiStop(config, options)),
).pipe(Command.withDescription('Explain local-model worker resource lifetime'));

const localAiStatus = Command.make('status', {}, () => withRuntimeEffect(config => runLocalAiStatus(config))).pipe(
  Command.withDescription('Show local model installation and health'),
);

const localAiModelSwitch = Command.make(
  'switch',
  {
    dryRun: boolean('dry-run', 'Select a model and print the switch actions without changing configuration'),
    model: optionalString('model', 'Switch directly to an installed model instead of prompting'),
  },
  options => withRuntimeEffect(config => runLocalAiModelSwitch(config, options)),
).pipe(Command.withDescription('Interactively switch between installed local AI models'));

const localAiModel = Command.make('model').pipe(
  Command.withDescription('Manage installed local AI models'),
  Command.withSubcommands([localAiModelSwitch]),
);

const localAiUninstall = Command.make(
  'uninstall',
  {
    dryRun: boolean('dry-run', 'Print local AI removal actions without making changes'),
    eraseModel: boolean('erase-model', 'Also delete a model inside the Threadnote-managed model directory'),
  },
  options => withRuntimeEffect(config => runLocalAiUninstall(config, options)),
).pipe(Command.withDescription('Remove local AI configuration and optionally its managed model'));

const localAi = Command.make('local-ai').pipe(
  Command.withDescription('Deprecated compatibility aliases for local model management'),
  Command.withSubcommands([
    localAiInstall,
    localAiEnable,
    localAiDisable,
    localAiStart,
    localAiStop,
    localAiStatus,
    localAiModel,
    localAiUninstall,
  ]),
);

const modelsList = Command.make('list', {}, () => withRuntimeEffect(config => runModelList(config))).pipe(
  Command.withDescription('List pinned local model candidates and installation state'),
);

const modelsInstall = Command.make(
  'install',
  {
    dryRun: boolean('dry-run', 'Show the pinned download and checksum without changing files'),
    modelId: argument('model-id', 'Pinned model ID from threadnote models list'),
  },
  ({modelId, ...options}) => withRuntimeEffect(config => runModelInstall(config, modelId, options)),
).pipe(Command.withDescription('Resumably download and verify a pinned GGUF model'));

const modelsVerify = Command.make('verify', {modelId: argument('model-id', 'Installed model ID')}, ({modelId}) =>
  withRuntimeEffect(config => runModelVerify(config, modelId)),
).pipe(Command.withDescription('Verify an installed model size and SHA-256'));

const modelsRemove = Command.make(
  'remove',
  {
    dryRun: boolean('dry-run', 'Show the exact managed model path without removing it'),
    modelId: argument('model-id', 'Installed model ID'),
  },
  ({modelId, ...options}) => withRuntimeEffect(config => runModelRemove(config, modelId, options)),
).pipe(Command.withDescription('Remove one Threadnote-managed model'));

const modelsSelect = Command.make(
  'select',
  {
    dryRun: boolean('dry-run', 'Show the role selection without changing it'),
    modelId: argument('model-id', 'Installed model ID'),
    role: Argument.Literals('role', ['embedding', 'reranker', 'generation']).pipe(
      Argument.withDescription('embedding, reranker, or generation'),
    ),
  },
  ({modelId, role, ...options}) => withRuntimeEffect(config => runModelSelect(config, role, modelId, options)),
).pipe(Command.withDescription('Select a verified installed model for one runtime role'));

const modelsRuntime = Command.make('runtime', {}, () => withRuntimeEffect(() => runModelRuntimeStatus())).pipe(
  Command.withDescription('Verify the prebuilt-only node-llama-cpp runtime and show its backend'),
);

const models = Command.make('models').pipe(
  Command.withDescription('Manage pinned local GGUF models'),
  Command.withSubcommands([modelsList, modelsInstall, modelsVerify, modelsRemove, modelsSelect, modelsRuntime]),
);

const indexRebuild = Command.make(
  'rebuild',
  {model: optionalString('model', 'Embedding model ID; defaults to the selected embedding model')},
  options => withRuntimeEffect(config => runIndexRebuild(config, options)),
).pipe(Command.withDescription('Build and atomically activate a complete vector-index generation'));

const indexStatus = Command.make('status', {}, () => withRuntimeEffect(config => runIndexStatus(config))).pipe(
  Command.withDescription('Show vector-index generation and compatibility state'),
);

const indexVerify = Command.make(
  'verify',
  {model: optionalString('model', 'Embedding model ID; defaults to the selected embedding model')},
  options => withRuntimeEffect(config => runIndexVerify(config, options)),
).pipe(Command.withDescription('Verify the selected SQLite vector index and active mapping'));

const indexPurge = Command.make(
  'purge',
  {
    dryRun: boolean('dry-run', 'Show which derived index would be removed'),
    model: optionalString('model', 'Embedding model ID; defaults to the selected embedding model'),
  },
  options => withRuntimeEffect(config => runIndexPurge(config, options)),
).pipe(Command.withDescription('Remove disposable vector data without touching canonical resources'));

const indexCommand = Command.make('index').pipe(
  Command.withDescription('Inspect and rebuild derived recall indexes'),
  Command.withSubcommands([indexRebuild, indexStatus, indexVerify, indexPurge]),
);

const graphStatus = Command.make('status', codeGraphStatusFlags, options =>
  withRuntimeEffect(config => runCodeGraphStatus(config, options)),
).pipe(Command.withDescription('Show native code graph snapshot and freshness state'));

const graphInventory = Command.make(
  'inventory',
  {
    cwd: graphBounds.cwd,
    json: graphBounds.json,
    project: graphBounds.project,
  },
  options => withRuntimeEffect(config => runCodeGraphInventory(config, options)),
).pipe(Command.withDescription('Preview aggregate graph eligibility by language, role, classifier, and policy reason'));

const graphDiagnostics = Command.make(
  'diagnostics',
  {
    analyze: boolean('analyze', 'Include bounded structural statistics for every ready indexed view'),
    deep: boolean('deep', 'Run full SQLite integrity and foreign-key checks for every idle database'),
    json: graphBounds.json,
  },
  options => withRuntimeEffect(config => runCodeGraphDiagnostics(config, options)),
).pipe(Command.withDescription('Inspect health, storage, snapshots, builds, and statistics for every local graph'));

const graphRepair = Command.make(
  'repair',
  {
    all: boolean('all', 'Repair every local native code graph database'),
    checkoutId: optionalString('checkout-id', 'Repair one exact checkout identity instead of the current repository'),
    cwd: graphBounds.cwd,
    deep: boolean('deep', 'Run full SQLite integrity and foreign-key checks before destructive recovery'),
    dryRun: boolean('dry-run', 'Print repair actions without modifying graph databases'),
    json: graphBounds.json,
  },
  options => withRuntimeEffect(config => runCodeGraphRepair(config, options)),
).pipe(Command.withDescription('Immediately migrate and repair native code graph databases'));

const graphIndex = Command.make(
  'index',
  {
    cwd: graphBounds.cwd,
    full: boolean('full', 'Ignore reusable snapshot state and rebuild the graph'),
    json: graphBounds.json,
    noVectors: boolean(
      'no-vectors',
      'Skip embedding materialization; matches watcher-driven refresh (ensureVectors: false)',
    ),
    project: graphBounds.project,
  },
  options => withMutationRuntimeEffect(config => runCodeGraphIndex(config, options)),
).pipe(Command.withDescription('Build and atomically activate a current native code graph snapshot'));

const withScopedRuntime = withManifestManagementRuntimeEffect as <E, R>(
  effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>,
) => Effect.Effect<void, E, R>;
const graphScope = makeCodeGraphScopeCommand(withScopedRuntime, graphBounds.json);

const graphQuery = Command.make(
  'query',
  {
    ...graphBounds,
    freshness: graphFreshness('ready'),
    budgetTokens: optional(
      describeFlag(
        integerFlag('budget-tokens').pipe(
          Flag.withSchema(
            Schema.Int.check(
              Schema.isBetween({
                minimum: CODE_GRAPH_WORKSET_EVIDENCE_MINIMUM_ESTIMATED_TOKENS,
                maximum: CODE_GRAPH_WORKSET_EVIDENCE_MAXIMUM_ESTIMATED_TOKENS,
              }),
            ),
          ),
        ),
        `Requires --workset; maximum estimated tokens (${CODE_GRAPH_WORKSET_EVIDENCE_MINIMUM_ESTIMATED_TOKENS}-${CODE_GRAPH_WORKSET_EVIDENCE_MAXIMUM_ESTIMATED_TOKENS}) for the compact agent response`,
      ),
    ),
    cursor: optionalString('cursor', 'Requires --workset; opaque cgwc_ continuation from a prior query'),
    packageName: optionalString('package', 'Restrict results to one exact indexed package or workspace component'),
    query: optionalString('query', 'Concept, symbol, module, path, or documentation query'),
    workset: optionalString(
      'workset',
      'Query a published ready-snapshot catalog; run `threadnote workset prepare` for cold members',
    ),
  },
  options => withRuntimeEffect(config => runCodeGraphInspect(config, {...options, operation: 'query'})),
).pipe(Command.withDescription('Search symbols and inspect a bounded relationship neighborhood'));

const graphNode = Command.make(
  'node',
  {
    cwd: graphBounds.cwd,
    freshness: graphFreshness('ready'),
    json: graphBounds.json,
    nodeId: requiredString('node-id', 'Exact local cgs_ ID or repository-qualified cgr_ handle'),
    project: graphBounds.project,
    readTimeoutMilliseconds: graphBounds.readTimeoutMilliseconds,
  },
  options => withRuntimeEffect(config => runCodeGraphInspect(config, {...options, operation: 'node'})),
).pipe(Command.withDescription('Read one code graph node by its exact stable ID'));

const graphNeighbors = Command.make(
  'neighbors',
  {
    ...graphBounds,
    freshness: graphFreshness('ready'),
    direction: defaultChoice(
      'direction',
      ['both', 'incoming', 'outgoing'],
      'Relationship direction relative to each traversal frontier',
      'both',
    ),
    nodeId: requiredString('node-id', 'Exact local cgs_ ID or repository-qualified cgr_ handle'),
  },
  options => withRuntimeEffect(config => runCodeGraphInspect(config, {...options, operation: 'neighbors'})),
).pipe(Command.withDescription('Traverse a bounded neighborhood from one exact stable node ID'));

const graphExplain = Command.make(
  'explain',
  {
    ...graphBounds,
    freshness: graphFreshness('ready'),
    symbol: requiredString('symbol', 'Symbol, qualified name, or source path selector'),
  },
  options => withRuntimeEffect(config => runCodeGraphInspect(config, {...options, operation: 'explain'})),
).pipe(Command.withDescription('Explain one symbol with declaration and relationship evidence'));

const graphPath = Command.make(
  'path',
  {
    ...graphBounds,
    freshness: graphFreshness('current'),
    from: requiredString('from', 'Local symbol/cgs_ selector, or cgr_ / repository:cgp_ endpoint with --workset'),
    to: requiredString('to', 'Local symbol/cgs_ selector, or cgr_ / repository:cgp_ endpoint with --workset'),
    workset: optionalString('workset', 'Traverse a prepared workset generation across authoritative bridges'),
  },
  options => withRuntimeEffect(config => runCodeGraphInspect(config, {...options, operation: 'path'})),
).pipe(Command.withDescription('Find a bounded authoritative path between two code concepts'));

const graphImpact = Command.make(
  'impact',
  {
    base: optionalString('base', 'Git base ref used to derive changed paths; defaults to HEAD~1'),
    cwd: graphBounds.cwd,
    depth: graphBounds.depth,
    edgeLimit: graphBounds.edgeLimit,
    json: graphBounds.json,
    nodeLimit: graphBounds.nodeLimit,
    project: graphBounds.project,
    query: optionalString('query', 'Local selector, or cgr_ / repository:cgp_ endpoint with --workset'),
    workset: optionalString('workset', 'Trace reverse impact across a prepared workset generation'),
  },
  options => withRuntimeEffect(config => runCodeGraphImpact(config, options)),
).pipe(Command.withDescription('Trace reverse impact from a symbol, path, or Git diff'));

const graphTopology = Command.make(
  'topology',
  {
    edgeLimit: graphBounds.edgeLimit,
    json: graphBounds.json,
    nodeLimit: graphBounds.nodeLimit,
    workset: requiredString('workset', 'Prepared workset generation to summarize'),
  },
  options => withRuntimeEffect(config => runCodeGraphWorksetTopology(config, options)),
).pipe(Command.withDescription('Summarize generation-bound repository/component bridge topology'));

const graphAnalysisBounds = {
  cwd: graphBounds.cwd,
  freshness: defaultChoice(
    'freshness',
    ['ready', 'current', 'allow-stale'],
    'Ready uses an existing snapshot, current refreshes before analysis, and allow-stale never starts indexing',
    'ready',
  ),
  includeHeuristic: graphBounds.includeHeuristic,
  includeModelAssociations: graphBounds.includeModelAssociations,
  json: graphBounds.json,
  project: graphBounds.project,
  readTimeoutMilliseconds: graphBounds.readTimeoutMilliseconds,
} as const;

const graphCommunityMemberLimit = optional(
  describeFlag(
    integerFlag('member-limit').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 5_000})))),
    'Maximum deterministic community members to return',
  ),
);

const graphAnalyze = Command.make(
  'analyze',
  {
    ...graphAnalysisBounds,
    communityId: optionalString('community-id', 'Stable cgc_ community identifier required by the community view'),
    memberLimit: graphCommunityMemberLimit,
    view: defaultChoice(
      'view',
      ['stats', 'communities', 'community', 'groups', 'hubs', 'surprises', 'confidence', 'full'],
      'Analysis view to render',
      'stats',
    ),
  },
  options => withRuntimeEffect(config => runCodeGraphAnalysis(config, options)),
).pipe(
  Command.withDescription(
    'Analyze whole-graph statistics, structural communities, hubs, surprising links, and relationship confidence',
  ),
);

const graphStats = Command.make('stats', graphAnalysisBounds, options =>
  withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'stats'})),
).pipe(Command.withDescription('Show whole-graph structural statistics'));

const graphCommunities = Command.make('communities', graphAnalysisBounds, options =>
  withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'communities'})),
).pipe(Command.withDescription('Find deterministic structural communities and their stable IDs'));

const graphCommunity = Command.make(
  'community',
  {
    ...graphAnalysisBounds,
    communityId: requiredString('community-id', 'Stable cgc_ identifier returned by graph communities'),
    memberLimit: graphCommunityMemberLimit,
  },
  options => withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'community'})),
).pipe(Command.withDescription('Inspect bounded members of one stable structural community'));

const graphHubs = Command.make('hubs', graphAnalysisBounds, options =>
  withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'hubs'})),
).pipe(Command.withDescription('Rank hubs and graph-wide god nodes'));

const graphGroups = Command.make('groups', graphAnalysisBounds, options =>
  withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'groups'})),
).pipe(Command.withDescription('Derive bounded high-degree fan-in and fan-out structural hyperedges'));

const graphSurprises = Command.make('surprises', graphAnalysisBounds, options =>
  withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'surprises'})),
).pipe(Command.withDescription('Rank unexpected cross-community relationships'));

const graphConfidence = Command.make('confidence', graphAnalysisBounds, options =>
  withRuntimeEffect(config => runCodeGraphAnalysis(config, {...options, view: 'confidence'})),
).pipe(Command.withDescription('Audit relationship confidence, provenance, and endpoint coverage'));

const graphReport = Command.make(
  'report',
  {
    cwd: graphBounds.cwd,
    includeHeuristic: graphBounds.includeHeuristic,
    includeModelAssociations: graphBounds.includeModelAssociations,
    output: requiredString('output', 'New Markdown report path; existing files are never overwritten'),
    readTimeoutMilliseconds: graphBounds.readTimeoutMilliseconds,
  },
  options => withRuntimeEffect(config => runCodeGraphReport(config, options)),
).pipe(Command.withDescription('Write a deterministic architecture report with suggested graph questions'));

const graphWatch = Command.make('watch', {cwd: graphBounds.cwd, project: graphBounds.project}, options =>
  withRuntimeEffect(config => runCodeGraphWatch(config, options)),
).pipe(Command.withDescription('Keep one worktree graph current in the foreground'));

const graphExport = Command.make(
  'export',
  {
    cwd: graphBounds.cwd,
    edgeLimit: optionalString('edge-limit', 'Maximum relationships to export, or all; defaults by format'),
    format: defaultChoice('format', ['json', 'graphml', 'html', 'svg'], 'Explicit export format', 'json'),
    nodeLimit: withValueAlias(
      optionalString('node-limit', 'Maximum nodes to export, or all; defaults by format'),
      'limit',
      'string',
    ),
    output: requiredString('output', 'New output file; existing files are never overwritten'),
  },
  options => withRuntimeEffect(config => runCodeGraphExport(config, options)),
).pipe(Command.withDescription('Stream a portable JSON, GraphML, HTML, or SVG graph snapshot'));

const graphCheckpointExport = Command.make(
  'export',
  {
    cwd: graphBounds.cwd,
    json: graphBounds.json,
    output: requiredString('output', 'New checkpoint file; existing files are never overwritten'),
  },
  options => withRuntimeEffect(config => runCodeGraphCheckpointExport(config, options)),
).pipe(Command.withDescription('Export an exact clean ready graph as a deterministic portable checkpoint'));

const graphCheckpointInspect = Command.make(
  'inspect',
  {
    expectedDigest: optionalString('expected-digest', 'Expected SHA-256 artifact digest'),
    input: requiredString('input', 'Checkpoint file to inspect without inflating logical chunks'),
    json: graphBounds.json,
  },
  options => withRuntimeEffect(() => runCodeGraphCheckpointInspect(options)),
).pipe(Command.withDescription('Inspect checkpoint metadata and exact framing without inflating graph records'));

const graphCheckpointVerify = Command.make(
  'verify',
  {
    expectedDigest: optionalString('expected-digest', 'Expected SHA-256 artifact digest'),
    input: requiredString('input', 'Checkpoint file to verify'),
    json: graphBounds.json,
  },
  options => withRuntimeEffect(() => runCodeGraphCheckpointVerify(options)),
).pipe(Command.withDescription('Fully verify checkpoint framing, chunks, records, ordering, and logical digest'));

const graphCheckpointImport = Command.make(
  'import',
  {
    cwd: graphBounds.cwd,
    expectedDigest: optionalString('expected-digest', 'Expected SHA-256 artifact digest'),
    input: requiredString('input', 'Checkpoint file to import'),
    json: graphBounds.json,
  },
  options => withRuntimeEffect(config => runCodeGraphCheckpointImport(config, options)),
).pipe(Command.withDescription('Verify and safely publish a compatible clean graph checkpoint for this repository'));

const graphCheckpoint = Command.make('checkpoint').pipe(
  Command.withDescription('Export, inspect, verify, and import portable native graph checkpoints'),
  Command.withSubcommands([
    graphCheckpointExport,
    graphCheckpointInspect,
    graphCheckpointVerify,
    graphCheckpointImport,
  ]),
);

const {graphAuth, graphContribute, graphPublisher, graphShare, graphWorker} =
  makeGraphSharingCommands(withScopedRuntime);

const graphPurge = Command.make(
  'purge',
  {
    all: boolean('all', 'Remove every disposable native code graph index'),
    apply: boolean('apply', 'Apply an exact selected-snapshot purge after preview approval'),
    approval: optionalString('approval', 'Exact sha256 approval digest emitted by a fresh snapshot preview'),
    checkoutId: optionalString('checkout-id', 'Target one inventoried checkout by its full 64-character identity'),
    cwd: graphBounds.cwd,
    dryRun: boolean('dry-run', 'Show the derived index path without removing it'),
    json: graphBounds.json,
    obsolete: boolean('obsolete', 'Remove only verified older graph-vN SQLite files for this checkout'),
    snapshotId: optionalString('snapshot-id', 'Expert action targeting one exact isolated ready/retired snapshot'),
  },
  options => withRuntimeEffect(config => runCodeGraphPurge(config, options)),
).pipe(Command.withDescription('Remove disposable native code graph data without touching repositories or memories'));

const graphRemoveView = Command.make(
  'remove-view',
  {
    apply: boolean('apply', 'Apply the exact selected-view removal; the default is a non-mutating preview'),
    checkoutId: requiredString('checkout-id', 'Full 64-character checkout identity'),
    json: graphBounds.json,
    snapshotId: requiredString('snapshot-id', 'Exact snapshot identity currently selected by the view'),
    worktreeId: requiredString('worktree-id', 'Full 64-character worktree identity'),
  },
  options => withRuntimeEffect(config => runCodeGraphRemoveView(config, options)),
).pipe(Command.withDescription('Preview or remove one exact active code graph view'));

const graphCompact = Command.make(
  'compact',
  {
    cwd: graphBounds.cwd,
    dryRun: boolean('dry-run', 'Inspect and verify compaction without changing the active database'),
    force: boolean('force', 'Compact even when reclaimable space is below the reviewed threshold'),
    json: graphBounds.json,
  },
  options => withRuntimeEffect(config => runCodeGraphCompact(config, options)),
).pipe(Command.withDescription('Safely reclaim free pages in the active code graph database'));

const graphCommand = Command.make('graph').pipe(
  Command.withDescription('Index and inspect the self-contained native code graph'),
  Command.withSubcommands([
    graphStatus,
    graphInventory,
    graphDiagnostics,
    graphRepair,
    graphIndex,
    graphScope,
    graphQuery,
    graphNode,
    graphNeighbors,
    graphExplain,
    graphPath,
    graphImpact,
    graphTopology,
    graphAnalyze,
    graphStats,
    graphCommunities,
    graphCommunity,
    graphGroups,
    graphHubs,
    graphSurprises,
    graphConfidence,
    graphReport,
    graphWatch,
    graphExport,
    graphCheckpoint,
    graphShare,
    graphAuth,
    graphPublisher,
    graphContribute,
    graphWorker,
    graphCompact,
    graphRemoveView,
    graphPurge,
  ]),
);

const sourceAdd = Command.make('add', sourceAddFlags, options =>
  withRuntimeEffect(config =>
    runSourceAdd(config, {...options, pages: options.pages.length ? options.pages : undefined}),
  ),
).pipe(Command.withDescription('Configure an allowlisted read-only external source'));

const sourceList = Command.make('list', {}, () => withRuntimeEffect(config => runSourceList(config))).pipe(
  Command.withDescription('List configured external sources'),
);
const sourceInventory = Command.make('inventory', {id: argument('id', 'Source identifier')}, ({id}) =>
  withRuntimeEffect(config => runSourceInventory(config, id)),
).pipe(Command.withDescription('Inventory allowed, changed, removed, and unsafe source notes'));

const sourceSync = Command.make(
  'sync',
  {
    id: argument('id', 'Source identifier'),
    apply: boolean('apply', 'Update the external index; without this, print a dry run'),
    dryRun: boolean('dry-run', 'Print changes without updating the external index'),
  },
  options => withRuntimeEffect(config => runSourceSync(config, options)),
).pipe(Command.withDescription('Incrementally synchronize an allowlisted external source'));

const sourceStatus = Command.make('status', {id: argument('id', 'Source identifier')}, ({id}) =>
  withRuntimeEffect(config => runSourceStatus(config, id)),
).pipe(Command.withDescription('Show source configuration and pending changes'));

const sourceRemove = Command.make(
  'remove',
  {
    id: argument('id', 'Source identifier'),
    apply: boolean('apply', 'Remove source configuration and its external index'),
    dryRun: boolean('dry-run', 'Print removal without changing anything'),
  },
  options => withRuntimeEffect(config => runSourceRemove(config, options)),
).pipe(Command.withDescription('Remove a source index while preserving its vault and Threadnote memories'));

const source = Command.make('source').pipe(
  Command.withDescription('Manage capability-scoped external knowledge sources'),
  Command.withSubcommands([sourceAdd, sourceList, sourceInventory, sourceSync, sourceStatus, sourceRemove]),
);

const projectionAdd = Command.make(
  'add',
  {
    apply: boolean('apply', 'Write the projection configuration; without this, print a preview'),
    folder: defaultString('folder', 'Vault-relative managed projection folder', 'Threadnote'),
    id: requiredString('id', 'Stable projection identifier'),
    includeShared: negatedBoolean('shared', 'Exclude shared memories from this projection'),
    kind: repeatedString('kind', 'Memory kind to project; repeat for multiple'),
    status: repeatedString('status', 'Memory status to project; repeat for multiple'),
    type: defaultChoice('type', ['obsidian'], 'Projection type', 'obsidian'),
    vault: requiredString('vault', 'Obsidian vault directory'),
  },
  ({kind, status, type: _type, ...options}) =>
    withRuntimeEffect(config =>
      runObsidianProjectionAdd(config, {
        ...options,
        kinds: kind.map(parseMemoryKind),
        statuses: status.map(parseMemoryStatus),
      }),
    ),
).pipe(Command.withDescription('Configure a deterministic read-only memory projection'));

const projectionList = Command.make('list', {}, () =>
  withRuntimeEffect(config => runObsidianProjectionList(config)),
).pipe(Command.withDescription('List configured memory projections'));

const projectionSync = Command.make(
  'sync',
  {
    id: argument('id', 'Projection identifier'),
    apply: boolean('apply', 'Write projection changes; without this, print a dry run'),
    dryRun: boolean('dry-run', 'Print changes without writing the vault'),
    force: boolean('force', 'Regenerate edited managed files; never overwrites unmanaged files'),
  },
  options => withRuntimeEffect(config => runObsidianProjectionSync(config, options)),
).pipe(Command.withDescription('Refresh memories already selected for an Obsidian projection'));

const projectionPublish = Command.make(
  'publish',
  {
    id: argument('id', 'Projection identifier'),
    apply: boolean('apply', 'Select and write the memories; without this, print a dry run'),
    dryRun: boolean('dry-run', 'Print changes without writing the vault or projection selection'),
    force: boolean('force', 'Regenerate edited managed files; never overwrites unmanaged files'),
    uri: repeatedString('uri', 'Canonical Threadnote memory URI; repeat for multiple memories'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runObsidianProjectionPublish(config, {...options, uris: uri})),
).pipe(Command.withDescription('Publish explicitly selected Threadnote memories to Obsidian'));

const projectionStatus = Command.make('status', {id: argument('id', 'Projection identifier')}, ({id}) =>
  withRuntimeEffect(config => runObsidianProjectionStatus(config, id)),
).pipe(Command.withDescription('Show projection configuration, drift, and pending changes'));

const projectionRemove = Command.make(
  'remove',
  {
    id: argument('id', 'Projection identifier'),
    apply: boolean('apply', 'Remove unchanged managed files and projection configuration'),
    dryRun: boolean('dry-run', 'Print removal without changing anything'),
    force: boolean('force', 'Also remove edited files previously managed by this projection'),
  },
  options => withRuntimeEffect(config => runObsidianProjectionRemove(config, options)),
).pipe(Command.withDescription('Remove managed projection files while preserving the vault and memories'));

const projection = Command.make('projection').pipe(
  Command.withDescription('Manage one-way human-readable memory projections'),
  Command.withSubcommands([
    projectionAdd,
    projectionList,
    projectionPublish,
    projectionSync,
    projectionStatus,
    projectionRemove,
  ]),
);

const openMemory = Command.make(
  'open',
  {
    uri: argument('uri', 'Projected threadnote:// memory URI'),
    dryRun: boolean('dry-run', 'Print the Obsidian command without opening it'),
    projection: optionalString('projection', 'Projection identifier when a memory appears in more than one'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runObsidianOpen(config, uri, options)),
).pipe(Command.withDescription('Open a projected Threadnote memory in Obsidian'));

const inboxScan = Command.make(
  'scan',
  {
    apply: boolean('apply', 'Persist candidate reviews; without this, print a dry run'),
    dryRun: boolean('dry-run', 'Print candidate reviews without persisting them'),
    source: requiredString('source', 'Obsidian source identifier with a configured Inbox'),
  },
  options => withRuntimeEffect(config => runObsidianInboxScan(config, options)),
).pipe(Command.withDescription('Form reviewed memory candidates from an explicit Obsidian Inbox'));

const inbox = Command.make('inbox').pipe(
  Command.withDescription('Review explicit external writeback candidates'),
  Command.withSubcommands([inboxScan]),
);

const seed = Command.make(
  'seed',
  {
    dryRun: boolean('dry-run', 'Print files and native store operations without importing'),
    force: boolean('force', 'Re-upload every candidate even if recorded state matches'),
    graph: boolean('graph', 'Also seed per-project dependency facts with cross-repo edges'),
    only: repeatedString('only', 'Restrict seeding to one or more manifest projects; repeat for multiple'),
  },
  options => withRuntimeEffect(config => runSeed(config, options)),
).pipe(Command.withDescription('Seed curated context from the manifest; never indexes whole repos by default'));

const initManifest = Command.make(
  'init-manifest',
  {
    dryRun: boolean('dry-run', 'Print the manifest without writing it'),
    path: optionalString('path', 'Manifest path; defaults to THREADNOTE_MANIFEST or the user manifest'),
    replace: boolean('replace', 'Replace the manifest instead of merging with existing projects'),
    repo: repeatedString('repo', 'Repo root to include; repeat for multiple repos'),
  },
  options => withRuntimeEffect(config => runInitManifest(config, options)),
).pipe(Command.withDescription('Create or update a per-developer seed manifest from one or more repo roots'));

const seedSkills = Command.make(
  'seed-skills',
  {
    dryRun: boolean('dry-run', 'Print skill files without importing'),
  },
  options => withRuntimeEffect(config => runSeedSkills(config, options)),
).pipe(Command.withDescription('Seed Codex, Claude, and Cursor skills plus Claude commands'));

const mcpInstall = Command.make(
  'mcp-install',
  {
    agent: Argument.Literals('agent', ['codex', 'claude', 'cursor', 'copilot', 'omp']).pipe(
      Argument.withDescription('codex, claude, cursor, copilot, or omp'),
    ),
    apply: boolean('apply', 'Actually modify the selected agent config'),
    ...makeComposerAttachFlags(),
    name: defaultString('name', 'MCP server name', THREADNOTE_MCP_NAME),
    project: optionalString('project', 'Write Cursor/Copilot/omp MCP into this repository config'),
    scope: defaultChoice('scope', ['user', 'local', 'project'], 'Claude MCP config scope', 'user'),
    toolset: optionalChoice('toolset', ['core', 'full'], 'Stdio adapter toolset'),
  },
  ({agent, ...options}) => withRuntimeEffect(config => runMcpInstall(config, agent, options)),
).pipe(Command.withDescription('Install the Threadnote MCP config, instructions, and skills for one supported agent'));

const installHooks = hooksCli.makeInstallHooksCommand((agent, options) =>
  withRuntimeEffect(config => runHooksInstall(config, agent, options)),
);
const cursorHook = hooksCli.makeCursorHookCommand((event, options) =>
  withRuntimeEffect(config => runCursorHook(config, event, options)),
);

const preCompactHook = hooksCli.makePreCompactHookCommand(options =>
  withRuntimeEffect(config => runPreCompactHook(config, options)),
);

const sessionStartHook = Command.make(
  'session-start-hook',
  {dryRun: boolean('dry-run', 'Print the planned native operation without running it')},
  options => withRuntimeEffect(config => runSessionStartHook(config, options)),
).pipe(Command.withDescription('Print current repo handoff context at session start'), Command.unlisted);

const codeBriefHook = hooksCli.makeCodeBriefHookCommand(options =>
  withRuntimeEffect(config => runCodeBriefEditHook(config, options)),
);
const codexResumeHook = hooksCli.makeCodexResumeHookCommand(options =>
  withRuntimeEffect(config => runCodexResumeHook(config, options)),
);
const remember = Command.make(
  'remember',
  {
    codeRefs: repeatedString(
      'code-ref',
      'Graph-indexed repository-relative path, cgs_ symbol, or cgr_ qualified ref to cite; repeat for multiple',
    ),
    deferCodeRefs: boolean(
      'defer-code-refs',
      'Explicitly use the default private store-now/anchor-later citation policy',
    ),
    dryRun: boolean('dry-run', 'Print memory and native operation without storing'),
    clearKeywords: boolean('clear-keywords', 'Drop keywords preserved from the replaced memory'),
    keyword: repeatedString(
      'keyword',
      'Explicit search keyword; repeat for multiple. Preserved keywords are kept by default on --replace.',
      32,
    ),
    kind: defaultChoice(
      'kind',
      ['durable', 'handoff', 'incident', 'preference', 'smoke'],
      'Memory lifecycle kind',
      'durable',
    ),
    project: optionalString('project', 'Project/repo/topic namespace for lifecycle-aware storage'),
    regenerateKeywords: boolean(
      'regenerate-keywords',
      'Discard preserved keywords and regenerate them; personal memories only',
    ),
    requireCurrentCodeRefs: boolean(
      'require-current-code-refs',
      'Fail before writing unless every code reference has exact-current graph evidence',
    ),
    relations: repeatedString('relation', 'Typed memory relation as <type>=<threadnote://uri>; repeat for multiple'),
    replace: withValueAlias(
      optionalString('replace', 'Supersede an existing threadnote:// memory after storing the new memory'),
      'replace-uri',
      'string',
    ),
    sourceAgentClient: defaultString('source-agent-client', 'Originating agent client name', 'codex'),
    status: defaultChoice(
      'status',
      ['active', 'archived', 'expired', 'superseded'],
      'Memory lifecycle status',
      'active',
    ),
    stdin: boolean('stdin', 'Read memory text from stdin'),
    text: optionalString('text', 'Memory text to store'),
    topic: optionalString('topic', 'Stable topic name for an active project/topic memory'),
  },
  ({keyword, ...rest}) =>
    withMutationRuntimeEffect(config =>
      runRemember(config, {...rest, ...(keyword.length > 0 ? {keywords: [...keyword]} : {})}),
    ),
).pipe(Command.withDescription('Store a durable engineering memory in the native Threadnote store'));

const migrateMemories = Command.make(
  'migrate-memories',
  {
    allAccounts: boolean('all-accounts', 'Scan all local canonical accounts under THREADNOTE_HOME'),
    dryRun: boolean('dry-run', 'Print migration actions without writing memories'),
    limit: optionalString('limit', 'Maximum number of memories to migrate'),
    sourceAccount: repeatedString('source-account', 'Source canonical account; repeat for multiple accounts'),
  },
  options => withMutationRuntimeEffect(config => runMigrateMemories(config, options)),
).pipe(Command.withDescription('Migrate legacy session-only memories into durable memory files'));

const migrateHome = Command.make(
  'migrate',
  {
    apply: boolean('apply', 'Stage, validate, and atomically promote ~/.threadnote'),
    dryRun: boolean('dry-run', 'Inspect the legacy home without changing files'),
    legacyHome: optionalString('legacy-home', 'Legacy OpenViking home; defaults to ~/.openviking'),
  },
  options =>
    withRuntimeEffect(config =>
      runHomeMigration({
        apply: options.apply && !options.dryRun,
        legacyHome: options.legacyHome,
        targetHome: config.agentContextHome,
      }),
    ),
).pipe(Command.withDescription('Migrate a legacy ~/.openviking home into the self-contained ~/.threadnote home'));

const migrateLifecycle = Command.make(
  'migrate-lifecycle',
  {
    apply: boolean('apply', 'Perform the migration; without this, prints a dry run'),
    dryRun: boolean('dry-run', 'Print migration actions without changing memories'),
    limit: optionalString('limit', 'Maximum number of legacy handoffs to migrate'),
  },
  options => withMutationRuntimeEffect(config => runMigrateLifecycle(config, options)),
).pipe(Command.withDescription('Move clear legacy handoff memories into lifecycle-aware archive paths'));

const migrateProjectNamesFlags = {
  apply: boolean('apply', 'Perform the migration; without this, prints a dry run'),
  dryRun: boolean('dry-run', 'Print migration actions without changing memories'),
  limit: optionalString('limit', 'Maximum number of memories to migrate'),
};

const migrateProjectNames = Command.make('migrate-projects', migrateProjectNamesFlags, options =>
  withMutationRuntimeEffect(config => runMigrateProjectNames(config, options)),
).pipe(Command.withDescription('Move memories from clone-folder project names to the git remote repo name'));

const migrateProjectNamesCompatibility = Command.make('migrate-project-names', migrateProjectNamesFlags, options =>
  withMutationRuntimeEffect(config => runMigrateProjectNames(config, options)),
).pipe(Command.withDescription('Compatibility name for migrate-projects'), Command.unlisted);

const enrichMemories = Command.make(
  'enrich-memories',
  {
    apply: boolean('apply', 'Generate and store local-model search keywords; without this, prints a dry run'),
    dryRun: boolean('dry-run', 'Print eligible memories without changing them'),
    force: boolean('force', 'Regenerate keywords for memories that are already enriched'),
    installLocalAi: boolean('install-local-ai', 'Install the pinned local model first when it is not installed'),
    limit: optionalString('limit', 'Maximum number of memories to enrich'),
  },
  options => withRuntimeEffect(config => runEnrichMemories(config, options)),
).pipe(Command.withDescription('Enrich personal and shared memories with local-model retrieval keywords'));

const recall = Command.make(
  'recall',
  {
    callerCwd: withValueAlias(
      optionalString('caller-cwd', 'Absolute caller workspace path for current repo/branch resolution'),
      'cwd',
      'string',
    ),
    dryRun: boolean('dry-run', 'Print the native query without searching'),
    includeArchived: boolean('include-archived', 'Include archived memories in recall results'),
    inferScope: negatedBoolean('infer-scope', 'Disable query-based scope inference'),
    memoryRefs: repeatedString(
      'memory-ref',
      'Stable memory ID or managed memory URI to expand by one hop; repeat for multiple premises',
      8,
    ),
    nodeLimit: withValueAlias(
      withValueAlias(optionalString('node-limit', 'Maximum number of search results'), 'n', 'string'),
      'limit',
      'string',
    ),
    project: optionalString('project', 'Restrict to this project plus projectless guidance; omit for global recall'),
    query: optionalString('query', 'Search query; optional when --memory-ref supplies an explicit navigation seed'),
    relationTypes: repeatedString(
      'relation-type',
      'Filter one-hop expansion by relation type; repeat for multiple types',
      5,
    ),
    threshold: optionalString(
      'threshold',
      'Minimum topical relevanceScore 0-1; defaults to THREADNOTE_RECALL_THRESHOLD or 0.3',
    ),
    uri: optionalString('uri', 'Restrict search to a threadnote:// URI'),
    workset: optionalString('workset', 'Recall across a named seed-manifest workset'),
  },
  options => withMutationRuntimeEffect(config => runRecall(config, options)),
).pipe(Command.withDescription('Search shared Threadnote context'));

const recallFeedback = makeRecallFeedbackCommand(options =>
  withRuntimeEffect(config => runRecallFeedback(config, options)),
);

const workset = makeWorksetCommand(withScopedRuntime);
const project = makeProjectCommand(withScopedRuntime);
const context = makeContextRuntimeCommand(withRuntimeEffect, withMutationRuntimeEffect);
const value = makeValueCommand(
  options => withRuntimeEffect(config => valueReportCommands.runValueReport(config, options)),
  options => withRuntimeEffect(config => valueReportCommands.runValueReportExport(config, options)),
  options => withRuntimeEffect(config => valueReportCommands.runValueReportRetention(config, options)),
  options => withRuntimeEffect(config => valueReportCommands.runValueReportDelete(config, options)),
  options => Effect.flatMap(root, ({home}) => withPilotHome(home, config => runPilotCommand(config, options))),
);
const procedure = makeProcedureCommand(
  options => withRuntimeEffect(() => runProcedureVerify(options)),
  options => withRuntimeEffect(() => runProcedureStatus(options)),
  options => withRuntimeEffect(config => runProcedurePublish(config, options)),
);

const compact = makeCompactCommand(options => withRuntimeEffect(config => runCompact(config, options)));

const read = Command.make(
  'read',
  {
    dryRun: boolean('dry-run', 'Print the native read without running it'),
    uri: argument('uri', 'Canonical threadnote:// URI or threadnote://memory/tn_ stable selector'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runRead(config, uri, options)),
).pipe(Command.withDescription('Read a canonical or stable-identity threadnote:// pointer'));

const closeout = makeCloseoutCommand(
  Effect.flatMap(root, options =>
    getRuntimeConfig(options).pipe(Effect.mapError(cause => applicationError('load runtime configuration', cause))),
  ),
);

const list = Command.make(
  'list',
  {
    all: boolean('all', 'Show hidden files such as .abstract.md and .overview.md').pipe(Flag.withAlias('a')),
    dryRun: boolean('dry-run', 'Print the native listing operation without running it'),
    nodeLimit: withValueAlias(
      withValueAlias(optionalString('node-limit', 'Maximum number of nodes to list'), 'n', 'string'),
      'limit',
      'string',
    ),
    recursive: boolean('recursive', 'List subdirectories recursively').pipe(Flag.withAlias('r')),
    simple: boolean('simple', 'Print only paths').pipe(Flag.withAlias('s')),
    uri: optionalArgument('uri', 'threadnote:// directory URI', 'threadnote://'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runList(config, uri, options)),
).pipe(Command.withDescription('List a threadnote:// directory'), Command.withAlias('ls'));

const handoff = Command.make(
  'handoff',
  {
    blockers: optionalString('blockers', 'Known blockers'),
    ci: optionalString('ci', 'Captured CI status snapshot'),
    clearKeywords: boolean('clear-keywords', 'Drop keywords preserved from the replaced memory'),
    codeRefs: repeatedString(
      'code-ref',
      'Graph-indexed repository-relative path, cgs_ symbol, or cgr_ qualified ref to cite; repeat for multiple',
    ),
    deferCodeRefs: boolean(
      'defer-code-refs',
      'Explicitly use the default private store-now/anchor-later citation policy',
    ),
    dryRun: boolean('dry-run', 'Print handoff without storing'),
    issue: optionalString('issue', 'Related issue reference'),
    keyword: repeatedString(
      'keyword',
      'Explicit search keyword; repeat for multiple. Handoffs never generate keywords.',
      32,
    ),
    nextStep: optionalString('next-step', 'Suggested next step'),
    pr: optionalString('pr', 'Related pull request reference'),
    project: optionalString('project', 'Project/repo namespace; defaults to current repo'),
    reference: repeatedString('reference', 'Prior threadnote:// context URI; repeat for multiple'),
    replace: withValueAlias(
      optionalString('replace', 'Supersede an existing memory after storing the handoff'),
      'replace-uri',
      'string',
    ),
    requireCurrentCodeRefs: boolean(
      'require-current-code-refs',
      'Fail before writing unless every code reference has exact-current graph evidence',
    ),
    sourceAgentClient: defaultString('source-agent-client', 'Originating agent client name', 'codex'),
    task: optionalString('task', 'Current task summary'),
    tests: optionalString('tests', 'Tests or checks run'),
    timestamped: boolean('timestamped', 'Store a historical timestamped handoff'),
    topic: optionalString('topic', 'Stable topic name'),
  },
  ({keyword, ...options}) =>
    withMutationRuntimeEffect(config =>
      runHandoff(config, {
        ...options,
        ...(keyword.length > 0 ? {keywords: [...keyword]} : {}),
        references: options.reference,
      }),
    ),
).pipe(Command.withDescription('Capture current repo state as a durable cross-agent handoff memory'));

const archive = Command.make(
  'archive',
  {
    dryRun: boolean('dry-run', 'Print archive content and commands without changing anything'),
    kind: optionalChoice('kind', ['durable', 'handoff', 'incident', 'preference', 'smoke'], 'Memory kind'),
    project: optionalString('project', 'Override inferred project/repo namespace'),
    topic: optionalString('topic', 'Override inferred topic'),
    uri: argument('uri', 'threadnote:// memory URI to archive'),
  },
  ({uri, ...options}) => withMutationRuntimeEffect(config => runArchive(config, uri, options)),
).pipe(Command.withDescription('Move a memory into the archived lifecycle tree'));

const forget = Command.make(
  'forget',
  {
    dryRun: boolean('dry-run', 'Print the native delete without running it'),
    uri: argument('uri', 'threadnote:// URI to remove'),
  },
  ({uri, ...options}) => withMutationRuntimeEffect(config => runForget(config, uri, options)),
).pipe(Command.withDescription('Remove a threadnote:// URI from local Threadnote context'));

const finalizeCodeRefs = Command.make(
  'finalize-code-refs',
  {
    limit: optionalString('limit', 'Maximum pending memories to inspect; defaults to 25, maximum 100'),
    uris: repeatedString('uri', 'Pending personal memory URI to finalize; repeat for multiple'),
  },
  options => withMutationRuntimeEffect(config => runFinalizeCodeRefs(config, options)),
).pipe(Command.withDescription('Finalize private pending memory code citations from exact-current ready graphs'));

const cursorCloudIdentityFlags = makeCursorCloudIdentityFlags(defaultString, optionalString);
const cursorCloudBaseIdentityFlags = {
  agentId: cursorCloudIdentityFlags.agentId,
  user: cursorCloudIdentityFlags.user,
};
const cursorCloudMode = makeCursorCloudModeFlag(defaultChoice);
const cursorCloudRuntime = (config: RuntimeConfig, agentId: string | undefined, user: string | undefined) =>
  cursorCloudRuntimeConfig(config, {agentId, user});

const cursorCloudConfig = Command.make(
  'config',
  {
    ...cursorCloudBaseIdentityFlags,
    ...makeCursorCloudRemoteConfigFlags(),
    memoryMode: defaultChoice(
      'memory-mode',
      ['shared-read-write'],
      'Cursor Cloud memory capability profile',
      'shared-read-write',
    ),
    mode: cursorCloudMode,
    teams: repeatedString('team', 'Personal Git memory share; repeat to expose several through one MCP'),
  },
  options =>
    withRuntimeEffect(config =>
      runCursorCloudConfig(cursorCloudRuntime(config, options.agentId, options.user), options),
    ),
).pipe(Command.withDescription('Print a deterministic Cursor Dashboard MCP configuration'));

const cursorCloudBootstrap = Command.make(
  'bootstrap',
  {
    ...cursorCloudIdentityFlags,
    cwd: optionalString('cwd', 'Absolute checkout path prepared for local graph inspection'),
    dryRun: boolean('dry-run', 'Preview configuration without changing or synchronizing the share'),
    endpoint: optionalString('endpoint', 'Managed remote Streamable HTTP MCP endpoint'),
    mode: cursorCloudMode,
    remote: optionalString('remote', 'Credential-free Git URL for the shared memory repository'),
    shareId: optionalString('share-id', 'Opaque managed remote memory share identifier'),
    sync: negatedBoolean('sync', 'Configure the share without synchronizing it immediately'),
  },
  ({agentId, cwd, dryRun, endpoint, mode, remote, shareId, sync, team, user}) =>
    withRuntimeEffect(config =>
      runCursorCloudBootstrap(cursorCloudRuntime(config, agentId, user), {
        cwd,
        dryRun,
        endpoint,
        mode,
        remote,
        shareId,
        sync,
        team,
      }),
    ),
).pipe(Command.withDescription('Idempotently prepare one writable Personal Cursor Cloud memory share'));

const cursorCloudVerify = Command.make(
  'verify',
  {
    ...cursorCloudBaseIdentityFlags,
    cwd: requiredString('cwd', 'Absolute Cursor Cloud checkout path used for local code-graph inspection'),
    endpoint: optionalString('endpoint', 'Managed remote Streamable HTTP MCP endpoint'),
    json: boolean('json', 'Print a machine-readable verification receipt'),
    mode: cursorCloudMode,
    shareId: optionalString('share-id', 'Opaque managed remote memory share identifier'),
    teams: repeatedString('team', 'Personal Git memory share; repeat to verify one MCP share set'),
  },
  ({agentId, cwd, endpoint, json, mode, shareId, teams, user}) =>
    withRuntimeEffect(config =>
      runCursorCloudVerify(cursorCloudRuntime(config, agentId, user), {cwd, endpoint, json, mode, shareId, teams}),
    ),
).pipe(Command.withDescription('Verify the Cursor Cloud runtime, share, and local graph checkout'));

const cursorCloudAttest = makeCursorCloudAttestCommand({boolean, requiredString}, options =>
  withRuntimeEffect(() => runCursorAttestationCommand(options)),
);

const cursorCloud = Command.make('cursor').pipe(
  Command.withDescription('Configure Threadnote for Cursor Cloud Agents'),
  Command.withSubcommands([cursorCloudConfig, cursorCloudBootstrap, cursorCloudVerify, cursorCloudAttest]),
);

const cloud = Command.make('cloud').pipe(
  Command.withDescription('Cloud-agent integrations'),
  Command.withSubcommands([cursorCloud]),
);

const shareInit = Command.make(
  'init',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    push: negatedBoolean('push', 'Do not push the generated housekeeping commit'),
    readOnly: boolean('read-only', 'Persist the team as fetch/ingest-only and disable publication or pushes'),
    remoteUrl: argument('remote-url', 'git remote URL of the shared memories repo'),
    setDefault: boolean('set-default', 'Mark this team as the default'),
    team: optionalString('team', 'Team name; defaults to default'),
  },
  ({remoteUrl, ...options}) => withRuntimeEffect(config => runShareInit(config, remoteUrl, options)),
).pipe(Command.withDescription('Configure a shared memories repo for a team'));

const shareStatus = Command.make(
  'status',
  {dryRun: boolean('dry-run', 'Print git commands'), team: optionalString('team', 'Team name')},
  options => withRuntimeEffect(config => runShareStatus(config, options)),
).pipe(Command.withDescription('Show git status and ahead/behind counts for a shared team'));

const shareSync = Command.make(
  'sync',
  {
    autoCommit: negatedBoolean('auto-commit', 'Refuse to sync with uncommitted local changes'),
    dryRun: boolean('dry-run', 'Print actions without running them'),
    message: optionalString('message', 'Commit message for local edits'),
    push: negatedBoolean('push', 'Skip the push step'),
    team: optionalString('team', 'Team name; omit to sync all teams'),
  },
  options => withMutationRuntimeEffect(config => runShareSync(config, options)),
).pipe(Command.withDescription('Pull, reindex, and push shared memories repos'));

const shareConflicts = Command.make(
  'conflicts',
  {team: optionalString('team', 'Team name; defaults to all teams')},
  options => withRuntimeEffect(config => runShareConflicts(config, options)),
).pipe(Command.withDescription('List pending shared memory conflicts'));

const conflictShow = Command.make(
  'show',
  {
    conflictId: argument('conflict-id', 'Conflict id, relative path, or shared threadnote:// URI'),
    team: optionalString('team', 'Team name for a relative path'),
  },
  ({conflictId, ...options}) => withRuntimeEffect(config => runShareConflictShow(config, conflictId, options)),
).pipe(Command.withDescription('Show local/shared content for one conflict'));

const conflictResolve = Command.make(
  'resolve',
  {
    conflictId: argument('conflict-id', 'Conflict id, relative path, or shared threadnote:// URI'),
    dryRun: boolean('dry-run', 'Print actions without writing'),
    fromFile: optionalString('from-file', 'Merged memory markdown to write to both stores'),
    message: optionalString('message', 'Commit message'),
    push: negatedBoolean('push', 'Skip pushing the resolution commit'),
    take: optionalChoice('take', ['shared', 'local'], 'Resolution side'),
    team: optionalString('team', 'Team name for a relative path'),
  },
  ({conflictId, ...options}) => withRuntimeEffect(config => runShareConflictResolve(config, conflictId, options)),
).pipe(Command.withDescription('Resolve one pending shared memory conflict'));

const shareConflict = Command.make('conflict').pipe(
  Command.withDescription('Inspect or resolve one pending shared memory conflict'),
  Command.withSubcommands([conflictShow, conflictResolve]),
);

const {shareMaterialize, sharePropose, sharePublish} = makeShareMemoryCommands(
  (uri, options) => withRuntimeEffect(config => runSharePublish(config, uri, options)),
  options => withRuntimeEffect(config => runKnowledgeDeltaGitProposalExport(config, options)),
  options => withRuntimeEffect(config => runKnowledgeDeltaGitProposalMaterialize(config, options)),
);

const artifactFlags = {
  dryRun: publishFlags.dryRun,
  message: publishFlags.message,
  preview: publishFlags.preview,
  push: publishFlags.push,
  redact: boolean(
    'redact',
    'Ignored for agent artifacts; the memory-share scrubber does not run on skills, commands, or packs',
  ),
  team: publishFlags.team,
  agent: optionalChoice('agent', ['codex', 'claude', 'cursor'], 'Agent owner'),
  allowBinary: boolean(
    'allow-binary',
    'Include binary files; embedded binary credentials and machine-local paths in binaries still block',
  ),
  force: boolean('force', 'Replace existing shared files with different content'),
  kind: optionalChoice('kind', ['skill', 'command', 'pack'], 'Shared artifact kind'),
  name: optionalString('name', 'Shared artifact name'),
} as const;

const sharePublishArtifact = Command.make(
  'publish-artifact',
  {...artifactFlags, path: argument('path', 'Path to SKILL.md or a Claude command file')},
  ({path, ...options}) => withRuntimeEffect(config => runSharePublishArtifact(config, path, options)),
).pipe(Command.withDescription('Publish a local agent skill or command into the shared team repo'));

const sharePublishBundle = Command.make(
  'publish-bundle',
  {...artifactFlags, manifest: argument('manifest', 'Path to a threadnote-bundle.json manifest')},
  ({manifest, ...options}) => withRuntimeEffect(config => runSharePublishBundle(config, manifest, options)),
).pipe(Command.withDescription('Publish a multi-skill constellation declared by a bundle manifest'));

const shareInstallArtifacts = Command.make(
  'install-artifacts',
  {
    agent: optionalChoice('agent', ['codex', 'claude', 'cursor'], 'Agent filter'),
    apply: boolean('apply', 'Actually write local artifact files'),
    dryRun: boolean('dry-run', 'Preview without writing files'),
    force: boolean('force', 'Replace existing installed artifacts'),
    kind: optionalChoice('kind', ['skill', 'command', 'pack'], 'Artifact kind filter'),
    name: optionalString('name', 'Shared artifact name filter'),
    sync: negatedBoolean('sync', 'Skip pulling shared updates first'),
    team: optionalString('team', 'Team name'),
  },
  options => withRuntimeEffect(config => runShareInstallArtifacts(config, options)),
).pipe(Command.withDescription('Install shared agent skills and commands from a team repo'));

const shareUnpublish = Command.make(
  'unpublish',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    message: optionalString('message', 'Commit message override'),
    push: negatedBoolean('push', 'Skip the push step'),
    team: optionalString('team', 'Team name'),
    uri: argument('resource-uri', 'Shared threadnote:// memory URI'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runShareUnpublish(config, uri, options)),
).pipe(Command.withDescription('Pull a shared memory back into the personal namespace'));

const shareList = Command.make('list', {dryRun: boolean('dry-run', 'Print without side effects')}, options =>
  withRuntimeEffect(config => runShareList(config, options)),
).pipe(Command.withDescription('List configured shared teams'));

const shareRename = Command.make(
  'rename',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    team: requiredString('team', 'Existing team name'),
    to: requiredString('to', 'New team name'),
  },
  options => withRuntimeEffect(config => runShareRename(config, options)),
).pipe(Command.withDescription('Rename a configured shared team'));

const shareSetUrl = Command.make(
  'set-url',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    remoteUrl: argument('remote-url', 'New git remote URL'),
    team: optionalString('team', 'Team name'),
  },
  ({remoteUrl, ...options}) => withRuntimeEffect(config => runShareSetUrl(config, remoteUrl, options)),
).pipe(Command.withDescription('Change a shared team git remote URL'));

const shareSetAccess = Command.make(
  'set-access',
  {
    dryRun: boolean('dry-run', 'Print the access change without writing it'),
    mode: requiredChoice('mode', ['read-only', 'read-write'], 'Persistent shared-team access mode'),
    team: optionalString('team', 'Team name'),
  },
  options => withRuntimeEffect(config => runShareSetAccess(config, options)),
).pipe(Command.withDescription('Set a shared team to read-only or read-write'));

const shareRemove = Command.make(
  'remove',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    keepFiles: boolean('keep-files', 'Keep worktree and gitdir files'),
    preserveLocal: boolean('preserve-local', 'Copy durable memories into the personal tree first'),
    team: optionalString('team', 'Team name'),
  },
  options => withRuntimeEffect(config => runShareRemove(config, options)),
).pipe(Command.withDescription('Forget a configured team and optionally delete its files'));

const share = Command.make('share').pipe(
  Command.withDescription('Share durable memories with teammates through a git-backed repository'),
  Command.withSubcommands([
    shareInit,
    shareStatus,
    shareSync,
    shareConflicts,
    shareConflict,
    sharePropose,
    shareMaterialize,
    sharePublish,
    sharePublishArtifact,
    sharePublishBundle,
    shareInstallArtifacts,
    shareUnpublish,
    shareList,
    shareRename,
    shareSetAccess,
    shareSetUrl,
    shareRemove,
  ]),
);

const exportPack = Command.make(
  'export-pack',
  {
    dryRun: boolean('dry-run', 'Print the native export without running it'),
    path: optionalString('path', 'Output .ovpack path'),
    uri: optionalString('uri', 'Source threadnote:// URI; defaults to the current user memories'),
  },
  options => withRuntimeEffect(config => runExportPack(config, options)),
).pipe(Command.withDescription('Export local Threadnote context to an .ovpack archive'));

const importPack = Command.make(
  'import-pack',
  {
    dryRun: boolean('dry-run', 'Print the native import without running it'),
    path: requiredString('path', 'Input .ovpack path'),
    targetUri: optionalString('target-uri', 'Target parent threadnote:// URI; defaults to the current user'),
  },
  options => withMutationRuntimeEffect(config => runImportPack(config, options)),
).pipe(Command.withDescription('Import an .ovpack archive into local Threadnote context'));

interface TopLevelCommandMetadata {
  readonly aliases?: readonly string[];
  readonly productionLog?: {
    readonly mode?: ProductionLogMode;
    readonly subcommands?: Readonly<Record<string, ProductionLogMode>>;
  };
}

const registerTopLevelCommand = <const Name extends string, CommandType>(
  canonicalName: Name,
  command: CommandType,
  metadata: TopLevelCommandMetadata = {},
) => ({
  aliases: metadata.aliases ?? [],
  canonicalName,
  command,
  productionLog: metadata.productionLog ?? {},
});

const topLevelCommandRegistrations = [
  registerTopLevelCommand('setup', makeSetupCommand(withRuntimeEffect), setupCommandMetadata),
  registerTopLevelCommand('activate', makeActivationCommand(withScopedRuntime)),
  registerTopLevelCommand('guidance', makeGuidanceCommand(withScopedRuntime), guidanceCommandMetadata),
  registerTopLevelCommand('agents', makeAgentsCommand(withScopedRuntime), agentsCommandMetadata),
  registerTopLevelCommand('manage', manage),
  registerTopLevelCommand('processes', processes, {productionLog: {mode: 'never'}}),
  registerTopLevelCommand('doctor', doctor),
  registerTopLevelCommand('install', install),
  registerTopLevelCommand('version', version),
  registerTopLevelCommand('logs', logs),
  registerTopLevelCommand('telemetry', telemetry, {productionLog: {mode: 'never'}}),
  registerTopLevelCommand('jev', makeJevCommand(), {productionLog: {mode: 'never'}}),
  registerTopLevelCommand('image-projection', imageProjection, {productionLog: {mode: 'never'}}),
  registerTopLevelCommand('report-issue', reportIssue, {productionLog: {mode: 'never'}}),
  registerTopLevelCommand('update', update),
  registerTopLevelCommand('auto-update-worker', autoUpdateWorker),
  registerTopLevelCommand('post-update', postUpdate),
  registerTopLevelCommand('development-install-repair', developmentInstallRepair),
  registerTopLevelCommand('repair', repair),
  registerTopLevelCommand('start', start),
  registerTopLevelCommand('stop', stop),
  registerTopLevelCommand('uninstall', uninstall),
  registerTopLevelCommand('models', models),
  registerTopLevelCommand('index', indexCommand),
  registerTopLevelCommand('graph', graphCommand),
  registerTopLevelCommand('composer', makeComposerCommands(withScopedRuntime)),
  registerTopLevelCommand('local-ai', localAi),
  registerTopLevelCommand('source', source, {
    productionLog: {
      subcommands: {add: 'requires-apply', remove: 'requires-apply', sync: 'requires-apply'},
    },
  }),
  registerTopLevelCommand('projection', projection, {
    productionLog: {
      subcommands: {
        add: 'requires-apply',
        publish: 'requires-apply',
        remove: 'requires-apply',
        sync: 'requires-apply',
      },
    },
  }),
  registerTopLevelCommand('open', openMemory),
  registerTopLevelCommand('inbox', inbox, {
    productionLog: {subcommands: {scan: 'requires-apply'}},
  }),
  registerTopLevelCommand('seed', seed),
  registerTopLevelCommand('init-manifest', initManifest),
  registerTopLevelCommand('seed-skills', seedSkills),
  registerTopLevelCommand('mcp-install', mcpInstall, {productionLog: {mode: 'requires-apply'}}),
  registerTopLevelCommand('install-hooks', installHooks, {productionLog: {mode: 'requires-apply'}}),
  registerTopLevelCommand('pre-compact-hook', preCompactHook),
  registerTopLevelCommand('cursor-hook', cursorHook),
  registerTopLevelCommand('session-start-hook', sessionStartHook),
  registerTopLevelCommand('code-brief-hook', codeBriefHook),
  registerTopLevelCommand('codex-resume-hook', codexResumeHook),
  registerTopLevelCommand('remember', remember),
  registerTopLevelCommand('finalize-code-refs', finalizeCodeRefs),
  registerTopLevelCommand('migrate', migrateHome, {productionLog: {mode: 'requires-apply'}}),
  registerTopLevelCommand('migrate-memories', migrateMemories),
  registerTopLevelCommand('migrate-lifecycle', migrateLifecycle, {
    productionLog: {mode: 'requires-apply'},
  }),
  registerTopLevelCommand('migrate-projects', migrateProjectNames, {
    productionLog: {mode: 'requires-apply'},
  }),
  registerTopLevelCommand('migrate-project-names', migrateProjectNamesCompatibility, {
    productionLog: {mode: 'requires-apply'},
  }),
  registerTopLevelCommand('enrich-memories', enrichMemories, {
    productionLog: {mode: 'requires-apply'},
  }),
  registerTopLevelCommand('recall', recall),
  registerTopLevelCommand('recall-feedback', recallFeedback),
  registerTopLevelCommand('workset', workset),
  registerTopLevelCommand('project', project),
  registerTopLevelCommand('context', context),
  registerTopLevelCommand('value', value, {productionLog: {subcommands: {report: 'requires-apply', pilot: 'never'}}}),
  registerTopLevelCommand('procedure', procedure, {productionLog: {subcommands: {verify: 'requires-apply'}}}),
  registerTopLevelCommand('compact', compact, {productionLog: {mode: 'requires-apply'}}),
  registerTopLevelCommand('closeout', closeout, {productionLog: {subcommands: {apply: 'always'}}}),
  registerTopLevelCommand('read', read),
  registerTopLevelCommand('list', list, {aliases: ['ls']}),
  registerTopLevelCommand('handoff', handoff),
  registerTopLevelCommand('archive', archive),
  registerTopLevelCommand('forget', forget),
  registerTopLevelCommand('cloud', cloud),
  registerTopLevelCommand('share', share, {
    productionLog: {
      subcommands: {
        'install-artifacts': 'requires-apply',
        publish: 'skips-on-preview',
        'publish-artifact': 'skips-on-preview',
        'publish-bundle': 'skips-on-preview',
      },
    },
  }),
  registerTopLevelCommand('export-pack', exportPack),
  registerTopLevelCommand('import-pack', importPack),
] as const;

const inspectRegisteredCliInvocation = makeCliInvocationInspector(topLevelCommandRegistrations);
export const threadnoteCommand = root.pipe(
  Command.withDescription('Threadnote shared context workflow for development agents'),
  Command.withSubcommands(topLevelCommandRegistrations.map(registration => registration.command)),
);
export function inspectCliInvocation(arguments_: readonly string[]): CliInvocationInspection {
  return inspectRegisteredCliInvocation(arguments_);
}
export {CliError, normalizeCliArguments, type CliInvocationInspection};
