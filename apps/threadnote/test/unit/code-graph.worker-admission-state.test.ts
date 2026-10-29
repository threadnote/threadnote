import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Schema} from 'effect';
import * as FC from 'fast-check';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
  GRAPH_WORKER_ADMISSION_MAX_RECEIPTS,
  GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES,
  mergeGraphWorkerAdmissionReceipts,
  parseGraphWorkerAdmissionBytes,
  parseGraphWorkerAdmissionStore,
  retireGraphWorkerAdmissionsForPublishedSource,
  retireGraphWorkerAdmissionsForPublishedSources,
} from '@threadnote/graph/sharing/worker/admission_state';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {verifyGraphWorkerResultAnnouncement} from '@threadnote/graph/sharing/worker/announcement';
import type {GraphWorkerResultAnnouncement} from '@threadnote/graph/sharing/worker/announcement';
import type {GraphWorkerResultAuthority} from '@threadnote/graph/sharing/worker/result';
import {makeGraphWorkerSigner} from '@threadnote/graph/sharing/worker/signing';

import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));
const NOW = 1000;
const authority: GraphWorkerResultAuthority = {
  expiresAt: 2000,
  graphAbi: Effect2.pipe('a', EffectString.repeat(64)),
  principalId: sha256Digest('principal'),
  profileDigest: sha256Digest('profile'),
  repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
  signingPublicKey: Effect2.pipe('c', EffectString.repeat(64)),
  workerId: `gw_${Effect2.pipe('d', EffectString.repeat(32))}`,
};

function announcement(
  seed: number,
  semantic = seed,
  actionKey = Effect2.pipe('e', EffectString.repeat(64)),
  batchId = Effect2.pipe('f', EffectString.repeat(40)),
): GraphWorkerResultAnnouncement {
  const fields = {
    actionKey,
    attestationDigest: sha256Digest(`attestation-${seed}`),
    batchId,
    principalId: authority.principalId,
    profileDigest: authority.profileDigest,
    repositoryId: authority.repositoryId,
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
  };
}

function admit(
  store: ReturnType<typeof emptyGraphWorkerAdmissionStore>,
  signed: GraphWorkerResultAnnouncement,
  worker = authority,
  sourceCommit = signed.body.batchId,
) {
  return admitGraphWorkerAnnouncement(store, {
    announcement: signed,
    authority: worker,
    nowSeconds: NOW,
    sourceCommit,
  });
}

