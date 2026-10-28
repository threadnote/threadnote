import {DateTime, Effect, FileSystem, Schema} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {ResourceStore, ResourceNotFound} from '@threadnote/store/resource-store';
import {makeResourceIdScopeChecker, parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import {
  assertMemoryRecordArchivable,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  parseMemoryDocument,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias, memoryIdentityLockKey} from '@threadnote/memory/identity-alias';
import {MemoryPointerNotFound, readMemoryWithRelocations} from '@threadnote/memory/relocation';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {refreshWorkflowRecall, trackPotentialWorkflowMutation} from './recall_refresh.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {preparePersonalMemoryWrite} from '../mcp/server/memory.js';
import {captureMemoryCodeCitationsForMcp} from '../mcp/memory_code_citation.js';
import {
  assertNativeJobLiveSource,
  CurrentNativeJobReadyPromotion,
  CurrentNativeJobSourceView,
} from '../workflow_automation/native_jobs.js';
import {MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {readWorkflowSharedRoots} from './scopes.js';
import {assertWorkflowEvidenceSnapshot, verifyWorkflowEvidence, verifyWorkflowEvidenceBytes} from './evidence.js';
import {
  discardDeferredCodeAnchorIntent,
  discardOtherDeferredCodeAnchorIntents,
  stageDeferredCodeAnchorIntent,
  withDeferredCodeAnchorMutationLocks,
  type DeferredCodeAnchorWriteRequest,
} from '../memory/deferred/code_anchor.js';
import {
  resolveAuthoredMemoryRelations,
  verifyAuthoredMemoryRelationTargetIdentities,
  memoryIdentityWriteLockKeys,
} from '../memory/relations.js';
import {
  readOptionalResource,
  workflowLocation,
  writeJournalFile,
  persistWorkflowState,
  assertWorkflowTransition,
} from './journal.js';
import {assertWorkflowArtifactIdentity} from './artifact_validation.js';
import {reconcileWorkflowCitationEnrichment} from './citation_recovery.js';
import {workflowOwnedArtifacts} from './journal_validation.js';
import {allocateWorkflowArtifactName, workflowArtifactTopic, workflowArchiveUri} from './naming.js';
import {
  portableKey,
  requiredText,
  stableJson,
  workflowError,
  validateWorkflowInput,
  type WorkflowJournal,
  type WorkflowOperation,
  type WorkflowRequest,
  type WorkflowReadResult,
  type WorkflowEvidenceReference,
} from './protocol.js';

const prefix = (state: WorkflowJournal) => `workflow-${state.binding.bindingId}-`;
const nativeRoot = (config: RuntimeConfig) => `threadnote://user/${uriSegment(config.user)}/memories`;
const ownedArtifacts = workflowOwnedArtifacts;
const ownedArtifact = (state: WorkflowJournal, uri: string) =>
  ownedArtifacts(state).find(artifact => artifact.canonicalUri === uri);
function admitPrivateCandidate(
  state: WorkflowJournal,
  uri: string,
  sharedRoots: readonly string[],
  evidenceRefs: readonly WorkflowEvidenceReference[] = [],
): void {
  if (
    parseResourceId(uri).segments.at(-1)?.startsWith('workflow-') &&
    !ownedArtifact(state, uri) &&
    !evidenceRefs.some(ref => ref.uri === uri) &&
    !sharedRoots.some(root => resourceIdIsWithin(uri, root))
  ) {
    throw workflowError('out-of-scope', 'Private artifacts must belong to this workflow.');
  }
}
const allowedScopes = Effect.fn('workflowMemory.allowedScopes')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  readOnly = false,
  evidenceRefs: readonly WorkflowEvidenceReference[] = [],
) {
  const sharedRoots = yield* readWorkflowSharedRoots(config, state.binding);
  const evidenceScopes = yield* verifyWorkflowEvidence(config, state.binding, evidenceRefs);
  const scopes = [
    ...new Set([
      ...sharedRoots,
      ...evidenceScopes,
      ...ownedArtifacts(state).map(artifact => artifact.canonicalUri),
      ...(readOnly && state.binding.profile === 'desktop'
        ? [`${nativeRoot(config)}/durable`, `${nativeRoot(config)}/preferences`, `${nativeRoot(config)}/incidents`]
        : []),
      ...(!readOnly && state.binding.profile === 'desktop'
        ? [`${nativeRoot(config)}/durable`, `${nativeRoot(config)}/preferences`]
        : []),
    ]),
  ];
  return {scopes, sharedRoots};
});
function isExpectedUnwrittenUri(config: RuntimeConfig, state: WorkflowJournal, uri: string): boolean {
  // Readable family prefixes do not grant ownership of similarly named handoffs.
  if (state.binding.naming) return false;
  const roots = [
    `${nativeRoot(config)}/handoffs/active/${uriSegment(state.binding.project)}`,
    ...(state.binding.profile === 'desktop'
      ? [`${nativeRoot(config)}/durable/projects/${uriSegment(state.binding.project)}`]
      : []),
  ];
  return (
    roots.some(root => resourceIdIsWithin(uri, root)) &&
    parseResourceId(uri).segments.at(-1)?.startsWith(prefix(state)) === true
  );
}
const strictRead = Effect.fn('workflowMemory.strictRead')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  input: string,
  evidenceRefs: readonly WorkflowEvidenceReference[] = [],
) {
  const uri = yield* validateWorkflowInput(() => parseResourceId(input).canonicalUri);
  if (
    !ownedArtifact(state, uri) &&
    Object.values(state.operations).some(
      operation => operation.status === 'verified' && operation.artifact.canonicalUri === uri,
    )
  ) {
    // An old receipt permits checking absence, never returning a recreated body
    // or regaining mutation ownership after retirement.
    yield* (yield* ResourceStore).stat(workflowLocation(config), uri);
    return yield* workflowError(
      'out-of-scope',
      'This artifact was retired; historical receipts do not restore ownership.',
    );
  }
  const {scopes, sharedRoots} = yield* allowedScopes(config, state, true, evidenceRefs);
  const expected = isExpectedUnwrittenUri(config, state, uri);
  if (!memoryIdFromIdentityAlias(uri) && !scopes.some(scope => resourceIdIsWithin(uri, scope)) && !expected)
    return yield* workflowError('out-of-scope', 'Memory is outside this workflow and its configured shares.');
  const [resolved] = yield* resolveMemoryIdentityAliases(config, [uri], expected ? [...scopes, uri] : scopes);
  if (!expected)
    yield* validateWorkflowInput(() => admitPrivateCandidate(state, resolved.canonicalUri, sharedRoots, evidenceRefs));
  const live = yield* readMemoryWithRelocations(config, resolved.canonicalUri, {
    allowedUriScopes: [
      ...sharedRoots,
      ...ownedArtifacts(state).map(artifact => artifact.canonicalUri),
      resolved.canonicalUri,
    ],
  });
  yield* verifyResolvedMemoryIdentity(resolved, live.canonicalUri, live.content);
  const owned = ownedArtifact(state, live.canonicalUri);
  const record = parseMemoryDocument(live.canonicalUri, live.content);
  if (!record) return yield* workflowError('invalid-memory', 'The workflow resource is not a native memory.');
  const evidence = evidenceRefs.find(ref => ref.uri === live.canonicalUri);
  if (evidence)
    yield* validateWorkflowInput(() =>
      assertWorkflowEvidenceSnapshot(state.binding, evidence, live.canonicalUri, live.content),
    );
  const workflowTopic = record.metadata.topic?.startsWith('workflow-');
  if (
    (workflowTopic && !owned && !evidence && !sharedRoots.some(root => resourceIdIsWithin(live.canonicalUri, root))) ||
    (state.binding.profile !== 'desktop' &&
      !owned &&
      !sharedRoots.some(root => resourceIdIsWithin(live.canonicalUri, root)))
  )
    return yield* workflowError('out-of-scope', 'Private artifacts must belong to this workflow.');
  if (owned && owned.memoryId !== record.metadata.memoryId)
    return yield* workflowError('identity-conflict', 'The owned artifact changed memory identity.');
  return {live, record, owned};
});

