import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimePlatform} from '@threadnote/platform/system';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  ExternalSourcePolicy,
  externalDocumentManifestUri,
  externalResourceAccess,
  parseExternalResource,
  parseExternalResourceIdentity,
  readExternalDocumentManifest,
  readExternalSourceReceipt,
  type ExternalProvider,
} from './external-resource.js';
import {parseResourceId, validatePortableSegment} from './resource-id.js';
import {ResourceStore, type ResourceStoreLocation} from './resource-store.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ENVELOPE = 512 * 1024;
const MAX_FRAGMENT = 8192;
const MAX_CITATION = 4096;
const MAX_PINS = 256;
const MAX_BYTES = 64 * 1024 * 1024;
const PIN_HEADER = 'THREADNOTE SOURCE EVIDENCE/1\n';
const MAX_PIN_FILE_BYTES = MAX_ENVELOPE + MAX_CITATION + PIN_HEADER.length + 1;
const LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;
const encoder = new TextEncoder();

export interface SourceEvidenceCitationV1 {
  readonly version: 1;
  readonly provider: ExternalProvider;
  readonly sourceId: string;
  readonly sourceInstanceId: string;
  readonly resourceUri: string;
  readonly accessHash: string;
  readonly revisionHash: string;
  readonly contentHash: string;
  readonly rendererVersion: string;
  readonly sanitizerVersion: string;
  readonly fragmentHash: string;
  readonly fragmentStart: number;
  readonly fragmentEnd: number;
  readonly pinId: string;
  readonly expiresAt: string;
}

export interface SourceEvidenceInspection {
  readonly resourceUri: string;
  readonly provider: ExternalProvider;
  readonly sourceId: string;
  readonly sourceInstanceId: string;
  readonly accessHash: string;
  readonly revisionHash: string;
  readonly contentHash: string;
  readonly rendererVersion: string;
  readonly sanitizerVersion: string;
  readonly sanitizedContent: string;
}

export interface CaptureSourceEvidenceInput {
  readonly resourceUri: string;
  readonly fragment: string;
  readonly expectedSourceInstanceId: string;
  readonly expectedAccessHash: string;
  readonly expectedRevisionHash: string;
  readonly expectedContentHash: string;
  readonly expectedRendererVersion: string;
  readonly expectedSanitizerVersion: string;
  readonly retentionDays?: number;
}

export interface SourceEvidenceRead {
  readonly citation: SourceEvidenceCitationV1;
  readonly historical: 'available' | 'expired' | 'revoked' | 'missing' | 'corrupt';
  readonly currentRevision: 'same' | 'changed' | 'removed' | 'unknown';
  readonly fragment?: string;
}

export class SourceEvidenceError extends Schema.TaggedError<SourceEvidenceError>()('SourceEvidenceError', {
  message: Schema.String,
}) {}

function invalid(message: string): SourceEvidenceError {
  return SourceEvidenceError.make({message});
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function validVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    [...value].every(character => {
      const code = character.codePointAt(0)!;
      return (code > 31 && code < 127) || code > 159;
    })
  );
}

function privateMode(mode: number, expected: number): boolean {
  return runtimePlatform === 'win32' || (mode & 0o777) === expected;
}

