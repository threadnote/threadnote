import type {MemoryIdentityEngine} from '@threadnote/recall/index';
import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  WorkflowRequestSchema,
  WorkflowOperationInspectionRequestSchema,
  requiredText,
  validateWorkflowInput,
  type WorkflowRequest,
  type WorkflowJournal,
  workflowError,
} from './protocol.js';
import {resolveWorkflowBinding} from './profile.js';
import {bindWorkflow, loadWorkflowJournal, withWorkflowLock, withWorkflowJournalSession} from './journal.js';
import {executeWorkflowOperation, prepareWorkflowOperation, readWorkflowArtifact} from './artifacts.js';
import {WorkflowPublicationRequestSchema} from './publication_contract.js';
import {assertWorkflowArchivePublication, runWorkflowPublication} from './publication.js';
import {inspectWorkflowOperation} from './inspection.js';

export {readWorkflowReadiness} from './profile.js';

export const runWorkflowMemory = Effect.fn('workflowMemory.run')(function* (config: RuntimeConfig, input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(
    Schema.Union([WorkflowRequestSchema, WorkflowPublicationRequestSchema, WorkflowOperationInspectionRequestSchema]),
  )(input, {onExcessProperty: 'error'});
  if (
    'evidenceRefs' in request &&
    request.evidenceRefs?.length &&
    ['bind', 'capabilities', 'recover'].includes(request.action)
  )
    return yield* workflowError(
      'invalid-request',
      'Evidence is admitted per read or write intent; recovery uses the original saved evidence references.',
    );
  if (request.action === 'capabilities')
    return {
      protocolVersion: 1 as const,
      status: 'ok' as const,
      profiles: ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'],
      operations: [
        'bind',
        'read',
        'inspect-operation',
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
  if (request.action === 'inspect-operation')
    return yield* withWorkflowLock(
      config,
      request.bindingId,
      loadWorkflowJournal(config, request.bindingId, false).pipe(
        Effect.flatMap(state => inspectWorkflowOperation(state, request)),
      ),
    );
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
  const state = yield* loadWorkflowJournal(
    config,
    request.bindingId!,
    !['read', 'preflight'].includes(request.action),
    request,
  );
  return yield* runLoadedRequest(config, state, request);
});

const runLoadedRequest = Effect.fn('workflowMemory.loadedRequest')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  request: WorkflowRequest,
  identityEngine: MemoryIdentityEngine = 'lexical',
) {
  if (request.action === 'read')
    return yield* readWorkflowArtifact(
      config,
      state,
      yield* validateWorkflowInput(() => requiredText(request.uri, 'uri')),
      request.evidenceRefs,
    );
  if (request.action === 'preflight') {
    const prepared = yield* prepareWorkflowOperation(config, state, request, identityEngine);
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
    yield* assertWorkflowArchivePublication(config, state.binding);
  return yield* executeWorkflowOperation(config, state, request, identityEngine);
});

type NativeSessionCall = (
  input: unknown,
) => Effect.Effect<
  unknown,
  Effect.Error<ReturnType<typeof runWorkflowMemory>>,
  Effect.Services<ReturnType<typeof runWorkflowMemory>>
>;
/** App-internal lower dispatcher; its capability expires with the journal lock. */
export const withNativeWorkflowMemorySession = <A, E, R>(
  config: RuntimeConfig,
  bindingId: string,
  use: (
    admission: {readonly state: WorkflowJournal; readonly needsRecovery: boolean},
    call: NativeSessionCall,
  ) => Effect.Effect<A, E, R>,
) =>
  withWorkflowJournalSession(config, bindingId, session => {
    const call: NativeSessionCall = input =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Union([WorkflowRequestSchema, WorkflowOperationInspectionRequestSchema]),
        )(input, {onExcessProperty: 'error'});
        if (
          !['read', 'preflight', 'create', 'replace', 'recover', 'inspect-operation'].includes(request.action) ||
          (request.action === 'preflight' && request.mutation !== 'create' && request.mutation !== 'replace')
        )
          return yield* workflowError('invalid-request', 'Native child sessions cannot bind, archive or publish.');
        if (request.action === 'inspect-operation')
          return yield* session.run(request, state => inspectWorkflowOperation(state, request));
        return yield* session.run(request, state => {
          if (request.action === 'recover' && state.operations[request.operationId ?? '']?.request.action === 'archive')
            return Effect.fail(workflowError('invalid-request', 'Native child sessions cannot recover archives.'));
          return runLoadedRequest(config, state, request, 'identity-projection');
        });
      });
    return use(session.admission, call);
  });