describe('signed worker admission state', () => {
  it('persists exact signed identity and returns the original receipt for a live exact replay', () => {
    const signed = announcement(1);
    const first = admit(emptyGraphWorkerAdmissionStore(), signed);
    expect(first.status).toBe('accepted');
    if (!('receipt' in first)) throw new Error('Expected receipt.');
    expect(first.receipt.announcement).toEqual(signed);
    expect(first.receipt.signedBodyDigest).toBe(sha256Digest(canonicalJson(signed.body)));
    expect(first.receipt.announcementDigest).toBe(sha256Digest(canonicalJson(signed)));
    expect(first.receipt.authorityExpiresAt).toBe(authority.expiresAt);
    expect(first.receipt.graphAbi).toBe(authority.graphAbi);
    const replay = admit(first.store, signed);
    expect(replay.status).toBe('duplicate');
    if (!('receipt' in replay)) throw new Error('Expected replay receipt.');
    expect(replay.receipt).toBe(first.receipt);
    expect(replay.store).toBe(first.store);
    const later = admitGraphWorkerAnnouncement(first.store, {
      announcement: signed,
      authority,
      nowSeconds: NOW + 1,
      sourceCommit: signed.body.batchId,
    });
    expect(later).toEqual(replay);
    Object.assign(signed.body, {resultManifestDigest: sha256Digest('caller mutation')});
    expect(first.receipt.announcement.body.resultManifestDigest).not.toBe(signed.body.resultManifestDigest);
    expect(parseGraphWorkerAdmissionStore(JSON.parse(JSON.stringify(first.store)))).toEqual(first.store);
  });

  it('refuses same operation ID with changed body or signature without changing state', () => {
    const signed = announcement(1);
    const first = admit(emptyGraphWorkerAdmissionStore(), signed);
    const changedBody = {...signed, body: {...signed.body, semanticDigest: sha256Digest('changed')}};
    const changedSignature = {...signed, signature: Effect2.pipe('0', EffectString.repeat(128))};
    for (const changed of [changedBody, changedSignature]) {
      const result = admit(first.store, changed);
      expect(result.status).toBe('operation-conflict');
      expect(result.store).toBe(first.store);
    }
    expect(admit(emptyGraphWorkerAdmissionStore(), changedBody).status).toBe('invalid-authority');
  });

  it('quarantines every same-action semantic conflict regardless of arrival order or batch', () => {
    const first = announcement(1, 1);
    const other = announcement(2, 2, first.body.actionKey, Effect2.pipe('1', EffectString.repeat(40)));
    const left = admit(admit(emptyGraphWorkerAdmissionStore(), first).store, other);
    const right = admit(admit(emptyGraphWorkerAdmissionStore(), other).store, first);
    expect(left.status).toBe('quarantined');
    expect(right.status).toBe('quarantined');
    expect(left.store).toEqual(right.store);
    expect(left.store.quarantine).toEqual([
      {
        actionKey: first.body.actionKey,
        repositoryId: first.body.repositoryId,
        semanticDigests: [first.body.semanticDigest, other.body.semanticDigest].sort(),
      },
    ]);
    expect(admit(left.store, first).status).toBe('duplicate');
  });

  it('keeps replay and same-action conflicts across parked and hot receipts', () => {
    const first = admit(emptyGraphWorkerAdmissionStore(), announcement(1, 1));
    const second = admit(
      emptyGraphWorkerAdmissionStore(),
      announcement(2, 2, first.store.receipts[0].announcement.body.actionKey),
    );
    const union = mergeGraphWorkerAdmissionReceipts(first.store.receipts, second.store.receipts);
    expect(union.receipts).toHaveLength(2);
    expect(union.quarantine).toHaveLength(1);
    expect(mergeGraphWorkerAdmissionReceipts(first.store.receipts, first.store.receipts).receipts).toHaveLength(1);
    expect(() =>
      mergeGraphWorkerAdmissionReceipts(first.store.receipts, [
        {...first.store.receipts[0], graphAbi: Effect2.pipe('0', EffectString.repeat(64))},
      ]),
    ).toThrow();
  });

  it('preserves the logical receipt set and quarantine for every hot/cold partition', () => {
    FC.assert(
      FC.property(
        FC.uniqueArray(FC.integer({min: 1, max: 100_000}), {minLength: 1, maxLength: 8}),
        FC.array(FC.boolean(), {minLength: 8, maxLength: 8}),
        (seeds, partition) => {
          let store = emptyGraphWorkerAdmissionStore();
          for (const seed of seeds) store = admit(store, announcement(seed, seed % 3)).store;
          const hot = EffectArrayPipe(store.receipts, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (_, index) => index in __effectArrayValues && Boolean(partition[index]),
            ),
          );
          const cold = EffectArray.filter(store.receipts, (_, index) => !partition[index]);
          expect(mergeGraphWorkerAdmissionReceipts(hot, cold)).toEqual({
            quarantine: store.quarantine,
            receipts: store.receipts,
          });
        },
      ),
      {numRuns: 40},
    );
  });

  it('retires only the exact canonical source, recomputes quarantine, and is idempotent', () => {
    const prefix = Effect2.pipe('f', EffectString.repeat(40));
    const firstCommit = prefix + Effect2.pipe('a', EffectString.repeat(24));
    const nextCommit = prefix + Effect2.pipe('b', EffectString.repeat(24));
    const first = admit(emptyGraphWorkerAdmissionStore(), announcement(1, 1), authority, firstCommit);
    const conflict = admit(first.store, announcement(2, 2), authority, firstCommit);
    const future = admit(conflict.store, announcement(3, 2), authority, nextCommit);
    expect(future.store.quarantine).toHaveLength(1);
    const retired = retireGraphWorkerAdmissionsForPublishedSource(future.store, firstCommit);
    expect(retired.receipts).toHaveLength(1);
    expect(retired.receipts[0].sourceCommit).toBe(nextCommit);
    expect(retired.quarantine).toHaveLength(0);
    expect(retireGraphWorkerAdmissionsForPublishedSource(retired, firstCommit)).toBe(retired);
    expect(parseGraphWorkerAdmissionStore(retired)).toEqual(retired);
  });

  it('retires exactly the supplied published-source set without mutating admission state', () => {
    FC.assert(
      FC.property(
        FC.uniqueArray(FC.integer({min: 1, max: 100_000}), {minLength: 1, maxLength: 8}),
        FC.array(FC.boolean(), {minLength: 8, maxLength: 8}),
        (seeds, selected) => {
          const commits = EffectArray.map(seeds, seed =>
            Effect2.pipe(seed.toString(16), EffectString.padStart(40, '0')),
          );
          let store = emptyGraphWorkerAdmissionStore();
          for (const [index, seed] of seeds.entries())
            store = admit(store, announcement(seed, seed, authority.repositoryId, commits[index])).store;
          const original = canonicalJson(store);
          const covered = new Set(EffectArray.filter(commits, (_, index) => index in commits && selected[index]));
          const retired = retireGraphWorkerAdmissionsForPublishedSources(store, covered);
          expect(EffectArray.map(retired.receipts, receipt => receipt.sourceCommit)).toEqual(
            EffectArray.map(
              EffectArray.filter(store.receipts, receipt => !covered.has(receipt.sourceCommit)),
              receipt => receipt.sourceCommit,
            ),
          );
          expect(retireGraphWorkerAdmissionsForPublishedSources(retired, covered)).toBe(retired);
          expect(canonicalJson(store)).toBe(original);
          expect(parseGraphWorkerAdmissionStore(retired)).toEqual(retired);
        },
      ),
      {numRuns: 60},
    );
  });

  it('rejects expired or mismatched authority before acknowledging a replay', () => {
    const signed = announcement(1);
    const first = admit(emptyGraphWorkerAdmissionStore(), signed);
    for (const changed of [
      {...authority, expiresAt: NOW},
      {...authority, principalId: sha256Digest('other')},
      {...authority, signingPublicKey: Effect2.pipe('0', EffectString.repeat(64))},
    ]) {
      const result = admit(first.store, signed, changed);
      expect(result.status).toBe('invalid-authority');
      expect(result.store).toBe(first.store);
    }
    expect(
      admit(first.store, signed, {...authority, graphAbi: Effect2.pipe('0', EffectString.repeat(64))}).status,
    ).toBe('operation-conflict');
  });

  it('refuses capacity without losing an existing receipt or quarantine', () => {
    let store = emptyGraphWorkerAdmissionStore();
    for (let index = 0; index < GRAPH_WORKER_ADMISSION_MAX_RECEIPTS; index += 1)
      store = admit(store, announcement(index, index % 2)).store;
    expect(store.receipts).toHaveLength(GRAPH_WORKER_ADMISSION_MAX_RECEIPTS);
    expect(store.quarantine).toHaveLength(1);
    const before = store;
    const refusal = admit(store, announcement(GRAPH_WORKER_ADMISSION_MAX_RECEIPTS + 1));
    expect(refusal.status).toBe('capacity-exceeded');
    expect(refusal.store).toBe(before);
    expect(admit(store, announcement(0, 0)).status).toBe('duplicate');
    expect(parseGraphWorkerAdmissionStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
    const bytes = new TextEncoder().encode(JSON.stringify(store));
    expect(bytes.byteLength).toBeLessThan(GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES);
    expect(parseGraphWorkerAdmissionBytes(bytes)).toEqual(store);
  });

  it('rejects malformed or inconsistent durable state rather than accepting it as empty', () => {
    const result = admit(emptyGraphWorkerAdmissionStore(), announcement(1));
    const valid = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      JSON.parse(JSON.stringify(result.store)),
    );
    expect(() => parseGraphWorkerAdmissionStore({...valid, schemaVersion: 1})).toThrow();
    expect(() => parseGraphWorkerAdmissionStore({...valid, extra: true})).toThrow();
    const receipts = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(
      valid.receipts,
    );
    expect(() =>
      parseGraphWorkerAdmissionStore({
        ...valid,
        receipts: [{...receipts[0], announcementDigest: sha256Digest('forged')}],
      }),
    ).toThrow();
    expect(() => parseGraphWorkerAdmissionBytes(new Uint8Array(GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES + 1))).toThrow();
    expect(() => parseGraphWorkerAdmissionBytes(new Uint8Array([0xff]))).toThrow();
    expect(() => parseGraphWorkerAdmissionStore({...valid, receipts: [...receipts, receipts[0]]})).toThrow();
    expect(() =>
      parseGraphWorkerAdmissionStore({
        ...valid,
        quarantine: [
          {
            actionKey: Effect2.pipe('0', EffectString.repeat(64)),
            repositoryId: Effect2.pipe('0', EffectString.repeat(64)),
            semanticDigests: [sha256Digest('a'), sha256Digest('b')],
          },
        ],
      }),
    ).toThrow();
  });

  it('is order-independent and does not mutate prior state or announcements', () => {
    FC.assert(
      FC.property(FC.uniqueArray(FC.integer({min: 1, max: 100_000}), {minLength: 1, maxLength: 6}), seeds => {
        const signed = EffectArray.map(seeds, seed => announcement(seed, seed % 3));
        const original = JSON.parse(JSON.stringify(signed));
        let forward = emptyGraphWorkerAdmissionStore();
        let reverse = emptyGraphWorkerAdmissionStore();
        for (const item of signed) {
          const previous = forward;
          const prior = JSON.parse(JSON.stringify(previous));
          forward = admit(forward, item).store;
          expect(previous).toEqual(prior);
          expect(admit(forward, item).status).toBe('duplicate');
        }
        for (const item of [...signed].reverse()) reverse = admit(reverse, item).store;
        expect(forward).toEqual(reverse);
        expect(signed).toEqual(original);
        expect(parseGraphWorkerAdmissionStore(JSON.parse(JSON.stringify(forward)))).toEqual(forward);
      }),
      {numRuns: 30},
    );
  });

  effectIt.effect('admits a real verified detached signature with the enrolled worker scope', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'worker-admission-'});
      const signer = yield* makeGraphWorkerSigner(home, sha256Digest('credential identity'));
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const scoped = {...authority, expiresAt: now + 3600, signingPublicKey: signer.publicKey};
      const unsigned = announcement(3);
      const body = unsigned.body;
      const signature = yield* signer.sign('announcement', new TextEncoder().encode(canonicalJson(body)));
      const signed = {...unsigned, publicKey: signer.publicKey, signature};
      expect(yield* verifyGraphWorkerResultAnnouncement(signed, scoped)).toEqual(body);
      const result = admitGraphWorkerAnnouncement(emptyGraphWorkerAdmissionStore(), {
        announcement: signed,
        authority: scoped,
        nowSeconds: now,
        sourceCommit: signed.body.batchId,
      });
      expect(result.status).toBe('accepted');
    }).pipe(provideTestLayer(layer)),
  );
});
