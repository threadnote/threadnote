import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {
  AGENT_CLIENTS,
  AGENT_INTEGRATION_ARTIFACT_VERSION,
  artifactHasOtherConsumers,
  agentIntegrationRegistryPath,
  emptyAgentIntegrationRegistry,
  readAgentIntegrationRegistry,
  registeredAgentClients,
  repairableAgentClients,
  type AgentIntegrationRegistry,
  type AgentIntegrationHostReceipt,
  type AgentIntegrationMcpReceipt,
  withAgentIntegrationHost,
  withAgentIntegrationLock,
  writeAgentIntegrationRegistry,
} from './registry.js';
import {
  LEGACY_CURSOR_INSTRUCTION_PATHS,
  USER_INSTRUCTIONS_END_MARKER,
  USER_INSTRUCTIONS_START_MARKER,
} from '../constants.js';
import {isCursorMarketplacePluginInstalled} from '../cursor/plugin.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import type {McpToolset} from '../mcp/toolset.js';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import type {AgentClient, ClaudeMcpScope, DoctorCheck} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath, getInvocationCwd} from '@threadnote/platform/paths';
import {readFileIfExists} from '../utils.js';
import {toolRoot} from '@threadnote/workspace/installation';
import {resolveAgentHostPaths} from './host_paths.js';
import {LEGACY_ARTIFACT_TARGETS as HOST_TARGETS} from './adapters/legacy_targets.js';
import {AGENT_SKILLS, CODEX_CLOUD_PERSONAL_AGENT_SKILLS, CURSOR_CLOUD_PERSONAL_AGENT_SKILLS} from './skills.js';

interface InstallAgentIntegrationOptions {
  readonly cwd?: string;
  readonly dryRun: boolean;
  readonly name: string;
  readonly scope?: ClaudeMcpScope;
  readonly toolset: McpToolset;
}

export interface AgentArtifact {
  readonly content: string;
  readonly hash: string;
  readonly kind: 'block' | 'file';
  readonly name: string;
  readonly path: string;
}

interface AgentArtifactPlan {
  readonly artifacts: readonly AgentArtifact[];
  readonly hostRoot?: string;
}

type AgentArtifactProfile = NonNullable<AgentIntegrationMcpReceipt['artifactProfile']>;

class AgentIntegrationError extends Schema.TaggedError<AgentIntegrationError>()('AgentIntegrationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export {readAgentIntegrationRegistry, registeredAgentClients, repairableAgentClients};

export const installAgentIntegration = Effect.fn('agentIntegrations.install')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  options: InstallAgentIntegrationOptions,
) {
  const cwd =
    options.cwd ?? (options.scope === 'local' || options.scope === 'project' ? yield* getInvocationCwd() : undefined);
  const mcp: AgentIntegrationMcpReceipt = {
    ...(cwd === undefined ? {} : {cwd}),
    name: options.name,
    repair: true,
    ...(options.scope === undefined ? {} : {scope: options.scope}),
    toolset: options.toolset,
  };
  const install = installAgentIntegrationInTransaction(config, agent, mcp, options.dryRun);
  yield* options.dryRun ? install : withAgentIntegrationLock(config, install);
});

export const installCursorCloudAgentIntegration = Effect.fn('agentIntegrations.installCursorCloud')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const mcp: AgentIntegrationMcpReceipt = {
    artifactProfile: 'cursor-cloud-personal',
    external: true,
    name: 'threadnote',
    repair: false,
    toolset: 'cursor-cloud-personal',
  };
  const install = installAgentIntegrationInTransaction(config, 'cursor', mcp, dryRun);
  yield* dryRun ? install : withAgentIntegrationLock(config, install);
});

export const installCodexCloudAgentIntegration = Effect.fn('agentIntegrations.installCodexCloud')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const install = Effect.gen(function* () {
    const existing = (yield* readAgentIntegrationRegistry(config))?.hosts.codex;
    if (existing && existing.mcp.artifactProfile !== 'codex-cloud-personal') {
      return yield* AgentIntegrationError.make({
        message:
          'This Threadnote home has a desktop Codex integration. Use a separate THREADNOTE_HOME for Codex Cloud.',
      });
    }
    const mcp: AgentIntegrationMcpReceipt = {
      artifactProfile: 'codex-cloud-personal',
      name: 'threadnote',
      repair: false,
      transport: 'cli',
    };
    yield* preflightAgentIntegrationArtifacts('codex', mcp);
    yield* installAgentIntegrationInTransaction(config, 'codex', mcp, dryRun);
  });
  yield* dryRun ? install : withAgentIntegrationLock(config, install);
});

