import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {
  installAgentIntegration,
  installAgentIntegrationInTransaction,
  migrateLegacyAgentIntegrationsInTransaction,
  readAgentIntegrationRegistry,
  registeredAgentClients,
} from '../agent_integration/index.js';
import {resolveAgentHostPaths} from '../agent_integration/host_paths.js';
import {
  emptyAgentIntegrationRegistry,
  setupCompletionForSuccessfulInstall,
  type AgentIntegrationMcpReceipt,
  withAgentIntegrationLock,
} from '../agent_integration/registry.js';
import {commandLauncherPath} from '../command-shim.js';
import {THREADNOTE_MCP_CLIENT_ENV, THREADNOTE_MCP_NAME, THREADNOTE_MCP_SURFACE_ENV} from '../constants.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {maybeRunEffect} from '../effect/command-presentation.js';
import {SystemInfo} from '@threadnote/platform/system';
import {relocateManagedOmpHook} from '../omp_hooks.js';
import {DEFAULT_MCP_TOOLSET, MCP_TOOLSET_ENV, type McpToolset} from './toolset.js';
import {runCodexOrgMcpInstall} from './codex_org_attach.js';
import {
  ComposerAttachError,
  THREADNOTE_ORG_MCP_NAME,
  buildComposerHttpMcpEntry,
  buildCopilotComposerHttpMcpEntry,
  isComposerHttpEntry,
  composerHttpEntryMatches,
  resolveComposerAttach,
  withComposerHttpMcpEntry,
  isManagedComposerHttpEntry,
  type ComposerHttpMcpEntry,
  type ComposerClientHttpMcpEntry,
  type CopilotComposerHttpMcpEntry,
  type ComposerShareBinding,
} from './composer_attach.js';
import type {AgentClient, ClaudeMcpScope, DoctorCheck, McpInstallOptions} from '../types.js';
import type {JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  ensureDirectory,
  exists,
  findExecutable,
  findWorkingExecutable,
  formatShellCommand,
  isJsonObject,
  parseJsonConfigObject,
  readFileIfExists,
  removePathIfExists,
} from '../utils.js';
import {expandPath, getInvocationCwd} from '@threadnote/platform/paths';
import {withSetupMutationLock} from '../setup/lock.js';

export function isPersonalThreadnoteHome(
  agentContextHome: string,
  userHome: string,
  resolvePath: (...parts: string[]) => string,
): boolean {
  return resolvePath(agentContextHome) === resolvePath(userHome, '.threadnote');
}

const isPersonalThreadnoteHomeEffect = Effect.fn('mcp.isPersonalHome')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return isPersonalThreadnoteHome(config.agentContextHome, system.homeDirectory, (...parts) => path.resolve(...parts));
});

export function runMcpInstall(config: RuntimeConfig, agent: AgentClient, options: McpInstallOptions) {
  const operation = Effect.gen(function* () {
    const attach = yield* Effect.try({
      try: () => resolveComposerAttach(options),
      catch: cause =>
        Schema.is(ComposerAttachError)(cause)
          ? cause
          : McpOperationError.make({message: 'Invalid organization attach options.'}),
    });
    if (attach && options.name === THREADNOTE_ORG_MCP_NAME) {
      return yield* McpOperationError.make({
        message:
          'Organization composer attach cannot use --name threadnote-org; that name is reserved for the HTTP composer entry.',
      });
    }
    if (attach?.callback && agent !== 'codex') {
      return yield* McpOperationError.make({message: 'Organization callback options are supported only for Codex.'});
    }
    if (options.composerOAuthScopes?.length && agent !== 'cursor' && agent !== 'codex') {
      return yield* McpOperationError.make({
        message: 'Additional organization OAuth scopes are supported only for Cursor and Codex.',
      });
    }
    if (attach && agent === 'codex') return yield* runCodexOrgMcpInstall(attach, options.apply === true);
    const install = Effect.gen(function* () {
      const registry = (yield* readAgentIntegrationRegistry(config)) ?? emptyAgentIntegrationRegistry(false);
      const setupCompletion = options.apply ? setupCompletionForSuccessfulInstall(registry, {host: agent}) : undefined;
      yield* runMcpInstallInTransaction(config, agent, options);
      return setupCompletion;
    });
    return yield* options.apply === true ? withAgentIntegrationLock(config, install) : install;
  });
  return options.apply !== true || options.setupLockHeld === true
    ? operation
    : withSetupMutationLock(config.agentContextHome, operation);
}

