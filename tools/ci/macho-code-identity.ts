/**
 * Publish-only Mach-O code identity for the signed private native TypeScript compiler. This is release tooling: the
 * product never ships or imports it. It is pure and bounded, and it runs on any OS.
 *
 * Two canonical forms bind a Developer ID signed `tsc` to its reviewed construction bytes:
 * - `macho-code-v1` (arm64, whose reviewed binary is linker-signed): SHA-256 of `[0, dataoff)` after
 *   `__LINKEDIT.vmsize`, `__LINKEDIT.filesize` and `LC_CODE_SIGNATURE.datasize` are set to zero.
 * - `unsigned-origin-v1` (x64, whose reviewed binary is unsigned): the exact reviewed bytes, restored by removing the
 *   added `LC_CODE_SIGNATURE`, restoring `ncmds` and `sizeofcmds`, truncating at `dataoff` and restoring `__LINKEDIT`
 *   to the unaligned Go linker layout (`filesize = dataoff - fileoff`, `vmsize = filesize`).
 *
 * The signature parser reads the embedded superblob and CodeDirectory, recomputes every page hash and derives the
 * cdhash. Policy checks report every violation, so the publish step fails closed with a complete reason list.
 */
import {createHash} from 'node:crypto';
import {Array as EffectArray, Schema} from 'effect';
import * as EffectString from 'effect/String';

export const MACHO_MAXIMUM_BYTES = 256 * 1_048_576;
export const CPU_TYPE_ARM64 = 0x0100000c;
export const CPU_TYPE_X86_64 = 0x01000007;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_EXECUTE = 2;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_CODE_SIGNATURE = 0x1d;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
/** `linkedit_data_command` kinds: one `(dataoff, datasize)` pair each. */
const LINKEDIT_DATA_COMMANDS = new Set([
  0x1e, // LC_SEGMENT_SPLIT_INFO
  0x26, // LC_FUNCTION_STARTS
  0x29, // LC_DATA_IN_CODE
  0x2b, // LC_DYLIB_CODE_SIGN_DRS
  0x2e, // LC_LINKER_OPTIMIZATION_HINT
  0x36, // LC_ATOM_INFO
  0x80000033, // LC_DYLD_EXPORTS_TRIE
  0x80000034, // LC_DYLD_CHAINED_FIXUPS
]);
/** Commands that carry no file data reference. Any command outside the known set is refused. */
const PLAIN_COMMANDS = new Set([
  0x5, // LC_UNIXTHREAD
  0xc, // LC_LOAD_DYLIB
  0xe, // LC_LOAD_DYLINKER
  0x1b, // LC_UUID
  0x24, // LC_VERSION_MIN_MACOSX
  0x2a, // LC_SOURCE_VERSION
  0x32, // LC_BUILD_VERSION
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001c, // LC_RPATH
  0x8000001f, // LC_REEXPORT_DYLIB
  0x80000028, // LC_MAIN
]);

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSMAGIC_REQUIREMENTS = 0xfade0c01;
const CSMAGIC_BLOBWRAPPER = 0xfade0b01;
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_REQUIREMENTS = 2;
const CSSLOT_SIGNATURESLOT = 0x10000;
const CS_HASHTYPE_SHA256 = 2;
export const CS_ADHOC = 0x2;
export const CS_HARD = 0x100;
export const CS_KILL = 0x200;
export const CS_RUNTIME = 0x10000;
export const CS_LINKER_SIGNED = 0x20000;
const CS_EXECSEG_MAIN_BINARY = 0x1n;

/** Every reason a Mach-O image was refused; the message lists them all. */
export class MachOCodeIdentityError extends Schema.TaggedError<
  MachOCodeIdentityError,
  {readonly brand: unique symbol}
>()('MachOCodeIdentityError', {violations: Schema.Array(Schema.String), message: Schema.String}) {}
export const machoCodeIdentityError = (violations: readonly string[]): MachOCodeIdentityError =>
  MachOCodeIdentityError.make({
    violations,
    message: `Mach-O code identity refused: ${EffectArray.join(violations, '; ')}`,
  });
const refuse = (reason: string): never => {
  throw machoCodeIdentityError([reason]);
};

