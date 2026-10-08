import {Cause, Data, Effect, Redacted, Schema} from 'effect';
import type {IntegrationResult, GitHubSource} from '@threadnote/manager/integrations-contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readExternalSourceReceipt} from '@threadnote/store/external-resource';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireGitHubSource,
  sourceConfigurationFingerprint,
  upsertGitHubSource,
  validateObsidianIdentifier,
  type GitHubSourceConfig,
} from '../config.js';
import {captureConsole} from '../../effect/console.js';
import {withSourceLock} from '../lock.js';
import {GitHubCredentialError, githubCredentialConfigured, resolveGitHubCredential} from './credentials.js';
import {
  runGitHubSourceAdd,
  runGitHubSourceInventory,
  runGitHubSourceRemove,
  runGitHubSourceSync,
  GitHubSourceConflictError,
} from './source.js';
import type {ManagerProcessApiRequest} from '../../manager/processes.js';

class ManagerGitHubError extends Data.TaggedError('ManagerGitHubError')<{
  readonly status: number;
  readonly message: string;
}> {}

function invalid(message: string): never {
  throw new ManagerGitHubError({status: 400, message});
}

function conflict(message: string): never {
  throw new ManagerGitHubError({status: 409, message});
}

function sourceId(value: unknown): string {
  if (typeof value !== 'string') invalid('Choose a valid source name.');
  try {
    return validateObsidianIdentifier(value, 'source name');
  } catch {
    return invalid('Choose a valid source name.');
  }
}

function credentialEnv(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value))
    invalid('Choose a valid credential environment variable name.');
  return value;
}

function environmentToken(config: RuntimeConfig, name: string) {
  const source: GitHubSourceConfig = {
    type: 'github',
    repositories: ['owner/repository'],
    id: 'manager-resolver',
    enabled: true,
    credentialEnv: name,
    project: null,
    refreshIntervalMinutes: 15,
    maxStaleHours: 24,
  };
  return resolveGitHubCredential(config, source).pipe(
    Effect.mapError(
      () => new ManagerGitHubError({status: 400, message: 'The selected environment credential is unavailable.'}),
    ),
  );
}

function safeErrorResponse(error: unknown) {
  if (Schema.is(GitHubSourceConflictError)(error))
    return {status: 409, body: {error: 'This connection changed. Refresh connections before saving.'}};
  if (Schema.is(GitHubCredentialError)(error)) return {status: 409, body: {error: error.message}};
  if (error instanceof ManagerGitHubError) return {status: error.status, body: {error: error.message}};
  return {status: 409, body: {error: 'The GitHub connection could not complete this action.'}};
}

export const listGitHubIntegrations = Effect.fn('manager.githubList')(function* (config: RuntimeConfig) {
  const configuration = yield* readSourceConfiguration(config);
  const sources: GitHubSource[] = [];
  for (const source of configuration.sources) {
    if (source.type !== 'github') continue;
    const credentialConfigured = yield* githubCredentialConfigured(config, source);
    const inventory = yield* runGitHubSourceInventory(config, source.id);
    const entries = inventory.entries;
    const active = entries.filter(entry => entry.status === 'active');
    const attention =
      entries.some(
        entry => entry.status === 'quarantined' || entry.status === 'pending' || entry.nextAttemptAt !== undefined,
      ) || inventory.repositories?.some(r => r.status === 'pending');
    const receipt = yield* readExternalSourceReceipt(
      {account: config.account, home: config.agentContextHome, user: config.user},
      source.id,
      'github',
    );
    const nextAttemptAt = entries.reduce<number | undefined>(
      (time, entry) => (entry.nextAttemptAt === undefined ? time : Math.max(time ?? 0, entry.nextAttemptAt)),
      inventory.nextAttemptAt,
    );
    sources.push({
      id: source.id,
      repositories: source.repositories,
      enabled: source.enabled,
      project: source.project,
      credentialEnv: source.credentialEnv,
      ...(source.credentialStorage === undefined ? {} : {credentialStorage: source.credentialStorage}),
      credentialConfigured,
      refreshIntervalMinutes: source.refreshIntervalMinutes,
      maxStaleHours: source.maxStaleHours,
      status:
        !credentialConfigured || attention || receipt?.status === 'authentication-rejected'
          ? 'needs-attention'
          : receipt?.completedAt &&
              !inventory.progress &&
              active.length === entries.length &&
              inventory.repositories?.length === source.repositories.length &&
              inventory.repositories.every(r => r.status === 'active' && r.backfillComplete)
            ? 'active'
            : 'needs-sync',
      conversations: active.filter(entry => entry.documentId.startsWith('r-')).length,
      chunks: active.reduce((count, entry) => count + entry.chunks, 0),
      ...(receipt?.completedAt === undefined ? {} : {lastSyncedAt: receipt.completedAt}),
      ...(inventory.progress === undefined ? {} : {progress: inventory.progress}),
      ...(inventory.lastReconciledAt === undefined ? {} : {lastReconciledAt: inventory.lastReconciledAt}),
      ...(nextAttemptAt === undefined ? {} : {nextAttemptAt}),
    });
  }
  return {sources};
});

