import {
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Result,
  Schedule,
  Schema,
} from 'effect';
import {uriSegment} from '@threadnote/store/resource-segment';
import {globToRegExp} from '@threadnote/platform/glob';
import {readExclusiveFileLockOwner, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath} from './resource/lock.js';
import {
  advanceCanonicalMutationGeneration,
  type CanonicalMutationGenerationTransition,
} from './resource/mutation_generation.js';
import {ResourceRecallInvalidation, type ResourceRecallInvalidationShape} from './resource/recall-invalidation.js';
import {SystemInfo} from '@threadnote/platform/system';
import {
  canonicalResourceUri,
  InvalidResourceId,
  parseResourceId,
  resourceIdWithoutAnchor,
  type ResourceId,
  validatePortableSegment,
} from '@threadnote/store/resource-id';
import {threadnoteStorageLayout} from '@threadnote/store/layout';
import {sha256Hex} from '@threadnote/platform/digest';
import {ExternalSourcePolicy, externalResourceAccess} from './external-resource.js';

export interface ResourceStoreLocation {
  readonly account: string;
  readonly home: string;
  readonly user: string;
}

export interface ResourceMutationLockEvent {
  readonly account: string;
  readonly lockPath: string;
  readonly uri: string;
}

export interface ResourceStoreLayerOptions {
  readonly onMutationLockAcquired?: (event: ResourceMutationLockEvent) => Effect.Effect<void, never>;
  readonly onMutationLockCompleted?: (event: ResourceMutationLockEvent) => Effect.Effect<void, never>;
  readonly onMutationLockContention?: (event: ResourceMutationLockEvent) => Effect.Effect<void, never>;
  readonly onRecallInvalidationFailed?: (event: ResourceRecallInvalidationFailureEvent) => Effect.Effect<void, never>;
}

export interface ResourceRecallInvalidationFailureEvent {
  readonly account: string;
  readonly includeInactive: boolean;
  readonly invalidatedUriCount: number;
}

export interface ResourceStoreEntry {
  readonly modifiedAt?: string;
  readonly size: number;
  readonly type: 'directory' | 'file';
  readonly uri: string;
}

export type ResourceStoreBoundedRead =
  {readonly content: string; readonly truncated: false} | {readonly truncated: true};

export interface ResourceStoreWriteOptions {
  readonly expectedFingerprint?: string;
  readonly mode: 'create' | 'replace' | 'upsert';
}

export type ResourceStoreMutation =
  | {
      readonly content: string;
      readonly options: ResourceStoreWriteOptions;
      readonly type: 'write';
      readonly uri: string;
    }
  | {
      readonly ignoreMissing?: boolean;
      readonly options?: {readonly expectedFingerprint?: string; readonly recursive?: boolean};
      readonly type: 'remove';
      readonly uri: string;
    };

export interface ResourceStoreGrepMatch {
  readonly line: number;
  readonly text: string;
  readonly uri: string;
}

export interface ResourceStoreMultiGrepMatch extends ResourceStoreGrepMatch {
  readonly term: string;
}

