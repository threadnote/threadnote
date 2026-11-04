import {unzlibSync} from 'fflate';
import {Array as EffectArray, Option} from 'effect';
import * as EffectString from 'effect/String';

export const CANDIDATE_PAGE_VERSION = 3;
export const CANDIDATE_PAGE_ROWS = 64;
export const CANDIDATE_PAGE_RAW_BYTES = 65_536;
export const CANDIDATE_PAGE_LOGICAL_BYTES = 8 * 1_048_576;
export const CANDIDATE_CODEC_BUFFER_BYTES = 8 * CANDIDATE_PAGE_RAW_BYTES + 32_768;
export const CANDIDATE_PAGE_PROTOCOL =
  'candidate-v3/utf8-binary-pairs/u32be/64x65536/file-owned/sha256-first16/zlib3-libdeflate/literal-pair/prefix-v1';
export const CANDIDATE_PAGE_PROTOCOL_SHA = Bun.SHA256.hash(CANDIDATE_PAGE_PROTOCOL, 'hex');
const hintPrefix = new TextEncoder().encode('cgp3-sha256-first16-length-framed-pair-v1\0');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const magic = [0x43, 0x47, 0x50, 0x33] as const;
export type CandidatePair = readonly [resolutionDomain: string, lookupKey: string];
export type CandidatePageCodec = 'raw-v1' | 'zlib3-v1' | 'literal-pair-v1';

export interface CandidatePage {
  readonly ordinal: number;
  readonly pairs: readonly CandidatePair[];
  readonly hints: readonly Uint8Array[];
  readonly codec: CandidatePageCodec;
  readonly rawBytes: number;
  readonly rawSha: string;
  readonly storedBytes: number;
  readonly storedSha: string;
  readonly payload?: Uint8Array;
}

export interface CandidatePageEnvelope {
  readonly codec: CandidatePageCodec;
  readonly entryCount: number;
  readonly rawBytes: number;
  readonly rawSha: string;
  readonly storedBytes: number;
  readonly storedSha: string;
}

// Code-unit matching deliberately omits /u: a paired astral scalar is two units,
// while either an unmatched high or unmatched low surrogate is lossful in UTF8.
const unpairedUnits = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

/** SQLite UTF8 cannot losslessly bind isolated UTF16 surrogates. Refuse the optional file. */
export function candidateTextRepresentable(value: unknown): value is string {
  return typeof value === 'string' && !unpairedUnits.test(value);
}

const surrogateUnits = /[\ud800-\udfff]/;

/** UTF8 BINARY order for scalar strings, without retaining encoded copies of large keys. */
export function compareCandidateText(left: string, right: string): number {
  if (left === right) return 0;
  // UTF16 and UTF8 BINARY orders agree for scalar BMP strings. Astral-vs-BMP
  // ordering still uses complete scalar comparison below; never use locale collation.
  if (!surrogateUnits.test(left) && !surrogateUnits.test(right)) return left < right ? -1 : 1;
  let l = 0;
  let r = 0;
  while (l < left.length && r < right.length) {
    const a = Option.getOrThrow(EffectString.codePointAt(left, l));
    const b = Option.getOrThrow(EffectString.codePointAt(right, r));
    if (a !== b) return a < b ? -1 : 1;
    l += a > 0xffff ? 2 : 1;
    r += b > 0xffff ? 2 : 1;
  }
  return l < left.length ? 1 : r < right.length ? -1 : 0;
}

export const compareCandidatePair = (left: CandidatePair, right: CandidatePair) =>
  compareCandidateText(left[0], right[0]) || compareCandidateText(left[1], right[1]);

/** Retain references to complete original strings, never a serialized-key dictionary. */
export function canonicalCandidatePairs(values: Iterable<CandidatePair>): readonly CandidatePair[] {
  const domains = new Map<string, Set<string>>();
  for (const [domain, key] of values) {
    const admitted = domains.get(domain);
    if (admitted?.has(key)) continue;
    // Reuse only this invocation's already validated immutable scalar membership.
    if ((!admitted && !candidateTextRepresentable(domain)) || !candidateTextRepresentable(key))
      throw new Error('Candidate key is not losslessly representable as SQLite UTF8.');
    const keys = admitted ?? new Set<string>();
    keys.add(key);
    domains.set(domain, keys);
  }
  const result: CandidatePair[] = [];
  for (const [domain, keys] of domains) for (const key of keys) result.push([domain, key]);
  return result.sort(compareCandidatePair);
}

