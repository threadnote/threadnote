import {Effect, Exit, FileSystem, Path, Scope, Stream, Schema} from 'effect';

class ArchiveOperationError extends Schema.TaggedError<ArchiveOperationError>()('ArchiveOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const TAR_BLOCK_BYTES = 512;
const MAX_COMPRESSED_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_DECOMPRESSED_TAR_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_DECOMPRESSED_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_TAR_END_PADDING_BYTES = 1024 * 1024;
const MAX_TAR_ENTRIES = 10_000;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;

export interface ArchiveExtractionLimits {
  readonly decompressedBytes?: number;
  readonly endPaddingBytes?: number;
  readonly entries?: number;
  readonly expandedBytes?: number;
}

interface TarEntry {
  readonly mode: number;
  readonly path: string;
  readonly size: number;
  readonly type: 'directory' | 'file' | 'globalPax' | 'longPath' | 'pax';
}

export const extractGzipTar = Effect.fn('archive.extractGzipTar')(function* (
  archivePath: string,
  destination: string,
  configuredLimits: ArchiveExtractionLimits = {},
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentScope = yield* Scope.Scope;
      const archiveInfo = yield* fs.stat(archivePath);
      if (Number(archiveInfo.size) > MAX_COMPRESSED_ARCHIVE_BYTES) {
        return yield* ArchiveOperationError.make({
          message: `Release archive exceeds ${MAX_COMPRESSED_ARCHIVE_BYTES} compressed bytes.`,
        });
      }
      const limits: Required<ArchiveExtractionLimits> = {
        decompressedBytes: configuredLimits.decompressedBytes ?? MAX_DECOMPRESSED_TAR_BYTES,
        endPaddingBytes: configuredLimits.endPaddingBytes ?? MAX_TAR_END_PADDING_BYTES,
        entries: configuredLimits.entries ?? MAX_TAR_ENTRIES,
        expandedBytes: configuredLimits.expandedBytes ?? MAX_EXPANDED_ARCHIVE_BYTES,
      };
      yield* validateExtractionLimits(limits);
      yield* fs.makeDirectory(destination, {recursive: true, mode: 0o700});
      const parser = createTarStreamParser(fs, path, parentScope, destination, limits);
      const decompressed = Stream.fromReadableStream({
        evaluate: () => Bun.file(archivePath).stream().pipeThrough(new DecompressionStream('gzip')),
        onError: cause => ArchiveOperationError.make({cause, message: `Could not decompress ${archivePath}.`}),
      });
      let decompressedBytes = 0;
      yield* decompressed.pipe(
        Stream.runForEach(chunk =>
          Effect.gen(function* () {
            if (chunk.length > MAX_DECOMPRESSED_CHUNK_BYTES) {
              return yield* ArchiveOperationError.make({
                message: `Release archive emitted an oversized ${chunk.length}-byte chunk.`,
              });
            }
            decompressedBytes += chunk.length;
            if (decompressedBytes > limits.decompressedBytes) {
              return yield* ArchiveOperationError.make({
                message: `Release archive exceeds ${limits.decompressedBytes} decompressed tar bytes.`,
              });
            }
            yield* parser.write(chunk);
          }),
        ),
        Effect.andThen(parser.complete()),
        Effect.mapError(cause =>
          ArchiveOperationError.make({
            cause,
            message: `Could not extract ${archivePath}: ${archiveCauseMessage(cause)}`,
          }),
        ),
      );
    }),
  );
});