function citationRecord(value: unknown): value is SourceEvidenceCitationV1 {
  if (!object(value)) return false;
  const identity = typeof value.resourceUri === 'string' ? parseExternalResourceIdentity(value.resourceUri) : undefined;
  if (
    Object.keys(value).length !== 15 ||
    value.version !== 1 ||
    !identity ||
    value.resourceUri !==
      `threadnote://resources/external/${identity.provider}/${identity.sourceId}/docs/${identity.documentId}/pages/${identity.pageId}/${identity.chunkId}.md` ||
    value.provider !== identity.provider ||
    value.sourceId !== identity.sourceId ||
    typeof value.sourceInstanceId !== 'string' ||
    !HASH.test(value.sourceInstanceId) ||
    typeof value.accessHash !== 'string' ||
    !HASH.test(value.accessHash) ||
    typeof value.revisionHash !== 'string' ||
    !HASH.test(value.revisionHash) ||
    typeof value.contentHash !== 'string' ||
    !HASH.test(value.contentHash) ||
    typeof value.fragmentHash !== 'string' ||
    !HASH.test(value.fragmentHash) ||
    !validVersion(value.rendererVersion) ||
    !validVersion(value.sanitizerVersion) ||
    typeof value.pinId !== 'string' ||
    !UUID.test(value.pinId) ||
    !Number.isSafeInteger(value.fragmentStart) ||
    (value.fragmentStart as number) < 0 ||
    !Number.isSafeInteger(value.fragmentEnd) ||
    (value.fragmentEnd as number) <= (value.fragmentStart as number) ||
    (value.fragmentEnd as number) > MAX_ENVELOPE ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    return false;
  return true;
}

export function validSourceEvidenceCitation(value: unknown): value is SourceEvidenceCitationV1 {
  return citationRecord(value) && bytes(JSON.stringify(value)) <= MAX_CITATION;
}

export function serializeSourceEvidenceCitation(citation: SourceEvidenceCitationV1): string {
  if (!validSourceEvidenceCitation(citation)) throw new Error('Invalid source evidence citation.');
  return JSON.stringify({
    version: citation.version,
    provider: citation.provider,
    sourceId: citation.sourceId,
    sourceInstanceId: citation.sourceInstanceId,
    resourceUri: citation.resourceUri,
    accessHash: citation.accessHash,
    revisionHash: citation.revisionHash,
    contentHash: citation.contentHash,
    rendererVersion: citation.rendererVersion,
    sanitizerVersion: citation.sanitizerVersion,
    fragmentHash: citation.fragmentHash,
    fragmentStart: citation.fragmentStart,
    fragmentEnd: citation.fragmentEnd,
    pinId: citation.pinId,
    expiresAt: citation.expiresAt,
  });
}

function githubRepositoryId(documentId: string): string | undefined {
  return /^r-([1-9][0-9]*)-/.exec(documentId)?.[1];
}

const access = Effect.fn('sourceEvidence.access')(function* (location: ResourceStoreLocation, resourceUri: string) {
  const identity = parseExternalResourceIdentity(resourceUri);
  if (!identity || identity.provider === undefined || resourceUri !== resourceUri.split('#', 1)[0]) return undefined;
  const service = yield* Effect.serviceOption(ExternalSourcePolicy);
  if (Option.isNone(service)) return undefined;
  const policy = yield* service.value.current(location, identity.sourceId, identity.provider);
  const credential = service.value.evidenceFingerprint
    ? yield* service.value.evidenceFingerprint(location, identity.sourceId, identity.provider)
    : undefined;
  const receipt = yield* readExternalSourceReceipt(location, identity.sourceId, identity.provider);
  if (
    policy?.enabled !== true ||
    !credential ||
    !HASH.test(credential) ||
    !HASH.test(policy.configFingerprint) ||
    !receipt ||
    receipt.status !== 'active' ||
    !HASH.test(receipt.accessEpoch) ||
    (identity.provider === 'linear' && policy.credentialFingerprint !== receipt.credentialFingerprint)
  )
    return undefined;
  const repositoryId = identity.provider === 'github' ? githubRepositoryId(identity.documentId) : undefined;
  if (identity.provider === 'github' && (!repositoryId || receipt.deniedRepositoryIds?.includes(repositoryId)))
    return undefined;
  const denialGeneration = repositoryId ? (receipt.repositoryDenialGenerations?.[repositoryId] ?? '') : '';
  return {
    identity,
    receipt,
    policy,
    accessHash: sha256HexSync(
      JSON.stringify([policy.configFingerprint, credential, receipt.accessEpoch, denialGeneration]),
    ),
  };
});

export const inspectSourceEvidence = Effect.fn('sourceEvidence.inspect')(function* (
  location: ResourceStoreLocation,
  resourceUri: string,
) {
  const before = yield* access(location, resourceUri);
  if (!before) return yield* invalid('Current source evidence access is unavailable.');
  const store = yield* ResourceStore;
  const read = yield* store
    .readBounded(location, resourceUri, MAX_ENVELOPE)
    .pipe(Effect.mapError(() => invalid('Current sanitized source snapshot is unavailable.')));
  if (read.truncated) return yield* invalid('Source evidence exceeds the 512 KiB limit.');
  const resource = parseExternalResource(resourceUri, read.content);
  if (
    !resource ||
    bytes(read.content) > MAX_ENVELOPE ||
    bytes(resource.body) > MAX_ENVELOPE ||
    !validVersion(resource.metadata.rendererVersion) ||
    !validVersion(resource.metadata.scrubberVersion)
  )
    return yield* invalid('Current sanitized source snapshot is invalid.');
  const contentHash = sha256HexSync(read.content);
  if (!(yield* externalResourceAccess(location, resourceUri, read.content, contentHash)))
    return yield* invalid('Current source evidence access changed.');
  const after = yield* access(location, resourceUri);
  if (!after || after.accessHash !== before.accessHash || after.receipt.accessEpoch !== before.receipt.accessEpoch)
    return yield* invalid('Current source evidence access changed.');
  return {
    resourceUri,
    provider: before.identity.provider!,
    sourceId: before.identity.sourceId,
    sourceInstanceId: before.receipt.accessEpoch,
    accessHash: before.accessHash,
    revisionHash: sha256HexSync(resource.body),
    contentHash,
    rendererVersion: resource.metadata.rendererVersion,
    sanitizerVersion: resource.metadata.scrubberVersion,
    sanitizedContent: resource.body,
  } satisfies SourceEvidenceInspection;
});

function directoryPath(path: Path.Path, location: ResourceStoreLocation, provider: ExternalProvider, sourceId: string) {
  validatePortableSegment(location.account);
  validatePortableSegment(sourceId);
  return path.join(location.home, 'threadnote', 'source-evidence', location.account, provider, sourceId);
}

const ensurePrivateDirectory = Effect.fn('sourceEvidence.privateDirectory')(function* (
  directory: string,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = home;
  const segments = path.relative(home, directory).split(path.sep).filter(Boolean);
  if (segments[0] !== 'threadnote' || segments[1] !== 'source-evidence' || segments.length !== 5)
    return yield* invalid('Private evidence directory is outside its account boundary.');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const result = yield* fs.stat(current).pipe(Effect.result);
    const created = Result.isFailure(result) && result.failure.reason._tag === 'NotFound';
    if (created) yield* fs.makeDirectory(current, {mode: 0o700});
    else if (Result.isFailure(result)) return yield* invalid('Private evidence directory is inaccessible.');
    const info = yield* fs.stat(current);
    if (info.type !== 'Directory' || (yield* fs.realPath(current)) !== path.resolve(current))
      return yield* invalid('Private evidence directory is unsafe.');
    if (index >= 1) {
      if (created) yield* fs.chmod(current, 0o700);
      else if (!privateMode(info.mode, 0o700))
        return yield* invalid('Private evidence directory has unsafe permissions.');
      const final = yield* fs.stat(current);
      if (
        final.type !== 'Directory' ||
        !privateMode(final.mode, 0o700) ||
        (yield* fs.realPath(current)) !== path.resolve(current)
      )
        return yield* invalid('Private evidence directory changed during validation.');
    }
  }
});

