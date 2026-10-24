import {Effect, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {CodeGraphStoreBusyError} from '@threadnote/graph/types';
import {
  WorkflowAutomationError,
  WorkflowMemory,
  type WorkflowArtifact,
  type WorkflowWriteIntent,
} from '@threadnote/workflow-automations/contracts';
import {runWorkflowMemory} from '../workflow_memory/index.js';
import {
  stableJson,
  WorkflowMemoryError,
  type WorkflowBinding,
  type WorkflowRequest,
} from '../workflow_memory/protocol.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export const nativeWorkflowError = (error: unknown): WorkflowAutomationError => {
  if (Schema.is(WorkflowAutomationError)(error)) return error;
  if (Schema.is(CodeGraphStoreBusyError)(error))
    return WorkflowAutomationError.make({
      code: 'evidence-busy',
      message: 'The graph evidence writer is busy. Preserve this run and retry the same operation.',
      retryable: true,
    });
  if (Schema.is(WorkflowMemoryError)(error))
    return WorkflowAutomationError.make({
      code: error.code,
      message: error.message,
      ...(error.code === 'evidence-busy' ? {retryable: true} : {}),
    });
  if (Schema.is(MemoryCodeCitationCaptureError)(error))
    return WorkflowAutomationError.make({
      code: error.retryable ? 'evidence-busy' : 'evidence-unavailable',
      message: error.message,
      retryable: error.retryable,
    });
  return WorkflowAutomationError.make({
    code: 'workflow-operation-failed',
    message: error instanceof Error ? error.message : 'Native workflow operation failed; no success is implied.',
  });
};

/** Exact native intent image. The executor never maintains a second ownership protocol. */
export function workflowWriteRequest(intent: WorkflowWriteIntent): WorkflowRequest {
  return {
    protocolVersion: 1,
    action: intent.expectedRevision === null ? 'create' : 'replace',
    bindingId: intent.bindingId,
    operationId: intent.operationId,
    artifactKey: intent.artifactKey,
    sourceRunId: intent.sourceRunId,
    role: intent.role,
    body: intent.body,
    bodySha256: sha256HexSync(intent.body),
    expectedRevision: intent.expectedRevision,
    ...(intent.uri === undefined ? {} : {uri: intent.uri}),
    ...(intent.storageKind === undefined ? {} : {storageKind: intent.storageKind}),
    ...(intent.codeRefs === undefined ? {} : {codeRefs: intent.codeRefs}),
    ...(intent.relations === undefined ? {} : {relations: intent.relations}),
    ...(intent.evidenceRefs === undefined ? {} : {evidenceRefs: intent.evidenceRefs}),
    citationPolicy: 'require-current',
  };
}

function artifact(result: unknown): WorkflowArtifact {
  if (result === null || typeof result !== 'object')
    throw WorkflowAutomationError.make({
      code: 'invalid-readback',
      message: 'Expected native verified artifact readback.',
    });
  const value = result as Record<string, unknown>;
  if (
    value.status !== 'ok' ||
    value.verifiedReadback !== true ||
    typeof value.canonicalUri !== 'string' ||
    typeof value.memoryId !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.body !== 'string' ||
    !['durable', 'handoff'].includes(String(value.storageKind)) ||
    !['active', 'archived'].includes(String(value.state))
  )
    throw WorkflowAutomationError.make({
      code: value.status === 'not-found' ? 'artifact-not-found' : 'invalid-readback',
      message: 'The native memory boundary did not return an existing verified artifact.',
    });
  return {
    uri: value.canonicalUri,
    memoryId: value.memoryId,
    revision: value.revision,
    body: value.body,
    storageKind: value.storageKind as WorkflowArtifact['storageKind'],
    state: value.state as WorkflowArtifact['state'],
  };
}

/** Capture application services, not scope authority; every call revalidates the native binding. */
export const makeWorkflowMemoryAdapter = Effect.fn('workflowAutomation.memoryAdapter')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof runWorkflowMemory>>>();
  const call = (input: unknown) =>
    runWorkflowMemory(config, input).pipe(Effect.provideContext(context), Effect.mapError(nativeWorkflowError));
  const admitted = (bindingId: string) =>
    bindingId === binding.bindingId
      ? Effect.void
      : Effect.fail(
          WorkflowAutomationError.make({code: 'binding-drift', message: 'This adapter belongs to another native run.'}),
        );
  const readback = (result: unknown) => Effect.try({try: () => artifact(result), catch: nativeWorkflowError});
  return WorkflowMemory.of({
    read: (bindingId, uri, evidenceRefs) =>
      admitted(bindingId).pipe(
        Effect.andThen(
          call({protocolVersion: 1, action: 'read', bindingId, uri, ...(evidenceRefs ? {evidenceRefs} : {})}),
        ),
        Effect.flatMap(readback),
      ),
    preflight: intent => {
      const request = workflowWriteRequest(intent);
      return admitted(intent.bindingId).pipe(
        Effect.andThen(call({...request, action: 'preflight', mutation: request.action})),
        Effect.flatMap(result =>
          'canonicalUri' in result &&
          typeof result.canonicalUri === 'string' &&
          'bodySha256' in result &&
          typeof result.bodySha256 === 'string'
            ? Effect.succeed({uri: result.canonicalUri, bodySha256: result.bodySha256})
            : Effect.fail(
                WorkflowAutomationError.make({code: 'invalid-readback', message: 'Native preflight did not complete.'}),
              ),
        ),
      );
    },
    write: intent =>
      admitted(intent.bindingId).pipe(Effect.andThen(call(workflowWriteRequest(intent))), Effect.flatMap(readback)),
    inspectOperation: intent =>
      admitted(intent.bindingId).pipe(
        Effect.andThen(
          call({
            protocolVersion: 1,
            action: 'inspect-operation',
            bindingId: intent.bindingId,
            generation: binding.generation,
            bindingHash: sha256HexSync(stableJson(binding)),
            operationId: intent.operationId,
            intentDigest: sha256HexSync(stableJson(workflowWriteRequest(intent))),
          }),
        ),
        Effect.flatMap(result =>
          'operationState' in result &&
          ['absent', 'prepared', 'verified'].includes(String(result.operationState)) &&
          'intentDigest' in result
            ? Effect.succeed({
                state: result.operationState as 'absent' | 'prepared' | 'verified',
                intentDigest: result.intentDigest,
              })
            : Effect.fail(
                WorkflowAutomationError.make({
                  code: 'invalid-readback',
                  message: 'Native operation inspection did not complete.',
                }),
              ),
        ),
      ),
    recover: (bindingId, operationId) =>
      admitted(bindingId).pipe(
        Effect.andThen(call({protocolVersion: 1, action: 'recover', bindingId, operationId})),
        Effect.flatMap(readback),
      ),
  });
});
