import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  announceGraphShareResult,
  emptyGraphShareReceiptStore,
  selectGraphShareResultsForFrozenBatch,
  selectGraphShareResultsForFrozenMachine,
  type GraphShareResultAnnouncementV1,
} from '@threadnote/graph/sharing/receipts';
import {
  lateResultAdmitted,
  observeCanonicalHead,
  freezeGraphShareBatch,
  failGraphShareBatch,
  idleGraphShareFrontier,
  publishGraphShareBatch,
  verifyGraphShareBatch,
  assembleGraphShareBatch,
} from '@threadnote/graph/sharing/frontier';
import type {Sha256Digest} from '@threadnote/graph/sharing/digest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const digest = (character: string): Sha256Digest => `sha256:${Effect.pipe(character, EffectString.repeat(64))}`;

describe('graph share receipts and frozen batches', () => {
  it('is order-independent and duplicate-idempotent for identical announcements', () => {
    FC.assert(
      FC.property(FC.array(announcementArb(), {maxLength: 6, minLength: 1}), announcements => {
        const shuffled = [...announcements].reverse();
        let left = emptyGraphShareReceiptStore();
        let right = emptyGraphShareReceiptStore();
        for (const announcement of announcements) {
          left = announceGraphShareResult(left, announcement).store;
          left = announceGraphShareResult(left, announcement).store;
        }
        for (const announcement of shuffled) {
          right = announceGraphShareResult(right, announcement).store;
        }
        expect(left.receipts).toHaveLength(uniqueKeys(announcements).length);
        expect(EffectArray.map(right.receipts, receiptKey).sort()).toEqual(
          EffectArray.map(left.receipts, receiptKey).sort(),
        );
      }),
      {numRuns: 25},
    );
  });

  it('quarantines one action key with two semantic digests and never first-writer-wins', () => {
    const first: GraphShareResultAnnouncementV1 = {
      actionKey: Effect.pipe('a', EffectString.repeat(64)),
      attestationDigest: digest('1'),
      batchId: Effect.pipe('b', EffectString.repeat(40)),
      resultManifestDigest: digest('2'),
      semanticDigest: digest('3'),
    };
    const second = {
      ...first,
      attestationDigest: digest('4'),
      resultManifestDigest: digest('5'),
      semanticDigest: digest('6'),
    };
    const accepted = announceGraphShareResult(emptyGraphShareReceiptStore(), first);
    expect(accepted.status).toBe('accepted');
    const quarantined = announceGraphShareResult(accepted.store, second);
    expect(quarantined.status).toBe('quarantined');
    const collided = announceGraphShareResult(accepted.store, {...first, semanticDigest: digest('9')});
    expect(collided.status).toBe('quarantined');
    const selected = selectGraphShareResultsForFrozenBatch(quarantined.store, {
      actionKeys: [first.actionKey],
      batchId: first.batchId,
    });
    expect(selected.selected).toEqual([]);
    expect(selected.quarantined).toEqual([first.actionKey]);
  });

  it('rejects late results from a different frozen batch', () => {
    let machine = idleGraphShareFrontier();
    machine = observeCanonicalHead(machine, {
      commit: Effect.pipe('c', EffectString.repeat(40)),
      isDescendantOfPublished: true,
      nowSeconds: 0,
    });
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [Effect.pipe('a', EffectString.repeat(64))],
      changedBytes: 1,
      changedFiles: 1,
      nowSeconds: 30,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    expect(machine.phase).toBe('frozen');
    expect(lateResultAdmitted(machine, machine.frozenBatchId ?? '')).toBe(true);
    expect(lateResultAdmitted(machine, Effect.pipe('d', EffectString.repeat(40)))).toBe(false);
    const late: GraphShareResultAnnouncementV1 = {
      actionKey: Effect.pipe('a', EffectString.repeat(64)),
      attestationDigest: digest('1'),
      batchId: Effect.pipe('d', EffectString.repeat(40)),
      resultManifestDigest: digest('2'),
      semanticDigest: digest('3'),
    };
    const selected = selectGraphShareResultsForFrozenBatch(
      announceGraphShareResult(emptyGraphShareReceiptStore(), late).store,
      {
        actionKeys: [late.actionKey],
        batchId: machine.frozenBatchId ?? '',
      },
    );
    expect(selected.skippedLate).toHaveLength(1);
    expect(selected.selected).toEqual([]);
  });

  it('keeps C in pendingRange while B is frozen and treats C receipts as late', () => {
    let machine = idleGraphShareFrontier();
    const commitB = Effect.pipe('b', EffectString.repeat(40));
    const commitC = Effect.pipe('c', EffectString.repeat(40));
    machine = observeCanonicalHead(machine, {commit: commitB, isDescendantOfPublished: true, nowSeconds: 0});
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [Effect.pipe('a', EffectString.repeat(64))],
      changedBytes: 1,
      changedFiles: 1,
      nowSeconds: 30,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    expect(machine.phase).toBe('frozen');
    machine = observeCanonicalHead(machine, {commit: commitC, isDescendantOfPublished: true, nowSeconds: 31});
    expect(machine.pendingRange).toEqual([commitC]);
    expect(machine.buildingFrontier).toBe(commitB);
    const forB: GraphShareResultAnnouncementV1 = {
      actionKey: Effect.pipe('a', EffectString.repeat(64)),
      attestationDigest: digest('1'),
      batchId: commitB,
      resultManifestDigest: digest('2'),
      semanticDigest: digest('3'),
    };
    const forC = {...forB, batchId: commitC, resultManifestDigest: digest('8')};
    let store = emptyGraphShareReceiptStore();
    store = announceGraphShareResult(store, forB).store;
    store = announceGraphShareResult(store, forC).store;
    const selected = selectGraphShareResultsForFrozenMachine(store, machine);
    expect(EffectArray.map(selected.selected, receipt => receipt.batchId)).toEqual([commitB]);
    expect(EffectArray.map(selected.skippedLate, receipt => receipt.batchId)).toEqual([commitC]);
    const generation = machine.generation;
    machine = assembleGraphShareBatch(machine);
    machine = verifyGraphShareBatch(machine);
    machine = publishGraphShareBatch(machine, digest('9'));
    expect(machine.generation).toBe(generation + 1);
    expect(machine.publishedFrontier).toBe(commitB);
    expect(machine.pendingRange).toEqual([commitC]);
  });

  it('does not move generation when verify fails after freeze', () => {
    let machine = idleGraphShareFrontier();
    machine = observeCanonicalHead(machine, {
      commit: Effect.pipe('b', EffectString.repeat(40)),
      isDescendantOfPublished: true,
      nowSeconds: 0,
    });
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [],
      changedBytes: 1,
      changedFiles: 1,
      nowSeconds: 30,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    const generation = machine.generation;
    const published = machine.publishedFrontier;
    machine = failGraphShareBatch(machine);
    expect(machine.phase).toBe('failed');
    expect(machine.generation).toBe(generation);
    expect(machine.publishedFrontier).toBe(published);
  });

  it('retries freeze after a failed verifying batch without moving the pointer', () => {
    const commit = Effect.pipe('b', EffectString.repeat(40));
    let machine = idleGraphShareFrontier();
    machine = observeCanonicalHead(machine, {commit, isDescendantOfPublished: true, nowSeconds: 0});
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [],
      changedBytes: 1,
      changedFiles: 1,
      nowSeconds: 30,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    machine = assembleGraphShareBatch(machine);
    machine = verifyGraphShareBatch(machine);
    const generation = machine.generation;
    const published = machine.publishedFrontier;
    machine = failGraphShareBatch(machine);
    expect(machine.phase).toBe('failed');
    machine = observeCanonicalHead(machine, {commit, isDescendantOfPublished: true, nowSeconds: 40});
    expect(machine.phase).toBe('collecting');
    expect(machine.generation).toBe(generation);
    expect(machine.publishedFrontier).toBe(published);
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [],
      changedBytes: 1,
      changedFiles: 1,
      nowSeconds: 40,
      thresholds: {maximumAgeSeconds: 0, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    expect(machine.phase).toBe('frozen');
    expect(machine.generation).toBe(generation);
    expect(machine.publishedFrontier).toBe(published);
  });

  it('keeps the last published frontier when HEAD is unrelated', () => {
    let machine = idleGraphShareFrontier();
    const published = Effect.pipe('a', EffectString.repeat(40));
    machine = {
      ...machine,
      generation: 1,
      observedHead: published,
      phase: 'published',
      publishedFrontier: published,
    };
    const unrelated = Effect.pipe('f', EffectString.repeat(40));
    machine = observeCanonicalHead(machine, {
      commit: unrelated,
      isDescendantOfPublished: false,
      nowSeconds: 10,
    });
    expect(machine.publishedFrontier).toBe(published);
    expect(machine.generation).toBe(1);
    expect(machine.phase).toBe('published');
    expect(machine.pendingRange).toEqual([]);
    expect(machine.collectingStartedAtSeconds).toBeNull();
  });

  it('never opens a collection for a sequence of unrelated heads', () => {
    FC.assert(
      FC.property(hex(40), FC.array(hex(40), {minLength: 1, maxLength: 4}), (published, heads) => {
        FC.pre(EffectArray.every(heads, head => head !== published));
        let machine = idleGraphShareFrontier();
        machine = {...machine, generation: 3, phase: 'published', publishedFrontier: published};
        for (const head of heads) {
          machine = observeCanonicalHead(machine, {commit: head, isDescendantOfPublished: false, nowSeconds: 10});
          expect(machine.phase).toBe('published');
          expect(machine.publishedFrontier).toBe(published);
          expect(machine.generation).toBe(3);
          expect(machine.pendingRange).toEqual([]);
        }
      }),
      {numRuns: 30},
    );
  });

  it('late results cannot mutate a frozen generation', () => {
    FC.assert(
      FC.property(hex(40), hex(40), hex(64), (headB, headC, actionKey) => {
        FC.pre(headB !== headC);
        let machine = idleGraphShareFrontier();
        machine = observeCanonicalHead(machine, {commit: headB, isDescendantOfPublished: true, nowSeconds: 0});
        machine = freezeGraphShareBatch(machine, {
          actionKeys: [actionKey],
          changedBytes: 1,
          changedFiles: 1,
          nowSeconds: 1,
          thresholds: {maximumAgeSeconds: 0, maximumChangedBytes: 1, maximumChangedFiles: 1},
        });
        const frozenGeneration = machine.generation;
        const frozenBatch = machine.frozenBatchId;
        machine = observeCanonicalHead(machine, {commit: headC, isDescendantOfPublished: true, nowSeconds: 2});
        const late: GraphShareResultAnnouncementV1 = {
          actionKey,
          attestationDigest: digest('1'),
          batchId: headC,
          resultManifestDigest: digest('2'),
          semanticDigest: digest('3'),
        };
        const selected = selectGraphShareResultsForFrozenMachine(
          announceGraphShareResult(emptyGraphShareReceiptStore(), late).store,
          machine,
        );
        expect(selected.selected).toEqual([]);
        expect(machine.generation).toBe(frozenGeneration);
        expect(machine.frozenBatchId).toBe(frozenBatch);
      }),
      {numRuns: 20},
    );
  });

  it('publish is a monotonic generation chain', () => {
    FC.assert(
      FC.property(FC.integer({max: 5, min: 1}), publishes => {
        let machine = idleGraphShareFrontier();
        for (let index = 0; index < publishes; index += 1) {
          const commit = Effect.pipe(index.toString(16), EffectString.repeat(40), EffectString.slice(0, 40));
          machine = observeCanonicalHead(machine, {
            commit,
            isDescendantOfPublished: true,
            nowSeconds: index,
          });
          machine = freezeGraphShareBatch(machine, {
            actionKeys: [],
            changedBytes: 1,
            changedFiles: 1,
            nowSeconds: index + 1,
            thresholds: {maximumAgeSeconds: 0, maximumChangedBytes: 1, maximumChangedFiles: 1},
          });
          machine = assembleGraphShareBatch(machine);
          machine = verifyGraphShareBatch(machine);
          machine = publishGraphShareBatch(machine, digest(index.toString(16)));
        }
        expect(machine.generation).toBe(publishes);
      }),
      {numRuns: 15},
    );
  });

  it('coalesces collecting commits into one frozen batch', () => {
    let machine = idleGraphShareFrontier();
    machine = observeCanonicalHead(machine, {
      commit: Effect.pipe('1', EffectString.repeat(40)),
      isDescendantOfPublished: true,
      nowSeconds: 0,
    });
    machine = observeCanonicalHead(machine, {
      commit: Effect.pipe('2', EffectString.repeat(40)),
      isDescendantOfPublished: true,
      nowSeconds: 1,
    });
    machine = observeCanonicalHead(machine, {
      commit: Effect.pipe('3', EffectString.repeat(40)),
      isDescendantOfPublished: true,
      nowSeconds: 2,
    });
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [],
      changedBytes: 10,
      changedFiles: 3,
      nowSeconds: 2,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    expect(machine.phase).toBe('frozen');
    expect(machine.buildingFrontier).toBe(Effect.pipe('3', EffectString.repeat(40)));
    machine = assembleGraphShareBatch(machine);
    machine = verifyGraphShareBatch(machine);
    machine = publishGraphShareBatch(machine, digest('9'));
    expect(machine.generation).toBe(1);
    expect(machine.publishedFrontier).toBe(Effect.pipe('3', EffectString.repeat(40)));
  });
});

function receiptKey(announcement: GraphShareResultAnnouncementV1): string {
  return `${announcement.actionKey}:${announcement.resultManifestDigest}:${announcement.attestationDigest}:${announcement.semanticDigest}`;
}

function uniqueKeys(announcements: readonly GraphShareResultAnnouncementV1[]): string[] {
  return [...new Set(EffectArray.map(announcements, receiptKey))];
}

function announcementArb() {
  return FC.tuple(hex(64), hex(64), hex(40), hex(64), hex(64)).map(
    ([actionKey, attestation, batchId, result, semantic]) =>
      ({
        actionKey,
        attestationDigest: digestFromHex(attestation),
        batchId,
        resultManifestDigest: digestFromHex(result),
        semanticDigest: digestFromHex(semantic),
      }) satisfies GraphShareResultAnnouncementV1,
  );
}

function hex(length: number) {
  return FC.array(FC.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length}).map(characters =>
    EffectArray.join(characters, ''),
  );
}

function digestFromHex(value: string): Sha256Digest {
  return `sha256:${value}`;
}
