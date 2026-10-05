import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  encodedJsonBytes,
  measureAgentToolResponse,
} from '@threadnote/protocol/agent-response';
import {renderCodeGraphResult} from '@threadnote/graph/query';
import type {CodeGraphProjectCoverage, CodeGraphQueryResult} from '@threadnote/graph/types';
import type {CodeGraphRefreshContinuity} from '@threadnote/graph/watcher';
import {
  graphAgentNumber,
  graphAgentRecord,
  graphAgentString,
  renderCodeGraphAgentProvenance,
} from './code_graph_agent_provenance.js';

const MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES = 24 * 1_024;
const MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES = 768;
/** Fixed receipt floor for every public graph channel (dual, text, agent). */
export const MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS = 800;
const MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS = 1_500;
const MCP_CODE_GRAPH_AGENT_IMPACT_DEFAULT_ESTIMATED_TOKENS = 1_250;

export type CodeGraphMcpResponseFormat = 'dual' | 'text' | 'agent';

function compactMcpText(value: string, maximumBytes: number): string {
  const prefixEnd = utf8PrefixEnd(value, maximumBytes);
  if (prefixEnd === value.length) return value;
  const suffix = '…';
  const suffixBytes = 3;
  if (maximumBytes < suffixBytes) return '';
  return `${value.slice(0, utf8PrefixEnd(value, maximumBytes - suffixBytes))}${suffix}`;
}

/** Return a code-point boundary whose UTF-8 prefix fits the byte limit.
 * The scan stops at the limit, so adversarial multi-megabyte fields cost O(limit)
 * instead of encoding or traversing the entire source string. */
function utf8PrefixEnd(value: string, maximumBytes: number): number {
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const encodedBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + encodedBytes > maximumBytes) break;
    bytes += encodedBytes;
    index += codeUnits;
  }
  return index;
}

type MandatoryMetadataProfile = 'minimum' | 'normal';

function compactCodeGraphNode(node: CodeGraphQueryResult['nodes'][number]) {
  return {
    ...(node.arity === undefined ? {} : {arity: node.arity}),
    exported: node.exported,
    id: node.id,
    kind: node.kind,
    language: compactMcpText(node.language, 80),
    name: compactMcpText(node.name, 160),
    ...(node.packageName === undefined ? {} : {packageName: compactMcpText(node.packageName, 160)}),
    path: compactMcpText(node.path, 400),
    qualifiedName: compactMcpText(node.qualifiedName, 320),
    score: node.score,
    ...(node.signature === undefined ? {} : {signature: compactMcpText(node.signature, 300)}),
    span: node.span,
  };
}

function compactCodeGraphEdge(edge: CodeGraphQueryResult['edges'][number]) {
  return {
    confidence: edge.confidence,
    evidencePath: compactMcpText(edge.evidencePath, 400),
    evidenceSpan: edge.evidenceSpan,
    id: edge.id,
    provenance: edge.provenance,
    relation: edge.relation,
    ...(edge.sourceId === undefined ? {} : {sourceId: edge.sourceId}),
    sourceName: compactMcpText(edge.sourceName, 160),
    ...(edge.targetId === undefined ? {} : {targetId: edge.targetId}),
    targetName: compactMcpText(edge.targetName, 160),
  };
}

function compactProjectCoverage(coverage: CodeGraphProjectCoverage, profile: MandatoryMetadataProfile) {
  const rootLimit = profile === 'minimum' ? 1 : 2;
  const textLimit = profile === 'minimum' ? 32 : 64;
  const configuredRoots = coverage.configuredRoots.slice(0, rootLimit).map(root => compactMcpText(root, textLimit));
  return {
    ...coverage,
    ...(coverage.snapshotSourceCommit === undefined
      ? {}
      : {snapshotSourceCommit: compactMcpText(coverage.snapshotSourceCommit, textLimit)}),
    configuredRoots,
    observedWorktreeCommit: compactMcpText(coverage.observedWorktreeCommit, 64),
    project: compactMcpText(coverage.project, 64),
    ...(configuredRoots.length === coverage.configuredRoots.length
      ? {}
      : {configuredRootsOmitted: coverage.configuredRoots.length - configuredRoots.length}),
  };
}