const safeFile = Effect.fn('sourceEvidence.safeFile')(function* (filename: string, maximum: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const stat = yield* fs.stat(filename);
    if (
      stat.type !== 'File' ||
      Number(stat.size) > maximum ||
      !privateMode(stat.mode, 0o600) ||
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
          inode !== Option.getOrUndefined(stat.ino) ||
          opened.dev !== stat.dev ||
          !privateMode(opened.mode, 0o600) ||
          opened.size > BigInt(maximum)
        )
          return undefined;
        const data = new Uint8Array(maximum + 1);
        let offset = 0;
        while (offset < data.length) {
          const n = Number(yield* file.read(data.subarray(offset)));
          if (n <= 0) break;
          offset += n;
        }
        const after = yield* fs.stat(filename);
        if (
          offset > maximum ||
          offset !== Number(opened.size) ||
          after.type !== 'File' ||
          Option.getOrUndefined(after.ino) !== inode ||
          after.dev !== opened.dev ||
          after.size !== opened.size ||
          !privateMode(after.mode, 0o600) ||
          (yield* fs.realPath(filename)) !== path.resolve(filename)
        )
          return undefined;
        return yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true}).decode(data.subarray(0, offset)));
      }),
    );
  }).pipe(Effect.orElseSucceed(() => undefined));
});

