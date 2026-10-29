import {Clock, Effect, FileSystem, Path, Random, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  type GraphShareFrontierPointerV1,
} from '../artifacts.js';
import {decodeJsonBytes, readBoundedPrivateBytes} from '../atomic.js';
import {graphShareFrontierPointerFromOciDescriptor, parseGraphShareOciDescriptor} from '../descriptor.js';
import {parseSha256Digest} from '../digest.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {
  assertGraphSharePredecessor,
  readAuthenticatedGraphShareFrontier,
  type GraphShareFrontierScope,
} from '../frontier_acceptance.js';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '../layout.js';
import {graphShareFrontierDiscoveryTag} from '../namespace.js';
import {
  assertProfileMatchesEnrollment,
  graphShareProfileDigest,
  type GraphShareEnrollment,
  type GraphShareProfileV1,
} from '../profile.js';
import {
  collectGraphShareRegistryPublication,
  readGraphShareRegistryPublicationBlob,
  type GraphShareRegistryPublication,
} from './closure.js';
import {
  assertGraphSharePublicationProgress,
  graphSharePublicationAuthority,
  graphSharePublicationReceiptPath,
  readGraphSharePublicationReceipt,
  writeGraphSharePublicationReceipt,
  type GraphSharePublicationCandidate,
  type GraphSharePublicationReceipt,
} from './publication_state.js';
import {makeGraphShareRegistryWriter} from './writer.js';
import {uploadGraphShareRegistryArtifacts} from './publication_upload.js';
import {graphShareContributionRetryDelay} from '../contribution/retry_state.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GraphShareRegistryPublicationOptions {
  readonly home: string;
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollment;
  readonly profile: GraphShareProfileV1;
}
export interface GraphShareRegistryPublicationResult {
  readonly changed: boolean;
  readonly status: 'local' | 'pending' | 'acknowledged';
  readonly acknowledged?: GraphSharePublicationCandidate;
  readonly nextAttempt?: number;
  readonly lastFailure?: GraphSharePublicationReceipt['lastFailure'];
}

export function graphShareRegistryPublicationScope(
  input: Pick<GraphShareRegistryPublicationOptions, 'enrollment' | 'profile'>,
): GraphShareFrontierScope {
  const profileDigest = graphShareProfileDigest(input.profile);
  assertProfileMatchesEnrollment(input.profile, input.enrollment, profileDigest);
  return {
    branch: input.profile.source.branches[0],
    profileDigest,
    publisherKeyFingerprint: parseSha256Digest(input.enrollment.publisherKeyFingerprint),
    repositoryId: input.enrollment.repositoryId,
  };
}