export const migrateLegacyAgentIntegrations = Effect.fn('agentIntegrations.migrateLegacy')(function* (
  config: RuntimeConfig,
  inferredClients: readonly AgentClient[],
  dryRun: boolean,
) {
  const migration = migrateLegacyAgentIntegrationsInTransaction(config, inferredClients, dryRun);
  return yield* dryRun ? migration : withAgentIntegrationLock(config, migration);
});

export const migrateLegacyAgentIntegrationsInTransaction = Effect.fn('agentIntegrations.migrateLegacyInTransaction')(
  function* (config: RuntimeConfig, inferredClients: readonly AgentClient[], dryRun: boolean) {
    const existing = yield* readAgentIntegrationRegistry(config);
    if (existing !== undefined) return registeredAgentClients(existing);
    const selected = AGENT_CLIENTS.filter(agent => inferredClients.includes(agent));
    const unknownMcp: AgentIntegrationMcpReceipt = {name: 'threadnote', repair: false};
    if (dryRun) {
      yield* removeOrphanedLegacyInstructions(selected, true);
      for (const agent of selected) yield* installAgentIntegrationInTransaction(config, agent, unknownMcp, true);
    } else {
      const concurrentRegistry = yield* readAgentIntegrationRegistry(config);
      if (concurrentRegistry !== undefined) return registeredAgentClients(concurrentRegistry);
      const installedVersion = yield* getThreadnoteVersion();
      let pendingRegistry = emptyAgentIntegrationRegistry(true);
      for (const agent of selected) {
        const plan = yield* agentArtifacts(agent, unknownMcp.artifactProfile);
        pendingRegistry = withAgentIntegrationHost(
          pendingRegistry,
          agent,
          hostReceipt(plan, installedVersion, unknownMcp, 'pending'),
        );
      }
      yield* writeAgentIntegrationRegistry(config, pendingRegistry);
      yield* removeOrphanedLegacyInstructions(selected, false);
      for (const agent of selected) yield* installAgentIntegrationInTransaction(config, agent, unknownMcp, false);
    }
    if (selected.length === 0) {
      yield* Console.log('No legacy agent integrations found.');
    } else if (dryRun) {
      yield* Console.log(`Would migrate ${selected.length} legacy agent integration(s).`);
    } else {
      yield* Console.log(`Migrated ${selected.length} legacy agent integration(s).`);
    }
    return selected;
  },
);

export const repairAgentIntegrations = Effect.fn('agentIntegrations.repair')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  if (registry === undefined) return [];
  const clients = registeredAgentClients(registry);
  const repair = Effect.gen(function* () {
    for (const agent of clients) {
      const current = yield* readAgentIntegrationRegistry(config);
      const receipt = current?.hosts[agent];
      if (receipt !== undefined) yield* installAgentIntegrationInTransaction(config, agent, receipt.mcp, dryRun);
    }
  });
  yield* dryRun ? repair : withAgentIntegrationLock(config, repair);
  return clients;
});

