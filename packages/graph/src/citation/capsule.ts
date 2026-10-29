import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, Predicate} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';
import {
  runtimePlatform,
  runtimeReadBoundedStableRegularFile,
  runtimeTextDirectoryNamePage,
} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphFileContentHashMatchesBytes} from '../content_identity.js';
import {codeGraphRepositoryRoot} from '../layout.js';
import {withCodeGraphLocalProvenanceLock} from '../local_provenance.js';
import type {RepositoryIdentity} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_CITATION_CAPSULE_MAXIMUM_FILE_BYTES = 256 * 1_024;
export const CODE_GRAPH_CITATION_CAPSULE_RETENTION = {
  maximumAgeMilliseconds: 90 * 86_400_000,
  maximumBytes: 32 * 1_048_576,
  maximumCount: 256,
} as const;
const MAXIMUM_CAPSULE_BYTES = CODE_GRAPH_CITATION_CAPSULE_MAXIMUM_FILE_BYTES * 2;
const CAPSULE_LOCK_ID = sha256HexSync('threadnote-citation-evidence-capsules-v1');

export interface CodeGraphCitationEvidenceSourceV1 {
  readonly extractorSet: string;
  readonly fileContentHash: string;
  readonly path: string;
  readonly repositoryId: string;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceSnapshotId: string;
}

export interface CodeGraphCitationEvidenceCapsuleV1 {
  readonly id: string;
  readonly objectFormat: RepositoryIdentity['objectFormat'];
  readonly payload: string;
  readonly referenceIds: readonly string[];
  readonly retainedAt: string;
  readonly source: CodeGraphCitationEvidenceSourceV1;
  readonly version: 1;
}

const isReferenceIdArray = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(
    value,
    (reference): reference is string => typeof reference === 'string' && /^[0-9a-f]{64}$/.test(reference),
  );

function validSource(source: unknown): source is CodeGraphCitationEvidenceSourceV1 {
  if (!Predicate.isObject(source)) return false;
  return (
    typeof source.repositoryId === 'string' &&
    /^[0-9a-f]{64}$/.test(source.repositoryId) &&
    typeof source.fileContentHash === 'string' &&
    /^[0-9a-f]{64}$/.test(source.fileContentHash) &&
    typeof source.sourceCommit === 'string' &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.sourceCommit) &&
    typeof source.sourceSnapshotId === 'string' &&
    /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/.test(source.sourceSnapshotId) &&
    typeof source.sourceDirty === 'boolean' &&
    typeof source.extractorSet === 'string' &&
    source.extractorSet.length > 0 &&
    source.extractorSet.length <= 256 &&
    typeof source.path === 'string' &&
    source.path.length <= 4_096 &&
    !Effect2.pipe(source.path, EffectString.startsWith('/')) &&
    !/[\0\r\n\\]/.test(source.path) &&
    EffectArray.every(
      Effect2.pipe(source.path, EffectString.split('/')),
      segment => segment.length > 0 && segment !== '.' && segment !== '..',
    )
  );
}

export function codeGraphCitationEvidenceCapsuleId(source: CodeGraphCitationEvidenceSourceV1): string {
  return sha256HexSync(
    JSON.stringify([
      source.repositoryId,
      source.sourceSnapshotId,
      source.sourceCommit,
      source.sourceDirty,
      source.extractorSet,
      source.path,
      source.fileContentHash,
    ]),
  );
}

