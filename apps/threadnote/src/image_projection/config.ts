import {Crypto, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isJsonObject} from '../utils.js';

export const IMAGE_PROJECTION_CONFIGURATION_VERSION = 1 as const;

export interface ImageProjectionConfiguration {
  readonly enabled: boolean;
  readonly version: typeof IMAGE_PROJECTION_CONFIGURATION_VERSION;
}

export class ImageProjectionConfigurationError extends Schema.TaggedError<ImageProjectionConfigurationError>()(
  'ImageProjectionConfigurationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {
  static of(message: string, options?: ErrorOptions): ImageProjectionConfigurationError {
    return ImageProjectionConfigurationError.make({
      message,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}

const IMAGE_PROJECTION_DIRECTORY_NAME = 'image-projection';
const IMAGE_PROJECTION_CONFIGURATION_FILE_NAME = 'config.json';
const IMAGE_PROJECTION_CONFIGURATION_MAX_BYTES = 16 * 1024;
const IMAGE_PROJECTION_DIRECTORY_MODE = 0o700;
const IMAGE_PROJECTION_CONFIGURATION_FILE_MODE = 0o600;
const IMAGE_PROJECTION_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 2_000,
} as const;
const IMAGE_PROJECTION_ENVIRONMENT_KEY = 'THREADNOTE_IMAGE_PROJECTION';

export const imageProjectionConfigurationPath = Effect.fn('imageProjection.configurationPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, IMAGE_PROJECTION_DIRECTORY_NAME, IMAGE_PROJECTION_CONFIGURATION_FILE_NAME);
});

export const readImageProjectionConfiguration = Effect.fn('imageProjection.readConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const document = yield* readImageProjectionConfigurationDocument(config);
  if (document === undefined) return undefined;
  return yield* Effect.try({
    try: () => parseImageProjectionConfiguration(document.raw, document.file),
    catch: cause =>
      Schema.is(ImageProjectionConfigurationError)(cause)
        ? cause
        : ImageProjectionConfigurationError.of('Image projection configuration could not be parsed.', {cause}),
  });
});

export const isImageProjectionEnabled = Effect.fn('imageProjection.isEnabled')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  if (imageProjectionEnvironmentDisabled(system.environment())) return false;
  return yield* readImageProjectionConfiguration(config).pipe(
    Effect.map(value => value?.enabled === true),
    Effect.orElseSucceed(() => false),
  );
});

export const writeImageProjectionConfiguration = Effect.fn('imageProjection.writeConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  value: ImageProjectionConfiguration,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* imageProjectionConfigurationPath(config);
  const directory = path.dirname(file);
  const serialized = renderImageProjectionConfiguration(value);
  yield* prepareImageProjectionDirectory(fs, directory);
  yield* withExclusiveFileLock(
    fs,
    `${file}.lock`,
    IMAGE_PROJECTION_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* assertRegularImageProjectionDirectory(fs, directory);
      if ((yield* fs.exists(file)) && Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
        return yield* ImageProjectionConfigurationError.of(
          'Image projection configuration must not be a symbolic link.',
        );
      }
      const temporary = path.join(directory, `.config.${yield* crypto.randomUUIDv4()}.tmp`);
      yield* fs.writeFileString(temporary, serialized, {mode: IMAGE_PROJECTION_CONFIGURATION_FILE_MODE});
      yield* fs.rename(temporary, file).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
      yield* fs.chmod(file, IMAGE_PROJECTION_CONFIGURATION_FILE_MODE);
      yield* fs.chmod(directory, IMAGE_PROJECTION_DIRECTORY_MODE);
    }),
  );
  return file;
});

export function parseImageProjectionConfiguration(
  raw: string,
  source = IMAGE_PROJECTION_CONFIGURATION_FILE_NAME,
): ImageProjectionConfiguration {
  try {
    return parseImageProjectionConfigurationValue(JSON.parse(raw) as unknown, source);
  } catch (cause) {
    if (Schema.is(ImageProjectionConfigurationError)(cause)) throw cause;
    throw ImageProjectionConfigurationError.of(`Image projection configuration is not valid JSON: ${source}`, {cause});
  }
}

