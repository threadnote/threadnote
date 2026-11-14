import {Effect, FileSystem, Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {platformPathFor} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {nativeVectorReaderHostProfile} from '@threadnote/recall/vector/native-reader-payload';

const path = platformPathFor(process.platform);
export const NATIVE_INFERENCE_DESCRIPTOR = 'native-inference.json';
export const NATIVE_INFERENCE_PACKAGE_VERSION = '3.22.2';
export const NATIVE_INFERENCE_LLAMA_COMMIT = '1729d2ec2c4846df7754f4ce8f90f75f8a30ca3b';
export const NATIVE_INFERENCE_BUNDLE_SHA256 = '1717cc2867373a8962212f4beeff8431565393fe087b0d8cf96769cc11d4036e';

export interface NativeInferenceFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
export interface NativeInferenceOverlay {
  readonly schemaVersion: 1;
  readonly bunVersion: string;
  readonly bunTarget: string;
  readonly packageVersion: '3.22.2';
  readonly llamaCommit: typeof NATIVE_INFERENCE_LLAMA_COMMIT;
  readonly sourceInputDigest: string;
  readonly origin: 'locked-prebuilt' | 'portable-local-build';
  readonly toolchain: Readonly<Record<string, string>>;
  readonly files: readonly NativeInferenceFile[];
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !EffectArray.isArray(value);
export function nativeInferencePayloadPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:runtime\/(?:node-llama-cpp\.js|NATIVE-LICENSE|native\/.+)|llama\/(?:localBuilds\/.+|lastBuild\.json|binariesGithubRelease\.json))$/u.test(
      value,
    ) &&
    EffectArray.every(
      EffectString.split(value, '/'),
      part => part !== '' && part !== '.' && part !== '..' && !EffectString.includes('\\')(part),
    )
  );
}
export function parseNativeInferenceOverlay(value: unknown): NativeInferenceOverlay {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.bunVersion !== '1.4.4' ||
    typeof value.bunTarget !== 'string' ||
    value.packageVersion !== NATIVE_INFERENCE_PACKAGE_VERSION ||
    value.llamaCommit !== NATIVE_INFERENCE_LLAMA_COMMIT ||
    !digest(value.sourceInputDigest) ||
    (value.origin !== 'locked-prebuilt' && value.origin !== 'portable-local-build') ||
    !object(value.toolchain) ||
    !EffectArray.every(EffectRecord.values(value.toolchain), field => typeof field === 'string') ||
    !EffectArray.isArray(value.files) ||
    value.files.length === 0
  )
    throw new Error('Invalid native inference overlay descriptor.');
  let previous = '';
  const files: NativeInferenceFile[] = [];
  for (const entry of value.files) {
    if (
      !object(entry) ||
      !nativeInferencePayloadPath(entry.path) ||
      !digest(entry.sha256) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.path <= previous
    )
      throw new Error('Invalid or duplicate native inference payload entry.');
    previous = entry.path;
    files.push({path: entry.path, sha256: entry.sha256, size: entry.size});
  }
  if (
    !EffectArray.some(files, file => file.path === 'runtime/node-llama-cpp.js') ||
    !EffectArray.some(files, file => EffectString.endsWith('.node')(file.path))
  )
    throw new Error('Native inference overlay is missing its runtime or addon.');
  if (
    value.origin === 'portable-local-build' &&
    (!EffectArray.some(files, file => /llama\/localBuilds\/[^/]+\/buildDone.status$/u.test(file.path)) ||
      !EffectArray.some(files, file => EffectString.endsWith('/Release/_nlcBuildMetadata.json')(file.path)))
  )
    throw new Error('Native inference local build is missing genuine upstream completion metadata.');
  return {
    schemaVersion: 1,
    bunVersion: value.bunVersion,
    bunTarget: value.bunTarget,
    packageVersion: NATIVE_INFERENCE_PACKAGE_VERSION,
    llamaCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
    sourceInputDigest: value.sourceInputDigest,
    origin: value.origin,
    toolchain: EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(value.toolchain), ([key, field]) => {
        if (typeof field !== 'string') throw new Error('Invalid native toolchain field.');
        return [key, field] as const;
      }),
    ),
    files,
  };
}

