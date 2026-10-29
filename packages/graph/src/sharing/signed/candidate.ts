import {Array as EffectArray} from 'effect';
import {Effect, Path} from 'effect';
import {codeGraphCheckpointAbiInputV1} from '../../checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../checkpoint/pack.js';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {codeGraphCommittedContentHash} from '../../content_identity.js';
import type {CodeGraphStoreShape} from '../../store/shape.js';
import type {CodeGraphInventoryFile, CodeGraphSnapshot} from '../../types.js';
import {graphShareParseActionKey} from '../action.js';
import {readVerifiedCasBlobBounded} from '../cas.js';
import {SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {graphSharingLayout} from '../layout.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../oci.js';
import {parseGraphShareParseResult, type GraphShareParseResultV1} from '../parse/result.js';
import {lookupGraphShareTrustReceipt} from '../trust.js';
import {resolveGraphShareRepositoryClient} from '../client/state.js';
import {
  acknowledgeSignedCandidateJournalPage,
  appendSignedCandidateJournal,
  listSignedCandidateJournalSegments,
  readSignedCandidateJournalPage,
  SIGNED_CANDIDATE_PAGE_MAXIMUM_ITEMS,
  type SignedCandidateJournalSpec,
} from './candidate_journal.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BATCH = /^[0-9a-f]{40}$/u;
const SNAPSHOT = /^cgsn_[0-9a-f]{40}(?:-[a-z0-9]+)*$/u;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SNAPSHOT_PATH_BATCH = 200;

/** Written before the corresponding raw parser facts become reusable in SQLite. */
export interface GraphSharePendingSignedCandidate {
  readonly actionKey: string;
  readonly batchId: string;
  readonly casRoot: string;
  readonly extractorSet: string;
  readonly organization: string;
  readonly platform: {readonly os: 'darwin' | 'linux' | 'win32'; readonly architecture: 'arm64' | 'x64'};
  readonly profileDigest: string;
  readonly queuedAtMilliseconds: number;
  readonly releaseIdentity: string;
  readonly resultDigest: string;
  readonly resultSize: number;
  readonly semanticDigest: string;
  readonly sourceCommit: string;
}

/** Private producer evidence; sending still requires current authority and a fresh CAS check. */
export interface GraphShareSignedCandidateV2 extends GraphSharePendingSignedCandidate {
  readonly graphAbi: string;
  readonly partialCoverage: boolean;
  readonly resourceLimits: readonly string[];
  readonly snapshotId: string;
}

export interface GraphSharePendingSignedCandidateQueueV1 {
  readonly candidates: readonly GraphSharePendingSignedCandidate[];
  readonly schemaVersion: 1;
}

export interface GraphShareSignedCandidateQueueV2 {
  readonly candidates: readonly GraphShareSignedCandidateV2[];
  readonly schemaVersion: 2;
}

const pendingJournalSpec: SignedCandidateJournalSpec<GraphSharePendingSignedCandidate, 1, 2> = {
  identity: pendingIdentity,
  manifestVersion: 2,
  pageVersion: 1,
  parseLegacy: parseGraphSharePendingSignedCandidateQueue,
  parsePage: parseGraphSharePendingSignedCandidateQueue,
  validCandidate: validPending,
};

const signedJournalSpec: SignedCandidateJournalSpec<GraphShareSignedCandidateV2, 2, 3> = {
  identity: graphShareSignedCandidateIdentity,
  manifestVersion: 3,
  pageVersion: 2,
  parseLegacy: parseGraphShareSignedCandidateQueue,
  parsePage: parseGraphShareSignedCandidateQueue,
  validCandidate: validCandidate,
};

/** The caller must run this before cacheFacts, and must propagate a persistence failure. */
export const persistGraphSharePendingSignedCandidates = Effect.fn('codeGraph.sharing.persistPendingSignedCandidates')(
  function* (input: {
    readonly candidates: readonly GraphSharePendingSignedCandidate[];
    readonly repositoryId: string;
    readonly threadnoteHome: string;
  }) {
    if (input.candidates.length === 0) return {queued: 0};
    if (
      !SHA256_HEX.test(input.repositoryId) ||
      EffectArray.some(input.candidates, candidate => !validPending(candidate))
    )
      return yield* graphSharingFailure('Pending signed candidate evidence is invalid.');
    const path = yield* Path.Path;
    return yield* appendSignedCandidateJournal({
      additions: input.candidates,
      manifestPath: pendingCandidateQueuePath(path, input.threadnoteHome, input.repositoryId),
      spec: pendingJournalSpec,
    });
  },
);

export type GraphShareSignedCandidateStore = Pick<
  CodeGraphStoreShape,
  'effectiveSnapshotFilesByPaths' | 'loadCachedFacts' | 'snapshotPackProvenance'
>;

/** Replays durable pending work after any clean ready result, even when this attempt parsed no files. */
export const finalizeGraphShareSignedCandidates = Effect.fn('codeGraph.sharing.finalizeSignedCandidates')(
  function* (input: {
    readonly databasePath: string;
    readonly repositoryId: string;
    readonly skippedFiles: number;
    readonly snapshot: CodeGraphSnapshot;
    readonly store: GraphShareSignedCandidateStore;
    readonly threadnoteHome: string;
  }) {
    const snapshot = input.snapshot;
    if (
      snapshot.state !== 'ready' ||
      snapshot.dirty ||
      snapshot.repositoryId !== input.repositoryId ||
      !SHA256_HEX.test(input.repositoryId) ||
      !Number.isSafeInteger(input.skippedFiles) ||
      input.skippedFiles < 0
    )
      return {examined: 0, queued: 0, verified: 0};
    const path = yield* Path.Path;
    const pendingPath = pendingCandidateQueuePath(path, input.threadnoteHome, input.repositoryId);
    const pageIds = yield* listSignedCandidateJournalSegments({manifestPath: pendingPath, spec: pendingJournalSpec});
    if (pageIds.length === 0) return {examined: 0, queued: 0, verified: 0};
    const provenance = yield* input.store.snapshotPackProvenance(input.databasePath, snapshot.id);
    if (provenance === undefined) return {examined: 0, queued: 0, verified: 0};
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.repositoryId);
    if (trust?.accessMode !== 'join') return {examined: 0, queued: 0, verified: 0};
    const state = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, trust);
    if (state.contributionMode === 'off') return {examined: 0, queued: 0, verified: 0};
    const graphAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(provenance)).digest;
    const cacheIdentities = new Set(EffectArray.map(provenance, pack => pack.cacheIdentity));
    let examined = 0;
    let queued = 0;
    let verifiedCount = 0;
    for (const id of pageIds) {
      const page = yield* readSignedCandidateJournalPage({id, manifestPath: pendingPath, spec: pendingJournalSpec});
      if (page === undefined) continue;
      examined += page.candidates.length;
      const candidates = page.candidates;
      const relevant = EffectArray.filter(
        candidates,
        (candidate, __effectArrayIndex) =>
          __effectArrayIndex in candidates &&
          candidate.sourceCommit === snapshot.commit &&
          candidate.batchId === Effect2.pipe(candidate.sourceCommit, EffectString.slice(0, 40)) &&
          candidate.profileDigest === trust.profileDigest &&
          candidate.organization === trust.organization &&
          candidate.casRoot === state.casRoot &&
          cacheIdentities.has(candidate.extractorSet),
      );
      if (relevant.length === 0) continue;
      // Parse results, not pending metadata, supply paths. First verify CAS, then batch exact snapshot observations.
      const parsed: Array<{
        readonly candidate: GraphSharePendingSignedCandidate;
        readonly result: GraphShareParseResultV1;
      }> = [];
      for (const candidate of relevant) {
        const result = yield* verifyPendingCasResult(candidate, input.repositoryId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (result !== undefined) parsed.push({candidate, result});
      }
      if (parsed.length === 0) continue;
      const uniquePaths = [...new Set(EffectArray.map(parsed, item => item.result.normalizedPath))];
      const snapshotFiles = new Map<string, CodeGraphInventoryFile>();
      for (let offset = 0; offset < uniquePaths.length; offset += SNAPSHOT_PATH_BATCH) {
        const observed = yield* input.store.effectiveSnapshotFilesByPaths(
          input.databasePath,
          snapshot.id,
          uniquePaths.slice(offset, offset + SNAPSHOT_PATH_BATCH),
        );
        for (const item of observed) if (item.file !== undefined) snapshotFiles.set(item.path, item.file);
      }
      const eligible: Array<{
        candidate: GraphSharePendingSignedCandidate;
        file: CodeGraphInventoryFile;
        result: GraphShareParseResultV1;
      }> = [];
      const filesByExtractor = new Map<string, Map<string, CodeGraphInventoryFile>>();
      for (const {candidate, result} of parsed) {
        const file = snapshotFiles.get(result.normalizedPath);
        const objectFormat =
          result.gitBlobId.length === 40 ? 'sha1' : result.gitBlobId.length === 64 ? 'sha256' : undefined;
        if (
          !file ||
          file.source !== 'commit' ||
          objectFormat === undefined ||
          file.contentHash !== result.contentHash ||
          file.contentHash !== codeGraphCommittedContentHash(objectFormat, result.gitBlobId)
        )
          continue;
        eligible.push({candidate, file, result});
        const group = filesByExtractor.get(candidate.extractorSet) ?? new Map<string, CodeGraphInventoryFile>();
        group.set(file.path, file);
        filesByExtractor.set(candidate.extractorSet, group);
      }
      const cachedFactsByKey = new Map<string, unknown>();
      for (const [extractorSet, files] of filesByExtractor) {
        const grouped = [...files.values()];
        for (let offset = 0; offset < grouped.length; offset += SNAPSHOT_PATH_BATCH) {
          const cached = yield* input.store
            .loadCachedFacts(input.databasePath, grouped.slice(offset, offset + SNAPSHOT_PATH_BATCH), extractorSet)
            .pipe(Effect.orElseSucceed(() => undefined));
          for (const [filePath, facts] of cached?.facts ?? [])
            cachedFactsByKey.set(`${extractorSet}\0${filePath}`, facts);
        }
      }
      const verified: GraphShareSignedCandidateV2[] = [];
      for (const {candidate, file, result} of eligible) {
        const cachedFacts = cachedFactsByKey.get(`${candidate.extractorSet}\0${file.path}`);
        if (cachedFacts === undefined || canonicalJson(cachedFacts) !== canonicalJson(result.facts)) continue;
        verified.push({
          ...candidate,
          graphAbi,
          partialCoverage: input.skippedFiles > 0,
          resourceLimits: [],
          snapshotId: snapshot.id,
        });
      }
      if (verified.length === 0) continue;
      const added = yield* persistGraphShareSignedCandidates(input.threadnoteHome, input.repositoryId, verified);
      queued += added.queued;
      verifiedCount += verified.length;
      yield* acknowledgeSignedCandidateJournalPage({
        acceptedIdentities: new Set(EffectArray.map(verified, pendingIdentity)),
        id,
        manifestPath: pendingPath,
        spec: pendingJournalSpec,
      });
    }
    return {examined, queued, verified: verifiedCount};
  },
);

