import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it, it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import * as FC from 'fast-check';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  generateGraphSharePublisherKey,
  graphShareFrontierCanonicalBytes,
  parseGraphShareFrontierManifest,
  signGraphShareFrontier,
  verifyGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from '@threadnote/graph/sharing/artifacts';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const MANIFEST: GraphShareFrontierManifestV1 = {
  branch: 'refs/heads/main',
  checkpoint: {
    manifestDigest: `sha256:${Effect2.pipe('1', EffectString.repeat(64))}`,
    snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
  },
  deltas: [],
  generation: 1,
  graphAbi: Effect2.pipe('c', EffectString.repeat(64)),
  graphContentId: 'cgc_' + Effect2.pipe('d', EffectString.repeat(40)),
  logicalGraphDigest: `sha256:${Effect2.pipe('2', EffectString.repeat(64))}`,
  previousManifestDigest: null,
  profileDigest: `sha256:${Effect2.pipe('3', EffectString.repeat(64))}`,
  publisherFence: 1,
  repositoryId: Effect2.pipe('e', EffectString.repeat(64)),
  schemaVersion: 1,
  snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
};

const HEX = '0123456789abcdef';

describe('graph share frontier signatures', () => {
  effectIt.effect('signs generation-one frontiers and fail-closes on tamper', () =>
    Effect.gen(function* () {
      const key = yield* generateGraphSharePublisherKey();
      const signed = yield* signGraphShareFrontier(key, MANIFEST);
      expect(signed.payloadDigest).toBe(sha256Digest(graphShareFrontierCanonicalBytes(MANIFEST)));
      yield* verifyGraphShareFrontier(key.fingerprint, MANIFEST, signed.envelope);
      const parsed = parseGraphShareFrontierManifest({...MANIFEST, deltas: []});
      yield* verifyGraphShareFrontier(key.fingerprint, parsed, signed.envelope);
      const tampered = {...MANIFEST, sourceCommit: Effect2.pipe('b', EffectString.repeat(40))};
      const result = yield* verifyGraphShareFrontier(key.fingerprint, tampered, signed.envelope).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it('rejects revspec sourceCommit and a mismatched checkpoint sourceCommit', () => {
    expect(() =>
      parseGraphShareFrontierManifest({
        ...MANIFEST,
        checkpoint: {...MANIFEST.checkpoint, sourceCommit: 'HEAD'},
        sourceCommit: 'HEAD',
      }),
    ).toThrow(/object id/i);
    expect(() =>
      parseGraphShareFrontierManifest({...MANIFEST, sourceCommit: Effect2.pipe('b', EffectString.repeat(40))}),
    ).toThrow(/must match/i);
    const withDelta = {
      ...MANIFEST,
      deltas: [
        {
          baseSnapshotId: MANIFEST.checkpoint.snapshotId,
          manifestDigest: `sha256:${Effect2.pipe('4', EffectString.repeat(64))}`,
          targetCommit: Effect2.pipe('b', EffectString.repeat(40)),
          targetSnapshotId: 'cgsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
      snapshotId: 'cgsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sourceCommit: Effect2.pipe('b', EffectString.repeat(40)),
    };
    expect(parseGraphShareFrontierManifest(withDelta)).toEqual(withDelta);
    expect(() => parseGraphShareFrontierManifest({...withDelta, extra: true})).toThrow(/unsupported/i);
    expect(() =>
      parseGraphShareFrontierManifest({
        ...withDelta,
        deltas: [{...withDelta.deltas[0], extra: true}],
      }),
    ).toThrow(/unsupported/i);
  });

  effectIt.effect('fail-closes when the expected publisher fingerprint does not match', () =>
    Effect.gen(function* () {
      const key = yield* generateGraphSharePublisherKey();
      const signed = yield* signGraphShareFrontier(key, MANIFEST);
      const result = yield* verifyGraphShareFrontier(
        `sha256:${Effect2.pipe('0', EffectString.repeat(64))}`,
        MANIFEST,
        signed.envelope,
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(parseGraphShareFrontierManifest(JSON.parse(canonicalJson(MANIFEST)) as unknown)).toEqual(MANIFEST);
      yield* verifyGraphShareFrontier(key.fingerprint, MANIFEST, signed.envelope);
    }),
  );

  fcEffectProp(
    effectIt,
    'signed frontiers round-trip canonical JSON and fail closed on payload tamper',
    {
      sourceCommit: FC.array(FC.constantFrom(...HEX), {maxLength: 40, minLength: 40}).map(characters =>
        EffectArray.join(characters, ''),
      ),
    },
    ({sourceCommit}) =>
      Effect.gen(function* () {
        const manifest: GraphShareFrontierManifestV1 = {
          ...MANIFEST,
          checkpoint: {...MANIFEST.checkpoint, sourceCommit},
          sourceCommit,
        };
        const parsed = parseGraphShareFrontierManifest(JSON.parse(canonicalJson(manifest)) as unknown);
        expect(parsed).toEqual(manifest);
        const key = yield* generateGraphSharePublisherKey();
        const signed = yield* signGraphShareFrontier(key, parsed);
        yield* verifyGraphShareFrontier(key.fingerprint, parsed, signed.envelope);
        const tampered = {
          ...parsed,
          sourceCommit:
            sourceCommit === Effect2.pipe('a', EffectString.repeat(40))
              ? Effect2.pipe('b', EffectString.repeat(40))
              : Effect2.pipe('a', EffectString.repeat(40)),
        };
        const result = yield* verifyGraphShareFrontier(key.fingerprint, tampered, signed.envelope).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
      }),
    {fastCheck: {numRuns: 16}},
  );
});
