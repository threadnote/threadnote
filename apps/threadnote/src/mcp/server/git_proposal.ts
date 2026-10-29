import {Effect} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {buildReviewedGitProposal} from '../../git_proposal/commands.js';
import {proposeSharedTopicMaintenance} from '../../git_proposal/topic_maintenance_commands.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {argumentError, mcpErrorResult, requiredText} from './common.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function registerKnowledgeDeltaGitProposalTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'share_propose',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Preview shared topics or export applied Knowledge Delta. Topic export requires approved=true and approvalDigest=proposalHash. Reads local evidence only.',
      inputSchema: {
        approved: McpInput.boolean('Explicit approval of reviewed changes'),
        approvalDigest: McpInput.string('Topic preview proposalHash'),
        sourceCwd: McpInput.string('Absolute topic source checkout'),
        candidateIds: McpInput.stringOrStrings('Applied candidate IDs (1–3)', {maximumItems: 3}),
        reviewId: McpInput.string('Private review ID'),
        revision: McpInput.integer('Exact review revision', {minimum: 1}),
        team: McpInput.string('Configured team; default if omitted'),
      },
    },
    ({approved, approvalDigest, sourceCwd, candidateIds, reviewId, revision, team}) => {
      const checkedReview = requiredText(reviewId, 'share_propose', 'reviewId', {
        reviewId: 'review-0123456789abcdef',
      });
      if (!checkedReview.ok) return checkedReview.error;
      if (revision === undefined || !Number.isSafeInteger(revision) || revision < 1) {
        return argumentError('share_propose requires a positive integer revision.');
      }
      const ids = stringList(candidateIds);
      return buildReviewedGitProposal(config, {
        approved,
        approvalDigest,
        sourceCwd,
        candidateIds: ids,
        reviewId: checkedReview.value,
        revision,
        team,
      }).pipe(
        Effect.map(built => ({
          content: [{type: 'text' as const, text: Effect2.pipe(built.artifact, EffectString.trimEnd)}],
          structuredContent: built.proposal,
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      );
    },
  );
}

export function registerTopicMaintenanceGitProposalTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'share_topic_propose',
    {
      annotations: {destructiveHint: false, readOnlyHint: false},
      description:
        'Inspect a fresh packet for an existing enrolled shared topic, or submit canonical manual draft JSON to the existing private CandidateReview and prepare its exact final document. Zero model calls. No accepted personal/shared writes, live shared enrollment, Git mutations or network activity.',
      inputSchema: {
        uri: McpInput.string('Exact existing enrolled shared durable topic URI'),
        sourceCwd: McpInput.string('Absolute cited source checkout'),
        draftJson: McpInput.string('Canonical draft JSON matching the fresh packet; omit to inspect packet/basis'),
        reviewId: McpInput.string('Current private review ID when editing an existing pending proposal'),
        revision: McpInput.integer('Exact current private review revision when editing', {minimum: 1}),
        team: McpInput.string('Configured shared Git team'),
      },
    },
    ({uri, sourceCwd, draftJson, reviewId, revision, team}) => {
      const checkedUri = requiredText(uri, 'share_topic_propose', 'uri', {
        uri: 'threadnote://user/local/memories/shared/default/durable/projects/project/topic.md',
      });
      const checkedCwd = requiredText(sourceCwd, 'share_topic_propose', 'sourceCwd', {
        sourceCwd: '/absolute/source/checkout',
      });
      if (!checkedUri.ok) return checkedUri.error;
      if (!checkedCwd.ok) return checkedCwd.error;
      return proposeSharedTopicMaintenance(config, {
        uri: checkedUri.value,
        sourceCwd: checkedCwd.value,
        draftJson,
        reviewId,
        revision,
        team,
      }).pipe(
        Effect.map(result => ({content: [{type: 'text' as const, text: JSON.stringify(result)}]})),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
      );
    },
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}
