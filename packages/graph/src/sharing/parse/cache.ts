import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Path, Random, Schema} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import type {BoundedCodeGraphFact} from '../../fact/budget.js';
import type {CodeGraphStoreShape} from '../../store/shape.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../../store/models.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from '../../types.js';
import {graphShareLanguageAndRole, graphShareParseActionKey} from '../action.js';
import {decodeJsonBytes} from '../atomic.js';
import {putCasBytes, readVerifiedCasBlob} from '../cas.js';
import {
  graphShareControlAnnounceResult,
  graphShareControlGetCas,
  graphShareControlGetStatus,
  graphShareControlPutCas,
  graphShareControlPutTag,
  mirrorCoordinatorCasBlob,
} from '../control/client.js';
import type {GraphShareResultAnnouncementV1} from '../receipts.js';
import {
  enqueuePersistedGraphShareContribution,
  acknowledgeGraphShareContributions,
  effectiveGraphShareContributionMode,
  effectiveGraphShareContributionPolicy,
  readGraphShareContributionQueue,
  prunePersistedGraphShareContributionQueue,
} from '../contribution.js';
import {sha256Digest, sha256HexFromDigest, type Sha256Digest} from '../digest.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../oci.js';
import {graphSharingFailure, graphSharingHttpFailure, GraphSharingError} from '../errors.js';
import {isGraphShareGitObjectId} from '../git.js';
import {graphShareActionDiscoveryTag} from '../namespace.js';
import {graphShareParseResultArtifact, parseGraphShareParseResult, type GraphShareParseResultV1} from './result.js';
import {lookupGraphShareTrustReceipt} from '../trust.js';
import {resolveGraphShareRepositoryClient} from '../client/state.js';
import {readTrustedGraphShareContributionProfile} from '../profile/storage.js';
import {graphSharingContributionQueuePath, graphSharingLayout} from '../layout.js';
import {persistGraphSharePendingSignedCandidates, type GraphSharePendingSignedCandidate} from '../signed/candidate.js';
import {usesSignedGraphWorkerDelivery} from '../worker/delivery.js';
import {
  graphShareContributionRetryDelay,
  readContributionRetryState,
  writeContributionRetryState,
} from '../contribution/retry_state.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const enqueueLocalGraphShareParseResults = Effect.fn('codeGraph.sharing.enqueueLocalParseResults')(
  function* (input: {
    readonly extractorSet: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
    readonly identity: Pick<RepositoryIdentity, 'headCommit' | 'repositoryId'>;
    readonly producer: {
      readonly platform: {readonly os: string; readonly architecture: string};
      readonly releaseIdentity: string;
    };
    readonly threadnoteHome: string;
  }) {
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
    if (trust?.accessMode !== 'join') return {queued: 0};
    const state = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, trust);
    const mode = effectiveGraphShareContributionMode(trust?.accessMode, state.contributionMode ?? 'off');
    if (mode === 'off') return {queued: 0};
    const casRoot = state.casRoot;
    const factsByPath = new Map(EffectArray.map(input.facts, fact => [fact.facts.path, fact]));
    const batchId = Effect2.pipe(input.identity.headCommit, EffectString.slice(0, 40));
    if (!/^[0-9a-f]{40}$/u.test(batchId)) return {queued: 0};
    const prepared: Array<{
      readonly artifact: GraphShareParseResultV1;
      readonly candidate?: GraphSharePendingSignedCandidate;
      readonly resultManifestDigest: Sha256Digest;
    }> = [];
    for (const file of input.files) {
      if (file.source !== 'commit' || !isGraphShareGitObjectId(file.blobId) || file.contentHash.length !== 64) continue;
      const fact = factsByPath.get(file.path);
      if (fact === undefined) continue;
      const artifact = graphShareParseResultArtifact({
        actionKey: graphShareParseActionKey({
          contentHash: file.contentHash,
          extractorSet: input.extractorSet,
          languageAndRole: graphShareLanguageAndRole(file.language, 'source'),
          normalizedPath: file.path,
          repositoryId: input.identity.repositoryId,
        }),
        contentHash: file.contentHash,
        extractorSet: input.extractorSet,
        facts: fact.facts,
        gitBlobId: file.blobId,
        languageAndRole: graphShareLanguageAndRole(file.language, 'source'),
        normalizedPath: file.path,
        repositoryId: input.identity.repositoryId,
      });
      const resultBytes = new TextEncoder().encode(canonicalJson(artifact));
      const resultManifestDigest = yield* putCasBytes(casRoot, resultBytes);
      const platform = parseSupportedPlatform(input.producer.platform);
      const candidate: GraphSharePendingSignedCandidate | undefined =
        platform !== undefined && input.producer.releaseIdentity !== 'unknown'
          ? {
              actionKey: artifact.actionKey,
              batchId,
              casRoot,
              extractorSet: input.extractorSet,
              organization: trust.organization,
              platform,
              profileDigest: trust.profileDigest,
              queuedAtMilliseconds: yield* Clock.currentTimeMillis,
              releaseIdentity: input.producer.releaseIdentity,
              resultDigest: resultManifestDigest,
              resultSize: resultBytes.byteLength,
              semanticDigest: artifact.semanticDigest,
              sourceCommit: input.identity.headCommit,
            }
          : undefined;
      prepared.push({artifact, resultManifestDigest, ...(candidate === undefined ? {} : {candidate})});
    }
    // The private producer journal must be durable before cacheFacts can make these results reusable.
    yield* persistGraphSharePendingSignedCandidates({
      candidates: EffectArray.flatMap(prepared, item => (item.candidate === undefined ? [] : [item.candidate])),
      repositoryId: input.identity.repositoryId,
      threadnoteHome: input.threadnoteHome,
    });
    let queued = 0;
    for (const {artifact, resultManifestDigest} of prepared) {
      const enqueued = yield* Effect.gen(function* () {
        const attestationDigest = yield* putCasBytes(
          casRoot,
          new TextEncoder().encode(
            canonicalJson({kind: 'contributor-self', payloadDigest: resultManifestDigest, schemaVersion: 1}),
          ),
        );
        return yield* enqueuePersistedGraphShareContribution(
          input.threadnoteHome,
          input.identity.repositoryId,
          trust.accessMode,
          {
            actionKey: artifact.actionKey,
            attestationDigest,
            batchId,
            resultManifestDigest,
            semanticDigest: artifact.semanticDigest,
          },
          mode,
        );
      }).pipe(Effect.option);
      if (enqueued._tag === 'Some' && enqueued.value.queued) queued += 1;
    }
    return {queued};
  },
);

