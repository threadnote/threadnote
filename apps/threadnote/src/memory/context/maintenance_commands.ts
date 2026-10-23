import {Effect, FileSystem, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {
  MAX_TOPIC_MAINTENANCE_DRAFT_BYTES,
  topicGenerationDiagnosticSummary,
} from '@threadnote/memory/topic-maintenance-draft';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {renderContextMaintenanceStatus} from './maintenance_projection.js';
import {readTopicGenerationSummary} from '@threadnote/memory/candidate-generation';
import {loadCandidateReview} from '@threadnote/memory/candidate';
import {captureTopicObsidianEvidence} from './maintenance_obsidian.js';
import {
  readTopicMaintenanceDraft,
  requestTopicMaintenanceDraft,
  runAutomaticMemoryBackground,
  setAutomaticDraftBackgroundPolicy,
  TopicDraftError,
} from './maintenance_draft.js';
import {runSelectedDraft} from '../../effect/ai/selected_generation.js';
import {projectTopicReviewDecisionAcknowledgement} from './maintenance_review_projection.js';
import {
  applyTopicMaintenanceReview,
  decideTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
  TopicReviewError,
} from './maintenance_review.js';
import {
  readContextMaintenancePacket,
  readContextMaintenanceStatus,
  retireContextMaintenanceAnchor,
  runContextMaintenance,
  setContextMaintenancePaused,
  undoContextMaintenance,
} from './maintenance.js';

export const runContextMaintainCommand = Effect.fn('contextMaintenance.command')(function* (
  config: RuntimeConfig,
  options: {
    readonly project?: string;
    readonly maxRecords?: number;
    readonly json?: boolean;
    readonly action?: string;
    readonly receiptId?: string;
    readonly caseId?: string;
    readonly caseCursor?: string;
    readonly receiptCursor?: string;
    readonly limit?: number;
    readonly evidenceRevision?: string;
    readonly expectedContentHash?: string;
    readonly citationId?: string;
    readonly memoryUri?: string;
    readonly startLine?: number;
    readonly maximumLines?: number;
    readonly backend?: string;
    readonly modelId?: string;
    readonly regenerate?: boolean;
    readonly reviewId?: string;
    readonly revision?: number;
    readonly approvalDigest?: string;
    readonly approved?: boolean;
    readonly sourceCwd?: string;
    readonly editedDraftFile?: string;
    readonly inspectionDigest?: string;
    readonly fragmentStart?: number;
    readonly fragmentEnd?: number;
    readonly retentionDays?: number;
    readonly unitsPerHour?: number;
  },
  generate: typeof runSelectedDraft = runSelectedDraft,
) {
  if (options.action?.startsWith('background-')) {
    const status = yield* setAutomaticDraftBackgroundPolicy(config, {
      action: options.action,
      backend: options.backend,
      modelId: options.modelId,
      unitsPerHour: options.unitsPerHour,
    });
    yield* writeFinalCliOutput(JSON.stringify(status, null, options.json ? undefined : 2));
    return;
  }
  if (options.action === 'draft-receipt')
    return yield* readTopicGenerationReceiptCommand(
      config.agentContextHome,
      options.receiptId ?? '',
      options.json === true,
    );
  const cwd = options.sourceCwd ?? (yield* SystemInfo).currentDirectory();
  let editedDraftJson: string | undefined;
  if (options.editedDraftFile) {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(options.editedDraftFile);
    if (stat.type !== 'File' || Number(stat.size) > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES)
      return yield* TopicReviewError.make({message: 'Edited topic draft must be a JSON file within 32 KiB.'});
    editedDraftJson = yield* fs.readFileString(options.editedDraftFile);
    if (new TextEncoder().encode(editedDraftJson).byteLength > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES)
      return yield* TopicReviewError.make({message: 'Edited topic draft exceeds 32 KiB.'});
  }
  if (options.action === 'draft-reject' && options.project !== undefined) {
    const selected = yield* loadCandidateReview(config.agentContextHome, options.reviewId ?? '');
    if (selected.project !== options.project)
      return yield* TopicReviewError.make({message: 'The selected review belongs to another project.'});
  }
  const result =
    options.action === 'capture'
      ? yield* captureTopicObsidianEvidence(config, {
          caseId: options.caseId ?? '',
          expectedContentHash: options.expectedContentHash ?? '',
          observationRevision: options.evidenceRevision ?? '',
          inspectionDigest: options.inspectionDigest ?? '',
          fragmentStart: options.fragmentStart ?? -1,
          fragmentEnd: options.fragmentEnd ?? -1,
          retentionDays: options.retentionDays,
          approved: options.approved === true,
        }).pipe(
          Effect.map(review => ({
            reviewId: review.reviewId,
            revision: review.revision,
            state: review.maintenanceCapture?.stage,
          })),
        )
      : options.action === 'draft'
        ? yield* requestTopicMaintenanceDraft(config, {
            caseId: options.caseId ?? '',
            backend: options.backend as 'local-ai' | 'effect-ai',
            modelId: options.modelId ?? '',
            regenerate: options.regenerate,
          }).pipe(
            Effect.catch(error =>
              Effect.gen(function* () {
                (yield* SystemInfo).setExitCode(1);
                return projectTopicDraftFailure(error);
              }),
            ),
          )
        : options.action === 'draft-view'
          ? yield* readTopicMaintenanceDraft(config, options.reviewId ?? '')
          : options.action === 'draft-preview'
            ? yield* prepareTopicMaintenanceReview(config, {
                reviewId: options.reviewId ?? '',
                revision: options.revision ?? 0,
                sourceCwd: cwd,
                editedDraftJson,
              })
            : options.action === 'draft-apply'
              ? yield* applyTopicMaintenanceReview(config, {
                  reviewId: options.reviewId ?? '',
                  revision: options.revision ?? 0,
                  sourceCwd: cwd,
                  approvalDigest: options.approvalDigest ?? '',
                  approved: options.approved === true,
                })
              : options.action === 'draft-reject' ||
                  options.action === 'draft-defer' ||
                  options.action === 'draft-resume'
                ? yield* decideTopicMaintenanceReview(config, {
                    reviewId: options.reviewId ?? '',
                    revision: options.revision ?? 0,
                    action: options.action.slice(6) as 'reject' | 'defer' | 'resume',
                    caseId: options.caseId,
                  })
                : options.action === 'retire-anchor'
                  ? yield* retireContextMaintenanceAnchor(config, {
                      caseId: options.caseId ?? '',
                      evidenceRevision: options.evidenceRevision ?? '',
                      expectedContentHash: options.expectedContentHash ?? '',
                    })
                  : options.action === 'packet'
                    ? yield* readContextMaintenancePacket(config, options.caseId ?? '', {
                        citationId: options.citationId,
                        memoryUri: options.memoryUri,
                        startLine: options.startLine,
                        maximumLines: options.maximumLines,
                      })
                    : options.action === 'status'
                      ? yield* readContextMaintenanceStatus(config, options.project, options)
                      : options.action === 'pause' || options.action === 'resume'
                        ? yield* setContextMaintenancePaused(config, options.action === 'pause')
                        : options.action === 'undo'
                          ? yield* undoContextMaintenance(config, options.receiptId ?? '')
                          : yield* runContextMaintenance(config, {
                              cwd: (yield* SystemInfo).currentDirectory(),
                              project: options.project,
                              maxRecords: options.maxRecords,
                              caseId: options.caseId,
                            });
  // Detached ordinary-use wakes run generation only after the assessment's state lock is released.
  const background =
    (options.action === undefined || options.action === 'run') &&
    !options.caseId &&
    'paused' in result &&
    !result.paused
      ? yield* runAutomaticMemoryBackground(
          config,
          {project: options.project, maxRecords: options.maxRecords},
          generate,
        )
      : undefined;
  const projected =
    'candidates' in result && 'maintenance' in result && result.maintenance?.version === 2
      ? (projectTopicReviewDecisionAcknowledgement(
          result,
          options.action === 'draft-reject' ? 'reject' : '',
          options.caseId,
        ) ?? (yield* readTopicMaintenanceDraft(config, result.reviewId)))
      : result;
  const output = background ? {...projected, background} : projected;
  yield* writeFinalCliOutput(
    options.json
      ? JSON.stringify(output)
      : 'error' in result && typeof result.error === 'string'
        ? result.error +
          ('diagnostics' in result && result.diagnostics ? ` Local diagnostics: ${result.diagnostics.receiptId}` : '')
        : 'projects' in result
          ? renderContextMaintenanceStatus(result)
          : 'status' in result
            ? `Maintenance undo: ${result.status}`
            : JSON.stringify(output, null, 2),
  );
});

export function projectTopicDraftFailure(error: unknown) {
  const diagnostics = Schema.is(TopicDraftError)(error)
    ? topicGenerationDiagnosticSummary(error.diagnostics)
    : undefined;
  return {
    status: 'failed' as const,
    code: 'topic-draft-unavailable',
    error: 'The topic draft could not be generated from this exact case and model.',
    ...(diagnostics ? {diagnostics} : {}),
  };
}

export const readTopicGenerationReceiptCommand = Effect.fn('contextMaintenance.generationReceiptCommand')(function* (
  home: string,
  receiptId: string,
  json: boolean,
) {
  const summary = yield* readTopicGenerationSummary(home, receiptId);
  yield* writeFinalCliOutput(JSON.stringify(summary, undefined, json ? undefined : 2));
});
