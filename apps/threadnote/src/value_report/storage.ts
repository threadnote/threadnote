import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  clearRecallFeedbackEvents,
  pruneRecallFeedbackEvents,
  type RecallFeedbackStorageResultV1,
} from '@threadnote/recall/feedback';
import {clearLocalValueEvents, pruneLocalValueEvents, type LocalValueEventStorageResultV1} from './events.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const VALUE_REPORT_STORAGE_VERSION = 1 as const;
export const VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE = 10_000 as const;
export const VALUE_REPORT_EXPORT_DIRECTORY = 'exports/value-reports' as const;
export const VALUE_REPORT_STAGING_FILENAME =
  /^\.threadnote-value-(?:report-export|pilot-report)-v1-[0-9a-f]{24}\.staging$/u;
export const PILOT_REPORT_STAGING_FILENAME = /^\.threadnote-value-pilot-report-v1-[0-9a-f]{24}\.staging$/u;
const VALUE_REPORT_EXPORT_FILENAME = /^threadnote-value-(?:report-export|pilot-report)-v1-[0-9a-f]{24}\.json$/u;

export interface ValueReportRetentionReceiptV1 {
  readonly applied: boolean;
  readonly feedback: RecallFeedbackStorageResultV1;
  readonly retentionDays: number;
  readonly type: 'value-report-retention';
  readonly valueEvents: LocalValueEventStorageResultV1;
  readonly version: typeof VALUE_REPORT_STORAGE_VERSION;
}

export interface ValueReportDeletionReceiptV1 {
  readonly applied: boolean;
  readonly exports: {readonly removed: number; readonly selected: boolean};
  readonly feedback: RecallFeedbackStorageResultV1 & {readonly selected: boolean};
  readonly type: 'value-report-deletion';
  readonly valueEvents: LocalValueEventStorageResultV1 & {readonly selected: boolean};
  readonly version: typeof VALUE_REPORT_STORAGE_VERSION;
}

export const pruneValueReportData = Effect.fn('valueReport.pruneData')(function* (
  agentContextHome: string,
  input: {readonly apply: boolean; readonly now: Date; readonly retentionDays: number},
) {
  const [feedback, valueEvents] = yield* Effect.all(
    [pruneRecallFeedbackEvents(agentContextHome, input), pruneLocalValueEvents(agentContextHome, input)],
    {concurrency: 2},
  );
  if (input.apply) yield* withValueReportStorageLock(agentContextHome, removeStaleValueReportStaging(agentContextHome));
  return {
    applied: input.apply,
    feedback,
    retentionDays: input.retentionDays,
    type: 'value-report-retention',
    valueEvents,
    version: VALUE_REPORT_STORAGE_VERSION,
  } satisfies ValueReportRetentionReceiptV1;
});

export const deleteValueReportData = Effect.fn('valueReport.deleteData')(function* (
  agentContextHome: string,
  input: {
    readonly apply: boolean;
    readonly exports: boolean;
    readonly feedback: boolean;
    readonly valueEvents: boolean;
  },
) {
  const [feedback, valueEvents, exportsRemoved] = yield* Effect.all(
    [
      input.feedback
        ? clearRecallFeedbackEvents(agentContextHome, input.apply)
        : Effect.succeed({after: 0, applied: input.apply, before: 0, removed: 0}),
      input.valueEvents
        ? clearLocalValueEvents(agentContextHome, input.apply)
        : Effect.succeed({after: 0, applied: input.apply, before: 0, removed: 0}),
      input.exports ? deleteValueReportExports(agentContextHome, input.apply) : Effect.succeed(0),
    ],
    {concurrency: 3},
  );
  return {
    applied: input.apply,
    exports: {removed: exportsRemoved, selected: input.exports},
    feedback: {...feedback, selected: input.feedback},
    type: 'value-report-deletion',
    valueEvents: {...valueEvents, selected: input.valueEvents},
    version: VALUE_REPORT_STORAGE_VERSION,
  } satisfies ValueReportDeletionReceiptV1;
});

const deleteValueReportExports = Effect.fn('valueReport.deleteExports')((agentContextHome: string, apply: boolean) => {
  const operation = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      agentContextHome,
      ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')),
    );
    if (!(yield* fs.exists(directory))) return 0;
    const names = selectValueReportExportNames(yield* fs.readDirectory(directory));
    if (apply) {
      for (let offset = 0; offset < names.length; offset += VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE) {
        yield* Effect.forEach(
          names.slice(offset, offset + VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE),
          name => fs.remove(path.join(directory, name), {force: true, recursive: true}),
          {concurrency: 16, discard: true},
        );
      }
    }
    return names.length;
  });
  return apply ? withValueReportStorageLock(agentContextHome, operation) : operation;
});

export function selectValueReportExportNames(names: readonly string[]): readonly string[] {
  return EffectArray.filter(
    names,
    (name, __effectArrayIndex) =>
      __effectArrayIndex in names &&
      (VALUE_REPORT_EXPORT_FILENAME.test(name) || VALUE_REPORT_STAGING_FILENAME.test(name)),
  ).sort();
}

export function withValueReportStorageLock<A, E, R>(home: string, operation: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* withExclusiveFileLock(
      fs,
      path.join(home, 'value', 'export.lock'),
      {
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 300_000,
        waitTimeoutMilliseconds: 5_000,
      },
      operation,
    );
  });
}

// Every artifact writer holds the same lock, so staging seen inside it has no active writer.
export const removeStaleValueReportStaging = Effect.fn('valueReport.removeStaleStaging')(function* (
  home: string,
  pilotOnly = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')));
  if (!(yield* fs.exists(directory))) return;
  const pattern = pilotOnly ? PILOT_REPORT_STAGING_FILENAME : VALUE_REPORT_STAGING_FILENAME;
  for (const name of yield* fs.readDirectory(directory)) {
    if (pattern.test(name)) yield* fs.remove(path.join(directory, name), {force: true, recursive: true});
  }
});
