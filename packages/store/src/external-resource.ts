import {Clock, Context, Effect, FileSystem, Option, Path, Result} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalResourceUri, parseResourceId, validatePortableSegment} from './resource-id.js';
import type {ResourceStoreLocation} from './resource-store.js';

const SUPERHUMAN_ROOT = 'threadnote://resources/external/superhuman';
const POCKET_ROOT = 'threadnote://resources/external/pocket';
const LINEAR_ROOT = 'threadnote://resources/external/linear';
const GITHUB_ROOT = 'threadnote://resources/external/github';
export type ExternalProvider = 'superhuman' | 'pocket' | 'linear' | 'github';
const ENVELOPE = 'THREADNOTE EXTERNAL RESOURCE/1\n';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_SOURCE_RECEIPT_BYTES = 32 * 1024;

export interface ExternalResourceIdentity {
  readonly provider?: ExternalProvider;
  readonly sourceId: string;
  readonly documentId: string;
  readonly pageId: string;
  readonly chunkId: string;
}

export interface ExternalResourceMetadata extends ExternalResourceIdentity {
  readonly version: 1;
  readonly project: string | null;
  readonly title: string;
  readonly browserLink?: string;
  readonly remoteRevision?: string;
  readonly rendererVersion: string;
  readonly scrubberVersion: string;
  readonly coverage: 'canvas-plain-text' | 'pocket-api-text' | 'linear-api-text' | 'github-conversation';
}

export interface ExternalDocumentManifest {
  readonly provider?: ExternalProvider;
  readonly version: 1;
  readonly sourceId: string;
  readonly documentId: string;
  readonly configFingerprint: string;
  readonly status: 'active' | 'quarantined' | 'pending';
  readonly fetchedAt: number;
  readonly maxStaleMilliseconds: number;
  readonly chunks: Readonly<Record<string, string>>;
  readonly nextAttemptAt?: number;
  readonly retryKind?: 'quota' | 'transient';
  readonly accessEpoch?: string;
  readonly inventoryGeneration?: string;
}

export interface ExternalSourceReceipt {
  readonly provider?: ExternalProvider;
  readonly version: 1;
  readonly sourceId: string;
  readonly accessEpoch: string;
  readonly status: 'active' | 'authentication-rejected' | 'cleanup';
  readonly inventoryPage?: number;
  readonly inventoryOffset?: number;
  readonly inventoryGeneration?: string;
  readonly credentialFingerprint?: string;
  readonly completedAt?: number;
  readonly nextAttemptAt?: number;
  readonly deniedRepositoryIds?: readonly string[];
  readonly repositoryDenialGenerations?: Readonly<Record<string, string>>;
}

export interface ExternalSourceAccessPolicy {
  readonly credentialFingerprint?: string;
  readonly enabled: boolean;
  readonly configFingerprint: string;
  readonly maxStaleMilliseconds?: number;
  readonly project: string | null;
}

export class ExternalSourcePolicy extends Context.Service<
  ExternalSourcePolicy,
  {
    readonly current: (
      location: ResourceStoreLocation,
      sourceId: string,
      provider?: ExternalProvider,
    ) => Effect.Effect<ExternalSourceAccessPolicy | undefined>;
  }
>()('@threadnote/store/external-resource/ExternalSourcePolicy') {}

export function isExternalResourceUri(uri: string): boolean {
  const value = uri.split('#', 1)[0];
  return [SUPERHUMAN_ROOT, POCKET_ROOT, LINEAR_ROOT, GITHUB_ROOT].some(
    root => value === root || value.startsWith(`${root}/`),
  );
}

export function externalResourceUri(identity: ExternalResourceIdentity): string {
  if (!validIdentity(identity)) throw new Error('Invalid external resource identity.');
  return canonicalResourceUri('resources', [
    'external',
    identity.provider ?? 'superhuman',
    identity.sourceId,
    'docs',
    identity.documentId,
    'pages',
    identity.pageId,
    `${identity.chunkId}.md`,
  ]);
}

