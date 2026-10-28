import fc from 'fast-check';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {Cause, Effect, FileSystem, Layer, Schema} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestClock} from 'effect/testing';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {resolveWorkflowBinding, verifyWorkflowBinding} from '../../src/workflow_memory/profile.js';
import {
  buildCursorCloudMcpConfig,
  buildCursorCloudProfile,
  buildCursorCloudRemoteHybridMcpConfig,
  credentialFreeGitRemote,
  cursorCloudMemoryEndpoint,
  cursorCloudMemoryRoot,
  cursorCloudRemoteShareId,
  cursorCloudRuntimeConfig,
  normalizeCursorCloudTeams,
  planCursorCloudBootstrap,
  resolveCursorCloudMemoryScope,
  registeredCursorCloudTeams,
  assertCursorCloudMemoryTeamsReady,
} from '@threadnote/threadnote/cursor/cloud';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ShareTeamConfig, ShareTeamsFile} from '@threadnote/threadnote/types';
import {InvalidResourceId, validatePortableSegment} from '@threadnote/store/resource-id';

const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-cloud-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-cloud-test/seed-manifest.yaml',
  user: 'local-user',
};

const scopeTestLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const scopeFixture = Effect.fn('test.cursorCloud.scopeFixture')(function* (
  names: readonly string[],
  defaultTeam = names[0],
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-scope-'});
  yield* fs.makeDirectory(`${home}/share`);
  const teams = Object.fromEntries(names.map(name => [name, {remote: `https://example.invalid/${name}.git`}]));
  const file = `${home}/share/teams.json`;
  yield* fs.writeFileString(file, JSON.stringify({version: 1, defaultTeam, teams}));
  return {config: {...runtime, agentContextHome: home}, fs, file};
});