export function renderImageProjectionConfiguration(value: ImageProjectionConfiguration): string {
  return `${JSON.stringify(parseImageProjectionConfigurationValue(value, IMAGE_PROJECTION_CONFIGURATION_FILE_NAME), undefined, 2)}\n`;
}

export function imageProjectionConfiguration(enabled: boolean): ImageProjectionConfiguration {
  return {enabled, version: IMAGE_PROJECTION_CONFIGURATION_VERSION};
}

export function imageProjectionEnvironmentDisabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = environment[IMAGE_PROJECTION_ENVIRONMENT_KEY];
  return value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export const imageProjectionDoctorCheck = Effect.fn('imageProjection.doctorCheck')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  const loaded = yield* Effect.result(readImageProjectionConfiguration(config));
  if (Result.isFailure(loaded)) {
    return {
      detail: 'invalid or unreadable configuration; image projection fails closed',
      name: 'MCP image projection',
      status: 'warn' as const,
    };
  }
  if (loaded.success?.enabled !== true) {
    return {
      detail: 'disabled; MCP read_context returns complete text',
      name: 'MCP image projection',
      status: 'ok' as const,
    };
  }
  return {
    detail: imageProjectionEnvironmentDisabled(system.environment())
      ? 'persisted enabled but suppressed by THREADNOTE_IMAGE_PROJECTION'
      : 'enabled; MCP read_context still returns complete text, not PNG pages',
    name: 'MCP image projection',
    status: 'ok' as const,
  };
});

function parseImageProjectionConfigurationValue(value: unknown, source: string): ImageProjectionConfiguration {
  if (!isJsonObject(value)) {
    throw ImageProjectionConfigurationError.of(`Image projection configuration must be an object: ${source}`);
  }
  if (value.version !== IMAGE_PROJECTION_CONFIGURATION_VERSION) {
    throw ImageProjectionConfigurationError.of(
      `Unsupported image projection configuration version in ${source}. Expected ${IMAGE_PROJECTION_CONFIGURATION_VERSION}.`,
    );
  }
  if (typeof value.enabled !== 'boolean') {
    throw ImageProjectionConfigurationError.of(
      `Image projection configuration requires a boolean enabled field: ${source}`,
    );
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== 2 || actual[0] !== 'enabled' || actual[1] !== 'version') {
    throw ImageProjectionConfigurationError.of(`Image projection configuration contains unsupported fields: ${source}`);
  }
  return imageProjectionConfiguration(value.enabled);
}

function prepareImageProjectionDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if ((yield* fs.exists(directory)) && Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* ImageProjectionConfigurationError.of('Image projection directory must not be a symbolic link.');
    }
    yield* fs.makeDirectory(directory, {mode: IMAGE_PROJECTION_DIRECTORY_MODE, recursive: true});
    yield* assertRegularImageProjectionDirectory(fs, directory);
    yield* fs.chmod(directory, IMAGE_PROJECTION_DIRECTORY_MODE);
  });
}

const readImageProjectionConfigurationDocument = Effect.fn('imageProjection.readConfigurationDocument')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* imageProjectionConfigurationPath(config);
  if (!(yield* fs.exists(file))) return undefined;
  yield* assertRegularImageProjectionDirectory(fs, path.dirname(file));
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* ImageProjectionConfigurationError.of('Image projection configuration must not be a symbolic link.');
  }
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || Number(info.size) > IMAGE_PROJECTION_CONFIGURATION_MAX_BYTES) {
    return yield* ImageProjectionConfigurationError.of(
      'Image projection configuration must be a bounded regular file.',
    );
  }
  return {file, raw: yield* fs.readFileString(file)};
});

function assertRegularImageProjectionDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* ImageProjectionConfigurationError.of('Image projection directory must not be a symbolic link.');
    }
    const info = yield* fs.stat(directory);
    if (info.type !== 'Directory') {
      return yield* ImageProjectionConfigurationError.of('Image projection directory must be a regular directory.');
    }
  });
}
