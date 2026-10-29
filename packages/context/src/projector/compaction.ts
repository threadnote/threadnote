import {Array as EffectArray} from 'effect';
import {isMemoryId, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {utf8Prefix} from '../projection_text.js';
import {contextBriefRelationshipMemoryByUri} from '../memory_projection.js';
import {compactContinuationCard} from '../projection_view.js';
import type {
  ContextBriefGraphCardV1,
  ContextBriefGraphContractV1,
  ContextBriefLogicalResultV1,
  ContextBriefMemoryEvidenceV1,
} from '../types.js';

export function compactProjectedMemory(
  memory: ContextBriefLogicalResultV1['durableDecisions'][number],
  protectRelationshipBundle = false,
  allowIdentityAlias = false,
  compactCodeLinkedCohort = false,
  includeActionCard = false,
  includeContinuationCard = false,
  preserveContinuationDetails = false,
): ContextBriefMemoryEvidenceV1 {
  const {cohortCodeRelations, continuationCard, memoryId, ...withoutIdentity} = memory;
  const compactContinuation =
    !includeContinuationCard || continuationCard === undefined
      ? {}
      : {continuationCard: compactContinuationCard(continuationCard, preserveContinuationDetails)};
  const hasProjectedCard =
    (includeActionCard && memory.actionCard !== undefined) ||
    (includeContinuationCard && continuationCard !== undefined);
  const stableUri =
    allowIdentityAlias && memoryId !== undefined && isMemoryId(memoryId) ? memoryIdentityAlias(memoryId) : memory.uri;
  if (memory.selectionBasis !== 'code-citation') {
    const {citationReceipts, ...resumeMemory} = withoutIdentity;
    return {
      ...(preserveContinuationDetails ? resumeMemory : withoutIdentity),
      ...compactContinuation,
      ...(preserveContinuationDetails && citationReceipts !== undefined ? {citationDetailsOmitted: true as const} : {}),
      ...(hasProjectedCard ? {excerpt: ''} : {}),
      uri: stableUri,
    };
  }
  const {project: _project, sourceCommit: _sourceCommit, topic: _topic, ...compact} = withoutIdentity;
  const compactActionCard =
    !includeActionCard || memory.actionCard === undefined
      ? {}
      : {
          actionCard: {
            appliesTo: utf8Prefix(memory.actionCard.appliesTo, 32),
            invariant: utf8Prefix(memory.actionCard.invariant, 56),
            ...(memory.actionCard.avoid === undefined ? {} : {avoid: utf8Prefix(memory.actionCard.avoid, 48)}),
            ...(memory.actionCard.verify === undefined ? {} : {verify: utf8Prefix(memory.actionCard.verify, 48)}),
          },
        };
  if (compactCodeLinkedCohort) {
    const {
      actionCard: _actionCard,
      citationSummary: _citationSummary,
      preciseStatus: _preciseStatus,
      ...cohortMemory
    } = compact;
    return {
      ...cohortMemory,
      ...compactActionCard,
      ...compactContinuation,
      ...(cohortCodeRelations === undefined ? {} : {codeRelations: cohortCodeRelations}),
      excerpt: hasProjectedCard ? '' : utf8Prefix(memory.excerpt, 16),
      uri: stableUri,
    };
  }
  if (protectRelationshipBundle) {
    const {
      actionCard: _actionCard,
      citationErrorCount,
      citationReceipts,
      citationSummary,
      codeRelations,
      ...protectedMemory
    } = compact;
    const citationDetailsOmitted =
      citationErrorCount !== undefined ||
      citationReceipts !== undefined ||
      citationSummary !== undefined ||
      codeRelations !== undefined;
    return {
      ...protectedMemory,
      ...compactActionCard,
      ...compactContinuation,
      ...(citationDetailsOmitted ? {citationDetailsOmitted: true as const} : {}),
      excerpt: hasProjectedCard ? '' : utf8Prefix(memory.excerpt, 32),
      uri: stableUri,
    };
  }
  const {citationReceipts, ...resumeCompact} = compact;
  return {
    ...(preserveContinuationDetails ? resumeCompact : compact),
    ...compactActionCard,
    ...compactContinuation,
    ...(preserveContinuationDetails && citationReceipts !== undefined ? {citationDetailsOmitted: true as const} : {}),
    excerpt: hasProjectedCard ? '' : utf8Prefix(memory.excerpt, 96),
    uri: stableUri,
  };
}

export function compactProjectedFollowUp(
  logical: ContextBriefLogicalResultV1,
  followUp: ContextBriefLogicalResultV1['recommendedFollowUps'][number],
  allowIdentityAlias: boolean,
): ContextBriefLogicalResultV1['recommendedFollowUps'][number] {
  if (followUp.operation !== 'read-memory') return followUp;
  const memory = contextBriefRelationshipMemoryByUri(logical, followUp.uri);
  if (!allowIdentityAlias || memory?.memoryId === undefined || !isMemoryId(memory.memoryId)) return followUp;
  const uri = memoryIdentityAlias(memory.memoryId);
  return {...followUp, arguments: {uri}, uri};
}

export function compactProjectedIssue(
  logical: ContextBriefLogicalResultV1,
  issue: ContextBriefLogicalResultV1['stalenessAndConflicts'][number],
  allowIdentityAlias: boolean,
): ContextBriefLogicalResultV1['stalenessAndConflicts'][number] {
  return {
    ...issue,
    uris: EffectArray.map(issue.uris, uri => {
      const memory = contextBriefRelationshipMemoryByUri(logical, uri);
      return allowIdentityAlias && memory?.memoryId !== undefined && isMemoryId(memory.memoryId)
        ? memoryIdentityAlias(memory.memoryId)
        : uri;
    }),
  };
}

export function compactProjectedGraphContract(contract: ContextBriefGraphContractV1): ContextBriefGraphContractV1 {
  const path = utf8Prefix(contract.evidence.path, 32);
  const repositoryKey = utf8Prefix(contract.evidence.repositoryKey, 64);
  const {
    pathTruncated: _pathTruncated,
    repositoryKeyTruncated: _repositoryKeyTruncated,
    ...evidence
  } = contract.evidence;
  return {
    ...contract,
    evidence: {
      ...evidence,
      path,
      ...(path === contract.evidence.path ? {} : {pathTruncated: true as const}),
      repositoryKey,
      ...(repositoryKey === contract.evidence.repositoryKey ? {} : {repositoryKeyTruncated: true as const}),
    },
  };
}

export function compactProjectedGraphCard(card: ContextBriefGraphCardV1): ContextBriefGraphCardV1 {
  return {...card, reason: utf8Prefix(card.reason, 48)};
}