const runMcpInstallInTransaction = Effect.fn('mcp.runInstallInTransaction')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  options: McpInstallOptions,
) {
  const name = options.name ?? THREADNOTE_MCP_NAME;
  const apply = options.apply === true;
  const toolset = options.toolset ?? DEFAULT_MCP_TOOLSET;
  const attach = yield* Effect.try({
    try: () => resolveComposerAttach(options),
    catch: cause =>
      Schema.is(ComposerAttachError)(cause)
        ? cause
        : McpOperationError.make({
            cause,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });
  const personalHome = yield* isPersonalThreadnoteHomeEffect(config);
  const project = options.project?.trim() || (agent === 'claude' ? undefined : options.cwd);
  if (attach && (agent === 'cursor' || agent === 'copilot') && !project) {
    return yield* McpOperationError.make({
      message:
        agent === 'copilot'
          ? 'Organization composer attach must write a project .vscode/mcp.json; pass --project so the user Copilot mcp.json is not rewritten.'
          : 'Organization composer attach must write a project .cursor/mcp.json; pass --project so personal ~/.cursor/mcp.json is not rewritten.',
    });
  }
  if (!personalHome && (agent === 'cursor' || agent === 'copilot' || agent === 'omp') && !project) {
    return yield* McpOperationError.make({
      message:
        agent === 'omp'
          ? 'This THREADNOTE_HOME is not the personal ~/.threadnote home; pass --project to write project .omp/mcp.json instead of rewriting the user omp mcp.json.'
          : agent === 'copilot'
            ? 'This THREADNOTE_HOME is not the personal ~/.threadnote home; pass --project to write project .vscode/mcp.json instead of rewriting the user Copilot mcp.json.'
            : 'This THREADNOTE_HOME is not the personal ~/.threadnote home; pass --project to write project MCP config instead of rewriting ~/.cursor/mcp.json.',
    });
  }
  const scope = agent === 'claude' ? (options.scope ?? 'user') : undefined;
  const cwd = options.cwd ?? (agent === 'claude' && scope !== 'user' ? yield* getInvocationCwd() : undefined);
  const legacyInferredClients =
    apply &&
    personalHome &&
    project === undefined &&
    (scope === undefined || scope === 'user') &&
    (yield* readAgentIntegrationRegistry(config)) === undefined
      ? yield* inferConfiguredMcpClients(config)
      : undefined;

  if (attach && name === THREADNOTE_ORG_MCP_NAME) {
    return yield* McpOperationError.make({
      message:
        'Organization composer attach cannot use --name threadnote-org; that name is reserved for the HTTP composer entry.',
    });
  }

  if (attach && agent !== 'cursor' && agent !== 'copilot') {
    return yield* McpOperationError.make({
      message: 'Organization composer attach writes a second HTTP MCP entry for cursor and copilot.',
    });
  }

  if (agent === 'cursor') {
    yield* runCursorMcpInstall(config, name, {
      apply,
      attach,
      dryRunApplyCommand: options.dryRunApplyCommand,
      project,
      toolset,
    });
    yield* finishAgentIntegrationInstall(config, agent, {
      apply,
      cwd: project,
      legacyInferredClients,
      name,
      toolset,
    });
    return;
  }
  if (agent === 'copilot') {
    yield* runCopilotMcpInstall(config, name, {
      apply,
      attach,
      dryRunApplyCommand: options.dryRunApplyCommand,
      project,
      toolset,
    });
    yield* finishAgentIntegrationInstall(config, agent, {
      apply,
      cwd: project,
      legacyInferredClients,
      name,
      toolset,
    });
    return;
  }
  if (agent === 'omp') {
    const path = yield* Path.Path;
    const projectDirectory = project === undefined ? undefined : yield* expandPath(project);
    const hostRoot =
      projectDirectory === undefined
        ? (yield* resolveAgentHostPaths('omp', options.hostRoot))!.agentRoot
        : path.join(projectDirectory, '.omp');
    yield* runOmpMcpInstall(config, name, {
      apply,
      dryRunApplyCommand: options.dryRunApplyCommand,
      hostRoot,
      project: projectDirectory,
      toolset,
    });
    yield* finishAgentIntegrationInstall(config, agent, {
      apply,
      cwd: projectDirectory,
      hostRoot,
      legacyInferredClients,
      name,
      toolset,
    });
    return;
  }

  const agentExecutable = apply ? yield* requiredMcpAgentExecutable(agent) : agent;
  const command = yield* buildMcpInstallCommand(config, agent, agentExecutable, name, {cwd, scope, toolset});
  const removeCommand = yield* buildMcpRemoveCommand(agent, agentExecutable, name, {cwd, scope});

  if (!apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify the selected agent config.`
        : 'Dry run. Re-run with --apply to modify the selected agent config.',
    );
    if (removeCommand.cwd || command.cwd) {
      yield* Console.log(`Command working directory: ${removeCommand.cwd ?? command.cwd}`);
    }
    yield* Console.log(formatShellCommand(removeCommand.executable, removeCommand.args));
    yield* Console.log(formatShellCommand(command.executable, command.args));
    yield* printMcpSnippet(config, agent, name, {scope, toolset});
    yield* installAgentIntegration(config, agent, {
      cwd,
      dryRun: true,
      name,
      scope,
      toolset,
    });
    return;
  }

  if (
    yield* cliMcpConfigurationMatches(config, agent, agentExecutable, name, {
      cwd,
      scope,
      toolset,
    })
  ) {
    yield* Console.log(`Already configured: ${agent} MCP ${name}`);
  } else {
    yield* maybeRunEffect(false, removeCommand.executable, removeCommand.args, {
      allowFailure: true,
      cwd: removeCommand.cwd,
    });
    yield* maybeRunEffect(false, command.executable, command.args, {cwd: command.cwd});
  }
  yield* finishAgentIntegrationInstall(config, agent, {
    apply,
    cwd,
    legacyInferredClients,
    name,
    scope,
    toolset,
  });
});

const finishAgentIntegrationInstall = Effect.fn('mcp.finishAgentIntegrationInstall')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  options: {
    readonly apply: boolean;
    readonly cwd?: string;
    readonly hostRoot?: string;
    readonly legacyInferredClients?: readonly AgentClient[];
    readonly name: string;
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  const receipt: AgentIntegrationMcpReceipt = {
    ...(options.cwd === undefined ? {} : {cwd: options.cwd}),
    ...(options.hostRoot === undefined ? {} : {hostRoot: options.hostRoot}),
    name: options.name,
    repair: true,
    ...(options.scope === undefined ? {} : {scope: options.scope}),
    toolset: options.toolset,
  };
  if (!options.apply) {
    yield* installAgentIntegrationInTransaction(config, agent, receipt, true);
    return;
  }
  if (options.legacyInferredClients !== undefined) {
    yield* migrateLegacyAgentIntegrationsInTransaction(config, options.legacyInferredClients, false);
  }
  yield* installAgentIntegrationInTransaction(config, agent, receipt, false);
});

class McpOperationError extends Schema.TaggedError<McpOperationError>()('McpOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export const mcpConfigurationChecks = Effect.fn('mcp.configurationChecks')(function* (
  config: RuntimeConfig,
  inferredClients?: readonly AgentClient[],
) {
  const checks: DoctorCheck[] = [];
  const registry = yield* readAgentIntegrationRegistry(config);
  const inferred = registry === undefined ? (inferredClients ?? (yield* inferConfiguredMcpClients(config))) : [];
  const clients = registry === undefined ? inferred : registeredAgentClients(registry);
  const personalHome = yield* isPersonalThreadnoteHomeEffect(config);
  for (const agent of clients) {
    const receipt = registry?.hosts[agent];
    const name = receipt?.mcp.name ?? THREADNOTE_MCP_NAME;
    const repair = receipt?.mcp.repair ?? true;
    if (receipt?.mcp.external === true) {
      checks.push({
        detail: `${name} is registered in the Cursor Cloud Dashboard; verify its status from an active Cloud Agent`,
        name: `${agent} MCP`,
        status: 'warn',
      });
      continue;
    }
    if (!personalHome && (agent === 'cursor' || agent === 'copilot' || agent === 'omp')) {
      const project = receipt?.mcp.cwd?.trim();
      if (!project) continue;
      if (agent === 'omp') {
        checks.push(
          yield* jsonMcpConfigurationCheck(
            'omp MCP',
            yield* ompMcpConfigPath(project, receipt?.mcp.hostRoot),
            'mcpServers',
            name,
            repair,
            true,
          ),
        );
        continue;
      }
      const containerKey = agent === 'cursor' ? 'mcpServers' : 'servers';
      const configPath =
        agent === 'cursor' ? yield* cursorMcpConfigPath(project) : yield* copilotMcpConfigPath(project);
      checks.push(yield* orgComposerConfigurationCheck(`${agent} org composer`, configPath, containerKey));
      continue;
    }
    if (agent === 'cursor') {
      checks.push(
        yield* jsonMcpConfigurationCheck(
          'cursor MCP',
          yield* cursorMcpConfigPath(receipt?.mcp.cwd),
          'mcpServers',
          name,
          repair,
        ),
      );
      continue;
    }
    if (agent === 'copilot') {
      checks.push(
        yield* jsonMcpConfigurationCheck(
          'copilot MCP',
          yield* copilotMcpConfigPath(receipt?.mcp.cwd),
          'servers',
          name,
          repair,
        ),
      );
      continue;
    }
    if (agent === 'omp') {
      checks.push(
        yield* jsonMcpConfigurationCheck(
          'omp MCP',
          yield* ompMcpConfigPath(receipt?.mcp.cwd, receipt?.mcp.hostRoot),
          'mcpServers',
          name,
          repair,
          true,
        ),
      );
      continue;
    }
    const executable = yield* findMcpAgentExecutable(agent);
    if (!executable) {
      checks.push({
        detail: `${agent} command unavailable; cannot inspect registered MCP ${name}`,
        name: `${agent} MCP`,
        status: 'warn',
      });
      continue;
    }
    const result = yield* runCommandEffect(executable, ['mcp', 'get', name], {
      allowFailure: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
    }).pipe(Effect.option);
    const configured = result._tag === 'Some' && result.value.exitCode === 0;
    const current = configured && isBrokerMcpCommandOutput(result.value.stdout);
    checks.push({
      detail: current
        ? `${name} broker configured`
        : configured
          ? repair
            ? `${name} uses the legacy direct server command; repair will migrate it to the session broker`
            : `${name} configuration predates receipts; run threadnote mcp-install ${agent} --apply to manage it`
          : repair
            ? `missing or unreadable; repair will configure ${name}`
            : `missing or unreadable; run threadnote mcp-install ${agent} --apply to manage it`,
      name: `${agent} MCP`,
      status: current ? 'ok' : 'warn',
    });
  }
  return checks;
});

function orgComposerConfigurationCheck(checkName: string, configPath: string, containerKey: 'mcpServers' | 'servers') {
  return Effect.gen(function* () {
    const raw = yield* readFileIfExists(configPath);
    const parsed = raw ? parseJsonConfigObject(raw) : undefined;
    const container = parsed?.[containerKey];
    const entry = isJsonObject(container) ? container[THREADNOTE_ORG_MCP_NAME] : undefined;
    const configured = isComposerHttpEntry(entry);
    return {
      detail: configured
        ? `${THREADNOTE_ORG_MCP_NAME} attached in ${configPath}`
        : `${configPath} missing ${THREADNOTE_ORG_MCP_NAME} composer entry`,
      name: checkName,
      status: configured ? ('ok' as const) : ('warn' as const),
    };
  });
}

function jsonMcpConfigurationCheck(
  checkName: string,
  configPath: string,
  containerKey: 'mcpServers' | 'servers',
  serverName: string,
  repair: boolean,
  checkDisabled = false,
) {
  return Effect.gen(function* () {
    const raw = yield* readFileIfExists(configPath);
    const parsed = raw ? parseJsonConfigObject(raw) : undefined;
    const container = parsed?.[containerKey];
    const server = isJsonObject(container) && isJsonObject(container[serverName]) ? container[serverName] : undefined;
    const configured = server !== undefined;
    const disabled = checkDisabled && server !== undefined && ompMcpServerIsDisabled(parsed, serverName, server);
    const current = configured && !disabled && isBrokerMcpServerConfig(server);
    return {
      detail: current
        ? `${serverName} broker configured in ${configPath}`
        : disabled
          ? repair
            ? `${configPath} has ${serverName} disabled; repair will re-enable it`
            : `${configPath} has ${serverName} disabled; run threadnote mcp-install ${checkName.split(' ')[0]} --apply to manage it`
          : configured
            ? repair
              ? `${configPath} uses the legacy direct server command; repair will migrate it to the session broker`
              : `${configPath} predates receipts; run threadnote mcp-install ${checkName.split(' ')[0]} --apply to manage it`
            : repair
              ? `${configPath} missing entry`
              : `${configPath} missing entry; run threadnote mcp-install ${checkName.split(' ')[0]} --apply to manage it`,
      name: checkName,
      status: current ? ('ok' as const) : ('warn' as const),
    };
  });
}

export const inferConfiguredMcpClients = Effect.fn('mcp.inferConfiguredClients')(function* (config: RuntimeConfig) {
  const clients: AgentClient[] = [];
  for (const agent of ['codex', 'claude'] as const) {
    const executable = yield* findMcpAgentExecutable(agent);
    if (!executable) continue;
    const result = yield* runCommandEffect(executable, ['mcp', 'get', THREADNOTE_MCP_NAME], {
      allowFailure: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
    }).pipe(Effect.option);
    if (result._tag === 'Some' && result.value.exitCode === 0) clients.push(agent);
  }
  if (yield* isPersonalThreadnoteHomeEffect(config)) {
    const cursor = yield* readJsonMcpServer(yield* cursorMcpConfigPath(), 'mcpServers', THREADNOTE_MCP_NAME);
    if (cursor !== undefined) clients.push('cursor');
    const copilot = yield* readJsonMcpServer(yield* copilotMcpConfigPath(), 'servers', THREADNOTE_MCP_NAME);
    if (copilot !== undefined) clients.push('copilot');
    const omp = yield* readJsonMcpServer(yield* ompMcpConfigPath(), 'mcpServers', THREADNOTE_MCP_NAME);
    if (omp !== undefined) clients.push('omp');
  }
  return clients;
});

function readJsonMcpServer(configPath: string, containerKey: 'mcpServers' | 'servers', serverName: string) {
  return Effect.gen(function* () {
    const raw = yield* readFileIfExists(configPath);
    const parsed = raw ? parseJsonConfigObject(raw) : undefined;
    const container = parsed?.[containerKey];
    return isJsonObject(container) && isJsonObject(container[serverName]) ? container[serverName] : undefined;
  });
}

function isBrokerMcpCommandOutput(output: string): boolean {
  return /(?:^|[\\/])threadnote-mcp-server(?:\.cmd)?(?:\s|$)/im.test(output);
}

function isBrokerMcpServerConfig(server: JsonObject): boolean {
  const command = server.command;
  const arguments_ = server.args;
  const values = [command, ...(Array.isArray(arguments_) ? arguments_ : [])];
  return values.some(
    value => typeof value === 'string' && /(?:^|[\\/])threadnote-mcp-server(?:\.cmd)?$/i.test(value.trim()),
  );
}

const cliMcpConfigurationMatches = Effect.fn('mcp.cliConfigurationMatches')(function* (
  config: RuntimeConfig,
  agent: 'claude' | 'codex',
  agentExecutable: string,
  name: string,
  options: {
    readonly cwd?: string;
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  const result = yield* runCommandEffect(
    agentExecutable,
    agent === 'codex' ? ['mcp', 'get', name, '--json'] : ['mcp', 'get', name],
    {
      allowFailure: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
      cwd: options.cwd,
    },
  ).pipe(Effect.option);
  if (result._tag === 'None' || result.value.exitCode !== 0) return false;

  const command = yield* mcpAdapterCommand();
  const environment = mcpEnvironmentObject(config, options.toolset, agent);
  return agent === 'codex'
    ? codexMcpConfigurationMatches(result.value.stdout, command, environment)
    : claudeMcpConfigurationMatches(result.value.stdout, command, environment, options.scope ?? 'user');
});

function codexMcpConfigurationMatches(output: string, command: readonly string[], environment: JsonObject): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  if (!isJsonObject(parsed) || parsed.enabled !== true || !isJsonObject(parsed.transport)) return false;
  const transport = parsed.transport;
  return (
    transport.type === 'stdio' &&
    transport.command === command[0] &&
    stringArrayEquals(transport.args, command.slice(1)) &&
    managedMcpEnvironmentMatches(transport.env, environment)
  );
}

function claudeMcpConfigurationMatches(
  output: string,
  command: readonly string[],
  environment: JsonObject,
  scope: ClaudeMcpScope,
): boolean {
  const lines = output.split(/\r?\n/);
  const field = (name: string) =>
    lines
      .find(line => line.startsWith(`  ${name}:`))
      ?.slice(name.length + 3)
      .trim();
  const environmentStart = lines.findIndex(line => line.trim() === 'Environment:');
  if (environmentStart < 0) return false;
  const actualEnvironment: Record<string, string> = {};
  for (const line of lines.slice(environmentStart + 1)) {
    if (!line.startsWith('    ')) break;
    const entry = line.trim();
    const equalsAt = entry.indexOf('=');
    if (equalsAt <= 0) return false;
    actualEnvironment[entry.slice(0, equalsAt)] = entry.slice(equalsAt + 1);
  }
  const expectedScope = scope === 'user' ? 'User config' : scope === 'local' ? 'Local config' : 'Project config';
  return (
    field('Type') === 'stdio' &&
    field('Command') === command[0] &&
    field('Args') === command.slice(1).join(' ') &&
    field('Scope')?.startsWith(expectedScope) === true &&
    managedMcpEnvironmentMatches(actualEnvironment, environment)
  );
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function managedMcpEnvironmentMatches(value: unknown, expected: JsonObject): boolean {
  return isJsonObject(value) && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function jsonMcpConfigurationMatches(
  currentContent: string | undefined,
  containerKey: 'mcpServers' | 'servers',
  name: string,
  expected: JsonObject,
  checkDisabled = false,
): boolean {
  if (currentContent === undefined) return false;
  const parsed = parseJsonConfigObject(currentContent);
  const container = parsed?.[containerKey];
  const actual = isJsonObject(container) && isJsonObject(container[name]) ? container[name] : undefined;
  const expectedArgs = expected.args;
  if (
    actual === undefined ||
    (checkDisabled && ompMcpServerIsDisabled(parsed, name, actual)) ||
    typeof expected.command !== 'string' ||
    !Array.isArray(expectedArgs) ||
    !expectedArgs.every(argument => typeof argument === 'string') ||
    !isJsonObject(expected.env)
  ) {
    return false;
  }
  return (
    actual.command === expected.command &&
    stringArrayEquals(actual.args, expectedArgs) &&
    (expected.type === undefined || actual.type === expected.type) &&
    managedMcpEnvironmentMatches(actual.env, expected.env)
  );
}

function ompMcpServerIsDisabled(config: JsonObject | undefined, name: string, server: JsonObject): boolean {
  if (Array.isArray(config?.disabledServers) && config.disabledServers.includes(name)) return true;
  if (Array.isArray(config?.enabledServers) && config.enabledServers.includes(name)) return false;
  return server.enabled === false;
}

function jsonComposerConfigurationMatches(
  currentContent: string | undefined,
  containerKey: 'mcpServers' | 'servers',
  expected: ComposerClientHttpMcpEntry,
): boolean {
  if (currentContent === undefined) return false;
  const parsed = parseJsonConfigObject(currentContent);
  const container = parsed?.[containerKey];
  const actual = isJsonObject(container) ? container[THREADNOTE_ORG_MCP_NAME] : undefined;
  return composerHttpEntryMatches(actual, expected);
}

const runCursorMcpInstall = Effect.fn('mcp.runCursorInstall')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly attach?: ComposerShareBinding;
    readonly dryRunApplyCommand?: string;
    readonly project?: string;
    readonly toolset: McpToolset;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = yield* cursorMcpConfigPath(options.project);
  const serverConfig = yield* buildCursorMcpServerConfig(config, {
    toolset: options.toolset,
  });
  const composerEntry = options.attach
    ? buildComposerHttpMcpEntry(
        options.attach.url,
        options.attach.shareId,
        options.attach.clientId,
        options.attach.additionalScopes,
      )
    : undefined;
  const currentContent = yield* readFileIfExists(path);
  const current =
    jsonMcpConfigurationMatches(currentContent, 'mcpServers', name, serverConfig) &&
    (composerEntry === undefined || jsonComposerConfigurationMatches(currentContent, 'mcpServers', composerEntry));
  const nextContent = renderCursorMcpConfig(path, currentContent, name, serverConfig, composerEntry);

  if (!options.apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify Cursor MCP config.`
        : 'Dry run. Re-run with --apply to modify Cursor MCP config.',
    );
    yield* printCursorMcpSnippet(config, name, {
      attach: options.attach,
      project: options.project,
      toolset: options.toolset,
    });
    return;
  }

  if (current || currentContent === nextContent) {
    yield* Console.log(`Already configured: ${path}`);
    return;
  }
  yield* ensureDirectory(pathService.dirname(path), false);
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(
    currentContent === undefined ? `Wrote Cursor MCP config: ${path}` : `Updated Cursor MCP config: ${path}`,
  );
});