const verifyPendingCasResult = Effect.fn('codeGraph.sharing.verifyPendingCasResult')(function* (
  candidate: GraphSharePendingSignedCandidate,
  repositoryId: string,
) {
  const bytes = yield* readVerifiedCasBlobBounded(candidate.casRoot, candidate.resultDigest, candidate.resultSize);
  if (bytes.byteLength !== candidate.resultSize || bytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES)
    return yield* graphSharingFailure('Pending signed result CAS size is invalid.');
  const result = yield* Effect.try({
    try: () => parseGraphShareParseResult(JSON.parse(new TextDecoder().decode(bytes))),
    catch: () => graphSharingFailure('Pending signed result CAS is invalid.'),
  });
  if (
    new TextDecoder().decode(bytes) !== canonicalJson(result) ||
    result.repositoryId !== repositoryId ||
    result.actionKey !== candidate.actionKey ||
    result.extractorSet !== candidate.extractorSet ||
    result.semanticDigest !== candidate.semanticDigest ||
    graphShareParseActionKey({
      contentHash: result.contentHash,
      extractorSet: result.extractorSet,
      languageAndRole: result.languageAndRole,
      normalizedPath: result.normalizedPath,
      repositoryId,
    }) !== result.actionKey
  )
    return yield* graphSharingFailure('Pending signed result does not match producer identity.');
  return result;
});

