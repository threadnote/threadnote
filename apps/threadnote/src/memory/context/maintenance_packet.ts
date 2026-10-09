import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {canonicalMemoryDocumentContent, isSharedMemoryUri, type MemoryRecord} from '@threadnote/memory/document';
import {memoryCodeCitationAnchorId} from '@threadnote/memory/code/citation';
import {findContextHealthSemanticContradiction} from '@threadnote/context/health_semantic';
import {resolveContextHealthRelationTargetV2} from '@threadnote/context/health_maintenance';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {readTeamsFile} from '../../share/core.js';
import type {ContextMaintenanceCaseV2} from './maintenance.js';

class ContextMaintenancePacketError extends Schema.TaggedError<ContextMaintenancePacketError>()(
  'ContextMaintenancePacketError',
  {message: Schema.String},
) {}

export function withMaintenancePacketRevision<A, E, R, E2, R2>(
  assertCurrent: Effect.Effect<void, E, R>,
  read: Effect.Effect<A, E2, R2>,
) {
  return Effect.gen(function* () {
    yield* assertCurrent;
    const result = yield* read;
    yield* assertCurrent;
    return result;
  });
}

export function sharedMaintenanceOwnerProposal(
  record: MemoryRecord,
  corpus: readonly MemoryRecord[],
  sharedBase?: {readonly repositoryId: string; readonly commit: string},
) {
  const edits = (record.metadata.relations ?? [])
    .filter(relation => resolveContextHealthRelationTargetV2(corpus, relation.uri).state === 'missing')
    .map(relation => ({
      operation: 'remove-relation' as const,
      relation,
      reason: 'target-unresolved-in-readable-corpus',
    }));
  const expectedContentHash = sha256HexSync(canonicalMemoryDocumentContent(record.content));
  return {
    readOnly: true as const,
    subjectUri: record.uri,
    expectedContentHash,
    sharedBase:
      sharedBase === undefined ? {state: 'unavailable' as const} : {state: 'available' as const, ...sharedBase},
    proposalRevision: sha256HexSync(JSON.stringify([record.uri, expectedContentHash, sharedBase, edits])),
    selectedEdits: edits.slice(0, 32),
    omittedEdits: Math.max(0, edits.length - 32),
    authority: 'shared-owner' as const,
    publication: {
      operations: ['review_session_context', 'list_memory_candidates', 'apply_memory_candidates', 'share_propose'],
      instructions:
        'The shared owner must verify the selected targets against team authority, review a Knowledge Delta containing only the selected shared record changes, explicitly approve and apply the candidate, then explicitly approve share_propose with the exact review revision and applied candidate IDs. share_propose binds the current shared Git base and target content. Refresh this packet if canonical content changed. Publication is separately reviewed; no personal context is selected or exported by this packet.',
    },
  };
}

const readSharedBase = Effect.fn('contextMaintenance.sharedBase')(function* (config: RuntimeConfig, uri: string) {
  const name = /^threadnote:\/\/user\/[^/]+\/memories\/shared\/([^/]+)\//u.exec(uri)?.[1];
  if (name === undefined) return undefined;
  const team = (yield* readTeamsFile(config)).teams[name];
  if (team === undefined) return undefined;
  const repository = yield* resolveRepositoryIdentity(team.worktree);
  return {repositoryId: repository.repositoryId, commit: repository.headCommit};
});

