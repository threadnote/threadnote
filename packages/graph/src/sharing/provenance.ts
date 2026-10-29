import {Array as EffectArray, Effect, FileSystem, Path, Predicate} from 'effect';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {parseSha256Digest, SHA256_HEX, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingAttemptPath, graphSharingLayout, graphSharingProvenancePath} from './layout.js';
import {lookupGraphShareTrustReceipt} from './trust.js';

export interface SharedGraphProvenanceV1 {
  readonly checkpointDigest: Sha256Digest;
  readonly deltaCount: number;
  readonly frontierCommit: string;
  readonly profileDigest: Sha256Digest;
  readonly repositoryId: string;
  readonly schemaVersion: 1;
  readonly snapshotId: string;
}

export const SHARED_GRAPH_IMPORT_ATTEMPT_REASONS = [
  'already-installed',
  'imported',
  'invalid-enrollment',
  'quarantined',
  'repository-mismatch',
  'trust-pin-mismatch',
  'unavailable',
  'unenrolled',
  'untrusted',
] as const;

export type SharedGraphImportAttemptReason = (typeof SHARED_GRAPH_IMPORT_ATTEMPT_REASONS)[number];

export interface SharedGraphImportAttemptV1 {
  readonly imported: boolean;
  readonly reason: SharedGraphImportAttemptReason;
  readonly atGeneration?: number;
  readonly checkpointDigest?: Sha256Digest;
}

export const writeSharedGraphProvenance = Effect.fn('codeGraph.sharing.writeProvenance')(function* (
  threadnoteHome: string,
  checkoutId: string,
  provenance: SharedGraphProvenanceV1,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  yield* writePrivateJsonFile(graphSharingProvenancePath(path, layout.provenanceRoot, checkoutId), provenance);
});

export const readSharedGraphProvenance = Effect.fn('codeGraph.sharing.readProvenance')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const target = graphSharingProvenancePath(path, layout.provenanceRoot, checkoutId);
  if (!(yield* fs.exists(target))) return undefined;
  return parseProvenance(yield* readJsonFile(target));
});

export const loadSharedGraphQuerySource = Effect.fn('codeGraph.sharing.loadQuerySource')(function* (input: {
  readonly checkoutId: string;
  readonly localCommit: string;
  readonly repositoryId: string;
  readonly snapshot: {readonly baseSnapshotId?: string; readonly id: string};
  readonly threadnoteHome: string;
}) {
  const provenance = yield* readSharedGraphProvenance(input.threadnoteHome, input.checkoutId).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (provenance === undefined || provenance.repositoryId !== input.repositoryId) return undefined;
  const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.repositoryId).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (trust === undefined || trust.profileDigest !== provenance.profileDigest) return undefined;
  if (input.snapshot.id !== provenance.snapshotId && input.snapshot.baseSnapshotId !== provenance.snapshotId) {
    return undefined;
  }
  return sharedGraphQuerySource(provenance, input.localCommit);
});

export const writeSharedGraphImportAttempt = Effect.fn('codeGraph.sharing.writeImportAttempt')(function* (
  threadnoteHome: string,
  checkoutId: string,
  attempt: SharedGraphImportAttemptV1,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  yield* writePrivateJsonFile(graphSharingAttemptPath(path, layout.attemptsRoot, checkoutId), attempt);
});

export const readSharedGraphImportAttempt = Effect.fn('codeGraph.sharing.readImportAttempt')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const target = graphSharingAttemptPath(path, layout.attemptsRoot, checkoutId);
  if (!(yield* fs.exists(target))) return undefined;
  return parseImportAttempt(yield* readJsonFile(target));
});

export const removeSharedGraphProvenance = Effect.fn('codeGraph.sharing.removeProvenance')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const provenance = graphSharingProvenancePath(path, layout.provenanceRoot, checkoutId);
  const attempt = graphSharingAttemptPath(path, layout.attemptsRoot, checkoutId);
  if (yield* fs.exists(provenance)) yield* fs.remove(provenance, {force: true});
  if (yield* fs.exists(attempt)) yield* fs.remove(attempt, {force: true});
});

