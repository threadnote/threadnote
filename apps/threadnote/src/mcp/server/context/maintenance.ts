import {Effect, Path, Result, Schema} from 'effect';
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
  retireContextMaintenanceAnchor,
} from '../../../memory/context/maintenance.js';
import {argumentError, mcpErrorResult} from '../common.js';
import {readTopicMaintenanceDraft} from '../../../memory/context/maintenance_draft.js';
import {requestTopicMaintenanceDraft} from '../../../memory/context/maintenance_draft.js';
import {MAX_TOPIC_MAINTENANCE_BYTES} from '@threadnote/memory/topic-maintenance';
import {MAX_TOPIC_MAINTENANCE_DRAFT_BYTES} from '@threadnote/memory/topic-maintenance-draft';
import {
  inspectTopicEnrollment,
  previewTopicEnrollment,
  applyTopicEnrollment,
} from '../../../memory/maintenance/topic_enrollment.js';
import {managerTopicReviewCaseIdentity, projectManagerTopicReview} from '../../../manager/topic_review.js';

class InvalidTopicEnrollmentJson extends Schema.TaggedError<InvalidTopicEnrollmentJson>()(
  'InvalidTopicEnrollmentJson',
  {},
) {}
import {
  applyTopicMaintenanceReview,
  decideTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
} from '../../../memory/context/maintenance_review.js';

