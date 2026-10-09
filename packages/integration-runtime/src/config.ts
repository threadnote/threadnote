import {Crypto, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as yaml from 'js-yaml';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  isJsonObject,
  SourceConfigurationError,
  SourceConfigurationStore,
  type ConfigurationHome,
  type ConfigurationServices,
  type SourceConfigurationFailure,
  type ProjectionConfig,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';

export interface ConfigurationCodec<T extends SourceConfig | ProjectionConfig> {
  readonly type: T['type'];
  readonly versions?: readonly (1 | 2)[];
  readonly isConfigurationError?: (cause: unknown) => cause is SourceConfigurationFailure;
  parse(value: Record<string, unknown>, label: string): T;
  serialize(value: T): Record<string, unknown>;
}
export interface SourceConfigurationRegistry<
  S extends SourceConfig = SourceConfig,
  P extends ProjectionConfig = ProjectionConfig,
> {
  readonly empty: () => SourceConfiguration<S, P>;
  readonly parse: (raw: string, path?: string) => SourceConfiguration<S, P>;
  readonly isConfigurationError: (cause: unknown) => cause is SourceConfigurationFailure;
  render(value: SourceConfiguration): string;
}
const CONFIGURATION_FILENAME = 'sources.yaml';
const CONFIGURATION_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 5 * 60 * 1_000,
  waitTimeoutMilliseconds: 5_000,
} as const;

function indexedCodecs<T extends SourceConfig | ProjectionConfig>(codecs: readonly ConfigurationCodec<T>[]) {
  const result = new Map<string, ConfigurationCodec<T>>();
  for (const codec of codecs) {
    if (result.has(codec.type))
      throw SourceConfigurationError.make({message: `Duplicate configuration codec "${codec.type}".`});
    result.set(codec.type, {...codec, versions: codec.versions === undefined ? undefined : [...codec.versions]});
  }
  return result;
}

export function makeSourceConfigurationRegistry<S extends SourceConfig, P extends ProjectionConfig>(options: {
  readonly sources: readonly ConfigurationCodec<S>[];
  readonly projections: readonly ConfigurationCodec<P>[];
}): SourceConfigurationRegistry<S, P> {
  const sources = indexedCodecs(options.sources);
  const projections = indexedCodecs(options.projections);
  const parseEntry = <T extends SourceConfig | ProjectionConfig>(
    value: unknown,
    label: string,
    version: 1 | 2,
    codecs: ReadonlyMap<string, ConfigurationCodec<T>>,
  ): T => {
    if (!isJsonObject(value)) throw SourceConfigurationError.make({message: `${label} must be an object.`});
    const allowed = [...codecs.values()].filter(codec => (codec.versions ?? [2]).includes(version));
    const codec = allowed.find(candidate => candidate.type === value.type);
    if (!codec) {
      const types = allowed.map(candidate => `"${candidate.type}"`);
      const list = types.length <= 2 ? types.join(' or ') : `${types.slice(0, -1).join(', ')}, or ${types.at(-1)}`;
      throw SourceConfigurationError.make({message: `${label}.type must be ${list}.`});
    }
    return codec.parse(value, label);
  };
  const serializeEntry = <T extends SourceConfig | ProjectionConfig>(
    value: SourceConfig | ProjectionConfig,
    codecs: ReadonlyMap<string, ConfigurationCodec<T>>,
  ) => {
    const codec = codecs.get(value.type);
    if (!codec) throw SourceConfigurationError.make({message: `Unsupported configuration type "${value.type}".`});
    return codec.serialize(value as T);
  };
  const errorGuards = [...sources.values(), ...projections.values()].flatMap(codec =>
    codec.isConfigurationError ? [codec.isConfigurationError] : [],
  );
  const isConfigurationError = (cause: unknown): cause is SourceConfigurationFailure =>
    Schema.is(SourceConfigurationError)(cause) || errorGuards.some(isError => isError(cause));
  return {
    isConfigurationError,
    empty: () => ({version: 1, sources: [], projections: []}),
    parse: (raw, path = CONFIGURATION_FILENAME) => {
      let loaded: unknown;
      try {
        loaded = yaml.load(raw);
      } catch {
        throw SourceConfigurationError.make({message: `Source configuration contains invalid YAML: ${path}`});
      }
      if (!isJsonObject(loaded))
        throw SourceConfigurationError.make({message: `Source configuration must be an object: ${path}`});
      if (loaded.version !== 1 && loaded.version !== 2)
        throw SourceConfigurationError.make({
          message: `Unsupported source configuration version in ${path}. Expected 1 or 2.`,
        });
      if (!Array.isArray(loaded.sources) || !Array.isArray(loaded.projections))
        throw SourceConfigurationError.make({
          message: `Source configuration requires sources and projections arrays: ${path}`,
        });
      const version = loaded.version;
      const parsedSources = loaded.sources.map((value, index) =>
        parseEntry(value, `${path} sources[${index}]`, version, sources),
      );
      const parsedProjections = loaded.projections.map((value, index) =>
        parseEntry(value, `${path} projections[${index}]`, version, projections),
      );
      for (const [kind, entries] of [
        ['source', parsedSources],
        ['projection', parsedProjections],
      ] as const) {
        const ids = new Set<string>();
        for (const entry of entries) {
          if (ids.has(entry.id))
            throw SourceConfigurationError.make({message: `Duplicate ${kind} id "${entry.id}" in ${path}.`});
          ids.add(entry.id);
        }
      }
      return {version, sources: parsedSources, projections: parsedProjections};
    },
    render: value =>
      yaml.dump(
        {
          version: value.version,
          sources: value.sources.map(source => serializeEntry(source, sources)),
          projections: value.projections.map(projection => serializeEntry(projection, projections)),
        },
        {lineWidth: 100, noRefs: true, sortKeys: false},
      ),
  };
}