export function externalDocumentManifestUri(
  sourceId: string,
  documentId: string,
  provider: ExternalProvider = 'superhuman',
): string {
  if (!SOURCE_ID.test(sourceId) || !ID.test(documentId)) throw new Error('Invalid external document identity.');
  return canonicalResourceUri('resources', ['external', provider, sourceId, 'docs', documentId, '.manifest.json']);
}

export function externalSourceReceiptUri(sourceId: string, provider: ExternalProvider = 'superhuman'): string {
  if (!SOURCE_ID.test(sourceId)) throw new Error('Invalid external source identity.');
  return canonicalResourceUri('resources', ['external', provider, sourceId, '.access.json']);
}

export function serializeExternalSourceReceipt(receipt: ExternalSourceReceipt): string {
  if (!validSourceReceipt(receipt)) throw new Error('Invalid external source receipt.');
  const content = JSON.stringify(receipt) + '\n';
  if (new TextEncoder().encode(content).byteLength > MAX_SOURCE_RECEIPT_BYTES)
    throw new Error('External source receipt exceeds its budget.');
  return content;
}

export function parseExternalResourceIdentity(uri: string): ExternalResourceIdentity | undefined {
  const value = uri.split('#', 1)[0];
  const match =
    /^threadnote:\/\/resources\/external\/(superhuman|pocket|linear|github)\/([^/]+)\/docs\/([^/]+)\/pages\/([^/]+)\/([^/]+)\.md$/.exec(
      value,
    );
  if (!match) return undefined;
  const identity = {
    provider: match[1] as ExternalProvider,
    sourceId: match[2],
    documentId: match[3],
    pageId: match[4],
    chunkId: match[5],
  };
  return validIdentity(identity) && externalResourceUri(identity) === value ? identity : undefined;
}

export function renderExternalResource(metadata: ExternalResourceMetadata, body: string): string {
  if (!validMetadata(metadata)) throw new Error('Invalid external resource metadata.');
  return `${ENVELOPE}${JSON.stringify(metadata)}\n\n${body}`;
}

export function parseExternalResource(
  uri: string,
  content: string,
): {readonly metadata: ExternalResourceMetadata; readonly body: string} | undefined {
  const identity = parseExternalResourceIdentity(uri);
  if (!identity || !content.startsWith(ENVELOPE)) return undefined;
  const end = content.indexOf('\n\n', ENVELOPE.length);
  if (end < 0 || end - ENVELOPE.length > 8192) return undefined;
  try {
    const metadata: unknown = JSON.parse(content.slice(ENVELOPE.length, end));
    if (!validMetadata(metadata) || externalResourceUri(metadata) !== externalResourceUri(identity)) return undefined;
    return {metadata, body: content.slice(end + 2)};
  } catch {
    return undefined;
  }
}

export function serializeExternalDocumentManifest(manifest: ExternalDocumentManifest): string {
  if (!validManifest(manifest)) throw new Error('Invalid external document manifest.');
  const content =
    JSON.stringify({
      ...manifest,
      chunks: Object.fromEntries(Object.entries(manifest.chunks).sort(([left], [right]) => left.localeCompare(right))),
    }) + '\n';
  if (new TextEncoder().encode(content).byteLength > MAX_RECEIPT_BYTES)
    throw new Error('External document manifest exceeds its budget.');
  return content;
}

