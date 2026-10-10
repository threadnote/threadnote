import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {
  ORG_CLOUD_ACCESS_HEADER,
  ORG_CLOUD_REPOSITORY_SET_HEADER,
  orgCloudRepositorySetDigest,
  orgCloudScopes,
} from '@threadnote/remote-memory/cloud_admission';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ShareTeamConfig, ShareTeamsFile} from '../types.js';
import {runShareInit, runShareSync} from '../share/index.js';
import {normalizeTeamName, readTeamsFile, shareTeamAccess} from '../share/index.js';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {SystemInfo} from '@threadnote/platform/system';
import {canonicalResourceUri, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {uriSegment} from '../mcp/server/common.js';
import {installCursorCloudAgentIntegration} from '../agent_integration/index.js';
import {persistCursorCloudIdentityProfile} from './profile.js';
import {
  ORG_COMPOSER_POLICY,
  THREADNOTE_ORG_MCP_NAME,
  buildComposerHttpMcpEntry,
  composerMcpUrl,
  composerShareId,
  type ComposerHttpMcpEntry,
} from '../mcp/composer_attach.js';

export const ORG_CLOUD_POLICY = {
  ...ORG_COMPOSER_POLICY,
  cursorOidc: 'required-for-writes',
  defaultAccess: 'read-only',
  repositoryBinding: 'sha256-header',
} as const;

/** Legacy selector retained for Threadnote 4.2 Dashboard configurations. */
export const CURSOR_CLOUD_MCP_TOOLSET = 'cursor-cloud' as const;
export const CURSOR_CLOUD_GIT_BETA_MCP_TOOLSET = 'cursor-cloud-git-beta' as const;
export const CURSOR_CLOUD_PERSONAL_MCP_TOOLSET = 'cursor-cloud-personal' as const;
export const CURSOR_CLOUD_LOCAL_MCP_TOOLSET = 'cursor-cloud-local' as const;
export const CURSOR_CLOUD_MEMORY_ENDPOINT_ENV = 'THREADNOTE_CURSOR_MEMORY_ENDPOINT';
export const CURSOR_CLOUD_MEMORY_SHARE_ID_ENV = 'THREADNOTE_CURSOR_MEMORY_SHARE_ID';
export const CURSOR_CLOUD_MODE_ENV = 'THREADNOTE_CURSOR_CLOUD_MODE';
export const CURSOR_CLOUD_TEAM_ENV = 'THREADNOTE_CURSOR_CLOUD_TEAM';
export const CURSOR_CLOUD_TEAMS_ENV = 'THREADNOTE_CURSOR_CLOUD_TEAMS';
export const DEFAULT_CURSOR_CLOUD_IDENTITY = 'cursor-cloud';

const CURSOR_CLOUD_SHARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const MAX_CURSOR_CLOUD_TEAMS = 16;

export type CursorCloudMode = 'org' | 'personal' | 'remote-hybrid';

export class CursorCloudOperationError extends Schema.TaggedError<CursorCloudOperationError>()(
  'CursorCloudOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export interface CursorCloudProfileV1 {
  readonly account: string;
  readonly agentId: string;
  readonly graphMode: 'local-checkout';
  readonly homeDurability: 'ephemeral';
  readonly memoryRoot: string;
  readonly profile: 'shared-read-write';
  readonly provider: 'cursor-cloud';
  readonly team: string;
  readonly user: string;
  readonly version: 1;
}

export interface CursorCloudMcpConfig {
  readonly args: readonly ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'];
  readonly command: '/bin/sh';
  readonly env: Readonly<{
    THREADNOTE_ACCOUNT: string;
    THREADNOTE_AGENT_ID: string;
    THREADNOTE_CURSOR_CLOUD_TEAM: string;
    THREADNOTE_CURSOR_CLOUD_TEAMS?: string;
    THREADNOTE_MCP_TOOLSET: typeof CURSOR_CLOUD_PERSONAL_MCP_TOOLSET;
    THREADNOTE_USER: string;
  }>;
  readonly type: 'stdio';
}

export interface CursorCloudLocalMcpConfig {
  readonly args: readonly ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'];
  readonly command: '/bin/sh';
  readonly env: Readonly<{
    THREADNOTE_ACCOUNT: string;
    THREADNOTE_AGENT_ID: string;
    THREADNOTE_CURSOR_CLOUD_MODE?: 'org';
    THREADNOTE_CURSOR_MEMORY_ENDPOINT: string;
    THREADNOTE_CURSOR_MEMORY_SHARE_ID: string;
    THREADNOTE_MCP_TOOLSET: typeof CURSOR_CLOUD_LOCAL_MCP_TOOLSET;
    THREADNOTE_USER: string;
  }>;
  readonly type: 'stdio';
}

export interface CursorCloudRemoteHybridMcpConfig {
  readonly mcpServers: Readonly<{
    'threadnote-local': CursorCloudLocalMcpConfig;
    'threadnote-memory': Readonly<{
      readonly headers: Readonly<{readonly 'threadnote-share-id': string}>;
      readonly url: string;
    }>;
  }>;
}

export interface OrgCloudHybridMcpConfig {
  readonly mcpServers: Readonly<{
    'threadnote-local': CursorCloudLocalMcpConfig;
    'threadnote-org': ComposerHttpMcpEntry & {
      readonly headers: ComposerHttpMcpEntry['headers'] & {
        readonly 'threadnote-cloud-access': 'read-only' | 'contribute';
        readonly 'threadnote-repository-set': string;
      };
    };
  }>;
  readonly policy: typeof ORG_CLOUD_POLICY;
}

export interface CursorCloudShareScope {
  readonly root: string;
  readonly team: string;
}

export interface CursorCloudMemoryScope {
  readonly mode: 'shared-read-write';
  readonly label?: string;
  readonly localReadRoots?: readonly string[];
  readonly shares: readonly CursorCloudShareScope[];
}

export interface CursorCloudBootstrapOptions {
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly endpoint?: string;
  readonly mode?: CursorCloudMode;
  readonly remote?: string;
  readonly shareId?: string;
  readonly sync?: boolean;
  readonly team?: string;
}

export type CursorCloudBootstrapPlan =
  | {readonly action: 'initialize'; readonly remote: string; readonly team: string}
  | {readonly action: 'reuse'; readonly remote: string; readonly team: string};

export interface CursorCloudVerifyCheck {
  readonly detail: string;
  readonly name: string;
  readonly plane?: 'local-graph' | 'remote-memory';
  readonly status: 'fail' | 'ok' | 'warn';
}

export interface CursorCloudVerifyReceiptV2 {
  readonly checks: readonly CursorCloudVerifyCheck[];
  readonly memoryRoot: string;
  readonly memoryRoots: readonly string[];
  readonly profile: 'shared-read-write';
  readonly provider: 'cursor-cloud';
  readonly shares: readonly CursorCloudShareScope[];
  readonly status: 'fail' | 'ok';
  readonly team: string;
  readonly teams: readonly string[];
  readonly version: 2;
}

export interface CursorCloudRemoteHybridVerifyReceiptV1 {
  readonly checks: readonly CursorCloudVerifyCheck[];
  readonly endpoint: string;
  readonly localMemoryFallback: 'disabled';
  readonly mode: 'remote-hybrid';
  readonly provider: 'cursor-cloud';
  readonly shareId: string;
  readonly status: 'fail' | 'ok';
  readonly version: 1;
}

export interface OrgCloudHybridVerifyReceiptV1 {
  readonly canonicalStore: 'git';
  readonly checks: readonly CursorCloudVerifyCheck[];
  readonly cursorOidc: 'required-for-writes';
  readonly endpoint: string;
  readonly localMemoryFallback: 'disabled';
  readonly mode: 'org';
  readonly oauth: 'org-idp';
  readonly provider: 'cursor-cloud';
  readonly shareBinding: 'header';
  readonly shareId: string;
  readonly status: 'fail' | 'ok';
  readonly stdioGitShare: false;
  readonly version: 1;
}

export function cursorCloudMemoryRoot(user: string, team: string): string {
  return canonicalResourceUri('user', [uriSegment(user), 'memories', 'shared', normalizeTeamName(team)]);
}

export function normalizeCursorCloudTeams(teams: string | readonly string[] | undefined): readonly string[] {
  const values = teams === undefined ? [] : typeof teams === 'string' ? [teams] : teams;
  const normalized = [...new Set(values.map(team => normalizeTeamName(team)))].sort();
  const selected = normalized.length === 0 ? [DEFAULT_CURSOR_CLOUD_IDENTITY] : normalized;
  if (selected.length > MAX_CURSOR_CLOUD_TEAMS) {
    throw CursorCloudOperationError.make({
      message: `Personal Cursor Cloud supports at most ${MAX_CURSOR_CLOUD_TEAMS} shares in one MCP server.`,
    });
  }
  return selected;
}

export function cursorCloudScopeRoots(scope: CursorCloudMemoryScope): readonly string[] {
  return [...scope.shares.map(share => share.root), ...(scope.localReadRoots ?? [])];
}

export function cursorCloudScopeTeams(scope: CursorCloudMemoryScope): readonly string[] {
  return scope.shares.map(share => share.team);
}

export function cursorCloudShareForTeam(
  scope: CursorCloudMemoryScope,
  team: string | undefined,
): CursorCloudShareScope | undefined {
  if (team === undefined) return scope.shares.length === 1 ? scope.shares[0] : undefined;
  const normalized = normalizeTeamName(team);
  return scope.shares.find(share => share.team === normalized);
}

export function cursorCloudShareForUri(scope: CursorCloudMemoryScope, uri: string): CursorCloudShareScope | undefined {
  return scope.shares.find(share => resourceIdIsWithin(uri, share.root));
}

export function cursorCloudUriWithinScope(scope: CursorCloudMemoryScope, uri: string): boolean {
  return cursorCloudScopeRoots(scope).some(root => resourceIdIsWithin(uri, root));
}

export function cursorCloudMemoryScopeReceipt(scope: CursorCloudMemoryScope) {
  const shares = scope.shares.map(share => ({root: share.root, team: share.team}));
  return {
    memoryRoots: shares.map(share => share.root),
    mode: scope.mode,
    shares,
    teams: shares.map(share => share.team),
    type: 'threadnote-memory-scope',
    version: 2,
  } as const;
}

export function buildCursorCloudProfile(
  config: Pick<RuntimeConfig, 'account'>,
  options: {readonly agentId?: string; readonly team?: string; readonly user?: string} = {},
): CursorCloudProfileV1 {
  const team = normalizeTeamName(options.team ?? DEFAULT_CURSOR_CLOUD_IDENTITY);
  const user = requiredIdentity(options.user ?? DEFAULT_CURSOR_CLOUD_IDENTITY, 'user');
  const agentId = requiredIdentity(options.agentId ?? DEFAULT_CURSOR_CLOUD_IDENTITY, 'agent id');
  return {
    account: config.account,
    agentId,
    graphMode: 'local-checkout',
    homeDurability: 'ephemeral',
    memoryRoot: cursorCloudMemoryRoot(user, team),
    profile: 'shared-read-write',
    provider: 'cursor-cloud',
    team,
    user,
    version: 1,
  };
}

export function buildCursorCloudMcpConfig(
  profile: CursorCloudProfileV1,
  requestedTeams: readonly string[] = [profile.team],
): CursorCloudMcpConfig {
  const teams = normalizeCursorCloudTeams(requestedTeams);
  return {
    args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
    command: '/bin/sh',
    env: {
      THREADNOTE_ACCOUNT: profile.account,
      THREADNOTE_AGENT_ID: profile.agentId,
      THREADNOTE_CURSOR_CLOUD_TEAM: teams[0],
      ...(teams.length === 1 ? {} : {THREADNOTE_CURSOR_CLOUD_TEAMS: JSON.stringify(teams)}),
      THREADNOTE_MCP_TOOLSET: CURSOR_CLOUD_PERSONAL_MCP_TOOLSET,
      THREADNOTE_USER: profile.user,
    },
    type: 'stdio',
  };
}

export function buildCursorCloudRemoteHybridMcpConfig(
  profile: CursorCloudProfileV1,
  endpoint: string,
  shareId: string,
  clientId?: string,
): CursorCloudRemoteHybridMcpConfig {
  const url = cursorCloudMemoryEndpoint(endpoint);
  const boundShareId = cursorCloudRemoteShareId(shareId);
  return {
    mcpServers: {
      'threadnote-local': buildCursorCloudLocalGraphMcpConfig(profile, url, boundShareId),
      'threadnote-memory': buildComposerHttpMcpEntry(url, boundShareId, clientId),
    },
  };
}

export function buildOrgCloudHybridMcpConfig(
  profile: CursorCloudProfileV1,
  endpoint: string,
  shareId: string,
  clientId?: string,
  options: {readonly repositories: readonly string[]; readonly contribute?: boolean} = {repositories: []},
): OrgCloudHybridMcpConfig {
  const url = composerMcpUrl(endpoint);
  const boundShareId = composerShareId(shareId);
  const digest = orgCloudRepositorySetDigest(boundShareId, options.repositories);
  const access = options.contribute === true ? 'contribute' : 'read-only';
  const entry = buildComposerHttpMcpEntry(url, boundShareId, clientId);
  return {
    mcpServers: {
      'threadnote-local': buildCursorCloudLocalGraphMcpConfig(profile, url, boundShareId, 'org'),
      [THREADNOTE_ORG_MCP_NAME]: {
        ...entry,
        auth: {...entry.auth, scopes: orgCloudScopes(access)},
        headers: {...entry.headers, [ORG_CLOUD_ACCESS_HEADER]: access, [ORG_CLOUD_REPOSITORY_SET_HEADER]: digest},
      },
    },
    policy: ORG_CLOUD_POLICY,
  };
}

function buildCursorCloudLocalGraphMcpConfig(
  profile: CursorCloudProfileV1,
  endpoint: string,
  shareId: string,
  mode?: 'org',
): CursorCloudLocalMcpConfig {
  return {
    args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
    command: '/bin/sh',
    env: {
      THREADNOTE_ACCOUNT: profile.account,
      THREADNOTE_AGENT_ID: profile.agentId,
      ...(mode === 'org' ? {THREADNOTE_CURSOR_CLOUD_MODE: 'org'} : {}),
      THREADNOTE_CURSOR_MEMORY_ENDPOINT: endpoint,
      THREADNOTE_CURSOR_MEMORY_SHARE_ID: shareId,
      THREADNOTE_MCP_TOOLSET: CURSOR_CLOUD_LOCAL_MCP_TOOLSET,
      THREADNOTE_USER: profile.user,
    },
    type: 'stdio',
  };
}

export function cursorCloudRemoteShareId(shareId: string): string {
  const normalized = shareId.trim();
  if (!CURSOR_CLOUD_SHARE_ID_PATTERN.test(normalized)) {
    throw CursorCloudOperationError.make({
      message:
        'The Cursor Cloud remote memory share ID must be an opaque identifier containing only letters, digits, dot, underscore, or hyphen.',
    });
  }
  return normalized;
}

export function cursorCloudMemoryEndpoint(endpoint: string): string {
  const normalized = endpoint.trim();
  const hasUnsafeCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasUnsafeCharacter) {
    throw CursorCloudOperationError.make({
      message: 'The Cursor Cloud remote memory endpoint must be a valid HTTPS URL.',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw CursorCloudOperationError.make({
      message: 'The Cursor Cloud remote memory endpoint must be a valid HTTPS URL.',
    });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0 ||
    parsed.pathname !== '/mcp'
  ) {
    throw CursorCloudOperationError.make({
      message:
        'The Cursor Cloud remote memory endpoint must be the credential-free HTTPS /mcp URL without a query or fragment.',
    });
  }
  return parsed.toString();
}

export function cursorCloudRuntimeConfig(
  config: RuntimeConfig,
  options: {readonly agentId?: string; readonly user?: string},
): RuntimeConfig {
  const profile = buildCursorCloudProfile(config, {
    agentId: options.agentId ?? cursorCloudDefaultIdentity(config.agentId, config.agentIdSource),
    user: options.user ?? cursorCloudDefaultIdentity(config.user, config.userSource),
  });
  return {
    ...config,
    agentId: profile.agentId,
    agentIdSource: options.agentId ? 'cursor-cloud-command' : config.agentIdSource,
    user: profile.user,
    userSource: options.user ? 'cursor-cloud-command' : config.userSource,
  };
}

export function credentialFreeGitRemote(remote: string, provider = 'Cursor Cloud'): string {
  const normalized = remote.trim();
  const hasForbiddenCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasForbiddenCharacter) {
    throw CursorCloudOperationError.make({
      message: `The ${provider} memory remote must be a non-empty URL without whitespace.`,
    });
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw CursorCloudOperationError.make({message: `The ${provider} memory remote must be a valid Git URL.`});
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw CursorCloudOperationError.make({
        message: `The ${provider} memory remote must not contain embedded credentials, query parameters, or fragments; configure authentication in the environment or Git credential provider.`,
      });
    }
  }
  return normalized;
}