export const drainQueuedGraphShareContributions = Effect.fn('codeGraph.sharing.drainQueuedContributions')(
  function* (input: {
    readonly identity: Pick<RepositoryIdentity, 'repositoryId'>;
    readonly threadnoteHome: string;
    readonly propagateUnavailable?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = graphSharingLayout(path, input.threadnoteHome).root;
    const lockPath = `${graphSharingContributionQueuePath(path, root, input.identity.repositoryId)}.delivery.lock`;
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
    if (trust === undefined) return {sent: 0};
    if (usesSignedGraphWorkerDelivery(trust)) return {sent: 0};
    if (trust.accessMode === 'read-only') {
      yield* prunePersistedGraphShareContributionQueue(input.threadnoteHome, input.identity.repositoryId, 'off');
      return {sent: 0};
    }
    yield* fs.makeDirectory(path.dirname(lockPath), {recursive: true, mode: 0o700});
    return yield* withExclusiveFileLock(
      fs,
      lockPath,
      {
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 30_000,
        waitTimeoutMilliseconds: 0,
      },
      drainContributionBatch(input).pipe(Effect.timeout(30_000)),
    ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed({sent: 0})));
  },
);

const drainContributionBatch = Effect.fn('codeGraph.sharing.drainContributionBatch')(function* (input: {
  readonly identity: Pick<RepositoryIdentity, 'repositoryId'>;
  readonly threadnoteHome: string;
  readonly propagateUnavailable?: boolean;
}) {
  const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
  if (trust?.accessMode !== 'join') return {sent: 0};
  const state = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, trust);
  const mode = effectiveGraphShareContributionMode(trust.accessMode, state.contributionMode);
  yield* prunePersistedGraphShareContributionQueue(input.threadnoteHome, input.identity.repositoryId, mode);
  if (mode === 'off' || state.coordinatorUrl === undefined) return {sent: 0};
  const profile = yield* readTrustedGraphShareContributionProfile(trust, state.casRoot);
  if (
    effectiveGraphShareContributionPolicy(
      trust.accessMode,
      state.contributionMode,
      profile.contribution.maximumUploadBytesPerSecond,
    ).deliveryPausedReason !== undefined
  )
    return {sent: 0};
  const queue = yield* readGraphShareContributionQueue(input.threadnoteHome, input.identity.repositoryId, mode);
  if (queue.announcements.length === 0) return {sent: 0};
  const identity = sha256Digest(JSON.stringify({trust, state}));
  const retry = yield* readContributionRetryState(input.threadnoteHome, input.identity.repositoryId);
  const previous = retry?.identity === identity ? retry : undefined;
  if (previous !== undefined && previous.nextAttempt > (yield* Clock.currentTimeMillis)) return {sent: 0};
  const casRoot = state.casRoot;
  const coordinatorUrl = state.coordinatorUrl;
  const sent: GraphShareResultAnnouncementV1[] = [];
  const discarded: GraphShareResultAnnouncementV1[] = [];
  const stillAuthorized = Effect.gen(function* () {
    const currentTrust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
    if (currentTrust?.accessMode !== 'join' || currentTrust.profileDigest !== trust.profileDigest) return false;
    const current = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, currentTrust);
    return (
      current.contributionMode !== 'off' && current.coordinatorUrl === coordinatorUrl && current.casRoot === casRoot
    );
  });
  return yield* Effect.gen(function* () {
    for (const announcement of queue.announcements.slice(0, 8)) {
      if (!(yield* stillAuthorized)) break;
      const prepared = yield* prepareContributionArtifacts(casRoot, input.identity.repositoryId, announcement).pipe(
        Effect.catchIf(
          error => Schema.is(GraphSharingError)(error),
          () => Effect.void,
        ),
      );
      if (prepared === undefined) {
        discarded.push(announcement);
        continue;
      }
      const drained = yield* drainOneAnnouncement(prepared, coordinatorUrl, announcement, stillAuthorized);
      if (drained) sent.push(announcement);
      else break;
    }
    if (retry !== undefined)
      yield* writeContributionRetryState(input.threadnoteHome, input.identity.repositoryId, undefined);
    return {sent: sent.length};
  }).pipe(
    Effect.timeout(25_000),
    Effect.catch(error =>
      Effect.gen(function* () {
        const failure = Schema.is(GraphSharingError)(error) ? error : undefined;
        const failures = Math.min(7, (previous?.failures ?? 0) + 1);
        const authorizationFailed = failure?.httpStatus === 401 || failure?.httpStatus === 403;
        const delay = authorizationFailed
          ? Math.max(3_600_000, failure?.retryAfterMilliseconds ?? 0)
          : graphShareContributionRetryDelay(failures, yield* Random.next, failure?.retryAfterMilliseconds);
        yield* writeContributionRetryState(input.threadnoteHome, input.identity.repositoryId, {
          identity,
          failures,
          nextAttempt: Math.min(Number.MAX_SAFE_INTEGER, (yield* Clock.currentTimeMillis) + delay),
        });
        if (!input.propagateUnavailable && failure?.kind === 'unavailable') return {sent: sent.length};
        return yield* Effect.fail(error);
      }),
    ),
    Effect.ensuring(
      Effect.suspend(() =>
        acknowledgeGraphShareContributions(
          input.threadnoteHome,
          input.identity.repositoryId,
          [...sent, ...discarded],
          mode,
        ),
      ).pipe(Effect.orDie),
    ),
  );
});