function parsePin(raw: string): {citation: SourceEvidenceCitationV1; sanitizedContent: string} | undefined {
  try {
    if (!raw.startsWith(PIN_HEADER)) return undefined;
    const headerEnd = raw.indexOf('\n', PIN_HEADER.length);
    if (headerEnd < 0 || headerEnd - PIN_HEADER.length > MAX_CITATION) return undefined;
    const header = raw.slice(PIN_HEADER.length, headerEnd);
    const citation: unknown = JSON.parse(header);
    if (!validSourceEvidenceCitation(citation) || serializeSourceEvidenceCitation(citation) !== header)
      return undefined;
    const sanitizedContent = raw.slice(headerEnd + 1);
    if (bytes(sanitizedContent) > MAX_ENVELOPE || sha256HexSync(sanitizedContent) !== citation.revisionHash)
      return undefined;
    return {citation, sanitizedContent};
  } catch {
    return undefined;
  }
}

const withPinLock = <A, E, R>(
  location: ResourceStoreLocation,
  provider: ExternalProvider,
  sourceId: string,
  effect: (directory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const realHome = yield* fs.realPath(location.home);
    const directory = directoryPath(path, {...location, home: realHome}, provider, sourceId);
    yield* ensurePrivateDirectory(directory, realHome);
    return yield* withExclusiveFileLock(fs, path.join(directory, '.lock'), LOCK_OPTIONS, effect(directory));
  });

