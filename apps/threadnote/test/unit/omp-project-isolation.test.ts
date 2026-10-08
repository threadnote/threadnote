import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, FileSystem, Path, Exit} from 'effect';
import {Command} from 'effect/cli';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {installAgentIntegration, readAgentIntegrationRegistry} from '@threadnote/threadnote/agent_integration/index';
import {runMcpInstall} from '@threadnote/threadnote/mcp/install';
import {repairRegisteredMcpClients, runUninstall} from '@threadnote/threadnote/lifecycle';
import {normalizeCliArguments, threadnoteCommand} from '@threadnote/threadnote/effect/cli';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {runSetupWith, type SetupOrchestratorDependencies} from '@threadnote/threadnote/setup/index';
import {USER_INSTRUCTIONS_START_MARKER, USER_INSTRUCTIONS_END_MARKER} from '@threadnote/threadnote/constants';
import {provideTestLayer} from '../helpers/effect-layer.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

function runtime(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'test-user',
  };
}

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-project-isolation-'});
  const user = path.join(root, 'user');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(project, {recursive: true});
  yield* runCommandEffect('git', ['init', '--quiet', project]);
  const testSystem = SystemInfo.of({
    ...system,
    homeDirectory: user,
    currentDirectory: () => project,
    environment: () => ({
      PATH: path.join(root, 'bin'),
      THREADNOTE_BIN_DIR: path.join(root, 'bin'),
      OMP_PROFILE: 'release-candidate',
    }),
  });
  return {fs, path, root, user, project, home, testSystem};
});

const snapshot = (root: string): Effect.Effect<Record<string, string>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(root))) return {};
    const result: Record<string, string> = {};
    for (const name of (yield* fs.readDirectory(root)).sort()) {
      const file = path.join(root, name);
      if ((yield* fs.stat(file)).type === 'Directory') {
        for (const [child, content] of Object.entries(yield* snapshot(file))) result[`${name}/${child}`] = content;
      } else result[name] = yield* fs.readFileString(file);
    }
    return result;
  });