const runCopilotMcpInstall = Effect.fn('mcp.runCopilotInstall')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly attach?: ComposerShareBinding;
    readonly dryRunApplyCommand?: string;
    readonly project?: string;
    readonly toolset: McpToolset;
  },
) {
  if (options.attach && !options.project) {
    return yield* McpOperationError.make({
      message:
        'Organization composer attach must write a project MCP config; pass --project so the user Copilot mcp.json is not rewritten.',
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = options.project
    ? pathService.join(pathService.resolve(options.project), '.vscode', 'mcp.json')
    : yield* copilotMcpConfigPath();
  const serverConfig = yield* buildCopilotMcpServerConfig(config, {
    toolset: options.toolset,
  });
  const composerEntry = options.attach
    ? buildCopilotComposerHttpMcpEntry(options.attach.url, options.attach.shareId, options.attach.clientId)
    : undefined;
  const currentContent = yield* readFileIfExists(path);
  const current =
    jsonMcpConfigurationMatches(currentContent, 'servers', name, serverConfig) &&
    (composerEntry === undefined || jsonComposerConfigurationMatches(currentContent, 'servers', composerEntry));
  const nextContent = renderCopilotMcpConfig(path, currentContent, name, serverConfig, composerEntry);

  if (!options.apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify GitHub Copilot MCP config.`
        : 'Dry run. Re-run with --apply to modify GitHub Copilot MCP config.',
    );
    yield* printCopilotMcpSnippet(config, name, {
      attach: options.attach,
      project: options.project,
      toolset: options.toolset,
    });
    return;
  }

  if (current || currentContent === nextContent) {
    yield* Console.log(`Already configured: ${path}`);
    return;
  }
  yield* ensureDirectory(pathService.dirname(path), false);
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(
    currentContent === undefined
      ? `Wrote GitHub Copilot MCP config: ${path}`
      : `Updated GitHub Copilot MCP config: ${path}`,
  );
});

const runOmpMcpInstall = Effect.fn('mcp.runOmpInstall')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly dryRunApplyCommand?: string;
    readonly hostRoot: string;
    readonly project?: string;
    readonly toolset: McpToolset;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = yield* ompMcpConfigPath(options.project, options.hostRoot);
  const previous = (yield* readAgentIntegrationRegistry(config))?.hosts.omp?.mcp;
  const previousHostRoot = previous?.hostRoot;
  const relocatingHost =
    options.project === undefined &&
    previous?.cwd === undefined &&
    previousHostRoot !== undefined &&
    previousHostRoot !== options.hostRoot;
  const relocatingPersonalMcp = relocatingHost && previous?.cwd === undefined;
  const serverConfig = yield* buildOmpMcpServerConfig(config, {
    toolset: options.toolset,
  });
  const currentContent = yield* readFileIfExists(path);
  const current = jsonMcpConfigurationMatches(currentContent, 'mcpServers', name, serverConfig, true);
  const nextContent = renderOmpMcpConfig(path, currentContent, name, serverConfig);

  if (!options.apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify the omp MCP config.`
        : 'Dry run. Re-run with --apply to modify the omp MCP config.',
    );
    yield* printOmpMcpSnippet(config, name, {
      hostRoot: options.hostRoot,
      project: options.project,
      toolset: options.toolset,
    });
    if (relocatingHost) {
      yield* relocateManagedOmpHook(previousHostRoot, options.hostRoot, true);
    }
    if (relocatingPersonalMcp) {
      yield* removeOmpMcpConfig(name, true, undefined, previousHostRoot);
    }
    return;
  }

  if (current || currentContent === nextContent) {
    yield* Console.log(`Already configured: ${path}`);
  } else {
    yield* ensureDirectory(pathService.dirname(path), false);
    yield* fs.writeFileString(path, nextContent, {mode: 0o644});
    yield* Console.log(
      currentContent === undefined ? `Wrote omp MCP config: ${path}` : `Updated omp MCP config: ${path}`,
    );
  }
  if (relocatingHost) {
    yield* relocateManagedOmpHook(previousHostRoot, options.hostRoot, false);
  }
  if (relocatingPersonalMcp) {
    yield* removeOmpMcpConfig(name, false, undefined, previousHostRoot);
  }
});

export const removeMcpConfigs = Effect.fn('mcp.removeConfigs')(function* (
  value: string,
  dryRun: boolean,
  receipts: Readonly<Partial<Record<AgentClient, AgentIntegrationMcpReceipt>>> = {},
) {
  const clients = yield* resolveMcpClients(value, 'remove', receipts);
  if (clients.length === 0) {
    yield* Console.log('Skipping MCP config removal.');
    return [];
  }
  const removed: AgentClient[] = [];
  for (const client of clients) {
    const receipt = receipts[client];
    if (receipt?.external === true) {
      yield* Console.log(`Released external ${client} MCP registration without modifying local host configuration.`);
      removed.push(client);
      continue;
    }
    const name = receipt?.name ?? THREADNOTE_MCP_NAME;
    if (client === 'cursor') {
      if (yield* removeCursorMcpConfig(name, dryRun)) removed.push(client);
      continue;
    }
    if (client === 'copilot') {
      if (yield* removeCopilotMcpConfig(name, dryRun)) removed.push(client);
      continue;
    }
    if (client === 'omp') {
      if (yield* removeOmpMcpConfig(name, dryRun, receipt?.cwd, receipt?.hostRoot)) removed.push(client);
      continue;
    }
    const executable = yield* requiredMcpAgentExecutable(client);
    const command = yield* buildMcpRemoveCommand(client, executable, name, {
      cwd: receipt?.cwd,
      scope: receipt?.scope,
    });
    const result = yield* maybeRunEffect(dryRun, command.executable, command.args, {
      allowFailure: true,
      cwd: command.cwd,
    });
    if (dryRun || result?.exitCode === 0) removed.push(client);
  }
  return removed;
});

export const removeMcpSnippets = Effect.fn('mcp.removeSnippets')(function* (config: RuntimeConfig, dryRun: boolean) {
  const path = yield* Path.Path;
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.codex.toml`),
    'MCP snippet',
    dryRun,
  );
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.claude.txt`),
    'MCP snippet',
    dryRun,
  );
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.cursor.json`),
    'MCP snippet',
    dryRun,
  );
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.copilot.json`),
    'MCP snippet',
    dryRun,
  );
});

