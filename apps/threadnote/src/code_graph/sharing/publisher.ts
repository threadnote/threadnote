import {Crypto, Effect, FileSystem, Path} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {runCodeGraphCheckpointExport} from '../checkpoint/commands.js';
import type {CliOutput} from '../../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  generateGraphSharePublisherKey,
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  parseGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
  type GraphSharePublisherKeyV1,
} from '@threadnote/graph/sharing/artifacts';
import {
  decodeJsonBytes,
  readJsonFile,
  writeDurablePrivateJsonFile,
  writePrivateJsonFile,
} from '@threadnote/graph/sharing/atomic';
import {putCasBytes, putCasFile, readVerifiedCasBlob} from '@threadnote/graph/sharing/cas';
import {putGraphShareCheckpointLayers} from '@threadnote/graph/sharing/checkpoint_cas';
import {putSignedGraphShareFrontierDocuments} from '@threadnote/graph/sharing/descriptor';
import {parseSha256Digest, type Sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphSharingFailure} from '@threadnote/graph/sharing/errors';
import {
  parseGraphShareListenAddress,
  recordPublishedFrontier,
  runGraphShareControlServer,
  withCoordinatorStateLock,
} from '@threadnote/graph/sharing/control/server';
import {
  graphShareEnrollmentPath,
  graphSharingFrontierPointerPath,
  graphSharingLayout,
} from '@threadnote/graph/sharing/layout';
import {
  assertEnrollmentMatchesIdentity,
  enrolledProfileBodyDigest,
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareCoordinatorUrl,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  ociProfilePointer,
  type GraphShareEnrollment,
  type GraphShareEnrollmentV2,
  type GraphShareProfileV1,
} from '@threadnote/graph/sharing/profile';
import {
  advanceGraphPublisherFrontier,
  ensureGraphSharePublishedOciDescriptor,
} from '@threadnote/graph/sharing/publisher/cycle';
import {resolveGraphShareCasRoot, writeGraphShareClientState} from '@threadnote/graph/sharing/trust';
import {validateGraphControlPolicy} from '@threadnote/graph/sharing/control/reader';
import {completeGraphPublisherRegistryPublication} from '@threadnote/graph/sharing/publisher/registry';
import {
  graphShareRegistryPublicationScope,
  type GraphShareRegistryPublicationResult,
} from '@threadnote/graph/sharing/registry/publication';
import {readAuthenticatedGraphShareFrontier} from '@threadnote/graph/sharing/frontier_acceptance';
import {graphWorkerRegistryForProfile} from '@threadnote/graph/sharing/worker/registry_upload';
import {publishGraphShareProfileArtifact} from '@threadnote/graph/sharing/profile/publication';
import {makeGraphShareRegistryReader} from '@threadnote/graph/sharing/registry/reader';
import {makeGraphShareRegistryWriter} from '@threadnote/graph/sharing/registry/writer';
import {parseGraphShareRegistryTarget} from '@threadnote/graph/sharing/registry/reference';
import {readGraphShareEnrolledProfile} from '@threadnote/graph/sharing/profile/storage';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GraphShareInitOptions {
  readonly cas?: string;
  readonly coordinator?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly organization?: string;
  readonly registry?: string;
  readonly workerRegistry?: string;
  readonly writeConfig?: boolean;
}

export interface GraphPublisherBootstrapOptions {
  readonly authorizationPolicy?: string;
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly listen?: string;
}

export interface GraphPublisherProfilePromoteOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly registry: string;
}

