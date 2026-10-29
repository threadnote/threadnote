import * as EffectString from 'effect/String';
import * as Effect from 'effect';
export type ExactProcedureTextResult =
  {readonly ok: true; readonly text: string} | {readonly ok: false; readonly reason: 'encoding' | 'noncanonical'};

/** Decodes the portable procedure artifact contract without normalizing stored bytes. */
export function decodeExactProcedureText(bytes: Uint8Array): ExactProcedureTextResult {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {ok: false, reason: 'noncanonical'};
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    return {ok: false, reason: 'encoding'};
  }
  if (Effect.pipe(text, EffectString.includes('\u0000')) || !bytesEqual(bytes, new TextEncoder().encode(text))) {
    return {ok: false, reason: 'noncanonical'};
  }
  return {ok: true, text};
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
