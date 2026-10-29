import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {graphSharingFailure, GraphSharingError} from '../errors.js';
import * as EffectRecord from 'effect/Record';

export const SIGNED_CANDIDATE_PAGE_MAXIMUM_ITEMS = 512;
export const SIGNED_CANDIDATE_PAGE_MAXIMUM_BYTES = 512 * 1_024;
export const SIGNED_CANDIDATE_JOURNAL_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_SEGMENTS = 2_048;
const MAXIMUM_MANIFEST_BYTES = 512 * 1_024;
const SEGMENT_NAME = /^[0-9a-f]{64}\.json$/u;
const SEGMENT_TEMP_NAME = /^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export interface SignedCandidatePage<T, V extends number> {
  readonly candidates: readonly T[];
  readonly schemaVersion: V;
}

export interface SignedCandidateJournalSpec<T, V extends number, M extends number> {
  readonly identity: (candidate: T) => string;
  readonly manifestVersion: M;
  readonly pageVersion: V;
  readonly parseLegacy: (value: unknown) => SignedCandidatePage<T, V>;
  readonly parsePage: (value: unknown) => SignedCandidatePage<T, V>;
  readonly validCandidate: (candidate: unknown) => candidate is T;
}

interface SegmentDescriptor {
  readonly count: number;
  readonly id: string;
  readonly size: number;
}

interface JournalManifest<M extends number> {
  readonly schemaVersion: M;
  readonly segments: readonly SegmentDescriptor[];
}

export interface SignedCandidateJournalPage<T> {
  readonly candidates: readonly T[];
  readonly id: string;
}

export const appendSignedCandidateJournal = Effect.fn('codeGraph.sharing.appendSignedCandidateJournal')(function* <
  T,
  V extends number,
  M extends number,
>(input: {
  readonly additions: readonly T[];
  readonly manifestPath: string;
  readonly spec: SignedCandidateJournalSpec<T, V, M>;
}) {
  if (input.additions.length === 0) return {queued: 0};
  if (EffectArray.some(input.additions, candidate => !input.spec.validCandidate(candidate)))
    return yield* graphSharingFailure('Signed candidate journal entry is invalid.');
  return yield* withJournalLock(
    input.manifestPath,
    Effect.gen(function* () {
      const current = yield* loadManifestLocked(input.manifestPath, input.spec);
      yield* removeOrphansLocked(input.manifestPath, current);
      const unseen = new Map<string, T>();
      for (const candidate of input.additions) {
        const identity = input.spec.identity(candidate);
        if (!unseen.has(identity)) unseen.set(identity, candidate);
      }
      for (const descriptor of current.segments) {
        if (unseen.size === 0) break;
        const page = yield* readSegmentLocked(input.manifestPath, descriptor, input.spec);
        for (const candidate of page.candidates) unseen.delete(input.spec.identity(candidate));
      }
      const additions = [...unseen.values()];
      const pages = yield* attemptMetadata(() => splitPages(additions, input.spec.pageVersion));
      const known = new Set(EffectArray.map(current.segments, segment => segment.id));
      const newPages = EffectArray.filter(pages, page => !known.has(page.descriptor.id));
      const next = {
        schemaVersion: input.spec.manifestVersion,
        segments: [...current.segments, ...EffectArray.map(newPages, page => page.descriptor)],
      } satisfies JournalManifest<M>;
      yield* attemptMetadata(() => checkQuota(next));
      for (const page of newPages) yield* writeSegmentLocked(input.manifestPath, page);
      if (newPages.length > 0) yield* writeDurableJson(input.manifestPath, next);
      yield* removeOrphansLocked(input.manifestPath, next);
      return {queued: EffectArray.reduce(newPages, 0, (sum, page) => sum + page.descriptor.count)};
    }),
  );
});

export const listSignedCandidateJournalSegments = Effect.fn('codeGraph.sharing.listSignedCandidateJournalSegments')(
  function* <T, V extends number, M extends number>(input: {
    readonly manifestPath: string;
    readonly spec: SignedCandidateJournalSpec<T, V, M>;
  }) {
    return yield* withJournalLock(
      input.manifestPath,
      Effect.gen(function* () {
        const manifest = yield* loadManifestLocked(input.manifestPath, input.spec);
        yield* removeOrphansLocked(input.manifestPath, manifest);
        return EffectArray.map(manifest.segments, segment => segment.id);
      }),
    );
  },
);

