import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  requiredIdentifier,
  requiredProviderId,
  portableIdentifier,
  providerIds,
  positiveInteger,
  requiredString,
  optionalBoolean,
  SourceConfigurationError,
  CREDENTIAL_ENV_PATTERN,
  isJsonObject,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';
export {validateSourceIdentifier} from '@threadnote/integration-core/config';
export interface SuperhumanDocumentConfig {
  readonly id: string;
  readonly pages?: readonly string[];
}
export interface SuperhumanSourceConfig {
  readonly type: 'superhuman';
  readonly id: string;
  readonly enabled: boolean;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly project: string | null;
  readonly documents: readonly SuperhumanDocumentConfig[];
  readonly includeHidden: boolean;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
}
export const DEFAULT_SUPERHUMAN_CREDENTIAL_ENV = 'SUPERHUMAN_DOCS_API_TOKEN';
export const DEFAULT_SUPERHUMAN_REFRESH_INTERVAL_MINUTES = 15;
export const DEFAULT_SUPERHUMAN_MAX_STALE_HOURS = 24;
export function upsertSuperhumanSource(
  configuration: SourceConfiguration,
  source: SuperhumanSourceConfig,
): SourceConfiguration {
  const checked = validateSuperhumanSourceConfig(source);
  if (configuration.sources.some(item => item.id === checked.id && item.type !== checked.type)) {
    throw SourceConfigurationError.make({message: `Source "${checked.id}" already has another type.`});
  }
  return {
    version: 2,
    projections: configuration.projections,
    sources: [...configuration.sources.filter(item => item.id !== checked.id), checked].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}
export function requireSuperhumanSource(configuration: SourceConfiguration, id: string): SuperhumanSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source || !isSuperhumanSource(source)) {
    throw SourceConfigurationError.make({message: `No Superhuman source named "${id}".`});
  }
  return source;
}
export function validateSuperhumanDocumentId(value: string): string {
  return requiredProviderId(value, 'document id');
}
export function validateSuperhumanPageId(value: string): string {
  return requiredProviderId(value, 'page id');
}
export function validateSuperhumanSourceConfig(source: SuperhumanSourceConfig): SuperhumanSourceConfig {
  return parseSuperhumanSource(
    {
      id: source.id,
      type: source.type,
      enabled: source.enabled,
      credential_env: source.credentialEnv,
      credential_storage: source.credentialStorage,
      project: source.project,
      documents: source.documents.map(document => ({id: document.id, pages: document.pages})),
      include_hidden: source.includeHidden,
      refresh_interval_minutes: source.refreshIntervalMinutes,
      max_stale_hours: source.maxStaleHours,
    },
    'superhuman source',
  );
}
export function parseSuperhumanSource(value: Record<string, unknown>, label: string): SuperhumanSourceConfig {
  const id = portableIdentifier(requiredIdentifier(value.id, `${label}.id`), `${label}.id`);
  const credentialEnv =
    value.credential_env === undefined
      ? DEFAULT_SUPERHUMAN_CREDENTIAL_ENV
      : requiredString(value.credential_env, `${label}.credential_env`);
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv)) {
    throw SourceConfigurationError.make({message: `${label}.credential_env must be an environment variable name.`});
  }
  if (value.credential_storage !== undefined && value.credential_storage !== 'local')
    throw SourceConfigurationError.make({message: `${label}.credential_storage must be "local" when present.`});
  const project = value.project === null ? null : requiredIdentifier(value.project, `${label}.project`);
  if (!Array.isArray(value.documents) || value.documents.length === 0 || value.documents.length > 64) {
    throw SourceConfigurationError.make({message: `${label}.documents must contain 1 to 64 documents.`});
  }
  const documents = value.documents.map((raw, index) => {
    const documentLabel = `${label}.documents[${index}]`;
    if (!isJsonObject(raw)) throw SourceConfigurationError.make({message: `${documentLabel} must be an object.`});
    const documentId = requiredProviderId(raw.id, `${documentLabel}.id`);
    const pages = raw.pages === undefined ? undefined : providerIds(raw.pages, `${documentLabel}.pages`, 256);
    return {id: documentId, ...(pages === undefined ? {} : {pages})};
  });
  if (new Set(documents.map(document => document.id)).size !== documents.length) {
    throw SourceConfigurationError.make({message: `${label}.documents contains duplicate ids.`});
  }
  return {
    type: 'superhuman',
    id,
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    credentialEnv,
    ...(value.credential_storage === 'local' ? {credentialStorage: 'local' as const} : {}),
    project,
    documents,
    includeHidden: optionalBoolean(value.include_hidden, false, `${label}.include_hidden`),
    refreshIntervalMinutes: positiveInteger(
      value.refresh_interval_minutes,
      DEFAULT_SUPERHUMAN_REFRESH_INTERVAL_MINUTES,
      10_080,
      `${label}.refresh_interval_minutes`,
    ),
    maxStaleHours: positiveInteger(
      value.max_stale_hours,
      DEFAULT_SUPERHUMAN_MAX_STALE_HOURS,
      8_760,
      `${label}.max_stale_hours`,
    ),
  };
}

export function isSuperhumanSource(source: SourceConfig): source is SuperhumanSourceConfig {
  return source.type === 'superhuman';
}

export function sourceConfigurationFingerprint(source: SuperhumanSourceConfig): string {
  return sha256HexSync(
    JSON.stringify({
      type: source.type,
      id: source.id,
      enabled: source.enabled,
      credentialEnv: source.credentialEnv,
      ...(source.credentialStorage === undefined ? {} : {credentialStorage: source.credentialStorage}),
      project: source.project,
      documents: source.documents
        .map(document => ({id: document.id, pages: document.pages ? [...document.pages].sort() : null}))
        .sort((left, right) => left.id.localeCompare(right.id)),
      includeHidden: source.includeHidden,
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

export function serializeSuperhumanSource(source: SuperhumanSourceConfig) {
  return {
    id: source.id,
    type: source.type,
    enabled: source.enabled,
    credential_env: source.credentialEnv,
    ...(source.credentialStorage === undefined ? {} : {credential_storage: source.credentialStorage}),
    project: source.project,
    documents: source.documents.map(document => ({
      id: document.id,
      ...(document.pages === undefined ? {} : {pages: [...document.pages]}),
    })),
    include_hidden: source.includeHidden,
    refresh_interval_minutes: source.refreshIntervalMinutes,
    max_stale_hours: source.maxStaleHours,
  };
}
export const superhumanSourceCodec = {
  type: 'superhuman' as const,
  versions: [2] as const,
  parse: parseSuperhumanSource,
  serialize: serializeSuperhumanSource,
};