export const candidatePairBytes = (pair: CandidatePair) => 8 + Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
export const candidateOriginalTupleBytes = (snapshotId: string, path: string, pair: CandidatePair) =>
  Buffer.byteLength(snapshotId) + Buffer.byteLength(path) + candidatePairBytes(pair) - 8;

/** Compare stable borrowed byte views before the next driver operation; never copy a Buffer merely to compare it. */
export function candidateBytesEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength)
    return false;
  for (let i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function updateText(hash: Bun.CryptoHasher, value: string): void {
  // Large literal keys never allocate a second full encoded buffer. Bound the
  // native UTF8 conversion too, and never split a surrogate pair at a chunk edge.
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 4_096);
    if (end < value.length) {
      const unit = Option.getOrThrow(EffectString.charCodeAt(value, end - 1));
      if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
    }
    hash.update(EffectString.slice(offset, end)(value));
    offset = end;
  }
}

function updatePair(hash: Bun.CryptoHasher, pair: CandidatePair): void {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, Buffer.byteLength(pair[0]), false);
  view.setUint32(4, Buffer.byteLength(pair[1]), false);
  hash.update(header);
  updateText(hash, pair[0]);
  updateText(hash, pair[1]);
}

function hintWith(hash: Bun.CryptoHasher, pair: CandidatePair): Uint8Array {
  hash.update(hintPrefix);
  updatePair(hash, pair);
  return new Uint8Array(hash.digest().subarray(0, 16));
}

/** Only a selective hint. Callers must compare every full original value and collect all matches. */
export const candidatePairHint = (pair: CandidatePair): Uint8Array => hintWith(new Bun.CryptoHasher('sha256'), pair);

export function candidateCanonicalSha(pairs: readonly CandidatePair[]): string {
  const hash = new Bun.CryptoHasher('sha256');
  for (const pair of pairs) updatePair(hash, pair);
  return hash.digest('hex');
}

function encodePage(ordinal: number, pairs: readonly CandidatePair[], hints: Bun.CryptoHasher): CandidatePage {
  const rawBytes = 8 + EffectArray.reduce(pairs, 0, (n, pair) => n + candidatePairBytes(pair));
  if (pairs.length === 0 || pairs.length > CANDIDATE_PAGE_ROWS || rawBytes > CANDIDATE_PAGE_LOGICAL_BYTES)
    throw new Error('Candidate page exceeds its unchanged logical limits.');
  const routeHints = EffectArray.map(pairs, pair => hintWith(hints, pair));
  if (rawBytes > CANDIDATE_PAGE_RAW_BYTES) {
    if (pairs.length !== 1) throw new Error('Only one full literal pair may exceed a normal page.');
    const hash = new Bun.CryptoHasher('sha256');
    hash.update(new Uint8Array([...magic, 0, 0, 0, 1]));
    updatePair(hash, pairs[0]);
    return {
      ordinal,
      pairs,
      hints: routeHints,
      codec: 'literal-pair-v1',
      rawBytes,
      rawSha: hash.digest('hex'),
      storedBytes: candidatePairBytes(pairs[0]) - 8,
      storedSha: candidateCanonicalSha(pairs),
    };
  }
  const raw = new Uint8Array(rawBytes);
  raw.set(magic);
  const view = new DataView(raw.buffer);
  view.setUint32(4, pairs.length, false);
  let offset = 8;
  for (const pair of pairs) {
    view.setUint32(offset, Buffer.byteLength(pair[0]), false);
    view.setUint32(offset + 4, Buffer.byteLength(pair[1]), false);
    offset += 8;
    for (const value of pair) {
      const encoded = encoder.encodeInto(value, raw.subarray(offset));
      if (encoded.read !== value.length) throw new Error('Candidate UTF8 framing changed during encoding.');
      offset += encoded.written;
    }
  }
  if (offset !== rawBytes) throw new Error('Candidate frame size changed.');
  const rawSha = Bun.SHA256.hash(raw, 'hex');
  const body = Bun.deflateSync(raw, {level: 3, library: 'libdeflate'});
  let payload: Uint8Array = raw;
  let codec: CandidatePageCodec = 'raw-v1';
  if (body.byteLength + 6 < rawBytes) {
    payload = new Uint8Array(body.byteLength + 6);
    payload[0] = 0x78;
    payload[1] = 0x5e;
    payload.set(body, 2);
    new DataView(payload.buffer).setUint32(payload.byteLength - 4, Bun.hash.adler32(raw) >>> 0, false);
    codec = 'zlib3-v1';
  }
  return {
    ordinal,
    pairs,
    hints: routeHints,
    codec,
    rawBytes,
    rawSha,
    storedBytes: payload.byteLength,
    storedSha: codec === 'raw-v1' ? rawSha : Bun.SHA256.hash(payload, 'hex'),
    payload,
  };
}