export class ResourceAccessDenied extends Schema.TaggedError<ResourceAccessDenied>()('ResourceAccessDenied', {
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceAlreadyExists extends Schema.TaggedError<ResourceAlreadyExists>()('ResourceAlreadyExists', {
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceConflict extends Schema.TaggedError<ResourceConflict>()('ResourceConflict', {
  actualFingerprint: Schema.String,
  expectedFingerprint: Schema.String,
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceIoFailed extends Schema.TaggedError<ResourceIoFailed>()('ResourceIoFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceNotFound extends Schema.TaggedError<ResourceNotFound>()('ResourceNotFound', {
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourcePathUnsafe extends Schema.TaggedError<ResourcePathUnsafe>()('ResourcePathUnsafe', {
  message: Schema.String,
  path: Schema.String,
  uri: Schema.String,
}) {}

export type ResourceStoreError =
  | InvalidResourceId
  | ResourceAccessDenied
  | ResourceAlreadyExists
  | ResourceConflict
  | ResourceIoFailed
  | ResourceNotFound
  | ResourcePathUnsafe;

export interface ResourceStoreShape {
  readonly fingerprint: (content: string | Uint8Array) => Effect.Effect<string, ResourceStoreError>;
  readonly glob: (
    location: ResourceStoreLocation,
    uri: string,
    pattern: string,
  ) => Effect.Effect<readonly ResourceStoreEntry[], ResourceStoreError>;
  readonly grep: (
    location: ResourceStoreLocation,
    uri: string,
    term: string,
    limit?: number,
  ) => Effect.Effect<readonly ResourceStoreGrepMatch[], ResourceStoreError>;
  readonly grepMany: (
    location: ResourceStoreLocation,
    uri: string,
    terms: readonly string[],
    limitPerTerm?: number,
  ) => Effect.Effect<readonly ResourceStoreMultiGrepMatch[], ResourceStoreError>;
  readonly list: (
    location: ResourceStoreLocation,
    uri: string,
    options?: {readonly recursive?: boolean},
  ) => Effect.Effect<readonly ResourceStoreEntry[], ResourceStoreError>;
  readonly makeDirectory: (location: ResourceStoreLocation, uri: string) => Effect.Effect<void, ResourceStoreError>;
  readonly mutate: (
    location: ResourceStoreLocation,
    mutations: readonly ResourceStoreMutation[],
  ) => Effect.Effect<void, ResourceStoreError>;
  /** Preflight every mutation, then run a read-only check and the batch under one account mutation lock. */
  readonly mutateChecked: <E, R>(
    location: ResourceStoreLocation,
    mutations: readonly ResourceStoreMutation[],
    check: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, E | ResourceStoreError, R>;
  readonly read: (location: ResourceStoreLocation, uri: string) => Effect.Effect<string, ResourceStoreError>;
  readonly readBounded: (
    location: ResourceStoreLocation,
    uri: string,
    maximumBytes: number,
  ) => Effect.Effect<ResourceStoreBoundedRead, ResourceStoreError>;
  readonly remove: (
    location: ResourceStoreLocation,
    uri: string,
    options?: {readonly expectedFingerprint?: string; readonly recursive?: boolean},
  ) => Effect.Effect<void, ResourceStoreError>;
  readonly stat: (
    location: ResourceStoreLocation,
    uri: string,
  ) => Effect.Effect<ResourceStoreEntry, ResourceStoreError>;
  readonly write: (
    location: ResourceStoreLocation,
    uri: string,
    content: string,
    options: ResourceStoreWriteOptions,
  ) => Effect.Effect<{readonly fingerprint: string; readonly uri: string}, ResourceStoreError>;
  /** Run a read-only invariant check under the account mutation lock immediately before writing. */
  readonly writeChecked: <E, R>(
    location: ResourceStoreLocation,
    uri: string,
    content: string,
    options: ResourceStoreWriteOptions,
    check: Effect.Effect<void, E, R>,
  ) => Effect.Effect<{readonly fingerprint: string; readonly uri: string}, E | ResourceStoreError, R>;
}

export class ResourceStore extends Context.Service<ResourceStore, ResourceStoreShape>()(
  '@threadnote/store/resource-store/ResourceStore',
) {
  static layerWith(options: ResourceStoreLayerOptions = {}) {
    return Layer.effect(
      ResourceStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const recallInvalidation = yield* ResourceRecallInvalidation;
        const externalPolicy = yield* Effect.serviceOption(ExternalSourcePolicy);
        const lockServices = yield* Effect.context<Crypto.Crypto | Path.Path | SystemInfo>();
        const provideLockServices = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, Exclude<R, Crypto.Crypto | Path.Path | SystemInfo>> =>
          effect.pipe(Effect.provide(lockServices));
        const operation = createResourceStoreOperations(
          fs,
          path,
          provideLockServices,
          recallInvalidation,
          options,
          externalPolicy,
        );
        return ResourceStore.of(operation);
      }),
    );
  }

  static readonly layer = ResourceStore.layerWith();
}

function createResourceStoreOperations(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  provideLockServices: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Crypto.Crypto | Path.Path | SystemInfo>>,
  recallInvalidation: ResourceRecallInvalidationShape,
  layerOptions: ResourceStoreLayerOptions,
  externalPolicy: Option.Option<Context.Service.Shape<typeof ExternalSourcePolicy>>,
): ResourceStoreShape {
  const externalAllowed = (location: ResourceStoreLocation, uri: string, content?: string) => {
    const access = externalResourceAccess(location, uri, content).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return Option.isSome(externalPolicy)
      ? access.pipe(Effect.provideService(ExternalSourcePolicy, externalPolicy.value))
      : access;
  };
  const assertExternalAccess = (location: ResourceStoreLocation, uri: string, content?: string) =>
    externalAllowed(location, uri, content).pipe(
      Effect.flatMap(allowed =>
        allowed
          ? Effect.void
          : Effect.fail(ResourceAccessDenied.make({message: 'External resource access is unavailable.', uri})),
      ),
    );
  const visibleEntries = (location: ResourceStoreLocation, entries: readonly ResourceStoreEntry[]) =>
    Effect.filter(entries, entry => externalAllowed(location, entry.uri));
  const resolve = (location: ResourceStoreLocation, uri: string) =>
    resolveResourcePath(fs, path, location, uri).pipe(mapIoError('resolve', uri));
  const invalidateRecall = (
    location: ResourceStoreLocation,
    includeInactive: boolean,
    invalidatedUris: readonly string[],
    canonicalMutationGeneration: CanonicalMutationGenerationTransition,
  ) =>
    provideLockServices(
      recallInvalidation
        .expire(location.home, includeInactive, invalidatedUris, canonicalMutationGeneration)
        .pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );
  const invalidateRecallBestEffort = (
    location: ResourceStoreLocation,
    invalidatedUris: readonly string[],
    canonicalMutationGeneration: CanonicalMutationGenerationTransition,
  ) =>
    Effect.forEach(
      [false, true],
      includeInactive =>
        invalidateRecall(location, includeInactive, invalidatedUris, canonicalMutationGeneration).pipe(
          Effect.retry(Schedule.recurs(2)),
          Effect.catchCause(() => {
            const event = {
              account: location.account,
              includeInactive,
              invalidatedUriCount: invalidatedUris.length,
            } satisfies ResourceRecallInvalidationFailureEvent;
            return Effect.logWarning(
              `Recall index per-URI invalidation failed after a canonical mutation attempt (${includeInactive ? 'with-inactive' : 'active'} scope); the durable canonical generation will force recovery on the next read.`,
            ).pipe(Effect.andThen(layerOptions.onRecallInvalidationFailed?.(event) ?? Effect.void), Effect.ignoreCause);
          }),
        ),
      {concurrency: 2, discard: true},
    ).pipe(Effect.uninterruptible);
  const withLock = <A, E, R>(location: ResourceStoreLocation, id: ResourceId, effect: Effect.Effect<A, E, R>) => {
    const lockPath = resourceAccountMutationLockPath(path, location.home, location.account);
    const event = {account: location.account, lockPath, uri: id.canonicalUri};
    const lockEffect = withExclusiveFileLock(
      fs,
      lockPath,
      {
        heartbeatIntervalMilliseconds: 10_000,
        ...(layerOptions.onMutationLockAcquired ? {onAcquired: () => layerOptions.onMutationLockAcquired!(event)} : {}),
        ...(layerOptions.onMutationLockCompleted
          ? {onCompleted: () => layerOptions.onMutationLockCompleted!(event)}
          : {}),
        ...(layerOptions.onMutationLockContention
          ? {onContention: () => layerOptions.onMutationLockContention!(event)}
          : {}),
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 30_000,
        waitTimeoutMilliseconds: 30_000,
      },
      Effect.result(effect),
    );
    return provideLockServices(lockEffect).pipe(
      Effect.catch(error =>
        readExclusiveFileLockOwner(fs, lockPath).pipe(
          Effect.flatMap(owner => {
            const processId = Option.getOrUndefined(owner)?.processId;
            return Effect.fail(
              ResourceIoFailed.make({
                cause: error,
                message: resourceMutationLockFailureMessage(id.canonicalUri, processId),
                operation: 'lock',
                uri: id.canonicalUri,
              }),
            );
          }),
        ),
      ),
      Effect.flatMap(
        Result.match({
          onFailure: error => Effect.fail(error),
          onSuccess: value => Effect.succeed(value),
        }),
      ),
    );
  };
  const verifyFingerprint = (resolved: ResolvedResourcePath, expectedFingerprint: string | undefined) =>
    Effect.gen(function* () {
      if (expectedFingerprint === undefined) return;
      const actualFingerprint = yield* provideLockServices(sha256Hex(yield* fs.readFile(resolved.path)));
      if (actualFingerprint !== expectedFingerprint) {
        return yield* ResourceConflict.make({
          actualFingerprint,
          expectedFingerprint,
          message: `Resource changed before mutation: ${resolved.id.canonicalUri}`,
          uri: resolved.id.canonicalUri,
        });
      }
    });
  const removeResourceUnlocked = (
    location: ResourceStoreLocation,
    resolved: ResolvedResourcePath,
    options?: {readonly expectedFingerprint?: string; readonly recursive?: boolean},
  ) =>
    Effect.gen(function* () {
      yield* verifyExistingPath(fs, path, resolved);
      yield* verifyFingerprint(resolved, options?.expectedFingerprint);
      const canonicalMutationGeneration = yield* provideLockServices(
        advanceCanonicalMutationGeneration(fs, path, location.home, location.account),
      );
      yield* fs
        .remove(resolved.path, {recursive: options?.recursive === true})
        .pipe(
          Effect.andThen(syncDirectory(fs, path.dirname(resolved.path))),
          Effect.ensuring(
            invalidateRecallBestEffort(location, [resolved.id.canonicalUri], canonicalMutationGeneration),
          ),
        );
    }).pipe(mapIoError('remove', resolved.id.canonicalUri));
  const removeResource = (
    location: ResourceStoreLocation,
    uri: string,
    options?: {readonly expectedFingerprint?: string; readonly recursive?: boolean},
  ) =>
    resolve(location, uri).pipe(
      Effect.flatMap(resolved => withLock(location, resolved.id, removeResourceUnlocked(location, resolved, options))),
      mapIoError('remove', uri),
    );
  const preflightWrite = (resolved: ResolvedResourcePath, options: ResourceStoreWriteOptions) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(resolved.path);
      if (options.mode === 'create' && exists) {
        return yield* ResourceAlreadyExists.make({
          message: `Resource already exists: ${resolved.id.canonicalUri}`,
          uri: resolved.id.canonicalUri,
        });
      }
      if (!exists && (options.mode === 'replace' || options.expectedFingerprint !== undefined)) {
        return yield* ResourceNotFound.make({
          message: `Resource does not exist for mutation: ${resolved.id.canonicalUri}`,
          uri: resolved.id.canonicalUri,
        });
      }
      if (exists) {
        yield* verifyExistingPath(fs, path, resolved, 'File');
        yield* verifyFingerprint(resolved, options.expectedFingerprint);
      }
    }).pipe(mapIoError('write', resolved.id.canonicalUri));
  const writeResourceUnlocked = (
    location: ResourceStoreLocation,
    resolved: ResolvedResourcePath,
    content: string,
    options: ResourceStoreWriteOptions,
  ) =>
    Effect.gen(function* () {
      yield* makeSafeDirectoryChain(fs, path, {...resolved, path: path.dirname(resolved.path)});
      yield* assertCaseCompatible(fs, path.dirname(resolved.path), path.basename(resolved.path), resolved.id);
      yield* preflightWrite(resolved, options);
      const canonicalMutationGeneration = yield* provideLockServices(
        advanceCanonicalMutationGeneration(fs, path, location.home, location.account),
      );
      yield* writeAtomically(fs, path, resolved, content, options.mode === 'create').pipe(
        Effect.ensuring(invalidateRecallBestEffort(location, [resolved.id.canonicalUri], canonicalMutationGeneration)),
      );
    }).pipe(mapIoError('write', resolved.id.canonicalUri));
  const writeResourceChecked = <E, R>(
    location: ResourceStoreLocation,
    uri: string,
    content: string,
    options: ResourceStoreWriteOptions,
    check: Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolve(location, uri);
      const fingerprint = yield* provideLockServices(sha256Hex(content)).pipe(mapIoError('write', uri));
      yield* withLock(
        location,
        resolved.id,
        check.pipe(Effect.andThen(writeResourceUnlocked(location, resolved, content, options))),
      );
      return {fingerprint, uri: resolved.id.canonicalUri};
    });
  const writeResource = (
    location: ResourceStoreLocation,
    uri: string,
    content: string,
    options: ResourceStoreWriteOptions,
  ): Effect.Effect<{readonly fingerprint: string; readonly uri: string}, ResourceStoreError> =>
    writeResourceChecked<never, never>(location, uri, content, options, Effect.void);
  const applyMutation = (location: ResourceStoreLocation, mutation: ResourceStoreMutation) => {
    if (mutation.type === 'write') {
      return writeResource(location, mutation.uri, mutation.content, mutation.options).pipe(Effect.asVoid);
    }
    const remove = removeResource(location, mutation.uri, mutation.options);
    return mutation.ignoreMissing === true
      ? remove.pipe(Effect.catchTag('ResourceNotFound', () => Effect.void))
      : remove;
  };
  const mutateResourceChecked = <E, R>(
    location: ResourceStoreLocation,
    mutations: readonly ResourceStoreMutation[],
    check: Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      if (mutations.length === 0) return yield* check;
      const prepared = yield* Effect.forEach(mutations, mutation =>
        resolve(location, mutation.uri).pipe(Effect.map(resolved => ({mutation, resolved}))),
      );
      return yield* withLock(
        location,
        prepared[0].resolved.id,
        Effect.gen(function* () {
          for (const {mutation, resolved} of prepared) {
            const preflight =
              mutation.type === 'write'
                ? preflightWrite(resolved, mutation.options)
                : verifyExistingPath(fs, path, resolved).pipe(
                    Effect.andThen(verifyFingerprint(resolved, mutation.options?.expectedFingerprint)),
                    mapIoError('remove', mutation.uri),
                  );
            yield* mutation.type === 'remove' && mutation.ignoreMissing === true
              ? preflight.pipe(Effect.catchTag('ResourceNotFound', () => Effect.void))
              : preflight;
          }
          yield* check;
          for (const {mutation, resolved} of prepared) {
            if (mutation.type === 'write') {
              yield* writeResourceUnlocked(location, resolved, mutation.content, mutation.options);
              yield* verifyFingerprint(resolved, yield* provideLockServices(sha256Hex(mutation.content))).pipe(
                mapIoError('write', mutation.uri),
              );
            } else {
              const remove = removeResourceUnlocked(location, resolved, mutation.options);
              yield* mutation.ignoreMissing === true
                ? remove.pipe(Effect.catchTag('ResourceNotFound', () => Effect.void))
                : remove;
            }
          }
        }),
      );
    });
  return {
    fingerprint: content =>
      provideLockServices(sha256Hex(content)).pipe(mapIoError('fingerprint', 'threadnote://local/content')),
    glob: (location, uri, pattern) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        const matcher = globToRegExp(pattern.replaceAll('\\', '/'));
        const entries = yield* visibleEntries(location, yield* listEntries(fs, path, resolved, true));
        return entries.filter(entry => {
          const relative = entry.uri.slice(resolved.id.canonicalUri.replace(/#.*$/, '').length).replace(/^\/+/, '');
          return matcher.test(relative);
        });
      }).pipe(mapIoError('glob', uri)),
    grep: (location, uri, term, limit = 100) =>
      Effect.gen(function* () {
        if (!term) return [];
        const resolved = yield* resolve(location, uri);
        return (yield* grepManyInTree(fs, path, resolved, [term], limit, (entry, content) =>
          externalAllowed(location, entry.uri, content),
        )).map(({line, text, uri}) => ({
          line,
          text,
          uri,
        }));
      }).pipe(mapIoError('grep', uri)),
    grepMany: (location, uri, terms, limitPerTerm = 100) =>
      Effect.gen(function* () {
        const normalizedTerms = [...new Set(terms.map(term => term.trim()).filter(Boolean))];
        if (normalizedTerms.length === 0 || limitPerTerm <= 0) return [];
        const resolved = yield* resolve(location, uri);
        return yield* grepManyInTree(fs, path, resolved, normalizedTerms, limitPerTerm, (entry, content) =>
          externalAllowed(location, entry.uri, content),
        );
      }).pipe(mapIoError('grep', uri)),
    list: (location, uri, options) =>
      resolve(location, uri).pipe(
        Effect.flatMap(resolved => listEntries(fs, path, resolved, options?.recursive === true)),
        Effect.flatMap(entries => visibleEntries(location, entries)),
        mapIoError('list', uri),
      ),
    makeDirectory: (location, uri) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        yield* withLock(
          location,
          resolved.id,
          Effect.gen(function* () {
            yield* makeSafeDirectoryChain(fs, path, resolved);
            yield* verifyExistingPath(fs, path, resolved, 'Directory');
          }),
        );
      }).pipe(mapIoError('mkdir', uri)),
    mutate: (location, mutations) =>
      mutations.length === 0
        ? Effect.void
        : Effect.forEach(mutations, mutation => applyMutation(location, mutation), {
            discard: true,
          }),
    mutateChecked: (location, mutations, check) => mutateResourceChecked(location, mutations, check),
    read: (location, uri) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        yield* assertExternalAccess(location, resolved.id.canonicalUri);
        yield* verifyExistingPath(fs, path, resolved, 'File');
        const content = yield* fs.readFileString(resolved.path);
        yield* assertExternalAccess(location, resolved.id.canonicalUri, content);
        return content;
      }).pipe(mapIoError('read', uri)),
    readBounded: (location, uri, maximumBytes) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        yield* assertExternalAccess(location, resolved.id.canonicalUri);
        const result = yield* readResourceBounded(fs, path, resolved, maximumBytes);
        yield* assertExternalAccess(location, resolved.id.canonicalUri, result.truncated ? undefined : result.content);
        return result;
      }).pipe(mapIoError('read', uri)),
    remove: (location, uri, options) => removeResource(location, uri, options),
    stat: (location, uri) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        yield* assertExternalAccess(location, resolved.id.canonicalUri);
        const info = yield* verifyExistingPath(fs, path, resolved);
        return entryForInfo(resolved.id.canonicalUri, info);
      }).pipe(mapIoError('stat', uri)),
    write: (location, uri, content, options) => writeResource(location, uri, content, options),
    writeChecked: (location, uri, content, options, check) =>
      writeResourceChecked(location, uri, content, options, check),
  };
}

