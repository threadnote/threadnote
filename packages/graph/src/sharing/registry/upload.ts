import {graphSharingFailure} from '../errors.js';
import type {GraphShareRegistryTarget} from './reference.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function parseGraphShareRegistryUploadLocation(
  target: GraphShareRegistryTarget,
  value: string | undefined,
): string {
  const fail = () => graphSharingFailure('Registry upload location is invalid.');
  if (value === undefined || value.length > 8192) throw fail();
  const location = Effect.pipe(value, EffectString.startsWith(target.origin + '/'))
    ? Effect.pipe(value, EffectString.slice(target.origin.length))
    : value;
  if (
    !Effect.pipe(location, EffectString.startsWith('/')) ||
    Effect.pipe(location, EffectString.startsWith('//')) ||
    Effect.pipe(location, EffectString.endsWith('?'))
  )
    throw fail();
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const pathname = location.split('?', 1)[0];
  const prefix = `/v2/${target.repository}/blobs/uploads/`;
  if (
    !Effect.pipe(pathname, EffectString.startsWith(prefix)) ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(Effect.pipe(pathname, EffectString.slice(prefix.length)))
  )
    throw fail();
  let url: URL;
  try {
    url = new URL(location, target.origin);
  } catch {
    throw fail();
  }
  if (url.href !== target.origin + location || url.hash !== '') throw fail();
  const keys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalized = Effect.pipe(key, EffectString.toLowerCase);
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(key) ||
      keys.has(normalized) ||
      ['digest', 'mount', 'from'].includes(normalized)
    )
      throw fail();
    keys.add(normalized);
  }
  return location;
}