function compactOutsideProjectGraph(
  outside: NonNullable<CodeGraphQueryResult['outsideProjectGraph']>,
  profile: MandatoryMetadataProfile,
) {
  const pathLimit = profile === 'minimum' ? 1 : 2;
  const actionLimit = profile === 'minimum' ? 0 : 1;
  const paths = outside.paths.slice(0, pathLimit).map(path => compactMcpText(path, profile === 'minimum' ? 48 : 96));
  const suggestedActions = outside.suggestedActions.slice(0, actionLimit).map(action => compactMcpText(action, 96));
  return {
    ...outside,
    paths,
    suggestedActions,
    ...(paths.length === outside.paths.length ? {} : {pathsOmitted: outside.paths.length - paths.length}),
    ...(suggestedActions.length === outside.suggestedActions.length
      ? {}
      : {suggestedActionsOmitted: outside.suggestedActions.length - suggestedActions.length}),
  };
}

function compactMandatoryMetadata(result: CodeGraphQueryResult, profile: MandatoryMetadataProfile) {
  const textLimit = profile === 'minimum' ? 32 : 96;
  const snapshotLimit = profile === 'minimum' ? 32 : 64;
  return {
    compacted: profile === 'minimum',
    repository: {
      displayName: compactMcpText(result.repository.displayName, textLimit),
      repositoryId: compactMcpText(result.repository.repositoryId, textLimit),
    },
    snapshot: {
      commit: compactMcpText(result.snapshot.commit, snapshotLimit),
      dirty: result.snapshot.dirty,
      id: compactMcpText(result.snapshot.id, snapshotLimit),
      worktreeId: compactMcpText(result.snapshot.worktreeId, snapshotLimit),
    },
    ...(result.projectCoverage === undefined
      ? {}
      : {projectCoverage: compactProjectCoverage(result.projectCoverage, profile)}),
    ...(result.outsideProjectGraph === undefined
      ? {}
      : {outsideProjectGraph: compactOutsideProjectGraph(result.outsideProjectGraph, profile)}),
    ...(result.scope === undefined
      ? {}
      : {
          scope: {
            ...result.scope,
            packageName: compactMcpText(result.scope.packageName, textLimit),
          },
        }),
    ...(result.source === undefined
      ? {}
      : {
          source: {
            ...result.source,
            frontierCommit: compactMcpText(result.source.frontierCommit, snapshotLimit),
            localCommit: compactMcpText(result.source.localCommit, snapshotLimit),
            profileDigest: compactMcpText(result.source.profileDigest, textLimit),
          },
        }),
  };
}

function projectCodeGraphMcpResult(
  result: CodeGraphQueryResult,
  nodeCount: number,
  edgeCount: number,
  warningCount: number,
  conciseTruncationWarning: boolean,
  refresh?: CodeGraphRefreshContinuity,
  metadataProfile: MandatoryMetadataProfile = 'normal',
) {
  const metadata = compactMandatoryMetadata(result, metadataProfile);
  const warningsPrefix = result.warnings.slice(0, warningCount).map(warning => compactMcpText(warning, 320));
  const nodes = result.nodes.slice(0, nodeCount).map(compactCodeGraphNode);
  const edges = result.edges.slice(0, edgeCount).map(compactCodeGraphEdge);
  const truncated =
    nodes.length < result.nodes.length ||
    edges.length < result.edges.length ||
    warningsPrefix.length < result.warnings.length;
  return {
    freshness: result.freshness,
    operation: result.operation,
    repository: metadata.repository,
    snapshot: metadata.snapshot,
    ...(metadata.projectCoverage === undefined ? {} : {projectCoverage: metadata.projectCoverage}),
    ...(metadata.outsideProjectGraph === undefined ? {} : {outsideProjectGraph: metadata.outsideProjectGraph}),
    ...(result.outsideScopeChangedPaths === undefined
      ? {}
      : {outsideScopeChangedPaths: result.outsideScopeChangedPaths}),
    ...(metadata.scope === undefined ? {} : {scope: metadata.scope}),
    ...(result.searchCoverage ? {searchCoverage: result.searchCoverage} : {}),
    sourceVersion: result.version,
    trust: result.trust,
    type: 'code-graph-inspection' as const,
    version: 1 as const,
    edges,
    nodes,
    output: {
      returnedEdges: edges.length,
      returnedNodes: nodes.length,
      totalEdges: result.edges.length,
      totalNodes: result.nodes.length,
      truncated,
      ...(metadata.compacted ? {metadataTruncated: true as const} : {}),
    },
    ...(metadata.source === undefined ? {} : {source: metadata.source}),
    ...(refresh === undefined ? {} : {refresh}),
    warnings: truncated
      ? [
          ...warningsPrefix,
          conciseTruncationWarning
            ? 'Budget truncated.'
            : `MCP output was bounded to ${nodes.length}/${result.nodes.length} nodes and ${edges.length}/${result.edges.length} relationships; refine the query or follow a stable cgs_ ID.`,
        ]
      : warningsPrefix,
  };
}

