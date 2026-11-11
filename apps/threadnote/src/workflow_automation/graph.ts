import {Effect, Schema} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStoreBusyError, CodeGraphStoreTransientIoError, type CodeGraphStatus} from '@threadnote/graph/types';
import {WorkflowAutomationError, WorkflowGraph} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {WorkflowBinding} from '../workflow_memory/protocol.js';
import {resolveWorkflowGraphScope} from '../workflow_memory/graph_scope.js';
import {resolveWorkflowBinding} from '../workflow_memory/profile.js';
import {nativeWorkflowError} from './memory.js';

const isReady = (status: CodeGraphStatus, repo: string) =>
  status.freshness === 'current' &&
  !status.stale &&
  status.identity.repoRoot === repo &&
  status.readySnapshot?.state === 'ready' &&
  status.readySnapshot.commit === status.identity.headCommit &&
  Boolean(status.readySnapshot.graphContentId);

/** One caller-owned preparation followed by a fresh source-bound readiness check. */
export const makeWorkflowGraphAdapter = Effect.fn('workflowAutomation.graphAdapter')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  options: {readonly prepare?: boolean; readonly recovery?: 'fresh-run' | 'same-task' | 'new-task'} = {},
) {
  const query = yield* CodeGraphQueryService;
  const indexer = yield* CodeGraphIndexer;
  // A memory project tag is not a graph scope selector.
  const route = yield* resolveWorkflowGraphScope(config, binding, options.recovery);
  const project = route.state === 'selected' ? route.project : undefined;
  const statusOptions = {
    manifestPath: config.manifestPath,
    ...(project ? {project: project.name} : {}),
  };
  return WorkflowGraph.of({
    ready: repo =>
      Effect.gen(function* () {
        if (repo !== binding.repo)
          return yield* WorkflowAutomationError.make({
            code: 'binding-drift',
            message: 'Graph preparation must use the native run checkout.',
          });
        let status = yield* query.status(config.agentContextHome, repo, statusOptions);
        if (!isReady(status, repo)) {
          if (options.prepare === false)
            return yield* WorkflowAutomationError.make({
              code: 'evidence-unavailable',
              message: `Code citations require an already-published ready graph; run \`threadnote graph index --no-vectors${project ? ` --project ${project.name}` : ''}\` from callerCwd, then retry. No indexing was started.`,
              retryable: false,
            });
          yield* indexer.index({
            cwd: repo,
            threadnoteHome: config.agentContextHome,
            ensureVectors: false,
            ...(project ? {project} : {}),
          });
          status = yield* query.status(config.agentContextHome, repo, statusOptions);
        }
        if (!isReady(status, repo))
          return yield* WorkflowAutomationError.make({
            code: 'evidence-not-ready',
            message: 'Preparation did not yield exact current ready graph evidence. Discovery must remain blocked.',
            retryable: true,
          });
        return {
          state: 'ready' as const,
          snapshotId: status.readySnapshot!.id,
          head: status.identity.headCommit,
          graphContentId: status.readySnapshot!.graphContentId!,
          repositoryRoot: status.identity.repoRoot,
          dirty: status.readySnapshot!.dirty,
        };
      }).pipe(
        Effect.mapError(error =>
          Schema.is(CodeGraphStoreBusyError)(error) || Schema.is(CodeGraphStoreTransientIoError)(error)
            ? WorkflowAutomationError.make({
                code: 'evidence-busy',
                message: 'The graph evidence writer is busy. Preserve this run and retry the same request.',
                retryable: true,
              })
            : nativeWorkflowError(error),
        ),
      ),
  });
});

/** Check a proposed native run before init creates its binding or reserves its name. */
export const requireWorkflowGraphReady = Effect.fn('workflowAutomation.requireGraphReady')(function* (
  config: RuntimeConfig,
  input: {
    readonly checkout: string;
    readonly runId: string;
    readonly project: string;
    readonly featureId: string;
    readonly generation: string;
    readonly profile: WorkflowBinding['profile'];
    readonly team?: string;
    readonly graphProject?: string;
    readonly recovery?: 'same-task' | 'new-task';
  },
) {
  const binding = yield* resolveWorkflowBinding(
    config,
    {
      protocolVersion: 1,
      action: 'bind',
      workflowRunId: 'native-v1-' + input.runId,
      project: input.project,
      featureId: input.featureId,
      generation: input.generation,
      profile: input.profile,
      ...(input.team === undefined ? {} : {team: input.team}),
    },
    input.graphProject,
  );
  const graph = yield* makeWorkflowGraphAdapter(config, binding, {prepare: false, recovery: input.recovery});
  return yield* graph.ready(input.checkout);
});
