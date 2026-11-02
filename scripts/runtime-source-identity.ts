import {ScriptError} from './effect/errors.js';
import {Effect, String as EffectString} from 'effect';

/** Dirty/source builds remain usable, but cannot authorize an isolated canonical writer. */
export const runtimeSourceIdentity = Effect.fn('build.runtimeSourceIdentity')(function* (root: string, target: string) {
  const git = (args: readonly string[]) =>
    Effect.try(() => {
      const result = Bun.spawnSync({cmd: ['git', '-C', root, ...args], stdout: 'pipe', stderr: 'ignore'});
      return result.exitCode === 0 ? EffectString.trim(result.stdout.toString()) : undefined;
    });
  const status = yield* git(['status', '--porcelain', '--untracked-files=normal']);
  if (status !== '') return undefined;
  const commit = yield* git(['rev-parse', 'HEAD']);
  const tree = yield* git(['rev-parse', 'HEAD^{tree}']);
  if (
    !commit ||
    !tree ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)
  )
    return undefined;
  return {version: 1 as const, commit, tree, bun: Bun.version, target};
});

export const assertRuntimeSourceIdentity = Effect.fn('build.assertRuntimeSourceIdentity')(function* (
  root: string,
  target: string,
  identity: Effect.Success<ReturnType<typeof runtimeSourceIdentity>>,
) {
  if (identity && JSON.stringify(yield* runtimeSourceIdentity(root, target)) !== JSON.stringify(identity))
    return yield* ScriptError.make({message: 'Compiled runtime source changed during the build; discard this output.'});
});