describe('Cursor Cloud discovered scope', () => {
  effectIt.effect('preserves workflow binding drift and can restore its original explicit restriction', () =>
    Effect.gen(function* () {
      const f = yield* scopeFixture(['personal']);
      const home = f.config.agentContextHome;
      const system = yield* SystemInfo;
      const environment: Record<string, string> = {};
      const repo = `${home}/repo`;
      const worktree = `${home}/share/worktrees/personal`;
      yield* f.fs.makeDirectory(repo);
      yield* f.fs.makeDirectory(worktree, {recursive: true});
      yield* runCommandEffect('git', ['init', '--initial-branch=main', repo]);
      yield* runCommandEffect('git', ['init', '--initial-branch=main', worktree]);
      yield* f.fs.makeDirectory(`${home}/cursor-cloud`);
      yield* f.fs.writeFileString(
        `${home}/cursor-cloud/profile.json`,
        JSON.stringify({
          version: 1,
          provider: 'cursor-cloud',
          account: f.config.account,
          user: f.config.user,
          agentId: f.config.agentId,
        }),
      );
      const info = {...system, currentDirectory: () => repo, environment: () => environment};
      const binding = yield* resolveWorkflowBinding(f.config, {
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'cursor-scope-binding',
        project: 'threadnote',
        featureId: 'scope-test',
        generation: 'test',
      }).pipe(Effect.provideService(SystemInfo, info));
      const registry = JSON.parse(yield* f.fs.readFileString(f.file));
      registry.teams.docs = {...registry.teams.personal};
      yield* f.fs.writeFileString(f.file, JSON.stringify(registry));
      expect(
        yield* verifyWorkflowBinding(f.config, binding).pipe(Effect.provideService(SystemInfo, info), Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'binding-drift'}});
      environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'personal';
      yield* verifyWorkflowBinding(f.config, binding).pipe(Effect.provideService(SystemInfo, info));
    }).pipe(
      TestClock.withLive,
      provideTestLayer(
        TestCommandExecutorLayer.pipe(Layer.provideMerge(TestSystemInfoLayer), Layer.provideMerge(BunServices.layer)),
      ),
    ),
  );

  it('discovers exactly the writable set independent of order and default without mutating the registry', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u), {maxLength: 16}),
        fc.array(fc.boolean(), {minLength: 1, maxLength: 16}),
        (names, readOnly) => {
          const entries = names.map(
            (name, index) =>
              [
                name,
                {
                  ...teamConfig(
                    'https://example.invalid/memory.git',
                    readOnly[index % readOnly.length] ? 'read-only' : undefined,
                  ),
                  name,
                },
              ] as const,
          );
          const registry: ShareTeamsFile = {version: 1, defaultTeam: names[0], teams: Object.fromEntries(entries)};
          const original = structuredClone(registry);
          const selected = registeredCursorCloudTeams(registry);
          expect(selected).toEqual([...new Set(selected)].sort());
          for (const [name, team] of entries) expect(selected.includes(name)).toBe(team.access !== 'read-only');
          expect(selected.every(name => names.includes(name))).toBe(true);
          expect(
            registeredCursorCloudTeams({
              ...registry,
              defaultTeam: names.at(-1),
              teams: Object.fromEntries([...entries].reverse()),
            }),
          ).toEqual(selected);
          expect(registry).toEqual(original);
        },
      ),
      {numRuns: 100},
    );
  });
  effectIt.effect('discovers all writable shares without a default and observes registry changes', () =>
    Effect.gen(function* () {
      const f = yield* scopeFixture(['engineering', 'docs'], 'engineering');
      const before = yield* f.fs.readFileString(f.file);
      expect((yield* resolveCursorCloudMemoryScope(f.config, {})).shares.map(s => s.team)).toEqual([
        'docs',
        'engineering',
      ]);
      expect(yield* f.fs.readFileString(f.file)).toBe(before);
      yield* f.fs.writeFileString(
        f.file,
        JSON.stringify({
          version: 1,
          defaultTeam: 'docs',
          teams: {
            engineering: {remote: 'https://example.invalid/engineering.git'},
            docs: {remote: 'https://example.invalid/docs.git', access: 'read-only'},
          },
        }),
      );
      expect((yield* resolveCursorCloudMemoryScope(f.config, {})).shares.map(s => s.team)).toEqual(['engineering']);
      expect(
        (yield* resolveCursorCloudMemoryScope(f.config, {THREADNOTE_CURSOR_CLOUD_TEAM: 'docs'})).shares.map(
          s => s.team,
        ),
      ).toEqual(['docs']);
      const readiness = yield* assertCursorCloudMemoryTeamsReady(f.config, ['docs']).pipe(Effect.exit);
      expect(readiness._tag).toBe('Failure');
      if (readiness._tag === 'Failure') expect(Cause.pretty(readiness.cause)).toContain('not read-write yet');
    }).pipe(provideTestLayer(scopeTestLayer)),
  );

  effectIt.effect('keeps empty discovery empty and applies restrictions before the share cap', () =>
    Effect.gen(function* () {
      const f = yield* scopeFixture([]);
      expect((yield* resolveCursorCloudMemoryScope(f.config, {})).shares).toEqual([]);
      const large = yield* scopeFixture(Array.from({length: 17}, (_, i) => `team-${i}`));
      expect(
        (yield* resolveCursorCloudMemoryScope(large.config, {THREADNOTE_CURSOR_CLOUD_TEAM: 'team-0'})).shares,
      ).toHaveLength(1);
      const oversized = yield* resolveCursorCloudMemoryScope(large.config, {}).pipe(Effect.result);
      expect(oversized._tag).toBe('Failure');
      for (const selection of ['[]', '{}', '["docs", ""]', 'invalid']) {
        const result = yield* resolveCursorCloudMemoryScope(f.config, {THREADNOTE_CURSOR_CLOUD_TEAMS: selection}).pipe(
          Effect.result,
        );
        expect(result._tag).toBe('Failure');
      }
      expect(
        yield* resolveCursorCloudMemoryScope(f.config, {
          THREADNOTE_CURSOR_CLOUD_TEAM: 'other',
          THREADNOTE_CURSOR_CLOUD_TEAMS: '["docs"]',
        }).pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure'});
    }).pipe(provideTestLayer(scopeTestLayer)),
  );
});

