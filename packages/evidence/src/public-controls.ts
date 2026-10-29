import {Array as EffectArray} from 'effect';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const SAFE_PUBLIC_CONTROL_QUERY = /^[A-Za-z0-9_./:@+-]{1,512}$/;

export function privacySafeExternalControlQuery(query: string): string {
  const value = Effect.pipe(query, EffectString.trim);
  if (
    !SAFE_PUBLIC_CONTROL_QUERY.test(value) ||
    credentialScrubberBlocker(value) !== undefined ||
    Effect.pipe(value, EffectString.startsWith('/')) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    Effect.pipe(value, EffectString.startsWith('\\\\'))
  ) {
    throw new Error('External benchmark controls must use a privacy-safe public symbol or repository-relative path.');
  }
  return value;
}

export function privacySafeExternalControlPath(path: string): string {
  const normalized = Effect.pipe(path, EffectString.replaceAll('\\', '/'));
  if (
    normalized.length === 0 ||
    normalized.length > 1_024 ||
    Effect.pipe(normalized, EffectString.startsWith('/')) ||
    /^[A-Za-z]:\//.test(normalized) ||
    credentialScrubberBlocker(normalized) !== undefined ||
    EffectArray.some(
      Effect.pipe(normalized, EffectString.split('/')),
      segment => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('External benchmark control paths must be normalized repository-relative paths.');
  }
  return normalized;
}
