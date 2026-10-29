import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  applyDevSkills,
  ensureDevSkills,
  statusDevSkills,
  undoDevSkillsEnsure,
  withDevSkillsMutationLease,
} from '../../src/dev_skills/index.js';
import {consumerId, enrollmentContext, homeIndexPath, runtimeIndexPath} from '../../src/dev_skills/registry.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {devSkillsTestLayer, fixture, snapshot, devSkillsReleaseFixture} from './service-fixture.js';
import * as EffectRecord from 'effect/Record';

const selector = {agent: 'codex'};
describe('workflow setup ownership and enablement', () => {
  effectIt.effect('opt-out before enrollment persists independently and default setup never re-enables it', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const disabled = yield* f.run(
        ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'disabled', operationId: 'disable'}),
      );
      expect(disabled.state).toBe('disabled');
      expect(yield* f.fs.exists(f.path.join(f.host, '.agents/skills/.threadnote-dev-skills/receipt.json'))).toBe(false);
      const state = yield* f.run(statusDevSkills(f.config, selector));
      expect(state.targets[0]).toMatchObject({enrollmentState: 'removed', enabled: false, enrolled: false});
      const repeat = yield* f.run(
        ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'default', operationId: 'later'}),
      );
      expect(repeat.state).toBe('disabled');
      yield* f.run(applyDevSkills(f.config, 'install', selector));
      expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0]).toMatchObject({
        enrollmentState: 'enrolled',
        enabled: true,
      });
    }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
  );
  effectIt.effect(
    'setup checkpoint replays created ownership, restores only missing owned files, and undo does not affect later explicit ownership',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const options = {mode: 'setup', choice: 'default', operationId: 'setup-a'} as const;
        const first = yield* f.run(
          withDevSkillsMutationLease(f.config, lease => ensureDevSkills(f.config, selector, {...options, lease})),
        );
        expect(first).toMatchObject({state: 'installed', createdConsumer: true});
        const next = yield* f.run(ensureDevSkills(f.config, selector, options));
        expect(next).toMatchObject({state: 'current', createdConsumer: true});
        const target = (yield* f.run(statusDevSkills(f.config, selector))).targets[0].target;
        const file = f.path.join(target.skillRoot, 'dev-plan/SKILL.md');
        const body = yield* f.fs.readFileString(file);
        yield* f.fs.remove(file);
        expect((yield* f.run(ensureDevSkills(f.config, selector, {mode: 'maintenance'}))).state).toBe('installed');
        expect(yield* f.fs.readFileString(file)).toBe(body);
        yield* f.fs.writeFileString(file, 'user edit');
        expect((yield* f.run(ensureDevSkills(f.config, selector, {mode: 'maintenance'}))).state).toBe('pending');
        expect(yield* f.fs.readFileString(file)).toBe('user edit');
        yield* f.fs.writeFileString(file, body);
        yield* f.run(applyDevSkills(f.config, 'remove', selector));
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        yield* f.run(undoDevSkillsEnsure(f.config, 'setup-a'));
        expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0].enrolled).toBe(true);
      }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
  );
  effectIt.effect('undo removes only newly created consumer and legacy reads normalize without writing', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'default', operationId: 'new'}));
      yield* f.run(ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'default', operationId: 'reused'}));
      yield* f.run(undoDevSkillsEnsure(f.config, 'reused'));
      expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0].enrolled).toBe(true);
      const context = yield* f.run(enrollmentContext(f.config));
      const legacy = (entries: typeof context.homeIndex.targets) =>
        EffectRecord.fromEntries(
          EffectArray.map(EffectRecord.toEntries(entries), ([id, entry]) => {
            const {enabled: _e, createdBy: _c, ...rest} = entry;
            return [id, rest];
          }),
        );
      yield* f.fs.writeFileString(
        homeIndexPath(f.path, f.home),
        JSON.stringify({...context.homeIndex, schemaVersion: 1, targets: legacy(context.homeIndex.targets)}),
      );
      yield* f.fs.writeFileString(
        runtimeIndexPath(f.path, f.runtime),
        JSON.stringify({
          ...context.runtimeIndex,
          schemaVersion: 1,
          enrollments: legacy(context.runtimeIndex.enrollments),
        }),
      );
      const before = yield* snapshot(f.root);
      const read = yield* f.run(statusDevSkills(f.config, selector));
      expect(read.targets[0].enabled).toBe(true);
      expect(yield* snapshot(f.root)).toEqual(before);
      // A legacy owner has no new setup provenance; a stale checkpoint cannot take it over.
      yield* f.run(undoDevSkillsEnsure(f.config, 'new'));
      expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0].enrolled).toBe(true);
      expect(consumerId(EffectRecord.values(context.homeIndex.targets)[0])).toBe(read.targets[0].consumerId);
    }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
  );
  effectIt.effect('owned maintenance converges the active payload; new-consumer undo preserves helpers', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.run(
        ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'default', operationId: 'new-owner'}),
      );
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const updated = yield* release.run(ensureDevSkills(f.config, selector, {mode: 'maintenance'}));
      expect(updated.state).toBe('installed');
      expect((yield* release.run(statusDevSkills(f.config, selector))).targets[0].installed?.digest).toBe(
        release.bundle.manifest.digest,
      );
      yield* release.run(undoDevSkillsEnsure(f.config, 'new-owner'));
      expect((yield* release.run(statusDevSkills(f.config, selector))).targets[0]).toMatchObject({
        enrolled: false,
        enabled: false,
      });
      expect(
        yield* f.fs.exists(
          f.path.join(
            installed.result!.target.skillRoot,
            '.threadnote-dev-skills/generations',
            installed.result!.bundleDigest,
          ),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
  );
  effectIt.effect(
    'recovers registry-only opt-out after a home-index response loss without creating a physical root',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let failed = false;
        const failing = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) => {
            if (!failed && to === homeIndexPath(f.path, f.home)) {
              failed = true;
              return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), to)));
            }
            return f.fs.rename(from, to);
          },
        });
        const options = {mode: 'setup', choice: 'disabled', operationId: 'disabled-interrupted'} as const;
        expect(
          yield* f
            .run(ensureDevSkills(f.config, selector, options))
            .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
        ).toMatchObject({_tag: 'Failure'});
        expect((yield* f.run(ensureDevSkills(f.config, selector, options))).state).toBe('disabled');
        expect(yield* f.fs.exists(f.path.join(f.host, '.agents'))).toBe(false);
        expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0]).toMatchObject({
          enrollmentState: 'removed',
          enabled: false,
        });
        expect(yield* f.fs.exists(f.path.join(f.home, 'dev-skills/enablement-journal.json'))).toBe(false);
      }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
  );
  effectIt.effect(
    'explicit remove before first setup records a disabled tombstone without touching discovery roots',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const removed = yield* f.run(applyDevSkills(f.config, 'remove', selector));
        expect(removed.applied).toBe(true);
        expect(
          (yield* f.run(
            ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'default', operationId: 'after-remove'}),
          )).state,
        ).toBe('disabled');
        expect(yield* f.fs.exists(f.path.join(f.host, '.agents'))).toBe(false);
        expect((yield* f.run(applyDevSkills(f.config, 'remove', selector))).applied).toBe(false);
      }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
  );
});