/** Registry I/O runs only after local graph assembly has released its mutation locks. */
export const publishGraphShareRegistryFrontier = Effect.fn('codeGraph.sharing.publishRegistryFrontier')(function* (
  input: GraphShareRegistryPublicationOptions,
) {
  if (!Effect2.pipe(input.profile.registry.canonical, EffectString.startsWith('oci://')))
    return {status: 'local', changed: false} satisfies GraphShareRegistryPublicationResult;
  const scope = yield* Effect.try({
    try: () => graphShareRegistryPublicationScope(input),
    catch: () => graphSharingFailure('Registry publisher enrollment is invalid.'),
  });
  const authority = graphSharePublicationAuthority(scope, input.profile.registry.canonical);
  const target = yield* graphSharePublicationReceiptPath(input.home, authority);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    `${target}.lock`,
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 100,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 2_000,
    },
    Effect.gen(function* () {
      let state: GraphSharePublicationReceipt = yield* readGraphSharePublicationReceipt(input.home, authority);
      let changed = false;
      const result = (status: 'pending' | 'acknowledged'): GraphShareRegistryPublicationResult => ({
        status,
        changed,
        acknowledged: state.acknowledged,
        nextAttempt: state.nextAttempt,
        lastFailure: state.lastFailure,
      });
      if ((yield* Clock.currentTimeMillis) < state.nextAttempt) return result('pending');
      const save = (next: GraphSharePublicationReceipt) =>
        writeGraphSharePublicationReceipt(input.home, authority, next).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              state = next;
            }),
          ),
        );
      const attempt = Effect.gen(function* () {
        // Resolve an unknown older promotion before admitting a newer local candidate.
        for (let step = 0; step < 2; step += 1) {
          const pointerPath = graphSharingFrontierPointerPath(
            path,
            graphSharingLayout(path, input.home, input.casRoot).frontiersRoot,
            scope.repositoryId,
          );
          const latest = parseGraphShareFrontierPointer(
            yield* decodeJsonBytes(yield* readBoundedPrivateBytes(pointerPath, 4096)),
          );
          const latestManifest = yield* readAuthenticatedGraphShareFrontier(input.casRoot, scope, latest);
          for (const previous of [state.acknowledged, state.pending]) {
            if (
              previous !== undefined &&
              (latestManifest.generation < previous.generation ||
                latestManifest.publisherFence < previous.publisherFence ||
                (latestManifest.generation === previous.generation && !samePointer(previous, latest)))
            )
              return yield* graphSharingFailure(
                'Local registry candidate rolls back or conflicts with recorded publication.',
              );
          }
          const pointer = state.pending === undefined ? latest : candidatePointer(state.pending);
          const now = yield* Clock.currentTimeMillis;
          const unchanged =
            state.pending === undefined && state.acknowledged !== undefined && samePointer(state.acknowledged, latest);
          if (unchanged && now - state.verifiedAt < 60_000) return result('acknowledged');
          // Complete preflight precedes credentials and HTTP; the confirmed fast path only performs a HEAD.
          const publication = unchanged
            ? undefined
            : yield* collectGraphShareRegistryPublication({
                casRoot: input.casRoot,
                checkpointCount: input.profile.retention.checkpointCount,
                pointer,
                scope,
              });
          const writer = yield* makeGraphShareRegistryWriter(input.profile.registry.canonical);
          const tag = graphShareFrontierDiscoveryTag(scope.repositoryId, scope.branch);
          const remote = yield* writer.headManifest(tag);
          if (unchanged && remote === state.acknowledged?.descriptorDigest) {
            yield* save({
              authority,
              acknowledged: state.acknowledged,
              verifiedAt: now,
              nextAttempt: 0,
              failures: 0,
              schemaVersion: 1,
            });
            return result('acknowledged');
          }
          const prepared =
            publication ??
            (yield* collectGraphShareRegistryPublication({
              casRoot: input.casRoot,
              checkpointCount: input.profile.retention.checkpointCount,
              pointer,
              scope,
            }));
          const candidate = publicationCandidate(prepared);
          for (const previous of [state.acknowledged, state.pending]) {
            if (previous !== undefined)
              yield* Effect.try({
                try: () => assertGraphSharePublicationProgress(previous, candidate),
                catch: () => graphSharingFailure('Registry publication conflicts with recorded progress.'),
              });
          }
          if (remote !== undefined && remote !== candidate.descriptorDigest)
            yield* verifyKnownRegistryPredecessor(input.casRoot, scope, prepared, remote);
          yield* save({...state, pending: candidate});
          yield* uploadGraphShareRegistryArtifacts(prepared, writer, (digest, maximum) =>
            readGraphShareRegistryPublicationBlob(input.casRoot, digest, maximum),
          );
          // Pending survives an unknown tag outcome or a failed durable acknowledgement write.
          yield* writer.putManifest(tag, prepared.descriptorBytes);
          if ((yield* writer.headManifest(tag)) !== prepared.descriptorDigest)
            return yield* graphSharingUnavailable('Registry publication acknowledgement changed before confirmation.');
          yield* save({
            authority,
            acknowledged: candidate,
            failures: 0,
            nextAttempt: 0,
            schemaVersion: 1,
            verifiedAt: yield* Clock.currentTimeMillis,
          });
          changed = true;
          if (samePointer(candidate, latest)) return result('acknowledged');
        }
        return result('pending');
      }).pipe(Effect.timeout('15 minutes'));
      return yield* attempt.pipe(
        Effect.catch(error =>
          Effect.gen(function* () {
            const failures = Math.min(7, state.failures + 1);
            const now = yield* Clock.currentTimeMillis;
            const retryAfter = Schema.is(GraphSharingError)(error) ? (error.retryAfterMilliseconds ?? 0) : 0;
            const delay = graphShareContributionRetryDelay(failures, yield* Random.next, retryAfter);
            yield* save({
              ...state,
              failures,
              nextAttempt: Math.min(Number.MAX_SAFE_INTEGER, now + delay),
              lastFailure: Schema.is(GraphSharingError)(error)
                ? {
                    kind: error.kind,
                    message: Effect2.pipe(error.message, EffectString.slice(0, 512)),
                    ...(error.httpStatus === undefined ? {} : {httpStatus: error.httpStatus}),
                  }
                : {kind: 'unavailable', message: 'Registry publication could not be completed.'},
            });
            return result('pending');
          }),
        ),
      );
    }),
  );
});