export interface MachOSegment {
  readonly offset: number;
  readonly name: string;
  readonly vmsize: bigint;
  readonly fileoff: bigint;
  readonly filesize: bigint;
}
export interface MachOLayout {
  readonly cputype: number;
  readonly ncmds: number;
  readonly sizeofcmds: number;
  readonly segments: readonly MachOSegment[];
  readonly linkedit: MachOSegment;
  /** `[start, end)` file ranges referenced by `__LINKEDIT` data commands. */
  readonly linkeditReferences: readonly (readonly [number, number])[];
  readonly signature?: {
    readonly offset: number;
    readonly cmdsize: number;
    readonly index: number;
    readonly dataoff: number;
    readonly datasize: number;
  };
}

const ascii = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  return new TextDecoder('latin1').decode(end < 0 ? bytes : bytes.subarray(0, end));
};
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Parse one thin 64-bit `MH_EXECUTE` of `cputype`. Refuses fat, foreign, malformed or unknown-command input. */
export function parseMachOLayout(bytes: Uint8Array, cputype: number): MachOLayout {
  if (bytes.byteLength < 32 || bytes.byteLength > MACHO_MAXIMUM_BYTES) refuse('size');
  const data = view(bytes);
  if (data.getUint32(0, true) !== MH_MAGIC_64) refuse('not a thin MH_MAGIC_64 image');
  if (data.getUint32(4, true) !== cputype) refuse('cputype');
  if (data.getUint32(12, true) !== MH_EXECUTE) refuse('filetype');
  const ncmds = data.getUint32(16, true);
  const sizeofcmds = data.getUint32(20, true);
  const commandsEnd = 32 + sizeofcmds;
  if (ncmds === 0 || ncmds > 512 || commandsEnd > bytes.byteLength) refuse('load command bounds');
  const segments: MachOSegment[] = [];
  const references: (readonly [number, number])[] = [];
  let signature: MachOLayout['signature'];
  const reference = (offset: number, size: number) => {
    if (size > 0) references.push([offset, offset + size]);
  };
  let offset = 32;
  for (let index = 0; index < ncmds; index += 1) {
    if (offset + 8 > commandsEnd) refuse('load command bounds');
    const cmd = data.getUint32(offset, true);
    const cmdsize = data.getUint32(offset + 4, true);
    if (cmdsize < 8 || cmdsize % 8 !== 0 || offset + cmdsize > commandsEnd) refuse('load command size');
    if (cmd === LC_SEGMENT_64) {
      if (cmdsize < 72) refuse('segment command size');
      segments.push({
        offset,
        name: ascii(bytes.subarray(offset + 8, offset + 24)),
        vmsize: data.getBigUint64(offset + 32, true),
        fileoff: data.getBigUint64(offset + 40, true),
        filesize: data.getBigUint64(offset + 48, true),
      });
    } else if (cmd === LC_CODE_SIGNATURE) {
      if (signature) refuse('more than one LC_CODE_SIGNATURE');
      if (cmdsize !== 16) refuse('LC_CODE_SIGNATURE size');
      signature = {
        offset,
        cmdsize,
        index,
        dataoff: data.getUint32(offset + 8, true),
        datasize: data.getUint32(offset + 12, true),
      };
    } else if (cmd === LC_SYMTAB) {
      if (cmdsize !== 24) refuse('LC_SYMTAB size');
      reference(data.getUint32(offset + 8, true), data.getUint32(offset + 12, true) * 16);
      reference(data.getUint32(offset + 16, true), data.getUint32(offset + 20, true));
    } else if (cmd === LC_DYSYMTAB) {
      if (cmdsize !== 80) refuse('LC_DYSYMTAB size');
      // [offset field, count field, entry size]: TOC, module table, external refs, indirect symbols, relocations.
      for (const [at, count, size] of [
        [32, 36, 8],
        [40, 44, 56],
        [48, 52, 4],
        [56, 60, 4],
        [64, 68, 8],
        [72, 76, 8],
      ] as const)
        reference(data.getUint32(offset + at, true), data.getUint32(offset + count, true) * size);
    } else if (cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) {
      if (cmdsize !== 48) refuse('LC_DYLD_INFO size');
      for (let field = 8; field < 48; field += 8)
        reference(data.getUint32(offset + field, true), data.getUint32(offset + field + 4, true));
    } else if (LINKEDIT_DATA_COMMANDS.has(cmd)) {
      if (cmdsize !== 16) refuse('linkedit data command size');
      reference(data.getUint32(offset + 8, true), data.getUint32(offset + 12, true));
    } else if (!PLAIN_COMMANDS.has(cmd)) refuse(`unknown load command 0x${cmd.toString(16)}`);
    offset += cmdsize;
  }
  if (offset !== commandsEnd) refuse('sizeofcmds');
  const linkedits = EffectArray.filter(segments, segment => segment.name === '__LINKEDIT');
  if (linkedits.length !== 1) refuse('__LINKEDIT');
  const linkedit = linkedits[0];
  const fileLength = BigInt(bytes.byteLength);
  for (const segment of segments) {
    if (segment.fileoff + segment.filesize > fileLength) refuse(`segment ${segment.name} beyond EOF`);
    if (segment !== linkedit && segment.filesize > 0n && segment.fileoff + segment.filesize > linkedit.fileoff)
      refuse(`segment ${segment.name} overlaps __LINKEDIT`);
  }
  if (linkedit.fileoff + linkedit.filesize !== fileLength) refuse('__LINKEDIT does not end at EOF');
  for (const [start, end] of references)
    if (BigInt(start) < linkedit.fileoff || BigInt(end) > fileLength) refuse('__LINKEDIT reference bounds');
  return {
    cputype,
    ncmds,
    sizeofcmds,
    segments,
    linkedit,
    linkeditReferences: references,
    ...(signature ? {signature} : {}),
  };
}