const buildMcpInstallCommand = Effect.fn('mcp.buildInstallCommand')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  agentExecutable: string,
  name: string,
  options: {
    readonly cwd?: string;
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  if (agent === 'cursor') {
    return yield* McpOperationError.make({message: 'Cursor MCP config is written directly to ~/.cursor/mcp.json.'});
  }
  if (agent === 'copilot') {
    return yield* McpOperationError.make({
      message: 'GitHub Copilot MCP config is written directly to the VS Code user mcp.json file.',
    });
  }
  if (agent === 'omp') {
    return yield* McpOperationError.make({
      message: 'omp MCP config is written directly to ~/.omp/agent/mcp.json.',
    });
  }
  const claudeCwd = options.cwd ?? (yield* getInvocationCwd());
  const claudeScope = options.scope ?? 'user';
  const command = yield* mcpAdapterCommand();
  const env = mcpEnvironment(config, options.toolset, agent);
  if (agent === 'codex') {
    return {
      executable: agentExecutable,
      args: ['mcp', 'add', ...env.flatMap(value => ['--env', value]), name, '--', ...command],
    };
  }
  return {
    executable: agentExecutable,
    args: ['mcp', 'add', '--scope', claudeScope, name, ...env.flatMap(value => ['--env', value]), '--', ...command],
    cwd: claudeCwd,
  };
});

