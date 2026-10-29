import {Array as EffectArray} from 'effect';
import * as Effect2 from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {renderCodeGraphAnalysis, type CodeGraphAnalysisView} from '@threadnote/graph/analysis/render';
import {type CodeGraphAnalysisResult} from '@threadnote/graph/analysis';
import {sanitizeCodeGraphPresentationText} from '@threadnote/graph/presentation_text';
import type {CodeGraphAnalysisReadMetadata} from './analysis_read.js';

export const MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES = 24 * 1_024;

interface CodeGraphMcpOutputCoverage {
  readonly budgetBytes: number;
  readonly byteLength: number;
  readonly complete: boolean;
  readonly truncated: boolean;
}
type CodeGraphMcpAnalysisTextCoverage = CodeGraphMcpOutputCoverage;
interface CodeGraphMcpAnalysisStringObservation {
  truncated: number;
}
export function codeGraphAnalysisMcpResponse(
  result: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
  repository: {readonly displayName: string; readonly repositoryId: string},
  metadata?: CodeGraphAnalysisReadMetadata,
) {
  const relevantSource = codeGraphMcpAnalysisSourceForView(result, operation);
  const observation: CodeGraphMcpAnalysisStringObservation = {truncated: 0};
  const compactSource = compactCodeGraphAnalysisStrings(relevantSource, observation);
  const compactRepository = compactCodeGraphAnalysisStrings(repository, observation);
  const {projected, projectedDrillDown} = emptyCodeGraphMcpAnalysisProjection(compactSource);
  const placeholderTextCoverage: CodeGraphMcpAnalysisTextCoverage = {
    budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
    byteLength: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
    complete: false,
    truncated: false,
  };
  const fits = () =>
    finalizedCodeGraphMcpAnalysisEnvelope(
      compactSource,
      projected,
      operation,
      compactRepository,
      observation.truncated,
      placeholderTextCoverage,
      metadata,
    ).output.structuredContent.byteLength <= MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES;
  const appendPrefix = <Value>(target: Value[], source: readonly Value[], synchronize?: () => void): void => {
    for (const value of source) {
      target.push(value);
      synchronize?.();
      if (fits()) continue;
      target.pop();
      synchronize?.();
      break;
    }
  };

  // Coverage warnings are retained before repository-derived evidence so a
  // bounded response never hides why an analysis is partial or unavailable.
  appendPrefix(projected.warnings, compactSource.warnings);

  const appendStatistics = () => {
    appendPrefix(projected.statistics.languages, compactSource.statistics.languages);
    appendPrefix(projected.statistics.kinds, compactSource.statistics.kinds);
    appendPrefix(projected.statistics.relations, compactSource.statistics.relations);
    appendPrefix(projected.statistics.provenances, compactSource.statistics.provenances);
  };
  const appendConfidence = () => {
    appendPrefix(projected.confidenceAudit.provenances, compactSource.confidenceAudit.provenances);
    appendPrefix(projected.confidenceAudit.findings, compactSource.confidenceAudit.findings);
  };
  const appendCommunities = () => {
    appendPrefix(projected.communities, compactSource.communities);
    appendPrefix(projected.components, compactSource.components);
  };
  const appendCommunityMembers = () => {
    const sourceDrillDown = compactSource.communityDrillDown;
    if (sourceDrillDown?.state !== 'found' || projectedDrillDown === undefined) {
      return;
    }
    const members = projectedDrillDown.members;
    const synchronize = () => {
      projectedDrillDown.coverage.shownMemberCount = members.length;
      projectedDrillDown.coverage.complete =
        sourceDrillDown.coverage.complete && members.length === sourceDrillDown.members.length;
    };
    appendPrefix(members, sourceDrillDown.members, synchronize);
  };
  const appendGroups = () => {
    const groups = projected.relationshipGroups;
    const sourceGroups = EffectArray.map(compactSource.relationshipGroups, source => ({
      sourceMembers: source.members,
      sourceMemberSampleComplete: source.memberSampleComplete,
      group: {
        ...source,
        members: emptyLike(source.members),
        memberSampleComplete: source.memberSampleComplete && source.members.length === 0,
      },
    }));
    appendPrefix(
      groups,
      EffectArray.map(sourceGroups, item => item.group),
    );
    for (const item of sourceGroups) {
      if (!EffectArray.some(groups, group => group.id === item.group.id)) break;
      const members = item.group.members;
      const synchronize = () => {
        item.group.memberSampleComplete =
          item.sourceMemberSampleComplete && item.sourceMembers.length === members.length;
      };
      appendPrefix(members, item.sourceMembers, synchronize);
    }
  };

  switch (operation) {
    case 'stats':
      appendStatistics();
      break;
    case 'confidence':
      appendConfidence();
      break;
    case 'communities':
      appendCommunities();
      break;
    case 'community':
      appendCommunityMembers();
      break;
    case 'groups':
      appendGroups();
      break;
    case 'hubs':
      appendPrefix(projected.hubs, compactSource.hubs);
      break;
    case 'surprises':
      appendPrefix(projected.surprisingLinks, compactSource.surprisingLinks);
      break;
    case 'full':
      appendStatistics();
      appendConfidence();
      appendCommunities();
      appendCommunityMembers();
      appendPrefix(projected.hubs, compactSource.hubs);
      appendGroups();
      appendPrefix(projected.surprisingLinks, compactSource.surprisingLinks);
      break;
  }
  if (operation === 'communities' || operation === 'full') {
    appendPrefix(projected.memberships, compactSource.memberships);
  }
  appendPrefix(projected.suggestedQuestions, compactSource.suggestedQuestions);

  const projectionOmissions = codeGraphMcpAnalysisOmissions(compactSource, projected, operation);
  const projectionComplete = observation.truncated === 0 && EffectRecord.keys(projectionOmissions).length === 0;
  const rendered = renderCodeGraphAnalysis(projected, operation, 'mcp');
  const boundedText = boundedCodeGraphMcpAnalysisText(rendered, result.coverage.topology.state, projectionComplete);
  const structuredContent = finalizedCodeGraphMcpAnalysisEnvelope(
    compactSource,
    projected,
    operation,
    compactRepository,
    observation.truncated,
    boundedText.coverage,
    metadata,
  );

  return {structuredContent, text: boundedText.text};
}