export function pendingCandidateQueuePath(path: Path.Path, home: string, repositoryId: string): string {
  return path.join(graphSharingLayout(path, home).root, 'signed-pending', `${repositoryId}.json`);
}

export function signedCandidateQueuePath(path: Path.Path, home: string, repositoryId: string): string {
  return path.join(graphSharingLayout(path, home).root, 'signed-candidates', `${repositoryId}.json`);
}

export const listGraphShareSignedCandidatePageIds = Effect.fn('codeGraph.sharing.listSignedCandidatePages')(function* (
  threadnoteHome: string,
  repositoryId: string,
) {
  if (!SHA256_HEX.test(repositoryId)) return yield* graphSharingFailure('Repository ID is invalid.');
  const path = yield* Path.Path;
  return yield* listSignedCandidateJournalSegments({
    manifestPath: signedCandidateQueuePath(path, threadnoteHome, repositoryId),
    spec: signedJournalSpec,
  });
});

export const readGraphShareSignedCandidatePage = Effect.fn('codeGraph.sharing.readSignedCandidatePage')(function* (
  threadnoteHome: string,
  repositoryId: string,
  id: string,
) {
  if (!SHA256_HEX.test(repositoryId)) return yield* graphSharingFailure('Repository ID is invalid.');
  const path = yield* Path.Path;
  return yield* readSignedCandidateJournalPage({
    id,
    manifestPath: signedCandidateQueuePath(path, threadnoteHome, repositoryId),
    spec: signedJournalSpec,
  });
});

