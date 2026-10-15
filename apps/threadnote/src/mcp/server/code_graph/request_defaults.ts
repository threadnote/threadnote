import type {CodeGraphAnalysisBudget} from '@threadnote/graph/analysis';

type CodeGraphMcpOperation = 'explain' | 'impact' | 'neighbors' | 'node' | 'path' | 'query' | 'topology';

const MCP_CODE_GRAPH_DEFAULT_NODE_LIMIT = 20;
const MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT = 40;
const MCP_CODE_GRAPH_LOCAL_QUERY_DEFAULT_BUDGET_TOKENS = 800;
const MCP_CODE_GRAPH_LOCAL_QUERY_DEFAULT_NODE_LIMIT = 8;
const MCP_CODE_GRAPH_LOCAL_QUERY_DEFAULT_EDGE_LIMIT = 12;

/** Applies compact defaults only to a local discovery query; callers retain every explicit value. */
export function codeGraphMcpRequestDefaults(
  operation: CodeGraphMcpOperation,
  input: {
    readonly budgetTokens?: number;
    readonly edgeLimit?: number;
    readonly nodeLimit?: number;
    readonly workset?: string;
  },
) {
  const localQuery = !input.workset?.trim() && operation === 'query';
  return {
    budgetTokens: localQuery
      ? (input.budgetTokens ?? MCP_CODE_GRAPH_LOCAL_QUERY_DEFAULT_BUDGET_TOKENS)
      : input.budgetTokens,
    edgeLimit: localQuery
      ? (input.edgeLimit ?? MCP_CODE_GRAPH_LOCAL_QUERY_DEFAULT_EDGE_LIMIT)
      : (input.edgeLimit ?? MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT),
    nodeLimit: localQuery
      ? (input.nodeLimit ?? MCP_CODE_GRAPH_LOCAL_QUERY_DEFAULT_NODE_LIMIT)
      : (input.nodeLimit ?? MCP_CODE_GRAPH_DEFAULT_NODE_LIMIT),
  };
}

export const MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS = 55_000;
export const MCP_CODE_GRAPH_QUERY_TIMEOUT_MILLISECONDS = 55_000;
export const MCP_CODE_GRAPH_RESPONSE_RESERVE_MILLISECONDS = 1_000;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_NODE_VISITS = 100_000;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_EDGE_VISITS = 1_000_000;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_DISTINCT_EDGES = 500_000;

/**
 * MCP analysis is admitted for every repository, but topology retention is
 * bounded independently from the complete CLI and Manager analysis surfaces.
 */
export function codeGraphMcpAnalysisBudget(): CodeGraphAnalysisBudget {
  return {
    maxDurationMilliseconds: MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS - MCP_CODE_GRAPH_RESPONSE_RESERVE_MILLISECONDS,
    maxEdges: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_DISTINCT_EDGES,
    maxEdgeVisits: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_EDGE_VISITS,
    maxNodes: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_NODE_VISITS,
  };
}