type SignedLayout = MachOLayout & {readonly signature: NonNullable<MachOLayout['signature']>};
/** §4.1 layout rules shared by both canonical forms; the signature is the last command and the file tail. */
function signedLayout(bytes: Uint8Array, layout: MachOLayout): SignedLayout {
  const {signature, linkedit} = layout;
  if (!signature) return refuse('no LC_CODE_SIGNATURE');
  if (signature.index !== layout.ncmds - 1) refuse('LC_CODE_SIGNATURE is not the last load command');
  if (signature.dataoff % 16 !== 0 || BigInt(signature.dataoff) < linkedit.fileoff) refuse('dataoff');
  if (signature.dataoff + signature.datasize !== bytes.byteLength) refuse('signature does not end at EOF');
  const filesize = linkedit.filesize;
  const allowed = [filesize, (filesize + 0xfffn) & ~0xfffn, (filesize + 0x3fffn) & ~0x3fffn];
  if (!EffectArray.contains(allowed, linkedit.vmsize)) refuse('__LINKEDIT.vmsize');
  return {...layout, signature};
}

/** Every `__LINKEDIT` data reference must end at or before the code limit: no linker data inside the signature. */
export function linkeditReferenceViolations(layout: MachOLayout, codeLimit: number): readonly string[] {
  return EffectArray.flatMap(layout.linkeditReferences, ([start, end]) =>
    end > codeLimit ? [`__LINKEDIT reference [${start}, ${end}) crosses the code limit ${codeLimit}`] : [],
  );
}

/** `macho-code-v1`: signature-independent digest of a signed image. */
export function machoCodeDigest(
  bytes: Uint8Array,
  cputype: number,
): {readonly codeLimit: number; readonly sha256: string} {
  const layout = signedLayout(bytes, parseMachOLayout(bytes, cputype));
  const canonical = bytes.slice(0, layout.signature.dataoff);
  const data = view(canonical);
  data.setUint32(layout.signature.offset + 12, 0, true);
  data.setBigUint64(layout.linkedit.offset + 32, 0n, true);
  data.setBigUint64(layout.linkedit.offset + 48, 0n, true);
  return {codeLimit: layout.signature.dataoff, sha256: hex(sha256(canonical))};
}

/** `unsigned-origin-v1`: the exact unsigned bytes a signature was added to. */
export function machoUnsignedOrigin(bytes: Uint8Array, cputype: number): Uint8Array {
  const layout = signedLayout(bytes, parseMachOLayout(bytes, cputype));
  const origin = bytes.slice(0, layout.signature.dataoff);
  const data = view(origin);
  data.setUint32(16, layout.ncmds - 1, true);
  data.setUint32(20, layout.sizeofcmds - layout.signature.cmdsize, true);
  origin.fill(0, layout.signature.offset, layout.signature.offset + layout.signature.cmdsize);
  const filesize = BigInt(layout.signature.dataoff) - layout.linkedit.fileoff;
  data.setBigUint64(layout.linkedit.offset + 48, filesize, true);
  data.setBigUint64(layout.linkedit.offset + 32, filesize, true);
  return origin;
}

export interface MachOCodeSignature {
  readonly codeLimit: number;
  readonly cdhash: string;
  readonly identifier: string;
  readonly teamIdentifier: string | undefined;
  readonly version: number;
  readonly flags: number;
  readonly pageSize: number;
  readonly hashType: number;
  readonly hashSize: number;
  readonly platform: number;
  readonly nCodeSlots: number;
  readonly execSegFlags: bigint;
  readonly codeDirectories: number;
  /** Superblob slot types in index order. */
  readonly slots: readonly number[];
  /** Violations found while parsing: bounds, bindings and page hashes. Policy checks add more. */
  readonly violations: readonly string[];
}

