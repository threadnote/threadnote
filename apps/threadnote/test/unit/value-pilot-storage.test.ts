import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';

import {buildPilotReport} from '@threadnote/threadnote/value_report/pilot';
import {exportPilotReport, managePilotReports} from '@threadnote/threadnote/value_report/pilot/storage';
import {
  deleteValueReportData,
  pruneValueReportData,
  VALUE_REPORT_EXPORT_DIRECTORY,
  withValueReportStorageLock,
} from '@threadnote/threadnote/value_report/storage';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {pilotInput} from '../helpers/value-pilot-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);

effectIt.effect('keeps preview read-only, exports idempotently, and resets only managed pilot artifacts', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-pilot-'});
      yield* TestClock.setTime(Date.parse('2026-09-01T00:00:00.000Z'));
      const report = buildPilotReport(pilotInput());
      const directory = path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')));
      const before = yield* fs.readDirectory(home);
      expect((yield* exportPilotReport(home, report, false)).applied).toBe(false);
      expect(yield* fs.readDirectory(home)).toEqual(before);
      const receipt = yield* exportPilotReport(home, report, true);
      expect(yield* exportPilotReport(home, report, true)).toEqual(receipt);
      const names = yield* fs.readDirectory(directory);
      expect(names).toEqual([expect.stringMatching(/^threadnote-value-pilot-report-v1-/u)]);
      expect((yield* fs.stat(path.join(directory, names[0]))).mode & 0o077).toBe(0);
      const raw = yield* fs.readFileString(path.join(directory, names[0]));
      expect(raw).not.toContain('"actor":');
      expect(raw).not.toContain('"item":');
      const unrelated = path.join(directory, 'keep.txt');
      yield* fs.writeFileString(unrelated, 'unrelated');
      const preview = yield* managePilotReports(home, 'reset', false);
      expect(preview).toMatchObject({selected: 1, removed: 0, applied: false, correlationRecords: 0});
      expect(yield* managePilotReports(home, 'reset', false)).toEqual(preview);
      const applied = yield* managePilotReports(home, 'reset', true, preview.selectionDigest);
      expect(applied.selectionDigest).toBe(preview.selectionDigest);
      expect(applied.removed).toBe(1);
      expect(yield* fs.readDirectory(directory)).toEqual(['keep.txt']);
      const empty = yield* managePilotReports(home, 'reset', false);
      expect((yield* managePilotReports(home, 'reset', true, empty.selectionDigest)).removed).toBe(0);
    }),
  ).pipe(provideTestLayer(layer)),
);

effectIt.effect('bounds retention and includes pilot exports in existing value-data deletion', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-pilot-retention-'});
      yield* TestClock.setTime(Date.parse('2026-09-01T00:00:00.000Z'));
      const report = buildPilotReport(pilotInput());
      yield* exportPilotReport(home, report, true);
      expect((yield* managePilotReports(home, 'retention', false)).selected).toBe(0);
      yield* TestClock.setTime(Date.parse('2026-09-28T00:00:00.000Z'));
      expect((yield* managePilotReports(home, 'retention', false)).selected).toBe(1);
      expect((yield* managePilotReports(home, 'retention', true)).removed).toBe(1);
      expect((yield* Effect.result(exportPilotReport(home, report, true)))._tag).toBe('Failure');
      yield* TestClock.setTime(Date.parse('2026-09-01T00:00:00.000Z'));
      yield* exportPilotReport(home, report, true);
      const deletion = yield* deleteValueReportData(home, {
        apply: true,
        exports: true,
        feedback: false,
        valueEvents: false,
      });
      expect(deletion.exports).toEqual({removed: 1, selected: true});
    }),
  ).pipe(provideTestLayer(layer)),
);

effectIt.effect('rejects reset without its preview digest and on selection drift before deleting', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-pilot-drift-'});
      yield* TestClock.setTime(Date.parse('2026-09-01T00:00:00.000Z'));
      const preview = yield* managePilotReports(home, 'reset', false);
      yield* exportPilotReport(home, buildPilotReport(pilotInput()), true);
      expect((yield* Effect.result(managePilotReports(home, 'reset', true)))._tag).toBe('Failure');
      expect((yield* Effect.result(managePilotReports(home, 'reset', true, preview.selectionDigest)))._tag).toBe(
        'Failure',
      );
      expect((yield* managePilotReports(home, 'reset', false)).selected).toBe(1);
    }),
  ).pipe(provideTestLayer(layer)),
);

effectIt.effect('includes abandoned artifact staging in pilot reset, retention, and general cleanup', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-pilot-staging-'});
      const directory = path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')));
      const pilot = `.threadnote-value-pilot-report-v1-${Effect2.pipe('a', EffectString.repeat(24))}.staging`;
      const general = `.threadnote-value-report-export-v1-${Effect2.pipe('b', EffectString.repeat(24))}.staging`;
      const seed = (name: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(directory, name), {recursive: true});
          yield* fs.writeFileString(path.join(directory, name, 'report.json'), 'complete private report');
        });
      yield* seed(pilot);
      yield* seed(general);
      const preview = yield* managePilotReports(home, 'reset', false);
      expect(preview.selected).toBe(1);
      expect(yield* fs.exists(path.join(directory, pilot, 'report.json'))).toBe(true);
      yield* managePilotReports(home, 'reset', true, preview.selectionDigest);
      expect(yield* fs.readDirectory(directory)).toEqual([general]);
      yield* seed(pilot);
      expect((yield* managePilotReports(home, 'retention', true)).removed).toBe(1);
      expect(yield* fs.readDirectory(directory)).toEqual([general]);
      yield* pruneValueReportData(home, {
        apply: true,
        now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-01T00:00:00.000Z')),
        retentionDays: 28,
      });
      expect(yield* fs.readDirectory(directory)).toEqual([]);
      yield* seed(pilot);
      yield* seed(general);
      expect(
        (yield* deleteValueReportData(home, {apply: true, exports: true, feedback: false, valueEvents: false})).exports
          .removed,
      ).toBe(2);
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }),
  ).pipe(provideTestLayer(layer)),
);

effectIt.effect('does not remove staging while its writer owns the storage lock', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-pilot-active-'});
      const staging = path.join(
        home,
        ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')),
        `.threadnote-value-pilot-report-v1-${Effect2.pipe('a', EffectString.repeat(24))}.staging`,
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* withValueReportStorageLock(
        home,
        Effect.gen(function* () {
          yield* fs.makeDirectory(staging, {recursive: true});
          yield* fs.writeFileString(path.join(staging, 'report.json'), 'in progress');
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          expect(yield* fs.exists(path.join(staging, 'report.json'))).toBe(true);
          yield* fs.remove(staging, {recursive: true});
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const cleanup = yield* managePilotReports(home, 'retention', true).pipe(TestClock.withLive, Effect.forkChild);
      yield* Effect.sleep('100 millis').pipe(TestClock.withLive);
      expect(yield* fs.exists(staging)).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      expect((yield* Fiber.join(cleanup)).removed).toBe(0);
    }),
  ).pipe(provideTestLayer(layer)),
);
