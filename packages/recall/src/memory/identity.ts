import {Effect, Schema} from 'effect';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {isMemoryId, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {loadMemoryRelocationIdentityWitnesses} from '@threadnote/memory/relocation';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';
import {loadRecallMemoryIdentities, type MemoryIdentityEngine} from '../index.js';

interface MemoryIdentityRuntime {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export class MemoryIdentityResolutionError extends Schema.TaggedError<MemoryIdentityResolutionError>()(
  'MemoryIdentityResolutionError',
  {
    message: Schema.String,
    memoryId: Schema.String,
    reason: Schema.Literals(['ambiguous', 'live-mismatch', 'not-found', 'scope-required']),
  },
) {}

export interface ResolvedMemoryIdentityAlias {
  readonly canonicalUri: string;
  readonly expectedMemoryId?: string;
  readonly identityWitness?: 'private-relocation-receipt';
  readonly requestedUri: string;
}

interface MemoryIdentityCandidate {
  readonly identityConflict?: boolean;
  readonly memoryId?: string;
  readonly status?: string;
  readonly uri: string;
}

export type MemoryIdentityCandidateResolution =
  {readonly state: 'ambiguous'} | {readonly state: 'not-found'} | {readonly state: 'resolved'; readonly uri: string};

/** Shared pure classifier keeps Context Brief alias emission and later reads on the same authorization contract. */
export function classifyMemoryIdentityCandidates(
  candidates: readonly MemoryIdentityCandidate[],
  memoryId: string,
  allowedUriScopes: readonly string[],
): MemoryIdentityCandidateResolution {
  if (allowedUriScopes.length === 0) return {state: 'not-found'};
  const matches = candidates.filter(
    candidate =>
      candidate.memoryId === memoryId && allowedUriScopes.some(scope => resourceIdIsWithin(candidate.uri, scope)),
  );
  const activeMatches = matches.filter(candidate => candidate.status === 'active');
  const identityConflict = matches.some(candidate => candidate.identityConflict === true);
  if (activeMatches.length === 1 && !identityConflict) return {state: 'resolved', uri: activeMatches[0].uri};
  return activeMatches.length === 0 && !identityConflict ? {state: 'not-found'} : {state: 'ambiguous'};
}

/** Resolve only inside the caller-authorized recall corpus; conflicts and missing IDs fail closed. */
export const resolveMemoryIdentityAliases = Effect.fn('recall.resolveMemoryIdentityAliases')(function* (
  config: MemoryIdentityRuntime,
  inputs: readonly string[],
  allowedUriScopes: readonly string[],
  options: {readonly validateNow?: boolean; readonly engine?: MemoryIdentityEngine} = {},
) {
  const memoryIds = [...new Set(inputs.flatMap(input => memoryIdFromIdentityAlias(input) ?? []).filter(isMemoryId))];
  if (memoryIds.length === 0) {
    return inputs.map(input => ({canonicalUri: input, expectedMemoryId: undefined, requestedUri: input}));
  }
  if (allowedUriScopes.length === 0) {
    return yield* MemoryIdentityResolutionError.make({
      memoryId: memoryIds[0],
      message: 'Stable memory identity resolution requires an explicit non-empty authorized URI scope.',
      reason: 'scope-required',
    });
  }
  const candidates = yield* loadRecallMemoryIdentities(config, {
    allowedUriScopes,
    memoryIds,
    validateNow: options.validateNow,
    engine: options.engine,
  });
  const indexedResolutions = new Map(
    memoryIds.map(
      memoryId => [memoryId, classifyMemoryIdentityCandidates(candidates, memoryId, allowedUriScopes)] as const,
    ),
  );
  // A receipt is a bounded disaster-recovery witness for an identity that the
  // active index cannot find. A live indexed memory_id is stronger evidence and
  // must not pay an O(lifetime relocations) filesystem scan on every read.
  const fallbackMemoryIds = memoryIds.filter(memoryId => indexedResolutions.get(memoryId)?.state === 'not-found');
  const relocationWitnesses =
    fallbackMemoryIds.length === 0
      ? []
      : yield* loadMemoryRelocationIdentityWitnesses(config, fallbackMemoryIds, allowedUriScopes);

  const resolved: ResolvedMemoryIdentityAlias[] = [];
  for (const input of inputs) {
    const memoryId = memoryIdFromIdentityAlias(input);
    if (memoryId === undefined) {
      resolved.push({canonicalUri: input, expectedMemoryId: undefined, requestedUri: input});
      continue;
    }
    const indexed = indexedResolutions.get(memoryId) ?? {state: 'not-found' as const};
    if (indexed.state === 'ambiguous') {
      return yield* MemoryIdentityResolutionError.make({
        memoryId,
        message: 'Stable memory identity is ambiguous or conflicted inside the authorized corpus.',
        reason: 'ambiguous',
      });
    }
    if (indexed.state === 'resolved') {
      resolved.push({canonicalUri: indexed.uri, expectedMemoryId: memoryId, requestedUri: input});
      continue;
    }
    const witnessed = classifyMemoryIdentityCandidates(relocationWitnesses, memoryId, allowedUriScopes);
    if (witnessed.state !== 'resolved') {
      const reason = witnessed.state;
      return yield* MemoryIdentityResolutionError.make({
        memoryId,
        message:
          reason === 'not-found'
            ? 'Stable memory identity does not resolve inside the authorized active corpus.'
            : 'Stable memory identity is ambiguous or conflicted inside the authorized corpus.',
        reason,
      });
    }
    resolved.push({
      canonicalUri: witnessed.uri,
      expectedMemoryId: memoryId,
      identityWitness: 'private-relocation-receipt',
      requestedUri: input,
    });
  }
  return resolved;
});

type MemoryIdentityResolutionRequirements =
  ReturnType<typeof resolveMemoryIdentityAliases> extends Effect.Effect<unknown, unknown, infer Requirements>
    ? Requirements
    : never;

/** Re-check live bytes after index resolution so stale indexes or URI reuse cannot cross identities. */
export const verifyResolvedMemoryIdentity = Effect.fn('recall.verifyResolvedMemoryIdentity')(function* (
  resolved: ResolvedMemoryIdentityAlias,
  canonicalUri: string,
  content: string,
) {
  if (resolved.expectedMemoryId === undefined) return;
  const record = parseMemoryDocument(canonicalUri, content);
  const observedMemoryId = record?.metadata.memoryId;
  const witnessedMissingIdentity =
    record !== undefined &&
    observedMemoryId === undefined &&
    resolved.identityWitness === 'private-relocation-receipt' &&
    resolved.canonicalUri === canonicalUri;
  if (observedMemoryId !== resolved.expectedMemoryId && !witnessedMissingIdentity) {
    return yield* MemoryIdentityResolutionError.make({
      memoryId: resolved.expectedMemoryId,
      message: 'Stable memory identity no longer matches the live memory bytes; refresh recall and retry.',
      reason: 'live-mismatch',
    });
  }
});

/** Resolve a replacement alias once, then bind its stable identity to the live target bytes. */
export function resolveMemoryReplacementTarget<Record extends {readonly content: string}, E, R>(
  config: MemoryIdentityRuntime,
  requestedUri: string,
  allowedUriScopes: readonly string[],
  read: (uri: string) => Effect.Effect<readonly Record[], E, R>,
): Effect.Effect<
  ResolvedMemoryIdentityAlias & {readonly record: Record | undefined},
  unknown,
  R | MemoryIdentityResolutionRequirements
> {
  return Effect.gen(function* () {
    const [resolved] = yield* resolveMemoryIdentityAliases(config, [requestedUri], allowedUriScopes);
    const [record] = yield* read(resolved.canonicalUri);
    if (record) {
      yield* verifyResolvedMemoryIdentity(resolved, resolved.canonicalUri, record.content);
    }
    return {...resolved, record};
  });
}
