import {Array as EffectArray, Cause, Effect, Record as EffectRecord} from 'effect';
import {recallLocalShareAccess} from '@threadnote/recall/sections_read';
import type {RecallHit} from '@threadnote/recall/results';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {readTeamsFile} from '../share/index.js';

const MAX_CLOSING_URIS = 4096;

function currentShareRoots(config: RuntimeConfig) {
  const root = `threadnote://user/${uriSegment(config.user)}/memories/shared`;
  return readTeamsFile(config).pipe(
    Effect.map(file =>
      EffectArray.map(
        EffectArray.filter(EffectRecord.keys(file.teams), name => /^[a-z0-9][a-z0-9._-]*$/u.test(name)).sort(),
        name => `${root}/${name}`,
      ),
    ),
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause),
      () => Effect.succeed([]),
    ),
  );
}

/** Local Git membership can change before canonical mirror cleanup finishes. */
export function closeRecallWithShareScope<A, E, R>(
  config: RuntimeConfig,
  ranked: readonly RecallHit[],
  limit: number,
  fuse: boolean,
  close: (uris: readonly string[], closingRead: boolean, roots?: readonly string[]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    if (!fuse) {
      const uris = EffectArray.map(ranked.slice(0, limit), hit => hit.uri);
      return {result: yield* close(uris, true), allowsUri: undefined};
    }
    const roots = yield* currentShareRoots(config);
    const allowsUri = recallLocalShareAccess(config.user, roots);
    const windows = EffectArray.filter(
      EffectArray.map(ranked, hit => EffectArray.filter([hit.uri, ...(hit.equivalentUris ?? [])], allowsUri)),
      uris => uris.length > 0,
    );
    const selected = windows.slice(0, limit);
    const representatives = EffectArray.flatMap(selected, uris => uris.slice(0, 1));
    const aliases = EffectArray.flatMap(selected, uris => uris.slice(1));
    const authorized = [...new Set([...representatives, ...aliases])].slice(0, MAX_CLOSING_URIS);
    const result = yield* close(authorized, true, roots);
    if (roots.length === 0) return {result, allowsUri};
    const current = yield* currentShareRoots(config);
    if (EffectArray.join(roots, '\n') === EffectArray.join(current, '\n')) return {result, allowsUri};
    return {result: yield* close([], true, []), allowsUri: recallLocalShareAccess(config.user, [])};
  });
}