export function createCodeGraphCitationEvidenceCapsule(
  source: CodeGraphCitationEvidenceSourceV1,
  objectFormat: RepositoryIdentity['objectFormat'],
  bytes: Uint8Array,
  retainedAt: string,
  referenceIds: readonly string[],
): CodeGraphCitationEvidenceCapsuleV1 | undefined {
  if (
    !validSource(source) ||
    bytes.byteLength > CODE_GRAPH_CITATION_CAPSULE_MAXIMUM_FILE_BYTES ||
    !codeGraphFileContentHashMatchesBytes(source.fileContentHash, objectFormat, bytes) ||
    !Number.isFinite(Date.parse(retainedAt)) ||
    new Date(Date.parse(retainedAt)).toISOString() !== retainedAt
  )
    return undefined;
  return {
    id: codeGraphCitationEvidenceCapsuleId(source),
    objectFormat,
    payload: Buffer.from(bytes).toString('base64'),
    referenceIds: [
      ...new Set(
        EffectArray.filter(
          referenceIds,
          (value, __effectArrayIndex) => __effectArrayIndex in referenceIds && /^[0-9a-f]{64}$/.test(value),
        ),
      ),
    ]
      .sort()
      .slice(0, 32),
    retainedAt,
    source,
    version: 1,
  };
}

export function parseCodeGraphCitationEvidenceCapsule(
  text: string,
  expected: CodeGraphCitationEvidenceSourceV1,
): {readonly bytes: Uint8Array; readonly capsule: CodeGraphCitationEvidenceCapsuleV1} | undefined {
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_CAPSULE_BYTES || !validSource(expected)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      !Predicate.isObject(value) ||
      value.version !== 1 ||
      (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256') ||
      typeof value.payload !== 'string' ||
      typeof value.retainedAt !== 'string' ||
      !isReferenceIdArray(value.referenceIds) ||
      !validSource(value.source)
    )
      return undefined;
    const source = value.source;
    if (codeGraphCitationEvidenceCapsuleId(source) !== codeGraphCitationEvidenceCapsuleId(expected)) return undefined;
    const bytes = Buffer.from(value.payload, 'base64');
    if (bytes.toString('base64') !== value.payload) return undefined;
    const capsule = createCodeGraphCitationEvidenceCapsule(
      source,
      value.objectFormat,
      bytes,
      value.retainedAt,
      value.referenceIds,
    );
    return capsule === undefined || capsule.id !== value.id ? undefined : {bytes: new Uint8Array(bytes), capsule};
  } catch {
    return undefined;
  }
}

export interface CodeGraphCitationCapsuleRetentionEntry {
  readonly bytes: number;
  readonly id: string;
  readonly retainedAt: string;
}

export function selectCodeGraphCitationCapsuleRetention(
  entries: readonly CodeGraphCitationCapsuleRetentionEntry[],
  now: number,
  limits: {
    readonly maximumAgeMilliseconds: number;
    readonly maximumBytes: number;
    readonly maximumCount: number;
  } = CODE_GRAPH_CITATION_CAPSULE_RETENTION,
): {
  readonly retain: readonly CodeGraphCitationCapsuleRetentionEntry[];
  readonly retire: readonly CodeGraphCitationCapsuleRetentionEntry[];
} {
  const ordered = [...entries].sort(
    (left, right) =>
      Effect2.pipe(right.retainedAt, EffectString.localeCompare(left.retainedAt)) ||
      Effect2.pipe(left.id, EffectString.localeCompare(right.id)),
  );
  const retain: CodeGraphCitationCapsuleRetentionEntry[] = [];
  const retire: CodeGraphCitationCapsuleRetentionEntry[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    const age = now - Date.parse(entry.retainedAt);
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > limits.maximumAgeMilliseconds ||
      retain.length >= limits.maximumCount ||
      entry.bytes < 0 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes > limits.maximumBytes - bytes
    ) {
      retire.push(entry);
    } else {
      retain.push(entry);
      bytes += entry.bytes;
    }
  }
  return {retain, retire};
}

