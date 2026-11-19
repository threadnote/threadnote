import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {CodeGraphStoreBusyError, CodeGraphStoreTransientIoError, type CodeGraphStatus} from '@threadnote/graph/types';
import {WorkflowAutomationError, WorkflowGraph} from '@threadnote/workflow-automations/contracts';
import type {NativeWorkflowPolicy} from '@threadnote/workflow-automations/gates';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import type {WorkflowBinding} from '../workflow_memory/protocol.js';
import {requireWorkflowGraphProjectHint, resolveWorkflowGraphScope} from '../workflow_memory/graph_scope.js';
import {resolveWorkflowBinding} from '../workflow_memory/profile.js';
import {nativeWorkflowError} from './memory.js';
import {shellQuote} from '../utils.js';

const isReady = (status: CodeGraphStatus, roots: readonly string[], selectedProject?: string) =>
  status.freshness === 'current' &&
  !status.stale &&
  roots.includes(status.identity.repoRoot) &&
  (selectedProject === undefined ||
    observationFromCodeGraphStatus(status)?.projectScope?.project.name === selectedProject) &&
  status.readySnapshot?.state === 'ready' &&
  status.readySnapshot.commit === status.identity.headCommit &&
  Boolean(status.readySnapshot.graphContentId);

/** One caller-owned preparation followed by a fresh source-bound readiness check. */
export const makeWorkflowGraphAdapter = Effect.fn('workflowAutomation.graphAdapter')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  const query = yield* CodeGraphQueryService;
  const indexer = yield* CodeGraphIndexer;
  const fs = yield* FileSystem.FileSystem;
  // A memory project tag is not a graph scope selector.
  const route = yield* resolveWorkflowGraphScope(config, binding);
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
        // Either the bound path or the checkout storage it now names identifies this checkout.
        const roots = [repo, yield* fs.realPath(repo)];
        let status = yield* query.status(config.agentContextHome, repo, statusOptions);
        if (!isReady(status, roots, binding.graphProject)) {
          yield* indexer.index({
            cwd: repo,
            threadnoteHome: config.agentContextHome,
            ensureVectors: false,
            ...(project ? {project} : {}),
          });
          status = yield* query.status(config.agentContextHome, repo, statusOptions);
        }
        if (!isReady(status, roots, binding.graphProject))
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

const graphWarmIntervalMillis = 30_000;

/**
 * Start a background graph index for a released build, at most once for each checkout every 30 seconds. A recent
 * start counts as warming. A spawn failure never fails the caller.
 */
const warmWorkflowGraph = Effect.fn('workflowAutomation.warmGraph')(
  function* (config: RuntimeConfig, checkout: string, args: readonly string[]) {
    if (!isStandaloneThreadnoteBuild()) return false;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const marker = path.join(config.agentContextHome, 'runtime', 'graph-warm', `${sha256HexSync(checkout)}.txt`);
    const now = yield* Clock.currentTimeMillis;
    const last = yield* fs.readFileString(marker).pipe(Effect.map(Number), Effect.option);
    if (Option.isSome(last) && now - last.value < graphWarmIntervalMillis) return true;
    const started = yield* runDetachedCommandEffect(system.executablePath, args, {
      cwd: checkout,
      env: {...system.environment(), THREADNOTE_HOME: config.agentContextHome},
    });
    // The marker only spaces out warm-ups; a failed write must not report a started index as not started.
    if (started)
      yield* fs
        .makeDirectory(path.dirname(marker), {recursive: true})
        .pipe(Effect.andThen(fs.writeFileString(marker, String(now))), Effect.ignoreCause);
    return started;
  },
  Effect.catchCause(() => Effect.succeed(false)),
);

/**
 * Check a proposed native run's graph scope before init creates its binding or reserves its name. A missing or stale
 * graph is warmed in the background by a released build; a standard run starts without it and defers its code
 * citations, while a strict run still requires exact current evidence before init.
 */
export const requireWorkflowGraphScope = Effect.fn('workflowAutomation.requireGraphScope')(function* (
  config: RuntimeConfig,
  input: {
    readonly checkout: string;
    readonly runId: string;
    readonly project: string;
    readonly featureId: string;
    readonly generation: string;
    readonly profile: WorkflowBinding['profile'];
    readonly policy: NativeWorkflowPolicy;
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
  const route = yield* resolveWorkflowGraphScope(config, binding, input.recovery);
  yield* requireWorkflowGraphProjectHint(config, binding, input.recovery);
  const project = route.state === 'selected' ? route.project.name : undefined;
  const indexArgs = ['graph', 'index', '--no-vectors', ...(project ? ['--project', project] : [])];
  const ready = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const status = yield* (yield* CodeGraphQueryService).status(config.agentContextHome, input.checkout, {
      manifestPath: config.manifestPath,
      ...(project ? {project} : {}),
    });
    return isReady(status, [input.checkout, yield* fs.realPath(input.checkout)], binding.graphProject);
  }).pipe(Effect.orElseSucceed(() => false));
  if (ready) return;
  const warming = yield* warmWorkflowGraph(config, input.checkout, indexArgs);
  if (input.policy === 'strict')
    return yield* WorkflowAutomationError.make({
      code: 'evidence-unavailable',
      message: `A strict run requires an already-published ready graph; ${warming ? 'a background index started; run `threadnote graph status` from callerCwd to see when it is done, then retry' : `run \`threadnote ${EffectArray.join(EffectArray.map(indexArgs, shellQuote), ' ')}\` from callerCwd, then retry`}. No run was created.`,
      retryable: warming,
    });
});
