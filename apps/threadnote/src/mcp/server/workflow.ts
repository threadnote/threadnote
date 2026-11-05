import {Effect, Schema} from 'effect';
import {McpInput} from '../../effect/ai/mcp.js';
import {readNativeTaskView} from '../../workflow_automation/task.js';
import {runNativeTaskAction} from '../../workflow_automation/task_actions.js';
import {NativeCyclePacketOptionsSchema} from '@threadnote/workflow-automations/cycle-packet';
import {NativeCycleReviewSchema} from '@threadnote/workflow-automations/cycle-review';
import {NativeCycleValidationSchema} from '@threadnote/workflow-automations/cycle';
import {NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import {NativeTaskAnchorSchema} from '@threadnote/workflow-automations/task';
import {NativeCompactIntentSchema} from '@threadnote/workflow-automations/authoring';
import type {RuntimeConfig} from './common.js';
import type {EffectMcpServerAdapter} from '../../effect/ai/mcp.js';

export function registerWorkflowTaskTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'workflow_task_compact_start',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Save a bounded compact task intent as a draft and return its exact approval packet.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        intent: NativeCompactIntentSchema,
      },
    },
    Effect.fn('mcp_server.workflowTaskCompactStart')(function* ({runId, callerCwd, intent}) {
      const result = yield* runNativeTaskAction(config, {command: 'compact-start', runId, callerCwd, intent});
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_compact_expand',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Prepare an expanded native plan on the same compact-origin authoring root.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        document: Schema.Unknown,
      },
    },
    Effect.fn('mcp_server.workflowTaskCompactExpand')(function* ({runId, callerCwd, document}) {
      const result = yield* runNativeTaskAction(config, {command: 'compact-expand', runId, callerCwd, document});
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_compact_confirm',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Record an actual exact-intent user response, then admit or reconcile the same canonical run.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        presentedIntentHash: McpInput.requiredString('Exact intent hash from the complete approval packet'),
        userResponse: McpInput.string('Actual user response to the displayed exact-intent packet'),
        userDecision: Schema.optionalKey(Schema.Literals(['approve', 'reject', 'defer'])),
        baseBranch: McpInput.string('Exact base branch for a new local cycle'),
        reconcileReason: McpInput.string('Concrete reason for reconciling an existing cycle'),
        bindings: Schema.optionalKey(
          Schema.Record(Schema.String, Schema.Struct({branch: Schema.String, baseBranch: Schema.String})),
        ),
        review: Schema.optionalKey(
          Schema.Struct({
            documentHash: Schema.String,
            outcome: Schema.Literals(['accepted', 'changes-requested']),
            blockingIssueCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
          }),
        ),
      },
    },
    Effect.fn('mcp_server.workflowTaskCompactConfirm')(function* (input) {
      const result = yield* runNativeTaskAction(config, {command: 'compact-confirm', ...input});
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_view',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Read the next task; detail=packet returns its full approval/review content.',
      inputSchema: {
        runId: McpInput.string('Existing native workflow run identifier'),
        callerCwd: McpInput.string('Absolute bound checkout path'),
        role: McpInput.string('Role: implementation, review, or delivery'),
        cursor: McpInput.string('Opaque continuation from the previous task-view page'),
        detail: Schema.optionalKey(Schema.Literals(['summary', 'packet'])),
      },
    },
    Effect.fn('mcp_server.workflowTaskView')(function* ({runId, callerCwd, role, cursor, detail}) {
      const result = yield* readNativeTaskView(config, {
        runId,
        callerCwd,
        ...(role === undefined ? {} : {role}),
        ...(cursor === undefined ? {} : {cursor}),
        ...(detail === undefined ? {} : {detail}),
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
        anchors: Schema.Array(NativeTaskAnchorSchema).check(Schema.isBetweenLength(1, 128)),
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
        resume: McpInput.boolean('Explicitly continue a canonical closeout job using the same opaque reference'),
      },
    },
    Effect.fn('mcp_server.workflowTaskFinish')(function* ({runId, callerCwd, proposal, prepareRef, finishRef, resume}) {
      const result = yield* runNativeTaskAction(config, {
        command: 'finish',
        runId,
        callerCwd,
        ...(proposal === undefined ? {} : {proposal}),
        ...(prepareRef === undefined ? {} : {prepareRef}),
        ...(finishRef === undefined ? {} : {finishRef}),
        ...(resume === true ? {resume: true} : {}),
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
}