const inventory = Effect.fn('nativeInference.inventory')(function* (
  root: string,
  relative: string,
): Effect.fn.Return<NativeInferenceFile[], unknown, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const absolute = path.join(root, ...EffectString.split(relative, '/'));
  const stat = yield* fs.lstat(absolute);
  if (stat.type === 'SymbolicLink') throw new Error(`Native inference payload symlink is forbidden: ${relative}`);
  if (stat.type === 'Directory') {
    const entries: NativeInferenceFile[] = [];
    for (const name of [...(yield* fs.readDirectory(absolute))].sort())
      entries.push(...(yield* inventory(root, `${relative}/${name}`)));
    return entries;
  }
  if (stat.type !== 'File' || !nativeInferencePayloadPath(relative))
    throw new Error(`Invalid inference payload: ${relative}`);
  const bytes = yield* fs.readFile(absolute);
  return [{path: relative, sha256: sha256HexSync(bytes), size: bytes.length}];
});
export const nativeInferenceInventory = Effect.fn('nativeInference.inventoryClosure')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries: NativeInferenceFile[] = [];
  for (const parent of ['runtime', 'llama']) {
    const directory = path.join(root, parent);
    if (yield* fs.exists(directory)) {
      if ((yield* fs.lstat(directory)).type !== 'Directory')
        throw new Error(`Native inference parent must be a real directory: ${parent}`);
    }
  }
  for (const relative of [
    'runtime/node-llama-cpp.js',
    'runtime/NATIVE-LICENSE',
    'runtime/native',
    'llama/localBuilds',
    'llama/lastBuild.json',
    'llama/binariesGithubRelease.json',
  ]) {
    if (yield* fs.exists(path.join(root, relative))) entries.push(...(yield* inventory(root, relative)));
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
});
export const verifyNativeInferenceOverlay = Effect.fn('nativeInference.verify')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const descriptor = parseNativeInferenceOverlay(
    JSON.parse(yield* fs.readFileString(path.join(root, NATIVE_INFERENCE_DESCRIPTOR))),
  );
  const actual = yield* nativeInferenceInventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(descriptor.files))
    throw new Error('Native inference payload inventory/digest differs from its descriptor.');
  return descriptor;
});
export const publishNativeInferenceOverlay = Effect.fn('nativeInference.publish')(function* (
  root: string,
  fields: Omit<NativeInferenceOverlay, 'schemaVersion' | 'files'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const descriptor = parseNativeInferenceOverlay({
    schemaVersion: 1,
    ...fields,
    files: yield* nativeInferenceInventory(root),
  });
  yield* fs.writeFileString(path.join(root, NATIVE_INFERENCE_DESCRIPTOR), `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptor;
});
export const stageNativeInferenceOverlay = Effect.fn('nativeInference.stage')(function* (
  sourceRoot: string,
  destinationRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (path.resolve(sourceRoot) === path.resolve(destinationRoot))
    return yield* verifyNativeInferenceOverlay(sourceRoot);
  const descriptor = yield* verifyNativeInferenceOverlay(sourceRoot);
  for (const relative of ['runtime/native', 'llama/localBuilds', 'llama/lastBuild.json', NATIVE_INFERENCE_DESCRIPTOR])
    yield* fs.remove(path.join(destinationRoot, relative), {recursive: true, force: true});
  for (const file of descriptor.files) {
    const destination = path.join(destinationRoot, ...EffectString.split(file.path, '/'));
    yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
    yield* fs.copyFile(path.join(sourceRoot, ...EffectString.split(file.path, '/')), destination);
  }
  yield* fs.writeFileString(
    path.join(destinationRoot, NATIVE_INFERENCE_DESCRIPTOR),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  return yield* verifyNativeInferenceOverlay(destinationRoot);
});
export function nativeInferenceHostTarget() {
  return nativeVectorReaderHostProfile({platform: process.platform, architecture: process.arch});
}

/** Codesigning may change Mach-O bytes but cannot add or remove payload members. */
export const finalizeNativeInferenceOverlay = Effect.fn('nativeInference.finalize')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const previous = parseNativeInferenceOverlay(
    JSON.parse(yield* fs.readFileString(path.join(root, NATIVE_INFERENCE_DESCRIPTOR))),
  );
  const files = yield* nativeInferenceInventory(root);
  if (
    JSON.stringify(EffectArray.map(files, file => file.path)) !==
    JSON.stringify(EffectArray.map(previous.files, file => file.path))
  )
    throw new Error('Native inference payload membership changed during signing.');
  return yield* publishNativeInferenceOverlay(root, previous);
});
