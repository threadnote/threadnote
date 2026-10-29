import {Array as EffectArray} from 'effect';
import {compareCodeUnits} from '../../ordering.js';
import type {GraphWorkerAdmissionReceiptV2, GraphWorkerAdmissionView} from './admission_state.js';

/** Keep ordered same-action alternatives until full source and OCI authority are verified. */
export function selectGraphWorkerReceiptsForSource(
  store: GraphWorkerAdmissionView,
  source: {
    readonly actionKeys: readonly string[];
    readonly profileDigest: string;
    readonly repositoryId: string;
    readonly sourceCommit: string;
  },
): {
  readonly quarantined: readonly string[];
  readonly candidateGroups: readonly {
    readonly actionKey: string;
    readonly alternatives: readonly GraphWorkerAdmissionReceiptV2[];
  }[];
  readonly skippedLate: readonly GraphWorkerAdmissionReceiptV2[];
} {
  const requested = source.actionKeys.length === 0 ? undefined : new Set(source.actionKeys);
  const quarantined = new Set(
    EffectArray.map(
      EffectArray.filter(store.quarantine, item => item.repositoryId === source.repositoryId),
      item => item.actionKey,
    ),
  );
  const byAction = new Map<string, GraphWorkerAdmissionReceiptV2[]>();
  const skippedLate: GraphWorkerAdmissionReceiptV2[] = [];
  for (const receipt of store.receipts) {
    const body = receipt.announcement.body;
    if (body.repositoryId !== source.repositoryId || body.profileDigest !== source.profileDigest) continue;
    if (requested !== undefined && !requested.has(body.actionKey)) continue;
    if (quarantined.has(body.actionKey)) continue;
    if (receipt.sourceCommit !== source.sourceCommit) {
      skippedLate.push(receipt);
      continue;
    }
    const alternatives = byAction.get(body.actionKey) ?? [];
    alternatives.push(receipt);
    byAction.set(body.actionKey, alternatives);
  }
  return {
    quarantined: [...quarantined].sort(compareCodeUnits),
    candidateGroups: EffectArray.map(
      [...byAction.entries()].sort(([left], [right]) => compareCodeUnits(left, right)),
      ([actionKey, alternatives]) => ({
        actionKey,
        alternatives: alternatives.sort((a, b) =>
          compareCodeUnits(a.announcement.body.idempotencyKey, b.announcement.body.idempotencyKey),
        ),
      }),
    ),
    skippedLate: skippedLate.sort((a, b) =>
      compareCodeUnits(a.announcement.body.idempotencyKey, b.announcement.body.idempotencyKey),
    ),
  };
}
