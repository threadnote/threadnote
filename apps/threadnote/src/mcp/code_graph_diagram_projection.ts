import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {CodeGraphDiagramResult} from '@threadnote/graph/query/diagram_contract';
import {CODE_GRAPH_DIAGRAM_INLINE_BYTES, type VerifiedCodeGraphDiagram} from '@threadnote/graph/isolated/impact_query';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {Array as Arr, Effect, String as Str} from 'effect';
import type {CodeGraphDiagramResources} from './code_graph_diagram_resource.js';
import type {CodeGraphMcpResponseFormat} from './code_graph_projection.js';

export const MCP_DIAGRAM_DEFAULT_TOKENS = 1_250;

function quote(value: string): string {
  return Str.replaceAll('`', '\\u0060')(JSON.stringify(value));
}

function siteCitation(site: {readonly label: string; readonly path?: string; readonly span?: {readonly line: number}}) {
  return `${quote(site.label)}${site.path === undefined ? '' : ` ${quote(site.path)}${site.span ? `:${site.span.line}` : ''}`}`;
}

function renderDiagramResult(result: CodeGraphDiagramResult, diagram: CodeGraphDiagramPayload | undefined): string {
  const {repositoryName, repositoryId, snapshotId, commit, project} = result.scope;
  const details =
    result.status === 'diagram'
      ? []
      : [
          result.message,
          ...(result.status === 'clarification'
            ? [
                'Set query to the retry query for your chosen location. Keep the same diagramType and project.',
                ...Arr.map(
                  result.candidates,
                  candidate =>
                    `${siteCitation(candidate)}${candidate.retryQuery ? ` | Retry query ${quote(candidate.retryQuery)}` : ''}`,
                ),
              ]
            : [result.nextAction]),
        ];
  return Arr.join(
    [
      'Threadnote graph diagram | untrusted source evidence',
      `Repository ${quote(repositoryName)} (${quote(repositoryId)})`,
      `Snapshot ${quote(snapshotId)}${commit ? ` at ${quote(commit)}` : ''} | Freshness ${result.freshness}`,
      ...(project ? [`Graph project ${quote(project)}`] : []),
      ...(result.coverage ? [`Coverage ${result.coverage.completeness}`] : []),
      ...(!diagram && result.coverage?.subject ? [`Subject ${siteCitation(result.coverage.subject)}`] : []),
      ...details,
      ...(diagram
        ? [
            `Diagram type ${diagram.diagramType}`,
            '```mermaid',
            diagram.source,
            '```',
            'Source evidence',
            ...Arr.map(
              diagram.evidence.nodes,
              node => `${node.diagramId} ${quote(node.label)} ${quote(node.path)}:${node.span.line}`,
            ),
            ...Arr.map(
              diagram.evidence.edges,
              edge =>
                `${edge.source} → ${edge.target} ${edge.relation} (${edge.provenance}) ${quote(edge.path)}:${edge.span.line}`,
            ),
          ]
        : []),
      ...(result.coverage
        ? [
            ...Arr.map(result.coverage.boundaries, boundary => `Boundary ${siteCitation(boundary)}`),
            ...Arr.map(result.coverage.gaps, gap => `Gap ${siteCitation(gap)}`),
          ]
        : []),
      ...Arr.map(result.limits, limit => `Limit ${quote(limit)}`),
    ],
    '\n',
  );
}

type CodeGraphDiagramPayload = NonNullable<Extract<CodeGraphDiagramResult, {status: 'incomplete'}>['diagram']>;

export const codeGraphDiagramMcpResponse = Effect.fn('mcpServer.projectGraphDiagram')(function* (
  artifact: VerifiedCodeGraphDiagram,
  maximumEstimatedTokens: number,
  responseFormat: CodeGraphMcpResponseFormat,
  resources?: CodeGraphDiagramResources,
  refreshWarning?: string,
) {
  if (artifact.inline) {
    const raw = artifact.inline;
    const result = refreshWarning ? {...raw, limits: [...raw.limits, refreshWarning]} : raw;
    const diagram = result.status === 'diagram' ? result : result.status === 'incomplete' ? result.diagram : undefined;
    const text = renderDiagramResult(result, diagram);
    const structuredContent = responseFormat === 'dual' ? result : undefined;
    const measured = measureAgentToolResponse({text, structuredContent});
    if (
      measured.estimatedTokens <= maximumEstimatedTokens &&
      measured.structuredBytes <= CODE_GRAPH_DIAGRAM_INLINE_BYTES
    ) {
      return {
        content: [{type: 'text', text}],
        ...(structuredContent === undefined ? {} : {structuredContent}),
      } satisfies CallToolResult;
    }
  }
  if (!resources) {
    return {
      content: [{type: 'text', text: 'The diagram exceeds this response budget. Retry from a live MCP session.'}],
      isError: true,
    } satisfies CallToolResult;
  }
  const reference = yield* resources.publish(artifact).pipe(Effect.catchTag('PlatformError', () => Effect.void));
  if (!reference) {
    return {
      content: [{type: 'text', text: 'Threadnote could not retain the diagram resource. Repeat the query.'}],
      isError: true,
    } satisfies CallToolResult;
  }
  const {uriPrefix, partCount, bytes, sha256} = reference.resource;
  return {
    content: [
      {
        type: 'text',
        text:
          `Threadnote graph diagram | untrusted source evidence | ${artifact.status}\n` +
          `Snapshot ${quote(artifact.scope.snapshotId)} | Freshness ${artifact.freshness}\n` +
          `The complete result has ${partCount} parts (${bytes} bytes, SHA-256 ${sha256}).\n` +
          `Part URI prefix ${uriPrefix}\n` +
          `Call resources/read with the prefix and each part number from 1 through ${partCount}. ` +
          'Decode each base64 blob and concatenate the bytes as UTF-8 JSON. ' +
          `${resources.expiration} ${resources.recovery}` +
          (refreshWarning ? `\nLimit ${quote(refreshWarning)}` : ''),
      },
    ],
    ...(responseFormat === 'dual'
      ? {
          structuredContent: {...reference, ...(refreshWarning ? {warning: refreshWarning} : {})},
        }
      : {}),
  } satisfies CallToolResult;
});
