import {Predicate, Schema} from 'effect';
import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  AgentResponseBudgetTooSmallError,
  measureAgentToolResponse,
} from '@threadnote/protocol/agent-response';
import {
  CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_AGENT_VIEW_VERSION,
  CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
  CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
  CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
  CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION,
  CONTEXT_BRIEF_LEGACY_VERSION,
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS,
  CONTEXT_BRIEF_MAXIMUM_PUBLIC_CODE_RELATIONS,
  CONTEXT_BRIEF_PROCEDURE_AGENT_VIEW_VERSION,
  CONTEXT_BRIEF_PROCEDURE_PROJECTOR_VERSION,
  CONTEXT_BRIEF_PROCEDURE_VERSION,
  CONTEXT_BRIEF_PROJECTOR_VERSION,
  CONTEXT_BRIEF_VERSION,
  type ContextBriefGraphCardV1,
  type ContextBriefGraphContractV1,
  type ContextBriefLogicalResultV1,
  type ContextBriefAgentViewV1,
  type ContextBriefLogicalMemoryEvidenceV1,
  type ContextBriefMemoryEvidenceV1,
  type ContextBriefResponseFormat,
  type ContextBriefV1,
  type ProjectedContextBriefV1,
} from './types.js';
import {isMemoryId, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {legacyEvidenceState, renderContextBriefAgentViewText, renderContextBriefText} from './agent_view_text.js';
import {parseVerifiedProcedureEvidenceList} from './procedure/selection.js';
import {
  contextBriefResumeFocusUri,
  contextBriefRelationshipMemoryByUri,
  deriveContextBriefEvidenceState,
  isContextBriefGraphOnlyGap,
  requiredContextBriefAgentMemoryItem,
  withStableContextBriefMemoryIdentityGap,
} from './memory_projection.js';
import {
  CONTEXT_BRIEF_PROJECTION_LANES as PROJECTION_LANES,
  contextBriefProjectionLanePriority as lanePriority,
  type ContextBriefProjectionLane as ProjectionLane,
} from './projection_lanes.js';
import {
  CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP,
  contextBriefSourceExcerptOmissionCount,
  contextBriefSourceProjectionItems,
  requiredContextBriefSourceProjectionItems,
  selectContextBriefProjectedSources,
  validateContextBriefSourceExcerpt,
  withAdjustedContextBriefSourceExcerpt,
} from './source_projection.js';
import {jsonStringPrefix, utf8Prefix} from './projection_text.js';
import {
  compactContextBriefScope,
  compactContinuationCard,
  compactMinimumContextBriefScope,
  preservesBaselineEvidence,
  projectContextBriefAgentView,
} from './projection_view.js';
import {preservesResumeBaselineEvidence} from './projection_view.js';

export {
  CONTEXT_BRIEF_AGENT_VIEW_CITATION_RECEIPT_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_COVERAGE_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_GRAPH_CARD_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_GRAPH_CARD_SYMBOL_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_GRAPH_CONTRACT_EVIDENCE_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_GRAPH_CONTRACT_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_MEMORY_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_OUTPUT_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_ROOT_FIELD_POLICY,
  CONTEXT_BRIEF_AGENT_VIEW_SCOPE_FIELD_POLICY,
  compactContinuationCard,
  projectContextBriefAgentView,
} from './projection_view.js';

export {isContextBriefExactCurrentContinuation, isContextBriefGraphOnlyGap} from './memory_projection.js';

export {renderContextBriefAgentViewText, renderContextBriefText} from './agent_view_text.js';

export {CONTEXT_BRIEF_AGENT_VIEW_SOURCE_EXCERPT_FIELD_POLICY} from './source_projection.js';

const UnknownArraySchema = Schema.Array(Schema.Unknown);
const isUnknownArray = Schema.is(UnknownArraySchema);
const isBoundedPublicCodeRelations = Schema.is(
  UnknownArraySchema.check(Schema.isMaxLength(CONTEXT_BRIEF_MAXIMUM_PUBLIC_CODE_RELATIONS)),
);

interface ProjectionItem {
  readonly id: string;
  readonly lane: ProjectionLane;
  readonly laneRank: number;
  readonly priority: number;
}

interface CodeLinkedEvidenceCoreProjection {
  readonly allCohortKeys: ReadonlySet<string>;
  readonly compactMemoryUris: ReadonlySet<string>;
  readonly excludedKeys: ReadonlySet<string>;
  readonly protectedMemoryUri?: string;
  readonly requiredItems: readonly ProjectionItem[];
}

const ROOT_KEYS = new Set([
  'activeHandoffs',
  'coverage',
  'durableDecisions',
  'evidenceState',
  'graph',
  'mode',
  'output',
  'recommendedFollowUps',
  'scope',
  'stalenessAndConflicts',
  'task',
  'trust',
  'type',
  'version',
  'verifiedProcedures',
]);

export function projectContextBrief(
  logical: ContextBriefLogicalResultV1,
  maximumEstimatedTokens: number = CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
  responseFormat: ContextBriefResponseFormat = 'dual',
): ProjectedContextBriefV1 {
  const resumeFocusUri = contextBriefResumeFocusUri(logical);
  if (
    ![...logical.activeHandoffs, ...logical.durableDecisions].some(
      memory => memory.actionCard !== undefined || (logical.mode === 'resume' && memory.continuationCard !== undefined),
    )
  ) {
    return projectContextBriefCore(logical, maximumEstimatedTokens, responseFormat, resumeFocusUri);
  }
  const withoutCards = {
    ...logical,
    activeHandoffs: logical.activeHandoffs.map(
      ({actionCard: _actionCard, continuationCard: _continuationCard, ...memory}) => memory,
    ),
    durableDecisions: logical.durableDecisions.map(
      ({actionCard: _actionCard, continuationCard: _continuationCard, ...memory}) => memory,
    ),
  };
  const baseline = projectContextBriefCore(withoutCards, maximumEstimatedTokens, responseFormat, resumeFocusUri);
  const withCards = projectContextBriefCore(logical, maximumEstimatedTokens, responseFormat, resumeFocusUri);
  const preservesBaseline = logical.mode === 'resume' ? preservesResumeBaselineEvidence : preservesBaselineEvidence;
  return preservesBaseline(withCards.structuredContent, baseline.structuredContent) ? withCards : baseline;
}

function projectContextBriefCore(
  logical: ContextBriefLogicalResultV1,
  maximumEstimatedTokens: number,
  responseFormat: ContextBriefResponseFormat,
  resumeFocusUri?: string,
): ProjectedContextBriefV1 {
  logical = withStableContextBriefMemoryIdentityGap(logical);
  const maximumBytes = projectionMaximumBytes(maximumEstimatedTokens);
  const items = projectionItems(logical, responseFormat, resumeFocusUri);
  const graphRecoveryItem = requiredGraphRecoveryItem(logical, items);
  const baseRequiredItems = uniqueProjectionItems(
    [
      requiredCoverageGapItem(items),
      ...(resumeFocusUri === undefined
        ? []
        : items.filter(item => item.lane === 'coverage-gap' || item.lane === 'verified-procedure')),
      ...requiredAgentGraphEvidenceItems(logical, items, responseFormat, graphRecoveryItem),
      items.find(item => item.lane === 'handoff' && item.id === resumeFocusUri),
      requiredContextBriefAgentMemoryItem(logical, items, responseFormat),
      ...requiredContextBriefSourceProjectionItems(logical, items),
      ...requiredAgentWorksetRecoveryItems(logical, items, responseFormat),
      ...(resumeFocusUri === undefined ? [] : [items.find(item => item.lane === 'graph-card')]),
      graphRecoveryItem,
    ].filter((item): item is ProjectionItem => item !== undefined),
  );
  const fixedCore =
    resumeFocusUri === undefined
      ? requiredCodeLinkedEvidenceCore(logical, items, baseRequiredItems, responseFormat)
      : {
          allCohortKeys: new Set<string>(),
          compactMemoryUris: new Set<string>(),
          excludedKeys: new Set<string>(),
          requiredItems: baseRequiredItems,
        };
  const fixedProjection = renderProjection(
    logical,
    fixedCore.requiredItems,
    fixedCore.protectedMemoryUri,
    fixedCore.compactMemoryUris,
    resumeFocusUri,
  );
  const fixedMeasurement = measureContextBriefResponse(fixedProjection, responseFormat);
  const baseKeys = new Set(baseRequiredItems.map(projectionItemKey));
  const fixedCoreHasExtras = fixedCore.requiredItems.some(item => !baseKeys.has(projectionItemKey(item)));
  const admitFixedCore = fixedMeasurement.totalBytes <= maximumBytes;
  const requiredItems = admitFixedCore ? fixedCore.requiredItems : uniqueProjectionItems(baseRequiredItems);
  const compactMemoryUris = admitFixedCore ? fixedCore.compactMemoryUris : new Set<string>();
  const protectedMemoryUri = admitFixedCore ? fixedCore.protectedMemoryUri : undefined;
  const excludedKeys = admitFixedCore
    ? fixedCore.excludedKeys
    : requiredLanePredecessorExclusions(items, requiredItems, fixedCore.allCohortKeys);
  const suppressOptional = !admitFixedCore && fixedCoreHasExtras;
  const suppressOptionalAgentLocate =
    responseFormat === 'agent' &&
    logical.mode === 'locate' &&
    logical.coverage.memory.codeAnchors === undefined &&
    (logical.graph.sourceExcerpts?.length ?? 0) === 0;
  const requiredKeys = new Set(requiredItems.map(projectionItemKey));
  const eligibleOptionalItems = items.filter(item => {
    const key = projectionItemKey(item);
    return !requiredKeys.has(key) && !excludedKeys.has(key);
  });
  const optionalItems =
    suppressOptional || suppressOptionalAgentLocate
      ? []
      : responseFormat === 'agent'
        ? agentSemanticOptionalProjectionItems(eligibleOptionalItems, requiredItems)
        : laneStableOptionalProjectionItems(eligibleOptionalItems);
  const selectItems = (count: number): readonly ProjectionItem[] => [
    ...requiredItems,
    ...optionalItems.slice(0, count),
  ];
  let selectedCount: number | undefined;
  for (let count = 0; count <= optionalItems.length; count += 1) {
    const structuredContent = renderProjection(
      logical,
      selectItems(count),
      protectedMemoryUri,
      compactMemoryUris,
      resumeFocusUri,
    );
    const measurement = measureContextBriefResponse(structuredContent, responseFormat);
    if (measurement.totalBytes <= maximumBytes) selectedCount = count;
  }
  const codeLinkedFallbackItem = currentCodeLinkedMemoryFallbackItem(logical, items);
  const projectCodeLinkedFallback = (): ProjectedContextBriefV1 | undefined => {
    if (codeLinkedFallbackItem === undefined) return undefined;
    const fallbackItems = uniqueProjectionItems([...baseRequiredItems, codeLinkedFallbackItem]);
    const structuredContent = parseContextBriefV1(
      renderProjection(logical, fallbackItems, undefined, new Set([codeLinkedFallbackItem.id]), resumeFocusUri),
    );
    const measurement = measureContextBriefResponse(structuredContent, responseFormat);
    if (measurement.totalBytes > maximumBytes) return undefined;
    return {
      maximumBytes,
      measurement,
      structuredContent,
      text: renderContextBriefForFormat(structuredContent, responseFormat),
    };
  };
  if (selectedCount === undefined) {
    const sourceAdjusted = fitRequiredSourceProjection({
      compactMemoryUris,
      logical,
      maximumBytes,
      protectedMemoryUri,
      requiredItems,
      responseFormat,
    });
    if (sourceAdjusted !== logical) {
      return projectContextBriefCore(sourceAdjusted, maximumEstimatedTokens, responseFormat, resumeFocusUri);
    }
    const codeLinkedFallback = projectCodeLinkedFallback();
    if (codeLinkedFallback !== undefined) return codeLinkedFallback;
    const structuredContent = parseContextBriefV1(renderMinimumProjection(logical, baseRequiredItems));
    const text = renderContextBriefForFormat(structuredContent, responseFormat);
    const measurement = measureContextBriefResponse(structuredContent, responseFormat);
    if (measurement.totalBytes > maximumBytes)
      throw AgentResponseBudgetTooSmallError.of(maximumBytes, measurement.totalBytes);
    return {maximumBytes, measurement, structuredContent, text};
  }
  if (
    codeLinkedFallbackItem !== undefined &&
    !selectItems(selectedCount).some(item => projectionItemKey(item) === projectionItemKey(codeLinkedFallbackItem))
  ) {
    const codeLinkedFallback = projectCodeLinkedFallback();
    if (codeLinkedFallback !== undefined) return codeLinkedFallback;
  }
  const structuredContent = parseContextBriefV1(
    renderProjection(logical, selectItems(selectedCount), protectedMemoryUri, compactMemoryUris, resumeFocusUri),
  );
  const text = renderContextBriefForFormat(structuredContent, responseFormat);
  const measurement = measureContextBriefResponse(structuredContent, responseFormat);
  return {maximumBytes, measurement, structuredContent, text};
}

function fitRequiredSourceProjection(input: {
  readonly compactMemoryUris: ReadonlySet<string>;
  readonly logical: ContextBriefLogicalResultV1;
  readonly maximumBytes: number;
  readonly protectedMemoryUri?: string;
  readonly requiredItems: readonly ProjectionItem[];
  readonly responseFormat: ContextBriefResponseFormat;
}): ContextBriefLogicalResultV1 {
  const requiredSourceId = input.requiredItems.find(item => item.lane === 'source-excerpt')?.id;
  const source = input.logical.graph.sourceExcerpts?.find(candidate => candidate.id === requiredSourceId);
  if (source === undefined) return input.logical;
  const lines = source.content.split('\n');
  for (let lineCount = lines.length - 1; lineCount >= 1; lineCount -= 1) {
    const adjusted = withAdjustedContextBriefSourceExcerpt(input.logical, source.id, {
      ...source,
      content: lines.slice(0, lineCount).join('\n'),
      endLine: Math.min(source.endLine, source.startLine + lineCount - 1),
      truncated: true,
    });
    const projection = renderProjection(
      adjusted,
      input.requiredItems,
      input.protectedMemoryUri,
      input.compactMemoryUris,
    );
    if (measureContextBriefResponse(projection, input.responseFormat).totalBytes <= input.maximumBytes) return adjusted;
  }
  return {
    ...input.logical,
    coverage: {
      ...input.logical.coverage,
      gaps: [
        CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP,
        ...input.logical.coverage.gaps.filter(gap => gap !== CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP),
      ],
    },
    graph: {...input.logical.graph, sourceExcerpts: []},
  };
}

function renderContextBriefForFormat(brief: ContextBriefV1, responseFormat: ContextBriefResponseFormat): string {
  return responseFormat === 'agent'
    ? renderContextBriefAgentViewText(projectContextBriefAgentView(brief, true))
    : renderContextBriefText(brief);
}

function measureContextBriefResponse(brief: ContextBriefV1, responseFormat: ContextBriefResponseFormat) {
  const text = renderContextBriefForFormat(brief, responseFormat);
  return measureAgentToolResponse(responseFormat === 'agent' ? {text} : {structuredContent: brief, text});
}

export function parseContextBriefJsonText(text: string): ContextBriefAgentViewV1 {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalid('text channel is not valid JSON');
  }
  if (
    !Predicate.isObject(value) ||
    value.type !== 'context-brief-agent-view' ||
    (value.version !== CONTEXT_BRIEF_AGENT_VIEW_VERSION && value.version !== CONTEXT_BRIEF_PROCEDURE_AGENT_VIEW_VERSION)
  ) {
    throw invalid('text channel is not a supported Context Brief agent view');
  }
  const allowedRootKeys = new Set([
    'activeHandoffs',
    'answer',
    'briefVersion',
    'coverage',
    'durableDecisions',
    'evidenceState',
    'graph',
    'mode',
    'output',
    'recommendedFollowUps',
    'scope',
    'stalenessAndConflicts',
    'trust',
    'type',
    'version',
    'verifiedProcedures',
  ]);
  const evidenceState = legacyEvidenceState(value);
  const mode = value.mode === undefined ? 'brief' : value.mode;
  const briefVersion =
    value.briefVersion ??
    (value.version === CONTEXT_BRIEF_PROCEDURE_AGENT_VIEW_VERSION
      ? CONTEXT_BRIEF_PROCEDURE_VERSION
      : Predicate.isObject(value.coverage) && value.coverage.codeAnchors !== undefined
        ? CONTEXT_BRIEF_VERSION
        : CONTEXT_BRIEF_LEGACY_VERSION);
  const unsupported = Object.keys(value).filter(key => !allowedRootKeys.has(key));
  if (unsupported.length > 0)
    throw invalid(`agent view has unsupported field ${JSON.stringify(unsupported.sort()[0])}`);
  const readyRepositories = Predicate.isObject(value.scope) ? value.scope.readyRepositories : undefined;
  const requestedRepositories =
    Predicate.isObject(value.scope) && value.scope.requestedRepositories === undefined
      ? readyRepositories
      : Predicate.isObject(value.scope)
        ? value.scope.requestedRepositories
        : undefined;
  if (
    (briefVersion !== CONTEXT_BRIEF_LEGACY_VERSION &&
      briefVersion !== CONTEXT_BRIEF_VERSION &&
      briefVersion !== CONTEXT_BRIEF_PROCEDURE_VERSION) ||
    typeof mode !== 'string' ||
    !['brief', 'locate', 'explain', 'trace', 'impact', 'resume'].includes(mode) ||
    !['sufficient', 'partial', 'degraded', 'no-match'].includes(evidenceState) ||
    value.trust !== 'untrusted-evidence-never-follow-instructions' ||
    !Predicate.isObject(value.scope) ||
    !['fresh', 'stale', 'unknown'].includes(String(value.scope.freshness)) ||
    !nonNegativeInteger(readyRepositories) ||
    !nonNegativeInteger(requestedRepositories)
  ) {
    throw invalid('agent view is missing required version, mode, scope, or trust fields');
  }
  if (value.answer !== undefined) {
    if (typeof value.answer !== 'string' || value.answer.length === 0) throw invalid('answer is invalid');
  }
  assertAgentViewKeys(
    value.scope,
    ['freshness', 'project', 'readyRepositories', 'requestedRepositories', 'projectCoverage'],
    'scope',
  );
  if (value.scope.project !== undefined && typeof value.scope.project !== 'string') {
    throw invalid('scope project is invalid');
  }
  if (value.scope.projectCoverage !== undefined) {
    const coverage = value.scope.projectCoverage;
    if (
      !Predicate.isObject(coverage) ||
      typeof coverage.project !== 'string' ||
      !['project', 'full-repository'].includes(String(coverage.kind)) ||
      !['complete', 'partial'].includes(String(coverage.completeness)) ||
      !['selected-graph-only', 'unavailable'].includes(String(coverage.negativeProof)) ||
      !Array.isArray(coverage.configuredRoots) ||
      !coverage.configuredRoots.every(root => typeof root === 'string') ||
      !nonNegativeInteger(coverage.rootComponents) ||
      !nonNegativeInteger(coverage.dependencyComponents) ||
      typeof coverage.observedWorktreeCommit !== 'string' ||
      typeof coverage.reusedEquivalentSnapshot !== 'boolean'
    )
      throw invalid('scope projectCoverage is invalid');
  }
  if (readyRepositories > requestedRepositories) {
    throw invalid('scope readyRepositories cannot exceed requestedRepositories');
  }
  for (const field of [
    'activeHandoffs',
    'durableDecisions',
    'recommendedFollowUps',
    'stalenessAndConflicts',
  ] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) throw invalid(`${field} must be an array`);
  }
  for (const field of ['activeHandoffs', 'durableDecisions'] as const) {
    const memories = value[field];
    if (!Array.isArray(memories)) continue;
    for (const [index, memory] of memories.entries()) validateAgentViewMemory(memory, `${field}[${index}]`);
  }
  if (value.coverage !== undefined) validateAgentViewCoverage(value.coverage);
  if (value.version === CONTEXT_BRIEF_AGENT_VIEW_VERSION) {
    if (value.verifiedProcedures !== undefined || briefVersion === CONTEXT_BRIEF_PROCEDURE_VERSION) {
      throw invalid('legacy agent views cannot carry verified procedures');
    }
  } else if (briefVersion !== CONTEXT_BRIEF_PROCEDURE_VERSION || value.verifiedProcedures === undefined) {
    throw invalid('procedure agent views require procedure-version evidence');
  }
  if (value.verifiedProcedures !== undefined) {
    try {
      parseVerifiedProcedureEvidenceList(value.verifiedProcedures);
    } catch {
      throw invalid('verifiedProcedures contains invalid evidence');
    }
  }
  if (value.graph !== undefined) {
    if (!Predicate.isObject(value.graph)) throw invalid('graph must be an object');
    assertAgentViewKeys(value.graph, ['cards', 'continuation', 'contracts', 'sources'], 'graph');
    if (value.graph.cards !== undefined && !Array.isArray(value.graph.cards))
      throw invalid('graph.cards must be an array');
    if (value.graph.contracts !== undefined && !Array.isArray(value.graph.contracts)) {
      throw invalid('graph.contracts must be an array');
    }
    if (value.graph.sources !== undefined && !Array.isArray(value.graph.sources)) {
      throw invalid('graph.sources must be an array');
    }
    for (const [index, card] of (value.graph.cards ?? []).entries()) validateAgentViewGraphCard(card, index);
    for (const [index, contract] of (value.graph.contracts ?? []).entries()) {
      validateAgentViewGraphContract(contract, index);
    }
    for (const [index, source] of (value.graph.sources ?? []).entries()) {
      validateContextBriefSourceExcerpt(source, index);
    }
    if (value.graph.continuation !== undefined) validateAgentViewContinuation(value.graph.continuation);
  }
  if (value.output !== undefined && (!Predicate.isObject(value.output) || value.output.truncated !== true)) {
    throw invalid('output must be a truncated-output receipt');
  }
  if (Predicate.isObject(value.output)) {
    assertAgentViewKeys(value.output, ['omissions', 'truncated'], 'output');
    if (
      !Predicate.isObject(value.output.omissions) ||
      Object.values(value.output.omissions).some(count => !nonNegativeInteger(count))
    ) {
      throw invalid('output omissions must contain non-negative counts');
    }
  }
  const callerCwd =
    Predicate.isObject(value.scope) && typeof value.scope.callerCwd === 'string' ? value.scope.callerCwd : undefined;
  const followUps = Array.isArray(value.recommendedFollowUps)
    ? value.recommendedFollowUps.map(followUp => normalizeLegacyFollowUp(followUp, callerCwd))
    : value.recommendedFollowUps;
  for (const [index, followUp] of (Array.isArray(followUps) ? followUps : []).entries()) {
    validateContextBriefFollowUp(followUp, `recommendedFollowUps[${index}]`);
  }
  const issues = value.stalenessAndConflicts;
  for (const [index, issue] of (Array.isArray(issues) ? issues : []).entries()) {
    if (
      !Predicate.isObject(issue) ||
      typeof issue.id !== 'string' ||
      typeof issue.kind !== 'string' ||
      !nonNegativeInteger(issue.rank) ||
      typeof issue.summary !== 'string' ||
      !stringArray(issue.uris)
    ) {
      throw invalid(`stalenessAndConflicts[${index}] is invalid`);
    }
  }
  return {
    ...value,
    ...(Array.isArray(value.activeHandoffs)
      ? {activeHandoffs: value.activeHandoffs.map(normalizeAgentViewMemory)}
      : {}),
    briefVersion,
    ...(Array.isArray(value.durableDecisions)
      ? {durableDecisions: value.durableDecisions.map(normalizeAgentViewMemory)}
      : {}),
    evidenceState,
    mode,
    scope: {
      ...value.scope,
      readyRepositories,
      requestedRepositories,
    },
    ...(followUps === undefined ? {} : {recommendedFollowUps: followUps}),
  } as unknown as ContextBriefAgentViewV1;
}