/**
 * Remove evidence that does not belong to the requested view before string
 * compaction and byte accounting. The stable analysis result shape is retained,
 * but unrelated arrays cannot consume an MCP response budget or make that view
 * appear truncated.
 */
function codeGraphMcpAnalysisSourceForView(
  result: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
): CodeGraphAnalysisResult {
  const includeStatistics = operation === 'stats' || operation === 'full';
  const includeConfidence = operation === 'confidence' || operation === 'full';
  const includeCommunities = operation === 'communities' || operation === 'full';
  const includeCommunity = operation === 'community' || operation === 'full';
  const {communityDrillDown: _communityDrillDown, ...base} = result;
  return {
    ...base,
    communities: includeCommunities ? result.communities : [],
    ...(includeCommunity && result.communityDrillDown !== undefined
      ? {communityDrillDown: result.communityDrillDown}
      : {}),
    components: includeCommunities ? result.components : [],
    confidenceAudit: {
      ...result.confidenceAudit,
      bands: includeStatistics || includeConfidence ? result.confidenceAudit.bands : [],
      findings: includeConfidence ? result.confidenceAudit.findings : [],
      provenances: includeConfidence ? result.confidenceAudit.provenances : [],
      reviewThresholds: includeConfidence ? result.confidenceAudit.reviewThresholds : [],
    },
    hubs: operation === 'hubs' || operation === 'full' ? result.hubs : [],
    memberships: includeCommunities ? result.memberships : [],
    relationshipGroups: operation === 'groups' || operation === 'full' ? result.relationshipGroups : [],
    statistics: {
      ...result.statistics,
      kinds: includeStatistics ? result.statistics.kinds : [],
      languages: includeStatistics ? result.statistics.languages : [],
      provenances: includeStatistics ? result.statistics.provenances : [],
      relations: includeStatistics ? result.statistics.relations : [],
    },
    surprisingLinks: operation === 'surprises' || operation === 'full' ? result.surprisingLinks : [],
  };
}

