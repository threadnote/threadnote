import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {SystemInfo} from '@threadnote/platform/system';
import {expect} from 'vitest';
import {composeWorkflowSetup, maintainPersonalWorkflows} from '../../src/setup/workflows.js';
import {applyDevSkills, statusDevSkills} from '../../src/dev_skills/index.js';
import {fixture, devSkillsTestLayer, snapshot} from './service-fixture.js';

for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
  effectIt.effect(`${profile} start maintains only enabled ownership and retains prior helper generations`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const system = SystemInfo.of({...f.system, platform: 'linux'});
      const selector = {agent: profile === 'codex-cloud-personal' ? 'codex-cloud' : profile, profile};
      const missing = yield* f.run(
        maintainPersonalWorkflows(f.config, selector).pipe(Effect.provideService(SystemInfo, system)),
      );
      expect(missing.state).toBe('setup-needed');
      expect(yield* f.fs.exists(f.path.join(f.home, 'dev-skills/index.json'))).toBe(false);
      yield* f.run(
        composeWorkflowSetup(f.config, selector, {apply: true, key: `bootstrap:${profile}`}, () => Effect.void).pipe(
          Effect.provideService(SystemInfo, system),
        ),
      );
      const first = (yield* f.run(statusDevSkills(f.config, selector).pipe(Effect.provideService(SystemInfo, system))))
        .targets[0];
      expect(first).toMatchObject({enrolled: true, enabled: true});
      yield* f.fs.writeFileString(
        f.path.join(f.source, 'config/agent-skills/dev-spec/scripts/helper.py'),
        'print("new helpers")\n',
      );
      const maintained = yield* f.run(
        maintainPersonalWorkflows(f.config, selector).pipe(Effect.provideService(SystemInfo, system)),
      );
      expect(maintained.state).toBe('installed');
      const next = (yield* f.run(statusDevSkills(f.config, selector).pipe(Effect.provideService(SystemInfo, system))))
        .targets[0];
      expect(next.installedDigest).not.toBe(first.installedDigest);
      expect(
        yield* f.fs.exists(
          f.path.join(first.target.skillRoot, '.threadnote-dev-skills/generations', first.installedDigest!),
        ),
      ).toBe(true);
      yield* f.run(applyDevSkills(f.config, 'remove', selector).pipe(Effect.provideService(SystemInfo, system)));
      const before = yield* snapshot(f.root);
      expect(
        (yield* f.run(maintainPersonalWorkflows(f.config, selector).pipe(Effect.provideService(SystemInfo, system))))
          .state,
      ).toBe('disabled');
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
  );
}

effectIt.effect('unsupported personal platform supports truthful core-only opt-out without workflow enrollment', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const system = SystemInfo.of({...f.system, platform: 'darwin'});
    const selector = {agent: 'codex-cloud', profile: 'codex-cloud-personal' as const};
    const before = yield* snapshot(f.root);
    let calls = 0;
    yield* f.run(
      composeWorkflowSetup(f.config, selector, {apply: true, noDevSkills: true, key: 'unsupported'}, () =>
        Effect.sync(() => {
          calls++;
        }),
      ).pipe(Effect.provideService(SystemInfo, system)),
    );
    expect(calls).toBe(1);
    expect(yield* snapshot(f.root)).toEqual(before);
    expect(
      (yield* f.run(maintainPersonalWorkflows(f.config, selector).pipe(Effect.provideService(SystemInfo, system))))
        .state,
    ).toBe('setup-needed');
    const rejected = yield* f
      .run(
        composeWorkflowSetup(f.config, selector, {apply: true, key: 'unsupported'}, () =>
          Effect.sync(() => {
            calls++;
          }),
        ).pipe(Effect.provideService(SystemInfo, system)),
      )
      .pipe(Effect.result);
    expect(rejected).toMatchObject({_tag: 'Failure', failure: {code: 'unsupported-platform'}});
    expect(calls).toBe(1);
    expect(yield* snapshot(f.root)).toEqual(before);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);