function validateAgentViewCoverage(value: unknown): void {
  if (!Predicate.isObject(value)) throw invalid('coverage must be an object');
  assertAgentViewKeys(value, ['codeAnchors', 'gaps'], 'coverage');
  if (value.gaps !== undefined && !stringArray(value.gaps)) throw invalid('coverage.gaps must be a string array');
  if (value.codeAnchors !== undefined) {
    if (!Predicate.isObject(value.codeAnchors)) throw invalid('coverage.codeAnchors must be an object');
    assertAgentViewKeys(
      value.codeAnchors,
      ['complete', 'matchedMemories', 'requested', 'resolved', 'unresolvedOrdinals'],
      'coverage.codeAnchors',
    );
    if (
      typeof value.codeAnchors.complete !== 'boolean' ||
      !nonNegativeInteger(value.codeAnchors.matchedMemories) ||
      !nonNegativeInteger(value.codeAnchors.requested) ||
      !nonNegativeInteger(value.codeAnchors.resolved) ||
      (value.codeAnchors.unresolvedOrdinals !== undefined &&
        (!Array.isArray(value.codeAnchors.unresolvedOrdinals) ||
          !value.codeAnchors.unresolvedOrdinals.every(nonNegativeInteger)))
    ) {
      throw invalid('coverage.codeAnchors is invalid');
    }
  }
}

