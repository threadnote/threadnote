import * as EffectString from 'effect/String';
import * as Effect from 'effect';
const GIT_INDEX_HEADER_BYTES = 12;
const GIT_INDEX_SIGNATURE = Uint8Array.of(0x44, 0x49, 0x52, 0x43); // DIRC
const GIT_INDEX_ENTRY_STAT_BYTES = 40;
const GIT_INDEX_FLAGS_BYTES = 2;
const GIT_INDEX_OPTIONAL_EXTENSION_HEADER_BYTES = 8;
const GIT_INDEX_SEMANTIC_FLAGS_MASK = 0xf000;
const GIT_INDEX_EXTENDED_FLAG = 0x4000;
const GIT_INDEX_NAME_LENGTH_MASK = 0x0fff;
const GIT_INDEX_NAME_LENGTH_SENTINEL = GIT_INDEX_NAME_LENGTH_MASK;
const GIT_INDEX_SEMANTIC_DIGEST_VERSION = 1;

/**
 * Hash the staged/index semantics without Git's mutable stat and cache data.
 *
 * Unsupported required extensions and malformed indexes return `undefined`,
 * allowing the caller to fail closed to Git's canonical `ls-files` view.
 */
export function codeGraphGitIndexSemanticSha256(
  index: Uint8Array,
  objectFormat: 'sha1' | 'sha256',
  options: {readonly requirePlainWorktreeEntries?: boolean; readonly rejectTrackedIgnoreFiles?: boolean} = {},
): string | undefined {
  const objectIdBytes = objectFormat === 'sha1' ? 20 : 32;
  const checksumBytes = objectIdBytes;
  if (index.byteLength < GIT_INDEX_HEADER_BYTES + checksumBytes) return undefined;
  for (let offset = 0; offset < GIT_INDEX_SIGNATURE.byteLength; offset += 1) {
    if (index[offset] !== GIT_INDEX_SIGNATURE[offset]) return undefined;
  }

  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const version = view.getUint32(4, false);
  if (version !== 2 && version !== 3 && version !== 4) return undefined;
  const entryCount = view.getUint32(8, false);
  const contentEnd = index.byteLength - checksumBytes;
  if (!validGitIndexChecksum(index, contentEnd, objectFormat)) return undefined;

  const digest = new Bun.CryptoHasher('sha256');
  digest.update(`threadnote-git-index-semantic-v${GIT_INDEX_SEMANTIC_DIGEST_VERSION}\0${objectFormat}\0`);
  digest.update(index.subarray(8, 12));
  const canonicalEntry = new Uint8Array(12);
  const canonicalView = new DataView(canonicalEntry.buffer);
  let previousPath: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let offset = GIT_INDEX_HEADER_BYTES;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const entryStart = offset;
    const flagsOffset = entryStart + GIT_INDEX_ENTRY_STAT_BYTES + objectIdBytes;
    if (flagsOffset + GIT_INDEX_FLAGS_BYTES > contentEnd) return undefined;
    const flags = view.getUint16(flagsOffset, false);
    offset = flagsOffset + GIT_INDEX_FLAGS_BYTES;
    let extendedFlags = 0;
    if ((flags & GIT_INDEX_EXTENDED_FLAG) !== 0) {
      if (version === 2 || offset + 2 > contentEnd) return undefined;
      extendedFlags = view.getUint16(offset, false);
      offset += 2;
    }

    if (
      options.requirePlainWorktreeEntries === true &&
      (![0o100644, 0o100755, 0o120000].includes(view.getUint32(entryStart + 24, false)) ||
        (flags & 0xb000) !== 0 ||
        extendedFlags !== 0)
    )
      return undefined;

    let path: Uint8Array<ArrayBufferLike>;
    if (version === 4) {
      const decoded = decodeGitIndexVariableWidthInteger(index, offset, contentEnd);
      if (decoded === undefined || decoded.value > previousPath.byteLength) return undefined;
      offset = decoded.nextOffset;
      const terminator = index.indexOf(0, offset);
      if (terminator < 0 || terminator >= contentEnd) return undefined;
      const suffix = index.subarray(offset, terminator);
      path = new Uint8Array(previousPath.byteLength - decoded.value + suffix.byteLength);
      path.set(previousPath.subarray(0, previousPath.byteLength - decoded.value));
      path.set(suffix, previousPath.byteLength - decoded.value);
      offset = terminator + 1;
    } else {
      const terminator = index.indexOf(0, offset);
      if (terminator < 0 || terminator >= contentEnd) return undefined;
      path = index.subarray(offset, terminator);
      const entryBytes = terminator + 1 - entryStart;
      const paddedEntryBytes = Math.ceil(entryBytes / 8) * 8;
      offset = entryStart + paddedEntryBytes;
      if (offset > contentEnd) return undefined;
      for (let paddingOffset = terminator + 1; paddingOffset < offset; paddingOffset += 1) {
        if (index[paddingOffset] !== 0) return undefined;
      }
    }
    if (options.rejectTrackedIgnoreFiles === true && isGitIgnorePath(path)) return undefined;
    const declaredPathBytes = flags & GIT_INDEX_NAME_LENGTH_MASK;
    if (declaredPathBytes !== GIT_INDEX_NAME_LENGTH_SENTINEL && declaredPathBytes !== path.byteLength) {
      return undefined;
    }

    canonicalEntry.set(index.subarray(entryStart + 24, entryStart + 28), 0);
    canonicalView.setUint16(4, flags & GIT_INDEX_SEMANTIC_FLAGS_MASK, false);
    canonicalView.setUint16(6, extendedFlags, false);
    canonicalView.setUint32(8, path.byteLength, false);
    digest.update(canonicalEntry);
    digest.update(index.subarray(entryStart + GIT_INDEX_ENTRY_STAT_BYTES, flagsOffset));
    digest.update(path);
    previousPath = path;
  }

  while (offset < contentEnd) {
    if (offset + GIT_INDEX_OPTIONAL_EXTENSION_HEADER_BYTES > contentEnd) return undefined;
    const signature = index.subarray(offset, offset + 4);
    const extensionBytes = view.getUint32(offset + 4, false);
    const extensionEnd = offset + GIT_INDEX_OPTIONAL_EXTENSION_HEADER_BYTES + extensionBytes;
    if (extensionEnd > contentEnd) return undefined;
    // Only uppercase signatures are optional. Lowercase signatures are
    // required extensions; split and sparse indexes change entry
    // interpretation. Invalid or required formats deliberately ask Git for
    // the canonical view instead of guessing.
    if (signature[0] < 0x41 || signature[0] > 0x5a) return undefined;
    offset = extensionEnd;
  }
  if (offset !== contentEnd) return undefined;
  return digest.digest('hex');
}

