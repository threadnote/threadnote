import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {expect, it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {describe, it} from 'vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {SystemInfo, runtimePlatform} from '@threadnote/platform/system';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {defaultGraphShareProfile, ociProfilePointer} from '@threadnote/graph/sharing/profile';
import {graphShareProfileOciArtifact} from '@threadnote/graph/sharing/profile/oci_artifact';
import {
  assertGraphShareApprovalRoot,
  assertGraphShareApprovedProfile,
  loadGraphShareManagedApprovalFile,
  parseGraphShareManagedApproval,
} from '@threadnote/graph/sharing/profile/approval';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const registryCanonical = 'oci://registry.example.test/acme/canonical';
const registryWorker = 'oci://registry.example.test/acme/worker';
const coordinatorUrl = 'https://graph.example.test';
const profile = {
  ...defaultGraphShareProfile({
    branch: 'refs/heads/main',
    canonicalRemote: 'github.com/acme/repository',
    coordinatorUrl,
    organization: 'acme',
    publisherKeyFingerprint: sha256Digest('publisher'),
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  }),
  registry: {canonical: registryCanonical, worker: registryWorker},
};
const artifact = graphShareProfileOciArtifact(profile);
const enrollment = {
  profile: ociProfilePointer(registryCanonical, artifact.manifestDigest),
  profileDigest: artifact.profileDigest,
  publisherKeyFingerprint: profile.trust.publisherKeys[0],
  repositoryId: profile.repositoryId,
  schemaVersion: 2 as const,
};
const approval = {
  accessMode: 'join' as const,
  contribution: {declared: profile.contribution, effectiveMode: 'passive-on-index' as const},
  coordinatorUrl,
  organization: profile.organization,
  profileDigest: artifact.profileDigest,
  publisherKeyFingerprint: enrollment.publisherKeyFingerprint,
  registry: {canonical: registryCanonical, worker: registryWorker},
  repositoryId: enrollment.repositoryId,
  schemaVersion: 1 as const,
  source: profile.source,
};

describe('managed OCI profile approval', () => {
  it('parses a strict policy and authorizes only its exact root before a registry read', () => {
    const parsed = parseGraphShareManagedApproval(approval);
    expect(parsed).toEqual(approval);
    expect(assertGraphShareApprovalRoot(parsed, enrollment, profile.source.canonicalRemote)).toEqual({
      profileDigest: artifact.profileDigest,
      publisherKeyFingerprint: enrollment.publisherKeyFingerprint,
      registryCanonical,
      repositoryId: enrollment.repositoryId,
    });
    for (const wrong of [
      {...enrollment, repositoryId: Effect2.pipe('b', EffectString.repeat(64))},
      {...enrollment, publisherKeyFingerprint: sha256Digest('other')},
      {...enrollment, profileDigest: sha256Digest('other')},
      {...enrollment, profile: ociProfilePointer('oci://other.example.test/acme/canonical', artifact.manifestDigest)},
    ]) {
      expect(() => assertGraphShareApprovalRoot(parsed, wrong, profile.source.canonicalRemote)).toThrow();
    }
    expect(() => assertGraphShareApprovalRoot(parsed, enrollment, 'github.com/acme/other')).toThrow();
    expect(() => assertGraphShareApprovalRoot(parsed, enrollment, undefined)).toThrow();
  });

  it('pins effective destinations, source scope, declared policy, and actual contribution behavior', () => {
    const parsed = parseGraphShareManagedApproval(approval);
    expect(() => assertGraphShareApprovedProfile(parsed, profile, coordinatorUrl)).not.toThrow();
    for (const wrong of [
      {...approval, organization: 'other'},
      {...approval, coordinatorUrl: 'https://other.example.test'},
      {...approval, registry: {...approval.registry, worker: 'oci://registry.example.test/acme/other'}},
      {...approval, source: {...approval.source, branches: ['refs/heads/other']}},
      {...approval, contribution: {...approval.contribution, effectiveMode: 'off'}},
      {
        ...approval,
        contribution: {
          ...approval.contribution,
          declared: {...approval.contribution.declared, maximumUploadBytesPerSecond: 5},
        },
      },
    ] as const) {
      expect(() =>
        assertGraphShareApprovedProfile(parseGraphShareManagedApproval(wrong), profile, coordinatorUrl),
      ).toThrow();
    }
    expect(() => assertGraphShareApprovedProfile(parsed, profile, 'https://unexpected.example.test')).toThrow();
    FC.assert(
      FC.property(
        FC.integer({min: 1, max: 64}).filter(value => value !== profile.contribution.maximumCpus),
        value => {
          const wrong = parseGraphShareManagedApproval({
            ...approval,
            contribution: {
              ...approval.contribution,
              declared: {...approval.contribution.declared, maximumCpus: value},
            },
          });
          expect(() => assertGraphShareApprovedProfile(wrong, profile, coordinatorUrl)).toThrow();
        },
      ),
      {numRuns: 30},
    );
  });

  it('rejects extra fields, malformed roots, and false join policy', () => {
    for (const wrong of [
      {...approval, unexpected: true},
      {...approval, registry: {...approval.registry, extra: true}},
      {...approval, profileDigest: 'sha256:bad'},
      {...approval, source: {...approval.source, branches: []}},
      {...approval, contribution: {...approval.contribution, effectiveMode: 'dedicated'}},
    ]) {
      expect(() => parseGraphShareManagedApproval(wrong)).toThrow();
    }
    const missingCoordinator = {...profile, coordinator: undefined};
    expect(() =>
      assertGraphShareApprovedProfile(
        parseGraphShareManagedApproval({...approval, coordinatorUrl: null}),
        missingCoordinator,
        undefined,
      ),
    ).toThrow();
    const sameRegistry = {...profile, registry: {canonical: registryCanonical, worker: registryCanonical}};
    expect(() =>
      assertGraphShareApprovedProfile(
        parseGraphShareManagedApproval({
          ...approval,
          registry: {canonical: registryCanonical, worker: registryCanonical},
        }),
        sameRegistry,
        coordinatorUrl,
      ),
    ).toThrow();
  });
});

effectIt.effect('loads only a bounded, stable, private approval file outside checkout and Git metadata', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'graph-profile-approval-'}));
    const repoRoot = path.join(root, 'repo');
    const gitCommonDirectory = path.join(root, 'git');
    const approvalPath = path.join(root, 'approval.json');
    yield* fs.makeDirectory(repoRoot);
    yield* fs.makeDirectory(gitCommonDirectory);
    yield* fs.writeFileString(approvalPath, JSON.stringify(approval), {mode: 0o600});
    const input = {approvalPath, repoRoot, gitCommonDirectory};
    if (runtimePlatform === 'win32') {
      expect((yield* Effect.result(loadGraphShareManagedApprovalFile(input)))._tag).toBe('Failure');
      return;
    }
    expect(yield* loadGraphShareManagedApprovalFile(input)).toEqual(approval);

    yield* fs.chmod(approvalPath, 0o644);
    expect((yield* Effect.result(loadGraphShareManagedApprovalFile(input)))._tag).toBe('Failure');
    yield* fs.chmod(approvalPath, 0o600);
    if (system.userId !== undefined) {
      const wrongOwner = loadGraphShareManagedApprovalFile(input).pipe(
        Effect.provideService(SystemInfo, {...system, userId: system.userId + 1}),
      );
      expect((yield* Effect.result(wrongOwner))._tag).toBe('Failure');
    }

    const linked = path.join(root, 'linked.json');
    yield* fs.symlink(approvalPath, linked);
    expect((yield* Effect.result(loadGraphShareManagedApprovalFile({...input, approvalPath: linked})))._tag).toBe(
      'Failure',
    );
    const linkedParent = path.join(root, 'linked-parent');
    yield* fs.symlink(root, linkedParent);
    expect(
      (yield* Effect.result(
        loadGraphShareManagedApprovalFile({...input, approvalPath: path.join(linkedParent, 'approval.json')}),
      ))._tag,
    ).toBe('Failure');
    const insideRepo = path.join(repoRoot, 'approval.json');
    yield* fs.writeFileString(insideRepo, JSON.stringify(approval), {mode: 0o600});
    expect((yield* Effect.result(loadGraphShareManagedApprovalFile({...input, approvalPath: insideRepo})))._tag).toBe(
      'Failure',
    );
    const insideGit = path.join(gitCommonDirectory, 'approval.json');
    yield* fs.writeFileString(insideGit, JSON.stringify(approval), {mode: 0o600});
    expect((yield* Effect.result(loadGraphShareManagedApprovalFile({...input, approvalPath: insideGit})))._tag).toBe(
      'Failure',
    );
    expect(
      (yield* Effect.result(loadGraphShareManagedApprovalFile({...input, approvalPath: 'approval.json'})))._tag,
    ).toBe('Failure');
    yield* fs.writeFileString(approvalPath, Effect2.pipe('x', EffectString.repeat(16_385)), {mode: 0o600});
    expect((yield* Effect.result(loadGraphShareManagedApprovalFile(input)))._tag).toBe('Failure');
  }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
);
