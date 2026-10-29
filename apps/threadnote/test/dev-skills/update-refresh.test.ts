import {it as effectIt} from '@effect/vitest';
import {Array as A, Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {CommandExecutor, CommandFailed} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {withStandaloneInstallationLock} from '../../src/installations.js';
import {
  applyDevSkills,
  readDevSkillsRefresh,
  runDevSkillsRefresh,
  statusDevSkills,
} from '../../src/dev_skills/index.js';
import {DevSkillsSource} from '../../src/dev_skills/manifest.js';
import {prepareReleaseDevSkills, refreshReleaseDevSkills} from '../../src/release/dev_skills_update.js';
import {
  prepareCandidateDevSkillsUpdate,
  readCandidateDevSkillsUpdate,
  refreshCandidateDevSkillsUpdate,
} from '../../src/dev_skills/update_protocol.js';
import {devSkillsReleaseFixture, devSkillsTestLayer, fixture} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

/** In-process command boundary, with real capability/intent/ownership files and child lock acquisition. */
const commands = Effect.fn('test.update.commands')(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof runDevSkillsRefresh>>>();
  const calls: Array<{executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv}> = [];
  const executor = CommandExecutor.of({
    execute: (executable, args, options) =>
      Effect.gen(function* () {
        calls.push({executable, args, env: options?.env});
        const root = f.path.dirname(executable);
        const version = (JSON.parse(yield* f.fs.readFileString(f.path.join(root, 'release.json'))) as {version: string})
          .version;
        expect(args.slice(0, 3)).toEqual(['--home', f.config.agentContextHome, 'dev-skills']);
        expect(args[args.indexOf('--protocol-version') + 1]).toBe('1');
        const candidate =
          args[3] === 'prepare-update'
            ? prepareCandidateDevSkillsUpdate(
                f.config,
                args[args.indexOf('--release-root') + 1],
                args[args.indexOf('--release-version') + 1],
              )
            : args[3] === 'refresh-update'
              ? refreshCandidateDevSkillsUpdate(f.config, args[args.indexOf('--intent') + 1])
              : readCandidateDevSkillsUpdate(f.config, args[args.indexOf('--intent') + 1]);
        const result = yield* candidate.pipe(
          Effect.provideService(SystemInfo, {
            ...f.system,
            executablePath: executable,
            environment: () => options?.env ?? f.system.environment(),
          }),
          Effect.provideService(DevSkillsSource, {root, runtimeVersion: version}),
        );
        return {exitCode: 0, stderr: '', stdout: JSON.stringify(result)};
      }).pipe(
        Effect.provide(context),
        Effect.mapError(error =>
          CommandFailed.make({
            executable,
            args,
            exitCode: 1,
            stdout: '',
            stderr: String(error),
            message: String(error),
          }),
        ),
      ),
    executeStreaming: () => Effect.die('workflow refresh uses its bounded JSON child protocol'),
  });
  return {calls, executor};
});