export const hydrateSharedParseCache = Effect.fn('codeGraph.sharing.hydrateSharedParseCache')(function* (input: {
  readonly databasePath: string;
  readonly identity: RepositoryIdentity;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(input.databasePath))) return {hydrated: 0};
  const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
  if (trust === undefined) return {hydrated: 0};
  const state = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, trust);
  if (state.coordinatorUrl === undefined) return {hydrated: 0};
  const status = yield* graphShareControlGetStatus(state.coordinatorUrl).pipe(
    Effect.catchIf(
      error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
      () => Effect.void,
    ),
  );
  if (status === undefined || status.repositoryId !== input.identity.repositoryId) return {hydrated: 0};
  const quarantinedActionKeys = quarantinedGraphShareActionKeys(status.receipts);
  const casRoot = state.casRoot;
  let hydrated = 0;
  for (const receipt of status.receipts.slice(0, 256)) {
    if (quarantinedActionKeys.has(receipt.actionKey)) continue;
    const bytes = yield* graphShareControlGetCas(state.coordinatorUrl, receipt.resultManifestDigest).pipe(
      Effect.catchIf(
        error => Schema.is(GraphSharingError)(error),
        () => Effect.void,
      ),
    );
    if (bytes === undefined) continue;
    const parsed = yield* decodeJsonBytes(bytes).pipe(
      Effect.flatMap(value =>
        Effect.try({
          try: () => parseGraphShareParseResult(value),
          catch: cause =>
            Schema.is(GraphSharingError)(cause)
              ? cause
              : graphSharingFailure('Parse-result artifact is invalid.', cause),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      parsed === undefined ||
      !admitsSharedParseCacheHydrate({
        identityRepositoryId: input.identity.repositoryId,
        parsed,
        quarantinedActionKeys,
        receipt,
      })
    ) {
      continue;
    }
    yield* putCasBytes(casRoot, bytes);
    const language = Effect2.pipe(parsed.languageAndRole, EffectString.split(':'))[0] ?? 'unknown';
    yield* input.store.cacheFacts(
      input.databasePath,
      [
        {
          blobId: parsed.gitBlobId,
          contentHash: parsed.contentHash,
          language,
          mode: '100644',
          path: parsed.normalizedPath,
          size: 1,
          source: 'commit',
        },
      ],
      [parsed.facts],
      parsed.extractorSet,
      input.persistentCapacityProtector,
    );
    hydrated += 1;
  }
  return {hydrated};
});

export function quarantinedGraphShareActionKeys(
  receipts: readonly {readonly actionKey: string; readonly semanticDigest: string}[],
): ReadonlySet<string> {
  const digests = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    const existing = digests.get(receipt.actionKey) ?? new Set<string>();
    existing.add(receipt.semanticDigest);
    digests.set(receipt.actionKey, existing);
  }
  return new Set(
    EffectArray.map(
      EffectArray.filter([...digests], ([, semanticDigests]) => semanticDigests.size > 1),
      ([actionKey]) => actionKey,
    ),
  );
}

