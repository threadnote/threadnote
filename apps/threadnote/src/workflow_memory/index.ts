import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {WorkflowRequestSchema, requiredText, validateWorkflowInput, type WorkflowRequest} from './protocol.js';
import {resolveWorkflowBinding} from './profile.js';
import {bindWorkflow, loadWorkflowJournal, withWorkflowLock} from './journal.js';
import {executeWorkflowOperation, prepareWorkflowOperation, readWorkflowArtifact} from './artifacts.js';
import {WorkflowPublicationRequestSchema} from './publication_contract.js';
import {assertWorkflowPublicationVerified, runWorkflowPublication} from './publication.js';

export const runWorkflowMemory = Effect.fn('workflowMemory.run')(function* (config: RuntimeConfig, input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(
    Schema.Union([WorkflowRequestSchema, WorkflowPublicationRequestSchema]),
  )(input, {onExcessProperty: 'error'});
  if (request.action === 'capabilities')
    return {
      protocolVersion: 1 as const,
      status: 'ok' as const,
      profiles: ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'],
      operations: [
        'bind',
        'read',
        'preflight',
        'create',
        'replace',
        'archive',
        'recover',
        'publication-preview',
        'publication-approve',
        'publication-publish',
      ],
    };
  if (request.action === 'bind') {
    const binding = yield* resolveWorkflowBinding(config, request);
    return yield* withWorkflowLock(
      config,
      binding.bindingId,
      bindWorkflow(config, binding).pipe(
        Effect.map(state => ({protocolVersion: 1 as const, status: 'ok' as const, binding: state.binding})),
      ),
    );
  }
  if (
    request.action === 'publication-preview' ||
    request.action === 'publication-approve' ||
    request.action === 'publication-publish'
  ) {
    return yield* withWorkflowLock(
      config,
      request.bindingId,
      loadWorkflowJournal(config, request.bindingId).pipe(
        Effect.flatMap(state => runWorkflowPublication(config, state, request)),
      ),
    );
  }
  return yield* withWorkflowLock(
    config,
    yield* validateWorkflowInput(() => requiredText(request.bindingId, 'bindingId')),
    runBoundRequest(config, request),
  );
});

const runBoundRequest = Effect.fn('workflowMemory.boundRequest')(function* (
  config: RuntimeConfig,
  request: WorkflowRequest,
) {
  const state = yield* loadWorkflowJournal(config, request.bindingId!, !['read', 'preflight'].includes(request.action));
  if (request.action === 'read')
    return yield* readWorkflowArtifact(
      config,
      state,
      yield* validateWorkflowInput(() => requiredText(request.uri, 'uri')),
    );
  if (request.action === 'preflight') {
    const prepared = yield* prepareWorkflowOperation(config, state, request);
    return {
      protocolVersion: 1 as const,
      status: 'ok' as const,
      canonicalUri: prepared.artifact.canonicalUri,
      beforeRevision: request.expectedRevision ?? null,
      bodySha256: prepared.artifact.bodySha256,
      storageKind: prepared.artifact.storageKind,
      role: prepared.artifact.role,
    };
  }
  if (
    state.binding.profile !== 'desktop' &&
    (request.action === 'archive' ||
      (request.action === 'recover' && state.operations[request.operationId ?? '']?.request.action === 'archive'))
  )
    yield* assertWorkflowPublicationVerified(config, state.binding.bindingId);
  return yield* executeWorkflowOperation(config, state, request);
});
