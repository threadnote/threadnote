import {Effect, FileSystem, Path} from 'effect';
import {
  USER_INSTRUCTIONS_START_MARKER,
  USER_INSTRUCTIONS_END_MARKER,
  THREADNOTE_MCP_CLIENT_ENV,
  THREADNOTE_MCP_SURFACE_ENV,
} from '../constants.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {mcpAdapterCommand} from '../mcp/adapter-command.js';
import {MCP_TOOLSET_ENV} from '../mcp/toolset.js';
import type {McpToolset} from '../mcp/toolset.js';
import type {JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {toolRoot} from '@threadnote/workspace/installation';
import type {AgentAdapter, AgentSkillRootPaths, JsonAgentStrategy} from './adapters/contract.js';
import type {AgentArtifact} from './index.js';
import type {AgentSurfaceReceipt} from './registry.js';
import {AgentSurfaceError} from './surfaces.js';
import {AGENT_SKILLS} from './skills.js';
import {parseAgentJson, sameAgentContainer} from './json_config.js';
import {errorMessage} from '@threadnote/platform/errors';
import {readFileIfExists} from '../utils.js';

export interface SurfaceInstallOptions {
  readonly apply?: boolean;
  readonly cwd?: string;
  readonly toolset?: McpToolset;
  readonly scope?: 'user' | 'project' | 'local';
}

/** Resolve only host/skill paths; no filesystem, MCP document or template reads. */
export const resolveJsonAgentSkillPaths = Effect.fn('agentSurfaces.resolveSkillPaths')(function* (
  strategy: JsonAgentStrategy,
  scope: 'user' | 'project' | 'local',
  options: Pick<SurfaceInstallOptions, 'cwd'> = {},
  previous?: AgentSkillRootPaths,
) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const requestedCwd = scope === 'user' || options.cwd === undefined ? undefined : path.resolve(options.cwd);
  if (previous?.cwd !== undefined && requestedCwd !== undefined && previous.cwd !== requestedCwd)
    return yield* AgentSurfaceError.make({
      message: `The recorded ${scope} installation belongs to another repository. Remove it before changing repositories.`,
    });
  const cwd = previous?.cwd ?? requestedCwd ?? (scope === 'user' ? undefined : path.resolve(system.currentDirectory()));
  const environment = system.environment();
  const configuredRoot = strategy.rootEnvironment === undefined ? undefined : environment[strategy.rootEnvironment];
  if (!previous && scope === 'user' && configuredRoot && !path.isAbsolute(configuredRoot))
    return yield* AgentSurfaceError.make({message: `${strategy.rootEnvironment} must be absolute.`});
  const xdg = environment.XDG_CONFIG_HOME;
  if (!previous && scope === 'user' && strategy.xdg && xdg && !path.isAbsolute(xdg))
    return yield* AgentSurfaceError.make({message: 'XDG_CONFIG_HOME must be absolute.'});
  const appData = environment.APPDATA;
  if (
    !previous &&
    scope === 'user' &&
    strategy.windowsAppData &&
    system.platform === 'win32' &&
    appData &&
    !path.isAbsolute(appData)
  )
    return yield* AgentSurfaceError.make({message: 'APPDATA must be absolute.'});
  const root =
    previous?.root ??
    (scope !== 'user'
      ? path.join(cwd!, strategy.projectRoot ?? strategy.root)
      : (configuredRoot ??
        path.join(
          strategy.windowsAppData && system.platform === 'win32'
            ? appData || path.join(system.homeDirectory, 'AppData', 'Roaming')
            : strategy.xdg
              ? xdg || path.join(system.homeDirectory, '.config')
              : system.homeDirectory,
          system.platform === 'win32' ? (strategy.windowsRoot ?? strategy.root) : strategy.root,
        )));
  const skillRoot =
    previous?.skillRoot ??
    (typeof strategy.skillRoot === 'object'
      ? path.join(
          scope === 'user' ? system.homeDirectory : cwd!,
          strategy.skillRoot[scope === 'user' ? 'user' : 'project'],
        )
      : strategy.skillRoot === 'shared'
        ? path.join(scope === 'user' ? system.homeDirectory : cwd!, '.agents', 'skills')
        : path.join(root, scope === 'user' ? 'skills' : (strategy.projectSkillRoot ?? 'skills')));
  return {root, skillRoot, cwd};
});