export function planCursorCloudBootstrap(
  teamsFile: ShareTeamsFile,
  requestedRemote: string,
  requestedTeam = DEFAULT_CURSOR_CLOUD_IDENTITY,
  provider = 'Cursor Cloud',
): CursorCloudBootstrapPlan {
  const team = normalizeTeamName(requestedTeam);
  const remote = credentialFreeGitRemote(requestedRemote, provider);
  const existing = teamsFile.teams[team];
  if (!existing) return {action: 'initialize', remote, team};
  assertEquivalentWritableTeam(existing, remote, team, provider);
  return {action: 'reuse', remote, team};
}

export const resolveCursorCloudMemoryScope = Effect.fn('cursorCloud.resolveMemoryScope')(function (
  config: RuntimeConfig,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return Effect.sync(() => {
    const teams = cursorCloudTeamsFromEnvironment(environment);
    return {
      mode: 'shared-read-write',
      shares: teams.map(team => ({root: cursorCloudMemoryRoot(config.user, team), team})),
    } satisfies CursorCloudMemoryScope;
  });
});

export const assertCursorCloudMemoryTeamsReady = Effect.fn('cursorCloud.assertMemoryTeamsReady')(function* (
  config: RuntimeConfig,
  teams: readonly string[],
) {
  const teamsFile = yield* readTeamsFile(config);
  for (const team of teams) {
    const configured = teamsFile.teams[team];
    if (!configured) {
      throw CursorCloudOperationError.make({
        message: `Cursor Cloud memory team "${team}" is not configured yet. MCP discovery remains available while bootstrap runs; wait for the environment Build to finish, then retry. If bootstrap is not running, run threadnote cloud cursor bootstrap --team ${team} first.`,
      });
    }
    if (shareTeamAccess(configured) !== 'read-write') {
      throw CursorCloudOperationError.make({
        message: `Cursor Cloud memory team "${team}" is not read-write yet. MCP discovery remains available while bootstrap runs; wait for the environment Build to finish, then retry.`,
      });
    }
  }
});