effectIt.effect(
  'checks staged compatibility before replacement and refreshes via the active release after unlocking',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const old = yield* devSkillsReleaseFixture(f, '5.3.0-beta.4');
      yield* old.activate;
      yield* old.run(applyDevSkills(f.config, 'install', {agent: 'codex'}));
      const boundary = yield* commands(f);
      const {prepared, next} = yield* f
        .run(
          withStandaloneInstallationLock(
            Effect.gen(function* () {
              const next = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5', true);
              const prepared = yield* prepareReleaseDevSkills(
                f.config,
                next.releaseRoot,
                next.releaseVersion,
                next.bundleRoot,
              );
              return {prepared, next};
            }),
          ),
        )
        .pipe(Effect.provideService(CommandExecutor, boundary.executor));
      expect(
        (JSON.parse(yield* f.fs.readFileString(f.path.join(f.runtime, 'active-release.json'))) as {version: string})
          .version,
      ).toBe(old.releaseVersion);
      expect((yield* f.run(readDevSkillsRefresh(f.config)))?.repairRequired).toBe(true);
      yield* f.fs.rename(next.bundleRoot, next.releaseRoot);
      yield* next.activate;
      const result = yield* f
        .run(refreshReleaseDevSkills(f.config, prepared))
        .pipe(Effect.provideService(CommandExecutor, boundary.executor));
      expect(result.repairRequired).toBe(false);
      expect(result).toMatchObject({current: 1, skipped: 0, pending: 0});
      expect(boundary.calls.map(call => call.executable)).toEqual([
        f.path.join(next.bundleRoot, f.system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
        f.path.join(next.bundleRoot, f.system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
        f.path.join(next.releaseRoot, f.system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
        f.path.join(next.releaseRoot, f.system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
      ]);
      const status = yield* next.run(statusDevSkills(f.config, {agent: 'codex'}));
      expect(status.targets[0].installed?.digest).toBe(next.bundle.manifest.digest);
      expect(
        yield* f.fs.exists(
          f.path.join(
            status.targets[0].target.skillRoot,
            '.threadnote-dev-skills',
            'generations',
            old.bundle.manifest.digest,
          ),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
);

effectIt.effect('rejects candidate incompatibility before preparing an activation intent', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const old = yield* devSkillsReleaseFixture(f, '5.3.0-beta.4');
    yield* old.activate;
    yield* old.run(applyDevSkills(f.config, 'install', {agent: 'codex'}));
    const boundary = yield* commands(f);
    yield* f.fs.writeFileString(f.manifest, JSON.stringify({...f.inventory, minimumRuntime: '5.3.0-beta.3'}));
    const result = yield* f
      .run(
        withStandaloneInstallationLock(
          Effect.gen(function* () {
            const next = yield* devSkillsReleaseFixture(f, '5.3.0-beta.3', true);
            return yield* prepareReleaseDevSkills(f.config, next.releaseRoot, next.releaseVersion, next.bundleRoot);
          }),
        ),
      )
      .pipe(Effect.provideService(CommandExecutor, boundary.executor), Effect.result);
    expect(result._tag).toBe('Failure');
    expect(yield* f.run(readDevSkillsRefresh(f.config))).toBeUndefined();
    expect(
      (JSON.parse(yield* f.fs.readFileString(f.path.join(f.runtime, 'active-release.json'))) as {version: string})
        .version,
    ).toBe(old.releaseVersion);
    expect(yield* f.fs.exists(f.path.join(f.runtime, 'versions', '5.3.0-beta.3'))).toBe(false);
  }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
);

effectIt.effect(
  'keeps a fresh custom installation root across all four candidate calls without changing the parent environment',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const old = yield* devSkillsReleaseFixture(f, '5.3.0-beta.4');
      yield* old.activate;
      delete f.environment.THREADNOTE_INSTALL_ROOT;
      const environmentBefore = {...f.environment};
      const parent = {...f.system, executablePath: f.path.join(old.releaseRoot, 'threadnote')};
      const boundary = yield* commands(f);
      expect(yield* f.fs.exists(f.path.join(f.home, 'dev-skills', 'index.json'))).toBe(false);
      const {prepared, next} = yield* f
        .run(
          withStandaloneInstallationLock(
            Effect.gen(function* () {
              const next = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5', true);
              const prepared = yield* prepareReleaseDevSkills(
                f.config,
                next.releaseRoot,
                next.releaseVersion,
                next.bundleRoot,
              );
              return {prepared, next};
            }),
          ).pipe(Effect.provideService(SystemInfo, parent)),
        )
        .pipe(Effect.provideService(CommandExecutor, boundary.executor));
      yield* f.fs.rename(next.bundleRoot, next.releaseRoot);
      yield* next.activate;
      const result = yield* f
        .run(refreshReleaseDevSkills(f.config, prepared).pipe(Effect.provideService(SystemInfo, parent)))
        .pipe(Effect.provideService(CommandExecutor, boundary.executor));
      expect(result).toMatchObject({repairRequired: false, current: 0, skipped: 0, pending: 0});
      expect(A.map(boundary.calls, call => call.args[3])).toEqual([
        'prepare-update',
        'update-status',
        'refresh-update',
        'update-status',
      ]);
      expect(A.map(boundary.calls, call => call.env?.THREADNOTE_INSTALL_ROOT)).toEqual([
        f.runtime,
        f.runtime,
        f.runtime,
        f.runtime,
      ]);
      for (const call of boundary.calls) expect(call.env?.PATH).toBe(environmentBefore.PATH);
      expect(f.environment).toEqual(environmentBefore);
      expect(f.environment.THREADNOTE_INSTALL_ROOT).toBeUndefined();
      expect(yield* f.fs.exists(f.path.join(f.host, '.local', 'share', 'threadnote'))).toBe(false);
    }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
);

effectIt.effect('reports late enrollment after an empty preview and includes it on the same-version retry', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const old = yield* devSkillsReleaseFixture(f, '5.3.0-beta.4');
    yield* old.activate;
    const boundary = yield* commands(f);
    const {prepared, next} = yield* f
      .run(
        withStandaloneInstallationLock(
          Effect.gen(function* () {
            const next = yield* devSkillsReleaseFixture(f, '5.3.0-beta.5', true);
            const prepared = yield* prepareReleaseDevSkills(
              f.config,
              next.releaseRoot,
              next.releaseVersion,
              next.bundleRoot,
            );
            return {prepared, next};
          }),
        ),
      )
      .pipe(Effect.provideService(CommandExecutor, boundary.executor));
    yield* old.run(applyDevSkills(f.config, 'install', {agent: 'codex'}));
    yield* f.fs.rename(next.bundleRoot, next.releaseRoot);
    yield* next.activate;
    const attempt = yield* f
      .run(refreshReleaseDevSkills(f.config, prepared))
      .pipe(Effect.provideService(CommandExecutor, boundary.executor), Effect.result);
    expect(attempt).toMatchObject({
      _tag: 'Failure',
      failure: {_tag: 'DevSkillsUpdatePending', message: expect.stringContaining('Workflow refresh is pending.')},
    });
    expect(yield* f.run(readDevSkillsRefresh(f.config))).toMatchObject({
      intentId: prepared.intentId,
      targets: [],
      repairRequired: true,
      issues: [{code: 'enrollment-drift'}],
    });
    expect((yield* next.run(statusDevSkills(f.config, {agent: 'codex'}))).targets[0].installed?.digest).toBe(
      old.bundle.manifest.digest,
    );
    const retry = yield* f
      .run(withStandaloneInstallationLock(prepareReleaseDevSkills(f.config, next.releaseRoot, next.releaseVersion)))
      .pipe(Effect.provideService(CommandExecutor, boundary.executor));
    expect(retry.intentId).not.toBe(prepared.intentId);
    const result = yield* f
      .run(refreshReleaseDevSkills(f.config, retry))
      .pipe(Effect.provideService(CommandExecutor, boundary.executor));
    expect(result.repairRequired).toBe(false);
    expect(result).toMatchObject({current: 1, skipped: 0, pending: 0});
    expect((yield* next.run(statusDevSkills(f.config, {agent: 'codex'}))).targets[0].installed?.digest).toBe(
      next.bundle.manifest.digest,
    );
  }).pipe(provideTestLayer(devSkillsTestLayer), TestClock.withLive),
);