export function sharedGraphQuerySource(
  provenance: SharedGraphProvenanceV1,
  localCommit: string,
): {
  readonly deltaCount: number;
  readonly frontierCommit: string;
  readonly kind: 'shared-base-plus-local-overlay';
  readonly localCommit: string;
  readonly profileDigest: Sha256Digest;
} {
  return {
    deltaCount: provenance.deltaCount,
    frontierCommit: provenance.frontierCommit,
    kind: 'shared-base-plus-local-overlay',
    localCommit,
    profileDigest: provenance.profileDigest,
  };
}

function isSharedGraphImportAttemptReason(value: string): value is SharedGraphImportAttemptReason {
  return EffectArray.some(SHARED_GRAPH_IMPORT_ATTEMPT_REASONS, reason => reason === value);
}

function parseImportAttempt(value: unknown): SharedGraphImportAttemptV1 {
  if (!Predicate.isObject(value)) {
    throw graphSharingFailure('Shared graph import attempt is invalid.');
  }
  const record = value;
  if (typeof record.imported !== 'boolean' || typeof record.reason !== 'string') {
    throw graphSharingFailure('Shared graph import attempt is invalid.');
  }
  if (!isSharedGraphImportAttemptReason(record.reason)) {
    throw graphSharingFailure('Shared graph import attempt is invalid.');
  }
  const reason = record.reason;
  if (record.imported !== (reason === 'imported')) {
    throw graphSharingFailure('Shared graph import attempt is invalid.');
  }
  const atGeneration =
    record.atGeneration === undefined
      ? undefined
      : typeof record.atGeneration === 'number' && Number.isSafeInteger(record.atGeneration) && record.atGeneration >= 1
        ? record.atGeneration
        : undefined;
  if (record.atGeneration !== undefined && atGeneration === undefined) {
    throw graphSharingFailure('Shared graph import attempt is invalid.');
  }
  const checkpointDigest =
    record.checkpointDigest === undefined ? undefined : parseSha256Digest(String(record.checkpointDigest));
  return {
    imported: record.imported,
    reason,
    ...(atGeneration === undefined ? {} : {atGeneration}),
    ...(checkpointDigest === undefined ? {} : {checkpointDigest}),
  };
}

function parseProvenance(value: unknown): SharedGraphProvenanceV1 {
  if (!Predicate.isObject(value) || !('schemaVersion' in value)) {
    throw graphSharingFailure('Shared graph provenance is invalid.');
  }
  const record = value;
  if (
    record.schemaVersion !== 1 ||
    typeof record.snapshotId !== 'string' ||
    typeof record.frontierCommit !== 'string'
  ) {
    throw graphSharingFailure('Shared graph provenance is invalid.');
  }
  if (typeof record.repositoryId !== 'string' || !SHA256_HEX.test(record.repositoryId)) {
    throw graphSharingFailure('Shared graph provenance repository identity is invalid.');
  }
  const deltaCount =
    record.deltaCount === undefined
      ? 0
      : typeof record.deltaCount === 'number' && Number.isSafeInteger(record.deltaCount) && record.deltaCount >= 0
        ? record.deltaCount
        : undefined;
  if (record.deltaCount !== undefined && deltaCount === undefined) {
    throw graphSharingFailure('Shared graph provenance is invalid.');
  }
  return {
    checkpointDigest: parseSha256Digest(String(record.checkpointDigest)),
    deltaCount: deltaCount ?? 0,
    frontierCommit: record.frontierCommit,
    profileDigest: parseSha256Digest(String(record.profileDigest)),
    repositoryId: record.repositoryId,
    schemaVersion: 1,
    snapshotId: record.snapshotId,
  };
}
