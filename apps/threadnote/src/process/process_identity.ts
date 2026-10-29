import {Effect} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {SystemInfoShape} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const PRE_CANONICAL_DARWIN_PROCESS_IDENTITY = /^darwin:(?!v2:)./;

export function observeCanonicalProcessInstanceIdentity(
  system: Pick<SystemInfoShape, 'canonicalProcessStartIdentity'>,
  processId: number,
): Effect.Effect<string | undefined> {
  return system.canonicalProcessStartIdentity?.(processId) ?? succeedUndefined;
}

export function observeProcessInstanceIdentity(
  system: Pick<SystemInfoShape, 'canonicalProcessStartIdentity' | 'processStartIdentity'>,
  processId: number,
): Effect.Effect<string | undefined> {
  return observeCanonicalProcessInstanceIdentity(system, processId).pipe(
    Effect.filterOrElse(
      (canonical): canonical is string => canonical !== undefined,
      () => system.processStartIdentity(processId),
    ),
  );
}

function isPreCanonicalDarwinProcessIdentity(identity: string): boolean {
  return PRE_CANONICAL_DARWIN_PROCESS_IDENTITY.test(identity);
}

function isCanonicalDarwinProcessIdentity(identity: string): boolean {
  return Effect2.pipe(identity, EffectString.startsWith('darwin-v2:'));
}

export function processInstanceIdentityMatches(stored: string | undefined, observed: string | undefined): boolean {
  if (stored === undefined || observed === undefined) return true;
  if (stored === observed) return true;
  return (
    (isPreCanonicalDarwinProcessIdentity(stored) && isCanonicalDarwinProcessIdentity(observed)) ||
    (isCanonicalDarwinProcessIdentity(stored) && isPreCanonicalDarwinProcessIdentity(observed))
  );
}