export const readSignedCandidateJournalPage = Effect.fn('codeGraph.sharing.readSignedCandidateJournalPage')(function* <
  T,
  V extends number,
  M extends number,
>(input: {readonly id: string; readonly manifestPath: string; readonly spec: SignedCandidateJournalSpec<T, V, M>}) {
  if (!DIGEST.test(input.id)) return yield* graphSharingFailure('Signed candidate segment ID is invalid.');
  return yield* withJournalLock(
    input.manifestPath,
    Effect.gen(function* () {
      const manifest = yield* loadManifestLocked(input.manifestPath, input.spec);
      const descriptor = Option.getOrUndefined(
        EffectArray.findFirst(manifest.segments, segment => segment.id === input.id),
      );
      if (descriptor === undefined) return undefined;
      const page = yield* readSegmentLocked(input.manifestPath, descriptor, input.spec);
      return {candidates: page.candidates, id: descriptor.id} satisfies SignedCandidateJournalPage<T>;
    }),
  );
});

export const acknowledgeSignedCandidateJournalPage = Effect.fn('codeGraph.sharing.ackSignedCandidateJournalPage')(
  function* <T, V extends number, M extends number>(input: {
    readonly acceptedIdentities: ReadonlySet<string>;
    readonly id: string;
    readonly manifestPath: string;
    readonly spec: SignedCandidateJournalSpec<T, V, M>;
  }) {
    if (!DIGEST.test(input.id)) return yield* graphSharingFailure('Signed candidate segment ID is invalid.');
    if (input.acceptedIdentities.size === 0) return {acknowledged: 0, absent: false};
    return yield* withJournalLock(
      input.manifestPath,
      Effect.gen(function* () {
        const manifest = yield* loadManifestLocked(input.manifestPath, input.spec);
        const index = Option.getOrElse(
          EffectArray.findFirstIndex(manifest.segments, segment => segment.id === input.id),
          () => -1,
        );
        if (index < 0)
          return {
            acknowledged: 0,
            absent: !(yield* hasIdentityLocked(input.manifestPath, manifest, input.spec, input.acceptedIdentities)),
          };
        const oldPage = yield* readSegmentLocked(input.manifestPath, manifest.segments[index], input.spec);
        const retained = EffectArray.filter(
          oldPage.candidates,
          candidate => !input.acceptedIdentities.has(input.spec.identity(candidate)),
        );
        if (retained.length === oldPage.candidates.length) return {acknowledged: 0, absent: false};
        const replacement = retained.length === 0 ? undefined : makePage(retained, input.spec.pageVersion);
        const segments = [...manifest.segments];
        const replacementExists =
          replacement !== undefined &&
          EffectArray.some(
            segments,
            (segment, position) => position !== index && segment.id === replacement.descriptor.id,
          );
        segments.splice(index, 1, ...(replacement === undefined || replacementExists ? [] : [replacement.descriptor]));
        const next = {schemaVersion: input.spec.manifestVersion, segments} satisfies JournalManifest<M>;
        yield* attemptMetadata(() => checkQuota(next));
        if (replacement !== undefined) yield* writeSegmentLocked(input.manifestPath, replacement);
        yield* writeDurableJson(input.manifestPath, next);
        yield* removeOrphansLocked(input.manifestPath, next);
        return {acknowledged: oldPage.candidates.length - retained.length, absent: true};
      }),
    );
  },
);

function withJournalLock<A, E, R>(manifestPath: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(manifestPath), {recursive: true, mode: 0o700});
    return yield* withExclusiveFileLock(
      fs,
      `${manifestPath}.lock`,
      {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 30_000},
      assertSegmentDirectory(manifestPath).pipe(Effect.andThen(body)),
    );
  });
}

const assertSegmentDirectory = Effect.fn('codeGraph.sharing.assertCandidateSegmentDirectory')(function* (
  manifestPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(`${manifestPath}.d`).pipe(Effect.option)))
    return yield* graphSharingFailure('Signed candidate segment directory must not be a symbolic link.');
});

const hasIdentityLocked = Effect.fn('codeGraph.sharing.hasCandidateIdentity')(function* <
  T,
  V extends number,
  M extends number,
>(
  manifestPath: string,
  manifest: JournalManifest<M>,
  spec: SignedCandidateJournalSpec<T, V, M>,
  identities: ReadonlySet<string>,
) {
  for (const descriptor of manifest.segments) {
    const page = yield* readSegmentLocked(manifestPath, descriptor, spec);
    if (EffectArray.some(page.candidates, candidate => identities.has(spec.identity(candidate)))) return true;
  }
  return false;
});