export const runCursorCloudConfig = Effect.fn('cursorCloud.config')(function* (
  config: RuntimeConfig,
  options: {
    readonly agentId?: string;
    readonly clientId?: string;
    readonly contribute?: boolean;
    readonly repositories?: readonly string[];
    readonly endpoint?: string;
    readonly mode?: CursorCloudMode;
    readonly shareId?: string;
    readonly teams?: readonly string[];
    readonly user?: string;
  },
) {
  if (options.mode !== 'org' && (options.contribute || options.repositories?.length)) {
    throw CursorCloudOperationError.make({message: '--repository and --contribute require --mode org.'});
  }
  const teams = normalizeCursorCloudTeams(options.teams);
  const profile = buildCursorCloudProfile(config, {
    ...options,
    agentId: options.agentId ?? config.agentId,
    team: teams[0],
    user: options.user ?? config.user,
  });
  const output =
    options.mode === 'org'
      ? buildOrgCloudHybridMcpConfig(
          profile,
          requiredHybridEndpoint(options.endpoint, 'org'),
          requiredRemoteShareId(options.shareId),
          options.clientId,
          {repositories: options.repositories ?? [], contribute: options.contribute},
        )
      : options.mode === 'remote-hybrid'
        ? buildCursorCloudRemoteHybridMcpConfig(
            profile,
            requiredHybridEndpoint(options.endpoint, 'remote-hybrid'),
            requiredRemoteShareId(options.shareId),
            options.clientId,
          )
        : buildCursorCloudMcpConfig(profile, teams);
  yield* Console.log(JSON.stringify(output, undefined, 2));
});

