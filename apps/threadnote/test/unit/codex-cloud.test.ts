import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {
  agentIntegrationDoctorChecks,
  installCodexCloudAgentIntegration,
  readAgentIntegrationRegistry,
  removeAgentIntegrations,
  repairAgentIntegrations,
} from '@threadnote/threadnote/agent_integration/index';
import {repairableAgentClients} from '@threadnote/threadnote/agent_integration/registry';
import {removeMcpConfigs} from '@threadnote/threadnote/mcp/install';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {normalizeCodexCloudShares} from '@threadnote/threadnote/codex/profile';
import {codexCloudRuntimeConfig} from '@threadnote/threadnote/codex/cloud';
import {cursorCloudMemoryRoot, cursorCloudUriWithinScope} from '@threadnote/threadnote/cursor/cloud';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u);

describe('Codex Cloud contracts', () => {
  it('normalizes bounded shares independently of order and duplicates', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(segment, {minLength: 1, maxLength: 16}),
        fc.array(fc.nat(), {maxLength: 30}),
        (teams, duplicates) => {
          const normalized = normalizeCodexCloudShares(
            [...teams].reverse().concat(duplicates.map(index => teams[index % teams.length])),
          );
          expect(normalized).toEqual([...teams].sort());
          expect(normalizeCodexCloudShares(normalized)).toEqual(normalized);
        },
      ),
      {numRuns: 100},
    );
    expect(() => normalizeCodexCloudShares([])).toThrow('requires 1');
    expect(() => normalizeCodexCloudShares(Array.from({length: 17}, (_, index) => `team-${index}`))).toThrow('16');
  });

  it('allows descendants but excludes sibling namespaces and prefix lookalikes', () => {
    fc.assert(
      fc.property(segment, segment, segment, (user, team, topic) => {
        const root = cursorCloudMemoryRoot(user, team);
        const scope = {
          mode: 'shared-read-write' as const,
          shares: [{root, team}],
          localReadRoots: [`threadnote://user/${user}/memories/handoffs`],
        };
        expect(cursorCloudUriWithinScope(scope, `${root}/durable/${topic}.md`)).toBe(true);
        expect(cursorCloudUriWithinScope(scope, `${root}-other/durable/${topic}.md`)).toBe(false);
        expect(
          cursorCloudUriWithinScope(
            scope,
            `threadnote://user/${user}-other/memories/shared/${team}/durable/${topic}.md`,
          ),
        ).toBe(false);
        expect(cursorCloudUriWithinScope(scope, `threadnote://user/${user}/memories/durable/${topic}.md`)).toBe(false);
        expect(cursorCloudUriWithinScope(scope, `threadnote://user/${user}/memories/handoffs/active/${topic}.md`)).toBe(
          true,
        );
      }),
      {numRuns: 100},
    );
  });

  it('uses stable cloud defaults and preserves persisted identities', () => {
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: '/tmp/codex',
      agentId: 'threadnote',
      user: 'ubuntu',
      manifestPath: '/tmp/manifest.yaml',
      agentIdSource: 'system',
      userSource: 'system',
    };
    expect(codexCloudRuntimeConfig(config, {})).toMatchObject({agentId: 'codex-cloud', user: 'codex-cloud'});
    expect(
      codexCloudRuntimeConfig(
        {
          ...config,
          agentId: 'stable-agent',
          user: 'stable-user',
          agentIdSource: 'codex-cloud-profile',
          userSource: 'codex-cloud-profile',
        },
        {},
      ),
    ).toMatchObject({agentId: 'stable-agent', user: 'stable-user'});
  });
});

effectIt.effect('Codex Cloud repairs and removes CLI-only managed artifacts while preserving user guidance', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-codex-artifacts-'});
    const userHome = path.join(root, 'user');
    const codexRoot = path.join(root, 'configured-codex');
    const home = path.join(root, 'threadnote');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'codex-cloud',
      user: 'codex-cloud',
      manifestPath: path.join(home, 'manifest.yaml'),
    };
    const testSystem = SystemInfo.of({
      ...system,
      homeDirectory: userHome,
      environment: () => ({...system.environment(), CODEX_HOME: codexRoot, PATH: ''}),
    });
    const instruction = path.join(codexRoot, 'AGENTS.md');
    yield* fs.makeDirectory(codexRoot, {recursive: true});
    yield* fs.writeFileString(instruction, 'Existing personal guidance.\n');
    yield* installCodexCloudAgentIntegration(config, false).pipe(Effect.provideService(SystemInfo, testSystem));
    const receipt = (yield* readAgentIntegrationRegistry(config))!.hosts.codex!;
    expect(receipt.mcp).toMatchObject({
      artifactProfile: 'codex-cloud-personal',
      transport: 'cli',
      repair: false,
      hostRoot: codexRoot,
    });
    expect(repairableAgentClients(yield* readAgentIntegrationRegistry(config))).toEqual([]);
    const template = path.join(codexRoot, 'threadnote-start-skill.md');
    expect(yield* fs.readFileString(template)).toContain('threadnote-context/SKILL.md');
    expect(yield* fs.readFileString(template)).toContain('threadnote-code-graph/SKILL.md');
    expect(yield* fs.readFileString(template)).toContain('--cwd "$PWD"');
    const graphSkill = path.join(userHome, '.agents', 'skills', 'threadnote-code-graph', 'SKILL.md');
    expect(yield* fs.readFileString(graphSkill)).toContain('threadnote graph');
    yield* fs.remove(template);
    yield* fs.remove(graphSkill);
    yield* repairAgentIntegrations(config, false).pipe(Effect.provideService(SystemInfo, testSystem));
    expect(yield* fs.exists(template)).toBe(true);
    expect(yield* fs.exists(graphSkill)).toBe(true);
    expect(
      (yield* agentIntegrationDoctorChecks(config).pipe(Effect.provideService(SystemInfo, testSystem))).every(
        check => check.status === 'ok',
      ),
    ).toBe(true);
    expect(yield* fs.exists(path.join(codexRoot, 'config.toml'))).toBe(false);
    for (const dryRun of [true, false]) {
      expect(
        yield* removeMcpConfigs('codex', dryRun, {codex: receipt.mcp}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        ),
      ).toEqual(['codex']);
    }
    yield* removeAgentIntegrations(config, false).pipe(Effect.provideService(SystemInfo, testSystem));
    expect(yield* fs.readFileString(instruction)).toBe('Existing personal guidance.\n');
    expect(yield* fs.exists(template)).toBe(false);
    expect(yield* fs.exists(graphSkill)).toBe(false);
    expect(yield* fs.exists(path.join(userHome, '.agents', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(false);
  }).pipe(
    provideTestLayer(
      TestCommandExecutorLayer.pipe(Layer.provideMerge(TestSystemInfoLayer), Layer.provideMerge(BunServices.layer)),
    ),
  ),
);
