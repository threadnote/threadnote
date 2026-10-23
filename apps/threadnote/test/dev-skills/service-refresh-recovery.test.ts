import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {
  applyDevSkills,
  prepareDevSkillsRefresh,
  previewDevSkillsRefresh,
  runDevSkillsRefresh,
} from '../../src/dev_skills/index.js';
import {homeIndexPath, journalPath, receiptPath, runtimeIndexPath} from '../../src/dev_skills/registry.js';
import {devSkillsReleaseFixture, devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const selector = {agent: 'codex'};
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));

const removalRecovery = (boundary: 'journal' | 'receipt' | 'home' | 'runtime', shared: boolean) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const old = yield* devSkillsReleaseFixture(f, '5.3.0-beta.6');
    yield* old.activate;
    const installed = yield* old.run(applyDevSkills(f.config, 'install', selector));
    const other = {...f.config, agentContextHome: f.path.join(f.root, 'other-home')};
    if (shared) yield* old.run(applyDevSkills(other, 'install', selector));
    const files = {
      journal: journalPath(f.path, installed.target.skillRoot),
      receipt: receiptPath(f.path, installed.target.skillRoot),
      home: homeIndexPath(f.path, f.home),
      runtime: runtimeIndexPath(f.path, f.runtime),
    };
    const originalReceipt = yield* f.fs.readFileString(files.receipt);
    let interrupted = false;
    const failing = FileSystem.FileSystem.of({
      ...f.fs,
      rename: (from, to) => {
        if (!interrupted && to === files[boundary]) {
          interrupted = true;
          return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'absent'), to)));
        }
        return f.fs.rename(from, to);
      },
    });
    expect(
      yield* old
        .run(applyDevSkills(f.config, 'remove', selector))
        .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
    ).toMatchObject({_tag: 'Failure'});
    expect(interrupted).toBe(true);
    expect(yield* f.fs.exists(files.journal)).toBe(true);
    const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.7');
    const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
    const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
    yield* release.activate;
    const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
    expect(result.repairRequired).toBe(false);
    expect(result.targets.find(target => target.consumerId === installed.consumerId)?.outcome.state).toBe('skipped');
    expect(yield* f.fs.exists(files.journal)).toBe(false);
    const home = JSON.parse(yield* f.fs.readFileString(files.home));
    const runtime = JSON.parse(yield* f.fs.readFileString(files.runtime));
    expect(home.targets[installed.consumerId]).toMatchObject({state: 'removed', enabled: false});
    expect(runtime.enrollments[installed.consumerId]).toEqual(home.targets[installed.consumerId]);
    const receipt = JSON.parse(yield* f.fs.readFileString(files.receipt));
    expect(receipt.consumers[installed.consumerId]).toBeUndefined();
    expect(Object.keys(receipt.consumers)).toHaveLength(shared ? 1 : 0);
    expect(receipt.generations[installed.bundleDigest]).toEqual(JSON.parse(originalReceipt).manifest);
    if (shared) {
      expect(result.targets.map(target => target.outcome.state).sort()).toEqual(['current', 'skipped']);
      expect(receipt.manifest.digest).toBe(release.bundle.manifest.digest);
    } else {
      expect(receipt.manifest).toEqual(JSON.parse(originalReceipt).manifest);
      expect(receipt.entrypoints).toEqual({});
      expect(receipt.generations[release.bundle.manifest.digest]).toBeUndefined();
    }
    expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(false);
  }).pipe(provide);

for (const boundary of ['journal', 'receipt', 'home', 'runtime'] as const)
  effectIt.effect(`skips a consumer removed by recovery after the ${boundary} checkpoint`, () =>
    removalRecovery(boundary, false),
  );

effectIt.effect.prop(
  'refresh completes an interrupted removal before deciding ownership or enablement',
  {boundary: Schema.Literals(['journal', 'receipt', 'home', 'runtime']), shared: Schema.Boolean},
  ({boundary, shared}) => removalRecovery(boundary, shared),
  {arbitrary: {runs: 8}, timeout: 120_000},
);

for (const conflict of ['missing-receipt', 'different-owner', 'third-party-edit'] as const)
  effectIt.effect(`preserves a genuine ${conflict} without recovery authority`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
      const file = receiptPath(f.path, installed.target.skillRoot);
      if (conflict === 'missing-receipt') yield* f.fs.remove(file);
      else if (conflict === 'different-owner') {
        const receipt = JSON.parse(yield* f.fs.readFileString(file));
        receipt.consumers[installed.consumerId].installationRoot = f.path.join(f.root, 'foreign-runtime');
        yield* f.fs.writeFileString(file, JSON.stringify(receipt));
      } else yield* f.fs.writeFileString(f.path.join(installed.target.skillRoot, 'dev-plan/SKILL.md'), 'user edit');
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.7');
      const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
      const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
      yield* release.activate;
      const before = yield* snapshot(f.host);
      const home = yield* f.fs.readFileString(homeIndexPath(f.path, f.home));
      const runtime = yield* f.fs.readFileString(runtimeIndexPath(f.path, f.runtime));
      const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
      expect(result.repairRequired).toBe(true);
      expect(result.targets[0].outcome).toMatchObject({state: 'pending', issues: [{code: 'refresh-pending'}]});
      expect(yield* snapshot(f.host)).toEqual(before);
      expect(yield* f.fs.readFileString(homeIndexPath(f.path, f.home))).toBe(home);
      expect(yield* f.fs.readFileString(runtimeIndexPath(f.path, f.runtime))).toBe(runtime);
    }).pipe(provide),
  );
