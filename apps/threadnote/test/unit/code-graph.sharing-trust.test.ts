import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  casBlobPath,
  putCasBytes,
  putCasFile,
  readVerifiedCasBlob,
  readVerifiedCasBlobBounded,
  verifyCasBlob,
} from '@threadnote/graph/sharing/cas';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {graphSharingCasBlobPath} from '@threadnote/graph/sharing/layout';
import {
  lookupGraphShareTrustReceipt,
  isGraphShareAutoEnrollmentRevoked,
  removeGraphShareTrustReceipt,
  trustReceiptFromEnrollment,
  writeGraphShareTrustReceipt,
  type GraphShareTrustReceiptV1,
} from '@threadnote/graph/sharing/trust';
import {
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
} from '@threadnote/graph/sharing/profile';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const sharingLayer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

const profile = defaultGraphShareProfile({
  branch: 'refs/heads/main',
  canonicalRemote: 'github.com/acme/monorepo',
  organization: 'acme',
  publisherKeyFingerprint: `sha256:${Effect2.pipe('a', EffectString.repeat(64))}`,
  repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
});

describe('graph share trust and CAS', () => {
  effectIt.effect('round-trips digest-addressed blobs and join/leave receipts', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-trust-'});
      const casRoot = path.join(home, 'cas');
      const bytes = new TextEncoder().encode('checkpoint-bytes');
      const digest = yield* putCasBytes(casRoot, bytes);
      expect(digest).toBe(sha256Digest(bytes));
      expect(new TextDecoder().decode(yield* readVerifiedCasBlob(casRoot, digest))).toBe('checkpoint-bytes');
      expect(yield* verifyCasBlob(casRoot, digest)).toBe(
        graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(digest)),
      );
      const source = path.join(home, 'blob.bin');
      const fileBytes = new TextEncoder().encode('file-checkpoint-bytes');
      yield* fs.writeFile(source, fileBytes);
      const fileDigest = yield* putCasFile(casRoot, source);
      expect(fileDigest).toBe(sha256Digest(fileBytes));
      expect(new TextDecoder().decode(yield* readVerifiedCasBlob(casRoot, fileDigest))).toBe('file-checkpoint-bytes');
      expect(yield* putCasFile(casRoot, source)).toBe(fileDigest);
      const enrollment = parseGraphShareEnrollment({
        profile: casProfilePointer(graphShareProfileDigest(profile)),
        publisherKeyFingerprint: profile.trust.publisherKeys[0],
        repositoryId: profile.repositoryId,
        schemaVersion: 1,
      });
      const readOnly = trustReceiptFromEnrollment(enrollment, profile, graphShareProfileDigest(profile), 'read-only');
      yield* writeGraphShareTrustReceipt(home, readOnly);
      expect((yield* lookupGraphShareTrustReceipt(home, profile.repositoryId))?.accessMode).toBe('read-only');
      yield* writeGraphShareTrustReceipt(
        home,
        trustReceiptFromEnrollment(enrollment, profile, graphShareProfileDigest(profile), 'join'),
      );
      expect((yield* lookupGraphShareTrustReceipt(home, profile.repositoryId))?.accessMode).toBe('join');
      yield* removeGraphShareTrustReceipt(home, profile.repositoryId);
      expect(yield* lookupGraphShareTrustReceipt(home, profile.repositoryId)).toBeUndefined();
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('fail-closes verifyCasBlob when the stored object is mutated', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-cas-mutate-'});
      const casRoot = path.join(home, 'cas');
      const bytes = new TextEncoder().encode('checkpoint-bytes');
      const digest = yield* putCasBytes(casRoot, bytes);
      yield* fs.writeFile(yield* verifyCasBlob(casRoot, digest), new TextEncoder().encode('mutated-checkpoint'));
      const result = yield* verifyCasBlob(casRoot, digest).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('bounds signed-result CAS reads before accepting bytes or a digest', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-cas-bounded-'});
      const casRoot = path.join(home, 'cas');
      const bytes = new TextEncoder().encode('signed-result');
      const digest = yield* putCasBytes(casRoot, bytes);
      expect(Array.from(yield* readVerifiedCasBlobBounded(casRoot, digest, bytes.byteLength))).toEqual([...bytes]);
      expect(
        Result.isFailure(yield* Effect.result(readVerifiedCasBlobBounded(casRoot, digest, bytes.byteLength - 1))),
      ).toBe(true);
      yield* fs.writeFile(yield* casBlobPath(casRoot, digest), new TextEncoder().encode('forged-result'));
      expect(Result.isFailure(yield* Effect.result(readVerifiedCasBlobBounded(casRoot, digest, 32)))).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('does not drop another repository receipt when write and remove race', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-trust-lock-'});
        const first = receiptFor(Effect2.pipe('b', EffectString.repeat(64)), 'read-only');
        const second = receiptFor(Effect2.pipe('c', EffectString.repeat(64)), 'join');
        const third = receiptFor(Effect2.pipe('d', EffectString.repeat(64)), 'join');
        yield* writeGraphShareTrustReceipt(home, first);
        yield* writeGraphShareTrustReceipt(home, second);
        yield* Effect.all(
          [
            writeGraphShareTrustReceipt(home, {...first, accessMode: 'join'}),
            removeGraphShareTrustReceipt(home, second.repositoryId),
            writeGraphShareTrustReceipt(home, third),
          ],
          {concurrency: 'unbounded'},
        );
        expect((yield* lookupGraphShareTrustReceipt(home, first.repositoryId))?.accessMode).toBe('join');
        expect(yield* lookupGraphShareTrustReceipt(home, second.repositoryId)).toBeUndefined();
        expect((yield* lookupGraphShareTrustReceipt(home, third.repositoryId))?.accessMode).toBe('join');
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'auto-enrollment revocation follows the latest explicit transition per repository',
    {
      operations: FC.array(
        FC.record({
          repository: FC.constantFrom(0, 1),
          transition: FC.constantFrom('leave' as const, 'join' as const),
        }),
        {minLength: 1, maxLength: 6},
      ),
    },
    ({operations}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-auto-revocation-'});
          const ids = [Effect2.pipe('b', EffectString.repeat(64)), Effect2.pipe('c', EffectString.repeat(64))] as const;
          const revoked = new Set<string>();
          for (const {repository, transition} of operations) {
            const id = ids[repository];
            if (transition === 'leave') {
              yield* removeGraphShareTrustReceipt(home, id, {revokeAutomatic: true});
              revoked.add(id);
            } else {
              yield* writeGraphShareTrustReceipt(home, receiptFor(id, 'read-only'), {
                clearAutoEnrollmentRevocation: true,
              });
              revoked.delete(id);
            }
            for (const observed of ids) {
              expect(yield* isGraphShareAutoEnrollmentRevoked(home, observed)).toBe(revoked.has(observed));
            }
          }
        }).pipe(provideTestLayer(sharingLayer)),
      ),
    {fastCheck: {numRuns: 12}},
  );
});

function receiptFor(
  repositoryId: string,
  accessMode: GraphShareTrustReceiptV1['accessMode'],
): GraphShareTrustReceiptV1 {
  const enrollment = parseGraphShareEnrollment({
    profile: casProfilePointer(graphShareProfileDigest(profile)),
    publisherKeyFingerprint: profile.trust.publisherKeys[0],
    repositoryId,
    schemaVersion: 1,
  });
  return trustReceiptFromEnrollment(
    enrollment,
    {...profile, repositoryId},
    graphShareProfileDigest(profile),
    accessMode,
  );
}
