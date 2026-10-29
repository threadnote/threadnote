import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {CodeMemoryLinkScaleProvenanceVerifier} from '../../../../scripts/code-memory-link-scale-provenance.js';
import {ScriptError} from '../../../../scripts/effect/errors.js';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  assertCodeMemoryLinkReleaseDescriptorRuntime,
  loadCodeMemoryLinkReleaseDescriptorAtHead,
  loadCodeMemoryLinkRetainedBundleAtHead,
  loadCodeMemoryLinkScaleArtifactAtHead,
  loadCodeMemoryLinkScaleCandidateBindingAtCommit,
  resolveGovernedCodeMemoryLinkRelease,
  verifyApprovalCheckout,
  verifyFinalEvidenceApproval,
  verifyManifestApproval,
} from '../../../../scripts/verify-code-memory-link-release.js';
import {
  CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_TYPE,
  codeMemoryLinkReleaseDescriptorPath,
  parseCodeMemoryLinkReleaseDescriptorV1,
} from '../../../../scripts/code-memory-link-release-descriptor.js';
import type {DevelopmentRuntimeEvidence} from '../../../../scripts/development-runtime.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer, StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {
  CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT,
  createCodeMemoryLinkRetainedBundleV1,
  type CodeMemoryLinkRetainedArtifactRole,
} from '@threadnote/threadnote/evaluation/code-memory-link-retained-bundle';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
  CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
  CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
  CODE_MEMORY_LINK_SCALE_SCENARIOS,
  codeMemoryLinkScaleCandidateBindingV1,
  codeMemoryLinkScaleArtifactPath,
  codeMemoryLinkScaleExpectedTruncatedSelectorCount,
  codeMemoryLinkScaleExpectedUris,
  evaluateCodeMemoryLinkScaleCapture,
  type CodeMemoryLinkScaleIdentityV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const MANIFEST_HASH = Effect2.pipe('a', EffectString.repeat(64));
const EXTERNAL_HASH = Effect2.pipe('b', EffectString.repeat(64));
const DOGFOOD_HASH = Effect2.pipe('c', EffectString.repeat(64));
const EXTRA_HASH = Effect2.pipe('d', EffectString.repeat(64));
const BUNDLE_HASH = Effect2.pipe('e', EffectString.repeat(64));
const BUNDLE_BLOB_HASH = Effect2.pipe('f', EffectString.repeat(64));
const BUNDLE_PATH = `${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/${BUNDLE_HASH}/bundle.json`;
const BUNDLE_PATHS = [BUNDLE_PATH, `${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/${BUNDLE_HASH}/blobs/${BUNDLE_BLOB_HASH}`];
const RELEASE_TAG = 'v4.6.0';
const RELEASE_DESCRIPTOR_PATH = codeMemoryLinkReleaseDescriptorPath(RELEASE_TAG);
const SCALE_ARTIFACT_HASH = Effect2.pipe('6', EffectString.repeat(64));
const SCALE_ARTIFACT_PATH = codeMemoryLinkScaleArtifactPath(SCALE_ARTIFACT_HASH);
const SCALE_BUILT_TARGET_HASH = Effect2.pipe('7', EffectString.repeat(64));
const CANDIDATE_EXECUTABLE_HASH = Effect2.pipe('1', EffectString.repeat(64));
const CANDIDATE_PAYLOAD_HASH = Effect2.pipe('2', EffectString.repeat(64));
const CANDIDATE_RELEASE_METADATA_HASH = Effect2.pipe('3', EffectString.repeat(64));
const CANDIDATE_LOCKFILE_HASH = Effect2.pipe('4', EffectString.repeat(64));
const CANDIDATE_PACKAGE_HASH = Effect2.pipe('5', EffectString.repeat(64));
const arbitraryHash = fc
  .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64})
  .map(characters => EffectArray.join(characters, ''))
  .filter(hash => hash !== EXTERNAL_HASH && hash !== DOGFOOD_HASH);
const arbitraryMismatchedScaleHash = arbitraryHash.filter(hash => hash !== SCALE_ARTIFACT_HASH);
const ScaleVerifierTestLayer = Layer.merge(
  ApplicationLayer,
  Layer.succeed(CodeMemoryLinkScaleProvenanceVerifier, {
    verify: (_subject, identity) => Effect.succeed(scaleRunnerBinding(identity.candidateCommit)),
  }),
);

