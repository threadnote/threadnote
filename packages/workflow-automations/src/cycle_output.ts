import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';

const invalidPage = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-cycle-page', message});
};

const outputCapacity = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'outputcapacity', message});
};

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

export interface NativeCycleTextPageOptions {
  readonly maxBytes?: number;
  readonly offsetBytes?: number;
  readonly sourceDigest?: string;
}

export interface NativeCycleTextPage {
  readonly text: string;
  readonly sourceDigest: string;
  readonly offsetBytes: number;
  readonly totalBytes: number;
  readonly nextOffsetBytes: number | null;
}

/** Return a UTF-8-safe page of immutable cycle text. */
export function nativeCycleTextPage(text: string, options: NativeCycleTextPageOptions = {}): NativeCycleTextPage {
  const maxBytes = options.maxBytes ?? 16_384;
  const offsetBytes = options.offsetBytes ?? 0;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 65_536)
    return invalidPage('Cycle page size must be an integer from 1024 to 65536 UTF-8 bytes.');
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0)
    return invalidPage('Cycle page offsets must be nonnegative safe UTF-8 byte offsets.');

  const bytes = new TextEncoder().encode(text);
  const sourceDigest = sha256HexSync(bytes);
  if (options.sourceDigest !== undefined && options.sourceDigest !== sourceDigest)
    return invalidPage('Cycle text changed while its pages were being read.');
  if (offsetBytes > bytes.byteLength || (offsetBytes < bytes.byteLength && isContinuationByte(bytes[offsetBytes])))
    return invalidPage('Cycle page offset is outside the text or splits a UTF-8 code point.');
  if (offsetBytes > 0 && options.sourceDigest === undefined)
    return invalidPage('A source digest is required to continue cycle text paging.');

  let end = Math.min(offsetBytes + maxBytes, bytes.byteLength);
  while (end < bytes.byteLength && isContinuationByte(bytes[end])) end -= 1;
  const pageText = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offsetBytes, end));
  return {
    text: pageText,
    sourceDigest,
    offsetBytes,
    totalBytes: bytes.byteLength,
    nextOffsetBytes: end < bytes.byteLength ? end : null,
  };
}

/** Keep structured cycle responses within a transport budget with explicit continuation data. */
export function boundNativeCycleOutput(
  payload: Readonly<Record<string, unknown>>,
  maximumBytes = 16_384,
  detail: Readonly<Record<string, string>> = {},
): Readonly<Record<string, unknown>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    return outputCapacity('Cycle output budget must be a positive safe integer byte count.');

  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    return outputCapacity('Cycle output cannot be represented as bounded JSON.');
  }
  if (encoded === undefined) return outputCapacity('Cycle output cannot be represented as bounded JSON.');
  const requiredBytes = new TextEncoder().encode(encoded).byteLength;
  if (requiredBytes <= maximumBytes) return payload;

  const snapshot = payload.snapshot;
  const snapshotId =
    typeof snapshot === 'object' && snapshot !== null ? (snapshot as Record<string, unknown>).snapshotId : undefined;
  const fallback = {
    available: false,
    reason: 'response-budget-exceeded',
    requiredBytes,
    maxBytes: maximumBytes,
    ...(payload.status === 'error'
      ? {status: 'error', code: typeof payload.code === 'string' ? payload.code : 'cycle-operation-failed'}
      : {}),
    ...(typeof payload.revision === 'string' ? {revision: payload.revision} : {}),
    ...(payload.next ? {next: payload.next} : {}),
    continuation: {
      command: 'detail',
      ...detail,
      ...(typeof snapshotId === 'string' ? {snapshotId} : {}),
    },
  };
  let fallbackJson: string | undefined;
  try {
    fallbackJson = JSON.stringify(fallback);
  } catch {
    return outputCapacity('Cycle output continuation exceeds the response budget.');
  }
  if (fallbackJson === undefined || new TextEncoder().encode(fallbackJson).byteLength > maximumBytes)
    return outputCapacity('Cycle output continuation exceeds the response budget.');
  return fallback;
}
