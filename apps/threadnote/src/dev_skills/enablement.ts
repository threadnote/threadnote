import {Array as EffectArray} from 'effect';
import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {DevSkillsConsumer} from './contract.js';
import {compareWrite, decode, fail, isRecord, json, readOptional, requireValue, stableJson} from './files.js';
import {
  consumerId,
  journalPath,
  physicalDirectory,
  enrollmentContext,
  homeIndexPath,
  parseHomeIndex,
  parseRuntimeIndex,
  parseTarget,
  readReceipt,
  runtimeIndexPath,
} from './registry.js';
import * as EffectRecord from 'effect/Record';

interface EnablementJournal {
  readonly schemaVersion: 1;
  readonly consumer: DevSkillsConsumer;
  readonly homeBefore: string | null;
  readonly homeAfter: string;
  readonly runtimeBefore: string | null;
  readonly runtimeAfter: string;
}
export const enablementJournalPath = (path: Path.Path, home: string) =>
  path.join(home, 'dev-skills', 'enablement-journal.json');
function parse(value: unknown, home: string, root: string): EnablementJournal {
  requireValue(
    isRecord(value) &&
      value.schemaVersion === 1 &&
      isRecord(value.consumer) &&
      value.consumer.home === home &&
      value.consumer.installationRoot === root,
    'Invalid opt-out transaction identity.',
  );
  const consumer = {home, installationRoot: root, target: parseTarget(value.consumer.target)};
  const id = consumerId(consumer);
  requireValue(
    (value.homeBefore === null || typeof value.homeBefore === 'string') &&
      typeof value.homeAfter === 'string' &&
      (value.runtimeBefore === null || typeof value.runtimeBefore === 'string') &&
      typeof value.runtimeAfter === 'string',
    'Invalid opt-out images.',
  );
  const beforeHome = value.homeBefore === null ? undefined : parseHomeIndex(JSON.parse(value.homeBefore));
  const afterHome = parseHomeIndex(JSON.parse(value.homeAfter));
  const beforeRuntime = value.runtimeBefore === null ? undefined : parseRuntimeIndex(JSON.parse(value.runtimeBefore));
  const afterRuntime = parseRuntimeIndex(JSON.parse(value.runtimeAfter));
  requireValue(
    EffectArray.every(
      [beforeHome, afterHome],
      index => !index || (index.home === home && index.installationRoot === root),
    ) && EffectArray.every([beforeRuntime, afterRuntime], index => !index || index.installationRoot === root),
    'Opt-out index identities differ.',
  );
  const others = (entries: Readonly<Record<string, unknown>>) =>
    EffectRecord.fromEntries(EffectArray.filter(EffectRecord.toEntries(entries), ([key]) => key !== id));
  const previous = beforeHome?.targets[id];
  requireValue(
    stableJson(previous) === stableJson(beforeRuntime?.enrollments[id]),
    'Opt-out cannot repair mismatched enrollment.',
  );
  const desired = {
    ...consumer,
    ...(previous?.createdBy ? {createdBy: previous.createdBy} : {}),
    state: previous?.state ?? 'removed',
    enabled: false,
  };
  requireValue(
    stableJson(afterHome.targets[id]) === stableJson(desired) &&
      stableJson(afterRuntime.enrollments[id]) === stableJson(desired) &&
      stableJson(others(beforeHome?.targets ?? {})) === stableJson(others(afterHome.targets)) &&
      stableJson(others(beforeRuntime?.enrollments ?? {})) === stableJson(others(afterRuntime.enrollments)),
    'Opt-out may only disable its exact consumer.',
  );
  return {
    schemaVersion: 1,
    consumer,
    homeBefore: value.homeBefore,
    homeAfter: value.homeAfter,
    runtimeBefore: value.runtimeBefore,
    runtimeAfter: value.runtimeAfter,
  };
}
const execute = Effect.fn('devSkills.executeOptOut')(function* (journal: EnablementJournal, content: string) {
  const path = yield* Path.Path;
  const {consumer} = journal;
  const id = consumerId(consumer);
  const desired = (yield* decode(journal.homeAfter, parseHomeIndex)).targets[id];
  const receipt = (yield* readReceipt(consumer.target)).receipt;
  if (
    (desired.state === 'enrolled') !== Boolean(receipt?.consumers[id]) ||
    (receipt?.consumers[id] && stableJson(receipt.consumers[id]) !== stableJson(consumer))
  )
    return yield* fail('enrollment-conflict', 'Opt-out ownership differs; preserve the interrupted operation.');
  const changes = [
    {file: homeIndexPath(path, consumer.home), before: journal.homeBefore, after: journal.homeAfter},
    {
      file: runtimeIndexPath(path, consumer.installationRoot),
      before: journal.runtimeBefore,
      after: journal.runtimeAfter,
    },
  ];
  for (const change of changes) {
    const current = yield* readOptional(change.file);
    if (current !== change.before && current !== change.after)
      return yield* fail('recovery-conflict', 'Opt-out found changed enrollment; preserve it for recovery.');
  }
  for (const change of changes) yield* compareWrite(change.file, change.before, change.after);
  for (const change of changes)
    if ((yield* readOptional(change.file)) !== change.after)
      return yield* fail('readback-conflict', 'Opt-out enrollment readback differs.');
  yield* compareWrite(enablementJournalPath(path, consumer.home), content, null);
});
/** Called with the original home's setup lock and its runtime coordinator held. */
export const recoverEnablement = Effect.fn('devSkills.recoverEnablement')(function* (home: string, root: string) {
  const path = yield* Path.Path;
  const content = yield* readOptional(enablementJournalPath(path, home));
  if (content === null) return;
  const journal = yield* decode(content, value => parse(value, home, root));
  yield* execute(journal, content);
});
export const disableEnrollment = Effect.fn('devSkills.disableEnrollment')(function* (
  config: RuntimeConfig,
  consumer: DevSkillsConsumer,
) {
  const path = yield* Path.Path;
  const context = yield* enrollmentContext(config);
  const id = consumerId(consumer);
  if (context.home !== consumer.home || context.root !== consumer.installationRoot)
    return yield* fail('enrollment-conflict', 'Opt-out coordinator identity changed.');
  if (
    (yield* readOptional(journalPath(path, consumer.target.skillRoot))) !== null ||
    (yield* readOptional(path.join(physicalDirectory(path, consumer.target.skillRoot), 'restore-journal.json'))) !==
      null
  )
    return yield* fail(
      'recovery-needed',
      'Recover the original owned workflow transaction before changing enablement.',
    );
  const previous = context.homeIndex.targets[id];
  const desired = {
    ...consumer,
    ...(previous?.createdBy ? {createdBy: previous.createdBy} : {}),
    state: previous?.state ?? 'removed',
    enabled: false,
  };
  const journal: EnablementJournal = {
    schemaVersion: 1,
    consumer,
    homeBefore: context.homeContent,
    homeAfter: json({...context.homeIndex, targets: {...context.homeIndex.targets, [id]: desired}}),
    runtimeBefore: context.runtimeContent,
    runtimeAfter: json({...context.runtimeIndex, enrollments: {...context.runtimeIndex.enrollments, [id]: desired}}),
  };
  if (journal.homeBefore === journal.homeAfter && journal.runtimeBefore === journal.runtimeAfter) return;
  const content = json(journal);
  if (Buffer.byteLength(content) > 8_000_000)
    return yield* fail('state-capacity', 'Opt-out transaction exceeds its bounded capacity.');
  yield* decode(content, value => parse(value, context.home, context.root));
  yield* compareWrite(enablementJournalPath(path, context.home), null, content);
  yield* execute(journal, content);
});
