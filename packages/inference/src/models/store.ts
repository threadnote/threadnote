import {Context, Crypto, Effect, FileSystem, Layer, Option, Path, Result, Schema} from 'effect';
import {
  InsufficientDiskSpace,
  ModelChecksumMismatch,
  ModelDownloadFailed,
  ModelNotInstalled,
} from '../engine/errors.js';
import {sha256FileHex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {HttpService, type HttpServiceShape} from '@threadnote/platform/http';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {extractBundledModelSource, type BundledModelSourceExtractor} from './bundled-model-source.js';
import {modelArtifactFileIdentity, sameModelArtifactFile, type ModelArtifactFileIdentity} from './artifact_identity.js';
import type {LocalModelManifest} from './catalog.js';

export interface LocalModelInstallation {
  readonly bytes: number;
  readonly installed: boolean;
  readonly modelId: string;
  readonly partialBytes: number;
  readonly path: string;
  readonly verified: boolean;
  readonly fileIdentity?: ModelArtifactFileIdentity;
}

export interface LocalModelInstallResult extends LocalModelInstallation {
  readonly resumed: boolean;
  readonly sourceUrl: string;
}

export interface LocalModelInstallOptions {
  readonly sourcePath?: string;
  readonly requireKnownDiskSpace?: boolean;
  readonly sourceUrl?: string;
  /** Bounded worker progress/fence hook; never called under the setup-state lock. */
  readonly onStage?: (stage: 'downloading' | 'verifying' | 'publishing', bytes: number) => Effect.Effect<void, unknown>;
}

export interface LocalModelLockEvent {
  readonly lockPath: string;
  readonly modelId: string;
  readonly operation: string;
}

export interface LocalModelStoreLayerOptions {
  readonly extractBundledSource?: BundledModelSourceExtractor;
  readonly onModelLockAcquired?: (event: LocalModelLockEvent) => Effect.Effect<void, never>;
  readonly onModelLockCompleted?: (event: LocalModelLockEvent) => Effect.Effect<void, never>;
  readonly onModelLockContention?: (event: LocalModelLockEvent) => Effect.Effect<void, never>;
}

export class ModelStoreIoFailed extends Schema.TaggedError<ModelStoreIoFailed>()('ModelStoreIoFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
  operation: Schema.String,
}) {}

export type LocalModelStoreError =
  InsufficientDiskSpace | ModelChecksumMismatch | ModelDownloadFailed | ModelNotInstalled | ModelStoreIoFailed;

export interface LocalModelStoreShape {
  readonly install: (
    home: string,
    manifest: LocalModelManifest,
    options?: LocalModelInstallOptions,
  ) => Effect.Effect<LocalModelInstallResult, LocalModelStoreError>;
  readonly path: (home: string, manifest: LocalModelManifest) => string;
  readonly remove: (home: string, manifest: LocalModelManifest) => Effect.Effect<boolean, LocalModelStoreError>;
  readonly status: (
    home: string,
    manifest: LocalModelManifest,
  ) => Effect.Effect<LocalModelInstallation, LocalModelStoreError>;
  readonly verify: (
    home: string,
    manifest: LocalModelManifest,
  ) => Effect.Effect<LocalModelInstallation, LocalModelStoreError>;
}

export class LocalModelStore extends Context.Service<LocalModelStore, LocalModelStoreShape>()(
  '@threadnote/inference/models/store/LocalModelStore',
) {
  static layerWith(options: LocalModelStoreLayerOptions = {}) {
    return Layer.effect(
      LocalModelStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const http = yield* HttpService;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const platform = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo>();
        const providePlatform = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, Exclude<R, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo>> =>
          effect.pipe(Effect.provide(platform));
        return LocalModelStore.of(makeLocalModelStore(fs, http, path, system, providePlatform, options));
      }),
    );
  }

  static readonly layer = LocalModelStore.layerWith();
}

// GitHub marks these releases immutable, and each asset is named by its verified model digest.
const THREADNOTE_MODEL_RELEASES_BY_SHA256: Readonly<Record<string, string>> = {
  f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804: 'v4.1.1',
};

