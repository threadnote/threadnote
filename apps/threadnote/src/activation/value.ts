import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {recordActivationValueEvent, type ActivationValueEventV1} from '../value_report/events.js';
import type {ActivationReceiptV1} from './contract.js';
import type {ActivationStateV1} from './store.js';

export const reconcileActivationValueEventsV1 = Effect.fn('activation.value.reconcile')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  state: ActivationStateV1,
) {
  for (const event of activationValueEventsV1(state.receipt)) {
    const {kind: _, version: __, ...input} = event;
    yield* recordActivationValueEvent(config.agentContextHome, input);
  }
});

export function activationValueEventsV1(receipt: ActivationReceiptV1): readonly ActivationValueEventV1[] {
  return [
    {
      durationMilliseconds: 0,
      eventId: activationValueEventIdV1(receipt.activationId, 'started'),
      kind: 'activation',
      phase: 'started',
      timestamp: receipt.startedAt,
      version: 1,
    },
    ...(receipt.firstBrief === undefined
      ? []
      : [
          {
            durationMilliseconds: receipt.firstBrief.durationMilliseconds,
            eventId: activationValueEventIdV1(receipt.activationId, 'first-evidence'),
            kind: 'activation' as const,
            phase: 'first-evidence' as const,
            timestamp: receipt.firstBrief.completedAt,
            version: 1 as const,
          },
        ]),
    ...(EffectArray.some(
      receipt.operations,
      operation => operation.kind === 'secondary.prove' && operation.status === 'verified',
    )
      ? [
          {
            durationMilliseconds: elapsed(receipt.startedAt, receipt.updatedAt),
            eventId: activationValueEventIdV1(receipt.activationId, 'second-surface-proof'),
            kind: 'activation' as const,
            phase: 'second-surface-proof' as const,
            timestamp: receipt.updatedAt,
            version: 1 as const,
          },
        ]
      : []),
    ...(receipt.status === 'completed' && receipt.completedAt !== undefined
      ? [
          {
            durationMilliseconds: elapsed(receipt.startedAt, receipt.completedAt),
            eventId: activationValueEventIdV1(receipt.activationId, 'completed'),
            kind: 'activation' as const,
            phase: 'completed' as const,
            timestamp: receipt.completedAt,
            version: 1 as const,
          },
        ]
      : []),
  ];
}

/** Stable, content-free identity shared by reconciliation and evidence replay. */
export function activationValueEventIdV1(
  activationId: string,
  phase: 'started' | 'first-evidence' | 'completed' | 'second-surface-proof',
): string {
  return sha256HexSync(canonicalJson({activationId, phase, type: 'threadnote-activation-value-event', version: 1}));
}

function elapsed(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
}
