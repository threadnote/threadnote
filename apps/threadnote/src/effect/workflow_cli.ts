import {Array as EffectArray, Effect, Schema} from 'effect';
import {Command, Flag} from 'effect/cli';
import {withDefaultActionSubcommand} from './cli/help.js';
import {
  argument,
  boolean,
  defaultChoice,
  describeFlag,
  integerFlag,
  optional,
  optionalChoice,
  optionalString,
  repeatedString,
  requiredChoice,
  requiredString,
} from './cli/flags.js';
import {CONTEXT_BRIEF_CWD_OPTION, type runContextBrief} from '../context_brief/commands.js';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {runCompact} from '../memory/commands.js';
import type {runRecallFeedback} from '../recall/feedback_commands.js';
import type {runContextHealth} from '../memory/context/health_commands.js';
import type {runContextMaintainCommand} from '../memory/context/maintenance.js';
import {CONTEXT_HEALTH_FINDING_CATEGORIES, CONTEXT_HEALTH_MEMORY_KINDS} from '../memory/context/health_selector.js';
import type {runContextHealthAggregate, runContextHealthSchedule} from '../memory/context/health_aggregate_commands.js';
import type {
  runContextHealthRepairApply,
  runContextHealthRepairPreview,
} from '../memory/context/health_repair_commands.js';
import type {runContextCheck} from '../context_check/commands.js';
import type {
  runValueReport,
  runValueReportDelete,
  runValueReportExport,
  runValueReportRetention,
} from '../value_report/commands.js';
import type {runProcedurePublish, runProcedureStatus, runProcedureVerify} from '../procedure/commands.js';
import type {runPilotCommand} from '../value_report/pilot/commands.js';
import {
  CONTEXT_BRIEF_DETAILS,
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MODES,
} from '@threadnote/context/types';

export function makeCompactCommand<E, R>(
  handler: (options: Parameters<typeof runCompact>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'compact',
    {
      apply: boolean('apply', 'Apply the compact plan; without this, prints a dry run'),
      dryRun: boolean('dry-run', 'Print the compact plan without changing anything'),
      kind: optionalChoice('kind', ['durable', 'handoff', 'incident'], 'Optional memory kind filter'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      topic: optionalString('topic', 'Stable topic name to inspect'),
    },
    handler,
  ).pipe(Command.withDescription('Plan or apply scoped memory hygiene for active personal memories'));
}

export function makeNativeTaskViewCommand<E, R>(
  handler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly role?: string;
    readonly cursor?: string;
    readonly phaseId?: string;
    readonly detail?: 'summary' | 'packet';
    readonly outputKey?: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
) {
  return Command.make(
    'task-view',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path for this task context'),
      role: optionalChoice('role', ['implementation', 'review', 'delivery'], 'Optional task role'),
      cursor: optionalString('cursor', 'Opaque continuation returned by the previous task-view page'),
      phaseId: optionalString('phase-id', 'Select an active historical PR watch from task-view history'),
      detail: optionalChoice(
        'detail',
        ['summary', 'packet'],
        'Read the bounded summary or full current approval/review packet',
      ),
      outputKey: optionalString('output-key', 'Listed verified closeout output key; requires detail=packet'),
    },
    handler,
  ).pipe(Command.withDescription('Read the next task or select a discovered active historical PR watch'));
}

export function makeNativeTaskPrDeliveryCommand<E, R>(
  handler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly validationRef: string;
    readonly commitEvidence: string;
    readonly pr: unknown;
    readonly publication: unknown;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
) {
  return Command.make(
    'deliver-pr',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      validationRef: requiredString('validation-ref', 'Opaque current validation reference from the task flow'),
      commitEvidence: requiredString('commit-evidence', 'Actual verified PR commit evidence'),
      pr: requiredString('pr', 'Physical PR metadata as JSON'),
      publication: requiredString('publication', 'Actual publication authority input as JSON'),
    },
    options =>
      Effect.try({
        try: () => ({pr: JSON.parse(options.pr) as unknown, publication: JSON.parse(options.publication) as unknown}),
        catch: () =>
          WorkflowAutomationError.make({
            code: 'invalid-request',
            message: 'PR and publication inputs must be valid JSON.',
          }),
      }).pipe(Effect.flatMap(value => handler({...options, ...value}))),
  ).pipe(
    Command.withDescription('Verify a current approved PR delivery and return the next watch card when it is open'),
  );
}

