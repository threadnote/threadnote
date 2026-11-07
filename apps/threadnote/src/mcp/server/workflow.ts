import {Effect} from 'effect';
import {McpInput} from '../../effect/ai/mcp.js';
import {readNativeTaskView} from '../../workflow_automation/task.js';
import type {RuntimeConfig} from './common.js';
import type {EffectMcpServerAdapter} from '../../effect/ai/mcp.js';

export function registerWorkflowTaskTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'workflow_task_view',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Read the next actionable task for an existing native workflow run.',
      inputSchema: {
        runId: McpInput.string('Existing native workflow run identifier'),
        callerCwd: McpInput.string('Absolute checkout path for this task context'),
        role: McpInput.string('Optional role: implementation, review, or delivery'),
        cursor: McpInput.string('Opaque continuation returned by the previous task-view page'),
      },
    },
    Effect.fn('mcp_server.workflowTaskView')(function* ({runId, callerCwd, role, cursor}) {
      const result = yield* readNativeTaskView(config, {
        runId,
        callerCwd,
        ...(role === undefined ? {} : {role}),
        ...(cursor === undefined ? {} : {cursor}),
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
}
