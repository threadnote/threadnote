import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';
/** Cryptographic UUID v4 for Promise/Node adapters that cannot yield `Crypto.randomUUIDv4()`. */
export function randomUuidV4(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = EffectArray.join(
    Array.from(bytes, byte => Effect.pipe(byte.toString(16), EffectString.padStart(2, '0'))),
    '',
  );
  return `${Effect.pipe(hex, EffectString.slice(0, 8))}-${Effect.pipe(hex, EffectString.slice(8, 12))}-${Effect.pipe(hex, EffectString.slice(12, 16))}-${Effect.pipe(hex, EffectString.slice(16, 20))}-${Effect.pipe(hex, EffectString.slice(20))}`;
}