export function makeNativeTaskPrWatchCommand<E, R>(
  handler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly validationRef?: string;
    readonly deliveryRef?: string;
    readonly phaseId?: string;
    readonly operation:
      'start' | 'inspect' | 'relay' | 'disposition' | 'ack' | 'work' | 'work-disposition' | 'stop' | 'complete';
    readonly host?: 'codex' | 'cursor-cli';
    readonly executable?: string;
    readonly hostReference?: string;
    readonly workspace?: string;
    readonly takeover?: boolean;
    readonly recoverWakeup?: boolean;
    readonly noticeRef?: string;
    readonly watchDeliveryRef?: string;
    readonly dispositionEventRefs: readonly string[];
    readonly dispositionStatuses: readonly string[];
    readonly dispositionReasons: readonly string[];
    readonly dispositionEvidence: readonly string[];
    readonly wakeup?: unknown;
    readonly dispositions?: readonly unknown[];
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
) {
  return Command.make(
    'watch-pr',
    {
      runId: requiredString('run-id', 'Native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Bound checkout path'),
      validationRef: optionalString('validation-ref', 'Current opaque validation reference'),
      deliveryRef: optionalString('delivery-ref', 'Opaque open PR delivery reference'),
      phaseId: optionalString('phase-id', 'Current phase for provisional inspect or stop'),
      operation: requiredChoice(
        'operation',
        ['start', 'inspect', 'relay', 'disposition', 'ack', 'work', 'work-disposition', 'stop', 'complete'],
        'Task-bound watch operation',
      ),
      host: optionalChoice('host', ['codex', 'cursor-cli'], 'Registered wakeup host'),
      executable: optionalString('host-executable', 'Absolute registered host executable'),
      hostReference: optionalString('host-reference', 'Codex thread ID or Cursor session ID'),
      workspace: optionalString('workspace', 'Cursor workspace path'),
      noticeRef: optionalString('notice-ref', 'Opaque notice route returned by the current watch'),
      watchDeliveryRef: optionalString('watch-delivery-ref', 'Opaque current event delivery returned by relay'),
      takeover: boolean('takeover', 'Explicitly take over an expired task watch consumer'),
      recoverWakeup: boolean('recover-wakeup', 'Explicitly recover the owned ambiguous host wakeup'),
      dispositionEventRefs: repeatedString(
        'disposition-event-ref',
        'Opaque event reference returned by the current delivery',
      ),
      dispositionStatuses: repeatedString('disposition-status', 'Disposition status in matching order'),
      dispositionReasons: repeatedString('disposition-reason', 'Disposition reason in matching order'),
      dispositionEvidence: repeatedString('disposition-evidence', 'Disposition evidence in matching order'),
    },
    options => {
      const lengths = [
        options.dispositionEventRefs.length,
        options.dispositionStatuses.length,
        options.dispositionReasons.length,
        options.dispositionEvidence.length,
      ];
      if (EffectArray.some(lengths, value => value !== lengths[0]))
        return Effect.fail(
          WorkflowAutomationError.make({
            code: 'invalid-request',
            message: 'Disposition fields must have the same number of values.',
          }),
        );
      const dispositionStatuses: ('open' | 'blocked' | 'resolved' | 'ignored')[] = [];
      for (const status of options.dispositionStatuses) {
        if (status !== 'open' && status !== 'blocked' && status !== 'resolved' && status !== 'ignored')
          return Effect.fail(
            WorkflowAutomationError.make({
              code: 'invalid-request',
              message: 'Disposition status must be open, blocked, resolved, or ignored.',
            }),
          );
        dispositionStatuses.push(status);
      }
      const dispositions: {
        eventRef: string;
        status: 'open' | 'blocked' | 'resolved' | 'ignored';
        reason: string;
        evidence: string;
      }[] = [];
      for (let index = 0; index < options.dispositionEventRefs.length; index++) {
        const eventRef = options.dispositionEventRefs[index];
        const status = dispositionStatuses[index];
        const reason = options.dispositionReasons[index];
        const evidence = options.dispositionEvidence[index];
        if (eventRef === undefined || status === undefined || reason === undefined || evidence === undefined)
          return Effect.fail(
            WorkflowAutomationError.make({
              code: 'invalid-request',
              message: 'Disposition fields must align by position.',
            }),
          );
        dispositions.push({eventRef, status, reason, evidence});
      }
      return handler({
        ...options,
        ...(options.host && options.executable && options.hostReference
          ? {
              wakeup:
                options.host === 'codex'
                  ? {host: 'codex' as const, executable: options.executable, threadId: options.hostReference}
                  : {
                      host: 'cursor-cli' as const,
                      executable: options.executable,
                      sessionId: options.hostReference,
                      workspace: options.workspace ?? '',
                      exclusiveSession: true as const,
                    },
            }
          : {}),
        ...(options.takeover ? {takeover: true} : {}),
        ...(options.recoverWakeup ? {recoverWakeup: true} : {}),
        dispositions,
      });
    },
  ).pipe(Command.withDescription('Run a task-bound PR watch step through native watch state and receipts'));
}

