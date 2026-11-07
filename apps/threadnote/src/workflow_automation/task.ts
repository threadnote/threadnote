import {Effect, FileSystem, Path, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {
  decodeNativeTaskCursor,
  nativeTaskCursorMatches,
  projectNativeTaskView,
} from '@threadnote/workflow-automations/task';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readNativeWorkflowState} from './store.js';
import {runWorkflowAutomation} from './index.js';
import {gitValue} from '../utils.js';

const requestSchema = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  role: Schema.optionalKey(Schema.Literals(['implementation', 'review', 'delivery'])),
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
    const inspection = yield* runWorkflowAutomation(
      config,
      stored.state.cycle
        ? {
            protocolVersion: 1,
            executorVersion: 1,
            action: 'cycle',
            command: 'next',
            runId: stored.state.runId,
            generation: stored.state.generation,
          }
        : {
            protocolVersion: 1,
            executorVersion: 1,
            action: 'inspect',
            runId: stored.state.runId,
            generation: stored.state.generation,
          },
    ).pipe(
      Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}),
      Effect.match({onFailure: error => ({error}), onSuccess: value => ({value})}),
    );
    if ('error' in inspection) {
      if (Schema.is(WorkflowAutomationError)(inspection.error) && inspection.error.code === 'plan-drift')
        return projectNativeTaskView(stored.state, stored.revision, {
          ...(request.role === undefined ? {} : {role: request.role}),
          planDrift: inspection.error.message,
        });
      return yield* inspection.error;
    }
    const inspected = inspection.value;
    const current = yield* readNativeWorkflowState(config, request.runId);
    const inspectedRevision =
      stored.state.cycle &&
      typeof inspected === 'object' &&
      inspected !== null &&
      'cycle' in inspected &&
      typeof inspected.cycle === 'object' &&
      inspected.cycle !== null &&
      'revision' in inspected.cycle
        ? inspected.cycle.revision
        : !stored.state.cycle && current?.revision === stored.revision
          ? stored.revision
          : undefined;
    if (
      typeof inspected !== 'object' ||
      inspected === null ||
      !('status' in inspected) ||
      inspected.status !== 'ok' ||
      inspectedRevision !== stored.revision
    )
      return yield* fail('inspection-failed', 'The native run could not be inspected.');
    const currentView = projectNativeTaskView(stored.state, stored.revision, {
      ...(request.role === undefined ? {} : {role: request.role}),
    });
    if (request.cursor === undefined) return currentView;
    const cursor = decodeNativeTaskCursor(request.cursor);
    if (!cursor || !nativeTaskCursorMatches(cursor, currentView))
      return yield* fail(
        'stale-cursor',
        'This task view changed. Restart with workflow_task_view to get a current task card.',
      );
    return projectNativeTaskView(stored.state, stored.revision, {
      ...(request.role === undefined ? {} : {role: request.role}),
      offset: cursor.offset,
    });
  });
