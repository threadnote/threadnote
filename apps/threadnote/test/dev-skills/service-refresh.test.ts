import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  applyDevSkills,
  ensureDevSkills,
  previewDevSkillsRefresh,
  prepareDevSkillsRefresh,
  runDevSkillsRefresh,
  readDevSkillsRefresh,
  statusDevSkills,
} from '../../src/dev_skills/index.js';
import {devSkillsTestLayer, fixture, snapshot, devSkillsReleaseFixture} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {hash, stableJson} from '../../src/dev_skills/files.js';
import {consumerId, homeIndexPath, receiptPath, runtimeIndexPath} from '../../src/dev_skills/registry.js';
import {refreshPropertyDiagnostics} from './service-refresh-diagnostics.js';

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));
const selector = {agent: 'codex'};
describe('exact-release enrolled workflow refresh', () => {
  effectIt.effect(
    'refreshes two homes sharing one root, retains helpers and private files, and reuses the same intent',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.run(applyDevSkills(f.config, 'install', selector));
        const other = {...f.config, agentContextHome: f.path.join(f.root, 'second')};
        yield* f.run(applyDevSkills(other, 'install', selector));
        yield* f.fs.writeFileString(
          f.path.join(other.agentContextHome, 'private-evidence.json'),
          '{"unchanged":"review-identity"}',
        );
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const before = yield* snapshot(f.root);
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        expect(plan.compatibility).toBe('compatible');
        expect(yield* snapshot(f.root)).toEqual(before);
        const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
        yield* release.activate;
        const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
        expect(result.repairRequired).toBe(false);
        expect(EffectArray.map(result.targets, target => target.outcome.state)).toEqual(['current', 'current']);
        expect(yield* f.fs.readFileString(f.path.join(other.agentContextHome, 'private-evidence.json'))).toBe(
          '{"unchanged":"review-identity"}',
        );
        expect(
          yield* f.fs.exists(
            f.path.join(first.target.skillRoot, '.threadnote-dev-skills/generations', first.bundleDigest),
          ),
        ).toBe(true);
        const next = yield* release.run(previewDevSkillsRefresh(f.config, release));
        expect(
          (yield* release.run(prepareDevSkillsRefresh(f.config, next, {expectedDigest: next.previewDigest}))).intentId,
        ).toBe(prepared.intentId);
        expect((yield* release.run(statusDevSkills(f.config, selector))).targets[0]).toMatchObject({
          installed: {releaseVersion: '5.3.0-beta.5'},
          lastRefresh: {state: 'current'},
        });
      }).pipe(provide),
  );
  effectIt.effect(
    'does not activate known incompatibility, and stages a same-version force candidate without changing active bytes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5', true);
        const before = yield* snapshot(f.root);
        const incompatible = yield* f.run(
          previewDevSkillsRefresh(f.config, {...release, capabilities: {...release.capabilities, stateSchemas: []}}),
        );
        expect(incompatible.compatibility).toBe('incompatible');
        expect(
          yield* f
            .run(prepareDevSkillsRefresh(f.config, incompatible, {expectedDigest: incompatible.previewDigest}))
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'incompatible'}});
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
        expect(yield* f.fs.exists(release.releaseRoot)).toBe(false);
        expect(before['runtime/versions/.threadnote-update-fixture/release/config/dev-skills.json']).toBeDefined();
      }).pipe(provide),
  );
  effectIt.effect(
    'keeps an edited root pending while another root succeeds, then resumes the same intent after repair',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.run(applyDevSkills(f.config, 'install', selector));
        yield* f.run(applyDevSkills(f.config, 'install', {agent: 'claude-code'}));
        const file = f.path.join(first.target.skillRoot, 'dev-plan/SKILL.md');
        const original = yield* f.fs.readFileString(file);
        yield* f.fs.writeFileString(file, 'user edit');
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
        yield* release.activate;
        const firstRun = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
        expect(firstRun.repairRequired).toBe(true);
        expect(EffectArray.map(firstRun.targets, target => target.outcome.state).sort()).toEqual([
          'current',
          'pending',
        ]);
        expect(yield* f.fs.readFileString(file)).toBe('user edit');
        yield* f.fs.writeFileString(file, original);
        expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(false);
      }).pipe(provide),
    // Two roots plus a repair retry took 23–29s on Windows CI, leaving too little room under 30s.
    process.platform === 'win32' ? 60_000 : undefined,
  );
  effectIt.effect.prop(
    'never re-enables disabled or removed consumers during refresh',
    {removed: Schema.Boolean},
    ({removed}, context) => {
      const diagnostics = refreshPropertyDiagnostics(context);
      return diagnostics.observe(
        removed,
        Effect.gen(function* () {
          diagnostics.phase('fixture');
          const f = yield* fixture();
          diagnostics.phase('install');
          yield* f.run(applyDevSkills(f.config, 'install', selector));
          diagnostics.phase('remove-or-disable');
          if (removed) yield* f.run(applyDevSkills(f.config, 'remove', selector));
          else
            yield* f.run(
              ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'disabled', operationId: 'opt-out'}),
            );
          diagnostics.phase('release');
          const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
          diagnostics.phase('preview');
          const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
          diagnostics.phase('prepare');
          const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
          diagnostics.phase('activate');
          yield* release.activate;
          diagnostics.phase('index-read');
          const home = yield* f.fs.readFileString(homeIndexPath(f.path, f.home));
          diagnostics.phase('refresh');
          const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
          diagnostics.phase('assertions-status');
          expect(result.targets[0].outcome.state).toBe('skipped');
          expect(yield* f.fs.readFileString(homeIndexPath(f.path, f.home))).toBe(home);
          expect((yield* release.run(statusDevSkills(f.config, selector))).targets[0].enabled).toBe(false);
        }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), provide),
      );
    },
    // Four real-filesystem refresh runs share one outer property deadline on Windows.
    {arbitrary: {runs: 4}, ...(process.platform === 'win32' ? {timeout: 120_000} : {})},
  );
  effectIt.effect('recovers interrupted opt-out through refresh before comparing the two enrollment indexes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
      const physicalBefore = yield* snapshot(installed.target.skillRoot);
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
      expect(
        yield* f
          .run(ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'disabled', operationId: 'lost-opt-out'}))
          .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      expect(failed).toBe(true);
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
      expect(plan.compatibility).toBe('unknown');
      const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
      yield* release.activate;
      const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
      expect(result.repairRequired).toBe(false);
      expect(result.targets[0].outcome.state).toBe('skipped');
      expect(yield* snapshot(installed.target.skillRoot)).toEqual(physicalBefore);
      expect(yield* f.fs.exists(f.path.join(f.home, 'dev-skills/enablement-journal.json'))).toBe(false);
      expect((yield* release.run(statusDevSkills(f.config, selector))).targets[0].enabled).toBe(false);
      expect((yield* release.run(readDevSkillsRefresh(f.config)))?.repairRequired).toBe(false);
    }).pipe(provide),
  );
  effectIt.effect(
    'reports late enabled enrollment without expanding intent authority, then fresh prepare converges',
    () =>
      Effect.gen(function* () {
        for (const alreadyCurrent of [false, true]) {
          const f = yield* fixture();
          yield* f.run(applyDevSkills(f.config, 'install', selector));
          const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
          const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
          const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
          const stateFile = f.path.join(f.runtime, 'dev-skills-refresh.json');
          const originalRequest = JSON.parse(yield* f.fs.readFileString(stateFile)).request;
          if (alreadyCurrent) {
            yield* release.activate;
            expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(false);
          }
          const other = {...f.config, agentContextHome: f.path.join(f.root, 'late-home')};
          const lateSelector = {agent: 'claude-code'};
          const late = yield* f.run(applyDevSkills(other, 'install', lateSelector));
          const lateBefore = yield* snapshot(late.target.skillRoot);
          yield* release.activate;
          const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
          expect(result.repairRequired).toBe(true);
          expect(result).toMatchObject({issues: [{code: 'enrollment-drift'}]});
          if (alreadyCurrent) expect(result.targets[0].outcome.state).toBe('current');
          expect(EffectArray.some(result.targets, target => target.consumerId === late.consumerId)).toBe(false);
          expect(yield* snapshot(late.target.skillRoot)).toEqual(lateBefore);
          expect(JSON.parse(yield* f.fs.readFileString(stateFile)).request).toEqual(originalRequest);
          expect(yield* release.run(readDevSkillsRefresh(f.config))).toEqual(result);
          const next = yield* release.run(previewDevSkillsRefresh(f.config, release));
          const retry = yield* release.run(
            prepareDevSkillsRefresh(f.config, next, {expectedDigest: next.previewDigest}),
          );
          expect(retry.intentId).not.toBe(prepared.intentId);
          const completed = yield* release.run(runDevSkillsRefresh(f.config, retry.intentId));
          expect(completed.repairRequired).toBe(false);
          expect(EffectArray.map(completed.targets, target => target.outcome.state)).toEqual(['current', 'current']);
          expect((yield* release.run(statusDevSkills(other, lateSelector))).targets[0].installed?.releaseVersion).toBe(
            '5.3.0-beta.5',
          );
        }
      }).pipe(provide),
    // Two complete convergence scenarios; single Windows refresh cases took 19–25s in CI.
    process.platform === 'win32' ? 120_000 : undefined,
  );
  effectIt.effect.prop(
    'late disabled or removed enrollment does not block the prepared enabled membership',
    {removed: Schema.Boolean},
    ({removed}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
        const lateSelector = {agent: 'claude-code'};
        const late = yield* f.run(applyDevSkills(f.config, 'install', lateSelector));
        if (removed) yield* f.run(applyDevSkills(f.config, 'remove', lateSelector));
        else
          yield* f.run(
            ensureDevSkills(f.config, lateSelector, {mode: 'setup', choice: 'disabled', operationId: 'late-disabled'}),
          );
        const before = yield* snapshot(late.target.skillRoot);
        yield* release.activate;
        const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
        expect(result.repairRequired).toBe(false);
        expect(yield* snapshot(late.target.skillRoot)).toEqual(before);
        expect((yield* release.run(statusDevSkills(f.config, lateSelector))).targets[0].enabled).toBe(false);
      }).pipe(provide),
    // Four real-filesystem refresh runs retain the same property coverage on slower Windows runners.
    {arbitrary: {runs: 4}, ...(process.platform === 'win32' ? {timeout: 120_000} : {})},
  );
  effectIt.effect(
    'recovers a committed write with lost response and refuses stale child execution without rewriting progress',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
        yield* release.activate;
        let failed = false;
        const failing = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) => {
            if (!failed && f.path.basename(to) === 'receipt.json') {
              failed = true;
              return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), to)));
            }
            return f.fs.rename(from, to);
          },
        });
        const first = yield* release
          .run(runDevSkillsRefresh(f.config, prepared.intentId))
          .pipe(Effect.provideService(FileSystem.FileSystem, failing));
        expect(first.repairRequired).toBe(true);
        expect(failed).toBe(true);
        const resumed = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
        expect(resumed.repairRequired).toBe(false);
        const state = yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh.json'));
        const stale = yield* f.run(runDevSkillsRefresh(f.config, prepared.intentId));
        expect(stale.repairRequired).toBe(true);
        expect(stale.targets[0].outcome.issues[0].code).toBe('stale-active-release');
        expect(yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh.json'))).toBe(state);
        expect((yield* release.run(readDevSkillsRefresh(f.config)))?.repairRequired).toBe(false);
      }).pipe(provide),
  );
  effectIt.effect(
    'unavailable registered homes remain pending and do not block a separate root or reconstruct consent',
    context => {
      const diagnostics = refreshPropertyDiagnostics(context, {scope: 'dev-skills-refresh-unavailable-home'});
      return diagnostics.observe(
        undefined,
        Effect.gen(function* () {
          diagnostics.phase('fixture');
          const f = yield* fixture();
          diagnostics.phase('install');
          yield* f.run(applyDevSkills(f.config, 'install', selector));
          const other = {...f.config, agentContextHome: f.path.join(f.root, 'offline-home')};
          diagnostics.phase('install');
          yield* f.run(applyDevSkills(other, 'install', {agent: 'claude-code'}));
          diagnostics.phase('index-read');
          const homeFile = homeIndexPath(f.path, other.agentContextHome);
          const originalHome = yield* f.fs.readFileString(homeFile);
          diagnostics.phase('remove-or-disable');
          yield* f.fs.remove(homeFile);
          diagnostics.phase('release');
          const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
          diagnostics.phase('preview');
          const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
          diagnostics.phase('assertions-status');
          expect(plan.compatibility).toBe('unknown');
          diagnostics.phase('prepare');
          const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
          diagnostics.phase('activate');
          yield* release.activate;
          diagnostics.phase('refresh');
          const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
          diagnostics.phase('assertions-status');
          expect(EffectArray.map(result.targets, target => target.outcome.state).sort()).toEqual([
            'current',
            'pending',
          ]);
          expect(yield* f.fs.exists(homeFile)).toBe(false);
          diagnostics.phase('restore-home-index');
          yield* f.fs.writeFileString(homeFile, originalHome);
          diagnostics.phase('refresh');
          expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(false);
        }).pipe(Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))), provide),
      );
    },
  );
  effectIt.effect(
    'preflight rejects concrete future retained requirements even when the old decoder cannot admit ownership',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
        const file = receiptPath(f.path, installed.target.skillRoot);
        const receipt = JSON.parse(yield* f.fs.readFileString(file));
        receipt.generations[installed.bundleDigest].workflowProtocol = 2;
        yield* f.fs.writeFileString(file, JSON.stringify(receipt));
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        expect(plan.compatibility).toBe('incompatible');
        expect(
          yield* f
            .run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}))
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'incompatible'}});
      }).pipe(provide),
  );
  effectIt.effect('unknown request fields and an unregistered forged destination fail before target writes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(applyDevSkills(f.config, 'install', selector));
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
      const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
      yield* release.activate;
      const file = f.path.join(f.runtime, 'dev-skills-refresh.json');
      const state = JSON.parse(yield* f.fs.readFileString(file));
      const validState = JSON.parse(JSON.stringify(state));
      state.request.rootOverride = f.path.join(f.root, 'not-owned');
      yield* f.fs.writeFileString(file, JSON.stringify(state));
      const before = yield* snapshot(f.root);
      expect(yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'invalid-state'},
      });
      expect(yield* snapshot(f.root)).toEqual(before);
      const unowned = f.path.join(f.root, 'unregistered-destination');
      validState.request.members[0].enrollment.target.skillRoot = unowned;
      validState.intentId = hash(stableJson(validState.request));
      yield* f.fs.writeFileString(file, JSON.stringify(validState));
      expect((yield* release.run(runDevSkillsRefresh(f.config, validState.intentId))).repairRequired).toBe(true);
      expect(yield* f.fs.exists(unowned)).toBe(false);
    }).pipe(provide),
  );
  effectIt.effect('refresh reports a shared foreign consumer without rewriting its home or runtime index', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(applyDevSkills(f.config, 'install', selector));
      const foreignRoot = f.path.join(f.root, 'foreign-runtime');
      const foreign = {...f.config, agentContextHome: f.path.join(f.root, 'foreign-home'), user: 'private-other-user'};
      f.environment.THREADNOTE_INSTALL_ROOT = foreignRoot;
      yield* f.run(applyDevSkills(foreign, 'install', selector));
      f.environment.THREADNOTE_INSTALL_ROOT = f.runtime;
      const foreignHome = yield* f.fs.readFileString(homeIndexPath(f.path, foreign.agentContextHome));
      const foreignRuntime = yield* f.fs.readFileString(runtimeIndexPath(f.path, foreignRoot));
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
      const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
      yield* release.activate;
      const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
      expect(result.repairRequired).toBe(false);
      expect(EffectArray.map(result.targets, target => target.outcome.state).sort()).toEqual(['current', 'skipped']);
      expect(yield* f.fs.readFileString(homeIndexPath(f.path, foreign.agentContextHome))).toBe(foreignHome);
      expect(yield* f.fs.readFileString(runtimeIndexPath(f.path, foreignRoot))).toBe(foreignRuntime);
    }).pipe(provide),
  );
  effectIt.effect(
    'routes a pending physical journal through its original registered home before other shared consumers',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        const other = {...f.config, agentContextHome: f.path.join(f.root, 'aaa-before-original')};
        yield* f.run(applyDevSkills(other, 'install', selector));
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
        const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
        const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
        yield* release.activate;
        let failed = false;
        const failing = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) => {
            if (!failed && f.path.basename(to) === 'journal.json') {
              failed = true;
              return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), to)));
            }
            return f.fs.rename(from, to);
          },
        });
        expect(
          yield* release
            .run(applyDevSkills(f.config, 'update', selector))
            .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
        ).toMatchObject({_tag: 'Failure'});
        const result = yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId));
        expect(EffectArray.map(result.targets, target => target.outcome.state)).toEqual(['current', 'current']);
      }).pipe(provide),
  );
  effectIt.effect('superseding an intent retains its history and stale children cannot change the newer request', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(applyDevSkills(f.config, 'install', selector));
      const old = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const oldPlan = yield* f.run(previewDevSkillsRefresh(f.config, old));
      const first = yield* f.run(prepareDevSkillsRefresh(f.config, oldPlan, {expectedDigest: oldPlan.previewDigest}));
      const next = yield* devSkillsReleaseFixture(f, '5.3.0-beta.6');
      const newPlan = yield* f.run(previewDevSkillsRefresh(f.config, next));
      const second = yield* f.run(prepareDevSkillsRefresh(f.config, newPlan, {expectedDigest: newPlan.previewDigest}));
      yield* next.activate;
      const state = yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh.json'));
      const stale = yield* old.run(runDevSkillsRefresh(f.config, first.intentId));
      expect(stale.intentId).toBe(first.intentId);
      expect(stale.repairRequired).toBe(true);
      expect(yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh.json'))).toBe(state);
      expect(yield* f.fs.exists(f.path.join(f.runtime, 'dev-skills-refresh-history', `${first.intentId}.json`))).toBe(
        true,
      );
      expect((yield* next.run(runDevSkillsRefresh(f.config, second.intentId))).repairRequired).toBe(false);
    }).pipe(provide),
  );
  effectIt.effect('unsupported recorded hosts stay pending before restoration writes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
      const homeFile = homeIndexPath(f.path, f.home);
      const runtimeFile = runtimeIndexPath(f.path, f.runtime);
      const physicalFile = receiptPath(f.path, installed.target.skillRoot);
      const home = JSON.parse(yield* f.fs.readFileString(homeFile));
      const runtime = JSON.parse(yield* f.fs.readFileString(runtimeFile));
      const receipt = JSON.parse(yield* f.fs.readFileString(physicalFile));
      const entry = home.targets[installed.consumerId];
      entry.target = {...entry.target, surfaceId: 'unsupported-old-host', agentId: 'unsupported-old-host'};
      const id = consumerId(entry);
      home.targets = {[id]: entry};
      runtime.enrollments = {[id]: entry};
      receipt.consumers = {[id]: {home: entry.home, installationRoot: entry.installationRoot, target: entry.target}};
      yield* f.fs.writeFileString(homeFile, JSON.stringify(home));
      yield* f.fs.writeFileString(runtimeFile, JSON.stringify(runtime));
      yield* f.fs.writeFileString(physicalFile, JSON.stringify(receipt));
      const missing = f.path.join(installed.target.skillRoot, 'dev-plan/SKILL.md');
      yield* f.fs.remove(missing);
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5');
      const plan = yield* f.run(previewDevSkillsRefresh(f.config, release));
      const prepared = yield* f.run(prepareDevSkillsRefresh(f.config, plan, {expectedDigest: plan.previewDigest}));
      yield* release.activate;
      expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(true);
      expect(yield* f.fs.exists(missing)).toBe(false);
      expect(
        yield* f.fs.exists(
          f.path.join(installed.target.skillRoot, '.threadnote-dev-skills/generations', release.bundle.manifest.digest),
        ),
      ).toBe(false);
    }).pipe(provide),
  );
});
