import {unzlibSync} from 'fflate';
import {
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  serializeBoundedCodeGraphFact,
  type BoundedCodeGraphFact,
} from './budget.js';
import {Predicate} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_STORED_FACT_CODEC = 'zlib-base64-v1' as const;
export const CODE_GRAPH_STORED_FACT_COMPRESSION_LEVEL = 3 as const;
export const CODE_GRAPH_STORED_FACT_COMPRESSION_MINIMUM_BYTES = 1_024;
export const CODE_GRAPH_STORED_FACT_MINIMUM_SAVINGS_BYTES = 256;
export const CODE_GRAPH_STORED_FACT_MINIMUM_SAVINGS_RATIO = 0.1;

const storedFactDecoder = new TextDecoder('utf-8', {fatal: true});
const storedFactEncoder = new TextEncoder();
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface StoredCodeGraphFactEnvelope {
  readonly codec: typeof CODE_GRAPH_STORED_FACT_CODEC;
  readonly path: string;
  readonly pathOccurrences: number;
  readonly payload: string;
  readonly rawBytes: number;
  readonly sha256: string;
}

export interface EncodedStoredCodeGraphFact {
  readonly codec: 'json' | typeof CODE_GRAPH_STORED_FACT_CODEC;
  readonly json: string;
  readonly rawBytes: number;
  readonly storedBytes: number;
}

/**
 * Persist parser/materialized facts in a deterministic, self-describing JSON
 * envelope when doing so saves meaningful space. Keeping `path` visible lets
 * mixed-version SQL readers retain their existing cache-authority check.
 */
export function encodeStoredCodeGraphFact(fact: BoundedCodeGraphFact): EncodedStoredCodeGraphFact {
  const rawBytes = fact.bytes;
  if (rawBytes < CODE_GRAPH_STORED_FACT_COMPRESSION_MINIMUM_BYTES) {
    return {codec: 'json', json: fact.json, rawBytes, storedBytes: rawBytes};
  }
  const raw = storedFactEncoder.encode(fact.json);
  if (raw.byteLength !== rawBytes) throw new Error('Code graph fact byte measurement changed before persistence.');
  const payload = Buffer.from(compressStoredFact(raw)).toString('base64');
  const envelope: StoredCodeGraphFactEnvelope = {
    codec: CODE_GRAPH_STORED_FACT_CODEC,
    path: fact.facts.path,
    pathOccurrences: serializedPathOccurrences(fact.json, fact.facts.path),
    payload,
    rawBytes,
    sha256: storedFactSha256Hex(raw),
  };
  const json = JSON.stringify(envelope);
  const storedBytes = Buffer.byteLength(json, 'utf8');
  const minimumRatioSavings = Math.ceil(rawBytes * CODE_GRAPH_STORED_FACT_MINIMUM_SAVINGS_RATIO);
  if (rawBytes - storedBytes < Math.max(CODE_GRAPH_STORED_FACT_MINIMUM_SAVINGS_BYTES, minimumRatioSavings)) {
    return {codec: 'json', json: fact.json, rawBytes, storedBytes: rawBytes};
  }
  return {codec: CODE_GRAPH_STORED_FACT_CODEC, json, rawBytes, storedBytes};
}