function validateContextBriefFollowUp(value: unknown, label: string): void {
  if (
    !Predicate.isObject(value) ||
    typeof value.id !== 'string' ||
    !nonNegativeInteger(value.rank) ||
    typeof value.operation !== 'string' ||
    typeof value.tool !== 'string' ||
    !Predicate.isObject(value.arguments)
  ) {
    throw invalid(`${label} is invalid`);
  }
  const arguments_ = value.arguments;
  switch (value.operation) {
    case 'inspect-node':
      assertAgentViewKeys(value, ['arguments', 'id', 'operation', 'rank', 'ref', 'tool'], label);
      assertAgentViewKeys(
        arguments_,
        ['budgetTokens', 'callerCwd', 'edgeLimit', 'nodeId', 'nodeLimit', 'operation'],
        `${label}.arguments`,
      );
      if (
        value.tool !== 'inspect_code_graph' ||
        typeof value.ref !== 'string' ||
        typeof arguments_.callerCwd !== 'string' ||
        arguments_.operation !== 'node' ||
        arguments_.nodeId !== value.ref ||
        arguments_.budgetTokens !== CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS ||
        arguments_.nodeLimit !== CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT ||
        arguments_.edgeLimit !== CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT
      )
        throw invalid(`${label} is invalid`);
      return;
    case 'read-memory':
      assertAgentViewKeys(value, ['arguments', 'id', 'operation', 'rank', 'tool', 'uri'], label);
      assertAgentViewKeys(arguments_, ['uri'], `${label}.arguments`);
      if (value.tool !== 'read_context' || typeof value.uri !== 'string' || arguments_.uri !== value.uri)
        throw invalid(`${label} is invalid`);
      return;
    case 'continue-workset':
      assertAgentViewKeys(value, ['arguments', 'cursor', 'id', 'operation', 'rank', 'tool', 'workset'], label);
      assertAgentViewKeys(
        arguments_,
        ['budgetTokens', 'cursor', 'edgeLimit', 'nodeLimit', 'operation', 'workset'],
        `${label}.arguments`,
      );
      if (
        value.tool !== 'inspect_code_graph' ||
        typeof value.cursor !== 'string' ||
        typeof value.workset !== 'string' ||
        arguments_.operation !== 'query' ||
        arguments_.cursor !== value.cursor ||
        arguments_.workset !== value.workset ||
        arguments_.budgetTokens !== CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS ||
        arguments_.nodeLimit !== CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT ||
        arguments_.edgeLimit !== CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT
      )
        throw invalid(`${label} is invalid`);
      return;
    case 'graph-status':
      assertAgentViewKeys(value, ['arguments', 'id', 'operation', 'rank', 'scope', 'tool', 'workset'], label);
      if (
        value.tool !== 'inspect_code_graph' ||
        (value.scope !== 'repository' && value.scope !== 'workset') ||
        arguments_.operation !== 'query' ||
        arguments_.query !== 'code graph readiness' ||
        arguments_.budgetTokens !== CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS ||
        arguments_.nodeLimit !== CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT ||
        arguments_.edgeLimit !== CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT
      )
        throw invalid(`${label} is invalid`);
      if (value.scope === 'repository') {
        assertAgentViewKeys(
          arguments_,
          ['budgetTokens', 'callerCwd', 'edgeLimit', 'nodeLimit', 'operation', 'query'],
          `${label}.arguments`,
        );
      } else {
        assertAgentViewKeys(
          arguments_,
          ['budgetTokens', 'edgeLimit', 'nodeLimit', 'operation', 'query', 'workset'],
          `${label}.arguments`,
        );
        if (typeof value.workset !== 'string' || arguments_.workset !== value.workset)
          throw invalid(`${label} is invalid`);
      }
      return;
    default:
      throw invalid(`${label} is invalid`);
  }
}

