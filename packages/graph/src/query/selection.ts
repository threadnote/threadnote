import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult} from '../types.js';
import {sanitizeCodeGraphPresentationText as sanitizeText} from '../presentation_text.js';

const CODE_GRAPH_RESULT_MAX_BYTES = 256 * 1_024;

export function sanitizeSelection(selection: {
  readonly edges: readonly CodeGraphEdge[];
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly scope?: CodeGraphQueryResult['scope'];
  readonly searchCoverage?: CodeGraphQueryResult['searchCoverage'];
  readonly warnings: readonly string[];
}): {
  readonly edges: readonly CodeGraphEdge[];
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly scope?: CodeGraphQueryResult['scope'];
  readonly searchCoverage?: CodeGraphQueryResult['searchCoverage'];
  readonly warnings: readonly string[];
} {
  const nodes = selection.nodes.map(node => ({
    ...node,
    documentation: node.documentation ? sanitizeText(node.documentation, 2_048) : undefined,
    id: sanitizeText(node.id, 256),
    kind: sanitizeText(node.kind, 128),
    language: sanitizeText(node.language, 128),
    name: sanitizeText(node.name, 256),
    packageName: node.packageName ? sanitizeText(node.packageName, 256) : undefined,
    path: sanitizeText(node.path, 1_024),
    qualifiedName: sanitizeText(node.qualifiedName, 512),
    signature: node.signature ? sanitizeText(node.signature, 1_024) : undefined,
  }));
  const edges = selection.edges.map(edge => ({
    ...edge,
    evidencePath: sanitizeText(edge.evidencePath, 1_024),
    id: sanitizeText(edge.id, 256),
    sourceId: edge.sourceId ? sanitizeText(edge.sourceId, 256) : undefined,
    sourceName: sanitizeText(edge.sourceName, 256),
    targetId: edge.targetId ? sanitizeText(edge.targetId, 256) : undefined,
    targetName: sanitizeText(edge.targetName, 256),
  }));
  const warnings = selection.warnings.map(warning => sanitizeText(warning, 1_024));
  const acceptedNodes: CodeGraphQueryNode[] = [];
  const acceptedEdges: CodeGraphEdge[] = [];
  let bytes = 0;
  let truncated = false;
  for (const node of nodes) {
    const size = encodedSize(node);
    if (bytes + size > CODE_GRAPH_RESULT_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    acceptedNodes.push(node);
  }
  for (const edge of edges) {
    const size = encodedSize(edge);
    if (bytes + size > CODE_GRAPH_RESULT_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    acceptedEdges.push(edge);
  }
  return {
    edges: acceptedEdges,
    nodes: acceptedNodes,
    ...(selection.scope
      ? {scope: {...selection.scope, packageName: sanitizeText(selection.scope.packageName, 256)}}
      : {}),
    ...(selection.searchCoverage
      ? {
          searchCoverage: truncated
            ? {
                ...selection.searchCoverage,
                status: selection.searchCoverage.status === 'timed-out' ? ('timed-out' as const) : ('bounded' as const),
                limitsReached: [...new Set([...selection.searchCoverage.limitsReached, 'output-bytes' as const])],
              }
            : selection.searchCoverage,
        }
      : {}),
    warnings: truncated ? [...warnings, 'Graph result reached its output byte budget; results are partial.'] : warnings,
  };
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
