import {Array as EffectArray} from 'effect';
import {expect, it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {graphRegistryFixture} from '@threadnote/graph/test/helpers/graph-registry';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {readVerifiedCasBlob} from '@threadnote/graph/sharing/cas';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {maybeImportSharedGraphBase, runGraphShareJoin, runGraphShareLeave} from '@threadnote/graph/sharing/client';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {
  graphShareEnrollmentPath,
  graphSharingCasBlobPath,
  graphSharingFrontierPointerPath,
  graphSharingLayout,
} from '@threadnote/graph/sharing/layout';
import {
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
} from '@threadnote/graph/sharing/profile';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherProfilePromote,
  runGraphShareInit,
} from '@threadnote/threadnote/code_graph/sharing/publisher';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {lookupGraphShareTrustReceipt} from '@threadnote/graph/sharing/trust';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const canonicalRegistry = 'oci://registry.example.test/acme/canonical';
const workerRegistry = 'oci://registry.example.test/acme/worker';

function rejected<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.exit(effect);
    if (Exit.isSuccess(result)) return yield* Effect.die('Expected an operation failure');
    return Cause.squash(result.cause);
  });
}

const repositoryFixture = Effect.fn('test.publisherProfilePromotion.repositoryFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-profile-promotion-'});
  const repository = path.join(root, 'repository');
  const cas = path.join(root, 'cas');
  const config = {
    account: 'local',
    agentContextHome: path.join(root, 'publisher-home'),
    agentId: 'profile-promotion-test',
    manifestPath: path.join(root, 'manifest.yaml'),
    user: 'profile-promotion-test',
  } satisfies Parameters<typeof runGraphShareInit>[0];
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
  const commit = (message: string) =>
    git(['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', message]);
  yield* fs.makeDirectory(repository);
  yield* git(['init', '-q', '--initial-branch=main']);
  yield* git(['remote', 'add', 'origin', 'https://github.com/acme/profile-promotion-test.git']);
  yield* fs.writeFileString(path.join(repository, 'index.ts'), 'export const value = 1;\n');
  yield* git(['add', 'index.ts']);
  yield* commit('base');
  return {cas, config, fs, git, path, repository, commit};
});

const fixture = Effect.fn('test.publisherProfilePromotion.fixture')(function* () {
  const base = yield* repositoryFixture();
  const {cas, config, fs, git, path, repository, commit} = base;
  const registry = yield* graphRegistryFixture();
  const initialized = yield* runGraphShareInit(config, {
    cas,
    cwd: repository,
    organization: 'acme',
    registry: canonicalRegistry,
    workerRegistry,
    writeConfig: true,
  });
  const pointer = parseGraphShareProfilePointer(initialized.enrollment.profile);
  if (pointer.kind !== 'cas') return yield* Effect.die('Initial enrollment must be CAS-pinned');
  const profile = parseGraphShareProfile(yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, pointer.bodyDigest)));
  expect(profile.registry).toEqual({canonical: canonicalRegistry, worker: workerRegistry});
  const enrollmentPath = graphShareEnrollmentPath(path, repository);
  const enrollment = parseGraphShareEnrollment(initialized.enrollment);
  yield* git(['add', '.threadnote/graph-share.json']);
  yield* commit('stage CAS profile');
  const head = Effect2.pipe((yield* git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
  const enrollmentBytes = yield* fs.readFileString(enrollmentPath);
  const keyPath = graphSharingLayout(path, config.agentContextHome, cas).publisherKeyPath;
  const promote = (registryReference = canonicalRegistry) =>
    registry.provide(runGraphPublisherProfilePromote(config, {cas, cwd: repository, registry: registryReference}));
  return {...base, enrollment, enrollmentBytes, enrollmentPath, head, keyPath, promote, registry};
});