export function makeNativeTaskStartCommand<E, R>(
  handler: (options: {
    readonly callerCwd: string;
    readonly featureName: string;
    readonly installationTarget: string;
    readonly graphProject?: string;
    readonly taskRef?: string;
    readonly title: string;
    readonly currentBehavior: string;
    readonly desiredChange: string;
    readonly affectedPaths: readonly string[];
    readonly acceptanceCriterion: string;
    readonly verification: string;
    readonly eligibilityRationale: string;
    readonly eligibility: 'eligible' | 'needs-planning';
    readonly missingDecision?: string;
    readonly evidenceRefs: readonly string[];
    readonly reviewRequired: boolean;
    readonly reviewReason: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
) {
  return Command.make(
    'task-start',
    {
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path for this task'),
      featureName: requiredString('feature-name', 'Stable feature name used to resume this task'),
      installationTarget: requiredString(
        'installation-target',
        'Installed Threadnote host target verified on start or resume',
      ),
      taskRef: optionalString('task-ref', 'Opaque task reference returned by a previous start'),
      graphProject: optionalString('graph-project', 'Configured graph project for a new native run'),
      title: requiredString('title', 'Task title'),
      currentBehavior: requiredString('current-behavior', 'Current behavior'),
      desiredChange: requiredString('desired-change', 'Desired behavior'),
      affectedPaths: repeatedString('affected-path', 'Repository-relative source path; repeat for each path'),
      acceptanceCriterion: requiredString('acceptance', 'Acceptance criterion'),
      verification: requiredString('verification', 'How the acceptance criterion will be verified'),
      eligibilityRationale: requiredString('eligibility-rationale', 'Human-authored bounded-fix eligibility rationale'),
      eligibility: requiredChoice('eligibility', ['eligible', 'needs-planning'], 'Semantic bounded-fix eligibility'),
      missingDecision: optionalString('missing-decision', 'Unresolved decision that requires expanded planning'),
      evidenceRefs: repeatedString('evidence-ref', 'Evidence URI for needs-planning; repeat as needed'),
      reviewRequired: boolean('review-required', 'Whether an independent authoring review is required'),
      reviewReason: requiredString('review-reason', 'Why review is or is not required'),
    },
    handler,
  ).pipe(Command.withDescription('Start or resume a bounded task from semantic intent'));
}

export function makeNativeTaskActionCommands<E, R>(
  workHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly packet: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  snapshotHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly workRef: string;
    readonly reason?: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  reviewHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly snapshotRef: string;
    readonly taskRef?: string;
    readonly userAuthority?: string;
    readonly report: unknown;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  validationHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly snapshotRef: string;
    readonly validation: unknown;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  deliveryHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly validationRef: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  finishHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly proposal?: unknown;
    readonly prepareRef?: string;
    readonly finishRef?: string;
    readonly resume?: boolean;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  compactStartHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly intent: unknown;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  compactExpandHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly document: unknown;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  compactConfirmHandler: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly presentedIntentHash: string;
    readonly userResponse?: string;
    readonly userDecision?: 'approve' | 'reject' | 'defer';
    readonly baseBranch?: string;
    readonly reconcileReason?: string;
    readonly bindings?: unknown;
    readonly review?: unknown;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  supersedeUnreviewedSnapshotHandler?: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly snapshotRef: string;
    readonly reason: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  lifecycleHandler?: (options: {
    readonly command: 'begin' | 'resume' | 'reconcile' | 'extend-review-budget';
    readonly runId: string;
    readonly callerCwd: string;
    readonly taskRef: string;
    readonly reason?: string;
    readonly bindings?: unknown;
    readonly additionalReviews?: number;
    readonly userAuthority?: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  baseRequalificationHandler?: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly snapshotRef: string;
    readonly reason: string;
    readonly userAuthority: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
  commitDeliveryHandler?: (options: {
    readonly runId: string;
    readonly callerCwd: string;
    readonly validationRef: string;
    readonly commitEvidence: string;
  }) => Effect.Effect<void, E | WorkflowAutomationError, R>,
) {
  const lifecycle = (options: Parameters<NonNullable<typeof lifecycleHandler>>[0]) =>
    lifecycleHandler
      ? lifecycleHandler(options)
      : Effect.fail(
          WorkflowAutomationError.make({code: 'unsupported-action', message: 'This task action is unavailable.'}),
        );
  const begin = Command.make(
    'begin',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      taskRef: requiredString('task-ref', 'Opaque current phase task reference from workflow task view'),
    },
    options => lifecycle({command: 'begin', ...options}),
  ).pipe(Command.withDescription('Begin the phase on the current eligible task card'));
  const resume = Command.make(
    'resume',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      taskRef: requiredString('task-ref', 'Opaque current blocked phase task reference'),
      reason: requiredString('reason', 'Concrete recovery reason for resuming the blocked phase'),
    },
    options => lifecycle({command: 'resume', ...options}),
  ).pipe(Command.withDescription('Resume the current blocked phase after its dependencies are accepted'));
  const reconcile = Command.make(
    'reconcile',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      taskRef: requiredString('task-ref', 'Opaque current approved-plan reconciliation reference'),
      reason: requiredString('reason', 'Concrete reason for reconciling the approved plan'),
      bindings: optionalString(
        'bindings',
        'Bindings for new phases or existing phase bases (branch stays fixed), as JSON',
      ),
    },
    options => {
      const {bindings: bindingsJson, ...request} = options;
      return (
        bindingsJson === undefined
          ? Effect.void
          : Effect.try({
              try: () => JSON.parse(bindingsJson) as unknown,
              catch: () =>
                WorkflowAutomationError.make({code: 'invalid-request', message: 'Bindings must be valid JSON.'}),
            })
      ).pipe(
        Effect.flatMap(bindings =>
          lifecycle({command: 'reconcile', ...request, ...(bindingsJson === undefined ? {} : {bindings})}),
        ),
      );
    },
  ).pipe(Command.withDescription('Reconcile the current ready, approved plan on the same run'));
  const extendReviewBudget = Command.make(
    'extend-review-budget',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      taskRef: requiredString('task-ref', 'Opaque current exhausted-review task reference'),
      additionalReviews: integerFlag('additional-reviews'),
      reason: requiredString('reason', 'Concrete reason to add review attempts'),
      userAuthority: requiredString(
        'user-authority',
        'Caller-provided human authority statement; actor identity is not independently authenticated',
      ),
    },
    options => lifecycle({command: 'extend-review-budget', ...options}),
  ).pipe(Command.withDescription('Extend an exhausted phase review budget with explicit authority'));
  const work = Command.make(
    'work',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      model: requiredString('model', 'Selected background worker model'),
      effort: requiredString('effort', 'Selected worker effort'),
      selection: requiredChoice(
        'selection',
        ['least-sufficient', 'risk', 'user-override', 'escalation'],
        'Capacity selection rationale',
      ),
      risk: requiredChoice('risk', ['settled', 'unresolved', 'high'], 'Implementation risk assessment'),
      reason: requiredString('reason', 'Concrete capacity selection reason'),
      catalogEvidence: requiredString('catalog-evidence', 'Available model/effort capability evidence'),
      trigger: optionalString('trigger', 'Observed trigger for a risk selection'),
      escalationCause: optionalChoice(
        'escalation-cause',
        ['reasoning-limit', 'new-complexity', 'user-request'],
        'Observed reason for escalation',
      ),
      userAuthority: optionalString(
        'user-authority',
        'Caller-provided human authority statement; actor identity is not independently authenticated',
      ),
      nearestSupportedEffort: optionalString('nearest-supported-effort', 'Nearest available lower effort'),
      anchorPaths: repeatedString('anchor-path', 'Repository-relative source anchor path', 128),
      anchorPatterns: repeatedString(
        'anchor-pattern',
        'Literal source pattern for each anchor path, in matching order',
        128,
      ),
      ownership: repeatedString('ownership', 'Repository-relative path owned by this worker', 128),
      checks: repeatedString('check', 'Required focused check', 32),
      budgetBytes: optional(integerFlag('budget-bytes')),
      detailRefs: repeatedString('detail-ref', 'Optional bounded detail reference', 16),
    },
    options => {
      if (options.anchorPaths.length !== options.anchorPatterns.length)
        return Effect.fail(
          WorkflowAutomationError.make({
            code: 'invalid-request',
            message: 'Repeat --anchor-path and --anchor-pattern the same number of times.',
          }),
        );
      return workHandler({
        runId: options.runId,
        callerCwd: options.callerCwd,
        packet: {
          capacity: {
            model: options.model,
            effort: options.effort,
            selection: options.selection,
            risk: options.risk,
            reason: options.reason,
            catalogEvidence: options.catalogEvidence,
            ...(options.trigger === undefined ? {} : {trigger: options.trigger}),
            ...(options.escalationCause === undefined ? {} : {escalationCause: options.escalationCause}),
            ...(options.userAuthority === undefined ? {} : {userAuthority: options.userAuthority}),
            ...(options.nearestSupportedEffort === undefined
              ? {}
              : {nearestSupportedEffort: options.nearestSupportedEffort}),
          },
          anchors: EffectArray.map(EffectArray.zip(options.anchorPaths, options.anchorPatterns), ([path, pattern]) => ({
            path,
            pattern,
          })),
          ownership: options.ownership,
          checks: options.checks,
          ...(options.budgetBytes === undefined ? {} : {budgetBytes: options.budgetBytes}),
          ...(options.detailRefs.length === 0 ? {} : {detailRefs: options.detailRefs}),
        },
      });
    },
  ).pipe(Command.withDescription('Prepare a source-checked implementation packet for the current native phase'));
  const recordSnapshot = Command.make(
    'record-snapshot',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      workRef: requiredString('work-ref', 'Opaque reference returned by workflow-automation task-action work'),
      reason: optionalString('reason', 'Concrete reason for another source iteration'),
    },
    snapshotHandler,
  ).pipe(Command.withDescription('Record the current worker source for an admitted implementation packet'));
  const requalifyBaseSnapshot = Command.make(
    'requalify-base-snapshot',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      snapshotRef: requiredString('snapshot-ref', 'Exact reviewed predecessor reference from workflow task view'),
      reason: requiredString('reason', 'Why the reviewed source is being requalified on the approved new base'),
      userAuthority: requiredString(
        'user-authority',
        'Caller-provided human authority statement for this base change; actor identity is not independently authenticated',
      ),
    },
    options =>
      baseRequalificationHandler
        ? baseRequalificationHandler(options)
        : Effect.fail(
            WorkflowAutomationError.make({
              code: 'invalid-request',
              message: 'This task-action command has no base-requalification handler.',
            }),
          ),
  ).pipe(Command.withDescription('Requalify an exact reviewed predecessor against a newly approved base'));
  const supersedeUnreviewedSnapshot = Command.make(
    'supersede-unreviewed-snapshot',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      snapshotRef: requiredString('snapshot-ref', 'Exact immutable reference for the unreviewed source snapshot'),
      reason: requiredString('reason', 'Why corrected source supersedes the unreviewed snapshot'),
    },
    options =>
      supersedeUnreviewedSnapshotHandler
        ? supersedeUnreviewedSnapshotHandler(options)
        : Effect.fail(
            WorkflowAutomationError.make({
              code: 'invalid-request',
              message: 'This task-action command has no supersession handler.',
            }),
          ),
  ).pipe(Command.withDescription('Retain an unreviewed snapshot and require a full review of changed source'));
  const recordReview = Command.make(
    'record-review',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      snapshotRef: requiredString('snapshot-ref', 'Opaque snapshot reference returned by snapshot recording'),
      taskRef: optionalString(
        'task-ref',
        'Current blocked review-recovery task reference; provide with user-authority',
      ),
      userAuthority: optionalString(
        'user-authority',
        'Actual human authority for one corrected attempt; provide with task-ref',
      ),
      report: requiredString('report', 'Complete semantic review report as JSON, strictly schema-validated'),
    },
    options =>
      Effect.try({
        try: () => JSON.parse(options.report) as unknown,
        catch: () =>
          WorkflowAutomationError.make({
            code: 'invalid-request',
            message: 'The semantic review report must be valid JSON.',
          }),
      }).pipe(
        Effect.flatMap(report =>
          reviewHandler({
            runId: options.runId,
            callerCwd: options.callerCwd,
            snapshotRef: options.snapshotRef,
            ...(options.taskRef === undefined ? {} : {taskRef: options.taskRef}),
            ...(options.userAuthority === undefined ? {} : {userAuthority: options.userAuthority}),
            report,
          }),
        ),
      ),
  ).pipe(Command.withDescription('Record a complete independent review against an immutable snapshot'));
  const recordValidation = Command.make(
    'record-validation',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      snapshotRef: requiredString('snapshot-ref', 'Opaque snapshot reference returned by review recording'),
      validation: requiredString(
        'validation',
        'Passed check and acceptance evidence as JSON, strictly schema-validated',
      ),
    },
    options =>
      Effect.try({
        try: () => JSON.parse(options.validation) as unknown,
        catch: () =>
          WorkflowAutomationError.make({
            code: 'invalid-request',
            message: 'Validation evidence must be valid JSON.',
          }),
      }).pipe(Effect.flatMap(validation => validationHandler({...options, validation}))),
  ).pipe(Command.withDescription('Record passed checks and acceptance evidence for the reviewed snapshot'));
  const deliverLocal = Command.make(
    'deliver-local',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      validationRef: requiredString('validation-ref', 'Opaque validation reference returned by validation recording'),
    },
    deliveryHandler,
  ).pipe(Command.withDescription('Record the canonical local delivery receipt for a validated local phase'));
  const deliverCommit = Command.make(
    'deliver-commit',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      validationRef: requiredString('validation-ref', 'Opaque current validation reference from the task flow'),
      commitEvidence: requiredString('commit-evidence', 'Commit evidence to retain with the canonical receipt'),
    },
    options =>
      commitDeliveryHandler
        ? commitDeliveryHandler(options)
        : Effect.fail(
            WorkflowAutomationError.make({code: 'unsupported-action', message: 'This task action is unavailable.'}),
          ),
  ).pipe(Command.withDescription('Record the canonical commit delivery receipt for a validated commit phase'));
  const finish = Command.make(
    'finish',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      proposal: optionalString('proposal', 'Typed semantic closeout proposal as JSON, strictly schema-validated'),
      prepareRef: optionalString('prepare-ref', 'Opaque reference returned while closeout preparation is pending'),
      finishRef: optionalString('finish-ref', 'Opaque reference returned while verified finish is pending'),
      resume: boolean('resume', 'Explicitly continue a canonical closeout job using the same opaque reference'),
    },
    options => {
      const rawProposal = options.proposal;
      const proposal =
        rawProposal === undefined
          ? Effect.void
          : Effect.try({
              try: () => JSON.parse(rawProposal) as unknown,
              catch: () =>
                WorkflowAutomationError.make({
                  code: 'invalid-request',
                  message: 'The semantic closeout proposal must be valid JSON.',
                }),
            });
      return proposal.pipe(
        Effect.flatMap(value =>
          finishHandler({
            runId: options.runId,
            callerCwd: options.callerCwd,
            ...(value === undefined ? {} : {proposal: value}),
            ...(options.prepareRef === undefined ? {} : {prepareRef: options.prepareRef}),
            ...(options.finishRef === undefined ? {} : {finishRef: options.finishRef}),
            ...(options.resume ? {resume: true} : {}),
          }),
        ),
      );
    },
  ).pipe(
    Command.withDescription(
      'Finish an eligible completed cycle; PR delivery requires a merged, source-complete terminal watch',
    ),
  );
  const compactStart = Command.make(
    'compact-start',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      intent: requiredString(
        'intent',
        'Compact intent JSON with current behavior, desired change, scope, acceptance and eligibility',
      ),
    },
    options =>
      Effect.try({
        try: () => JSON.parse(options.intent) as unknown,
        catch: () =>
          WorkflowAutomationError.make({code: 'invalid-request', message: 'Compact intent must be valid JSON.'}),
      }).pipe(Effect.flatMap(intent => compactStartHandler({...options, intent}))),
  ).pipe(Command.withDescription('Save a compact bounded intent as a draft and return its exact approval packet'));
  const compactExpand = Command.make(
    'compact-expand',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      document: requiredString(
        'document',
        'Complete expanded native plan JSON; compact origin is retained by the runtime',
      ),
    },
    options =>
      Effect.try({
        try: () => JSON.parse(options.document) as unknown,
        catch: () =>
          WorkflowAutomationError.make({code: 'invalid-request', message: 'Expanded plan must be valid JSON.'}),
      }).pipe(Effect.flatMap(document => compactExpandHandler({...options, document}))),
  ).pipe(Command.withDescription('Prepare a material expansion on the same compact-origin authoring root'));
  const compactConfirm = Command.make(
    'compact-confirm',
    {
      runId: requiredString('run-id', 'Existing native workflow run identifier'),
      callerCwd: requiredString('caller-cwd', 'Absolute checkout path bound to this workflow run'),
      presentedIntentHash: requiredString('intent-hash', 'Exact intent hash from the complete approval packet'),
      userResponse: optionalString('user-response', 'Caller-provided response to the displayed exact-intent packet'),
      userDecision: optionalChoice('user-decision', ['approve', 'reject', 'defer'], 'Caller-provided user decision'),
      baseBranch: optionalString('base-branch', 'Exact base branch for a new local cycle'),
      reconcileReason: optionalString('reconcile-reason', 'Concrete reason for reconciling an existing cycle'),
      bindings: optionalString('bindings', 'Exact phase-to-branch/base-branch map as JSON'),
      review: optionalString('review', 'Accepted exact-document independent review as JSON, when required'),
    },
    options =>
      Effect.all({
        bindings:
          options.bindings === undefined
            ? Effect.void
            : Effect.try({
                try: () => JSON.parse(options.bindings!) as unknown,
                catch: () =>
                  WorkflowAutomationError.make({
                    code: 'invalid-request',
                    message: 'Branch bindings must be valid JSON.',
                  }),
              }),
        review:
          options.review === undefined
            ? Effect.void
            : Effect.try({
                try: () => JSON.parse(options.review!) as unknown,
                catch: () =>
                  WorkflowAutomationError.make({
                    code: 'invalid-request',
                    message: 'Review evidence must be valid JSON.',
                  }),
              }),
      }).pipe(Effect.flatMap(parsed => compactConfirmHandler({...options, ...parsed}))),
  ).pipe(
    Command.withDescription(
      'Record a caller-provided exact-intent response, then admit or reconcile the same canonical run; actor identity is not independently authenticated',
    ),
  );
  return Command.make('task-action', {}).pipe(
    Command.withSubcommands([
      work,
      begin,
      resume,
      reconcile,
      extendReviewBudget,
      recordSnapshot,
      requalifyBaseSnapshot,
      supersedeUnreviewedSnapshot,
      recordReview,
      recordValidation,
      deliverLocal,
      deliverCommit,
      finish,
      compactStart,
      compactExpand,
      compactConfirm,
    ]),
  );
}