/** Parse the embedded signature and check its structure, its special-slot bindings and every page hash. */
export function machoCodeSignature(bytes: Uint8Array, cputype: number): MachOCodeSignature {
  const layout = signedLayout(bytes, parseMachOLayout(bytes, cputype));
  const {dataoff, datasize} = layout.signature;
  const violations: string[] = [...linkeditReferenceViolations(layout, dataoff)];
  const blob = bytes.subarray(dataoff, dataoff + datasize);
  const data = view(blob);
  if (blob.byteLength < 12 || data.getUint32(0) !== CSMAGIC_EMBEDDED_SIGNATURE) refuse('superblob magic');
  const length = data.getUint32(4);
  const count = data.getUint32(8);
  if (length > datasize || count === 0 || count > 32 || 12 + count * 8 > length) refuse('superblob bounds');
  // codesign can leave stale bytes in the reserved space after the superblob. No CodeDirectory, page hash or kernel
  // check covers that slack; the exact signed SHA-256 that publish compiles into the outer binary still pins it.
  const slots: number[] = [];
  const blobs = new Map<number, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const type = data.getUint32(12 + index * 8);
    const offset = data.getUint32(16 + index * 8);
    if (offset < 12 + count * 8 || offset + 8 > length) refuse('superblob index bounds');
    const size = data.getUint32(offset + 4);
    if (size < 8 || offset + size > length) refuse('superblob blob bounds');
    if (blobs.has(type)) refuse('duplicate superblob slot');
    slots.push(type);
    blobs.set(type, blob.subarray(offset, offset + size));
  }
  for (const type of slots)
    if (type !== CSSLOT_CODEDIRECTORY && type !== CSSLOT_REQUIREMENTS && type !== CSSLOT_SIGNATURESLOT)
      violations.push(`forbidden superblob slot 0x${type.toString(16)}`);
  const codeDirectories = EffectArray.filter(
    [...blobs.values()],
    entry => view(entry).getUint32(0) === CSMAGIC_CODEDIRECTORY,
  ).length;
  if (codeDirectories !== 1) violations.push(`expected one CodeDirectory, found ${codeDirectories}`);
  const requirements = blobs.get(CSSLOT_REQUIREMENTS);
  if (requirements && view(requirements).getUint32(0) !== CSMAGIC_REQUIREMENTS) violations.push('requirements magic');
  const cms = blobs.get(CSSLOT_SIGNATURESLOT);
  if (cms && view(cms).getUint32(0) !== CSMAGIC_BLOBWRAPPER) violations.push('signature slot magic');
  const directory = blobs.get(CSSLOT_CODEDIRECTORY);
  if (!directory || view(directory).getUint32(0) !== CSMAGIC_CODEDIRECTORY) return refuse('no CodeDirectory in slot 0');
  const cd = view(directory);
  if (directory.byteLength < 88) refuse('CodeDirectory size');
  const version = cd.getUint32(8);
  const flags = cd.getUint32(12);
  const hashOffset = cd.getUint32(16);
  const identOffset = cd.getUint32(20);
  const nSpecialSlots = cd.getUint32(24);
  const nCodeSlots = cd.getUint32(28);
  const codeLimit = cd.getUint32(32);
  const hashSize = cd.getUint8(36);
  const hashType = cd.getUint8(37);
  const platform = cd.getUint8(38);
  const pageShift = cd.getUint8(39);
  if (version < 0x20400 || version > 0x20600) refuse(`CodeDirectory version 0x${version.toString(16)}`);
  const headerEnd = version >= 0x20600 ? 108 : version >= 0x20500 ? 96 : 88;
  if (directory.byteLength < headerEnd) refuse('CodeDirectory size');
  if (hashType !== CS_HASHTYPE_SHA256 || hashSize !== 32) violations.push('CodeDirectory hash is not SHA-256');
  if (platform !== 0) violations.push('platform CodeDirectory');
  if (cd.getUint32(44) !== 0) violations.push('scatter vector');
  if (cd.getBigUint64(56) !== 0n) violations.push('64-bit code limit');
  if (version >= 0x20500 && cd.getUint32(92) !== 0) violations.push('pre-encryption hashes');
  if (version >= 0x20600 && (cd.getUint32(100) !== 0 || cd.getUint32(104) !== 0)) violations.push('linkage hash');
  if (codeLimit !== dataoff) violations.push('CodeDirectory code limit differs from dataoff');
  const pageSize = pageShift === 0 ? 0 : 2 ** pageShift;
  if (pageSize !== 4096 && pageSize !== 16384) violations.push(`page size ${pageSize}`);
  if (nSpecialSlots > 7) violations.push('special slot count');
  const hashesStart = hashOffset - nSpecialSlots * hashSize;
  const hashesEnd = hashOffset + nCodeSlots * hashSize;
  if (hashSize === 0 || hashesStart < headerEnd || hashesEnd > directory.byteLength)
    refuse('CodeDirectory hash bounds');
  const string = (at: number) => {
    if (at < headerEnd || at >= directory.byteLength) return refuse('CodeDirectory string bounds');
    const end = directory.indexOf(0, at);
    if (end < 0) return refuse('CodeDirectory string termination');
    return ascii(directory.subarray(at, end));
  };
  const identifier = string(identOffset);
  const teamOffset = cd.getUint32(48);
  const teamIdentifier = teamOffset === 0 ? undefined : string(teamOffset);
  const execSegFlags = cd.getBigUint64(80);
  if (execSegFlags !== CS_EXECSEG_MAIN_BINARY) violations.push(`execSegFlags 0x${execSegFlags.toString(16)}`);
  const zero = (hash: Uint8Array) => hash.every(value => value === 0);
  for (let slot = 1; slot <= nSpecialSlots; slot += 1) {
    const hash = directory.subarray(hashOffset - slot * hashSize, hashOffset - (slot - 1) * hashSize);
    const bound = blobs.get(slot);
    if (bound === undefined) {
      if (!zero(hash)) violations.push(`special slot -${slot} hashes an absent blob`);
    } else if (!Buffer.from(sha256(bound).subarray(0, hashSize)).equals(hash))
      violations.push(`special slot -${slot} does not bind its blob`);
  }
  if (pageSize > 0) {
    if (nCodeSlots !== Math.ceil(codeLimit / pageSize)) violations.push('code slot count');
    let mismatched = 0;
    for (let page = 0; page < Math.min(nCodeSlots, Math.ceil(codeLimit / pageSize)); page += 1) {
      const actual = sha256(bytes.subarray(page * pageSize, Math.min(codeLimit, (page + 1) * pageSize)));
      const expected = directory.subarray(hashOffset + page * hashSize, hashOffset + (page + 1) * hashSize);
      if (!Buffer.from(actual.subarray(0, hashSize)).equals(expected)) mismatched += 1;
    }
    if (mismatched > 0) violations.push(`${mismatched} page hashes differ from the file`);
  }
  return {
    codeLimit,
    cdhash: hex(sha256(directory).subarray(0, 20)),
    identifier,
    teamIdentifier,
    version,
    flags,
    pageSize,
    hashType,
    hashSize,
    platform,
    nCodeSlots,
    execSegFlags,
    codeDirectories,
    slots,
    violations,
  };
}

