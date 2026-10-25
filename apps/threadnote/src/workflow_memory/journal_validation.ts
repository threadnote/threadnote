import {Schema} from 'effect';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import {assertWorkflowArtifactIdentity} from './artifact_validation.js';
import {assertWorkflowEvidenceSnapshot, workflowEvidenceScopes} from './evidence.js';
import {workflowFamilyStem, workflowMemoryStem} from '@threadnote/workflow-automations/naming';
import {
  workflowArtifactTopic,
  workflowStateTopic,
  workflowArtifactUri,
  workflowArchiveUri,
  workflowRoleName,
} from './naming.js';
import {
  portableKey,
  stableJson,
  WorkflowRequestSchema,
  workflowError,
  type WorkflowArtifact,
  type WorkflowBinding,
  type WorkflowJournal,
  type WorkflowOperation,
} from './protocol.js';

function check(condition: unknown): asserts condition {
  if (!condition)
    throw workflowError(
      'invalid-journal',
      'Workflow ownership state differs from its native manifest or operation intent.',
    );
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) => stableJson(left) === stableJson(right);
const root = (binding: WorkflowBinding) => `threadnote://user/${uriSegment(binding.user)}/memories`;
const memoryId = (binding: WorkflowBinding, artifact: WorkflowArtifact) =>
  `tn_${sha256HexSync(`${binding.bindingId}\n${artifact.sourceRunId}\n${artifact.artifactKey}`).slice(0, 20)}`;
const activeUri = workflowArtifactUri;
const archiveUri = workflowArchiveUri;

function assertArtifact(binding: WorkflowBinding, artifact: WorkflowArtifact, uri: string): void {
  check(object(artifact));
  portableKey(artifact.artifactKey, 'artifactKey');
  portableKey(artifact.sourceRunId, 'sourceRunId');
  portableKey(artifact.role, 'role');
  check(artifact.storageKind === 'handoff' || (artifact.storageKind === 'durable' && binding.profile === 'desktop'));
  check(artifact.state === 'active' || artifact.state === 'archived');
  check(artifact.canonicalUri === uri && parseResourceId(uri).canonicalUri === uri);
  check(artifact.memoryId === memoryId(binding, artifact));
  check(/^[a-f0-9]{64}$/u.test(artifact.revision) && /^[a-f0-9]{64}$/u.test(artifact.bodySha256));
  if (binding.naming) {
    check(artifact.naming);
    workflowMemoryStem(binding.naming, artifact.naming.role, artifact.naming.version);
  } else check(artifact.naming === undefined);
  if (artifact.state === 'active') {
    check(artifact.naming?.archiveOrdinal === undefined);
    check(uri === activeUri(binding, artifact));
  } else {
    if (binding.naming) {
      check(uri === archiveUri(binding, artifact, ''));
      return;
    }
    const prefix = archiveUri(binding, artifact, '');
    const suffix = uri.slice(prefix.length - 3, -3);
    portableKey(suffix, 'archive operationId');
    check(uri === archiveUri(binding, artifact, suffix));
  }
}

function manifestArtifacts(state: WorkflowJournal, content: string): WorkflowJournal['artifacts'] {
  check(typeof content === 'string');
  const record = parseMemoryDocument(state.manifestUri, content);
  check(record && record.metadata.kind === 'handoff' && record.metadata.status === 'active');
  check(record.metadata.project === state.binding.project);
  check(record.metadata.topic === workflowStateTopic(state.binding));
  check(record.metadata.memoryId === `tn_${state.binding.bindingId.slice(0, 20)}`);
  check(record.metadata.sourceSessionId === state.binding.workflowRunId);
  const parsed: unknown = JSON.parse(record.body);
  check(
    object(parsed) && parsed.protocolVersion === 1 && same(parsed.binding, state.binding) && object(parsed.artifacts),
  );
  const artifacts = parsed.artifacts as WorkflowJournal['artifacts'];
  for (const [uri, artifact] of Object.entries(artifacts)) assertArtifact(state.binding, artifact, uri);
  return artifacts;
}