export const readWorkflowArtifact = Effect.fn('workflowMemory.readArtifact')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  uri: string,
  evidenceRefs: readonly WorkflowEvidenceReference[] = [],
) {
  const result = yield* strictRead(config, state, uri, evidenceRefs).pipe(
    Effect.catchIf(
      error => error instanceof MemoryPointerNotFound || Schema.is(ResourceNotFound)(error),
      () => Effect.void,
    ),
  );
  if (!result) return {protocolVersion: 1 as const, status: 'not-found' as const, requestedUri: uri};
  const {live, record, owned} = result;
  const archivePreface = 'Archived original Threadnote memory.\n\n';
  const raw =
    record.metadata.status === 'archived' && record.body.startsWith(archivePreface)
      ? record.body.slice(archivePreface.length)
      : record.body;
  const body = `${raw.trim()}\n`;
  return {
    protocolVersion: 1,
    status: 'ok',
    canonicalUri: live.canonicalUri,
    memoryId: record.metadata.memoryId,
    revision: yield* sha256Hex(live.content),
    state: record.metadata.status ?? 'active',
    storageKind: record.metadata.kind ?? 'handoff',
    role: owned?.role,
    artifactKey: owned?.artifactKey,
    sourceRunId: owned?.sourceRunId,
    codeCitations: record.metadata.codeCitations ?? [],
    relations: record.metadata.relations ?? [],
    sourceCommit: record.metadata.sourceCommit,
    body,
    bodySha256: yield* sha256Hex(body),
    verifiedReadback: true,
  } satisfies WorkflowReadResult;
});