export function graphSharePublicationPointer(candidate: GraphSharePublicationCandidate): GraphShareFrontierPointerV1 {
  return candidatePointer(candidate);
}

function candidatePointer(candidate: GraphSharePublicationCandidate): GraphShareFrontierPointerV1 {
  return {
    schemaVersion: 1,
    manifestDigest: parseSha256Digest(candidate.manifestDigest),
    envelopeDigest: parseSha256Digest(candidate.envelopeDigest),
  };
}

function samePointer(candidate: GraphSharePublicationCandidate, pointer: GraphShareFrontierPointerV1): boolean {
  return candidate.manifestDigest === pointer.manifestDigest && candidate.envelopeDigest === pointer.envelopeDigest;
}

function publicationCandidate(publication: GraphShareRegistryPublication): GraphSharePublicationCandidate {
  return {
    descriptorDigest: publication.descriptorDigest,
    envelopeDigest: publication.pointer.envelopeDigest,
    generation: publication.frontier.generation,
    historyFloor: publication.historyFloor,
    manifestDigest: publication.pointer.manifestDigest,
    publisherFence: publication.frontier.publisherFence,
    retentionDigest: publication.retention.digest,
    sourceCommit: publication.frontier.sourceCommit,
  };
}

const verifyKnownRegistryPredecessor = Effect.fn('codeGraph.sharing.verifyKnownRegistryPredecessor')(function* (
  casRoot: string,
  scope: GraphShareFrontierScope,
  publication: GraphShareRegistryPublication,
  remoteDigest: string,
) {
  const json = yield* decodeJsonBytes(yield* readGraphShareRegistryPublicationBlob(casRoot, remoteDigest, 1_048_576));
  const descriptor = yield* Effect.try({
    try: () => parseGraphShareOciDescriptor(json),
    catch: () => graphSharingFailure('Remote registry publication is unknown.'),
  });
  const remotePointer = {...graphShareFrontierPointerFromOciDescriptor(descriptor), schemaVersion: 1 as const};
  const remote = yield* readAuthenticatedGraphShareFrontier(casRoot, scope, remotePointer);
  if (
    remote.generation >= publication.frontier.generation ||
    remote.publisherFence > publication.frontier.publisherFence
  )
    return yield* graphSharingFailure('Remote registry publication is newer or conflicts with the local candidate.');
  let current = publication.frontier;
  for (let step = 1; step < 64 && current.previousManifestDigest !== null; step += 1) {
    const digest = current.previousManifestDigest;
    const json = yield* decodeJsonBytes(yield* readGraphShareRegistryPublicationBlob(casRoot, digest, 65_536));
    const previous = yield* Effect.try({
      try: () => parseGraphShareFrontierManifest(json),
      catch: () => graphSharingFailure('Registry predecessor is invalid.'),
    });
    yield* Effect.try({
      try: () => assertGraphSharePredecessor(current, previous),
      catch: () => graphSharingFailure('Registry predecessor is outside the authenticated lineage.'),
    });
    if (digest === remotePointer.manifestDigest) return;
    current = previous;
  }
  return yield* graphSharingFailure('Remote registry publication is not a known retained predecessor.');
});
