import {runNativeTaskAuthoring} from '../../workflow_automation/task_authoring.js';
import {Effect, Schema} from 'effect';
import {McpInput} from '../../effect/ai/mcp.js';
import {readNativeTaskView} from '../../workflow_automation/task.js';
import {
  NativeTaskPrDeliveryFieldsSchema,
  NativeTaskPrWatchFieldsSchema,
  NativeTaskCloseoutProposalSchema,
  runNativeTaskAction,
  runNativeTaskStart,
} from '../../workflow_automation/task_actions.js';
import {NativeCyclePacketOptionsSchema} from '@threadnote/workflow-automations/cycle-packet';
import {NativeCycleReviewSchema} from '@threadnote/workflow-automations/cycle-review';
import {NativeCycleValidationSchema} from '@threadnote/workflow-automations/cycle';
import {NativeTaskAnchorSchema} from '@threadnote/workflow-automations/task';
import {NativeCompactIntentSchema} from '@threadnote/workflow-automations/authoring';
import type {RuntimeConfig} from './common.js';
import type {EffectMcpServerAdapter} from '../../effect/ai/mcp.js';

export function registerWorkflowTaskTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'workflow_task_author',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Standard spec/plan business authoring. Start/save from business JSON without native metadata; read full content; record a caller-provided human response and independent review; admit an approved local, commit, or PR plan. References come from this tool. Actor identity is caller-asserted, not independently authenticated. Read is nonmutating.',
      inputSchema: {
        command: Schema.Literals(['start', 'read', 'save', 'decide', 'admit', 'job']),
        callerCwd: McpInput.requiredString('Absolute original checkout'),
        featureName: McpInput.string('Feature name for start'),
        kind: Schema.optionalKey(Schema.Literals(['spec', 'plan'])),
        contentFile: McpInput.string('Business JSON file; omit format/id/project/source/spec/compactOrigin metadata'),
        saveMode: Schema.optionalKey(Schema.Literal('background')),
        installationTarget: McpInput.string('Installed target selector for start or authoring job resume'),
        authoringRef: McpInput.string('Current authoring continuation'),
        jobRef: McpInput.string('Opaque accepted semantic authoring job continuation'),
        operation: Schema.optionalKey(Schema.Literals(['status', 'result', 'cancel', 'resume'])),
        specRef: McpInput.string('Approved spec reference for plan start'),
        detail: Schema.optionalKey(Schema.Literals(['summary', 'document'])),
        userDecision: Schema.optionalKey(Schema.Literals(['approve', 'reject', 'defer'])),
        userResponse: McpInput.string('Caller-provided response to the full current document'),
        delivery: Schema.optionalKey(Schema.Literals(['local', 'commit', 'pr'])),
        review: Schema.optionalKey(
          Schema.Struct({
            outcome: Schema.Literals(['accepted', 'changes-requested']),
            blockingIssueCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
          }),
        ),
        bindings: Schema.optionalKey(
          Schema.Record(Schema.String, Schema.Struct({branch: Schema.String, baseBranch: Schema.String})),
        ),
      },
    },
    Effect.fn('mcp.workflowTaskAuthor')(function* (input) {
      const result = yield* runNativeTaskAuthoring(config, input);
      return {content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_start',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Start or resume a bounded task from business intent; the runtime verifies installed workflow resources and owns native run metadata.',
      inputSchema: {
        callerCwd: McpInput.requiredString('Absolute checkout path for this task'),
        featureName: McpInput.requiredString('Stable feature name used to resume this task'),
        installationTarget: McpInput.requiredString(
          'Installed Threadnote host target, required to verify the current bundle on start or resume',
        ),
        taskRef: McpInput.string('Optional opaque task reference returned by a previous start'),
        intent: NativeCompactIntentSchema,
      },
    },
    Effect.fn('mcp_server.workflowTaskStart')(function* (input) {
      const {callerCwd, featureName, installationTarget, taskRef, intent} = input;
      const result = yield* runNativeTaskStart(config, {
        callerCwd,
        featureName,
        ...(installationTarget === undefined ? {} : {installationTarget}),
        ...(taskRef === undefined ? {} : {taskRef}),
        intent,
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
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
        userResponse: McpInput.string('Caller-provided response to the displayed exact-intent packet'),
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
      description: 'Read a task summary or packet (detail=packet).',
      inputSchema: {
        runId: McpInput.requiredString('Run ID'),
        callerCwd: McpInput.requiredString('Absolute path'),
        role: McpInput.string('Role'),
        cursor: McpInput.string('Cursor'),
        phaseId: McpInput.string('Listed historical phase ID for its PR watch'),
        detail: Schema.optionalKey(Schema.Literals(['summary', 'packet'])),
        outputKey: McpInput.string('One listed verified closeout body key; requires packet detail'),
      },
    },
    Effect.fn('mcp_server.workflowTaskView')(function* ({runId, callerCwd, role, cursor, phaseId, detail, outputKey}) {
      const result = yield* readNativeTaskView(config, {
        runId,
        callerCwd,
        ...(role === undefined ? {} : {role}),
        ...(cursor === undefined ? {} : {cursor}),
        ...(phaseId === undefined ? {} : {phaseId}),
        ...(detail === undefined ? {} : {detail}),
        ...(outputKey === undefined ? {} : {outputKey}),
      });
      const nextTool =
        result.next.action === 'deliver'
          ? {
              tool: 'workflow_task_deliver',
              guidance: 'Choose local, commit, or pr to match the approved plan.',
            }
          : result.next.action === 'implement'
            ? {
                tool: 'workflow_task_snapshot',
                guidance:
                  'After work, record the source; supersede-unreviewed is only for its eligible latest snapshot.',
              }
            : result.next.action === 'complete'
              ? {
                  tool: 'workflow_task_finish',
                  guidance:
                    'Finish an eligible completed cycle; PR delivery requires a merged, source-complete terminal watch.',
                }
              : undefined;
      const response = nextTool ? {...result, next: {...result.next, ...nextTool}} : result;
      const text = JSON.stringify(response);
      return {content: [{type: 'text' as const, text}], structuredContent: response};
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
    'workflow_task_control',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Use the current task card to begin eligible phases, resume a blocked phase after dependencies are accepted, reconcile this run to its verified ready approved plan with bindings, or extend an exhausted review budget with caller-provided human authority. Actor identity is not independently authenticated.',
      inputSchema: {
        runId: McpInput.requiredString('Existing workflow run ID'),
        callerCwd: McpInput.requiredString('Absolute bound checkout'),
        taskRef: McpInput.requiredString('Current task card reference from workflow_task_view'),
        control: Schema.Union([
          Schema.Struct({command: Schema.Literal('begin')}),
          Schema.Struct({
            command: Schema.Literal('resume'),
            reason: McpInput.requiredString('Recovery reason'),
          }),
          Schema.Struct({
            command: Schema.Literal('reconcile'),
            reason: McpInput.requiredString('Reason for approved-plan reconciliation'),
            bindings: Schema.optionalKey(
              Schema.Record(Schema.String, Schema.Struct({branch: Schema.String, baseBranch: Schema.String})),
            ),
          }),
          Schema.Struct({
            command: Schema.Literal('extend-review-budget'),
            additionalReviews: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 251})),
            reason: McpInput.requiredString('Reason for review-budget increase'),
            userAuthority: McpInput.requiredString(
              'Caller-provided human authority; actor identity is not independently authenticated',
            ),
          }),
        ]).pipe(Schema.toTaggedUnion('command')),
      },
    },
    Effect.fn('mcp_server.workflowTaskControl')(function* ({runId, callerCwd, taskRef, control}) {
      const request =
        control.command === 'begin'
          ? {command: control.command, runId, callerCwd, taskRef}
          : control.command === 'resume'
            ? {command: control.command, runId, callerCwd, taskRef, reason: control.reason}
            : control.command === 'reconcile'
              ? {
                  command: control.command,
                  runId,
                  callerCwd,
                  taskRef,
                  reason: control.reason,
                  ...(control.bindings === undefined ? {} : {bindings: control.bindings}),
                }
              : {
                  command: control.command,
                  runId,
                  callerCwd,
                  taskRef,
                  additionalReviews: control.additionalReviews,
                  reason: control.reason,
                  userAuthority: control.userAuthority,
                };
      const result = yield* runNativeTaskAction(config, request);
      return {content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_snapshot',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Record a source snapshot, supersede only the latest unreviewed snapshot, or requalify an exact reviewed predecessor after an approved base-branch transition. Requalification retains history and requires a new full review.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        snapshot: Schema.Union([
          Schema.Struct({
            command: Schema.Literal('record'),
            workRef: McpInput.requiredString('Opaque work reference returned by workflow_task_work'),
            reason: McpInput.string('Concrete reason for another source iteration'),
          }),
          Schema.Struct({
            command: Schema.Literal('supersede-unreviewed'),
            snapshotRef: McpInput.requiredString('Exact immutable reference for the unreviewed source snapshot'),
            reason: McpInput.requiredString('Why corrected source supersedes the unreviewed snapshot'),
          }),
          Schema.Struct({
            command: Schema.Literal('requalify-base'),
            snapshotRef: McpInput.requiredString('Exact reviewed predecessor reference from the current task view'),
            reason: McpInput.requiredString('Why the reviewed source is being requalified on the approved new base'),
            userAuthority: McpInput.requiredString(
              'Caller-provided human authority statement for this base change; actor identity is not independently authenticated',
            ),
          }),
        ]).pipe(Schema.toTaggedUnion('command')),
      },
    },
    Effect.fn('mcp_server.workflowTaskSnapshot')(function* ({runId, callerCwd, snapshot}) {
      const request =
        snapshot.command === 'record'
          ? {
              command: 'record-snapshot',
              runId,
              callerCwd,
              workRef: snapshot.workRef,
              ...(snapshot.reason === undefined ? {} : {reason: snapshot.reason}),
            }
          : snapshot.command === 'supersede-unreviewed'
            ? {
                command: 'supersede-unreviewed-snapshot',
                runId,
                callerCwd,
                snapshotRef: snapshot.snapshotRef,
                reason: snapshot.reason,
              }
            : {
                command: 'requalify-base-snapshot',
                runId,
                callerCwd,
                snapshotRef: snapshot.snapshotRef,
                reason: snapshot.reason,
                userAuthority: snapshot.userAuthority,
              };
      const result = yield* runNativeTaskAction(config, request);
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
        taskRef: McpInput.string('Current blocked review-recovery task reference; provide with userAuthority'),
        userAuthority: McpInput.string('Actual human authority for one corrected attempt; provide with taskRef'),
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
      taskRef,
      userAuthority,
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
        ...(taskRef === undefined ? {} : {taskRef}),
        ...(userAuthority === undefined ? {} : {userAuthority}),
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
    'workflow_task_deliver',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Record canonical local or commit delivery for the current validated phase, or verify PR delivery. Choose the operation matching the approved plan; PR receipts require the supplied typed PR and publication evidence and may return a watch card.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        delivery: Schema.Union([
          Schema.Struct({
            command: Schema.Literal('local'),
            validationRef: McpInput.requiredString('Opaque current validation reference'),
          }),
          Schema.Struct({
            command: Schema.Literal('commit'),
            validationRef: McpInput.requiredString('Opaque current validation reference'),
            commitEvidence: McpInput.requiredString('Commit evidence to retain with the canonical receipt').check(
              Schema.isMaxLength(2048),
            ),
          }),
          Schema.Struct({
            command: Schema.Literal('pr'),
            validationRef: McpInput.requiredString('Opaque current validation reference'),
            ...NativeTaskPrDeliveryFieldsSchema.fields,
          }),
        ]).pipe(Schema.toTaggedUnion('command')),
      },
    },
    Effect.fn('mcp_server.workflowTaskDeliver')(function* ({runId, callerCwd, delivery}) {
      const request =
        delivery.command === 'local'
          ? {command: 'deliver-local', runId, callerCwd, validationRef: delivery.validationRef}
          : delivery.command === 'commit'
            ? {
                command: 'deliver-commit',
                runId,
                callerCwd,
                validationRef: delivery.validationRef,
                commitEvidence: delivery.commitEvidence,
              }
            : {
                command: 'deliver-pr',
                runId,
                callerCwd,
                validationRef: delivery.validationRef,
                commitEvidence: delivery.commitEvidence,
                pr: delivery.pr,
                publication: delivery.publication,
              };
      const result = yield* runNativeTaskAction(config, request);
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_watch_pr',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description:
        'Operate the exact current task PR watch, route notices, persist dispositions before ACK, and complete delivery from readback.',
      inputSchema: {
        runId: McpInput.requiredString('Native run'),
        callerCwd: McpInput.requiredString('Bound checkout'),
        validationRef: McpInput.string('Current validation reference; omit only for provisional inspect or stop'),
        deliveryRef: McpInput.string('Opaque open PR delivery reference; omit only for provisional inspect or stop'),
        ...NativeTaskPrWatchFieldsSchema.fields,
      },
    },
    Effect.fn('mcp_server.workflowTaskWatchPr')(function* ({runId, callerCwd, validationRef, deliveryRef, ...watch}) {
      const result = yield* runNativeTaskAction(config, {
        command: 'watch-pr',
        runId,
        callerCwd,
        ...(validationRef === undefined ? {} : {validationRef}),
        ...(deliveryRef === undefined ? {} : {deliveryRef}),
        ...watch,
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_finish',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Finish an eligible completed cycle; PR delivery requires a merged, source-complete terminal watch.',
      inputSchema: {
        runId: McpInput.requiredString('Existing native workflow run identifier'),
        callerCwd: McpInput.requiredString('Absolute checkout path bound to this workflow run'),
        proposal: Schema.optionalKey(NativeTaskCloseoutProposalSchema),
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