export const captureSourceEvidence = Effect.fn('sourceEvidence.capture')(function* (
  location: ResourceStoreLocation,
  input: CaptureSourceEvidenceInput,
) {
  const identity = parseExternalResourceIdentity(input.resourceUri);
  if (!identity?.provider) return yield* invalid('Invalid source evidence resource URI.');
  const retentionDays = input.retentionDays ?? 90;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)
    return yield* invalid('Source evidence retentionDays must be 1–365.');
  if (typeof input.fragment !== 'string' || bytes(input.fragment) < 1 || bytes(input.fragment) > MAX_FRAGMENT)
    return yield* invalid('Source evidence fragment must be 1–8192 UTF-8 bytes.');
  return yield* withPinLock(location, identity.provider, identity.sourceId, directory =>
    Effect.gen(function* () {
      const inspected = yield* inspectSourceEvidence(location, input.resourceUri);
      if (
        inspected.sourceInstanceId !== input.expectedSourceInstanceId ||
        inspected.accessHash !== input.expectedAccessHash ||
        inspected.revisionHash !== input.expectedRevisionHash ||
        inspected.contentHash !== input.expectedContentHash ||
        inspected.rendererVersion !== input.expectedRendererVersion ||
        inspected.sanitizerVersion !== input.expectedSanitizerVersion
      )
        return yield* invalid('Reviewed source identity or sanitized revision changed; inspect again.');
      const fragmentStart = inspected.sanitizedContent.indexOf(input.fragment);
      if (fragmentStart < 0) return yield* invalid('Fragment is absent from the exact sanitized imported revision.');
      const crypto = yield* Crypto.Crypto;
      const now = yield* Clock.currentTimeMillis;
      const pinId = yield* crypto.randomUUIDv4;
      const citation: SourceEvidenceCitationV1 = {
        version: 1,
        provider: inspected.provider,
        sourceId: inspected.sourceId,
        sourceInstanceId: inspected.sourceInstanceId,
        resourceUri: inspected.resourceUri,
        accessHash: inspected.accessHash,
        revisionHash: inspected.revisionHash,
        contentHash: inspected.contentHash,
        rendererVersion: inspected.rendererVersion,
        sanitizerVersion: inspected.sanitizerVersion,
        fragmentHash: sha256HexSync(input.fragment),
        fragmentStart,
        fragmentEnd: fragmentStart + input.fragment.length,
        pinId,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + retentionDays * 86_400_000)),
      };
      if (!validSourceEvidenceCitation(citation)) return yield* invalid('Source evidence citation exceeds its bounds.');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let retainedCount = 0;
      let retainedBytes = 0;
      const names = yield* fs.readDirectory(directory);
      if (names.length > 700) return yield* invalid('Source evidence directory exceeds its file budget.');
      for (const name of names) {
        if (!UUID.test(name.slice(0, -5)) || !name.endsWith('.json')) continue;
        const filename = path.join(directory, name);
        const raw = yield* safeFile(filename, MAX_PIN_FILE_BYTES);
        if (raw === undefined) return yield* invalid('Source evidence pin is unreadable or unsafe.');
        const pin = parsePin(raw);
        if (
          !pin ||
          `${pin.citation.pinId}.json` !== name ||
          pin.citation.provider !== identity.provider ||
          pin.citation.sourceId !== identity.sourceId
        )
          return yield* invalid('Source evidence pin is corrupt.');
        if (Date.parse(pin.citation.expiresAt) <= now) yield* fs.remove(filename);
        else {
          retainedCount++;
          retainedBytes += bytes(raw);
        }
      }
      const serialized = `${PIN_HEADER}${serializeSourceEvidenceCitation(citation)}\n${inspected.sanitizedContent}`;
      if (bytes(serialized) > MAX_PIN_FILE_BYTES) return yield* invalid('Source evidence pin exceeds its file budget.');
      if (retainedCount >= MAX_PINS || retainedBytes + bytes(serialized) > MAX_BYTES)
        return yield* invalid('Source evidence retention capacity reached.');
      const final = yield* inspectSourceEvidence(location, input.resourceUri);
      if (
        final.sourceInstanceId !== inspected.sourceInstanceId ||
        final.accessHash !== inspected.accessHash ||
        final.revisionHash !== inspected.revisionHash ||
        final.contentHash !== inspected.contentHash ||
        final.rendererVersion !== inspected.rendererVersion ||
        final.sanitizerVersion !== inspected.sanitizerVersion
      )
        return yield* invalid('Source evidence access changed during capture.');
      const destination = path.join(directory, `${pinId}.json`);
      const temporary = path.join(directory, `${pinId}.tmp`);
      yield* fs.writeFileString(temporary, serialized, {mode: 0o600});
      yield* fs
        .rename(temporary, destination)
        .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
      yield* fs.chmod(destination, 0o600);
      return citation;
    }),
  );
});

function denied(
  citation: SourceEvidenceCitationV1,
  historical: SourceEvidenceRead['historical'],
  currentRevision: SourceEvidenceRead['currentRevision'] = 'unknown',
): SourceEvidenceRead {
  return {citation, historical, currentRevision};
}

const manifestEntry = Effect.fn('sourceEvidence.manifestEntry')(function* (home: string, filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relative = path.relative(home, filename);
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length < 1 || segments.length > 16 || segments.some(segment => segment === '..' || segment === '.'))
    return 'unsafe' as const;
  let parent = home;
  for (const [index, segment] of segments.entries()) {
    const entry = path.join(parent, segment);
    const stat = yield* fs.stat(entry).pipe(Effect.result);
    if (Result.isFailure(stat)) {
      if (stat.failure.reason._tag !== 'NotFound') return 'unsafe' as const;
      const listed = yield* fs.readDirectory(parent).pipe(Effect.result);
      if (
        Result.isFailure(listed) ||
        listed.success.includes(segment) ||
        (yield* fs.realPath(parent).pipe(Effect.orElseSucceed(() => ''))) !== path.resolve(parent)
      )
        return 'unsafe' as const;
      return 'absent' as const;
    }
    if (
      stat.success.type !== (index === segments.length - 1 ? 'File' : 'Directory') ||
      (yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => ''))) !== path.resolve(entry)
    )
      return 'unsafe' as const;
    parent = entry;
  }
  return 'present' as const;
});

