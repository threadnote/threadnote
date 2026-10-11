import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {resourceAccountMutationGenerationPath} from './lock.js';

const CANONICAL_MUTATION_GENERATION_PATTERN =
  /^v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAXIMUM_CANONICAL_MUTATION_GENERATION_BYTES = 128;

export class CanonicalMutationGenerationInvalid extends Schema.TaggedError<CanonicalMutationGenerationInvalid>()(
  'CanonicalMutationGenerationInvalid',
  {message: Schema.String},
) {}

export interface CanonicalMutationGenerationTransition {
  readonly currentGeneration: string;
  readonly previousGeneration: string;
}

/**
 * Read the durable, account-scoped canonical mutation generation. Absence is
 * the initial generation; a malformed marker fails closed instead of allowing
 * an index to claim freshness against an untrustworthy clock.
 */
export const readCanonicalMutationGeneration = Effect.fn('resourceMutationGeneration.read')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  account: string,
) {
  const generationPath = resourceAccountMutationGenerationPath(path, home, account);
  if (!(yield* fs.exists(generationPath))) return '';
  if (Option.isSome(yield* fs.readLink(generationPath).pipe(Effect.option))) {
    return yield* CanonicalMutationGenerationInvalid.make({
      message: 'Canonical mutation generation must not be a symbolic link.',
    });
  }
  const info = yield* fs.stat(generationPath);
  if (info.type !== 'File' || Number(info.size) > MAXIMUM_CANONICAL_MUTATION_GENERATION_BYTES) {
    return yield* CanonicalMutationGenerationInvalid.make({
      message: 'Canonical mutation generation is not a bounded regular file.',
    });
  }
  const generation = (yield* fs.readFileString(generationPath)).trim();
  if (!CANONICAL_MUTATION_GENERATION_PATTERN.test(generation)) {
    return yield* CanonicalMutationGenerationInvalid.make({message: 'Canonical mutation generation is malformed.'});
  }
  return generation;
});

/**
 * Advance and fsync the durable generation before a canonical mutation while
 * the caller owns the account mutation lock. A failed advance prevents the
 * mutation, so every successful commit is discoverable even when derived
 * recall-index marker I/O later fails.
 */
export const advanceCanonicalMutationGeneration = Effect.fn('resourceMutationGeneration.advance')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  account: string,
) {
  const crypto = yield* Crypto.Crypto;
  const previousGeneration = yield* readCanonicalMutationGeneration(fs, path, home, account);
  const generationPath = resourceAccountMutationGenerationPath(path, home, account);
  const directory = path.dirname(generationPath);
  const generation = `v1:${yield* crypto.randomUUIDv4()}`;
  const temporaryPath = `${generationPath}.${yield* crypto.randomUUIDv4()}.tmp`;
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
      yield* file.writeAll(new TextEncoder().encode(`${generation}\n`));
      yield* file.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporaryPath, generationPath)),
    Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
  );
  yield* syncMutationGenerationDirectory(fs, directory);
  return {
    currentGeneration: generation,
    previousGeneration,
  } satisfies CanonicalMutationGenerationTransition;
});

function syncMutationGenerationDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(file => file.sync),
      Effect.ignore,
    ),
  );
}
