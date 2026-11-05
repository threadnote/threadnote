import {Effect, FileSystem, Path, Predicate, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {
  decodeNativeTaskCursor,
  nativeTaskCursorMatches,
  nativeTaskCardRef,
  projectNativeTaskView,
} from '@threadnote/workflow-automations/task';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskInspection} from './index.js';
import {gitValue} from '../utils.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';

const requestSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  role: Schema.optionalKey(Schema.Literals(['implementation', 'review', 'delivery'])),
  detail: Schema.optionalKey(Schema.Literals(['summary', 'packet'])),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
});

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});

/** Read the canonical run, then use the guarded native inspection path before projecting a task. */
export const readNativeTaskView = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(requestSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(() => fail('invalid-request', 'Provide runId, an absolute callerCwd, and an optional role.')),
    );
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(request.callerCwd))
      return yield* fail('invalid-request', 'callerCwd must be an absolute checkout path.');
    const callerCwd = yield* fs
      .realPath(request.callerCwd)
      .pipe(Effect.mapError(() => fail('workspace-not-found', 'callerCwd must resolve to an existing checkout.')));
    const checkout = yield* gitValue(['rev-parse', '--show-toplevel'], callerCwd);
    if (!checkout) return yield* fail('workspace-not-found', 'callerCwd must be inside a Git checkout.');
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored) return yield* fail('run-not-found', 'This native run does not exist.');
    const system = yield* SystemInfo;
    const inspected = yield* readNativeTaskInspection(
      config,
      stored.state.runId,
      stored.state.generation,
      request.detail ?? 'summary',
    ).pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
    if (!('revision' in inspected) || inspected.revision !== stored.revision || !('taskAuthoring' in inspected))
      return yield* fail('inspection-failed', 'The native run could not be inspected.');
    const planDrift = 'planDrift' in inspected ? inspected.planDrift : undefined;
    const authoringResult = inspected.taskAuthoring;
    const authoring =
      authoringResult && 'currentPlan' in authoringResult && Predicate.isObject(authoringResult.currentPlan)
        ? authoringResult.currentPlan
        : undefined;
    const afterRead = yield* readNativeWorkflowState(config, request.runId);
    if (afterRead?.revision !== stored.revision)
      return yield* fail('inspection-failed', 'The native run changed while reading its current authoring root.');
    const continueAuthoring = (view: ReturnType<typeof projectNativeTaskView>) => {
      if (!authoring) return view;
      const currentRoot = Predicate.isObject(authoring.root) ? authoring.root : undefined;
      if (authoring.status === 'admitted')
        return view.next.action === 'reconcile-plan' && currentRoot
          ? {
              ...view,
              authoring,
              taskRef: nativeTaskCardRef(
                stored.state,
                stored.revision,
                'reconcile-plan',
                undefined,
                undefined,
                sha256HexSync(
                  stableJson({
                    uri: currentRoot.uri,
                    revision: currentRoot.revision,
                    documentHash: authoring.documentHash,
                    intentHash: authoring.intentHash,
                  }),
                ),
              ),
            }
          : {...view, authoring};
      const reconcileReady = authoring.status === 'awaiting-admission';
      const taskRef = reconcileReady
        ? nativeTaskCardRef(
            stored.state,
            stored.revision,
            'reconcile-plan',
            undefined,
            undefined,
            currentRoot
              ? sha256HexSync(
                  stableJson({
                    uri: currentRoot.uri,
                    revision: currentRoot.revision,
                    documentHash: authoring.documentHash,
                    intentHash: authoring.intentHash,
                  }),
                )
              : undefined,
          )
        : undefined;
      return {
        ...view,
        status: 'blocked' as const,
        ...(taskRef ? {taskRef} : {}),
        next: {action: reconcileReady ? 'reconcile-plan' : 'compact-confirm'},
        missingInputs: [
          ...view.missingInputs,
          authoring.status === 'awaiting-user-confirmation'
            ? 'An actual user response and explicit approve/reject/defer decision for the current intent hash'
            : authoring.status === 'awaiting-review'
              ? 'An accepted review of the exact current document'
              : 'Admission of the confirmed current plan',
        ],
        authoring,
        ...(stored.state.cycle ? {cycleTask: view} : {}),
      };
    };
    const currentView = projectNativeTaskView(stored.state, stored.revision, {
      ...(request.role === undefined ? {} : {role: request.role}),
      ...(planDrift === undefined ? {} : {planDrift}),
    });
    const continuedView = continueAuthoring(currentView);
    if (request.cursor === undefined) return continuedView;
    const cursor = decodeNativeTaskCursor(request.cursor);
    if (!cursor || !nativeTaskCursorMatches(cursor, continuedView))
      return yield* fail(
        'stale-cursor',
        'This task view changed. Restart with workflow_task_view to get a current task card.',
      );
    return continueAuthoring(
      projectNativeTaskView(stored.state, stored.revision, {
        ...(request.role === undefined ? {} : {role: request.role}),
        ...(planDrift === undefined ? {} : {planDrift}),
        offset: cursor.offset,
      }),
    );
  });