export const runGraphPublisherProfilePromote = Effect.fn('codeGraph.sharing.promotePublisherProfile')(function* (
  config: RuntimeConfig,
  options: GraphPublisherProfilePromoteOptions,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  if (enrollment.schemaVersion !== 1)
    return yield* graphSharingFailure('Profile promotion requires a staged v1 CAS enrollment.');
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  if (!(yield* fs.exists(layout.publisherKeyPath)))
    return yield* graphSharingFailure('Profile promotion requires the persisted publisher signing key.');
  const key = parseGraphSharePublisherKey(yield* readJsonFile(layout.publisherKeyPath));
  const profile = yield* readGraphShareEnrolledProfile(casRoot, enrollment);
  if (
    key.fingerprint !== enrollment.publisherKeyFingerprint ||
    profile.source.canonicalRemote !== identity.remoteIdentity ||
    profile.registry.canonical !== options.registry
  )
    return yield* graphSharingFailure('Publisher profile promotion authority does not match the staged enrollment.');
  yield* Effect.try({
    try: () =>
      graphWorkerRegistryForProfile(profile, {
        profileDigest: graphShareProfileDigest(profile),
        repositoryId: identity.repositoryId,
      }),
    catch: () => graphSharingFailure('Publisher profile worker registry overlaps or exceeds its enrolled namespace.'),
  });
  const writer = yield* makeGraphShareRegistryWriter(options.registry);
  const reader = yield* makeGraphShareRegistryReader(options.registry);
  const artifact = yield* publishGraphShareProfileArtifact(profile, writer, reader);
  yield* putCasBytes(casRoot, artifact.manifestBytes);
  const candidate: GraphShareEnrollmentV2 = {
    profile: ociProfilePointer(options.registry, artifact.manifestDigest),
    profileDigest: artifact.profileDigest,
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: identity.repositoryId,
    schemaVersion: 2,
  };
  return {enrollment: candidate, manifestDigest: artifact.manifestDigest, profileDigest: artifact.profileDigest};
});

export const runGraphShareInit = Effect.fn('codeGraph.sharing.init')(function* (
  config: RuntimeConfig,
  options: GraphShareInitOptions,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (identity.remoteIdentity === undefined) {
    return yield* graphSharingFailure(
      'Graph share init requires a credential-free origin remote such as github.com/org/repository.',
    );
  }
  if ((options.registry === undefined) !== (options.workerRegistry === undefined))
    return yield* graphSharingFailure('Specify both --registry and --worker-registry for OCI profile staging.');
  const canonicalReference = options.registry;
  const workerReference = options.workerRegistry;
  if (canonicalReference !== undefined && workerReference !== undefined) {
    const registry = yield* Effect.try({
      try: () => parseGraphShareRegistryTarget(canonicalReference),
      catch: () => graphSharingFailure('Canonical OCI registry reference is invalid.'),
    });
    const worker = yield* Effect.try({
      try: () => parseGraphShareRegistryTarget(workerReference),
      catch: () => graphSharingFailure('Worker OCI registry reference is invalid.'),
    });
    if (registry.origin === worker.origin && registry.repository === worker.repository)
      return yield* graphSharingFailure('Canonical and worker OCI registry repositories must differ.');
  }
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const key = yield* loadOrCreatePublisherKey(config.agentContextHome);
  const branch = identity.branch === undefined ? 'refs/heads/main' : `refs/heads/${identity.branch}`;
  const defaults = defaultGraphShareProfile({
    branch,
    canonicalRemote: identity.remoteIdentity,
    ...(options.coordinator === undefined ? {} : {coordinatorUrl: parseGraphShareCoordinatorUrl(options.coordinator)}),
    organization:
      Effect2.pipe(options.organization, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || 'local',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: identity.repositoryId,
  });
  const profile =
    canonicalReference === undefined || workerReference === undefined
      ? defaults
      : parseGraphShareProfile({
          ...defaults,
          registry: {canonical: canonicalReference, worker: workerReference},
        });
  const profileDigest = graphShareProfileDigest(profile);
  yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(profile)));
  const enrollment: GraphShareEnrollment = {
    profile: casProfilePointer(profileDigest),
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: identity.repositoryId,
    schemaVersion: 1,
  };
  const enrollmentPath = graphShareEnrollmentPath(path, identity.repoRoot);
  if (options.writeConfig) {
    if (yield* fs.exists(enrollmentPath)) {
      return yield* graphSharingFailure(`Enrollment file already exists: ${enrollmentPath}`);
    }
    yield* fs.makeDirectory(path.dirname(enrollmentPath), {recursive: true, mode: 0o755});
    yield* fs.writeFileString(enrollmentPath, `${JSON.stringify(enrollment, undefined, 2)}\n`);
  }
  return {
    enrollment,
    enrollmentPath,
    profileDigest,
    publisherKeyFingerprint: key.fingerprint,
    type: 'code-graph-share-init' as const,
    version: 1 as const,
    written: Boolean(options.writeConfig),
  };
});

