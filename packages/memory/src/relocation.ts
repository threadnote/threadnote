import {Array as EffectArray, Schema} from 'effect';
import {Effect, FileSystem, Option, Path, Predicate} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {fileSystemModeIsPrivate, runtimePlatform} from '@threadnote/platform/system';
import {uriSegment} from '@threadnote/workspace/manifest';
import {threadnoteStorageLayout} from '@threadnote/store/layout';
import {makeResourceIdScopeChecker, parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const MEMORY_RELOCATION_RECEIPT_VERSION = 1 as const;
export const MAX_MEMORY_RELOCATION_DEPTH = 8;
const MAX_MEMORY_RELOCATION_RECEIPT_BYTES = 16 * 1024;
const MAX_MEMORY_RELOCATION_RECEIPT_COUNT = 1_024;
const MAX_MEMORY_RELOCATION_RECEIPT_TOTAL_BYTES = 2 * 1024 * 1024;

export class MemoryRelocationError extends Schema.TaggedError<MemoryRelocationError, {readonly brand: unique symbol}>()(
  'MemoryRelocationError',
  {message: Schema.String},
) {}

export class MemoryPointerNotFound extends Schema.TaggedError<MemoryPointerNotFound, {readonly brand: unique symbol}>()(
  'MemoryPointerNotFound',
  {message: Schema.String, uri: Schema.String},
) {}

export interface MemoryRelocationReceiptV1 {
  readonly fromUri: string;
  readonly memoryId: string;
  readonly toUri: string;
  readonly type: 'threadnote-memory-relocation';
  readonly version: typeof MEMORY_RELOCATION_RECEIPT_VERSION;
  readonly visibility: 'private-local';
}

export interface ResolvedMemoryRead {
  readonly canonicalUri: string;
  readonly content: string;
  readonly memoryId?: string;
  readonly relocationDepth: number;
  readonly requestedUri: string;
}

export interface MemoryRelocationIdentityWitnessCandidate {
  readonly identityConflict?: boolean;
  readonly memoryId: string;
  readonly missingMemoryId: boolean;
  readonly record: MemoryRecord;
  readonly status: 'active';
  readonly uri: string;
}

type RelocationRuntime = Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>;

/**
 * Persist a private relocation receipt before deleting a moved canonical memory.
 * Legacy memories without memory_id keep their pre-4.6 move behavior and do
 * not receive a receipt; any present but mismatched identity fails closed.
 */
export const recordMemoryRelocation = Effect.fn('memoryRelocation.record')(function* (
  config: RelocationRuntime,
  input: {
    readonly fromContent: string;
    readonly fromUri: string;
    readonly toContent: string;
    readonly toUri: string;
  },
) {
  const fromUri = yield* canonicalManagedMemoryUri(config, input.fromUri);
  const toUri = yield* canonicalManagedMemoryUri(config, input.toUri);
  if (fromUri === toUri) return false;
  const fromRecord = parseMemoryDocument(fromUri, input.fromContent);
  const toRecord = parseMemoryDocument(toUri, input.toContent);
  if (!fromRecord || !toRecord) {
    return yield* relocationError('Relocation receipts require canonical memory documents.');
  }
  const fromId = fromRecord.metadata.memoryId;
  const toId = toRecord.metadata.memoryId;
  if (fromId === undefined || toId === undefined) return false;
  if (!validMemoryId(fromId) || fromId !== toId) {
    return yield* relocationError('Relocation source and destination memory_id values must match.');
  }
  const receipt: MemoryRelocationReceiptV1 = {
    fromUri,
    memoryId: fromId,
    toUri,
    type: 'threadnote-memory-relocation',
    version: MEMORY_RELOCATION_RECEIPT_VERSION,
    visibility: 'private-local',
  };
  yield* writeMemoryRelocationReceipt(config, receipt);
  return true;
});

/** Clear an obsolete outgoing receipt whenever a URI receives live memory bytes. */
export const discardMemoryRelocation = Effect.fn('memoryRelocation.discard')(function* (
  config: RelocationRuntime,
  uri: string,
) {
  if (!isMemoryRelocationUri(config, uri)) return;
  const canonicalUri = yield* canonicalManagedMemoryUri(config, uri);
  const fs = yield* FileSystem.FileSystem;
  const root = yield* existingPrivateMemoryRelocationRoot(config);
  if (root === undefined) return;
  const target = yield* memoryRelocationReceiptPath(root, canonicalUri);
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* relocationError('Memory relocation receipt must not be a symbolic link.');
  }
  yield* fs.remove(target, {force: true});
});

