import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  generateGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from '@threadnote/graph/sharing/artifacts';
import {putCasBytes, casBlobPath} from '@threadnote/graph/sharing/cas';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphSharingFailure} from '@threadnote/graph/sharing/errors';
import {
  acceptGraphShareFrontier,
  assertGraphSharePredecessor,
  graphShareAcceptedFrontierPath,
  readAcceptedGraphShareFrontier,
} from '@threadnote/graph/sharing/frontier_acceptance';
import {
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
  casProfilePointer,
} from '@threadnote/graph/sharing/profile';
import {
  trustReceiptFromEnrollment,
  writeGraphShareTrustReceipt,
  removeGraphShareTrustReceipt,
} from '@threadnote/graph/sharing/trust';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));
const fixture = Effect.fn('test.frontierAcceptance.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-frontier-acceptance-'});
  const casRoot = path.join(home, 'cas');
  const key = yield* generateGraphSharePublisherKey();
  const profile = defaultGraphShareProfile({
    branch: 'refs/heads/main',
    canonicalRemote: 'github.com/acme/example',
    organization: 'acme',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  });
  const profileDigest = graphShareProfileDigest(profile);
  const enrollment = parseGraphShareEnrollment({
    profile: casProfilePointer(profileDigest),
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: profile.repositoryId,
    schemaVersion: 1,
  });
  yield* writeGraphShareTrustReceipt(home, trustReceiptFromEnrollment(enrollment, profile, profileDigest, 'read-only'));
  const scope = {
    branch: profile.source.branches[0],
    profileDigest,
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: profile.repositoryId,
  };
  const candidate = Effect.fn('test.frontierAcceptance.candidate')(function* (
    generation: number,
    fence = 1,
    overrides: Partial<GraphShareFrontierManifestV1> = {},
  ) {
    const manifest: GraphShareFrontierManifestV1 = {
      branch: scope.branch,
      checkpoint: {
        manifestDigest: sha256Digest('checkpoint'),
        snapshotId: 'cgsn_fixture',
        sourceCommit: Effect2.pipe('b', EffectString.repeat(40)),
      },
      deltas: [],
      generation,
      graphAbi: Effect2.pipe('c', EffectString.repeat(64)),
      graphContentId: 'cgc_' + Effect2.pipe('d', EffectString.repeat(40)),
      logicalGraphDigest: sha256Digest('graph'),
      previousManifestDigest: generation === 1 ? null : sha256Digest('previous'),
      profileDigest,
      publisherFence: fence,
      repositoryId: scope.repositoryId,
      schemaVersion: 1,
      snapshotId: 'cgsn_fixture',
      sourceCommit: Effect2.pipe('b', EffectString.repeat(40)),
      ...overrides,
    };
    const signed = yield* signGraphShareFrontier(key, manifest);
    const manifestDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(manifest)));
    const envelopeDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(signed.envelope)));
    return {manifest, pointer: {manifestDigest, envelopeDigest, schemaVersion: 1 as const}};
  });
  return {fs, home, casRoot, scope, candidate, target: yield* graphShareAcceptedFrontierPath(home, scope)};
});

