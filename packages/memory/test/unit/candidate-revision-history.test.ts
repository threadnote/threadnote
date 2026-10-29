import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {describe, expect, it} from 'vitest';
import {
  loadCandidateReview,
  parseCandidateReview,
  preserveCandidateReviewRevision,
  withCandidateReviewLock,
} from '@threadnote/memory/candidate';

function provideBun<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Layer.build(
      Layer.merge(
        BunServices.layer,
        SystemInfo.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildEnvironmentPolicy, {
                preserveIntendedChild: environment => environment,
                sanitizeExternal: environment => environment,
              }),
              Layer.succeed(RuntimeEntrypoint, {
                developmentEntrypoint: '/fixture/entrypoint',
              }),
            ),
          ),
        ),
      ),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}
const fixture = Effect.fn('candidateRevision.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({
    prefix: 'candidate-history-',
  });
  const file = path.join(home, 'threadnote/candidates/v1/reviews/review-history.json');
  const raw =
    JSON.stringify(
      {
        version: 2,
        reviewId: 'review-history',
        revision: 1,
        project: 'fixture',
        topic: 'History',
        task: 'Full previous revision',
        outcome: 'Retain an immutable previous candidate review.',
        sourceAgentClient: 'legacy-fixture',
        createdAt: '2026-10-25T00:00:00.000Z',
        codeCitations: [],
        auditEvents: [],
        candidates: [
          {
            candidateId: 'candidate-one',
            state: 'pending',
            categories: ['decision'],
            comparison: 'new',
            confidence: 1,
            evidence: ['legacy-review-fixture'],
            project: 'fixture',
            topic: 'History',
            proposedText: 'Exact fictional previous proposal.',
            reason: 'Preserve its complete private payload.',
            recommendation: 'create',
          },
        ],
      },
      undefined,
      4,
    ) + '\n\n';
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  yield* fs.writeFileString(file, raw, {mode: 0o600});
  const review = yield* loadCandidateReview(home, 'review-history');
  return {fs, path, home, file, raw, review};
});

describe('immutable candidate revision preimages', () => {
  effectIt.effect('refuses unsafe identities and linked history before any immutable payload can be replaced', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const unsafe = yield* preserveCandidateReviewRevision(f.home, {
        ...f.review,
        reviewId: '../outside',
      }).pipe(Effect.result);
      expect(Result.isFailure(unsafe)).toBe(true);
      const directory = f.path.join(f.home, 'threadnote/candidates/v1/revision-history');
      const outside = f.path.join(f.home, 'outside');
      yield* f.fs.makeDirectory(outside);
      yield* f.fs.symlink(outside, directory);
      const linked = yield* withCandidateReviewLock(
        f.home,
        f.review.reviewId,
        preserveCandidateReviewRevision(f.home, f.review),
      ).pipe(Effect.result);
      expect(Result.isFailure(linked)).toBe(true);
      expect(yield* f.fs.readDirectory(outside)).toEqual([]);
      expect(yield* f.fs.readFileString(f.file)).toBe(f.raw);
    }).pipe(provideBun),
  );

  effectIt.effect('preserves complete original bytes and replays without altering current or historical content', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const archive = yield* withCandidateReviewLock(
        f.home,
        f.review.reviewId,
        preserveCandidateReviewRevision(f.home, f.review),
      );
      expect(yield* f.fs.readFileString(archive)).toBe(f.raw);
      expect(yield* f.fs.readFileString(f.file)).toBe(f.raw);
      expect(
        yield* withCandidateReviewLock(f.home, f.review.reviewId, preserveCandidateReviewRevision(f.home, f.review)),
      ).toBe(archive);
      expect(yield* f.fs.readFileString(archive)).toBe(f.raw);
    }).pipe(provideBun),
  );

  effectIt.effect('refuses changed revisions and immutable-history collisions without overwriting either payload', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const archive = yield* withCandidateReviewLock(
        f.home,
        f.review.reviewId,
        preserveCandidateReviewRevision(f.home, f.review),
      );
      const newer = JSON.stringify({...f.review, revision: 2});
      yield* f.fs.writeFileString(f.file, newer);
      const stale = yield* withCandidateReviewLock(
        f.home,
        f.review.reviewId,
        preserveCandidateReviewRevision(f.home, f.review),
      ).pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      expect(yield* f.fs.readFileString(f.file)).toBe(newer);
      expect(yield* f.fs.readFileString(archive)).toBe(f.raw);
      yield* f.fs.writeFileString(f.file, f.raw);
      yield* f.fs.writeFileString(archive, 'Different existing history.');
      const collision = yield* withCandidateReviewLock(
        f.home,
        f.review.reviewId,
        preserveCandidateReviewRevision(f.home, f.review),
      ).pipe(Effect.result);
      expect(Result.isFailure(collision)).toBe(true);
      expect(yield* f.fs.readFileString(archive)).toBe('Different existing history.');
      expect(yield* f.fs.readFileString(f.file)).toBe(f.raw);
    }).pipe(provideBun),
  );
});

describe('legacy candidate review parsing', () => {
  it('accepts absent v2 metadata without inventing values and rejects absent v3 metadata', () => {
    const candidate = {
      candidateId: 'legacy-candidate',
      state: 'pending',
      categories: ['decision'],
      comparison: 'new',
      confidence: 1,
      proposedText: 'Legacy proposal.',
      reason: 'Persisted before candidate metadata became required.',
      recommendation: 'create',
    };
    const legacy = parseCandidateReview({
      version: 2,
      reviewId: 'legacy-review',
      revision: 1,
      project: 'fixture',
      topic: 'History',
      task: 'Read legacy review',
      createdAt: '2026-10-25T00:00:00.000Z',
      codeCitations: [],
      candidates: [candidate],
    });
    expect(legacy.outcome).toBeUndefined();
    expect(legacy.sourceAgentClient).toBeUndefined();
    expect(legacy.candidates[0]?.evidence).toBeUndefined();
    expect(() =>
      parseCandidateReview({
        ...legacy,
        version: 3,
        codeCitations: [],
        candidates: [
          {
            ...candidate,
            evidence: [],
            kind: 'durable',
            project: 'fixture',
            topic: 'History',
          },
        ],
      }),
    ).toThrow('unsupported review document');
  });
});