function responseForPrefix(
  result: CodeGraphQueryResult,
  nodeCount: number,
  edgeCount: number,
  warningCount: number,
  conciseTruncationWarning: boolean,
  refresh?: CodeGraphRefreshContinuity,
  metadataProfile: MandatoryMetadataProfile = 'normal',
) {
  const structuredContent = projectCodeGraphMcpResult(
    result,
    nodeCount,
    edgeCount,
    warningCount,
    conciseTruncationWarning,
    refresh,
    metadataProfile,
  );
  const rendered: CodeGraphQueryResult = {
    ...result,
    edges: result.edges
      .slice(0, structuredContent.edges.length)
      .map((edge, index) => ({...edge, ...structuredContent.edges[index]})),
    nodes: result.nodes
      .slice(0, structuredContent.nodes.length)
      .map((node, index) => ({...node, ...structuredContent.nodes[index]})),
    repository: structuredContent.repository,
    snapshot: structuredContent.snapshot,
    ...(structuredContent.projectCoverage === undefined ? {} : {projectCoverage: structuredContent.projectCoverage}),
    ...(structuredContent.outsideProjectGraph === undefined
      ? {}
      : {outsideProjectGraph: structuredContent.outsideProjectGraph}),
    ...(structuredContent.outsideScopeChangedPaths === undefined
      ? {}
      : {outsideScopeChangedPaths: structuredContent.outsideScopeChangedPaths}),
    ...(structuredContent.scope === undefined ? {} : {scope: structuredContent.scope}),
    ...(structuredContent.source === undefined ? {} : {source: structuredContent.source}),
    warnings: structuredContent.warnings,
  };
  return {structuredContent, text: renderCodeGraphResult(rendered, 'mcp')};
}

function longestAdmittedPrefix(
  result: CodeGraphQueryResult,
  admits: (response: ReturnType<typeof responseForPrefix>) => boolean,
  conciseTruncationWarning = false,
  refresh?: CodeGraphRefreshContinuity,
  metadataProfile: MandatoryMetadataProfile = 'normal',
) {
  let nodeCount = 0;
  let edgeCount = 0;
  let warningCount = 0;
  let nodesBlocked = false;
  let edgesBlocked = false;
  let warningsBlocked = false;
  let selected = responseForPrefix(
    result,
    nodeCount,
    edgeCount,
    warningCount,
    conciseTruncationWarning,
    refresh,
    metadataProfile,
  );
  while (
    (!nodesBlocked && nodeCount < result.nodes.length) ||
    (!edgesBlocked && edgeCount < result.edges.length) ||
    (!warningsBlocked && warningCount < Math.min(5, result.warnings.length))
  ) {
    if (!warningsBlocked && warningCount < Math.min(5, result.warnings.length)) {
      const candidate = responseForPrefix(
        result,
        nodeCount,
        edgeCount,
        warningCount + 1,
        conciseTruncationWarning,
        refresh,
        metadataProfile,
      );
      if (admits(candidate)) {
        warningCount += 1;
        selected = candidate;
      } else warningsBlocked = true;
    }
    if (!nodesBlocked && nodeCount < result.nodes.length) {
      const candidate = responseForPrefix(
        result,
        nodeCount + 1,
        edgeCount,
        warningCount,
        conciseTruncationWarning,
        refresh,
        metadataProfile,
      );
      if (admits(candidate)) {
        nodeCount += 1;
        selected = candidate;
      } else nodesBlocked = true;
    }
    if (!edgesBlocked && edgeCount < result.edges.length) {
      const candidate = responseForPrefix(
        result,
        nodeCount,
        edgeCount + 1,
        warningCount,
        conciseTruncationWarning,
        refresh,
        metadataProfile,
      );
      if (admits(candidate)) {
        edgeCount += 1;
        selected = candidate;
      } else edgesBlocked = true;
    }
  }
  return selected;
}

