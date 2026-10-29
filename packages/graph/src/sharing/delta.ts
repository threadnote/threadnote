import {Array as EffectArray} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {
  codeGraphCheckpointRecordOrderKey,
  compareCodeGraphCheckpointRecordOrderKeys,
  compareCodeGraphCheckpointRecords,
  type CodeGraphCheckpointHeaderV1,
  type CodeGraphCheckpointRecordOrderKeyV1,
  type CodeGraphCheckpointRecordV1,
} from '../checkpoint/schema.js';
import {compareCodeUnits} from '../ordering.js';
import {sha256Digest, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import type {GraphShareFrontierManifestV1} from './artifacts.js';
import type {GraphShareProfileV1} from './profile.js';
import * as EffectRecord from 'effect/Record';

export interface GraphShareLogicalModel {
  readonly records: ReadonlyMap<string, string>;
}

export interface GraphShareLogicalDeltaV1 {
  readonly baseCommit: string;
  readonly baseLogicalDigest: Sha256Digest;
  readonly baseSnapshotId: string;
  readonly deletions: readonly string[];
  readonly graphAbi: string;
  readonly targetCommit: string;
  readonly targetLogicalDigest: Sha256Digest;
  readonly upserts: readonly {readonly key: string; readonly value: string}[];
}

export function emptyLogicalGraph(): GraphShareLogicalModel {
  return {records: new Map()};
}

export function setLogicalRecord(model: GraphShareLogicalModel, key: string, value: string): GraphShareLogicalModel {
  const records = new Map(model.records);
  records.set(key, value);
  return {records};
}

export function deleteLogicalRecord(model: GraphShareLogicalModel, key: string): GraphShareLogicalModel {
  const records = new Map(model.records);
  records.delete(key);
  return {records};
}

export function logicalGraphDigest(model: GraphShareLogicalModel): Sha256Digest {
  return sha256Digest(
    canonicalJson(
      EffectRecord.fromEntries([...model.records.entries()].sort(([left], [right]) => compareCodeUnits(left, right))),
    ),
  );
}

export function diffLogicalGraphs(
  base: GraphShareLogicalModel,
  target: GraphShareLogicalModel,
  meta: {
    readonly baseCommit: string;
    readonly baseSnapshotId: string;
    readonly graphAbi: string;
    readonly targetCommit: string;
  },
): GraphShareLogicalDeltaV1 {
  const deletions = EffectArray.filter([...base.records.keys()], key => !target.records.has(key)).sort(
    compareCodeUnits,
  );
  const upserts = EffectArray.map(
    EffectArray.filter([...target.records.entries()], ([key, value]) => base.records.get(key) !== value).sort(
      ([left], [right]) => compareCodeUnits(left, right),
    ),
    ([key, value]) => ({key, value}),
  );
  return {
    ...meta,
    baseLogicalDigest: logicalGraphDigest(base),
    deletions,
    targetLogicalDigest: logicalGraphDigest(target),
    upserts,
  };
}

export function applyLogicalDelta(
  base: GraphShareLogicalModel,
  delta: GraphShareLogicalDeltaV1,
): GraphShareLogicalModel {
  if (logicalGraphDigest(base) !== delta.baseLogicalDigest) {
    throw graphSharingFailure('Delta base digest does not match the selected graph.');
  }
  let next = base;
  for (const key of delta.deletions) next = deleteLogicalRecord(next, key);
  for (const upsert of delta.upserts) next = setLogicalRecord(next, upsert.key, upsert.value);
  if (logicalGraphDigest(next) !== delta.targetLogicalDigest) {
    throw graphSharingFailure('Delta target digest does not match the applied records.');
  }
  return next;
}

export function compactLogicalGraph(model: GraphShareLogicalModel): GraphShareLogicalModel {
  return {records: new Map(model.records)};
}

export function selectNewestPublishedAncestor<T extends {readonly sourceCommit: string}>(
  published: readonly T[],
  isAncestorOfHead: (commit: string) => boolean,
): T | undefined {
  for (let index = published.length - 1; index >= 0; index -= 1) {
    const candidate = published[index];
    if (candidate !== undefined && isAncestorOfHead(candidate.sourceCommit)) return candidate;
  }
  return undefined;
}

export function checkpointRecordIdentityKey(key: CodeGraphCheckpointRecordOrderKeyV1): string {
  return canonicalJson([key.kind, ...key.identity]);
}

export function diffCheckpointRecords(
  base: readonly CodeGraphCheckpointRecordV1[],
  target: readonly CodeGraphCheckpointRecordV1[],
): {
  readonly deletions: readonly CodeGraphCheckpointRecordOrderKeyV1[];
  readonly upserts: readonly CodeGraphCheckpointRecordV1[];
} {
  const targetByKey = new Map(
    EffectArray.map(target, record => [checkpointRecordIdentityKey(codeGraphCheckpointRecordOrderKey(record)), record]),
  );
  const deletions = EffectArray.filter(
    EffectArray.map(base, record => codeGraphCheckpointRecordOrderKey(record)),
    key => !targetByKey.has(checkpointRecordIdentityKey(key)),
  ).sort(compareCodeGraphCheckpointRecordOrderKeys);
  const baseByKey = new Map(
    EffectArray.map(base, record => [
      checkpointRecordIdentityKey(codeGraphCheckpointRecordOrderKey(record)),
      canonicalJson(record),
    ]),
  );
  const upserts = EffectArray.filter(target, record => {
    const key = checkpointRecordIdentityKey(codeGraphCheckpointRecordOrderKey(record));
    return baseByKey.get(key) !== canonicalJson(record);
  }).sort(compareCodeGraphCheckpointRecords);
  return {deletions, upserts};
}

export function applyCheckpointRecords(
  base: readonly CodeGraphCheckpointRecordV1[],
  delta: {
    readonly deletions: readonly CodeGraphCheckpointRecordOrderKeyV1[];
    readonly upserts: readonly CodeGraphCheckpointRecordV1[];
  },
): readonly CodeGraphCheckpointRecordV1[] {
  const records = new Map(
    EffectArray.map(base, record => [checkpointRecordIdentityKey(codeGraphCheckpointRecordOrderKey(record)), record]),
  );
  for (const deletion of delta.deletions) records.delete(checkpointRecordIdentityKey(deletion));
  for (const upsert of delta.upserts) {
    records.set(checkpointRecordIdentityKey(codeGraphCheckpointRecordOrderKey(upsert)), upsert);
  }
  return [...records.values()].sort(compareCodeGraphCheckpointRecords);
}

export function graphShareDeltaClosureComplete(
  previous: CodeGraphCheckpointHeaderV1,
  next: CodeGraphCheckpointHeaderV1,
): boolean {
  if (previous.repository.repositoryId !== next.repository.repositoryId) return false;
  if (previous.abi.digest !== next.abi.digest) return false;
  const previousReuse = previous.reuse;
  const nextReuse = next.reuse;
  if (previousReuse === undefined || nextReuse === undefined) return false;
  return (
    previousReuse.workspaceFingerprint === nextReuse.workspaceFingerprint &&
    previousReuse.resolutionSurfaceVersion === nextReuse.resolutionSurfaceVersion &&
    previousReuse.formatVersion === nextReuse.formatVersion
  );
}

export function planGraphSharePublication(input: {
  readonly chainDeltaBytes: number;
  readonly chainDeltaCount: number;
  readonly checkpointAgeSeconds: number;
  readonly closureComplete: boolean;
  readonly nextDeltaBytes: number;
  readonly profile: GraphShareProfileV1['frontier'];
}): 'compact' | 'delta' {
  if (!input.closureComplete) return 'compact';
  if (input.chainDeltaCount >= input.profile.compactAfterDeltas) return 'compact';
  if (input.chainDeltaBytes + input.nextDeltaBytes > input.profile.compactAfterDeltaBytes) return 'compact';
  if (input.checkpointAgeSeconds >= input.profile.compactAfterSeconds) return 'compact';
  return 'delta';
}

export function validateGraphShareFrontierDeltaChain(manifest: GraphShareFrontierManifestV1): void {
  if (manifest.deltas.length === 0) {
    if (manifest.sourceCommit !== manifest.checkpoint.sourceCommit) {
      throw graphSharingFailure('Frontier sourceCommit must match the checkpoint sourceCommit.');
    }
    if (manifest.snapshotId !== manifest.checkpoint.snapshotId) {
      throw graphSharingFailure('Frontier snapshotId must match the checkpoint snapshotId.');
    }
    return;
  }
  const last = manifest.deltas[manifest.deltas.length - 1];
  if (last === undefined || manifest.sourceCommit !== last.targetCommit) {
    throw graphSharingFailure('Frontier sourceCommit must match the last delta targetCommit.');
  }
  if (manifest.snapshotId !== last.targetSnapshotId) {
    throw graphSharingFailure('Frontier snapshotId must match the last delta targetSnapshotId.');
  }
  let baseSnapshotId = manifest.checkpoint.snapshotId;
  const seen = new Set<string>([baseSnapshotId]);
  for (const delta of manifest.deltas) {
    if (delta.baseSnapshotId !== baseSnapshotId) {
      throw graphSharingFailure('Frontier delta baseSnapshotId does not follow the published chain.');
    }
    if (seen.has(delta.targetSnapshotId)) {
      throw graphSharingFailure('Frontier delta targetSnapshotId is not unique.');
    }
    seen.add(delta.targetSnapshotId);
    baseSnapshotId = delta.targetSnapshotId;
  }
}

export function graphShareApplyIsAlreadyAtTarget(
  existing:
    | {
        readonly checkpointDigest: string;
        readonly frontierCommit: string;
        readonly snapshotId: string;
      }
    | undefined,
  selected: GraphShareFrontierManifestV1,
): boolean {
  return (
    existing !== undefined &&
    existing.checkpointDigest === selected.checkpoint.manifestDigest &&
    existing.frontierCommit === selected.sourceCommit &&
    existing.snapshotId === selected.snapshotId
  );
}

export function graphShareApplyBaseMatches(
  existing:
    | {
        readonly checkpointDigest: string;
        readonly snapshotId: string;
      }
    | undefined,
  selected: GraphShareFrontierManifestV1,
): boolean {
  if (existing === undefined || selected.deltas.length === 0) return true;
  if (existing.checkpointDigest !== selected.checkpoint.manifestDigest) return false;
  if (existing.snapshotId === selected.checkpoint.snapshotId || existing.snapshotId === selected.snapshotId) {
    return true;
  }
  return EffectArray.some(
    selected.deltas,
    delta => delta.baseSnapshotId === existing.snapshotId || delta.targetSnapshotId === existing.snapshotId,
  );
}