/** Decode both 4.0 raw JSON rows and compact 4.1 envelopes. */
export function decodeStoredCodeGraphFact(json: string, expectedPath?: string): BoundedCodeGraphFact {
  const parsed = JSON.parse(json) as unknown;
  if (!isStoredCodeGraphFactEnvelope(parsed)) {
    if (Predicate.isObject(parsed) && parsed.codec === CODE_GRAPH_STORED_FACT_CODEC) {
      throw new Error('Stored code graph fact envelope is malformed.');
    }
    const bounded = serializeBoundedCodeGraphFact(parsed);
    if (expectedPath !== undefined && bounded.facts.path !== expectedPath) {
      throw new Error('Stored code graph fact path does not match its cache key.');
    }
    return bounded;
  }
  if (expectedPath !== undefined && parsed.path !== expectedPath) {
    throw new Error('Stored code graph fact envelope path does not match its cache key.');
  }
  const compressed = decodeCanonicalBase64(parsed.payload);
  // Keep the caller-owned output buffer: Bun's synchronous inflate API does
  // not currently expose an equivalent decompressed-byte ceiling.
  const raw = unzlibSync(compressed, {out: new Uint8Array(parsed.rawBytes)});
  if (raw.byteLength !== parsed.rawBytes || storedFactSha256Hex(raw) !== parsed.sha256) {
    throw new Error('Stored code graph fact envelope failed integrity validation.');
  }
  const bounded = serializeBoundedCodeGraphFact(JSON.parse(storedFactDecoder.decode(raw)));
  if (bounded.bytes !== parsed.rawBytes || bounded.facts.path !== parsed.path) {
    throw new Error('Stored code graph fact envelope metadata does not match its payload.');
  }
  return bounded;
}

/**
 * SQL expression for the semantic uncompressed byte count. The column name is
 * implementation-owned; rejecting arbitrary input prevents accidental SQL
 * construction at future call sites.
 */
export function storedCodeGraphFactRawBytesSql(column: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/u.test(column)) throw new Error('Stored fact SQL column is invalid.');
  return `CASE
    WHEN json_valid(${column})
      AND json_extract(${column}, '$.codec') = '${CODE_GRAPH_STORED_FACT_CODEC}'
      AND typeof(json_extract(${column}, '$.rawBytes')) = 'integer'
      AND json_extract(${column}, '$.rawBytes') BETWEEN 0 AND ${CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM}
    THEN CAST(json_extract(${column}, '$.rawBytes') AS INTEGER)
    ELSE length(CAST(${column} AS BLOB))
  END`;
}

function isStoredCodeGraphFactEnvelope(value: unknown): value is StoredCodeGraphFactEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredCodeGraphFactEnvelope>;
  return (
    candidate.codec === CODE_GRAPH_STORED_FACT_CODEC &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.pathOccurrences === 'number' &&
    Number.isSafeInteger(candidate.pathOccurrences) &&
    candidate.pathOccurrences > 0 &&
    typeof candidate.payload === 'string' &&
    candidate.payload.length > 0 &&
    candidate.payload.length <= Math.ceil((CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM * 4) / 3) + 4 &&
    typeof candidate.rawBytes === 'number' &&
    Number.isSafeInteger(candidate.rawBytes) &&
    candidate.rawBytes >= CODE_GRAPH_STORED_FACT_COMPRESSION_MINIMUM_BYTES &&
    candidate.rawBytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM &&
    typeof candidate.sha256 === 'string' &&
    SHA256_HEX.test(candidate.sha256)
  );
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    throw new Error('Stored code graph fact envelope payload is not canonical base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Stored code graph fact envelope payload is not canonical base64.');
  }
  return decoded;
}

function serializedPathOccurrences(json: string, path: string): number {
  const quoted = JSON.stringify(path);
  const needle = Effect.pipe(quoted, EffectString.slice(1, -1));
  if (needle.length === 0) throw new Error('Code graph fact path cannot be empty.');
  let count = 0;
  for (let offset = 0; ;) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const next = json.indexOf(needle, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function storedFactSha256Hex(value: Uint8Array): string {
  return Bun.SHA256.hash(value, 'hex');
}

function compressStoredFact(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  // Bun's libdeflate path emits raw DEFLATE. Add the canonical level-3 zlib
  // header and Adler-32 trailer so existing zlib-base64-v1 readers stay valid.
  const body = Bun.deflateSync(raw, {
    level: CODE_GRAPH_STORED_FACT_COMPRESSION_LEVEL,
    library: 'libdeflate',
  });
  const output = new Uint8Array(body.byteLength + 6);
  output[0] = 0x78;
  output[1] = 0x5e;
  output.set(body, 2);
  new DataView(output.buffer).setUint32(output.byteLength - 4, Bun.hash.adler32(raw) >>> 0, false);
  return output;
}