export const mcpAdapterCommand = Effect.fn('mcp.adapterCommand')(function* () {
  const system = yield* SystemInfo;
  const launcher = yield* commandLauncherPath('mcp');
  if (system.platform === 'win32') {
    const comSpec = system.environment().ComSpec ?? system.environment().COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
    return [comSpec, '/d', '/c', launcher];
  }
  return [launcher];
});

const buildMcpRemoveCommand = Effect.fn('mcp.buildRemoveCommand')(function* (
  agent: AgentClient,
  agentExecutable: string,
  name: string,
  options: {readonly cwd?: string; readonly scope?: ClaudeMcpScope} = {},
) {
  if (agent === 'cursor') {
    return yield* McpOperationError.make({message: 'Cursor MCP config is removed directly from ~/.cursor/mcp.json.'});
  }
  if (agent === 'copilot') {
    return yield* McpOperationError.make({
      message: 'GitHub Copilot MCP config is removed directly from the VS Code user mcp.json file.',
    });
  }
  if (agent === 'omp') {
    return yield* McpOperationError.make({
      message: 'omp MCP config is removed directly from ~/.omp/agent/mcp.json.',
    });
  }
  return agent === 'codex'
    ? {executable: agentExecutable, args: ['mcp', 'remove', name]}
    : {
        executable: agentExecutable,
        args: ['mcp', 'remove', '--scope', options.scope ?? 'user', name],
        cwd: options.cwd ?? (yield* getInvocationCwd()),
      };
});

