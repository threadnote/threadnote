import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {Array as EffectArray, Schema} from 'effect';
import {
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  MachOCodeIdentityError,
  machoCodeDigest,
  machoCodeSignature,
  machoSignaturePolicyViolations,
  machoUnsignedOrigin,
} from '../macho-code-identity.js';

/**
 * Synthetic thin Mach-O executables built in memory: header, `__TEXT`, `__LINKEDIT` with a symbol table, and an
 * optional embedded signature whose CodeDirectory hashes the real pages. Runs on any OS.
 */
const sha = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const TEXT = 2 * 4096;
const LINKEDIT = 48;

interface Unsigned {
  readonly bytes: Uint8Array;
  readonly linkedit: number;
  readonly commandsEnd: number;
}
function unsignedImage(options: {cputype?: number; extraCommand?: number; seed?: number} = {}): Unsigned {
  const bytes = new Uint8Array(TEXT + LINKEDIT);
  for (let index = 512; index < TEXT; index += 1) bytes[index] = (index * 31 + (options.seed ?? 7)) & 0xff;
  const data = new DataView(bytes.buffer);
  let offset = 32;
  const segment = (name: string, fileoff: number, filesize: number) => {
    data.setUint32(offset, 0x19, true);
    data.setUint32(offset + 4, 72, true);
    bytes.set(new TextEncoder().encode(name), offset + 8);
    data.setBigUint64(offset + 32, BigInt(filesize), true);
    data.setBigUint64(offset + 40, BigInt(fileoff), true);
    data.setBigUint64(offset + 48, BigInt(filesize), true);
    const at = offset;
    offset += 72;
    return at;
  };
  segment('__TEXT', 0, TEXT);
  const linkedit = segment('__LINKEDIT', TEXT, LINKEDIT);
  data.setUint32(offset, 0x2, true); // LC_SYMTAB: one nlist_64 and a 32-byte string table
  data.setUint32(offset + 4, 24, true);
  data.setUint32(offset + 8, TEXT, true);
  data.setUint32(offset + 12, 1, true);
  data.setUint32(offset + 16, TEXT + 16, true);
  data.setUint32(offset + 20, 32, true);
  offset += 24;
  let ncmds = 3;
  if (options.extraCommand !== undefined) {
    data.setUint32(offset, options.extraCommand, true);
    data.setUint32(offset + 4, 16, true);
    offset += 16;
    ncmds += 1;
  }
  data.setUint32(0, 0xfeedfacf, true);
  data.setUint32(4, options.cputype ?? CPU_TYPE_ARM64, true);
  data.setUint32(12, 2, true);
  data.setUint32(16, ncmds, true);
  data.setUint32(20, offset - 32, true);
  return {bytes, linkedit, commandsEnd: offset};
}

