import {Effect, Path} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../../effect/ai/mcp.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {SystemInfo} from '@threadnote/platform/system';
import {
  readContextMaintenanceStatus,
  readContextMaintenancePacket,
  renderContextMaintenanceStatus,
  runContextMaintenance,
  setContextMaintenancePaused,
  undoContextMaintenance,
} from '../../../memory/context/maintenance.js';
import {argumentError, mcpErrorResult} from '../common.js';

export function registerContextMaintenanceTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_maintenance_status',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Read persistent local maintenance progress, grouped evidence cases and bounded automatic repair receipts. Does not run maintenance.',
      inputSchema: {project: McpInput.string('Optional project selection')},
    },
    ({project}) =>
      readContextMaintenanceStatus(config, project).pipe(
        Effect.map(result => ({
          content: [
            {
              type: 'text' as const,
              text: 'version' in result ? renderContextMaintenanceStatus(result) : JSON.stringify(result),
            },
          ],
          structuredContent: result,
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      ),
  );
  server.registerTool(
    'context_maintain',
    {
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false},
      description:
        'Run one bounded local maintenance tick, pause/resume default automatic work, or CAS-undo an exact retained repair receipt. Shared canonical knowledge remains review controlled; no network or scheduler installation occurs.',
      inputSchema: {
        action: McpInput.literals(['run', 'pause', 'resume', 'undo'], 'Defaults to run'),
        callerCwd: McpInput.string('Absolute local repository/worktree evidence root'),
        project: McpInput.string('Optional project; omitted work uses fair home-wide scheduling'),
        maxRecords: McpInput.integer('Bounded work tasks', {minimum: 1, maximum: 100}),
        receiptId: McpInput.string('Exact retained receipt for undo'),
      },
    },
    input =>
      Effect.gen(function* () {
        const cwd = input.callerCwd ?? (yield* SystemInfo).currentDirectory();
        if (!(yield* Path.Path).isAbsolute(cwd)) return argumentError('context_maintain callerCwd must be absolute.');
        const result =
          input.action === 'pause' || input.action === 'resume'
            ? yield* setContextMaintenancePaused(config, input.action === 'pause')
            : input.action === 'undo'
              ? yield* undoContextMaintenance(config, input.receiptId ?? '')
              : yield* runContextMaintenance(config, {cwd, project: input.project, maxRecords: input.maxRecords});
        return {
          content: [
            {
              type: 'text' as const,
              text: 'version' in result ? renderContextMaintenanceStatus(result) : JSON.stringify(result),
            },
          ],
          structuredContent: result,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error)))),
  );
  server.registerTool(
    'context_maintenance_packet',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Read one exact, bounded maintenance decision packet with canonical memory/evidence revisions and reviewed allowable operations.',
      inputSchema: {caseId: McpInput.string('Exact case ID from context_maintenance_status')},
    },
    ({caseId}) =>
      readContextMaintenancePacket(config, caseId ?? '').pipe(
        Effect.map(result => ({
          content: [{type: 'text' as const, text: JSON.stringify(result)}],
          structuredContent: result,
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      ),
  );
}
