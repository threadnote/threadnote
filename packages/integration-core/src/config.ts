import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {Context, Effect, Schema} from 'effect';
import type {FileSystem, Path, Crypto} from 'effect';
import type {PlatformError} from 'effect/PlatformError';
import type {SystemInfo} from '@threadnote/platform/system';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface SourceConfig {
  readonly type: string;
  readonly id: string;
  readonly enabled: boolean;
}
export interface ProjectionConfig {
  readonly type: string;
  readonly id: string;
  readonly enabled: boolean;
}
export interface SourceConfiguration<
  S extends SourceConfig = SourceConfig,
  P extends ProjectionConfig = ProjectionConfig,
> {
  readonly version: 1 | 2;
  readonly sources: readonly S[];
  readonly projections: readonly P[];
}
export type ConfigurationHome = Pick<RuntimeConfig, 'agentContextHome'>;
export interface SourceConfigurationFailure extends Error {
  readonly _tag: string;
  readonly message: string;
}
export type ConfigurationError = SourceConfigurationFailure | PlatformError;
export type ConfigurationServices = FileSystem.FileSystem | Path.Path | Crypto.Crypto | SystemInfo;
export interface SourceConfigurationStoreShape {
  readonly read: (config: ConfigurationHome) => Effect.Effect<SourceConfiguration, ConfigurationError>;
  readonly write: (config: ConfigurationHome, value: SourceConfiguration) => Effect.Effect<string, unknown>;
  readonly mutate: (
    config: ConfigurationHome,
    update: (current: SourceConfiguration) => SourceConfiguration,
  ) => Effect.Effect<string, unknown>;
}
export class SourceConfigurationStore extends Context.Service<
  SourceConfigurationStore,
  SourceConfigurationStoreShape
>()('@threadnote/integration-core/config/SourceConfigurationStore') {}
export const readSourceConfiguration = Effect.fn('source.readConfiguration')(function* (config: ConfigurationHome) {
  return yield* (yield* SourceConfigurationStore).read(config);
});
export const writeSourceConfiguration = Effect.fn('source.writeConfiguration')(function* (
  config: ConfigurationHome,
  value: SourceConfiguration,
) {
  return yield* (yield* SourceConfigurationStore).write(config, value);
});
export const mutateSourceConfiguration = Effect.fn('source.mutateConfiguration')(function* (
  config: ConfigurationHome,
  update: (current: SourceConfiguration) => SourceConfiguration,
) {
  return yield* (yield* SourceConfigurationStore).mutate(config, update);
});
export class SourceConfigurationError extends Schema.TaggedError<
  SourceConfigurationError,
  {readonly brand: unique symbol}
>()('SourceConfigurationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const CREDENTIAL_ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
export {isJsonObject} from '@threadnote/platform/json';
export function validateSourceIdentifier(value: string, label: string): string {
  const normalized = Effect2.pipe(value, EffectString.trim, EffectString.toLowerCase);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw SourceConfigurationError.make({
      message: `${label} must contain only lowercase letters, digits, dots, underscores, and hyphens.`,
    });
  }
  return normalized;
}
export function requiredIdentifier(value: unknown, label: string): string {
  return validateSourceIdentifier(requiredString(value, label), label);
}
export function requiredProviderId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw SourceConfigurationError.make({
      message: `${label} must be 1 to 128 ASCII letters, digits, underscores, or hyphens.`,
    });
  }
  return portableIdentifier(id, label);
}
export function portableIdentifier(value: string, label: string): string {
  try {
    return validatePortableSegment(value);
  } catch {
    throw SourceConfigurationError.make({message: `${label} must be a portable resource path segment.`});
  }
}
export function providerIds(value: unknown, label: string, maximum: number): readonly string[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > maximum) {
    throw SourceConfigurationError.make({message: `${label} must contain 1 to ${maximum} ids.`});
  }
  const ids = EffectArray.map(value, item => requiredProviderId(item, label));
  if (new Set(ids).size !== ids.length) {
    throw SourceConfigurationError.make({message: `${label} contains duplicate ids.`});
  }
  return ids;
}
export function positiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!checkedIsSafeInteger(value) || value < 1 || value > maximum) {
    throw SourceConfigurationError.make({message: `${label} must be an integer from 1 to ${maximum}.`});
  }
  return value;
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || Effect2.pipe(value, EffectString.trim).length === 0) {
    throw SourceConfigurationError.make({message: `${label} must be a non-empty string.`});
  }
  return Effect2.pipe(value, EffectString.trim);
}
const isNonEmptyTrimmedStringArray = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(
    value,
    (item): item is string => typeof item === 'string' && Effect2.pipe(item, EffectString.trim).length > 0,
  );

export function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!isNonEmptyTrimmedStringArray(value)) {
    throw SourceConfigurationError.make({message: `${label} must be an array of non-empty strings.`});
  }
  return [...new Set(EffectArray.map(value, item => Effect2.pipe(item, EffectString.trim)))];
}
export function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw SourceConfigurationError.make({message: `${label} must be a boolean.`});
  }
  return value;
}
