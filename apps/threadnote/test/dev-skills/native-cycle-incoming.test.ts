import {it as effectIt} from '@effect/vitest';
import {Effect, Schema, Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {describe, expect} from 'vitest';
import {CommandExecutor, runBinaryCommandEffect} from '@threadnote/platform/command';
import {readNativeCycleTreeEntries, readNativeCycleTreeEntry} from '../../src/workflow_automation/cycle_git.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {nativeFixture} from './native-automation-fixture.js';
import {fixture, object, run, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

// Real Git is intentional: pathspec, object-format and mode behavior are the boundary under test.
const inventoryFixture = Effect.fn('test.incoming.inventoryFixture')(function* (format: 'sha1' | 'sha256') {
  const f = yield* nativeFixture();
  yield* f.fs.remove(f.path.join(f.repo, '.git'), {recursive: true});
  const git = (...args: string[]) => runBinaryCommandEffect('git', ['-C', f.repo, ...args]);
  yield* git('init', '--initial-branch=main', `--object-format=${format}`);
  yield* git('config', 'user.name', 'Fixture');
  yield* git('config', 'user.email', 'fixture@example.invalid');
  yield* f.fs.makeDirectory(f.path.join(f.repo, 'nested'));
  const names = ['plain', 'space name', 'nested/é [x]*', '!literal', 'nested/file'];
  for (const name of names) yield* f.fs.writeFileString(f.path.join(f.repo, name), name + '\n');
  yield* git('add', '--all');
  const blob = EffectString.trim(new TextDecoder().decode((yield* git('hash-object', '-w', '--stdin')).stdout));
  yield* git('update-index', '--add', '--cacheinfo', `100755,${blob},script`);
  yield* git('update-index', '--add', '--cacheinfo', `120000,${blob},link`);
  yield* git('commit', '-m', 'Inventory modes');
  const head = EffectString.trim(new TextDecoder().decode((yield* git('rev-parse', 'HEAD')).stdout));
  yield* git('update-index', '--add', '--cacheinfo', `160000,${head},module`);
  yield* git('commit', '-m', 'Inventory gitlink');
  return {...f, names: [...names, 'script', 'link', 'module', 'missing', 'nested'], git};
});

describe('bounded incoming tree inventories', () => {
  effectIt.effect.prop(
    'bulk lookup equals exact single-entry lookup under request permutation and duplication',
    {order: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 9}))).check(Schema.isMaxLength(16))},
    ({order}) =>
      Effect.gen(function* () {
        for (const format of ['sha1', 'sha256'] as const) {
          const f = yield* inventoryFixture(format);
          const paths = EffectArray.map(order, index => f.names[index]);
          const actual = yield* readNativeCycleTreeEntries(f.repo, 'HEAD', paths);
          for (const name of new Set(paths))
            expect(actual[name]).toEqual(yield* readNativeCycleTreeEntry(f.repo, 'HEAD', name));
          const all = yield* readNativeCycleTreeEntries(f.repo, 'HEAD', f.names);
          expect(all.script.mode).toBe('100755');
          expect(all.link.mode).toBe('120000');
          expect(all.module.mode).toBe('160000');
          expect(all.missing).toEqual({mode: '000000', blob: EffectString.repeat(format === 'sha1' ? 40 : 64)('0')});
          expect(all.nested).toEqual(all.missing);
        }
      }).pipe(run),
    {arbitrary: {runs: 5}},
  );

  effectIt.effect('resolves a tree once and bounds Git probes for 2,720 requested paths', () =>
    Effect.gen(function* () {
      const f = yield* inventoryFixture('sha1');
      const commands = yield* CommandExecutor;
      const probes: string[][] = [];
      const entries = yield* readNativeCycleTreeEntries(
        f.repo,
        'HEAD',
        Array.from({length: 2720}, (_, i) => `missing-${i}`),
      ).pipe(
        Effect.provideService(CommandExecutor, {
          ...commands,
          executeBytes: (executable, args, options) => {
            probes.push([...args]);
            return commands.executeBytes!(executable, args, options);
          },
        }),
      );
      expect(EffectRecord.keys(entries)).toHaveLength(2720);
      expect(EffectArray.filter(probes, args => args.includes('ls-tree'))).toHaveLength(22);
      expect(EffectArray.filter(probes, args => args.includes('rev-parse'))).toHaveLength(2);
    }).pipe(run),
  );

  effectIt.effect(
    'retains baseline, upstream identities and reviewed history across a large rebase and source iteration',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one', 'two'], 'local', true);
        const readCycle = () =>
          readNativeWorkflowState(f.config, 'native-run').pipe(
            Effect.map(stored => {
              if (!stored?.state.cycle) throw new Error('Expected initialized cycle.');
              return stored.state.cycle;
            }),
          );
        const before = (yield* readCycle()).baselines.one;
        yield* f.git(['stash', 'push', '-m', 'Preserved original user work']);
        yield* f.git(['checkout', 'main']);
        yield* f.fs.makeDirectory(f.path.join(f.repo, 'incoming'));
        for (let i = 0; i < 2720; i++)
          yield* f.fs.writeFileString(f.path.join(f.repo, 'incoming', `${i}.txt`), `upstream ${i}\n`);
        yield* f.git(['add', 'incoming']);
        yield* f.git(['commit', '-m', 'Large upstream']);
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['rebase', 'main']);
        yield* f.git(['stash', 'pop', '--index']);
        const acceptedHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'phase iteration one\n');
        yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'bulk-one',
          acceptedHead,
          reason: 'Legitimate upstream rebase.',
        });
        let runtime = yield* readCycle();
        const first = runtime.snapshots[0].snapshot;
        expect(runtime.baselines.one).toEqual(before);
        expect(runtime.snapshots[0].incoming).toHaveLength(2721);
        expect(EffectArray.filter(runtime.snapshots[0].incoming, entry => entry.source === 'upstream')).toHaveLength(
          2720,
        );
        expect(
          object(
            yield* f.mutate('validate-review', {
              snapshotId: 'bulk-one',
              attemptId: 'bulk-review',
              report: {
                snapshotId: 'bulk-one',
                phaseHash: first.phaseHash,
                snapshotTree: first.tree,
                status: 'complete',
                mode: 'full',
                selected: ['correctness', 'simplicity'],
                lanes: [
                  {name: 'correctness', status: 'complete'},
                  {name: 'simplicity', status: 'complete'},
                ],
                findings: [],
              },
            }),
          ).status,
        ).toBe('ok');
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'phase iteration two\n');
        yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'bulk-two', previous: 'bulk-one'});
        runtime = yield* readCycle();
        expect(runtime.baselines.one).toEqual(before);
        expect(runtime.reviews).toHaveLength(1);
        expect(runtime.snapshots).toHaveLength(2);
        expect(runtime.snapshots[1].incoming).toEqual(runtime.snapshots[0].incoming);
        const second = runtime.snapshots[1].snapshot;
        yield* f.mutate('validate-review', {
          snapshotId: 'bulk-two',
          attemptId: 'bulk-review-two',
          report: {
            snapshotId: 'bulk-two',
            phaseHash: second.phaseHash,
            snapshotTree: second.tree,
            status: 'complete',
            mode: 'incremental',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        });
        yield* f.fs.writeFileString(f.path.join(f.repo, 'incoming', '42.txt'), 'unauthorized change\n');
        expect(
          yield* f
            .mutate('snapshot', {phaseId: 'one', snapshotId: 'tampered', previous: 'bulk-two'})
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'phase-scope'}});
      }).pipe(run),
    windowsCycleFixtureTimeout,
  );
});