function emptyCodeGraphMcpAnalysisProjection(result: CodeGraphAnalysisResult) {
  const projectedDrillDown =
    result.communityDrillDown?.state === 'found'
      ? {
          ...result.communityDrillDown,
          coverage: {
            ...result.communityDrillDown.coverage,
            complete: false,
            shownMemberCount: 0,
          },
          members: emptyLike(result.communityDrillDown.members),
        }
      : undefined;
  const projected = {
    ...result,
    communities: emptyLike(result.communities),
    ...(projectedDrillDown === undefined ? {} : {communityDrillDown: projectedDrillDown}),
    components: emptyLike(result.components),
    confidenceAudit: {
      ...result.confidenceAudit,
      findings: emptyLike(result.confidenceAudit.findings),
      provenances: emptyLike(result.confidenceAudit.provenances),
    },
    hubs: emptyLike(result.hubs),
    memberships: emptyLike(result.memberships),
    relationshipGroups: emptyLike(result.relationshipGroups),
    statistics: {
      ...result.statistics,
      kinds: emptyLike(result.statistics.kinds),
      languages: emptyLike(result.statistics.languages),
      provenances: emptyLike(result.statistics.provenances),
      relations: emptyLike(result.statistics.relations),
    },
    suggestedQuestions: emptyLike(result.suggestedQuestions),
    surprisingLinks: emptyLike(result.surprisingLinks),
    warnings: emptyLike(result.warnings),
  } satisfies CodeGraphAnalysisResult;
  return {projected, projectedDrillDown};
}

function emptyLike<Value>(_source: readonly Value[]): Value[] {
  return [];
}

function compactCodeGraphAnalysisStrings<Value>(
  value: Value,
  observation: CodeGraphMcpAnalysisStringObservation,
): Value {
  const copy = structuredClone(value);
  compactCodeGraphAnalysisStringsInPlace(copy, observation);
  return copy;
}

function compactCodeGraphAnalysisStringsInPlace(
  value: unknown,
  observation: CodeGraphMcpAnalysisStringObservation,
): void {
  if (EffectArray.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const item = Reflect.get(value, index);
      if (typeof item === 'string') Reflect.set(value, index, compactCodeGraphString(item, observation));
      else compactCodeGraphAnalysisStringsInPlace(item, observation);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of EffectRecord.toEntries(value)) {
    if (typeof item === 'string') Reflect.set(value, key, compactCodeGraphString(item, observation));
    else compactCodeGraphAnalysisStringsInPlace(item, observation);
  }
}

function compactCodeGraphString(value: string, observation: CodeGraphMcpAnalysisStringObservation): string {
  const sanitized = sanitizeCodeGraphPresentationText(value);
  const compact = compactMcpUtf8Text(sanitized, 512);
  if (compact !== sanitized) observation.truncated += 1;
  return compact;
}
function codeGraphMcpAnalysisOmissions(
  source: CodeGraphAnalysisResult,
  projected: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
) {
  const sourceCommunityMembers =
    source.communityDrillDown?.state === 'found' ? source.communityDrillDown.members.length : 0;
  const projectedCommunityMembers =
    projected.communityDrillDown?.state === 'found' ? projected.communityDrillDown.members.length : 0;
  const sourceGroupMembers = EffectArray.reduce(
    source.relationshipGroups,
    0,
    (total, group) => total + group.members.length,
  );
  const projectedGroupMembers = EffectArray.reduce(
    projected.relationshipGroups,
    0,
    (total, group) => total + group.members.length,
  );
  const includeStatistics = operation === 'stats' || operation === 'full';
  const includeConfidence = operation === 'confidence' || operation === 'full';
  const includeCommunities = operation === 'communities' || operation === 'full';
  const includeCommunity = operation === 'community' || operation === 'full';
  const includeGroups = operation === 'groups' || operation === 'full';
  const counts = {
    communities: includeCommunities ? source.communities.length - projected.communities.length : 0,
    communityMembers: includeCommunity ? sourceCommunityMembers - projectedCommunityMembers : 0,
    components: includeCommunities ? source.components.length - projected.components.length : 0,
    confidenceFindings: includeConfidence
      ? source.confidenceAudit.findings.length - projected.confidenceAudit.findings.length
      : 0,
    confidenceProvenances: includeConfidence
      ? source.confidenceAudit.provenances.length - projected.confidenceAudit.provenances.length
      : 0,
    hubs: operation === 'hubs' || operation === 'full' ? source.hubs.length - projected.hubs.length : 0,
    memberships: includeCommunities ? source.memberships.length - projected.memberships.length : 0,
    relationshipGroupMembers: includeGroups ? sourceGroupMembers - projectedGroupMembers : 0,
    relationshipGroups: includeGroups ? source.relationshipGroups.length - projected.relationshipGroups.length : 0,
    statisticsKinds: includeStatistics ? source.statistics.kinds.length - projected.statistics.kinds.length : 0,
    statisticsLanguages: includeStatistics
      ? source.statistics.languages.length - projected.statistics.languages.length
      : 0,
    statisticsProvenances: includeStatistics
      ? source.statistics.provenances.length - projected.statistics.provenances.length
      : 0,
    statisticsRelations: includeStatistics
      ? source.statistics.relations.length - projected.statistics.relations.length
      : 0,
    suggestedQuestions: source.suggestedQuestions.length - projected.suggestedQuestions.length,
    surprisingLinks:
      operation === 'surprises' || operation === 'full'
        ? source.surprisingLinks.length - projected.surprisingLinks.length
        : 0,
    warnings: source.warnings.length - projected.warnings.length,
  };
  return EffectRecord.fromEntries(EffectArray.filter(EffectRecord.toEntries(counts), ([, count]) => count > 0));
}