function manifestFresh(
  manifest: {readonly fetchedAt: number; readonly maxStaleMilliseconds: number},
  policy: {readonly maxStaleMilliseconds?: number},
  now: number,
): boolean {
  return (
    now >= manifest.fetchedAt &&
    now - manifest.fetchedAt <=
      Math.min(manifest.maxStaleMilliseconds, policy.maxStaleMilliseconds ?? manifest.maxStaleMilliseconds)
  );
}

export const readSourceEvidence = Effect.fn('sourceEvidence.read')(function* (
  location: ResourceStoreLocation,
  citation: SourceEvidenceCitationV1,
) {
  if (!validSourceEvidenceCitation(citation)) return denied(citation, 'corrupt');
  return yield* withPinLock(location, citation.provider, citation.sourceId, directory =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (Date.parse(citation.expiresAt) <= now) return denied(citation, 'expired');
      const state = yield* access(location, citation.resourceUri);
      if (!state || state.accessHash !== citation.accessHash || state.receipt.accessEpoch !== citation.sourceInstanceId)
        return denied(citation, 'revoked');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const manifestUri = externalDocumentManifestUri(citation.sourceId, state.identity.documentId, citation.provider);
      const realHome = yield* fs.realPath(location.home);
      const manifestPath = path.join(
        realHome,
        'data',
        location.account,
        'resources',
        ...parseResourceId(manifestUri).segments,
      );
      const initialEntry = yield* manifestEntry(realHome, manifestPath);
      if (initialEntry === 'unsafe') return denied(citation, 'revoked');
      if (initialEntry === 'present') {
        const manifest = yield* readExternalDocumentManifest(
          location,
          citation.sourceId,
          state.identity.documentId,
          citation.provider,
        );
        if (
          !manifest ||
          manifest.status !== 'active' ||
          manifest.configFingerprint !== state.policy.configFingerprint ||
          manifest.accessEpoch !== state.receipt.accessEpoch
        )
          return denied(citation, 'revoked');
      }
      const filename = path.join(directory, `${citation.pinId}.json`);
      const fileState = yield* fs.stat(filename).pipe(Effect.result);
      if (Result.isFailure(fileState))
        return denied(citation, fileState.failure.reason._tag === 'NotFound' ? 'missing' : 'corrupt');
      const raw = yield* safeFile(filename, MAX_PIN_FILE_BYTES);
      if (raw === undefined) return denied(citation, 'corrupt');
      const pin = parsePin(raw);
      if (
        !pin ||
        serializeSourceEvidenceCitation(pin.citation) !== serializeSourceEvidenceCitation(citation) ||
        citation.fragmentEnd > pin.sanitizedContent.length
      )
        return denied(citation, 'corrupt');
      const fragment = pin.sanitizedContent.slice(citation.fragmentStart, citation.fragmentEnd);
      if (bytes(fragment) < 1 || bytes(fragment) > MAX_FRAGMENT || sha256HexSync(fragment) !== citation.fragmentHash)
        return denied(citation, 'corrupt');
      const beforeInspection = yield* access(location, citation.resourceUri);
      if (!beforeInspection || beforeInspection.accessHash !== citation.accessHash) return denied(citation, 'revoked');
      const beforeEntry = yield* manifestEntry(realHome, manifestPath);
      if (beforeEntry === 'unsafe') return denied(citation, 'revoked');
      let currentInspection: SourceEvidenceInspection | undefined;
      if (beforeEntry === 'present') {
        const beforeManifest = yield* readExternalDocumentManifest(
          location,
          citation.sourceId,
          state.identity.documentId,
          citation.provider,
        );
        if (
          !beforeManifest ||
          beforeManifest.status !== 'active' ||
          beforeManifest.configFingerprint !== beforeInspection.policy.configFingerprint ||
          beforeManifest.accessEpoch !== beforeInspection.receipt.accessEpoch
        )
          return denied(citation, 'revoked');
        if (
          beforeManifest.chunks[citation.resourceUri] !== undefined &&
          manifestFresh(beforeManifest, beforeInspection.policy, yield* Clock.currentTimeMillis)
        ) {
          const inspected = yield* Effect.result(inspectSourceEvidence(location, citation.resourceUri));
          if (Result.isSuccess(inspected)) currentInspection = inspected.success;
        }
      }
      const finalAccess = yield* access(location, citation.resourceUri);
      if (
        !finalAccess ||
        finalAccess.accessHash !== citation.accessHash ||
        finalAccess.receipt.accessEpoch !== citation.sourceInstanceId
      )
        return denied(citation, 'revoked');
      const finalEntry = yield* manifestEntry(realHome, manifestPath);
      if (finalEntry === 'unsafe') return denied(citation, 'revoked');
      let currentRevision: SourceEvidenceRead['currentRevision'] = 'unknown';
      if (finalEntry === 'present') {
        const finalManifest = yield* readExternalDocumentManifest(
          location,
          citation.sourceId,
          state.identity.documentId,
          citation.provider,
        );
        if (
          !finalManifest ||
          finalManifest.status !== 'active' ||
          finalManifest.configFingerprint !== finalAccess.policy.configFingerprint ||
          finalManifest.accessEpoch !== finalAccess.receipt.accessEpoch
        )
          return denied(citation, 'revoked');
        if (manifestFresh(finalManifest, finalAccess.policy, yield* Clock.currentTimeMillis)) {
          const finalHash = finalManifest.chunks[citation.resourceUri];
          if (finalHash === undefined) currentRevision = 'removed';
          else if (
            currentInspection?.contentHash === finalHash &&
            currentInspection.accessHash === citation.accessHash &&
            currentInspection.sourceInstanceId === citation.sourceInstanceId
          ) {
            currentRevision =
              currentInspection.contentHash === citation.contentHash &&
              currentInspection.revisionHash === citation.revisionHash &&
              currentInspection.rendererVersion === citation.rendererVersion &&
              currentInspection.sanitizerVersion === citation.sanitizerVersion
                ? 'same'
                : 'changed';
          }
        }
      }
      return {citation, historical: 'available' as const, currentRevision, fragment};
    }),
  );
});