export function makeRecallFeedbackCommand<E, R>(
  handler: (options: Parameters<typeof runRecallFeedback>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'recall-feedback',
    {
      action: requiredChoice('action', ['useful', 'wrong', 'pin', 'dismiss', 'applied'], 'Feedback action'),
      project: optionalString('project', 'Project scope; required for pin because pins are never global'),
      query: requiredString('query', 'The original recall query; only its SHA-256 fingerprint is stored'),
      uri: argument('uri', 'The recalled threadnote:// result URI'),
    },
    handler,
  ).pipe(Command.withDescription('Record local feedback for one recalled result'));
}

export function makeContextBriefCommand<E, R>(
  handler: (options: Parameters<typeof runContextBrief>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'brief',
    {
      budgetTokens: optional(
        describeFlag(
          integerFlag('budget-tokens').pipe(
            Flag.withSchema(
              Schema.Int.check(
                Schema.isBetween({
                  minimum: CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
                  maximum: CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
                }),
              ),
            ),
          ),
          `Maximum estimated tokens for the agent text (${CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS}-${CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS}); --json exposes the same selected evidence with structured audit metadata`,
        ),
      ),
      codeRefs: repeatedString(
        'code-ref',
        'Canonical graph-indexed repository-relative path (no ./ or ..) or exact cgs_<32 lowercase hex>; cgr_ unsupported; repeat up to eight times',
        8,
      ),
      cwd: optionalString(
        CONTEXT_BRIEF_CWD_OPTION.name,
        'Absolute repository path, at most 4096 UTF-8 bytes; defaults to the current directory',
      ),
      detail: defaultChoice(
        'detail',
        CONTEXT_BRIEF_DETAILS,
        'Response detail: compact evidence or bounded exact-current source excerpts',
        'compact',
      ),
      json: boolean('json', 'Print the structured Context Brief projection'),
      mode: defaultChoice('mode', CONTEXT_BRIEF_MODES, 'Evidence-planning mode', 'brief'),
      project: optionalString('project', 'Optional memory project scope, at most 256 UTF-8 bytes'),
      surface: optionalString('surface', 'Agent catalog surface selector used for compatible procedure admission'),
      task: requiredString('task', 'Engineering task or question, 1-4096 UTF-8 bytes without control characters'),
      workset: optionalString('workset', 'Prepared workset scope, at most 256 UTF-8 bytes, instead of the repository'),
    },
    handler,
  ).pipe(Command.withDescription('Compile bounded graph, decision, handoff, and freshness evidence for an agent task'));
}

