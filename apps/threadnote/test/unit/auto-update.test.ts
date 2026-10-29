import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import fc from 'fast-check';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import {DevSkillsUpdatePending} from '../../src/release/dev_skills_update.js';
import {runUpdate} from '@threadnote/threadnote/release/index';
import {
  autoUpdateWorkerTelemetryFields,
  initializeAutoUpdatePolicy,
  isAutoUpdateDue,
  isAutoUpdateVersionEligible,
  nextAutoUpdateAttempt,
  parseAutoUpdateState,
  readAutoUpdateStatus,
  runAutoUpdateWorker,
  setAutoUpdatePolicy,
  stateAfterFailedAutoUpdateSpawn,
  terminalAutoUpdateState,
  threadnoteUpdateCommandMode,
  type AutoUpdateState,
  type AutoUpdateWorkerResult,
} from '@threadnote/threadnote/release/auto_update';
import type {UpdateOptions} from '@threadnote/threadnote/types';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {HttpService} from '@threadnote/platform/http';
import {CliOutput} from '../../src/effect/cli/output.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const AutoUpdateTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const WorkerBoundaryLayer = Layer.mergeAll(
  AutoUpdateTestLayer,
  CliOutput.layer.pipe(Layer.provide(TestSystemInfoLayer)),
  Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: () => Effect.die('mock updater owns commands'),
      executeStreaming: () => Effect.die('mock updater owns commands'),
    }),
  ),
  Layer.succeed(
    HttpService,
    HttpService.of({
      downloadToFile: () => Effect.die('mock updater owns HTTP'),
      getJson: () => Effect.die('mock updater owns HTTP'),
      getStatus: () => Effect.die('mock updater owns HTTP'),
      getText: () => Effect.die('mock updater owns HTTP'),
    }),
  ),
);

vi.mock('@threadnote/threadnote/release/index', () => ({runUpdate: vi.fn()}));
vi.mock('@threadnote/workspace/runtime-version', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/workspace/runtime-version')>()),
  isStandaloneThreadnoteBuild: () => true,
}));
vi.mock('../../src/system_notification.js', () => ({sendSystemNotification: () => Effect.succeed('unavailable')}));

effectIt.effect(
  'records workflow attention after activation and clears it only after a successful same-version retry',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-auto-workflow-'});
      const installRoot = path.join(root, 'runtime');
      const home = path.join(root, 'home');
      const config = {
        account: 'local' as const,
        agentContextHome: home,
        agentId: 'test',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'test',
      };
      const system = SystemInfo.of({...baseSystem, environment: () => ({THREADNOTE_INSTALL_ROOT: installRoot})});
      const activate = (version: string) =>
        Effect.gen(function* () {
          const releaseRoot = path.join(installRoot, 'versions', version);
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), JSON.stringify({version}));
          yield* fs.writeFileString(
            path.join(installRoot, 'active-release.json'),
            JSON.stringify({version, releaseRoot}),
          );
        });
      yield* activate('5.3.0');
      yield* initializeAutoUpdatePolicy('automatic').pipe(Effect.provideService(SystemInfo, system));
      vi.mocked(runUpdate).mockImplementation(() =>
        activate('5.4.0').pipe(
          Effect.andThen(Effect.fail(DevSkillsUpdatePending.make({message: 'fixture edited target'}))),
        ),
      );
      const first = yield* runAutoUpdateWorker(config).pipe(Effect.provideService(SystemInfo, system));
      expect(first).toEqual({result: 'updated', repairRequired: true});
      let status = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, system));
      expect(status.lastSuccess).toMatchObject({toVersion: '5.4.0', repairRequired: true, repairScope: 'workflows'});
      expect(status.lastFailure).toBeDefined();
      vi.mocked(runUpdate).mockReturnValue(Effect.fail(DevSkillsUpdatePending.make({message: 'still edited'})));
      expect(
        yield* runAutoUpdateWorker(config).pipe(Effect.provideService(SystemInfo, system), Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      status = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, system));
      expect(status.lastSuccess?.repairRequired).toBe(true);
      vi.mocked(runUpdate).mockReturnValue(Effect.void);
      expect(yield* runAutoUpdateWorker(config).pipe(Effect.provideService(SystemInfo, system))).toEqual({
        result: 'current',
      });
      status = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, system));
      expect(status.lastSuccess).toMatchObject({toVersion: '5.4.0', repairRequired: false});
      expect(status.lastFailure).toBeUndefined();

      // A successful workflow retry cannot claim an earlier core repair was fixed.
      yield* fs.writeFileString(
        path.join(installRoot, 'auto-update.json'),
        JSON.stringify({
          version: 1,
          policy: 'automatic',
          lastSuccess: {...status.lastSuccess, repairScope: undefined, repairRequired: true},
        }),
      );
      yield* runAutoUpdateWorker(config).pipe(Effect.provideService(SystemInfo, system));
      expect(
        (yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, system))).lastSuccess?.repairRequired,
      ).toBe(true);
    }).pipe(provideTestLayer(WorkerBoundaryLayer), TestClock.withLive),
);

