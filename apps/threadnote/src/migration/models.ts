import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {sha256FileHex} from '@threadnote/platform/digest';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection, writeModelSelection} from '@threadnote/inference/models/selection';

class LegacyLocalModelMigrationError extends Schema.TaggedError<
  LegacyLocalModelMigrationError,
  {readonly brand: unique symbol}
>()('LegacyLocalModelMigrationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export const LEGACY_LOCAL_MODEL_MIGRATION_ID = 'legacy-local-model-v1' as const;
const LEGACY_MODEL_DIRECTORY = 'threadnote/models';

export interface LegacyLocalModelMigrationOptions {
  readonly apply?: boolean;
  readonly home: string;
  /** Test seam for small deterministic model fixtures. */
  readonly manifests?: readonly LocalModelManifest[];
}

export interface LegacyLocalModelMigrationResult {
  readonly action: 'already_migrated' | 'dry_run' | 'migrated' | 'no_legacy_models' | 'resumed';
  readonly models: readonly string[];
}

interface LegacyLocalModelMigrationReceipt {
  readonly id: typeof LEGACY_LOCAL_MODEL_MIGRATION_ID;
  readonly models: readonly string[];
  readonly status: 'completed' | 'pending';
  readonly version: 1;
}

/**
 * Checks only the bounded legacy model catalog and resumable receipt. Model
 * bytes are verified by the applying migration, not while deciding whether an
 * update should offer it.
 */
export const isLegacyLocalModelMigrationPending = Effect.fn('legacyLocalModelMigration.isPending')(function* (
  options: Pick<LegacyLocalModelMigrationOptions, 'home' | 'manifests'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.resolve(options.home);
  yield* assertLegacyModelAncestors(fs, path, home);
  const manifests = options.manifests ?? BUILTIN_MODEL_MANIFESTS;
  const receipt = yield* readReceipt(fs, path.join(home, 'migration', `${LEGACY_LOCAL_MODEL_MIGRATION_ID}.json`));
  if (receipt?.status === 'completed') return false;
  if (receipt?.status === 'pending') {
    for (const modelId of receipt.models) {
      const manifest = Option.getOrUndefined(EffectArray.findFirst(manifests, candidate => candidate.id === modelId));
      if (!manifest) {
        return yield* LegacyLocalModelMigrationError.make({
          message: `Legacy model migration receipt references unknown model ${modelId}.`,
        });
      }
      yield* inspectLegacyModelCandidate(fs, path.join(home, LEGACY_MODEL_DIRECTORY, manifest.file), manifest);
    }
    return true;
  }
  return (yield* discoverLegacyModels(fs, path, home, manifests)).length > 0;
});

/**
 * Adopts verified 3.x managed GGUF files into the role-aware 4.x model store.
 * The model is renamed on the same filesystem, so upgrading does not require a
 * second multi-gigabyte copy or a new download.
 */
export const migrateLegacyLocalModels = Effect.fn('legacyLocalModelMigration.migrate')(function* (
  options: LegacyLocalModelMigrationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.resolve(options.home);
  yield* assertLegacyModelAncestors(fs, path, home);
  const manifests = options.manifests ?? BUILTIN_MODEL_MANIFESTS;
  const receiptPath = path.join(home, 'migration', `${LEGACY_LOCAL_MODEL_MIGRATION_ID}.json`);
  const existingReceipt = yield* readReceipt(fs, receiptPath);
  const legacyModels = existingReceipt?.models ?? (yield* discoverLegacyModels(fs, path, home, manifests));
  if (legacyModels.length === 0) {
    return {action: 'no_legacy_models', models: []} satisfies LegacyLocalModelMigrationResult;
  }
  if (existingReceipt?.status === 'completed') {
    return {action: 'already_migrated', models: legacyModels} satisfies LegacyLocalModelMigrationResult;
  }
  if (options.apply !== true) {
    return {action: 'dry_run', models: legacyModels} satisfies LegacyLocalModelMigrationResult;
  }

  const receipt: LegacyLocalModelMigrationReceipt = existingReceipt ?? {
    id: LEGACY_LOCAL_MODEL_MIGRATION_ID,
    models: legacyModels,
    status: 'pending',
    version: 1,
  };
  if (!existingReceipt) {
    yield* writeReceipt(fs, path, receiptPath, receipt);
  }

  let resumed = false;
  for (const modelId of legacyModels) {
    const manifest = Option.getOrUndefined(EffectArray.findFirst(manifests, candidate => candidate.id === modelId));
    if (!manifest) {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Legacy model migration receipt references unknown model ${modelId}.`,
      });
    }
    const source = path.join(home, LEGACY_MODEL_DIRECTORY, manifest.file);
    const directory = path.join(home, 'models', manifest.role, manifest.id);
    const target = path.join(directory, `${manifest.sha256}.gguf`);
    yield* assertLegacyModelAncestors(fs, path, home);
    const sourceExists = yield* inspectLegacyModelCandidate(fs, source, manifest);
    const targetExists = yield* fs.exists(target);
    if (sourceExists && targetExists) {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Both legacy and canonical model files exist for ${manifest.id}; refusing to overwrite either.`,
      });
    }
    if (sourceExists) {
      yield* verifyModel(fs, source, manifest);
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      yield* assertLegacyModelAncestors(fs, path, home);
      yield* inspectLegacyModelCandidate(fs, source, manifest);
      yield* fs.rename(source, target);
      yield* fs.chmod(target, 0o600);
    } else if (targetExists) {
      resumed = true;
      yield* verifyModel(fs, target, manifest);
    } else {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Model ${manifest.id} disappeared while its legacy migration was pending.`,
      });
    }
    yield* fs.writeFileString(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, {
      mode: 0o600,
    });
  }

  const generationModel = Option.getOrUndefined(
    EffectArray.findFirst(
      EffectArray.map(legacyModels, id =>
        Option.getOrUndefined(EffectArray.findFirst(manifests, candidate => candidate.id === id)),
      ),
      (manifest): manifest is LocalModelManifest => manifest?.role === 'generation',
    ),
  );
  if (generationModel) {
    const selection = yield* readModelSelection(home);
    if (selection.roles.generation === undefined) {
      yield* writeModelSelection(home, {
        roles: {...selection.roles, generation: generationModel.id},
        version: selection.version,
      });
    }
  }

  yield* writeReceipt(fs, path, receiptPath, {...receipt, status: 'completed'});
  return {
    action: resumed ? 'resumed' : 'migrated',
    models: legacyModels,
  } satisfies LegacyLocalModelMigrationResult;
});

function discoverLegacyModels(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  manifests: readonly LocalModelManifest[],
) {
  return Effect.gen(function* () {
    const found: string[] = [];
    for (const manifest of manifests) {
      if (yield* inspectLegacyModelCandidate(fs, path.join(home, LEGACY_MODEL_DIRECTORY, manifest.file), manifest)) {
        found.push(manifest.id);
      }
    }
    return found;
  });
}

function assertLegacyModelAncestors(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const canonicalHome = (yield* fs.exists(home)) ? yield* fs.realPath(home) : undefined;
    for (const relative of ['threadnote', LEGACY_MODEL_DIRECTORY] as const) {
      const ancestor = path.join(home, relative);
      if (Option.isSome(yield* fs.readLink(ancestor).pipe(Effect.option))) {
        return yield* LegacyLocalModelMigrationError.make({
          message: `Legacy model parent ${relative} must not be a symbolic link.`,
        });
      }
      if (!(yield* fs.exists(ancestor))) continue;
      const info = yield* fs.stat(ancestor);
      if (info.type !== 'Directory') {
        return yield* LegacyLocalModelMigrationError.make({
          message: `Legacy model parent ${relative} must be a regular directory.`,
        });
      }
      if (canonicalHome !== undefined) {
        const canonicalAncestor = yield* fs.realPath(ancestor);
        if (path.resolve(canonicalAncestor) !== path.resolve(canonicalHome, relative)) {
          return yield* LegacyLocalModelMigrationError.make({
            message: `Legacy model parent ${relative} resolves outside its owned path.`,
          });
        }
      }
    }
  });
}

function inspectLegacyModelCandidate(fs: FileSystem.FileSystem, modelPath: string, manifest: LocalModelManifest) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(modelPath).pipe(Effect.option))) {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Legacy model ${manifest.id} must not be a symbolic link.`,
      });
    }
    if (!(yield* fs.exists(modelPath))) return false;
    const info = yield* fs.stat(modelPath);
    if (info.type !== 'File') {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Legacy model ${manifest.id} must be a regular file.`,
      });
    }
    return true;
  });
}

function verifyModel(fs: FileSystem.FileSystem, modelPath: string, manifest: LocalModelManifest) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(modelPath).pipe(Effect.option))) {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Legacy model ${manifest.id} must not be a symbolic link.`,
      });
    }
    const info = yield* fs.stat(modelPath);
    if (info.type !== 'File' || Number(info.size) !== manifest.size) {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Legacy model ${manifest.id} has ${Number(info.size)} bytes; expected ${manifest.size}.`,
      });
    }
    const digest = yield* sha256FileHex(modelPath);
    if (digest !== manifest.sha256) {
      return yield* LegacyLocalModelMigrationError.make({
        message: `Legacy model ${manifest.id} checksum is ${digest}; expected ${manifest.sha256}.`,
      });
    }
  });
}

function readReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<LegacyLocalModelMigrationReceipt | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => {
      const value: unknown = JSON.parse(content);
      if (!Predicate.isObject(value)) {
        throw LegacyLocalModelMigrationError.make({message: 'Invalid legacy local-model migration receipt.'});
      }
      const parsed = value;
      if (
        parsed.id !== LEGACY_LOCAL_MODEL_MIGRATION_ID ||
        parsed.version !== 1 ||
        (parsed.status !== 'pending' && parsed.status !== 'completed') ||
        !EffectArray.isArray(parsed.models) ||
        !EffectArray.every(parsed.models, model => typeof model === 'string')
      ) {
        throw LegacyLocalModelMigrationError.make({message: 'Invalid legacy local-model migration receipt.'});
      }
      return {
        id: LEGACY_LOCAL_MODEL_MIGRATION_ID,
        models: parsed.models,
        status: parsed.status === 'pending' ? ('pending' as const) : ('completed' as const),
        version: 1 as const,
      };
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

function writeReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  receiptPath: string,
  receipt: LegacyLocalModelMigrationReceipt,
) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
    const temporary = `${receiptPath}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(receipt, undefined, 2)}\n`, {mode: 0o600});
    yield* fs.rename(temporary, receiptPath);
  });
}