const capsuleDirectory = Effect.fn('codeGraph.citationCapsuleDirectory')(function* (
  threadnoteHome: string,
  checkoutId: string,
  create: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let parent = yield* fs.realPath(threadnoteHome);
  const root = codeGraphRepositoryRoot(path, parent, checkoutId);
  const names = [
    ...Effect2.pipe(path.relative(parent, root), EffectString.split(path.sep)),
    'local-context',
    'citation-evidence',
  ];
  for (const name of names) {
    const child = path.join(parent, name);
    if (Option.isSome(yield* fs.readLink(child).pipe(Effect.option))) return undefined;
    if (!(yield* fs.exists(child))) {
      if (!create) return undefined;
      yield* fs.makeDirectory(child, {mode: 0o700});
    }
    const canonical = yield* fs.realPath(child);
    if (
      path.dirname(canonical) !== parent ||
      path.basename(canonical) !== name ||
      (yield* fs.stat(canonical)).type !== 'Directory'
    )
      return undefined;
    parent = canonical;
  }
  return parent;
});

const readCapsule = Effect.fn('codeGraph.readCitationEvidenceCapsule')(function* (
  directory: string,
  source: CodeGraphCitationEvidenceSourceV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, `${codeGraphCitationEvidenceCapsuleId(source)}.json`);
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (
    info._tag === 'None' ||
    info.value.type !== 'File' ||
    info.value.size > BigInt(MAXIMUM_CAPSULE_BYTES) ||
    (runtimePlatform !== 'win32' && (info.value.mode & 0o777) !== 0o600)
  )
    return undefined;
  const bytes = yield* fromPromise('read stable citation capsule', () =>
    runtimeReadBoundedStableRegularFile(file, MAXIMUM_CAPSULE_BYTES),
  );
  return parseCodeGraphCitationEvidenceCapsule(new TextDecoder('utf-8', {fatal: true}).decode(bytes), source);
});

export const readRetainedCodeGraphCitationEvidence = Effect.fn('codeGraph.readRetainedCitationEvidence')(function* (
  threadnoteHome: string,
  checkoutId: string,
  source: CodeGraphCitationEvidenceSourceV1,
) {
  const directory = yield* capsuleDirectory(threadnoteHome, checkoutId, false).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (directory === undefined) return undefined;
  const retained = yield* readCapsule(directory, source).pipe(Effect.orElseSucceed(() => undefined));
  const now = yield* Clock.currentTimeMillis;
  const age = retained === undefined ? Infinity : now - Date.parse(retained.capsule.retainedAt);
  return age < 0 || age > CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumAgeMilliseconds ? undefined : retained;
});