const findMcpAgentExecutable = Effect.fn('mcp.findAgentExecutable')((agent: 'claude' | 'codex') =>
  findWorkingExecutable([agent]),
);

const requiredMcpAgentExecutable = Effect.fn('mcp.requiredAgentExecutable')(function* (agent: 'claude' | 'codex') {
  const executable = yield* findMcpAgentExecutable(agent);
  if (executable) {
    return executable;
  }
  const discovered = yield* findExecutable([agent]);
  if (discovered) {
    return yield* McpOperationError.make({
      message:
        `${agent} command was found at ${discovered} but is not working. ` +
        `Repair or reinstall ${agent}, then run threadnote mcp-install ${agent} --apply.`,
    });
  }
  return yield* McpOperationError.make({
    message: `${agent} command was not found in PATH. Install ${agent}, then run threadnote mcp-install ${agent} --apply.`,
  });
});

function mcpEnvironment(config: RuntimeConfig, toolset: McpToolset, client: AgentClient): readonly string[] {
  return [
    `THREADNOTE_HOME=${config.agentContextHome}`,
    `THREADNOTE_ACCOUNT=${config.account}`,
    `THREADNOTE_USER=${config.user}`,
    `THREADNOTE_AGENT_ID=${config.agentId}`,
    `${MCP_TOOLSET_ENV}=${toolset}`,
    `${THREADNOTE_MCP_CLIENT_ENV}=${client}`,
    `${THREADNOTE_MCP_SURFACE_ENV}=${legacyMcpSurfaceId(client)}`,
  ];
}

function mcpEnvironmentObject(config: RuntimeConfig, toolset: McpToolset, client: AgentClient): JsonObject {
  return {
    THREADNOTE_ACCOUNT: config.account,
    THREADNOTE_AGENT_ID: config.agentId,
    THREADNOTE_HOME: config.agentContextHome,
    [THREADNOTE_MCP_CLIENT_ENV]: client,
    [THREADNOTE_MCP_SURFACE_ENV]: legacyMcpSurfaceId(client),
    [MCP_TOOLSET_ENV]: toolset,
    THREADNOTE_USER: config.user,
  };
}

function legacyMcpSurfaceId(client: AgentClient): string {
  return {
    claude: 'claude-code',
    codex: 'codex-cli',
    copilot: 'copilot-vscode',
    cursor: 'cursor-desktop',
    omp: 'omp-agent',
  }[client];
}

const buildCursorMcpServerConfig = Effect.fn('mcp.buildCursorServerConfig')(function* (
  config: RuntimeConfig,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const command = yield* mcpAdapterCommand();
  return {
    args: command.slice(1),
    command: command[0],
    env: mcpEnvironmentObject(config, options.toolset, 'cursor'),
  };
});

const buildCopilotMcpServerConfig = Effect.fn('mcp.buildCopilotServerConfig')(function* (
  config: RuntimeConfig,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const command = yield* mcpAdapterCommand();
  return {
    args: command.slice(1),
    command: command[0],
    env: mcpEnvironmentObject(config, options.toolset, 'copilot'),
    type: 'stdio',
  };
});

const buildOmpMcpServerConfig = Effect.fn('mcp.buildOmpServerConfig')(function* (
  config: RuntimeConfig,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const command = yield* mcpAdapterCommand();
  return {
    args: command.slice(1),
    command: command[0],
    env: mcpEnvironmentObject(config, options.toolset, 'omp'),
    instructions: false,
    type: 'stdio',
  };
});

function isEmptyConfigContent(content: string | undefined): boolean {
  return content === undefined || content.trim().length === 0;
}

function withoutManagedComposerEntry(servers: Record<string, unknown>, name: string): Record<string, unknown> {
  const next = {...servers};
  delete next[name];
  if (isManagedComposerHttpEntry(next[THREADNOTE_ORG_MCP_NAME])) {
    delete next[THREADNOTE_ORG_MCP_NAME];
  }
  return next;
}