function assertOperation(state: WorkflowJournal, key: string, operation: WorkflowOperation): void {
  const binding = state.binding;
  // In-memory preparation clears optional fields with undefined; the persisted
  // intent omits them. Validate the same canonical JSON image in both states.
  check(object(operation) && Schema.is(WorkflowRequestSchema)(JSON.parse(stableJson(operation.request))));
  const request = operation.request;
  workflowEvidenceScopes(binding, request.evidenceRefs);
  portableKey(key, 'operationId');
  check(request.operationId === key && request.bindingId === binding.bindingId && request.mutation === undefined);
  check(['create', 'replace', 'archive'].includes(request.action));
  check(operation.status === 'prepared' || operation.status === 'verified');
  check(operation.intentDigest === sha256HexSync(stableJson(request)));
  const artifact = operation.artifact;
  assertArtifact(binding, artifact, artifact?.canonicalUri);
  if (binding.naming && request.action === 'create')
    check(artifact.naming?.role === (request.nameHint ?? workflowRoleName(request.role!)));
  if (binding.naming && request.nameHint !== undefined) check(artifact.naming?.role === request.nameHint);
  check(
    request.artifactKey === artifact.artifactKey &&
      request.sourceRunId === artifact.sourceRunId &&
      request.role === artifact.role,
  );
  check(typeof operation.desired === 'string' && artifact.revision === sha256HexSync(operation.desired));
  const record = parseMemoryDocument(artifact.canonicalUri, operation.desired);
  check(record && record.metadata.memoryId === artifact.memoryId && record.metadata.project === binding.project);
  check(record.metadata.topic === workflowArtifactTopic(binding, artifact.artifactKey, artifact.naming));
  check(record.metadata.sourceSessionId === binding.workflowRunId && record.metadata.kind === artifact.storageKind);
  check(record.metadata.status === artifact.state && record.metadata.sourceAgentClient === 'threadnote');
  if (request.action === 'archive') {
    check(artifact.state === 'archived' && artifact.canonicalUri === archiveUri(binding, artifact, key));
    check(record.metadata.archivedFrom === operation.sourceUri);
  } else {
    check(artifact.state === 'active' && typeof request.body === 'string');
    check(request.bodySha256 === sha256HexSync(request.body));
    check(`${record.body.trim()}\n` === `${request.body.trim()}\n`);
    check(artifact.bodySha256 === sha256HexSync(`${record.body.trim()}\n`));
    check(artifact.storageKind === (binding.profile === 'desktop' ? (request.storageKind ?? 'handoff') : 'handoff'));
    assertWorkflowArtifactIdentity(binding, request);
  }
  if (request.action === 'create') {
    check(
      operation.before === undefined &&
        operation.sourceUri === undefined &&
        request.uri === undefined &&
        request.expectedRevision == null,
    );
  } else {
    check(typeof operation.before === 'string' && operation.sourceUri === request.uri);
    check(operation.sourceUri === activeUri(binding, artifact));
    check(request.expectedRevision === sha256HexSync(operation.before));
    const before = parseMemoryDocument(operation.sourceUri, operation.before);
    check(before && before.metadata.memoryId === artifact.memoryId && before.metadata.status === 'active');
    check(
      before.metadata.topic === workflowArtifactTopic(binding, artifact.artifactKey, artifact.naming) &&
        before.metadata.project === binding.project,
    );
    check(before.metadata.sourceSessionId === binding.workflowRunId && before.metadata.kind === artifact.storageKind);
    if (request.action === 'archive') {
      check(`${record.body.trim()}\n` === `Archived original Threadnote memory.\n\n${before.body.trim()}\n`);
      check(artifact.bodySha256 === sha256HexSync(`${before.body.trim()}\n`));
    }
  }
  check(Array.isArray(operation.relations));
  if (operation.deferredCodeAnchor) {
    check(
      operation.deferredCodeAnchor.callerCwd === binding.repo &&
        operation.deferredCodeAnchor.project === binding.project,
    );
    check(same(operation.deferredCodeAnchor.codeRefs, request.codeRefs ?? []));
  }
}