function createTarStreamParser(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  parentScope: Scope.Scope,
  destination: string,
  limits: Required<ArchiveExtractionLimits>,
) {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let ended = false;
  let endPaddingBytes = 0;
  let entryCount = 0;
  let expandedBytes = 0;
  let globalPax: Readonly<Record<string, string>> = {};
  let nextLongPath: string | undefined;
  let nextPax: Readonly<Record<string, string>> | undefined;
  let file:
    | {
        readonly chunks?: Uint8Array<ArrayBufferLike>[];
        readonly handle?: FileSystem.File;
        readonly metadataType?: 'globalPax' | 'longPath' | 'pax';
        readonly mode: number;
        readonly padding: number;
        readonly path: string | undefined;
        readonly scope?: Scope.Closeable;
        remaining: number;
      }
    | undefined;
  let paddingRemaining = 0;

  const write = Effect.fn('archive.tarParser.write')(function* (chunk: Uint8Array) {
    buffer = concatenate(buffer, chunk);
    while (buffer.length > 0) {
      if (ended) {
        if (!buffer.every(byte => byte === 0)) {
          return yield* ArchiveOperationError.make({message: 'Release archive contains data after its end marker.'});
        }
        endPaddingBytes += buffer.length;
        if (endPaddingBytes > limits.endPaddingBytes) {
          return yield* ArchiveOperationError.make({
            message: `Release archive exceeds ${limits.endPaddingBytes} end-padding bytes.`,
          });
        }
        buffer = new Uint8Array();
        return;
      }
      if (file) {
        if (file.remaining > 0) {
          const length = Math.min(file.remaining, buffer.length);
          const data = buffer.slice(0, length);
          buffer = buffer.slice(length);
          if (file.handle) yield* file.handle.writeAll(data);
          else file.chunks?.push(data);
          file.remaining -= length;
          if (file.remaining > 0) return;
        }
        if (file.handle && file.scope && file.path) {
          yield* file.handle.sync;
          yield* Scope.close(file.scope, Exit.void);
          yield* fs.chmod(file.path, file.mode);
        } else if (file.metadataType) {
          const metadata = concatenateAll(file.chunks ?? []);
          const parsedPax =
            file.metadataType === 'pax' || file.metadataType === 'globalPax'
              ? yield* attemptArchiveParse(() => parsePaxMetadata(metadata))
              : undefined;
          if (file.metadataType === 'pax') nextPax = parsedPax;
          if (file.metadataType === 'globalPax') {
            globalPax = mergePaxMetadata(globalPax, parsedPax ?? {});
          }
          if (file.metadataType === 'longPath') nextLongPath = tarMetadataText(metadata);
        }
        paddingRemaining = file.padding;
        file = undefined;
      }
      if (paddingRemaining > 0) {
        const length = Math.min(paddingRemaining, buffer.length);
        buffer = buffer.slice(length);
        paddingRemaining -= length;
        if (paddingRemaining > 0) return;
        continue;
      }
      if (buffer.length < TAR_BLOCK_BYTES) return;
      const header = buffer.slice(0, TAR_BLOCK_BYTES);
      buffer = buffer.slice(TAR_BLOCK_BYTES);
      if (header.every(byte => byte === 0)) {
        ended = true;
        continue;
      }
      entryCount += 1;
      if (entryCount > limits.entries) {
        return yield* ArchiveOperationError.make({message: `Release archive exceeds ${limits.entries} tar entries.`});
      }
      const entry = yield* attemptArchiveParse(() => parseTarHeader(header));
      expandedBytes += entry.size;
      if (expandedBytes > limits.expandedBytes) {
        return yield* ArchiveOperationError.make({
          message: `Release archive exceeds ${limits.expandedBytes} expanded bytes.`,
        });
      }
      if (entry.type === 'globalPax' || entry.type === 'longPath' || entry.type === 'pax') {
        if (entry.size > MAX_TAR_METADATA_BYTES) {
          return yield* ArchiveOperationError.make({
            message: `Release archive tar metadata exceeds ${MAX_TAR_METADATA_BYTES} bytes.`,
          });
        }
        file = {
          chunks: [],
          metadataType: entry.type,
          mode: entry.mode,
          padding: tarPadding(entry.size),
          path: undefined,
          remaining: entry.size,
        };
        if (entry.size === 0) {
          if (entry.type === 'pax') nextPax = {};
          if (entry.type === 'longPath') nextLongPath = '';
          paddingRemaining = file.padding;
          file = undefined;
        }
        continue;
      }
      const effectivePax = mergePaxMetadata(globalPax, nextPax ?? {});
      const effectivePath = nextLongPath ?? effectivePax.path ?? entry.path;
      const effectiveSize =
        effectivePax.size === undefined
          ? entry.size
          : yield* attemptArchiveParse(() => parsePaxSize(effectivePax.size));
      expandedBytes += effectiveSize - entry.size;
      if (expandedBytes > limits.expandedBytes) {
        return yield* ArchiveOperationError.make({
          message: `Release archive exceeds ${limits.expandedBytes} expanded bytes.`,
        });
      }
      nextLongPath = undefined;
      nextPax = undefined;
      if (entry.type === 'directory' && isArchiveRootPath(effectivePath)) {
        paddingRemaining = tarPadding(effectiveSize);
        continue;
      }
      const entryPath = yield* attemptArchiveParse(() => safeArchivePath(path, destination, effectivePath));
      if (entry.type === 'directory') {
        yield* fs.makeDirectory(entryPath, {recursive: true, mode: entry.mode});
        paddingRemaining = tarPadding(effectiveSize);
        continue;
      }
      yield* fs.makeDirectory(path.dirname(entryPath), {recursive: true, mode: 0o700});
      const fileScope = yield* Scope.make();
      yield* Scope.addFinalizerExit(parentScope, exit => Scope.close(fileScope, exit));
      const handle = yield* fs
        .open(entryPath, {flag: 'w', mode: entry.mode})
        .pipe(Effect.provideService(Scope.Scope, fileScope));
      file = {
        handle,
        mode: entry.mode,
        padding: tarPadding(effectiveSize),
        path: entryPath,
        remaining: effectiveSize,
        scope: fileScope,
      };
      if (effectiveSize === 0) {
        yield* handle.sync;
        yield* Scope.close(fileScope, Exit.void);
        yield* fs.chmod(entryPath, entry.mode);
        paddingRemaining = file.padding;
        file = undefined;
      }
    }
  });

  const complete = Effect.fn('archive.tarParser.complete')(function* () {
    if (!ended || file || paddingRemaining !== 0 || buffer.length !== 0) {
      return yield* ArchiveOperationError.make({message: 'Release archive ended before a complete tar end marker.'});
    }
    if (nextLongPath !== undefined || nextPax !== undefined) {
      return yield* ArchiveOperationError.make({
        message: 'Release archive ended after metadata without a target entry.',
      });
    }
  });

  return {complete, write};
}