function normalizeLegacyFollowUp(value: unknown, scopeCallerCwd?: string): unknown {
  if (!Predicate.isObject(value) || value.tool !== undefined || value.arguments !== undefined) return value;
  if (typeof value.id !== 'string' || !nonNegativeInteger(value.rank)) return value;
  switch (value.operation) {
    case 'inspect-node':
      return typeof value.ref !== 'string' || typeof value.callerCwd !== 'string'
        ? value
        : {
            ...withoutLegacyCallerCwd(value),
            arguments: {
              budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
              callerCwd: value.callerCwd,
              edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
              nodeId: value.ref,
              nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
              operation: 'node',
            },
            tool: 'inspect_code_graph',
          };
    case 'read-memory':
      return typeof value.uri !== 'string' ? value : {...value, arguments: {uri: value.uri}, tool: 'read_context'};
    case 'continue-workset':
      return typeof value.cursor !== 'string' || typeof value.workset !== 'string'
        ? value
        : {
            ...value,
            arguments: {
              budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
              cursor: value.cursor,
              edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
              nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
              operation: 'query',
              workset: value.workset,
            },
            tool: 'inspect_code_graph',
          };
    case 'graph-status':
      return (value.scope !== 'repository' && value.scope !== 'workset') ||
        (value.scope === 'workset' && typeof value.workset !== 'string')
        ? value
        : {
            ...withoutLegacyCallerCwd(value),
            arguments:
              value.scope === 'repository'
                ? {
                    budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
                    callerCwd: typeof value.callerCwd === 'string' ? value.callerCwd : scopeCallerCwd,
                    edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
                    nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
                    operation: 'query',
                    query: 'code graph readiness',
                  }
                : {
                    budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
                    edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
                    nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
                    operation: 'query',
                    query: 'code graph readiness',
                    workset: value.workset,
                  },
            tool: 'inspect_code_graph',
          };
    default:
      return value;
  }
}

function withoutLegacyCallerCwd(value: Record<string, unknown>): Record<string, unknown> {
  const {callerCwd: _callerCwd, ...withoutCallerCwd} = value;
  return withoutCallerCwd;
}

function validateAgentViewGraphCard(value: unknown, index: number): void {
  const label = `graph.cards[${index}]`;
  if (!Predicate.isObject(value)) throw invalid(`${label} must be an object`);
  assertAgentViewKeys(value, ['kind', 'line', 'path', 'qualifiedName', 'reason', 'ref', 'repositoryKey'], label);
  if (
    !['kind', 'path', 'qualifiedName', 'reason', 'ref', 'repositoryKey'].every(
      field => typeof value[field] === 'string',
    ) ||
    !nonNegativeInteger(value.line)
  ) {
    throw invalid(`${label} is invalid`);
  }
}

function validateAgentViewGraphContract(value: unknown, index: number): void {
  const label = `graph.contracts[${index}]`;
  if (!Predicate.isObject(value)) throw invalid(`${label} must be an object`);
  assertAgentViewKeys(value, ['authority', 'evidence', 'provenance', 'relation', 'sourceRef', 'targetRef'], label);
  if (
    !['authority', 'provenance', 'relation', 'sourceRef', 'targetRef'].every(
      field => typeof value[field] === 'string',
    ) ||
    !Predicate.isObject(value.evidence) ||
    typeof value.evidence.path !== 'string' ||
    (value.evidence.pathTruncated !== undefined && value.evidence.pathTruncated !== true) ||
    typeof value.evidence.repositoryKey !== 'string' ||
    (value.evidence.repositoryKeyTruncated !== undefined && value.evidence.repositoryKeyTruncated !== true) ||
    !nonNegativeInteger(value.evidence.line)
  ) {
    throw invalid(`${label} is invalid`);
  }
  assertAgentViewKeys(
    value.evidence,
    ['line', 'path', 'pathTruncated', 'repositoryKey', 'repositoryKeyTruncated'],
    `${label}.evidence`,
  );
}

function validateAgentViewContinuation(value: unknown): void {
  if (!Predicate.isObject(value)) throw invalid('graph.continuation must be an object');
  if (value.state === 'available') {
    assertAgentViewKeys(value, ['cursor', 'remainingEstimate', 'state'], 'graph.continuation');
    if (typeof value.cursor !== 'string' || !nonNegativeInteger(value.remainingEstimate)) {
      throw invalid('available graph continuation is invalid');
    }
    return;
  }
  if (value.state === 'rerun-required') {
    assertAgentViewKeys(value, ['omittedCards', 'state', 'upstreamRemainingEstimate'], 'graph.continuation');
    if (
      !nonNegativeInteger(value.omittedCards) ||
      (value.upstreamRemainingEstimate !== undefined && !nonNegativeInteger(value.upstreamRemainingEstimate))
    ) {
      throw invalid('rerun-required graph continuation is invalid');
    }
    return;
  }
  throw invalid('graph continuation state is invalid');
}

function validateAgentViewMemory(value: unknown, label: string): void {
  if (!Predicate.isObject(value)) throw invalid(`${label} must be an object`);
  assertAgentViewKeys(
    value,
    [
      'actionCard',
      'continuationCard',
      'authority',
      'citationActions',
      'citationDetailsOmitted',
      'citationSummary',
      'codeRelations',
      'excerpt',
      'freshness',
      'freshnessBasis',
      'memoryTrust',
      'preciseStatus',
      'selectionBasis',
      'uri',
    ],
    label,
  );
  const freshnessBasis =
    value.freshnessBasis ?? (value.selectionBasis === 'code-citation' ? 'code-citations' : 'source-commit');
  if (
    typeof value.excerpt !== 'string' ||
    (value.citationDetailsOmitted !== undefined && value.citationDetailsOmitted !== true) ||
    !['fresh', 'stale', 'unknown'].includes(String(value.freshness)) ||
    !['code-citations', 'source-commit'].includes(String(freshnessBasis)) ||
    typeof value.uri !== 'string' ||
    !value.uri.startsWith('threadnote://') ||
    (value.authority !== undefined &&
      !['agent_generated', 'canonical_repo', 'external', 'reviewed_shared', 'user_approved'].includes(
        String(value.authority),
      )) ||
    (value.memoryTrust !== undefined && !['approved', 'inferred', 'untrusted'].includes(String(value.memoryTrust))) ||
    (value.preciseStatus !== undefined &&
      !['exact', 'relocated', 'changed', 'deleted', 'unknown'].includes(String(value.preciseStatus))) ||
    (value.selectionBasis !== undefined && value.selectionBasis !== 'code-citation')
  ) {
    throw invalid(`${label} is invalid`);
  }
  if (value.actionCard !== undefined) {
    if (!Predicate.isObject(value.actionCard)) throw invalid(`${label}.actionCard must be an object`);
    assertAgentViewKeys(value.actionCard, ['appliesTo', 'invariant', 'avoid', 'verify'], `${label}.actionCard`);
    if (
      typeof value.actionCard.appliesTo !== 'string' ||
      typeof value.actionCard.invariant !== 'string' ||
      (value.actionCard.avoid !== undefined && typeof value.actionCard.avoid !== 'string') ||
      (value.actionCard.verify !== undefined && typeof value.actionCard.verify !== 'string')
    )
      throw invalid(`${label}.actionCard is invalid`);
  }
  if (value.continuationCard !== undefined)
    validateContinuationCard(value.continuationCard, `${label}.continuationCard`);
  if (value.citationActions !== undefined && !Array.isArray(value.citationActions)) {
    throw invalid(`${label}.citationActions must be an array`);
  }
  for (const [index, action] of (Array.isArray(value.citationActions) ? value.citationActions : []).entries()) {
    if (!Predicate.isObject(action)) throw invalid(`${label}.citationActions[${index}] must be an object`);
    assertAgentViewKeys(
      action,
      ['count', 'observedNodeIds', 'reason', 'relocationHints', 'status'],
      `${label}.citationActions[${index}]`,
    );
    const observedNodeIds = action.observedNodeIds;
    const relocationHints = action.relocationHints;
    if (
      !Number.isSafeInteger(action.count) ||
      Number(action.count) < 1 ||
      Number(action.count) > CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS ||
      typeof action.reason !== 'string' ||
      !['relocated', 'changed', 'deleted', 'unknown'].includes(String(action.status)) ||
      (observedNodeIds !== undefined &&
        (!stringArray(observedNodeIds) ||
          observedNodeIds.length < 1 ||
          observedNodeIds.length > Number(action.count))) ||
      (relocationHints !== undefined &&
        (!stringArray(relocationHints) || relocationHints.length < 1 || relocationHints.length > Number(action.count)))
    ) {
      throw invalid(`${label}.citationActions[${index}] is invalid`);
    }
  }
  if (value.codeRelations !== undefined && !isBoundedPublicCodeRelations(value.codeRelations)) {
    throw invalid(`${label}.codeRelations must be a bounded array`);
  }
  for (const [index, relation] of (isUnknownArray(value.codeRelations) ? value.codeRelations : []).entries()) {
    if (
      !Predicate.isObject(relation) ||
      !nonNegativeInteger(relation.anchorOrdinal) ||
      typeof relation.citationId !== 'string' ||
      !['file', 'symbol'].includes(String(relation.kind)) ||
      !['exact', 'relocated', 'changed', 'deleted', 'unknown'].includes(String(relation.status))
    ) {
      throw invalid(`${label}.codeRelations[${index}] is invalid`);
    }
    assertAgentViewKeys(
      relation,
      ['anchorOrdinal', 'citationId', 'kind', 'status'],
      `${label}.codeRelations[${index}]`,
    );
  }
  if (value.citationSummary !== undefined && !Predicate.isObject(value.citationSummary)) {
    throw invalid(`${label}.citationSummary must be an object`);
  }
  if (Predicate.isObject(value.citationSummary)) {
    const summary = value.citationSummary;
    assertAgentViewKeys(summary, ['coverage', 'exact', 'relocated', 'stale', 'unknown'], `${label}.citationSummary`);
    if (
      !['current-complete', 'incomplete'].includes(String(summary.coverage)) ||
      !(['exact', 'relocated', 'stale', 'unknown'] as const).every(field => nonNegativeInteger(summary[field]))
    ) {
      throw invalid(`${label}.citationSummary is invalid`);
    }
  }
}

function normalizeAgentViewMemory(value: unknown): unknown {
  if (!Predicate.isObject(value)) return value;
  return {
    ...value,
    freshnessBasis:
      value.freshnessBasis ?? (value.selectionBasis === 'code-citation' ? 'code-citations' : 'source-commit'),
  };
}

