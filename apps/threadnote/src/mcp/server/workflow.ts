import {runNativeTaskAuthoring} from '../../workflow_automation/task_authoring.js';
import {Effect, Schema, Struct} from 'effect';
import {McpInput} from '../../effect/ai/mcp.js';
import {readNativeTaskView} from '../../workflow_automation/task.js';
import {
  NativeTaskPrDeliveryFieldsSchema,
  NativeTaskSupplementalAttachFieldsSchema,
  NativeTaskInvalidTailFieldsSchema,
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
        'Business-JSON specs/plans: start/save/read full content, record caller responses/independent reviews, admit approved local/commit/PR plans; share via current authoringRef and writable team. Caller identity is asserted, unauthenticated; reads do not mutate.',
      inputSchema: {
        command: Schema.Literals(['start', 'read', 'save', 'decide', 'admit', 'share', 'job']),
        callerCwd: McpInput.requiredString('Absolute original checkout'),
        featureName: McpInput.string('Start feature name'),
        kind: Schema.optionalKey(Schema.Literals(['spec', 'plan'])),
        contentFile: McpInput.string('Business JSON file; omit format/id/project/source/spec/compactOrigin'),
        saveMode: Schema.optionalKey(Schema.Literal('background')),
        installationTarget: McpInput.string('Required for start; installed target for authoring job resume'),
        graphProject: McpInput.string('New task graph project'),
        authoringRef: McpInput.string('Current authoring ref'),
        team: McpInput.string('Writable team'),
        jobRef: McpInput.string('Opaque accepted authoring ref'),
        operation: Schema.optionalKey(Schema.Literals(['status', 'result', 'cancel', 'resume'])),
        specRef: McpInput.string('Approved spec ref for new plan'),
        detail: Schema.optionalKey(Schema.Literals(['summary', 'document'])),
        userDecision: Schema.optionalKey(Schema.Literals(['approve', 'reject', 'defer'])),
        userResponse: McpInput.string('Actual full-document response'),
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
        'Start/resume bounded business intent after verifying installed workflow resources; runtime owns native run metadata.',
      inputSchema: {
        callerCwd: McpInput.requiredString('Absolute checkout path for this task'),
        featureName: McpInput.string('Stable compact-task name'),
        installationTarget: McpInput.requiredString('Installed host target; verifies current bundle on start/resume'),
        taskRef: McpInput.string('Prior start task ref'),
        sharedPlanRef: McpInput.string('Verified portable plan ref'),
        graphProject: McpInput.string('New run graph project'),
        intent: Schema.optionalKey(NativeCompactIntentSchema),
        delivery: Schema.optionalKey(Schema.Literals(['local', 'commit', 'pr'])),
        bindings: Schema.optionalKey(
          Schema.Record(Schema.String, Schema.Struct({branch: Schema.String, baseBranch: Schema.String})),
        ),
        userResponse: McpInput.string('Actual shared-plan execution authority'),
        review: Schema.optionalKey(
          Schema.Struct({outcome: Schema.Literal('accepted'), blockingIssueCount: Schema.Literal(0)}),
        ),
      },
    },
    Effect.fn('mcp_server.workflowTaskStart')(function* (input) {
      const {
        callerCwd,
        featureName,
        installationTarget,
        taskRef,
        graphProject,
        intent,
        sharedPlanRef,
        delivery,
        bindings,
        userResponse,
        review,
      } = input;
      const result = yield* runNativeTaskStart(config, {
        callerCwd,
        ...(installationTarget === undefined ? {} : {installationTarget}),
        ...(featureName === undefined ? {} : {featureName}),
        ...(taskRef === undefined ? {} : {taskRef}),
        ...(graphProject === undefined ? {} : {graphProject}),
        ...(intent === undefined ? {} : {intent}),
        ...(sharedPlanRef === undefined ? {} : {sharedPlanRef}),
        ...(delivery === undefined ? {} : {delivery}),
        ...(bindings === undefined ? {} : {bindings}),
        ...(userResponse === undefined ? {} : {userResponse}),
        ...(review === undefined ? {} : {review}),
      });
      const text = JSON.stringify(result);
      return {content: [{type: 'text' as const, text}], structuredContent: result};
    }),
  );
  server.registerTool(
    'workflow_task_compact_start',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Bounded compact draft; exact approval packet.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
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
      description: 'Expand native plan on the same compact-origin root.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
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
      description: 'Record actual exact-intent user response; admit/reconcile same run.',
      inputSchema: {
        runId: McpInput.requiredString('Native run ID'),
        callerCwd: McpInput.requiredString('Absolute bound checkout'),
        presentedIntentHash: McpInput.requiredString('Complete approval packet intent hash'),
        userResponse: McpInput.string('Actual displayed exact-intent response'),
        userDecision: Schema.optionalKey(Schema.Literals(['approve', 'reject', 'defer'])),
        baseBranch: McpInput.string('Exact base branch for a new local cycle'),
        reconcileReason: McpInput.string('Reconciliation reason'),
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
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString('Absolute path'),
        role: McpInput.string('Role'),
        cursor: McpInput.string('Cursor'),
        phaseId: McpInput.string('Listed historical phase ID for its PR watch'),
        detail: Schema.optionalKey(Schema.Literals(['summary', 'packet'])),
        outputKey: McpInput.string('Listed closeout body key; detail=packet'),
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
          : result.next.action === 'validate'
            ? {
                tool: 'workflow_task_record_validation',
                guidance: 'Record passed checks and acceptance for the reviewed snapshotRef.',
              }
            : result.next.action === 'review'
              ? {
                  tool: 'workflow_task_record_review',
                  guidance: 'Record the independent review for this snapshotRef.',
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
      description: 'Prepare source-checked implementation packet for current native phase.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
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
        'Phases: begin eligible; reopen validated/published after failure; resume blocked after accepted dependencies; reconcile verified ready approved plan with bindings; extend exhausted review budget with caller authority. Identity is unauthenticated.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
        taskRef: McpInput.requiredString(),
        control: Schema.Union([
          Schema.Struct({command: Schema.Literal('begin')}),
          Schema.Struct({
            command: Schema.Literal('resume'),
            reason: McpInput.requiredString(),
          }),
          Schema.Struct({
            command: Schema.Literal('reopen'),
            phaseId: McpInput.requiredString(),
            reason: McpInput.requiredString(),
          }),
          Schema.Struct({
            command: Schema.Literal('reconcile'),
            reason: McpInput.requiredString(),
            bindings: Schema.optionalKey(
              Schema.Record(Schema.String, Schema.Struct({branch: Schema.String, baseBranch: Schema.String})),
            ),
          }),
          Schema.Struct({
            command: Schema.Literal('extend-review-budget'),
            additionalReviews: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 251})),
            reason: McpInput.requiredString(),
            userAuthority: McpInput.requiredString(
              'Caller-provided human authority; actor identity is not authenticated',
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
            : control.command === 'reopen'
              ? {command: control.command, runId, callerCwd, taskRef, phaseId: control.phaseId, reason: control.reason}
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
        'Current opaque refs; retain history. Supersede latest unreviewed only; recover authorized rebase; qualify reviewed base or prepared normal invalid-tail merge. Fresh full review/validation; caller authority unverified.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
        snapshot: Schema.Union([
          Schema.Struct({
            command: Schema.Literal('record'),
            workRef: McpInput.requiredString(),
            reason: McpInput.string(),
          }),
          Schema.Struct({
            command: Schema.Literal('supersede-unreviewed'),
            snapshotRef: McpInput.requiredString(),
            reason: McpInput.requiredString(),
          }),
          Schema.Struct({
            command: Schema.Literals(['recover-unreviewed-rebase', 'requalify-base', 'integrate-same-label-base']),
            snapshotRef: McpInput.requiredString(),
            reason: McpInput.requiredString(),
            userAuthority: McpInput.requiredString(),
          }),
          Schema.Struct({
            command: Schema.Literal('requalify-invalid-tail'),
            ...NativeTaskInvalidTailFieldsSchema.fields,
          }),
        ]),
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
          : snapshot.command === 'recover-unreviewed-rebase'
            ? {
                command: 'recover-unreviewed-rebase-snapshot',
                runId,
                callerCwd,
                snapshotRef: snapshot.snapshotRef,
                reason: snapshot.reason,
                userAuthority: snapshot.userAuthority,
              }
            : snapshot.command === 'supersede-unreviewed'
              ? {
                  command: 'supersede-unreviewed-snapshot',
                  runId,
                  callerCwd,
                  snapshotRef: snapshot.snapshotRef,
                  reason: snapshot.reason,
                }
              : snapshot.command === 'requalify-invalid-tail'
                ? {...snapshot, runId, callerCwd}
                : {
                    command:
                      snapshot.command === 'integrate-same-label-base'
                        ? 'integrate-same-label-base-snapshot'
                        : 'requalify-base-snapshot',
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
      description: 'Record an independent review for a snapshot.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString('Absolute bound checkout'),
        snapshotRef: McpInput.requiredString('Snapshot ref'),
        taskRef: McpInput.string('Blocked recovery taskRef'),
        userAuthority: McpInput.string('Human authority for blocked retry'),
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
      description: 'Record passed checks/acceptance for the reviewed task snapshot.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
        snapshotRef: McpInput.requiredString('Reviewed snapshot ref'),
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
        'Record approved local/commit/PR delivery with exact review/validation, actual userAuthority and separate publication evidence; open PRs need a watch. Supplemental attaches an existing authorized PR to unchanged completed local proof, preserving original delivery.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
        delivery: Schema.Union([
          Schema.Struct({
            command: Schema.Literal('local'),
            validationRef: McpInput.requiredString('Current validation ref'),
          }),
          Schema.Struct({
            command: Schema.Literal('commit'),
            validationRef: McpInput.requiredString('Current validation ref'),
            commitEvidence: McpInput.requiredString('Canonical commit evidence').check(Schema.isMaxLength(2048)),
          }),
          Schema.Struct({
            command: Schema.Literal('pr'),
            validationRef: McpInput.requiredString('Current validation ref'),
            ...NativeTaskPrDeliveryFieldsSchema.fields,
          }),
          Schema.Struct({command: Schema.Literal('supplemental'), ...NativeTaskSupplementalAttachFieldsSchema.fields}),
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
            : delivery.command === 'supplemental'
              ? {...delivery, command: 'supplemental-publication', operation: 'attach', runId, callerCwd}
              : {
                  command: 'deliver-pr',
                  runId,
                  callerCwd,
                  validationRef: delivery.validationRef,
                  commitEvidence: delivery.commitEvidence,
                  pr: delivery.pr,
                  publication: delivery.publication,
                  ...(delivery.userAuthority === undefined ? {} : {userAuthority: delivery.userAuthority}),
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
        'Monitor standalone or canonical/candidate/supplemental PR watches with distinct proof. Standalone grants no delivery/merge authority. Relay noticeRefs only; persist dispositions before ACK with current refs.',
      inputSchema: {
        runId: McpInput.string('Omit for standalone'),
        prUrl: McpInput.string(),
        watchRef: McpInput.string(),
        callerCwd: McpInput.requiredString(),
        validationRef: McpInput.string(),
        deliveryRef: McpInput.string('PR delivery ref; provisional inspect/stop may omit'),
        ...Struct.omit(NativeTaskPrWatchFieldsSchema.fields, ['noticeRef']),
        noticeRef: McpInput.string('Relay only; retain event disposition; ACK current refs.'),
        snapshotRef: McpInput.string('Candidate snapshot; diagnostics only'),
        candidateWatchRef: McpInput.string(),
        supplementalRef: McpInput.string('Completed-local publication owner'),
        pr: McpInput.string('Candidate PR URL'),
      },
    },
    Effect.fn('mcp_server.workflowTaskWatchPr')(function* ({runId, callerCwd, validationRef, deliveryRef, ...watch}) {
      const result = yield* runNativeTaskAction(config, {
        command: 'watch-pr',
        ...(runId === undefined ? {} : {runId}),
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
      description: 'Finish completed eligible cycle; PR needs merged, source-complete terminal watch.',
      inputSchema: {
        runId: McpInput.requiredString(),
        callerCwd: McpInput.requiredString(),
        proposal: Schema.optionalKey(NativeTaskCloseoutProposalSchema),
        prepareRef: McpInput.string('Prior opaque prepare ref'),
        finishRef: McpInput.string('Prior opaque finish ref'),
        resume: McpInput.boolean('Resume same opaque canonical closeout ref'),
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