function isGitIgnorePath(path: Uint8Array): boolean {
  const name = '.gitignore';
  const start = path.lastIndexOf(0x2f) + 1;
  if (path.byteLength - start !== name.length) return false;
  for (let index = 0; index < name.length; index += 1)
    if (
      (path[start + index] | 0x20) !==
      Effect.pipe(
        name,
        EffectString.charCodeAt(index),
        Effect.Option.getOrElse(() => NaN),
      )
    )
      return false;
  return true;
}

function validGitIndexChecksum(index: Uint8Array, contentEnd: number, objectFormat: 'sha1' | 'sha256'): boolean {
  const expected = bytesToHex(index.subarray(contentEnd));
  const actual = new Bun.CryptoHasher(objectFormat).update(index.subarray(0, contentEnd)).digest('hex');
  return actual === expected;
}

function decodeGitIndexVariableWidthInteger(
  bytes: Uint8Array,
  start: number,
  end: number,
): {readonly nextOffset: number; readonly value: number} | undefined {
  let offset = start;
  if (offset >= end) return undefined;
  let byte = bytes[offset++];
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= end || value > Math.floor(Number.MAX_SAFE_INTEGER / 128) - 1) return undefined;
    byte = bytes[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return {nextOffset: offset, value};
}

function bytesToHex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += Effect.pipe(byte.toString(16), EffectString.padStart(2, '0'));
  return value;
}
