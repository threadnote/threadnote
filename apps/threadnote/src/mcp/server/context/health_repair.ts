import {Effect, Path} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../../effect/ai/mcp.js';
import {
  applyContextHealthRepair,
  previewContextHealthRepairs,
  renderContextHealthRepairApply,
  renderContextHealthRepairPlan,
} from '../../../memory/context/health_repair_commands.js';
import {
  CONTEXT_HEALTH_FINDING_CATEGORIES,
  CONTEXT_HEALTH_MEMORY_KINDS,
  normalizeContextHealthSelector,
} from '../../../memory/context/health_selector.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {argumentError, mcpErrorResult, requiredText} from '../common.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function registerContextHealthRepairTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_health_repair_preview',
    {
      annotations: {destructiveHint: false, readOnlyHint: true},
      description:
        'Preview bounded, exact context-health repairs. Semantic supersede suggestions require an explicit contradiction ID, report revision, stale URI, and current URI from a prior preview.',
      inputSchema: {
        after: McpInput.string('Opaque continuation cursor returned by the prior exact-scope page'),
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        contradictionId: McpInput.string('Optional analyzer contradiction ID; supply all semantic direction fields'),
        currentUri: McpInput.string('Optional reviewed current memory URI; supply all semantic direction fields'),
        findingCategory: McpInput.literals(
          CONTEXT_HEALTH_FINDING_CATEGORIES,
          'Optional exact finding category; intersects with kind and topic',
        ),
        kind: McpInput.literals(CONTEXT_HEALTH_MEMORY_KINDS, 'Optional exact memory kind'),
        project: McpInput.string('Required project/repo namespace'),
        reportRevision: McpInput.string('Optional exact health report revision; supply all semantic direction fields'),
        staleUri: McpInput.string('Optional reviewed stale memory URI; supply all semantic direction fields'),
        topic: McpInput.string('Optional exact memory topic; may be combined with kind'),
      },
    },
    ({
      after,
      callerCwd,
      contradictionId,
      currentUri,
      findingCategory,
      kind,
      project,
      reportRevision,
      staleUri,
      topic,
    }) => {
      const checked = repairToolScope('context_health_repair_preview', callerCwd, project);
      if (!checked.ok) return checked.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        if (!path.isAbsolute(checked.cwd)) {
          return argumentError('context health repair callerCwd must be an absolute repository or worktree path.');
        }
        const plan = yield* previewContextHealthRepairs(config, checked.project, checked.cwd, {
          after,
          contradictionId,
          currentUri,
          findingCategory,
          kind,
          reportRevision,
          staleUri,
          topic,
        });
        const selector = normalizeContextHealthSelector({after, findingCategory, kind, topic});
        return {
          content: [
            {
              type: 'text' as const,
              text: renderContextHealthRepairPlan(plan, selector),
            },
          ],
          structuredContent: plan,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );

  server.registerTool(
    'context_health_repair_apply',
    {
      annotations: {destructiveHint: true, readOnlyHint: false},
      description:
        'Apply one exact personal-memory repair after explicit approval. Requires the proposal ID and revision from preview; shared and review-only proposals are never mutated.',
      inputSchema: {
        after: McpInput.string('Exact continuation cursor used for preview'),
        approved: McpInput.boolean('Required true after explicit approval of this proposal revision'),
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        findingCategory: McpInput.literals(
          CONTEXT_HEALTH_FINDING_CATEGORIES,
          'Exact finding category used for preview; intersects with kind and topic',
        ),
        kind: McpInput.literals(CONTEXT_HEALTH_MEMORY_KINDS, 'Exact memory kind used for preview'),
        project: McpInput.string('Required project/repo namespace'),
        proposalId: McpInput.string('Exact proposal ID from context_health_repair_preview'),
        revision: McpInput.string('Exact proposal revision from context_health_repair_preview'),
        topic: McpInput.string('Exact memory topic used for preview'),
      },
    },
    ({after, approved, callerCwd, findingCategory, kind, project, proposalId, revision, topic}) => {
      const checked = repairToolScope('context_health_repair_apply', callerCwd, project);
      if (!checked.ok) return checked.error;
      const checkedProposal = requiredText(proposalId, 'context_health_repair_apply', 'proposalId', {
        proposalId: `health-repair-${Effect2.pipe('0', EffectString.repeat(40))}`,
      });
      if (!checkedProposal.ok) return checkedProposal.error;
      const checkedRevision = requiredText(revision, 'context_health_repair_apply', 'revision', {
        revision: Effect2.pipe('0', EffectString.repeat(64)),
      });
      if (!checkedRevision.ok) return checkedRevision.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        if (!path.isAbsolute(checked.cwd)) {
          return argumentError('context health repair callerCwd must be an absolute repository or worktree path.');
        }
        const result = yield* applyContextHealthRepair(config, {
          after,
          approved,
          cwd: checked.cwd,
          findingCategory,
          kind,
          project: checked.project,
          proposalId: checkedProposal.value,
          revision: checkedRevision.value,
          topic,
        });
        return {
          content: [{type: 'text' as const, text: renderContextHealthRepairApply(result)}],
          structuredContent: result,
        };
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}

function repairToolScope(name: string, callerCwd: string | undefined, project: string | undefined) {
  const checkedProject = requiredText(project, name, 'project', {
    callerCwd: '/workspace/project',
    project: 'threadnote',
  });
  if (!checkedProject.ok) return {error: checkedProject.error, ok: false as const};
  const checkedCwd = requiredText(callerCwd, name, 'callerCwd', {
    callerCwd: '/workspace/project',
    project: checkedProject.value,
  });
  if (!checkedCwd.ok) return {error: checkedCwd.error, ok: false as const};
  return {
    cwd: checkedCwd.value,
    ok: true as const,
    project: checkedProject.value,
  };
}
