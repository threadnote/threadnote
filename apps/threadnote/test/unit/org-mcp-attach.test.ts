import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {TestClock} from 'effect/testing';
import {afterEach, describe as vitestDescribe, it, vi} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {THREADNOTE_MCP_NAME} from '@threadnote/threadnote/constants';
import {
  CURSOR_CLOUD_LOCAL_MCP_TOOLSET,
  CURSOR_CLOUD_MEMORY_ENDPOINT_ENV,
  CURSOR_CLOUD_MODE_ENV,
  buildCursorCloudProfile,
  buildCursorCloudRemoteHybridMcpConfig,
  buildOrgCloudHybridMcpConfig,
  cursorCloudMemoryEndpoint,
  cursorCloudRemoteHybridStatus,
} from '@threadnote/threadnote/cursor/cloud';
import {isPersonalThreadnoteHome, removeMcpConfigs, runMcpInstall} from '@threadnote/threadnote/mcp/index';
import {
  ORG_COMPOSER_POLICY,
  THREADNOTE_COMPOSER_SHARE_ID_HEADER,
  THREADNOTE_ORG_MCP_NAME,
  buildComposerHttpMcpEntry,
  composerHttpEntryMatches,
  isComposerHttpEntry,
  buildCopilotComposerHttpMcpEntry,
  composerMcpUrl,
  composerShareId,
  composerOAuthScopes,
  isManagedComposerHttpEntry,
  resolveComposerAttach,
  stdioEnvironmentCallsComposer,
  teamStdioServers,
  withComposerHttpMcpEntry,
} from '@threadnote/threadnote/mcp/composer_attach';
import {mcpToolCapabilities, parseMcpToolset} from '@threadnote/threadnote/mcp/toolset';
import {runRemember} from '@threadnote/threadnote/memory/index';
import {runSharePublishTool} from '@threadnote/threadnote/mcp/server/share';
import {isJsonObject, parseJsonConfigObject} from '@threadnote/platform/json';
import type {JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function cursorMcpServers(content: string): {readonly mcpServers: JsonObject} {
  const config = parseJsonConfigObject(content);
  if (config === undefined || !isJsonObject(config.mcpServers)) {
    throw new Error('Cursor MCP configuration has no server map.');
  }
  return {...config, mcpServers: config.mcpServers};
}

function cursorServerEnvironment(server: unknown): JsonObject {
  if (!isJsonObject(server) || !isJsonObject(server.env)) return {};
  return server.env;
}

const runtimeConfig = (home: string): RuntimeConfig => ({
  account: 'local',
  agentContextHome: home,
  agentId: 'threadnote',
  manifestPath: `${home}/seed-manifest.yaml`,
  user: 'tester',
});

const profile = buildCursorCloudProfile(runtimeConfig('/tmp/threadnote-org-mcp'), {
  agentId: 'cloud-agent',
  user: 'cloud-user',
});

const SHARE_ID = FC.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/u);
const HOST = FC.constantFrom('composer.example.test', 'memory.example.test', 'org.example.test');
const COMPOSER_REQUIRED_SCOPES = [
  'memory:read',
  'memory:propose:durable',
  'memory:review:durable',
  'memory:write:durable',
  'memory:write:handoff',
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('organization composer attach', () => {
  fcEffectProp(
    effectIt,
    'scope union preserves required scopes and is idempotent and permutation invariant',
    {
      extras: FC.array(FC.stringMatching(/^[A-Za-z][A-Za-z0-9_:.-]{0,30}$/u), {maxLength: 10}),
    },
    ({extras}) =>
      Effect.sync(() => {
        const scopes = composerOAuthScopes(extras);
        expect(scopes.slice(0, COMPOSER_REQUIRED_SCOPES.length)).toEqual(COMPOSER_REQUIRED_SCOPES);
        expect(new Set(scopes)).toEqual(new Set([...COMPOSER_REQUIRED_SCOPES, ...extras]));
        expect(composerOAuthScopes(scopes)).toEqual(scopes);
        expect(composerOAuthScopes([...extras].reverse())).toEqual(scopes);
        expect(composerOAuthScopes([...extras, ...extras])).toEqual(scopes);
      }),
  );

  it.each([
    '',
    ' offline_access',
    'openid profile',
    'a"b',
    'a\\b',
    'é',
    '\n',
    Effect2.pipe('a', EffectString.repeat(257)),
  ])('rejects invalid provider scopes %#', scope => {
    expect(() => composerOAuthScopes([scope])).toThrow('RFC 6749');
  });

  it('bounds provider scope count and serialized size', () => {
    expect(() => composerOAuthScopes(Array.from({length: 33}, () => 'offline_access'))).toThrow('32');
    expect(() => composerOAuthScopes(Array.from({length: 30}, (_, i) => `scope${i}`))).toThrow('32');
    expect(() =>
      composerOAuthScopes(Array.from({length: 10}, (_, i) => `${i}${Effect2.pipe('a', EffectString.repeat(255))}`)),
    ).toThrow('2048');
  });

  it('compares explicit scopes while keeping customized demo entries outside removal ownership', () => {
    const base = buildComposerHttpMcpEntry('https://composer.example.test/mcp', 'engineering');
    const refresh = buildComposerHttpMcpEntry(base.url, 'engineering', undefined, ['offline_access']);
    expect(isComposerHttpEntry(refresh)).toBe(true);
    expect(isManagedComposerHttpEntry(refresh)).toBe(false);
    expect(composerHttpEntryMatches(base, refresh)).toBe(false);
    expect(
      composerHttpEntryMatches(
        {...refresh, auth: {...refresh.auth, scopes: [...refresh.auth.scopes].reverse()}},
        refresh,
      ),
    ).toBe(true);
    expect(isComposerHttpEntry({...refresh, auth: {...refresh.auth, scopes: ['offline_access']}})).toBe(false);
    expect(
      isComposerHttpEntry({...refresh, auth: {...refresh.auth, scopes: [...refresh.auth.scopes, 'offline_access']}}),
    ).toBe(false);
  });
  fcEffectProp(
    effectIt,
    'keeps stdio core Git share and binds composer share only in the HTTP header',
    {clientId: SHARE_ID, host: HOST, shareId: SHARE_ID},
    ({clientId, host, shareId}) =>
      Effect.sync(() => {
        const url = `https://${host}/mcp`;
        const stdio = {
          command: '/bin/threadnote-mcp-server',
          env: {
            THREADNOTE_MCP_TOOLSET: 'core',
            THREADNOTE_USER: 'tester',
          },
        } satisfies JsonObject;
        const servers = teamStdioServers(
          stdio,
          resolveComposerAttach({composerUrl: url, shareId, composerClientId: clientId}),
        );
        const capabilities = mcpToolCapabilities(parseMcpToolset('core'));
        expect(capabilities.graphLocal).toBe(true);
        expect(capabilities.memoryPublish).toBe(true);
        expect(servers[THREADNOTE_MCP_NAME]).toEqual(stdio);
        expect(stdioEnvironmentCallsComposer(stdio.env)).toBe(false);
        expect(
          composerHttpEntryMatches(servers[THREADNOTE_ORG_MCP_NAME], buildComposerHttpMcpEntry(url, shareId, clientId)),
        ).toBe(true);
        expect(servers[THREADNOTE_ORG_MCP_NAME]).toMatchObject({auth: {CLIENT_ID: clientId}});
        expect(JSON.stringify(servers[THREADNOTE_ORG_MCP_NAME])).not.toMatch(/"(?:authorization|CLIENT_SECRET)"\s*:/i);
        const composerEntry = servers[THREADNOTE_ORG_MCP_NAME];
        if (!composerEntry || typeof composerEntry.url !== 'string') throw new Error('Expected a composer URL.');
        expect(new URL(composerEntry.url).search).toBe('');
        expect(ORG_COMPOSER_POLICY).toEqual({
          canonicalStore: 'git',
          cursorOidc: 'optional-attribution',
          oauth: 'org-idp',
          shareBinding: 'header',
        });
        expect(isComposerHttpEntry(servers[THREADNOTE_ORG_MCP_NAME])).toBe(true);
        expect(isManagedComposerHttpEntry(servers[THREADNOTE_ORG_MCP_NAME])).toBe(clientId === 'threadnote-composer');
        expect(() =>
          withComposerHttpMcpEntry(
            {},
            THREADNOTE_ORG_MCP_NAME,
            stdio,
            resolveComposerAttach({composerUrl: url, shareId}),
          ),
        ).toThrow('reserved HTTP server name');
      }),
  );

  it('rejects invalid share IDs without reflecting them', () => {
    for (const shareId of ['share:other', '-leading-hyphen', `${Effect2.pipe('a', EffectString.repeat(128))}b`]) {
      let message = '';
      try {
        composerShareId(shareId);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      expect(message).toContain('opaque identifier');
      expect(message).not.toContain(shareId);
    }
  });

  it('carries a registered public OAuth client through the additive attach configuration', () => {
    const url = 'https://composer.example.test/mcp';
    const attach = resolveComposerAttach({
      composerUrl: url,
      shareId: 'engineering',
      composerClientId: 'registered-client',
    });
    const servers = teamStdioServers({command: '/bin/threadnote-mcp-server'}, attach);

    expect(servers[THREADNOTE_ORG_MCP_NAME]).toEqual(
      buildComposerHttpMcpEntry(url, 'engineering', 'registered-client'),
    );
    expect(servers[THREADNOTE_ORG_MCP_NAME]).toMatchObject({auth: {CLIENT_ID: 'registered-client'}});
    expect(isManagedComposerHttpEntry(servers[THREADNOTE_ORG_MCP_NAME])).toBe(false);
    expect(
      isManagedComposerHttpEntry({
        ...servers[THREADNOTE_ORG_MCP_NAME],
        auth: {
          CLIENT_ID: 'registered-client',
          CLIENT_SECRET: 'must-preserve',
          scopes: ['memory:read', 'memory:write:durable', 'memory:write:handoff'],
        },
      }),
    ).toBe(false);
    expect(
      composerHttpEntryMatches(
        servers[THREADNOTE_ORG_MCP_NAME],
        buildComposerHttpMcpEntry(url, 'engineering', 'different-client'),
      ),
    ).toBe(false);
  });

  it('matches each client schema and preserves custom OAuth configuration', () => {
    const cursor = buildComposerHttpMcpEntry('https://composer.example.test/mcp', 'engineering', 'registered');
    const copilot = buildCopilotComposerHttpMcpEntry(cursor.url, 'engineering', 'registered');
    expect(composerHttpEntryMatches(copilot, copilot)).toBe(true);
    expect(composerHttpEntryMatches(cursor, copilot)).toBe(false);
    expect(composerHttpEntryMatches(copilot, cursor)).toBe(false);
    expect(isManagedComposerHttpEntry(copilot)).toBe(false);
    expect(isComposerHttpEntry({...copilot, oauth: {...copilot.oauth, enterpriseManaged: true}})).toBe(false);
  });

  it('rejects an OAuth client ID without a composer binding', () => {
    expect(() => resolveComposerAttach({composerClientId: 'registered-client'})).toThrow(
      '--composer-url and --share-id',
    );
  });

  it.each(['', ' ', 'client\nother', Effect2.pipe('x', EffectString.repeat(513))])(
    'rejects an invalid registered OAuth client ID %#',
    clientId => {
      expect(() => buildComposerHttpMcpEntry('https://composer.example.test/mcp', 'engineering', clientId)).toThrow(
        'OAuth client ID',
      );
    },
  );

  it('rejects credential-bearing composer URLs without reflecting them', () => {
    const endpoint = 'https://owner:credential@composer.example.test/mcp';
    expect(() => composerMcpUrl(endpoint)).toThrow('credential-free');
    try {
      composerMcpUrl(endpoint);
    } catch (cause) {
      expect(String(cause)).not.toContain(endpoint);
      expect(String(cause)).not.toContain('credential@');
    }
    expect(() => composerMcpUrl('https://composer.example.test/mcp?share=other')).toThrow('query');
    expect(() => resolveComposerAttach({composerUrl: 'https://composer.example.test/mcp'})).toThrow(
      '--composer-url and --share-id',
    );
  });

  it('allows loopback HTTP for local composer attach and requires HTTPS otherwise', () => {
    expect(composerMcpUrl('http://127.0.0.1:18788/mcp')).toBe('http://127.0.0.1:18788/mcp');
    expect(composerMcpUrl('http://localhost:18788/mcp')).toBe('http://127.0.0.1:18788/mcp');
    expect(() => composerMcpUrl('http://composer.example.test/mcp')).toThrow('HTTPS');
  });

  it('treats only ~/.threadnote as the personal home', () => {
    const resolve = (...parts: string[]) => EffectArray.join(parts, '/');
    expect(isPersonalThreadnoteHome('/Users/denys/.threadnote', '/Users/denys', resolve)).toBe(true);
    expect(isPersonalThreadnoteHome('/homes/contributor-a', '/Users/denys', resolve)).toBe(false);
  });
});

vitestDescribe('organization cloud hybrid MCP', () => {
  it('uses a registered OAuth client for org and remote-hybrid cloud configurations', () => {
    expect(
      buildOrgCloudHybridMcpConfig(profile, 'https://composer.example.test/mcp', 'engineering', 'registered-client', {
        repositories: ['github.com/example/repo'],
      }).mcpServers[THREADNOTE_ORG_MCP_NAME],
    ).toMatchObject({auth: {CLIENT_ID: 'registered-client'}});
    expect(
      buildCursorCloudRemoteHybridMcpConfig(
        profile,
        'https://composer.example.test/mcp',
        'engineering',
        'registered-client',
      ).mcpServers['threadnote-memory'],
    ).toMatchObject({auth: {CLIENT_ID: 'registered-client'}});
  });
  it('binds memory HTTP to the Git-backed composer with org IdP OAuth', () => {
    const config = buildOrgCloudHybridMcpConfig(
      profile,
      'https://composer.example.test/mcp',
      'share-engineering',
      undefined,
      {repositories: ['github.com/example/repo']},
    );
    expect(config.policy).toEqual({
      ...ORG_COMPOSER_POLICY,
      cursorOidc: 'required-for-writes',
      defaultAccess: 'read-only',
      repositoryBinding: 'sha256-header',
    });
    expect(config.mcpServers['threadnote-local'].env.THREADNOTE_MCP_TOOLSET).toBe(CURSOR_CLOUD_LOCAL_MCP_TOOLSET);
    expect(config.mcpServers['threadnote-local'].env.THREADNOTE_CURSOR_CLOUD_MODE).toBe('org');
    expect(mcpToolCapabilities(parseMcpToolset(CURSOR_CLOUD_LOCAL_MCP_TOOLSET)).memoryPublish).toBe(false);
    expect(mcpToolCapabilities(parseMcpToolset(CURSOR_CLOUD_LOCAL_MCP_TOOLSET)).graphLocal).toBe(true);
    expect(config.mcpServers[THREADNOTE_ORG_MCP_NAME]).toEqual({
      auth: {
        CLIENT_ID: 'threadnote-composer',
        scopes: ['memory:read'],
      },
      headers: {
        [THREADNOTE_COMPOSER_SHARE_ID_HEADER]: 'share-engineering',
        'threadnote-cloud-access': 'read-only',
        'threadnote-repository-set': expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      url: 'https://composer.example.test/mcp',
    });
    expect(JSON.stringify(config)).not.toMatch(/postgres|markdown_body/i);
    expect(JSON.stringify(config)).not.toMatch(/authorization|bearer|CLIENT_SECRET|secret/i);
  });
});

describe('Team MCP install composer attach', () => {
  effectIt.effect('stdio-only Team install never writes a composer URL or endpoint', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-stdio-only-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        yield* captureConsole(runMcpInstall(testRuntime, 'cursor', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const installed = cursorMcpServers(yield* fs.readFileString(cursorPath));
        expect(cursorServerEnvironment(installed.mcpServers[THREADNOTE_MCP_NAME]).THREADNOTE_MCP_TOOLSET).toBe('core');
        expect(stdioEnvironmentCallsComposer(cursorServerEnvironment(installed.mcpServers[THREADNOTE_MCP_NAME]))).toBe(
          false,
        );
        expect(installed.mcpServers[THREADNOTE_ORG_MCP_NAME]).toBeUndefined();
        expect(JSON.stringify(installed)).not.toContain(CURSOR_CLOUD_MEMORY_ENDPOINT_ENV);
        expect(JSON.stringify(installed)).not.toContain('composer.example.test');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('installs and previews a registered Copilot client using the VS Code OAuth schema', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-copilot-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const project = path.join(root, 'repo');
        const configPath = path.join(project, '.vscode', 'mcp.json');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.makeDirectory(project, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        const options = {
          composerClientId: 'registered-copilot',
          composerUrl: 'https://composer.example.test/mcp',
          project,
          shareId: 'engineering',
        };
        const preview = yield* captureConsole(runMcpInstall(testRuntime, 'copilot', options)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(preview.output).toContain('"clientId": "registered-copilot"');
        expect(preview.output).not.toContain('"CLIENT_ID"');
        expect(yield* fs.exists(configPath)).toBe(false);
        yield* captureConsole(runMcpInstall(testRuntime, 'copilot', {...options, apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const before = yield* fs.readFileString(configPath);
        const installed = JSON.parse(before);
        expect(installed.servers[THREADNOTE_ORG_MCP_NAME]).toEqual({
          type: 'http',
          url: options.composerUrl,
          headers: {'threadnote-share-id': options.shareId},
          oauth: {clientId: options.composerClientId},
        });
        expect(installed.servers[THREADNOTE_MCP_NAME].type).toBe('stdio');
        const repeated = yield* captureConsole(runMcpInstall(testRuntime, 'copilot', {...options, apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(repeated.output).toContain('Already configured:');
        expect(yield* fs.readFileString(configPath)).toBe(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('attaches composer HTTP without removing stdio Git share or calling composer from stdio', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-attach-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const project = path.join(root, 'fixture-repo');
        const cursorPath = path.join(project, '.cursor', 'mcp.json');
        const personalCursorPath = path.join(user, '.cursor', 'mcp.json');
        const home = path.join(user, '.threadnote');
        const testRuntime = runtimeConfig(home);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.makeDirectory(home, {recursive: true});
        yield* fs.makeDirectory(project, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        yield* fs.writeFileString(path.join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        yield* captureConsole(
          runMcpInstall(testRuntime, 'cursor', {
            apply: true,
            composerClientId: 'registered-client',
            composerUrl: 'https://composer.example.test/mcp',
            project,
            shareId: 'share-engineering',
          }),
        ).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(yield* fs.exists(personalCursorPath)).toBe(false);
        const installed = cursorMcpServers(yield* fs.readFileString(cursorPath));
        const stdio = installed.mcpServers[THREADNOTE_MCP_NAME];
        const composer = installed.mcpServers[THREADNOTE_ORG_MCP_NAME];
        expect(cursorServerEnvironment(stdio).THREADNOTE_MCP_TOOLSET).toBe('core');
        expect(stdioEnvironmentCallsComposer(cursorServerEnvironment(stdio))).toBe(false);
        expect(JSON.stringify(cursorServerEnvironment(stdio))).not.toMatch(/attest|oidc|CURSOR_AGENT_SOCKET/i);
        expect(composer).toEqual(
          buildComposerHttpMcpEntry('https://composer.example.test/mcp', 'share-engineering', 'registered-client'),
        );
        const beforeRepeat = yield* fs.readFileString(cursorPath);
        const repeated = yield* captureConsole(
          runMcpInstall(testRuntime, 'cursor', {
            apply: true,
            composerClientId: 'registered-client',
            composerUrl: 'https://composer.example.test/mcp',
            project,
            shareId: 'share-engineering',
          }),
        ).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(repeated.output).toContain('Already configured:');
        expect(yield* fs.readFileString(cursorPath)).toBe(beforeRepeat);
        const refreshOptions = {
          apply: true,
          composerClientId: 'registered-client',
          composerUrl: 'https://composer.example.test/mcp',
          project,
          shareId: 'share-engineering',
          composerOAuthScopes: ['offline_access'],
        };
        yield* captureConsole(runMcpInstall(testRuntime, 'cursor', refreshOptions)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const withRefresh = yield* fs.readFileString(cursorPath);
        expect(JSON.parse(withRefresh).mcpServers['threadnote-org'].auth.scopes).toContain('offline_access');
        const repeatRefresh = yield* captureConsole(runMcpInstall(testRuntime, 'cursor', refreshOptions)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(repeatRefresh.output).toContain('Already configured:');
        yield* captureConsole(runMcpInstall(testRuntime, 'cursor', {apply: true, project})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(yield* fs.readFileString(cursorPath)).toBe(withRefresh);
        expect(mcpToolCapabilities(parseMcpToolset('core')).memoryPublish).toBe(true);

        const fetchSpy = vi.fn(() => Promise.reject(new Error('composer down')));
        vi.stubGlobal('fetch', fetchSpy);
        yield* TestClock.setTime(Date.parse('2026-09-05T08:00:00.000Z'));
        yield* runRemember(testRuntime, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: 'Team laptop remembers while composer is down.',
          topic: 'org-mcp-attach',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(
          yield* fs.exists(
            path.join(
              home,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'org-mcp-attach.md',
            ),
          ),
        ).toBe(true);

        const worktree = path.join(home, 'share', 'worktrees', 'default');
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-09-05T08:00:00.000Z',
                  gitdir: path.join(home, 'share', 'teams', 'default.gitdir'),
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        const published = yield* runSharePublishTool(
          testRuntime,
          'threadnote://user/tester/memories/durable/projects/threadnote/org-mcp-attach.md',
          {preview: true},
        );
        expect(published.isError).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('stdio-only reinstall preserves an existing composer HTTP entry', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-preserve-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        yield* fs.writeFileString(
          cursorPath,
          `${JSON.stringify(
            {
              mcpServers: {
                [THREADNOTE_ORG_MCP_NAME]: {
                  headers: {[THREADNOTE_COMPOSER_SHARE_ID_HEADER]: 'share-engineering'},
                  url: 'https://composer.example.test/mcp',
                },
              },
            },
            undefined,
            2,
          )}\n`,
        );
        yield* captureConsole(runMcpInstall(testRuntime, 'cursor', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const installed = cursorMcpServers(yield* fs.readFileString(cursorPath));
        expect(installed.mcpServers[THREADNOTE_MCP_NAME]).toMatchObject({
          env: {THREADNOTE_MCP_TOOLSET: 'core'},
        });
        expect(installed.mcpServers[THREADNOTE_ORG_MCP_NAME]).toEqual({
          headers: {[THREADNOTE_COMPOSER_SHARE_ID_HEADER]: 'share-engineering'},
          url: 'https://composer.example.test/mcp',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects --name threadnote-org when attaching composer', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-name-collision-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        const error = yield* runMcpInstall(testRuntime, 'cursor', {
          apply: true,
          composerUrl: 'https://composer.example.test/mcp',
          name: THREADNOTE_ORG_MCP_NAME,
          project: path.join(root, 'fixture-repo'),
          shareId: 'share-engineering',
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
        expect(error).toMatchObject({message: expect.stringContaining('reserved for the HTTP composer entry')});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses composer attach that would rewrite personal ~/.cursor/mcp.json', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-no-global-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const personalCursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        const error = yield* runMcpInstall(testRuntime, 'cursor', {
          apply: true,
          composerUrl: 'https://composer.example.test/mcp',
          shareId: 'share-engineering',
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
        expect(error).toMatchObject({message: expect.stringContaining('--project')});
        expect(yield* fs.exists(personalCursorPath)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses Cursor MCP writes from a non-personal THREADNOTE_HOME without --project', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-enterprise-home-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const enterpriseHome = path.join(root, 'homes', 'contributor-a');
        const personalCursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtimeConfig(enterpriseHome);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        const error = yield* runMcpInstall(testRuntime, 'cursor', {apply: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.flip,
        );
        expect(error).toMatchObject({message: expect.stringContaining('--project')});
        expect(yield* fs.exists(personalCursorPath)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall of personal Cursor MCP leaves project composer attach in place', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-uninstall-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const project = path.join(root, 'fixture-repo');
        const cursorPath = path.join(project, '.cursor', 'mcp.json');
        const personalCursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.makeDirectory(path.dirname(personalCursorPath), {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        yield* fs.writeFileString(
          personalCursorPath,
          `${JSON.stringify({mcpServers: {[THREADNOTE_MCP_NAME]: {command: 'personal-stdio'}}}, undefined, 2)}\n`,
        );
        yield* captureConsole(
          runMcpInstall(testRuntime, 'cursor', {
            apply: true,
            composerUrl: 'https://composer.example.test/mcp',
            project,
            shareId: 'share-engineering',
          }),
        ).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* captureConsole(removeMcpConfigs('cursor', false)).pipe(Effect.provideService(SystemInfo, testSystem));
        const remaining = cursorMcpServers(yield* fs.readFileString(cursorPath));
        expect(remaining.mcpServers[THREADNOTE_ORG_MCP_NAME]).toEqual(
          buildComposerHttpMcpEntry('https://composer.example.test/mcp', 'share-engineering'),
        );
        const personal = cursorMcpServers(yield* fs.readFileString(personalCursorPath));
        expect(personal.mcpServers[THREADNOTE_ORG_MCP_NAME]).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall preserves an operator-registered threadnote-org entry', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-keep-custom-'}));
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtimeConfig(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(path.join(bin, 'threadnote-mcp-server'), '');
        yield* fs.writeFileString(
          cursorPath,
          `${JSON.stringify(
            {
              mcpServers: {
                [THREADNOTE_MCP_NAME]: {command: 'placeholder'},
                [THREADNOTE_ORG_MCP_NAME]: buildComposerHttpMcpEntry(
                  'https://composer.example.test/mcp',
                  'engineering',
                  'operator-registered',
                ),
              },
            },
            undefined,
            2,
          )}\n`,
        );
        yield* captureConsole(runMcpInstall(testRuntime, 'cursor', {apply: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* captureConsole(removeMcpConfigs('cursor', false)).pipe(Effect.provideService(SystemInfo, testSystem));
        const remaining = cursorMcpServers(yield* fs.readFileString(cursorPath));
        expect(remaining.mcpServers[THREADNOTE_MCP_NAME]).toBeUndefined();
        expect(remaining.mcpServers[THREADNOTE_ORG_MCP_NAME]).toEqual(
          buildComposerHttpMcpEntry('https://composer.example.test/mcp', 'engineering', 'operator-registered'),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

vitestDescribe('organization cloud hybrid verify', () => {
  effectIt.effect('reports unverified composer OAuth as warn and Cursor OIDC required for writes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-verify-'}));
        const home = path.join(root, 'home');
        const cwd = path.join(root, 'checkout');
        yield* fs.makeDirectory(home, {recursive: true});
        yield* fs.makeDirectory(cwd, {recursive: true});
        const receipt = yield* cursorCloudRemoteHybridStatus(runtimeConfig(home), {
          cwd,
          endpoint: 'https://composer.example.test/mcp',
          mode: 'org',
          shareId: 'share-engineering',
        }).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...baseSystem,
              environment: () => ({...baseSystem.environment()}),
              homeDirectory: root,
              platform: 'linux',
            }),
          ),
        );
        expect(receipt.mode).toBe('org');
        if (receipt.mode !== 'org') {
          throw new Error('expected organization cloud hybrid receipt');
        }
        expect(receipt.cursorOidc).toBe('required-for-writes');
        expect(receipt.oauth).toBe('org-idp');
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(receipt.checks, check => check.name === 'composer OAuth')),
        ).toMatchObject({
          status: 'warn',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('accepts loopback HTTP when the org local-graph env is set without an explicit mode', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-org-status-loopback-'}));
        const home = path.join(root, 'home');
        const cwd = path.join(root, 'checkout');
        yield* fs.makeDirectory(home, {recursive: true});
        yield* fs.makeDirectory(cwd, {recursive: true});
        const receipt = yield* cursorCloudRemoteHybridStatus(runtimeConfig(home), {
          cwd,
          endpoint: 'http://127.0.0.1:18788/mcp',
        }).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...baseSystem,
              environment: () => ({
                ...baseSystem.environment(),
                [CURSOR_CLOUD_MEMORY_ENDPOINT_ENV]: 'http://127.0.0.1:18788/mcp',
                [CURSOR_CLOUD_MODE_ENV]: 'org',
                THREADNOTE_CURSOR_MEMORY_SHARE_ID: 'share-engineering',
              }),
              homeDirectory: root,
              platform: 'linux',
            }),
          ),
        );
        expect(receipt.mode).toBe('org');
        expect(receipt.endpoint).toBe('http://127.0.0.1:18788/mcp');
        expect(() => cursorCloudMemoryEndpoint('http://127.0.0.1:18788/mcp')).toThrow('HTTPS');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
