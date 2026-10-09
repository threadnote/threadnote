import {sha256HexSync} from '@threadnote/platform/sha256';

export interface LinearSourceConfig {
  readonly type: 'linear';
  readonly id: string;
  readonly enabled: boolean;
  readonly organizationId: string;
  readonly principalId: string;
  readonly teamIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly project: string;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
}
export const LINEAR_MAX_PROJECTS = 64;
export const LINEAR_MAX_COLLECTION_ITEMS = 2000;
export const LINEAR_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid = (): never => {
  throw new Error('Invalid Linear source configuration. Use UUID scope IDs and one local project.');
};
export function linearUuid(value: unknown): string {
  if (typeof value !== 'string' || !LINEAR_UUID.test(value)) return invalid();
  return value;
}
function ids(value: unknown, maximum: number, empty = true): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || (!empty && value.length === 0)) return invalid();
  const result = value.map(linearUuid).sort();
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function setting(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) return invalid();
  return value;
}
export function parseLinearSource(value: Record<string, unknown>): LinearSourceConfig {
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id)) return invalid();
  if (typeof value.project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.project)) return invalid();
  const credentialEnv = value.credential_env ?? 'THREADNOTE_LINEAR_API_KEY';
  if (typeof credentialEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)) return invalid();
  if (value.credential_storage !== undefined && value.credential_storage !== 'local') return invalid();
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return invalid();
  const projectIds = ids(value.project_ids ?? [], LINEAR_MAX_PROJECTS);
  const issueIds = ids(value.issue_ids ?? [], 256);
  if (projectIds.length + issueIds.length === 0) return invalid();
  return {
    type: 'linear',
    id: value.id,
    enabled: value.enabled !== false,
    organizationId: linearUuid(value.organization_id),
    principalId: linearUuid(value.principal_id),
    teamIds: ids(value.team_ids, 64, false),
    projectIds,
    issueIds,
    project: value.project,
    credentialEnv,
    ...(value.credential_storage === 'local' ? {credentialStorage: 'local' as const} : {}),
    refreshIntervalMinutes: setting(value.refresh_interval_minutes, 60, 10080),
    maxStaleHours: setting(value.max_stale_hours, 24, 8760),
  };
}
export function serializeLinearSource(source: LinearSourceConfig) {
  return {
    id: source.id,
    type: source.type,
    enabled: source.enabled,
    organization_id: source.organizationId,
    principal_id: source.principalId,
    team_ids: [...source.teamIds],
    project_ids: [...source.projectIds],
    issue_ids: [...source.issueIds],
    project: source.project,
    credential_env: source.credentialEnv,
    ...(source.credentialStorage === undefined ? {} : {credential_storage: source.credentialStorage}),
    refresh_interval_minutes: source.refreshIntervalMinutes,
    max_stale_hours: source.maxStaleHours,
  };
}
export const validateLinearSourceConfig = (source: LinearSourceConfig) =>
  parseLinearSource(serializeLinearSource(source));
export function linearConfigurationFingerprint(source: LinearSourceConfig): string {
  return sha256HexSync(
    JSON.stringify({
      ...serializeLinearSource(validateLinearSourceConfig(source)),
      policy: 'linear-read-v1-threads-native-text-no-inline-no-update-comments',
    }),
  );
}

import {
  SourceConfigurationError,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';
export {validateSourceIdentifier} from '@threadnote/integration-core/config';
export function upsertLinearSource(
  configuration: SourceConfiguration,
  source: LinearSourceConfig,
): SourceConfiguration {
  const checked = validateLinearSourceConfig(source);
  if (configuration.sources.some(item => item.id === checked.id && item.type !== checked.type))
    throw SourceConfigurationError.make({message: `Source "${checked.id}" already has another type.`});
  return {
    version: 2,
    projections: configuration.projections,
    sources: [...configuration.sources.filter(item => item.id !== checked.id), checked].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
}
export function requireLinearSource(configuration: SourceConfiguration, id: string): LinearSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source || !isLinearSource(source))
    throw SourceConfigurationError.make({message: `No Linear source named "${id}".`});
  return source;
}

export function isLinearSource(source: SourceConfig): source is LinearSourceConfig {
  return source.type === 'linear';
}

export const sourceConfigurationFingerprint = linearConfigurationFingerprint;

export {
  readSourceConfiguration,
  writeSourceConfiguration,
  mutateSourceConfiguration,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';

export const linearSourceCodec = {
  type: 'linear' as const,
  versions: [2] as const,
  parse: parseLinearSource,
  serialize: serializeLinearSource,
};