export const runCursorCloudBootstrap = Effect.fn('cursorCloud.bootstrap')(function* (
  config: RuntimeConfig,
  options: CursorCloudBootstrapOptions,
) {
  if (options.mode === 'remote-hybrid' || options.mode === 'org') {
    return yield* runCursorCloudRemoteHybridBootstrap(config, {
      cwd: requiredRemoteCheckout(options.cwd),
      dryRun: options.dryRun,
      endpoint: requiredHybridEndpoint(options.endpoint, options.mode),
      mode: options.mode,
      shareId: requiredRemoteShareId(options.shareId),
    });
  }
  if (!options.remote) {
    throw CursorCloudOperationError.make({message: 'Personal Cursor Cloud bootstrap requires --remote.'});
  }
  const remote = options.remote;
  yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      if (options.dryRun !== true) {
        yield* persistCursorCloudIdentityProfile(config);
      }
      const plan = planCursorCloudBootstrap(yield* readTeamsFile(config), remote, options.team);
      if (plan.action === 'initialize') {
        yield* runShareInit(config, plan.remote, {
          dryRun: options.dryRun,
          push: true,
          readOnly: false,
          setDefault: true,
          team: plan.team,
        });
      } else {
        yield* Console.log(`Cursor Cloud memory team "${plan.team}" is already configured read-write; reusing it.`);
      }
      if (options.dryRun === true) {
        yield* Console.log('Dry run complete; the memory share was not changed or synchronized.');
      } else if (options.sync !== false) {
        yield* runShareSync(config, {push: true, team: plan.team});
      }
      yield* Console.log(`Cursor Cloud memory root: ${cursorCloudMemoryRoot(config.user, plan.team)}/`);
      yield* installCursorCloudAgentIntegration(config, options.dryRun === true);
    }),
  );
});

