import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {canonicalResourceUri, validatePortableSegment} from '@threadnote/store/resource-id';
import {
  REMOTE_MEMORY_PORTABILITY_VERSION,
  parseGitBetaImportPlan,
  verifyRemoteMemoryExportPlan,
  type GitBetaMemorySourceV1,
  type RemoteMemoryExportPlanV1,
} from '../portability.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_IMPORT_FILES = 10_000;
const MAX_IMPORT_TREE_ENTRIES = 50_000;
const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export class RemoteMemoryOperatorFileError extends Schema.TaggedError<
  RemoteMemoryOperatorFileError,
  {readonly brand: unique symbol}
>()('RemoteMemoryOperatorFileError', {message: Schema.String}) {}

export const readGitBetaMemorySources = Effect.fn('remoteMemory.operator.readGitBetaMemorySources')(function* (input: {
  readonly directory: string;
  readonly team: string;
  readonly user: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const user = yield* tryOperatorFile(() => validatePortableSegment(input.user));
  const team = yield* tryOperatorFile(() => validatePortableSegment(input.team));
  if (yield* isSymbolicLink(path.resolve(input.directory))) {
    return yield* operatorFileError('The Git beta source directory cannot be a symbolic link.');
  }
  const root = yield* fs.realPath(input.directory);
  const sourceRoot = path.join(root, 'durable', 'projects');
  yield* requireDirectoryWithoutSymlink(sourceRoot);
  const paths = yield* markdownFiles(sourceRoot);
  if (paths.length > MAX_IMPORT_FILES) {
    return yield* operatorFileError(`Git beta import exceeds ${MAX_IMPORT_FILES} Markdown files.`);
  }
  let totalBytes = 0;
  const sources: GitBetaMemorySourceV1[] = [];
  for (const sourcePath of paths) {
    const content = yield* readRegularFileWithoutSymlink(
      sourcePath,
      MAX_IMPORT_FILE_BYTES,
      'A Git beta memory exceeds the import size limit.',
    );
    const size = new TextEncoder().encode(content).byteLength;
    totalBytes += size;
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
      return yield* operatorFileError('Git beta import exceeds the total size limit.');
    }
    const segments = Effect2.pipe(path.relative(sourceRoot, sourcePath), EffectString.split(path.sep));
    const sourceUri = yield* tryOperatorFile(() =>
      canonicalResourceUri('user', [user, 'memories', 'shared', team, 'durable', 'projects', ...segments]),
    );
    sources.push({content, sourceUri, version: REMOTE_MEMORY_PORTABILITY_VERSION});
  }
  return sources.sort((left, right) => compareCodeUnits(left.sourceUri, right.sourceUri));
});

export const readOperatorJson = Effect.fn('remoteMemory.operator.readJson')(function* (file: string) {
  const content = yield* readRegularFileWithoutSymlink(
    file,
    MAX_JSON_BYTES,
    'Operator JSON input is not a bounded file.',
  );
  return yield* tryOperatorFile((): unknown => JSON.parse(content));
});

export const readGitBetaImportPlan = Effect.fn('remoteMemory.operator.readGitBetaImportPlan')(function* (file: string) {
  const raw = yield* readOperatorJson(file);
  return yield* tryOperatorFile(() => parseGitBetaImportPlan(raw));
});

