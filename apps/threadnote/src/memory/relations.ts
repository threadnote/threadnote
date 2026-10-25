import {Data, Effect} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import {makeResourceIdScopeChecker, parseResourceId} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  isMemoryRelationType,
  MAX_MEMORY_RELATIONS,
  parseMemoryDocument,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {
  isMemoryId,
  memoryIdentityAlias,
  memoryIdentityLockKey,
  memoryIdFromIdentityAlias,
} from '@threadnote/memory/identity-alias';
import {readMemoryWithRelocations} from '@threadnote/memory/relocation';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';

export class MemoryRelationWriteError extends Data.TaggedError('MemoryRelationWriteError')<{
  readonly message: string;
}> {}

export interface AuthoredMemoryRelationTarget {
  readonly allowedUriScopes: readonly string[];
  readonly content: string;
  readonly memoryId?: string;
  readonly uri: string;
}

export interface ResolvedAuthoredMemoryRelations {
  readonly relations?: readonly MemoryRelation[];
  /** Canonical target snapshots rechecked atomically by the writer. */
  readonly targets: readonly AuthoredMemoryRelationTarget[];
}

export function memoryIdentityWriteLockKeys(
  sourceMemoryId: string | undefined,
  targets: readonly {readonly memoryId?: string}[],
): readonly string[] {
  return [
    memoryIdentityLockKey(sourceMemoryId),
    ...targets.map(target => memoryIdentityLockKey(target.memoryId)),
  ].filter((key): key is string => key !== undefined);
}

type RelationInput = Readonly<{readonly type: string; readonly uri: string}>;

/** Parse the repeatable CLI `--relation <type>=<threadnote://uri>` form. */
export function parseMemoryRelationOption(value: string): MemoryRelation {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw relationError('Relation must use <type>=<threadnote://uri>.');
  }
  return normalizeMemoryRelationInputs([
    {type: value.slice(0, separator).trim(), uri: value.slice(separator + 1).trim()},
  ])[0];
}

export function formatMemoryRelationOption(relation: MemoryRelation): string {
  return `${relation.type}=${relation.uri}`;
}

/**
 * Strict, pure authoring normalization. Imported documents remain tolerant;
 * only new explicit writes use this closed contract.
 */
export function normalizeMemoryRelationInputs(inputs: readonly RelationInput[]): readonly MemoryRelation[] {
  if (inputs.length > MAX_MEMORY_RELATIONS) {
    throw relationError(`A memory can declare at most ${MAX_MEMORY_RELATIONS} relations.`);
  }
  const normalized: MemoryRelation[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!isMemoryRelationType(input.type)) {
      throw relationError(`Unsupported memory relation type "${input.type}".`);
    }
    let uri: string;
    let resource: ReturnType<typeof parseResourceId>;
    try {
      resource = parseResourceId(input.uri.trim());
      uri = resource.canonicalUri;
    } catch {
      throw relationError('Relation targets must be canonical threadnote:// memory URIs or stable memory aliases.');
    }
    if (
      resource.anchor !== undefined ||
      (memoryIdFromIdentityAlias(uri) === undefined &&
        (resource.namespace !== 'user' || resource.segments[1] !== 'memories'))
    ) {
      throw relationError('Relation targets must identify Threadnote memories, not general resources.');
    }
    const key = `${input.type}\n${uri}`;
    if (seen.has(key)) {
      throw relationError('Duplicate memory relations are not allowed.');
    }
    seen.add(key);
    normalized.push({type: input.type, uri});
  }
  // Relation declarations are a set contract; canonical ordering keeps the
  // stored header and projection independent of CLI/MCP input ordering.
  return normalized.sort(compareRelation);
}

/**
 * Resolve every target inside an explicit authorized scope, verify live bytes,
 * reject identity conflicts/self-links, and persist stable identity aliases when
 * the target has a memory_id. Active authorized memories without an identity keep
 * their canonical projection URI.
 */