export interface VerifiedGraphShareParseReceipt {
  readonly announcement: GraphShareResultAnnouncementV1;
  readonly parsed: GraphShareParseResultV1;
}

const readVerifiedGraphShareParseReceipt = Effect.fn('codeGraph.sharing.readVerifiedParseReceipt')(function* (input: {
  readonly announcement: GraphShareResultAnnouncementV1;
  readonly casRoot: string;
  readonly graphAbi?: string;
  readonly repositoryId: string;
}) {
  const resultBytes = yield* readVerifiedCasBlob(input.casRoot, input.announcement.resultManifestDigest);
  if (sha256Digest(resultBytes) !== input.announcement.resultManifestDigest) {
    return yield* graphSharingFailure('Parse-result CAS digest does not match the receipt.');
  }
  const value = yield* decodeJsonBytes(resultBytes);
  const parsed = yield* Effect.try({
    try: () => parseGraphShareParseResult(value),
    catch: () => graphSharingFailure('Parse-result artifact is invalid.'),
  });
  if (
    !admitsSharedParseCacheHydrate({
      identityRepositoryId: input.repositoryId,
      parsed,
      quarantinedActionKeys: new Set(),
      receipt: input.announcement,
    })
  ) {
    return yield* graphSharingFailure('Parse-result action key or repository does not match the receipt.');
  }
  if (parsed.semanticDigest !== input.announcement.semanticDigest) {
    return yield* graphSharingFailure('Parse-result semantic digest does not match the receipt.');
  }
  const attestationBytes = yield* readVerifiedCasBlob(input.casRoot, input.announcement.attestationDigest);
  const attestation = yield* decodeJsonBytes(attestationBytes);
  if (
    sha256Digest(attestationBytes) !== input.announcement.attestationDigest ||
    !isContributorSelfAttestation(attestation, input.announcement.resultManifestDigest)
  ) {
    return yield* graphSharingFailure('Parse-result attestation does not match the receipt.');
  }
  if (input.graphAbi !== undefined && !/^[0-9a-f]{64}$/u.test(input.graphAbi)) {
    return yield* graphSharingFailure('Publisher graph ABI is invalid.');
  }
  return {announcement: input.announcement, parsed, resultBytes, attestationBytes};
});