export const agentIntegrationDoctorChecks = Effect.fn('agentIntegrations.doctorChecks')(function* (
  config: RuntimeConfig,
  legacyInferredClients: readonly AgentClient[] = [],
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  if (registry === undefined) {
    return AGENT_CLIENTS.filter(agent => legacyInferredClients.includes(agent)).map(agent => ({
      detail: 'legacy Threadnote MCP entry detected; repair will register host-specific instructions and skills',
      name: `${agent} agent integration`,
      status: 'warn' as const,
    }));
  }
  const checks: DoctorCheck[] = [];
  for (const agent of registeredAgentClients(registry)) {
    const receipt = registry.hosts[agent]!;
    if (receipt.status === 'pending') {
      checks.push({
        detail: 'installation did not complete; repair will retry it',
        name: `${agent} agent integration`,
        status: 'warn',
      });
    }
    const plan = yield* agentArtifacts(agent, receipt.mcp.artifactProfile, receipt.mcp.hostRoot);
    for (const artifact of plan.artifacts) {
      const current = yield* readFileIfExists(artifact.path);
      const currentManagedBlock = current === undefined ? undefined : extractManagedBlock(current);
      const expectedManagedBlock = extractManagedBlock(artifact.content);
      const currentMatches =
        current !== undefined &&
        (current === artifact.content ||
          (expectedManagedBlock !== undefined && currentManagedBlock === expectedManagedBlock));
      const recordedHash = receipt.artifacts[artifact.path];
      checks.push({
        detail: currentMatches && recordedHash === artifact.hash ? artifact.path : `${artifact.path} missing or stale`,
        name: `${agent} ${artifact.name}`,
        status: currentMatches && recordedHash === artifact.hash ? 'ok' : 'warn',
      });
    }
  }
  return checks;
});

export const removeAgentIntegrations = Effect.fn('agentIntegrations.remove')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const removal = removeAgentIntegrationsInTransaction(config, dryRun);
  yield* dryRun ? removal : withAgentIntegrationLock(config, removal);
});

export const removeAgentIntegrationsInTransaction = Effect.fn('agentIntegrations.removeInTransaction')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  const clients = registry === undefined ? AGENT_CLIENTS : registeredAgentClients(registry);
  for (const agent of clients) {
    const receipt = registry?.hosts[agent];
    const plan = yield* agentArtifacts(agent, receipt?.mcp.artifactProfile, receipt?.mcp.hostRoot);
    for (const artifact of plan.artifacts) {
      if (Object.values(registry?.surfaces ?? {}).some(surface => surface.artifacts[artifact.path] !== undefined))
        continue;
      yield* removeArtifact(artifact, dryRun);
    }
    yield* removeObsoleteCursorCloudPersonalGraphSkill(
      plan,
      receipt?.mcp.artifactProfile,
      dryRun,
      registry,
      `legacy:${agent}`,
    );
  }
  for (const legacyPath of LEGACY_CURSOR_INSTRUCTION_PATHS) {
    const target = yield* expandPath(legacyPath);
    yield* removeManagedPath(target, 'legacy Cursor user rule', dryRun, false);
  }
  const target = yield* agentIntegrationRegistryPath(config);
  const fs = yield* FileSystem.FileSystem;
  if (registry !== undefined && Object.keys(registry.surfaces ?? {}).length > 0) {
    if (!dryRun) yield* writeAgentIntegrationRegistry(config, {...registry, hosts: {}});
    return;
  }
  if (yield* fs.exists(target)) {
    if (dryRun) yield* Console.log(`Would remove agent integration registry: ${target}`);
    else {
      yield* fs.remove(target);
      yield* Console.log(`Removed agent integration registry: ${target}`);
    }
  }
});

