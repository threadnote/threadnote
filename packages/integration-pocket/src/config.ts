import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  requiredIdentifier,
  portableIdentifier,
  positiveInteger,
  requiredString,
  optionalBoolean,
  SourceConfigurationError,
  CREDENTIAL_ENV_PATTERN,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';
export {validateSourceIdentifier} from '@threadnote/integration-core/config';
export interface PocketSourceConfig {
  readonly type: 'pocket';
  readonly id: string;
  readonly enabled: boolean;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly project: string | null;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
}
export const DEFAULT_POCKET_CREDENTIAL_ENV = 'POCKET_API_KEY';
export function upsertPocketSource(
  configuration: SourceConfiguration,
  source: PocketSourceConfig,
): SourceConfiguration {
  const checked = validatePocketSourceConfig(source);
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
export function requirePocketSource(configuration: SourceConfiguration, id: string): PocketSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source || !isPocketSource(source))
    throw SourceConfigurationError.make({message: `No Pocket source named "${id}".`});
  return source;
}
export function validatePocketSourceConfig(source: PocketSourceConfig): PocketSourceConfig {
  return parsePocketSource(
    {
      id: source.id,
      type: source.type,
      enabled: source.enabled,
      credential_env: source.credentialEnv,
      credential_storage: source.credentialStorage,
      project: source.project,
      refresh_interval_minutes: source.refreshIntervalMinutes,
      max_stale_hours: source.maxStaleHours,
    },
    'pocket source',
  );
}
export function parsePocketSource(value: Record<string, unknown>, label: string): PocketSourceConfig {
  const id = portableIdentifier(requiredIdentifier(value.id, `${label}.id`), `${label}.id`);
  const credentialEnv =
    value.credential_env === undefined
      ? DEFAULT_POCKET_CREDENTIAL_ENV
      : requiredString(value.credential_env, `${label}.credential_env`);
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv))
    throw SourceConfigurationError.make({message: `${label}.credential_env must be an environment variable name.`});
  if (value.credential_storage !== undefined && value.credential_storage !== 'local')
    throw SourceConfigurationError.make({message: `${label}.credential_storage must be "local" when present.`});
  const project = value.project === null ? null : requiredIdentifier(value.project, `${label}.project`);
  return {
    type: 'pocket',
    id,
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    credentialEnv,
    ...(value.credential_storage === 'local' ? {credentialStorage: 'local' as const} : {}),
    project,
    refreshIntervalMinutes: positiveInteger(
      value.refresh_interval_minutes,
      15,
      10_080,
      `${label}.refresh_interval_minutes`,
    ),
    maxStaleHours: positiveInteger(value.max_stale_hours, 24, 8_760, `${label}.max_stale_hours`),
  };
}

export function isPocketSource(source: SourceConfig): source is PocketSourceConfig {
  return source.type === 'pocket';
}

export function sourceConfigurationFingerprint(source: PocketSourceConfig): string {
  return sha256HexSync(
    JSON.stringify({
      type: source.type,
      id: source.id,
      enabled: source.enabled,
      credentialEnv: source.credentialEnv,
      credentialStorage: source.credentialStorage ?? null,
      project: source.project,
      refreshIntervalMinutes: source.refreshIntervalMinutes,
      maxStaleHours: source.maxStaleHours,
    }),
  );
}

export {
  readSourceConfiguration,
  writeSourceConfiguration,
  mutateSourceConfiguration,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';

export function serializePocketSource(source: PocketSourceConfig) {
  return {
    id: source.id,
    type: source.type,
    enabled: source.enabled,
    credential_env: source.credentialEnv,
    ...(source.credentialStorage === undefined ? {} : {credential_storage: source.credentialStorage}),
    project: source.project,
    refresh_interval_minutes: source.refreshIntervalMinutes,
    max_stale_hours: source.maxStaleHours,
  };
}
export const pocketSourceCodec = {
  type: 'pocket' as const,
  versions: [2] as const,
  parse: parsePocketSource,
  serialize: serializePocketSource,
};