export const sourceConfigurationPath = Effect.fn('obsidian.configurationPath')(function* (config: ConfigurationHome) {
  return (yield* Path.Path).join(config.agentContextHome, 'threadnote', CONFIGURATION_FILENAME);
});

export function makeSourceConfigurationStore(registry: SourceConfigurationRegistry) {
  const readAt = Effect.fn('source.readConfigurationAt')(function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return registry.empty();
    const raw = yield* fs.readFileString(path);
    return yield* Effect.try({
      try: () => registry.parse(raw, path),
      catch: cause =>
        registry.isConfigurationError(cause)
          ? cause
          : SourceConfigurationError.make({message: 'Source configuration could not be parsed.'}),
    });
  });
  const writeAt = Effect.fn('source.writeConfigurationAt')(function* (path: string, serialized: string) {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const temporaryPath = `${path}.${yield* (yield* Crypto.Crypto).randomUUIDv4}.tmp`;
    yield* fs.writeFileString(temporaryPath, serialized, {mode: 0o600});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
    yield* fs.chmod(path, 0o600);
  });
  return {
    read: Effect.fn('source.readConfiguration')(function* (config: ConfigurationHome) {
      return yield* readAt(yield* sourceConfigurationPath(config));
    }),
    write: Effect.fn('source.writeConfiguration')(function* (config: ConfigurationHome, value: SourceConfiguration) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* sourceConfigurationPath(config);
      const serialized = registry.render(value);
      yield* withExclusiveFileLock(fs, `${path}.lock`, CONFIGURATION_LOCK_OPTIONS, writeAt(path, serialized));
      return path;
    }),
    mutate: Effect.fn('source.mutateConfiguration')(function* (
      config: ConfigurationHome,
      update: (current: SourceConfiguration) => SourceConfiguration,
    ) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* sourceConfigurationPath(config);
      yield* withExclusiveFileLock(
        fs,
        `${path}.lock`,
        CONFIGURATION_LOCK_OPTIONS,
        Effect.gen(function* () {
          const current = yield* readAt(path);
          const next = yield* Effect.try({
            try: () => update(current),
            catch: cause =>
              registry.isConfigurationError(cause)
                ? cause
                : SourceConfigurationError.make({message: 'Source configuration update failed.'}),
          });
          yield* writeAt(path, registry.render(next));
        }),
      );
      return path;
    }),
  };
}
export const sourceConfigurationStoreLayer = (registry: SourceConfigurationRegistry) =>
  Layer.effect(
    SourceConfigurationStore,
    Effect.gen(function* () {
      const services = yield* Effect.context<ConfigurationServices>();
      const storage = makeSourceConfigurationStore(registry);
      return SourceConfigurationStore.of({
        read: config => storage.read(config).pipe(Effect.provide(services)),
        write: (config, value) => storage.write(config, value).pipe(Effect.provide(services)),
        mutate: (config, update) => storage.mutate(config, update).pipe(Effect.provide(services)),
      });
    }),
  );
