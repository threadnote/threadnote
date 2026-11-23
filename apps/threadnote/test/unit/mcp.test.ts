import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {withoutOmpPathSelectors} from '@threadnote/testing/omp-environment';
import {
  chmod,
  mkdtemp as makeTempDirectory,
  realpath,
  readFile,
  rm,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {delimiter, join} from '@threadnote/testing/node-path';
import {Effect, Equal, FileSystem, Path, Predicate} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {
  installCursorCloudAgentIntegration,
  readAgentIntegrationRegistry,
} from '@threadnote/threadnote/agent_integration/index';
import {commandLauncherPath, installCommandShim, renderCommandShim} from '@threadnote/threadnote/command-shim';
import {hasActiveMcpLauncher} from '../../src/mcp/codex_broker_rotation.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {activateStandaloneRelease} from '@threadnote/threadnote/installations';
import {CommandExecutor, formatShellCommand} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {repairRegisteredMcpClients, runUninstall} from '@threadnote/threadnote/lifecycle';
import {
  mcpAdapterCommand,
  mcpConfigurationChecks,
  resolveMcpClients,
  runMcpInstall,
} from '@threadnote/threadnote/mcp/index';
import {mcpToolCapabilities, parseMcpToolset} from '@threadnote/threadnote/mcp/toolset';
import {runOmpHooksInstall} from '@threadnote/threadnote/omp_hooks';
import {
  writeAgentIntegrationRegistry,
  withAgentIntegrationHost,
} from '@threadnote/threadnote/agent_integration/registry';
import {
  CODEX_MCP_RELEASE_ENV,
  reconcileActivatedCodexMcp,
  reconcileRegisteredCodexMcp,
  verifyRegisteredCodexMcp,
} from '@threadnote/threadnote/mcp/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function runtime(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/seed-manifest.yaml`,
    user: 'test-user',
  };
}

const fixtureRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-runtime-'}));
  return runtime(path.join(root, 'home'));
});

function dryRunOutput(toolset?: 'core' | 'full') {
  return Effect.gen(function* () {
    const config = yield* fixtureRuntime;
    return (yield* captureConsole(runMcpInstall(config, 'codex', {toolset}))).output;
  }).pipe(provideTestLayer(ApplicationLayer));
}

const mkdtemp = async (prefix: string) => realpath(await makeTempDirectory(prefix));

const originalPath = process.env.PATH;
const originalThreadnoteBinDirectory = process.env.THREADNOTE_BIN_DIR;
const temporaryDirectories: string[] = [];
const posixIt = process.platform === 'win32' ? it.skip : it;

async function agentLauncher(agent: 'claude' | 'codex', script: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `threadnote-${agent}-`));
  temporaryDirectories.push(directory);
  const launcher = join(directory, agent);
  await writeFile(launcher, `#!/bin/sh\n${script}\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

const codexLauncher = (script: string) => agentLauncher('codex', script);

function shellLiteral(value: string): string {
  return `'${Effect2.pipe(value, EffectString.replaceAll("'", `'"'"'`))}'`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalThreadnoteBinDirectory === undefined) {
    delete process.env.THREADNOTE_BIN_DIR;
  } else {
    process.env.THREADNOTE_BIN_DIR = originalThreadnoteBinDirectory;
  }
  await Promise.all(EffectArray.map(temporaryDirectories.splice(0), path => rm(path, {force: true, recursive: true})));
});

describe('MCP toolsets', () => {
  effectIt.effect('installs the core stdio toolset by default', () =>
    Effect.gen(function* () {
      expect(yield* dryRunOutput()).toContain('THREADNOTE_MCP_TOOLSET=core');
    }),
  );

  effectIt.effect('uses the stable MCP broker launcher instead of a direct server command', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const path = yield* Path.Path;
      const binDirectory = '/opt/threadnote/bin';
      const brokerLauncher = path.join(binDirectory, 'threadnote-mcp-server');
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          THREADNOTE_BIN_DIR: binDirectory,
        }),
        platform: 'linux',
      });
      const command = yield* mcpAdapterCommand().pipe(Effect.provideService(SystemInfo, testSystem));

      expect(command).toEqual([brokerLauncher]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('renders the broker launcher for every supported MCP host', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-render-'}));
      const binDirectory = '/opt/threadnote/bin';
      const brokerLauncher = path.join(binDirectory, 'threadnote-mcp-server');
      const userHome = path.join(root, 'user');
      const testRuntime = runtime(path.join(userHome, '.threadnote'));
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          THREADNOTE_BIN_DIR: binDirectory,
        }),
        homeDirectory: userHome,
        platform: 'linux',
      });

      for (const agent of ['codex', 'claude', 'cursor', 'copilot', 'omp'] as const) {
        const result = yield* captureConsole(runMcpInstall(testRuntime, agent, {})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const renderedBrokerLauncher =
          agent === 'cursor' || agent === 'copilot' || agent === 'omp'
            ? Effect2.pipe(JSON.stringify(brokerLauncher), EffectString.slice(1, -1))
            : brokerLauncher;
        expect(result.output, agent).toContain(renderedBrokerLauncher);
        expect(result.output, agent).not.toMatch(/\bthreadnote\s+mcp-server\b/);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps runnable quoting in MCP setup and removal previews', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const config = yield* fixtureRuntime;
      const testSystem = SystemInfo.of({
        ...baseSystem,
        platform: 'linux',
        environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: "/opt/threadnote's bin"}),
      });
      const preview = yield* captureConsole(runMcpInstall(config, 'codex', {name: 'team-memory'})).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(preview.output).toContain('threadnote mcp-install codex --apply --name team-memory');
      expect(preview.output).toContain('team-memory');
      expect(preview.output).not.toContain('codex mcp add');
      expect(preview.output).toContain(`'${join("/opt/threadnote'\"'\"'s bin", 'threadnote-mcp-server')}'`);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('installs the full stdio toolset when requested', () =>
    Effect.gen(function* () {
      expect(yield* dryRunOutput('full')).toContain('THREADNOTE_MCP_TOOLSET=full');
    }),
  );

  effectIt.effect('uses the owning repair command instead of advertising an unsupported apply flag', () =>
    Effect.gen(function* () {
      const result = yield* captureConsole(
        runMcpInstall(yield* fixtureRuntime, 'codex', {
          dryRunApplyCommand: 'threadnote repair',
        }),
      );
      expect(result.output).toContain('Run `threadnote repair` without `--dry-run`');
      expect(result.output).not.toContain('Re-run with --apply');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('rejects unsupported toolsets', () => {
    expect(() => parseMcpToolset('minimal')).toThrow(
      'Invalid MCP toolset: minimal. Expected core, cursor-cloud-personal, cursor-cloud-local, cursor-cloud, cursor-cloud-git-beta, or full.',
    );
  });

  it('gives Personal Cursor Cloud shared writes without graph, review, publishing, maintenance, or worksets', () => {
    for (const toolset of ['cursor-cloud-personal', 'cursor-cloud', 'cursor-cloud-git-beta'] as const) {
      expect(mcpToolCapabilities(parseMcpToolset(toolset)), toolset).toEqual({
        contextBrief: false,
        graphLocal: false,
        graphWorkset: false,
        lifecycle: false,
        maintenance: false,
        memoryPublish: false,
        memoryRead: true,
        memoryReview: false,
        memoryWrite: true,
      });
    }
  });

  it('keeps the Cursor Cloud local toolset graph-only', () => {
    expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud-local'))).toEqual({
      contextBrief: false,
      graphLocal: true,
      graphWorkset: false,
      lifecycle: false,
      maintenance: false,
      memoryPublish: false,
      memoryRead: false,
      memoryReview: false,
      memoryWrite: false,
    });
  });

  it('gives local personal toolsets the lifecycle surface while retaining maintenance for full', () => {
    expect(mcpToolCapabilities(parseMcpToolset('core'))).toMatchObject({lifecycle: true, maintenance: false});
    expect(mcpToolCapabilities(parseMcpToolset('full'))).toMatchObject({lifecycle: true, maintenance: true});
  });

  effectIt.effect('launches the Windows MCP cmd adapter through ComSpec', () =>
    Effect.gen(function* () {
      const command = yield* Effect.gen(function* () {
        const baseSystem = yield* SystemInfo;
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            ComSpec: 'C:\\Windows\\System32\\cmd.exe',
            THREADNOTE_BIN_DIR: 'C:\\Threadnote\\bin',
          }),
          platform: 'win32',
        });
        return yield* mcpAdapterCommand().pipe(Effect.provideService(SystemInfo, testSystem));
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(command.slice(0, 3)).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/c']);
      expect(command[3]).toMatch(/C:\\Threadnote\\bin[\\/]threadnote-mcp-server\.cmd$/);
      expect(command[3]).not.toContain('"');
    }),
  );
});