export function resourceMutationLockFailureMessage(uri: string, processId?: number): string {
  const ownerMessage = processId === undefined ? '' : ` Local process ${processId} currently owns the lock.`;
  return `Resource lock failed for ${uri}.${ownerMessage} Retry after the active operation completes; use threadnote processes and threadnote doctor --dry-run for recovery guidance.`;
}

interface ResolvedResourcePath {
  readonly boundaryRoot: string;
  readonly id: ResourceId;
  readonly path: string;
}

function resolveResourcePath(fs: FileSystem.FileSystem, path: Path.Path, location: ResourceStoreLocation, uri: string) {
  return Effect.gen(function* () {
    const id = resourceIdWithoutAnchor(parseResourceId(uri));
    const userSegment = uriSegment(location.user);
    const layout = threadnoteStorageLayout(path, location.home, location.account, userSegment);
    let relativeSegments: readonly string[];
    if (id.namespace === 'resources') {
      relativeSegments = ['resources', ...id.segments];
    } else if (id.namespace === 'user') {
      if (id.segments[0] !== userSegment) {
        return yield* ResourceAccessDenied.make({
          message: `Resource user scope does not match the configured Threadnote user.`,
          uri: id.canonicalUri,
        });
      }
      relativeSegments = ['user', ...id.segments];
    } else {
      return yield* ResourceAccessDenied.make({
        message: `Unsupported Threadnote resource namespace: ${id.namespace}`,
        uri: id.canonicalUri,
      });
    }
    validatePortableSegment(location.account, location.account);
    const resolved = path.resolve(layout.accountRoot, ...relativeSegments);
    const relative = path.relative(layout.accountRoot, resolved);
    if (escapesBoundary(relative, path)) {
      return yield* ResourcePathUnsafe.make({
        message: `Resolved resource path escapes the Threadnote account root.`,
        path: resolved,
        uri: id.canonicalUri,
      });
    }
    const realBoundaryRoot = yield* resolveOwnedAccountBoundary(fs, path, location, id.canonicalUri);
    return {boundaryRoot: realBoundaryRoot, id, path: path.resolve(realBoundaryRoot, relative)};
  });
}

