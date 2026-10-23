import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {codeGraphGitIndexSemanticSha256} from '@threadnote/graph/git/index_semantic';

const SHA1_BYTES = 20;
const REGULAR_FILE_MODE = 0o100644;

describe('Git index semantic fingerprint', () => {
  it('is invariant to arbitrary stat-cache fields while retaining staged semantics', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({max: 0xffff_ffff, min: 0}), {maxLength: 9, minLength: 9}),
        fc.array(fc.integer({max: 0xffff_ffff, min: 0}), {maxLength: 9, minLength: 9}),
        fc.uint8Array({maxLength: SHA1_BYTES, minLength: SHA1_BYTES}),
        fc.array(fc.integer({max: 255, min: 1}), {maxLength: 48, minLength: 1}),
        fc.boolean(),
        fc.integer({max: 3, min: 0}),
        (firstStat, secondStat, objectId, pathValues, assumeValid, stage) => {
          const path = Uint8Array.from(pathValues);
          const semanticFlags = (assumeValid ? 0x8000 : 0) | (stage << 12);
          const first = buildGitIndex(2, [entry(firstStat, objectId, path, semanticFlags)]);
          const second = buildGitIndex(2, [entry(secondStat, objectId, path, semanticFlags)]);
          expect(codeGraphGitIndexSemanticSha256(first, 'sha1')).toBe(codeGraphGitIndexSemanticSha256(second, 'sha1'));

          const changedObjectId = objectId.slice();
          changedObjectId[0] = changedObjectId[0] ^ 1;
          const changed = buildGitIndex(2, [entry(firstStat, changedObjectId, path, semanticFlags)]);
          expect(codeGraphGitIndexSemanticSha256(changed, 'sha1')).not.toBe(
            codeGraphGitIndexSemanticSha256(first, 'sha1'),
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('preserves raw path bytes, extended flags, and v4 prefix-compressed paths', () => {
    const stat = Array.from({length: 9}, () => 0);
    const objectId = Uint8Array.from({length: SHA1_BYTES}, (_, index) => index);
    const invalidUtf8A = buildGitIndex(2, [entry(stat, objectId, Uint8Array.of(0x80), 0)]);
    const invalidUtf8B = buildGitIndex(2, [entry(stat, objectId, Uint8Array.of(0x81), 0)]);
    expect(codeGraphGitIndexSemanticSha256(invalidUtf8A, 'sha1')).not.toBe(
      codeGraphGitIndexSemanticSha256(invalidUtf8B, 'sha1'),
    );

    const ordinary = buildGitIndex(3, [entry(stat, objectId, new TextEncoder().encode('src/index.ts'), 0)]);
    const skipWorktree = buildGitIndex(3, [entry(stat, objectId, new TextEncoder().encode('src/index.ts'), 0, 0x4000)]);
    expect(codeGraphGitIndexSemanticSha256(ordinary, 'sha1')).not.toBe(
      codeGraphGitIndexSemanticSha256(skipWorktree, 'sha1'),
    );

    const v4 = buildGitIndex(4, [
      entry(stat, objectId, new TextEncoder().encode('src/a.ts'), 0),
      entry(stat, objectId, new TextEncoder().encode('src/b.ts'), 0),
      entry(stat, objectId, new TextEncoder().encode(`other/${'x'.repeat(180)}.ts`), 0),
    ]);
    expect(codeGraphGitIndexSemanticSha256(v4, 'sha1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects every case spelling of tracked ignore basenames without changing ordinary digest semantics', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(2 as const, 3 as const, 4 as const),
        fc.array(fc.constantFrom('scope', 'scope with spaces', 'line\nbreak', 'é'), {maxLength: 4}),
        fc.array(fc.boolean(), {minLength: 10, maxLength: 10}),
        (version, directories, uppercase) => {
          const name = [...'.gitignore']
            .map((letter, index) => (uppercase[index] ? letter.toUpperCase() : letter))
            .join('');
          const prefix = directories.length ? directories.join('/') + '/' : '';
          const stat = Array.from({length: 9}, () => 0);
          const objectId = new Uint8Array(SHA1_BYTES).fill(7);
          const bytes = (path: string) =>
            buildGitIndex(version, [
              entry(stat, objectId, new TextEncoder().encode(prefix + 'marker.txt'), 0),
              entry(stat, objectId, new TextEncoder().encode(path), 0),
            ]);
          const ignored = bytes(prefix + name);
          expect(codeGraphGitIndexSemanticSha256(ignored, 'sha1')).toMatch(/^[0-9a-f]{64}$/);
          expect(codeGraphGitIndexSemanticSha256(ignored, 'sha1', {rejectTrackedIgnoreFiles: true})).toBeUndefined();
          for (const path of [prefix + name + '.backup', prefix + 'prefix-' + name, prefix + name + '/source.ts']) {
            const ordinary = bytes(path);
            expect(codeGraphGitIndexSemanticSha256(ordinary, 'sha1', {rejectTrackedIgnoreFiles: true})).toBe(
              codeGraphGitIndexSemanticSha256(ordinary, 'sha1'),
            );
          }
        },
      ),
      {numRuns: 50},
    );
  });

  it('ignores optional cache extensions and rejects required or corrupt input', () => {
    const stat = Array.from({length: 9}, () => 0);
    const objectId = new Uint8Array(SHA1_BYTES).fill(7);
    const base = [entry(stat, objectId, new TextEncoder().encode('src/index.ts'), 0)] as const;
    const plain = buildGitIndex(2, base);
    const cached = buildGitIndex(2, base, {data: Uint8Array.of(1, 2, 3), signature: 'TREE'});
    expect(codeGraphGitIndexSemanticSha256(cached, 'sha1')).toBe(codeGraphGitIndexSemanticSha256(plain, 'sha1'));
    expect(
      codeGraphGitIndexSemanticSha256(buildGitIndex(2, base, {data: Uint8Array.of(1), signature: 'link'}), 'sha1'),
    ).toBeUndefined();
    expect(
      codeGraphGitIndexSemanticSha256(buildGitIndex(2, base, {data: Uint8Array.of(1), signature: '1BAD'}), 'sha1'),
    ).toBeUndefined();

    const corrupt = plain.slice();
    corrupt[12] = corrupt[12] ^ 1;
    expect(codeGraphGitIndexSemanticSha256(corrupt, 'sha1')).toBeUndefined();
  });
});

interface TestEntry {
  readonly extendedFlags: number;
  readonly flags: number;
  readonly mode: number;
  readonly objectId: Uint8Array;
  readonly path: Uint8Array;
  readonly stat: readonly number[];
}

function entry(
  stat: readonly number[],
  objectId: Uint8Array,
  path: Uint8Array,
  flags: number,
  extendedFlags = 0,
): TestEntry {
  return {extendedFlags, flags, mode: REGULAR_FILE_MODE, objectId, path, stat};
}

function buildGitIndex(
  version: 2 | 3 | 4,
  entries: readonly TestEntry[],
  extension?: {readonly data: Uint8Array; readonly signature: string},
): Uint8Array {
  const encodedEntries: Uint8Array[] = [];
  let previousPath: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (const current of entries) {
    const hasExtendedFlags = current.extendedFlags !== 0;
    const fixedBytes = 40 + SHA1_BYTES + 2 + (hasExtendedFlags ? 2 : 0);
    let pathPrefix: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let pathSuffix = current.path;
    if (version === 4) {
      let common = 0;
      while (
        common < previousPath.byteLength &&
        common < current.path.byteLength &&
        previousPath[common] === current.path[common]
      ) {
        common += 1;
      }
      const removed = previousPath.byteLength - common;
      pathPrefix = encodeGitIndexVariableWidthInteger(removed);
      pathSuffix = current.path.subarray(common);
    }
    const unpaddedBytes = fixedBytes + pathPrefix.byteLength + pathSuffix.byteLength + 1;
    const entryBytes = version === 4 ? unpaddedBytes : Math.ceil(unpaddedBytes / 8) * 8;
    const encoded = new Uint8Array(entryBytes);
    const view = new DataView(encoded.buffer);
    const statOffsets = [0, 4, 8, 12, 16, 20, 28, 32, 36] as const;
    statOffsets.forEach((offset, index) => view.setUint32(offset, current.stat[index] ?? 0, false));
    view.setUint32(24, current.mode, false);
    encoded.set(current.objectId, 40);
    let offset = 40 + SHA1_BYTES;
    view.setUint16(
      offset,
      current.flags | (hasExtendedFlags ? 0x4000 : 0) | Math.min(current.path.byteLength, 0x0fff),
      false,
    );
    offset += 2;
    if (hasExtendedFlags) {
      view.setUint16(offset, current.extendedFlags, false);
      offset += 2;
    }
    encoded.set(pathPrefix, offset);
    offset += pathPrefix.byteLength;
    encoded.set(pathSuffix, offset);
    encodedEntries.push(encoded);
    previousPath = current.path;
  }

  const extensionBytes = extension === undefined ? 0 : 8 + extension.data.byteLength;
  const contentBytes = 12 + encodedEntries.reduce((sum, value) => sum + value.byteLength, 0) + extensionBytes;
  const index = new Uint8Array(contentBytes + SHA1_BYTES);
  index.set(new TextEncoder().encode('DIRC'));
  const view = new DataView(index.buffer);
  view.setUint32(4, version, false);
  view.setUint32(8, entries.length, false);
  let offset = 12;
  for (const encoded of encodedEntries) {
    index.set(encoded, offset);
    offset += encoded.byteLength;
  }
  if (extension !== undefined) {
    index.set(new TextEncoder().encode(extension.signature), offset);
    view.setUint32(offset + 4, extension.data.byteLength, false);
    index.set(extension.data, offset + 8);
  }
  index.set(new Bun.CryptoHasher('sha1').update(index.subarray(0, contentBytes)).digest(), contentBytes);
  return index;
}

function encodeGitIndexVariableWidthInteger(value: number): Uint8Array {
  const encoded = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    remaining -= 1;
    encoded.push(0x80 | (remaining & 0x7f));
    remaining = Math.floor(remaining / 128);
  }
  encoded.reverse();
  return Uint8Array.from(encoded);
}