export function makeContextHealthCommand<E, R>(
  handler: (options: Parameters<typeof runContextHealth>[1]) => Effect.Effect<void, E, R>,
  aggregateHandler: (options: Parameters<typeof runContextHealthAggregate>[1]) => Effect.Effect<void, E, R>,
  scheduleHandler: (options: Parameters<typeof runContextHealthSchedule>[0]) => Effect.Effect<void, E, R>,
) {
  const aggregate = Command.make(
    'aggregate',
    {
      json: boolean('json', 'Emit the bounded ContextHealthAggregateV1 as JSON'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      teams: repeatedString('team', 'Configured Git team snapshot to include; repeat for multiple', 32),
    },
    aggregateHandler,
  ).pipe(Command.withDescription('Aggregate personal and selected local Git-team health without syncing'));
  const schedule = Command.make(
    'schedule',
    {
      cadenceMinutes: integerFlag('cadence-minutes'),
      json: boolean('json', 'Emit the provider-neutral ContextHealthSchedulePlanV1 as JSON'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      teams: repeatedString('team', 'Configured Git team snapshot to include; repeat for multiple', 32),
    },
    scheduleHandler,
  ).pipe(Command.withDescription('Render a read-only, network-disabled scheduled invocation contract'));
  return Command.make(
    'health',
    {
      after: optionalString('after', 'Opaque continuation cursor returned by the prior exact-scope page'),
      findingCategory: optionalChoice(
        'finding-category',
        CONTEXT_HEALTH_FINDING_CATEGORIES,
        'Exact finding category; intersects with --kind and --topic',
      ),
      json: boolean('json', 'Emit the bounded ContextHealthReportV1 as JSON'),
      kind: optionalChoice('kind', CONTEXT_HEALTH_MEMORY_KINDS, 'Exact memory kind to inspect'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      topic: optionalString('topic', 'Exact memory topic to inspect; may be combined with --kind'),
    },
    handler,
  ).pipe(
    Command.withDescription('Inspect active project memories and report read-only hygiene findings'),
    Command.withSubcommands([aggregate, schedule]),
    withDefaultActionSubcommand,
  );
}

export function makeContextHealthRepairCommand<E, R>(
  previewHandler: (options: Parameters<typeof runContextHealthRepairPreview>[1]) => Effect.Effect<void, E, R>,
  applyHandler: (options: Parameters<typeof runContextHealthRepairApply>[1]) => Effect.Effect<void, E, R>,
) {
  const preview = Command.make(
    'preview',
    {
      after: optionalString('after', 'Opaque continuation cursor returned by the prior exact-scope page'),
      contradictionId: optionalString(
        'contradiction-id',
        'Analyzer contradiction ID being explicitly directed; requires the other semantic direction flags',
      ),
      currentUri: optionalString('current-uri', 'Reviewed current memory URI for the selected contradiction'),
      findingCategory: optionalChoice(
        'finding-category',
        CONTEXT_HEALTH_FINDING_CATEGORIES,
        'Exact finding category; intersects with --kind and --topic',
      ),
      json: boolean('json', 'Emit the bounded ContextHealthRepairPlanV1 as JSON'),
      kind: optionalChoice('kind', CONTEXT_HEALTH_MEMORY_KINDS, 'Exact memory kind to inspect'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      reportRevision: optionalString('report-revision', 'Exact health report revision being reviewed'),
      staleUri: optionalString('stale-uri', 'Reviewed stale memory URI for the selected contradiction'),
      topic: optionalString('topic', 'Exact memory topic to inspect; may be combined with --kind'),
    },
    previewHandler,
  ).pipe(Command.withDescription('Preview exact, bounded repairs without changing memory'));

  const apply = Command.make(
    'apply',
    {
      after: optionalString('after', 'Exact continuation cursor used for preview'),
      approved: boolean('approved', 'Confirm explicit approval for this exact repair proposal revision'),
      findingCategory: optionalChoice(
        'finding-category',
        CONTEXT_HEALTH_FINDING_CATEGORIES,
        'Exact finding category used for preview; intersects with --kind and --topic',
      ),
      json: boolean('json', 'Emit the ContextHealthRepairApplyResultV1 as JSON'),
      kind: optionalChoice('kind', CONTEXT_HEALTH_MEMORY_KINDS, 'Exact memory kind used for preview'),
      project: requiredString('project', 'Project/repo namespace containing the reviewed proposal'),
      proposalId: requiredString('proposal-id', 'Exact proposal ID from context repair preview'),
      revision: requiredString('revision', 'Exact proposal revision from context repair preview'),
      topic: optionalString('topic', 'Exact memory topic used for preview'),
    },
    applyHandler,
  ).pipe(Command.withDescription('Apply one explicitly approved, revision-checked personal-memory repair'));

  return Command.make('repair').pipe(
    Command.withDescription('Preview or apply reviewable context-health repairs'),
    Command.withSubcommands([preview, apply]),
  );
}

export function makeContextCheckCommand<E, R>(
  handler: (options: Parameters<typeof runContextCheck>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'check',
    {
      base: optionalString(
        'base',
        'Git commit/ref to compare with the working tree, including untracked files (default HEAD)',
      ),
      format: optionalChoice('format', ['text', 'json', 'sarif'], 'Output format (default text)'),
      json: boolean('json', 'Emit privacy-safe ContextCheckReportV2 JSON'),
      project: requiredString('project', 'Project/repo namespace to inspect'),
      sarif: boolean('sarif', 'Emit SARIF 2.1.0 instead of JSON; excludes paths and memory bodies'),
    },
    handler,
  ).pipe(
    Command.withDescription('Check directly cited changed files; exit 0 clean, 1 findings, 2 unavailable evidence'),
  );
}

export function makeValueCommand<E, R>(
  handler: (options: Parameters<typeof runValueReport>[1]) => Effect.Effect<void, E, R>,
  exportHandler: (options: Parameters<typeof runValueReportExport>[1]) => Effect.Effect<void, E, R>,
  retentionHandler: (options: Parameters<typeof runValueReportRetention>[1]) => Effect.Effect<void, E, R>,
  deleteHandler: (options: Parameters<typeof runValueReportDelete>[1]) => Effect.Effect<void, E, R>,
  pilotHandler: (options: Parameters<typeof runPilotCommand>[1]) => Effect.Effect<void, E, R>,
) {
  const pilotCommand = Command.make(
    'pilot',
    {
      action: defaultChoice(
        'action',
        ['report', 'export', 'retention', 'reset'] as const,
        'Offline pilot report, explicit export, retention, or reset',
        'report',
      ),
      input: optionalString('input', 'Strict content-free pilot input JSON; correlation is never stored'),
      selectionDigest: optionalString('selection-digest', 'Required preview selection digest for reset apply'),
      apply: boolean('apply', 'Explicitly write or delete managed pilot exports'),
    },
    pilotHandler,
  ).pipe(Command.withDescription('Aggregate one deployment and window without network telemetry'));
  const exportCommand = Command.make(
    'export',
    {
      apply: boolean('apply', 'Write the bounded bundle under the private Threadnote home'),
      from: optionalString('from', 'Absolute inclusive UTC date YYYY-MM-DD; requires --to and excludes --period'),
      to: optionalString('to', 'Absolute exclusive UTC date YYYY-MM-DD; requires --from'),
      period: optional(
        describeFlag(
          integerFlag('period').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Include local inputs from this many whole days (default 30)',
        ),
      ),
      project: optionalString(
        'project',
        'Restrict local aggregation without including the project label in the bundle',
      ),
    },
    exportHandler,
  ).pipe(Command.withDescription('Preview or explicitly write a redacted design-partner bundle'));

  const retentionCommand = Command.make(
    'retention',
    {
      apply: boolean('apply', 'Prune the selected expired local inputs after previewing the count-only receipt'),
      days: optional(
        describeFlag(
          integerFlag('days').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Keep feedback and value events from this many days (default 365)',
        ),
      ),
    },
    retentionHandler,
  ).pipe(Command.withDescription('Preview or apply one-time local feedback and value-event retention'));

  const deleteCommand = Command.make(
    'delete',
    {
      all: boolean('all', 'Select feedback, value events, and explicit export bundles'),
      apply: boolean('apply', 'Delete the selected local value data after previewing the count-only receipt'),
      events: boolean('events', 'Select local Context Brief, setup, and health value events'),
      exports: boolean('exports', 'Select explicit redacted value-report export bundles'),
      feedback: boolean('feedback', 'Select local recall feedback events'),
    },
    deleteHandler,
  ).pipe(Command.withDescription('Preview or explicitly delete selected local value data'));

  const reportCommand = Command.make(
    'report',
    {
      json: boolean('json', 'Emit the bounded ValueReportV1 as JSON'),
      period: optional(
        describeFlag(
          integerFlag('period').pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
          'Include local inputs from this many whole days (default 30)',
        ),
      ),
      project: optionalString('project', 'Restrict local recall-feedback aggregation to one project'),
    },
    handler,
  ).pipe(
    Command.withDescription('Summarize bounded local value inputs without exporting telemetry'),
    Command.withSubcommands([exportCommand, retentionCommand, deleteCommand]),
    withDefaultActionSubcommand,
  );
  return Command.make('value').pipe(
    Command.withDescription('Inspect local, count-only value signals'),
    Command.withSubcommands([reportCommand, pilotCommand]),
  );
}

export function makeProcedureVerifyCommand<E, R>(
  handler: (options: Parameters<typeof runProcedureVerify>[0]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'verify',
    {
      apply: boolean('apply', 'Execute reviewed local verification commands with your user permissions'),
      artifact: optionalString('artifact', 'Local artifact file whose SHA-256 must match the manifest'),
      dryRun: boolean('dry-run', 'Preview only, even with --apply'),
      fixture: repeatedString(
        'fixture',
        'Local fixture mapping id=path; required for every declared fixture with --apply',
      ),
      json: boolean('json', 'Emit structured preview or verification receipt (also the default)'),
      manifest: argument('manifest', 'Explicit local procedure JSON manifest'),
      preview: boolean('preview', 'Preview only, even with --apply'),
    },
    handler,
  ).pipe(
    Command.withDescription('Preview local commands; --apply verifies content and executes in the manifest directory'),
  );
}

export function makeProcedureStatusCommand<E, R>(
  handler: (options: Parameters<typeof runProcedureStatus>[0]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'status',
    {
      artifact: requiredString('artifact', 'Local artifact file to hash without executing commands'),
      availableManifest: optionalString(
        'available-manifest',
        'Optional reviewed local manifest used only to detect a newer artifact version',
      ),
      capability: repeatedString('capability', 'Explicit host capability identifier; repeat for multiple'),
      json: boolean('json', 'Emit a structured read-only status'),
      manifest: argument('manifest', 'Explicit local procedure JSON manifest'),
      receipt: optionalString('receipt', 'Local verification receipt JSON emitted by procedure verify --apply'),
      surface: repeatedString('surface', 'Explicit host surface identifier; repeat for multiple'),
    },
    handler,
  ).pipe(
    Command.withDescription('Check a receipt, local artifact hash, and declared host compatibility without execution'),
  );
}

export function makeProcedurePublishCommand<E, R>(
  handler: (options: Parameters<typeof runProcedurePublish>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'publish',
    {
      apply: boolean('apply', 'Publish the exact reviewed proposal into the configured team Git share'),
      approved: boolean('approved', 'Confirm the exact preview proposal has been reviewed'),
      artifact: requiredString('artifact', 'Exact local artifact file bound by the manifest and receipt'),
      json: boolean('json', 'Emit the structured publication plan (also the default)'),
      manifest: argument('manifest', 'Explicit local procedure JSON manifest'),
      proposalId: optionalString('proposal-id', 'Exact proposal ID emitted by the preview'),
      push: boolean('push', 'Push the resulting Git commit after publication'),
      receipt: requiredString('receipt', 'Local verification receipt JSON emitted by procedure verify --apply'),
      team: optionalString('team', 'Configured shared team; defaults to the default team'),
    },
    handler,
  ).pipe(Command.withDescription('Preview by default; publish verified procedure bytes only after explicit approval'));
}

export function makeContextMaintainCommand<E, R>(
  handler: (options: Parameters<typeof runContextMaintainCommand>[1]) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'maintain',
    {
      action: defaultChoice(
        'action',
        [
          'run',
          'status',
          'pause',
          'resume',
          'undo',
          'packet',
          'refresh',
          'retire-anchor',
          'draft',
          'draft-view',
          'capture',
          'draft-receipt',
          'draft-preview',
          'draft-apply',
          'draft-reject',
          'draft-defer',
          'draft-resume',
          'background-status',
          'background-pause',
          'background-resume',
          'background-provider',
          'background-budget',
        ],
        'Local maintenance action',
        'run',
      ),
      json: boolean('json', 'Emit local maintenance progress and decisions as JSON'),
      maxRecords: optional(
        integerFlag('max-records').pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 100}))),
        ),
      ),
      project: optionalString('project', 'Optional project selection; omitted work is processed fairly'),
      receiptId: optionalString(
        'receipt-id',
        'Exact local repair receipt for undo or private generation receipt for draft-receipt',
      ),
      caseId: optionalString('case-id', 'Exact case for refresh/packet/status; run supports citation cases only'),
      backend: optionalString('backend', 'Selected text-only topic draft backend: local-ai or effect-ai'),
      unitsPerHour: optional(
        integerFlag('background-units').pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 4}))),
        ),
      ),
      modelId: optionalString('model-id', 'Exact selected generation model ID'),
      regenerate: boolean('regenerate', 'Explicitly replace a prior topic draft revision'),
      reviewId: optionalString('review-id', 'Exact private topic draft review ID for draft-view'),
      revision: optional(integerFlag('revision')),
      approvalDigest: optionalString('approval-digest', 'Exact reviewed full-document approval digest'),
      approved: boolean('approved', 'Explicit approval for reviewed topic application'),
      sourceCwd: optionalString('source-cwd', 'Absolute evidence checkout for topic review'),
      inspectionDigest: optionalString('inspection-digest', 'Exact inspected note vector digest'),
      fragmentStart: optional(integerFlag('fragment-start')),
      fragmentEnd: optional(integerFlag('fragment-end')),
      retentionDays: optional(integerFlag('retention-days')),
      editedDraftFile: optionalString('edited-draft-file', 'Path to an edited closed topic draft JSON document'),
      caseCursor: optionalString('case-cursor', 'Generation-bound next retained case page'),
      receiptCursor: optionalString('receipt-cursor', 'Generation-bound next retained receipt page'),
      citationId: optionalString('citation-id', 'Exact scoped citation evidence selector'),
      memoryUri: optionalString('memory-uri', 'Exact scoped case subject evidence selector'),
      startLine: optional(
        integerFlag('start-line').pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 1000000}))),
        ),
      ),
      maximumLines: optional(
        integerFlag('maximum-lines').pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 24}))),
        ),
      ),
      evidenceRevision: optionalString('evidence-revision', 'Exact reviewed anchor evidence revision'),
      expectedContentHash: optionalString('expected-content-hash', 'Exact reviewed subject hash for anchor retirement'),
      limit: optional(
        integerFlag('limit').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 100})))),
      ),
    },
    handler,
  ).pipe(Command.withDescription('Run bounded local structural maintenance or inspect/pause/undo it'));
}