function validateContinuationCard(value: unknown, label: string): void {
  if (!Predicate.isObject(value)) throw invalid(`${label} must be an object`);
  const allowed =
    'anchors attempted avoidRepeat blockers decisions graphQuery graphQuestion invariants nextStep observations rationale risks task unresolved verification';
  assertAgentViewKeys(value, allowed.split(' '), label);
  if (
    Object.keys(value).length === 0 ||
    Object.values(value).some(field => typeof field !== 'string' || field.length === 0)
  ) {
    throw invalid(`${label} is invalid`);
  }
}

function assertAgentViewKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unsupported.length > 0) throw invalid(`${label} has unsupported field ${JSON.stringify(unsupported.sort()[0])}`);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Strict validation for the compact CLI/MCP-ready structured projection. */
export function parseContextBriefV1(value: unknown): ContextBriefV1 {
  if (!Predicate.isObject(value)) throw invalid('projection must be an object');
  const object: Record<string, unknown> = {
    ...value,
    evidenceState: legacyEvidenceState(value),
    recommendedFollowUps: Array.isArray(value.recommendedFollowUps)
      ? value.recommendedFollowUps.map(followUp => normalizeLegacyFollowUp(followUp))
      : value.recommendedFollowUps,
  };
  const unknown = Object.keys(object).filter(key => !ROOT_KEYS.has(key));
  if (unknown.length > 0) throw invalid(`projection has unsupported field ${JSON.stringify(unknown.sort()[0])}`);
  if (
    object.type !== 'context-brief' ||
    (object.version !== CONTEXT_BRIEF_LEGACY_VERSION &&
      object.version !== CONTEXT_BRIEF_VERSION &&
      object.version !== CONTEXT_BRIEF_PROCEDURE_VERSION)
  ) {
    throw invalid('projection type or version is unsupported');
  }
  for (const field of [
    'activeHandoffs',
    'durableDecisions',
    'recommendedFollowUps',
    'stalenessAndConflicts',
  ] as const) {
    const values = object[field];
    if (!isUnknownArray(values)) throw invalid(`${field} must be an array`);
    if (field !== 'activeHandoffs' && field !== 'durableDecisions') continue;
    for (const [index, memory] of values.entries()) {
      if (!Predicate.isObject(memory)) throw invalid(`${field}[${index}] must be an object`);
      if (memory.codeRelations !== undefined && !isBoundedPublicCodeRelations(memory.codeRelations)) {
        throw invalid(`${field}[${index}].codeRelations must be a bounded array`);
      }
    }
  }
  const structuredFollowUps = object.recommendedFollowUps;
  for (const [index, followUp] of (Array.isArray(structuredFollowUps) ? structuredFollowUps : []).entries()) {
    validateContextBriefFollowUp(followUp, `recommendedFollowUps[${index}]`);
  }
  if (object.version === CONTEXT_BRIEF_PROCEDURE_VERSION) {
    if (object.verifiedProcedures === undefined) throw invalid('procedure projection requires verifiedProcedures');
  } else if (object.verifiedProcedures !== undefined) {
    throw invalid('legacy projections cannot carry verifiedProcedures');
  }
  if (object.verifiedProcedures !== undefined) {
    try {
      parseVerifiedProcedureEvidenceList(object.verifiedProcedures);
    } catch {
      throw invalid('verifiedProcedures contains invalid evidence');
    }
  }
  if (
    !Predicate.isObject(object.graph) ||
    !Array.isArray(object.graph.cards) ||
    !Array.isArray(object.graph.contracts)
  ) {
    throw invalid('graph must contain card and contract arrays');
  }
  if (object.graph.sources !== undefined) {
    if (!Array.isArray(object.graph.sources)) throw invalid('graph.sources must be an array');
    for (const [index, source] of object.graph.sources.entries()) {
      validateContextBriefSourceExcerpt(source, index);
    }
  }
  if (!Predicate.isObject(object.coverage) || !Predicate.isObject(object.trust) || !Predicate.isObject(object.output)) {
    throw invalid('coverage, trust, and output are required');
  }
  const output = object.output;
  if (
    output.projectorVersion !==
      (object.version === CONTEXT_BRIEF_LEGACY_VERSION
        ? CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION
        : object.version === CONTEXT_BRIEF_VERSION
          ? CONTEXT_BRIEF_PROJECTOR_VERSION
          : CONTEXT_BRIEF_PROCEDURE_PROJECTOR_VERSION) ||
    !nonNegativeInteger(output.omittedItems) ||
    !nonNegativeInteger(output.returnedItems) ||
    typeof output.truncated !== 'boolean'
  ) {
    throw invalid('output receipt is invalid');
  }
  return object as unknown as ContextBriefV1;
}

function renderProjection(
  logical: ContextBriefLogicalResultV1,
  selected: readonly ProjectionItem[],
  protectedMemoryUri?: string,
  compactMemoryUris: ReadonlySet<string> = new Set(),
  resumeFocusUri?: string,
): ContextBriefV1 {
  const selectedByLane = new Map<ProjectionLane, Set<string>>();
  for (const item of selected) {
    const ids = selectedByLane.get(item.lane) ?? new Set<string>();
    ids.add(item.id);
    selectedByLane.set(item.lane, ids);
  }
  const cards = selectById(logical.graph.cards, selectedByLane.get('graph-card')).map(compactProjectedGraphCard);
  const contracts = selectById(logical.graph.contracts, selectedByLane.get('graph-contract')).map(
    compactProjectedGraphContract,
  );
  const retainedGraphRefs = new Set([
    ...cards.map(card => card.ref),
    ...contracts.flatMap(contract => [contract.sourceRef, contract.targetRef]),
  ]);
  const sources = selectContextBriefProjectedSources(logical, selectedByLane.get('source-excerpt'), retainedGraphRefs);
  const durableDecisions = selectById(logical.durableDecisions, selectedByLane.get('durable-decision'), 'uri').map(
    memory =>
      compactProjectedMemory(
        memory,
        memory.uri === protectedMemoryUri,
        logical.coverage.memory.codeAnchors !== undefined,
        compactMemoryUris.has(memory.uri),
        true,
        logical.mode === 'resume',
        memory.uri === resumeFocusUri,
      ),
  );
  const activeHandoffs = selectById(logical.activeHandoffs, selectedByLane.get('handoff'), 'uri').map(memory =>
    compactProjectedMemory(
      memory,
      memory.uri === protectedMemoryUri,
      logical.coverage.memory.codeAnchors !== undefined,
      compactMemoryUris.has(memory.uri),
      true,
      logical.mode === 'resume',
      memory.uri === resumeFocusUri,
    ),
  );
  const stalenessAndConflicts = selectById(logical.stalenessAndConflicts, selectedByLane.get('issue')).map(issue =>
    compactProjectedIssue(logical, issue, logical.coverage.memory.codeAnchors !== undefined),
  );
  const selectedFollowUps = selectById(logical.recommendedFollowUps, selectedByLane.get('follow-up')).map(followUp =>
    compactProjectedFollowUp(logical, followUp, logical.coverage.memory.codeAnchors !== undefined),
  );
  const selectedProcedureIds = selectedByLane.get('verified-procedure');
  const logicalVerifiedProcedures = logical.verifiedProcedures ?? [];
  const verifiedProcedures = logicalVerifiedProcedures.filter(procedure =>
    selectedProcedureIds?.has(procedureProjectionId(procedure)),
  );
  const selectedGapIds = selectedByLane.get('coverage-gap');
  const gaps = logical.coverage.gaps.filter(gap => selectedGapIds?.has(coverageGapProjectionId(gap)) === true);
  const evidenceState = deriveContextBriefEvidenceState({
    activeHandoffs,
    cards,
    contracts,
    durableDecisions,
    gaps,
    logical,
    resumeFocusUri,
    sources,
  });
  const recommendedFollowUps = evidenceState === 'sufficient' ? [] : selectedFollowUps;
  const sourceExcerpts = contextBriefSourceExcerptOmissionCount(logical, sources.length);
  const omissions = {
    activeHandoffs: logical.activeHandoffs.length - activeHandoffs.length,
    coverageGaps: logical.coverage.gaps.length - gaps.length,
    durableDecisions: logical.durableDecisions.length - durableDecisions.length,
    graphCards: logical.graph.cards.length - cards.length,
    graphContracts: logical.graph.contracts.length - contracts.length,
    ...(sourceExcerpts === 0 ? {} : {sourceExcerpts}),
    recommendedFollowUps: logical.recommendedFollowUps.length - recommendedFollowUps.length,
    stalenessAndConflicts: logical.stalenessAndConflicts.length - stalenessAndConflicts.length,
    ...(logicalVerifiedProcedures.length === 0
      ? {}
      : {verifiedProcedures: logicalVerifiedProcedures.length - verifiedProcedures.length}),
  };
  const omittedItems = Object.values(omissions).reduce((total, value) => total + value, 0);
  const taskSummary = jsonStringPrefix(logical.task, 96);
  const task = {summary: taskSummary, truncated: taskSummary !== logical.task};
  return {
    activeHandoffs,
    coverage: {
      ...logical.coverage,
      graph: logical.coverage.graph,
      gaps,
      memory: logical.coverage.memory,
      omissions,
    },
    durableDecisions,
    evidenceState,
    graph: {
      cards,
      ...(resumeFocusUri !== undefined
        ? {}
        : cards.length < logical.graph.cards.length
          ? {
              continuation: {
                omittedCards: logical.graph.cards.length - cards.length,
                state: 'rerun-required' as const,
                ...(logical.graph.continuation === undefined
                  ? {}
                  : {upstreamRemainingEstimate: logical.graph.continuation.remainingEstimate}),
              },
            }
          : logical.graph.continuation === undefined
            ? {}
            : {
                continuation: {
                  cursor: logical.graph.continuation.cursor,
                  remainingEstimate: logical.graph.continuation.remainingEstimate,
                  state: 'available' as const,
                },
              }),
      contracts,
      ...(sources.length === 0 ? {} : {sources}),
    },
    mode: logical.mode,
    output: {
      omittedItems,
      projectorVersion:
        logical.version === CONTEXT_BRIEF_LEGACY_VERSION
          ? CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION
          : logical.version === CONTEXT_BRIEF_VERSION
            ? CONTEXT_BRIEF_PROJECTOR_VERSION
            : CONTEXT_BRIEF_PROCEDURE_PROJECTOR_VERSION,
      returnedItems: selected.length - selectedFollowUps.length + recommendedFollowUps.length,
      truncated: omittedItems > 0,
    },
    recommendedFollowUps,
    scope: compactContextBriefScope(logical.scope),
    stalenessAndConflicts,
    task,
    trust: logical.trust,
    type: 'context-brief',
    version: logical.version,
    ...(logicalVerifiedProcedures.length === 0 ? {} : {verifiedProcedures}),
  };
}