export const writeOperatorJsonExclusive = Effect.fn('remoteMemory.operator.writeJsonExclusive')(function* (
  file: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(path.resolve(file)), {recursive: true});
  yield* fs.writeFileString(file, `${JSON.stringify(value, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
});

export const writeRemoteMemoryExportBundle = Effect.fn('remoteMemory.operator.writeExportBundle')(function* (
  outputDirectory: string,
  plan: RemoteMemoryExportPlanV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* tryOperatorFile(() => verifyRemoteMemoryExportPlan(plan));
  const output = path.resolve(outputDirectory);
  if (yield* fs.exists(output)) {
    return yield* operatorFileError('The export output directory already exists.');
  }
  const crypto = yield* Crypto.Crypto;
  const staging = path.join(path.dirname(output), `.threadnote-remote-export-${yield* crypto.randomUUIDv4()}`);
  yield* fs.makeDirectory(staging, {mode: 0o700, recursive: false});
  return yield* Effect.gen(function* () {
    for (const file of plan.files) {
      const target = yield* tryOperatorFile(() => containedExportPath(path, staging, file.relativePath));
      yield* fs.makeDirectory(path.dirname(target), {mode: 0o700, recursive: true});
      yield* fs.writeFileString(target, file.canonicalContent, {flag: 'wx', mode: 0o600});
    }
    const manifest = {
      bundleDigest: plan.bundleDigest,
      files: EffectArray.map(plan.files, file => ({
        aliases: file.aliases,
        contentHash: file.contentHash,
        relativePath: file.relativePath,
        sourceUri: file.sourceUri,
        version: file.version,
      })),
      sourceMutation: plan.sourceMutation,
      version: plan.version,
    };
    yield* fs.writeFileString(
      path.join(staging, 'threadnote-export.v1.json'),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
      {flag: 'wx', mode: 0o600},
    );
    yield* fs.rename(staging, output);
  }).pipe(Effect.onError(() => fs.remove(staging, {force: true, recursive: true}).pipe(Effect.ignore)));
});

const markdownFiles = Effect.fn('remoteMemory.operator.markdownFiles')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: string[] = [];
  const pending = [directory];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = yield* fs.readDirectory(current);
    for (const name of entries.sort(compareCodeUnits)) {
      visited += 1;
      if (visited > MAX_IMPORT_TREE_ENTRIES) {
        return yield* operatorFileError('Git beta import exceeds the bounded tree-entry limit.');
      }
      const candidate = path.join(current, name);
      if (yield* isSymbolicLink(candidate)) {
        return yield* operatorFileError('Operator input does not follow symbolic links.');
      }
      const info = yield* fs.stat(candidate);
      if (info.type === 'Directory') pending.push(candidate);
      else if (info.type === 'File' && Effect2.pipe(name, EffectString.endsWith('.md'))) {
        found.push(candidate);
        if (found.length > MAX_IMPORT_FILES) {
          return yield* operatorFileError(`Git beta import exceeds ${MAX_IMPORT_FILES} Markdown files.`);
        }
      }
    }
  }
  return found.sort(compareCodeUnits);
});

const requireDirectoryWithoutSymlink = Effect.fn('remoteMemory.operator.requireDirectory')(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const status = yield* fs.stat(directory);
  const real = yield* fs.realPath(directory);
  if ((yield* isSymbolicLink(directory)) || real !== path.resolve(directory) || status.type !== 'Directory') {
    return yield* operatorFileError('The Git beta source must contain a real durable/projects directory.');
  }
});

function containedExportPath(path: Path.Path, root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath))
    throw new Error('Remote export contains an invalid relative path.');
  const target = path.resolve(root, relativePath);
  const suffix = path.relative(root, target);
  if (
    !suffix ||
    suffix === '..' ||
    Effect2.pipe(suffix, EffectString.startsWith(`..${path.sep}`)) ||
    path.isAbsolute(suffix)
  ) {
    throw new Error('Remote export path escapes the output directory.');
  }
  return target;
}

const readRegularFileWithoutSymlink = Effect.fn('remoteMemory.operator.readRegularFile')(function* (
  file: string,
  maximumBytes: number,
  tooLarge: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* isSymbolicLink(file)) return yield* operatorFileError('Operator input does not follow symbolic links.');
  const actual = yield* fs.realPath(file);
  const info = yield* fs.stat(file);
  if (info.type !== 'File') return yield* operatorFileError('Operator input is not a regular file.');
  if (Number(info.size) > maximumBytes) return yield* operatorFileError(tooLarge);
  const content = yield* fs.readFileString(file);
  if (new TextEncoder().encode(content).byteLength > maximumBytes) {
    return yield* operatorFileError(tooLarge);
  }
  if ((yield* isSymbolicLink(file)) || (yield* fs.realPath(file)) !== actual) {
    return yield* operatorFileError('Operator input changed identity while it was read.');
  }
  return content;
});

const isSymbolicLink = Effect.fn('remoteMemory.operator.isSymbolicLink')((path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.readLink(path)),
    Effect.option,
    Effect.map(Option.isSome),
  ),
);

function tryOperatorFile<A>(evaluate: () => A): Effect.Effect<A, RemoteMemoryOperatorFileError> {
  return Effect.try({
    try: evaluate,
    catch: cause => operatorFileError(operatorFileFailureMessage(cause)),
  });
}

function operatorFileError(message: string): RemoteMemoryOperatorFileError {
  return RemoteMemoryOperatorFileError.make({message});
}

function operatorFileFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Invalid operator input.';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
