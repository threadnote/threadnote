import {Context, Effect, Option} from 'effect';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {
  memoryCodeCitationProjectScopeMatches,
  MemoryCodeCitationCaptureError,
} from '@threadnote/context/citation/capture';
import type {ProjectManifest, RuntimeConfig} from '@threadnote/workspace/config';
import type {DeferredCodeAnchorProjectScopeExpectationV1} from './code_anchor_scope.js';

export interface DeferredCodeAnchorRefreshSchedulerShape {
  readonly schedule: (options: {
    readonly cwd: string;
    readonly key: string;
    readonly manifestPath: string;
    readonly threadnoteHome: string;
    readonly graphProject?: Pick<ProjectManifest, 'graph' | 'name' | 'uri'>;
  }) => Effect.Effect<void>;
}

export class DeferredCodeAnchorRefreshScheduler extends Context.Service<
  DeferredCodeAnchorRefreshScheduler,
  DeferredCodeAnchorRefreshSchedulerShape
>()('@threadnote/threadnote/memory/deferred/code_anchor_scheduler/DeferredCodeAnchorRefreshScheduler') {}

export const scheduleDeferredCodeAnchorWorkspaceRefresh = Effect.fn('memoryCodeAnchor.scheduleWorkspaceRefresh')(
  function* (
    config: Pick<RuntimeConfig, 'agentContextHome' | 'manifestPath'>,
    target: {
      readonly cwd: string;
      readonly worktreeId: string;
      readonly project?: string;
      readonly projectScope?: DeferredCodeAnchorProjectScopeExpectationV1;
    },
  ) {
    const scheduler = yield* Effect.serviceOption(DeferredCodeAnchorRefreshScheduler);
    if (Option.isNone(scheduler)) return;
    const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, target.cwd, target.project);
    const graphProject = route.state === 'selected' ? route.project : undefined;
    const query = yield* CodeGraphQueryService;
    const status = yield* query.status(config.agentContextHome, target.cwd, {
      project: graphProject?.name,
      manifestPath: config.manifestPath,
      observeWorktree: true,
      requestMaintenance: false,
    });
    if (target.projectScope !== undefined && !memoryCodeCitationProjectScopeMatches(status, target.projectScope)) {
      return yield* MemoryCodeCitationCaptureError.make({
        message: 'The selected project graph changed since deferred code citation capture; refresh was not scheduled.',
        retryable: false,
      });
    }
    yield* scheduler.value.schedule({
      cwd: target.cwd,
      key: target.worktreeId,
      manifestPath: config.manifestPath,
      threadnoteHome: config.agentContextHome,
      ...(graphProject === undefined ? {} : {graphProject}),
    });
  },
);

export const scheduleDeferredCodeAnchorIntentRefresh = Effect.fn('memoryCodeAnchor.scheduleIntentRefresh')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome' | 'manifestPath'>,
  intent: {
    readonly callerCwd: string;
    readonly worktreeId: string;
    readonly project?: string;
    readonly projectScope?: DeferredCodeAnchorProjectScopeExpectationV1;
  },
) {
  yield* scheduleDeferredCodeAnchorWorkspaceRefresh(config, {
    cwd: intent.callerCwd,
    worktreeId: intent.worktreeId,
    ...(intent.project === undefined ? {} : {project: intent.project}),
    ...(intent.projectScope === undefined ? {} : {projectScope: intent.projectScope}),
  });
});