export const verifyGraphShareParseReceipt = Effect.fn('codeGraph.sharing.verifyParseReceipt')(
  (input: {
    readonly announcement: GraphShareResultAnnouncementV1;
    readonly casRoot: string;
    readonly graphAbi?: string;
    readonly repositoryId: string;
  }) =>
    readVerifiedGraphShareParseReceipt(input).pipe(
      Effect.map(({announcement, parsed}): VerifiedGraphShareParseReceipt => ({announcement, parsed})),
    ),
);

export const hydratePublisherParseCache = Effect.fn('codeGraph.sharing.hydratePublisherParseCache')(function* (input: {
  readonly databasePath: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly store: CodeGraphStoreShape;
  readonly verified: readonly VerifiedGraphShareParseReceipt[];
}) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(input.databasePath)) || input.verified.length === 0) return {hydrated: 0};
  let hydrated = 0;
  for (const item of input.verified) {
    const language = Effect2.pipe(item.parsed.languageAndRole, EffectString.split(':'))[0] ?? 'unknown';
    yield* input.store.cacheFacts(
      input.databasePath,
      [
        {
          blobId: item.parsed.gitBlobId,
          contentHash: item.parsed.contentHash,
          language,
          mode: '100644',
          path: item.parsed.normalizedPath,
          size: 1,
          source: 'commit',
        },
      ],
      [item.parsed.facts],
      item.parsed.extractorSet,
      input.persistentCapacityProtector,
    );
    hydrated += 1;
  }
  return {hydrated};
});

function isContributorSelfAttestation(value: unknown, payloadDigest: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !EffectArray.isArray(value) &&
    JSON.stringify(EffectRecord.keys(value).sort()) === JSON.stringify(['kind', 'payloadDigest', 'schemaVersion']) &&
    'kind' in value &&
    value.kind === 'contributor-self' &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'payloadDigest' in value &&
    value.payloadDigest === payloadDigest
  );
}

function parseSupportedPlatform(platform: {
  readonly os: string;
  readonly architecture: string;
}): GraphSharePendingSignedCandidate['platform'] | undefined {
  if (
    (platform.os !== 'darwin' && platform.os !== 'linux' && platform.os !== 'win32') ||
    (platform.architecture !== 'arm64' && platform.architecture !== 'x64')
  ) {
    return undefined;
  }
  return {os: platform.os, architecture: platform.architecture};
}