export const acknowledgeGraphShareSignedCandidatePage = Effect.fn('codeGraph.sharing.ackSignedCandidatePage')(
  function* (threadnoteHome: string, repositoryId: string, id: string, acceptedIdentities: ReadonlySet<string>) {
    if (!SHA256_HEX.test(repositoryId)) return yield* graphSharingFailure('Repository ID is invalid.');
    const path = yield* Path.Path;
    return yield* acknowledgeSignedCandidateJournalPage({
      acceptedIdentities,
      id,
      manifestPath: signedCandidateQueuePath(path, threadnoteHome, repositoryId),
      spec: signedJournalSpec,
    });
  },
);

export const persistGraphShareSignedCandidates = Effect.fn('codeGraph.sharing.persistSignedCandidates')(function* (
  threadnoteHome: string,
  repositoryId: string,
  candidates: readonly GraphShareSignedCandidateV2[],
) {
  if (!SHA256_HEX.test(repositoryId)) return yield* graphSharingFailure('Repository ID is invalid.');
  const path = yield* Path.Path;
  return yield* appendSignedCandidateJournal({
    additions: candidates,
    manifestPath: signedCandidateQueuePath(path, threadnoteHome, repositoryId),
    spec: signedJournalSpec,
  });
});

function isPendingSignedCandidateQueue(value: unknown): value is GraphSharePendingSignedCandidateQueueV1 {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    EffectArray.isArray(value.candidates) &&
    value.candidates.length <= SIGNED_CANDIDATE_PAGE_MAXIMUM_ITEMS &&
    !EffectArray.some(value.candidates, candidate => !validPending(candidate)) &&
    EffectArray.join(EffectRecord.keys(value).sort(), ',') === 'candidates,schemaVersion'
  );
}

export function parseGraphSharePendingSignedCandidateQueue(value: unknown): GraphSharePendingSignedCandidateQueueV1 {
  if (!isPendingSignedCandidateQueue(value)) {
    throw graphSharingFailure('Pending signed candidate queue is invalid.');
  }
  return value;
}

export function parseGraphShareSignedCandidateQueue(value: unknown): GraphShareSignedCandidateQueueV2 {
  // The pre-release v1 private queue lacked producer profile authority and cannot be signed safely.
  // Treat it as empty so the first verified v2 append replaces it atomically.
  if (isRecord(value) && value.schemaVersion === 1 && EffectArray.isArray(value.candidates))
    return {candidates: [], schemaVersion: 2};
  if (!isSignedCandidateQueue(value)) {
    throw graphSharingFailure('Signed candidate queue is invalid.');
  }
  return value;
}

