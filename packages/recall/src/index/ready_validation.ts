import {Array as EffectArray, String as EffectString, Clock, Effect, FileSystem, Path} from 'effect';
import {parseResourceId} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/workspace/manifest';
import {runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {fromPromise} from '@threadnote/platform/errors';
import {isExternalResourceUri} from '@threadnote/store/external-resource';
import {indexCandidate, recallIndexCandidateIsEligible} from './candidate.js';
import {recallProjectMatches} from './selection.js';
import {recallWorkspaceScopeMatches} from './scope.js';
import {loadCanonicalResourcePolicy, verifyCanonicalResource} from './canonical_resource.js';
import type {RecallCandidate} from '../rank.js';
import type {RecallEligibilityPolicy} from '../eligibility.js';

/** Read only selected canonical sources. A stale index can lose hits, never widen live eligibility. */
export const makeRecallReadyValidator = Effect.fn('recall.makeReadyValidator')(function* (
  config: {account: string; agentContextHome: string; user: string; manifestPath?: string},
  selected: readonly RecallCandidate[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(config.agentContextHome, 'data', config.account);
  const boundary = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => undefined));
  const canonicalUris = new Set<string>();
  for (const candidate of selected) {
    if (candidate.authority !== 'canonical_repo') continue;
    for (const uri of [candidate.uri, ...(candidate.equivalentUris ?? [])]) canonicalUris.add(uri);
  }
  const policy =
    canonicalUris.size > 0 ? yield* loadCanonicalResourcePolicy(config, cause => cause, canonicalUris) : undefined;
  const now = yield* Clock.currentTimeMillis;
  const readLive = (uri: string) =>
    Effect.gen(function* () {
      const id = yield* Effect.try(() => parseResourceId(uri));
      if (
        id.namespace !== 'resources' &&
        !(id.namespace === 'user' && id.segments[0] === uriSegment(config.user) && id.segments[1] === 'memories')
      )
        return undefined;
      const filename = path.join(root, id.namespace, ...id.segments);
      if (!boundary) return undefined;
      const relative = path.relative(boundary, yield* fs.realPath(filename));
      if (relative === '..' || EffectString.startsWith('..' + path.sep)(relative) || path.isAbsolute(relative))
        return undefined;
      const bytes = yield* fromPromise('recall.readReadyCanonicalSource', () =>
        runtimeReadBoundedStableRegularFile(filename, 512 * 1024),
      );
      const content = yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      const canonical = policy ? yield* verifyCanonicalResource(fs, uri, content, policy) : false;
      return yield* Effect.try(() => indexCandidate(uri, content, canonical));
    }).pipe(Effect.orElseSucceed(() => undefined));
  const cache = new Map(
    yield* Effect.forEach(
      [...new Set(EffectArray.flatMap(selected, candidate => [candidate.uri, ...(candidate.equivalentUris ?? [])]))],
      uri => Effect.cached(readLive(uri)).pipe(Effect.map(read => [uri, read] as const)),
    ),
  );
  return (
    candidate: RecallCandidate,
    options: {
      eligibility?: RecallEligibilityPolicy;
      includeInactive: boolean;
      project?: string;
      workspaceScope?: string;
      workspaceScopeMode?: 'hierarchy' | 'sibling';
    },
  ) =>
    Effect.gen(function* () {
      if (isExternalResourceUri(candidate.uri)) return true; // The live external authorization/hash fence runs separately.
      const read = cache.get(candidate.uri);
      if (!read) return false;
      const live = yield* read;
      if (!live || live.text !== candidate.text || live.memoryId !== candidate.memoryId) return false;
      if (!options.includeInactive && live.status !== undefined && live.status !== 'active') return false;
      if (
        !options.includeInactive &&
        ((live.validFrom !== undefined && Date.parse(live.validFrom) > now) ||
          (live.validTo !== undefined && Date.parse(live.validTo) < now))
      )
        return false;
      if (!options.includeInactive && /\/(archived|expired|superseded)\//u.test(candidate.uri)) return false;
      return (
        recallIndexCandidateIsEligible(options.eligibility, live) &&
        recallProjectMatches(options.project, live.fields?.project) &&
        recallWorkspaceScopeMatches(options.workspaceScope, live.fields?.workspaceScope, options.workspaceScopeMode) &&
        // Serve only the still-current projection; metadata changes wait for maintenance too.
        JSON.stringify(live.fields) === JSON.stringify(candidate.fields) &&
        live.authority === candidate.authority &&
        live.trust === candidate.trust &&
        live.status === candidate.status &&
        live.validFrom === candidate.validFrom &&
        live.validTo === candidate.validTo
      );
    });
});