export const readExternalDocumentManifest = Effect.fn('external.readManifest')(function* (
  location: ResourceStoreLocation,
  sourceId: string,
  documentId: string,
  provider: ExternalProvider = 'superhuman',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const uri = yield* Effect.try(() => externalDocumentManifestUri(sourceId, documentId, provider)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (uri === undefined) return undefined;
  const realHome = yield* fs.realPath(location.home).pipe(Effect.orElseSucceed(() => undefined));
  if (realHome === undefined) return undefined;
  const content = yield* safeRead(fs, path, resourcePath(path, {...location, home: realHome}, uri), MAX_RECEIPT_BYTES);
  if (content === undefined) return undefined;
  return yield* Effect.try(() => {
    const manifest: unknown = JSON.parse(content);
    return validManifest(manifest) &&
      (manifest.provider ?? 'superhuman') === provider &&
      manifest.sourceId === sourceId &&
      manifest.documentId === documentId
      ? manifest
      : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
});

export const readExternalSourceReceipt = Effect.fn('external.readSourceReceipt')(function* (
  location: ResourceStoreLocation,
  sourceId: string,
  provider: ExternalProvider = 'superhuman',
): Effect.fn.Return<ExternalSourceReceipt | undefined | null, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const uri = yield* Effect.try(() => externalSourceReceiptUri(sourceId, provider)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (uri === undefined) return null;
  const realHome = yield* fs.realPath(location.home).pipe(Effect.orElseSucceed(() => undefined));
  if (realHome === undefined) return null;
  const filename = resourcePath(path, {...location, home: realHome}, uri);
  const info = yield* fs.stat(filename).pipe(Effect.result);
  if (Result.isFailure(info)) return info.failure.reason._tag === 'NotFound' ? undefined : null;
  const content = yield* safeRead(fs, path, filename, MAX_SOURCE_RECEIPT_BYTES);
  if (content === undefined) return null;
  return yield* Effect.try(() => {
    const receipt: unknown = JSON.parse(content);
    return validSourceReceipt(receipt) &&
      (receipt.provider ?? 'superhuman') === provider &&
      receipt.sourceId === sourceId
      ? receipt
      : null;
  }).pipe(Effect.orElseSucceed(() => null));
});

export const externalResourceAccess = Effect.fn('external.resourceAccess')(function* (
  location: ResourceStoreLocation,
  uri: string,
  content?: string,
  expectedContentHash?: string,
) {
  if (!isExternalResourceUri(uri)) return true;
  const identity = parseExternalResourceIdentity(uri);
  if (!identity) return false;
  const policyService = yield* Effect.serviceOption(ExternalSourcePolicy);
  if (Option.isNone(policyService)) return false;
  const provider = identity.provider ?? 'superhuman';
  const policy = yield* policyService.value.current(location, identity.sourceId, provider);
  const sourceReceipt = yield* readExternalSourceReceipt(location, identity.sourceId, provider);
  const manifest = yield* readExternalDocumentManifest(location, identity.sourceId, identity.documentId, provider);
  const now = yield* Clock.currentTimeMillis;
  if (!manifestPermits(manifest, policy, sourceReceipt, now)) return false;
  const expectedHash = manifest!.chunks[externalResourceUri(identity)];
  if (expectedHash === undefined || (expectedContentHash !== undefined && expectedContentHash !== expectedHash))
    return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realHome = yield* fs.realPath(location.home).pipe(Effect.orElseSucceed(() => undefined));
  if (realHome === undefined) return false;
  const value =
    content ??
    (yield* safeRead(
      fs,
      path,
      resourcePath(path, {...location, home: realHome}, externalResourceUri(identity)),
      512 * 1024,
    ));
  if (value === undefined || sha256HexSync(value) !== expectedHash) return false;
  const resource = parseExternalResource(uri, value);
  return resource !== undefined && resource.metadata.project === policy!.project;
});

export const loadExternalResourceAccess = Effect.fn('external.loadAccess')(function* (location: ResourceStoreLocation) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policyService = yield* Effect.serviceOption(ExternalSourcePolicy);
  const allowed: Record<string, string> = {};
  if (Option.isNone(policyService)) return allowed;
  const realHome = yield* fs.realPath(location.home).pipe(Effect.orElseSucceed(() => undefined));
  if (realHome === undefined) return allowed;
  const canonicalLocation = {...location, home: realHome};
  const now = yield* Clock.currentTimeMillis;
  for (const provider of ['superhuman', 'pocket', 'linear', 'github'] as const) {
    const root = resourcePath(
      path,
      canonicalLocation,
      provider === 'linear'
        ? LINEAR_ROOT
        : provider === 'pocket'
          ? POCKET_ROOT
          : provider === 'github'
            ? GITHUB_ROOT
            : SUPERHUMAN_ROOT,
    );
    const sources = yield* safeDirectories(fs, path, root);
    for (const sourceId of sources.filter(value => SOURCE_ID.test(value))) {
      const policy = yield* policyService.value.current(location, sourceId, provider);
      if (policy?.enabled !== true) continue;
      const sourceReceipt = yield* readExternalSourceReceipt(location, sourceId, provider);
      for (const documentId of (yield* safeDirectories(fs, path, path.join(root, sourceId, 'docs'))).filter(value =>
        ID.test(value),
      )) {
        const manifest = yield* readExternalDocumentManifest(location, sourceId, documentId, provider);
        if (!manifestPermits(manifest, policy, sourceReceipt, now)) continue;
        for (const [uri, expectedHash] of Object.entries(manifest!.chunks)) allowed[uri] = expectedHash;
      }
    }
  }
  return allowed;
});

function manifestPermits(
  manifest: ExternalDocumentManifest | undefined,
  policy: ExternalSourceAccessPolicy | undefined,
  sourceReceipt: ExternalSourceReceipt | undefined | null,
  now: number,
): boolean {
  return (
    policy?.enabled === true &&
    manifest?.status === 'active' &&
    sourceReceipt !== null &&
    (manifest.provider === 'github'
      ? sourceReceipt?.status === 'active' &&
        manifest.accessEpoch !== undefined &&
        !sourceReceipt.deniedRepositoryIds?.some(id => manifest.documentId.startsWith(`r-${id}-`))
      : sourceReceipt === undefined ||
        (manifest.provider === 'pocket' || manifest.provider === 'linear'
          ? sourceReceipt.status === 'active'
          : sourceReceipt.status !== 'cleanup')) &&
    (manifest.provider !== 'linear' ||
      (policy.credentialFingerprint !== undefined &&
        policy.credentialFingerprint === sourceReceipt?.credentialFingerprint)) &&
    manifest.accessEpoch === sourceReceipt?.accessEpoch &&
    policy.configFingerprint === manifest.configFingerprint &&
    now >= manifest.fetchedAt &&
    now - manifest.fetchedAt <=
      Math.min(manifest.maxStaleMilliseconds, policy.maxStaleMilliseconds ?? manifest.maxStaleMilliseconds)
  );
}

function resourcePath(path: Path.Path, location: ResourceStoreLocation, uri: string): string {
  const id = parseResourceId(uri);
  return path.join(location.home, 'data', location.account, 'resources', ...id.segments);
}

function safeRead(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  filename: string,
  maximumBytes: number,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const info = yield* fs.stat(filename);
    if (
      info.type !== 'File' ||
      Number(info.size) > maximumBytes ||
      (yield* fs.realPath(filename)) !== path.resolve(filename)
    )
      return undefined;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filename, {flag: 'r'});
        const opened = yield* file.stat;
        const inode = Option.getOrUndefined(opened.ino);
        if (
          inode === undefined ||
          inode !== Option.getOrUndefined(info.ino) ||
          opened.dev !== info.dev ||
          opened.size > BigInt(maximumBytes)
        )
          return undefined;
        const bytes = new Uint8Array(maximumBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const count = Number(yield* file.read(bytes.subarray(offset)));
          if (count <= 0) break;
          offset += count;
        }
        const after = yield* fs.stat(filename);
        if (
          offset > maximumBytes ||
          offset !== Number(opened.size) ||
          after.type !== 'File' ||
          Option.getOrUndefined(after.ino) !== inode ||
          after.dev !== opened.dev ||
          after.size !== opened.size ||
          (yield* fs.realPath(filename)) !== path.resolve(filename)
        )
          return undefined;
        return yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, offset)));
      }),
    );
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function safeDirectories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    if ((yield* fs.realPath(directory)) !== path.resolve(directory)) return [];
    const names = yield* fs.readDirectory(directory);
    const allowed = yield* Effect.filter(names, name =>
      Effect.gen(function* () {
        const filename = path.join(directory, name);
        return (
          (yield* fs.stat(filename)).type === 'Directory' && (yield* fs.realPath(filename)) === path.resolve(filename)
        );
      }).pipe(Effect.orElseSucceed(() => false)),
    );
    return allowed.sort();
  }).pipe(Effect.orElseSucceed(() => []));
}