interface SignOptions {
  readonly identifier?: string;
  readonly pageSize?: number;
  readonly flags?: number;
  readonly execSegFlags?: bigint;
  readonly vmsizeRounding?: number;
  readonly extraSlots?: readonly number[];
  readonly entitlementHash?: boolean;
}
const blobOf = (magic: number, body = new Uint8Array(0)) => {
  const blob = new Uint8Array(8 + body.byteLength);
  new DataView(blob.buffer).setUint32(0, magic);
  new DataView(blob.buffer).setUint32(4, blob.byteLength);
  blob.set(body, 8);
  return blob;
};
/** Embed a signature the way codesign does: a last LC_CODE_SIGNATURE and a superblob at the 16-aligned EOF. */
function sign(image: Unsigned, options: SignOptions = {}): Uint8Array {
  const pageSize = options.pageSize ?? 4096;
  const identifier = new TextEncoder().encode(`${options.identifier ?? 'dev.threadnote.typescript-native'}\0`);
  const dataoff = Math.ceil(image.bytes.byteLength / 16) * 16;
  const nCodeSlots = Math.ceil(dataoff / pageSize);
  const nSpecial = options.entitlementHash ? 5 : 2;
  const identOffset = 96;
  const hashOffset = identOffset + identifier.byteLength + nSpecial * 32;
  const cdLength = hashOffset + nCodeSlots * 32;
  const requirements = blobOf(0xfade0c01, new Uint8Array(4));
  const cms = blobOf(0xfade0b01);
  // An alternate CodeDirectory slot (0x1000-0x1fff) copies the primary one; any other extra slot is a small blob.
  const extras = EffectArray.map(options.extraSlots ?? [], type => ({
    type,
    blob: type >= 0x1000 && type < 0x2000 ? new Uint8Array(cdLength) : blobOf(0xfade7171, new Uint8Array(8)),
  }));
  const count = 3 + extras.length;
  let extraBytes = 0;
  for (const extra of extras) extraBytes += extra.blob.byteLength;
  const superLength = 12 + count * 8 + cdLength + requirements.byteLength + cms.byteLength + extraBytes;
  const signed = new Uint8Array(dataoff + superLength);
  signed.set(image.bytes);
  const data = new DataView(signed.buffer);
  data.setUint32(16, data.getUint32(16, true) + 1, true);
  data.setUint32(20, data.getUint32(20, true) + 16, true);
  data.setUint32(image.commandsEnd, 0x1d, true);
  data.setUint32(image.commandsEnd + 4, 16, true);
  data.setUint32(image.commandsEnd + 8, dataoff, true);
  data.setUint32(image.commandsEnd + 12, superLength, true);
  const filesize = BigInt(signed.byteLength - TEXT);
  const rounding = BigInt(options.vmsizeRounding ?? 0x4000);
  data.setBigUint64(image.linkedit + 48, filesize, true);
  data.setBigUint64(image.linkedit + 32, (filesize + rounding - 1n) & ~(rounding - 1n), true);
  const cd = new Uint8Array(cdLength);
  const view = new DataView(cd.buffer);
  view.setUint32(0, 0xfade0c02);
  view.setUint32(4, cdLength);
  view.setUint32(8, 0x20500);
  view.setUint32(12, options.flags ?? 0x10302);
  view.setUint32(16, hashOffset);
  view.setUint32(20, identOffset);
  view.setUint32(24, nSpecial);
  view.setUint32(28, nCodeSlots);
  view.setUint32(32, dataoff);
  view.setUint8(36, 32);
  view.setUint8(37, 2);
  view.setUint8(39, Math.log2(pageSize));
  view.setBigUint64(72, BigInt(TEXT));
  view.setBigUint64(80, options.execSegFlags ?? 1n);
  cd.set(identifier, identOffset);
  cd.set(sha(requirements), hashOffset - 2 * 32);
  if (options.entitlementHash) cd.set(sha(new Uint8Array([1])), hashOffset - 5 * 32);
  for (let page = 0; page < nCodeSlots; page += 1)
    cd.set(sha(signed.subarray(page * pageSize, Math.min(dataoff, (page + 1) * pageSize))), hashOffset + page * 32);
  for (const extra of extras) if (extra.blob.byteLength === cdLength) extra.blob.set(cd);
  const entries = [{type: 0, blob: cd}, {type: 2, blob: requirements}, ...extras, {type: 0x10000, blob: cms}];
  data.setUint32(dataoff, 0xfade0cc0);
  data.setUint32(dataoff + 4, superLength);
  data.setUint32(dataoff + 8, count);
  let at = 12 + count * 8;
  for (const [index, {type, blob}] of entries.entries()) {
    data.setUint32(dataoff + 12 + index * 8, type);
    data.setUint32(dataoff + 16 + index * 8, at);
    signed.set(blob, dataoff + at);
    at += blob.byteLength;
  }
  return signed;
}
const refusal = (run: () => unknown): readonly string[] => {
  try {
    run();
  } catch (error) {
    if (Schema.is(MachOCodeIdentityError)(error)) return error.violations;
    throw error;
  }
  return [];
};
const policy = {identifier: 'dev.threadnote.typescript-native', requireRuntime: true};

