import {Cause, Effect, Schema} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {CodeGraphStoreBusyError, CodeGraphStoreTransientIoError, type CodeGraphStatus} from '@threadnote/graph/types';
import {WorkflowAutomationError, WorkflowGraph} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {WorkflowBinding} from '../workflow_memory/protocol.js';
import {nativeWorkflowError} from './memory.js';

const isReady = (status: CodeGraphStatus, repo: string) =>
  status.freshness === 'current' &&
  !status.stale &&
  status.identity.repoRoot === repo &&
  status.readySnapshot?.state === 'ready' &&
  status.readySnapshot.commit === status.identity.headCommit &&
  Boolean(status.readySnapshot.graphContentId);

/** One bounded, owned preparation followed by a fresh source-bound readiness check. */
export const makeWorkflowGraphAdapter = Effect.fn('workflowAutomation.graphAdapter')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  const query = yield* CodeGraphQueryService;
  const indexer = yield* CodeGraphIndexer;
  // A memory project tag is not a graph scope selector.
  const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, binding.repo);
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
          yield* indexer
            .index({
              cwd: repo,
              threadnoteHome: config.agentContextHome,
              ensureVectors: false,
              ...(project ? {project} : {}),
            })
            .pipe(
              Effect.timeout('120 seconds'),
              Effect.catchIf(Cause.isTimeoutError, () =>
                Effect.fail(
                  WorkflowAutomationError.make({
                    code: 'evidence-busy',
                    message:
                      'Graph preparation exceeded its bounded wait. Keep this native run and retry when its owner finishes.',
                    retryable: true,
                  }),
                ),
              ),
            );
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