export const runGraphPublisherBootstrap = Effect.fn('codeGraph.sharing.publisherBootstrap')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const candidate = yield* bootstrapGraphPublisherCandidate(config, options);
  const publication = yield* completeGraphPublisherRegistryPublication(config, options);
  return {...candidate, publication};
});

const bootstrapGraphPublisherCandidate = Effect.fn('codeGraph.sharing.bootstrapPublisherCandidate')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const key = yield* loadOrCreatePublisherKey(config.agentContextHome);
  if (key.fingerprint !== enrollment.publisherKeyFingerprint) {
    return yield* graphSharingFailure('Publisher key fingerprint does not match enrollment.');
  }
  const profile = yield* readGraphShareEnrolledProfile(casRoot, enrollment);
  const profileDigest = graphShareProfileDigest(profile);
  if (profileDigest !== enrolledProfileBodyDigest(enrollment) || profile.repositoryId !== enrollment.repositoryId) {
    return yield* graphSharingFailure('Published profile digest does not match enrollment.');
  }
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  const existing = Effect.gen(function* () {
    const stored = parseGraphShareFrontierPointer(yield* readJsonFile(pointerPath));
    const current = yield* readAuthenticatedGraphShareFrontier(
      casRoot,
      graphShareRegistryPublicationScope({enrollment, profile}),
      stored,
    );
    if (current.checkpoint.metadataDigest === undefined)
      return yield* graphSharingFailure('Publisher frontier is missing chunk metadata.');
    const documents = yield* ensureGraphSharePublishedOciDescriptor(casRoot, stored, current.checkpoint.metadataDigest);
    return {
      checkpointDigest: current.checkpoint.manifestDigest,
      descriptorDigest: documents.descriptorDigest,
      envelopeDigest: stored.envelopeDigest,
      generation: current.generation,
      manifestDigest: stored.manifestDigest,
      profileDigest,
      sourceCommit: current.sourceCommit,
      type: 'code-graph-publisher-bootstrap' as const,
      version: 1 as const,
    };
  });
  if (yield* fs.exists(pointerPath)) return yield* existing;
  const spool = path.join(casRoot, 'spool', `${yield* crypto.randomUUIDv4()}.cgcp`);
  const exported = yield* runCodeGraphCheckpointExport(config, {cwd, output: spool, quiet: true});
  const checkpointDigest = yield* putCasFile(casRoot, spool);
  yield* fs.remove(spool, {force: true});
  if (checkpointDigest !== parseSha256Digest(exported.artifact.digest)) {
    return yield* graphSharingFailure('Checkpoint CAS digest does not match the exported artifact.');
  }
  const layers = yield* putGraphShareCheckpointLayers(casRoot, checkpointDigest);
  const signed = yield* signGraphShareFrontier(
    key,
    manifestFromExport(exported, checkpointDigest, layers.metadataDigest, {
      branch: profile.source.branches[0] ?? 'refs/heads/main',
      generation: 1,
      previousManifestDigest: null,
      profileDigest,
      publisherFence: 1,
      repositoryId: identity.repositoryId,
    }),
  );
  const metadataBytes = yield* readVerifiedCasBlob(casRoot, layers.metadataDigest);
  const documents = yield* putSignedGraphShareFrontierDocuments(casRoot, signed, metadataBytes);
  return yield* withCoordinatorStateLock(
    {threadnoteHome: config.agentContextHome},
    Effect.gen(function* () {
      if (yield* fs.exists(pointerPath)) return yield* existing;
      yield* writeDurablePrivateJsonFile(pointerPath, {
        envelopeDigest: documents.envelopeDigest,
        manifestDigest: documents.manifestDigest,
        schemaVersion: 1,
      });
      return {
        checkpointDigest,
        descriptorDigest: documents.descriptorDigest,
        envelopeDigest: documents.envelopeDigest,
        generation: 1,
        manifestDigest: documents.manifestDigest,
        profileDigest,
        sourceCommit: exported.sourceCommit,
        type: 'code-graph-publisher-bootstrap' as const,
        version: 1 as const,
      };
    }),
  );
});

