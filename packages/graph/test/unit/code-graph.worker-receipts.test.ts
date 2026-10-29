import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
} from '@threadnote/graph/sharing/worker/admission_state';
import type {GraphWorkerResultAnnouncement} from '@threadnote/graph/sharing/worker/announcement';
import {selectGraphWorkerReceiptsForSource} from '@threadnote/graph/sharing/worker/receipts';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const repositoryId = Effect2.pipe('a', EffectString.repeat(64));
const profileDigest = sha256Digest('profile');
const sourceCommit = `${Effect2.pipe('b', EffectString.repeat(40))}${Effect2.pipe('c', EffectString.repeat(24))}`;
const actionKey = Effect2.pipe('d', EffectString.repeat(64));
const authority = {
  expiresAt: 2_000,
  graphAbi: Effect2.pipe('e', EffectString.repeat(64)),
  principalId: sha256Digest('principal'),
  profileDigest,
  repositoryId,
  signingPublicKey: Effect2.pipe('f', EffectString.repeat(64)),
  workerId: `gw_${Effect2.pipe('1', EffectString.repeat(32))}`,
};

function announcement(
  seed: number,
  action = actionKey,
  semantic = 1,
  batch = Effect2.pipe(sourceCommit, EffectString.slice(0, 40)),
) {
  const fields = {
    actionKey: action,
    attestationDigest: sha256Digest(`attestation-${seed}`),
    batchId: batch,
    principalId: authority.principalId,
    profileDigest,
    repositoryId,
    resultManifestDigest: sha256Digest(`manifest-${seed}`),
    semanticDigest: sha256Digest(`semantic-${semantic}`),
    workerId: authority.workerId,
  };
  return {
    algorithm: 'ed25519',
    body: {
      ...fields,
      idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields)),
    },
    publicKey: authority.signingPublicKey,
    schemaVersion: 1,
    signature: Effect2.pipe(seed.toString(16), EffectString.padStart(128, '0')),
  } as GraphWorkerResultAnnouncement;
}

function admitted(items: readonly GraphWorkerResultAnnouncement[]) {
  return EffectArray.reduce(
    items,
    emptyGraphWorkerAdmissionStore(),
    (store, item) =>
      admitGraphWorkerAnnouncement(store, {
        announcement: item,
        authority,
        nowSeconds: 1_000,
        sourceCommit:
          item.body.batchId === Effect2.pipe(sourceCommit, EffectString.slice(0, 40))
            ? sourceCommit
            : item.body.batchId,
      }).store,
  );
}

const source = {actionKeys: [] as string[], profileDigest, repositoryId, sourceCommit};

describe('signed worker receipt selection', () => {
  fcEffectProp(
    effectIt,
    'is independent of admission order and retains deterministic same-semantic alternatives',
    {ranks: FC.tuple(FC.integer(), FC.integer(), FC.integer())},
    ({ranks}) =>
      Effect.sync(() => {
        const items = [announcement(1), announcement(2), announcement(3, Effect2.pipe('2', EffectString.repeat(64)))];
        const permuted = EffectArray.map(
          EffectArray.map(items, (item, index) => ({item, rank: ranks[index], index})).sort(
            (a, b) => a.rank - b.rank || a.index - b.index,
          ),
          row => row.item,
        );
        const left = selectGraphWorkerReceiptsForSource(admitted(items), source);
        const right = selectGraphWorkerReceiptsForSource(admitted(permuted), source);
        expect(right).toEqual(left);
        expect(left.candidateGroups).toHaveLength(2);
        expect(
          EffectOption.getOrUndefined(
            EffectOption.map(
              EffectOption.fromNullishOr(
                EffectOption.getOrUndefined(
                  EffectArray.findFirst(left.candidateGroups, row => row.actionKey === actionKey),
                )?.alternatives,
              ),
              __effectArrayReceiver =>
                EffectArray.map(__effectArrayReceiver, item => item.announcement.body.idempotencyKey),
            ),
          ),
        ).toEqual([items[0].body.idempotencyKey, items[1].body.idempotencyKey].sort());
      }),
    {fastCheck: {numRuns: 30}},
  );

  effectIt.effect('skips late source prefixes and quarantines all conflicting semantics', () =>
    Effect.sync(() => {
      const store = admitted([
        announcement(1),
        announcement(2, actionKey, 2),
        announcement(3, Effect2.pipe('2', EffectString.repeat(64)), 1, Effect2.pipe('3', EffectString.repeat(40))),
      ]);
      const selected = selectGraphWorkerReceiptsForSource(store, source);
      expect(selected.quarantined).toEqual([actionKey]);
      expect(selected.candidateGroups).toEqual([]);
      expect(selected.skippedLate).toHaveLength(1);
    }),
  );

  effectIt.effect('distinguishes SHA-256 commits with the same batch prefix', () =>
    Effect.sync(() => {
      const samePrefixOtherCommit = `${Effect2.pipe(sourceCommit, EffectString.slice(0, 40))}${Effect2.pipe('e', EffectString.repeat(24))}`;
      const signed = announcement(4);
      const store = admitGraphWorkerAnnouncement(emptyGraphWorkerAdmissionStore(), {
        announcement: signed,
        authority,
        nowSeconds: 1_000,
        sourceCommit: samePrefixOtherCommit,
      }).store;
      const selected = selectGraphWorkerReceiptsForSource(store, source);
      expect(selected.candidateGroups).toHaveLength(0);
      expect(selected.skippedLate).toHaveLength(1);
    }),
  );
});