function defaultCodeGraphMcpResponse(result: CodeGraphQueryResult, refresh?: CodeGraphRefreshContinuity) {
  const maximumBytes = MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES - MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES;
  return longestAdmittedPrefix(
    result,
    response => encodedJsonBytes(response.structuredContent) <= maximumBytes,
    false,
    refresh,
  );
}

function impactAgentProjectionOrder(result: CodeGraphQueryResult): CodeGraphQueryResult {
  if (result.operation !== 'impact') return result;
  const nodeIds = new Set(result.nodes.map(node => node.id));
  const edges = result.edges
    .map((edge, index) => ({edge, index}))
    .sort(
      (left, right) =>
        Number(edgeIsConnected(right.edge, nodeIds)) - Number(edgeIsConnected(left.edge, nodeIds)) ||
        impactRelationPriority(left.edge.relation) - impactRelationPriority(right.edge.relation) ||
        left.index - right.index,
    )
    .map(({edge}) => edge);
  const nodesById = new Map(result.nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  const nodes: CodeGraphQueryResult['nodes'][number][] = [];
  const append = (id: string | undefined) => {
    if (id === undefined || seen.has(id)) return;
    const node = nodesById.get(id);
    if (node === undefined) return;
    seen.add(id);
    nodes.push(node);
  };
  for (const edge of edges) {
    append(edge.sourceId);
    append(edge.targetId);
  }
  for (const node of result.nodes) append(node.id);
  return {...result, edges, nodes};
}

function impactRelationPriority(relation: string): number {
  if (['calls', 'constructs', 'extends', 'implements', 'overrides'].includes(relation)) return 0;
  if (relation === 'depends_on') return 1;
  if (relation === 'imports') return 2;
  if (relation === 'reexports') return 3;
  if (relation === 'contains') return 4;
  return 5;
}

function edgeIsConnected(edge: CodeGraphQueryResult['edges'][number], nodeIds: ReadonlySet<string>): boolean {
  return (
    edge.sourceId !== undefined &&
    edge.targetId !== undefined &&
    nodeIds.has(edge.sourceId) &&
    nodeIds.has(edge.targetId)
  );
}

function impactAgentCoreResponse(
  result: CodeGraphQueryResult,
  maximumBytes: number,
  refresh?: CodeGraphRefreshContinuity,
) {
  const ordered = impactAgentProjectionOrder(result);
  const nodeIds = new Set(ordered.nodes.map(node => node.id));
  const firstPriority = ordered.edges[0] === undefined ? undefined : impactRelationPriority(ordered.edges[0].relation);
  const primaryEdgeCount =
    firstPriority === undefined
      ? 0
      : ordered.edges.findIndex(
          edge => !edgeIsConnected(edge, nodeIds) || impactRelationPriority(edge.relation) !== firstPriority,
        );
  const maximumPrimaryEdges = primaryEdgeCount === -1 ? ordered.edges.length : primaryEdgeCount;
  for (let edgeCount = maximumPrimaryEdges; edgeCount >= 0; edgeCount -= 1) {
    const endpointIds = new Set<string>();
    for (const edge of ordered.edges.slice(0, edgeCount)) {
      if (edge.sourceId !== undefined && nodeIds.has(edge.sourceId)) endpointIds.add(edge.sourceId);
      if (edge.targetId !== undefined && nodeIds.has(edge.targetId)) endpointIds.add(edge.targetId);
    }
    const nodeCount = edgeCount === 0 ? Math.min(2, ordered.nodes.length) : endpointIds.size;
    const candidate = responseForPrefix(
      ordered,
      nodeCount,
      edgeCount,
      Math.min(5, ordered.warnings.length),
      true,
      refresh,
    );
    if (measureFormattedCodeGraphMcpResponse(candidate, 'agent').totalBytes <= maximumBytes) return candidate;
  }
  return fixedCodeGraphMcpReceipt(ordered, refresh);
}

function queryAgentCoreResponse(
  result: CodeGraphQueryResult,
  maximumBytes: number,
  refresh?: CodeGraphRefreshContinuity,
  requestedNodeLimit?: number,
) {
  const maximumCoreNodes = Math.min(requestedNodeLimit ?? 3, result.nodes.length);
  for (let nodeCount = maximumCoreNodes; nodeCount >= 0; nodeCount -= 1) {
    const selectedNodeIds = new Set(result.nodes.slice(0, nodeCount).map(node => node.id));
    const connectedEdges = result.edges.filter(edge => edgeIsConnected(edge, selectedNodeIds));
    const connectedEdgeSet = new Set(connectedEdges);
    const ordered = {
      ...result,
      edges: [...connectedEdges, ...result.edges.filter(edge => !connectedEdgeSet.has(edge))],
    };
    const candidate = responseForPrefix(
      ordered,
      nodeCount,
      connectedEdges.length,
      Math.min(5, result.warnings.length),
      false,
      refresh,
    );
    if (measureFormattedCodeGraphMcpResponse(candidate, 'agent').totalBytes <= maximumBytes) return candidate;
  }
  return fixedCodeGraphMcpReceipt(result, refresh);
}

/**
 * Last-resort receipt for a valid public budget. It intentionally contains no
 * optional metadata bodies: their bounded omission counts retain recovery
 * semantics without allowing adversarial identifiers to consume the envelope.
 */
function fixedCodeGraphMcpReceipt(result: CodeGraphQueryResult, refresh?: CodeGraphRefreshContinuity) {
  const metadataOmissions = {
    ...(result.projectCoverage === undefined
      ? {}
      : {projectCoverage: {configuredRoots: result.projectCoverage.configuredRoots.length}}),
    ...(result.outsideProjectGraph === undefined
      ? {}
      : {
          outsideProjectGraph: {
            paths: result.outsideProjectGraph.paths.length,
            suggestedActions: result.outsideProjectGraph.suggestedActions.length,
          },
        }),
    ...(result.outsideScopeChangedPaths === undefined ? {} : {outsideScopeChangedPaths: true}),
    ...(result.scope === undefined ? {} : {scope: true}),
    ...(result.searchCoverage === undefined ? {} : {searchCoverage: true}),
    ...(result.source === undefined ? {} : {source: true}),
    ...(refresh === undefined ? {} : {refresh: true}),
  };
  const structuredContent = {
    freshness: result.freshness,
    operation: result.operation,
    repository: {
      displayName: compactMcpText(result.repository.displayName, 8),
      repositoryId: compactMcpText(result.repository.repositoryId, 8),
    },
    snapshot: {
      commit: compactMcpText(result.snapshot.commit, 8),
      dirty: result.snapshot.dirty,
      id: compactMcpText(result.snapshot.id, 8),
      worktreeId: compactMcpText(result.snapshot.worktreeId, 8),
    },
    sourceVersion: result.version,
    trust: result.trust,
    type: 'code-graph-inspection' as const,
    version: 1 as const,
    edges: [],
    nodes: [],
    output: {
      returnedEdges: 0,
      returnedNodes: 0,
      totalEdges: result.edges.length,
      totalNodes: result.nodes.length,
      truncated: true as const,
      metadataOmissions,
      metadataTruncated: true as const,
    },
    ...(refresh === undefined
      ? {}
      : {
          refresh: {
            ...(refresh.failure === undefined ? {} : {failure: refresh.failure}),
            ...(refresh.retryAfterMilliseconds === undefined
              ? {}
              : {retryAfterMilliseconds: refresh.retryAfterMilliseconds}),
            state: refresh.state,
            type: refresh.type,
            version: refresh.version,
          },
        }),
    warnings: ['Budget truncated.'],
  };
  return {structuredContent, text: JSON.stringify(structuredContent)};
}

/**
 * MCP consumers need stable IDs and source evidence, not parser/index internals.
 * Keep the richer graph result available to the CLI and Manager while enforcing
 * a deterministic context budget for agent tool calls.
 */
export function compactCodeGraphMcpResult(result: CodeGraphQueryResult, refresh?: CodeGraphRefreshContinuity) {
  return defaultCodeGraphMcpResponse(result, refresh).structuredContent;
}

export function codeGraphMcpResponse(
  result: CodeGraphQueryResult,
  maximumEstimatedTokens?: number,
  refresh?: CodeGraphRefreshContinuity,
  responseFormat: CodeGraphMcpResponseFormat = 'dual',
  options?: {readonly queryNodeLimit?: number},
) {
  const effectiveMaximumEstimatedTokens =
    maximumEstimatedTokens ??
    (responseFormat === 'agent' && result.operation === 'impact'
      ? MCP_CODE_GRAPH_AGENT_IMPACT_DEFAULT_ESTIMATED_TOKENS
      : undefined);
  if (effectiveMaximumEstimatedTokens === undefined) return defaultCodeGraphMcpResponse(result, refresh);
  if (
    !Number.isSafeInteger(effectiveMaximumEstimatedTokens) ||
    effectiveMaximumEstimatedTokens < MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS ||
    effectiveMaximumEstimatedTokens > MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw new Error(
      `Code graph response token budget must be an integer from ${MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS} to ${MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS}.`,
    );
  }
  const maximumBytes = effectiveMaximumEstimatedTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  if (responseFormat === 'agent' && result.operation === 'impact') {
    return impactAgentCoreResponse(result, maximumBytes, refresh);
  }
  if (responseFormat === 'agent' && result.operation === 'query') {
    return queryAgentCoreResponse(result, maximumBytes, refresh, options?.queryNodeLimit);
  }
  const minimum = responseForPrefix(result, 0, 0, 0, true, refresh);
  const minimumBytes = measureFormattedCodeGraphMcpResponse(minimum, responseFormat).totalBytes;
  if (minimumBytes <= maximumBytes) {
    return longestAdmittedPrefix(
      result,
      response => measureFormattedCodeGraphMcpResponse(response, responseFormat).totalBytes <= maximumBytes,
      true,
      refresh,
    );
  }
  const compactMinimum = responseForPrefix(result, 0, 0, 0, true, refresh, 'minimum');
  const compactMinimumBytes = measureFormattedCodeGraphMcpResponse(compactMinimum, responseFormat).totalBytes;
  if (compactMinimumBytes > maximumBytes) return fixedCodeGraphMcpReceipt(result, refresh);
  return longestAdmittedPrefix(
    result,
    response => measureFormattedCodeGraphMcpResponse(response, responseFormat).totalBytes <= maximumBytes,
    true,
    refresh,
    'minimum',
  );
}

export function formatCodeGraphMcpResponse<T>(
  response: {readonly structuredContent: T; readonly text: string},
  responseFormat: CodeGraphMcpResponseFormat = 'dual',
) {
  if (responseFormat === 'agent') {
    return {content: [{type: 'text' as const, text: renderCodeGraphAgentResponse(response.structuredContent)}]};
  }
  if (responseFormat === 'text') {
    return {content: [{type: 'text' as const, text: JSON.stringify(response.structuredContent)}]};
  }
  return {
    content: [{type: 'text' as const, text: response.text}],
    structuredContent: response.structuredContent,
  };
}

function measureFormattedCodeGraphMcpResponse<T>(
  response: {readonly structuredContent: T; readonly text: string},
  responseFormat: CodeGraphMcpResponseFormat,
) {
  const formatted = formatCodeGraphMcpResponse(response, responseFormat);
  return measureAgentToolResponse({
    ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
    text: formatted.content[0].text,
  });
}

/** A deterministic, text-only receipt for direct agent reading. The structured
 * dual channel remains available to machine consumers. */
export function renderCodeGraphAgentResponse(value: unknown): string {
  const result = value as {
    readonly edges?: readonly Record<string, unknown>[];
    readonly nodes?: readonly Record<string, unknown>[];
    readonly output?: Record<string, unknown>;
    readonly warnings?: readonly unknown[];
    readonly [key: string]: unknown;
  };
  const nodes = result.nodes ?? [];
  const aliases = new Map(nodes.map((node, index) => [String(node.id), `n${index + 1}`]));
  const scalar = (item: unknown) =>
    (JSON.stringify(item) ?? 'null').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const oneLine = (item: unknown) => {
    let output = '';
    let replacingControl = false;
    for (const character of String(item ?? '')) {
      const codePoint = character.codePointAt(0) ?? 0;
      const control =
        codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029;
      if (!control) output += character;
      else if (!replacingControl) output += ' ';
      replacingControl = control;
    }
    return output.trim();
  };
  const provenance = renderCodeGraphAgentProvenance(result).trimEnd();
  const lines = ['TN-GRAPH/1', ...(provenance.length === 0 ? [] : provenance.split('\n'))];
  if (result.outsideProjectGraph !== undefined)
    lines.push(`Outside project graph: ${scalar(result.outsideProjectGraph)}`);
  if (result.outsideScopeChangedPaths !== undefined)
    lines.push(`Outside-scope changed paths: ${scalar(result.outsideScopeChangedPaths)}`);
  if (result.scope !== undefined) lines.push(`Scope: ${scalar(result.scope)}`);
  if (result.searchCoverage !== undefined) lines.push(`Search coverage: ${scalar(result.searchCoverage)}`);
  const source = graphAgentRecord(result.source);
  if (source !== undefined) {
    const kind = graphAgentString(source.kind);
    const deltaCount = graphAgentNumber(source.deltaCount);
    if (kind !== undefined || deltaCount !== undefined)
      lines.push(`Source: ${kind ?? 'graph'}${deltaCount === undefined ? '' : `, ${deltaCount} delta(s)`}.`);
  }
  const output = graphAgentRecord(result.output);
  const returnedNodes = graphAgentNumber(output?.returnedNodes) ?? nodes.length;
  const totalNodes = graphAgentNumber(output?.totalNodes) ?? returnedNodes;
  const returnedEdges = graphAgentNumber(output?.returnedEdges) ?? result.edges?.length ?? 0;
  const totalEdges = graphAgentNumber(output?.totalEdges) ?? returnedEdges;
  lines.push(
    `Coverage: ${returnedNodes}/${totalNodes} symbols, ${returnedEdges}/${totalEdges} relationships${output?.truncated === true ? '; truncated' : ''}${output?.metadataTruncated === true ? '; metadata truncated' : ''}.`,
  );
  for (const node of nodes) {
    const id = graphAgentString(node.id) ?? '';
    const alias = aliases.get(id) ?? `n${lines.length}`;
    const kind = graphAgentString(node.kind) ?? 'symbol';
    const name = graphAgentString(node.name) ?? graphAgentString(node.qualifiedName) ?? id;
    const path = graphAgentString(node.path);
    const span = graphAgentRecord(node.span);
    const line = graphAgentNumber(span?.line);
    const location = path === undefined ? '' : ` — ${oneLine(path)}${line === undefined ? '' : `:${line}`}`;
    lines.push(`${alias}. ${node.exported === true ? 'exported ' : ''}${kind} ${oneLine(name)}${location} — ${id}`);
    const signature = graphAgentString(node.signature);
    if (signature !== undefined) lines.push(`   Signature: ${oneLine(signature)}`);
    const qualifiedName = graphAgentString(node.qualifiedName);
    if (qualifiedName !== undefined && qualifiedName !== name) lines.push(`   Qualified: ${oneLine(qualifiedName)}`);
  }
  for (const edge of result.edges ?? []) {
    const {id: _id, sourceId, targetId, ...rest} = edge;
    const source =
      sourceId === undefined
        ? (graphAgentString(rest.sourceName) ?? 'unknown')
        : (aliases.get(String(sourceId)) ?? graphAgentString(rest.sourceName) ?? sourceId);
    const target =
      targetId === undefined
        ? (graphAgentString(rest.targetName) ?? 'unknown')
        : (aliases.get(String(targetId)) ?? graphAgentString(rest.targetName) ?? targetId);
    const relation = graphAgentString(rest.relation) ?? 'related to';
    const evidencePath = graphAgentString(rest.evidencePath);
    const evidenceSpan = graphAgentRecord(rest.evidenceSpan);
    const evidenceLine = graphAgentNumber(evidenceSpan?.line);
    const evidence =
      evidencePath === undefined
        ? ''
        : ` — ${oneLine(evidencePath)}${evidenceLine === undefined ? '' : `:${evidenceLine}`}`;
    const confidence = graphAgentNumber(rest.confidence);
    const relationshipEvidence = [graphAgentString(rest.provenance), confidence === undefined ? undefined : confidence]
      .filter(item => item !== undefined)
      .join(' ');
    lines.push(
      `${oneLine(source)} → ${oneLine(target)}: ${oneLine(relation)}${relationshipEvidence ? ` (${relationshipEvidence})` : ''}${evidence}`,
    );
  }
  for (const warning of result.warnings ?? []) lines.push(`Warning: ${oneLine(warning)}`);
  if (result.output?.truncated === true) lines.push('Recovery: refine the query or follow a stable cgs_ handle.');
  return `${lines.join('\n')}\n`;
}
