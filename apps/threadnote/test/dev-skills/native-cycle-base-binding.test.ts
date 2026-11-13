import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {bindNativeCycleDeliveryBase} from '../../src/workflow_automation/cycle_delivery.js';
import {fixture, object, run as lifecycleRun, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive);
const git = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args]).pipe(
    Effect.map(result => EffectString.trim(result.stdout)),
  );
const setup = Effect.fn('test.baseBinding.setup')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-base-binding-'});
  yield* git(repo, ['init', '--initial-branch=main']);
  yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const fixture = true;\n');
  yield* git(repo, ['add', 'source.ts']);
  yield* git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const head = yield* git(repo, ['rev-parse', 'HEAD']);
  yield* git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  yield* git(repo, ['update-ref', 'refs/remotes/origin/main', head]);
  const delivery = {
    phaseId: 'one',
    phaseHash: EffectString.repeat(64)('1'),
    delivery: 'pr',
    headSha: head,
    validatedTree: yield* git(repo, ['rev-parse', 'HEAD^{tree}']),
    commitEvidence: 'Actual fixture commit.',
    pr: {
      url: 'https://github.com/example/repo/pull/1',
      headSha: head,
      branch: 'feature/one',
      baseBranch: 'main',
      state: 'merged',
    },
  };
  const inventory = () =>
    Effect.gen(function* () {
      return {
        index: Array.from(yield* fs.readFile(path.join(repo, '.git', 'index'))),
        config: yield* fs.readFileString(path.join(repo, '.git', 'config')),
        refs: yield* git(repo, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']),
        status: yield* git(repo, ['status', '--porcelain=v2']),
      };
    });
  return {repo, head, delivery, inventory};
});