function resolveOwnedAccountBoundary(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  location: ResourceStoreLocation,
  uri: string,
) {
  return Effect.gen(function* () {
    const logicalHome = path.resolve(location.home);
    yield* fs.makeDirectory(logicalHome, {recursive: true, mode: 0o700});
    const realHome = yield* fs.realPath(logicalHome);
    let logicalCurrent = logicalHome;
    let realCurrent = realHome;
    for (const segment of ['data', location.account]) {
      logicalCurrent = path.join(logicalCurrent, segment);
      if (Option.isSome(yield* fs.readLink(logicalCurrent).pipe(Effect.option))) {
        return yield* ResourcePathUnsafe.make({
          message: 'Symbolic links are not allowed inside Threadnote-owned storage roots.',
          path: logicalCurrent,
          uri,
        });
      }
      if (!(yield* fs.exists(logicalCurrent))) {
        // First-use callers may race here. Only an existing entry is recoverable; validation below decides its safety.
        yield* fs.makeDirectory(logicalCurrent, {mode: 0o700}).pipe(
          Effect.catchIf(
            error => error instanceof PlatformError.PlatformError && error.reason._tag === 'AlreadyExists',
            () => Effect.void,
          ),
        );
      }
      const info = yield* fs.stat(logicalCurrent);
      if (info.type !== 'Directory') {
        return yield* ResourcePathUnsafe.make({
          message: 'Threadnote-owned storage root component is not a directory.',
          path: logicalCurrent,
          uri,
        });
      }
      realCurrent = path.join(realCurrent, segment);
      const actual = yield* fs.realPath(logicalCurrent);
      if (actual !== realCurrent) {
        return yield* ResourcePathUnsafe.make({
          message: 'Threadnote-owned storage root was redirected through a path alias.',
          path: logicalCurrent,
          uri,
        });
      }
    }
    return realCurrent;
  });
}