const route = Effect.fn('manager.githubRoute')(function* (request: ManagerProcessApiRequest) {
  if (request.url.pathname !== '/api/integrations/github') return undefined;
  if (request.method === 'GET') return {status: 200, body: yield* listGitHubIntegrations(request.config)};
  if (request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
  const body = yield* request.body;
  if (typeof body.action !== 'string') invalid('Choose a GitHub action.');
  const id = sourceId(body.id);
  const apply = body.apply === true;
  if (apply && body.confirm !== true) invalid('Confirm this GitHub action.');
  const result = yield* captureConsole(
    Effect.gen(function* () {
      switch (body.action) {
        case 'save-source': {
          const configuration = yield* readSourceConfiguration(request.config);
          const existing = configuration.sources.find(source => source.id === id);
          if (existing && existing.type !== 'github') conflict('Another connection already uses this name.');
          if (!!existing !== (body.editing === true))
            conflict(existing ? 'Open this source to edit it.' : 'This source no longer exists. Refresh connections.');
          const token = typeof body.token === 'string' && body.token.length > 0 ? Redacted.make(body.token) : undefined;
          const env = credentialEnv(body.credentialEnv);
          if (token && env) invalid('Choose a key or an environment credential.');
          if (!existing && !token && !env) invalid('Provide a GitHub API key or environment credential.');
          if (env) yield* environmentToken(request.config, env);
          if (body.project !== null && typeof body.project !== 'string')
            invalid('Choose a project or projectless source.');
          if (!Number.isSafeInteger(body.refreshIntervalMinutes) || !Number.isSafeInteger(body.maxStaleHours))
            invalid('Choose valid GitHub source settings.');
          if (
            !Array.isArray(body.repositories) ||
            !body.repositories.every((item: unknown) => typeof item === 'string')
          )
            invalid('Choose valid GitHub repositories.');
          yield* runGitHubSourceAdd(request.config, {
            id,
            repositories: body.repositories,
            apply,
            project: body.project ?? undefined,
            projectless: body.project === null,
            refreshIntervalMinutes: body.refreshIntervalMinutes as number,
            maxStaleHours: body.maxStaleHours as number,
            credentialEnv: env ?? (existing?.type === 'github' ? existing.credentialEnv : undefined),
            credentialStorage:
              token || (env === undefined && existing?.type === 'github' && existing.credentialStorage === 'local')
                ? 'local'
                : undefined,
            apiToken: token,
            enabled: existing?.type === 'github' ? existing.enabled : true,
            expectedFingerprint: existing?.type === 'github' ? sourceConfigurationFingerprint(existing) : null,
          });
          if (!apply) return {output: 'GitHub source settings are ready to save.'};
          const synced = yield* runGitHubSourceSync(request.config, {id, apply: true}).pipe(
            Effect.catchCause(() => Effect.void),
          );
          if (!synced)
            return {
              output: 'GitHub connection saved. Initial sync needs attention.',
              warnings: ['Initial sync could not finish. Retry from the connection.'],
            };
          return {
            output: `GitHub connection saved. ${synced.syncedDocuments.length} conversation(s) refreshed.`,
            warnings: synced.warnings.map(() => 'A conversation could not be refreshed.'),
          };
        }
        case 'sync-source': {
          const synced = yield* runGitHubSourceSync(request.config, {id, apply});
          return {
            output: apply
              ? `${synced.syncedDocuments.length} conversation(s) refreshed.`
              : 'GitHub source is ready to refresh.',
            warnings: synced.warnings.map(() => 'A conversation could not be refreshed.'),
          };
        }
        case 'set-enabled': {
          if (typeof body.enabled !== 'boolean') invalid('Choose whether this source is enabled.');
          const enabled = body.enabled;
          if (apply) {
            yield* withSourceLock(
              request.config,
              id,
              mutateSourceConfiguration(request.config, current =>
                upsertGitHubSource(current, {...requireGitHubSource(current, id), enabled}),
              ),
            );
          } else {
            const current = yield* readSourceConfiguration(request.config);
            upsertGitHubSource(current, {...requireGitHubSource(current, id), enabled});
          }
          return {output: apply ? 'GitHub source setting updated.' : 'GitHub source setting is ready to update.'};
        }
        case 'remove-source':
          yield* runGitHubSourceRemove(request.config, {id, apply});
          return {output: apply ? 'GitHub source removed.' : 'GitHub source is ready to remove.'};
        default:
          return invalid('Unknown GitHub action.');
      }
    }),
  );
  const response: IntegrationResult = {applied: apply, entries: [], ...result.value};
  return {status: 200, body: response};
});

export const handleManagerGitHubIntegrationRequest = (request: ManagerProcessApiRequest) =>
  route(request).pipe(Effect.catchCause(cause => Effect.succeed(safeErrorResponse(Cause.squash(cause)))));
