import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {applyDevSkills, previewDevSkills, statusDevSkills} from '../../src/dev_skills/index.js';
import {DevSkillsSource} from '../../src/dev_skills/manifest.js';
import {homeIndexPath} from '../../src/dev_skills/registry.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));

describe('installed workflow readiness', () => {
  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
    effectIt.effect(`uses the native ${profile} core skill set without Python probes`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const provider = profile === 'codex-cloud-personal' ? 'codex-cloud' : 'cursor-cloud';
        const agent = provider === 'codex-cloud' ? 'codex' : 'cursor';
        yield* f.fs.makeDirectory(f.path.join(f.home, provider), {recursive: true});
        yield* f.fs.writeFileString(
          f.path.join(f.home, provider, 'profile.json'),
          JSON.stringify({
            version: 1,
            provider,
            account: f.config.account,
            agentId: f.config.agentId,
            user: f.config.user,
            ...(provider === 'codex-cloud' ? {teams: ['personal']} : {}),
          }),
        );
        if (provider === 'cursor-cloud') f.environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'personal';
        const worktree = f.path.join(f.root, 'share');
        yield* f.fs.makeDirectory(f.path.join(worktree, '.git'), {recursive: true});
        yield* f.fs.makeDirectory(f.path.join(f.home, 'share'));
        yield* f.fs.writeFileString(
          f.path.join(f.home, 'share/teams.json'),
          JSON.stringify({
            version: 1,
            teams: {personal: {remote: 'https://example.invalid/private.git', worktree, access: 'read-write'}},
          }),
        );
        const bin = f.path.join(f.root, 'bin');
        yield* f.fs.makeDirectory(bin);
        const executableFiles = new Set<string>();
        for (const command of ['threadnote', 'git', 'rg', 'gh']) {
          const file = f.path.join(bin, command);
          yield* f.fs.writeFileString(file, 'fixture executable');
          yield* f.fs.chmod(file, 0o700);
          executableFiles.add(file);
        }
        f.environment.PATH = bin;
        // This is a Linux cloud probe fixture on a native filesystem, not native cloud acceptance.
        // Windows chmod cannot model POSIX execute bits, so supply them only for these fake commands.
        const probeFs = FileSystem.FileSystem.of({
          ...f.fs,
          stat: file =>
            f.fs
              .stat(file)
              .pipe(Effect.map(info => (executableFiles.has(file) ? {...info, mode: info.mode | 0o111} : info))),
        });
        const executor = yield* CommandExecutor;
        const probes: string[] = [];
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          f.run(
            effect.pipe(
              Effect.provideService(SystemInfo, {...f.system, platform: 'linux'}),
              Effect.provideService(FileSystem.FileSystem, probeFs),
              Effect.provideService(CommandExecutor, {
                ...executor,
                execute: executable => {
                  probes.push(executable);
                  return Effect.succeed({exitCode: 0, stdout: '', stderr: ''});
                },
              }),
            ),
          );
        const selector = {agent, profile};
        const target = (yield* run(previewDevSkills(f.config, 'install', selector))).target;
        const core =
          provider === 'codex-cloud'
            ? ['threadnote-context', 'threadnote-memory', 'threadnote-code-graph']
            : ['threadnote-context', 'threadnote-memory'];
        for (const id of core) {
          const file = f.path.join(target.skillRoot, id, 'SKILL.md');
          yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
          yield* f.fs.writeFileString(file, `---\nname: ${id}\n---\nNative profile fixture\n`);
        }
        const check = run(statusDevSkills(f.config, selector));
        const before = yield* snapshot(f.root);
        const result = (yield* check).targets[0];
        expect(result.readiness?.planning.state).toBe('unchecked');
        expect(result.readiness?.publication.state).toBe('unchecked');
        expect(result.readiness?.watch.state).toBe('unchecked');
        expect(probes.some(executable => /python/iu.test(executable))).toBe(false);
        expect(yield* snapshot(f.root)).toEqual(before);
        yield* f.fs.remove(f.path.join(target.skillRoot, 'threadnote-memory', 'SKILL.md'));
        expect((yield* check).targets[0].readiness?.planning.reasons).toContainEqual(
          expect.objectContaining({code: 'core-integration-missing'}),
        );
      }).pipe(provide),
    );
  }

  effectIt.effect('reports a newer shared generation as incompatible while retaining ownership-safe removal', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const newer = yield* fixture();
      const second = {...f.config, agentContextHome: f.path.join(f.root, 'second-home')};
      const system = SystemInfo.of({
        ...f.system,
        environment: () => ({...f.environment, THREADNOTE_INSTALL_ROOT: f.path.join(f.root, 'new-runtime')}),
      });
      const first = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'codex'}));
      yield* f.run(applyDevSkills(second, 'install', {agent: 'amp'}).pipe(Effect.provideService(SystemInfo, system)));
      yield* newer.fs.writeFileString(newer.manifest, JSON.stringify({...newer.inventory, minimumRuntime: '6.0.0'}));
      yield* f.run(
        applyDevSkills(second, 'update', {agent: 'amp'}).pipe(
          Effect.provideService(SystemInfo, system),
          Effect.provideService(DevSkillsSource, {root: newer.source, runtimeVersion: '6.0.0'}),
        ),
      );
      const before = yield* snapshot(f.root);
      const status = (yield* f.run(statusDevSkills(f.config, {agent: 'codex'}))).targets[0];
      expect(status.installationState).toBe('incompatible');
      expect(status.issues).toContainEqual(
        expect.objectContaining({code: 'incompatible', message: expect.stringContaining('6.0.0')}),
      );
      expect(status.readiness?.planning).toMatchObject({
        state: 'blocked',
        reasons: expect.arrayContaining([expect.objectContaining({code: 'incompatible'})]),
      });
      expect((yield* f.run(previewDevSkills(f.config, 'update', {agent: 'codex'}))).canApply).toBe(false);
      expect(yield* snapshot(f.root)).toEqual(before);
      const otherIndex = yield* f.fs.readFileString(homeIndexPath(f.path, second.agentContextHome));
      expect((yield* f.run(applyDevSkills(f.config, 'remove', {agent: 'codex'}))).applied).toBe(true);
      expect(yield* f.fs.readFileString(homeIndexPath(f.path, second.agentContextHome))).toBe(otherIndex);
      expect(yield* f.fs.exists(f.path.join(first.target.skillRoot, 'dev-spec/SKILL.md'))).toBe(true);
    }).pipe(provide),
  );
});