export const runGraphPublisherServe = Effect.fn('codeGraph.sharing.publisherServe')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  if (!(yield* fs.exists(pointerPath))) {
    return yield* runGraphPublisherBootstrap(config, options);
  }
  return yield* advanceGraphPublisherFrontier(config, {...options, forceFreeze: true});
});

export const runGraphPublisherListen = Effect.fn('codeGraph.sharing.publisherListen')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions & {
    readonly listen: string;
    readonly onReady: (output: {
      readonly coordinatorUrl: string;
      readonly envelopeDigest: string;
      readonly generation: number;
      readonly listening: true;
      readonly manifestDigest: string;
      readonly port: number;
      readonly publication: GraphShareRegistryPublicationResult;
      readonly sourceCommit: string;
      readonly type: 'code-graph-publisher-serve';
      readonly version: 1;
    }) => Effect.Effect<void, unknown, CliOutput>;
  },
) {
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  const profile = yield* readGraphShareEnrolledProfile(casRoot, enrollment);
  const enableWorkerResults =
    Effect2.pipe(profile.registry.canonical, EffectString.startsWith('oci://')) &&
    Effect2.pipe(profile.registry.worker, EffectString.startsWith('oci://'));
  if (enableWorkerResults)
    yield* Effect.try({
      try: () =>
        graphWorkerRegistryForProfile(profile, {
          profileDigest: graphShareProfileDigest(profile),
          repositoryId: identity.repositoryId,
        }),
      catch: () => graphSharingFailure('Signed graph worker registry overlaps or exceeds its trusted namespace.'),
    });
  const authorization =
    options.authorizationPolicy === undefined
      ? undefined
      : {
          enrollment,
          enableWorkerResults,
          policyFile: path.resolve(options.authorizationPolicy),
          profile,
          repoRoot: identity.repoRoot,
        };
  if (authorization !== undefined) {
    yield* validateGraphControlPolicy({...authorization, casRoot, threadnoteHome: config.agentContextHome});
  }
  const published = yield* runGraphPublisherServe(config, options);
  const branch = profile.source.branches[0] ?? 'refs/heads/main';
  const descriptorDigest =
    published.descriptorDigest ??
    (yield* ensureDescriptorForPointer(config.agentContextHome, casRoot, identity.repositoryId, {
      envelopeDigest: published.envelopeDigest,
      manifestDigest: published.manifestDigest,
    })).descriptorDigest;
  if (published.publication.status !== 'pending')
    yield* recordPublishedFrontier(
      {
        casRoot,
        organization: profile.organization,
        repositoryId: identity.repositoryId,
        threadnoteHome: config.agentContextHome,
      },
      {
        branch,
        descriptorDigest:
          published.publication.acknowledged === undefined
            ? descriptorDigest
            : parseSha256Digest(published.publication.acknowledged.descriptorDigest),
        envelopeDigest:
          published.publication.acknowledged === undefined
            ? published.envelopeDigest
            : parseSha256Digest(published.publication.acknowledged.envelopeDigest),
        generation: published.publication.acknowledged?.generation ?? published.generation,
        manifestDigest:
          published.publication.acknowledged === undefined
            ? published.manifestDigest
            : parseSha256Digest(published.publication.acknowledged.manifestDigest),
        repositoryId: identity.repositoryId,
        sourceCommit: published.publication.acknowledged?.sourceCommit ?? published.sourceCommit,
      },
    );
  return yield* runGraphShareControlServer<
    unknown,
    CliOutput | Effect.Services<ReturnType<typeof advanceGraphPublisherFrontier>>
  >({
    ...(authorization === undefined ? {} : {authorization}),
    casRoot,
    listen: parseGraphShareListenAddress(options.listen),
    onListening: info =>
      options.onReady({
        coordinatorUrl: info.url,
        envelopeDigest: published.envelopeDigest,
        generation: published.generation,
        listening: true,
        manifestDigest: published.manifestDigest,
        port: info.port,
        publication: published.publication,
        sourceCommit: published.sourceCommit,
        type: 'code-graph-publisher-serve',
        version: 1,
      }),
    organization: profile.organization,
    republish: stateRef =>
      advanceGraphPublisherFrontier(config, {
        ...options,
        forceFreeze: false,
        stateRef,
      }).pipe(
        Effect.map(result => ({
          branch,
          descriptorDigest:
            result.publication.acknowledged === undefined
              ? result.descriptorDigest
              : parseSha256Digest(result.publication.acknowledged.descriptorDigest),
          envelopeDigest:
            result.publication.acknowledged === undefined
              ? result.envelopeDigest
              : parseSha256Digest(result.publication.acknowledged.envelopeDigest),
          generation: result.publication.acknowledged?.generation ?? result.generation,
          manifestDigest:
            result.publication.acknowledged === undefined
              ? result.manifestDigest
              : parseSha256Digest(result.publication.acknowledged.manifestDigest),
          published: result.published,
          repositoryId: identity.repositoryId,
          sourceCommit: result.publication.acknowledged?.sourceCommit ?? result.sourceCommit,
        })),
      ),
    repositoryId: identity.repositoryId,
    threadnoteHome: config.agentContextHome,
  });
});