export const prepareWorkflowOperation = Effect.fn('workflowMemory.prepareOperation')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  request: WorkflowRequest,
) {
  const resourceIds = makeResourceIdScopeChecker();
  const action = request.action === 'preflight' ? request.mutation : request.action;
  if (action !== 'create' && action !== 'replace' && action !== 'archive')
    return yield* workflowError('invalid-request', 'Specify create, replace or archive.');
  const normalized: WorkflowRequest = {...request, action, mutation: undefined};
  const {artifactKey, sourceRunId, role} = yield* validateWorkflowInput(() => {
    portableKey(request.operationId, 'operationId');
    return {
      artifactKey: portableKey(request.artifactKey, 'artifactKey'),
      sourceRunId: portableKey(request.sourceRunId, 'sourceRunId'),
      role: portableKey(request.role, 'role'),
    };
  });
  let before: string | undefined;
  let sourceUri: string | undefined;
  let previous: ReturnType<typeof parseMemoryDocument>;
  let original: import('./protocol.js').WorkflowArtifact | undefined;
  if (action !== 'create') {
    sourceUri = yield* validateWorkflowInput(() => resourceIds.parse(requiredText(request.uri, 'uri')).canonicalUri);
    const owned = state.artifacts[sourceUri];
    original = owned;
    if (
      !owned ||
      owned.state !== 'active' ||
      owned.artifactKey !== artifactKey ||
      owned.sourceRunId !== sourceRunId ||
      owned.role !== role
    )
      return yield* workflowError(
        'out-of-scope',
        'Only an active artifact owned by this writer and workflow can be replaced or archived.',
      );
    before = yield* (yield* ResourceStore).read(workflowLocation(config), sourceUri);
    previous = parseMemoryDocument(sourceUri, before);
    if (!previous || previous.metadata.memoryId !== owned.memoryId)
      return yield* workflowError('identity-conflict', 'Artifact identity changed before mutation.');
    if (!request.expectedRevision || (yield* sha256Hex(before)) !== request.expectedRevision)
      return yield* workflowError('revision-conflict', 'Artifact changed after review; refresh before mutating it.');
  } else if (request.uri || request.expectedRevision != null)
    return yield* workflowError(
      'invalid-request',
      'Create requires an absent destination, without a replacement URI or revision.',
    );
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  const naming = yield* allocateWorkflowArtifactName(config, state, request, original);
  let desired: string;
  let canonicalUri: string;
  let metadata: MemoryMetadata;
  let relations: WorkflowOperation['relations'] = [];
  let deferredCodeAnchor: DeferredCodeAnchorWriteRequest | undefined;
  if (action === 'archive') {
    yield* Effect.try(() => assertMemoryRecordArchivable(previous!));
    const archiveMetadata = memoryArchiveMetadata(previous!.metadata, {
      archivedFrom: sourceUri!,
      kind: previous!.metadata.kind ?? 'handoff',
      timestamp,
      sourceAgentClient: 'threadnote',
    });
    metadata = archiveMetadata;
    desired = formatMemoryDocument('MEMORY', archiveMetadata, memoryArchiveBody(previous!.body));
    canonicalUri = workflowArchiveUri(state.binding, {...original!, ...(naming ? {naming} : {})}, request.operationId!);
  } else {
    const body = request.body;
    if (body === undefined || new TextEncoder().encode(body).byteLength > 60_000 || !body.trim())
      return yield* workflowError(
        'invalid-body',
        'Workflow artifacts need a nonempty body of at most 60000 UTF-8 bytes.',
      );
    if (request.bodySha256 !== (yield* sha256Hex(body)))
      return yield* workflowError('body-digest-conflict', 'The supplied body digest does not match the artifact.');
    yield* validateWorkflowInput(() => assertWorkflowArtifactIdentity(state.binding, request));
    const storageKind = state.binding.profile === 'desktop' ? (request.storageKind ?? 'handoff') : 'handoff';
    const memoryId =
      previous?.metadata.memoryId ??
      `tn_${(yield* sha256Hex(`${state.binding.bindingId}\n${sourceRunId}\n${artifactKey}`)).slice(0, 20)}`;
    const {scopes: relationScopes, sharedRoots} = yield* allowedScopes(config, state, false, request.evidenceRefs);
    const relationUris = yield* validateWorkflowInput(() =>
      (request.relations ?? []).map(relation => resourceIds.parse(relation.uri).canonicalUri),
    );
    for (const uri of relationUris)
      if (!memoryIdFromIdentityAlias(uri) && !relationScopes.some(scope => resourceIds.isWithin(uri, scope)))
        return yield* workflowError(
          'out-of-scope',
          'Relation targets must belong to this workflow or its configured shares.',
        );
    const candidates = yield* resolveMemoryIdentityAliases(config, relationUris, relationScopes);
    for (const candidate of candidates) {
      if (!relationScopes.some(scope => resourceIds.isWithin(candidate.canonicalUri, scope)))
        return yield* workflowError('out-of-scope', 'The resolved relation target is outside this workflow scope.');
      yield* validateWorkflowInput(() =>
        admitPrivateCandidate(state, candidate.canonicalUri, sharedRoots, request.evidenceRefs),
      );
    }
    const resolvedRelations = yield* resolveAuthoredMemoryRelations(config, request.relations ?? [], {
      allowedUriScopes: [
        ...sharedRoots,
        ...ownedArtifacts(state).map(artifact => artifact.canonicalUri),
        ...candidates.map(candidate => candidate.canonicalUri),
      ],
      sourceMemoryId: memoryId,
      sourceUri,
    });
    for (const target of resolvedRelations.targets) {
      const record = parseMemoryDocument(target.uri, target.content);
      const evidence = request.evidenceRefs?.find(ref => ref.uri === target.uri);
      if (evidence)
        yield* validateWorkflowInput(() =>
          assertWorkflowEvidenceSnapshot(state.binding, evidence, target.uri, target.content),
        );
      if (
        (record?.metadata.topic?.startsWith('workflow-') ||
          resourceIds.isWithin(target.uri, `${nativeRoot(config)}/handoffs`)) &&
        !ownedArtifact(state, target.uri) &&
        !evidence &&
        !sharedRoots.some(root => resourceIds.isWithin(target.uri, root))
      )
        return yield* workflowError('out-of-scope', 'Private relation targets must belong to the same workflow.');
    }
    relations = resolvedRelations.targets;
    const admitted = yield* CurrentNativeJobSourceView;
    const promotion =
      (role === 'authoring-root' && (yield* CurrentNativeJobReadyPromotion)) || role.startsWith('closeout-');
    if (admitted && admitted.repo !== state.binding.repo)
      return yield* workflowError(
        'binding-drift',
        'Admitted source view does not belong to the original logical repository.',
      );
    if (admitted && !promotion && stableJson(request.codeRefs ?? []) !== stableJson(admitted.citationRefs))
      return yield* workflowError('citation-drift', 'Child code references differ from the admitted citation witness.');
    const captured =
      admitted && !promotion
        ? {ok: true as const, citations: admitted.citations}
        : yield* captureMemoryCodeCitationsForMcp(
            config,
            {callerCwd: state.binding.repo, project: state.binding.project, refs: request.codeRefs ?? []},
            'workflow-memory',
          );
    if (!captured.ok) {
      if (Schema.is(MemoryCodeCitationCaptureError)(captured.failure) && captured.failure.retryable)
        return yield* workflowError(
          'evidence-busy',
          captured.failure.recovery?.code === 'graph-writer-busy'
            ? 'Code evidence is busy. Preserve this binding and operationId; retry the same intent after the current graph writer finishes.'
            : 'Code evidence capture is temporarily unavailable. Preserve this binding and operationId; retry the same intent.',
        );
      if (
        request.citationPolicy !== 'defer' ||
        !Schema.is(MemoryCodeCitationCaptureError)(captured.failure) ||
        !captured.failure.recovery
      )
        return yield* captured.failure;
      deferredCodeAnchor = {
        callerCwd: state.binding.repo,
        project: state.binding.project,
        codeRefs: request.codeRefs ?? [],
        recovery: captured.failure.recovery,
      };
    }
    metadata = {
      kind: storageKind,
      status: 'active',
      timestamp,
      project: state.binding.project,
      topic: workflowArtifactTopic(state.binding, artifactKey, naming),
      memoryId,
      sourceAgentClient: 'threadnote',
      sourceSessionId: state.binding.workflowRunId,
      relations: resolvedRelations.relations,
      codeCitations: captured.ok ? captured.citations : [],
    };
    const prepared = yield* preparePersonalMemoryWrite(config, {
      bodyText: body,
      metadata,
      replaceUri: sourceUri,
      expectedReplaceContent: before,
      expectedReplaceMemoryId: previous?.metadata.memoryId,
    });
    canonicalUri = prepared.memoryUri;
    desired = prepared.memory;
    metadata = prepared.finalMetadata;
    if (sourceUri && sourceUri !== canonicalUri)
      return yield* workflowError('destination-conflict', 'A workflow replacement must preserve its owned URI.');
  }
  if (action === 'create' && (yield* readOptionalResource(config, canonicalUri)) !== undefined)
    return yield* workflowError(
      'already-exists',
      'The create destination already exists. Recover the original operation instead.',
    );
  const record = parseMemoryDocument(canonicalUri, desired)!;
  return {
    request: normalized,
    intentDigest: yield* sha256Hex(stableJson(normalized)),
    desired,
    before,
    sourceUri,
    relations,
    deferredCodeAnchor,
    status: 'prepared',
    artifact: {
      artifactKey,
      sourceRunId,
      role,
      ...(naming ? {naming} : {}),
      canonicalUri,
      memoryId: metadata.memoryId!,
      revision: yield* sha256Hex(desired),
      bodySha256: yield* sha256Hex(`${(action === 'archive' ? previous!.body : record.body).trim()}\n`),
      storageKind: metadata.kind as 'handoff' | 'durable',
      state: action === 'archive' ? 'archived' : 'active',
    },
  } satisfies WorkflowOperation;
});