/**
 * Last-resort MCP projection for a valid public budget whose normal safety core is inflated by
 * optional diagnostic detail. Keep the actionable recovery, scope counts, and omission receipts;
 * omit unbounded task and project-coverage display detail rather than failing the entire brief.
 */
function renderMinimumProjection(
  logical: ContextBriefLogicalResultV1,
  requiredItems: readonly ProjectionItem[],
): ContextBriefV1 {
  const continueWorksetIds = new Set(
    logical.recommendedFollowUps
      .filter(followUp => followUp.operation === 'continue-workset')
      .map(followUp => followUp.id),
  );
  const recoveryIds = new Set(
    requiredItems
      .filter(
        item => item.lane === 'follow-up' && (logical.graph.cards.length === 0 || !continueWorksetIds.has(item.id)),
      )
      .map(item => item.id),
  );
  const recommendedFollowUps = logical.recommendedFollowUps.filter(followUp => recoveryIds.has(followUp.id));
  const gaps = logical.coverage.gaps.slice(0, 1);
  const sourceExcerpts = contextBriefSourceExcerptOmissionCount(logical);
  const omissions = {
    activeHandoffs: logical.activeHandoffs.length,
    coverageGaps: logical.coverage.gaps.length - gaps.length,
    durableDecisions: logical.durableDecisions.length,
    graphCards: logical.graph.cards.length,
    graphContracts: logical.graph.contracts.length,
    ...(sourceExcerpts === 0 ? {} : {sourceExcerpts}),
    recommendedFollowUps: logical.recommendedFollowUps.length - recommendedFollowUps.length,
    stalenessAndConflicts: logical.stalenessAndConflicts.length,
    ...(logical.verifiedProcedures === undefined ? {} : {verifiedProcedures: logical.verifiedProcedures.length}),
  };
  const omittedItems = Object.values(omissions).reduce((total, value) => total + value, 0) + 1;
  return {
    activeHandoffs: [],
    coverage: {
      gaps,
      graph: logical.coverage.graph,
      memory: logical.coverage.memory,
      omissions,
    },
    durableDecisions: [],
    evidenceState: logical.graph.cards.length === 0 ? 'no-match' : 'partial',
    graph: {
      cards: [],
      ...(logical.graph.cards.length === 0
        ? {}
        : {continuation: {omittedCards: logical.graph.cards.length, state: 'rerun-required' as const}}),
      contracts: [],
    },
    mode: logical.mode,
    output: {
      omittedItems,
      projectorVersion:
        logical.version === CONTEXT_BRIEF_LEGACY_VERSION
          ? CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION
          : logical.version === CONTEXT_BRIEF_VERSION
            ? CONTEXT_BRIEF_PROJECTOR_VERSION
            : CONTEXT_BRIEF_PROCEDURE_PROJECTOR_VERSION,
      returnedItems: recommendedFollowUps.length,
      truncated: true,
    },
    recommendedFollowUps,
    scope: compactMinimumContextBriefScope(logical.scope),
    stalenessAndConflicts: [],
    task: {summary: '', truncated: true},
    trust: logical.trust,
    type: 'context-brief',
    version: logical.version,
    ...(logical.version === CONTEXT_BRIEF_PROCEDURE_VERSION ? {verifiedProcedures: []} : {}),
  };
}

function projectionItems(
  logical: ContextBriefLogicalResultV1,
  responseFormat: ContextBriefResponseFormat,
  resumeFocusUri?: string,
): readonly ProjectionItem[] {
  const hasCurrentCodeRelation = (memory: ContextBriefLogicalMemoryEvidenceV1): boolean =>
    (memory.cohortCodeRelations ?? memory.codeRelations ?? []).some(
      relation => relation.status === 'exact' || relation.status === 'relocated',
    );
  const hasCodeLinkedMemory = [...logical.activeHandoffs, ...logical.durableDecisions].some(
    memory => memory.selectionBasis === 'code-citation',
  );
  const hasCurrentCodeLinkedMemory = [...logical.activeHandoffs, ...logical.durableDecisions].some(
    memory => memory.selectionBasis === 'code-citation' && hasCurrentCodeRelation(memory),
  );
  const firstStaleCodeLinkedMemoryUri = hasCurrentCodeLinkedMemory
    ? undefined
    : [...logical.activeHandoffs, ...logical.durableDecisions]
        .filter(memory => memory.selectionBasis === 'code-citation')
        .sort((left, right) => left.rank - right.rank || compareText(left.uri, right.uri))[0]?.uri;
  const sourceFirst =
    responseFormat === 'agent' && logical.coverage.memory.codeAnchors === undefined && logical.mode === 'locate';
  // Reserve one linked memory, then the exact card, before admitting more stale handoffs.
  const projected = [
    ...logical.coverage.gaps.map((gap, rank) => ({
      id: coverageGapProjectionId(gap),
      lane: 'coverage-gap' as const,
      laneRank: rank,
      priority: 3,
    })),
    ...logical.graph.cards.map(card => ({
      id: card.id,
      lane: 'graph-card' as const,
      laneRank: card.rank,
      priority: sourceFirst
        ? 0
        : hasCodeLinkedMemory
          ? card.rank === 0
            ? hasCurrentCodeLinkedMemory
              ? 1
              : -1
            : 2
          : 0,
    })),
    ...logical.activeHandoffs.map(memory => ({
      id: memory.uri,
      lane: 'handoff' as const,
      laneRank: memory.rank,
      priority: sourceFirst
        ? 2
        : hasCodeLinkedMemory
          ? memory.selectionBasis === 'code-citation'
            ? hasCurrentCodeRelation(memory)
              ? 0
              : hasCurrentCodeLinkedMemory
                ? 2
                : memory.uri === firstStaleCodeLinkedMemoryUri
                  ? -2
                  : 1
            : 2
          : 0,
    })),
    ...logical.durableDecisions.map(memory => ({
      id: memory.uri,
      lane: 'durable-decision' as const,
      laneRank: memory.rank,
      priority: sourceFirst
        ? 2
        : hasCodeLinkedMemory
          ? memory.selectionBasis === 'code-citation'
            ? hasCurrentCodeRelation(memory)
              ? 0
              : hasCurrentCodeLinkedMemory
                ? 2
                : memory.uri === firstStaleCodeLinkedMemoryUri
                  ? -2
                  : 1
            : 2
          : 0,
    })),
    ...logical.graph.contracts.map(contract => ({
      id: contract.id,
      lane: 'graph-contract' as const,
      laneRank: contract.rank,
      priority: sourceFirst
        ? 3
        : hasCodeLinkedMemory && (logical.mode === 'trace' || logical.mode === 'impact') && contract.rank === 0
          ? 0
          : hasCodeLinkedMemory
            ? 2
            : 0,
    })),
    ...contextBriefSourceProjectionItems(logical),
    ...logical.stalenessAndConflicts.map(issue => ({
      id: issue.id,
      lane: 'issue' as const,
      laneRank: issue.rank,
      priority: sourceFirst ? 4 : hasCodeLinkedMemory ? 2 : 0,
    })),
    ...logical.recommendedFollowUps.map(followUp => ({
      id: followUp.id,
      lane: 'follow-up' as const,
      laneRank: followUp.rank,
      priority: sourceFirst ? 3 : hasCodeLinkedMemory ? 2 : 0,
    })),
    ...(logical.verifiedProcedures ?? []).map((procedure, rank) => ({
      id: procedureProjectionId(procedure),
      lane: 'verified-procedure' as const,
      laneRank: rank,
      priority: -3,
    })),
  ].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.laneRank - right.laneRank ||
      lanePriority(left.lane) - lanePriority(right.lane) ||
      compareText(left.id, right.id),
  );
  if (resumeFocusUri === undefined) return projected;
  const primaryGraphCardId = [...logical.graph.cards].sort(
    (left, right) => left.rank - right.rank || compareText(left.id, right.id),
  )[0]?.id;
  return projected.filter(
    item =>
      (item.lane === 'handoff' && item.id === resumeFocusUri) ||
      (item.lane === 'graph-card' && item.id === primaryGraphCardId) ||
      (item.lane === 'coverage-gap' && !isContextBriefGraphOnlyGap(item.id.slice('gap:'.length))) ||
      item.lane === 'verified-procedure',
  );
}

/** Keep one explicit limitation whenever the logical result contains coverage gaps. */
function requiredCoverageGapItem(items: readonly ProjectionItem[]): ProjectionItem | undefined {
  return items.find(item => item.lane === 'coverage-gap');
}

/** A bounded locate answer must not strand a partial or unprepared Workset. */
function requiredAgentWorksetRecoveryItems(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
  responseFormat: ContextBriefResponseFormat,
): readonly ProjectionItem[] {
  if (
    responseFormat !== 'agent' ||
    logical.mode !== 'locate' ||
    logical.scope.kind !== 'workset' ||
    logical.coverage.memory.codeAnchors !== undefined
  ) {
    return [];
  }
  const recoveryIds = new Set(
    logical.recommendedFollowUps
      .filter(followUp => followUp.operation === 'continue-workset' && logical.graph.cards.length <= 2)
      .map(followUp => followUp.id),
  );
  return items.filter(item => item.lane === 'follow-up' && recoveryIds.has(item.id));
}

