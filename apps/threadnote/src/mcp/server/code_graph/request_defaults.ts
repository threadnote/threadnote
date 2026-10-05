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
