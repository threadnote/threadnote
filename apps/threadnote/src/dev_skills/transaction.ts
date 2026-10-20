import {Effect, FileSystem, Path} from 'effect';
import type {DevSkillsBundle, DevSkillsConsumer} from './contract.js';
import {
  assertSafePath,
  compareWrite,
  decode,
  fail,
  hash,
  isRecord,
  json,
  readOptional,
  requireValue,
  statOptional,
  stableJson,
} from './files.js';
import {generationRoot, renderEntrypoints, verifyGeneration, verifyHistoricalProjection} from './inspection.js';
import {DEV_SKILLS_MAX_HISTORICAL_SUPPORT_MEMBERS, parseDevSkillsManifest} from './manifest.js';
import {
  consumerId,
  homeIndexPath,
  journalPath,
  parseHomeIndex,
  parseReceipt,
  parseRuntimeIndex,
  parseTarget,
  receiptPath,
  runtimeIndexPath,
} from './registry.js';
import type {FileChange, PlannedMutation} from './plan.js';

interface Journal {
  readonly schemaVersion: 1;
  readonly consumer: DevSkillsConsumer;
  readonly previewDigest: string;
  readonly generation: DevSkillsBundle | null;
  readonly changes: readonly FileChange[];
}
function parseBundle(value: unknown): DevSkillsBundle | null {
  if (value === null) return null;
  requireValue(isRecord(value) && isRecord(value.files), 'Invalid transaction generation.');
  const manifest = parseDevSkillsManifest(value.manifest);
  const files: Record<string, string> = {};
  requireValue(
    Object.keys(value.files).length === Object.keys(manifest.hashes).length,
    'Invalid transaction inventory.',
  );
  let size = 0;
  for (const [file, digest] of Object.entries(manifest.hashes)) {
    const encoded = value.files[file];
    requireValue(typeof encoded === 'string', 'Missing transaction payload.');
    const bytes = Buffer.from(encoded, 'base64');
    size += bytes.length;
    requireValue(
      size <= 2_000_000 && bytes.toString('base64') === encoded && hash(bytes) === digest,
      'Transaction payload differs from its immutable manifest.',
    );
    files[file] = encoded;
  }
  return {manifest, files};
}
function assertTransition(journal: Journal, path: Path.Path) {
  const {consumer, changes, generation} = journal;
  const target = consumer.target;
  const id = consumerId(consumer);
  const receiptChange = changes.find(change => change.path === receiptPath(path, target.skillRoot));
  requireValue(
    receiptChange?.after !== null && receiptChange?.after !== undefined,
    'A transaction requires its physical ownership transition.',
  );
  const before = receiptChange.before === null ? undefined : parseReceipt(JSON.parse(receiptChange.before));
  const after = parseReceipt(JSON.parse(receiptChange.after));
  const others = (values: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(Object.entries(values).filter(([key]) => key !== id));
  requireValue(
    stableJson(others(before?.consumers ?? {})) === stableJson(others(after.consumers)),
    'A transaction cannot change another consumer.',
  );
  if (generation) {
    requireValue(
      stableJson(after.consumers[id]) === stableJson(consumer) &&
        stableJson(after.manifest) === stableJson(generation.manifest) &&
        stableJson(after.entrypoints) === stableJson(renderEntrypoints(path, target, generation)) &&
        stableJson(after.generations) ===
          stableJson({...before?.generations, [generation.manifest.digest]: generation.manifest}),
      'Installed postimage differs from its captured generation or consumer.',
    );
  } else {
    requireValue(
      before?.consumers[id] &&
        !(id in after.consumers) &&
        stableJson(before.manifest) === stableJson(after.manifest) &&
        stableJson(before.generations) === stableJson(after.generations) &&
        stableJson(after.entrypoints) === stableJson(Object.keys(after.consumers).length ? before.entrypoints : {}),
      'Removal lacks prior ownership or changes retained resources.',
    );
  }
  for (const change of changes) {
    const relative = path.relative(target.skillRoot, change.path).split(path.sep).join('/');
    if (relative in (before?.entrypoints ?? {}) || relative in after.entrypoints)
      requireValue(
        change.before === (before?.entrypoints[relative] ?? null) &&
          change.after === (after.entrypoints[relative] ?? null),
        'A discovery write lacks its exact owned preimage/postimage.',
      );
    for (const kind of ['home', 'runtime'] as const) {
      const file =
        kind === 'home' ? homeIndexPath(path, consumer.home) : runtimeIndexPath(path, consumer.installationRoot);
      if (change.path !== file) continue;
      requireValue(change.after !== null, 'Enrollment indexes are retained, not deleted.');
      const entries = (content: string | null) =>
        content === null
          ? {}
          : kind === 'home'
            ? parseHomeIndex(JSON.parse(content)).targets
            : parseRuntimeIndex(JSON.parse(content)).enrollments;
      const oldEntries = entries(change.before);
      const newEntries = entries(change.after);
      requireValue(
        stableJson(others(oldEntries)) === stableJson(others(newEntries)) &&
          stableJson(newEntries[id]) === stableJson({...consumer, state: generation ? 'enrolled' : 'removed'}),
        'A transaction cannot rewrite foreign enrollment or omit its own tombstone.',
      );
    }
  }
}

function parseJournal(value: unknown, path: Path.Path): Journal {
  requireValue(
    isRecord(value) &&
      value.schemaVersion === 1 &&
      isRecord(value.consumer) &&
      typeof value.consumer.home === 'string' &&
      path.isAbsolute(value.consumer.home) &&
      typeof value.consumer.installationRoot === 'string' &&
      path.isAbsolute(value.consumer.installationRoot) &&
      typeof value.previewDigest === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.previewDigest) &&
      Array.isArray(value.changes) &&
      value.changes.length <= DEV_SKILLS_MAX_HISTORICAL_SUPPORT_MEMBERS + 4 + 3,
    'Invalid development skills transaction.',
  );
  const consumer = {
    home: value.consumer.home,
    installationRoot: value.consumer.installationRoot,
    target: parseTarget(value.consumer.target),
  };
  const target = consumer.target;
  const generation = parseBundle(value.generation);
  const metadata = new Map([
    [homeIndexPath(path, consumer.home), 'home'],
    [runtimeIndexPath(path, consumer.installationRoot), 'runtime'],
    [receiptPath(path, target.skillRoot), 'receipt'],
  ]);
  const ownershipChange = value.changes.find(
    item => isRecord(item) && item.path === receiptPath(path, target.skillRoot),
  );
  requireValue(isRecord(ownershipChange), 'A transaction requires its physical ownership transition.');
  const entrypoints = new Set<string>();
  for (const content of [ownershipChange.before, ownershipChange.after]) {
    if (content === null) continue;
    requireValue(typeof content === 'string', 'Invalid ownership transition content.');
    const receipt = parseReceipt(JSON.parse(content));
    for (const relative of Object.keys(receipt.entrypoints)) entrypoints.add(path.join(target.skillRoot, relative));
  }
  const projected = generation ? renderEntrypoints(path, target, generation) : undefined;
  const changes: FileChange[] = [];
  for (const item of value.changes) {
    requireValue(
      isRecord(item) &&
        typeof item.path === 'string' &&
        (item.before === null || typeof item.before === 'string') &&
        (item.after === null || typeof item.after === 'string') &&
        (metadata.has(item.path) || entrypoints.has(item.path)),
      'Invalid transaction destination.',
    );
    if (metadata.has(item.path))
      for (const content of [item.before, item.after]) {
        if (content === null) continue;
        const decoded: unknown = JSON.parse(content);
        if (metadata.get(item.path) === 'home') {
          const index = parseHomeIndex(decoded);
          requireValue(
            index.home === consumer.home && index.installationRoot === consumer.installationRoot,
            'Transaction home differs.',
          );
        } else if (metadata.get(item.path) === 'runtime') {
          requireValue(
            parseRuntimeIndex(decoded).installationRoot === consumer.installationRoot,
            'Transaction runtime differs.',
          );
        } else {
          const receipt = parseReceipt(decoded);
          requireValue(
            receipt.skillRoot === target.skillRoot && receipt.layout === target.layout,
            'Transaction receipt differs.',
          );
        }
      }
    else if (item.after !== null)
      requireValue(
        projected && projected[path.relative(target.skillRoot, item.path).split(path.sep).join('/')] === item.after,
        'Transaction entrypoint differs from the immutable generation.',
      );
    changes.push({path: item.path, before: item.before, after: item.after});
  }
  requireValue(
    new Set(changes.map(change => change.path)).size === changes.length,
    'Duplicate transaction destination.',
  );
  const journal: Journal = {schemaVersion: 1, consumer, previewDigest: value.previewDigest, generation, changes};
  assertTransition(journal, path);
  return journal;
}
/** Compact journals may omit unchanged files, but never an unfulfilled transition. */
const assertJournalCoverage = Effect.fn('devSkills.assertJournalCoverage')(function* (journal: Journal) {
  const path = yield* Path.Path;
  const {consumer, changes, generation} = journal;
  const id = consumerId(consumer);
  const expected = {...consumer, state: generation ? 'enrolled' : 'removed'};
  for (const kind of ['home', 'runtime'] as const) {
    const file =
      kind === 'home' ? homeIndexPath(path, consumer.home) : runtimeIndexPath(path, consumer.installationRoot);
    if (changes.some(change => change.path === file)) continue;
    const content = yield* readOptional(file);
    const present =
      content === null
        ? undefined
        : yield* decode(content, value =>
            kind === 'home' ? parseHomeIndex(value).targets[id] : parseRuntimeIndex(value).enrollments[id],
          );
    if (stableJson(present) !== stableJson(expected))
      return yield* fail('invalid-state', `Transaction omits its required enrollment transition: ${file}`);
  }
  const transition = changes.find(change => change.path === receiptPath(path, consumer.target.skillRoot))!;
  const before = transition.before === null ? undefined : yield* decode(transition.before, parseReceipt);
  const after = yield* decode(transition.after!, parseReceipt);
  if (before) yield* verifyHistoricalProjection(consumer.target, before);
  for (const relative of new Set([...Object.keys(before?.entrypoints ?? {}), ...Object.keys(after.entrypoints)])) {
    const file = path.join(consumer.target.skillRoot, relative);
    if (changes.some(change => change.path === file)) continue;
    const actual = yield* readOptional(file);
    const desired = after.entrypoints[relative] ?? null;
    // Final removal deliberately preserves edited files; unchanged owned bytes must be removed.
    if (actual !== desired && !(desired === null && actual !== before?.entrypoints[relative]))
      return yield* fail('invalid-state', `Transaction omits its required discovery transition: ${file}`);
  }
});
const stageGeneration = Effect.fn('devSkills.stageGeneration')(function* (journal: Journal) {
  if (!journal.generation) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const {manifest, files} = journal.generation;
  const root = generationRoot(path, journal.consumer.target.skillRoot, manifest.digest);
  if (yield* statOptional(root)) {
    yield* verifyGeneration(root, manifest);
    return;
  }
  const staging = `${root}.staging-${journal.previewDigest}`;
  yield* verifyGeneration(staging, manifest, true);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(staging, relative);
    if (yield* statOptional(file)) continue; // Existing staged bytes were verified above.
    yield* assertSafePath(file);
    yield* fs.makeDirectory(path.dirname(file), {recursive: true});
    yield* fs.writeFile(file, Buffer.from(content, 'base64'), {flag: 'wx', mode: 0o600});
  }
  yield* verifyGeneration(staging, manifest);
  yield* assertSafePath(root);
  if (yield* statOptional(root)) return yield* fail('generation-conflict', 'Generation appeared while staging.');
  yield* fs.rename(staging, root);
  yield* verifyGeneration(root, manifest);
});
const executeJournal = Effect.fn('devSkills.executeJournal')(function* (journal: Journal, content: string) {
  const path = yield* Path.Path;
  // Validate the entire recovery image before progressing any one file.
  yield* assertJournalCoverage(journal);
  for (const change of journal.changes) {
    const actual = yield* readOptional(change.path);
    if (actual !== change.before && actual !== change.after)
      return yield* fail(
        'recovery-conflict',
        `Interrupted transaction found third-party content; preserved ${change.path}`,
      );
  }
  yield* stageGeneration(journal);
  for (const change of journal.changes) yield* compareWrite(change.path, change.before, change.after);
  for (const change of journal.changes)
    if ((yield* readOptional(change.path)) !== change.after)
      return yield* fail('readback-conflict', `Transaction readback differs: ${change.path}`);
  yield* assertJournalCoverage(journal);
  yield* compareWrite(journalPath(path, journal.consumer.target.skillRoot), content, null);
  // Keep empty native directories: FileSystem.remove may recursively erase a racing
  // unowned file. Only the exact owned entrypoint is removed.
});
export const recoverTransaction = Effect.fn('devSkills.recoverTransaction')(function* (consumer: DevSkillsConsumer) {
  const path = yield* Path.Path;
  const content = yield* readOptional(journalPath(path, consumer.target.skillRoot));
  if (content === null) return false;
  const journal = yield* decode(content, value => parseJournal(value, path));
  if (
    journal.consumer.home !== consumer.home ||
    journal.consumer.installationRoot !== consumer.installationRoot ||
    journal.consumer.target.skillRoot !== consumer.target.skillRoot
  )
    return yield* fail(
      'recovery-needed',
      'Resume the interrupted development skills command from its original Threadnote home and runtime enrollment.',
    );
  yield* executeJournal(journal, content);
  return true;
});
export const commitMutation = Effect.fn('devSkills.commitMutation')(function* (mutation: PlannedMutation) {
  if (!mutation.changes.length) return false;
  const path = yield* Path.Path;
  const journal: Journal = {
    schemaVersion: 1,
    consumer: mutation.consumer,
    previewDigest: mutation.plan.previewDigest,
    generation: mutation.generation,
    changes: mutation.changes,
  };
  const content = json(journal);
  if (Buffer.byteLength(content) > 8_000_000)
    return yield* fail('state-capacity', 'Development skills transaction exceeds its bounded capacity.');
  yield* decode(content, value => parseJournal(value, path));
  if (consumerId(journal.consumer) !== mutation.plan.consumerId)
    return yield* fail('invalid-state', 'Transaction consumer differs from its plan.');
  yield* assertJournalCoverage(journal);
  yield* compareWrite(journalPath(path, journal.consumer.target.skillRoot), null, content);
  yield* executeJournal(journal, content);
  return true;
});
