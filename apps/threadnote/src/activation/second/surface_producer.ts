import {Array as EffectArray} from 'effect';
import {Crypto, DateTime, Effect} from 'effect';
import {getAgentAdapter} from '../../agent_integration/adapters.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {THREADNOTE_MCP_CLIENT_ENV, THREADNOTE_MCP_SURFACE_ENV} from '../../constants.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {captureConsole} from '../../effect/console.js';
import {SystemInfo} from '@threadnote/platform/system';
import {runRecall} from '../../memory/index.js';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {DEFAULT_MCP_TOOLSET, MCP_TOOLSET_ENV} from '../../mcp/toolset.js';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {observeCurrentActivationSurfaceV1} from '../production/evidence.js';
import {
  completeSecondSurfaceProofV1,
  planSecondSurfaceReadV1,
  type SecondSurfaceReadObservationV1,
  type SecondSurfaceRecallObservationV1,
} from './surface.js';
import {
  completeSecondSurfaceProofChallengeV1,
  readSecondSurfaceProofChallengeV1,
  verifySecondSurfaceProofAttestationV1,
} from './surface_store.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface SecondSurfaceProofProducerInputV1 {
  readonly callerCwd: string;
  readonly challengeId: string;
  readonly project: string;
  readonly query: string;
  readonly topic: string;
  readonly transport: 'http' | 'stdio';
}