/** Read live bytes first, then follow a private, identity-fenced relocation chain on exact miss. */
export const readMemoryWithRelocations = Effect.fn('memoryRelocation.read')(function* (
  config: RelocationRuntime,
  requestedInput: string,
  options: {readonly allowedUriScopes?: readonly string[]} = {},
) {
  const resourceIds = makeResourceIdScopeChecker();
  const requestedUri = yield* canonicalManagedMemoryUri(config, requestedInput);
  const allowedUriScopes = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(options.allowedUriScopes), __effectArrayReceiver =>
      EffectArray.map(__effectArrayReceiver, scope => resourceIds.parse(scope).canonicalUri),
    ),
  );
  const isAuthorized = (uri: string) =>
    allowedUriScopes === undefined || EffectArray.some(allowedUriScopes, scope => resourceIds.isWithin(uri, scope));
  if (!isAuthorized(requestedUri)) {
    return yield* MemoryPointerNotFound.make({
      message: `Memory resource does not exist: ${requestedUri}`,
      uri: requestedUri,
    });
  }
  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  const direct = yield* store.read(location, requestedUri).pipe(
    Effect.asSome,
    Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
  );
  if (Option.isSome(direct)) {
    return {
      canonicalUri: requestedUri,
      content: direct.value,
      memoryId: parseMemoryDocument(requestedUri, direct.value)?.metadata.memoryId,
      relocationDepth: 0,
      requestedUri,
    };
  }

  const visited = new Set([requestedUri]);
  let currentUri = requestedUri;
  let expectedMemoryId: string | undefined;
  for (let depth = 1; depth <= MAX_MEMORY_RELOCATION_DEPTH; depth += 1) {
    const receipt = yield* readMemoryRelocationReceipt(config, currentUri);
    if (receipt === undefined) {
      return depth === 1
        ? yield* MemoryPointerNotFound.make({
            message: `Memory resource does not exist: ${requestedUri}`,
            uri: requestedUri,
          })
        : yield* relocationError('Memory relocation chain is incomplete.');
    }
    if (receipt.fromUri !== currentUri) {
      return yield* relocationError('Memory relocation receipt source does not match its lookup URI.');
    }
    if (expectedMemoryId !== undefined && receipt.memoryId !== expectedMemoryId) {
      return yield* relocationError('Memory relocation chain changed memory_id.');
    }
    expectedMemoryId = receipt.memoryId;
    if (visited.has(receipt.toUri)) {
      return yield* relocationError('Memory relocation chain contains a loop.');
    }
    visited.add(receipt.toUri);
    // Private relocation receipts may cross share boundaries. Authorization
    // must be checked before the destination read so the receipt cannot become
    // an existence oracle for a private or different-team memory.
    if (!isAuthorized(receipt.toUri)) {
      return yield* MemoryPointerNotFound.make({
        message: `Memory resource does not exist: ${requestedUri}`,
        uri: requestedUri,
      });
    }

    const destination = yield* store.read(location, receipt.toUri).pipe(
      Effect.asSome,
      Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
    );
    if (Option.isSome(destination)) {
      const record = parseMemoryDocument(receipt.toUri, destination.value);
      if (!record || (record.metadata.memoryId !== undefined && record.metadata.memoryId !== receipt.memoryId)) {
        return yield* relocationError('Memory relocation destination failed its memory_id identity fence.');
      }
      return {
        canonicalUri: receipt.toUri,
        content: destination.value,
        memoryId: receipt.memoryId,
        relocationDepth: depth,
        requestedUri,
      };
    }
    currentUri = receipt.toUri;
  }
  return yield* relocationError(`Memory relocation chain exceeds the maximum depth of ${MAX_MEMORY_RELOCATION_DEPTH}.`);
});

/**
 * Bounded explicit-read fallback for a stable identity whose shared destination
 * lost only its identity header. Private receipts are witnesses, not topical
 * recall candidates: a different non-empty destination identity always wins
 * and fails closed.
 */