function validateExtractionLimits(limits: Required<ArchiveExtractionLimits>) {
  return Effect.forEach(Object.entries(limits), ([name, value]) =>
    Number.isSafeInteger(value) && value > 0
      ? Effect.void
      : Effect.fail(
          ArchiveOperationError.make({message: `Archive extraction limit ${name} must be a positive safe integer.`}),
        ),
  ).pipe(Effect.asVoid);
}

function attemptArchiveParse<A>(parse: () => A) {
  return Effect.try({
    try: parse,
    catch: cause =>
      Schema.is(ArchiveOperationError)(cause)
        ? cause
        : ArchiveOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
  });
}

function archiveCauseMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseTarHeader(header: Uint8Array<ArrayBufferLike>): TarEntry {
  const expectedChecksum = parseTarNumber(header.slice(148, 156), 'checksum');
  const checksum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
  if (checksum !== expectedChecksum)
    throw ArchiveOperationError.make({message: 'Release archive contains an invalid tar header checksum.'});
  const name = tarText(header.slice(0, 100));
  const prefix = tarText(header.slice(345, 500));
  const entryPath = prefix ? `${prefix}/${name}` : name;
  const type = String.fromCharCode(header[156] ?? 0);
  if (type !== '\0' && type !== '0' && type !== '5' && type !== 'g' && type !== 'L' && type !== 'x') {
    throw ArchiveOperationError.make({
      message: `Release archive contains unsupported tar entry type ${JSON.stringify(type)}.`,
    });
  }
  return {
    mode: parseTarNumber(header.slice(100, 108), 'mode') & 0o777,
    path: entryPath,
    size: parseTarNumber(header.slice(124, 136), 'size'),
    type:
      type === '5'
        ? 'directory'
        : type === 'g'
          ? 'globalPax'
          : type === 'L'
            ? 'longPath'
            : type === 'x'
              ? 'pax'
              : 'file',
  };
}

function parsePaxMetadata(bytes: Uint8Array<ArrayBufferLike>): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const separator = bytes.indexOf(0x20, offset);
    if (separator < 0)
      throw ArchiveOperationError.make({message: 'Release archive contains malformed PAX metadata length.'});
    const lengthText = new TextDecoder().decode(bytes.slice(offset, separator));
    if (!/^[1-9][0-9]*$/.test(lengthText))
      throw ArchiveOperationError.make({message: 'Release archive contains an invalid PAX record length.'});
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a) {
      throw ArchiveOperationError.make({message: 'Release archive contains a truncated PAX metadata record.'});
    }
    const record = new TextDecoder().decode(bytes.slice(separator + 1, end - 1));
    const equals = record.indexOf('=');
    if (equals <= 0) throw ArchiveOperationError.make({message: 'Release archive contains malformed PAX metadata.'});
    metadata[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return metadata;
}

function mergePaxMetadata(
  current: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {...current};
  for (const [key, value] of Object.entries(incoming)) {
    if (value.length === 0) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function parsePaxSize(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value))
    throw ArchiveOperationError.make({message: 'Release archive contains an invalid PAX size.'});
  const size = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(size) || size < 0)
    throw ArchiveOperationError.make({message: 'Release archive contains an invalid PAX size.'});
  return size;
}

function tarMetadataText(bytes: Uint8Array<ArrayBufferLike>): string {
  const decoded = new TextDecoder().decode(bytes);
  const nullTerminator = decoded.indexOf(String.fromCharCode(0));
  return decoded.slice(0, nullTerminator < 0 ? undefined : nullTerminator).replace(/\n$/, '');
}

function safeArchivePath(path: Path.Path, destination: string, entry: string): string {
  const normalized = entry
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw ArchiveOperationError.make({message: `Release archive contains an unsafe path: ${entry}`});
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw ArchiveOperationError.make({message: `Release archive contains an unsafe path: ${entry}`});
  }
  const root = path.resolve(destination);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw ArchiveOperationError.make({message: `Release archive path escapes its destination: ${entry}`});
  }
  return resolved;
}

function isArchiveRootPath(entry: string): boolean {
  return /^\.\/*$/.test(entry.replaceAll('\\', '/'));
}

function parseTarNumber(bytes: Uint8Array<ArrayBufferLike>, field: string): number {
  const text = tarText(bytes).trim();
  if (!/^[0-7]+$/.test(text))
    throw ArchiveOperationError.make({message: `Release archive has an invalid tar ${field}.`});
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0)
    throw ArchiveOperationError.make({message: `Release archive has an invalid tar ${field}.`});
  return value;
}

function tarText(bytes: Uint8Array<ArrayBufferLike>): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.slice(0, end));
}

function tarPadding(size: number): number {
  return (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function concatenate(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) return right;
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function concatenateAll(chunks: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