/** Runs only inside the installed MCP process selected by the secondary catalog surface. */
export const produceSecondSurfaceProofV1 = Effect.fn('activation.proof.produce')(function* (
  config: RuntimeConfig,
  input: SecondSurfaceProofProducerInputV1,
) {
  if (input.transport !== 'stdio') throw new Error('Activation retrieval proof requires local MCP stdio transport.');
  const challenge = yield* readSecondSurfaceProofChallengeV1(config, input.challengeId);
  if (challenge === undefined) throw new Error('Activation retrieval proof challenge was not found.');
  const context = challenge.context;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const surfaceId = Effect2.pipe(environment[THREADNOTE_MCP_SURFACE_ENV], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (surfaceId !== context.secondary.surfaceId) {
    throw new Error('Activation retrieval proof was invoked from the wrong catalog surface.');
  }
  const adapter = getAgentAdapter(surfaceId);
  if (
    adapter === undefined ||
    Effect2.pipe(environment[THREADNOTE_MCP_CLIENT_ENV], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) !== adapter.catalog.agentId
  ) {
    throw new Error('Activation retrieval proof client identity does not match the catalog surface.');
  }
  const observed = yield* observeCurrentActivationSurfaceV1(config, adapter);
  if (canonicalJson(observed.snapshot) !== canonicalJson(context.secondary)) {
    throw new Error('Activation retrieval proof surface configuration changed after challenge issue.');
  }
  const runtimeFingerprint = sha256HexSync(
    canonicalJson({
      installedVersion: yield* getThreadnoteVersion(),
      protocol: 'threadnote-mcp-stdio-v1',
      toolset:
        Effect2.pipe(environment[MCP_TOOLSET_ENV], effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || DEFAULT_MCP_TOOLSET,
    }),
  );
  if (runtimeFingerprint !== context.secondary.mcpServerFingerprint) {
    throw new Error('Activation retrieval proof runtime does not match the installed surface receipt.');
  }
  const repository = yield* resolveRepositoryIdentity(input.callerCwd);
  if (repository.repositoryId !== context.repositoryIdentityHash) {
    throw new Error('Activation retrieval proof repository does not match the challenge.');
  }
  if (
    sha256HexSync(canonicalJson({project: input.project, task: input.query, topic: input.topic})) !==
    context.queryFingerprint
  ) {
    throw new Error('Activation retrieval proof query does not match the challenge.');
  }
  if (challenge.receipt !== undefined) {
    return yield* verifySecondSurfaceProofAttestationV1(config, challenge, challenge.receipt);
  }
  const crypto = yield* Crypto.Crypto;
  const recalled = (yield* captureConsole(
    runRecall(config, {
      callerCwd: input.callerCwd,
      inferScope: false,
      nodeLimit: '32',
      project: input.project,
      query: `${input.query}\n${input.topic}`,
    }),
  )).value;
  const recallAt = DateTime.formatIso(yield* DateTime.now);
  const recallInvocationId = sha256HexSync(yield* crypto.randomBytes(32));
  const recallResults = EffectArray.map(recalled.ranked, candidate => {
    if (candidate.memoryId === undefined) {
      throw new Error('Activation retrieval proof recall returned an unresolved memory identity.');
    }
    return {
      canonicalUri: candidate.uri,
      identityConflict: candidate.identityConflict === true,
      memoryId: candidate.memoryId,
    };
  });
  const recallResponseFingerprint = sha256HexSync(
    canonicalJson({
      challengeId: challenge.challengeId,
      confidence: recalled.confidence ?? null,
      invocationId: recallInvocationId,
      operation: 'recall',
      project: input.project,
      queryFingerprint: context.queryFingerprint,
      queryExpansions: recalled.queryExpansions,
      results: EffectArray.map(recalled.ranked, candidate => ({
        category: candidate.category,
        contextType: candidate.contextType,
        equivalentUris: candidate.equivalentUris ?? [],
        exactTerms: candidate.exactTerms ?? [],
        finalScore: candidate.finalScore ?? null,
        identityConflict: candidate.identityConflict === true,
        memoryId: candidate.memoryId ?? null,
        rankReasons: candidate.rankReasons ?? [],
        rankWarnings: candidate.rankWarnings ?? [],
        score: candidate.score,
        snippetHash: sha256HexSync(candidate.snippet),
        uri: candidate.uri,
      })),
      totalRanked: recalled.totalRanked,
      warnings: EffectArray.map(recalled.warnings, warning => sha256HexSync(JSON.stringify(warning))),
    }),
  );
  const common = {
    activationReceiptRevision: context.activationReceiptRevision,
    capabilitiesFingerprint: context.secondary.capabilitiesFingerprint,
    catalogRevision: context.catalogRevision,
    catalogSnapshotHash: context.catalogSnapshotHash,
    mcpConfigFingerprint: context.secondary.mcpConfigFingerprint!,
    mcpReceiptFingerprint: context.secondary.mcpReceiptFingerprint!,
    mcpServerFingerprint: context.secondary.mcpServerFingerprint,
    repositoryIdentityHash: context.repositoryIdentityHash,
    surfaceId: context.secondary.surfaceId,
    teamShareStateHash: context.teamShareStateHash,
  };
  const recall: SecondSurfaceRecallObservationV1 = {
    ...common,
    complete: true,
    invocationId: recallInvocationId,
    observedAt: recallAt,
    queryFingerprint: context.queryFingerprint,
    responseFingerprint: recallResponseFingerprint,
    results: recallResults,
    returnedResults: recallResults.length,
    totalResults: recalled.totalRanked,
    truncated: recalled.totalRanked > recallResults.length,
  };
  const readPlan = planSecondSurfaceReadV1(context, recall);
  if (readPlan.status === 'rejected') {
    throw new Error(`Activation retrieval proof recall failed: ${readPlan.code}.`);
  }
  const records = yield* readMemoryRecordsByUri(config, [readPlan.request.uri]);
  const record = records[0];
  if (
    records.length !== 1 ||
    record === undefined ||
    record.uri !== readPlan.request.uri ||
    record.metadata.memoryId !== readPlan.request.memoryId ||
    sha256HexSync(canonicalMemoryDocumentContent(record.content)) !== context.decision.contentHash
  ) {
    throw new Error('Activation retrieval proof could not read the exact recalled decision.');
  }
  const readAt = DateTime.formatIso(yield* DateTime.now);
  const readInvocationId = sha256HexSync(yield* crypto.randomBytes(32));
  const readResponseFingerprint = sha256HexSync(
    canonicalJson({
      challengeId: challenge.challengeId,
      contentHash: context.decision.contentHash,
      invocationId: readInvocationId,
      operation: 'read',
      recallResponseFingerprint,
    }),
  );
  const read: SecondSurfaceReadObservationV1 = {
    ...common,
    canonicalUri: record.uri,
    complete: true,
    contentHash: context.decision.contentHash,
    invocationId: readInvocationId,
    memoryId: record.metadata.memoryId,
    observedAt: readAt,
    readable: true,
    recallResponseFingerprint,
    requestedMemoryId: context.decision.memoryId,
    requestedUri: context.decision.canonicalUri,
    resourceCount: 1,
    responseFingerprint: readResponseFingerprint,
  };
  const completed = completeSecondSurfaceProofV1(context, recall, read);
  if (completed.status === 'rejected') throw new Error(`Activation retrieval proof failed: ${completed.code}.`);
  return yield* completeSecondSurfaceProofChallengeV1(config, {
    challengeId: challenge.challengeId,
    proof: completed.receipt,
    runtimeFingerprint,
    surfaceId,
  });
});
