import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {graphSharingFailure} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const GRAPH_SHARE_GIT_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;

export function isGraphShareGitObjectId(value: string): boolean {
  return GRAPH_SHARE_GIT_OBJECT_ID.test(value);
}

export function graphShareCommitIsAncestor(repoRoot: string, ancestor: string, descendant: string) {
  return Effect.gen(function* () {
    if (!isGraphShareGitObjectId(ancestor) || !isGraphShareGitObjectId(descendant)) return false;
    if (ancestor === descendant) return true;
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect(
      'git',
      ['-C', repoRoot, 'merge-base', '--is-ancestor', '--', ancestor, descendant],
      {
        allowFailure: true,
        env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
        maxOutputBytes: 4_096,
        timeoutMs: 10_000,
      },
    );
    return result.exitCode === 0;
  });
}

export function graphShareCommitDiffStats(repoRoot: string, from: string, to: string) {
  return Effect.gen(function* () {
    if (!isGraphShareGitObjectId(from) || !isGraphShareGitObjectId(to) || from === to) {
      return {changedBytes: 0, changedFiles: 0};
    }
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect('git', ['-C', repoRoot, 'diff', '--numstat', '--', from, to], {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      maxOutputBytes: 1_048_576,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return {changedBytes: 0, changedFiles: 0};
    let changedBytes = 0;
    let changedFiles = 0;
    for (const line of Effect2.pipe(result.stdout, EffectString.split('\n'))) {
      const match = /^(\d+|-)\t(\d+|-)\t/u.exec(line);
      if (match === null) continue;
      changedFiles += 1;
      changedBytes += (match[1] === '-' ? 0 : Number(match[1])) + (match[2] === '-' ? 0 : Number(match[2]));
    }
    return {changedBytes, changedFiles};
  });
}

export const graphShareCommitUnixSeconds = (repoRoot: string, commit: string) =>
  Effect.gen(function* () {
    if (!isGraphShareGitObjectId(commit)) return undefined;
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect('git', ['-C', repoRoot, 'log', '-1', '--format=%ct', commit], {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      maxOutputBytes: 64,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return undefined;
    const value = Number(Effect2.pipe(result.stdout, EffectString.trim));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  });

export const assertGraphShareCommitChain = Effect.fn('codeGraph.sharing.assertCommitChain')(function* (
  repoRoot: string,
  commits: readonly string[],
) {
  for (let index = 1; index < commits.length; index += 1) {
    const ancestor = commits[index - 1];
    const descendant = commits[index];
    if (ancestor === undefined || descendant === undefined) {
      return yield* graphSharingFailure('Frontier Git ancestry chain is invalid.');
    }
    if (!(yield* graphShareCommitIsAncestor(repoRoot, ancestor, descendant))) {
      return yield* graphSharingFailure('Frontier delta is not a Git descendant of its published base.');
    }
  }
});

export function graphShareBlobExists(repoRoot: string, blobId: string) {
  return Effect.gen(function* () {
    if (!isGraphShareGitObjectId(blobId)) return false;
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect('git', ['-C', repoRoot, 'cat-file', '-e', '--', blobId], {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      maxOutputBytes: 4_096,
      timeoutMs: 10_000,
    });
    return result.exitCode === 0;
  });
}