function finalizedCodeGraphMcpAnalysisEnvelope(
  source: CodeGraphAnalysisResult,
  projected: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
  repository: {readonly displayName: string; readonly repositoryId: string},
  truncatedStrings: number,
  textCoverage: CodeGraphMcpAnalysisTextCoverage,
  metadata?: CodeGraphAnalysisReadMetadata,
) {
  const omitted = codeGraphMcpAnalysisOmissions(source, projected, operation);
  const truncated = truncatedStrings > 0 || EffectRecord.keys(omitted).length > 0;
  const build = (byteLength: number) => ({
    ...metadata,
    state: source.coverage.complete ? 'complete' : 'partial',
    operation,
    output: {
      analysisCoverage: {
        complete: source.coverage.complete,
        topology: source.coverage.topology.state,
      },
      structuredContent: {
        budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
        byteLength,
        complete: !truncated,
        omitted,
        truncated,
        truncatedStrings,
      },
      text: textCoverage,
    },
    repository,
    result: projected,
    sourceVersion: source.version,
    type: 'code-graph-analysis' as const,
    version: 1 as const,
  });
  let byteLength = 0;
  let envelope = build(byteLength);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = encodedMcpBytes(envelope);
    if (measured === byteLength) return envelope;
    byteLength = measured;
    envelope = build(byteLength);
  }
  return envelope;
}

function boundedCodeGraphMcpAnalysisText(
  rendered: string,
  topology: CodeGraphAnalysisResult['coverage']['topology']['state'],
  projectionComplete: boolean,
): {
  readonly coverage: CodeGraphMcpAnalysisTextCoverage;
  readonly text: string;
} {
  const completeFooter =
    `\nMCP text output coverage: complete within the ${MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES}-byte UTF-8 budget; ` +
    `structured projection ${projectionComplete ? 'complete' : 'bounded'}; topology ${topology}.\n`;
  const completeText = `${Effect2.pipe(rendered, EffectString.trimEnd)}${completeFooter}`;
  if (encodedMcpBytes(completeText) <= MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES) {
    return {
      coverage: {
        budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
        byteLength: encodedMcpBytes(completeText),
        complete: true,
        truncated: false,
      },
      text: completeText,
    };
  }
  const truncatedFooter =
    `\n…\nMCP text output coverage: truncated at the ${MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES}-byte UTF-8 budget; ` +
    `structured projection ${projectionComplete ? 'complete' : 'bounded'}; topology ${topology}.\n`;
  const prefixBudget = MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES - encodedMcpBytes(truncatedFooter);
  const text = `${Effect2.pipe(utf8Prefix(rendered, prefixBudget), EffectString.trimEnd)}${truncatedFooter}`;
  return {
    coverage: {
      budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
      byteLength: encodedMcpBytes(text),
      complete: false,
      truncated: true,
    },
    text,
  };
}

export function compactMcpUtf8Text(value: string, maximumBytes: number): string {
  if (utf8Prefix(value, maximumBytes).length === value.length) return value;
  const ellipsis = '…';
  return utf8Prefix(value, Math.max(0, maximumBytes - encodedMcpBytes(ellipsis))) + ellipsis;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of value) {
    const characterBytes = encodedMcpBytes(character);
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    prefix += character;
  }
  return prefix;
}

export function encodedMcpBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}
