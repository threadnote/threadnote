import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import * as configuration from '@threadnote/integration-core/config';
import type {SourceConfig, SourceConfiguration, ProjectionConfig} from '@threadnote/integration-core/config';
export class ObsidianConfigurationError extends Schema.TaggedError<
  ObsidianConfigurationError,
  {readonly brand: unique symbol}
>()('ObsidianConfigurationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}
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
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

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
export function upsertObsidianSource<S extends SourceConfig, P extends ProjectionConfig>(
  configuration: SourceConfiguration<S, P>,
  source: ObsidianSourceConfig,
): SourceConfiguration<S | ObsidianSourceConfig, P> {
  if (EffectArray.some(configuration.sources, item => item.id === source.id && item.type !== source.type)) {
    throw ObsidianConfigurationError.make({message: `Source "${source.id}" already has another type.`});
  }
  const sources = [...EffectArray.filter(configuration.sources, item => item.id !== source.id), source].sort(
    (left, right) => Effect.pipe(left.id, EffectString.localeCompare(right.id)),
  );
  return configuration.version === 1
    ? {version: 1, sources: EffectArray.filter(sources, isObsidianSource), projections: configuration.projections}
    : {version: 2, sources, projections: configuration.projections};
}
export function upsertObsidianProjection<S extends SourceConfig, P extends ProjectionConfig>(
  configuration: SourceConfiguration<S, P>,
  projection: ObsidianProjectionConfig,
): SourceConfiguration<S, P | ObsidianProjectionConfig> {
  const projections = [
    ...EffectArray.filter(configuration.projections, item => item.id !== projection.id),
    projection,
  ].sort((left, right) => Effect.pipe(left.id, EffectString.localeCompare(right.id)));
  return configuration.version === 1
    ? {version: 1, sources: configuration.sources, projections}
    : {version: 2, sources: configuration.sources, projections};
}
export function removeObsidianSource<S extends SourceConfig, P extends ProjectionConfig>(
  configuration: SourceConfiguration<S, P>,
  id: string,
): SourceConfiguration<S, P> {
  return configuration.version === 1
    ? {
        version: 1,
        projections: configuration.projections,
        sources: EffectArray.filter(configuration.sources, source => source.id !== id),
      }
    : {
        version: 2,
        projections: configuration.projections,
        sources: EffectArray.filter(configuration.sources, source => source.id !== id || !isObsidianSource(source)),
      };
}
export function removeObsidianProjection<S extends SourceConfig, P extends ProjectionConfig>(
  configuration: SourceConfiguration<S, P>,
  id: string,
): SourceConfiguration<S, P> {
  return configuration.version === 1
    ? {
        version: 1,
        sources: configuration.sources,
        projections: EffectArray.filter(configuration.projections, item => item.id !== id),
      }
    : {
        version: 2,
        sources: configuration.sources,
        projections: EffectArray.filter(configuration.projections, item => item.id !== id),
      };
}
export function requireObsidianSource(configuration: ObsidianConfiguration, id: string): ObsidianSourceConfig {
  const source = EffectOption.getOrUndefined(EffectArray.findFirst(configuration.sources, item => item.id === id));
  if (!source || !isObsidianSource(source)) {
    throw ObsidianConfigurationError.make({message: `No Obsidian source named "${id}".`});
  }
  return source;
}
export function isObsidianSource(source: SourceConfig): source is ObsidianSourceConfig {
  return source.type === 'obsidian';
}
export function requireObsidianProjection(configuration: ObsidianConfiguration, id: string): ObsidianProjectionConfig {
  const projection = EffectOption.getOrUndefined(
    EffectArray.findFirst(configuration.projections, item => item.id === id),
  );
  if (projection && !isObsidianProjection(projection))
    throw ObsidianConfigurationError.make({message: `No Obsidian projection named "${id}".`});
  if (!projection) {
    throw ObsidianConfigurationError.make({message: `No Obsidian projection named "${id}".`});
  }
  return projection;
}
function requiredAbsoluteVaultPath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (!Effect.pipe(path, EffectString.startsWith('/')) && !/^[a-zA-Z]:[\\/]/.test(path) && !/^\\\\/.test(path)) {
    throw ObsidianConfigurationError.make({message: `${label} must be an absolute path.`});
  }
  return path;
}
function requiredRelativeFolder(value: unknown, label: string): string {
  const folder = Effect.pipe(
    requiredString(value, label),
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\/+|\/+$/g, ''),
  );
  if (
    folder.length === 0 ||
    EffectArray.some(
      Effect.pipe(folder, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw ObsidianConfigurationError.make({message: `${label} must be a safe vault-relative folder.`});
  }
  return folder;
}
function sourcePatterns(value: unknown, label: string): readonly string[] {
  return EffectArray.map(requiredStringArray(value, label), pattern => {
    const normalized = Effect.pipe(pattern, EffectString.replaceAll('\\', '/'));
    if (
      Effect.pipe(normalized, EffectString.startsWith('/')) ||
      /^[a-zA-Z]:\//.test(normalized) ||
      EffectArray.some(Effect.pipe(normalized, EffectString.split('/')), segment => segment === '..')
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
    !EffectArray.every(
      values,
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
  if (
    !EffectArray.every(
      values,
      item => item === 'active' || item === 'archived' || item === 'expired' || item === 'superseded',
    )
  ) {
    throw ObsidianConfigurationError.make({message: `${label} contains an unsupported memory status.`});
  }
  return values;
}
function selectedMemoryUris(value: unknown, label: string): readonly string[] {
  return EffectArray.map(requiredStringArray(value, label), uri => {
    const parsed = resourceIdWithoutAnchor(parseResourceId(uri));
    if (
      parsed.namespace !== 'user' ||
      parsed.segments.length < 3 ||
      parsed.segments[1] !== 'memories' ||
      !Effect.pipe(
        parsed.segments.at(-1),
        effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
        effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
      )
    ) {
      throw ObsidianConfigurationError.make({message: `${label} may contain only canonical Threadnote memory URIs.`});
    }
    return parsed.canonicalUri;
  }).sort((left, right) => Effect.pipe(left, EffectString.localeCompare(right)));
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