export const loadMemoryRelocationIdentityWitnesses = Effect.fn('memoryRelocation.loadIdentityWitnesses')(function* (
  config: RelocationRuntime,
  memoryIds: readonly string[],
  allowedUriScopes: readonly string[],
  options: {readonly destinationUris?: readonly string[]} = {},
) {
  const requestedMemoryIds = new Set(
    EffectArray.filter(
      memoryIds,
      (__effectFilterValue: (typeof memoryIds)[number], __effectFilterIndex: number) =>
        __effectFilterIndex in memoryIds && validMemoryId(__effectFilterValue),
    ),
  );
  const requestedDestinationUris = new Set(options.destinationUris ?? []);
  if ((requestedMemoryIds.size === 0 && requestedDestinationUris.size === 0) || allowedUriScopes.length === 0)
    return [];
  const root = yield* existingPrivateMemoryRelocationRoot(config);
  if (root === undefined) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = EffectArray.filter(
    yield* fs.readDirectory(root),
    __effectArrayValue => !!(entry => Effect2.pipe(entry, EffectString.endsWith('.json')))(__effectArrayValue),
  ).sort();
  if (entries.length > MAX_MEMORY_RELOCATION_RECEIPT_COUNT) {
    return yield* relocationError(
      `Memory relocation identity scan exceeds the maximum receipt count of ${MAX_MEMORY_RELOCATION_RECEIPT_COUNT}.`,
    );
  }

  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  let scannedBytes = 0;
  const receipts: MemoryRelocationReceiptV1[] = [];
  const receiptClaimsByDestination = new Map<string, Set<string>>();
  for (const entry of entries) {
    const target = path.join(root, entry);
    const info = yield* fs.stat(target);
    scannedBytes += Number(info.size);
    if (scannedBytes > MAX_MEMORY_RELOCATION_RECEIPT_TOTAL_BYTES) {
      return yield* relocationError(
        `Memory relocation identity scan exceeds the ${MAX_MEMORY_RELOCATION_RECEIPT_TOTAL_BYTES}-byte aggregate limit.`,
      );
    }
    const receipt = yield* readMemoryRelocationReceiptFile(target);
    if (receipt === undefined) continue;
    const canonicalFrom = yield* canonicalManagedMemoryUri(config, receipt.fromUri);
    const canonicalTo = yield* canonicalManagedMemoryUri(config, receipt.toUri);
    if (canonicalFrom !== receipt.fromUri || canonicalTo !== receipt.toUri) {
      return yield* relocationError('Memory relocation receipt contains a non-canonical URI.');
    }
    receipts.push(receipt);
    if (requestedDestinationUris.has(receipt.toUri)) requestedMemoryIds.add(receipt.memoryId);
    const claims = receiptClaimsByDestination.get(receipt.toUri) ?? new Set<string>();
    claims.add(receipt.memoryId);
    receiptClaimsByDestination.set(receipt.toUri, claims);
  }

  const destinationRecords = new Map<string, MemoryRecord | undefined>();
  const candidates = new Map<string, MemoryRelocationIdentityWitnessCandidate>();
  for (const receipt of receipts) {
    if (!requestedMemoryIds.has(receipt.memoryId)) continue;
    if (!EffectArray.some(allowedUriScopes, scope => resourceIdIsWithin(receipt.toUri, scope))) continue;
    let record = destinationRecords.get(receipt.toUri);
    if (!destinationRecords.has(receipt.toUri)) {
      const destination = yield* store.read(location, receipt.toUri).pipe(
        Effect.asSome,
        Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
      );
      record = Option.isSome(destination) ? parseMemoryDocument(receipt.toUri, destination.value) : undefined;
      destinationRecords.set(receipt.toUri, record);
    }
    if (!record || record.metadata.status !== 'active') continue;
    const observedMemoryId = record.metadata.memoryId;
    const key = `${receipt.memoryId}\u0000${receipt.toUri}`;
    candidates.set(key, {
      identityConflict: observedMemoryId !== undefined && observedMemoryId !== receipt.memoryId,
      memoryId: receipt.memoryId,
      missingMemoryId: observedMemoryId === undefined,
      record,
      status: 'active',
      uri: receipt.toUri,
    });
  }

  return EffectArray.map([...candidates.values()], candidate =>
    candidate.missingMemoryId && (receiptClaimsByDestination.get(candidate.uri)?.size ?? 0) > 1
      ? {...candidate, identityConflict: true}
      : candidate,
  ).sort((left, right) =>
    left.memoryId === right.memoryId
      ? Effect2.pipe(left.uri, EffectString.localeCompare(right.uri))
      : Effect2.pipe(left.memoryId, EffectString.localeCompare(right.memoryId)),
  );
});