function renderCursorMcpConfig(
  configPath: string,
  currentContent: string | undefined,
  name: string,
  serverConfig: JsonObject,
  composerEntry?: ComposerHttpMcpEntry,
): string {
  const parsed = isEmptyConfigContent(currentContent) ? {} : parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    throw McpOperationError.make({message: `${configPath} exists but is not a JSON object; not modifying it.`});
  }
  if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
    throw McpOperationError.make({message: `${configPath} has a non-object mcpServers field; not modifying it.`});
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = isJsonObject(parsed.mcpServers) ? {...parsed.mcpServers} : {};
  mcpServers[name] = serverConfig;
  if (composerEntry) mcpServers[THREADNOTE_ORG_MCP_NAME] = composerEntry;
  nextConfig.mcpServers = mcpServers;
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

function renderCopilotMcpConfig(
  configPath: string,
  currentContent: string | undefined,
  name: string,
  serverConfig: JsonObject,
  composerEntry?: CopilotComposerHttpMcpEntry,
): string {
  const parsed = isEmptyConfigContent(currentContent) ? {} : parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    throw McpOperationError.make({message: `${configPath} exists but is not a JSON object; not modifying it.`});
  }
  if (parsed.servers !== undefined && !isJsonObject(parsed.servers)) {
    throw McpOperationError.make({message: `${configPath} has a non-object servers field; not modifying it.`});
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const servers = isJsonObject(parsed.servers) ? {...parsed.servers} : {};
  servers[name] = serverConfig;
  if (composerEntry) servers[THREADNOTE_ORG_MCP_NAME] = composerEntry;
  nextConfig.servers = servers;
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

function renderOmpMcpConfig(
  configPath: string,
  currentContent: string | undefined,
  name: string,
  serverConfig: JsonObject,
): string {
  const parsed = isEmptyConfigContent(currentContent) ? {} : parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    throw McpOperationError.make({message: `${configPath} exists but is not a JSON object; not modifying it.`});
  }
  if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
    throw McpOperationError.make({message: `${configPath} has a non-object mcpServers field; not modifying it.`});
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = isJsonObject(parsed.mcpServers) ? {...parsed.mcpServers} : {};
  mcpServers[name] = serverConfig;
  nextConfig.mcpServers = mcpServers;
  if (Array.isArray(parsed.disabledServers)) {
    nextConfig.disabledServers = parsed.disabledServers.filter(server => server !== name);
  }
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

const removeCursorMcpConfig = Effect.fn('mcp.removeCursorConfig')(function* (name: string, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* cursorMcpConfigPath();
  const currentContent = yield* readFileIfExists(path);
  if (isEmptyConfigContent(currentContent)) {
    yield* Console.log(`Already absent: ${path}`);
    return true;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return false;
  }
  if (!isJsonObject(parsed.mcpServers) || parsed.mcpServers[name] === undefined) {
    yield* Console.log(`No Cursor MCP config found: ${path}`);
    return true;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  nextConfig.mcpServers = withoutManagedComposerEntry({...parsed.mcpServers}, name);
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update Cursor MCP config: ${path}`);
    return true;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated Cursor MCP config: ${path}`);
  return true;
});

const removeCopilotMcpConfig = Effect.fn('mcp.removeCopilotConfig')(function* (name: string, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* copilotMcpConfigPath();
  const currentContent = yield* readFileIfExists(path);
  if (isEmptyConfigContent(currentContent)) {
    yield* Console.log(`Already absent: ${path}`);
    return true;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return false;
  }
  if (!isJsonObject(parsed.servers) || parsed.servers[name] === undefined) {
    yield* Console.log(`No GitHub Copilot MCP config found: ${path}`);
    return true;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  nextConfig.servers = withoutManagedComposerEntry({...parsed.servers}, name);
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update GitHub Copilot MCP config: ${path}`);
    return true;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated GitHub Copilot MCP config: ${path}`);
  return true;
});

const removeOmpMcpConfig = Effect.fn('mcp.removeOmpConfig')(function* (
  name: string,
  dryRun: boolean,
  project?: string,
  hostRoot?: string,
) {
  return yield* removeOmpMcpConfigAtPath(name, dryRun, yield* ompMcpConfigPath(project, hostRoot));
});

const removeOmpMcpConfigAtPath = Effect.fn('mcp.removeOmpConfigAtPath')(function* (
  name: string,
  dryRun: boolean,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const currentContent = yield* readFileIfExists(path);
  if (isEmptyConfigContent(currentContent)) {
    yield* Console.log(`Already absent: ${path}`);
    return true;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return false;
  }
  if (!isJsonObject(parsed.mcpServers) || parsed.mcpServers[name] === undefined) {
    yield* Console.log(`No omp MCP config found: ${path}`);
    return true;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = {...parsed.mcpServers};
  delete mcpServers[name];
  nextConfig.mcpServers = mcpServers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update omp MCP config: ${path}`);
    return true;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated omp MCP config: ${path}`);
  return true;
});

const printMcpSnippet = Effect.fn('mcp.printSnippet')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  name: string,
  options: {
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  if (agent === 'cursor') {
    yield* printCursorMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }
  if (agent === 'copilot') {
    yield* printCopilotMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }
  if (agent === 'omp') {
    yield* printOmpMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }
  const path = yield* Path.Path;
  const snippetPath = path.join(
    config.agentContextHome,
    'mcp',
    `${name}.${agent}.${agent === 'codex' ? 'toml' : 'txt'}`,
  );
  const command = yield* buildMcpInstallCommand(config, agent, agent, name, {
    scope: options.scope,
    toolset: options.toolset,
  });
  const snippet = `${formatShellCommand(command.executable, command.args)}\n`;
  yield* Console.log(`\nSnippet (${snippetPath}):\n${snippet}`);
});

const printCursorMcpSnippet = Effect.fn('mcp.printCursorSnippet')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly attach?: ComposerShareBinding;
    readonly project?: string;
    readonly toolset: McpToolset;
  },
) {
  const path = yield* Path.Path;
  const snippetPath = path.join(config.agentContextHome, 'mcp', `${name}.cursor.json`);
  const stdio = yield* buildCursorMcpServerConfig(config, options);
  const mcpServers = withComposerHttpMcpEntry({}, name, stdio, options.attach);
  const snippet = JSON.stringify({mcpServers}, null, 2);
  const target = yield* cursorMcpConfigPath(options.project);
  yield* Console.log(`\nSnippet (${snippetPath}; merge into ${target}):\n${snippet}`);
});

const printCopilotMcpSnippet = Effect.fn('mcp.printCopilotSnippet')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly attach?: ComposerShareBinding;
    readonly project?: string;
    readonly toolset: McpToolset;
  },
) {
  const path = yield* Path.Path;
  const snippetPath = path.join(config.agentContextHome, 'mcp', `${name}.copilot.json`);
  const stdio = yield* buildCopilotMcpServerConfig(config, options);
  const servers = withComposerHttpMcpEntry({}, name, stdio, options.attach, 'copilot');
  const snippet = JSON.stringify({servers}, null, 2);
  yield* Console.log(
    `\nSnippet (${snippetPath}; merge into ${yield* copilotMcpConfigPath(options.project)}):\n${snippet}`,
  );
});

