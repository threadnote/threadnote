import {DateTime, Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readOperatorJson} from '@threadnote/remote-memory/operator/files';
import {ValueArtifactError, writeValueArtifactUnderLock} from '../artifact.js';
import {parsePilotReport, serializePilotReport} from '../pilot.js';
import {PILOT_RETENTION_DAYS, type PilotReport} from './contract.js';
import {VALUE_REPORT_EXPORT_DIRECTORY, PILOT_REPORT_STAGING_FILENAME, withValueReportStorageLock} from '../storage.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

export const PILOT_EXPORT_FILENAME = /^threadnote-value-pilot-report-v1-[a-f0-9]{24}\.json$/u;
const MAX_EXPORTS = 100;

export const exportPilotReport = Effect.fn('valueReport.pilot.export')(function* (
  home: string,
  report: PilotReport,
  apply: boolean,
) {
  const serialized = yield* Effect.try(() => `${serializePilotReport(report)}\n`);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const end = reportEnd(report);
  if (end > now || now >= end + PILOT_RETENTION_DAYS * 86_400_000) {
    return yield* ValueArtifactError.make({message: 'Pilot export is outside its retention window.'});
  }
  if (apply) {
    yield* withValueReportStorageLock(
      home,
      Effect.gen(function* () {
        yield* pruneExports(home, now, true);
        const names = yield* pilotExportNames(home);
        const filename = `threadnote-value-pilot-report-v1-${Effect2.pipe(sha256HexSync(serialized), EffectString.slice(0, 24))}.json`;
        if (names.length >= MAX_EXPORTS && !names.includes(filename)) {
          return yield* ValueArtifactError.make({
            message: 'Pilot export capacity reached; reset managed exports before continuing.',
          });
        }
        yield* writeValueArtifactUnderLock(home, serialized, 'threadnote-value-pilot-report-v1');
      }),
    );
  }
  return {
    schema: 'threadnote.value-pilot-export-receipt.v1',
    version: 1,
    applied: apply,
    reportDigest: report.reportDigest,
    publication: 'none',
    retentionDays: PILOT_RETENTION_DAYS,
  } as const;
});

export const managePilotReports = Effect.fn('valueReport.pilot.manage')(function* (
  home: string,
  action: 'retention' | 'reset',
  apply: boolean,
  expectedSelectionDigest?: string,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const mutate = Effect.gen(function* () {
    const names = action === 'reset' ? yield* pilotExportNames(home) : yield* expiredNames(home, now);
    const selectionDigest = sha256HexSync(JSON.stringify(names));
    if (action === 'reset' && apply && expectedSelectionDigest !== selectionDigest) {
      return yield* ValueArtifactError.make({message: 'Reset requires the current preview selection digest.'});
    }
    if (action !== 'reset' && expectedSelectionDigest !== undefined) {
      return yield* ValueArtifactError.make({message: 'Selection digest is only accepted for reset.'});
    }
    if (apply) yield* removeExports(home, names);
    return {
      schema: 'threadnote.value-pilot-storage-receipt.v1',
      version: 1,
      action,
      applied: apply,
      selected: names.length,
      removed: apply ? names.length : 0,
      selectionDigest,
      correlationRecords: 0,
      scope: 'managed-pilot-exports-only',
      externalCopies: 'caller-owned',
      retentionDays: PILOT_RETENTION_DAYS,
    } as const;
  });
  return yield* apply ? withValueReportStorageLock(home, mutate) : mutate;
});

const pilotExportNames = Effect.fn('valueReport.pilot.exportNames')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')));
  if (!(yield* fs.exists(directory))) return [];
  return EffectArray.filter(
    yield* fs.readDirectory(directory),
    __effectArrayValue =>
      !!(name => PILOT_EXPORT_FILENAME.test(name) || PILOT_REPORT_STAGING_FILENAME.test(name))(__effectArrayValue),
  ).sort();
});

const expiredNames = Effect.fn('valueReport.pilot.expiredNames')(function* (home: string, now: number) {
  const path = yield* Path.Path;
  const names = yield* pilotExportNames(home);
  if (names.length > MAX_EXPORTS)
    return yield* ValueArtifactError.make({message: 'Pilot export capacity exceeded; use reset.'});
  const expired: string[] = [];
  for (const name of names) {
    if (PILOT_REPORT_STAGING_FILENAME.test(name)) {
      expired.push(name);
      continue;
    }
    const raw = yield* readOperatorJson(
      path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')), name),
    );
    const report = yield* Effect.try(() => parsePilotReport(raw));
    if (now >= reportEnd(report) + PILOT_RETENTION_DAYS * 86_400_000) expired.push(name);
  }
  return expired;
});

const removeExports = Effect.fn('valueReport.pilot.removeExports')(function* (home: string, names: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.forEach(
    names,
    name =>
      fs.remove(path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')), name), {
        force: true,
        recursive: true,
      }),
    {concurrency: 4, discard: true},
  );
});
const pruneExports = Effect.fn('valueReport.pilot.pruneExports')(function* (home: string, now: number, apply: boolean) {
  const names = yield* expiredNames(home, now);
  if (apply) yield* removeExports(home, names);
});
function reportEnd(report: PilotReport): number {
  return Date.parse(`${report.windowStart}T00:00:00.000Z`) + report.elapsedDays * 86_400_000;
}