function makeSafeDirectoryChain(fs: FileSystem.FileSystem, path: Path.Path, resolved: ResolvedResourcePath) {
  return Effect.gen(function* () {
    const logicalBoundary = path.resolve(resolved.boundaryRoot);
    const relative = path.relative(logicalBoundary, path.resolve(resolved.path));
    if (escapesBoundary(relative, path)) {
      return yield* unsafe(resolved, 'Directory path escapes its boundary.');
    }
    let current = logicalBoundary;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      yield* assertCaseCompatible(fs, current, segment, resolved.id);
      current = path.join(current, segment);
      if (!(yield* fs.exists(current))) {
        yield* fs.makeDirectory(current, {mode: 0o700});
      }
      yield* verifyPathAtExpectedLocation(fs, path, resolved, current, 'Directory');
    }
  });
}

function verifyExistingPath(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  expectedType?: 'Directory' | 'File',
) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(resolved.path))) {
      return yield* ResourceNotFound.make({
        message: `Resource does not exist: ${resolved.id.canonicalUri}`,
        uri: resolved.id.canonicalUri,
      });
    }
    return yield* verifyPathAtExpectedLocation(fs, path, resolved, resolved.path, expectedType);
  });
}

function verifyPathAtExpectedLocation(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  logicalPath: string,
  expectedType?: 'Directory' | 'File',
) {
  return Effect.gen(function* () {
    const relative = path.relative(path.resolve(resolved.boundaryRoot), path.resolve(logicalPath));
    if (escapesBoundary(relative, path)) return yield* unsafe(resolved, 'Path escapes its storage boundary.');
    const actual = yield* fs.realPath(logicalPath);
    const expected = path.resolve(resolved.boundaryRoot, relative);
    if (actual !== expected) return yield* unsafe(resolved, 'Symbolic links or path aliases are not allowed.');
    const info = yield* fs.stat(logicalPath);
    if (info.type === 'SymbolicLink') return yield* unsafe(resolved, 'Symbolic links are not allowed.');
    if (expectedType && info.type !== expectedType) {
      return yield* unsafe(resolved, `Expected a ${expectedType.toLowerCase()}, found ${info.type}.`);
    }
    return info;
  });
}

