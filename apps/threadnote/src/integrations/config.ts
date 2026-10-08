import {Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import * as yaml from 'js-yaml';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseResourceId, resourceIdWithoutAnchor, validatePortableSegment} from '@threadnote/store/resource-id';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isJsonObject} from '../utils.js';

export interface ObsidianSourceConfig {
  readonly enabled: boolean;
  readonly exclude: readonly string[];
  readonly id: string;
  readonly inbox?: string;
  readonly include: readonly string[];
  readonly type: 'obsidian';
  readonly vault: string;
  readonly watch: boolean;
}

export interface ObsidianProjectionConfig {
  readonly enabled: boolean;
  readonly folder: string;
  readonly id: string;
  readonly includeShared: boolean;
  readonly kinds: readonly MemoryKind[];
  readonly selectedUris?: readonly string[];
  readonly statuses: readonly MemoryStatus[];
  readonly type: 'obsidian';
  readonly vault: string;
}

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

export type SourceConfig = ObsidianSourceConfig | SuperhumanSourceConfig | PocketSourceConfig;

export type SourceConfiguration =
  | {
      readonly projections: readonly ObsidianProjectionConfig[];
      readonly sources: readonly ObsidianSourceConfig[];
      readonly version: 1;
    }
  | {
      readonly projections: readonly ObsidianProjectionConfig[];
      readonly sources: readonly SourceConfig[];
      readonly version: 2;
    };

export type ObsidianConfiguration = SourceConfiguration;