const loadManifestLocked = Effect.fn('codeGraph.sharing.loadCandidateManifest')(function* <
  T,
  V extends number,
  M extends number,
>(manifestPath: string, spec: SignedCandidateJournalSpec<T, V, M>) {
  const fs = yield* FileSystem.FileSystem;
  const empty: JournalManifest<M> = {schemaVersion: spec.manifestVersion, segments: []};
  if (!(yield* fs.exists(manifestPath))) return empty;
  const bytes = yield* readBoundedPrivateBytes(manifestPath, MAXIMUM_MANIFEST_BYTES);
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: () => graphSharingFailure('Signed candidate manifest is not valid JSON.'),
  });
  if (isRecord(value) && value.schemaVersion === spec.manifestVersion && 'segments' in value)
    return yield* attemptMetadata(() => parseManifest(value, spec.manifestVersion));
  const legacy = yield* attemptMetadata(() => spec.parseLegacy(value));
  const pages = yield* attemptMetadata(() => splitPages(legacy.candidates, spec.pageVersion));
  const migrated = {schemaVersion: spec.manifestVersion, segments: EffectArray.map(pages, page => page.descriptor)};
  yield* attemptMetadata(() => checkQuota(migrated));
  for (const page of pages) yield* writeSegmentLocked(manifestPath, page);
  yield* writeDurableJson(manifestPath, migrated);
  return migrated;
});

function parseManifest<M extends number>(value: Record<string, unknown>, version: M): JournalManifest<M> {
  if (
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'schemaVersion,segments' ||
    value.schemaVersion !== version ||
    !EffectArray.isArray(value.segments) ||
    value.segments.length > MAXIMUM_SEGMENTS
  )
    throw graphSharingFailure('Signed candidate manifest is invalid.');
  const seen = new Set<string>();
  const segments: SegmentDescriptor[] = [];
  for (const item of value.segments) {
    if (
      !isRecord(item) ||
      EffectArray.join(EffectRecord.keys(item).sort(), ',') !== 'count,id,size' ||
      typeof item.id !== 'string' ||
      !DIGEST.test(item.id) ||
      seen.has(item.id) ||
      typeof item.count !== 'number' ||
      !Number.isSafeInteger(item.count) ||
      item.count < 1 ||
      item.count > SIGNED_CANDIDATE_PAGE_MAXIMUM_ITEMS ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 1 ||
      item.size > SIGNED_CANDIDATE_PAGE_MAXIMUM_BYTES
    )
      throw graphSharingFailure('Signed candidate manifest segment is invalid.');
    seen.add(item.id);
    segments.push({count: item.count, id: item.id, size: item.size});
  }
  const manifest = {schemaVersion: version, segments};
  checkQuota(manifest);
  return manifest;
}

function splitPages<T, V extends number>(candidates: readonly T[], version: V) {
  const pages: ReturnType<typeof makePage<T, V>>[] = [];
  let group: T[] = [];
  const emptyBytes = serializedPage([], version).byteLength;
  let groupBytes = emptyBytes;
  for (const candidate of candidates) {
    const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    const nextBytes = groupBytes + candidateBytes + (group.length === 0 ? 0 : 1);
    if (group.length + 1 > SIGNED_CANDIDATE_PAGE_MAXIMUM_ITEMS || nextBytes > SIGNED_CANDIDATE_PAGE_MAXIMUM_BYTES) {
      if (group.length === 0) throw graphSharingFailure('Signed candidate exceeds the page limit.');
      pages.push(makePage(group, version));
      group = [candidate];
      groupBytes = emptyBytes + candidateBytes;
      if (groupBytes > SIGNED_CANDIDATE_PAGE_MAXIMUM_BYTES)
        throw graphSharingFailure('Signed candidate exceeds the page limit.');
    } else {
      group.push(candidate);
      groupBytes = nextBytes;
    }
  }
  if (group.length > 0) pages.push(makePage(group, version));
  return pages;
}

