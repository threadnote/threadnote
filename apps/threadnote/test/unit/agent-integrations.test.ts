import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  agentIntegrationDoctorChecks,
  installAgentIntegration,
  installCursorCloudAgentIntegration,
  migrateLegacyAgentIntegrations,
  readAgentIntegrationRegistry,
  removeAgentIntegrations,
  repairAgentIntegrations,
} from '@threadnote/threadnote/agent_integration/index';
import {repairableAgentClients, writeAgentIntegrationRegistry} from '@threadnote/threadnote/agent_integration/registry';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '@threadnote/threadnote/constants';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import type {AgentClient} from '@threadnote/threadnote/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {withoutOmpPathSelectors} from '@threadnote/testing/omp-environment';

const agents = ['codex', 'claude', 'cursor', 'copilot', 'omp'] as const;

function config(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'tester',
  };
}

describe('agent integrations', () => {
  effectIt.effect('uses the active OMP agent root for instructions and skills', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-profile-'});
        const userHome = path.join(root, 'user');
        const profileRoot = path.join(userHome, '.omp', 'profiles', 'work', 'agent');
        const overriddenRoot = path.join(root, 'overridden-agent');
        const threadnoteHome = path.join(root, 'shared-threadnote');
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({
            ...withoutOmpPathSelectors(system.environment()),
            OMP_PROFILE: 'work',
            PI_CODING_AGENT_DIR: overriddenRoot,
            PI_PROFILE: 'ignored',
          }),
          homeDirectory: userHome,
        });

        yield* installAgentIntegration(config(threadnoteHome), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(yield* fs.readFileString(path.join(profileRoot, 'AGENTS.md'))).toContain(
          '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
        );
        expect(yield* fs.exists(path.join(profileRoot, 'skills', 'threadnote-context', 'SKILL.md'))).toBe(true);
        expect(yield* fs.exists(path.join(overriddenRoot, 'AGENTS.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses PI_CODING_AGENT_DIR when no OMP profile is active', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-agent-dir-'});
        const userHome = path.join(root, 'user');
        const agentRoot = path.join(root, 'active-agent');
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...withoutOmpPathSelectors(system.environment()), PI_CODING_AGENT_DIR: agentRoot}),
          homeDirectory: userHome,
        });

        yield* installAgentIntegration(config(path.join(root, 'shared-threadnote')), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(yield* fs.exists(path.join(agentRoot, 'AGENTS.md'))).toBe(true);
        expect(yield* fs.exists(path.join(userHome, '.omp', 'agent', 'AGENTS.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses PI_PROFILE when OMP_PROFILE is absent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-pi-profile-'});
        const userHome = path.join(root, 'user');
        const profileRoot = path.join(userHome, '.omp', 'profiles', 'pi-work', 'agent');
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...withoutOmpPathSelectors(system.environment()), PI_PROFILE: 'pi-work'}),
          homeDirectory: userHome,
        });

        yield* installAgentIntegration(config(path.join(root, 'shared-threadnote')), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(yield* fs.exists(path.join(profileRoot, 'AGENTS.md'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('moves managed artifacts when a relocatable host root changes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-profile-move-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(root, 'shared-threadnote');
        const profileRoot = (profile: string) => path.join(userHome, '.omp', 'profiles', profile, 'agent');
        const testSystem = (profile: string) =>
          SystemInfo.of({
            ...system,
            environment: () => ({...withoutOmpPathSelectors(system.environment()), OMP_PROFILE: profile}),
            homeDirectory: userHome,
          });

        yield* installAgentIntegration(config(threadnoteHome), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem('first')));
        yield* installAgentIntegration(config(threadnoteHome), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem('second')));

        expect(yield* fs.exists(path.join(profileRoot('first'), 'AGENTS.md'))).toBe(false);
        expect(yield* fs.exists(path.join(profileRoot('first'), 'skills', 'threadnote-context', 'SKILL.md'))).toBe(
          false,
        );
        expect(yield* fs.exists(path.join(profileRoot('second'), 'AGENTS.md'))).toBe(true);
        expect(yield* fs.exists(path.join(profileRoot('second'), 'skills', 'threadnote-context', 'SKILL.md'))).toBe(
          true,
        );
        expect((yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts.omp?.mcp.hostRoot).toBe(
          profileRoot('second'),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes older generated skill content while relocating a host root', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-omp-old-skill-move-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(root, 'shared-threadnote');
        const profileRoot = (profile: string) => path.join(userHome, '.omp', 'profiles', profile, 'agent');
        const skillPath = (profile: string) =>
          path.join(profileRoot(profile), 'skills', 'threadnote-context', 'SKILL.md');
        const testSystem = (profile: string) =>
          SystemInfo.of({
            ...system,
            environment: () => ({...withoutOmpPathSelectors(system.environment()), OMP_PROFILE: profile}),
            homeDirectory: userHome,
          });

        yield* installAgentIntegration(config(threadnoteHome), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem('first')));
        const olderGeneratedSkill = (yield* fs.readFileString(skillPath('first'))).replace(
          USER_INSTRUCTIONS_START_MARKER,
          `${USER_INSTRUCTIONS_START_MARKER}\nLegacy generated content from an older Threadnote release.`,
        );
        yield* fs.writeFileString(skillPath('first'), olderGeneratedSkill);

        yield* installAgentIntegration(config(threadnoteHome), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem('second')));
        expect(yield* fs.exists(skillPath('first'))).toBe(false);

        yield* installAgentIntegration(config(threadnoteHome), 'omp', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem('first')));
        expect(yield* fs.readFileString(skillPath('first'))).toContain(USER_INSTRUCTIONS_START_MARKER);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('registers one selected host with its bootstrap and skills', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-integration-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* installAgentIntegration(config(threadnoteHome), 'cursor', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        const registry = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(Object.keys(registry?.hosts ?? {})).toEqual(['cursor']);
        expect(registry?.hosts.cursor).toMatchObject({
          mcp: {name: 'threadnote', toolset: 'core'},
          status: 'current',
        });
        const cursorRule = yield* fs.readFileString(path.join(userHome, '.cursor', 'rules', 'threadnote.mdc'));
        expect(cursorRule).toContain('alwaysApply: true');
        expect(cursorRule).toContain('Route non-trivial work by situation');
        for (const skill of ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory', 'threadnote-health']) {
          const installedSkill = yield* fs.readFileString(path.join(userHome, '.cursor', 'skills', skill, 'SKILL.md'));
          expect(installedSkill).toContain(`name: ${skill}`);
          if (skill === 'threadnote-memory') {
            expect(installedSkill).toContain('`citationPolicy: "defer"`');
          }
        }
        expect(yield* fs.exists(path.join(userHome, '.codex', 'AGENTS.md'))).toBe(false);
        expect(yield* fs.exists(path.join(userHome, '.claude', 'CLAUDE.md'))).toBe(false);
        expect(yield* fs.exists(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md'))).toBe(
          false,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('writes each host bundle to its documented personal locations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-targets-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        for (const agent of agents) {
          yield* installAgentIntegration(config(threadnoteHome), agent, {
            dryRun: false,
            name: 'threadnote',
            scope: agent === 'claude' ? 'user' : undefined,
            toolset: 'core',
          }).pipe(Effect.provideService(SystemInfo, testSystem));
        }

        expect(yield* fs.readFileString(path.join(userHome, '.codex', 'AGENTS.md'))).toContain(
          'Route non-trivial work by situation',
        );
        expect(yield* fs.readFileString(path.join(userHome, '.claude', 'CLAUDE.md'))).toContain(
          'Route non-trivial work by situation',
        );
        expect(yield* fs.readFileString(path.join(userHome, '.cursor', 'rules', 'threadnote.mdc'))).toContain(
          'alwaysApply: true',
        );
        expect(
          yield* fs.readFileString(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md')),
        ).toContain('applyTo: "**"');
        expect(yield* fs.readFileString(path.join(userHome, '.omp', 'agent', 'AGENTS.md'))).toContain(
          'Route non-trivial work by situation',
        );
        expect(yield* fs.exists(path.join(userHome, '.agents', 'AGENTS.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes concurrent host registration without losing receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-concurrent-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* Effect.all(
          agents.map(agent =>
            installAgentIntegration(config(threadnoteHome), agent, {
              dryRun: false,
              name: `threadnote-${agent}`,
              scope: agent === 'claude' ? 'project' : undefined,
              toolset: 'full',
            }).pipe(Effect.provideService(SystemInfo, testSystem)),
          ),
          {concurrency: 'unbounded'},
        ).pipe(TestClock.withLive);

        const registry = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(Object.keys(registry?.hosts ?? {}).sort()).toEqual([...agents].sort());
        for (const agent of agents) {
          expect(registry?.hosts[agent]).toMatchObject({
            mcp: {name: `threadnote-${agent}`, repair: true, toolset: 'full'},
            status: 'current',
          });
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('migrates only inferred MCP hosts and preserves unrelated instruction content', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-migration-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const codexInstructions = path.join(userHome, '.codex', 'AGENTS.md');
        const claudeInstructions = path.join(userHome, '.claude', 'CLAUDE.md');
        const legacyBlock = `${USER_INSTRUCTIONS_START_MARKER}\nLegacy dense instructions.\n${USER_INSTRUCTIONS_END_MARKER}`;
        yield* fs.makeDirectory(path.dirname(codexInstructions), {recursive: true});
        yield* fs.makeDirectory(path.dirname(claudeInstructions), {recursive: true});
        yield* fs.writeFileString(codexInstructions, `Keep this Codex note.\n\n${legacyBlock}\n`);
        yield* fs.writeFileString(claudeInstructions, `Keep this Claude note.\n\n${legacyBlock}\n`);
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* migrateLegacyAgentIntegrations(config(threadnoteHome), ['claude'], false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(yield* fs.readFileString(codexInstructions)).toBe('Keep this Codex note.\n');
        const migratedClaude = yield* fs.readFileString(claudeInstructions);
        expect(migratedClaude).toContain('Keep this Claude note.');
        expect(migratedClaude).toContain('Route non-trivial work by situation');
        expect(Object.keys((yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts ?? {})).toEqual([
          'claude',
        ]);
        const receipt = (yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts.claude;
        expect(receipt?.mcp).toEqual({name: 'threadnote', repair: false});
        expect(repairableAgentClients(yield* readAgentIntegrationRegistry(config(threadnoteHome)))).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('records every inferred host as pending before migration writes artifacts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-pending-migration-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const conflictingSkill = path.join(userHome, '.agents', 'skills', 'threadnote-context', 'SKILL.md');
        yield* fs.makeDirectory(path.dirname(conflictingSkill), {recursive: true});
        yield* fs.writeFileString(conflictingSkill, 'User-owned skill.\n');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        const migration = yield* migrateLegacyAgentIntegrations(
          config(threadnoteHome),
          ['codex', 'claude'],
          false,
        ).pipe(Effect.provideService(SystemInfo, testSystem), Effect.exit);
        expect(migration._tag).toBe('Failure');
        const pending = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(Object.keys(pending?.hosts ?? {})).toEqual(['codex', 'claude']);
        expect(pending?.hosts.codex?.status).toBe('pending');
        expect(pending?.hosts.claude?.status).toBe('pending');

        yield* fs.remove(conflictingSkill);
        yield* repairAgentIntegrations(config(threadnoteHome), false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const repaired = yield* readAgentIntegrationRegistry(config(threadnoteHome));
        expect(repaired?.hosts.codex?.status).toBe('current');
        expect(repaired?.hosts.claude?.status).toBe('current');
        expect(repairableAgentClients(repaired)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves unrelated Cursor rule text while migrating its managed block', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-cursor-preserve-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const cursorRule = path.join(userHome, '.cursor', 'rules', 'threadnote.mdc');
        yield* fs.makeDirectory(path.dirname(cursorRule), {recursive: true});
        yield* fs.writeFileString(
          cursorRule,
          [
            '---',
            'description: User-maintained Cursor rule',
            'alwaysApply: true',
            '---',
            '',
            'Keep this user preface.',
            '',
            USER_INSTRUCTIONS_START_MARKER,
            'Legacy dense instructions.',
            USER_INSTRUCTIONS_END_MARKER,
            '',
            'Keep this user appendix.',
            '',
          ].join('\n'),
        );
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* migrateLegacyAgentIntegrations(config(threadnoteHome), ['cursor'], false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        const migrated = yield* fs.readFileString(cursorRule);
        expect(migrated).toContain('description: User-maintained Cursor rule');
        expect(migrated).toContain('Keep this user preface.');
        expect(migrated).toContain('Keep this user appendix.');
        expect(migrated).toContain('Route non-trivial work by situation');
        expect(migrated).not.toContain('Legacy dense instructions.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses an installed Cursor Marketplace rule without adding a duplicate user rule', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-cursor-plugin-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const pluginRoot = path.join(userHome, '.cursor', 'plugins', 'cache', 'threadnote', '1.1.0');
        const directRule = path.join(userHome, '.cursor', 'rules', 'threadnote.mdc');
        yield* fs.copy(path.join(process.cwd(), 'cursor-plugin'), pluginRoot, {overwrite: true});
        yield* fs.makeDirectory(path.dirname(directRule), {recursive: true});
        yield* fs.writeFileString(
          directRule,
          `Keep this note.\n\n${USER_INSTRUCTIONS_START_MARKER}\nDuplicate.\n${USER_INSTRUCTIONS_END_MARKER}\n`,
        );
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* installAgentIntegration(config(threadnoteHome), 'cursor', {
          dryRun: false,
          name: 'threadnote',
          toolset: 'core',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(yield* fs.readFileString(directRule)).toBe('Keep this note.\n');
        const receipt = (yield* readAgentIntegrationRegistry(config(threadnoteHome)))?.hosts.cursor;
        expect(Object.keys(receipt?.artifacts ?? {})).not.toContain(directRule);
        expect(Object.keys(receipt?.artifacts ?? {})).toHaveLength(4);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('plans removal without mutation, then removes only managed artifacts and its receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-removal-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const instructions = path.join(userHome, '.codex', 'AGENTS.md');
        const skill = path.join(userHome, '.agents', 'skills', 'threadnote-context', 'SKILL.md');
        yield* fs.makeDirectory(path.dirname(instructions), {recursive: true});
        yield* fs.writeFileString(instructions, 'Keep this user instruction.\n');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
        yield* installAgentIntegration(config(threadnoteHome), 'codex', {
          dryRun: false,
          name: 'custom-threadnote',
          toolset: 'full',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        const installedInstructions = yield* fs.readFileString(instructions);

        yield* removeAgentIntegrations(config(threadnoteHome), true).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.readFileString(instructions)).toBe(installedInstructions);
        expect(yield* fs.exists(skill)).toBe(true);
        expect(yield* readAgentIntegrationRegistry(config(threadnoteHome))).toBeDefined();

        yield* removeAgentIntegrations(config(threadnoteHome), false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.readFileString(instructions)).toBe('Keep this user instruction.\n');
        expect(yield* fs.exists(skill)).toBe(false);
        expect(yield* readAgentIntegrationRegistry(config(threadnoteHome))).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes an obsolete Personal Cursor Cloud graph skill recorded by a prior release', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-cloud-upgrade-removal-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const graphSkill = path.join(userHome, '.cursor', 'skills', 'threadnote-code-graph', 'SKILL.md');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        yield* installCursorCloudAgentIntegration(config(threadnoteHome), false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.makeDirectory(path.dirname(graphSkill), {recursive: true});
        yield* fs.writeFileString(
          graphSkill,
          yield* fs.readFileString(
            path.join(process.cwd(), 'config', 'agent-skills', 'threadnote-code-graph', 'SKILL.md'),
          ),
        );
        const registry = (yield* readAgentIntegrationRegistry(config(threadnoteHome)))!;
        const cursor = registry.hosts.cursor!;
        yield* writeAgentIntegrationRegistry(config(threadnoteHome), {
          ...registry,
          hosts: {
            ...registry.hosts,
            cursor: {
              ...cursor,
              artifacts: {...cursor.artifacts, [graphSkill]: Object.values(cursor.artifacts)[0]},
            },
          },
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        yield* removeAgentIntegrations(config(threadnoteHome), true).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.exists(graphSkill)).toBe(true);

        yield* removeAgentIntegrations(config(threadnoteHome), false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.exists(graphSkill)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'installing and removing a block round-trips bounded surrounding user content',
    {
      prefix: fc.stringMatching(/^[A-Za-z0-9._-]{1,24}$/u),
      suffix: fc.stringMatching(/^[A-Za-z0-9._-]{1,24}$/u),
    },
    ({prefix, suffix}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-roundtrip-'});
          const userHome = path.join(root, 'user');
          const threadnoteHome = path.join(userHome, '.threadnote');
          const instructions = path.join(userHome, '.codex', 'AGENTS.md');
          const original = `${prefix}\n\n${suffix}\n`;
          yield* fs.makeDirectory(path.dirname(instructions), {recursive: true});
          yield* fs.writeFileString(instructions, original);
          const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

          yield* installAgentIntegration(config(threadnoteHome), 'codex', {
            dryRun: false,
            name: 'threadnote',
            toolset: 'core',
          }).pipe(Effect.provideService(SystemInfo, testSystem));
          yield* removeAgentIntegrations(config(threadnoteHome), false).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          expect(yield* fs.readFileString(instructions)).toBe(original);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );

  fcEffectProp(
    effectIt,
    'doctor reports exactly the registered host subset',
    {selected: fc.uniqueArray(fc.constantFrom<AgentClient>(...agents), {maxLength: agents.length})},
    ({selected}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-doctor-'});
          const userHome = path.join(root, 'user');
          const threadnoteHome = path.join(userHome, '.threadnote');
          const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
          for (const agent of selected) {
            yield* installAgentIntegration(config(threadnoteHome), agent, {
              dryRun: false,
              name: 'threadnote',
              scope: agent === 'claude' ? 'user' : undefined,
              toolset: 'core',
            }).pipe(Effect.provideService(SystemInfo, testSystem));
          }

          const checks = yield* agentIntegrationDoctorChecks(config(threadnoteHome)).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          const checkedHosts = new Set(
            checks.map(check => agents.find(agent => check.name.startsWith(`${agent} `))).filter(Boolean),
          );
          expect([...checkedHosts].sort()).toEqual([...selected].sort());
          expect(checks.every(check => check.status === 'ok')).toBe(true);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}},
  );
});