class ObsidianConfigurationError extends Schema.TaggedError<ObsidianConfigurationError>()(
  'ObsidianConfigurationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const DEFAULT_OBSIDIAN_EXCLUDES = ['.obsidian/**', '.trash/**'] as const;
export const DEFAULT_PROJECTION_KINDS = ['durable', 'handoff'] as const;
export const DEFAULT_PROJECTION_STATUSES = ['active'] as const;
export const DEFAULT_SUPERHUMAN_CREDENTIAL_ENV = 'SUPERHUMAN_DOCS_API_TOKEN';
export const DEFAULT_SUPERHUMAN_REFRESH_INTERVAL_MINUTES = 15;
export const DEFAULT_SUPERHUMAN_MAX_STALE_HOURS = 24;
export const DEFAULT_POCKET_CREDENTIAL_ENV = 'POCKET_API_KEY';

const CONFIGURATION_VERSION = 1;
const CONFIGURATION_FILENAME = 'sources.yaml';
const CONFIGURATION_LOCK_RETRY_MILLISECONDS = 25;
const CONFIGURATION_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const CONFIGURATION_LOCK_WAIT_MILLISECONDS = 5_000;
const CONFIGURATION_LOCK_OPTIONS = {
  retryIntervalMilliseconds: CONFIGURATION_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: CONFIGURATION_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: CONFIGURATION_LOCK_WAIT_MILLISECONDS,
} as const;
const CONFIGURATION_FILE_MODE = 0o600;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CREDENTIAL_ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function emptyObsidianConfiguration(): ObsidianConfiguration {
  return {projections: [], sources: [], version: CONFIGURATION_VERSION};
}

export const obsidianConfigurationPath = Effect.fn('obsidian.configurationPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const pathService = yield* Path.Path;
  return pathService.join(config.agentContextHome, 'threadnote', CONFIGURATION_FILENAME);
});

export const readObsidianConfiguration = Effect.fn('obsidian.readConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* obsidianConfigurationPath(config);
  return yield* readConfigurationAt(path);
});

const readConfigurationAt = Effect.fn('source.readConfigurationAt')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) {
    return emptyObsidianConfiguration();
  }
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseObsidianConfiguration(raw, path),
    catch: cause =>
      Schema.is(ObsidianConfigurationError)(cause)
        ? cause
        : ObsidianConfigurationError.make({message: 'Source configuration could not be parsed.'}),
  });
});

export const readSourceConfiguration = readObsidianConfiguration;

export const writeObsidianConfiguration = Effect.fn('obsidian.writeConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  value: ObsidianConfiguration,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* obsidianConfigurationPath(config);
  const serialized = renderObsidianConfiguration(value);
  yield* withExclusiveFileLock(fs, `${path}.lock`, CONFIGURATION_LOCK_OPTIONS, writeConfigurationAt(path, serialized));
  return path;
});

const writeConfigurationAt = Effect.fn('source.writeConfigurationAt')(function* (path: string, serialized: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
  const crypto = yield* Crypto.Crypto;
  const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporaryPath, serialized, {mode: CONFIGURATION_FILE_MODE});
  yield* fs
    .rename(temporaryPath, path)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  yield* fs.chmod(path, CONFIGURATION_FILE_MODE);
});

export const writeSourceConfiguration = writeObsidianConfiguration;

export const mutateSourceConfiguration = Effect.fn('source.mutateConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  update: (current: SourceConfiguration) => SourceConfiguration,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* obsidianConfigurationPath(config);
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    CONFIGURATION_LOCK_OPTIONS,
    Effect.gen(function* () {
      const current = yield* readConfigurationAt(path);
      const next = yield* Effect.try({
        try: () => update(current),
        catch: cause =>
          Schema.is(ObsidianConfigurationError)(cause)
            ? cause
            : ObsidianConfigurationError.make({message: 'Source configuration update failed.'}),
      });
      yield* writeConfigurationAt(path, renderObsidianConfiguration(next));
    }),
  );
  return path;
});

export function parseObsidianConfiguration(raw: string, path = CONFIGURATION_FILENAME): ObsidianConfiguration {
  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch {
    throw ObsidianConfigurationError.make({message: `Source configuration contains invalid YAML: ${path}`});
  }
  if (!isJsonObject(loaded)) {
    throw ObsidianConfigurationError.make({message: `Obsidian source configuration must be an object: ${path}`});
  }
  if (loaded.version !== 1 && loaded.version !== 2) {
    throw ObsidianConfigurationError.make({
      message: `Unsupported source configuration version in ${path}. Expected 1 or 2.`,
    });
  }
  if (!Array.isArray(loaded.sources) || !Array.isArray(loaded.projections)) {
    throw ObsidianConfigurationError.make({
      message: `Obsidian source configuration requires sources and projections arrays: ${path}`,
    });
  }
  const version = loaded.version;
  const sources = loaded.sources.map((value, index) => parseSource(value, `${path} sources[${index}]`, version));
  const projections = loaded.projections.map((value, index) => parseProjection(value, `${path} projections[${index}]`));
  assertUniqueIds(sources, projections, path);
  return loaded.version === 1
    ? {projections, sources: sources.map(source => requireParsedObsidianSource(source)), version: 1}
    : {projections, sources, version: 2};
}

export const parseSourceConfiguration = parseObsidianConfiguration;

export function renderObsidianConfiguration(value: ObsidianConfiguration): string {
  const normalized = {
    version: value.version,
    sources: value.sources.map(source =>
      source.type === 'obsidian'
        ? {
            id: source.id,
            type: source.type,
            vault: source.vault,
            include: [...source.include],
            exclude: [...source.exclude],
            enabled: source.enabled,
            watch: source.watch,
            ...(source.inbox ? {inbox: source.inbox} : {}),
          }
        : source.type === 'pocket'
          ? {
              id: source.id,
              type: source.type,
              enabled: source.enabled,
              credential_env: source.credentialEnv,
              ...(source.credentialStorage === undefined ? {} : {credential_storage: source.credentialStorage}),
              project: source.project,
              refresh_interval_minutes: source.refreshIntervalMinutes,
              max_stale_hours: source.maxStaleHours,
            }
          : {
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
            },
    ),
    projections: value.projections.map(projection => ({
      id: projection.id,
      type: projection.type,
      vault: projection.vault,
      folder: projection.folder,
      kinds: [...projection.kinds],
      statuses: [...projection.statuses],
      include_shared: projection.includeShared,
      ...(projection.selectedUris === undefined ? {} : {selected_uris: [...projection.selectedUris]}),
      enabled: projection.enabled,
    })),
  };
  return yaml.dump(normalized, {lineWidth: 100, noRefs: true, sortKeys: false});
}

export const renderSourceConfiguration = renderObsidianConfiguration;

export function upsertObsidianSource(
  configuration: ObsidianConfiguration,
  source: ObsidianSourceConfig,
): ObsidianConfiguration {
  if (configuration.sources.some(item => item.id === source.id && item.type !== source.type)) {
    throw ObsidianConfigurationError.make({message: `Source "${source.id}" already has another type.`});
  }
  const sources = [...configuration.sources.filter(item => item.id !== source.id), source].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return configuration.version === 1
    ? {version: 1, sources: sources.filter(isObsidianSource), projections: configuration.projections}
    : {version: 2, sources, projections: configuration.projections};
}

export function upsertSuperhumanSource(
  configuration: SourceConfiguration,
  source: SuperhumanSourceConfig,
): SourceConfiguration {
  const checked = validateSuperhumanSourceConfig(source);
  if (configuration.sources.some(item => item.id === checked.id && item.type !== checked.type)) {
    throw ObsidianConfigurationError.make({message: `Source "${checked.id}" already has another type.`});
  }
  return {
    version: 2,
    projections: configuration.projections,
    sources: [...configuration.sources.filter(item => item.id !== checked.id), checked].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

export function upsertPocketSource(
  configuration: SourceConfiguration,
  source: PocketSourceConfig,
): SourceConfiguration {
  const checked = validatePocketSourceConfig(source);
  if (configuration.sources.some(item => item.id === checked.id && item.type !== checked.type))
    throw ObsidianConfigurationError.make({message: `Source "${checked.id}" already has another type.`});
  return {
    version: 2,
    projections: configuration.projections,
    sources: [...configuration.sources.filter(item => item.id !== checked.id), checked].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
}

export function upsertObsidianProjection(
  configuration: ObsidianConfiguration,
  projection: ObsidianProjectionConfig,
): ObsidianConfiguration {
  const projections = [...configuration.projections.filter(item => item.id !== projection.id), projection].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  return configuration.version === 1
    ? {version: 1, sources: configuration.sources, projections}
    : {version: 2, sources: configuration.sources, projections};
}

export function removeObsidianSource(configuration: ObsidianConfiguration, id: string): ObsidianConfiguration {
  return configuration.version === 1
    ? {
        version: 1,
        projections: configuration.projections,
        sources: configuration.sources.filter(source => source.id !== id),
      }
    : {
        version: 2,
        projections: configuration.projections,
        sources: configuration.sources.filter(source => source.id !== id || source.type !== 'obsidian'),
      };
}

export function removeObsidianProjection(configuration: ObsidianConfiguration, id: string): ObsidianConfiguration {
  return configuration.version === 1
    ? {
        version: 1,
        sources: configuration.sources,
        projections: configuration.projections.filter(item => item.id !== id),
      }
    : {
        version: 2,
        sources: configuration.sources,
        projections: configuration.projections.filter(item => item.id !== id),
      };
}

export function requireObsidianSource(configuration: ObsidianConfiguration, id: string): ObsidianSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source || !isObsidianSource(source)) {
    throw ObsidianConfigurationError.make({message: `No Obsidian source named "${id}".`});
  }
  return source;
}

export function requireSuperhumanSource(configuration: SourceConfiguration, id: string): SuperhumanSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source || source.type !== 'superhuman') {
    throw ObsidianConfigurationError.make({message: `No Superhuman source named "${id}".`});
  }
  return source;
}

export function requirePocketSource(configuration: SourceConfiguration, id: string): PocketSourceConfig {
  const source = configuration.sources.find(item => item.id === id);
  if (!source || source.type !== 'pocket')
    throw ObsidianConfigurationError.make({message: `No Pocket source named "${id}".`});
  return source;
}

export function isObsidianSource(source: SourceConfig): source is ObsidianSourceConfig {
  return source.type === 'obsidian';
}

export function requireObsidianProjection(configuration: ObsidianConfiguration, id: string): ObsidianProjectionConfig {
  const projection = configuration.projections.find(item => item.id === id);
  if (!projection) {
    throw ObsidianConfigurationError.make({message: `No Obsidian projection named "${id}".`});
  }
  return projection;
}

export function validateObsidianIdentifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw ObsidianConfigurationError.make({
      message: `${label} must contain only lowercase letters, digits, dots, underscores, and hyphens.`,
    });
  }
  return normalized;
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

export function sourceConfigurationFingerprint(source: SuperhumanSourceConfig | PocketSourceConfig): string {
  if (source.type === 'pocket')
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

function parseSource(value: unknown, label: string, version: 1 | 2): SourceConfig {
  if (!isJsonObject(value)) {
    throw ObsidianConfigurationError.make({message: `${label} must be an object.`});
  }
  if (value.type === 'superhuman' && version === 2) return parseSuperhumanSource(value, label);
  if (value.type === 'pocket' && version === 2) return parsePocketSource(value, label);
  if (value.type !== 'obsidian') {
    throw ObsidianConfigurationError.make({
      message: `${label}.type must be "obsidian"${version === 2 ? ', "superhuman", or "pocket"' : ''}.`,
    });
  }
  const id = requiredIdentifier(value.id, `${label}.id`);
  const include = sourcePatterns(value.include, `${label}.include`);
  if (include.length === 0) {
    throw ObsidianConfigurationError.make({message: `${label}.include must contain at least one allowlist pattern.`});
  }
  return {
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    exclude: value.exclude === undefined ? [] : sourcePatterns(value.exclude, `${label}.exclude`),
    id,
    inbox: value.inbox === undefined ? undefined : requiredRelativeFolder(value.inbox, `${label}.inbox`),
    include,
    type: 'obsidian',
    vault: requiredAbsoluteVaultPath(value.vault, `${label}.vault`),
    watch: optionalBoolean(value.watch, false, `${label}.watch`),
  };
}

function requireParsedObsidianSource(source: SourceConfig): ObsidianSourceConfig {
  if (!isObsidianSource(source))
    throw ObsidianConfigurationError.make({message: 'Version 1 sources must be Obsidian.'});
  return source;
}

function parseSuperhumanSource(value: Record<string, unknown>, label: string): SuperhumanSourceConfig {
  const id = portableIdentifier(requiredIdentifier(value.id, `${label}.id`), `${label}.id`);
  const credentialEnv =
    value.credential_env === undefined
      ? DEFAULT_SUPERHUMAN_CREDENTIAL_ENV
      : requiredString(value.credential_env, `${label}.credential_env`);
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv)) {
    throw ObsidianConfigurationError.make({message: `${label}.credential_env must be an environment variable name.`});
  }
  if (value.credential_storage !== undefined && value.credential_storage !== 'local')
    throw ObsidianConfigurationError.make({message: `${label}.credential_storage must be "local" when present.`});
  const project = value.project === null ? null : requiredIdentifier(value.project, `${label}.project`);
  if (!Array.isArray(value.documents) || value.documents.length === 0 || value.documents.length > 64) {
    throw ObsidianConfigurationError.make({message: `${label}.documents must contain 1 to 64 documents.`});
  }
  const documents = value.documents.map((raw, index) => {
    const documentLabel = `${label}.documents[${index}]`;
    if (!isJsonObject(raw)) throw ObsidianConfigurationError.make({message: `${documentLabel} must be an object.`});
    const documentId = requiredProviderId(raw.id, `${documentLabel}.id`);
    const pages = raw.pages === undefined ? undefined : providerIds(raw.pages, `${documentLabel}.pages`, 256);
    return {id: documentId, ...(pages === undefined ? {} : {pages})};
  });
  if (new Set(documents.map(document => document.id)).size !== documents.length) {
    throw ObsidianConfigurationError.make({message: `${label}.documents contains duplicate ids.`});
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

function parsePocketSource(value: Record<string, unknown>, label: string): PocketSourceConfig {
  const id = portableIdentifier(requiredIdentifier(value.id, `${label}.id`), `${label}.id`);
  const credentialEnv =
    value.credential_env === undefined
      ? DEFAULT_POCKET_CREDENTIAL_ENV
      : requiredString(value.credential_env, `${label}.credential_env`);
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv))
    throw ObsidianConfigurationError.make({message: `${label}.credential_env must be an environment variable name.`});
  if (value.credential_storage !== undefined && value.credential_storage !== 'local')
    throw ObsidianConfigurationError.make({message: `${label}.credential_storage must be "local" when present.`});
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

function parseProjection(value: unknown, label: string): ObsidianProjectionConfig {
  if (!isJsonObject(value)) {
    throw ObsidianConfigurationError.make({message: `${label} must be an object.`});
  }
  const id = requiredIdentifier(value.id, `${label}.id`);
  if (value.type !== 'obsidian') {
    throw ObsidianConfigurationError.make({message: `${label}.type must be "obsidian".`});
  }
  return {
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    folder: requiredRelativeFolder(value.folder, `${label}.folder`),
    id,
    includeShared: optionalBoolean(value.include_shared, true, `${label}.include_shared`),
    kinds: memoryKinds(value.kinds, `${label}.kinds`),
    ...(value.selected_uris === undefined
      ? {}
      : {selectedUris: selectedMemoryUris(value.selected_uris, `${label}.selected_uris`)}),
    statuses: memoryStatuses(value.statuses, `${label}.statuses`),
    type: 'obsidian',
    vault: requiredAbsoluteVaultPath(value.vault, `${label}.vault`),
  };
}

function assertUniqueIds(
  sources: readonly SourceConfig[],
  projections: readonly ObsidianProjectionConfig[],
  path: string,
): void {
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw ObsidianConfigurationError.make({message: `Duplicate source id "${source.id}" in ${path}.`});
    }
    sourceIds.add(source.id);
  }
  const projectionIds = new Set<string>();
  for (const projection of projections) {
    if (projectionIds.has(projection.id)) {
      throw ObsidianConfigurationError.make({message: `Duplicate projection id "${projection.id}" in ${path}.`});
    }
    projectionIds.add(projection.id);
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  return validateObsidianIdentifier(requiredString(value, label), label);
}

function requiredProviderId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw ObsidianConfigurationError.make({
      message: `${label} must be 1 to 128 ASCII letters, digits, underscores, or hyphens.`,
    });
  }
  return portableIdentifier(id, label);
}

function portableIdentifier(value: string, label: string): string {
  try {
    return validatePortableSegment(value);
  } catch {
    throw ObsidianConfigurationError.make({message: `${label} must be a portable resource path segment.`});
  }
}

function providerIds(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw ObsidianConfigurationError.make({message: `${label} must contain 1 to ${maximum} ids.`});
  }
  const ids = value.map(item => requiredProviderId(item, label));
  if (new Set(ids).size !== ids.length) {
    throw ObsidianConfigurationError.make({message: `${label} contains duplicate ids.`});
  }
  return ids;
}

function positiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw ObsidianConfigurationError.make({message: `${label} must be an integer from 1 to ${maximum}.`});
  }
  return value as number;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ObsidianConfigurationError.make({message: `${label} must be a non-empty string.`});
  }
  return value.trim();
}

function requiredAbsoluteVaultPath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (!path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path) && !/^\\\\/.test(path)) {
    throw ObsidianConfigurationError.make({message: `${label} must be an absolute path.`});
  }
  return path;
}

function requiredRelativeFolder(value: unknown, label: string): string {
  const folder = requiredString(value, label)
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');
  if (folder.length === 0 || folder.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw ObsidianConfigurationError.make({message: `${label} must be a safe vault-relative folder.`});
  }
  return folder;
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim().length > 0)) {
    throw ObsidianConfigurationError.make({message: `${label} must be an array of non-empty strings.`});
  }
  return [...new Set(value.map(item => item.trim()))];
}

function sourcePatterns(value: unknown, label: string): readonly string[] {
  return requiredStringArray(value, label).map(pattern => {
    const normalized = pattern.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.split('/').some(segment => segment === '..')
    ) {
      throw ObsidianConfigurationError.make({
        message: `${label} must contain only vault-relative patterns without parent traversal.`,
      });
    }
    return normalized;
  });
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw ObsidianConfigurationError.make({message: `${label} must be a boolean.`});
  }
  return value;
}

function memoryKinds(value: unknown, label: string): readonly MemoryKind[] {
  const values = value === undefined ? DEFAULT_PROJECTION_KINDS : requiredStringArray(value, label);
  if (
    !values.every(
      item =>
        item === 'durable' || item === 'handoff' || item === 'incident' || item === 'preference' || item === 'smoke',
    )
  ) {
    throw ObsidianConfigurationError.make({message: `${label} contains an unsupported memory kind.`});
  }
  return values;
}

function memoryStatuses(value: unknown, label: string): readonly MemoryStatus[] {
  const values = value === undefined ? DEFAULT_PROJECTION_STATUSES : requiredStringArray(value, label);
  if (!values.every(item => item === 'active' || item === 'archived' || item === 'expired' || item === 'superseded')) {
    throw ObsidianConfigurationError.make({message: `${label} contains an unsupported memory status.`});
  }
  return values;
}

function selectedMemoryUris(value: unknown, label: string): readonly string[] {
  return requiredStringArray(value, label)
    .map(uri => {
      const parsed = resourceIdWithoutAnchor(parseResourceId(uri));
      if (
        parsed.namespace !== 'user' ||
        parsed.segments.length < 3 ||
        parsed.segments[1] !== 'memories' ||
        !parsed.segments.at(-1)?.toLowerCase().endsWith('.md')
      ) {
        throw ObsidianConfigurationError.make({message: `${label} may contain only canonical Threadnote memory URIs.`});
      }
      return parsed.canonicalUri;
    })
    .sort((left, right) => left.localeCompare(right));
}