/** Release signature policy on top of the structural checks. */
export function machoSignaturePolicyViolations(
  signature: MachOCodeSignature,
  policy: {readonly identifier: string; readonly requireRuntime: boolean},
): readonly string[] {
  const violations = [...signature.violations];
  if ((signature.flags & ~(CS_ADHOC | CS_LINKER_SIGNED | CS_HARD | CS_KILL | CS_RUNTIME)) !== 0)
    violations.push(`CodeDirectory flags 0x${signature.flags.toString(16)}`);
  if (policy.requireRuntime && (signature.flags & CS_RUNTIME) === 0)
    violations.push('hardened runtime flag is not set');
  // macOS 15 does not imply kill or hard from the hardened runtime; the runtime image check requires both.
  if (policy.requireRuntime && (signature.flags & CS_KILL) === 0) violations.push('kill flag is not set');
  if (policy.requireRuntime && (signature.flags & CS_HARD) === 0) violations.push('hard flag is not set');
  if (policy.requireRuntime && (signature.flags & CS_LINKER_SIGNED) !== 0) violations.push('linker signature');
  if (signature.identifier !== policy.identifier)
    violations.push(`identifier ${JSON.stringify(signature.identifier)} is not ${JSON.stringify(policy.identifier)}`);
  return violations;
}

export const isHexDigest = (value: string, bytes: number): boolean =>
  value.length === bytes * 2 && EffectString.toLowerCase(value) === value && /^[0-9a-f]+$/u.test(value);