function makePage<T, V extends number>(candidates: readonly T[], version: V) {
  const value = {candidates, schemaVersion: version};
  const bytes = serializedPage(candidates, version);
  return {bytes, descriptor: {count: candidates.length, id: sha256HexSync(bytes), size: bytes.byteLength}, value};
}

function serializedPage<T, V extends number>(candidates: readonly T[], version: V): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({candidates, schemaVersion: version})}\n`);
}

function checkQuota(manifest: JournalManifest<number>): void {
  if (
    manifest.segments.length > MAXIMUM_SEGMENTS ||
    EffectArray.reduce(manifest.segments, 0, (total, item) => total + item.size) >
      SIGNED_CANDIDATE_JOURNAL_MAXIMUM_BYTES ||
    new TextEncoder().encode(`${JSON.stringify(manifest)}\n`).byteLength > MAXIMUM_MANIFEST_BYTES
  )
    throw graphSharingFailure('Signed candidate journal quota is full.');
}

const readSegmentLocked = Effect.fn('codeGraph.sharing.readCandidateSegment')(function* <
  T,
  V extends number,
  M extends number,
>(manifestPath: string, descriptor: SegmentDescriptor, spec: SignedCandidateJournalSpec<T, V, M>) {
  yield* assertSegmentDirectory(manifestPath);
  const path = yield* Path.Path;
  const target = path.join(`${manifestPath}.d`, `${descriptor.id}.json`);
  const bytes = yield* readBoundedPrivateBytes(target, SIGNED_CANDIDATE_PAGE_MAXIMUM_BYTES);
  if (bytes.byteLength !== descriptor.size || sha256HexSync(bytes) !== descriptor.id)
    return yield* graphSharingFailure('Signed candidate segment bytes do not match the manifest.');
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: () => graphSharingFailure('Signed candidate segment is not valid JSON.'),
  });
  const page = yield* attemptMetadata(() => spec.parsePage(value));
  if (page.candidates.length !== descriptor.count)
    return yield* graphSharingFailure('Signed candidate segment count differs.');
  return page;
});

const writeSegmentLocked = Effect.fn('codeGraph.sharing.writeCandidateSegment')(function* <T, V extends number>(
  manifestPath: string,
  page: ReturnType<typeof makePage<T, V>>,
) {
  yield* assertSegmentDirectory(manifestPath);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(`${manifestPath}.d`, `${page.descriptor.id}.json`);
  if (yield* fs.exists(target)) {
    const bytes = yield* readBoundedPrivateBytes(target, SIGNED_CANDIDATE_PAGE_MAXIMUM_BYTES);
    if (sha256HexSync(bytes) === page.descriptor.id) {
      yield* syncPath(target);
      if ((yield* SystemInfo).platform !== 'win32') yield* syncPath(path.dirname(target));
      return;
    }
  }
  yield* writeDurableJson(target, page.value);
});

const writeDurableJson = Effect.fn('codeGraph.sharing.writeDurableCandidateJson')(function* (
  target: string,
  value: unknown,
) {
  const path = yield* Path.Path;
  yield* writePrivateJsonFile(target, value);
  yield* syncPath(target);
  if ((yield* SystemInfo).platform !== 'win32') yield* syncPath(path.dirname(target));
});

const removeOrphansLocked = Effect.fn('codeGraph.sharing.removeCandidateOrphans')(function* (
  manifestPath: string,
  manifest: JournalManifest<number>,
) {
  yield* assertSegmentDirectory(manifestPath);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = `${manifestPath}.d`;
  if (!(yield* fs.exists(directory))) return;
  const names = yield* fs.readDirectory(directory);
  if (names.length > MAXIMUM_SEGMENTS * 2)
    return yield* graphSharingFailure('Signed candidate journal has too many segment files.');
  const active = new Set(EffectArray.map(manifest.segments, segment => `${segment.id}.json`));
  for (const name of names) {
    if (!(SEGMENT_NAME.test(name) || SEGMENT_TEMP_NAME.test(name)) || active.has(name)) continue;
    yield* fs.remove(path.join(directory, name));
  }
});

const syncPath = Effect.fn('codeGraph.sharing.syncCandidatePath')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(fs.open(target, {flag: 'r'}).pipe(Effect.flatMap(file => file.sync))).pipe(
    Effect.mapError(cause => graphSharingFailure('Could not durably persist signed candidate evidence.', cause)),
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function attemptMetadata<A>(evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure('Signed candidate metadata is invalid.', cause),
  });
}