function readResourceBounded(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  maximumBytes: number,
) {
  return Effect.gen(function* () {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes >= Number.MAX_SAFE_INTEGER) {
      return yield* ResourceIoFailed.make({
        cause: new Error('invalid bounded resource read size'),
        message: 'Resource read bound is invalid.',
        operation: 'read',
        uri: resolved.id.canonicalUri,
      });
    }
    const pathInfoBefore = yield* verifyExistingPath(fs, path, resolved, 'File');
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(resolved.path, {flag: 'r'});
        const openedInfoBefore = yield* file.stat;
        const pathInfoOpened = yield* verifyExistingPath(fs, path, resolved, 'File');
        if (!sameOpenedResourceFile(pathInfoBefore, pathInfoOpened, openedInfoBefore)) {
          return yield* unsafe(resolved, 'Resource changed while opening it for a bounded read.');
        }
        if (openedInfoBefore.size > BigInt(maximumBytes)) {
          return {truncated: true} as const;
        }
        const bytes = new Uint8Array(maximumBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const count = Number(yield* file.read(bytes.subarray(offset)));
          if (count <= 0) break;
          offset += count;
        }
        if (offset < Number(openedInfoBefore.size)) {
          return yield* unsafe(resolved, 'Resource ended before its bounded read completed.');
        }
        const openedInfoAfter = yield* file.stat;
        const pathInfoAfter = yield* verifyExistingPath(fs, path, resolved, 'File');
        if (
          !sameOpenedResourceFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          !sameOpenedResourceState(openedInfoBefore, openedInfoAfter)
        ) {
          return yield* unsafe(resolved, 'Resource changed during a bounded read.');
        }
        if (offset > maximumBytes) return {truncated: true} as const;
        const content = yield* Effect.try({
          try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
          catch: cause =>
            ResourceIoFailed.make({
              cause,
              message: 'Resource content is not valid UTF-8.',
              operation: 'read',
              uri: resolved.id.canonicalUri,
            }),
        });
        return {content, truncated: false} as const;
      }),
    );
  });
}