describe('authenticated frontier acceptance', () => {
  effectIt.effect(
    'rejects rollback, equivocation, wrong scope and bad signatures without changing the accepted pointer',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const baseline = yield* f.candidate(4, 3);
        const input = {casRoot: f.casRoot, home: f.home, scope: f.scope};
        const accepted = yield* acceptGraphShareFrontier({...input, pointer: baseline.pointer});
        const before = yield* f.fs.readFileString(f.target);
        const candidates = [
          yield* f.candidate(3, 3),
          yield* f.candidate(5, 2),
          yield* f.candidate(4, 3, {logicalGraphDigest: sha256Digest('different graph')}),
          yield* f.candidate(5, 3, {branch: 'refs/heads/unrelated'}),
          yield* f.candidate(5, 3, {profileDigest: sha256Digest('different profile')}),
          yield* f.candidate(5, 3, {repositoryId: Effect2.pipe('e', EffectString.repeat(64))}),
        ];
        const unsigned = yield* f.candidate(5, 3);
        candidates.push({...unsigned, pointer: {...unsigned.pointer, envelopeDigest: baseline.pointer.envelopeDigest}});
        for (const candidate of candidates) {
          expect(
            Result.isFailure(
              yield* acceptGraphShareFrontier({...input, pointer: candidate.pointer}).pipe(Effect.result),
            ),
          ).toBe(true);
          expect(yield* f.fs.readFileString(f.target)).toBe(before);
        }
        expect(yield* acceptGraphShareFrontier({...input, pointer: baseline.pointer})).toEqual(accepted);
        expect(
          (yield* acceptGraphShareFrontier({...input, pointer: (yield* f.candidate(6, 3)).pointer})).generation,
        ).toBe(6);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps an intact watermark when its cached payload is missing and ignores a stale legacy seed', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = {casRoot: f.casRoot, home: f.home, scope: f.scope};
      const newest = yield* f.candidate(10, 3);
      yield* acceptGraphShareFrontier({...input, pointer: newest.pointer});
      yield* f.fs.remove(yield* casBlobPath(f.casRoot, newest.pointer.manifestDigest));
      const older = yield* f.candidate(5, 2);
      expect((yield* acceptGraphShareFrontier({...input, legacy: true, pointer: older.pointer})).generation).toBe(10);
      expect(
        Result.isFailure(yield* acceptGraphShareFrontier({...input, pointer: older.pointer}).pipe(Effect.result)),
      ).toBe(true);
      expect((yield* readAcceptedGraphShareFrontier(f.home, f.scope))?.generation).toBe(10);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('serializes competing sessions so a slow candidate cannot replace a higher generation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const input = {casRoot: f.casRoot, home: f.home, scope: f.scope};
        const candidates = yield* Effect.forEach([2, 7, 3, 6, 4, 5, 1, 8], generation => f.candidate(generation));
        yield* Effect.forEach(
          candidates,
          candidate => acceptGraphShareFrontier({...input, pointer: candidate.pointer}).pipe(Effect.result),
          {concurrency: 8},
        );
        expect((yield* readAcceptedGraphShareFrontier(f.home, f.scope))?.generation).toBe(8);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('denies acceptance after trust removal and on a failed persistence commit', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = {casRoot: f.casRoot, home: f.home, scope: f.scope, pointer: (yield* f.candidate(1)).pointer};
      const failing = {
        ...f.fs,
        rename: (from: string, to: string) =>
          to === f.target ? graphSharingFailure('Synthetic persistence failure.') : f.fs.rename(from, to),
      };
      expect(
        Result.isFailure(
          yield* acceptGraphShareFrontier(input).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
            Effect.result,
          ),
        ),
      ).toBe(true);
      expect(yield* f.fs.exists(f.target)).toBe(false);
      yield* removeGraphShareTrustReceipt(f.home, f.scope.repositoryId);
      expect(Result.isFailure(yield* acceptGraphShareFrontier(input).pipe(Effect.result))).toBe(true);
      expect(yield* f.fs.exists(f.target)).toBe(false);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('does not reset corrupt or oversized accepted state', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = {casRoot: f.casRoot, home: f.home, scope: f.scope, pointer: (yield* f.candidate(1)).pointer};
      yield* acceptGraphShareFrontier(input);
      for (const invalid of ['{invalid', Effect2.pipe('x', EffectString.repeat(4097))]) {
        yield* f.fs.writeFileString(f.target, invalid);
        expect(Result.isFailure(yield* acceptGraphShareFrontier(input).pipe(Effect.result))).toBe(true);
        expect(yield* f.fs.readFileString(f.target)).toBe(invalid);
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rechecks trust after reading state inside the acceptance lease', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = {casRoot: f.casRoot, home: f.home, scope: f.scope};
      yield* acceptGraphShareFrontier({...input, pointer: (yield* f.candidate(1)).pointer});
      const before = yield* f.fs.readFileString(f.target);
      const revoking = {
        ...f.fs,
        exists: (target: string) =>
          target === f.target
            ? removeGraphShareTrustReceipt(f.home, f.scope.repositoryId).pipe(Effect.andThen(f.fs.exists(target)))
            : f.fs.exists(target),
      };
      const result = yield* acceptGraphShareFrontier({...input, pointer: (yield* f.candidate(2)).pointer}).pipe(
        Effect.provideService(FileSystem.FileSystem, revoking),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* f.fs.readFileString(f.target)).toBe(before);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('allows only decreasing in-scope predecessor metadata', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const older = yield* f.candidate(1);
      const newer = yield* f.candidate(2, 2, {previousManifestDigest: older.pointer.manifestDigest});
      expect(() => assertGraphSharePredecessor(newer.manifest, older.manifest)).not.toThrow();
      for (const change of [
        {branch: 'refs/heads/other'},
        {profileDigest: sha256Digest('other')},
        {repositoryId: Effect2.pipe('f', EffectString.repeat(64))},
        {generation: 2},
        {publisherFence: 3},
      ]) {
        expect(() => assertGraphSharePredecessor(newer.manifest, {...older.manifest, ...change})).toThrow();
      }
    }).pipe(provideTestLayer(layer)),
  );

  fcEffectProp(
    effectIt,
    'accepted generation and fence never decrease and denied transitions leave state unchanged',
    {
      candidates: FC.array(FC.tuple(FC.integer({min: 1, max: 8}), FC.integer({min: 1, max: 4})), {
        minLength: 1,
        maxLength: 12,
      }),
    },
    ({candidates}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let generation = 0;
        let fence = 0;
        let body: string | undefined;
        for (const [nextGeneration, nextFence] of candidates) {
          const candidate = yield* f.candidate(nextGeneration, nextFence);
          const allowed =
            (nextGeneration > generation && nextFence >= fence) ||
            (nextGeneration === generation && nextFence === fence);
          const result = yield* acceptGraphShareFrontier({
            casRoot: f.casRoot,
            home: f.home,
            scope: f.scope,
            pointer: candidate.pointer,
          }).pipe(Effect.result);
          expect(Result.isSuccess(result)).toBe(allowed);
          const after = yield* f.fs.readFileString(f.target);
          if (allowed) {
            generation = nextGeneration;
            fence = nextFence;
            body = after;
          } else expect(after).toBe(body);
          const current = yield* readAcceptedGraphShareFrontier(f.home, f.scope);
          expect(current?.generation).toBe(generation);
          expect(current?.publisherFence).toBe(fence);
        }
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 30}},
  );
});
