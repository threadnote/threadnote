import * as EffectString from 'effect/String';
import {Array as EffectArray} from 'effect';
import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {DevSkillsConsumer} from './contract.js';
import {compareWrite, decode, fail, isRecord, json, readOptional, requireValue, stableJson} from './files.js';
import {consumerId, enrollmentContext, physicalDirectory, readReceipt} from './registry.js';
import {inspectDuplicates, inspectOwned, verifyReceiptProjection} from './inspection.js';
import {recoverTransaction} from './transaction.js';
import * as EffectRecord from 'effect/Record';
import * as Effect2 from 'effect';

export const restoreJournalPath = (path: Path.Path, root: string) =>
  path.join(physicalDirectory(path, root), 'restore-journal.json');
const isStringArray = (value: unknown): value is string[] =>
  EffectArray.isArray(value) && EffectArray.every(value, item => typeof item === 'string');

/** Files-only recovery: caller holds the original home's lease and physical root lock. */
export const restoreOwnedProjection = Effect.fn('devSkills.restoreOwnedProjection')(function* (
  config: RuntimeConfig,
  consumer: DevSkillsConsumer,
) {
  const path = yield* Path.Path;
  yield* recoverTransaction(consumer);
  const context = yield* enrollmentContext(config);
  const id = consumerId(consumer);
  const enrollment = context.homeIndex.targets[id];
  const physical = yield* readReceipt(consumer.target);
  const receipt = physical.receipt;
  if (
    !receipt ||
    !enrollment ||
    enrollment.state !== 'enrolled' ||
    !enrollment.enabled ||
    stableJson(context.runtimeIndex.enrollments[id]) !== stableJson(enrollment) ||
    stableJson(receipt?.consumers[id]) !== stableJson(consumer)
  )
    return yield* fail(
      'enrollment-conflict',
      'Maintenance requires matching enabled ownership in both indexes and the physical receipt.',
    );
  yield* verifyReceiptProjection(consumer.target, receipt);
  const file = restoreJournalPath(path, consumer.target.skillRoot);
  const existing = yield* readOptional(file);
  const inspected = yield* inspectOwned(consumer.target, receipt);
  const issues = [
    ...EffectArray.filter(
      inspected.issues,
      issue =>
        !(
          issue.code === 'modified' &&
          issue.path &&
          inspected.contents[
            EffectArray.join(
              Effect2.pipe(path.relative(consumer.target.skillRoot, issue.path), EffectString.split(path.sep)),
              '/',
            )
          ] === null
        ),
    ),
    ...(yield* inspectDuplicates(consumer.target)),
  ];
  if (issues.length)
    return yield* fail(
      'installation-conflict',
      EffectArray.join(
        EffectArray.map(issues, issue => issue.message),
        ' ',
      ),
    );
  const missing = EffectArray.filter(
    EffectRecord.keys(receipt.entrypoints),
    relative => inspected.contents[relative] === null,
  ).sort();
  if (existing === null && !missing.length) return false;
  const content = existing ?? json({schemaVersion: 1, consumerId: id, receipt: physical.content, missing});
  const request = yield* decode(content, value => {
    const missingNames = isRecord(value) && isStringArray(value.missing) ? value.missing : [];
    requireValue(
      isRecord(value) &&
        value.schemaVersion === 1 &&
        value.consumerId === id &&
        value.receipt === physical.content &&
        isStringArray(value.missing) &&
        value.missing.length <= 19 &&
        EffectArray.every(value.missing, item => item in receipt.entrypoints) &&
        new Set(value.missing).size === value.missing.length,
      'Invalid owned projection recovery.',
    );
    requireValue(
      EffectArray.every(missing, relative => missingNames.includes(relative)),
      'Recovery omits a missing owned projection.',
    );
    return {missing: missingNames};
  });
  if (existing === null) yield* compareWrite(file, null, content);
  for (const relative of request.missing)
    yield* compareWrite(path.join(consumer.target.skillRoot, relative), null, receipt.entrypoints[relative]);
  for (const [relative, expected] of EffectRecord.toEntries(receipt.entrypoints))
    if ((yield* readOptional(path.join(consumer.target.skillRoot, relative))) !== expected)
      return yield* fail('readback-conflict', 'Owned projection restoration did not verify.');
  if ((yield* readReceipt(consumer.target)).content !== physical.content)
    return yield* fail('recovery-conflict', 'Owned projection receipt changed.');
  yield* compareWrite(file, content, null);
  return true;
});