export const runCursorCloudVerify = Effect.fn('cursorCloud.verify')(function* (
  config: RuntimeConfig,
  options: {
    readonly cwd: string;
    readonly endpoint?: string;
    readonly json?: boolean;
    readonly mode?: CursorCloudMode;
    readonly shareId?: string;
    readonly teams?: readonly string[];
  },
) {
  if (options.mode === 'remote-hybrid' || options.mode === 'org') {
    const receipt = yield* cursorCloudRemoteHybridStatus(config, {
      cwd: options.cwd,
      endpoint: requiredHybridEndpoint(options.endpoint, options.mode),
      mode: options.mode,
      shareId: requiredRemoteShareId(options.shareId),
    });
    yield* printCursorCloudVerifyReceipt(receipt, options.json);
    if (receipt.status === 'fail') {
      throw CursorCloudOperationError.make({
        message: 'Cursor Cloud verification failed; resolve the failed checks above.',
      });
    }
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const teams = normalizeCursorCloudTeams(options.teams);
  const shares = teams.map(team => ({root: cursorCloudMemoryRoot(config.user, team), team}));
  const [firstShare] = shares;
  const teamsFile = yield* readTeamsFile(config);
  const checks: CursorCloudVerifyCheck[] = [
    {
      detail:
        system.platform === 'linux' ? 'Linux cloud runtime' : `${system.platform}; production Cursor Cloud uses Linux`,
      name: 'platform',
      status: system.platform === 'linux' ? 'ok' : 'warn',
    },
    {
      detail: (yield* fs.exists(config.agentContextHome)) ? 'initialized' : 'missing',
      name: 'Threadnote home',
      status: (yield* fs.exists(config.agentContextHome)) ? 'ok' : 'fail',
    },
  ];
  for (const team of teams) {
    const configured = teamsFile.teams[team];
    checks.push({
      detail: configured ? 'configured' : 'missing',
      name: `memory team ${team}`,
      status: configured ? 'ok' : 'fail',
    });
    if (configured) {
      checks.push(...(yield* configuredTeamChecks(fs, configured, team)));
    }
  }
  const cwdIsAbsolute = path.isAbsolute(options.cwd);
  const cwdExists = cwdIsAbsolute && (yield* fs.exists(options.cwd));
  checks.push({
    detail: cwdExists ? 'absolute checkout path exists' : 'expected an existing absolute checkout path',
    name: 'local graph checkout',
    status: cwdExists ? 'ok' : 'fail',
  });
  for (const share of shares) checks.push({detail: share.root, name: `memory root ${share.team}`, status: 'ok'});
  const receipt: CursorCloudVerifyReceiptV2 = {
    checks,
    memoryRoot: firstShare.root,
    memoryRoots: shares.map(share => share.root),
    profile: 'shared-read-write',
    provider: 'cursor-cloud',
    shares,
    status: checks.some(check => check.status === 'fail') ? 'fail' : 'ok',
    team: firstShare.team,
    teams,
    version: 2,
  };
  yield* printCursorCloudVerifyReceipt(receipt, options.json);
  if (receipt.status === 'fail') {
    throw CursorCloudOperationError.make({
      message: 'Cursor Cloud verification failed; resolve the failed checks above.',
    });
  }
});

export const cursorCloudRemoteHybridStatus = Effect.fn('cursorCloud.remoteHybridStatus')(function* (
  config: RuntimeConfig,
  options: {
    readonly cwd: string;
    readonly endpoint: string;
    readonly mode?: 'org' | 'remote-hybrid';
    readonly shareId?: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const graph = yield* CodeGraphQueryService;
  const environment = system.environment();
  const org = options.mode === 'org' || environment[CURSOR_CLOUD_MODE_ENV]?.trim() === 'org';
  const endpoint = org ? composerMcpUrl(options.endpoint) : cursorCloudMemoryEndpoint(options.endpoint);
  const environmentShareId = environment[CURSOR_CLOUD_MEMORY_SHARE_ID_ENV]?.trim();
  const shareId = requiredRemoteShareId(options.shareId ?? environmentShareId);
  const shareBindingMatches =
    environmentShareId === undefined || safeCursorCloudRemoteShareId(environmentShareId) === shareId;
  const cwdIsAbsolute = path.isAbsolute(options.cwd);
  const cwdExists = cwdIsAbsolute && (yield* fs.exists(options.cwd));
  const homeExists = yield* fs.exists(config.agentContextHome);
  const socket = environment.CURSOR_AGENT_SOCKET?.trim() || '/run/cursor/api.sock';
  const socketPresent = path.isAbsolute(socket) && (yield* fs.exists(socket));
  const checks: CursorCloudVerifyCheck[] = [
    {
      detail: homeExists ? 'initialized' : 'missing',
      name: 'Threadnote local home',
      plane: 'local-graph',
      status: homeExists ? 'ok' : 'fail',
    },
    {
      detail: cwdExists ? 'absolute checkout path exists' : 'expected an existing absolute checkout path',
      name: 'local graph checkout',
      plane: 'local-graph',
      status: cwdExists ? 'ok' : 'fail',
    },
    {
      detail: system.platform === 'linux' ? 'Linux cloud runtime' : 'production Cursor Cloud uses Linux',
      name: 'platform',
      plane: 'local-graph',
      status: system.platform === 'linux' ? 'ok' : 'warn',
    },
    {
      detail: socketPresent
        ? 'Cursor workload identity socket is available'
        : org
          ? 'attestation socket not present; required for Cloud contribution'
          : 'optional attestation socket not present',
      name: 'workload attestation',
      plane: 'local-graph',
      status: socketPresent ? 'ok' : 'warn',
    },
  ];
  if (homeExists && cwdExists) {
    checks.push(
      yield* graph.status(config.agentContextHome, options.cwd, {requestMaintenance: false}).pipe(
        Effect.map(status => ({
          detail:
            status.readySnapshot === undefined
              ? 'not indexed yet; ordinary graph reads return no-ready; run threadnote graph index explicitly'
              : status.stale
                ? 'a ready snapshot exists but is stale'
                : `ready snapshot ${status.readySnapshot.id}`,
          name: 'local graph readiness',
          plane: 'local-graph' as const,
          status: status.readySnapshot !== undefined && !status.stale ? ('ok' as const) : ('warn' as const),
        })),
        Effect.orElseSucceed(() => ({
          detail: 'graph status could not resolve this checkout',
          name: 'local graph readiness',
          plane: 'local-graph' as const,
          status: 'fail' as const,
        })),
      ),
    );
  }
  checks.push(
    {
      detail: endpoint,
      name: org ? 'organization composer MCP endpoint' : 'managed MCP endpoint',
      plane: 'remote-memory',
      status: 'ok',
    },
    {
      detail: shareBindingMatches
        ? `bound to remote memory share ${shareId}`
        : 'the active local adapter environment does not match the requested remote memory share',
      name: 'managed share binding',
      plane: 'remote-memory',
      status: shareBindingMatches ? 'ok' : 'fail',
    },
    {
      detail: org
        ? 'Organization IdP OAuth is discovered from composer protected-resource metadata and was not probed'
        : 'OAuth is owned by Cursor and must be confirmed in Dashboard MCP status',
      name: org ? 'composer OAuth' : 'remote OAuth',
      plane: 'remote-memory',
      status: 'warn',
    },
    {
      detail: org
        ? 'Git-backed composer is canonical; Postgres bodies are not the organization memory store'
        : 'local personal and Git-backed memory are not registered',
      name: 'memory fallback',
      plane: 'remote-memory',
      status: 'ok',
    },
  );
  const status = checks.some(check => check.status === 'fail') ? ('fail' as const) : ('ok' as const);
  if (org) {
    return {
      ...ORG_CLOUD_POLICY,
      checks,
      endpoint,
      localMemoryFallback: 'disabled',
      mode: 'org',
      provider: 'cursor-cloud',
      shareId,
      status,
      stdioGitShare: false,
      version: 1,
    } satisfies OrgCloudHybridVerifyReceiptV1;
  }
  return {
    checks,
    endpoint,
    localMemoryFallback: 'disabled',
    mode: 'remote-hybrid',
    provider: 'cursor-cloud',
    shareId,
    status,
    version: 1,
  } satisfies CursorCloudRemoteHybridVerifyReceiptV1;
});

const runCursorCloudRemoteHybridBootstrap = Effect.fn('cursorCloud.remoteHybridBootstrap')(function* (
  config: RuntimeConfig,
  options: {
    readonly cwd: string;
    readonly dryRun?: boolean;
    readonly endpoint: string;
    readonly mode: 'org' | 'remote-hybrid';
    readonly shareId: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (options.mode === 'org') composerMcpUrl(options.endpoint);
  else cursorCloudMemoryEndpoint(options.endpoint);
  const shareId = cursorCloudRemoteShareId(options.shareId);
  if (!path.isAbsolute(options.cwd) || !(yield* fs.exists(options.cwd))) {
    throw CursorCloudOperationError.make({
      message: 'Cursor Cloud remote-hybrid bootstrap requires --cwd to be an existing absolute checkout path.',
    });
  }
  if (options.dryRun === true) {
    yield* Console.log('Dry run complete; no local or remote memory state was changed.');
  } else {
    yield* fs.makeDirectory(config.agentContextHome, {recursive: true, mode: 0o700});
  }
  if (options.mode === 'org') {
    yield* Console.log('Organization cloud hybrid local graph adapter is ready; indexing starts on demand.');
    yield* Console.log(`Git-backed composer memory is bound exclusively to share ${shareId}.`);
    yield* Console.log(
      'Cloud durable contribution requires Cursor workload attestation; local Git memory share was not configured.',
    );
    return;
  }
  yield* Console.log('Cursor Cloud remote-hybrid local graph adapter is ready; indexing starts on demand.');
  yield* Console.log(`Managed remote memory is bound exclusively to share ${shareId}.`);
  yield* Console.log('Managed remote memory remains exclusive; no local Git memory share was configured.');
});

const printCursorCloudVerifyReceipt = Effect.fn('cursorCloud.printVerifyReceipt')(function* (
  receipt: CursorCloudVerifyReceiptV2 | CursorCloudRemoteHybridVerifyReceiptV1 | OrgCloudHybridVerifyReceiptV1,
  json?: boolean,
) {
  if (json === true) {
    yield* Console.log(JSON.stringify(receipt));
    return;
  }
  yield* Console.log('Cursor Cloud verification');
  for (const check of receipt.checks) {
    const plane = check.plane ? ` [${check.plane}]` : '';
    yield* Console.log(`${check.status.toUpperCase()}${plane} ${check.name}: ${check.detail}`);
  }
  yield* Console.log(`Status: ${receipt.status}`);
});

function requiredHybridEndpoint(endpoint: string | undefined, mode: 'org' | 'remote-hybrid'): string {
  if (!endpoint?.trim()) {
    throw CursorCloudOperationError.make({
      message:
        mode === 'org'
          ? 'Organization cloud hybrid mode requires --endpoint.'
          : 'Cursor Cloud remote-hybrid mode requires --endpoint.',
    });
  }
  return mode === 'org' ? composerMcpUrl(endpoint) : cursorCloudMemoryEndpoint(endpoint);
}

function requiredRemoteShareId(shareId: string | undefined): string {
  if (!shareId?.trim()) {
    throw CursorCloudOperationError.make({message: 'Cursor Cloud remote-hybrid mode requires --share-id.'});
  }
  return cursorCloudRemoteShareId(shareId);
}

function safeCursorCloudRemoteShareId(shareId: string): string | undefined {
  try {
    return cursorCloudRemoteShareId(shareId);
  } catch {
    return undefined;
  }
}

function requiredRemoteCheckout(cwd: string | undefined): string {
  if (!cwd?.trim()) {
    throw CursorCloudOperationError.make({message: 'Cursor Cloud remote-hybrid bootstrap requires --cwd.'});
  }
  return cwd;
}

function requiredIdentity(value: string, label: string): string {
  const normalized = uriSegment(value.trim());
  if (!value.trim() || normalized === 'unknown') {
    throw CursorCloudOperationError.make({message: `Cursor Cloud ${label} must contain a portable identifier.`});
  }
  return normalized;
}

function cursorCloudDefaultIdentity(
  configured: string,
  source: RuntimeConfig['userSource'] | RuntimeConfig['agentIdSource'],
): string {
  return source === 'cursor-cloud-profile' || source === 'environment' ? configured : DEFAULT_CURSOR_CLOUD_IDENTITY;
}

function assertEquivalentWritableTeam(existing: ShareTeamConfig, remote: string, team: string, provider: string): void {
  if (existing.remote.trim() !== remote) {
    throw CursorCloudOperationError.make({
      message: `${provider} memory team "${team}" already uses a different remote. Review it with threadnote share status before changing configuration.`,
    });
  }
  if (shareTeamAccess(existing) !== 'read-write') {
    throw CursorCloudOperationError.make({
      message: `${provider} memory team "${team}" is not read-write. Change it explicitly with threadnote share set-access before retrying.`,
    });
  }
}

export const configuredTeamChecks = Effect.fn('cursorCloud.configuredTeamChecks')(function* (
  fs: FileSystem.FileSystem,
  configured: ShareTeamConfig,
  team: string,
) {
  const remoteStatus = yield* Effect.try({
    try: () => credentialFreeGitRemote(configured.remote),
    catch: cause => CursorCloudOperationError.make({cause, message: 'Cursor Cloud Git remote validation failed.'}),
  }).pipe(
    Effect.as('ok' as const),
    Effect.orElseSucceed(() => 'fail' as const),
  );
  return [
    {
      detail: shareTeamAccess(configured),
      name: `share access ${team}`,
      status: shareTeamAccess(configured) === 'read-write' ? ('ok' as const) : ('fail' as const),
    },
    {
      detail: remoteStatus === 'ok' ? 'credential-free remote' : 'remote contains credentials or is invalid',
      name: `Git remote ${team}`,
      status: remoteStatus,
    },
    {
      detail: (yield* fs.exists(configured.worktree)) ? 'present' : 'missing',
      name: `share worktree ${team}`,
      status: (yield* fs.exists(configured.worktree)) ? ('ok' as const) : ('fail' as const),
    },
    {
      detail: (yield* fs.exists(configured.gitdir)) ? 'present' : 'missing',
      name: `share gitdir ${team}`,
      status: (yield* fs.exists(configured.gitdir)) ? ('ok' as const) : ('fail' as const),
    },
  ] satisfies readonly CursorCloudVerifyCheck[];
});

function cursorCloudTeamsFromEnvironment(environment: Readonly<Record<string, string | undefined>>): readonly string[] {
  const rawTeams = environment[CURSOR_CLOUD_TEAMS_ENV]?.trim();
  const rawTeam = environment[CURSOR_CLOUD_TEAM_ENV]?.trim();
  if (!rawTeams && !rawTeam) {
    throw CursorCloudOperationError.make({
      message: `${CURSOR_CLOUD_TEAM_ENV} or ${CURSOR_CLOUD_TEAMS_ENV} is required by the Personal Cursor Cloud toolset.`,
    });
  }
  let decoded: unknown;
  if (rawTeams) {
    try {
      decoded = JSON.parse(rawTeams);
    } catch {
      throw CursorCloudOperationError.make({message: `${CURSOR_CLOUD_TEAMS_ENV} must be a JSON array of share names.`});
    }
    if (!Array.isArray(decoded) || decoded.some(team => typeof team !== 'string')) {
      throw CursorCloudOperationError.make({message: `${CURSOR_CLOUD_TEAMS_ENV} must be a JSON array of share names.`});
    }
  } else {
    return normalizeCursorCloudTeams(rawTeam);
  }
  const teams = normalizeCursorCloudTeams(decoded as readonly string[] | undefined);
  if (rawTeam && !teams.includes(normalizeTeamName(rawTeam))) {
    throw CursorCloudOperationError.make({
      message: `${CURSOR_CLOUD_TEAM_ENV} must name one of the shares in ${CURSOR_CLOUD_TEAMS_ENV}.`,
    });
  }
  return teams;
}