export function admitsSharedParseCacheHydrate(input: {
  readonly identityRepositoryId: string;
  readonly parsed: GraphShareParseResultV1;
  readonly quarantinedActionKeys: ReadonlySet<string>;
  readonly receipt: {readonly actionKey: string};
}): boolean {
  if (input.parsed.repositoryId !== input.identityRepositoryId) return false;
  if (input.quarantinedActionKeys.has(input.receipt.actionKey)) return false;
  const expected = graphShareParseActionKey({
    contentHash: input.parsed.contentHash,
    extractorSet: input.parsed.extractorSet,
    languageAndRole: input.parsed.languageAndRole,
    normalizedPath: input.parsed.normalizedPath,
    repositoryId: input.parsed.repositoryId,
  });
  return input.parsed.actionKey === input.receipt.actionKey && input.parsed.actionKey === expected;
}

export const mirrorCoordinatorCasBlobs = Effect.fn('codeGraph.sharing.mirrorCoordinatorCasBlobs')(function* (
  casRoot: string,
  coordinatorUrl: string,
  digests: readonly string[],
) {
  for (const digest of digests) {
    yield* mirrorCoordinatorCasBlob(casRoot, coordinatorUrl, digest);
  }
});

const prepareContributionArtifacts = Effect.fn('codeGraph.sharing.prepareContributionArtifacts')(function* (
  casRoot: string,
  repositoryId: string,
  announcement: GraphShareResultAnnouncementV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [digest, limit] of [
    [announcement.resultManifestDigest, GRAPH_SHARE_HTTP_CAS_MAX_BYTES],
    [announcement.attestationDigest, 65_536],
  ] as const) {
    const target = path.join(casRoot, 'sha256', sha256HexFromDigest(digest));
    if (!(yield* fs.exists(target))) return undefined;
    if (Number((yield* fs.stat(target)).size) > limit)
      return yield* graphSharingFailure('Contribution artifact exceeds the upload read limit.');
  }
  return yield* readVerifiedGraphShareParseReceipt({
    casRoot,
    repositoryId,
    announcement,
  });
});

const drainOneAnnouncement = Effect.fn('codeGraph.sharing.drainOneAnnouncement')(function* (
  prepared: {readonly resultBytes: Uint8Array; readonly attestationBytes: Uint8Array},
  coordinatorUrl: string,
  announcement: GraphShareResultAnnouncementV1,
  stillAuthorized: Effect.Effect<boolean, unknown, FileSystem.FileSystem | Path.Path>,
) {
  const {resultBytes, attestationBytes} = prepared;
  if (!(yield* stillAuthorized)) return false;
  yield* graphShareControlPutCas(coordinatorUrl, resultBytes);
  if (!(yield* stillAuthorized)) return false;
  yield* graphShareControlPutCas(coordinatorUrl, attestationBytes);
  if (!(yield* stillAuthorized)) return false;
  yield* graphShareControlPutTag(
    coordinatorUrl,
    graphShareActionDiscoveryTag(announcement.actionKey),
    announcement.resultManifestDigest,
  ).pipe(
    Effect.catchIf(
      error =>
        Schema.is(GraphSharingError)(error) &&
        error.kind === 'verification-failed' &&
        error.httpStatus !== 401 &&
        error.httpStatus !== 403,
      () => Effect.void,
    ),
  );
  if (!(yield* stillAuthorized)) return false;
  const announced = yield* graphShareControlAnnounceResult(
    coordinatorUrl,
    announcement,
    announcement.resultManifestDigest,
  );
  if (announced.status !== 200 && announced.status !== 201 && announced.status !== 409)
    return yield* graphSharingHttpFailure(announced.status);
  return true;
});
