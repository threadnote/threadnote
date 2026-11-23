import {Array as EffectArray, Cause, Effect, Record as EffectRecord} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {readTeamsFile} from '../share/index.js';

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
export function withRecallBodyShareScope<A, E, R>(
  config: RuntimeConfig,
  close: (roots: readonly string[], membershipChanged: boolean) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const roots = yield* currentShareRoots(config);
    const result = yield* close(roots, false);
    if (roots.length === 0) return result;
    const current = yield* currentShareRoots(config);
    if (EffectArray.join(roots, '\n') === EffectArray.join(current, '\n')) return result;
    return yield* close([], true);
  });
}
