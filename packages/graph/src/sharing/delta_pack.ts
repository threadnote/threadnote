import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import {
  decodeCodeGraphCheckpointPackV1,
  encodeCodeGraphCheckpointPackV1,
  type CodeGraphCheckpointEncodedPackV1,
} from '../checkpoint/pack.js';
import {
  type CodeGraphCheckpointHeaderV1,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointRecordV1,
} from '../checkpoint/schema.js';
import {GRAPH_SHARE_DELTA_MEDIA_TYPE} from './artifacts.js';
import {putCasBytes} from './cas.js';
import {putGraphShareCheckpointLayers} from './checkpoint_cas.js';
import {applyCheckpointRecords, diffCheckpointRecords} from './delta.js';
import {parseSha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';

export function checkpointMetadataFromHeader(header: CodeGraphCheckpointHeaderV1): CodeGraphCheckpointMetadataV1 {
  return {
    abi: header.abi.input,
    coverage: header.coverage,
    repository: header.repository,
    ...(header.reuse === undefined ? {} : {reuse: header.reuse}),
    source: header.source,
  };
}

export function decodeGraphShareCheckpointBytes(bytes: Uint8Array) {
  return decodeCodeGraphCheckpointPackV1(bytes);
}

export function encodeGraphShareDeltaPack(input: {
  readonly base: {
    readonly commit: string;
    readonly logicalDigest: CodeGraphCheckpointHeaderV1['logical'];
    readonly snapshotId: string;
  };
  readonly previousRecords: readonly CodeGraphCheckpointRecordV1[];
  readonly target: {
    readonly header: CodeGraphCheckpointHeaderV1;
    readonly records: readonly CodeGraphCheckpointRecordV1[];
  };
}): CodeGraphCheckpointEncodedPackV1 {
  const diff = diffCheckpointRecords(input.previousRecords, input.target.records);
  return encodeCodeGraphCheckpointPackV1(checkpointMetadataFromHeader(input.target.header), diff.upserts, {
    delta: {
      base: {
        commit: input.base.commit,
        logicalDigest: input.base.logicalDigest,
        snapshotId: input.base.snapshotId,
      },
      deletions: diff.deletions,
      targetLogical: input.target.header.logical,
    },
    packKind: 'delta',
  });
}

export function applyGraphShareDeltaPack(
  baseRecords: readonly CodeGraphCheckpointRecordV1[],
  delta: {
    readonly header: CodeGraphCheckpointHeaderV1;
    readonly records: readonly CodeGraphCheckpointRecordV1[];
  },
): readonly CodeGraphCheckpointRecordV1[] {
  if (delta.header.packKind !== 'delta' || delta.header.base === undefined || delta.header.deletions === undefined) {
    throw graphSharingFailure('Shared graph delta pack is missing its deletion envelope.');
  }
  return applyCheckpointRecords(baseRecords, {deletions: delta.header.deletions, upserts: delta.records});
}

export function composeGraphShareTargetRecords(
  checkpointRecords: readonly CodeGraphCheckpointRecordV1[],
  deltas: readonly {
    readonly header: CodeGraphCheckpointHeaderV1;
    readonly records: readonly CodeGraphCheckpointRecordV1[];
  }[],
): readonly CodeGraphCheckpointRecordV1[] {
  return EffectArray.reduce(deltas, checkpointRecords, applyGraphShareDeltaPack);
}

export const putGraphShareDeltaArtifact = Effect.fn('codeGraph.sharing.putDeltaArtifact')(function* (
  casRoot: string,
  pack: CodeGraphCheckpointEncodedPackV1,
) {
  const digest = yield* putCasBytes(casRoot, pack.bytes);
  if (digest !== parseSha256Digest(pack.descriptor.digest)) {
    return yield* graphSharingFailure('Delta CAS digest does not match the encoded artifact.');
  }
  const layers = yield* putGraphShareCheckpointLayers(casRoot, digest, GRAPH_SHARE_DELTA_MEDIA_TYPE);
  return {digest, layers};
});

export const writeTemporaryCheckpointPack = Effect.fn('codeGraph.sharing.writeTemporaryCheckpoint')(function* (
  directory: string,
  name: string,
  pack: CodeGraphCheckpointEncodedPackV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(directory, name);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  yield* fs.writeFile(target, pack.bytes, {flag: 'wx', mode: 0o600});
  return target;
});