function isSignedCandidateQueue(value: unknown): value is GraphShareSignedCandidateQueueV2 {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    EffectArray.isArray(value.candidates) &&
    value.candidates.length <= SIGNED_CANDIDATE_PAGE_MAXIMUM_ITEMS &&
    !EffectArray.some(value.candidates, candidate => !validCandidate(candidate)) &&
    EffectArray.join(EffectRecord.keys(value).sort(), ',') === 'candidates,schemaVersion'
  );
}

function validPending(value: unknown): value is GraphSharePendingSignedCandidate {
  return (
    isRecord(value) &&
    EffectArray.join(EffectRecord.keys(value).sort(), ',') ===
      'actionKey,batchId,casRoot,extractorSet,organization,platform,profileDigest,queuedAtMilliseconds,releaseIdentity,resultDigest,resultSize,semanticDigest,sourceCommit' &&
    typeof value.actionKey === 'string' &&
    SHA256_HEX.test(value.actionKey) &&
    typeof value.batchId === 'string' &&
    BATCH.test(value.batchId) &&
    typeof value.casRoot === 'string' &&
    value.casRoot.length > 0 &&
    value.casRoot.length <= 4096 &&
    typeof value.extractorSet === 'string' &&
    SHA256_HEX.test(value.extractorSet) &&
    typeof value.organization === 'string' &&
    ORGANIZATION.test(value.organization) &&
    validPlatform(value.platform) &&
    typeof value.profileDigest === 'string' &&
    SHA256_DIGEST.test(value.profileDigest) &&
    typeof value.queuedAtMilliseconds === 'number' &&
    Number.isSafeInteger(value.queuedAtMilliseconds) &&
    value.queuedAtMilliseconds >= 0 &&
    typeof value.releaseIdentity === 'string' &&
    RELEASE.test(value.releaseIdentity) &&
    value.releaseIdentity !== 'unknown' &&
    typeof value.resultDigest === 'string' &&
    SHA256_DIGEST.test(value.resultDigest) &&
    typeof value.resultSize === 'number' &&
    Number.isSafeInteger(value.resultSize) &&
    value.resultSize > 0 &&
    value.resultSize <= GRAPH_SHARE_HTTP_CAS_MAX_BYTES &&
    typeof value.semanticDigest === 'string' &&
    SHA256_DIGEST.test(value.semanticDigest) &&
    typeof value.sourceCommit === 'string' &&
    COMMIT.test(value.sourceCommit) &&
    value.batchId === Effect2.pipe(value.sourceCommit, EffectString.slice(0, 40))
  );
}

function validCandidate(value: unknown): value is GraphShareSignedCandidateV2 {
  if (!isRecord(value)) return false;
  const {graphAbi, partialCoverage, resourceLimits, snapshotId, ...pending} = value;
  return (
    validPending(pending) &&
    EffectRecord.keys(value).length === 17 &&
    typeof graphAbi === 'string' &&
    SHA256_HEX.test(graphAbi) &&
    typeof partialCoverage === 'boolean' &&
    EffectArray.isArray(resourceLimits) &&
    resourceLimits.length === 0 &&
    typeof snapshotId === 'string' &&
    SNAPSHOT.test(snapshotId)
  );
}

function validPlatform(value: unknown): value is GraphSharePendingSignedCandidate['platform'] {
  return (
    isRecord(value) &&
    EffectArray.join(EffectRecord.keys(value).sort(), ',') === 'architecture,os' &&
    (value.os === 'darwin' || value.os === 'linux' || value.os === 'win32') &&
    (value.architecture === 'arm64' || value.architecture === 'x64')
  );
}

function pendingIdentity(value: GraphSharePendingSignedCandidate): string {
  return JSON.stringify([
    value.actionKey,
    value.resultDigest,
    value.sourceCommit,
    value.semanticDigest,
    value.casRoot,
    value.profileDigest,
    value.organization,
    value.releaseIdentity,
  ]);
}

export function graphShareSignedCandidateIdentity(value: GraphShareSignedCandidateV2): string {
  return JSON.stringify([pendingIdentity(value), value.graphAbi, value.partialCoverage, value.snapshotId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
