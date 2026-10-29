import {Effect} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {produceSecondSurfaceProofV1} from '../../activation/second/surface_producer.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export function registerActivationProofTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'complete_activation_retrieval_proof',
    {
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
      description:
        'Complete a pending guided-activation retrieval challenge from this exact managed MCP surface. The server reads and attests the published decision; user-authored recall/read JSON is never accepted.',
      inputSchema: {
        callerCwd: McpInput.string('Absolute repository path from the activation request'),
        challengeId: McpInput.string('Opaque challenge ID emitted by threadnote activate'),
        project: McpInput.string('Exact activation project'),
        query: McpInput.string('Exact activation task text'),
        topic: McpInput.string('Exact activation topic'),
      },
    },
    Effect.fn('mcp_server.completeActivationRetrievalProof')(function* (
      {callerCwd, challengeId, project, query, topic},
      context,
    ) {
      const receipt = yield* produceSecondSurfaceProofV1(config, {
        callerCwd: required(callerCwd, 'callerCwd'),
        challengeId: required(challengeId, 'challengeId'),
        project: required(project, 'project'),
        query: required(query, 'query'),
        topic: required(topic, 'topic'),
        transport: context.requestContext.transport,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Activation retrieval proof completed for ${receipt.surfaceId}; resume the activation CLI.`,
          },
        ],
        structuredContent: receipt,
      };
    }),
  );
}

function required(value: string | undefined, name: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining narrows `value` for the return below.
  if (!value?.trim()) throw new Error(`complete_activation_retrieval_proof requires ${name}.`);
  return value;
}