function assertSourceOwned(operation: WorkflowOperation, artifacts: WorkflowJournal['artifacts']): void {
  if (operation.request.action === 'create') {
    check(artifacts[operation.artifact.canonicalUri] === undefined);
    return;
  }
  const source = artifacts[operation.sourceUri!];
  // Native citation finalization can refresh bytes after the manifest snapshot.
  // Ownership stays pinned here; the prepared before-image hash and native CAS
  // enforce the caller's explicitly refreshed expectedRevision.
  check(source?.state === 'active');
  for (const field of ['artifactKey', 'sourceRunId', 'role', 'memoryId', 'storageKind'] as const)
    check(source[field] === operation.artifact[field]);
  check(
    same(
      source.naming && {...source.naming, archiveOrdinal: undefined},
      operation.artifact.naming && {...operation.artifact.naming, archiveOrdinal: undefined},
    ),
  );
}

function assertPreparedRelations(
  state: WorkflowJournal,
  operation: WorkflowOperation,
  desktopSharedRoots: readonly string[],
): void {
  if (operation.request.action === 'archive') {
    check(operation.relations.length === 0);
    return;
  }
  const owned = workflowOwnedArtifacts(state);
  const sharedRoots = state.binding.profile === 'desktop' ? desktopSharedRoots : state.binding.sharedRoots;
  const scopes = [
    ...sharedRoots,
    ...workflowEvidenceScopes(state.binding, operation.request.evidenceRefs),
    ...owned.map(artifact => artifact.canonicalUri),
    ...(state.binding.profile === 'desktop'
      ? [`${root(state.binding)}/durable`, `${root(state.binding)}/preferences`]
      : []),
  ];
  const allowed = (uri: string) => scopes.some(scope => resourceIdIsWithin(uri, scope));
  for (const target of operation.relations) {
    check(object(target) && typeof target.uri === 'string' && allowed(target.uri));
    check(typeof target.content === 'string');
    const record = parseMemoryDocument(target.uri, target.content);
    check(record && record.metadata.status === 'active' && record.metadata.memoryId === target.memoryId);
    const evidence = operation.request.evidenceRefs?.find(ref => ref.uri === target.uri);
    if (evidence) assertWorkflowEvidenceSnapshot(state.binding, evidence, target.uri, target.content);
    check(target.memoryId === undefined || target.memoryId !== operation.artifact.memoryId);
    if (
      record.metadata.topic?.startsWith('workflow-') ||
      resourceIdIsWithin(target.uri, `${root(state.binding)}/handoffs`)
    )
      check(
        owned.some(artifact => artifact.canonicalUri === target.uri) ||
          evidence !== undefined ||
          sharedRoots.some(scope => resourceIdIsWithin(target.uri, scope)),
      );
    check(
      target.allowedUriScopes === undefined ||
        (Array.isArray(target.allowedUriScopes) && target.allowedUriScopes.every(allowed)),
    );
    check(!target.memoryId || (target.allowedUriScopes?.length ?? 0) > 0);
  }
  const requested = operation.request.relations ?? [];
  const record = parseMemoryDocument(operation.artifact.canonicalUri, operation.desired)!;
  const relations = record.metadata.relations ?? [];
  check(requested.length === relations.length);
  check(same(requested.map(item => item.type).sort(), relations.map(item => item.type).sort()));
  const targets = operation.relations.map(target =>
    target.memoryId ? memoryIdentityAlias(target.memoryId) : target.uri,
  );
  check(relations.every(relation => targets.includes(relation.uri)));
  check(targets.every(uri => relations.some(relation => relation.uri === uri)));
  for (const relation of requested) {
    const id = memoryIdFromIdentityAlias(relation.uri);
    check(
      id
        ? operation.relations.some(target => target.memoryId === id)
        : allowed(parseResourceId(relation.uri).canonicalUri),
    );
  }
}

