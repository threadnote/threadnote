import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {saveTopicGenerationReceipt, loadTopicGenerationReceipt} from '@threadnote/memory/candidate-generation';
import {
  MAX_TOPIC_GENERATION_RECEIPTS,
  TOPIC_GENERATION_RETENTION_MILLISECONDS,
  type TopicGenerationReceiptV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const receipt = (ordinal: number): TopicGenerationReceiptV1 => ({
  version: 1,
  receiptId: 'topic-generation-' + Effect2.pipe(ordinal.toString(16), EffectString.padStart(32, '0')),
  caseId: 'health-case-' + Effect2.pipe('a', EffectString.repeat(40)),
  reviewId: 'review-' + Effect2.pipe('b', EffectString.repeat(24)),
  targetHash: Effect2.pipe('c', EffectString.repeat(64)),
  observationRevision: Effect2.pipe('d', EffectString.repeat(64)),
  packetDigest: Effect2.pipe('e', EffectString.repeat(64)),
  agent: 'local-ai',
  model: 'fixture',
  promptVersion: 'v5',
  state: 'failed',
  phase: 'generation',
  elapsedMilliseconds: 0,
  promptScope: 'user-prompt-utf8-sha256',
  attempts: [],
  createdAtMilliseconds: 0,
});

describe('private generation receipt storage', () => {
  effectIt.layer(Layer.merge(BunServices.layer, TestSystemInfoLayer))(it => {
    it.effect('enforces capacity, expiry and orphan temporary cleanup without touching candidate reviews', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(home, 'threadnote/candidates/v1/topic-generation');
        yield* fs.makeDirectory(directory, {recursive: true});
        for (let ordinal = 0; ordinal <= MAX_TOPIC_GENERATION_RECEIPTS; ordinal++) {
          const entry = receipt(ordinal);
          const file = path.join(directory, entry.receiptId + '.json');
          yield* fs.writeFileString(file, JSON.stringify(entry));
          yield* fs.utimes(file, ordinal, ordinal);
        }
        const orphan = path.join(directory, receipt(1000).receiptId + '.json.12345678-1234-1234-1234-123456789abc.tmp');
        yield* fs.writeFileString(orphan, 'private staged output');
        const current = receipt(1001);
        yield* saveTopicGenerationReceipt(home, current);
        expect(
          EffectArray.filter(
            yield* fs.readDirectory(directory),
            __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
          ),
        ).toHaveLength(MAX_TOPIC_GENERATION_RECEIPTS);
        expect(yield* fs.exists(orphan)).toBe(false);
        expect(yield* fs.exists(path.join(directory, receipt(0).receiptId + '.json'))).toBe(false);
        expect(yield* fs.exists(path.join(home, 'threadnote/candidates/v1/reviews'))).toBe(false);
        expect((yield* loadTopicGenerationReceipt(home, current.receiptId)).receiptId).toBe(current.receiptId);
        const file = path.join(directory, current.receiptId + '.json');
        yield* fs.utimes(file, 0, 0);
        yield* TestClock.adjust(TOPIC_GENERATION_RETENTION_MILLISECONDS + 1);
        expect(yield* Clock.currentTimeMillis).toBeGreaterThan(TOPIC_GENERATION_RETENTION_MILLISECONDS);
        const expired = yield* loadTopicGenerationReceipt(home, current.receiptId).pipe(Effect.flip);
        expect(expired.message).toContain('expired');
      }),
    );
    it.effect('rejects private-schema extras, oversized receipts and traversal IDs', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const extra = yield* saveTopicGenerationReceipt(home, {
          ...receipt(1),
          // @ts-expect-error This schema rejection fixture deliberately adds a private field.
          apiKey: 'private key',
        }).pipe(Effect.flip);
        expect(extra.message).not.toContain('private key');
        const oversized = yield* saveTopicGenerationReceipt(home, {
          ...receipt(2),
          model: Effect2.pipe('x', EffectString.repeat(256 * 1024)),
        }).pipe(Effect.flip);
        expect(oversized.message).toContain('could not be saved');
        const invalid = yield* loadTopicGenerationReceipt(home, '../reviews/fixture').pipe(Effect.flip);
        expect(invalid.message).toContain('unavailable');
      }),
    );
  });
});