export const planAgentSurface = Effect.fn('agentSurfaces.plan')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: SurfaceInstallOptions = {},
  previous?: AgentSurfaceReceipt,
) {
  if (!adapter.json)
    return yield* AgentSurfaceError.make({
      message: `No managed JSON installer for ${adapter.catalog.id}; consult threadnote agents list.`,
    });
  const strategy = adapter.json;
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const scope = previous?.scope ?? options.scope ?? strategy.defaultScope ?? 'user';
  if (!adapter.catalog.scopes.includes(scope) || (previous && options.scope && options.scope !== scope))
    return yield* AgentSurfaceError.make({
      message: `Unsupported or conflicting scope for ${adapter.catalog.id}. Remove the recorded installation before changing scope.`,
    });
  const {root, skillRoot, cwd} = yield* resolveJsonAgentSkillPaths(strategy, scope, options, previous);
  const environment = system.environment();
  const configuredMcpRoot =
    strategy.mcpRootEnvironment === undefined ? undefined : environment[strategy.mcpRootEnvironment];
  if (!previous && scope === 'user' && configuredMcpRoot && !path.isAbsolute(configuredMcpRoot))
    return yield* AgentSurfaceError.make({message: `${strategy.mcpRootEnvironment} must be absolute.`});
  const mcpRoot =
    previous?.mcp.root ?? (scope === 'user' ? (configuredMcpRoot ?? path.join(root, strategy.mcpRoot ?? '')) : root);
  const defaultMcpFile =
    scope === 'local'
      ? strategy.localMcpFile!
      : scope === 'project'
        ? (strategy.projectMcpFile ?? strategy.mcpFile)
        : strategy.mcpFile;
  const candidateMcpPaths = [...(strategy.mcpFileAlternatives ?? []), defaultMcpFile].map(file =>
    path.join(mcpRoot, file),
  );
  let mcpPath = previous?.mcp.path ?? path.join(mcpRoot, defaultMcpFile);
  if (!previous) {
    for (const candidate of candidateMcpPaths) {
      if (yield* fs.exists(candidate)) {
        mcpPath = candidate;
        break;
      }
    }
  }
  if (![root, skillRoot, mcpRoot, mcpPath, ...(cwd ? [cwd] : [])].every(target => path.isAbsolute(target)))
    return yield* AgentSurfaceError.make({message: 'Adapter receipt paths must be absolute.'});
  if (
    !candidateMcpPaths.includes(mcpPath) ||
    (scope !== 'user' && root !== path.join(cwd!, strategy.projectRoot ?? strategy.root))
  )
    return yield* AgentSurfaceError.make({message: 'Adapter receipt paths do not match the recorded root and scope.'});
  let container = strategy.container;
  let enablement = strategy.enablement ?? 'enabled';
  let emptyDocument: JsonObject = {};
  const mcpContent = yield* readFileIfExists(mcpPath);
  if (strategy.legacySchema !== undefined) {
    const parsed = yield* Effect.try({
      try: () => parseAgentJson(mcpContent, strategy.codec),
      catch: cause => AgentSurfaceError.make({message: errorMessage(cause)}),
    });
    const legacy =
      mcpContent === undefined && previous !== undefined
        ? sameAgentContainer(previous.strategy.container, strategy.legacySchema.container)
        : strategy.legacySchema.keys.some(key => Object.hasOwn(parsed, key));
    if (legacy) {
      container = strategy.legacySchema.container;
      enablement = strategy.legacySchema.enablement;
      emptyDocument = strategy.legacySchema.emptyDocument;
    }
  }
  const templateRoot = path.join(yield* toolRoot(), 'config');
  const bootstrap =
    strategy.instructionContent ?? (yield* fs.readFileString(path.join(templateRoot, 'agent-instructions.md'))).trim();
  const instructionPrefix =
    scope === 'user' ? strategy.instructionPrefix : (strategy.projectInstructionPrefix ?? strategy.instructionPrefix);
  const instruction = `${instructionPrefix ?? ''}${USER_INSTRUCTIONS_START_MARKER}\n${bootstrap}\n${USER_INSTRUCTIONS_END_MARKER}`;
  const artifacts: AgentArtifact[] =
    strategy.instructionFile === undefined
      ? []
      : [
          {
            content: instruction,
            hash: yield* sha256Hex(instruction),
            kind: instructionPrefix ? 'file' : 'block',
            name: 'instructions',
            path: path.join(
              root,
              scope === 'user'
                ? strategy.instructionFile
                : (strategy.projectInstructionFile ?? strategy.instructionFile),
            ),
          },
        ];
  for (const skill of strategy.skillRoot === 'none' ? [] : AGENT_SKILLS) {
    const content = `${(yield* fs.readFileString(path.join(templateRoot, 'agent-skills', skill, 'SKILL.md'))).trim()}\n`;
    artifacts.push({
      content,
      hash: yield* sha256Hex(content),
      kind: 'file',
      name: `skill ${skill}`,
      path:
        strategy.skillLayout === 'flat' ? path.join(skillRoot, `${skill}.md`) : path.join(skillRoot, skill, 'SKILL.md'),
    });
  }
  const command = yield* mcpAdapterCommand();
  const toolset = options.toolset ?? previous?.mcp.toolset ?? 'core';
  const entry: JsonObject = {
    ...(strategy.entryType === undefined ? {} : {type: strategy.entryType}),
    ...(strategy.commandArray
      ? {command: [...command], [enablement]: enablement === 'enabled'}
      : {command: command[0], args: command.slice(1)}),
    [strategy.commandArray ? 'environment' : 'env']: {
      THREADNOTE_ACCOUNT: config.account,
      THREADNOTE_AGENT_ID: config.agentId,
      THREADNOTE_HOME: config.agentContextHome,
      THREADNOTE_USER: config.user,
      [THREADNOTE_MCP_CLIENT_ENV]: adapter.catalog.agentId,
      [THREADNOTE_MCP_SURFACE_ENV]: adapter.catalog.id,
      [MCP_TOOLSET_ENV]: toolset,
    },
  };
  return {
    adapter,
    artifacts,
    root,
    skillRoot,
    scope,
    cwd,
    entry,
    mcpRoot,
    mcpPath,
    mcpContent,
    container,
    emptyDocument,
    name: previous?.mcp.name ?? 'threadnote',
    toolset,
  };
});