/** Proactively retain exact source while the validating snapshot lease is held. Caps are independent of graph retention. */
export const retainCodeGraphCitationEvidence = Effect.fn('codeGraph.retainCitationEvidence')(function* (input: {
  readonly bytes: Uint8Array;
  readonly checkoutId: string;
  readonly objectFormat: RepositoryIdentity['objectFormat'];
  readonly referenceId: string;
  readonly source: CodeGraphCitationEvidenceSourceV1;
  readonly threadnoteHome: string;
  /** @internal An approved write-ahead intent fixes retention across crash/retry. */
  readonly retainedAt?: string;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.checkoutId)) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const reservedAt = input.retainedAt === undefined ? undefined : Date.parse(input.retainedAt);
  if (
    reservedAt !== undefined &&
    (!Number.isFinite(reservedAt) ||
      DateTime.formatIso(DateTime.makeUnsafe(reservedAt)) !== input.retainedAt ||
      reservedAt > now ||
      now - reservedAt > CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumAgeMilliseconds)
  )
    return false;
  const capsule = createCodeGraphCitationEvidenceCapsule(
    input.source,
    input.objectFormat,
    input.bytes,
    input.retainedAt ?? DateTime.formatIso(DateTime.makeUnsafe(now)),
    [input.referenceId],
  );
  if (capsule === undefined) return false;
  return yield* withCodeGraphLocalProvenanceLock(
    input.threadnoteHome,
    input.checkoutId,
    CAPSULE_LOCK_ID,
    250,
    Effect.gen(function* () {
      const directory = yield* capsuleDirectory(input.threadnoteHome, input.checkoutId, true);
      if (directory === undefined) return false;
      const previous = yield* readCapsule(directory, input.source).pipe(Effect.orElseSucceed(() => undefined));
      if (
        reservedAt !== undefined &&
        previous === undefined &&
        (yield* fs.exists(path.join(directory, `${capsule.id}.json`)))
      )
        return false;
      const previousTime = previous === undefined ? undefined : Date.parse(previous.capsule.retainedAt);
      if (
        reservedAt !== undefined &&
        previousTime !== undefined &&
        (previousTime > now || now - previousTime > CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumAgeMilliseconds)
      )
        return false;
      const retainedCapsule =
        reservedAt !== undefined && previousTime !== undefined
          ? {...capsule, retainedAt: DateTime.formatIso(DateTime.makeUnsafe(Math.min(reservedAt, previousTime)))}
          : capsule;
      const references = [...new Set([...(previous?.capsule.referenceIds ?? []), input.referenceId])]
        .sort()
        .slice(0, 32);
      if (reservedAt !== undefined && !references.includes(input.referenceId)) return false;
      if (
        previous !== undefined &&
        (reservedAt === undefined
          ? now - Date.parse(previous.capsule.retainedAt) < 86_400_000
          : previous.capsule.retainedAt === retainedCapsule.retainedAt) &&
        EffectArray.every(references, value => previous.capsule.referenceIds.includes(value))
      )
        return true;
      const page = yield* runtimeTextDirectoryNamePage(
        directory,
        CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumCount + 1,
      );
      if (page.overflow) return false;
      const names = EffectArrayPipe(page.names, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (name, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && /^[0-9a-f]{64}\.json$/.test(name),
        ),
      );
      const entries = yield* Effect.forEach(
        names,
        name =>
          Effect.gen(function* () {
            const info = yield* fs.stat(path.join(directory, name)).pipe(Effect.option);
            return info._tag === 'None'
              ? []
              : [
                  {
                    id: Effect2.pipe(name, EffectString.slice(0, -5)),
                    regular: info.value.type === 'File',
                    bytes: Number(info.value.size),
                    retainedAt: Option.getOrUndefined(info.value.mtime)?.toISOString() ?? '',
                  },
                ];
          }),
        {concurrency: 4},
      );
      const serialized = `${JSON.stringify({...retainedCapsule, referenceIds: references})}\n`;
      const physical = [
        ...EffectArray.filter(entries.flat(), value => value.id !== capsule.id),
        {
          id: capsule.id,
          regular: true,
          bytes: new TextEncoder().encode(serialized).byteLength,
          retainedAt: retainedCapsule.retainedAt,
        },
      ];
      // Reserved writes never retire history, including logically expired files.
      // Their complete physical footprint must fit without eviction or renewal.
      if (
        reservedAt !== undefined &&
        (entries.flat().length !== names.length ||
          EffectArray.some(
            physical,
            entry => !entry.regular || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0,
          ) ||
          physical.length > CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumCount ||
          EffectArray.reduce(physical, 0, (sum, entry) => sum + entry.bytes) >
            CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumBytes)
      )
        return false;
      const selection =
        reservedAt === undefined
          ? selectCodeGraphCitationCapsuleRetention(physical, now)
          : {retain: physical, retire: []};
      if (!EffectArray.some(selection.retain, value => value.id === capsule.id)) return false;
      const crypto = yield* Crypto.Crypto;
      const temporary = path.join(directory, `pending-${yield* crypto.randomUUIDv4()}`);
      yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
      yield* fs.chmod(temporary, 0o600);
      yield* fs
        .rename(temporary, path.join(directory, `${capsule.id}.json`))
        .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
      for (const retired of selection.retire)
        yield* fs.remove(path.join(directory, `${retired.id}.json`)).pipe(Effect.ignore);
      return true;
    }),
  ).pipe(Effect.orElseSucceed(() => false));
});