describe('Code Memory Link release governance verifier', () => {
  effectIt.effect('derives identity from candidate Git objects and rejects malformed or oversized manifests', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scale-candidate-binding-'});
      const manifest = path.join(root, 'package.json');
      yield* git(root, ['init', '--quiet']);
      yield* fs.writeFileString(manifest, JSON.stringify({version: '4.6.0', packageManager: 'bun@1.4.2'}));
      const candidate = yield* commit(root, 'candidate package');
      yield* fs.writeFileString(manifest, JSON.stringify({version: '9.0.0', packageManager: 'bun@9.0.0'}));
      yield* commit(root, 'governance package differs');
      expect(yield* loadCodeMemoryLinkScaleCandidateBindingAtCommit(root, candidate)).toEqual(
        scaleCandidateBinding(candidate),
      );
      yield* fs.writeFileString(manifest, '{malformed');
      const malformed = yield* commit(root, 'malformed manifest');
      const malformedFailure = yield* loadCodeMemoryLinkScaleCandidateBindingAtCommit(root, malformed).pipe(
        Effect.flip,
      );
      expect(String(malformedFailure)).toContain('Could not derive');
      yield* fs.writeFileString(
        manifest,
        JSON.stringify({
          version: '4.6.0',
          packageManager: 'bun@1.4.2',
          padding: Effect2.pipe('x', EffectString.repeat(128 * 1024)),
        }),
      );
      const oversized = yield* commit(root, 'oversized manifest');
      const oversizedFailure = yield* loadCodeMemoryLinkScaleCandidateBindingAtCommit(root, oversized).pipe(
        Effect.flip,
      );
      expect(oversizedFailure._tag).toBe('CommandOutputLimitExceeded');
    }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
  );
  effectIt.effect('loads only a hash-named complete bundle from exact tracked HEAD blobs', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-retained-head-'});
      const bundle = createCodeMemoryLinkRetainedBundleV1({
        artifacts: retainedArtifacts(),
        candidateCommit: Effect2.pipe('9', EffectString.repeat(40)),
        clients: [
          {
            clientId: `cli_${Effect2.pipe('1', EffectString.repeat(16))}`,
            configProjection: `${JSON.stringify({model: 'gpt-5.6-luna'})}\n`,
            descriptor: `${JSON.stringify({hash: Effect2.pipe('1', EffectString.repeat(64))})}\n`,
          },
          {
            clientId: `cli_${Effect2.pipe('2', EffectString.repeat(16))}`,
            configProjection: `${JSON.stringify({model: 'gpt-5.6-terra'})}\n`,
            descriptor: `${JSON.stringify({hash: Effect2.pipe('2', EffectString.repeat(64))})}\n`,
          },
        ],
        sealedFiles: [
          {content: '{"version":1}\n', path: `tasks/tsk_${Effect2.pipe('3', EffectString.repeat(16))}/packet.json`},
        ],
      });
      const repositoryPath = `${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/${bundle.bundleHash}/bundle.json`;
      const bundleRoot = path.join(root, path.dirname(repositoryPath));
      yield* fs.makeDirectory(path.join(bundleRoot, 'blobs'), {recursive: true});
      yield* fs.writeFileString(path.join(root, repositoryPath), bundle.indexContent);
      yield* Effect.forEach(bundle.blobs, ([hash, content]) =>
        fs.writeFileString(path.join(bundleRoot, 'blobs', hash), content),
      );
      yield* git(root, ['init', '--quiet']);
      const head = yield* commit(root, 'retained bundle');

      const loaded = yield* loadCodeMemoryLinkRetainedBundleAtHead(root, head, repositoryPath);
      expect(loaded.bundleHash).toBe(bundle.bundleHash);
      expect(loaded.contents.index.candidateCommit).toBe(Effect2.pipe('9', EffectString.repeat(40)));
      const pathFailure = yield* loadCodeMemoryLinkRetainedBundleAtHead(
        root,
        head,
        path.join(root, repositoryPath),
      ).pipe(Effect.flip);
      expect(String(pathFailure)).toContain('repository-relative hash-named bundle');
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rederives one exact tracked release-scale artifact and binds its rebuilt target digest', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-scale-head-'});
      const candidate = Effect2.pipe('9', EffectString.repeat(40));
      const artifact = releaseScaleArtifact(candidate, SCALE_BUILT_TARGET_HASH);
      const source = `${JSON.stringify(artifact, undefined, 2)}\n`;
      const artifactHash = sha256HexSync(source);
      const repositoryPath = codeMemoryLinkScaleArtifactPath(artifactHash);
      const target = path.join(root, repositoryPath);
      yield* fs.makeDirectory(path.dirname(target), {recursive: true});
      yield* fs.writeFileString(target, source);
      yield* git(root, ['init', '--quiet']);
      const head = yield* commit(root, 'scale artifact');

      const loaded = yield* loadCodeMemoryLinkScaleArtifactAtHead(
        root,
        head,
        repositoryPath,
        artifactHash,
        candidate,
        SCALE_BUILT_TARGET_HASH,
        scaleCandidateBinding(candidate),
      );
      expect(loaded.artifact.gate).toEqual({failures: [], passed: true});
      expect(loaded.artifact.identity).toMatchObject({candidateCommit: candidate, dirty: false});

      const digestFailure = yield* loadCodeMemoryLinkScaleArtifactAtHead(
        root,
        head,
        repositoryPath,
        artifactHash,
        candidate,
        Effect2.pipe('0', EffectString.repeat(64)),
        scaleCandidateBinding(candidate),
      ).pipe(Effect.flip);
      expect(String(digestFailure)).toContain('independently rebuilt target');
      const missingRunner = yield* loadCodeMemoryLinkScaleArtifactAtHead(
        root,
        head,
        repositoryPath,
        artifactHash,
        candidate,
        SCALE_BUILT_TARGET_HASH,
        scaleCandidateBinding(candidate),
      ).pipe(
        Effect.provideService(CodeMemoryLinkScaleProvenanceVerifier, {
          verify: () => Effect.fail(ScriptError.make({message: 'No signed GitHub attestation'})),
        }),
        Effect.flip,
      );
      expect(String(missingRunner)).toContain('No signed GitHub attestation');
      const anotherRun = scaleRunnerBinding(candidate);
      const mismatchedRunner = yield* loadCodeMemoryLinkScaleArtifactAtHead(
        root,
        head,
        repositoryPath,
        artifactHash,
        candidate,
        SCALE_BUILT_TARGET_HASH,
        scaleCandidateBinding(candidate),
      ).pipe(
        Effect.provideService(CodeMemoryLinkScaleProvenanceVerifier, {
          verify: () => Effect.succeed({...anotherRun, github: {...anotherRun.github, runId: 2}}),
        }),
        Effect.flip,
      );
      expect(String(mismatchedRunner)).toContain('failed release-scale gate');
    }).pipe(provideTestLayer(ScaleVerifierTestLayer), TestClock.withLive),
  );

  effectIt.effect('rejects an executable-mode tracked scale artifact', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-scale-mode-'});
      const candidate = Effect2.pipe('9', EffectString.repeat(40));
      const source = `${JSON.stringify(releaseScaleArtifact(candidate, SCALE_BUILT_TARGET_HASH), undefined, 2)}\n`;
      const artifactHash = sha256HexSync(source);
      const repositoryPath = codeMemoryLinkScaleArtifactPath(artifactHash);
      const target = path.join(root, repositoryPath);
      yield* fs.makeDirectory(path.dirname(target), {recursive: true});
      yield* fs.writeFileString(target, source);
      yield* fs.chmod(target, 0o755);
      yield* git(root, ['init', '--quiet']);
      const head = yield* commit(root, 'executable scale artifact');

      const failure = yield* loadCodeMemoryLinkScaleArtifactAtHead(
        root,
        head,
        repositoryPath,
        artifactHash,
        candidate,
        SCALE_BUILT_TARGET_HASH,
        scaleCandidateBinding(candidate),
      ).pipe(Effect.flip);
      expect(String(failure)).toContain('one exact non-executable regular Git blob');
    }).pipe(provideTestLayer(ScaleVerifierTestLayer), TestClock.withLive),
  );

  effectIt.effect('accepts the exact candidate, manifest approval, and final-governance chronology', () =>
    fixtureRepository().pipe(
      Effect.flatMap(({approval, candidate, head, root}) =>
        Effect.gen(function* () {
          const release = yield* loadCodeMemoryLinkReleaseDescriptorAtHead(
            root,
            head,
            RELEASE_DESCRIPTOR_PATH,
            RELEASE_TAG,
          );
          expect(release.descriptor).toMatchObject({
            candidate: {commit: candidate, testedCandidateExecutableSha256: CANDIDATE_EXECUTABLE_HASH},
            releaseTag: RELEASE_TAG,
            retainedBundle: {path: BUNDLE_PATH, sha256: BUNDLE_HASH},
            scaleArtifact: {path: SCALE_ARTIFACT_PATH, sha256: SCALE_ARTIFACT_HASH},
          });
          const governance = yield* verifyApprovalCheckout(
            root,
            candidate,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          );
          expect(governance).toMatchObject({commit: head});
          expect(governance.changedPaths).toEqual(
            [
              ...BUNDLE_PATHS,
              RELEASE_DESCRIPTOR_PATH,
              SCALE_ARTIFACT_PATH,
              'apps/threadnote/src/evaluation/code-memory-link-approvals.json',
            ].sort(),
          );
          yield* verifyManifestApproval(root, candidate, head, approval, MANIFEST_HASH);
          yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          );
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects a descriptor candidate outside governance before it can be printed or executed', () =>
    fixtureRepository().pipe(
      Effect.flatMap(({candidate, head, root}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* git(root, ['checkout', '--quiet', '--detach', candidate]);
          yield* fs.writeFileString(path.join(root, 'src/product.ts'), 'export const product = 2;\n');
          const nonAncestor = yield* commit(root, 'non-ancestor candidate');
          yield* git(root, ['checkout', '--quiet', '--detach', head]);
          yield* fs.writeFileString(
            path.join(root, RELEASE_DESCRIPTOR_PATH),
            releaseDescriptorJson({bundleHash: BUNDLE_HASH, candidateCommit: nonAncestor}),
          );
          yield* commit(root, 'descriptor names non-ancestor');

          const failure = yield* resolveGovernedCodeMemoryLinkRelease(root, RELEASE_DESCRIPTOR_PATH, RELEASE_TAG).pipe(
            Effect.flip,
          );
          expect(String(failure)).toContain('candidate must be an ancestor');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('binds every field of the complete tested candidate payload evidence', () =>
    Effect.sync(() => {
      const candidateCommit = Effect2.pipe('9', EffectString.repeat(40));
      const descriptor = parseCodeMemoryLinkReleaseDescriptorV1({
        expectedReleaseTag: RELEASE_TAG,
        repositoryPath: RELEASE_DESCRIPTOR_PATH,
        source: releaseDescriptorJson({bundleHash: BUNDLE_HASH, candidateCommit}),
      });
      const runtime = candidateRuntimeEvidence(candidateCommit);
      expect(() => assertCodeMemoryLinkReleaseDescriptorRuntime(descriptor.candidate, runtime)).not.toThrow();
      for (const field of CANDIDATE_RUNTIME_FIELDS) {
        expect(
          () => assertCodeMemoryLinkReleaseDescriptorRuntime(descriptor.candidate, mutateRuntime(runtime, field)),
          field,
        ).toThrow('complete final release descriptor binding');
      }
    }),
  );

  effectIt.effect('rejects a forbidden product change even when a later commit reverts the net tree', () =>
    fixtureRepository({productChangeAndRevert: true}).pipe(
      Effect.flatMap(({candidate, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyApprovalCheckout(root, candidate).pipe(Effect.flip);
          expect(String(failure)).toContain('Runtime or product files changed in post-candidate history');
          expect(String(failure)).toContain('src/product.ts');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects approval JSON with fields outside the exact data schema', () =>
    fixtureRepository({extraApprovalField: true}).pipe(
      Effect.flatMap(({approval, candidate, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyManifestApproval(root, candidate, head, approval, MANIFEST_HASH).pipe(
            Effect.flip,
          );
          expect(String(failure)).toContain('must contain exactly');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects an executable-mode approvals blob at manifest approval A', () =>
    fixtureRepository({approvalExecutableMode: true}).pipe(
      Effect.flatMap(({approval, candidate, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyManifestApproval(root, candidate, head, approval, MANIFEST_HASH).pipe(
            Effect.flip,
          );
          expect(String(failure)).toContain('one exact non-executable regular Git blob');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects an executable-mode approvals blob at final governance G', () =>
    fixtureRepository({finalApprovalExecutableMode: true}).pipe(
      Effect.flatMap(({approval, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('one exact non-executable regular Git blob');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects any post-candidate modification to the executable approvals loader', () =>
    fixtureRepository({approvalsLoaderChange: true}).pipe(
      Effect.flatMap(({candidate, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyApprovalCheckout(root, candidate).pipe(Effect.flip);
          expect(String(failure)).toContain('Runtime or product files changed in post-candidate history');
          expect(String(failure)).toContain('apps/threadnote/src/evaluation/code-memory-link-approvals.ts');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects evidence hashes that preexist the final approval transition', () =>
    fixtureRepository({preexistingEvidence: true}).pipe(
      Effect.flatMap(({approval, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('must not preexist');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects an unreviewed extra hash in the final evidence delta', () =>
    fixtureRepository({extraFinalHash: EXTRA_HASH}).pipe(
      Effect.flatMap(({approval, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('must add exactly');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects an extra retained file outside the exact approved bundle map', () =>
    fixtureRepository({extraRetainedPath: true}).pipe(
      Effect.flatMap(({approval, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('add the exact retained bundle');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects final governance G when it does not newly add the exact scale artifact', () =>
    fixtureRepository({omitScaleArtifact: true}).pipe(
      Effect.flatMap(({approval, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('scale artifact');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects a descriptor whose retained path and hash do not identify the same bundle', () =>
    fixtureRepository({descriptorBundleHash: EXTRA_HASH}).pipe(
      Effect.flatMap(({head, root}) =>
        Effect.gen(function* () {
          const failure = yield* loadCodeMemoryLinkReleaseDescriptorAtHead(
            root,
            head,
            RELEASE_DESCRIPTOR_PATH,
            RELEASE_TAG,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('Final release descriptor is invalid');
          expect(String(failure)).toContain('path and SHA-256 differ');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  fcEffectProp(
    effectIt,
    'rejects every descriptor scale hash that differs from its content-addressed path (property)',
    {scaleArtifactHash: arbitraryMismatchedScaleHash},
    ({scaleArtifactHash}) =>
      Effect.sync(() => {
        expect(() =>
          parseCodeMemoryLinkReleaseDescriptorV1({
            expectedReleaseTag: RELEASE_TAG,
            repositoryPath: RELEASE_DESCRIPTOR_PATH,
            source: releaseDescriptorJson({
              bundleHash: BUNDLE_HASH,
              candidateCommit: Effect2.pipe('9', EffectString.repeat(40)),
              scaleArtifactHash,
            }),
          }),
        ).toThrow('scale artifact path and SHA-256 differ');
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('rejects a descriptor tag that differs from the tracked package version', () =>
    fixtureRepository({packageVersion: '4.6.1'}).pipe(
      Effect.flatMap(({head, root}) =>
        Effect.gen(function* () {
          const failure = yield* loadCodeMemoryLinkReleaseDescriptorAtHead(
            root,
            head,
            RELEASE_DESCRIPTOR_PATH,
            RELEASE_TAG,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('descriptor tag differs from package.json version');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects any governance commit inserted between candidate C and manifest approval A', () =>
    fixtureRepository({intermediateGovernanceBeforeApproval: true}).pipe(
      Effect.flatMap(({approval, candidate, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyManifestApproval(root, candidate, head, approval, MANIFEST_HASH).pipe(
            Effect.flip,
          );
          expect(String(failure)).toContain('immediate governance commit after the tested candidate');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects a tag checkout after the exact final-governance commit G', () =>
    fixtureRepository({postFinalGovernanceCommit: true}).pipe(
      Effect.flatMap(({approval, head, root}) =>
        Effect.gen(function* () {
          const failure = yield* verifyFinalEvidenceApproval(
            root,
            approval,
            head,
            EXTERNAL_HASH,
            DOGFOOD_HASH,
            MANIFEST_HASH,
            BUNDLE_HASH,
            BUNDLE_PATHS,
            RELEASE_DESCRIPTOR_PATH,
            SCALE_ARTIFACT_PATH,
          ).pipe(Effect.flip);
          expect(String(failure)).toContain('immediate single-parent commit after manifest approval');
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  fcEffectProp(
    effectIt,
    'rejects every additional valid hash beyond the reviewed final delta (property)',
    {extraHash: arbitraryHash},
    ({extraHash}) =>
      fixtureRepository({extraFinalHash: extraHash}).pipe(
        Effect.flatMap(({approval, head, root}) =>
          Effect.gen(function* () {
            const failure = yield* verifyFinalEvidenceApproval(
              root,
              approval,
              head,
              EXTERNAL_HASH,
              DOGFOOD_HASH,
              MANIFEST_HASH,
              BUNDLE_HASH,
              BUNDLE_PATHS,
              RELEASE_DESCRIPTOR_PATH,
              SCALE_ARTIFACT_PATH,
            ).pipe(Effect.flip);
            expect(String(failure)).toContain('must add exactly');
          }),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {fastCheck: {numRuns: 8}},
  );

  effectIt.effect('cleans up idempotently when the release verifier fixture root disappears before finalization', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const {root} = yield* fixtureRepository();

      yield* fs.remove(root, {force: true, recursive: true});

      expect(yield* fs.exists(root)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

function fixtureRepository(
  options: {
    readonly approvalExecutableMode?: boolean;
    readonly approvalsLoaderChange?: boolean;
    readonly descriptorBundleHash?: string;
    readonly extraApprovalField?: boolean;
    readonly extraFinalHash?: string;
    readonly extraRetainedPath?: boolean;
    readonly finalApprovalExecutableMode?: boolean;
    readonly intermediateGovernanceBeforeApproval?: boolean;
    readonly packageVersion?: string;
    readonly postFinalGovernanceCommit?: boolean;
    readonly preexistingEvidence?: boolean;
    readonly productChangeAndRevert?: boolean;
    readonly omitScaleArtifact?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-code-memory-release-verifier-');
    const approvalsPath = path.join(root, 'apps/threadnote/src/evaluation/code-memory-link-approvals.json');
    const approvalsLoaderPath = path.join(root, 'apps/threadnote/src/evaluation/code-memory-link-approvals.ts');
    const packagePath = path.join(root, 'package.json');
    const productPath = path.join(root, 'src/product.ts');
    yield* Effect.all(
      [
        fs.makeDirectory(path.dirname(approvalsPath), {recursive: true}),
        fs.makeDirectory(path.dirname(productPath), {recursive: true}),
      ],
      {concurrency: 'unbounded'},
    );
    const initialExternalEvidence = options.preexistingEvidence ? [EXTERNAL_HASH] : [];
    yield* fs.writeFileString(approvalsPath, approvalJson({externalEvidence: initialExternalEvidence}));
    yield* fs.writeFileString(approvalsLoaderPath, 'export const APPROVALS_LOADER_VERSION = 1;\n');
    yield* fs.writeFileString(
      packagePath,
      `${JSON.stringify({version: options.packageVersion ?? Effect2.pipe(RELEASE_TAG, EffectString.slice(1))}, undefined, 2)}\n`,
    );
    yield* fs.writeFileString(productPath, 'export const product = 1;\n');
    yield* git(root, ['init', '--quiet']);
    const candidate = yield* commit(root, 'candidate');

    if (options.productChangeAndRevert) {
      yield* fs.writeFileString(productPath, 'export const product = 2;\n');
      yield* commit(root, 'forbidden product change');
      yield* fs.writeFileString(productPath, 'export const product = 1;\n');
      yield* commit(root, 'net-tree revert');
    }
    if (options.approvalsLoaderChange) {
      yield* fs.writeFileString(approvalsLoaderPath, 'export const APPROVALS_LOADER_VERSION = 2;\n');
      yield* commit(root, 'forbidden executable approval loader change');
    }
    if (options.intermediateGovernanceBeforeApproval) {
      const intermediate = path.join(root, CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT, 'intermediate.txt');
      yield* fs.makeDirectory(path.dirname(intermediate), {recursive: true});
      yield* fs.writeFileString(intermediate, 'intermediate governance\n');
      yield* commit(root, 'unexpected governance before manifest approval');
    }

    yield* fs.writeFileString(
      approvalsPath,
      approvalJson({
        externalEvidence: initialExternalEvidence,
        extraField: options.extraApprovalField ? MANIFEST_HASH : undefined,
        manifests: [MANIFEST_HASH],
      }),
    );
    if (options.approvalExecutableMode) yield* fs.chmod(approvalsPath, 0o755);
    const approval = yield* commit(root, 'approve manifest');
    yield* fs.writeFileString(
      approvalsPath,
      approvalJson({
        dogfoodEvidence: [DOGFOOD_HASH],
        externalEvidence: [
          ...new Set([
            ...initialExternalEvidence,
            EXTERNAL_HASH,
            ...(options.extraFinalHash ? [options.extraFinalHash] : []),
          ]),
        ],
        manifests: [MANIFEST_HASH],
        retainedBundles: [BUNDLE_HASH],
      }),
    );
    if (options.finalApprovalExecutableMode) yield* fs.chmod(approvalsPath, 0o755);
    for (const retainedPath of BUNDLE_PATHS) {
      const target = path.join(root, retainedPath);
      yield* fs.makeDirectory(path.dirname(target), {recursive: true});
      yield* fs.writeFileString(target, retainedPath === BUNDLE_PATH ? '{"version":1}\n' : '{"blob":true}\n');
    }
    if (options.extraRetainedPath) {
      const extra = path.join(root, CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT, BUNDLE_HASH, 'notes.txt');
      yield* fs.writeFileString(extra, 'unreviewed\n');
    }
    if (!options.omitScaleArtifact) {
      const scaleArtifactPath = path.join(root, SCALE_ARTIFACT_PATH);
      yield* fs.makeDirectory(path.dirname(scaleArtifactPath), {recursive: true});
      yield* fs.writeFileString(scaleArtifactPath, '{"fixture":"scale"}\n');
    }
    const descriptorPath = path.join(root, RELEASE_DESCRIPTOR_PATH);
    yield* fs.makeDirectory(path.dirname(descriptorPath), {recursive: true});
    yield* fs.writeFileString(
      descriptorPath,
      releaseDescriptorJson({
        bundleHash: options.descriptorBundleHash ?? BUNDLE_HASH,
        candidateCommit: candidate,
      }),
    );
    let head = yield* commit(root, 'approve evidence');
    if (options.postFinalGovernanceCommit) {
      yield* fs.writeFileString(
        descriptorPath,
        releaseDescriptorJson({bundleHash: BUNDLE_HASH, candidateCommit: candidate, target: 'bun-darwin-x64'}),
      );
      head = yield* commit(root, 'unexpected governance after final approval');
    }
    return {approval, candidate, head, root};
  });
}

function releaseDescriptorJson(input: {
  readonly bundleHash: string;
  readonly candidateCommit: string;
  readonly scaleArtifactHash?: string;
  readonly target?: string;
}): string {
  return `${JSON.stringify(
    {
      candidate: {
        commit: input.candidateCommit,
        dependencyInstallation: 'bun install --frozen-lockfile',
        payloadBytes: 4096,
        payloadFileCount: 8,
        payloadManifestSha256: CANDIDATE_PAYLOAD_HASH,
        releaseMetadataSha256: CANDIDATE_RELEASE_METADATA_HASH,
        runtime: 'bun',
        sourceLockfileSha256: CANDIDATE_LOCKFILE_HASH,
        sourcePackageManifestSha256: CANDIDATE_PACKAGE_HASH,
        target: input.target ?? 'bun-darwin-arm64',
        testedCandidateExecutableSha256: CANDIDATE_EXECUTABLE_HASH,
        version: `${Effect2.pipe(RELEASE_TAG, EffectString.slice(1))}-local.g${input.candidateCommit}`,
      },
      releaseTag: RELEASE_TAG,
      retainedBundle: {path: BUNDLE_PATH, sha256: input.bundleHash},
      scaleArtifact: {path: SCALE_ARTIFACT_PATH, sha256: input.scaleArtifactHash ?? SCALE_ARTIFACT_HASH},
      type: CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_TYPE,
      version: 1,
    },
    undefined,
    2,
  )}\n`;
}

function releaseScaleArtifact(candidateCommit: string, builtArtifactSha256: string) {
  const scenario = (id: (typeof CODE_MEMORY_LINK_SCALE_SCENARIOS)[number], returnedUris: readonly string[]) => {
    const truncatedSelectorCount = codeMemoryLinkScaleExpectedTruncatedSelectorCount(id);
    const observation = {canonicalMismatchCount: 0, milliseconds: 1, returnedUris, truncatedSelectorCount};
    return {
      cold: observation,
      expectedTruncatedSelectorCount: truncatedSelectorCount,
      expectedUris: returnedUris,
      id,
      samples: Array.from({length: 25}, () => observation),
      warmups: Array.from({length: 5}, () => observation),
    };
  };
  const identity: CodeMemoryLinkScaleIdentityV1 = {
    architecture: 'arm64',
    builtArtifactSha256,
    candidateCommit,
    candidateVersion: Effect2.pipe(RELEASE_TAG, EffectString.slice(1)),
    cpu: 'Apple M1',
    dirty: false,
    gitStatusObserved: true,
    github: {
      actions: true,
      eventName: 'workflow_dispatch',
      job: CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
      ref: 'refs/heads/release/4.6.0',
      repository: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
      repositoryId: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
      runAttempt: 1,
      runId: 1,
      sha: candidateCommit,
      workflowRef: `${CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY}/.github/workflows/benchmarks.yml@refs/heads/release/4.6.0`,
      workflowSha: candidateCommit,
    },
    invocationMode: 'release-scale',
    memoryBytes: 64 * 1024 * 1024 * 1024,
    observedCommit: candidateCommit,
    operatingSystem: 'macOS 15.0',
    packageManager: 'bun@1.4.2',
    runnerClass: CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
    runnerArchitecture: 'ARM64',
    runnerEnvironment: 'github-hosted',
    runnerOperatingSystem: 'macOS',
    runtime: 'bun/1.4.2',
    sourceVersion: `threadnote-${Effect2.pipe(RELEASE_TAG, EffectString.slice(1))}`,
  };
  return evaluateCodeMemoryLinkScaleCapture({
    budget: CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
    candidateBinding: scaleCandidateBinding(candidateCommit),
    runnerBinding: scaleRunnerBinding(candidateCommit),
    capture: {
      corpus: {
        corpusBytes: 32 * 1024 * 1024,
        denseBacklinkMemoryCount: 99_996,
        directBacklinkMemoryCount: 3,
        indexedMemoryCount: 100_000,
        isolationDecoyMemoryCount: 1,
        materializedMemoryCount: 100_000,
        noiseMemoryCount: 99_996,
      },
      fixtureHash: CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
      resources: {
        addedPeakRssBytes: 1024 * 1024 * 1024,
        baselineRssBytes: 128 * 1024 * 1024,
        indexBuildMilliseconds: 90_000,
        materializationMilliseconds: 20_000,
        peakRssBytes: 1152 * 1024 * 1024,
        recallDatabaseBytes: 300 * 1024 * 1024,
        recallStorageBytes: 320 * 1024 * 1024,
      },
      scenarios: [
        scenario('file-backlinks', codeMemoryLinkScaleExpectedUris('file-backlinks')),
        scenario('symbol-backlink', codeMemoryLinkScaleExpectedUris('symbol-backlink')),
        scenario('dense-shared-selector', codeMemoryLinkScaleExpectedUris('dense-shared-selector')),
        scenario('no-answer', []),
      ],
    },
    createdAt: '2026-08-29T00:00:00.000Z',
    identity,
  });
}

function scaleCandidateBinding(candidateCommit: string) {
  return codeMemoryLinkScaleCandidateBindingV1(candidateCommit, {
    packageManager: 'bun@1.4.2',
    version: Effect2.pipe(RELEASE_TAG, EffectString.slice(1)),
  });
}

function scaleRunnerBinding(candidateCommit: string) {
  return {
    github: {
      actions: true,
      eventName: 'workflow_dispatch',
      job: CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
      ref: 'refs/heads/release/4.6.0',
      repository: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
      repositoryId: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
      runAttempt: 1,
      runId: 1,
      sha: candidateCommit,
      workflowRef: `${CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY}/.github/workflows/benchmarks.yml@refs/heads/release/4.6.0`,
      workflowSha: candidateCommit,
    },
    runnerClass: CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
    runnerArchitecture: 'ARM64',
    runnerEnvironment: 'github-hosted',
    runnerOperatingSystem: 'macOS',
  };
}

const CANDIDATE_RUNTIME_FIELDS = [
  'dependencyInstallation',
  'executableSha256',
  'payloadBytes',
  'payloadFileCount',
  'payloadManifestSha256',
  'releaseMetadataSha256',
  'runtime',
  'sourceCommit',
  'sourceLockfileSha256',
  'sourcePackageManifestSha256',
  'target',
  'version',
] as const satisfies readonly (keyof DevelopmentRuntimeEvidence)[];

function candidateRuntimeEvidence(candidateCommit: string): DevelopmentRuntimeEvidence {
  return {
    dependencyInstallation: 'bun install --frozen-lockfile',
    executableSha256: CANDIDATE_EXECUTABLE_HASH,
    payloadBytes: 4096,
    payloadFileCount: 8,
    payloadManifestSha256: CANDIDATE_PAYLOAD_HASH,
    releaseMetadataSha256: CANDIDATE_RELEASE_METADATA_HASH,
    runtime: 'bun',
    sourceCommit: candidateCommit,
    sourceLockfileSha256: CANDIDATE_LOCKFILE_HASH,
    sourcePackageManifestSha256: CANDIDATE_PACKAGE_HASH,
    target: 'bun-darwin-arm64',
    version: `${Effect2.pipe(RELEASE_TAG, EffectString.slice(1))}-local.g${candidateCommit}`,
  };
}

function mutateRuntime(
  runtime: DevelopmentRuntimeEvidence,
  field: (typeof CANDIDATE_RUNTIME_FIELDS)[number],
): DevelopmentRuntimeEvidence {
  const replacements: Record<(typeof CANDIDATE_RUNTIME_FIELDS)[number], string | number> = {
    dependencyInstallation: 'bun install',
    executableSha256: Effect2.pipe('0', EffectString.repeat(64)),
    payloadBytes: runtime.payloadBytes + 1,
    payloadFileCount: runtime.payloadFileCount + 1,
    payloadManifestSha256: Effect2.pipe('0', EffectString.repeat(64)),
    releaseMetadataSha256: Effect2.pipe('0', EffectString.repeat(64)),
    runtime: `${runtime.runtime}-changed`,
    sourceCommit: Effect2.pipe('0', EffectString.repeat(40)),
    sourceLockfileSha256: Effect2.pipe('0', EffectString.repeat(64)),
    sourcePackageManifestSha256: Effect2.pipe('0', EffectString.repeat(64)),
    target: 'bun-darwin-x64',
    version: `${runtime.version}.changed`,
  };
  return {...runtime, [field]: replacements[field]};
}

function approvalJson(
  options: {
    readonly dogfoodEvidence?: readonly string[];
    readonly externalEvidence?: readonly string[];
    readonly extraField?: string;
    readonly manifests?: readonly string[];
    readonly retainedBundles?: readonly string[];
  } = {},
): string {
  return `${JSON.stringify(
    {
      agentAbEvidenceHashes: options.externalEvidence ?? [],
      agentAbManifestHashes: options.manifests ?? [],
      dogfoodEvidenceHashes: options.dogfoodEvidence ?? [],
      retainedEvidenceBundleHashes: options.retainedBundles ?? [],
      ...(options.extraField === undefined ? {} : {reviewedManifestHash: options.extraField}),
      version: 1,
    },
    undefined,
    2,
  )}\n`;
}

function retainedArtifacts(): Record<CodeMemoryLinkRetainedArtifactRole, string> {
  return {
    assignment: '{"version":1}\n',
    attempts: '{"version":1}\n',
    dogfood: '{"version":1}\n',
    evidence: '{"version":1}\n',
    manifest: '{"version":1}\n',
    result: '{"version":1}\n',
    sealedLayout: '{"version":1}\n',
    sealedSuite: '{"version":1}\n',
    trials: '{"version":1}\n',
  };
}

const commit = Effect.fn('codeMemoryLinkReleaseVerifierTest.commit')(function* (root: string, message: string) {
  yield* git(root, ['add', '.']);
  yield* git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--quiet',
    '--message',
    message,
  ]);
  return Effect2.pipe((yield* git(root, ['rev-parse', 'HEAD'])).stdout, EffectString.trim);
});

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 64 * 1024, timeoutMs: 30_000});
}