export const discardSourceEvidence = Effect.fn('sourceEvidence.discard')(function* (
  location: ResourceStoreLocation,
  citation: SourceEvidenceCitationV1,
) {
  if (!validSourceEvidenceCitation(citation)) return yield* invalid('Invalid source evidence citation.');
  return yield* withPinLock(location, citation.provider, citation.sourceId, directory =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(directory, `${citation.pinId}.json`);
      const raw = yield* safeFile(filename, MAX_PIN_FILE_BYTES);
      const pin = raw === undefined ? undefined : parsePin(raw);
      if (pin && serializeSourceEvidenceCitation(pin.citation) === serializeSourceEvidenceCitation(citation))
        yield* fs.remove(filename);
    }),
  );
});

export const removeSourceEvidencePins = Effect.fn('sourceEvidence.removePins')(function* (
  location: ResourceStoreLocation,
  provider: ExternalProvider,
  sourceId: string,
) {
  return yield* withPinLock(location, provider, sourceId, directory =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const names = yield* fs.readDirectory(directory);
      if (names.length > 700) return yield* invalid('Source evidence directory exceeds its file budget.');
      for (const name of names) {
        if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) {
          const filename = path.join(directory, name);
          const raw = yield* safeFile(filename, MAX_PIN_FILE_BYTES);
          const pin = raw === undefined ? undefined : parsePin(raw);
          if (
            !pin ||
            pin.citation.provider !== provider ||
            pin.citation.sourceId !== sourceId ||
            `${pin.citation.pinId}.json` !== name
          )
            return yield* invalid('Source evidence pin is corrupt.');
          yield* fs.remove(filename);
        }
      }
    }),
  );
});