export const installAgentIntegrationInTransaction = Effect.fn('agentIntegrations.installInTransaction')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  mcp: AgentIntegrationMcpReceipt,
  dryRun: boolean,
) {
  const currentRegistry = (yield* readAgentIntegrationRegistry(config)) ?? emptyAgentIntegrationRegistry(false);
  const plan = yield* agentArtifacts(agent, mcp.artifactProfile, mcp.hostRoot);
  const installedVersion = yield* getThreadnoteVersion();
  const receipt = hostReceipt(plan, installedVersion, mcp, 'pending');
  const previous = currentRegistry.hosts[agent];
  const previousRootMatchesScope =
    previous?.mcp.cwd === undefined || previous.mcp.hostRoot === (yield* Path.Path).join(previous.mcp.cwd, '.omp');
  const previousPlan =
    (mcp.cwd === undefined) === (previous?.mcp.cwd === undefined) &&
    previousRootMatchesScope &&
    previous?.mcp.hostRoot !== undefined &&
    previous.mcp.hostRoot !== plan.hostRoot
      ? yield* agentArtifacts(agent, previous.mcp.artifactProfile, previous.mcp.hostRoot)
      : undefined;
  if (dryRun) {
    if (previousPlan !== undefined) {
      for (const artifact of previousPlan.artifacts) {
        if (!artifactHasOtherConsumers(currentRegistry, artifact.path, `legacy:${agent}`))
          yield* removeArtifact(artifact, true);
      }
    }
    if (agent === 'cursor' && !plan.artifacts.some(artifact => artifact.name === 'instructions')) {
      yield* removeManagedPath(
        yield* expandPath(HOST_TARGETS.cursor.instruction.path),
        'duplicate Cursor instructions',
        true,
        false,
      );
    }
    for (const artifact of plan.artifacts) yield* logArtifactPlan(artifact);
    yield* removeObsoleteCursorCloudPersonalGraphSkill(
      plan,
      mcp.artifactProfile,
      true,
      currentRegistry,
      `legacy:${agent}`,
    );
    yield* Console.log(`Would register ${agent} agent integration in ${yield* agentIntegrationRegistryPath(config)}.`);
    return;
  }

  if (previousPlan !== undefined) {
    for (const artifact of previousPlan.artifacts) {
      if (!artifactHasOtherConsumers(currentRegistry, artifact.path, `legacy:${agent}`))
        yield* removeArtifact(artifact, false);
    }
  }
  yield* removeObsoleteCursorCloudPersonalGraphSkill(
    plan,
    mcp.artifactProfile,
    false,
    currentRegistry,
    `legacy:${agent}`,
  );
  yield* writeAgentIntegrationRegistry(config, withAgentIntegrationHost(currentRegistry, agent, receipt));
  if (agent === 'cursor' && !plan.artifacts.some(artifact => artifact.name === 'instructions')) {
    yield* removeManagedPath(
      yield* expandPath(HOST_TARGETS.cursor.instruction.path),
      'duplicate Cursor instructions',
      false,
      false,
    );
  }
  for (const artifact of plan.artifacts) yield* writeArtifact(artifact);
  const latestRegistry = (yield* readAgentIntegrationRegistry(config)) ?? currentRegistry;
  yield* writeAgentIntegrationRegistry(
    config,
    withAgentIntegrationHost(latestRegistry, agent, {...receipt, status: 'current'}),
  );
  yield* Console.log(`Registered ${agent} agent integration.`);
});

function removeObsoleteCursorCloudPersonalGraphSkill(
  plan: AgentArtifactPlan,
  profile: AgentArtifactProfile | undefined,
  dryRun: boolean,
  registry: AgentIntegrationRegistry | undefined,
  consumer: string,
) {
  return Effect.gen(function* () {
    if (profile !== 'cursor-cloud-personal') return;
    const contextSkill = plan.artifacts.find(artifact => artifact.name === 'skill threadnote-context');
    if (contextSkill === undefined) return;
    const path = yield* Path.Path;
    const target = path.join(path.dirname(path.dirname(contextSkill.path)), 'threadnote-code-graph', 'SKILL.md');
    if (registry !== undefined && artifactHasOtherConsumers(registry, target, consumer)) return;
    yield* removeManagedPath(target, 'obsolete Personal Cursor Cloud graph skill', dryRun, true);
  });
}

