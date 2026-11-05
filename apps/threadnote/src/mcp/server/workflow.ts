import {Effect, Schema} from 'effect';
import {McpInput} from '../../effect/ai/mcp.js';
import {readNativeTaskView} from '../../workflow_automation/task.js';
import {runNativeTaskAction} from '../../workflow_automation/task_actions.js';
import {NativeCyclePacketOptionsSchema} from '@threadnote/workflow-automations/cycle-packet';
import {NativeCycleReviewSchema} from '@threadnote/workflow-automations/cycle-review';
import {NativeCycleValidationSchema} from '@threadnote/workflow-automations/cycle';
import {NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
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
  server.registerTool(
    'workflow_task_work',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Prepare a source-checked implementation packet for the current native phase.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        capacity: NativeCyclePacketOptionsSchema.fields.capacity,
        anchors: NativeCyclePacketOptionsSchema.fields.anchors,
        ownership: NativeCyclePacketOptionsSchema.fields.ownership,
        checks: NativeCyclePacketOptionsSchema.fields.checks,
        budgetBytes: NativeCyclePacketOptionsSchema.fields.budgetBytes,
        detailRefs: NativeCyclePacketOptionsSchema.fields.detailRefs,
      },
    },
    Effect.fn('mcp_server.workflowTaskWork')(function* ({
      runId,
      callerCwd,
      capacity,
      anchors,
      ownership,
      checks,
      budgetBytes,
      detailRefs,
    }) {
      const result = yield* runNativeTaskAction(config, {
        command: 'work',
        runId,
        callerCwd,
        packet: {
          capacity,
          anchors,
          ownership,
          checks,
          ...(budgetBytes === undefined ? {} : {budgetBytes}),
          ...(detailRefs === undefined ? {} : {detailRefs}),
        },
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_record_snapshot',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Record the current worker source as the immutable result of an admitted implementation packet.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        workRef: McpInput.requiredString('Opaque work reference returned by workflow_task_work'),
      },
    },
    Effect.fn('mcp_server.workflowTaskRecordSnapshot')(function* ({runId, callerCwd, workRef}) {
      const result = yield* runNativeTaskAction(config, {command: 'record-snapshot', runId, callerCwd, workRef});
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_record_review',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Record a complete independent review result against an immutable task snapshot.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        snapshotRef: McpInput.requiredString('Opaque snapshot reference returned by snapshot recording'),
        mode: NativeCycleReviewSchema.fields.mode,
        selected: NativeCycleReviewSchema.fields.selected,
        lanes: NativeCycleReviewSchema.fields.lanes,
        findings: NativeCycleReviewSchema.fields.findings,
      },
    },
    Effect.fn('mcp_server.workflowTaskRecordReview')(function* ({
      runId,
      callerCwd,
      snapshotRef,
      mode,
      selected,
      lanes,
      findings,
    }) {
      const result = yield* runNativeTaskAction(config, {
        command: 'record-review',
        runId,
        callerCwd,
        snapshotRef,
        report: {mode, selected, lanes, findings},
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_record_validation',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Record passed check and acceptance evidence against the reviewed task snapshot.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        snapshotRef: McpInput.requiredString('Opaque snapshot reference returned by review recording'),
        checks: NativeCycleValidationSchema.fields.checks,
        acceptance: NativeCycleValidationSchema.fields.acceptance,
      },
    },
    Effect.fn('mcp_server.workflowTaskRecordValidation')(function* ({
      runId,
      callerCwd,
      snapshotRef,
      checks,
      acceptance,
    }) {
      const result = yield* runNativeTaskAction(config, {
        command: 'record-validation',
        runId,
        callerCwd,
        snapshotRef,
        validation: {checks, acceptance},
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_deliver_local',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Record the canonical local delivery receipt for a validated local phase.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        validationRef: McpInput.requiredString('Opaque validation reference returned by validation recording'),
      },
    },
    Effect.fn('mcp_server.workflowTaskDeliverLocal')(function* ({runId, callerCwd, validationRef}) {
      const result = yield* runNativeTaskAction(config, {
        command: 'deliver-local',
        runId,
        callerCwd,
        validationRef,
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_finish',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Prepare and finish a completed single-phase local cycle through canonical closeout jobs.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        proposal: Schema.optionalKey(NativeCloseoutProposalSchema),
        prepareRef: McpInput.string('Opaque preparation reference returned by an earlier finish call'),
        finishRef: McpInput.string('Opaque finish reference returned by an earlier finish call'),
      },
    },
    Effect.fn('mcp_server.workflowTaskFinish')(function* ({runId, callerCwd, proposal, prepareRef, finishRef}) {
      const result = yield* runNativeTaskAction(config, {
        command: 'finish',
        runId,
        callerCwd,
        ...(proposal === undefined ? {} : {proposal}),
        ...(prepareRef === undefined ? {} : {prepareRef}),
        ...(finishRef === undefined ? {} : {finishRef}),
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
}