const writeMemoryRelocationReceipt = Effect.fn('memoryRelocation.writeReceipt')(function* (
  config: RelocationRuntime,
  receipt: MemoryRelocationReceiptV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* ensurePrivateMemoryRelocationRoot(config);
  const target = yield* memoryRelocationReceiptPath(root, receipt.fromUri);
  const content = `${JSON.stringify(receipt, undefined, 2)}\n`;
  if (new TextEncoder().encode(content).byteLength > MAX_MEMORY_RELOCATION_RECEIPT_BYTES) {
    return yield* relocationError('Memory relocation receipt exceeds its size limit.');
  }
  const existing = yield* readMemoryRelocationReceiptFile(target);
  if (existing !== undefined) {
    if (sameReceipt(existing, receipt)) return;
    return yield* relocationError(`A different relocation already exists for ${receipt.fromUri}.`);
  }
  yield* fs
    .writeFileString(target, content, {flag: 'wx', mode: 0o600})
    .pipe(
      Effect.catch(error =>
        readMemoryRelocationReceiptFile(target).pipe(
          Effect.flatMap(concurrent =>
            concurrent !== undefined && sameReceipt(concurrent, receipt) ? Effect.void : Effect.fail(error),
          ),
        ),
      ),
    );
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* relocationError('Memory relocation receipt must not be a symbolic link.');
  }
  if (runtimePlatform !== 'win32') yield* fs.chmod(target, 0o600);
  const persisted = yield* readMemoryRelocationReceiptFile(target);
  if (persisted === undefined || !sameReceipt(persisted, receipt)) {
    return yield* relocationError('Memory relocation receipt failed post-write verification.');
  }
});

const readMemoryRelocationReceipt = Effect.fn('memoryRelocation.readReceipt')(function* (
  config: RelocationRuntime,
  fromUri: string,
) {
  const root = yield* existingPrivateMemoryRelocationRoot(config);
  if (root === undefined) return undefined;
  const target = yield* memoryRelocationReceiptPath(root, fromUri);
  const receipt = yield* readMemoryRelocationReceiptFile(target);
  if (receipt === undefined) return undefined;
  // Revalidate user ownership even if the on-disk JSON was externally edited.
  const canonicalFrom = yield* canonicalManagedMemoryUri(config, receipt.fromUri);
  const canonicalTo = yield* canonicalManagedMemoryUri(config, receipt.toUri);
  if (canonicalFrom !== receipt.fromUri || canonicalTo !== receipt.toUri) {
    return yield* relocationError('Memory relocation receipt contains a non-canonical URI.');
  }
  return receipt;
});

const readMemoryRelocationReceiptFile = Effect.fn('memoryRelocation.readReceiptFile')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* relocationError('Memory relocation receipt must not be a symbolic link.');
  }
  if (!(yield* fs.exists(target))) return undefined;
  const info = yield* fs.stat(target);
  if (info.type !== 'File' || !fileSystemModeIsPrivate(runtimePlatform, info.mode)) {
    return yield* relocationError('Memory relocation receipt must be a private regular file.');
  }
  const content = yield* fs.readFileString(target);
  if (new TextEncoder().encode(content).byteLength > MAX_MEMORY_RELOCATION_RECEIPT_BYTES) {
    return yield* relocationError('Memory relocation receipt exceeds its size limit.');
  }
  return yield* Effect.try({
    catch: cause =>
      Schema.is(MemoryRelocationError)(cause)
        ? cause
        : relocationError(cause instanceof Error ? cause.message : 'Memory relocation receipt is invalid.'),
    try: () => parseMemoryRelocationReceipt(content),
  });
});

function parseMemoryRelocationReceipt(content: string): MemoryRelocationReceiptV1 {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw relocationError('Memory relocation receipt is not valid JSON.');
  }
  if (
    !Predicate.isObject(value) ||
    !hasExactKeys(value, ['fromUri', 'memoryId', 'toUri', 'type', 'version', 'visibility'])
  ) {
    throw relocationError('Memory relocation receipt has an unsupported shape.');
  }
  if (
    value.type !== 'threadnote-memory-relocation' ||
    value.version !== MEMORY_RELOCATION_RECEIPT_VERSION ||
    value.visibility !== 'private-local' ||
    typeof value.fromUri !== 'string' ||
    typeof value.toUri !== 'string' ||
    typeof value.memoryId !== 'string' ||
    !validMemoryId(value.memoryId)
  ) {
    throw relocationError('Memory relocation receipt has invalid fields.');
  }
  return {
    fromUri: value.fromUri,
    memoryId: value.memoryId,
    toUri: value.toUri,
    type: 'threadnote-memory-relocation',
    version: MEMORY_RELOCATION_RECEIPT_VERSION,
    visibility: 'private-local',
  };
}