const printOmpMcpSnippet = Effect.fn('mcp.printOmpSnippet')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly hostRoot?: string;
    readonly project?: string;
    readonly toolset: McpToolset;
  },
) {
  const path = yield* Path.Path;
  const snippetPath = path.join(config.agentContextHome, 'mcp', `${name}.omp.json`);
  const stdio = yield* buildOmpMcpServerConfig(config, options);
  const snippet = JSON.stringify({mcpServers: {[name]: stdio}}, null, 2);
  yield* Console.log(
    `\nSnippet (${snippetPath}; merge into ${yield* ompMcpConfigPath(options.project, options.hostRoot)}):\n${snippet}`,
  );
});

const cursorMcpConfigPath = Effect.fn('mcp.cursorConfigPath')(function* (project?: string) {
  if (project?.trim()) {
    const path = yield* Path.Path;
    return path.join(path.resolve(project.trim()), '.cursor', 'mcp.json');
  }
  return yield* expandPath('~/.cursor/mcp.json');
});

const copilotMcpConfigPath = Effect.fn('mcp.copilotConfigPath')(function* (project?: string) {
  if (project?.trim()) {
    const path = yield* Path.Path;
    return path.join(path.resolve(project.trim()), '.vscode', 'mcp.json');
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  if (environment.THREADNOTE_COPILOT_MCP_CONFIG) {
    return yield* expandPath(environment.THREADNOTE_COPILOT_MCP_CONFIG);
  }
  if (system.platform === 'darwin') {
    const stablePath = yield* expandPath('~/Library/Application Support/Code/User/mcp.json');
    const insidersPath = yield* expandPath('~/Library/Application Support/Code - Insiders/User/mcp.json');
    return (yield* fs.exists(path.dirname(stablePath))) || !(yield* fs.exists(path.dirname(insidersPath)))
      ? stablePath
      : insidersPath;
  }
  if (system.platform === 'win32') {
    const appData = environment.APPDATA;
    return appData
      ? path.join(appData, 'Code', 'User', 'mcp.json')
      : yield* expandPath('~/AppData/Roaming/Code/User/mcp.json');
  }
  const configHome = environment.XDG_CONFIG_HOME
    ? yield* expandPath(environment.XDG_CONFIG_HOME)
    : yield* expandPath('~/.config');
  return path.join(configHome, 'Code', 'User', 'mcp.json');
});

const ompMcpConfigPath = Effect.fn('mcp.ompConfigPath')(function* (project?: string, hostRoot?: string) {
  if (project?.trim()) {
    const path = yield* Path.Path;
    return path.join(path.resolve(project.trim()), '.omp', 'mcp.json');
  }
  return (yield* resolveAgentHostPaths('omp', hostRoot))!.mcpConfigPath;
});

export function parseAgentClient(value: string): AgentClient {
  if (value === 'codex' || value === 'claude' || value === 'copilot' || value === 'cursor' || value === 'omp') {
    return value;
  }
  throw McpOperationError.make({
    message: `Unsupported agent: ${value}. Expected codex, claude, copilot, cursor, or omp.`,
  });
}

export function parseClaudeMcpScope(value: string): ClaudeMcpScope {
  if (value === 'local' || value === 'project' || value === 'user') {
    return value;
  }
  throw McpOperationError.make({message: `Invalid Claude MCP scope: ${value}. Expected local, project, or user.`});
}

export const resolveMcpClients = Effect.fn('mcp.resolveClients')(function* (
  value: string,
  action: 'remove' | 'repair',
  receipts: Readonly<Partial<Record<AgentClient, AgentIntegrationMcpReceipt>>> = {},
) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'false' || normalized === 'off') {
    return [];
  }

  let requested: readonly AgentClient[];
  if (normalized === 'available' || normalized === 'all') {
    requested = ['codex', 'claude', 'cursor', 'copilot', 'omp'];
  } else {
    requested = normalized
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(parseAgentClient);
  }

  const clients: AgentClient[] = [];
  for (const client of requested) {
    if (client === 'cursor') {
      if (!(yield* isCursorAvailable())) {
        yield* Console.log(`WARN Cursor config not found; cannot ${action} cursor MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (client === 'copilot') {
      if (!(yield* isCopilotAvailable())) {
        yield* Console.log(`WARN VS Code/Copilot config not found; cannot ${action} copilot MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (client === 'omp') {
      if (!(yield* isOmpAvailable(receipts.omp?.hostRoot))) {
        yield* Console.log(`WARN omp config not found; cannot ${action} omp MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (!(yield* findMcpAgentExecutable(client))) {
      const discovered = yield* findExecutable([client]);
      yield* Console.log(
        discovered
          ? `WARN ${client} command at ${discovered} is not working; cannot ${action} ${client} MCP config. ` +
              `Repair or reinstall ${client}, then run threadnote mcp-install ${client} --apply.`
          : `WARN ${client} command not found; cannot ${action} ${client} MCP config.`,
      );
      continue;
    }
    if (!clients.includes(client)) {
      clients.push(client);
    }
  }
  return clients;
});

const isCursorAvailable = Effect.fn('mcp.isCursorAvailable')(function* () {
  const system = yield* SystemInfo;
  if (yield* exists(yield* expandPath('~/.cursor'))) {
    return true;
  }
  if (yield* findExecutable(['cursor', 'cursor-agent'])) {
    return true;
  }
  return system.platform === 'darwin' && (yield* exists('/Applications/Cursor.app'));
});

const isCopilotAvailable = Effect.fn('mcp.isCopilotAvailable')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (system.environment().THREADNOTE_COPILOT_MCP_CONFIG) {
    return true;
  }
  if (yield* exists(path.dirname(yield* copilotMcpConfigPath()))) {
    return true;
  }
  if (yield* findExecutable(['code', 'code-insiders'])) {
    return true;
  }
  return system.platform === 'darwin' && (yield* exists('/Applications/Visual Studio Code.app'));
});

const isOmpAvailable = Effect.fn('mcp.isOmpAvailable')(function* (hostRoot?: string) {
  const host = (yield* resolveAgentHostPaths('omp', hostRoot))!;
  return (
    (yield* exists(host.agentRoot)) ||
    (yield* exists(yield* expandPath('~/.omp'))) ||
    (yield* findExecutable(['omp'])) !== undefined
  );
});
