import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  requireConfirm,
  requireString,
  requireStringArray,
  optionalString,
} from '@threadnote/integration-core/manager-inputs';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import {
  readObsidianConfiguration,
  mutateSourceConfiguration,
  isObsidianSource,
  isObsidianProjection,
  type ObsidianProjectionConfig,
  requireObsidianSource,
  requireObsidianProjection,
  upsertObsidianSource,
  upsertObsidianProjection,
  type SourceConfiguration,
} from './config.js';
import {runObsidianSourceAdd, runObsidianSourceSync, runObsidianSourceRemove} from './source.js';
import {runObsidianProjectionAdd, runObsidianProjectionSync, runObsidianProjectionRemove} from './projection.js';
import {runObsidianInboxScan} from './inbox.js';
import {captureIntegrationConsole as captureConsole} from '@threadnote/integration-core/manager-http';
import type {ManagerIntegrationApiRequest} from '@threadnote/integration-core/manager-http';
import {integrationFeatureError} from '@threadnote/integration-core/manager-http';

export const listObsidianIntegrations = Effect.fn('manager.obsidianList')(function* (config: RuntimeConfig) {
  const configuration = yield* readObsidianConfiguration(config);
  return {
    sources: configuration.sources.filter(isObsidianSource),
    projections: configuration.projections.filter(isObsidianProjection),
  };
});

const routeManagerObsidianIntegration = Effect.fn('manager.obsidianIntegration')(function* (
  request: ManagerIntegrationApiRequest,
) {
  if (request.url.pathname !== '/api/integrations/obsidian') return undefined;
  if (request.method === 'GET') {
    const configuration = yield* readObsidianConfiguration(request.config);
    return {status: 200, body: {...configuration, sources: configuration.sources.filter(isObsidianSource)}};
  }
  if (request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
  const body = yield* request.body;
  const action = requireString(body.action, 'action');
  const id = requireString(body.id, 'connection name').trim().toLowerCase();
  const apply = body.apply === true;
  if (apply) requireConfirm(body);
  const config = request.config;
  const result = yield* captureConsole(
    Effect.gen(function* () {
      switch (action) {
        case 'save-source': {
          const current = yield* readObsidianConfiguration(config);
          const existing = current.sources.some(source => source.id === id)
            ? requireObsidianSource(current, id)
            : undefined;
          if (!!existing !== (body.editing === true))
            throw new Error(
              existing
                ? 'A vault source already uses this name. Open its settings to edit it.'
                : 'This vault source no longer exists. Refresh connections.',
            );
          yield* runObsidianSourceAdd(config, {
            apply,
            id,
            vault: existing?.vault ?? requireString(body.vault, 'vault path'),
            include: requireStringArray(body.include, 'include patterns'),
            exclude: stringList(body.exclude, 'exclude patterns'),
            inbox: optionalString(body.inbox),
          });
          return {};
        }
        case 'save-projection': {
          const current = yield* readObsidianConfiguration(config);
          const existing = current.projections.find(
            (projection): projection is ObsidianProjectionConfig =>
              isObsidianProjection(projection) && projection.id === id,
          );
          if (!!existing !== (body.editing === true))
            throw new Error(
              existing
                ? 'A memory export already uses this name. Open its settings to edit it.'
                : 'This memory export no longer exists. Refresh connections.',
            );
          const kinds = requireStringArray(body.kinds, 'memory kinds').map(kind => memoryKind(kind));
          const statuses = requireStringArray(body.statuses, 'statuses').map(status => memoryStatus(status));
          if (kinds.some(kind => !kind) || statuses.some(status => !status))
            throw new Error('Choose valid memory kinds and statuses.');
          const selection = body.selection;
          if (selection !== 'all' && selection !== 'selected')
            throw new Error('Choose all matching memories or selected memory URIs.');
          const selectedUris =
            selection === 'selected' ? requireStringArray(body.selectedUris, 'selected memory URIs') : null;
          yield* runObsidianProjectionAdd(config, {
            apply,
            id,
            vault: existing?.vault ?? requireString(body.vault, 'vault path'),
            folder: existing?.folder ?? requireString(body.folder, 'export folder'),
            includeShared: body.includeShared === true,
            kinds: kinds.filter(kind => kind !== undefined),
            statuses: statuses.filter(status => status !== undefined),
            selectedUris,
          });
          return {};
        }
        case 'set-enabled': {
          if (typeof body.enabled !== 'boolean' || !['source', 'projection'].includes(String(body.kind))) {
            throw new Error('Choose a connection and whether it is enabled.');
          }
          const enabled = body.enabled;
          const update = (current: SourceConfiguration) =>
            body.kind === 'source'
              ? upsertObsidianSource(current, {...requireObsidianSource(current, id), enabled})
              : upsertObsidianProjection(current, {...requireObsidianProjection(current, id), enabled});
          if (apply) yield* mutateSourceConfiguration(config, update);
          else update(yield* readObsidianConfiguration(config));
          return {};
        }
        case 'sync-source': {
          const inventory = yield* runObsidianSourceSync(config, {id, apply});
          return {entries: inventory.entries};
        }
        case 'sync-projection':
          return {entries: yield* runObsidianProjectionSync(config, {id, apply})};
        case 'remove-source':
          yield* runObsidianSourceRemove(config, {id, apply});
          return {};
        case 'remove-projection':
          yield* runObsidianProjectionRemove(config, {id, apply});
          return {};
        case 'scan-inbox':
          return {reviewCount: (yield* runObsidianInboxScan(config, {source: id, apply})).length};
        default:
          throw new Error('Unknown Obsidian action.');
      }
    }),
  );
  const response: IntegrationResult = {applied: apply, entries: [], ...result.value, output: result.output};
  return {status: 200, body: response};
});

export const handleManagerObsidianIntegrationRequest = (request: ManagerIntegrationApiRequest) =>
  routeManagerObsidianIntegration(request).pipe(Effect.catchCause(integrationFeatureError));

function stringList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string'))
    throw new Error('Provide ' + name + ' as a list.');
  return value;
}

function memoryKind(value: unknown) {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}
function memoryStatus(value: unknown) {
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded'
    ? value
    : undefined;
}
