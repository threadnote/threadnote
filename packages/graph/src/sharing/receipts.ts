import {Array as EffectArray, Option as EffectOption} from 'effect';
import {compareCodeUnits} from '../ordering.js';
import type {Sha256Digest} from './digest.js';
import type {GraphShareActionKey} from './action.js';
import type {GraphShareFrontierMachineV1} from './frontier.js';

export const GRAPH_SHARE_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface GraphShareResultAnnouncementV1 {
  readonly actionKey: GraphShareActionKey;
  readonly attestationDigest: Sha256Digest;
  readonly batchId: string;
  readonly resultManifestDigest: Sha256Digest;
  readonly semanticDigest: Sha256Digest;
}

export interface GraphShareQuarantineV1 {
  readonly actionKey: GraphShareActionKey;
  readonly semanticDigests: readonly Sha256Digest[];
}

export interface GraphShareReceiptStoreV1 {
  readonly quarantine: readonly GraphShareQuarantineV1[];
  readonly receipts: readonly GraphShareResultAnnouncementV1[];
  readonly schemaVersion: typeof GRAPH_SHARE_RECEIPT_SCHEMA_VERSION;
}

export type GraphShareAnnounceStatus = 'accepted' | 'duplicate' | 'quarantined';

export function emptyGraphShareReceiptStore(): GraphShareReceiptStoreV1 {
  return {quarantine: [], receipts: [], schemaVersion: GRAPH_SHARE_RECEIPT_SCHEMA_VERSION};
}

export function announceGraphShareResult(
  store: GraphShareReceiptStoreV1,
  announcement: GraphShareResultAnnouncementV1,
): {readonly status: GraphShareAnnounceStatus; readonly store: GraphShareReceiptStoreV1} {
  const identical = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      store.receipts,
      receipt =>
        receipt.actionKey === announcement.actionKey &&
        receipt.resultManifestDigest === announcement.resultManifestDigest &&
        receipt.attestationDigest === announcement.attestationDigest &&
        receipt.semanticDigest === announcement.semanticDigest,
    ),
  );
  if (identical !== undefined) return {status: 'duplicate', store};
  const receipts = [...store.receipts, announcement];
  const semanticDigests = uniqueDigests(
    EffectArray.map(
      EffectArray.filter(receipts, receipt => receipt.actionKey === announcement.actionKey),
      receipt => receipt.semanticDigest,
    ),
  );
  if (semanticDigests.length > 1) {
    const quarantine = [
      ...EffectArray.filter(store.quarantine, item => item.actionKey !== announcement.actionKey),
      {actionKey: announcement.actionKey, semanticDigests},
    ].sort((left, right) => compareCodeUnits(left.actionKey, right.actionKey));
    return {status: 'quarantined', store: {quarantine, receipts, schemaVersion: GRAPH_SHARE_RECEIPT_SCHEMA_VERSION}};
  }
  return {
    status: 'accepted',
    store: {quarantine: store.quarantine, receipts, schemaVersion: GRAPH_SHARE_RECEIPT_SCHEMA_VERSION},
  };
}

export function selectGraphShareResultsForFrozenBatch(
  store: GraphShareReceiptStoreV1,
  frozen: {readonly actionKeys: readonly string[]; readonly batchId: string},
): {
  readonly quarantined: readonly GraphShareActionKey[];
  readonly selected: readonly GraphShareResultAnnouncementV1[];
  readonly skippedLate: readonly GraphShareResultAnnouncementV1[];
} {
  const requested = new Set(frozen.actionKeys);
  const quarantined = new Set(EffectArray.map(store.quarantine, item => item.actionKey));
  const selected: GraphShareResultAnnouncementV1[] = [];
  const skippedLate: GraphShareResultAnnouncementV1[] = [];
  for (const receipt of store.receipts) {
    if (!requested.has(receipt.actionKey) || quarantined.has(receipt.actionKey)) continue;
    if (receipt.batchId !== frozen.batchId) {
      skippedLate.push(receipt);
      continue;
    }
    selected.push(receipt);
  }
  return {
    quarantined: [...quarantined].sort(compareCodeUnits),
    selected,
    skippedLate,
  };
}

export function selectGraphShareResultsForFrozenMachine(
  store: GraphShareReceiptStoreV1,
  machine: Pick<
    GraphShareFrontierMachineV1,
    'buildingFrontier' | 'frozenActionKeys' | 'frozenBatchId' | 'pendingRange'
  >,
) {
  const acceptedBatchIds = new Set(
    EffectArray.filter([machine.frozenBatchId, machine.buildingFrontier], (value): value is string => value !== null),
  );
  const lateBatchIds = new Set(machine.pendingRange);
  const requested = machine.frozenActionKeys.length === 0 ? undefined : new Set(machine.frozenActionKeys);
  const quarantined = new Set(EffectArray.map(store.quarantine, item => item.actionKey));
  const selected: GraphShareResultAnnouncementV1[] = [];
  const skippedLate: GraphShareResultAnnouncementV1[] = [];
  for (const receipt of store.receipts) {
    if (requested !== undefined && !requested.has(receipt.actionKey)) continue;
    if (quarantined.has(receipt.actionKey)) continue;
    if (lateBatchIds.has(receipt.batchId) && !acceptedBatchIds.has(receipt.batchId)) {
      skippedLate.push(receipt);
      continue;
    }
    if (!acceptedBatchIds.has(receipt.batchId)) {
      skippedLate.push(receipt);
      continue;
    }
    selected.push(receipt);
  }
  return {
    quarantined: [...quarantined].sort(compareCodeUnits),
    selected,
    skippedLate,
  };
}

function uniqueDigests(values: readonly Sha256Digest[]): readonly Sha256Digest[] {
  return [...new Set(values)].sort();
}
