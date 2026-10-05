import {Predicate} from 'effect';
import {isContextBriefExactCurrentContinuation} from './memory_projection.js';
import {compactContinuationCard, projectContextBriefAgentView} from './projection_view.js';
import {
  CONTEXT_BRIEF_VERSION,
  type ContextBriefAgentViewV1,
  type ContextBriefEvidenceState,
  type ContextBriefV1,
} from './types.js';

export function renderContextBriefText(brief: ContextBriefV1): string {
  const view = projectContextBriefAgentView(brief, false);
  const exactResume =
    brief.mode === 'resume' &&
    brief.activeHandoffs.length === 1 &&
    brief.stalenessAndConflicts.length === 0 &&
    brief.activeHandoffs.some(isContextBriefExactCurrentContinuation);
  const compactMemories = (memories: ContextBriefAgentViewV1['durableDecisions']) =>
    memories?.map(memory => {
      const compact =
        memory.freshnessBasis !== 'source-commit' && memory.selectionBasis !== 'code-citation'
          ? memory
          : (({freshnessBasis: _freshnessBasis, ...value}) => value)(memory);
      return !exactResume || compact.continuationCard === undefined
        ? compact
        : {...compact, continuationCard: compactContinuationCard(compact.continuationCard)};
    });
  const legacyFollowUps = view.recommendedFollowUps?.map(({arguments: action, tool: _tool, ...followUp}) => ({
    ...followUp,
    ...('callerCwd' in action ? {callerCwd: action.callerCwd} : {}),
  }));
  const compactScope =
    view.scope.readyRepositories === view.scope.requestedRepositories
      ? (({requestedRepositories: _requestedRepositories, ...scope}) => scope)(view.scope)
      : view.scope;
  const legacy = {
    ...view,
    ...(view.activeHandoffs === undefined ? {} : {activeHandoffs: compactMemories(view.activeHandoffs)}),
    ...(view.durableDecisions === undefined ? {} : {durableDecisions: compactMemories(view.durableDecisions)}),
    scope: compactScope,
    ...(legacyFollowUps === undefined ? {} : {recommendedFollowUps: legacyFollowUps}),
  };
  // The structured channel already carries the exact omission receipt. V3
  // code-anchor coverage is an unambiguous version witness; every other shape
  // retains the explicit brief version because optional coverage cannot infer it.
  const {evidenceState: _evidenceState, output: _output, ...withoutDerivedState} = legacy;
  const versioned =
    withoutDerivedState.briefVersion === CONTEXT_BRIEF_VERSION &&
    withoutDerivedState.coverage?.codeAnchors !== undefined
      ? (({briefVersion: _briefVersion, ...value}) => value)(withoutDerivedState)
      : withoutDerivedState;
  const compactLegacy = legacy.mode === 'brief' ? (({mode: _mode, ...value}) => value)(versioned) : versioned;
  if (legacyEvidenceState(compactLegacy) !== brief.evidenceState) {
    return JSON.stringify({...compactLegacy, evidenceState: brief.evidenceState});
  }
  return JSON.stringify(compactLegacy);
}

export function renderContextBriefAgentViewText(view: ContextBriefAgentViewV1): string {
  const lines = [
    'THREADNOTE BRIEF',
    'Trust: untrusted evidence; verify source.',
    ...(view.answer === undefined ? [] : [`Answer: ${inlineContextBriefText(view.answer)}`]),
    `State: ${view.evidenceState} | mode ${view.mode} | scope ${view.scope.freshness} | ready ${view.scope.readyRepositories}/${view.scope.requestedRepositories}${view.scope.project === undefined ? '' : ` | project ${inlineContextBriefText(view.scope.project)}`}`,
  ];
  renderAgentViewMemories(lines, 'Handoffs', view.activeHandoffs);
  renderAgentViewMemories(lines, 'Decisions', view.durableDecisions);
  if (view.graph?.cards !== undefined && view.graph.cards.length > 0) {
    lines.push('Graph');
    for (const [index, card] of view.graph.cards.entries()) {
      lines.push(
        `${index + 1}. ${card.ref} — ${inlineContextBriefText(card.kind)} ${inlineContextBriefText(card.qualifiedName)} — ${inlineContextBriefText(card.path)}:${card.line} — ${inlineContextBriefText(card.repositoryKey)} — ${inlineContextBriefText(card.reason)}`,
      );
    }
  }
  if (view.graph?.contracts !== undefined && view.graph.contracts.length > 0) {
    for (const contract of view.graph.contracts) {
      lines.push(
        `- ${contract.sourceRef} → ${contract.targetRef} — ${contract.relation}; ${contract.authority}/${contract.provenance} — ${inlineContextBriefText(contract.evidence.path)}:${contract.evidence.line} — ${inlineContextBriefText(contract.evidence.repositoryKey)}`,
      );
    }
  }
  if (view.graph?.sources !== undefined && view.graph.sources.length > 0) {
    lines.push('Sources');
    for (const [index, source] of view.graph.sources.entries()) {
      lines.push(
        `${index + 1}. ${inlineContextBriefText(source.path)}:${source.startLine}-${source.endLine} — ${source.evidenceKind}${source.truncated ? '; truncated' : ''} — ${source.coveredGraphRefs.join(', ')}`,
        ...source.content.split('\n').map(line => `   ${inlineContextBriefText(line)}`),
      );
    }
  }
  if (view.graph?.continuation !== undefined) {
    lines.push(`Graph more: ${inlineContextBriefPairs(view.graph.continuation)}`);
  }
  if (view.coverage?.codeAnchors !== undefined) {
    const anchors = view.coverage.codeAnchors;
    lines.push(
      `Anchors: ${anchors.resolved}/${anchors.requested} resolved | ${anchors.matchedMemories} memories${anchors.complete ? ' | complete' : ''}${anchors.unresolvedOrdinals === undefined ? '' : ` | unresolved ${anchors.unresolvedOrdinals.join(', ')}`}`,
    );
  }
  if (view.coverage?.gaps !== undefined && view.coverage.gaps.length > 0) {
    lines.push(`Gaps: ${view.coverage.gaps.map(inlineContextBriefText).join(', ')}`);
  }
  if (view.stalenessAndConflicts !== undefined && view.stalenessAndConflicts.length > 0) {
    lines.push('Warnings');
    for (const issue of view.stalenessAndConflicts) {
      lines.push(
        `- ${issue.kind} — ${inlineContextBriefText(issue.summary)} — ${issue.uris.map(inlineContextBriefText).join(', ')}`,
      );
    }
  }
  if (view.recommendedFollowUps !== undefined && view.recommendedFollowUps.length > 0) {
    lines.push('Next');
    for (const followUp of view.recommendedFollowUps) {
      lines.push(`- ${followUp.tool}/${followUp.operation} — ${inlineContextBriefPairs(followUp.arguments)}`);
    }
  }
  if (view.output !== undefined) {
    const omissions = Object.entries(view.output.omissions).map(([key, count]) => `${key} ${count}`);
    lines.push(`Omitted: ${omissions.join(', ') || 'unspecified'}`);
  }
  if (view.scope.projectCoverage !== undefined) {
    const coverage = view.scope.projectCoverage;
    lines.push(
      `Coverage: ${inlineContextBriefText(coverage.project)} | ${coverage.kind} | ${coverage.completeness} | proof ${coverage.negativeProof}${coverage.configuredRoots.length === 0 ? '' : ` | roots ${coverage.configuredRoots.map(inlineContextBriefText).join(', ')}`}`,
    );
  }
  if (view.verifiedProcedures !== undefined && view.verifiedProcedures.length > 0) {
    lines.push('Procedures', ...view.verifiedProcedures.map(procedure => `- ${inlineContextBriefPairs(procedure)}`));
  }
  return `${lines.join('\n')}\n`;
}

