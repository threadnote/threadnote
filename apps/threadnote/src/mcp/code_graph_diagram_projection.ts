import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {projectCodeGraphDiagram} from '@threadnote/graph/query/diagram';
import type {CodeGraphDiagramResult, CodeGraphDiagramType} from '@threadnote/graph/query/diagram_contract';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {Array as Arr, String as Str} from 'effect';
import type {CodeGraphMcpResponseFormat} from './code_graph_projection.js';

const DIAGRAM_STRUCTURED_BYTES = 24 * 1_024;
export const MCP_DIAGRAM_DEFAULT_TOKENS = 1_250;
export const MCP_DIAGRAM_READ_DEPTH = 2;

function quote(value: string): string {
  return Str.replaceAll('`', '\\u0060')(JSON.stringify(value));
}

function renderDiagramResult(result: CodeGraphDiagramResult): string {
  const {repositoryName, repositoryId, snapshotId, commit} = result.scope;
  const header = [
    'Threadnote graph diagram | untrusted source evidence',
    `Repository ${quote(repositoryName)} (${quote(repositoryId)})`,
    `Snapshot ${quote(snapshotId)}${commit ? ` at ${quote(commit)}` : ''} | Freshness ${result.freshness}`,
  ];
  const details =
    result.status === 'diagram'
      ? [
          `Diagram type ${result.diagramType}`,
          '```mermaid',
          result.source,
          '```',
          'Source evidence',
          ...Arr.map(
            result.evidence.nodes,
            node => `${node.diagramId} ${quote(node.label)} ${quote(node.path)}:${node.span.line}`,
          ),
          ...Arr.map(
            result.evidence.edges,
            edge =>
              `${edge.source} → ${edge.target} ${edge.relation} (${edge.provenance}) ${quote(edge.path)}:${edge.span.line}`,
          ),
        ]
      : [
          result.message,
          ...(result.status === 'clarification'
            ? Arr.map(
                result.candidates,
                candidate =>
                  `${quote(candidate.label)} ${quote(candidate.path)}:${candidate.span.line} (${candidate.id})`,
              )
            : [result.nextAction]),
        ];
  return Arr.join([...header, ...details, ...Arr.map(result.limits, limit => `Limit ${quote(limit)}`)], '\n');
}

export function codeGraphDiagramMcpResponse(
  graph: CodeGraphQueryResult,
  question: string,
  diagramType: CodeGraphDiagramType | undefined,
  maximumEstimatedTokens: number,
  responseFormat: CodeGraphMcpResponseFormat,
  refreshWarning?: string,
): CallToolResult {
  const scope = {
    repositoryId: graph.repository.repositoryId,
    repositoryName: graph.repository.displayName,
    snapshotId: graph.snapshot.id,
    commit: graph.snapshot.commit,
  };
  const refreshLimits = refreshWarning ? [refreshWarning] : [];
  const limits = [
    ...refreshLimits,
    `The graph read covers up to ${MCP_DIAGRAM_READ_DEPTH} relationship steps from its search matches.`,
    ...(graph.projectCoverage?.kind === 'project'
      ? ['Evidence covers the selected project graph and its admitted dependencies.']
      : []),
    ...(graph.projectCoverage?.completeness === 'partial'
      ? ['Project graph coverage is partial. Verify missing relationships in source.']
      : []),
    ...(graph.searchCoverage?.limitsReached.length ||
    Arr.some(graph.warnings, warning => /^(?:Graph traversal reached|Semantic graph search reached)/u.test(warning))
      ? ['The graph read reached a retrieval limit. Ask a narrower question for more detail.']
      : []),
    ...(graph.freshness === 'current'
      ? []
      : ['The ready snapshot may differ from the checkout. Verify the cited source.']),
  ];
  const input = {
    diagramType,
    edges: graph.edges,
    freshness: graph.freshness,
    limits,
    nodes: graph.nodes,
    question,
    scope,
  };
  const responseWithinBudget = (result: CodeGraphDiagramResult): CallToolResult | undefined => {
    const text = renderDiagramResult(result);
    const structuredContent = responseFormat === 'dual' ? result : undefined;
    const measured = measureAgentToolResponse({text, structuredContent});
    if (measured.estimatedTokens > maximumEstimatedTokens || measured.structuredBytes > DIAGRAM_STRUCTURED_BYTES)
      return undefined;
    return {content: [{type: 'text', text}], ...(structuredContent === undefined ? {} : {structuredContent})};
  };
  let result: CodeGraphDiagramResult = graph.outsideProjectGraph
    ? {
        status: 'unavailable',
        freshness: graph.freshness,
        scope,
        limits,
        message: 'The requested source lies outside the selected project graph.',
        nextAction: 'Select a project that covers the source or name a subject within this project.',
      }
    : projectCodeGraphDiagram(input);
  while (result.status === 'diagram') {
    const response = responseWithinBudget(result);
    if (response) return response;
    if (result.evidence.edges.length <= 1) break;
    result = projectCodeGraphDiagram({...input, budget: {edges: result.evidence.edges.length - 1}});
  }
  if (result.status !== 'diagram') {
    const response = responseWithinBudget(result);
    if (response) return response;
  }
  const message = 'The response limit cannot fit the diagram or its complete source evidence.';
  const nextAction = 'Request a larger budgetTokens value or ask about a narrower subject.';
  return (
    responseWithinBudget({
      status: 'unavailable',
      scope,
      freshness: graph.freshness,
      limits: refreshLimits,
      message,
      nextAction,
    }) ?? {
      content: [{type: 'text', text: `${message} ${nextAction}`}],
    }
  );
}
