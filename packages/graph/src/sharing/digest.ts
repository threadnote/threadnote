import {sha256HexSync} from '@threadnote/platform/sha256';
import {graphSharingFailure} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const SHA256_HEX = /^[0-9a-f]{64}$/u;
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type Sha256Digest = `sha256:${string}`;

function isSha256Digest(value: string): value is Sha256Digest {
  return SHA256_DIGEST.test(value);
}

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${sha256HexSync(value)}`;
}

export function parseSha256Digest(value: string, label = 'Digest'): Sha256Digest {
  const trimmed = Effect.pipe(value, EffectString.trim);
  if (isSha256Digest(trimmed)) return trimmed;
  if (SHA256_HEX.test(trimmed)) return `sha256:${trimmed}`;
  throw graphSharingFailure(`${label} must be a SHA-256 digest.`);
}

export function sha256HexFromDigest(digest: string): string {
  const parsed = parseSha256Digest(digest);
  return Effect.pipe(parsed, EffectString.slice('sha256:'.length));
}
