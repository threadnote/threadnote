import {gzipSync} from 'fflate';
import {sha256HexSync} from '@threadnote/platform/sha256';

const DISK_LIMIT = 16 * 1024 * 1024;
const LOGICAL_LIMIT = 64 * 1024 * 1024;
const FEED_SIZE = 256;
const COMPRESSION_THRESHOLD = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const FORMAT = 'threadnote-workflow-journal-gzip-v1';
const digest = (bytes: Uint8Array) => sha256HexSync(bytes);

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (btoa(binary) !== value) throw new Error('Noncanonical base64');
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += FEED_SIZE)
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + FEED_SIZE, bytes.length)));
  return btoa(binary);
}

export function encodeWorkflowJournal(content: string): string {
  return encodeBoundedWorkflowJson(content, FORMAT);
}

/** Shared bounded storage codec; callers choose their own isolated envelope marker. */
export function encodeBoundedWorkflowJson(content: string, format: string): string {
  const plainBytes = encoder.encode(content);
  if (plainBytes.byteLength > LOGICAL_LIMIT) throw new RangeError('Workflow journal logical size limit exceeded');
  if (plainBytes.byteLength <= COMPRESSION_THRESHOLD) return content;
  const compressed = gzipSync(plainBytes, {level: 6, mtime: 0});
  const envelope = JSON.stringify({
    format,
    expandedBytes: plainBytes.byteLength,
    sha256: digest(plainBytes),
    payload: encodeBase64(compressed),
  });
  const storedBytes = encoder.encode(envelope).byteLength;
  // Compression is optional: it must never shrink the capacity of valid plain journals.
  if (plainBytes.byteLength <= DISK_LIMIT && storedBytes >= plainBytes.byteLength) return content;
  if (storedBytes > DISK_LIMIT) throw new RangeError('Workflow journal disk size limit exceeded');
  return envelope;
}

/** Native gzip parsing avoids repeated optional-header scans in JS streaming decoders. */
async function inflateBounded(
  compressed: Uint8Array,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (compressed.byteLength < 18 || expectedBytes > LOGICAL_LIMIT) throw new Error('Invalid gzip bounds');
  const output = new Uint8Array(expectedBytes);
  const reader = new Blob([new Uint8Array(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, {once: true});
  let offset = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const {value, done} = await reader.read();
      signal?.throwIfAborted();
      // Always read through EOF: gzip checksum/trailer errors can arrive after all output bytes.
      if (done) break;
      if (value.byteLength > output.byteLength - offset) throw new Error('Gzip output exceeds declared size');
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expectedBytes) throw new Error('Gzip size mismatch');
    return output;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function decodeWorkflowJournal(text: string, signal?: AbortSignal): Promise<string> {
  return decodeBoundedWorkflowJson(text, FORMAT, signal);
}

export async function decodeBoundedWorkflowJson(text: string, format: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (new TextEncoder().encode(text).byteLength > DISK_LIMIT) throw new Error('Workflow journal exceeds disk limit');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) {
    if (encoder.encode(text).byteLength > LOGICAL_LIMIT) throw new Error('Workflow journal exceeds logical limit');
    return text;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (encoder.encode(text).byteLength > LOGICAL_LIMIT) throw new Error('Workflow journal exceeds logical limit');
    return text;
  }
  if (typeof parsed !== 'object' || parsed === null || !('format' in parsed)) return text;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== format) throw new Error('Unsupported workflow journal format');
  if (
    Object.keys(envelope).sort().join(',') !== 'expandedBytes,format,payload,sha256' ||
    !Number.isSafeInteger(envelope.expandedBytes) ||
    (envelope.expandedBytes as number) < 1 ||
    (envelope.expandedBytes as number) > LOGICAL_LIMIT ||
    typeof envelope.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(envelope.sha256) ||
    typeof envelope.payload !== 'string'
  )
    throw new Error('Invalid journal envelope');
  const compressed = decodeBase64(envelope.payload);
  const bytes = await inflateBounded(compressed, envelope.expandedBytes as number, signal);
  if (digest(bytes) !== envelope.sha256) throw new Error('Journal digest mismatch');
  return decoder.decode(bytes);
}

export const workflowJournalLimits = {diskBytes: DISK_LIMIT, logicalBytes: LOGICAL_LIMIT} as const;