export const executeWorkflowOperation = Effect.fn('workflowMemory.executeOperation')(function* (
  config: RuntimeConfig,
  initial: WorkflowJournal,
  request: WorkflowRequest,
) {
  const operationId = yield* validateWorkflowInput(() => portableKey(request.operationId, 'operationId'));
  const existing = initial.operations[operationId];
  if (request.action === 'recover' && !existing)
    return yield* workflowError(
      'operation-not-found',
      'No native operation was prepared for this identifier. Replay the exact saved request with the same operationId.',
    );
  const intentDigest = yield* sha256Hex(stableJson({...request, mutation: undefined}));
  if (existing && request.action !== 'recover' && existing.intentDigest !== intentDigest)
    return yield* workflowError('operation-intent-conflict', 'This operationId already belongs to different intent.');
  let operation = existing ?? (yield* prepareWorkflowOperation(config, initial, request));
  let prepared = {...initial, operations: {...initial.operations, [operationId]: operation}};
  const finalArtifacts = {...prepared.artifacts, [operation.artifact.canonicalUri]: operation.artifact};
  if (operation.request.action === 'archive' && operation.sourceUri) delete finalArtifacts[operation.sourceUri];
  if (existing?.status !== 'verified' || operation.request.action === 'archive')
    yield* assertWorkflowTransition(config, prepared, {
      ...prepared,
      artifacts: finalArtifacts,
      operations: {...prepared.operations, [operationId]: {...operation, status: 'verified'}},
    });
  if (!existing) yield* writeJournalFile(config, prepared);
  const store = yield* ResourceStore;
  const fs = yield* FileSystem.FileSystem;
  let artifact = operation.artifact;
  const isArchive = operation.request.action === 'archive';
  if (operation.status === 'verified' && initial.artifacts[artifact.canonicalUri]?.revision !== artifact.revision)
    return yield* workflowError(
      'operation-superseded',
      'A later operation changed or retired this artifact. The earlier operation cannot recreate it.',
    );
  yield* withDeferredCodeAnchorMutationLocks(
    fs,
    config,
    [
      artifact.canonicalUri,
      operation.sourceUri,
      ...operation.relations.map(target => target.uri),
      ...(operation.request.evidenceRefs ?? []).flatMap(ref => [ref.uri, memoryIdentityLockKey(ref.memoryId)]),
      ...memoryIdentityWriteLockKeys(artifact.memoryId, operation.relations),
    ],
    Effect.gen(function* () {
      yield* verifyWorkflowEvidence(config, initial.binding, operation.request.evidenceRefs);
      const current = yield* readOptionalResource(config, artifact.canonicalUri);
      const enriched = yield* reconcileWorkflowCitationEnrichment(config, initial.binding, operation, current);
      if (enriched) {
        yield* trackPotentialWorkflowMutation(config, [enriched.artifact.canonicalUri]);
        operation = {...enriched, status: 'verified'};
        artifact = enriched.artifact;
        prepared = yield* persistWorkflowState(config, prepared, {
          ...prepared,
          artifacts: {...prepared.artifacts, [artifact.canonicalUri]: artifact},
          operations: {...prepared.operations, [operationId]: operation},
        });
      }
      if (operation.status === 'verified' && current !== operation.desired)
        return yield* workflowError(
          'revision-conflict',
          'A verified operation no longer matches its stored artifact; replay cannot restore overwritten or removed state.',
        );
      if (
        current !== undefined &&
        current !== operation.desired &&
        current !== (isArchive ? undefined : operation.before)
      )
        return yield* workflowError(
          'revision-conflict',
          'The destination differs from both the pinned preimage and postimage.',
        );
      if (!isArchive && operation.status !== 'verified')
        yield* trackPotentialWorkflowMutation(config, [
          artifact.canonicalUri,
          ...(operation.sourceUri ? [operation.sourceUri] : []),
        ]);
      if (isArchive) {
        const source = yield* readOptionalResource(config, operation.sourceUri!);
        if (source !== operation.before && !(source === undefined && current === operation.desired))
          return yield* workflowError(
            'revision-conflict',
            'Archive source changed or disappeared without its verified archived copy.',
          );
        if (operation.status !== 'verified' || source !== undefined)
          yield* trackPotentialWorkflowMutation(config, [artifact.canonicalUri, operation.sourceUri!]);
        if (current === undefined)
          yield* store.write(workflowLocation(config), artifact.canonicalUri, operation.desired, {mode: 'create'});
        if (source !== undefined)
          yield* store.remove(workflowLocation(config), operation.sourceUri!, {
            expectedFingerprint: yield* store.fingerprint(operation.before!),
          });
      } else if (current !== operation.desired) {
        const staged = operation.deferredCodeAnchor
          ? yield* stageDeferredCodeAnchorIntent(config, {
              memoryContent: operation.desired,
              memoryMetadata: parseMemoryDocument(artifact.canonicalUri, operation.desired)!.metadata,
              memoryUri: artifact.canonicalUri,
              request: operation.deferredCodeAnchor,
            })
          : undefined;
        const admitted = yield* CurrentNativeJobSourceView;
        const promotion =
          (operation.request.role === 'authoring-root' && (yield* CurrentNativeJobReadyPromotion)) ||
          operation.request.role?.startsWith('closeout-');
        yield* store.writeChecked(
          workflowLocation(config),
          artifact.canonicalUri,
          operation.desired,
          {
            mode: operation.before === undefined ? 'create' : 'replace',
            ...(operation.before === undefined
              ? {}
              : {expectedFingerprint: yield* store.fingerprint(operation.before)}),
          },
          (admitted && promotion ? assertNativeJobLiveSource(admitted) : Effect.void).pipe(
            Effect.andThen(verifyAuthoredMemoryRelationTargetIdentities(config, operation.relations)),
            Effect.andThen(verifyWorkflowEvidenceBytes(config, initial.binding, operation.request.evidenceRefs)),
          ),
        );
        if (staged) yield* discardOtherDeferredCodeAnchorIntents(config, artifact.canonicalUri, staged.intentId);
        else yield* discardDeferredCodeAnchorIntent(config, artifact.canonicalUri);
      }
      if (isArchive) yield* discardDeferredCodeAnchorIntent(config, operation.sourceUri!);
      if ((yield* store.read(workflowLocation(config), artifact.canonicalUri)) !== operation.desired)
        return yield* workflowError(
          'readback-conflict',
          'Artifact readback differs from the exact journaled document.',
        );
    }),
  );
  if (existing?.status === 'verified')
    return {...(yield* readWorkflowArtifact(config, prepared, artifact.canonicalUri)), operationId};
  const artifacts = {...prepared.artifacts, [artifact.canonicalUri]: artifact};
  if (isArchive && operation.sourceUri) delete artifacts[operation.sourceUri];
  const updated = yield* persistWorkflowState(config, prepared, {
    ...prepared,
    artifacts,
    operations: {...prepared.operations, [operationId]: {...operation, status: 'verified'}},
  });
  yield* refreshWorkflowRecall(config, [artifact.canonicalUri, ...(operation.sourceUri ? [operation.sourceUri] : [])]);
  return {...(yield* readWorkflowArtifact(config, updated, artifact.canonicalUri)), operationId};
});