export const resolveAuthoredMemoryRelations = Effect.fn('memory.resolveAuthoredRelations')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'manifestPath' | 'user'>,
  inputs: readonly RelationInput[],
  options: {
    readonly allowedUriScopes: readonly string[];
    readonly sourceMemoryId?: string;
    readonly sourceUri?: string;
  },
) {
  const resourceIds = makeResourceIdScopeChecker();
  const relations = yield* Effect.try({
    catch: cause =>
      cause instanceof MemoryRelationWriteError
        ? cause
        : relationError(cause instanceof Error ? cause.message : 'Memory relation input is invalid.'),
    try: () => normalizeMemoryRelationInputs(inputs),
  });
  const sourceUri = yield* Effect.try({
    catch: cause =>
      cause instanceof MemoryRelationWriteError
        ? cause
        : relationError(cause instanceof Error ? cause.message : 'Relation source URI is invalid.'),
    try: () => (options.sourceUri === undefined ? undefined : resourceIds.parse(options.sourceUri).canonicalUri),
  });
  if (relations.length === 0) return {relations: undefined, targets: []} satisfies ResolvedAuthoredMemoryRelations;
  const allowedUriScopes = options.allowedUriScopes.map(scope => resourceIds.parse(scope).canonicalUri);
  if (allowedUriScopes.length === 0) {
    return yield* relationError('Relation resolution requires an explicit authorized memory scope.');
  }
  for (const relation of relations) {
    if (
      memoryIdFromIdentityAlias(relation.uri) === undefined &&
      !allowedUriScopes.some(scope => resourceIds.isWithin(relation.uri, scope))
    ) {
      return yield* relationError('Relation targets must stay inside the authorized memory scope.');
    }
  }

  const initiallyResolved = yield* resolveMemoryIdentityAliases(
    config,
    relations.map(relation => relation.uri),
    allowedUriScopes,
  );
  const liveTargets = yield* Effect.forEach(initiallyResolved, (resolved, index) =>
    Effect.gen(function* () {
      const live = yield* readMemoryWithRelocations(config, resolved.canonicalUri, {allowedUriScopes});
      if (!allowedUriScopes.some(scope => resourceIds.isWithin(live.canonicalUri, scope))) {
        return yield* relationError('Relation target does not resolve inside the authorized active memory scope.');
      }
      yield* verifyResolvedMemoryIdentity(resolved, live.canonicalUri, live.content);
      const record = parseMemoryDocument(live.canonicalUri, live.content);
      if (!record || record.metadata.status !== 'active') {
        return yield* relationError('Relation targets must resolve to one active canonical memory.');
      }
      const memoryId = record.metadata.memoryId;
      if (memoryId !== undefined && !isMemoryId(memoryId)) {
        return yield* relationError('Relation targets must resolve to one active, identity-bearing canonical memory.');
      }
      return {
        content: live.content,
        memoryId,
        relation: relations[index],
        uri: live.canonicalUri,
      };
    }),
  );

  const identityBearing = liveTargets.filter(
    (target): target is (typeof liveTargets)[number] & {readonly memoryId: string} => target.memoryId !== undefined,
  );
  const identityChecks =
    identityBearing.length === 0
      ? []
      : yield* resolveMemoryIdentityAliases(
          config,
          identityBearing.map(target => memoryIdentityAlias(target.memoryId)),
          allowedUriScopes,
        );
  const identityByMemoryId = new Map(
    identityBearing.map((target, index) => [target.memoryId, identityChecks[index]] as const),
  );
  const output: MemoryRelation[] = [];
  const targets = new Map<string, AuthoredMemoryRelationTarget>();
  const seen = new Set<string>();
  for (const target of liveTargets) {
    if (target.memoryId !== undefined) {
      const identity = identityByMemoryId.get(target.memoryId);
      if (identity === undefined || identity.canonicalUri !== target.uri) {
        return yield* relationError('Relation target identity changed during validation; refresh memory and retry.');
      }
      yield* verifyResolvedMemoryIdentity(identity, target.uri, target.content);
    }
    if (
      (options.sourceMemoryId !== undefined && target.memoryId === options.sourceMemoryId) ||
      (sourceUri !== undefined && target.uri === sourceUri)
    ) {
      return yield* relationError('A memory cannot relate to itself.');
    }
    const uri = target.memoryId === undefined ? target.uri : memoryIdentityAlias(target.memoryId);
    const key = `${target.relation.type}\n${uri}`;
    if (seen.has(key)) {
      return yield* relationError('Duplicate memory relations are not allowed.');
    }
    seen.add(key);
    output.push({type: target.relation.type, uri});
    targets.set(target.uri, {
      allowedUriScopes,
      content: target.content,
      ...(target.memoryId === undefined ? {} : {memoryId: target.memoryId}),
      uri: target.uri,
    });
  }
  return {
    relations: output.sort(compareRelation),
    targets: [...targets.values()].sort((left, right) => compareText(left.uri, right.uri)),
  } satisfies ResolvedAuthoredMemoryRelations;
});

/**
 * Re-resolve stable identities while the writer holds identity and URI locks.
 * Exact-byte CAS alone cannot notice a new conflicting URI for the same ID.
 */
export const verifyAuthoredMemoryRelationTargetIdentities = Effect.fn('memory.verifyRelationTargetIdentities')(
  function* (
    config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'manifestPath' | 'user'>,
    targets: readonly {
      readonly allowedUriScopes?: readonly string[];
      readonly content: string;
      readonly memoryId?: string;
      readonly uri: string;
    }[],
  ) {
    const store = yield* ResourceStore;
    const grouped = new Map<string, typeof targets>();
    for (const target of targets) {
      const liveContent = yield* store
        .read({account: config.account, home: config.agentContextHome, user: config.user}, target.uri)
        .pipe(Effect.mapError(() => relationError('A relation target changed during the write; refresh and retry.')));
      if (liveContent !== target.content) {
        return yield* relationError('A relation target changed during the write; refresh and retry.');
      }
      if (!target.memoryId || !target.allowedUriScopes?.length) continue;
      const key = JSON.stringify(target.allowedUriScopes);
      grouped.set(key, [...(grouped.get(key) ?? []), target]);
    }
    for (const targetsInScope of grouped.values()) {
      const allowedUriScopes = targetsInScope[0].allowedUriScopes!;
      const resolved = yield* resolveMemoryIdentityAliases(
        config,
        targetsInScope.map(target => memoryIdentityAlias(target.memoryId!)),
        allowedUriScopes,
        {validateNow: true},
      ).pipe(
        Effect.mapError(() =>
          relationError('A relation target identity became ambiguous or moved during the write; refresh and retry.'),
        ),
      );
      for (const [index, target] of targetsInScope.entries()) {
        const identity = resolved[index];
        if (identity.canonicalUri !== target.uri) {
          return yield* relationError(
            'A relation target identity became ambiguous or moved during the write; refresh and retry.',
          );
        }
        yield* verifyResolvedMemoryIdentity(identity, target.uri, target.content).pipe(
          Effect.mapError(() =>
            relationError('A relation target identity changed during the write; refresh and retry.'),
          ),
        );
      }
    }
  },
);

function relationError(message: string): MemoryRelationWriteError {
  return new MemoryRelationWriteError({message});
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRelation(left: MemoryRelation, right: MemoryRelation): number {
  const type = compareText(left.type, right.type);
  return type === 0 ? compareText(left.uri, right.uri) : type;
}
