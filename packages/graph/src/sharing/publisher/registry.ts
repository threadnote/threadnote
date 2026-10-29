import {Effect, FileSystem, Path, Result} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {resolveRepositoryIdentity} from '../../repository.js';
import {decodeJsonBytes, readBoundedPrivateBytes, readJsonFile} from '../atomic.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from '../layout.js';
import {parseGraphShareFrontierPointer} from '../artifacts.js';
import {readAuthenticatedGraphShareFrontier} from '../frontier_acceptance.js';
import {graphSharingFailure} from '../errors.js';
import {assertEnrollmentMatchesIdentity, parseGraphShareEnrollment} from '../profile.js';
import {readGraphShareEnrolledProfile} from '../profile/storage.js';
import {
  graphShareRegistryPublicationScope,
  publishGraphShareRegistryFrontier,
  type GraphShareRegistryPublicationResult,
} from '../registry/publication.js';
import {graphSharePublicationAuthority, readGraphSharePublicationReceipt} from '../registry/publication_state.js';
import {resolveGraphShareCasRoot} from '../trust.js';
import {readGraphPublisherEvidenceRecord, type GraphPublisherEvidenceRecordV1} from './evidence_record.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const loadGraphPublisherRegistry = Effect.fn('codeGraph.sharing.loadPublisherRegistry')(function* (
  config: RuntimeConfig,
  options: {readonly cas?: string; readonly cwd?: string},
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const cwd = path.resolve(
    Effect2.pipe(options.cwd, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || system.currentDirectory(),
  );
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const enrollmentPath = graphShareEnrollmentPath(path, identity.repoRoot);
  if (!(yield* (yield* FileSystem.FileSystem).exists(enrollmentPath))) return undefined;
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(enrollmentPath));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const profile = yield* readGraphShareEnrolledProfile(casRoot, enrollment);
  const scope = graphShareRegistryPublicationScope({enrollment, profile});
  return {home: config.agentContextHome, casRoot, enrollment, profile, scope};
});

export const completeGraphPublisherRegistryPublication = Effect.fn('codeGraph.sharing.completeRegistryPublication')(
  function* (config: RuntimeConfig, options: {readonly cas?: string; readonly cwd?: string}) {
    const input = yield* loadGraphPublisherRegistry(config, options);
    if (input === undefined) return yield* graphSharingFailure('Publisher repository is not enrolled.');
    return yield* publishGraphShareRegistryFrontier(input);
  },
);

interface PublisherStatus {
  readonly contributionEvidence?: GraphPublisherEvidenceRecordV1;
  readonly contributionEvidenceStatus?: 'available' | 'missing' | 'unavailable';
  readonly enrolled: boolean;
  readonly localCandidate?: {
    readonly generation: number;
    readonly manifestDigest: string;
    readonly sourceCommit: string;
  };
  readonly publication?: GraphShareRegistryPublicationResult;
  readonly type: 'code-graph-publisher-status';
  readonly version: 1;
}

export const readGraphPublisherRegistryStatus = Effect.fn('codeGraph.sharing.publisherRegistryStatus')(function* (
  config: RuntimeConfig,
  options: {readonly cas?: string; readonly cwd?: string},
) {
  const input = yield* loadGraphPublisherRegistry(config, options);
  if (input === undefined) {
    const unenrolled: PublisherStatus = {enrolled: false, type: 'code-graph-publisher-status', version: 1};
    return unenrolled;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointerPath = graphSharingFrontierPointerPath(
    path,
    graphSharingLayout(path, input.home, input.casRoot).frontiersRoot,
    input.scope.repositoryId,
  );
  const pointer = (yield* fs.exists(pointerPath))
    ? parseGraphShareFrontierPointer(yield* decodeJsonBytes(yield* readBoundedPrivateBytes(pointerPath, 4096)))
    : undefined;
  const manifest =
    pointer === undefined ? undefined : yield* readAuthenticatedGraphShareFrontier(input.casRoot, input.scope, pointer);
  const receipt = Effect2.pipe(input.profile.registry.canonical, EffectString.startsWith('oci://'))
    ? yield* readGraphSharePublicationReceipt(
        input.home,
        graphSharePublicationAuthority(input.scope, input.profile.registry.canonical),
      )
    : undefined;
  const publication: GraphShareRegistryPublicationResult =
    receipt === undefined
      ? {status: 'local', changed: false}
      : {
          status:
            receipt.acknowledged !== undefined &&
            receipt.pending === undefined &&
            receipt.nextAttempt === 0 &&
            receipt.acknowledged.manifestDigest === pointer?.manifestDigest &&
            receipt.acknowledged.envelopeDigest === pointer.envelopeDigest
              ? 'acknowledged'
              : 'pending',
          changed: false,
          acknowledged: receipt.acknowledged,
          nextAttempt: receipt.nextAttempt,
          lastFailure: receipt.lastFailure,
        };
  const evidenceResult =
    manifest === undefined || pointer === undefined
      ? undefined
      : yield* Effect.result(
          readGraphPublisherEvidenceRecord({
            manifestDigest: pointer.manifestDigest,
            repositoryId: input.scope.repositoryId,
            threadnoteHome: input.home,
          }),
        );
  const evidence =
    evidenceResult !== undefined && Result.isSuccess(evidenceResult) ? evidenceResult.success : undefined;
  const evidenceMatches =
    evidence !== undefined &&
    evidence.generation === manifest?.generation &&
    evidence.sourceCommit === manifest?.sourceCommit;
  const status: PublisherStatus = {
    ...(evidenceMatches ? {contributionEvidence: evidence} : {}),
    ...(evidenceResult === undefined
      ? {}
      : {
          contributionEvidenceStatus:
            Result.isFailure(evidenceResult) || (evidence !== undefined && !evidenceMatches)
              ? ('unavailable' as const)
              : evidenceMatches
                ? ('available' as const)
                : ('missing' as const),
        }),
    enrolled: true,
    localCandidate:
      manifest === undefined || pointer === undefined
        ? undefined
        : {
            generation: manifest.generation,
            manifestDigest: pointer.manifestDigest,
            sourceCommit: manifest.sourceCommit,
          },
    publication,
    type: 'code-graph-publisher-status',
    version: 1,
  };
  return status;
});

export function graphPublisherPublicationMessage(input: {
  readonly generation: number;
  readonly manifestDigest: string;
  readonly sourceCommit: string;
  readonly publication: GraphShareRegistryPublicationResult;
}): string {
  if (input.publication.status === 'pending') {
    const confirmed = input.publication.acknowledged?.generation;
    return `Registry publication pending for local generation ${input.generation}; ${confirmed === undefined ? 'no confirmed remote frontier' : `last confirmed generation ${confirmed}`}.${input.publication.lastFailure === undefined ? '' : ` ${input.publication.lastFailure.message}`}`;
  }
  const selected = input.publication.acknowledged ?? input;
  return `${input.publication.status === 'local' ? 'Prepared local' : 'Published'} generation ${selected.generation} frontier ${selected.manifestDigest} for ${selected.sourceCommit}`;
}