function sameOpenedResourceFile(
  before: FileSystem.File.Info,
  current: FileSystem.File.Info,
  opened: FileSystem.File.Info,
): boolean {
  const beforeInode = Option.getOrUndefined(before.ino);
  const currentInode = Option.getOrUndefined(current.ino);
  const openedInode = Option.getOrUndefined(opened.ino);
  // Threadnote's Bun FileSystem is backed by Node Stats, whose `ino` field is
  // mandatory on every supported platform (including Windows), and Effect
  // therefore wraps it in Some. Fail closed for custom FileSystem providers
  // that omit inode identity instead of weakening the open/stat interlock.
  return (
    before.type === 'File' &&
    current.type === 'File' &&
    opened.type === 'File' &&
    before.dev === current.dev &&
    current.dev === opened.dev &&
    beforeInode !== undefined &&
    currentInode !== undefined &&
    openedInode !== undefined &&
    beforeInode === currentInode &&
    currentInode === openedInode
  );
}

function sameOpenedResourceState(before: FileSystem.File.Info, after: FileSystem.File.Info): boolean {
  const beforeMtime = Option.getOrUndefined(before.mtime)?.getTime();
  const afterMtime = Option.getOrUndefined(after.mtime)?.getTime();
  return (
    before.size === after.size && beforeMtime !== undefined && afterMtime !== undefined && beforeMtime === afterMtime
  );
}

function assertCaseCompatible(fs: FileSystem.FileSystem, parent: string, desired: string, id: ResourceId) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(parent))) return;
    const desiredNfc = desired.normalize('NFC');
    const collision = (yield* fs.readDirectory(parent)).find(entry => {
      const entryNfc = entry.normalize('NFC');
      return entryNfc.toLocaleLowerCase() === desiredNfc.toLocaleLowerCase() && entryNfc !== desiredNfc;
    });
    if (collision) {
      return yield* ResourcePathUnsafe.make({
        message: `Portable path collision between "${desired}" and existing "${collision}".`,
        path: pathForMessage(parent, desired),
        uri: id.canonicalUri,
      });
    }
  });
}

function listEntries(fs: FileSystem.FileSystem, path: Path.Path, resolved: ResolvedResourcePath, recursive: boolean) {
  return Effect.gen(function* () {
    const rootInfo = yield* verifyExistingPath(fs, path, resolved);
    if (rootInfo.type === 'File') return [entryForInfo(resolved.id.canonicalUri, rootInfo)];
    if (rootInfo.type !== 'Directory') return yield* unsafe(resolved, `Unsupported resource type ${rootInfo.type}.`);
    const entries: ResourceStoreEntry[] = [];
    const visit = (directory: string, segments: readonly string[]): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        for (const name of [...(yield* fs.readDirectory(directory))].sort()) {
          const childPath = path.join(directory, name);
          const childResolved = {...resolved, path: childPath};
          const info = yield* verifyPathAtExpectedLocation(fs, path, childResolved, childPath);
          if (info.type !== 'Directory' && info.type !== 'File') continue;
          const childSegments = [...segments, name.normalize('NFC')];
          const uri = canonicalResourceUri(resolved.id.namespace, [...resolved.id.segments, ...childSegments]);
          entries.push(entryForInfo(uri, info));
          if (recursive && info.type === 'Directory') yield* visit(childPath, childSegments);
        }
      });
    yield* visit(resolved.path, []);
    return entries;
  });
}