function agentArtifacts(agent: AgentClient, requestedProfile?: AgentArtifactProfile, hostRoot?: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* toolRoot();
    const host = agent === 'omp' ? undefined : HOST_TARGETS[agent];
    const ompPaths = yield* resolveAgentHostPaths(agent, hostRoot);
    const system = yield* SystemInfo;
    const codexRoot =
      requestedProfile === 'codex-cloud-personal'
        ? (hostRoot ?? (yield* expandPath(system.environment().CODEX_HOME ?? '~/.codex')))
        : undefined;
    const instructionPath = codexRoot
      ? path.join(codexRoot, 'AGENTS.md')
      : (ompPaths?.instructionPath ?? (yield* expandPath(host!.instruction.path)));
    const profile = requestedProfile ?? 'default';
    const profileRoot =
      profile === 'default' ? path.join(root, 'config') : path.join(root, 'config', 'agent-profiles', profile);
    const bootstrap = (yield* (yield* FileSystem.FileSystem).readFileString(
      path.join(profileRoot, 'agent-instructions.md'),
    )).trim();
    const block = `${USER_INSTRUCTIONS_START_MARKER}\n${bootstrap}\n${USER_INSTRUCTIONS_END_MARKER}`;
    const instructionContent = renderInstructionContent(agent, host?.instruction.kind ?? 'block', block);
    const cursorPluginProvidesInstructions =
      profile === 'default' && agent === 'cursor' && (yield* isCursorMarketplacePluginInstalled());
    const artifacts: AgentArtifact[] = cursorPluginProvidesInstructions
      ? []
      : [
          {
            content: instructionContent,
            hash: yield* sha256Hex(instructionContent),
            kind: host?.instruction.kind ?? 'block',
            name: 'instructions',
            path: instructionPath,
          },
        ];
    const skillRoot = ompPaths?.skillRoot ?? (yield* expandPath(host!.skillRoot));
    const skills =
      profile === 'default'
        ? AGENT_SKILLS
        : profile === 'codex-cloud-personal'
          ? CODEX_CLOUD_PERSONAL_AGENT_SKILLS
          : CURSOR_CLOUD_PERSONAL_AGENT_SKILLS;
    for (const skill of skills) {
      const content = `${(yield* (yield* FileSystem.FileSystem).readFileString(
        path.join(profileRoot, 'agent-skills', skill, 'SKILL.md'),
      )).trim()}\n`;
      artifacts.push({
        content,
        hash: yield* sha256Hex(content),
        kind: 'file',
        name: `skill ${skill}`,
        path: path.join(skillRoot, skill, 'SKILL.md'),
      });
    }
    if (profile === 'codex-cloud-personal') {
      const content = `${(yield* (yield* FileSystem.FileSystem).readFileString(path.join(profileRoot, 'start-skill.md'))).trim()}\n`;
      artifacts.push({
        content,
        hash: yield* sha256Hex(content),
        kind: 'file',
        name: 'skill threadnote-start',
        path: path.join(codexRoot!, 'threadnote-start-skill.md'),
      });
    }
    return {
      artifacts,
      ...(codexRoot ? {hostRoot: codexRoot} : ompPaths === undefined ? {} : {hostRoot: ompPaths.agentRoot}),
    } satisfies AgentArtifactPlan;
  });
}

function hostReceipt(
  plan: AgentArtifactPlan,
  installedVersion: string,
  mcp: AgentIntegrationMcpReceipt,
  status: AgentIntegrationHostReceipt['status'],
): AgentIntegrationHostReceipt {
  return {
    artifacts: Object.fromEntries(plan.artifacts.map(artifact => [artifact.path, artifact.hash])),
    artifactVersion: AGENT_INTEGRATION_ARTIFACT_VERSION,
    installedVersion,
    mcp: {...mcp, ...(plan.hostRoot === undefined ? {} : {hostRoot: plan.hostRoot})},
    status,
  };
}

function renderInstructionContent(agent: AgentClient, kind: 'block' | 'file', block: string): string {
  if (kind === 'block') return block;
  const frontmatter =
    agent === 'cursor'
      ? [
          '---',
          'description: Route non-trivial work through installed Threadnote skills',
          'globs:',
          'alwaysApply: true',
          '---',
        ]
      : [
          '---',
          'name: Threadnote',
          'description: Route non-trivial work through installed Threadnote skills',
          'applyTo: "**"',
          '---',
        ];
  return [...frontmatter, '', block, ''].join('\n');
}

function logArtifactPlan(artifact: AgentArtifact) {
  return readFileIfExists(artifact.path).pipe(
    Effect.flatMap(current =>
      Console.log(`${current === undefined ? 'Would write' : 'Would update'} ${artifact.name}: ${artifact.path}`),
    ),
  );
}