describe('JSON MCP host configuration', () => {
  effectIt.effect('preserves differently formatted current Cursor and Copilot entries byte-for-byte', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-current-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const copilotPath = path.join(root, 'copilot-mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_BIN_DIR: bin,
            THREADNOTE_COPILOT_MCP_CONFIG: copilotPath,
          }),
          homeDirectory: user,
          platform: 'linux',
        });

        for (const agent of ['cursor', 'copilot'] as const) {
          const configPath = agent === 'cursor' ? cursorPath : copilotPath;
          const containerKey = agent === 'cursor' ? 'mcpServers' : 'servers';
          const original = JSON.stringify(
            {
              userSetting: true,
              [containerKey]: {
                unrelated: {command: 'unrelated-server'},
                threadnote: {
                  userMetadata: {preserve: true},
                  env: {
                    THREADNOTE_USER: 'test-user',
                    THREADNOTE_MCP_TOOLSET: 'core',
                    THREADNOTE_HOME: testRuntime.agentContextHome,
                    THREADNOTE_MCP_CLIENT: agent,
                    THREADNOTE_MCP_SURFACE: agent === 'cursor' ? 'cursor-desktop' : 'copilot-vscode',
                    THREADNOTE_AGENT_ID: 'threadnote',
                    THREADNOTE_ACCOUNT: 'local',
                    USER_EXTENSION: 'preserved',
                  },
                  command: broker,
                  args: [],
                  ...(agent === 'copilot' ? {type: 'stdio'} : {}),
                },
              },
            },
            null,
            agent === 'cursor' ? 4 : 0,
          );
          yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
          yield* fs.writeFileString(configPath, original);

          const result = yield* captureConsole(runMcpInstall(testRuntime, agent, {apply: true})).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          expect(result.output, agent).toContain(`Already configured: ${configPath}`);
          expect(yield* fs.readFileString(configPath), agent).toBe(original);
          const registry = yield* readAgentIntegrationRegistry(testRuntime);
          expect(registry?.hosts[agent]).toMatchObject({
            mcp: {name: 'threadnote', repair: true, toolset: 'core'},
            status: 'current',
          });
          const skillRoot = path.join(user, agent === 'cursor' ? '.cursor' : '.copilot', 'skills');
          expect(yield* fs.exists(path.join(skillRoot, 'threadnote-context', 'SKILL.md')), agent).toBe(true);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('writes the omp native user config, preserving unrelated keys and staying idempotent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const configPath = path.join(user, '.omp', 'agent', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...withoutOmpPathSelectors(baseSystem.environment()), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({
            disabledServers: ['unrelated-disabled'],
            mcpServers: {unrelated: {command: 'unrelated-server'}},
          }),
        );

        const firstRun = yield* captureConsole(runMcpInstall(testRuntime, 'omp', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(firstRun.output).toContain(`Updated omp MCP config: ${configPath}`);
        expect(JSON.parse(yield* fs.readFileString(configPath))).toMatchObject({
          disabledServers: ['unrelated-disabled'],
          mcpServers: {
            unrelated: {command: 'unrelated-server'},
            threadnote: {
              args: [],
              command: broker,
              env: {
                THREADNOTE_ACCOUNT: 'local',
                THREADNOTE_AGENT_ID: 'threadnote',
                THREADNOTE_HOME: testRuntime.agentContextHome,
                THREADNOTE_MCP_CLIENT: 'omp',
                THREADNOTE_MCP_TOOLSET: 'core',
                THREADNOTE_USER: 'test-user',
              },
              instructions: false,
              type: 'stdio',
            },
          },
        });

        const registry = yield* readAgentIntegrationRegistry(testRuntime);
        expect(registry?.hosts.omp).toMatchObject({
          mcp: {name: 'threadnote', repair: true, toolset: 'core'},
          status: 'current',
        });
        expect(
          yield* fs.readFileString(path.join(user, '.omp', 'agent', 'skills', 'threadnote-context', 'SKILL.md')),
        ).toContain('name: threadnote-context');
        expect(yield* fs.readFileString(path.join(user, '.omp', 'agent', 'AGENTS.md'))).toContain(
          '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
        );

        const secondRun = yield* captureConsole(runMcpInstall(testRuntime, 'omp', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(secondRun.output).toContain(`Already configured: ${configPath}`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const scenario of ['denylist', 'entry', 'both'] as const)
    effectIt.effect(`repairs native omp ${scenario} disable mechanisms without dropping unrelated settings`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-disabled-'}),
          );
          const bin = path.join(root, 'bin');
          const user = path.join(root, scenario, 'user');
          const agentRoot = path.join(user, '.omp', 'agent');
          const configPath = path.join(agentRoot, 'mcp.json');
          const testRuntime = runtime(path.join(user, '.threadnote'));
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...withoutOmpPathSelectors(baseSystem.environment()),
              PI_CODING_AGENT_DIR: agentRoot,
              THREADNOTE_BIN_DIR: bin,
            }),
            homeDirectory: user,
            platform: 'linux',
          });

          yield* runMcpInstall(testRuntime, 'omp', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem));
          const configured = JSON.parse(yield* fs.readFileString(configPath));
          configured.unrelated = {keep: true};
          if (scenario !== 'entry') configured.disabledServers = ['unrelated-disabled', 'threadnote'];
          if (scenario !== 'denylist') configured.mcpServers.threadnote.enabled = false;
          yield* fs.writeFileString(configPath, JSON.stringify(configured));

          const repaired = yield* captureConsole(runMcpInstall(testRuntime, 'omp', {apply: true})).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          const next = JSON.parse(yield* fs.readFileString(configPath));
          expect(repaired.output, scenario).toContain(`Updated omp MCP config: ${configPath}`);
          expect(next.disabledServers, scenario).toEqual(scenario === 'entry' ? undefined : ['unrelated-disabled']);
          expect(next.mcpServers.threadnote.enabled, scenario).toBeUndefined();
          expect(next.unrelated, scenario).toEqual({keep: true});
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('keeps an allowlisted omp server current when its entry is disabled', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-enabled-'}),
        );
        const user = path.join(root, 'user');
        const configPath = path.join(user, '.omp', 'agent', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => withoutOmpPathSelectors(baseSystem.environment()),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* runMcpInstall(testRuntime, 'omp', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem));
        const configured = JSON.parse(yield* fs.readFileString(configPath));
        configured.enabledServers = ['threadnote'];
        configured.mcpServers.threadnote.enabled = false;
        const original = JSON.stringify(configured);
        yield* fs.writeFileString(configPath, original);

        const result = yield* captureConsole(runMcpInstall(testRuntime, 'omp', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(result.output).toContain(`Already configured: ${configPath}`);
        expect(yield* fs.readFileString(configPath)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses the active OMP agent root for its native MCP config', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-agent-dir-'}),
        );
        const user = path.join(root, 'user');
        const agentRoot = path.join(root, 'active-agent');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...withoutOmpPathSelectors(baseSystem.environment()),
            PI_CODING_AGENT_DIR: agentRoot,
          }),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* runMcpInstall(runtime(path.join(user, '.threadnote')), 'omp', {apply: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(yield* fs.exists(path.join(agentRoot, 'mcp.json'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.omp', 'agent', 'mcp.json'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('treats a configured custom OMP root as available without a default install', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-available-'}),
        );
        const user = path.join(root, 'user');
        const agentRoot = path.join(root, 'custom-agent');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...withoutOmpPathSelectors(baseSystem.environment()),
            PATH: path.join(root, 'empty-bin'),
            PI_CODING_AGENT_DIR: agentRoot,
          }),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* runMcpInstall(runtime(path.join(user, '.threadnote')), 'omp', {apply: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(yield* resolveMcpClients('omp', 'repair').pipe(Effect.provideService(SystemInfo, testSystem))).toEqual([
          'omp',
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('moves personal OMP MCP and managed hooks when the active profile changes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-profile-move-'}),
        );
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const profileRoot = (profile: string) => path.join(user, '.omp', 'profiles', profile, 'agent');
        const testSystem = (profile: string) =>
          SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...withoutOmpPathSelectors(baseSystem.environment()),
              OMP_PROFILE: profile,
              THREADNOTE_BIN_DIR: bin,
            }),
            homeDirectory: user,
            platform: 'linux',
          });

        yield* runMcpInstall(testRuntime, 'omp', {apply: true}).pipe(
          Effect.provideService(SystemInfo, testSystem('first')),
        );
        yield* runOmpHooksInstall({apply: true}).pipe(Effect.provideService(SystemInfo, testSystem('first')));
        const firstConfigPath = path.join(profileRoot('first'), 'mcp.json');
        const firstConfig = JSON.parse(yield* fs.readFileString(firstConfigPath));
        firstConfig.unrelated = {keep: true};
        yield* fs.writeFileString(firstConfigPath, JSON.stringify(firstConfig));

        yield* runMcpInstall(testRuntime, 'omp', {apply: true}).pipe(
          Effect.provideService(SystemInfo, testSystem('second')),
        );

        const previous = JSON.parse(yield* fs.readFileString(firstConfigPath));
        expect(previous.mcpServers.threadnote).toBeUndefined();
        expect(previous.unrelated).toEqual({keep: true});
        expect(yield* fs.exists(path.join(profileRoot('first'), 'hooks', 'pre', 'threadnote.ts'))).toBe(false);
        expect(yield* fs.exists(path.join(profileRoot('second'), 'hooks', 'pre', 'threadnote.ts'))).toBe(true);
        expect(yield* fs.exists(path.join(profileRoot('second'), 'mcp.json'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves personal hooks when a project-scoped OMP install changes profile', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-project-profile-move-'}),
        );
        const user = path.join(root, 'user');
        const project = path.join(root, 'project');
        const bin = path.join(root, 'bin');
        const testRuntime = runtime(path.join(root, 'shared-threadnote'));
        const profileRoot = (profile: string) => path.join(user, '.omp', 'profiles', profile, 'agent');
        const testSystem = (profile: string) =>
          SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...withoutOmpPathSelectors(baseSystem.environment()),
              OMP_PROFILE: profile,
              THREADNOTE_BIN_DIR: bin,
            }),
            homeDirectory: user,
            platform: 'linux',
          });

        yield* runMcpInstall(testRuntime, 'omp', {apply: true, project}).pipe(
          Effect.provideService(SystemInfo, testSystem('first')),
        );
        yield* runOmpHooksInstall({apply: true}).pipe(Effect.provideService(SystemInfo, testSystem('first')));

        yield* runMcpInstall(testRuntime, 'omp', {apply: true, project}).pipe(
          Effect.provideService(SystemInfo, testSystem('second')),
        );

        expect(yield* fs.exists(path.join(project, '.omp', 'mcp.json'))).toBe(true);
        expect(yield* fs.exists(path.join(profileRoot('first'), 'hooks', 'pre', 'threadnote.ts'))).toBe(true);
        expect(yield* fs.exists(path.join(profileRoot('second'), 'hooks', 'pre', 'threadnote.ts'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs a registered project-scoped OMP MCP under a non-personal home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-project-repair-'}),
        );
        const user = path.join(root, 'user');
        const project = path.join(root, 'project');
        const configPath = path.join(project, '.omp', 'mcp.json');
        const testRuntime = runtime(path.join(root, 'shared-threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => withoutOmpPathSelectors(baseSystem.environment()),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* runMcpInstall(testRuntime, 'omp', {apply: true, project}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const registry = yield* readAgentIntegrationRegistry(testRuntime);
        const drifted = JSON.parse(yield* fs.readFileString(configPath));
        drifted.unrelated = {keep: true};
        drifted.mcpServers.threadnote.command = 'stale-command';
        yield* fs.writeFileString(configPath, JSON.stringify(drifted));

        const repaired = yield* captureConsole(
          repairRegisteredMcpClients(testRuntime, registry, ['omp'], false).pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        );
        const next = JSON.parse(yield* fs.readFileString(configPath));
        expect(repaired.output).toContain(`Updated omp MCP config: ${configPath}`);
        expect(repaired.output).not.toContain('Skipping omp MCP repair');
        expect(next.unrelated).toEqual({keep: true});
        expect(next.mcpServers.threadnote.command).not.toBe('stale-command');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rewrites a drifted omp entry onto the broker launcher without dropping foreign keys', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-drift-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const configPath = path.join(user, '.omp', 'agent', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...withoutOmpPathSelectors(baseSystem.environment()), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({
            $schema: 'https://example.com/omp-mcp-schema.json',
            enabledServers: ['threadnote'],
            mcpServers: {
              threadnote: {
                args: ['mcp-server'],
                command: path.join(bin, 'threadnote'),
                env: {THREADNOTE_HOME: testRuntime.agentContextHome, THREADNOTE_MCP_TOOLSET: 'full'},
              },
            },
          }),
        );

        const result = yield* captureConsole(runMcpInstall(testRuntime, 'omp', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(result.output).toContain(`Updated omp MCP config: ${configPath}`);
        expect(JSON.parse(yield* fs.readFileString(configPath))).toMatchObject({
          $schema: 'https://example.com/omp-mcp-schema.json',
          enabledServers: ['threadnote'],
          mcpServers: {
            threadnote: {
              args: [],
              command: broker,
              env: {THREADNOTE_MCP_CLIENT: 'omp', THREADNOTE_MCP_TOOLSET: 'core'},
              type: 'stdio',
            },
          },
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rewrites drifted Cursor and Copilot entries while preserving unrelated configuration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-drift-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const copilotPath = path.join(root, 'copilot-mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_BIN_DIR: bin,
            THREADNOTE_COPILOT_MCP_CONFIG: copilotPath,
          }),
          homeDirectory: user,
          platform: 'linux',
        });

        for (const agent of ['cursor', 'copilot'] as const) {
          const configPath = agent === 'cursor' ? cursorPath : copilotPath;
          const containerKey = agent === 'cursor' ? 'mcpServers' : 'servers';
          yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
          yield* fs.writeFileString(
            configPath,
            JSON.stringify({
              userSetting: true,
              [containerKey]: {
                unrelated: {command: 'unrelated-server'},
                threadnote: {
                  args: ['mcp-server'],
                  command: path.join(bin, 'threadnote'),
                  env: {
                    THREADNOTE_ACCOUNT: 'local',
                    THREADNOTE_AGENT_ID: 'threadnote',
                    THREADNOTE_HOME: testRuntime.agentContextHome,
                    THREADNOTE_MCP_TOOLSET: 'full',
                    THREADNOTE_USER: 'test-user',
                  },
                  ...(agent === 'copilot' ? {type: 'stdio'} : {}),
                },
              },
            }),
          );

          const result = yield* captureConsole(runMcpInstall(testRuntime, agent, {apply: true})).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          const updated: unknown = JSON.parse(yield* fs.readFileString(configPath));

          expect(result.output, agent).toContain('Updated');
          expect(updated, agent).toMatchObject({
            userSetting: true,
            [containerKey]: {
              unrelated: {command: 'unrelated-server'},
              threadnote: {
                args: [],
                command: broker,
                env: {THREADNOTE_MCP_TOOLSET: 'core'},
                ...(agent === 'copilot' ? {type: 'stdio'} : {}),
              },
            },
          });
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall removes a registered custom MCP name and its host bundle', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-custom-mcp-uninstall-'}),
        );
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(
          cursorPath,
          JSON.stringify({mcpServers: {unrelated: {command: 'keep-me'}}}, undefined, 2),
        );
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* runMcpInstall(testRuntime, 'cursor', {
          apply: true,
          name: 'team-memory',
          toolset: 'full',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* runUninstall(testRuntime, {preserveMemories: true}).pipe(Effect.provideService(SystemInfo, testSystem));

        const cursorConfig: unknown = JSON.parse(yield* fs.readFileString(cursorPath));
        expect(cursorConfig).toMatchObject({mcpServers: {unrelated: {command: 'keep-me'}}});
        expect(JSON.stringify(cursorConfig)).not.toContain('team-memory');
        expect(yield* readAgentIntegrationRegistry(testRuntime)).toBeUndefined();
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(false);
        expect(yield* fs.exists(path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall preserves a Dashboard-owned personal Cursor MCP entry', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-cloud-uninstall-'}),
        );
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const originalConfig = {
          mcpServers: {
            threadnote: {command: 'dashboard-owned-local-companion'},
            unrelated: {command: 'keep-me'},
          },
        };
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(cursorPath, `${JSON.stringify(originalConfig, undefined, 2)}\n`);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* installCursorCloudAgentIntegration(testRuntime, false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* runUninstall(testRuntime, {preserveMemories: true}).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(JSON.parse(yield* fs.readFileString(cursorPath))).toEqual(originalConfig);
        expect(yield* readAgentIntegrationRegistry(testRuntime)).toBeUndefined();
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(false);
        expect(yield* fs.exists(path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not classify a fresh Cursor MCP install as a legacy integration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-fresh-cursor-install-'}),
        );
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        const result = yield* captureConsole(
          runMcpInstall(testRuntime, 'cursor', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
        );

        expect(result.output).toContain('No legacy agent integrations found.');
        expect(result.output).not.toContain('Migrated 1 legacy agent integration');
        expect(
          Effect2.pipe(
            result.output,
            EffectString.match(/Wrote instructions:/g),
            Effect2.Option.getOrElse(() => null),
          ),
        ).toHaveLength(1);
        expect(yield* readAgentIntegrationRegistry(testRuntime)).toMatchObject({
          hosts: {cursor: {mcp: {name: 'threadnote', repair: true}, status: 'current'}},
          legacyInstructionsMigrated: true,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes concurrent MCP install and uninstall into a consistent winning state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-install-uninstall-race-'}),
        );
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const rulePath = path.join(user, '.cursor', 'rules', 'threadnote.mdc');
        const skillPath = path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(cursorPath, '{}\n');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* Effect.forEach(
          [
            runMcpInstall(testRuntime, 'cursor', {apply: true, name: 'team-memory', toolset: 'full'}),
            runUninstall(testRuntime, {preserveMemories: true}),
          ],
          operation => operation.pipe(Effect.provideService(SystemInfo, testSystem)),
          {concurrency: 'unbounded'},
        ).pipe(TestClock.withLive);

        const registry = yield* readAgentIntegrationRegistry(testRuntime);
        const parsedCursorConfig: unknown = JSON.parse(yield* fs.readFileString(cursorPath));
        if (!Predicate.isObject(parsedCursorConfig)) throw new Error('Cursor MCP configuration must be an object.');
        const cursorConfig = parsedCursorConfig;
        const configuredServers = cursorConfig.mcpServers;
        if (configuredServers !== undefined && !Predicate.isObject(configuredServers))
          throw new Error('Cursor MCP server entries must be an object.');
        const mcpServers = configuredServers;
        const installed = registry?.hosts.cursor?.status === 'current';
        expect(mcpServers?.['team-memory'] !== undefined).toBe(installed);
        expect(yield* fs.exists(rulePath)).toBe(installed);
        expect(yield* fs.exists(skillPath)).toBe(installed);
        // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
        expect(registry === undefined || Object.keys(registry.hosts).length === 0).toBe(!installed);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall retains a receipt when its custom MCP entry cannot be removed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-custom-mcp-retry-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const installRoot = path.join(root, 'install');
        const releaseRoot = path.join(installRoot, 'versions', '4.6.3');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.makeDirectory(releaseRoot, {recursive: true});
        yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), '{"version":"4.6.3"}\n');
        yield* fs.writeFileString(cursorPath, '{}\n');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            PATH: bin,
            THREADNOTE_BIN_DIR: bin,
            THREADNOTE_INSTALL_ROOT: installRoot,
          }),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* activateStandaloneRelease(releaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* runMcpInstall(testRuntime, 'cursor', {
          apply: true,
          name: 'team-memory',
          toolset: 'full',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* fs.writeFileString(cursorPath, '{ invalid json\n');

        const uninstall = yield* runUninstall(testRuntime, {preserveMemories: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.exit,
        );

        expect(uninstall._tag).toBe('Failure');
        expect((yield* readAgentIntegrationRegistry(testRuntime))?.hosts.cursor?.mcp).toMatchObject({
          name: 'team-memory',
          repair: true,
        });
        expect(yield* fs.readFileString(cursorPath)).toBe('{ invalid json\n');
        expect(yield* fs.exists(path.join(bin, 'threadnote'))).toBe(true);
        expect(yield* fs.exists(path.join(bin, 'threadnote-mcp-server'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses explicit MCP omission without removing retry-critical state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-omitted-uninstall-'}),
        );
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const installRoot = path.join(root, 'install');
        const releaseRoot = path.join(installRoot, 'versions', '4.6.3');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.makeDirectory(releaseRoot, {recursive: true});
        yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), '{"version":"4.6.3"}\n');
        yield* fs.writeFileString(cursorPath, '{}\n');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            PATH: bin,
            THREADNOTE_BIN_DIR: bin,
            THREADNOTE_INSTALL_ROOT: installRoot,
          }),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* activateStandaloneRelease(releaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* runMcpInstall(testRuntime, 'cursor', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));

        const uninstall = yield* runUninstall(testRuntime, {mcp: 'none', preserveMemories: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.exit,
        );

        expect(uninstall._tag).toBe('Failure');
        expect((yield* readAgentIntegrationRegistry(testRuntime))?.hosts.cursor?.status).toBe('current');
        expect(yield* fs.exists(path.join(bin, 'threadnote'))).toBe(true);
        expect(yield* fs.exists(path.join(bin, 'threadnote-mcp-server'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const codexConfigurationFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* SystemInfo;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-codex-config-'}));
  const userHome = path.join(root, 'user');
  const hostRoot = path.join(root, 'desktop');
  const alternateRoot = path.join(root, 'alternate');
  const bin = path.join(root, 'bin');
  const config = runtime(path.join(userHome, '.threadnote'));
  const installRoot = path.join(root, 'installation');
  const target = path.join(hostRoot, 'config.toml');
  const alternateTarget = path.join(alternateRoot, 'config.toml');
  yield* fs.makeDirectory(bin, {recursive: true});
  yield* fs.makeDirectory(hostRoot, {recursive: true});
  yield* fs.makeDirectory(alternateRoot, {recursive: true});
  const executable = path.join(bin, 'codex');
  yield* fs.writeFileString(executable, 'Codex executable probe fixture\n', {mode: 0o755});
  yield* fs.chmod(executable, 0o755);
  const commandCalls: string[][] = [];
  const executor = yield* CommandExecutor;
  const commandExecutor = CommandExecutor.of({
    ...executor,
    execute: (candidate, args, options) =>
      candidate === executable
        ? Effect.sync(() => {
            commandCalls.push([...args]);
            return {exitCode: Equal.equals(args, ['--version']) ? 0 : 1, stderr: '', stdout: ''};
          })
        : executor.execute(candidate, args, options),
  });
  const inCodexHome = (home: string) =>
    SystemInfo.of({
      ...base,
      environment: () => ({
        ...base.environment(),
        CODEX_HOME: home,
        PATH: bin,
        THREADNOTE_BIN_DIR: bin,
        THREADNOTE_INSTALL_ROOT: installRoot,
      }),
      homeDirectory: userHome,
    });
  const inFixture = <A, E, R>(effect: Effect.Effect<A, E, R>, selectedHome = hostRoot) =>
    effect.pipe(
      Effect.provideService(SystemInfo, inCodexHome(selectedHome)),
      Effect.provideService(CommandExecutor, commandExecutor),
    );
  const activate = (version: string) =>
    inFixture(
      Effect.gen(function* () {
        const releaseRoot = path.join(installRoot, 'versions', version);
        yield* fs.makeDirectory(releaseRoot, {recursive: true});
        yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), JSON.stringify({version}));
        yield* activateStandaloneRelease(releaseRoot, false);
        yield* installCommandShim(false, releaseRoot, config.agentContextHome);
      }),
    );
  return {
    activate,
    alternateRoot,
    alternateTarget,
    bin,
    commandCalls,
    config,
    hostRoot,
    inFixture,
    installRoot,
    target,
  };
});

const firstCodexRelease = '6.4.1-dev.aaaaaaaaaaaa';
const secondCodexRelease = '6.4.1-dev.bbbbbbbbbbbb';

describe('Codex receipt-owned release marker', () => {
  effectIt.effect('verifies the primary Windows CMD launcher without POSIX executable bits', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* SystemInfo;
      const bin = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-codex-cmd-launcher-'});
      const release = path.join(bin, 'versions', firstCodexRelease);
      const system = SystemInfo.of({
        ...base,
        environment: () => ({...base.environment(), THREADNOTE_BIN_DIR: bin}),
        platform: 'win32',
      });
      yield* Effect.gen(function* () {
        const cmd = yield* commandLauncherPath('mcp');
        const posix = yield* commandLauncherPath('mcp', 'posix');
        expect(cmd).toContain('threadnote-mcp-server.cmd');
        yield* fs.writeFileString(posix, yield* renderCommandShim(release, 'mcp', 'posix'), {mode: 0o755});
        expect(yield* hasActiveMcpLauncher(release)).toBe(false);
        yield* fs.writeFileString(cmd, yield* renderCommandShim(release, 'mcp', 'cmd'), {mode: 0o600});
        expect(yield* hasActiveMcpLauncher(release)).toBe(true);
      }).pipe(Effect.provideService(SystemInfo, system));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'pins fresh custom setup and updates only the marker in both repair entry points',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* codexConfigurationFixture;
        const {activate, alternateRoot, alternateTarget, config, hostRoot, inFixture, target} = fixture;
        const untouched = EffectArray.join(
          [
            '# Other Codex settings',
            'model = "fixture"',
            '[mcp_servers.threadnote-org]',
            'url = "https://composer.example/mcp" # organization',
            '[mcp_servers.unrelated]',
            'command = "/other/launcher"',
            'enabled = false',
            '',
          ],
          '\r\n',
        );
        yield* fs.writeFileString(target, untouched);
        yield* activate(firstCodexRelease);
        const install = runMcpInstall(config, 'codex', {apply: true, name: 'team-memory', toolset: 'full'});
        const alias = path.join(alternateRoot, 'alias');
        yield* fs.symlink(hostRoot, alias);
        const preview = yield* inFixture(captureConsole(runMcpInstall(config, 'codex', {name: 'team-memory'})), alias);
        expect(preview.output).toContain(hostRoot);
        expect(preview.output).toContain(firstCodexRelease);
        expect(preview.output).toContain('threadnote mcp-install codex --apply --name team-memory');
        expect(yield* fs.readFileString(target)).toBe(untouched);
        yield* inFixture(install, alias);
        const registry = yield* readAgentIntegrationRegistry(config);
        expect(registry?.hosts.codex?.mcp).toMatchObject({
          hostRoot,
          name: 'team-memory',
          repair: true,
          toolset: 'full',
        });
        const fresh = yield* fs.readFileString(target);
        const marker = `${CODEX_MCP_RELEASE_ENV} = "${firstCodexRelease}"`;
        expect(fresh).toContain(marker);
        expect(EffectString.startsWith(untouched)(fresh)).toBe(true);
        expect(fresh).toContain('THREADNOTE_MCP_TOOLSET = "full"');
        expect(fixture.commandCalls.flat()).not.toContain('add');
        expect(fixture.commandCalls.flat()).not.toContain('remove');

        const modified = EffectString.replace(
          marker,
          `${marker} # keep marker comment\r\nUSER_OVERRIDE = 'keep'`,
        )(fresh);
        yield* fs.writeFileString(target, modified);
        yield* fs.writeFileString(alternateTarget, modified);
        const before = yield* fs.stat(target);
        yield* inFixture(install);
        expect((yield* fs.stat(target)).ino).toEqual(before.ino);
        expect(yield* fs.readFileString(target)).toBe(modified);

        yield* activate(secondCodexRelease);
        expect(yield* inFixture(mcpConfigurationChecks(config), alternateRoot)).toContainEqual({
          detail: expect.stringContaining('has a stale release marker'),
          name: 'codex MCP',
          status: 'warn',
        });
        const dryRun = repairRegisteredMcpClients(config, registry, ['codex'], true);
        yield* inFixture(dryRun, alternateRoot);
        expect(yield* fs.readFileString(target)).toBe(modified);
        yield* inFixture(repairRegisteredMcpClients(config, registry, ['codex'], false), alternateRoot);
        expect(yield* fs.readFileString(target)).toBe(
          EffectString.replace(firstCodexRelease, secondCodexRelease)(modified),
        );
        expect(yield* fs.readFileString(alternateTarget)).toBe(modified);

        const verified = yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease), alternateRoot);
        expect(verified).toMatchObject({state: 'current', hostRoot, name: 'team-memory', release: secondCodexRelease});
        if (verified.state === 'current')
          expect(yield* inFixture(verifyRegisteredCodexMcp(config, verified))).toBe(true);

        yield* activate(firstCodexRelease);
        const adapter = getAgentAdapter('codex-cli')!;
        yield* inFixture(adapter.actions.repair(config, adapter, {apply: true}), alternateRoot);
        expect(yield* fs.readFileString(target)).toBe(modified);
        expect(yield* fs.readFileString(alternateTarget)).toBe(modified);
        const oldRoot = path.join(alternateRoot, 'previous-desktop');
        yield* fs.rename(hostRoot, oldRoot);
        yield* fs.symlink(alternateRoot, hostRoot);
        yield* activate(secondCodexRelease);
        const redirected = yield* inFixture(reconcileActivatedCodexMcp(config, secondCodexRelease));
        expect(redirected).toMatchObject({
          configuration: 'deferred',
          refresh: 'pending',
          reason: expect.stringContaining(
            'Set CODEX_HOME to the intended Codex home, then run `threadnote mcp-install codex --apply --name team-memory`',
          ),
        });
        expect(yield* fs.readFileString(alternateTarget)).toBe(modified);
        expect(yield* fs.readFileString(path.join(oldRoot, 'config.toml'))).toBe(modified);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'requires explicit adoption of an unpinned legacy entry and preserves its user settings',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const {activate, alternateRoot, alternateTarget, bin, config, hostRoot, inFixture, target} =
          yield* codexConfigurationFixture;
        yield* activate(secondCodexRelease);
        yield* inFixture(runMcpInstall(config, 'codex', {apply: true, name: 'legacy-team'}));
        const registry = (yield* readAgentIntegrationRegistry(config))!;
        const previous = registry.hosts.codex!;
        const unpinned = withAgentIntegrationHost(registry, 'codex', {
          ...previous,
          mcp: {...previous.mcp, hostRoot: undefined},
        });
        yield* writeAgentIntegrationRegistry(config, unpinned);
        const direct = JSON.stringify(path.join(bin, 'threadnote'));
        const broker = JSON.stringify(path.join(bin, 'threadnote-mcp-server'));
        const dotted = 'mcp_servers."legacy-team"';
        const ownerLine = `${dotted}.env.THREADNOTE_HOME = ${JSON.stringify(config.agentContextHome)} # profile\n`;
        const legacy = EffectArray.join(
          [
            `${dotted}.command = ${direct} # keep legacy comment`,
            `${dotted}.args = [ # keep array comment`,
            "  'mcp-server', # keep argument comment",
            ']',
            `${dotted}.startup_timeout_sec = 19`,
            EffectString.trimEnd(ownerLine),
            `${dotted}.env.USER_CONFIG = 'keep'`,
            `${dotted}.env.THREADNOTE_ACCOUNT = 'old-account'`,
            `${dotted}.env.THREADNOTE_AGENT_ID = 'threadnote'`,
            `${dotted}.env.THREADNOTE_USER = 'test-user'`,
            `${dotted}.env.THREADNOTE_MCP_CLIENT = 'codex'`,
            `${dotted}.env.THREADNOTE_MCP_SURFACE = 'codex-cli'`,
            `${dotted}.env.THREADNOTE_MCP_TOOLSET = 'core'`,
            '',
          ],
          '\n',
        );
        yield* fs.writeFileString(target, legacy);
        yield* fs.writeFileString(alternateTarget, legacy);
        const repair = yield* inFixture(
          captureConsole(repairRegisteredMcpClients(config, unpinned, ['codex'], false)),
          alternateRoot,
        );
        expect(repair.output).toContain('threadnote mcp-install codex --apply --name legacy-team');
        expect(yield* fs.readFileString(target)).toBe(legacy);
        expect(yield* fs.readFileString(alternateTarget)).toBe(legacy);

        yield* inFixture(runMcpInstall(config, 'codex', {apply: true, name: 'legacy-team'}));
        expect((yield* readAgentIntegrationRegistry(config))?.hosts.codex?.mcp.hostRoot).toBe(hostRoot);
        const expected = Effect2.pipe(
          legacy,
          EffectString.replace(direct, broker),
          EffectString.replace("'mcp-server',", ''),
          EffectString.replace(
            ownerLine,
            `${ownerLine}${dotted}.env.${CODEX_MCP_RELEASE_ENV} = "${secondCodexRelease}"\n`,
          ),
        );
        expect(yield* fs.readFileString(target)).toBe(EffectString.replace("'old-account'", '"local"')(expected));
        expect(yield* fs.readFileString(alternateTarget)).toBe(legacy);
        yield* fs.writeFileString(target, legacy);
        const doctor = yield* inFixture(mcpConfigurationChecks(config), alternateRoot);
        expect(doctor).toContainEqual({
          detail: expect.stringContaining('uses the owned legacy direct server command'),
          name: 'codex MCP',
          status: 'warn',
        });
        expect((yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease), alternateRoot)).state).toBe(
          'saved',
        );
        expect(yield* fs.readFileString(target)).toBe(expected);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'defers a generation changed during publication and lets repair converge',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const {activate, config, inFixture, installRoot, target} = yield* codexConfigurationFixture;
        const nextRelease = '6.4.1-dev.cccccccccccc';
        yield* activate(nextRelease);
        const activePath = path.join(installRoot, 'active-release.json');
        const nextPointer = yield* fs.readFileString(activePath);
        yield* activate(firstCodexRelease);
        yield* inFixture(runMcpInstall(config, 'codex', {apply: true}));
        yield* activate(secondCodexRelease);
        const result = yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              fs
                .rename(from, to)
                .pipe(Effect.tap(() => (to === target ? fs.writeFileString(activePath, nextPointer) : Effect.void))),
          }),
        );
        expect(result).toMatchObject({state: 'deferred', reason: 'the active release changed during reconciliation'});
        const repaired = yield* inFixture(reconcileRegisteredCodexMcp(config, nextRelease));
        expect(repaired).toMatchObject({state: 'saved', release: nextRelease});
        expect(yield* fs.readFileString(target)).toContain(`${CODEX_MCP_RELEASE_ENV} = "${nextRelease}"`);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'defers disabled, external, cloud, and concurrently edited entries',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const {activate, config, hostRoot, inFixture, target} = yield* codexConfigurationFixture;
        yield* activate(firstCodexRelease);
        yield* inFixture(runMcpInstall(config, 'codex', {apply: true}));
        const registry = (yield* readAgentIntegrationRegistry(config))!;
        const desktop = registry.hosts.codex!;
        const original = yield* fs.readFileString(target);
        yield* activate(secondCodexRelease);
        const disabled = EffectString.replace(
          '[mcp_servers.threadnote]\n',
          '[mcp_servers.threadnote]\nenabled = false\n',
        )(original);
        yield* fs.writeFileString(target, disabled);
        expect((yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease))).state).toBe('deferred');
        expect(yield* fs.readFileString(target)).toBe(disabled);
        expect(yield* inFixture(reconcileActivatedCodexMcp(config, secondCodexRelease))).toMatchObject({
          configuration: 'deferred',
          refresh: 'pending',
          reason: expect.stringContaining('Enable it in Codex before running repair'),
        });

        yield* fs.remove(target);
        const setupInstruction = `Set CODEX_HOME to ${formatShellCommand(hostRoot, [])}, then run \`threadnote mcp-install codex --apply --name threadnote\``;
        const missing = yield* inFixture(mcpConfigurationChecks(config));
        expect(missing).toContainEqual({
          detail: expect.stringContaining(setupInstruction),
          name: 'codex MCP',
          status: 'warn',
        });
        expect((yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease))).state).toBe('deferred');
        expect(yield* inFixture(reconcileActivatedCodexMcp(config, secondCodexRelease))).toMatchObject({
          configuration: 'deferred',
          refresh: 'pending',
          reason: expect.stringContaining(setupInstruction),
        });
        expect(yield* fs.exists(target)).toBe(false);

        yield* fs.writeFileString(target, original);
        for (const mcp of [
          {...desktop.mcp, external: true},
          {...desktop.mcp, artifactProfile: 'codex-cloud-personal' as const, transport: 'cli' as const, repair: false},
        ]) {
          yield* writeAgentIntegrationRegistry(config, withAgentIntegrationHost(registry, 'codex', {...desktop, mcp}));
          expect((yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease))).state).toBe('skipped');
          expect(yield* fs.readFileString(target)).toBe(original);
        }
        yield* writeAgentIntegrationRegistry(config, registry);

        const concurrent = `${original}# user wrote while reconciliation was staging\n`;
        const result = yield* inFixture(reconcileRegisteredCodexMcp(config, secondCodexRelease)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (file, content, options) =>
              fs
                .writeFileString(file, content, options)
                .pipe(
                  Effect.tap(() =>
                    EffectString.includes('.threadnote-mcp-')(file)
                      ? fs.writeFileString(target, concurrent)
                      : Effect.void,
                  ),
                ),
          }),
        );
        expect(result.state).toBe('deferred');
        expect(yield* fs.readFileString(target)).toBe(concurrent);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'requires the active release launcher bytes at activation and publication',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const {activate, bin, config, inFixture, installRoot, target} = yield* codexConfigurationFixture;
        yield* activate(firstCodexRelease);
        const launcher = yield* inFixture(commandLauncherPath('mcp'));
        const previousLauncher = yield* fs.readFileString(launcher);
        yield* inFixture(runMcpInstall(config, 'codex', {apply: true}));
        const previousConfig = yield* fs.readFileString(target);
        yield* activate(secondCodexRelease);
        const currentLauncher = yield* fs.readFileString(launcher);
        const copy = path.join(bin, 'foreign-copy');
        const writeLauncher = (contents: string) => fs.writeFileString(launcher, contents, {mode: 0o755});
        const reconcile = inFixture(reconcileActivatedCodexMcp(config, secondCodexRelease));
        const deferred = {
          configuration: 'deferred',
          refresh: 'pending',
          reason: expect.stringContaining('The MCP launcher does not match the active Threadnote release'),
        };
        yield* writeLauncher('unmanaged launcher\n');
        expect(yield* reconcile).toMatchObject(deferred);
        expect(yield* fs.readFileString(launcher)).toBe('unmanaged launcher\n');
        yield* writeLauncher(previousLauncher);
        expect(yield* reconcile).toMatchObject(deferred);
        expect(yield* fs.readFileString(launcher)).toBe(previousLauncher);
        yield* fs.writeFileString(copy, currentLauncher, {mode: 0o755});
        yield* fs.remove(launcher);
        yield* fs.symlink(copy, launcher);
        expect(yield* reconcile).toMatchObject(deferred);
        expect(yield* fs.readLink(launcher)).toBe(copy);
        expect(yield* fs.readFileString(target)).toBe(previousConfig);

        yield* fs.remove(launcher);
        yield* writeLauncher(currentLauncher);
        expect(
          yield* reconcile.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              writeFileString: (file, contents, options) =>
                fs
                  .writeFileString(file, contents, options)
                  .pipe(
                    Effect.tap(() =>
                      EffectString.includes('.threadnote-mcp-')(file) ? writeLauncher(previousLauncher) : Effect.void,
                    ),
                  ),
            }),
          ),
        ).toMatchObject(deferred);
        expect(yield* fs.readFileString(target)).toBe(previousConfig);
        yield* writeLauncher(currentLauncher);
        expect(yield* reconcile).toMatchObject({
          configuration: 'saved',
          refresh: 'pending',
          release: secondCodexRelease,
        });
        const installAlias = path.join(bin, 'installation-alias');
        yield* fs.symlink(installRoot, installAlias);
        yield* inFixture(
          Effect.gen(function* () {
            const system = yield* SystemInfo;
            const aliasRelease = path.join(installAlias, 'versions', secondCodexRelease);
            yield* writeLauncher(yield* renderCommandShim(aliasRelease, 'mcp'));
            const check = hasActiveMcpLauncher(path.join(installRoot, 'versions', secondCodexRelease)).pipe(
              Effect.provideService(
                SystemInfo,
                SystemInfo.of({
                  ...system,
                  environment: () => ({...system.environment(), THREADNOTE_INSTALL_ROOT: installAlias}),
                }),
              ),
            );
            expect(yield* check).toBe(true);
            yield* fs.remove(installAlias);
            expect(yield* check).toBe(false);
          }),
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

describe('MCP agent executable resolution', () => {
  posixIt('does not remove or add semantically current Claude broker configuration', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-managed-bin-'));
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-agent-home-'));
    temporaryDirectories.push(bin);
    temporaryDirectories.push(userHome);
    const system = await runEffect(SystemInfo);
    const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
    const testRuntime = runtime(join(userHome, '.threadnote'));
    process.env.THREADNOTE_BIN_DIR = bin;
    const broker = join(bin, 'threadnote-mcp-server');

    {
      const agent = 'claude';
      const managedEnvironment = {
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: testRuntime.agentContextHome,
        THREADNOTE_MCP_CLIENT: agent,
        THREADNOTE_MCP_SURFACE: 'claude-code',
        THREADNOTE_MCP_TOOLSET: 'core',
        THREADNOTE_USER: 'test-user',
      };

      const callsPath = join(tmpdir(), `threadnote-${agent}-current-calls-${process.pid}-${Date.now()}`);
      const output = EffectArray.join(
        [
          'threadnote:',
          '  Scope: User config (available in all your projects)',
          '  Status: ✘ Failed to connect',
          '  Type: stdio',
          `  Command: ${broker}`,
          '  Args:',
          '  Environment:',
          ...EffectArray.map(EffectRecord.toEntries(managedEnvironment), ([key, value]) => `    ${key}=${value}`),
        ],
        '\n',
      );
      const launcher = await agentLauncher(
        agent,
        `if [ "$1" = "--version" ]; then printf '%s\\n' '${agent} 1'; exit 0; fi\nprintf '%s\\n' "$*" >> ${shellLiteral(callsPath)}\nprintf '%s\\n' ${shellLiteral(output)}`,
      );
      process.env.PATH = EffectArray.join([join(launcher, '..'), '/usr/bin', '/bin'], delimiter);

      await runEffect(
        runMcpInstall(testRuntime, agent, {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
      );

      const calls = await readFile(callsPath, 'utf8');
      expect(calls, agent).toContain('mcp get threadnote');
      expect(calls, agent).not.toContain('mcp remove');
      expect(calls, agent).not.toContain('mcp add');
      const registry = await runEffect(readAgentIntegrationRegistry(testRuntime));
      expect(registry?.hosts[agent]).toMatchObject({
        mcp: {name: 'threadnote', repair: true, toolset: 'core'},
        status: 'current',
      });
      const instructionPath = join(userHome, '.claude/CLAUDE.md');
      expect(await readFile(instructionPath, 'utf8'), agent).toContain('Route non-trivial work by situation');
      await rm(callsPath, {force: true});
    }
  });

  posixIt('migrates a legacy direct Claude server configuration to the broker launcher', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-managed-bin-'));
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-agent-home-'));
    temporaryDirectories.push(bin);
    temporaryDirectories.push(userHome);
    const system = await runEffect(SystemInfo);
    const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
    const testRuntime = runtime(join(userHome, '.threadnote'));
    process.env.THREADNOTE_BIN_DIR = bin;
    const broker = join(bin, 'threadnote-mcp-server');
    const legacyCommand = join(bin, 'threadnote');
    const managedEnvironment = {
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_HOME: testRuntime.agentContextHome,
      THREADNOTE_MCP_TOOLSET: 'core',
      THREADNOTE_USER: 'test-user',
    };

    {
      const agent = 'claude';
      const callsPath = join(tmpdir(), `threadnote-${agent}-legacy-calls-${process.pid}-${Date.now()}`);
      const output = EffectArray.join(
        [
          'threadnote:',
          '  Scope: User config (available in all your projects)',
          '  Status: ✘ Failed to connect',
          '  Type: stdio',
          `  Command: ${legacyCommand}`,
          '  Args: mcp-server',
          '  Environment:',
          ...EffectArray.map(EffectRecord.toEntries(managedEnvironment), ([key, value]) => `    ${key}=${value}`),
        ],
        '\n',
      );
      const launcher = await agentLauncher(
        agent,
        `if [ "$1" = "--version" ]; then printf '%s\\n' '${agent} 1'; exit 0; fi\nprintf '%s\\n' "$*" >> ${shellLiteral(callsPath)}\ncase "$*" in\n  "mcp get threadnote"*) printf '%s\\n' ${shellLiteral(output)} ;;\nesac`,
      );
      process.env.PATH = EffectArray.join([join(launcher, '..'), '/usr/bin', '/bin'], delimiter);

      await runEffect(
        runMcpInstall(testRuntime, agent, {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
      );

      const calls = await readFile(callsPath, 'utf8');
      expect(calls, agent).toContain('mcp remove --scope user threadnote');
      expect(calls, agent).toContain('mcp add');
      expect(calls, agent).toContain(broker);
      await rm(callsPath, {force: true});
    }
  });

  posixIt('removes Claude project scope from its recorded install directory', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-bin-'));
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-home-'));
    const projectA = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-b-'));
    temporaryDirectories.push(bin, userHome, projectA, projectB);
    const callsPath = join(tmpdir(), `threadnote-claude-project-calls-${process.pid}-${Date.now()}`);
    const launcher = await agentLauncher(
      'claude',
      EffectArray.join(
        [
          'if [ "$1" = "--version" ]; then printf \'%s\\n\' \'claude 1\'; exit 0; fi',
          `printf '%s|%s\\n' "$PWD" "$*" >> ${shellLiteral(callsPath)}`,
          'if [ "$1 $2" = "mcp get" ]; then exit 1; fi',
          'exit 0',
        ],
        '\n',
      ),
    );
    const system = await runEffect(SystemInfo);
    const pathValue = EffectArray.join([join(launcher, '..'), '/usr/bin', '/bin'], delimiter);
    const environment = {
      ...system.environment(),
      PATH: pathValue,
      THREADNOTE_BIN_DIR: bin,
      THREADNOTE_CALLER_CWD: projectA,
    };
    const installSystem = SystemInfo.of({
      ...system,
      environment: () => environment,
      homeDirectory: userHome,
    });
    const testRuntime = runtime(join(userHome, '.threadnote'));

    await runEffect(
      runMcpInstall(testRuntime, 'claude', {
        apply: true,
        name: 'team-memory',
        scope: 'project',
      }).pipe(Effect.provideService(SystemInfo, installSystem)),
    );
    const receipt = await runEffect(readAgentIntegrationRegistry(testRuntime));
    expect(receipt?.hosts.claude?.mcp).toMatchObject({
      cwd: projectA,
      name: 'team-memory',
      repair: true,
      scope: 'project',
    });
    await writeFile(callsPath, '');
    const projectBSystem = SystemInfo.of({
      ...installSystem,
      environment: () => ({...environment, THREADNOTE_CALLER_CWD: projectB}),
    });
    await runEffect(
      repairRegisteredMcpClients(testRuntime, receipt, ['claude'], false).pipe(
        Effect.provideService(SystemInfo, projectBSystem),
      ),
    );
    const repairCalls = await readFile(callsPath, 'utf8');
    expect(repairCalls).toContain(`${projectA}|mcp get team-memory`);
    expect(repairCalls).toContain(`${projectA}|mcp remove --scope project team-memory`);
    expect(repairCalls).toContain(`${projectA}|mcp add --scope project team-memory`);
    expect((await runEffect(readAgentIntegrationRegistry(testRuntime)))?.hosts.claude?.mcp.cwd).toBe(projectA);
    await writeFile(callsPath, '');

    await runEffect(
      runUninstall(testRuntime, {preserveMemories: true}).pipe(Effect.provideService(SystemInfo, projectBSystem)),
    );

    expect(await readFile(callsPath, 'utf8')).toContain(`${projectA}|mcp remove --scope project team-memory`);
    expect(await runEffect(readAgentIntegrationRegistry(testRuntime))).toBeUndefined();
    await rm(callsPath, {force: true});
  });

  posixIt('uses a healthy later PATH entry when the first Codex launcher is stale', async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-agent-home-'));
    temporaryDirectories.push(userHome);
    const system = await runEffect(SystemInfo);
    const testSystem = SystemInfo.of({
      ...system,
      environment: () => ({...system.environment(), CODEX_HOME: join(userHome, '.codex')}),
      homeDirectory: userHome,
    });
    const testRuntime = runtime(join(userHome, '.threadnote'));
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    const callsPath = join(tmpdir(), `threadnote-codex-calls-${process.pid}-${Date.now()}`);
    const healthy = await codexLauncher(
      `printf '%s\\n' "$*" >> "${callsPath}"\nif [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\nexit 1`,
    );
    process.env.PATH = EffectArray.join([join(broken, '..'), join(healthy, '..')], delimiter);

    await runEffect(
      runMcpInstall(testRuntime, 'codex', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
    );

    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('--version');
    expect(calls).not.toContain('mcp remove');
    expect(await readFile(join(userHome, '.codex/config.toml'), 'utf8')).toContain(
      `THREADNOTE_HOME = ${JSON.stringify(testRuntime.agentContextHome)}`,
    );
    await rm(callsPath, {force: true});
  });

  posixIt('skips a broken Codex launcher during repair and gives explicit installs an actionable error', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    process.env.PATH = EffectArray.join([join(broken, '..'), '/usr/bin', '/bin'], delimiter);

    const resolution = await resolveMcpClients('codex', 'repair').pipe(captureConsole, runEffect);
    expect(resolution.value).toEqual([]);
    expect(resolution.output).toMatch(/codex command.*not working/i);
    const root = await mkdtemp(join(tmpdir(), 'threadnote-broken-codex-'));
    temporaryDirectories.push(root);
    const config = runtime(join(root, 'home'));
    await expect(runEffect(runMcpInstall(config, 'codex', {apply: true}))).rejects.toThrow(
      /repair or reinstall codex.*threadnote mcp-install codex --apply/i,
    );
  });
});
