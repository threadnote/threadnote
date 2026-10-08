import {Cause, Data, Effect, Redacted, Schema} from 'effect';
import type {LinearSource, ResolvedLinearSelection} from '@threadnote/manager/integrations-contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ManagerProcessApiRequest} from '../../manager/processes.js';
import {captureConsole} from '../../effect/console.js';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireLinearSource,
  sourceConfigurationFingerprint,
  upsertLinearSource,
  validateObsidianIdentifier,
} from '../config.js';
import {withSourceLock} from '../lock.js';
import {createLinearClient, linearIssueInScope, type LinearClientOptions} from './client.js';
import {linearUuid, validateLinearSourceConfig, type LinearSourceConfig} from './config.js';
import {linearCredentialConfigured, resolveLinearCredential, validLinearApiToken} from './credentials.js';
import {LINEAR_COVERAGE} from './render.js';
import {receipt, saveReceipt} from './storage.js';
import {call} from './sync.js';
import {
  LinearSourceConflictError,
  runLinearSourceAdd,
  runLinearSourceInventory,
  runLinearSourceRemove,
  runLinearSourceSync,
} from './source.js';
class ManagerLinearError extends Data.TaggedError('ManagerLinearError')<{
  readonly status: number;
  readonly message: string;
}> {}
function invalid(message: string): never {
  throw new ManagerLinearError({status: 400, message});
}
function id(value: unknown): string {
  if (typeof value !== 'string') return invalid('Choose a valid source name.');
  try {
    return validateObsidianIdentifier(value, 'source name');
  } catch {
    return invalid('Choose a valid source name.');
  }
}
function env(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value))
    return invalid('Choose a valid credential environment variable.');
  return value;
}
function ids(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid('Choose explicit UUID scope IDs.');
  try {
    return value.map(linearUuid);
  } catch {
    return invalid('Choose explicit UUID scope IDs.');
  }
}
function checkedUuid(value: unknown): string {
  try {
    return linearUuid(value);
  } catch {
    return invalid('Choose verified organization and principal UUIDs.');
  }
}
const existingSource = Effect.fn('manager.linearExisting')(function* (config: RuntimeConfig, sourceId: string) {
  const s = (yield* readSourceConfiguration(config)).sources.find(x => x.id === sourceId);
  if (s && s.type !== 'linear')
    return yield* new ManagerLinearError({status: 409, message: 'Another connection uses this source name.'});
  return s;
});
export const resolveLinearSelection = Effect.fn('manager.linearResolve')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
  options: LinearClientOptions = {},
) {
  const sourceId = body.id === undefined ? 'manager-resolver' : id(body.id);
  const existing = yield* existingSource(config, sourceId);
  const environment = env(body.credentialEnv);
  const provided = typeof body.token === 'string' && body.token.length ? Redacted.make(body.token) : undefined;
  if (provided && environment) invalid('Choose an API key or an environment credential.');
  if (provided && !validLinearApiToken(provided)) invalid('Provide a valid API key.');
  const token =
    provided ??
    (yield* resolveLinearCredential(
      config,
      environment
        ? {id: sourceId, credentialEnv: environment}
        : (existing ?? {id: sourceId, credentialEnv: 'THREADNOTE_LINEAR_API_KEY'}),
    ));
  const teamIds = ids(body.teamIds, 64);
  const projectIds = ids(body.projectIds ?? [], 64);
  const issueIds = ids(body.issueIds ?? [], 256);
  if (teamIds.length === 0 || projectIds.length + issueIds.length === 0)
    invalid('Select allowed teams and at least one project or issue.');
  const client = createLinearClient(token, options);
  return yield* Effect.gen(function* () {
    const identity = yield* call(() => client.identity());
    if (
      (body.organizationId !== undefined &&
        body.organizationId !== '' &&
        body.organizationId !== identity.organizationId) ||
      (body.principalId !== undefined && body.principalId !== '' && body.principalId !== identity.principalId)
    )
      invalid('Credential identity does not match this connection.');
    const source: LinearSourceConfig = validateLinearSourceConfig({
      type: 'linear',
      id: sourceId,
      enabled: true,
      ...identity,
      teamIds,
      projectIds,
      issueIds,
      project: 'selection-preview',
      credentialEnv: environment ?? 'THREADNOTE_LINEAR_API_KEY',
      refreshIntervalMinutes: 60,
      maxStaleHours: 24,
    });
    const teams: ResolvedLinearSelection['teams'][number][] = [];
    for (const teamId of teamIds) {
      const team = yield* call(() => client.team(teamId));
      if (team.organizationId !== identity.organizationId) invalid('Selected team belongs to another organization.');
      teams.push({id: team.id, name: team.name});
    }
    const projects: ResolvedLinearSelection['projects'][number][] = [];
    for (const projectId of projectIds) {
      const project = yield* call(() => client.projectDetail(projectId));
      projects.push({id: project.id, name: project.name});
    }
    const issues: ResolvedLinearSelection['issues'][number][] = [];
    for (const issueId of issueIds) {
      const issue = yield* call(() => client.issueDetail(issueId));
      if (!linearIssueInScope(source, issue)) invalid('Selected issue is outside allowed teams.');
      issues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        teamId: issue.team.id,
        ...(issue.project ? {projectId: issue.project.id} : {}),
      });
    }
    return {...identity, teams, projects, issues} satisfies ResolvedLinearSelection;
  }).pipe(Effect.ensuring(Effect.sync(() => client.close())));
});
export const listLinearIntegrations = Effect.fn('manager.linearList')(function* (config: RuntimeConfig) {
  const sources: LinearSource[] = [];
  for (const source of (yield* readSourceConfiguration(config)).sources) {
    if (source.type !== 'linear') continue;
    const credentialConfigured = yield* linearCredentialConfigured(config, source);
    const inventory = yield* runLinearSourceInventory(config, source.id);
    const access = yield* receipt(config, source.id);
    const active = inventory.entries.filter(e => e.status === 'active');
    sources.push({
      ...source,
      credentialConfigured,
      status:
        !source.enabled ||
        !credentialConfigured ||
        access === null ||
        access?.status === 'authentication-rejected' ||
        inventory.entries.some(e => e.status === 'pending' || e.status === 'quarantined' || e.status === 'stale')
          ? 'needs-attention'
          : access?.completedAt !== undefined && !inventory.progress
            ? 'active'
            : 'needs-sync',
      issues: active.filter(e => e.documentId.startsWith('issue-')).length,
      documents: active.filter(e => e.documentId.startsWith('document-')).length,
      updates: active.filter(e => e.documentId.startsWith('update-')).length,
      chunks: active.reduce((n, e) => n + e.chunks, 0),
      coverage: LINEAR_COVERAGE,
      ...(access?.completedAt === undefined ? {} : {lastSyncedAt: access.completedAt}),
      ...(access?.nextAttemptAt === undefined ? {} : {nextAttemptAt: access.nextAttemptAt}),
      ...(inventory.progress ? {progress: inventory.progress} : {}),
    });
  }
  return {sources};
});
const route = Effect.fn('manager.linearRoute')(function* (request: ManagerProcessApiRequest) {
  if (request.url.pathname !== '/api/integrations/linear') return undefined;
  if (request.method === 'GET') return {status: 200, body: yield* listLinearIntegrations(request.config)};
  if (request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
  const body = yield* request.body;
  if (body.action === 'resolve-selection')
    return {status: 200, body: yield* resolveLinearSelection(request.config, body)};
  const sourceId = id(body.id);
  const apply = body.apply === true;
  if (apply && body.confirm !== true) invalid('Confirm this Linear action.');
  const result = yield* captureConsole(
    Effect.gen(function* () {
      switch (body.action) {
        case 'save-source': {
          const existing = yield* existingSource(request.config, sourceId);
          if (!!existing !== (body.editing === true))
            return yield* new ManagerLinearError({
              status: 409,
              message: 'This connection changed. Refresh connections before saving.',
            });
          const token = typeof body.token === 'string' && body.token.length ? Redacted.make(body.token) : undefined;
          const environment = env(body.credentialEnv);
          if (token && environment) invalid('Choose an API key or environment credential.');
          if (!existing && !token && !environment) invalid('Provide an API key or environment credential.');
          if (typeof body.project !== 'string') invalid('Choose one local project.');
          if (!Number.isSafeInteger(body.refreshIntervalMinutes) || !Number.isSafeInteger(body.maxStaleHours))
            invalid('Choose valid freshness settings.');
          yield* runLinearSourceAdd(request.config, {
            id: sourceId,
            apply,
            organizationId: checkedUuid(body.organizationId),
            principalId: checkedUuid(body.principalId),
            teamIds: ids(body.teamIds, 64),
            projectIds: ids(body.projectIds ?? [], 64),
            issueIds: ids(body.issueIds ?? [], 256),
            project: body.project,
            apiToken: token,
            credentialEnv: environment ?? existing?.credentialEnv,
            credentialStorage: token || (!environment && existing?.credentialStorage === 'local') ? 'local' : undefined,
            enabled: existing?.enabled ?? true,
            refreshIntervalMinutes: body.refreshIntervalMinutes as number,
            maxStaleHours: body.maxStaleHours as number,
            expectedFingerprint: existing ? sourceConfigurationFingerprint(existing) : null,
          });
          return {
            output: apply
              ? 'Linear connection saved. Refresh to import selected evidence.'
              : 'Linear connection is ready to save.',
          };
        }
        case 'sync-source': {
          const result = yield* runLinearSourceSync(request.config, {id: sourceId, apply});
          return {
            output: apply
              ? `${result.syncedDocuments.length} Linear objects refreshed.`
              : 'Linear source is ready to refresh.',
            warnings: result.warnings,
          };
        }
        case 'set-enabled': {
          if (typeof body.enabled !== 'boolean') invalid('Choose whether the source is enabled.');
          const enabled = body.enabled;
          if (apply)
            yield* withSourceLock(
              request.config,
              sourceId,
              Effect.gen(function* () {
                const source = requireLinearSource(yield* readSourceConfiguration(request.config), sourceId);
                const access = yield* receipt(request.config, sourceId);
                if (!enabled && access)
                  yield* saveReceipt(request.config, source, {...access, status: 'authentication-rejected'}, false);
                yield* mutateSourceConfiguration(request.config, current =>
                  upsertLinearSource(current, {...requireLinearSource(current, sourceId), enabled}),
                );
              }),
            );
          else
            upsertLinearSource(yield* readSourceConfiguration(request.config), {
              ...requireLinearSource(yield* readSourceConfiguration(request.config), sourceId),
              enabled,
            });
          return {output: apply ? 'Linear connection updated.' : 'Linear connection update is ready.'};
        }
        case 'remove-source':
          yield* runLinearSourceRemove(request.config, {id: sourceId, apply});
          return {output: apply ? 'Linear connection removed.' : 'Linear connection is ready to remove.'};
        default:
          return invalid('Unknown Linear action.');
      }
    }),
  );
  return {status: 200, body: {applied: apply, entries: [], ...result.value}};
});
export const handleManagerLinearIntegrationRequest = (request: ManagerProcessApiRequest) =>
  route(request).pipe(
    Effect.catchCause(cause => {
      const error = Cause.squash(cause);
      if (error instanceof ManagerLinearError)
        return Effect.succeed({status: error.status, body: {error: error.message}});
      if (Schema.is(LinearSourceConflictError)(error))
        return Effect.succeed({
          status: 409,
          body: {error: 'This connection changed. Refresh connections before saving.'},
        });
      return Effect.succeed({
        status: 409,
        body: {error: 'Linear action could not complete. Check credential, explicit scope and provider availability.'},
      });
    }),
  );