/**
 * Agent responses must keep the evidence named by their recovery action, not only the selector.
 * Relationship modes also retain the highest-ranked direct contract for that primary card.
 */
function requiredAgentGraphEvidenceItems(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
  responseFormat: ContextBriefResponseFormat,
  recoveryItem: ProjectionItem | undefined,
): readonly ProjectionItem[] {
  if (responseFormat !== 'agent') return [];
  const recovery =
    recoveryItem?.lane === 'follow-up'
      ? logical.recommendedFollowUps.find(followUp => followUp.id === recoveryItem.id)
      : undefined;
  if (recovery?.operation === 'graph-status') return [];
  const primaryCard =
    recovery?.operation === 'inspect-node'
      ? logical.graph.cards.find(card => card.ref === recovery.ref)
      : [...logical.graph.cards].sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))[0];
  if (primaryCard === undefined) return [];
  const cardItem = items.find(item => item.lane === 'graph-card' && item.id === primaryCard.id);
  if (cardItem === undefined) return [];
  if (logical.mode === 'locate' && logical.coverage.memory.codeAnchors === undefined) {
    const secondCard = [...logical.graph.cards]
      .filter(card => card.id !== primaryCard.id)
      .sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))[0];
    const secondCardItem =
      secondCard === undefined
        ? undefined
        : items.find(item => item.lane === 'graph-card' && item.id === secondCard.id);
    return secondCardItem === undefined ? [cardItem] : [cardItem, secondCardItem];
  }
  if (logical.mode !== 'trace' && logical.mode !== 'impact') {
    return [cardItem];
  }
  const directContract = [...logical.graph.contracts]
    .filter(contract => contract.sourceRef === primaryCard.ref || contract.targetRef === primaryCard.ref)
    .sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))[0];
  const contractItem =
    directContract === undefined
      ? undefined
      : items.find(item => item.lane === 'graph-contract' && item.id === directContract.id);
  return contractItem === undefined ? [cardItem] : [cardItem, contractItem];
}

/**
 * A projected graph page that drops cards cannot expose its upstream cursor: doing so would skip
 * the omitted part of the current page. Reserve the planner's first exact card selector instead.
 * If the ready snapshot itself could not be read, reserve the bounded graph-query retry.
 * Every successful partial response therefore gives both MCP channels one next action.
 */
function requiredGraphRecoveryItem(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
): ProjectionItem | undefined {
  const graphStatus = logical.recommendedFollowUps.find(candidate => candidate.operation === 'graph-status');
  const staleRepositoryAnchors =
    logical.scope.kind === 'repository' &&
    logical.scope.freshness === 'stale' &&
    logical.scope.readyRepositories > 0 &&
    logical.coverage.memory.codeAnchors?.complete === false;
  if (staleRepositoryAnchors && graphStatus !== undefined) {
    return items.find(item => item.lane === 'follow-up' && item.id === graphStatus.id);
  }
  if (logical.graph.cards.length === 0) {
    if (logical.scope.readyRepositories !== 0 && !logical.coverage.gaps.includes('graph-repository-read-failed')) {
      return undefined;
    }
    if (graphStatus === undefined) return undefined;
    return items.find(item => item.lane === 'follow-up' && item.id === graphStatus.id);
  }
  const cardRefs = new Set(logical.graph.cards.map(card => card.ref));
  const followUp = [...logical.recommendedFollowUps]
    .filter(candidate => candidate.operation === 'inspect-node' && cardRefs.has(candidate.ref))
    .sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))[0];
  if (followUp === undefined) return undefined;
  return items.find(item => item.lane === 'follow-up' && item.id === followUp.id);
}

/** Select one budget-independent ambiguity, relationship, and recovery core for every public budget. */
function requiredCodeLinkedEvidenceCore(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
  baseRequiredItems: readonly ProjectionItem[],
  responseFormat: ContextBriefResponseFormat,
): CodeLinkedEvidenceCoreProjection {
  const memories = new Map(
    [...logical.activeHandoffs, ...logical.durableDecisions].map(memory => [memory.uri, memory] as const),
  );
  const byAnchor = new Map<number, ProjectionItem[]>();
  for (const item of items) {
    if (item.lane !== 'handoff' && item.lane !== 'durable-decision') continue;
    const memory = memories.get(item.id);
    if (memory?.selectionBasis !== 'code-citation') continue;
    const ordinals = new Set(
      (memory.cohortCodeRelations ?? memory.codeRelations ?? [])
        .filter(relation => relation.status === 'exact' || relation.status === 'relocated')
        .map(relation => relation.anchorOrdinal),
    );
    for (const ordinal of ordinals) {
      const group = byAnchor.get(ordinal) ?? [];
      group.push(item);
      byAnchor.set(ordinal, group);
    }
  }

  const groups = [...byAnchor.entries()]
    .sort(([left], [right]) => left - right)
    .map(([anchorOrdinal, rawItems]) => ({anchorOrdinal, items: uniqueProjectionItems(rawItems)}))
    .filter(group => group.items.length >= 2);
  const pendingGroups = [...groups];
  const connectedGroups: (typeof groups)[] = [];
  while (pendingGroups.length > 0) {
    const seed = pendingGroups.shift()!;
    const component = [seed];
    const componentKeys = new Set(seed.items.map(projectionItemKey));
    for (let index = 0; index < pendingGroups.length;) {
      const group = pendingGroups[index];
      if (!group.items.some(item => componentKeys.has(projectionItemKey(item)))) {
        index += 1;
        continue;
      }
      component.push(group);
      for (const item of group.items) componentKeys.add(projectionItemKey(item));
      pendingGroups.splice(index, 1);
      index = 0;
    }
    connectedGroups.push(component);
  }

  const components = connectedGroups.map(component => ({
    anchorCount: component.length,
    requiredItems: uniqueProjectionItems(component.flatMap(group => group.items.slice(0, 2))),
  }));
  const allAmbiguityItems = uniqueProjectionItems(
    connectedGroups.flatMap(component => component.flatMap(group => group.items)),
  );
  const allCohortKeys = new Set(allAmbiguityItems.map(projectionItemKey));
  const maximumPublicBytes = projectionMaximumBytes(CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS);
  const defaultPublicBytes = projectionMaximumBytes(CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS);
  let selected: EvidenceCoreCandidate | undefined;
  for (let mask = 0; mask < 2 ** components.length; mask += 1) {
    const selectedComponents = components.filter((_, index) => (mask & (1 << index)) !== 0);
    const admittedItems = uniqueProjectionItems(selectedComponents.flatMap(component => component.requiredItems));
    const admittedKeys = new Set(admittedItems.map(projectionItemKey));
    const ambiguityExclusions = new Set(
      allAmbiguityItems.filter(item => !admittedKeys.has(projectionItemKey(item))).map(projectionItemKey),
    );
    const relationship = relationshipBundleItems(logical, items, baseRequiredItems, ambiguityExclusions);
    for (const includeRelationship of relationship === undefined ? [false] : [false, true]) {
      const protectedMemoryUri = includeRelationship ? relationship?.primaryMemory.id : undefined;
      const requiredItems = uniqueProjectionItems([
        ...baseRequiredItems,
        ...admittedItems,
        ...(includeRelationship && relationship !== undefined ? relationship.items : []),
      ]);
      if (!hasLanePrefix(baseRequiredItems, requiredItems)) continue;
      const excludedKeys = requiredLanePredecessorExclusions(items, requiredItems, ambiguityExclusions);
      const compactMemoryUris = new Set(admittedItems.map(item => item.id));
      const projection = renderProjection(logical, requiredItems, protectedMemoryUri, compactMemoryUris);
      const measurement = measureContextBriefResponse(projection, responseFormat);
      if (measurement.totalBytes > maximumPublicBytes) continue;
      const candidate: EvidenceCoreCandidate = {
        admittedMemoryCount: admittedItems.length,
        allCohortKeys,
        anchorCount: selectedComponents.reduce((total, component) => total + component.anchorCount, 0),
        compactMemoryUris,
        excludedKeys,
        fitsDefault: measurement.totalBytes <= defaultPublicBytes,
        mask,
        measurementBytes: measurement.totalBytes,
        protectedMemoryUri,
        relationshipIncluded: includeRelationship,
        requiredItems,
      };
      if (selected === undefined || preferEvidenceCore(candidate, selected, components.length, logical.mode)) {
        selected = candidate;
      }
    }
  }
  return (
    selected ?? {
      admittedMemoryCount: 0,
      allCohortKeys,
      anchorCount: 0,
      compactMemoryUris: new Set(),
      excludedKeys: requiredLanePredecessorExclusions(items, baseRequiredItems, allCohortKeys),
      fitsDefault: true,
      mask: 0,
      measurementBytes: 0,
      relationshipIncluded: false,
      requiredItems: uniqueProjectionItems(baseRequiredItems),
    }
  );
}

/** Prefer one unambiguous current memory over secondary graph inspection in brief mode. */
function currentCodeLinkedMemoryFallbackItem(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
): ProjectionItem | undefined {
  if (logical.mode !== 'brief') return undefined;
  const memories = [...logical.activeHandoffs, ...logical.durableDecisions]
    .filter(
      candidate =>
        candidate.selectionBasis === 'code-citation' &&
        (candidate.cohortCodeRelations ?? candidate.codeRelations ?? []).some(
          relation => relation.status === 'exact' || relation.status === 'relocated',
        ),
    )
    .sort((left, right) => left.rank - right.rank || compareText(left.uri, right.uri));
  if (memories.length !== 1) return undefined;
  return items.find(
    item => (item.lane === 'handoff' || item.lane === 'durable-decision') && item.id === memories[0].uri,
  );
}

interface EvidenceCoreCandidate extends CodeLinkedEvidenceCoreProjection {
  readonly admittedMemoryCount: number;
  readonly anchorCount: number;
  readonly fitsDefault: boolean;
  readonly mask: number;
  readonly measurementBytes: number;
  readonly relationshipIncluded: boolean;
}