function validIdentity(value: ExternalResourceIdentity): boolean {
  if (
    (value.provider !== undefined &&
      value.provider !== 'superhuman' &&
      value.provider !== 'pocket' &&
      value.provider !== 'linear' &&
      value.provider !== 'github') ||
    !SOURCE_ID.test(value.sourceId) ||
    !ID.test(value.documentId) ||
    !ID.test(value.pageId) ||
    !ID.test(value.chunkId)
  )
    return false;
  try {
    for (const segment of [value.sourceId, value.documentId, value.pageId, `${value.chunkId}.md`])
      validatePortableSegment(segment);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isExternalResourceMetadata(value: unknown): value is ExternalResourceMetadata {
  return validMetadata(value);
}

function validMetadata(value: unknown): value is ExternalResourceMetadata {
  if (
    !record(value) ||
    value.version !== 1 ||
    (value.coverage !== 'canvas-plain-text' &&
      value.coverage !== 'pocket-api-text' &&
      value.coverage !== 'linear-api-text' &&
      value.coverage !== 'github-conversation') ||
    (value.provider !== undefined &&
      value.provider !== 'superhuman' &&
      value.provider !== 'pocket' &&
      value.provider !== 'linear' &&
      value.provider !== 'github') ||
    !['sourceId', 'documentId', 'pageId', 'chunkId', 'title', 'rendererVersion', 'scrubberVersion'].every(
      key => typeof value[key] === 'string',
    )
  )
    return false;
  if (value.provider === 'github' ? value.coverage !== 'github-conversation' : value.coverage === 'github-conversation')
    return false;
  if (
    !validIdentity(value as unknown as ExternalResourceIdentity) ||
    (value.project !== null &&
      (typeof value.project !== 'string' || value.project.length === 0 || value.project.length > 256)) ||
    (value.title as string).length > 1024
  )
    return false;
  if (
    value.remoteRevision !== undefined &&
    (typeof value.remoteRevision !== 'string' || value.remoteRevision.length > 256)
  )
    return false;
  if (value.browserLink !== undefined) {
    if (value.provider === 'pocket') return false;
    if (typeof value.browserLink !== 'string' || value.browserLink.length > 2048) return false;
    try {
      const url = new URL(value.browserLink);
      if (value.provider === 'github') {
        if (
          url.origin !== 'https://github.com' ||
          !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/(?:issues|pull)\/[1-9][0-9]*(?:\/files)?$/.test(url.pathname) ||
          url.username ||
          url.password ||
          url.search ||
          (url.hash !== '' && !/^#[A-Za-z0-9_-]+$/.test(url.hash))
        )
          return false;
        return true;
      }
      if (
        (value.provider === 'linear'
          ? url.origin !== 'https://linear.app'
          : url.origin !== 'https://docs.superhuman.com' || !url.pathname.startsWith('/d/')) ||
        url.username ||
        url.password ||
        url.search
      )
        return false;
    } catch {
      return false;
    }
  }
  if (value.provider === 'github') return false;
  return true;
}

function validManifest(value: unknown): value is ExternalDocumentManifest {
  if (
    !record(value) ||
    value.version !== 1 ||
    (value.provider !== undefined &&
      value.provider !== 'superhuman' &&
      value.provider !== 'pocket' &&
      value.provider !== 'linear' &&
      value.provider !== 'github') ||
    typeof value.sourceId !== 'string' ||
    !SOURCE_ID.test(value.sourceId) ||
    typeof value.documentId !== 'string' ||
    !ID.test(value.documentId) ||
    typeof value.configFingerprint !== 'string' ||
    !HASH.test(value.configFingerprint) ||
    !['active', 'quarantined', 'pending'].includes(value.status as string) ||
    typeof value.fetchedAt !== 'number' ||
    !Number.isFinite(value.fetchedAt) ||
    value.fetchedAt < 0 ||
    typeof value.maxStaleMilliseconds !== 'number' ||
    !Number.isFinite(value.maxStaleMilliseconds) ||
    value.maxStaleMilliseconds <= 0 ||
    !record(value.chunks) ||
    Object.keys(value.chunks).length > 2048
  )
    return false;
  if (
    value.nextAttemptAt !== undefined &&
    (typeof value.nextAttemptAt !== 'number' ||
      !Number.isFinite(value.nextAttemptAt) ||
      value.nextAttemptAt < 0 ||
      value.nextAttemptAt >= 8_640_000_000_000_000)
  )
    return false;
  if (value.retryKind !== undefined && value.retryKind !== 'quota' && value.retryKind !== 'transient') return false;
  if (value.accessEpoch !== undefined && (typeof value.accessEpoch !== 'string' || !HASH.test(value.accessEpoch)))
    return false;
  if (
    value.inventoryGeneration !== undefined &&
    (typeof value.inventoryGeneration !== 'string' || !HASH.test(value.inventoryGeneration))
  )
    return false;
  return Object.entries(value.chunks).every(([uri, hash]) => {
    const identity = parseExternalResourceIdentity(uri);
    return (
      identity !== undefined &&
      (identity.provider ?? 'superhuman') === (value.provider ?? 'superhuman') &&
      identity.sourceId === value.sourceId &&
      identity.documentId === value.documentId &&
      typeof hash === 'string' &&
      HASH.test(hash)
    );
  });
}

function validSourceReceipt(value: unknown): value is ExternalSourceReceipt {
  if (
    !record(value) ||
    value.version !== 1 ||
    (value.provider !== undefined &&
      value.provider !== 'superhuman' &&
      value.provider !== 'pocket' &&
      value.provider !== 'linear' &&
      value.provider !== 'github') ||
    typeof value.sourceId !== 'string' ||
    !SOURCE_ID.test(value.sourceId) ||
    typeof value.accessEpoch !== 'string' ||
    !HASH.test(value.accessEpoch) ||
    (value.status !== 'authentication-rejected' && value.status !== 'cleanup' && value.status !== 'active')
  )
    return false;
  if (
    value.credentialFingerprint !== undefined &&
    (typeof value.credentialFingerprint !== 'string' || !HASH.test(value.credentialFingerprint))
  )
    return false;
  if (
    value.deniedRepositoryIds !== undefined &&
    (value.provider !== 'github' ||
      !Array.isArray(value.deniedRepositoryIds) ||
      value.deniedRepositoryIds.length > 100 ||
      value.deniedRepositoryIds.some(id => typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) ||
      new Set(value.deniedRepositoryIds).size !== value.deniedRepositoryIds.length)
  )
    return false;
  if (
    value.repositoryDenialGenerations !== undefined &&
    (value.provider !== 'github' ||
      !record(value.repositoryDenialGenerations) ||
      Object.keys(value.repositoryDenialGenerations).length > 100 ||
      Object.entries(value.repositoryDenialGenerations).some(
        ([id, generation]) =>
          !/^[1-9][0-9]{0,127}$/.test(id) || typeof generation !== 'string' || !HASH.test(generation),
      ))
  )
    return false;
  if (
    value.inventoryPage !== undefined &&
    (!Number.isSafeInteger(value.inventoryPage) || (value.inventoryPage as number) < 1)
  )
    return false;
  if (
    value.inventoryOffset !== undefined &&
    (!Number.isSafeInteger(value.inventoryOffset) ||
      (value.inventoryOffset as number) < 0 ||
      (value.inventoryOffset as number) > 100)
  )
    return false;
  if (
    value.inventoryGeneration !== undefined &&
    (typeof value.inventoryGeneration !== 'string' || !HASH.test(value.inventoryGeneration))
  )
    return false;
  if (
    value.completedAt !== undefined &&
    (typeof value.completedAt !== 'number' || !Number.isFinite(value.completedAt) || value.completedAt < 0)
  )
    return false;
  if (
    value.nextAttemptAt !== undefined &&
    (typeof value.nextAttemptAt !== 'number' ||
      !Number.isFinite(value.nextAttemptAt) ||
      value.nextAttemptAt < 0 ||
      value.nextAttemptAt >= 8_640_000_000_000_000)
  )
    return false;
  try {
    externalSourceReceiptUri(value.sourceId, value.provider ?? 'superhuman');
    return true;
  } catch {
    return false;
  }
}