function citationOnlyTransition(previous: WorkflowArtifact, operation: WorkflowOperation): boolean {
  if (!operation.deferredCodeAnchor || !['create', 'replace'].includes(operation.request.action)) return false;
  if (!same({...previous, revision: operation.artifact.revision}, operation.artifact)) return false;
  const record = parseMemoryDocument(operation.artifact.canonicalUri, operation.desired)!;
  if (!record.metadata.codeCitations?.length || !record.metadata.sourceObservedAt) return false;
  const original = formatMemoryDocument(
    record.headerTitle,
    {
      ...record.metadata,
      codeCitations: [],
      sourceObservedAt: undefined,
      sourceCommit: undefined,
    },
    record.body,
  );
  return sha256HexSync(original) === previous.revision;
}

/** Validate the local intent against native ownership before it grants any resource scope. */
export function assertWorkflowJournalIntegrity(
  state: WorkflowJournal,
  currentManifestContent: string | undefined,
  desktopSharedRoots: readonly string[] = [],
): void {
  check(state.protocolVersion === 1 && object(state.binding) && object(state.artifacts) && object(state.operations));
  const {bindingId, ...identity} = state.binding;
  if (state.binding.naming) workflowFamilyStem(state.binding.naming);
  check(bindingId === sha256HexSync(stableJson(identity)));
  check(
    state.manifestUri ===
      `${root(state.binding)}/handoffs/active/${uriSegment(state.binding.project)}/${uriSegment(workflowStateTopic(state.binding))}.md`,
  );
  const desired = manifestArtifacts(state, state.manifestContent);
  check(same(desired, state.artifacts));
  for (const [key, operation] of Object.entries(state.operations)) assertOperation(state, key, operation);
  for (const operation of Object.values(state.operations).filter(item => item.status === 'prepared')) {
    assertSourceOwned(operation, state.artifacts);
    assertPreparedRelations(state, operation, desktopSharedRoots);
  }
  if (currentManifestContent === state.manifestContent) return;
  // The caller reports missing/changed committed state. It must never repair it.
  if (state.manifestCommitted || currentManifestContent !== state.previousManifestContent) return;
  if (currentManifestContent === undefined) {
    check(Object.keys(state.artifacts).length === 0 && Object.keys(state.operations).length === 0);
    return;
  }
  const previous = manifestArtifacts(state, currentManifestContent);
  const changed = Object.keys({...previous, ...state.artifacts}).filter(
    uri => !same(previous[uri], state.artifacts[uri]),
  );
  if (changed.length === 0) return;
  check(
    Object.values(state.operations).some(operation => {
      if (
        operation.status !== 'verified' ||
        !same(state.artifacts[operation.artifact.canonicalUri], operation.artifact)
      )
        return false;
      const old = previous[operation.artifact.canonicalUri];
      if (changed.length === 1 && old && citationOnlyTransition(old, operation)) return true;
      try {
        assertSourceOwned(operation, previous);
        assertPreparedRelations({...state, artifacts: previous}, operation, desktopSharedRoots);
      } catch {
        return false;
      }
      const next = {...previous, [operation.artifact.canonicalUri]: operation.artifact};
      if (operation.request.action === 'archive') delete next[operation.sourceUri!];
      return same(next, state.artifacts);
    }),
  );
}

/** Completed historical operations are receipts, never additional ownership grants. */
export function workflowOwnedArtifacts(state: WorkflowJournal): readonly WorkflowArtifact[] {
  return [
    ...Object.values(state.artifacts),
    ...Object.values(state.operations)
      .filter(operation => operation.status === 'prepared')
      .map(operation => operation.artifact),
  ];
}
