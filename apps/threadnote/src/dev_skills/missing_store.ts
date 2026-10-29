import {Array, Effect, FileSystem, Path, Record} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {installationRoot} from '../process/standalone_lease.js';
import type {DevSkillsConsumer, DevSkillsTarget} from './contract.js';
import {assertSafePath, stableJson, statOptional} from './files.js';
import {consumerId, physicalDirectory, type Enrollment, type enrollmentContext} from './registry.js';

/** Known enrollment survives a lost receipt, including a disabled consumer or a path alias. */
export const knownStoreEnrollments = Effect.fn('devSkills.knownStoreEnrollments')(function* (
  context: Effect.Success<ReturnType<typeof enrollmentContext>>,
  target: DevSkillsTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Enrollment[] = [];
  for (const entry of [
    ...Record.values(context.homeIndex.targets),
    ...Record.values(context.runtimeIndex.enrollments),
  ]) {
    if (entry.state !== 'enrolled') continue;
    const root = path.resolve(entry.target.skillRoot);
    const info = yield* statOptional(root);
    // An absent leaf cannot hide a linked ancestor that would share a future destination.
    if (!info) yield* assertSafePath(root);
    const canonical = info ? yield* fs.realPath(root) : root;
    if (canonical === target.skillRoot) entries.push(entry);
  }
  return entries;
});

/** Absence grants only a new install, never ownership of any surviving bytes or missing history. */
export const missingStoreIsEmpty = Effect.fn('devSkills.missingStoreIsEmpty')(function* (
  context: Effect.Success<ReturnType<typeof enrollmentContext>>,
  consumer: DevSkillsConsumer,
  physicalLockHeld: boolean,
  sharing: readonly Enrollment[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const id = consumerId(consumer);
  const homeEntry = context.homeIndex.targets[id];
  const runtimeEntry = context.runtimeIndex.enrollments[id];
  if (
    context.homeContent === null ||
    context.runtimeContent === null ||
    context.root !== installationRoot(path, system) ||
    homeEntry?.state !== 'enrolled' ||
    stableJson(homeEntry) !== stableJson(runtimeEntry) ||
    stableJson({home: homeEntry.home, installationRoot: homeEntry.installationRoot, target: homeEntry.target}) !==
      stableJson(consumer)
  )
    return false;
  for (const location of [context.home, context.root, consumer.target.skillRoot]) yield* assertSafePath(location);
  if (Array.some(sharing, entry => consumerId(entry) !== id)) return false;
  const emptyDirectory = Effect.fn('devSkills.absentOrEmptyDirectory')(function* (directory: string, ownLock = false) {
    yield* assertSafePath(directory);
    const info = yield* statOptional(directory);
    if (!info) return true;
    if (info.type !== 'Directory') return false;
    const children = yield* fs.readDirectory(directory);
    return Array.every(children, name => ownLock && name === '.mutation.lock');
  });
  if (!(yield* emptyDirectory(physicalDirectory(path, consumer.target.skillRoot), physicalLockHeld))) return false;
  for (const skill of ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr']) {
    const location = path.join(consumer.target.skillRoot, consumer.target.layout === 'flat' ? `${skill}.md` : skill);
    if (consumer.target.layout === 'directory') {
      if (!(yield* emptyDirectory(location))) return false;
    } else {
      yield* assertSafePath(location);
      if (yield* statOptional(location)) return false;
    }
  }
  return true;
});