const canonicalManagedMemoryUri = Effect.fn('memoryRelocation.canonicalUri')(
  (config: RelocationRuntime, input: string) =>
    Effect.try({
      catch: cause =>
        Schema.is(MemoryRelocationError)(cause)
          ? cause
          : relocationError(cause instanceof Error ? cause.message : 'Invalid memory relocation URI.'),
      try: () => {
        const resource = parseResourceId(input);
        if (
          resource.anchor !== undefined ||
          resource.namespace !== 'user' ||
          resource.segments[0] !== uriSegment(config.user) ||
          resource.segments[1] !== 'memories' ||
          resource.segments.length < 4 ||
          !Effect2.pipe(resource.segments.at(-1), effectOptionalString =>
            effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.endsWith('.md')),
          )
        ) {
          throw relocationError('Relocation receipts require a canonical memory URI owned by the current user.');
        }
        return resource.canonicalUri;
      },
    }),
);

const memoryRelocationReceiptPath = Effect.fn('memoryRelocation.receiptPath')(function* (
  root: string,
  canonicalUri: string,
) {
  const path = yield* Path.Path;
  const digest = yield* sha256Hex(canonicalUri);
  return path.join(root, `${digest}.json`);
});

const memoryRelocationRoot = Effect.fn('memoryRelocation.root')(function* (config: RelocationRuntime) {
  const path = yield* Path.Path;
  const userSegment = uriSegment(config.user);
  const layout = threadnoteStorageLayout(path, config.agentContextHome, config.account, userSegment);
  return path.join(layout.accountRoot, 'user', userSegment, 'private', 'memory-relocations', 'v1');
});

const ensurePrivateMemoryRelocationRoot = Effect.fn('memoryRelocation.ensurePrivateRoot')(function* (
  config: RelocationRuntime,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* memoryRelocationRoot(config);
  if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
    return yield* relocationError('Memory relocation store must not be a symbolic link.');
  }
  const before = yield* fs.stat(root).pipe(Effect.option);
  if (Option.isSome(before) && before.value.type !== 'Directory') {
    return yield* relocationError('Memory relocation store must be a private directory.');
  }
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (runtimePlatform !== 'win32') yield* fs.chmod(root, 0o700);
  const after = yield* fs.stat(root);
  if (after.type !== 'Directory' || !fileSystemModeIsPrivate(runtimePlatform, after.mode)) {
    return yield* relocationError('Memory relocation store must be a private directory.');
  }
  return root;
});

const existingPrivateMemoryRelocationRoot = Effect.fn('memoryRelocation.existingPrivateRoot')(function* (
  config: RelocationRuntime,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* memoryRelocationRoot(config);
  if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
    return yield* relocationError('Memory relocation store must not be a symbolic link.');
  }
  const info = yield* fs.stat(root).pipe(Effect.option);
  if (Option.isNone(info)) return undefined;
  if (info.value.type !== 'Directory' || !fileSystemModeIsPrivate(runtimePlatform, info.value.mode)) {
    return yield* relocationError('Memory relocation store must be a private directory.');
  }
  return root;
});

function sameReceipt(left: MemoryRelocationReceiptV1, right: MemoryRelocationReceiptV1): boolean {
  return left.fromUri === right.fromUri && left.toUri === right.toUri && left.memoryId === right.memoryId;
}

function validMemoryId(value: string): boolean {
  return /^tn_[A-Za-z0-9_-]{1,128}$/u.test(value);
}

export function isMemoryRelocationUri(config: Pick<RuntimeConfig, 'user'>, input: string): boolean {
  try {
    const resource = parseResourceId(input);
    return (
      resource.anchor === undefined &&
      resource.namespace === 'user' &&
      resource.segments[0] === uriSegment(config.user) &&
      resource.segments[1] === 'memories' &&
      resource.segments.length >= 4 &&
      Effect2.pipe(resource.segments.at(-1), effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.endsWith('.md')),
      ) === true
    );
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && EffectArray.every(actual, (key, index) => key === expected[index]);
}

function relocationError(message: string): MemoryRelocationError {
  return MemoryRelocationError.make({message});
}

function resourceStoreLocation(config: RelocationRuntime) {
  return {account: config.account, home: config.agentContextHome, user: config.user} as const;
}