describe('macho-code-v1 canonical digest', () => {
  it('does not change across signature identity, page size or __LINKEDIT rounding, and changes with any code byte', () => {
    const image = unsignedImage();
    const digest = machoCodeDigest(sign(image), CPU_TYPE_ARM64);
    for (const options of [{identifier: 'other'}, {pageSize: 16384}, {vmsizeRounding: 0x1000}, {vmsizeRounding: 1}])
      expect(machoCodeDigest(sign(image, options), CPU_TYPE_ARM64)).toEqual(digest);
    expect(digest.codeLimit).toBe(TEXT + LINKEDIT);
    for (const offset of [24, 600, TEXT - 1, TEXT + 4]) {
      const changed = sign(image);
      changed[offset] ^= 1;
      expect(machoCodeDigest(changed, CPU_TYPE_ARM64).sha256, String(offset)).not.toBe(digest.sha256);
    }
  });

  it('refuses inputs outside the canonical layout', () => {
    const image = unsignedImage();
    const signed = sign(image);
    const fat = signed.slice();
    new DataView(fat.buffer).setUint32(0, 0xbebafeca, true);
    expect(refusal(() => machoCodeDigest(fat, CPU_TYPE_ARM64))).toEqual(['not a thin MH_MAGIC_64 image']);
    expect(refusal(() => machoCodeDigest(signed, CPU_TYPE_X86_64))).toEqual(['cputype']);
    expect(refusal(() => machoCodeDigest(image.bytes, CPU_TYPE_ARM64))).toEqual(['no LC_CODE_SIGNATURE']);
    const trailing = new Uint8Array(signed.byteLength + 1);
    trailing.set(signed);
    expect(refusal(() => machoCodeDigest(trailing, CPU_TYPE_ARM64))).toEqual(['__LINKEDIT does not end at EOF']);
    const vmsize = signed.slice();
    new DataView(vmsize.buffer).setBigUint64(image.linkedit + 32, 3n, true);
    expect(refusal(() => machoCodeDigest(vmsize, CPU_TYPE_ARM64))).toEqual(['__LINKEDIT.vmsize']);
    expect(refusal(() => machoCodeDigest(sign(unsignedImage({extraCommand: 0x7})), CPU_TYPE_ARM64))).toEqual([
      'unknown load command 0x7',
    ]);
    // A second LC_CODE_SIGNATURE in the command area.
    const twice = sign(unsignedImage({extraCommand: 0x1d}));
    expect(refusal(() => machoCodeDigest(twice, CPU_TYPE_ARM64))).toEqual(['more than one LC_CODE_SIGNATURE']);
  });

  it('refuses a signature command that is not the last load command', () => {
    const image = unsignedImage({extraCommand: 0x1b}); // LC_UUID after LC_SYMTAB
    const signed = sign(image);
    const data = new DataView(signed.buffer);
    // Swap the trailing LC_UUID and LC_CODE_SIGNATURE (both 16 bytes).
    const uuid = signed.slice(image.commandsEnd - 16, image.commandsEnd);
    signed.copyWithin(image.commandsEnd - 16, image.commandsEnd, image.commandsEnd + 16);
    signed.set(uuid, image.commandsEnd);
    expect(data.getUint32(image.commandsEnd - 16, true)).toBe(0x1d);
    expect(refusal(() => machoCodeDigest(signed, CPU_TYPE_ARM64))).toEqual([
      'LC_CODE_SIGNATURE is not the last load command',
    ]);
  });
});

