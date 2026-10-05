import {isMemoryId} from '@threadnote/memory/identity-alias';
import type {
  ContextBriefEvidenceState,
  ContextBriefGraphCardV1,
  ContextBriefGraphContractV1,
  ContextBriefLogicalResultV1,
  ContextBriefMemoryEvidenceV1,
  ContextBriefResponseFormat,
  ContextBriefV1,
} from './types.js';
import {CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP} from './source_projection.js';

const STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP = 'stable-memory-identity-unavailable';

export function isContextBriefExactCurrentContinuation(memory: ContextBriefMemoryEvidenceV1): boolean {
  const summary = memory.citationSummary;
  return (
    memory.continuationCard !== undefined &&
    memory.freshness === 'fresh' &&
    memory.freshnessBasis === 'code-citations' &&
    memory.preciseStatus === 'exact' &&
    (memory.citationErrorCount ?? 0) === 0 &&
    summary?.coverage === 'current-complete' &&
    summary.exact > 0 &&
    summary.relocated === 0 &&
    summary.stale === 0 &&
    summary.unknown === 0
  );
}

export function contextBriefResumeFocusUri(logical: ContextBriefLogicalResultV1): string | undefined {
  if (logical.mode !== 'resume' || logical.activeHandoffs.length !== 1 || logical.stalenessAndConflicts.length !== 0) {
    return undefined;
  }
  const handoff = logical.activeHandoffs[0];
  return handoff !== undefined && isContextBriefExactCurrentContinuation(handoff) ? handoff.uri : undefined;
}

export function isContextBriefGraphOnlyGap(gap: string): boolean {
  return gap === 'no-graph-evidence' || gap.startsWith('graph-');
}

export function deriveContextBriefEvidenceState(input: {
  readonly activeHandoffs: readonly ContextBriefMemoryEvidenceV1[];
  readonly cards: readonly ContextBriefGraphCardV1[];
  readonly contracts: readonly ContextBriefGraphContractV1[];
  readonly durableDecisions: readonly ContextBriefMemoryEvidenceV1[];
  readonly gaps: readonly string[];
  readonly logical: ContextBriefLogicalResultV1;
  readonly resumeFocusUri?: string;
  readonly sources: ContextBriefV1['graph']['sources'];
}): ContextBriefEvidenceState {
  const retainedMemories = [...input.activeHandoffs, ...input.durableDecisions];
  const hasEvidence = input.cards.length > 0 || retainedMemories.length > 0;
  if (!hasEvidence) return 'no-match';
  if (
    input.resumeFocusUri !== undefined &&
    input.gaps.length === 0 &&
    input.logical.stalenessAndConflicts.length === 0 &&
    input.logical.scope.freshness === 'fresh' &&
    input.logical.coverage.graph.complete &&
    input.cards.length > 0 &&
    input.activeHandoffs.some(isContextBriefExactCurrentContinuation)
  ) {
    return 'sufficient';
  }
  const unreliable =
    input.logical.scope.freshness !== 'fresh' ||
    !input.logical.coverage.graph.complete ||
    retainedMemories.some(memory => memory.freshness !== 'fresh');
  if (unreliable) return 'degraded';
  const requiresContract = input.logical.mode === 'trace' || input.logical.mode === 'impact';
  const requiresSource = input.sources !== undefined || input.gaps.includes(CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP);
  const requiresContinuation = input.logical.mode === 'resume';
  const hasContinuation = retainedMemories.some(memory => memory.continuationCard !== undefined);
  const mandatoryGap = input.gaps.some(gap => gap !== 'no-relevant-active-memory');
  if (
    input.cards.length === 0 ||
    input.cards.length < input.logical.graph.cards.length ||
    input.logical.graph.continuation !== undefined ||
    (requiresContract && input.contracts.length === 0) ||
    (requiresSource && (input.sources?.length ?? 0) === 0) ||
    (requiresContinuation && !hasContinuation) ||
    mandatoryGap
  ) {
    return 'partial';
  }
  return 'sufficient';
}

export function contextBriefRelationshipMemoryByUri(
  logical: ContextBriefLogicalResultV1,
  uri: string,
): ContextBriefMemoryEvidenceV1 | undefined {
  return [...logical.activeHandoffs, ...logical.durableDecisions].find(memory => memory.uri === uri);
}

export function requiredContextBriefAgentMemoryItem<T extends {readonly id: string; readonly lane: string}>(
  logical: ContextBriefLogicalResultV1,
  items: readonly T[],
  responseFormat: ContextBriefResponseFormat,
): T | undefined {
  if (logical.mode === 'resume') {
    return items.find(
      item =>
        (item.lane === 'handoff' || item.lane === 'durable-decision') &&
        contextBriefRelationshipMemoryByUri(logical, item.id)?.continuationCard !== undefined,
    );
  }
  if (responseFormat !== 'agent' || logical.mode !== 'explain' || logical.coverage.memory.codeAnchors !== undefined) {
    return undefined;
  }
  return items.find(item => item.lane === 'handoff' || item.lane === 'durable-decision');
}

export function withStableContextBriefMemoryIdentityGap(
  logical: ContextBriefLogicalResultV1,
): ContextBriefLogicalResultV1 {
  if (logical.coverage.memory.codeAnchors === undefined) return logical;
  if (logical.mode !== 'trace' && logical.mode !== 'impact') return logical;
  const primary = [...logical.activeHandoffs, ...logical.durableDecisions].find(
    memory => memory.selectionBasis === 'code-citation',
  );
  if (primary === undefined || (primary.memoryId !== undefined && isMemoryId(primary.memoryId))) return logical;
  return {
    ...logical,
    coverage: {
      ...logical.coverage,
      gaps: [
        STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP,
        ...logical.coverage.gaps.filter(gap => gap !== STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP),
      ],
    },
  };
}
