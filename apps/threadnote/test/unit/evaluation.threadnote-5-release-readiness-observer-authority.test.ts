import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {createHash} from '@threadnote/testing/node-crypto';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {promisify} from '@threadnote/testing/node-util';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {
  previewThreadnote5ReviewedAuthorityManifestV1,
  reviewedAuthorityBundleArtifact,
  parseThreadnote5ReviewedAuthorityBundleV1,
  THREADNOTE_5_OBSERVER_AUTHORITY_COVERAGE,
  threadnote5PrivateObserverArtifactDigest,
  verifyThreadnote5ReviewedAuthorityManifestV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-observer-authority';
import {
  parseThreadnote5LocalAuthorityManifestV1,
  threadnote5LocalAuthorityManifestHash,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-authority';
import {
  PRODUCTION_CAPTURE_CANDIDATE,
  productionCaptureFixture,
} from '../helpers/threadnote-5-production-capture-fixture.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function execOutput(error: unknown): string {
  if (!Predicate.isObject(error)) return '';
  return String(error.stderr || error.stdout || '');
}

describe('Threadnote 5 independent observer authority', () => {
  effectIt.effect('replays native sources and seals content-free proof binding', () =>
    Effect.sync(() => {
      const fixture = productionCaptureFixture();
      const reviews = reviewEnvelope();
      const preview = previewThreadnote5ReviewedAuthorityManifestV1({
        candidate: PRODUCTION_CAPTURE_CANDIDATE,
        retainedRecords: fixture.records,
        reviews,
      });
      expect(THREADNOTE_5_OBSERVER_AUTHORITY_COVERAGE).toHaveLength(15);
      expect(preview.manifest).toEqual(parseThreadnote5LocalAuthorityManifestV1(fixture.authorityManifest));
      expect(preview.manifestHash).toBe(threadnote5LocalAuthorityManifestHash(preview.manifest));
      expect(preview.reviewArtifactSetHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(preview.bindingHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(preview)).not.toContain('reviewerIdHash');
      expect(
        verifyThreadnote5ReviewedAuthorityManifestV1({
          bundle: reviewedAuthorityBundleArtifact(preview),
          candidate: PRODUCTION_CAPTURE_CANDIDATE,
          expectedBindingSha256: preview.bindingHash,
          expectedManifestSha256: preview.manifestHash,
          expectedReviewArtifactSetSha256: preview.reviewArtifactSetHash,
          retainedRecords: fixture.records,
          reviews,
        }),
      ).toEqual(preview);
    }),
  );

  effectIt.effect('is invariant under retained and private-artifact ordering', () =>
    Effect.sync(() => {
      const fixture = productionCaptureFixture();
      const reviews = reviewEnvelope();
      const expected = previewThreadnote5ReviewedAuthorityManifestV1({
        candidate: PRODUCTION_CAPTURE_CANDIDATE,
        retainedRecords: fixture.records,
        reviews,
      });
      fc.assert(
        fc.property(
          fc.shuffledSubarray([...fixture.records], {
            minLength: fixture.records.length,
            maxLength: fixture.records.length,
          }),
          fc.shuffledSubarray([...reviews.artifacts], {
            minLength: reviews.artifacts.length,
            maxLength: reviews.artifacts.length,
          }),
          (retainedRecords, artifacts) => {
            const actual = previewThreadnote5ReviewedAuthorityManifestV1({
              candidate: PRODUCTION_CAPTURE_CANDIDATE,
              retainedRecords,
              reviews: {...reviews, artifacts},
            });
            expect(actual.manifestHash).toBe(expected.manifestHash);
            expect(actual.reviewArtifactSetHash).toBe(expected.reviewArtifactSetHash);
            expect(actual.bindingHash).toBe(expected.bindingHash);
          },
        ),
        {numRuns: 5},
      );
    }),
  );

  effectIt.effect('rejects oversized retained data and review cardinality before per-item digest work', () =>
    Effect.sync(() => {
      const fixture = productionCaptureFixture();
      const reviews = reviewEnvelope();
      expect(() =>
        previewThreadnote5ReviewedAuthorityManifestV1({
          candidate: PRODUCTION_CAPTURE_CANDIDATE,
          retainedRecords: [
            {
              ...fixture.records[0],
              artifact: {padding: Effect2.pipe('x', EffectString.repeat(8 * 1024 * 1024))},
              digest: 'not-a-hash',
            },
          ],
          reviews,
        }),
      ).toThrow(/encoded byte budget/u);
      expect(() =>
        previewThreadnote5ReviewedAuthorityManifestV1({
          candidate: PRODUCTION_CAPTURE_CANDIDATE,
          retainedRecords: fixture.records,
          reviews: {
            ...reviews,
            artifacts: [...reviews.artifacts, {...reviews.artifacts[0], artifactDigest: 'not-a-hash'}],
          },
        }),
      ).toThrow(/exactly 15 artifacts/u);
    }),
  );

  effectIt.effect(
    'fails closed for proof mutation, source digest mutation, runtime race, extra rows, and unpinned binding',
    () =>
      Effect.sync(() => {
        const fixture = productionCaptureFixture();
        const reviews = reviewEnvelope();
        const preview = previewThreadnote5ReviewedAuthorityManifestV1({
          candidate: PRODUCTION_CAPTURE_CANDIDATE,
          retainedRecords: fixture.records,
          reviews,
        });
        const first = reviews.artifacts[0];
        expect(() =>
          previewThreadnote5ReviewedAuthorityManifestV1({
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            retainedRecords: fixture.records,
            reviews: {
              ...reviews,
              artifacts: [
                {...first, artifact: {...first.artifact, observedAt: '2026-01-02T00:00:00.000Z'}},
                ...reviews.artifacts.slice(1),
              ],
            },
          }),
        ).toThrow(/digest/u);
        expect(() =>
          previewThreadnote5ReviewedAuthorityManifestV1({
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            retainedRecords: EffectArray.map(fixture.records, (record, index) =>
              index === 0 ? {...record, digest: Effect2.pipe('f', EffectString.repeat(64))} : record,
            ),
            reviews,
          }),
        ).toThrow(/digest/u);
        const unsupportedRecordInput = {...fixture.records[0], version: 2};
        const {digest: _validDigest, ...unsupportedRecordWithoutDigest} = unsupportedRecordInput;
        const unsupportedRecord = {
          ...unsupportedRecordWithoutDigest,
          digest: createHash('sha256')
            .update(`threadnote-5-local-subsystem-receipt-v1\0${canonicalJson(unsupportedRecordWithoutDigest)}`)
            .digest('hex'),
        };
        expect(() =>
          previewThreadnote5ReviewedAuthorityManifestV1({
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            retainedRecords: [unsupportedRecord, ...fixture.records.slice(1)],
            reviews,
          }),
        ).toThrow(/unsupported/u);
        const unsupported = {...first.artifact, version: 2};
        expect(() =>
          previewThreadnote5ReviewedAuthorityManifestV1({
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            retainedRecords: fixture.records,
            reviews: {
              ...reviews,
              artifacts: [
                {
                  ...first,
                  artifact: unsupported,
                  artifactDigest: threadnote5PrivateObserverArtifactDigest(unsupported),
                },
                ...reviews.artifacts.slice(1),
              ],
            },
          }),
        ).toThrow(/version/u);
        expect(() =>
          previewThreadnote5ReviewedAuthorityManifestV1({
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            retainedRecords: [...fixture.records, fixture.records[0]],
            reviews,
          }),
        ).toThrow(/duplicated|extra|incomplete/u);
        expect(() =>
          previewThreadnote5ReviewedAuthorityManifestV1({
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            retainedRecords: fixture.records,
            reviews: {
              ...reviews,
              artifacts: EffectArray.map(reviews.artifacts, (row, index) =>
                index === 0
                  ? {
                      ...row,
                      artifact: {
                        ...row.artifact,
                        runtime: {
                          ...row.artifact.runtime,
                          post: {
                            ...PRODUCTION_CAPTURE_CANDIDATE,
                            executableSha256: Effect2.pipe('f', EffectString.repeat(64)),
                          },
                        },
                      },
                      artifactDigest: row.artifactDigest,
                    }
                  : row,
              ),
            },
          }),
        ).toThrow(/runtime boundary|digest/u);
        expect(() =>
          verifyThreadnote5ReviewedAuthorityManifestV1({
            bundle: reviewedAuthorityBundleArtifact(preview),
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            expectedBindingSha256: Effect2.pipe('f', EffectString.repeat(64)),
            expectedManifestSha256: preview.manifestHash,
            expectedReviewArtifactSetSha256: preview.reviewArtifactSetHash,
            retainedRecords: fixture.records,
            reviews,
          }),
        ).toThrow(/independently supplied/u);
        const bundle = reviewedAuthorityBundleArtifact(preview);
        expect(() =>
          verifyThreadnote5ReviewedAuthorityManifestV1({
            bundle: {...bundle, manifest: {...bundle.manifest, entries: bundle.manifest.entries.slice(1)}},
            candidate: PRODUCTION_CAPTURE_CANDIDATE,
            expectedBindingSha256: preview.bindingHash,
            expectedManifestSha256: preview.manifestHash,
            expectedReviewArtifactSetSha256: preview.reviewArtifactSetHash,
            retainedRecords: fixture.records,
            reviews,
          }),
        ).toThrow(/bundle/u);
      }),
  );
});

const execFilePromise = promisify(execFile);

describe('observer authority command boundary', () => {
  it('assembles one stdout bundle and verifies it into a raw legacy manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-observer-authority-'));
    try {
      const fixture = productionCaptureFixture();
      const reviews = reviewEnvelope();
      const candidatePath = join(directory, 'candidate.json');
      const recordsPath = join(directory, 'records.json');
      const reviewsPath = join(directory, 'reviews.json');
      const bundlePath = join(directory, 'reviewed-bundle.json');
      const inputFiles: readonly [string, unknown][] = [
        [candidatePath, PRODUCTION_CAPTURE_CANDIDATE],
        [recordsPath, fixture.records],
        [reviewsPath, reviews],
      ];
      await Promise.all(EffectArray.map(inputFiles, ([path, value]) => writeFile(path, JSON.stringify(value))));
      const assembled = await execFilePromise(
        process.execPath,
        [
          'scripts/assemble-threadnote-5-observer-authority.ts',
          '--assemble',
          '--candidate',
          candidatePath,
          '--retained-records',
          recordsPath,
          '--reviews',
          reviewsPath,
        ],
        {cwd: process.cwd()},
      );
      const bundle: unknown = JSON.parse(assembled.stdout);
      const parsedBundle = parseThreadnote5ReviewedAuthorityBundleV1(bundle);
      expect(assembled.stderr).toBe('');
      expect(parseThreadnote5LocalAuthorityManifestV1(parsedBundle.manifest)).toEqual(
        parseThreadnote5LocalAuthorityManifestV1(fixture.authorityManifest),
      );
      expect(parsedBundle.binding).toEqual(
        expect.objectContaining({
          manifestHash: threadnote5LocalAuthorityManifestHash(parsedBundle.manifest),
          version: 1,
        }),
      );
      expect(EffectRecord.keys(parsedBundle).sort()).toEqual(['binding', 'manifest', 'version']);
      await writeFile(bundlePath, assembled.stdout, {flag: 'wx'});
      const verified = await execFilePromise(
        process.execPath,
        [
          'scripts/assemble-threadnote-5-observer-authority.ts',
          '--verify',
          '--candidate',
          candidatePath,
          '--retained-records',
          recordsPath,
          '--reviews',
          reviewsPath,
          '--bundle',
          bundlePath,
          '--manifest-sha256',
          parsedBundle.binding.manifestHash,
          '--review-artifact-set-sha256',
          parsedBundle.binding.reviewArtifactSetHash,
          '--binding-sha256',
          parsedBundle.binding.bindingHash,
        ],
        {cwd: process.cwd()},
      );
      expect(parseThreadnote5LocalAuthorityManifestV1(JSON.parse(verified.stdout))).toEqual(
        parseThreadnote5LocalAuthorityManifestV1(fixture.authorityManifest),
      );
      expect(verified.stderr).toBe('');
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('bounds every raw JSON input before parsing or evidence replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-observer-authority-bounds-'));
    try {
      const candidatePath = join(directory, 'candidate.json');
      const recordsPath = join(directory, 'records.json');
      const reviewsPath = join(directory, 'reviews.json');
      const bundlePath = join(directory, 'bundle.json');
      const oversizedCandidatePath = join(directory, 'oversized-candidate.json');
      const oversizedPrivatePath = join(directory, 'oversized-private.json');
      await Promise.all([
        writeFile(candidatePath, '{}'),
        writeFile(recordsPath, '[]'),
        writeFile(reviewsPath, '{}'),
        writeFile(bundlePath, '{}'),
        writeFile(oversizedCandidatePath, JSON.stringify({padding: Effect2.pipe('x', EffectString.repeat(64 * 1024))})),
        writeFile(
          oversizedPrivatePath,
          JSON.stringify({padding: Effect2.pipe('x', EffectString.repeat(8 * 1024 * 1024))}),
        ),
      ]);
      const cases = [
        {
          label: 'candidate',
          mode: '--preview',
          paths: [oversizedCandidatePath, recordsPath, reviewsPath],
          verify: false,
        },
        {
          label: 'retained records',
          mode: '--preview',
          paths: [candidatePath, oversizedPrivatePath, reviewsPath],
          verify: false,
        },
        {
          label: 'private reviews',
          mode: '--preview',
          paths: [candidatePath, recordsPath, oversizedPrivatePath],
          verify: false,
        },
        {
          label: 'reviewed bundle',
          mode: '--verify',
          paths: [candidatePath, recordsPath, reviewsPath],
          verify: true,
        },
      ] as const;
      for (const row of cases) {
        const arguments_ = [
          'scripts/assemble-threadnote-5-observer-authority.ts',
          row.mode,
          '--candidate',
          row.paths[0],
          '--retained-records',
          row.paths[1],
          '--reviews',
          row.paths[2],
          ...(row.verify
            ? [
                '--bundle',
                oversizedPrivatePath,
                '--manifest-sha256',
                Effect2.pipe('a', EffectString.repeat(64)),
                '--review-artifact-set-sha256',
                Effect2.pipe('b', EffectString.repeat(64)),
                '--binding-sha256',
                Effect2.pipe('c', EffectString.repeat(64)),
              ]
            : []),
        ];
        const failure = await execFilePromise(process.execPath, arguments_, {cwd: process.cwd()}).then(
          () => undefined,
          error => execOutput(error),
        );
        expect(failure).toContain(`Observer authority ${row.label} exceeds its raw-byte limit.`);
      }
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('has no path publication surface for parent-retarget, no-clobber, or cleanup races', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-observer-authority-paths-'));
    try {
      const first = join(directory, 'first');
      const second = join(directory, 'second');
      const alias = join(directory, 'current');
      await Promise.all([mkdir(first), mkdir(second)]);
      await Promise.all([writeFile(join(first, 'sentinel'), 'first'), writeFile(join(second, 'sentinel'), 'second')]);
      await symlink(first, alias);
      const legacyArguments = (flag: '--binding-output' | '--output', value: string) => [
        'scripts/assemble-threadnote-5-observer-authority.ts',
        '--assemble',
        '--candidate',
        join(directory, 'missing-candidate.json'),
        '--retained-records',
        join(directory, 'missing-records.json'),
        '--reviews',
        join(directory, 'missing-reviews.json'),
        flag,
        value,
      ];
      const runLegacyPublication = (flag: '--binding-output' | '--output', value: string) =>
        execFilePromise(process.execPath, legacyArguments(flag, value), {cwd: process.cwd()}).then(
          () => undefined,
          error => execOutput(error),
        );
      const failureText = (failure: Awaited<ReturnType<typeof runLegacyPublication>>) => failure ?? '';
      expect(failureText(await runLegacyPublication('--output', join(alias, 'publication', 'authority.json')))).toMatch(
        /Unknown observer authority option: --output/u,
      );
      await rm(alias);
      await symlink(second, alias);
      expect(
        failureText(await runLegacyPublication('--binding-output', join(alias, 'publication', 'binding.json'))),
      ).toMatch(/Unknown observer authority option: --binding-output/u);
      expect(await readFile(join(first, 'sentinel'), 'utf8')).toBe('first');
      expect(await readFile(join(second, 'sentinel'), 'utf8')).toBe('second');
      expect(await readdir(first)).toEqual(['sentinel']);
      expect(await readdir(second)).toEqual(['sentinel']);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

function reviewEnvelope() {
  const fixture = productionCaptureFixture();
  const records = new Map(EffectArray.map(fixture.records, record => [`${record.scenario}\0${record.kind}`, record]));
  return {
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    version: 1 as const,
    artifacts: EffectArray.map(THREADNOTE_5_OBSERVER_AUTHORITY_COVERAGE, coverage => {
      const record = records.get(`${coverage.scenario}\0${coverage.kind}`)!;
      const observedAuthority = EffectOption.getOrUndefined(
        EffectArray.findFirst(fixture.authorityManifest.entries, entry => entry.recordDigest === record.digest),
      )!;
      const artifact = {
        candidate: PRODUCTION_CAPTURE_CANDIDATE,
        observedAt: '2026-01-01T00:00:00.000Z',
        observedAuthority,
        provenance: {
          approvalDigest: Effect2.pipe('a', EffectString.repeat(64)),
          observerIdHash: Effect2.pipe('b', EffectString.repeat(64)),
          reviewerIdHash: Effect2.pipe('c', EffectString.repeat(64)),
        },
        runtime: {pre: PRODUCTION_CAPTURE_CANDIDATE, post: PRODUCTION_CAPTURE_CANDIDATE},
        version: 1 as const,
      };
      return {
        artifact,
        artifactDigest: threadnote5PrivateObserverArtifactDigest(artifact),
        observerKind: coverage.observerKind,
        recordDigest: record.digest,
      };
    }),
  };
}
