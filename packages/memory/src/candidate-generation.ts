import {Clock, Effect, FileSystem, Path, Schema} from 'effect';
import {withCandidateReviewLock, writePrivateFileAtomically} from './candidate.js';
import {
  MAX_TOPIC_GENERATION_RECEIPT_BYTES,
  MAX_TOPIC_GENERATION_RECEIPTS,
  TOPIC_GENERATION_RETENTION_MILLISECONDS,
  TopicGenerationReceiptId,
  projectTopicGenerationSummary,
  validateTopicGenerationReceipt,
  type TopicGenerationReceiptV1,
} from './topic-maintenance-generation.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export class TopicGenerationStorageError extends Schema.TaggedError<
  TopicGenerationStorageError,
  {readonly brand: unique symbol}
>()('TopicGenerationStorageError', {
  message: Schema.String,
}) {}
const unavailable = () =>
  TopicGenerationStorageError.make({message: 'The private generation receipt is unavailable or expired.'});
const directory = (path: Path.Path, home: string) =>
  path.join(home, 'threadnote', 'candidates', 'v1', 'topic-generation');

export const TOPIC_GENERATION_LOCK_ID = 'topic-maintenance-generation';

export const saveTopicGenerationReceiptUnderLock = Effect.fn('candidate.saveTopicGenerationReceiptUnderLock')(
  function* (home: string, input: TopicGenerationReceiptV1) {
    return yield* Effect.gen(function* () {
      const receipt = yield* Effect.try({try: () => validateTopicGenerationReceipt(input), catch: unavailable});
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = directory(path, home);
      yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
      yield* fs.chmod(root, 0o700);
      yield* writePrivateFileAtomically(
        fs,
        path.join(root, receipt.receiptId + '.json'),
        JSON.stringify(receipt) + '\n',
      );
      const now = yield* Clock.currentTimeMillis;
      const entries = [];
      for (const name of yield* fs.readDirectory(root)) {
        if (/^topic-generation-[a-f0-9]{32}\.json\.[a-f0-9-]{36}\.tmp$/u.test(name)) {
          yield* fs.remove(path.join(root, name), {force: true});
          continue;
        }
        if (!/^topic-generation-[a-f0-9]{32}\.json$/u.test(name)) continue;
        const file = path.join(root, name);
        const info = yield* fs.stat(file);
        const modifiedAt = info.mtime._tag === 'Some' ? info.mtime.value.getTime() : 0;
        entries.push({file, name, modifiedAt});
      }
      entries.sort((a, b) => a.modifiedAt - b.modifiedAt || Effect2.pipe(a.name, EffectString.localeCompare(b.name)));
      let remaining = entries.length;
      for (const entry of entries) {
        if (entry.name === receipt.receiptId + '.json') continue;
        if (
          remaining <= MAX_TOPIC_GENERATION_RECEIPTS &&
          now - entry.modifiedAt <= TOPIC_GENERATION_RETENTION_MILLISECONDS
        )
          continue;
        yield* fs.remove(entry.file, {force: true});
        remaining--;
      }
      return receipt.receiptId;
    }).pipe(
      Effect.mapError(() =>
        TopicGenerationStorageError.make({message: 'The private generation receipt could not be saved.'}),
      ),
    );
  },
);

export const saveTopicGenerationReceipt = Effect.fn('candidate.saveTopicGenerationReceipt')(function* (
  home: string,
  input: TopicGenerationReceiptV1,
) {
  return yield* withCandidateReviewLock(
    home,
    TOPIC_GENERATION_LOCK_ID,
    saveTopicGenerationReceiptUnderLock(home, input),
  ).pipe(
    Effect.mapError(() =>
      TopicGenerationStorageError.make({message: 'The private generation receipt could not be saved.'}),
    ),
  );
});

export const loadTopicGenerationReceipt = Effect.fn('candidate.loadTopicGenerationReceipt')(function* (
  home: string,
  receiptId: string,
) {
  yield* Schema.decodeEffect(TopicGenerationReceiptId)(receiptId).pipe(Effect.mapError(unavailable));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory(path, home), receiptId + '.json');
  const info = yield* fs.stat(file).pipe(Effect.mapError(unavailable));
  const now = yield* Clock.currentTimeMillis;
  if (
    info.type !== 'File' ||
    info.size > MAX_TOPIC_GENERATION_RECEIPT_BYTES + 1 ||
    (info.mtime._tag === 'Some' && now - info.mtime.value.getTime() > TOPIC_GENERATION_RETENTION_MILLISECONDS)
  )
    return yield* unavailable();
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(unavailable));
  if (new TextEncoder().encode(text).byteLength > MAX_TOPIC_GENERATION_RECEIPT_BYTES + 1) return yield* unavailable();
  const result = yield* Effect.try({try: () => validateTopicGenerationReceipt(JSON.parse(text)), catch: unavailable});
  if (result.receiptId !== receiptId) return yield* unavailable();
  return result;
});

export const readTopicGenerationSummary = Effect.fn('candidate.readTopicGenerationSummary')(function* (
  home: string,
  receiptId: string,
) {
  return projectTopicGenerationSummary(yield* loadTopicGenerationReceipt(home, receiptId));
});