describe('automatic update state', () => {
  it('treats JSON as an output modifier for explicit release options without weakening mode conflicts', () => {
    const releaseOptions: UpdateOptions[] = [
      {allowUntrustedSource: true},
      {beta: true},
      {check: true},
      {dryRun: true},
      {force: true},
      {postUpdate: false},
      {repair: false},
      {source: 'https://example.com/releases'},
      {stable: true},
      {yes: true},
    ];
    for (const options of releaseOptions) {
      expect(threadnoteUpdateCommandMode({...options, json: true})).toBe('release');
    }
    fc.assert(
      fc.property(fc.subarray(releaseOptions, {minLength: 1}), selectedOptions => {
        const options = Object.assign({}, ...selectedOptions);
        expect(threadnoteUpdateCommandMode({...options, json: true})).toBe('release');
      }),
    );
    expect(threadnoteUpdateCommandMode({auto: 'on', dryRun: true})).toBe('policy');
    expect(threadnoteUpdateCommandMode({auto: 'off', dryRun: true})).toBe('policy');
    expect(threadnoteUpdateCommandMode({beta: true, dryRun: true, json: true})).toBe('release');
    expect(threadnoteUpdateCommandMode({beta: true, dryRun: true, json: true, yes: true})).toBe('release');
    expect(threadnoteUpdateCommandMode({beta: true, json: true})).toBe('release');
    expect(threadnoteUpdateCommandMode({stable: true, json: true})).toBe('release');
    expect(threadnoteUpdateCommandMode({json: true})).toBe('status');
    expect(threadnoteUpdateCommandMode({json: true, status: true})).toBe('status');
    expect(threadnoteUpdateCommandMode({auto: 'off', json: true})).toBe('invalid');
    expect(threadnoteUpdateCommandMode({check: true, json: true, status: true})).toBe('invalid');
    expect(threadnoteUpdateCommandMode({dryRun: true, status: true})).toBe('invalid');
    expect(threadnoteUpdateCommandMode({beta: true, auto: 'on'})).toBe('invalid');
  });

  effectIt.effect('defaults to notify and persists explicit policy changes atomically', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-auto-update-'});
      const installRoot = path.join(temporaryRoot, 'install');
      const statePath = path.join(installRoot, 'auto-update.json');
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          CI: undefined,
          NO_UPDATE_NOTIFIER: undefined,
          THREADNOTE_AUTO_UPDATE: undefined,
          THREADNOTE_INSTALL_ROOT: installRoot,
          THREADNOTE_NO_UPDATE_CHECK: undefined,
        }),
      });

      const initial = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, testSystem));
      yield* initializeAutoUpdatePolicy('automatic').pipe(Effect.provideService(SystemInfo, testSystem));
      const enabled = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, testSystem));
      yield* fs.writeFileString(
        statePath,
        `${JSON.stringify({
          policy: 'automatic',
          running: {attempt: 1, fromVersion: '4.2.2', startedAt: '2026-08-13T08:00:00.000Z'},
          version: 1,
        })}\n`,
      );
      yield* setAutoUpdatePolicy('notify').pipe(Effect.provideService(SystemInfo, testSystem));
      const disabled = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, testSystem));
      const persisted = JSON.parse(yield* fs.readFileString(statePath)) as unknown;

      expect(initial).toMatchObject({effectivePolicy: 'notify', policy: 'notify', policySource: 'default'});
      expect(enabled).toMatchObject({effectivePolicy: 'automatic', policy: 'automatic', policySource: 'file'});
      expect(disabled).toMatchObject({effectivePolicy: 'notify', policy: 'notify', policySource: 'file'});
      expect(persisted).toEqual({policy: 'notify', version: 1});
    }).pipe(provideTestLayer(AutoUpdateTestLayer)),
  );

  effectIt.effect('honors environment opt-out without rewriting the persisted preference', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-auto-update-opt-out-'});
      const installRoot = path.join(temporaryRoot, 'install');
      const persistedSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
      });
      yield* initializeAutoUpdatePolicy('automatic').pipe(Effect.provideService(SystemInfo, persistedSystem));
      const optedOutSystem = SystemInfo.of({
        ...persistedSystem,
        environment: () => ({
          ...persistedSystem.environment(),
          THREADNOTE_NO_UPDATE_CHECK: '1',
        }),
      });
      const status = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, optedOutSystem));

      expect(status).toMatchObject({effectivePolicy: 'notify', policy: 'automatic', policySource: 'environment'});
    }).pipe(provideTestLayer(AutoUpdateTestLayer)),
  );

  it('round-trips every valid fully populated state through JSON parsing', () => {
    const version = fc
      .tuple(fc.integer({max: 100, min: 0}), fc.integer({max: 100, min: 0}), fc.integer({max: 100, min: 0}))
      .map(parts =>
        EffectArray.join(
          EffectArray.map(parts, item => (item === null || item === undefined ? '' : String(item))),
          '.',
        ),
      );
    const timestamp = fc
      .integer({max: Date.parse('2099-12-31T23:59:59.999Z'), min: Date.parse('2000-01-01T00:00:00.000Z')})
      .map(milliseconds => new Date(milliseconds).toISOString());
    const notification = fc.constantFrom('failed' as const, 'sent' as const, 'unavailable' as const);
    const state = fc.record({
      lastCheckAt: timestamp,
      lastFailure: fc.record({
        attempt: fc.integer({max: 1_000, min: 1}),
        failedAt: timestamp,
        fromVersion: version,
        notification,
        summary: fc.string({maxLength: 500}),
      }),
      lastSuccess: fc.record({
        completedAt: timestamp,
        fromVersion: version,
        notification,
        repairRequired: fc.boolean(),
        repairScope: fc.option(fc.constant('workflows' as const), {nil: undefined}),
        toVersion: version,
      }),
      policy: fc.constantFrom('automatic' as const, 'notify' as const),
      running: fc.record({
        attempt: fc.integer({max: 1_000, min: 1}),
        fromVersion: version,
        startedAt: timestamp,
      }),
      version: fc.constant(1 as const),
    });

    fc.assert(
      fc.property(state, candidate => {
        expect(parseAutoUpdateState(JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);
      }),
    );
  });

  it('increments attempts only for consecutive failures from the same active version', () => {
    const prior = {
      lastFailure: {
        attempt: 3,
        failedAt: '2026-08-13T08:00:00.000Z',
        fromVersion: '4.2.2',
        summary: 'network unavailable',
      },
      policy: 'automatic',
      version: 1,
    } satisfies AutoUpdateState;

    expect(nextAutoUpdateAttempt(prior, '4.2.2')).toBe(4);
    expect(nextAutoUpdateAttempt(prior, '4.2.3')).toBe(1);
  });

  it('never permits unattended replacement of a SHA-bound development runtime', () => {
    expect(isAutoUpdateVersionEligible('4.2.2')).toBe(true);
    expect(isAutoUpdateVersionEligible(`4.2.2-local.g${Effect2.pipe('a', EffectString.repeat(40))}`)).toBe(false);
  });

  it('projects every closed worker result without inventing a repair state', () => {
    const cases: ReadonlyArray<readonly [AutoUpdateWorkerResult, Readonly<Record<string, unknown>>]> = [
      [{result: 'busy'}, {autoUpdateResult: 'busy'}],
      [{result: 'current'}, {autoUpdateResult: 'current'}],
      [{result: 'disabled'}, {autoUpdateResult: 'disabled'}],
      [{result: 'failed'}, {autoUpdateResult: 'failed'}],
      [
        {repairRequired: false, result: 'updated'},
        {autoUpdateRepairRequired: false, autoUpdateResult: 'updated'},
      ],
      [
        {repairRequired: true, result: 'updated'},
        {autoUpdateRepairRequired: true, autoUpdateResult: 'updated'},
      ],
    ];

    for (const [result, expected] of cases) expect(autoUpdateWorkerTelemetryFields(result)).toEqual(expected);
  });

  it('removes every running claim from a terminal state transition', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: 1}), attempt => {
        const runningState = {
          policy: 'automatic',
          running: {attempt, fromVersion: '4.2.2', startedAt: '2026-08-13T08:00:00.000Z'},
          version: 1,
        } satisfies AutoUpdateState;
        const terminal = terminalAutoUpdateState(runningState, {
          lastCheckAt: '2026-08-13T09:00:00.000Z',
        });
        expect(terminal.running).toBe(undefined);
        expect(terminal).toMatchObject({policy: 'automatic', version: 1});
      }),
    );
  });

  it('does not resurrect a running claim when opt-out wins a failed-spawn race', () => {
    const claimedAt = '2026-08-13T09:00:00.000Z';
    const disabledAfterClaim = {
      lastCheckAt: claimedAt,
      policy: 'notify',
      version: 1,
    } satisfies AutoUpdateState;
    expect(
      stateAfterFailedAutoUpdateSpawn(disabledAfterClaim, {
        claimedAt,
        previousLastCheckAt: '2026-08-13T08:00:00.000Z',
      }),
    ).toEqual({
      lastCheckAt: '2026-08-13T08:00:00.000Z',
      policy: 'notify',
      version: 1,
    });
  });

  it('backs off failed checks and eventually recovers a stale running claim', () => {
    const checkedAt = Date.parse('2026-08-13T08:00:00.000Z');
    const failure = {
      lastCheckAt: new Date(checkedAt).toISOString(),
      lastFailure: {
        attempt: 1,
        failedAt: new Date(checkedAt).toISOString(),
        fromVersion: '4.2.2',
        summary: 'network unavailable',
      },
      policy: 'automatic',
      version: 1,
    } satisfies AutoUpdateState;
    expect(isAutoUpdateDue(failure, checkedAt + 14 * 60 * 1_000)).toBe(false);
    expect(isAutoUpdateDue(failure, checkedAt + 15 * 60 * 1_000)).toBe(true);

    const running = {
      ...failure,
      running: {attempt: 2, fromVersion: '4.2.2', startedAt: new Date(checkedAt).toISOString()},
    } satisfies AutoUpdateState;
    expect(isAutoUpdateDue(running, checkedAt + 29 * 60 * 1_000)).toBe(false);
    expect(isAutoUpdateDue(running, checkedAt + 30 * 60 * 1_000)).toBe(true);
  });
});