export function registerContextMaintenanceTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_topic_enrollment',
    {
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false},
      description:
        'Inspect an existing personal durable topic or preview/apply explicit enrollment with exact content hash and proposal revision.',
      inputSchema: {
        action: McpInput.literals(['inspect', 'preview', 'enroll'], 'Exact topic enrollment action'),
        uri: McpInput.string('Personal durable memory URI or stable memory ID'),
        callerCwd: McpInput.string('Absolute selected repository checkout for preview/enroll'),
        project: McpInput.string(
          'Configured graph project name or root for preview/enroll; otherwise infer from callerCwd',
        ),
        inputJson: McpInput.string('Closed paragraph support and dependency decisions, JSON, at most 32 KiB'),
        expectedContentHash: McpInput.string('Exact previewed target content hash for enroll'),
        revision: McpInput.string('Exact previewed proposal revision for enroll'),
        approved: McpInput.boolean('Explicit enrollment approval'),
      },
    },
    input =>
      Effect.gen(function* () {
        if (input.action !== 'inspect' && input.action !== 'preview' && input.action !== 'enroll')
          return argumentError('Choose inspect, preview, or enroll explicitly.');
        if (typeof input.uri !== 'string' || !input.uri || input.uri.length > 4096)
          return argumentError('Select a bounded personal topic URI.');
        if (input.action === 'inspect') {
          const result = yield* inspectTopicEnrollment(config, input.uri);
          return {content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result};
        }
        const cwd = input.callerCwd ?? '';
        if (!(yield* Path.Path).isAbsolute(cwd)) return argumentError('Topic enrollment callerCwd must be absolute.');
        if (
          input.project !== undefined &&
          (!input.project.trim() || new TextEncoder().encode(input.project).byteLength > 256)
        )
          return argumentError('Select a graph project name or root within 256 bytes.');
        if (
          typeof input.inputJson !== 'string' ||
          new TextEncoder().encode(input.inputJson).byteLength > MAX_TOPIC_MAINTENANCE_BYTES
        )
          return argumentError('Topic enrollment JSON must be within 32 KiB.');
        const inputJson = input.inputJson;
        const parsed = yield* Effect.try({
          try: (): unknown => JSON.parse(inputJson),
          catch: () => InvalidTopicEnrollmentJson.make({}),
        }).pipe(Effect.result);
        if (Result.isFailure(parsed)) return argumentError('Topic enrollment input must be valid JSON.');
        if (
          input.action === 'enroll' &&
          (input.approved !== true ||
            typeof input.expectedContentHash !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(input.expectedContentHash) ||
            typeof input.revision !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(input.revision))
        )
          return argumentError('Enroll requires explicit approval and the exact preview hash and revision.');
        const options = {uri: input.uri, callerCwd: cwd, project: input.project, input: parsed.success};
        const result =
          input.action === 'preview'
            ? yield* previewTopicEnrollment(config, options)
            : yield* applyTopicEnrollment(config, {
                ...options,
                expectedContentHash: input.expectedContentHash ?? '',
                revision: input.revision ?? '',
                approved: input.approved === true,
              });
        return {content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result};
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error)))),
  );
  server.registerTool(
    'context_maintenance_draft',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
      description:
        'Explicitly generate or regenerate a private topic proposal from one exact ready maintenance case and selected text model. Accepted memory is unchanged.',
      inputSchema: {
        caseId: McpInput.string('Exact topic maintenance case ID'),
        backend: McpInput.literals(['local-ai', 'effect-ai'], 'Explicit text-only backend'),
        modelId: McpInput.string('Exact installed or configured model ID'),
        regenerate: McpInput.boolean('Explicitly regenerate instead of reusing an unchanged review'),
      },
    },
    input =>
      Effect.gen(function* () {
        if (
          typeof input.caseId !== 'string' ||
          !/^health-case-[a-f0-9]{40}$/u.test(input.caseId) ||
          (input.backend !== 'local-ai' && input.backend !== 'effect-ai') ||
          typeof input.modelId !== 'string' ||
          !input.modelId.trim() ||
          new TextEncoder().encode(input.modelId).byteLength > 256 ||
          [...input.modelId].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        )
          return argumentError('Select an exact ready topic case, backend, and model.');
        const review = yield* requestTopicMaintenanceDraft(config, {
          caseId: input.caseId,
          backend: input.backend,
          modelId: input.modelId,
          regenerate: input.regenerate === true,
        });
        const result = projectManagerTopicReview(review, yield* managerTopicReviewCaseIdentity(config, review))!;
        return {content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result};
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error)))),
  );
  server.registerTool(
    'context_maintenance_review',
    {
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false},
      description:
        'Read, preview, decide, or apply one exact private topic-maintenance review. Applying requires approved=true, the preview revision, and its full-document digest.',
      inputSchema: {
        action: McpInput.literals(['view', 'preview', 'apply', 'reject', 'defer', 'resume'], 'Exact review action'),
        reviewId: McpInput.string('Exact private topic review ID'),
        caseId: McpInput.string('Exact topic maintenance case for model review decisions'),
        revision: McpInput.integer('Exact private review or approval revision', {minimum: 1}),
        sourceCwd: McpInput.string('Absolute local evidence checkout for preview/apply'),
        editedDraftJson: McpInput.string('Optional edited closed topic-draft JSON for preview only'),
        approvalDigest: McpInput.string('Exact approved preview digest for apply'),
        approved: McpInput.boolean('Explicit human approval for apply'),
      },
    },
    input =>
      Effect.gen(function* () {
        if (
          input.action !== 'view' &&
          input.action !== 'preview' &&
          input.action !== 'apply' &&
          input.action !== 'reject' &&
          input.action !== 'defer' &&
          input.action !== 'resume'
        )
          return argumentError('Choose an exact topic review action.');
        if (typeof input.reviewId !== 'string' || !/^review-[a-f0-9]{24}$/u.test(input.reviewId))
          return argumentError('Select an exact topic review ID.');
        if (input.action !== 'view' && (!Number.isSafeInteger(input.revision) || (input.revision ?? 0) < 1))
          return argumentError('Select the exact positive review revision.');
        if (
          input.action === 'preview' &&
          input.editedDraftJson !== undefined &&
          new TextEncoder().encode(input.editedDraftJson).byteLength > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES
        )
          return argumentError('Edited topic draft JSON exceeds 32 KiB.');
        if (
          input.action === 'apply' &&
          (input.approved !== true ||
            typeof input.approvalDigest !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(input.approvalDigest))
        )
          return argumentError('Apply requires approved=true and the exact preview digest.');
        if (
          (input.action === 'reject' || input.action === 'defer' || input.action === 'resume') &&
          input.caseId !== undefined &&
          !/^health-case-[a-f0-9]{40}$/u.test(input.caseId)
        )
          return argumentError('Select an exact topic maintenance case.');
        const cwd =
          input.action === 'preview' || input.action === 'apply'
            ? (input.sourceCwd ?? (yield* SystemInfo).currentDirectory())
            : '';
        if ((input.action === 'preview' || input.action === 'apply') && !(yield* Path.Path).isAbsolute(cwd))
          return argumentError('Topic review sourceCwd must be absolute.');
        const result =
          input.action === 'view'
            ? yield* readTopicMaintenanceDraft(config, input.reviewId ?? '')
            : input.action === 'preview'
              ? yield* prepareTopicMaintenanceReview(config, {
                  reviewId: input.reviewId ?? '',
                  revision: input.revision ?? 0,
                  sourceCwd: cwd,
                  editedDraftJson: input.editedDraftJson,
                })
              : input.action === 'apply'
                ? yield* applyTopicMaintenanceReview(config, {
                    reviewId: input.reviewId ?? '',
                    revision: input.revision ?? 0,
                    sourceCwd: cwd,
                    approvalDigest: input.approvalDigest ?? '',
                    approved: input.approved === true,
                  })
                : yield* decideTopicMaintenanceReview(config, {
                    reviewId: input.reviewId ?? '',
                    revision: input.revision ?? 0,
                    action: input.action,
                    caseId: input.caseId,
                  });
        const projection = projectManagerTopicReview(result, yield* managerTopicReviewCaseIdentity(config, result));
        if (!projection) return argumentError('The selected review is not a topic maintenance proposal.');
        return {content: [{type: 'text' as const, text: JSON.stringify(projection)}], structuredContent: projection};
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error)))),
  );
  server.registerTool(
    'context_maintenance_status',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Read persistent local maintenance progress, grouped evidence cases and bounded automatic repair receipts. Does not run maintenance.',
      inputSchema: {
        project: McpInput.string('Optional project selection'),
        caseCursor: McpInput.string('Generation-bound next case page'),
        receiptCursor: McpInput.string('Generation-bound next receipt page'),
        caseId: McpInput.string('Exact retained case selector'),
        receiptId: McpInput.string('Exact retained receipt selector'),
        limit: McpInput.integer('Page size', {minimum: 1, maximum: 100}),
      },
    },
    input =>
      readContextMaintenanceStatus(config, input.project, input).pipe(
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
        action: McpInput.literals(['run', 'pause', 'resume', 'undo', 'retire-anchor'], 'Defaults to run'),
        callerCwd: McpInput.string('Absolute local repository/worktree evidence root'),
        project: McpInput.string('Optional project; omitted work uses fair home-wide scheduling'),
        maxRecords: McpInput.integer('Bounded work tasks', {minimum: 1, maximum: 100}),
        receiptId: McpInput.string('Exact retained receipt for undo'),
        caseId: McpInput.string('Exact citation case to refresh, or reviewed deleted-anchor case to retire'),
        evidenceRevision: McpInput.string('Exact reviewed anchor evidence revision'),
        expectedContentHash: McpInput.string('Exact reviewed subject hash for anchor retirement'),
      },
    },
    input =>
      Effect.gen(function* () {
        const cwd = input.callerCwd ?? (yield* SystemInfo).currentDirectory();
        if (!(yield* Path.Path).isAbsolute(cwd)) return argumentError('context_maintain callerCwd must be absolute.');
        const result =
          input.action === 'retire-anchor'
            ? yield* retireContextMaintenanceAnchor(config, {
                caseId: input.caseId ?? '',
                evidenceRevision: input.evidenceRevision ?? '',
                expectedContentHash: input.expectedContentHash ?? '',
              })
            : input.action === 'pause' || input.action === 'resume'
              ? yield* setContextMaintenancePaused(config, input.action === 'pause')
              : input.action === 'undo'
                ? yield* undoContextMaintenance(config, input.receiptId ?? '')
                : yield* runContextMaintenance(config, {
                    cwd,
                    project: input.project,
                    maxRecords: input.maxRecords,
                    caseId: input.caseId,
                  });
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
      inputSchema: {
        caseId: McpInput.string('Exact case ID from context_maintenance_status'),
        citationId: McpInput.string('Exact citation within case subject evidence selectors'),
        memoryUri: McpInput.string('Exact case subject URI'),
        startLine: McpInput.integer('First excerpt line', {minimum: 1, maximum: 1000000}),
        maximumLines: McpInput.integer('Bounded excerpt lines', {minimum: 1, maximum: 24}),
      },
    },
    input =>
      readContextMaintenancePacket(config, input.caseId ?? '', input).pipe(
        Effect.map(result => ({
          content: [{type: 'text' as const, text: JSON.stringify(result)}],
          structuredContent: result,
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      ),
  );
}
