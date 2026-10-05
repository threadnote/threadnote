import {Schema, type Effect} from 'effect';
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
        ['run', 'status', 'pause', 'resume', 'undo', 'packet', 'retire-anchor'],
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
      receiptId: optionalString('receipt-id', 'Exact local automatic repair receipt for undo'),
      caseId: optionalString('case-id', 'Exact local maintenance case for a bounded agent packet or status selector'),
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