describe('unsigned-origin-v1', () => {
  it('restores the exact unsigned bytes of an x64 image after a signature was added', () => {
    const image = unsignedImage({cputype: CPU_TYPE_X86_64});
    for (const options of [{}, {pageSize: 16384}, {identifier: 'other', vmsizeRounding: 0x1000}])
      expect(machoUnsignedOrigin(sign(image, options), CPU_TYPE_X86_64)).toEqual(image.bytes);
    const changed = sign(image);
    changed[TEXT - 8] ^= 1;
    expect(machoUnsignedOrigin(changed, CPU_TYPE_X86_64)).not.toEqual(image.bytes);
  });
});

describe('embedded signature', () => {
  it('derives the cdhash and identity and passes the release policy', () => {
    const signed = sign(unsignedImage());
    const signature = machoCodeSignature(signed, CPU_TYPE_ARM64);
    expect(signature).toMatchObject({
      identifier: 'dev.threadnote.typescript-native',
      flags: 0x10302,
      pageSize: 4096,
      codeDirectories: 1,
      slots: [0, 2, 0x10000],
      violations: [],
    });
    const dataoff = TEXT + LINKEDIT;
    const cdOffset = new DataView(signed.buffer).getUint32(dataoff + 16);
    const cdLength = new DataView(signed.buffer).getUint32(dataoff + cdOffset + 4);
    const cd = signed.subarray(dataoff + cdOffset, dataoff + cdOffset + cdLength);
    expect(signature.cdhash).toBe(Buffer.from(sha(cd).subarray(0, 20)).toString('hex'));
    expect(machoSignaturePolicyViolations(signature, policy)).toEqual([]);
  });

  it('reports every policy violation', () => {
    const violations = (options: SignOptions, image = unsignedImage()) =>
      machoSignaturePolicyViolations(machoCodeSignature(sign(image, options), CPU_TYPE_ARM64), policy);
    expect(violations({extraSlots: [5]})).toContain('forbidden superblob slot 0x5');
    expect(violations({extraSlots: [7]})).toContain('forbidden superblob slot 0x7');
    expect(violations({entitlementHash: true})).toContain('special slot -5 hashes an absent blob');
    const alternate = violations({extraSlots: [0x1000]});
    expect(alternate).toContain('forbidden superblob slot 0x1000');
    expect(alternate).toContain('expected one CodeDirectory, found 2');
    expect(violations({execSegFlags: 0x11n})).toEqual(['execSegFlags 0x11']);
    expect(violations({flags: 0x2})).toEqual([
      'hardened runtime flag is not set',
      'kill flag is not set',
      'hard flag is not set',
    ]);
    expect(violations({flags: 0x10002})).toEqual(['kill flag is not set', 'hard flag is not set']);
    expect(violations({flags: 0x10b02})).toEqual(['CodeDirectory flags 0x10b02']);
    expect(violations({identifier: 'a.out'})).toEqual(['identifier "a.out" is not "dev.threadnote.typescript-native"']);
    const tampered = sign(unsignedImage());
    tampered[TEXT - 100] ^= 1;
    expect(machoCodeSignature(tampered, CPU_TYPE_ARM64).violations).toEqual(['1 page hashes differ from the file']);
  });

  it('refuses a __LINKEDIT reference that crosses the code limit and an out-of-bounds superblob', () => {
    const image = unsignedImage();
    const reaching = unsignedImage();
    new DataView(reaching.bytes.buffer).setUint32(32 + 72 + 72 + 20, 64, true); // strsize reaches into the signature
    const crossing = sign(reaching);
    expect(machoCodeSignature(crossing, CPU_TYPE_ARM64).violations).toEqual([
      `__LINKEDIT reference [${TEXT + 16}, ${TEXT + 80}) crosses the code limit ${TEXT + LINKEDIT}`,
    ]);
    const outOfBounds = sign(image);
    new DataView(outOfBounds.buffer).setUint32(TEXT + LINKEDIT + 16, 0xffff_0000);
    expect(refusal(() => machoCodeSignature(outOfBounds, CPU_TYPE_ARM64))).toEqual(['superblob index bounds']);
  });
});