function relationshipBundleItems(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
  baseRequiredItems: readonly ProjectionItem[],
  excludedKeys: ReadonlySet<string>,
): {readonly items: readonly ProjectionItem[]; readonly primaryMemory: ProjectionItem} | undefined {
  if (logical.mode !== 'trace' && logical.mode !== 'impact') return undefined;
  const recoveryItem = baseRequiredItems.find(item => item.lane === 'follow-up');
  const recovery = logical.recommendedFollowUps.find(candidate => candidate.id === recoveryItem?.id);
  if (recovery?.operation !== 'inspect-node') return undefined;
  const primaryMemory = primaryRelationshipMemoryItem(logical, items, excludedKeys);
  const incidentContract = [...logical.graph.contracts]
    .filter(contract => contract.sourceRef === recovery.ref || contract.targetRef === recovery.ref)
    .sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))[0];
  const contractItem =
    incidentContract === undefined
      ? undefined
      : items.find(item => item.lane === 'graph-contract' && item.id === incidentContract.id);
  return primaryMemory === undefined || contractItem === undefined
    ? undefined
    : {items: [primaryMemory, contractItem], primaryMemory};
}

function preferEvidenceCore(
  candidate: EvidenceCoreCandidate,
  current: EvidenceCoreCandidate,
  componentCount: number,
  mode: ContextBriefLogicalResultV1['mode'],
): boolean {
  const relationshipMode = mode === 'trace' || mode === 'impact';
  if (relationshipMode && candidate.relationshipIncluded !== current.relationshipIncluded) {
    return candidate.relationshipIncluded;
  }
  const candidateHasEvidence = candidate.relationshipIncluded || candidate.admittedMemoryCount > 0;
  const currentHasEvidence = current.relationshipIncluded || current.admittedMemoryCount > 0;
  if (candidateHasEvidence !== currentHasEvidence) return candidateHasEvidence;
  if (candidate.fitsDefault !== current.fitsDefault) return candidate.fitsDefault;
  if (candidate.anchorCount !== current.anchorCount) return candidate.anchorCount > current.anchorCount;
  if (candidate.admittedMemoryCount !== current.admittedMemoryCount) {
    return candidate.admittedMemoryCount > current.admittedMemoryCount;
  }
  for (let index = 0; index < componentCount; index += 1) {
    const candidateIncludes = (candidate.mask & (1 << index)) !== 0;
    const currentIncludes = (current.mask & (1 << index)) !== 0;
    if (candidateIncludes !== currentIncludes) return candidateIncludes;
  }
  return candidate.measurementBytes < current.measurementBytes;
}

function hasLanePrefix(baseItems: readonly ProjectionItem[], candidateItems: readonly ProjectionItem[]): boolean {
  for (const lane of PROJECTION_LANES) {
    const baseKeys = laneOrderedItems(baseItems, lane).map(projectionItemKey);
    const candidateKeys = laneOrderedItems(candidateItems, lane).map(projectionItemKey);
    if (baseKeys.some((key, index) => candidateKeys[index] !== key)) return false;
  }
  return true;
}

function requiredLanePredecessorExclusions(
  items: readonly ProjectionItem[],
  requiredItems: readonly ProjectionItem[],
  initial: ReadonlySet<string>,
): ReadonlySet<string> {
  const excluded = new Set(initial);
  const requiredKeys = new Set(requiredItems.map(projectionItemKey));
  for (const lane of PROJECTION_LANES) {
    const laneItems = laneOrderedItems(items, lane);
    let lastRequiredIndex = -1;
    for (const [index, item] of laneItems.entries()) {
      if (requiredKeys.has(projectionItemKey(item))) lastRequiredIndex = index;
    }
    if (lastRequiredIndex < 0) continue;
    for (const item of laneItems.slice(0, lastRequiredIndex)) {
      if (!requiredKeys.has(projectionItemKey(item))) excluded.add(projectionItemKey(item));
    }
  }
  return excluded;
}

function laneOrderedItems(items: readonly ProjectionItem[], lane: ProjectionLane): readonly ProjectionItem[] {
  return items
    .filter(item => item.lane === lane)
    .sort((left, right) => left.laneRank - right.laneRank || compareText(left.id, right.id));
}

function laneStableOptionalProjectionItems(items: readonly ProjectionItem[]): readonly ProjectionItem[] {
  const originalOrder = new Map(items.map((item, index) => [projectionItemKey(item), index] as const));
  const lanes = PROJECTION_LANES.map(lane => laneOrderedItems(items, lane));
  const offsets = lanes.map(() => 0);
  const ordered: ProjectionItem[] = [];
  while (ordered.length < items.length) {
    let selectedLane = -1;
    let selectedOrder = Number.POSITIVE_INFINITY;
    for (const [laneIndex, laneItems] of lanes.entries()) {
      const item = laneItems[offsets[laneIndex] ?? 0];
      if (item === undefined) continue;
      const order = originalOrder.get(projectionItemKey(item)) ?? Number.POSITIVE_INFINITY;
      if (order < selectedOrder) {
        selectedLane = laneIndex;
        selectedOrder = order;
      }
    }
    if (selectedLane < 0) break;
    const item = lanes[selectedLane]?.[offsets[selectedLane] ?? 0];
    if (item === undefined) break;
    ordered.push(item);
    offsets[selectedLane] = (offsets[selectedLane] ?? 0) + 1;
  }
  return ordered;
}
/** Keep a fixed useful lane bundle; larger agent budgets are ceilings, not refill targets. */
function agentSemanticOptionalProjectionItems(
  items: readonly ProjectionItem[],
  requiredItems: readonly ProjectionItem[],
): readonly ProjectionItem[] {
  const selectedCounts = new Map<ProjectionLane, number>();
  for (const item of requiredItems) selectedCounts.set(item.lane, (selectedCounts.get(item.lane) ?? 0) + 1);
  return laneStableOptionalProjectionItems(items).filter(item => {
    const limit = agentSemanticLaneLimit(item.lane);
    const selected = selectedCounts.get(item.lane) ?? 0;
    if (limit === 0 || selected >= limit) return false;
    selectedCounts.set(item.lane, selected + 1);
    return true;
  });
}
function agentSemanticLaneLimit(lane: ProjectionLane): number {
  if (lane === 'durable-decision' || lane === 'graph-card') return 2;
  return ['handoff', 'graph-contract', 'issue', 'follow-up', 'verified-procedure'].includes(lane) ? 1 : 0;
}

function primaryRelationshipMemoryItem(
  logical: ContextBriefLogicalResultV1,
  items: readonly ProjectionItem[],
  excludedKeys: ReadonlySet<string> = new Set(),
): ProjectionItem | undefined {
  if (logical.mode !== 'trace' && logical.mode !== 'impact') return undefined;
  return items.find(item => {
    if (excludedKeys.has(projectionItemKey(item))) return false;
    if (item.lane === 'handoff') {
      return logical.activeHandoffs.some(memory => memory.uri === item.id && memory.selectionBasis === 'code-citation');
    }
    if (item.lane === 'durable-decision') {
      return logical.durableDecisions.some(
        memory => memory.uri === item.id && memory.selectionBasis === 'code-citation',
      );
    }
    return false;
  });
}

function uniqueProjectionItems(items: readonly ProjectionItem[]): readonly ProjectionItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = projectionItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coverageGapProjectionId(gap: string): string {
  return `gap:${gap}`;
}

function procedureProjectionId(
  procedure: NonNullable<ContextBriefLogicalResultV1['verifiedProcedures']>[number],
): string {
  return `${procedure.artifact.id}@${procedure.artifact.semanticVersion}`;
}

function projectionItemKey(item: ProjectionItem): string {
  return `${item.lane}\u0000${item.id}`;
}

function selectById<T extends {readonly id: string; readonly rank: number}>(
  items: readonly T[],
  selected: ReadonlySet<string> | undefined,
): readonly T[];
function selectById<T extends {readonly rank: number; readonly uri: string}>(
  items: readonly T[],
  selected: ReadonlySet<string> | undefined,
  key: 'uri',
): readonly T[];
function selectById<T extends {readonly id?: string; readonly rank: number; readonly uri?: string}>(
  items: readonly T[],
  selected: ReadonlySet<string> | undefined,
  key: 'id' | 'uri' = 'id',
): readonly T[] {
  if (selected === undefined) return [];
  return items
    .filter(item => {
      const id = item[key];
      return typeof id === 'string' && selected.has(id);
    })
    .sort((left, right) => {
      const leftId = left[key] ?? '';
      const rightId = right[key] ?? '';
      return left.rank - right.rank || compareText(leftId, rightId);
    });
}

function compactProjectedMemory(
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

function compactProjectedFollowUp(
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

function compactProjectedIssue(
  logical: ContextBriefLogicalResultV1,
  issue: ContextBriefLogicalResultV1['stalenessAndConflicts'][number],
  allowIdentityAlias: boolean,
): ContextBriefLogicalResultV1['stalenessAndConflicts'][number] {
  return {
    ...issue,
    uris: issue.uris.map(uri => {
      const memory = contextBriefRelationshipMemoryByUri(logical, uri);
      return allowIdentityAlias && memory?.memoryId !== undefined && isMemoryId(memory.memoryId)
        ? memoryIdentityAlias(memory.memoryId)
        : uri;
    }),
  };
}

function compactProjectedGraphContract(contract: ContextBriefGraphContractV1): ContextBriefGraphContractV1 {
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

function compactProjectedGraphCard(card: ContextBriefGraphCardV1): ContextBriefGraphCardV1 {
  return {...card, reason: utf8Prefix(card.reason, 48)};
}

function projectionMaximumBytes(tokens: number): number {
  if (
    !Number.isSafeInteger(tokens) ||
    tokens < CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS ||
    tokens > CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw invalid(
      `budget must be an integer from ${CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS} to ${CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS}`,
    );
  }
  return tokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): Error {
  return new Error(`Invalid Context Brief projection: ${message}.`);
}