function makeLocalModelStore(
  fs: FileSystem.FileSystem,
  http: HttpServiceShape,
  path: Path.Path,
  system: SystemInfoShape,
  providePlatform: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo>>,
  layerOptions: LocalModelStoreLayerOptions,
): LocalModelStoreShape {
  const verifiedModels = new Map<string, LocalModelInstallation>();
  const modelPath = (home: string, manifest: LocalModelManifest) =>
    path.join(modelDirectory(path, home, manifest), `${manifest.sha256}.gguf`);
  const partialPath = (home: string, manifest: LocalModelManifest) => `${modelPath(home, manifest)}.partial`;
  const status = (home: string, manifest: LocalModelManifest) =>
    Effect.gen(function* () {
      const installedPath = modelPath(home, manifest);
      const partial = partialPath(home, manifest);
      const installed = yield* fs.exists(installedPath);
      const partialExists = yield* fs.exists(partial);
      const bytes = installed ? Number((yield* fs.stat(installedPath)).size) : 0;
      const partialBytes = partialExists ? Number((yield* fs.stat(partial)).size) : 0;
      return {
        bytes,
        installed,
        modelId: manifest.id,
        partialBytes,
        path: installedPath,
        verified: false,
      };
    }).pipe(mapStoreIoError(manifest, 'status'));
  const verificationCacheKey = (home: string, manifest: LocalModelManifest) =>
    `${modelPath(home, manifest)}\0${manifest.sha256}`;
  const cacheVerifiedInstallation = (
    home: string,
    manifest: LocalModelManifest,
    installation: LocalModelInstallation,
  ) =>
    Effect.sync(() => {
      if (installation.fileIdentity) verifiedModels.set(verificationCacheKey(home, manifest), installation);
    });
  const cachedVerification = (home: string, manifest: LocalModelManifest) =>
    Effect.gen(function* () {
      const cached = verifiedModels.get(verificationCacheKey(home, manifest));
      if (!cached?.fileIdentity || !(yield* fs.exists(cached.path))) return Option.none<LocalModelInstallation>();
      const identity = yield* modelArtifactFileIdentity(cached.path);
      return identity && sameModelArtifactFile(identity, cached.fileIdentity)
        ? Option.some(cached)
        : Option.none<LocalModelInstallation>();
    }).pipe(mapStoreIoError(manifest, 'verify'));
  const verifyArtifact = (file: string, manifest: LocalModelManifest) =>
    Effect.gen(function* () {
      const before = yield* modelArtifactFileIdentity(file);
      if (!before || before.size !== String(manifest.size))
        return yield* checksumMismatch(manifest, 'invalid-file-size');
      const digest = yield* providePlatform(sha256FileHex(file));
      const after = yield* modelArtifactFileIdentity(file);
      if (!after || !sameModelArtifactFile(before, after))
        return yield* ModelStoreIoFailed.make({
          cause: 'artifact-changed-during-verification',
          message: 'Model changed during verification.',
          modelId: manifest.id,
          operation: 'verification-identity',
        });
      if (digest !== manifest.sha256) return yield* checksumMismatch(manifest, digest);
      return after;
    });
  const verifyUnlocked = (home: string, manifest: LocalModelManifest, allowCache: boolean) =>
    Effect.gen(function* () {
      const current = yield* status(home, manifest);
      if (!current.installed) {
        return yield* ModelNotInstalled.make({
          message: `Model ${manifest.id} is not installed.`,
          modelId: manifest.id,
          path: current.path,
        });
      }
      if (current.bytes !== manifest.size) {
        return yield* checksumMismatch(manifest, `size:${current.bytes}`);
      }
      if (allowCache) {
        const cached = yield* cachedVerification(home, manifest);
        if (Option.isSome(cached)) return cached.value;
      }
      const fileIdentity = yield* verifyArtifact(current.path, manifest);
      const verified = {...current, verified: true, fileIdentity};
      yield* cacheVerifiedInstallation(home, manifest, verified);
      return verified;
    }).pipe(mapStoreIoError(manifest, 'verify'));
  const withModelLock = <A, E, R>(
    home: string,
    manifest: LocalModelManifest,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ) => {
    const lockPath = path.join(home, 'locks', 'models', `${manifest.id}.lock`);
    const event = {lockPath, modelId: manifest.id, operation};
    return providePlatform(
      withExclusiveFileLock(
        fs,
        lockPath,
        {
          heartbeatIntervalMilliseconds: 10_000,
          ...(layerOptions.onModelLockAcquired ? {onAcquired: () => layerOptions.onModelLockAcquired!(event)} : {}),
          ...(layerOptions.onModelLockCompleted ? {onCompleted: () => layerOptions.onModelLockCompleted!(event)} : {}),
          ...(layerOptions.onModelLockContention
            ? {onContention: () => layerOptions.onModelLockContention!(event)}
            : {}),
          retryIntervalMilliseconds: 100,
          staleAfterMilliseconds: 60_000,
          waitTimeoutMilliseconds: 60_000,
        },
        effect,
      ).pipe(mapStoreIoError(manifest, operation)),
    );
  };
  return {
    install: (home, manifest, options) => {
      const sourcePath = options?.sourcePath;
      const install = Effect.gen(function* () {
        const current = yield* status(home, manifest);
        const sourceUrl = options?.sourceUrl ?? modelDownloadUrl(manifest);
        const directory = modelDirectory(path, home, manifest);
        if (current.installed) {
          yield* options?.onStage?.('verifying', current.bytes) ?? Effect.void;
          const verified = yield* verifyUnlocked(home, manifest, false).pipe(Effect.result);
          if (Result.isSuccess(verified)) {
            return {...verified.success, resumed: false, sourceUrl};
          }
          if (!Schema.is(ModelChecksumMismatch)(verified.failure)) {
            return yield* verified.failure;
          }
          yield* fs.remove(modelPath(home, manifest), {force: true});
          yield* fs.remove(path.join(directory, 'manifest.json'), {force: true});
        }
        yield* options?.onStage?.('downloading', current.partialBytes) ?? Effect.void;
        const partial = partialPath(home, manifest);
        yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
        let offset = sourcePath === undefined ? current.partialBytes : 0;
        if (sourcePath !== undefined && current.partialBytes > 0) {
          yield* fs.remove(partial, {force: true});
        }
        if (offset > manifest.size) {
          yield* fs.remove(partial, {force: true});
          offset = 0;
        }
        const availableBytes = yield* system.availableDiskBytes(directory).pipe(
          Effect.mapError(cause =>
            ModelStoreIoFailed.make({
              cause,
              message: `Could not inspect free space before downloading ${manifest.id}.`,
              modelId: manifest.id,
              operation: 'disk-space-preflight',
            }),
          ),
        );
        if (availableBytes === undefined && options?.requireKnownDiskSpace) {
          return yield* ModelStoreIoFailed.make({
            cause: 'unknown-disk-space',
            message: 'Available model disk space is unknown.',
            modelId: manifest.id,
            operation: 'unknown-disk-space',
          });
        }
        if (availableBytes !== undefined) {
          yield* assertSufficientModelDiskSpace(
            manifest,
            availableBytes,
            sourcePath === undefined ? manifest.size - offset : manifest.size,
          );
        }
        const resumed =
          sourcePath === undefined
            ? yield* http.downloadToFile(sourceUrl, partial, {offset}).pipe(
                Effect.map(response => offset > 0 && response.resumed),
                Effect.mapError(cause =>
                  ModelDownloadFailed.make({
                    cause,
                    message: `Could not download model ${manifest.id}: ${cause.message}`,
                    modelId: manifest.id,
                  }),
                ),
              )
            : yield* (layerOptions.extractBundledSource ?? extractBundledModelSource)(sourcePath, partial).pipe(
                Effect.tapError(() => fs.remove(partial, {force: true}).pipe(Effect.ignore)),
                Effect.mapError(cause =>
                  ModelStoreIoFailed.make({
                    cause,
                    message: `Could not extract bundled model ${manifest.id}.`,
                    modelId: manifest.id,
                    operation: 'extract-bundled-source',
                  }),
                ),
                Effect.as(false),
              );
        const downloadedBytes = Number((yield* fs.stat(partial)).size);
        if (downloadedBytes !== manifest.size) {
          if (sourcePath !== undefined) yield* fs.remove(partial, {force: true});
          return yield* ModelDownloadFailed.make({
            cause: {actualBytes: downloadedBytes, expectedBytes: manifest.size},
            message:
              sourcePath === undefined
                ? `Model ${manifest.id} download has ${downloadedBytes} bytes; expected ${manifest.size}. The partial file was retained for resume.`
                : `Bundled model ${manifest.id} has ${downloadedBytes} bytes; expected ${manifest.size}.`,
            modelId: manifest.id,
          });
        }
        yield* options?.onStage?.('verifying', downloadedBytes) ?? Effect.void;
        yield* verifyArtifact(partial, manifest).pipe(
          Effect.tapError(error =>
            Schema.is(ModelChecksumMismatch)(error)
              ? fs.remove(partial, {force: true}).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
        yield* options?.onStage?.('publishing', downloadedBytes) ?? Effect.void;
        const installedPath = modelPath(home, manifest);
        yield* fs.rename(partial, installedPath);
        yield* fs.chmod(installedPath, 0o600);
        // Rename/chmod change ctime. Bind the published file with a stable final-path hash,
        // rather than treating a new stat as proof of the previously verified bytes.
        const fileIdentity = yield* verifyArtifact(installedPath, manifest);
        yield* writeManifestReceipt(fs, path, directory, manifest);
        const installed = {
          bytes: downloadedBytes,
          installed: true,
          modelId: manifest.id,
          partialBytes: 0,
          path: installedPath,
          resumed,
          sourceUrl,
          verified: true,
          fileIdentity,
        };
        yield* cacheVerifiedInstallation(home, manifest, installed);
        return installed;
      });
      return withModelLock(
        home,
        manifest,
        'install',
        sourcePath === undefined ? install : Effect.uninterruptible(install),
      );
    },
    path: modelPath,
    remove: (home, manifest) =>
      withModelLock(
        home,
        manifest,
        'remove',
        Effect.gen(function* () {
          const directory = modelDirectory(path, home, manifest);
          if (!(yield* fs.exists(directory))) return false;
          yield* fs.remove(directory, {recursive: true});
          verifiedModels.delete(verificationCacheKey(home, manifest));
          return true;
        }),
      ),
    status,
    verify: (home, manifest) =>
      cachedVerification(home, manifest).pipe(
        Effect.flatMap(cached =>
          Option.isSome(cached)
            ? Effect.succeed(cached.value)
            : withModelLock(home, manifest, 'verify', verifyUnlocked(home, manifest, true)),
        ),
      ),
  };
}

export function modelDownloadUrl(manifest: LocalModelManifest): string {
  const threadnoteRelease = THREADNOTE_MODEL_RELEASES_BY_SHA256[manifest.sha256];
  if (threadnoteRelease) {
    return `https://github.com/threadnote/threadnote/releases/download/${threadnoteRelease}/${manifest.sha256}.gguf`;
  }
  const repository = manifest.repository.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const file = manifest.file.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repository}/resolve/${manifest.revision}/${file}`;
}

function modelDirectory(path: Path.Path, home: string, manifest: LocalModelManifest): string {
  return path.join(home, 'models', manifest.role, manifest.id);
}

function checksumMismatch(manifest: LocalModelManifest, actual: string): ModelChecksumMismatch {
  return ModelChecksumMismatch.make({
    actual,
    expected: manifest.sha256,
    message: `Model ${manifest.id} checksum does not match its immutable manifest.`,
    modelId: manifest.id,
  });
}

function writeManifestReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  manifest: LocalModelManifest,
) {
  return Effect.gen(function* () {
    const target = path.join(directory, 'manifest.json');
    const temporary = `${target}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`, {mode: 0o600});
    yield* fs.rename(temporary, target);
  });
}

function mapStoreIoError(manifest: LocalModelManifest, operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LocalModelStoreError, R> =>
    effect.pipe(
      Effect.mapError(error =>
        Schema.is(ModelChecksumMismatch)(error) ||
        Schema.is(InsufficientDiskSpace)(error) ||
        Schema.is(ModelDownloadFailed)(error) ||
        Schema.is(ModelNotInstalled)(error) ||
        Schema.is(ModelStoreIoFailed)(error)
          ? error
          : ModelStoreIoFailed.make({
              cause: error,
              message: `Local model ${operation} failed for ${manifest.id}.`,
              modelId: manifest.id,
              operation,
            }),
      ),
    );
}

export function assertSufficientModelDiskSpace(
  manifest: LocalModelManifest,
  availableBytes: number,
  remainingModelBytes: number,
): Effect.Effect<void, InsufficientDiskSpace> {
  const requiredBytes = Math.max(0, remainingModelBytes) + Math.min(512 * 1024 * 1024, manifest.size);
  return availableBytes >= requiredBytes
    ? Effect.void
    : Effect.fail(
        InsufficientDiskSpace.make({
          availableBytes,
          message: `Model ${manifest.id} needs ${requiredBytes} free bytes to download and promote safely; only ${availableBytes} are available.`,
          modelId: manifest.id,
          requiredBytes,
        }),
      );
}
