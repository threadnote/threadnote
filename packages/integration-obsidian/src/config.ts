import {Schema} from 'effect';
import * as configuration from '@threadnote/integration-core/config';
import type {SourceConfig, SourceConfiguration, ProjectionConfig} from '@threadnote/integration-core/config';
export class ObsidianConfigurationError extends Schema.TaggedError<ObsidianConfigurationError>()(
  'ObsidianConfigurationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}
function checked<A>(operation: () => A): A {
  try {
    return operation();
  } catch (cause) {
    if (Schema.is(configuration.SourceConfigurationError)(cause))
      throw ObsidianConfigurationError.make({message: cause.message});
    throw cause;
  }
}
export function validateObsidianIdentifier(value: string, label: string): string {
  return checked(() => configuration.validateSourceIdentifier(value, label));
}
const requiredIdentifier = (value: unknown, label: string) =>
  checked(() => configuration.requiredIdentifier(value, label));
const requiredString = (value: unknown, label: string) => checked(() => configuration.requiredString(value, label));
const requiredStringArray = (value: unknown, label: string) =>
  checked(() => configuration.requiredStringArray(value, label));
const optionalBoolean = (value: unknown, fallback: boolean, label: string) =>
  checked(() => configuration.optionalBoolean(value, fallback, label));
const isJsonObject = configuration.isJsonObject;
import {parseResourceId, resourceIdWithoutAnchor} from '@threadnote/store/resource-id';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
export type ObsidianConfiguration = SourceConfiguration;
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
export const DEFAULT_OBSIDIAN_EXCLUDES = ['.obsidian/**', '.trash/**'] as const;
export const DEFAULT_PROJECTION_KINDS = ['durable', 'handoff'] as const;
export const DEFAULT_PROJECTION_STATUSES = ['active'] as const;
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
        sources: configuration.sources.filter(source => source.id !== id || !isObsidianSource(source)),
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
export function isObsidianSource(source: SourceConfig): source is ObsidianSourceConfig {
  return source.type === 'obsidian';
}
export function requireObsidianProjection(configuration: ObsidianConfiguration, id: string): ObsidianProjectionConfig {
  const projection = configuration.projections.find(item => item.id === id);
  if (projection && !isObsidianProjection(projection))
    throw ObsidianConfigurationError.make({message: `No Obsidian projection named "${id}".`});
  if (!projection) {
    throw ObsidianConfigurationError.make({message: `No Obsidian projection named "${id}".`});
  }
  return projection;
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
export function parseProjection(value: unknown, label: string): ObsidianProjectionConfig {
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
export function parseObsidianSource(value: Record<string, unknown>, label: string): ObsidianSourceConfig {
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

export function isObsidianProjection(projection: ProjectionConfig): projection is ObsidianProjectionConfig {
  return projection.type === 'obsidian';
}

export {
  readSourceConfiguration,
  readSourceConfiguration as readObsidianConfiguration,
  writeSourceConfiguration,
  writeSourceConfiguration as writeObsidianConfiguration,
  mutateSourceConfiguration,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';

export function serializeObsidianSource(source: ObsidianSourceConfig) {
  return {
    id: source.id,
    type: source.type,
    vault: source.vault,
    include: [...source.include],
    exclude: [...source.exclude],
    enabled: source.enabled,
    watch: source.watch,
    ...(source.inbox ? {inbox: source.inbox} : {}),
  };
}
export function serializeObsidianProjection(projection: ObsidianProjectionConfig) {
  return {
    id: projection.id,
    type: projection.type,
    vault: projection.vault,
    folder: projection.folder,
    kinds: [...projection.kinds],
    statuses: [...projection.statuses],
    include_shared: projection.includeShared,
    ...(projection.selectedUris === undefined ? {} : {selected_uris: [...projection.selectedUris]}),
    enabled: projection.enabled,
  };
}
export const obsidianSourceCodec = {
  type: 'obsidian' as const,
  versions: [1, 2] as const,
  isConfigurationError: Schema.is(ObsidianConfigurationError),
  parse: parseObsidianSource,
  serialize: serializeObsidianSource,
};
export const obsidianProjectionCodec = {
  type: 'obsidian' as const,
  versions: [1, 2] as const,
  isConfigurationError: Schema.is(ObsidianConfigurationError),
  parse: parseProjection,
  serialize: serializeObsidianProjection,
};