describe('OMP project isolation', () => {
  effectIt.effect('CLI refuses isolated setup without creating the fallback manifest', () =>
    Effect.gen(function* () {
      const {home, project, testSystem, root} = yield* fixture;
      const before = yield* snapshot(root);
      const result = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})(
          normalizeCliArguments(['setup', 'omp', '--home', home, '--cwd', project, '--scope', 'user', '--apply']),
        ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.exit),
      );
      expect(Exit.isFailure(result.value)).toBe(true);
      if (Exit.isFailure(result.value))
        expect(Cause.squash(result.value.cause)).toMatchObject({
          _tag: 'SetupOperationError',
          message: expect.stringContaining('isolated'),
        });
      expect(yield* snapshot(root)).toEqual(before);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses isolated user setup before invoking any setup mutation or creating a receipt', () =>
    Effect.gen(function* () {
      const {home, project, testSystem, root} = yield* fixture;
      let calls = 0;
      const operation = () =>
        Effect.sync(() => {
          calls += 1;
          return {status: 'verified' as const};
        });
      const dependencies: SetupOrchestratorDependencies<never> = {
        contextBrief: operation,
        doctor: operation,
        ensureCore: operation,
        ensureHooks: operation,
        ensureManifest: operation,
        ensureSurface: operation,
        indexGraph: operation,
        inspectReversible: operation,
        removeSurface: operation,
        removeHooks: operation,
        seedProject: operation,
      };
      const before = yield* snapshot(root);
      const result = yield* runSetupWith(
        runtime(home),
        getAgentAdapter('omp-agent')!,
        {apply: true, cwd: project, scope: 'user'},
        dependencies,
      ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: 'SetupOperationError',
          message: expect.stringContaining('isolated'),
        });
      expect(calls).toBe(0);
      expect(yield* snapshot(root)).toEqual(before);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'keeps an existing personal OMP registration and hook untouched while writing project configuration',
    () =>
      Effect.gen(function* () {
        const {fs, path, user, project, home, testSystem} = yield* fixture;
        const config = runtime(home);
        yield* installAgentIntegration(config, 'omp', {dryRun: false, name: 'threadnote', toolset: 'core'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const personalRoot = path.join(user, '.omp', 'profiles', 'release-candidate', 'agent');
        yield* fs.makeDirectory(path.join(personalRoot, 'hooks', 'pre'), {recursive: true});
        yield* fs.writeFileString(
          path.join(personalRoot, 'hooks', 'pre', 'threadnote.ts'),
          '// Preserve this personal hook.\n',
        );
        yield* fs.writeFileString(
          path.join(personalRoot, 'mcp.json'),
          '{"mcpServers":{"threadnote":{"command":"threadnote"}}}\n',
        );
        const before = yield* snapshot(user);
        yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(yield* snapshot(user)).toEqual(before);
        expect(yield* fs.exists(path.join(project, '.omp', 'mcp.json'))).toBe(true);
        expect(yield* fs.exists(path.join(project, '.omp', 'AGENTS.md'))).toBe(true);
        expect(yield* fs.exists(path.join(project, '.omp', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs and uninstalls a relative project target from a different invocation directory', () =>
    Effect.gen(function* () {
      const {fs, path, root, user, project, home, testSystem} = yield* fixture;
      const other = path.join(root, 'other');
      yield* fs.makeDirectory(path.join(other, 'project'), {recursive: true});
      yield* fs.writeFileString(path.join(other, 'project', 'keep.txt'), 'Unrelated project.\n');
      const at =
        (cwd: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(SystemInfo, SystemInfo.of({...testSystem, currentDirectory: () => cwd})),
            Effect.provideService(
              Path.Path,
              Path.Path.of({...path, resolve: (...parts) => path.resolve(cwd, ...parts)}),
            ),
          );
      const config = runtime(home);
      const userBefore = yield* snapshot(user);
      const otherBefore = yield* snapshot(other);
      yield* runMcpInstall(config, 'omp', {apply: true, project: 'project'}).pipe(at(root));
      const registry = yield* readAgentIntegrationRegistry(config);
      expect(registry?.hosts.omp?.mcp.cwd).toBe(project);
      const configPath = path.join(project, '.omp', 'mcp.json');
      const drifted = JSON.parse(yield* fs.readFileString(configPath));
      drifted.mcpServers.threadnote.command = 'stale-command';
      drifted.unrelated = {keep: true};
      yield* fs.writeFileString(configPath, JSON.stringify(drifted));
      yield* repairRegisteredMcpClients(config, registry, ['omp'], false).pipe(at(other));
      const repaired = JSON.parse(yield* fs.readFileString(configPath));
      expect(repaired.mcpServers.threadnote.command).not.toBe('stale-command');
      expect(repaired.unrelated).toEqual({keep: true});
      expect((yield* readAgentIntegrationRegistry(config))?.hosts.omp?.mcp.cwd).toBe(project);
      yield* runUninstall(config, {preserveMemories: true}).pipe(at(other));
      const removed = JSON.parse(yield* fs.readFileString(configPath));
      expect(removed.mcpServers.threadnote).toBeUndefined();
      expect(removed.unrelated).toEqual({keep: true});
      expect(yield* readAgentIntegrationRegistry(config)).toBeUndefined();
      expect(yield* fs.exists(path.join(project, '.omp', 'AGENTS.md'))).toBe(false);
      expect(yield* snapshot(user)).toEqual(userBefore);
      expect(yield* snapshot(other)).toEqual(otherBefore);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const apply of [false, true]) {
    effectIt.effect(`retargets managed project artifacts without changing unrelated files (apply=${apply})`, () =>
      Effect.gen(function* () {
        const {fs, path, root, user, project, home, testSystem} = yield* fixture;
        const config = runtime(home);
        const nextProject = path.join(root, 'next-project');
        const previousRoot = path.join(project, '.omp');
        yield* fs.makeDirectory(nextProject, {recursive: true});
        yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpPath = path.join(previousRoot, 'mcp.json');
        const previousMcp = JSON.parse(yield* fs.readFileString(mcpPath));
        previousMcp.mcpServers.other = {command: 'keep-other-server'};
        previousMcp.mcpServers.retargeted = {command: 'keep-unrelated-name-collision'};
        yield* fs.writeFileString(mcpPath, JSON.stringify(previousMcp));
        const instructions = path.join(previousRoot, 'AGENTS.md');
        yield* fs.writeFileString(
          instructions,
          `Keep project instructions.\n${yield* fs.readFileString(instructions)}`,
        );
        const hook = path.join(previousRoot, 'hooks', 'pre', 'threadnote.ts');
        yield* fs.makeDirectory(path.dirname(hook), {recursive: true});
        yield* fs.writeFileString(hook, '// Keep project hook.\n');
        const customSkill = path.join(previousRoot, 'skills', 'custom', 'SKILL.md');
        yield* fs.makeDirectory(path.dirname(customSkill), {recursive: true});
        yield* fs.writeFileString(customSkill, 'Keep custom skill.\n');
        const before = yield* snapshot(root);
        const userBefore = yield* snapshot(user);
        yield* runMcpInstall(config, 'omp', {apply, project: nextProject, name: 'retargeted'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        if (!apply) {
          expect(yield* snapshot(root)).toEqual(before);
          return;
        }
        expect({
          managedMcp: JSON.parse(yield* fs.readFileString(mcpPath)).mcpServers.threadnote !== undefined,
          managedGuidance: (yield* fs.readFileString(instructions)).includes(USER_INSTRUCTIONS_START_MARKER),
          managedSkill: yield* fs.exists(path.join(previousRoot, 'skills', 'threadnote-context', 'SKILL.md')),
        }).toEqual({managedMcp: false, managedGuidance: false, managedSkill: false});
        expect(JSON.parse(yield* fs.readFileString(mcpPath)).mcpServers.other).toEqual(previousMcp.mcpServers.other);
        expect(JSON.parse(yield* fs.readFileString(mcpPath)).mcpServers.retargeted).toEqual(
          previousMcp.mcpServers.retargeted,
        );
        expect(yield* fs.readFileString(instructions)).toContain('Keep project instructions.');
        expect(yield* fs.readFileString(hook)).toBe('// Keep project hook.\n');
        expect(yield* fs.readFileString(customSkill)).toBe('Keep custom skill.\n');
        expect(yield* fs.exists(path.join(nextProject, '.omp', 'mcp.json'))).toBe(true);
        expect(yield* fs.exists(path.join(nextProject, '.omp', 'AGENTS.md'))).toBe(true);
        expect(yield* fs.exists(path.join(nextProject, '.omp', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(true);
        expect((yield* readAgentIntegrationRegistry(config))?.hosts.omp?.mcp.cwd).toBe(nextProject);
        expect((yield* readAgentIntegrationRegistry(config))?.hosts.omp?.mcp.name).toBe('retargeted');
        expect(yield* snapshot(user)).toEqual(userBefore);
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('upgrades a legacy project receipt without removing its new MCP entry or personal artifacts', () =>
    Effect.gen(function* () {
      const {fs, path, user, project, home, testSystem} = yield* fixture;
      const config = runtime(home);
      yield* installAgentIntegration(config, 'omp', {dryRun: false, name: 'threadnote', toolset: 'core'}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      const registryPath = path.join(home, 'integrations', 'agents.json');
      const legacy = JSON.parse(yield* fs.readFileString(registryPath));
      legacy.hosts.omp.mcp.cwd = project;
      yield* fs.writeFileString(registryPath, JSON.stringify(legacy));
      yield* fs.makeDirectory(path.join(project, '.omp'), {recursive: true});
      yield* fs.writeFileString(
        path.join(project, '.omp', 'mcp.json'),
        '{"mcpServers":{"threadnote":{"command":"stale-command"}}}\n',
      );
      const userBefore = yield* snapshot(user);
      yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(
        JSON.parse(yield* fs.readFileString(path.join(project, '.omp', 'mcp.json'))).mcpServers.threadnote,
      ).toBeDefined();
      expect((yield* readAgentIntegrationRegistry(config))?.hosts.omp?.mcp.hostRoot).toBe(path.join(project, '.omp'));
      expect(yield* snapshot(user)).toEqual(userBefore);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const apply of [false, true]) {
    effectIt.effect(
      `refuses retargeting unreadable previous MCP without changing its receipt or artifacts (apply=${apply})`,
      () =>
        Effect.gen(function* () {
          const {fs, path, root, project, home, testSystem} = yield* fixture;
          const config = runtime(home);
          yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          yield* fs.writeFileString(path.join(project, '.omp', 'mcp.json'), '{malformed');
          const nextProject = path.join(root, 'next-project');
          yield* fs.makeDirectory(nextProject, {recursive: true});
          const before = yield* snapshot(root);
          const result = yield* runMcpInstall(config, 'omp', {apply, project: nextProject}).pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.exit,
          );
          expect(Exit.isFailure(result)).toBe(true);
          expect(yield* snapshot(root)).toEqual(before);
        }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('refuses relocation from a legacy relative receipt instead of guessing its original directory', () =>
    Effect.gen(function* () {
      const {fs, path, root, project, home, testSystem} = yield* fixture;
      const config = runtime(home);
      const isolatedPath = Path.Path.of({...path, resolve: (...parts) => path.resolve(root, ...parts)});
      yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.provideService(Path.Path, isolatedPath),
      );
      const registryPath = path.join(home, 'integrations', 'agents.json');
      const legacy = JSON.parse(yield* fs.readFileString(registryPath));
      legacy.hosts.omp.mcp.cwd = 'project';
      yield* fs.writeFileString(registryPath, JSON.stringify(legacy));
      const nextProject = path.join(root, 'next-project');
      yield* fs.makeDirectory(nextProject, {recursive: true});
      const before = yield* snapshot(root);
      const result = yield* runMcpInstall(config, 'omp', {apply: true, project: nextProject}).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.provideService(Path.Path, isolatedPath),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* snapshot(root)).toEqual(before);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'retargeting leaves managed artifacts only in the current project and preserves other content',
    {targets: fc.array(fc.integer({min: 1, max: 2}), {minLength: 1, maxLength: 3})},
    ({targets}) =>
      Effect.gen(function* () {
        const {fs, path, root, user, home, testSystem} = yield* fixture;
        const config = runtime(home);
        const projects = [0, 1, 2].map(index => path.join(root, `target-${index}`));
        for (const project of projects) {
          yield* fs.makeDirectory(path.join(project, '.omp'), {recursive: true});
          yield* fs.writeFileString(
            path.join(project, '.omp', 'mcp.json'),
            '{"mcpServers":{"other":{"command":"keep-other-server"}}}\n',
          );
          yield* fs.writeFileString(path.join(project, '.omp', 'AGENTS.md'), 'Keep project instructions.\n');
        }
        const userBefore = yield* snapshot(user);
        const visited = new Set<number>();
        for (const target of [0, ...targets]) {
          const project = projects[target];
          const name = `managed-${target}`;
          yield* runMcpInstall(config, 'omp', {apply: true, project, name}).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          visited.add(target);
          expect((yield* readAgentIntegrationRegistry(config))?.hosts.omp?.mcp.cwd).toBe(project);
          for (const index of visited) {
            const host = path.join(projects[index], '.omp');
            const mcp = JSON.parse(yield* fs.readFileString(path.join(host, 'mcp.json')));
            expect(Object.keys(mcp.mcpServers).sort()).toEqual(index === target ? [name, 'other'] : ['other']);
            expect(mcp.mcpServers.other).toEqual({command: 'keep-other-server'});
            const guidance = yield* fs.readFileString(path.join(host, 'AGENTS.md'));
            expect(guidance.includes(USER_INSTRUCTIONS_START_MARKER)).toBe(index === target);
            expect(guidance).toContain('Keep project instructions.');
            expect(yield* fs.exists(path.join(host, 'skills', 'threadnote-context', 'SKILL.md'))).toBe(
              index === target,
            );
          }
          expect(yield* snapshot(user)).toEqual(userBefore);
        }
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 8}},
  );

  fcEffectProp(
    effectIt,
    'project installation preserves every global host file across profiles and repeated applies',
    {
      note: fc.string({maxLength: 40}),
      profile: fc.constantFrom('release-candidate', 'other-profile', ' profile with spaces '),
    },
    ({note, profile}) =>
      Effect.gen(function* () {
        const {fs, path, user, project, home, testSystem} = yield* fixture;
        const legacyBlock = `${USER_INSTRUCTIONS_START_MARKER}\nLegacy Threadnote instructions.\n${USER_INSTRUCTIONS_END_MARKER}`;
        const globalFiles = {
          '.cursor/rules/threadnote.mdc': `Keep Cursor.\n${legacyBlock}\n${note}`,
          '.copilot/instructions/threadnote.instructions.md': `Keep Copilot.\n${legacyBlock}\n${note}`,
          '.codex/AGENTS.md': `Keep Codex.\n${legacyBlock}\n${note}`,
          '.codex/config.toml': '[mcp_servers.threadnote]\ncommand = "threadnote"\nargs = ["mcp"]\n',
          '.omp/profiles/release-candidate/agent/AGENTS.md': `Keep OMP.\n${legacyBlock}\n${note}`,
          '.omp/profiles/release-candidate/agent/hooks/pre/threadnote.ts': `// Existing managed hook\n${note}`,
        };
        for (const [relative, content] of Object.entries(globalFiles)) {
          const file = path.join(user, relative);
          yield* fs.makeDirectory(path.dirname(file), {recursive: true});
          yield* fs.writeFileString(file, content);
        }
        const before = yield* snapshot(user);
        const config = runtime(home);
        yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(yield* snapshot(user)).toEqual(before);
        const registry = yield* readAgentIntegrationRegistry(config);
        expect(Object.keys(registry?.hosts ?? {})).toEqual(['omp']);
        expect(registry?.hosts.omp?.mcp.hostRoot).toBe(path.join(project, '.omp'));
        expect(
          Object.keys(registry?.hosts.omp?.artifacts ?? {}).every(file => file.startsWith(`${project}${path.sep}`)),
        ).toBe(true);
        const projectBefore = yield* snapshot(project);
        yield* runMcpInstall(config, 'omp', {apply: true, project}).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...testSystem,
              environment: () => ({...testSystem.environment(), OMP_PROFILE: profile}),
            }),
          ),
        );
        expect(yield* snapshot(user)).toEqual(before);
        expect(yield* snapshot(project)).toEqual(projectBefore);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}},
  );
});