effectIt.effect('publishes the staged v1 profile and returns a stable v2 candidate without changing Git', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.promote();
      expect(first.enrollment).toMatchObject({
        profile: `${canonicalRegistry}@${first.manifestDigest}`,
        profileDigest: first.profileDigest,
        publisherKeyFingerprint: f.enrollment.publisherKeyFingerprint,
        repositoryId: f.enrollment.repositoryId,
        schemaVersion: 2,
      });
      expect(first.manifestDigest).not.toBe(first.profileDigest);
      expect(first.profileDigest).toBe(Effect2.pipe(f.enrollment.profile, EffectString.slice('cas://'.length)));
      expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(f.enrollmentBytes);
      expect(Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim)).toBe(f.head);
      expect((yield* f.git(['status', '--porcelain'])).stdout).toBe('');
      expect(f.registry.manifests.has(first.manifestDigest)).toBe(true);
      expect(
        f.registry.manifests.has(
          `tn-profile-${Effect2.pipe(first.manifestDigest, EffectString.slice('sha256:'.length))}`,
        ),
      ).toBe(true);
      expect(EffectArray.some(f.registry.requests, request => request.method === 'PUT')).toBe(true);

      const retry = yield* f.promote();
      expect(retry).toEqual(first);
      expect(
        EffectArray.filter(
          f.registry.requests,
          request =>
            request.method === 'PUT' &&
            request.pathname ===
              `/v2/acme/canonical/manifests/tn-profile-${Effect2.pipe(first.manifestDigest, EffectString.slice('sha256:'.length))}`,
        ),
      ).toHaveLength(1);
      expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(f.enrollmentBytes);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('stages a fresh org outside Git history and replaces its temporary v1 file only after promotion', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* repositoryFixture();
      const registry = yield* graphRegistryFixture();
      const initialHead = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const staged = yield* runGraphShareInit(f.config, {
        cas: f.cas,
        cwd: f.repository,
        organization: 'acme',
        registry: canonicalRegistry,
        workerRegistry,
        writeConfig: true,
      });
      const stagedBytes = yield* f.fs.readFileString(staged.enrollmentPath);
      expect(parseGraphShareEnrollment(JSON.parse(stagedBytes))).toEqual(staged.enrollment);
      const promoted = yield* registry.provide(
        runGraphPublisherProfilePromote(f.config, {cas: f.cas, cwd: f.repository, registry: canonicalRegistry}),
      );
      expect(yield* f.fs.readFileString(staged.enrollmentPath)).toBe(stagedBytes);
      expect(Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim)).toBe(initialHead);
      yield* f.fs.writeFileString(staged.enrollmentPath, `${JSON.stringify(promoted.enrollment, undefined, 2)}\n`);
      expect(parseGraphShareEnrollment(JSON.parse(yield* f.fs.readFileString(staged.enrollmentPath)))).toEqual(
        promoted.enrollment,
      );
      expect(Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim)).toBe(initialHead);
      expect((yield* f.git(['status', '--porcelain'])).stdout).toContain('.threadnote/');
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('migrates a previously trusted v1 client to a cold v2 OCI profile without coordinator CAS', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const clientConfig = {...f.config, agentContextHome: f.path.join(f.repository, '..', 'client-home')};
      const joined = yield* runGraphShareJoin(clientConfig, {cas: f.cas, cwd: f.repository, readOnly: true});
      expect(joined.accessMode).toBe('read-only');
      const promoted = yield* f.promote();
      yield* f.fs.writeFileString(f.enrollmentPath, `${JSON.stringify(promoted.enrollment, undefined, 2)}\n`);
      yield* f.fs.remove(
        graphSharingCasBlobPath(
          f.path,
          f.cas,
          Effect2.pipe(promoted.profileDigest, EffectString.slice('sha256:'.length)),
        ),
      );
      yield* f.fs.remove(
        graphSharingCasBlobPath(
          f.path,
          f.cas,
          Effect2.pipe(promoted.manifestDigest, EffectString.slice('sha256:'.length)),
        ),
      );
      const requestsBefore = f.registry.requests.length;
      const migrated = yield* f.registry.provide(
        runGraphShareJoin(clientConfig, {cas: f.cas, cwd: f.repository, readOnly: true}),
      );
      expect(migrated.profileDigest).toBe(promoted.profileDigest);
      expect(EffectArray.map(f.registry.requests.slice(requestsBefore), request => request.pathname)).toEqual([
        `/v2/acme/canonical/manifests/${promoted.manifestDigest}`,
        `/v2/acme/canonical/blobs/${promoted.profileDigest}`,
      ]);
      const trust = yield* lookupGraphShareTrustReceipt(
        clientConfig.agentContextHome,
        promoted.enrollment.repositoryId,
      );
      expect(trust?.registryCanonical).toBe(canonicalRegistry);
      expect(trust?.accessMode).toBe('read-only');
      const freshConfig = {...clientConfig, agentContextHome: f.path.join(f.repository, '..', 'fresh-home')};
      const requestsAfterMigration = f.registry.requests.length;
      expect(
        yield* rejected(f.registry.provide(runGraphShareJoin(freshConfig, {cas: f.cas, cwd: f.repository}))),
      ).toBeInstanceOf(Error);
      expect(f.registry.requests).toHaveLength(requestsAfterMigration);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('fresh managed approval pins the OCI root and verified profile before trust or CAS writes', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const promoted = yield* f.promote();
      yield* f.fs.writeFileString(f.enrollmentPath, `${JSON.stringify(promoted.enrollment)}\n`);
      const pointer = parseGraphShareProfilePointer(f.enrollment.profile);
      if (pointer.kind !== 'cas') return yield* Effect.die('Expected staged CAS profile');
      const profile = parseGraphShareProfile(
        yield* decodeJsonBytes(yield* readVerifiedCasBlob(f.cas, pointer.bodyDigest)),
      );
      const approvalPath = yield* f.fs.realPath(f.path.join(f.repository, '..'));
      const approvalFile = f.path.join(approvalPath, 'managed-approval.json');
      const approval = {
        accessMode: 'read-only' as const,
        contribution: {declared: profile.contribution, effectiveMode: 'off' as const},
        coordinatorUrl: null,
        organization: profile.organization,
        profileDigest: promoted.profileDigest,
        publisherKeyFingerprint: promoted.enrollment.publisherKeyFingerprint,
        registry: profile.registry,
        repositoryId: promoted.enrollment.repositoryId,
        schemaVersion: 1 as const,
        source: profile.source,
      };
      const clientConfig = {
        ...f.config,
        agentContextHome: f.path.join(f.repository, '..', 'fresh-approved-home'),
      };
      const clientCas = f.path.join(f.repository, '..', 'fresh-approved-cas');
      const manifestPath = graphSharingCasBlobPath(
        f.path,
        clientCas,
        Effect2.pipe(promoted.manifestDigest, EffectString.slice('sha256:'.length)),
      );
      yield* writePrivateJsonFile(approvalFile, {...approval, profileDigest: sha256Digest('wrong')});
      const beforeWrongRoot = f.registry.requests.length;
      expect(
        yield* rejected(
          f.registry.provide(runGraphShareJoin(clientConfig, {approvalFile, cas: clientCas, cwd: f.repository})),
        ),
      ).toBeInstanceOf(Error);
      expect(f.registry.requests).toHaveLength(beforeWrongRoot);
      expect(yield* lookupGraphShareTrustReceipt(clientConfig.agentContextHome, approval.repositoryId)).toBeUndefined();
      expect(yield* f.fs.exists(manifestPath)).toBe(false);

      yield* writePrivateJsonFile(approvalFile, {...approval, organization: 'wrong'});
      expect(
        yield* rejected(
          f.registry.provide(runGraphShareJoin(clientConfig, {approvalFile, cas: clientCas, cwd: f.repository})),
        ),
      ).toBeInstanceOf(Error);
      expect(f.registry.requests.length).toBeGreaterThan(beforeWrongRoot);
      expect(yield* lookupGraphShareTrustReceipt(clientConfig.agentContextHome, approval.repositoryId)).toBeUndefined();
      expect(yield* f.fs.exists(manifestPath)).toBe(false);

      yield* writePrivateJsonFile(approvalFile, approval);
      const joined = yield* f.registry.provide(
        runGraphShareJoin(clientConfig, {approvalFile, cas: clientCas, cwd: f.repository}),
      );
      expect(joined.accessMode).toBe('read-only');
      const repeated = yield* f.registry.provide(
        runGraphShareJoin(clientConfig, {approvalFile, cas: clientCas, cwd: f.repository}),
      );
      expect(repeated.accessMode).toBe('read-only');
      expect(yield* f.fs.exists(manifestPath)).toBe(true);
      expect(
        (yield* lookupGraphShareTrustReceipt(clientConfig.agentContextHome, approval.repositoryId))?.accessMode,
      ).toBe('read-only');
      yield* f.git(['checkout', '-qb', 'unapproved-branch']);
      const system = yield* SystemInfo;
      const deniedUpgrade = yield* rejected(
        f.registry.provide(
          runGraphShareJoin(clientConfig, {cas: clientCas, coordinator: 'http://127.0.0.1:9', cwd: f.repository}).pipe(
            Effect.provideService(SystemInfo, {
              ...system,
              stdinIsTTY: true,
              stdoutIsTTY: true,
              readLine: (_prompt, onLine) => {
                queueMicrotask(() => onLine('join'));
                return () => undefined;
              },
            }),
          ),
        ),
      );
      expect(deniedUpgrade instanceof Error ? deniedUpgrade.message : String(deniedUpgrade)).toContain(
        'does not authorize this checkout branch',
      );
      expect(
        (yield* lookupGraphShareTrustReceipt(clientConfig.agentContextHome, approval.repositoryId))?.accessMode,
      ).toBe('read-only');
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('ordinary graph use auto-consumes managed approval without an explicit join', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const promoted = yield* f.promote();
      yield* f.fs.writeFileString(f.enrollmentPath, `${JSON.stringify(promoted.enrollment)}\n`);
      const pointer = parseGraphShareProfilePointer(f.enrollment.profile);
      if (pointer.kind !== 'cas') return yield* Effect.die('Expected staged CAS profile');
      const profile = parseGraphShareProfile(
        yield* decodeJsonBytes(yield* readVerifiedCasBlob(f.cas, pointer.bodyDigest)),
      );
      const approvalPath = f.path.join(yield* f.fs.realPath(f.path.join(f.repository, '..')), 'auto-approval.json');
      yield* writePrivateJsonFile(approvalPath, {
        accessMode: 'join',
        contribution: {declared: profile.contribution, effectiveMode: 'passive-on-index'},
        coordinatorUrl: 'http://127.0.0.1:9',
        organization: profile.organization,
        profileDigest: promoted.profileDigest,
        publisherKeyFingerprint: promoted.enrollment.publisherKeyFingerprint,
        registry: profile.registry,
        repositoryId: promoted.enrollment.repositoryId,
        schemaVersion: 1,
        source: profile.source,
      });
      const identity = yield* resolveRepositoryIdentity(f.repository);
      const home = f.path.join(f.repository, '..', 'auto-client-home');
      const clientConfig = {...f.config, agentContextHome: home};
      const system = yield* SystemInfo;
      const ordinaryUse = () =>
        f.registry.provide(
          maybeImportSharedGraphBase({cwd: f.repository, identity, threadnoteHome: home}).pipe(
            Effect.provideService(SystemInfo, {
              ...system,
              environment: () => ({
                ...system.environment(),
                DOCKER_CONFIG: f.registry.docker,
                THREADNOTE_GRAPH_APPROVAL_FILE: approvalPath,
              }),
            }),
          ),
        );
      yield* ordinaryUse();
      const trust = yield* lookupGraphShareTrustReceipt(home, identity.repositoryId);
      expect(trust?.accessMode).toBe('join');
      expect(trust?.client?.contributionMode).toBe('passive');
      expect(trust?.client?.coordinatorUrl).toBe('http://127.0.0.1:9');
      yield* runGraphShareLeave(clientConfig, {cwd: f.repository});
      expect(yield* lookupGraphShareTrustReceipt(home, identity.repositoryId)).toBeUndefined();
      const requestsBeforeRevokedUse = f.registry.requests.length;
      expect((yield* ordinaryUse()).reason).toBe('untrusted');
      expect(f.registry.requests).toHaveLength(requestsBeforeRevokedUse);
      expect(yield* lookupGraphShareTrustReceipt(home, identity.repositoryId)).toBeUndefined();
      const explicit = yield* f.registry.provide(
        runGraphShareJoin(clientConfig, {approvalFile: approvalPath, cwd: f.repository}),
      );
      expect(explicit.accessMode).toBe('join');
      expect((yield* lookupGraphShareTrustReceipt(home, identity.repositoryId))?.accessMode).toBe('join');
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('bootstraps from the promoted v2 pointer only while its persisted manifest remains verified', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const promoted = yield* f.promote();
      yield* f.fs.writeFileString(f.enrollmentPath, `${JSON.stringify(promoted.enrollment, undefined, 2)}\n`);
      yield* f.git(['add', '.threadnote/graph-share.json']);
      yield* f.commit('enroll verified OCI profile');
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({
        cwd: f.repository,
        ensureVectors: false,
        force: true,
        threadnoteHome: f.config.agentContextHome,
      });
      const manifestPath = graphSharingCasBlobPath(
        f.path,
        f.cas,
        Effect2.pipe(promoted.manifestDigest, EffectString.slice('sha256:'.length)),
      );
      const manifestBytes = yield* f.fs.readFile(manifestPath);
      yield* f.fs.remove(manifestPath);
      const requestsBefore = f.registry.requests.length;
      const frontierPath = graphSharingFrontierPointerPath(
        f.path,
        graphSharingLayout(f.path, f.config.agentContextHome, f.cas).frontiersRoot,
        promoted.enrollment.repositoryId,
      );
      expect(
        yield* rejected(f.registry.provide(runGraphPublisherBootstrap(f.config, {cas: f.cas, cwd: f.repository}))),
      ).toBeInstanceOf(Error);
      expect(f.registry.requests).toHaveLength(requestsBefore);
      expect(yield* f.fs.exists(frontierPath)).toBe(false);
      yield* f.fs.writeFile(manifestPath, manifestBytes);
      const bootstrapped = yield* f.registry.provide(
        runGraphPublisherBootstrap(f.config, {cas: f.cas, cwd: f.repository}),
      );
      expect(bootstrapped.profileDigest).toBe(promoted.profileDigest);
      expect(bootstrapped.publication.status).toBe('acknowledged');
      expect(yield* f.fs.exists(frontierPath)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('rejects mismatched repository, key, and registry before any registry request', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const identity = yield* resolveRepositoryIdentity(f.repository);
      expect(identity.repositoryId).toBe(f.enrollment.repositoryId);
      const cases = [
        {
          enrollment: {...f.enrollment, repositoryId: Effect2.pipe('f', EffectString.repeat(64))},
          message: /repository|enrollment/iu,
          registry: canonicalRegistry,
        },
        {
          enrollment: {...f.enrollment, publisherKeyFingerprint: sha256Digest('different publisher key')},
          message: /authority|publisher key|profile/iu,
          registry: canonicalRegistry,
        },
        {
          enrollment: f.enrollment,
          message: /authority|registry/iu,
          registry: workerRegistry,
        },
      ];
      for (const candidate of cases) {
        yield* writePrivateJsonFile(f.enrollmentPath, candidate.enrollment);
        const pointerBeforePromotion = yield* f.fs.readFileString(f.enrollmentPath);
        const failure = yield* rejected(f.promote(candidate.registry));
        expect(failure).toMatchObject({kind: 'verification-failed', message: expect.stringMatching(candidate.message)});
        expect(f.registry.requests).toHaveLength(0);
        expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(pointerBeforePromotion);
      }
      yield* writePrivateJsonFile(f.enrollmentPath, f.enrollment);
      expect(parseGraphShareEnrollment(yield* readJsonFile(f.enrollmentPath))).toEqual(f.enrollment);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('validates both exact, distinct OCI init references before writing an enrollment pointer', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* repositoryFixture();
      const enrollmentPath = graphShareEnrollmentPath(f.path, f.repository);
      const cases = [
        {registry: canonicalRegistry, message: /both --registry and --worker-registry/iu},
        {workerRegistry, message: /both --registry and --worker-registry/iu},
        {
          registry: canonicalRegistry,
          workerRegistry: canonicalRegistry,
          message: /must differ/iu,
        },
        {
          registry: 'oci://publisher:secret@registry.example.test/acme/canonical',
          workerRegistry,
          message: /canonical OCI registry reference is invalid/iu,
        },
        {
          registry: 'oci://Registry.example.test/acme/canonical',
          workerRegistry,
          message: /canonical OCI registry reference is invalid/iu,
        },
      ];
      for (const invalid of cases) {
        const failure = yield* rejected(
          runGraphShareInit(f.config, {
            cas: f.cas,
            cwd: f.repository,
            organization: 'acme',
            writeConfig: true,
            ...invalid,
          }),
        );
        expect(failure).toMatchObject({kind: 'verification-failed', message: expect.stringMatching(invalid.message)});
        expect(yield* f.fs.exists(enrollmentPath)).toBe(false);
      }
      const keyPath = graphSharingLayout(f.path, f.config.agentContextHome, f.cas).publisherKeyPath;
      expect(yield* f.fs.exists(keyPath)).toBe(false);
      expect((yield* f.git(['status', '--porcelain'])).stdout).toBe('');
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('rejects a missing persisted signing key before any registry request', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.remove(f.keyPath);
      const failure = yield* rejected(f.promote());
      expect(failure).toMatchObject({
        kind: 'verification-failed',
        message: expect.stringMatching(/persisted publisher signing key/iu),
      });
      expect(f.registry.requests).toHaveLength(0);
      expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(f.enrollmentBytes);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);