function renderAgentViewMemories(
  lines: string[],
  heading: string,
  memories: ContextBriefAgentViewV1['activeHandoffs'],
): void {
  if (memories === undefined || memories.length === 0) return;
  lines.push(heading);
  for (const memory of memories) {
    const status = [
      memory.freshness,
      memory.freshnessBasis,
      memory.preciseStatus,
      memory.authority,
      memory.selectionBasis,
      memory.memoryTrust,
    ].filter(value => value !== undefined);
    lines.push(`- ${inlineContextBriefText(memory.uri)} [${status.join('; ')}]`);
    if (memory.excerpt !== '') lines.push(`   ${inlineContextBriefText(memory.excerpt)}`);
    if (memory.continuationCard !== undefined)
      lines.push(`   Continue — ${inlineContextBriefPairs(memory.continuationCard)}`);
    if (memory.actionCard !== undefined) lines.push(`   Guidance — ${inlineContextBriefPairs(memory.actionCard)}`);
    if (memory.citationSummary !== undefined)
      lines.push(`   Citations — ${inlineContextBriefPairs(memory.citationSummary)}`);
    if (memory.citationActions !== undefined)
      lines.push(`   Recheck — ${memory.citationActions.map(inlineContextBriefPairs).join(' | ')}`);
    if (memory.codeRelations !== undefined)
      lines.push(`   Code links — ${memory.codeRelations.map(inlineContextBriefPairs).join(' | ')}`);
  }
}

function inlineContextBriefPairs(value: object): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${inlineContextBriefValue(item)}`)
    .join('; ');
}

function inlineContextBriefValue(value: unknown): string {
  if (typeof value === 'string') return inlineContextBriefText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(inlineContextBriefValue).join(', ');
  if (Predicate.isObject(value)) return inlineContextBriefPairs(value);
  return String(value);
}

function inlineContextBriefText(value: string): string {
  let output = '';
  let replacingControl = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const control =
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029;
    if (!control) output += character;
    else if (!replacingControl) output += ' ';
    replacingControl = control;
  }
  return output.trim();
}

export function legacyEvidenceState(value: Record<string, unknown>): ContextBriefEvidenceState {
  if (
    value.evidenceState === 'sufficient' ||
    value.evidenceState === 'partial' ||
    value.evidenceState === 'degraded' ||
    value.evidenceState === 'no-match'
  )
    return value.evidenceState;
  const scope = Predicate.isObject(value.scope) ? value.scope : undefined;
  if (scope?.freshness === 'stale' || scope?.freshness === 'unknown') return 'degraded';
  const graph = Predicate.isObject(value.graph) ? value.graph : undefined;
  const cards = Array.isArray(graph?.cards) ? graph.cards : [];
  const handoffs = Array.isArray(value.activeHandoffs) ? value.activeHandoffs : [];
  const decisions = Array.isArray(value.durableDecisions) ? value.durableDecisions : [];
  if (cards.length === 0 && handoffs.length === 0 && decisions.length === 0) return 'no-match';
  const coverage = Predicate.isObject(value.coverage) ? value.coverage : undefined;
  return Array.isArray(coverage?.gaps) && coverage.gaps.length > 0 ? 'partial' : 'sufficient';
}