/** One immutable file chunk; only the current normal page is encoded at a time. */
export function* candidateFilePages(pairs: readonly CandidatePair[]): Generator<CandidatePage> {
  let group: CandidatePair[] = [];
  let bytes = 8;
  let ordinal = 0;
  const hints = new Bun.CryptoHasher('sha256');
  for (const pair of pairs) {
    const size = candidatePairBytes(pair);
    if (group.length > 0 && (group.length === CANDIDATE_PAGE_ROWS || bytes + size > CANDIDATE_PAGE_RAW_BYTES)) {
      yield encodePage(ordinal++, group, hints);
      group = [];
      bytes = 8;
    }
    if (size + 8 > CANDIDATE_PAGE_RAW_BYTES) yield encodePage(ordinal++, [pair], hints);
    else {
      group.push(pair);
      bytes += size;
    }
  }
  if (group.length > 0) yield encodePage(ordinal, group, hints);
}

/** Metadata must be admitted by SQL before calling this normal-page decoder. */
export function decodeCandidatePage(payload: Uint8Array, page: CandidatePageEnvelope): readonly CandidatePair[] {
  if (
    page.codec === 'literal-pair-v1' ||
    !Number.isSafeInteger(page.entryCount) ||
    page.entryCount < 1 ||
    page.entryCount > CANDIDATE_PAGE_ROWS ||
    !Number.isSafeInteger(page.rawBytes) ||
    page.rawBytes < 16 ||
    page.rawBytes > CANDIDATE_PAGE_RAW_BYTES ||
    payload.byteLength !== page.storedBytes ||
    page.storedBytes > CANDIDATE_PAGE_RAW_BYTES ||
    Bun.SHA256.hash(payload, 'hex') !== page.storedSha
  )
    throw new Error('Candidate page metadata or complete stored envelope is invalid.');
  let raw = payload;
  if (page.codec === 'zlib3-v1') {
    if (payload.byteLength >= page.rawBytes || payload[0] !== 0x78 || payload[1] !== 0x5e)
      throw new Error('Candidate compressed envelope is not canonical.');
    raw = unzlibSync(payload, {out: new Uint8Array(page.rawBytes)});
    const trailer = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
      payload.byteLength - 4,
      false,
    );
    if (trailer !== Bun.hash.adler32(raw) >>> 0) throw new Error('Candidate compressed trailer is invalid.');
  } else if (page.codec !== 'raw-v1' || page.storedBytes !== page.rawBytes) {
    throw new Error('Candidate page codec or raw length is invalid.');
  }
  if (
    raw.byteLength !== page.rawBytes ||
    (page.codec === 'raw-v1' ? page.rawSha !== page.storedSha : Bun.SHA256.hash(raw, 'hex') !== page.rawSha)
  )
    throw new Error('Candidate page failed original-byte integrity.');
  if (EffectArray.some(magic, (value, i) => raw[i] !== value)) throw new Error('Candidate frame magic is invalid.');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(4, false) !== page.entryCount) throw new Error('Candidate frame count is invalid.');
  const result: CandidatePair[] = [];
  let offset = 8;
  for (let i = 0; i < page.entryCount; i += 1) {
    if (offset + 8 > raw.byteLength) throw new Error('Candidate frame header is truncated.');
    const domainBytes = view.getUint32(offset, false);
    const keyBytes = view.getUint32(offset + 4, false);
    offset += 8;
    if (domainBytes + keyBytes > raw.byteLength - offset) throw new Error('Candidate frame value is truncated.');
    const domain = decoder.decode(raw.subarray(offset, offset + domainBytes));
    offset += domainBytes;
    const key = decoder.decode(raw.subarray(offset, offset + keyBytes));
    offset += keyBytes;
    result.push([domain, key]);
  }
  if (offset !== raw.byteLength) throw new Error('Candidate frame has trailing records.');
  return result;
}