export const loadOrCreatePublisherKey = Effect.fn('codeGraph.sharing.loadOrCreatePublisherKey')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  if (yield* fs.exists(layout.publisherKeyPath)) {
    return parseGraphSharePublisherKey(yield* readJsonFile(layout.publisherKeyPath));
  }
  const key: GraphSharePublisherKeyV1 = yield* generateGraphSharePublisherKey();
  yield* writePrivateJsonFile(layout.publisherKeyPath, key);
  return key;
});

function manifestFromExport(
  exported: {
    readonly graphAbi: string;
    readonly graphContentId: string;
    readonly logicalDigest: string;
    readonly snapshotId: string;
    readonly sourceCommit: string;
  },
  checkpointDigest: Sha256Digest,
  metadataDigest: Sha256Digest,
  meta: {
    readonly branch: string;
    readonly generation: number;
    readonly previousManifestDigest: Sha256Digest | null;
    readonly profileDigest: Sha256Digest;
    readonly publisherFence: number;
    readonly repositoryId: string;
  },
): GraphShareFrontierManifestV1 {
  return {
    branch: meta.branch,
    checkpoint: {
      manifestDigest: checkpointDigest,
      metadataDigest,
      snapshotId: exported.snapshotId,
      sourceCommit: exported.sourceCommit,
    },
    deltas: [],
    generation: meta.generation,
    graphAbi: exported.graphAbi,
    graphContentId: exported.graphContentId,
    logicalGraphDigest: parseSha256Digest(exported.logicalDigest),
    previousManifestDigest: meta.previousManifestDigest,
    profileDigest: meta.profileDigest,
    publisherFence: meta.publisherFence,
    repositoryId: meta.repositoryId,
    schemaVersion: 1,
    snapshotId: exported.snapshotId,
    sourceCommit: exported.sourceCommit,
  };
}

const ensureDescriptorForPointer = Effect.fn('codeGraph.sharing.ensureDescriptorForPointer')(function* (
  threadnoteHome: string,
  casRoot: string,
  repositoryId: string,
  pointer: {readonly envelopeDigest: Sha256Digest; readonly manifestDigest: Sha256Digest},
) {
  const layout = graphSharingLayout(yield* Path.Path, threadnoteHome, casRoot);
  const stored = parseGraphShareFrontierPointer(
    yield* readJsonFile(graphSharingFrontierPointerPath(yield* Path.Path, layout.frontiersRoot, repositoryId)),
  );
  const current = parseGraphShareFrontierManifest(
    yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, stored.manifestDigest)),
  );
  if (current.checkpoint.metadataDigest === undefined) {
    return yield* graphSharingFailure('Published frontier is missing checkpoint metadata for an OCI descriptor.');
  }
  if (stored.manifestDigest !== pointer.manifestDigest || stored.envelopeDigest !== pointer.envelopeDigest) {
    return yield* graphSharingFailure('Frontier pointer does not match the published generation.');
  }
  return yield* ensureGraphSharePublishedOciDescriptor(casRoot, stored, current.checkpoint.metadataDigest);
});

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(
      Effect2.pipe(value, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || system.currentDirectory(),
    );
  });
}

export type {GraphShareProfileV1};
