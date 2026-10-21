import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';
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
    const mcpConfig = buildCursorCloudMcpConfig(profile);
    expect(mcpConfig).toEqual(buildCursorCloudMcpConfig(profile));
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