describe('Cursor Cloud profile', () => {
  it('renders a deterministic writable shared-memory MCP configuration', () => {
    const profile = buildCursorCloudProfile(runtime, {
      agentId: 'cursor-agent',
      team: 'engineering',
      user: 'cloud-user',
    });

    expect(profile).toMatchObject({
      agentId: 'cursor-agent',
      memoryRoot: 'threadnote://user/cloud-user/memories/shared/engineering',
      profile: 'shared-read-write',
      team: 'engineering',
      user: 'cloud-user',
    });
    const mcpConfig = buildCursorCloudMcpConfig(profile, ['engineering']);
    expect(mcpConfig).toEqual(buildCursorCloudMcpConfig(profile, ['engineering']));
    expect(mcpConfig).toEqual({
      args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
      command: '/bin/sh',
      env: {
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'cursor-agent',
        THREADNOTE_CURSOR_CLOUD_TEAM: 'engineering',
        THREADNOTE_MCP_TOOLSET: 'cursor-cloud-personal',
        THREADNOTE_USER: 'cloud-user',
      },
      type: 'stdio',
    });
  });

  it('omits share selectors for a reusable discovery configuration', () => {
    const profile = buildCursorCloudProfile(runtime, {team: 'engineering', user: 'cloud-user'});
    const config = buildCursorCloudMcpConfig(profile);
    expect(config.env.THREADNOTE_CURSOR_CLOUD_TEAM).toBeUndefined();
    expect(config.env.THREADNOTE_CURSOR_CLOUD_TEAMS).toBeUndefined();
    expect(config.env.THREADNOTE_MCP_TOOLSET).toBe('cursor-cloud-personal');
    expect(buildCursorCloudMcpConfig(profile, [])).toEqual(config);
  });

  it('renders one MCP configuration for a deterministic bounded share set', () => {
    const profile = buildCursorCloudProfile(runtime, {agentId: 'cursor-agent', team: 'platform', user: 'cloud-user'});
    expect(buildCursorCloudMcpConfig(profile, ['platform', 'docs', 'platform'])).toMatchObject({
      env: {
        THREADNOTE_CURSOR_CLOUD_TEAM: 'docs',
        THREADNOTE_CURSOR_CLOUD_TEAMS: '["docs","platform"]',
        THREADNOTE_MCP_TOOLSET: 'cursor-cloud-personal',
      },
    });
  });

  it('normalizes repeated share selections independent of order and duplicates', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u), {maxLength: 12, minLength: 1}),
        fc.array(fc.nat(), {maxLength: 24}),
        (teams, order) => {
          const reordered = order.map(index => teams[index % teams.length]).concat(teams);
          expect(normalizeCursorCloudTeams(reordered)).toEqual([...teams].sort());
        },
      ),
      {numRuns: 100},
    );
  });

  it('preserves a saved Personal Cursor Cloud identity unless a command explicitly overrides it', () => {
    const identity = fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/u);
    const portableUser = identity.filter(value => {
      try {
        validatePortableSegment(value);
        return true;
      } catch (error) {
        if (Schema.is(InvalidResourceId)(error)) return false;
        throw error;
      }
    });
    fc.assert(
      fc.property(portableUser, identity, portableUser, (savedUser, savedAgent, overrideUser) => {
        const savedRuntime: RuntimeConfig = {
          ...runtime,
          agentId: savedAgent,
          agentIdSource: 'cursor-cloud-profile',
          user: savedUser,
          userSource: 'cursor-cloud-profile',
        };
        expect(cursorCloudRuntimeConfig(savedRuntime, {})).toMatchObject({
          agentId: savedAgent,
          user: savedUser,
        });
        expect(cursorCloudRuntimeConfig(savedRuntime, {user: overrideUser})).toMatchObject({
          agentId: savedAgent,
          user: overrideUser,
          userSource: 'cursor-cloud-command',
        });
      }),
      {examples: [['a', 'prn', 'b']], numRuns: 100},
    );
  });

  it('rejects reserved saved and overriding user memory-path identities', () => {
    expect(() => cursorCloudRuntimeConfig({...runtime, user: 'prn', userSource: 'cursor-cloud-profile'}, {})).toThrow(
      InvalidResourceId,
    );
    expect(() => cursorCloudRuntimeConfig(runtime, {user: 'prn'})).toThrow(InvalidResourceId);
  });

  it('renders two credential-free Dashboard entries for remote-hybrid mode', () => {
    const profile = buildCursorCloudProfile(runtime, {agentId: 'cloud-agent', user: 'cloud-user'});
    const config = buildCursorCloudRemoteHybridMcpConfig(
      profile,
      'https://memory.threadnote.io/mcp',
      'share-engineering',
    );

    expect(config).toEqual({
      mcpServers: {
        'threadnote-local': {
          args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
          command: '/bin/sh',
          env: {
            THREADNOTE_ACCOUNT: 'local',
            THREADNOTE_AGENT_ID: 'cloud-agent',
            THREADNOTE_CURSOR_MEMORY_ENDPOINT: 'https://memory.threadnote.io/mcp',
            THREADNOTE_CURSOR_MEMORY_SHARE_ID: 'share-engineering',
            THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
            THREADNOTE_USER: 'cloud-user',
          },
          type: 'stdio',
        },
        'threadnote-memory': {
          auth: {
            CLIENT_ID: 'threadnote-composer',
            scopes: [
              'memory:read',
              'memory:propose:durable',
              'memory:review:durable',
              'memory:write:durable',
              'memory:write:handoff',
            ],
          },
          headers: {'threadnote-share-id': 'share-engineering'},
          url: 'https://memory.threadnote.io/mcp',
        },
      },
    });
    expect(Object.keys(config.mcpServers['threadnote-memory'].headers)).toEqual(['threadnote-share-id']);
    expect(new URL(config.mcpServers['threadnote-memory'].url).search).toBe('');
    expect(JSON.stringify(config)).not.toMatch(/authorization|bearer|CLIENT_SECRET|secret/i);
  });

  it('accepts only the server-supported opaque remote share ID grammar without reflecting rejected values', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/u), shareId => {
        expect(cursorCloudRemoteShareId(shareId)).toBe(shareId);
      }),
      {numRuns: 100},
    );

    for (const shareId of ['share:other', '-leading-hyphen', `${'a'.repeat(128)}b`]) {
      let message = '';
      try {
        cursorCloudRemoteShareId(shareId);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      expect(message).toContain('opaque identifier');
      expect(message).not.toContain(shareId);
    }
  });

  it('rejects credential-bearing or ambiguous managed endpoints without reflecting them', () => {
    const endpoint = 'https://owner:credential@memory.threadnote.io/mcp';
    expect(() => cursorCloudMemoryEndpoint(endpoint)).toThrow('credential-free HTTPS');
    try {
      cursorCloudMemoryEndpoint(endpoint);
    } catch (cause) {
      expect(String(cause)).not.toContain(endpoint);
      expect(String(cause)).not.toContain('credential@');
    }
    expect(() => cursorCloudMemoryEndpoint('http://memory.threadnote.io/mcp')).toThrow('credential-free HTTPS');
    expect(() => cursorCloudMemoryEndpoint('https://memory.threadnote.io/mcp?token=value')).toThrow(
      'credential-free HTTPS',
    );
    expect(() => cursorCloudMemoryEndpoint('https://memory.threadnote.io/not-mcp')).toThrow('HTTPS /mcp URL');
  });

  it('plans initialization once and reuses only the equivalent writable share', () => {
    const remote = 'git@example.com:team/memories.git';
    expect(planCursorCloudBootstrap(emptyTeams(), remote, 'engineering')).toEqual({
      action: 'initialize',
      remote,
      team: 'engineering',
    });
    expect(planCursorCloudBootstrap(teamsWith(teamConfig(remote)), remote, 'engineering')).toEqual({
      action: 'reuse',
      remote,
      team: 'engineering',
    });
    expect(() => planCursorCloudBootstrap(teamsWith(teamConfig(remote, 'read-only')), remote, 'engineering')).toThrow(
      'not read-write',
    );
    expect(() =>
      planCursorCloudBootstrap(teamsWith(teamConfig('git@example.com:other/memories.git')), remote, 'engineering'),
    ).toThrow('different remote');
  });

  it('constructs the canonical exclusive memory root', () => {
    expect(cursorCloudMemoryRoot('Cloud User', 'product-team')).toBe(
      'threadnote://user/cloud-user/memories/shared/product-team',
    );
  });

  it('never reflects embedded HTTP credentials in rejection messages', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        (username, password) => {
          const remote = `https://${username}:${password}@example.com/team/memories.git`;
          let message = '';
          try {
            credentialFreeGitRemote(remote);
          } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause);
          }
          expect(message).toContain('must not contain embedded credentials');
          expect(message).not.toContain(remote);
        },
      ),
      {numRuns: 100},
    );
  });

  it('rejects query- and fragment-bearing Git remotes without reflecting them', () => {
    for (const remote of [
      'https://example.com/team/memories.git?token=cursorSecretValue',
      'https://example.com/team/memories.git#cursorSecretValue',
    ]) {
      let message = '';
      try {
        credentialFreeGitRemote(remote);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      expect(message).toContain('query parameters, or fragments');
      expect(message).not.toContain(remote);
      expect(message).not.toContain('cursorSecretValue');
    }
  });
});

function emptyTeams(): ShareTeamsFile {
  return {teams: {}, version: 1};
}

function teamsWith(team: ShareTeamConfig): ShareTeamsFile {
  return {defaultTeam: 'engineering', teams: {engineering: team}, version: 1};
}

function teamConfig(remote: string, access?: 'read-only'): ShareTeamConfig {
  return {
    ...(access ? {access} : {}),
    addedAt: '2026-08-12T00:00:00.000Z',
    gitdir: '/tmp/threadnote-cloud-test/share/teams/engineering.gitdir',
    name: 'engineering',
    remote,
    worktree: '/tmp/threadnote-cloud-test/share/worktrees/engineering',
  };
}