const plannedArtifactContent = Effect.fn('agentIntegrations.plannedArtifactContent')(function* (
  artifact: AgentArtifact,
  current: string | undefined,
) {
  let next: string | undefined = artifact.content;
  if (artifact.kind === 'block') {
    next = upsertManagedBlock(current ?? '', artifact.content);
    if (next === undefined) {
      return yield* AgentIntegrationError.make({
        message: `${artifact.path} has partial Threadnote markers; not modifying it.`,
      });
    }
  } else if (current !== undefined && current !== artifact.content) {
    const currentBlock = extractManagedBlock(current);
    const expectedBlock = extractManagedBlock(artifact.content);
    const unmanagedContent = currentBlock === undefined ? undefined : removeManagedBlock(current);
    const generatedFile =
      unmanagedContent !== undefined &&
      (isExactLegacyCopilotInstructionFrontmatter(unmanagedContent) ||
        isGeneratedInstructionFrontmatter(unmanagedContent) ||
        (artifact.name.startsWith('skill ') && isGeneratedSkillFrontmatter(unmanagedContent)));
    const markerlessLegacyInstruction =
      currentBlock === undefined &&
      artifact.name === 'instructions' &&
      isExactLegacyCopilotInstructionFrontmatter(current);
    if (expectedBlock === undefined || (currentBlock === undefined && !markerlessLegacyInstruction)) {
      return yield* AgentIntegrationError.make({
        message: `${artifact.path} is not managed by Threadnote; not modifying it.`,
      });
    }
    next = generatedFile || markerlessLegacyInstruction ? artifact.content : upsertManagedBlock(current, expectedBlock);
  }
  if (next === undefined) {
    return yield* AgentIntegrationError.make({
      message: `${artifact.path} has partial Threadnote markers; not modifying it.`,
    });
  }
  return next;
});

export const preflightAgentIntegrationArtifacts = Effect.fn('agentIntegrations.preflightArtifacts')(function* (
  agent: AgentClient,
  mcp: AgentIntegrationMcpReceipt,
) {
  const plan = yield* agentArtifacts(agent, mcp.artifactProfile, mcp.hostRoot);
  for (const artifact of plan.artifacts) {
    yield* assertAgentTargetNotSymlink(artifact.path);
    yield* plannedArtifactContent(artifact, yield* readFileIfExists(artifact.path));
  }
});

export const writeArtifact = Effect.fn('agentIntegrations.writeArtifact')(function* (artifact: AgentArtifact) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* readFileIfExists(artifact.path);
  const next = yield* plannedArtifactContent(artifact, current);
  if (current === next) {
    yield* Console.log(`${artifact.name} already current: ${artifact.path}`);
    return;
  }
  yield* fs.makeDirectory(path.dirname(artifact.path), {recursive: true, mode: 0o700});
  yield* atomicAgentWrite(artifact.path, next, 0o644, {content: current});
  yield* Console.log(`${current === undefined ? 'Wrote' : 'Updated'} ${artifact.name}: ${artifact.path}`);
});

function removeOrphanedLegacyInstructions(selected: readonly AgentClient[], dryRun: boolean) {
  return Effect.gen(function* () {
    for (const agent of AGENT_CLIENTS) {
      if (selected.includes(agent)) continue;
      const host = agent === 'omp' ? undefined : HOST_TARGETS[agent];
      const ompPaths = yield* resolveAgentHostPaths(agent);
      const target = ompPaths?.instructionPath ?? (yield* expandPath(host!.instruction.path));
      yield* removeManagedPath(target, `${agent} instructions`, dryRun, host?.instruction.kind === 'file');
    }
    const cursorMarkdown = yield* expandPath('~/.cursor/rules/threadnote.md');
    yield* removeManagedPath(cursorMarkdown, 'legacy Cursor user rule', dryRun, true);
  });
}

export function removeArtifact(artifact: AgentArtifact, dryRun: boolean) {
  return removeManagedPath(artifact.path, artifact.name, dryRun, artifact.kind === 'file', artifact.content);
}

const removeManagedPath = Effect.fn('agentIntegrations.removeManagedPath')(function* (
  target: string,
  label: string,
  dryRun: boolean,
  removeWholeFile: boolean,
  expectedContent?: string,
) {
  const current = yield* readFileIfExists(target);
  if (current === undefined) return;
  const next = removeManagedBlock(current);
  if (next === undefined) {
    yield* Console.log(`WARN ${target} has partial Threadnote markers; not modifying it`);
    return;
  }
  if (next === current) return;
  const shouldRemove =
    next.trim().length === 0 ||
    (removeWholeFile &&
      (current === expectedContent || isGeneratedInstructionFrontmatter(next) || isGeneratedSkillFrontmatter(next)));
  if (dryRun) {
    yield* Console.log(`${shouldRemove ? 'Would remove' : 'Would update'} ${label}: ${target}`);
  } else if (shouldRemove) {
    yield* removeAgentTargetIfUnchanged(target, current);
    yield* Console.log(`Removed ${label}: ${target}`);
  } else {
    yield* atomicAgentWrite(target, next, 0o644, {content: current});
    yield* Console.log(`Updated ${target}`);
  }
});

