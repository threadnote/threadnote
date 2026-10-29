import type {CodeGraphStatus, CodeGraphSymbol} from '@threadnote/graph/types';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {ContextBriefCitationValidationReceiptV2} from '../types.js';

export interface ReceiptObservation {
  readonly candidateCount: number;
  readonly coverage: ContextBriefCitationValidationReceiptV2['coverage'];
  readonly observedLocator?: ContextBriefCitationValidationReceiptV2['observedLocator'];
  readonly observedNodeId?: string;
  readonly observedPath?: string;
  readonly observedSpan?: CodeGraphSymbol['span'];
  readonly strategy: ContextBriefCitationValidationReceiptV2['strategy'];
}

export function receipt(
  citation: MemoryCodeCitationV1,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  status: ContextBriefCitationValidationReceiptV2['status'],
  reason: ContextBriefCitationValidationReceiptV2['reason'],
  observation: ReceiptObservation,
  observedAt: string,
): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: observation.candidateCount,
    citationId: citation.id,
    coverage: observation.coverage,
    kind: citation.target.kind,
    observedAt,
    ...(observation.observedLocator === undefined ? {} : {observedLocator: observation.observedLocator}),
    ...(observation.observedNodeId === undefined ? {} : {observedNodeId: observation.observedNodeId}),
    ...(observation.observedPath === undefined ? {} : {observedPath: observation.observedPath}),
    ...(observation.observedSpan === undefined ? {} : {observedSpan: observation.observedSpan}),
    reason,
    repositoryId: citation.repositoryId,
    snapshotCommit: snapshot.commit,
    ...(snapshot.completedAt === undefined ? {} : {snapshotCompletedAt: snapshot.completedAt}),
    snapshotId: snapshot.id,
    sourcePath: citation.path,
    status,
    strategy: observation.strategy,
    validatorVersion: 1,
  };
}

export function unknownReceipt(
  citation: MemoryCodeCitationV1,
  reason: Extract<
    ContextBriefCitationValidationReceiptV2['reason'],
    'citation-limit' | 'graph-stale' | 'repository-ambiguous' | 'repository-unavailable' | 'validation-error'
  >,
  observedAt: string,
): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: 0,
    citationId: citation.id,
    coverage: 'incomplete',
    kind: citation.target.kind,
    observedAt,
    reason,
    repositoryId: citation.repositoryId,
    sourcePath: citation.path,
    status: 'unknown',
    strategy: 'none',
    validatorVersion: 1,
  };
}
