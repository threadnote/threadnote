import {Effect, String as EffectString} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {reviewed, run, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

type Reviewed = Effect.Success<ReturnType<typeof reviewed>>;
type Git = (args: readonly string[]) => ReturnType<typeof runCommandEffect>;

const validate = (f: Reviewed) =>
  f.mutate('validate-review', {snapshotId: f.snapshot.snapshotId, attemptId: 'review-1', report: f.report});
const ready = (f: Reviewed) =>
  f.mutate('ready', {
    phaseId: 'one',
    snapshotId: f.snapshot.snapshotId,
    validation: {
      snapshotTree: f.snapshot.tree,
      reviewTree: f.snapshot.tree,
      status: 'passed',
      productState: 'working',
      checks: [{command: 'private flow', result: 'passed', evidence: 'Real source fixture.'}],
      acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private source readback.'}],
    },
  });
/** Advances `main` through a temporary linked worktree so the phase checkout is never disturbed. */
const advanceMain = (f: Reviewed, edit: (git: Git, dir: string) => Effect.Effect<unknown, unknown, CommandExecutor>) =>
  Effect.gen(function* () {
    const dir = f.path.join(yield* f.fs.makeTempDirectoryScoped({prefix: 'threadnote-advance-'}), 'wt');
    yield* f.git(['worktree', 'add', dir, 'main']);
    const git: Git = args =>
      runCommandEffect('git', [
        '-C',
        dir,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ]);
    yield* edit(git, dir);
    yield* f.git(['worktree', 'remove', '--force', dir]);
  });

describe('native cycle base advance', () => {
  effectIt.effect(
    'delivers after a disjoint base advance and keeps the reviewed base evidence',
    () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        yield* validate(f);
        yield* advanceMain(f, (git, dir) =>
          Effect.gen(function* () {
            yield* f.fs.writeFileString(f.path.join(dir, 'unrelated.ts'), 'export const unrelated = true;\n');
            yield* git(['add', 'unrelated.ts']);
            yield* git(['commit', '-m', 'Disjoint base advance']);
          }),
        );
        expect((yield* ready(f)).next).toEqual({action: 'deliver', phaseId: 'one'});
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Phase one']);
        const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/private-fixture.git']);
        const providerIdentity = {
          url: 'https://github.com/example/private-fixture/pull/1',
          number: 1,
          baseRepository: 'example/private-fixture',
          headRepository: 'example/private-fixture',
          baseBranch: 'main',
          headBranch: 'feature/one',
          headSha: head,
          state: 'open' as const,
        };
        const executor = yield* CommandExecutor;
        const provider = CommandExecutor.of({
          ...executor,
          execute: (executable, args, options) =>
            executable === 'gh' && args.includes('--jq')
              ? Effect.succeed({exitCode: 0, stderr: '', stdout: JSON.stringify({...providerIdentity, merged: false})})
              : executor.execute(executable, args, options),
        });
        const before = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        const delivered = yield* f
          .mutate('record-delivery', {
            phaseId: 'one',
            delivery: {
              phaseId: 'one',
              phaseHash: f.snapshot.phaseHash,
              delivery: 'pr',
              userAuthority: 'The fixture user approved this exact phase PR delivery.',
              providerIdentity,
              headSha: head,
              validatedTree: f.snapshot.tree,
              commitEvidence: 'Actual clean Git commit.',
              pr: {url: providerIdentity.url, headSha: head, branch: 'feature/one', baseBranch: 'main', state: 'open'},
              watch: {
                prUrl: providerIdentity.url,
                headSha: head,
                state: 'active',
                stateDir: f.path.join(f.root, 'watch'),
                consumerKind: 'orchestrator',
                consumerId: 'test',
                evidence: 'Private owned consumer fixture; no external poller.',
              },
            },
          })
          .pipe(Effect.provideService(CommandExecutor, provider));
        expect(delivered.next).toEqual({action: 'implement', phaseId: 'two'});
        const after = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        // Delivery never rewrites the reviewed snapshot, so its declared base evidence stays the pre-advance head.
        expect(after.snapshots).toEqual(before.snapshots);
        const main = EffectString.trim((yield* f.git(['rev-parse', 'main'])).stdout);
        expect(main).not.toBe(before.snapshots.at(-1)?.snapshot.declaredBaseHead);
      }).pipe(run),
    windowsCycleFixtureTimeout,
  );

  const refusals: readonly [string, (f: Reviewed) => Parameters<typeof advanceMain>[1], string | undefined][] = [
    [
      'overlapping',
      f => (git, dir) =>
        Effect.gen(function* () {
          yield* f.fs.writeFileString(f.path.join(dir, 'source.ts'), 'export const fixture = "main edit";\n');
          yield* git(['commit', '-am', 'Overlapping base advance']);
        }),
      'source.ts',
    ],
    [
      'case-variant',
      () => git =>
        Effect.gen(function* () {
          // Index-only, so a case-insensitive filesystem cannot fold the new path into the reviewed file.
          const blob = EffectString.trim((yield* git(['rev-parse', 'HEAD:source.ts'])).stdout);
          yield* git(['update-index', '--add', '--cacheinfo', `100644,${blob},Source.ts`]);
          yield* git(['commit', '-m', 'Case-variant path']);
        }),
      'Source.ts',
    ],
    [
      'rename-away-from-scope',
      () => git =>
        Effect.gen(function* () {
          yield* git(['mv', 'source.ts', 'moved.ts']);
          yield* git(['commit', '-m', 'Rename reviewed file']);
        }),
      'source.ts',
    ],
    [
      'rewritten',
      () => git =>
        Effect.gen(function* () {
          // The declared base head is no longer an ancestor of the new main.
          yield* git(['checkout', '--orphan', 'replacement']);
          yield* git(['commit', '--allow-empty', '-m', 'Unrelated history']);
          yield* git(['branch', '-f', 'main', 'HEAD']);
        }),
      undefined,
    ],
  ];
  for (const [name, edit, path] of refusals)
    effectIt.effect(`refuses a ${name} base advance as review-stale with recovery`, () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        yield* validate(f);
        yield* advanceMain(f, edit(f));
        expect(yield* ready(f).pipe(Effect.result)).toMatchObject({
          failure: {code: 'review-stale', ...(path ? {message: expect.stringContaining(path)} : {})},
        });
      }).pipe(run),
    );
});