describe('native cycle remote base binding', () => {
  effectIt.effect('proves short/full refs and supported transport identities without changing Git state', () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* git(f.repo, ['remote', 'add', 'other', 'https://github.com/other/disjoint.git']);
      const beforePhysicalMismatch = yield* f.inventory();
      expect(
        yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', {
          ...f.delivery,
          pr: {...f.delivery.pr, baseBranch: 'origin/main'},
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'base-ref-unverified'}});
      expect(yield* f.inventory()).toEqual(beforePhysicalMismatch);

      for (const url of [
        'https://github.com/Example/Repo.git',
        'git@github.com:example/repo.git',
        'ssh://git@github.com/example/repo.git',
      ]) {
        yield* git(f.repo, ['remote', 'set-url', 'origin', url]);
        const before = yield* f.inventory();
        for (const ref of ['origin/main', 'refs/remotes/origin/main']) {
          const bound = yield* bindNativeCycleDeliveryBase(f.repo, ref, f.delivery);
          expect(bound.pr?.baseBranch).toBe('main');
          expect(bound.pr?.baseRefBinding).toEqual({
            ref: 'refs/remotes/origin/main',
            remote: 'origin',
            repository: 'https://github.com/example/repo',
          });
        }
        expect(yield* f.inventory()).toEqual(before);
      }
    }).pipe(run),
  );

  effectIt.effect('rejects unsupported, overlapping, duplicate and negative fetch mappings without writes', () =>
    Effect.gen(function* () {
      const f = yield* setup();
      for (const specs of [
        ['+refs/heads/*:refs/remotes/other/*'],
        ['+refs/heads/*:refs/remotes/origin/*', '^refs/heads/private/*'],
        ['+refs/heads/*:refs/remotes/origin/*', '+refs/heads/*:refs/remotes/origin/*'],
      ]) {
        yield* git(f.repo, ['config', '--unset-all', 'remote.origin.fetch']);
        for (const spec of specs) yield* git(f.repo, ['config', '--add', 'remote.origin.fetch', spec]);
        const before = yield* f.inventory();
        expect(yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', f.delivery).pipe(Effect.result)).toMatchObject(
          {failure: {code: 'base-ref-unverified'}},
        );
        expect(yield* f.inventory()).toEqual(before);
      }
      yield* git(f.repo, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      yield* git(f.repo, ['remote', 'add', 'fork', 'https://github.com/example/repo.git']);
      yield* git(f.repo, ['config', 'remote.fork.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      expect(yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', f.delivery).pipe(Effect.result)).toMatchObject({
        failure: {code: 'base-ref-unverified'},
      });
    }).pipe(run),
  );

  effectIt.effect(
    'rejects wrong fetch identities, credentials, helpers and aliases despite matching push identity',
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        yield* git(f.repo, ['remote', 'set-url', '--push', 'origin', 'https://github.com/example/repo.git']);
        for (const url of [
          'https://github.com/other/repo.git',
          'https://github.com/example/other.git',
          'https://other.invalid/example/repo.git',
          'https://name:private-value@github.com/example/repo.git',
          'git@github-alias:example/repo.git',
          'file:///example/repo',
          'ext::helper',
          'https://github.com/example/repo.git?query',
        ]) {
          yield* git(f.repo, ['remote', 'set-url', 'origin', url]);
          const before = yield* f.inventory();
          const result = yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', f.delivery).pipe(Effect.result);
          expect(result).toMatchObject({failure: {code: 'base-ref-unverified'}});
          expect(JSON.stringify(result)).not.toContain('private-value');
          expect(yield* f.inventory()).toEqual(before);
        }
      }).pipe(run),
  );

  effectIt.effect(
    'rejects ref expressions, shadows, aliases and caller proof while verifying exact local branch names',
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        for (const ref of ['origin/main~0', 'FETCH_HEAD', 'missing/main'])
          expect(yield* bindNativeCycleDeliveryBase(f.repo, ref, f.delivery).pipe(Effect.result)).toMatchObject({
            failure: {code: 'base-ref-unverified'},
          });
        yield* git(f.repo, ['tag', 'origin/main']);
        expect(yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', f.delivery).pipe(Effect.result)).toMatchObject(
          {failure: {code: 'base-ref-unverified'}},
        );
        yield* git(f.repo, ['tag', '-d', 'origin/main']);
        yield* git(f.repo, ['branch', 'origin/main']);
        expect(yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', f.delivery).pipe(Effect.result)).toMatchObject(
          {failure: {code: 'base-ref-unverified'}},
        );
        yield* git(f.repo, ['branch', '-D', 'origin/main']);
        yield* git(f.repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
        expect(yield* bindNativeCycleDeliveryBase(f.repo, 'origin/HEAD', f.delivery).pipe(Effect.result)).toMatchObject(
          {failure: {code: 'base-ref-unverified'}},
        );
        const forged = {
          ...f.delivery,
          pr: {
            ...f.delivery.pr,
            baseRefBinding: {
              ref: 'refs/remotes/origin/main',
              remote: 'origin',
              repository: 'https://github.com/example/repo',
            },
          },
        };
        expect(yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', forged).pipe(Effect.result)).toMatchObject({
          failure: {code: 'base-ref-unverified'},
        });
        expect(yield* bindNativeCycleDeliveryBase(f.repo, 'main', f.delivery)).toEqual(f.delivery);
        expect(
          yield* bindNativeCycleDeliveryBase('unused-no-repository', 'main', f.delivery).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'base-ref-unverified'}});
      }).pipe(run),
  );

  effectIt.effect('rejects configuration drift between probes', () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const executor = yield* CommandExecutor;
      let changed = false;
      const drifting = CommandExecutor.of({
        ...executor,
        execute: (executable, args, options) =>
          executor.execute(executable, args, options).pipe(
            Effect.tap(() => {
              if (!changed && args.includes('get-url')) {
                changed = true;
                return executor
                  .execute('git', ['-C', f.repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git'])
                  .pipe(Effect.asVoid);
              }
              return Effect.void;
            }),
          ),
      });
      expect(
        yield* bindNativeCycleDeliveryBase(f.repo, 'origin/main', f.delivery).pipe(
          Effect.provideService(CommandExecutor, drifting),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'base-ref-unverified'}});
      expect(changed).toBe(true);
    }).pipe(run),
  );

  effectIt.effect(
    'records the truthful provider base without rewriting native evidence and replays merged delivery offline',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one', 'two'], 'pr', false, false, false, {
          one: {branch: 'feature/one', baseBranch: 'origin/main'},
          two: {branch: 'feature/two', baseBranch: 'main'},
        });
        const base = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
        yield* f.git(['update-ref', 'refs/remotes/origin/main', base]);
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "bound";\n');
        const captured = object(object(yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'bound-1'})).snapshot);
        const snapshot = object(captured.snapshot);
        yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'bound-review',
          report: {
            snapshotId: snapshot.snapshotId,
            phaseHash: snapshot.phaseHash,
            snapshotTree: snapshot.tree,
            status: 'complete',
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        });
        yield* f.mutate('ready', {
          phaseId: 'one',
          snapshotId: snapshot.snapshotId,
          validation: {
            snapshotTree: snapshot.tree,
            reviewTree: snapshot.tree,
            status: 'passed',
            productState: 'working',
            checks: [{command: 'fixture', result: 'passed', evidence: 'Actual Git/native lifecycle.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Actual lifecycle.'}],
          },
        });
        const before = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Bound source']);
        const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        const publication = {exemption: 'maintenance', reason: 'Private fixture.'};
        const delivery = {
          phaseId: 'one',
          phaseHash: snapshot.phaseHash,
          delivery: 'pr',
          headSha: head,
          validatedTree: snapshot.tree,
          commitEvidence: 'Actual clean committed fixture.',
          pr: {
            url: 'https://github.com/example/repo/pull/1',
            headSha: head,
            branch: 'feature/one',
            baseBranch: 'main',
            state: 'open',
          },
          watch: {
            prUrl: 'https://github.com/example/repo/pull/1',
            headSha: head,
            state: 'active',
            stateDir: f.path.join(f.root, 'watch'),
            consumerKind: 'orchestrator',
            consumerId: 'fixture',
            evidence: 'Owned synthetic watch receipt.',
          },
        };
        const bytes = yield* f.fs.readFileString(f.statePath());
        expect(
          yield* f
            .mutate('record-delivery', {phaseId: 'one', publication, delivery: {...delivery, headSha: base}})
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure'});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
        const executor = yield* CommandExecutor;
        let sourceChanged = false;
        const sourceDrift = CommandExecutor.of({
          ...executor,
          execute: (executable, args, options) =>
            executor.execute(executable, args, options).pipe(
              Effect.tap(() => {
                if (!sourceChanged && args.includes('get-url')) {
                  sourceChanged = true;
                  return f.fs
                    .writeFileString(f.path.join(f.repo, 'source.ts'), 'export const drift = true;\n')
                    .pipe(Effect.orDie);
                }
                return Effect.void;
              }),
            ),
        });
        expect(
          yield* f
            .mutate('record-delivery', {phaseId: 'one', publication, delivery})
            .pipe(Effect.provideService(CommandExecutor, sourceDrift), Effect.result),
        ).toMatchObject({failure: {code: 'source-drift'}});
        expect(sourceChanged).toBe(true);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "bound";\n');
        yield* f.mutate('record-delivery', {phaseId: 'one', publication, delivery});
        const after = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        const canonicalOpenDelivery = after.state.phases.one.delivery;
        if (canonicalOpenDelivery?.delivery !== 'pr' || !canonicalOpenDelivery.pr || !canonicalOpenDelivery.watch)
          throw new Error('Expected the canonical stored open PR receipt and watch.');
        const mergedDelivery = {
          ...canonicalOpenDelivery,
          pr: {...canonicalOpenDelivery.pr, state: 'merged' as const},
          watch: {
            ...canonicalOpenDelivery.watch,
            state: 'terminal' as const,
            evidence: 'The owned watch observed merge.',
          },
        };
        for (const key of [
          'plans',
          'baselines',
          'snapshots',
          'reviews',
          'attempts',
          'reviewLimits',
          'reviewExpansions',
        ] as const)
          expect(after[key]).toEqual(before[key]);
        expect(after.state.plan).toEqual(before.state.plan);
        expect(after.state.phases.one.phaseHash).toBe(before.state.phases.one.phaseHash);
        expect(after.state.phases.one.delivery?.pr).toMatchObject({
          baseBranch: 'main',
          baseRefBinding: {ref: 'refs/remotes/origin/main'},
        });
        yield* f.git(['remote', 'remove', 'origin']);
        const publishedBytes = yield* f.fs.readFileString(f.statePath());
        expect(
          yield* f
            .mutate('record-delivery', {
              phaseId: 'one',
              publication,
              delivery: mergedDelivery,
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'base-ref-unverified'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(publishedBytes);
        yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
        yield* f.git(['update-ref', 'refs/remotes/origin/main', base]);
        yield* f.mutate('record-delivery', {
          phaseId: 'one',
          publication,
          delivery: mergedDelivery,
        });
        const merged = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        yield* f.git(['remote', 'remove', 'origin']);
        const mergedBytes = yield* f.fs.readFileString(f.statePath());
        yield* f.mutate('record-delivery', {phaseId: 'one', delivery: merged.state.phases.one.delivery});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(mergedBytes);
        expect(
          yield* f
            .mutate('record-delivery', {
              phaseId: 'one',
              delivery: {...merged.state.phases.one.delivery, commitEvidence: 'changed'},
            })
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure'});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(mergedBytes);
      }).pipe(lifecycleRun),
    windowsCycleFixtureTimeout,
  );
});
