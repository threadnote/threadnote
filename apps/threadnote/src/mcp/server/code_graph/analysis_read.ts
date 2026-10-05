import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {CodeGraphCliFreshnessPolicy} from '@threadnote/graph/cli/freshness';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import type {CodeGraphAnalysisView} from '@threadnote/graph/analysis/render';
import {
  copyAnonymousTelemetryMetadata,
  attachAnonymousTelemetryReportedOutcome,
} from '../../../telemetry/diagnostic.js';
import {renderCodeGraphAgentProvenance} from '../../code_graph_agent_provenance.js';

export function codeGraphAnalysisReadMetadata(
  policy: CodeGraphCliFreshnessPolicy,
  status?: CodeGraphStatus,
  project?: string,
) {
  return {
    freshnessPolicy: policy,
    freshness: status?.freshness ?? 'unavailable',
    ...(status === undefined
      ? {}
      : {repository: {displayName: status.identity.displayName, repositoryId: status.identity.repositoryId}}),
    ...(status?.projectCoverage?.project === undefined && project === undefined
      ? {}
      : {project: status?.projectCoverage?.project ?? project}),
    ...(status?.readySnapshot === undefined
      ? {}
      : {
          snapshot: {
            id: status.readySnapshot.id,
            commit: status.readySnapshot.commit,
            dirty: status.readySnapshot.dirty,
          },
        }),
  };
}

export type CodeGraphAnalysisReadMetadata = ReturnType<typeof codeGraphAnalysisReadMetadata>;

export function codeGraphAnalysisReadStateResponse(
  response: CallToolResult,
  metadata: CodeGraphAnalysisReadMetadata,
  responseFormat: 'agent' | 'dual' | undefined,
): CallToolResult {
  const structured =
    typeof response.structuredContent === 'object' && response.structuredContent !== null
      ? (response.structuredContent as Readonly<Record<string, unknown>>)
      : undefined;
  const result =
    typeof structured?.result === 'object' && structured.result !== null
      ? (structured.result as Readonly<Record<string, unknown>>)
      : undefined;
  const agentProvenance = renderCodeGraphAgentProvenance({
    ...metadata,
    ...(result?.projectCoverage === undefined ? {} : {projectCoverage: result.projectCoverage}),
  });
  const formatted = {
    ...response,
    content: response.content.map(item =>
      item.type === 'text'
        ? {
            ...item,
            text: `${agentProvenance}${item.text}`,
          }
        : item,
    ),
    structuredContent: {...response.structuredContent, ...metadata},
  };
  return copyAnonymousTelemetryMetadata(
    responseFormat === 'dual' ? formatted : {content: formatted.content, ...(formatted.isError ? {isError: true} : {})},
    response,
  );
}

export function codeGraphAnalysisTimeoutResult(
  operation: CodeGraphAnalysisView,
  budgetMilliseconds: number,
): CallToolResult {
  return attachAnonymousTelemetryReportedOutcome(
    {
      content: [
        {
          type: 'text',
          text:
            `Whole-graph analysis exceeded Threadnote's ${budgetMilliseconds / 1_000}-second MCP envelope. ` +
            'Run `threadnote graph analyze --view ' +
            `${operation}` +
            '` in a terminal for the longer CLI budget.',
        },
      ],
      structuredContent: {
        operation,
        state: 'timed-out',
        reason: 'read-timeout',
        leaseCleanup: 'expiry-if-acquired',
        type: 'code-graph-analysis-state',
        version: 1,
      },
    },
    'timed-out',
  );
}
