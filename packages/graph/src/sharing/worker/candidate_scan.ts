import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import {syncWritableFile} from '@threadnote/platform/file/durability';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {graphSharingFailure} from '../errors.js';
import {
  listGraphShareSignedCandidatePageIds,
  readGraphShareSignedCandidatePage,
  signedCandidateQueuePath,
  type GraphShareSignedCandidateV2,
} from '../signed/candidate.js';
import * as EffectRecord from 'effect/Record';

const PAGE_ID = /^[0-9a-f]{64}$/u;
const MAXIMUM_ATTEMPTS = 8;
const MAXIMUM_CURSOR_BYTES = 256;

interface Cursor {
  readonly index: number;
  readonly pageId: string;
  readonly schemaVersion: 1;
}

export interface SignedCandidateScanPosition {
  readonly candidate: GraphShareSignedCandidateV2;
  readonly index: number;
  readonly pageId: string;
}

const cursorPath = Effect.fn('codeGraph.sharing.signedScanCursorPath')(function* (home: string, repositoryId: string) {
  const path = yield* Path.Path;
  return `${signedCandidateQueuePath(path, home, repositoryId)}.scan.json`;
});

/** A failed head never suppresses the tail; this cursor does not acknowledge or discard evidence. */
export const nextGraphWorkerCandidateScan = Effect.fn('codeGraph.sharing.nextWorkerCandidateScan')(function* (
  home: string,
  repositoryId: string,
) {
  const ids = yield* listGraphShareSignedCandidatePageIds(home, repositoryId);
  if (ids.length === 0) return [] as SignedCandidateScanPosition[];
  const cursor = yield* readCursor(home, repositoryId);
  const anchor = cursor === undefined ? -1 : ids.indexOf(cursor.pageId);
  const ordered = anchor < 0 ? ids : [...ids.slice(anchor), ...ids.slice(0, anchor)];
  const selected: SignedCandidateScanPosition[] = [];
  for (const [ordinal, pageId] of ordered.entries()) {
    const page = yield* readGraphShareSignedCandidatePage(home, repositoryId, pageId);
    if (page === undefined) continue;
    const start = ordinal === 0 && anchor >= 0 ? cursor!.index + 1 : 0;
    for (let index = start; index < page.candidates.length && selected.length < MAXIMUM_ATTEMPTS; index++)
      selected.push({candidate: page.candidates[index], index, pageId});
    if (selected.length === MAXIMUM_ATTEMPTS) return selected;
  }
  if (anchor >= 0) {
    const page = yield* readGraphShareSignedCandidatePage(home, repositoryId, cursor!.pageId);
    if (page !== undefined) {
      for (
        let index = 0;
        index <= cursor!.index && index < page.candidates.length && selected.length < MAXIMUM_ATTEMPTS;
        index++
      )
        selected.push({candidate: page.candidates[index], index, pageId: cursor!.pageId});
    }
  }
  return selected;
});

export const advanceGraphWorkerCandidateScan = Effect.fn('codeGraph.sharing.advanceWorkerCandidateScan')(function* (
  home: string,
  repositoryId: string,
  position: Pick<SignedCandidateScanPosition, 'index' | 'pageId'>,
) {
  if (
    !PAGE_ID.test(position.pageId) ||
    !Number.isSafeInteger(position.index) ||
    position.index < 0 ||
    position.index >= 512
  )
    return yield* graphSharingFailure('Signed candidate scan position is invalid.');
  yield* writePrivateJsonFile(yield* cursorPath(home, repositoryId), {
    index: position.index,
    pageId: position.pageId,
    schemaVersion: 1,
  } satisfies Cursor);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* cursorPath(home, repositoryId);
  yield* syncWritableFile(fs, target);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* fs.open(path.dirname(target), {flag: 'r'});
      yield* parent.sync;
    }),
  );
});

const readCursor = Effect.fn('codeGraph.sharing.readWorkerCandidateScan')(function* (
  home: string,
  repositoryId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* cursorPath(home, repositoryId);
  if (!(yield* fs.exists(target))) return undefined;
  const bytes = yield* readBoundedPrivateBytes(target, MAXIMUM_CURSOR_BYTES);
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown,
    catch: () => graphSharingFailure('Signed candidate scan cursor is invalid.'),
  });
  if (
    typeof value !== 'object' ||
    value === null ||
    EffectArray.isArray(value) ||
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'index,pageId,schemaVersion' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('pageId' in value) ||
    typeof value.pageId !== 'string' ||
    !PAGE_ID.test(value.pageId) ||
    !('index' in value) ||
    typeof value.index !== 'number' ||
    !Number.isSafeInteger(value.index) ||
    value.index < 0 ||
    value.index >= 512
  )
    return yield* graphSharingFailure('Signed candidate scan cursor is invalid.');
  return {index: value.index, pageId: value.pageId, schemaVersion: value.schemaVersion};
});