export function buildContextMaintenancePacket<E, R>(
  config: RuntimeConfig,
  input: {
    readonly item: ContextMaintenanceCaseV2;
    readonly record: MemoryRecord;
    readonly corpus: readonly MemoryRecord[];
    readonly callerCwd: string;
    readonly selection?: {
      readonly citationId?: string;
      readonly memoryUri?: string;
      readonly startLine?: number;
      readonly maximumLines?: number;
    };
  },
  assertCurrent: Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const {item, record, corpus, callerCwd} = input;
    if (
      (input.selection?.startLine !== undefined &&
        (!Number.isSafeInteger(input.selection.startLine) || input.selection.startLine < 1)) ||
      (input.selection?.maximumLines !== undefined &&
        (!Number.isSafeInteger(input.selection.maximumLines) ||
          input.selection.maximumLines < 1 ||
          input.selection.maximumLines > 24))
    )
      return yield* ContextMaintenancePacketError.make({
        message: 'Choose a positive source line and 1 to 24 excerpt lines.',
      });
    const scopedRecords = corpus.filter(
      candidate =>
        candidate.uri === record.uri || item.subjectContentHashes?.some(subject => subject.uri === candidate.uri),
    );
    const selectedRecord =
      input.selection?.memoryUri === undefined
        ? record
        : scopedRecords.find(candidate => candidate.uri === input.selection?.memoryUri);
    if (selectedRecord === undefined)
      return yield* ContextMaintenancePacketError.make({
        message: 'Select evidence from the exact maintenance case subjects.',
      });
    const citations = selectedRecord.metadata.codeCitations ?? [];
    const selectedCitationId = input.selection?.citationId ?? item.citationId;
    const matches = citations.filter(citation =>
      selectedCitationId === undefined
        ? item.slot === `anchor:${memoryCodeCitationAnchorId(citation)}`
        : citation.id === selectedCitationId,
    );
    const citation = matches.length === 1 ? matches[0] : undefined;
    if (input.selection?.citationId !== undefined && citation === undefined)
      return yield* ContextMaintenancePacketError.make({message: 'Select an exact citation from the scoped memory.'});
    const evidenceSelectors = scopedRecords.flatMap(candidate =>
      (candidate.metadata.codeCitations ?? []).map(value => ({
        caseId: item.caseId,
        memoryUri: candidate.uri,
        citationId: value.id,
        anchorId: memoryCodeCitationAnchorId(value),
      })),
    );
    const shared = isSharedMemoryUri(record.uri);
    const canReviewRetirement =
      !shared &&
      item.citationId !== undefined &&
      ['deleted', 'changed', 'unknown'].includes(item.anchorEvidence?.status ?? '') &&
      ['waiting-evidence', 'needs-decision', 'historical'].includes(item.disposition);

    return yield* withMaintenancePacketRevision(
      assertCurrent,
      Effect.gen(function* () {
        const sharedBase = shared
          ? yield* readSharedBase(config, record.uri).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const evidence =
          citation === undefined
            ? undefined
            : yield* readContextHealthCitationEvidence(
                config,
                {callerCwd, kind: 'repository', project: item.project},
                citation,
                {
                  maximumBytes: 4_000,
                  maximumLines: input.selection?.maximumLines ?? 24,
                  startLine: input.selection?.startLine,
                },
              );
        const canRetire =
          canReviewRetirement &&
          citation?.id === item.citationId &&
          !evidence?.excerpts.some(excerpt => excerpt.provenance === 'current-verified' && excerpt.supportsCitation);
        if (sharedBase !== undefined) {
          const after = yield* readSharedBase(config, record.uri);
          if (after?.commit !== sharedBase.commit || after.repositoryId !== sharedBase.repositoryId)
            return yield* ContextMaintenancePacketError.make({
              message: 'The shared base changed. Refresh the owner proposal.',
            });
        }
        const ownerProposal = shared ? sharedMaintenanceOwnerProposal(record, corpus, sharedBase) : undefined;
        return {
          version: 2 as const,
          caseId: item.caseId,
          project: item.project,
          family: item.family,
          slot: item.slot,
          callerCwd,
          memoryUri: record.uri,
          memoryId: item.memoryId,
          evidenceRevision: item.evidenceRevision,
          expectedContentHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
          reason: item.reason,
          ...(item.family === 'semantic-contradiction'
            ? {
                semanticEvidence:
                  scopedRecords.length === 2
                    ? findContextHealthSemanticContradiction(
                        scopedRecords,
                        undefined,
                        item.slot.split(':') as [string, string],
                      )
                    : undefined,
              }
            : {}),
          disposition: item.disposition,
          relatedMemories: (item.subjectContentHashes ?? [])
            .slice(0, 32)
            .map(subject => ({uri: subject.uri, expectedContentHash: subject.hash})),
          omittedRelatedMemories: Math.max(0, (item.subjectContentHashes?.length ?? 0) - 32),
          sourceRevision: item.sourceSnapshot,
          subject: {kind: 'memory' as const, uri: record.uri, memoryId: item.memoryId},
          caseTarget: {family: item.family, slot: item.slot, citationId: item.citationId},
          target:
            citation === undefined
              ? {
                  kind: item.family,
                  slot: item.slot,
                  relations: (record.metadata.relations ?? [])
                    .filter(
                      relation =>
                        relation.uri === item.slot ||
                        resolveContextHealthRelationTargetV2(corpus, relation.uri).record?.metadata.memoryId ===
                          item.slot,
                    )
                    .slice(0, 32),
                }
              : {
                  kind: 'citation' as const,
                  memoryUri: selectedRecord.uri,
                  citationId: citation.id,
                  anchorId: memoryCodeCitationAnchorId(citation),
                  originalCitation: citation,
                },
          attempts: {
            count: item.attemptCount,
            events: item.events,
            attemptedRecoverySteps: evidence?.attemptedSteps ?? [],
          },
          policy: {
            sharedCanonicalReadOnly: shared,
            historicalEvidenceIsCurrentProof: false,
            requireRevisionCheck: true,
          },
          budget: {maximumExcerptBytes: 4_000, maximumExcerptLines: 24, maximumSelectedEdits: 32},
          ...(evidence === undefined ? {} : {evidence}),
          ...(ownerProposal === undefined ? {} : {ownerProposal}),
          ...(canRetire
            ? {
                retirement: {
                  operation: 'context_maintain',
                  action: 'retire-anchor',
                  caseId: item.caseId,
                  evidenceRevision: item.evidenceRevision,
                  expectedContentHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
                  instructions:
                    'Explicitly review historicalizing this unsupported current anchor; unavailable evidence is not proof of permanent loss. The service rechecks bounded current/historical evidence and rejects recovered current support. Original canonical citation, body and historical provenance are preserved. Active durable and smoke records still require a current-support claim decision.',
                },
              }
            : {}),
          evidenceSelectors: evidenceSelectors.slice(0, 8),
          omittedEvidenceSelectors: Math.max(0, evidenceSelectors.length - 8),
          evidenceRead: {
            operation: 'context_maintenance_packet',
            caseId: item.caseId,
            selectorFields: ['citationId', 'memoryUri', 'startLine', 'maximumLines'],
            instructions:
              'Read exact citation IDs from the selected memory pointer, then request this case packet with that citationId and memoryUri. Excerpts are bounded to 4000 bytes; maximumLines is at most 24. Original case and subject revisions are checked before and after the read.',
          },
          choices: shared
            ? [
                'Inspect the exact selected canonical edits',
                'Ask the shared owner to review the proposal',
                'Keep valid historical relations',
              ]
            : item.family === 'review-overdue'
              ? [
                  'Review the current claim and supporting evidence',
                  'Update the review date through a reviewed metadata change',
                  'Archive a superseded claim after review',
                ]
              : item.family === 'semantic-contradiction'
                ? [
                    'Read both source claims, inherited context, and exact revisions',
                    'Compare overlapping scope, validity, and descriptive or policy roles',
                    'Preserve compatible rules and history; review any correction explicitly',
                  ]
                : citation === undefined
                  ? [
                      'Review the current record and exact target',
                      'Preview an exact reviewed repair',
                      'Keep valid historical evidence',
                    ]
                  : [
                      'Compare the current claim with bounded current and historical source',
                      'Preserve verified historical provenance',
                      'Review retirement of an unsupported anchor or claim',
                    ],
          allowedOperations: shared
            ? [
                'read_context',
                'review_session_context',
                'list_memory_candidates',
                'apply_memory_candidates',
                'share_propose',
              ]
            : [
                'read_context',
                'context_health_repair_preview',
                'context_health_repair_apply',
                ...(canRetire ? ['context_maintain'] : []),
              ],
          instructions: shared
            ? ownerProposal!.publication.instructions
            : 'Read the exact memory and target. Current excerpts support the citation only when supportsCitation is true; historical excerpts preserve original provenance only. A new hash cannot validate old prose. Preview and apply only a supported exact revision within the authorized personal scope.',
        };
      }),
    );
  });
}
