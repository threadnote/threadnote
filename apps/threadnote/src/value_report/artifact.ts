import {Effect, FileSystem, Path, Schema} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {VALUE_REPORT_EXPORT_DIRECTORY, withValueReportStorageLock, removeStaleValueReportStaging} from './storage.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export class ValueArtifactError extends Schema.TaggedError<ValueArtifactError, {readonly brand: unique symbol}>()(
  'ValueArtifactError',
  {
    message: Schema.String,
  },
) {}

export const writeValueArtifactUnderLock = Effect.fn('valueReport.writeArtifactUnderLock')(function* (
  agentContextHome: string,
  serialized: string,
  prefix: 'threadnote-value-report-export-v1' | 'threadnote-value-pilot-report-v1',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* removeStaleValueReportStaging(agentContextHome);
  const digest = yield* sha256Hex(serialized);
  const directory = path.join(
    agentContextHome,
    ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')),
  );
  const output = path.join(directory, `${prefix}-${Effect2.pipe(digest, EffectString.slice(0, 24))}.json`);
  if (yield* fs.exists(output)) {
    if ((yield* fs.readFileString(output)) !== serialized)
      return yield* ValueArtifactError.make({message: 'Value export digest conflict.'});
    yield* fs.chmod(directory, 0o700);
    yield* fs.chmod(output, 0o600);
    return output;
  }
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* fs.chmod(directory, 0o700);
  const staging = path.join(directory, `.${prefix}-${Effect2.pipe(digest, EffectString.slice(0, 24))}.staging`);
  yield* fs.makeDirectory(staging, {mode: 0o700});
  const temporary = path.join(staging, 'report.json');
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600});
    yield* fs.chmod(temporary, 0o600);
    const renamed = yield* fs.rename(temporary, output).pipe(Effect.result);
    if (renamed._tag === 'Success') return;
    if ((yield* fs.exists(output)) && (yield* fs.readFileString(output)) === serialized) return;
    return yield* renamed.failure;
  }).pipe(Effect.ensuring(fs.remove(staging, {force: true, recursive: true}).pipe(Effect.ignore)));
  yield* fs.chmod(output, 0o600);
  return output;
});

export const writeValueArtifact = Effect.fn('valueReport.writeArtifact')(
  (
    home: string,
    serialized: string,
    prefix: 'threadnote-value-report-export-v1' | 'threadnote-value-pilot-report-v1',
  ) => withValueReportStorageLock(home, writeValueArtifactUnderLock(home, serialized, prefix)),
);