function isGeneratedInstructionFrontmatter(content: string): boolean {
  const trimmed = content.trim();
  if (!/^---\n[\s\S]*\n---$/.test(trimmed)) return false;
  return (
    trimmed.includes('description: Route non-trivial work through installed Threadnote skills') &&
    (trimmed.includes('alwaysApply: true') || trimmed.includes('applyTo: "**"'))
  );
}

const LEGACY_COPILOT_INSTRUCTION_FRONTMATTER = [
  '---',
  'name: Threadnote',
  'description: Shared local context and handoffs through Threadnote',
  'applyTo: "**"',
  '---',
].join('\n');

export function isExactLegacyCopilotInstructionFrontmatter(content: string): boolean {
  return content.replaceAll('\r\n', '\n').replace(/\n+$/u, '') === LEGACY_COPILOT_INSTRUCTION_FRONTMATTER;
}

function isGeneratedSkillFrontmatter(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^---\n[\s\S]*\n---$/.test(trimmed) &&
    /^name: threadnote-(?:context|code-graph|memory|health)$/mu.test(trimmed) &&
    /^description: \S.+$/mu.test(trimmed)
  );
}

export function extractManagedBlock(content: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return undefined;
  return content.slice(startIndex, endIndex + USER_INSTRUCTIONS_END_MARKER.length);
}

export function upsertManagedBlock(content: string, block: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) return undefined;
  if (startIndex !== -1) {
    const before = content.slice(0, startIndex).trimEnd();
    const after = content.slice(endIndex + USER_INSTRUCTIONS_END_MARKER.length).trimStart();
    return joinMarkdownSections([before, block, after]);
  }
  return joinMarkdownSections([content.trimEnd(), block]);
}

function removeManagedBlock(content: string): string | undefined {
  const startIndex = content.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const endIndex = content.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) return undefined;
  if (startIndex === -1) return content;
  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + USER_INSTRUCTIONS_END_MARKER.length).trimStart();
  return joinMarkdownSections([before, after]);
}

function joinMarkdownSections(sections: readonly string[]): string {
  return `${sections.filter(section => section.length > 0).join('\n\n')}\n`;
}

export const atomicAgentWrite = Effect.fn('agentIntegrations.atomicWrite')(function* (
  target: string,
  content: string,
  mode = 0o600,
  expected?: {readonly content: string | undefined},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  yield* assertAgentTargetNotSymlink(target);
  const temporary = `${target}.threadnote-${system.processId}.tmp`;
  yield* fs.writeFileString(temporary, content, {mode, flag: 'wx'});
  yield* Effect.gen(function* () {
    if (expected !== undefined && (yield* readFileIfExists(target)) !== expected.content) {
      return yield* AgentIntegrationError.make({
        message: `${target} changed while Threadnote was preparing an update; no changes were written.`,
      });
    }
    yield* assertAgentTargetNotSymlink(target);
    yield* fs.rename(temporary, target);
  }).pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
});

export const removeAgentTargetIfUnchanged = Effect.fn('agentIntegrations.removeTargetIfUnchanged')(function* (
  target: string,
  expected: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* assertAgentTargetNotSymlink(target);
  if ((yield* readFileIfExists(target)) !== expected) {
    return yield* AgentIntegrationError.make({
      message: `${target} changed while Threadnote was preparing its removal; no changes were written.`,
    });
  }
  yield* assertAgentTargetNotSymlink(target);
  yield* fs.remove(target);
});

export const assertAgentTargetNotSymlink = Effect.fn('agentIntegrations.assertTargetNotSymlink')(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const symbolicLink = yield* fs.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (symbolicLink) {
    return yield* AgentIntegrationError.make({
      message: `${target} is a symbolic link; Threadnote will not replace or remove it.`,
    });
  }
});