function grepManyInTree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  terms: readonly string[],
  limitPerTerm: number,
  allowed: (entry: ResourceStoreEntry, content?: string) => Effect.Effect<boolean>,
) {
  return Effect.gen(function* () {
    const normalized = terms.map(term => ({lower: term.toLocaleLowerCase(), term}));
    const counts = new Map(normalized.map(({term}) => [term, 0]));
    const matches: ResourceStoreMultiGrepMatch[] = [];
    const entries = yield* listEntries(fs, path, resolved, true);
    for (const entry of entries) {
      if (entry.type !== 'file' || !(yield* allowed(entry))) continue;
      const entryId = resourceIdWithoutAnchor(parseResourceId(entry.uri));
      const relativeSegments = entryId.segments.slice(resolved.id.segments.length);
      const fileResolved = {...resolved, id: entryId, path: path.join(resolved.path, ...relativeSegments)};
      yield* verifyExistingPath(fs, path, fileResolved, 'File');
      const content = yield* fs.readFileString(fileResolved.path);
      if (!(yield* allowed(entry, content))) continue;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const lowerLine = line.toLocaleLowerCase();
        for (const {lower, term} of normalized) {
          if ((counts.get(term) ?? 0) >= limitPerTerm || !lowerLine.includes(lower)) continue;
          matches.push({line: index + 1, term, text: line, uri: entry.uri});
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
      if (normalized.every(({term}) => (counts.get(term) ?? 0) >= limitPerTerm)) break;
    }
    return matches;
  });
}

function entryForInfo(uri: string, info: FileSystem.File.Info): ResourceStoreEntry {
  return {
    ...(Option.isSome(info.mtime) ? {modifiedAt: info.mtime.value.toISOString()} : {}),
    size: Number(info.size),
    type: info.type === 'Directory' ? 'directory' : 'file',
    uri,
  };
}

function writeAtomically(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  content: string,
  createOnly: boolean,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const parent = path.dirname(resolved.path);
    const temporary = path.join(parent, `.${path.basename(resolved.path)}.${yield* crypto.randomUUIDv4}.tmp`);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
        yield* file.writeAll(new TextEncoder().encode(content));
        yield* file.sync;
      }),
    );
    yield* verifyPathAtExpectedLocation(fs, path, {...resolved, path: temporary}, temporary, 'File');
    if (createOnly) {
      const linked = yield* fs.link(temporary, resolved.path).pipe(Effect.result);
      if (linked._tag === 'Failure') {
        if (yield* fs.exists(resolved.path)) {
          return yield* ResourceAlreadyExists.make({
            message: `Resource already exists: ${resolved.id.canonicalUri}`,
            uri: resolved.id.canonicalUri,
          });
        }
        return yield* linked.failure;
      }
      yield* fs.remove(temporary, {force: true});
    } else {
      yield* fs.rename(temporary, resolved.path);
    }
    yield* syncDirectory(fs, parent);
  }).pipe(Effect.ensuring(removeTemporarySiblings(fs, path, resolved)));
}

function removeTemporarySiblings(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const parent = path.dirname(resolved.path);
    if (!(yield* fs.exists(parent))) return;
    const prefix = `.${path.basename(resolved.path)}.`;
    for (const entry of yield* fs.readDirectory(parent)) {
      if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
        yield* fs.remove(path.join(parent, entry), {force: true});
      }
    }
  }).pipe(Effect.ignore);
}

function syncDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(file => file.sync),
      Effect.ignore,
    ),
  );
}

function escapesBoundary(relative: string, path: Path.Path): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function unsafe(resolved: ResolvedResourcePath, message: string): ResourcePathUnsafe {
  return ResourcePathUnsafe.make({message, path: resolved.path, uri: resolved.id.canonicalUri});
}

function pathForMessage(parent: string, child: string): string {
  return `${parent}/${child}`;
}

function isResourceStoreError(error: unknown): error is ResourceStoreError {
  return (
    Schema.is(InvalidResourceId)(error) ||
    Schema.is(ResourceAccessDenied)(error) ||
    Schema.is(ResourceAlreadyExists)(error) ||
    Schema.is(ResourceConflict)(error) ||
    Schema.is(ResourceIoFailed)(error) ||
    Schema.is(ResourceNotFound)(error) ||
    Schema.is(ResourcePathUnsafe)(error)
  );
}

function mapIoError(operation: string, uri: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ResourceStoreError, R> =>
    effect.pipe(
      Effect.mapError(error =>
        isResourceStoreError(error)
          ? error
          : ResourceIoFailed.make({
              cause: error,
              message: `Resource ${operation} failed for ${uri}.`,
              operation,
              uri,
            }),
      ),
    );
}
