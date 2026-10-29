import {Array as EffectArray} from 'effect';
import {Crypto, DateTime, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {ResourceStore} from '@threadnote/store/resource-store';
import {trackPotentialWorkflowMutation, verifyWorkflowMutation} from './recall_refresh.js';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {uriSegment} from '@threadnote/store/resource-segment';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  stableJson,
  WorkflowNameFamilySchema,
  WorkflowRequestSchema,
  validateWorkflowInput,
  workflowError,
  WorkflowMemoryError,
  type WorkflowBinding,
  type WorkflowJournal,
  type WorkflowRequest,
  type WorkflowOperationInspectionRequest,
} from './protocol.js';
import {verifyWorkflowBinding} from './profile.js';
import {assertWorkflowJournalIntegrity} from './journal_validation.js';
import {readWorkflowSharedRoots} from './scopes.js';
import {verifyWorkflowEvidence} from './evidence.js';
import {decodeWorkflowJournal, encodeWorkflowJournal, workflowJournalLimits} from './journal_codec.js';
import {workflowStateTopic} from './naming.js';
import {isMemoryCodeCitationRecovery} from '../memory/deferred/code_anchor_scope.js';
import type {DeferredCodeAnchorWriteRequest} from '../memory/deferred/code_anchor.js';
import {CurrentWorkflowReadCache, immutableWorkflowImage} from './read_cache.js';
import {
  decodeWorkflowJournalStorageImage,
  hasPackedWorkflowScopes,
  markPackedWorkflowScopes,
  workflowJournalStorageImage,
} from './journal_storage.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const WorkflowBindingSchema = Schema.Struct({
  bindingId: Schema.String,
  naming: Schema.optionalKey(WorkflowNameFamilySchema),
  workflowRunId: Schema.String,
  profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
  project: Schema.String,
  featureId: Schema.String,
  generation: Schema.String,
  home: Schema.String,
  repo: Schema.String,
  account: Schema.String,
  user: Schema.String,
  agentId: Schema.String,
  team: Schema.optionalKey(Schema.String),
  remote: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  sharedRoots: Schema.Array(Schema.String),
  artifactLifetime: Schema.Literals(['local-home', 'possibly-ephemeral-workspace']),
});
const WorkflowArtifactSchema = Schema.Struct({
  artifactKey: Schema.String,
  sourceRunId: Schema.String,
  role: Schema.String,
  naming: Schema.optionalKey(
    Schema.Struct({
      role: Schema.String,
      version: Schema.Finite,
      archiveOrdinal: Schema.optionalKey(Schema.Finite),
    }),
  ),
  canonicalUri: Schema.String,
  memoryId: Schema.String,
  revision: Schema.String,
  bodySha256: Schema.String,
  storageKind: Schema.Literals(['handoff', 'durable']),
  state: Schema.Literals(['active', 'archived']),
});
const isDeferredCodeAnchorWriteRequest = (value: unknown): value is DeferredCodeAnchorWriteRequest =>
  value !== null &&
  typeof value === 'object' &&
  !EffectArray.isArray(value) &&
  'callerCwd' in value &&
  typeof value.callerCwd === 'string' &&
  'codeRefs' in value &&
  EffectArray.isArray(value.codeRefs) &&
  EffectArray.every(value.codeRefs, (codeRef: unknown) => typeof codeRef === 'string') &&
  (!('project' in value) || value.project === undefined || typeof value.project === 'string') &&
  'recovery' in value &&
  isMemoryCodeCitationRecovery(value.recovery);
const DeferredCodeAnchorWriteRequestSchema = Schema.declare<DeferredCodeAnchorWriteRequest>(
  isDeferredCodeAnchorWriteRequest,
);
const WorkflowRelationSchema = Schema.Struct({
  uri: Schema.String,
  content: Schema.String,
  memoryId: Schema.optionalKey(Schema.String),
  allowedUriScopes: Schema.optionalKey(Schema.Array(Schema.String)),
});
const WorkflowOperationSchema = Schema.Struct({
  deferredCodeAnchor: Schema.optionalKey(DeferredCodeAnchorWriteRequestSchema),
  request: WorkflowRequestSchema,
  intentDigest: Schema.String,
  desired: Schema.String,
  before: Schema.optionalKey(Schema.String),
  sourceUri: Schema.optionalKey(Schema.String),
  artifact: WorkflowArtifactSchema,
  relations: Schema.Array(WorkflowRelationSchema),
  status: Schema.Literals(['prepared', 'verified']),
});
const WorkflowJournalSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  binding: WorkflowBindingSchema,
  artifacts: Schema.Record(Schema.String, WorkflowArtifactSchema),
  operations: Schema.Record(Schema.String, WorkflowOperationSchema),
  manifestUri: Schema.String,
  manifestContent: Schema.String,
  previousManifestContent: Schema.optionalKey(Schema.String),
  manifestCommitted: Schema.Boolean,
});

export const workflowLocation = (config: RuntimeConfig) => ({
  account: config.account,
  home: config.agentContextHome,
  user: config.user,
});
export const readOptionalResource = Effect.fn('workflowMemory.readOptional')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const content = yield* (yield* ResourceStore)
    .read(workflowLocation(config), uri)
    .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
  return typeof content === 'string' ? content : undefined;
});
const journalPath = Effect.fn('workflowMemory.journalPath')(function* (config: RuntimeConfig, bindingId: string) {
  if (!/^[a-f0-9]{64}$/u.test(bindingId))
    return yield* workflowError('invalid-binding', 'Invalid workflow binding identifier.');
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'workflow-memory', `${bindingId}.json`);
});
export function withWorkflowLock<A, E, R>(config: RuntimeConfig, bindingId: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* journalPath(config, bindingId);
    return yield* withExclusiveFileLock(
      fs,
      `${file}.lock`,
      {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 300_000, waitTimeoutMilliseconds: 30_000},
      body,
    );
  });
}

const readJournalFile = Effect.fn('workflowMemory.readJournalFile')(function* (
  config: RuntimeConfig,
  bindingId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* journalPath(config, bindingId);
  if (!(yield* fs.exists(file))) return undefined;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* workflowError('unsafe-journal', 'Workflow journals cannot be symbolic links.');
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > 16 * 1024 * 1024)
    return yield* workflowError('invalid-journal', 'Workflow journal is not a bounded regular file.');
  const text = yield* fs.readFileString(file);
  const cache = yield* CurrentWorkflowReadCache;
  if (cache?.journal?.file === file && cache.journal.bytes === text) return cache.journal.state;
  const state = yield* fromPromiseInterruptible(
    async signal => {
      const decoded = decodeWorkflowJournalStorageImage(
        JSON.parse(await decodeWorkflowJournal(text, signal)) as unknown,
      );
      if (!Schema.is(WorkflowJournalSchema)(decoded) || decoded.binding.bindingId !== bindingId)
        throw new Error('Invalid journal');
      return decoded;
    },
    () =>
      workflowError(
        'invalid-journal',
        'Workflow task state is invalid; restore the original context instead of rebinding.',
      ),
  );
  if (cache) cache.journal = {file, bytes: text, state: immutableWorkflowImage(state)};
  return state;
});

export const writeJournalFile = Effect.fn('workflowMemory.writeJournalFile')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
) {
  const cache = yield* CurrentWorkflowReadCache;
  const compact = cache?.compactJournal || hasPackedWorkflowScopes(state.binding);
  const serialized = yield* validateWorkflowInput(() => serializeWorkflowJournal(state, compact));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* journalPath(config, state.binding.bindingId);
  const directory = path.dirname(file);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  if (
    Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)) ||
    Option.isSome(yield* fs.readLink(file).pipe(Effect.option))
  )
    return yield* workflowError('unsafe-journal', 'Workflow journals cannot be symbolic links.');
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.tmp`;
  yield* fs.writeFileString(temporary, serialized, {mode: 0o600});
  yield* fs.rename(temporary, file).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  if (compact) markPackedWorkflowScopes(state.binding);
  if (cache) cache.journal = {file, bytes: serialized, state: immutableWorkflowImage(state)};
});

export const workflowJournalLogicalBytes = (state: WorkflowJournal, compact = false): number =>
  new TextEncoder().encode(
    stableJson(workflowJournalStorageImage(state, compact || hasPackedWorkflowScopes(state.binding))) + '\n',
  ).byteLength;

export function serializeWorkflowJournal(state: WorkflowJournal, compact = false): string {
  try {
    return encodeWorkflowJournal(
      stableJson(workflowJournalStorageImage(state, compact || hasPackedWorkflowScopes(state.binding))) + '\n',
    );
  } catch {
    throw workflowError(
      'journal-capacity',
      'This workflow has reached its bounded task-state capacity. No new operation was applied; preserve its existing receipts.',
    );
  }
}

/** Plaintext below the disk limit is admissible without running compression for a preview. */
export function assertWorkflowJournalCapacity(state: WorkflowJournal, compact = false): void {
  const content =
    stableJson(workflowJournalStorageImage(state, compact || hasPackedWorkflowScopes(state.binding))) + '\n';
  if (new TextEncoder().encode(content).byteLength <= workflowJournalLimits.diskBytes) return;
  try {
    encodeWorkflowJournal(content);
  } catch {
    throw workflowError(
      'journal-capacity',
      'This workflow has reached its bounded task-state capacity. Preserve its existing receipts.',
    );
  }
}

/** Only replay an exact journaled manifest transition; never reconstruct missing committed state. */
export const reconcileManifest = Effect.fn('workflowMemory.reconcileManifest')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  apply: boolean,
) {
  const store = yield* ResourceStore;
  const current = yield* readOptionalResource(config, state.manifestUri);
  const sharedRoots = yield* readWorkflowSharedRoots(config, state.binding);
  const cache = yield* CurrentWorkflowReadCache;
  const roots = JSON.stringify(sharedRoots);
  yield* Effect.try({
    try: () => {
      if (
        cache?.integrity?.state === state &&
        cache.integrity.manifest === current &&
        cache.integrity.sharedRoots === roots
      )
        return;
      assertWorkflowJournalIntegrity(state, current, sharedRoots, cache);
      if (cache) cache.integrity = {state: immutableWorkflowImage(state), manifest: current, sharedRoots: roots};
    },
    catch: cause =>
      Schema.is(WorkflowMemoryError)(cause)
        ? cause
        : workflowError(
            'invalid-journal',
            'Workflow ownership state differs from its native manifest or exact operation intent.',
          ),
  });
  if (current === state.manifestContent) return;
  if (state.manifestCommitted || current !== state.previousManifestContent)
    return yield* workflowError(
      'task-state-lost',
      'The private workflow manifest is missing or changed. Restore task state; no persisted cloud resume is implied.',
    );
  if (!apply)
    return yield* workflowError(
      'binding-recovery-needed',
      'An interrupted workflow manifest update requires recovery before reading or previewing.',
    );
  yield* trackPotentialWorkflowMutation(config, [state.manifestUri]);
  yield* store.write(workflowLocation(config), state.manifestUri, state.manifestContent, {
    mode: current === undefined ? 'create' : 'replace',
    ...(current === undefined ? {} : {expectedFingerprint: yield* store.fingerprint(current)}),
  });
  if ((yield* store.read(workflowLocation(config), state.manifestUri)) !== state.manifestContent)
    return yield* workflowError('readback-conflict', 'Manifest readback differs from the exact journaled document.');
  yield* verifyWorkflowMutation(config, [state.manifestUri]);
});

export const loadWorkflowJournal = Effect.fn('workflowMemory.loadJournal')(function* (
  config: RuntimeConfig,
  bindingId: string,
  recoverManifest = false,
  admissionRequest?: WorkflowRequest,
) {
  const state = yield* readJournalFile(config, bindingId);
  if (!state)
    return yield* workflowError(
      'task-state-lost',
      'The workflow binding is unavailable. Its local cloud workspace may have expired; do not create a new binding to reinterpret old receipts.',
    );
  yield* verifyWorkflowBinding(config, state.binding);
  // Admission precedes even manifest recovery. Rejected evidence cannot advance
  // a partially committed native transition or reinterpret its pending intent.
  if (admissionRequest) {
    const evidenceRefs =
      admissionRequest.action === 'recover'
        ? state.operations[admissionRequest.operationId ?? '']?.request.evidenceRefs
        : admissionRequest.evidenceRefs;
    yield* verifyWorkflowEvidence(config, state.binding, evidenceRefs);
  }
  yield* reconcileManifest(config, state, recoverManifest);
  return state;
});

/** Native executor inspection may observe an exact pending transition, but never replay it. */
export const inspectWorkflowJournal = Effect.fn('workflowMemory.inspectJournal')(function* (
  config: RuntimeConfig,
  bindingId: string,
) {
  const state = yield* readJournalFile(config, bindingId);
  if (!state)
    return yield* workflowError(
      'task-state-lost',
      'The native memory binding is unavailable. Restore its original state.',
    );
  yield* verifyWorkflowBinding(config, state.binding);
  const needsRecovery = yield* reconcileManifest(config, state, false).pipe(
    Effect.as(false),
    Effect.catchIf(
      error => Schema.is(WorkflowMemoryError)(error) && error.code === 'binding-recovery-needed',
      () => Effect.succeed(true),
    ),
  );
  return {state, needsRecovery};
});

/** Internal capability: one already-held journal lock, never request-supplied. */
export const withWorkflowJournalSession = <A, E, R>(
  config: RuntimeConfig,
  bindingId: string,
  use: (session: {
    readonly admission: Effect.Success<ReturnType<typeof inspectWorkflowJournal>>;
    readonly run: <B, F, S>(
      request: WorkflowRequest | WorkflowOperationInspectionRequest,
      body: (state: WorkflowJournal) => Effect.Effect<B, F, S>,
    ) => Effect.Effect<
      B,
      F | Effect.Error<ReturnType<typeof loadWorkflowJournal>>,
      S | Effect.Services<ReturnType<typeof loadWorkflowJournal>>
    >;
  }) => Effect.Effect<A, E, R>,
) =>
  withWorkflowLock(
    config,
    bindingId,
    Effect.gen(function* () {
      const admission = yield* inspectWorkflowJournal(config, bindingId);
      const owner = yield* Effect.fiberId;
      let active = true;
      let busy = false;
      const run = <B, F, S>(
        request: WorkflowRequest | WorkflowOperationInspectionRequest,
        body: (state: WorkflowJournal) => Effect.Effect<B, F, S>,
      ) =>
        Effect.gen(function* () {
          if (!active || (yield* Effect.fiberId) !== owner || busy || request.bindingId !== bindingId)
            return yield* workflowError(
              'binding-drift',
              'The native memory session is inactive, foreign or already in use.',
            );
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              busy = true;
            }),
            () =>
              Effect.gen(function* () {
                const state = yield* readJournalFile(config, bindingId);
                if (!state || stableJson(state.binding) !== stableJson(admission.state.binding))
                  return yield* workflowError('binding-drift', 'The native memory session binding changed.');
                const evidenceRefs =
                  request.action === 'recover'
                    ? state.operations[request.operationId ?? '']?.request.evidenceRefs
                    : 'evidenceRefs' in request
                      ? request.evidenceRefs
                      : undefined;
                yield* verifyWorkflowEvidence(config, state.binding, evidenceRefs);
                yield* reconcileManifest(
                  config,
                  state,
                  !['read', 'preflight', 'inspect-operation'].includes(request.action),
                );
                const result = yield* body(state);
                if (['create', 'replace', 'recover'].includes(request.action))
                  yield* verifyWorkflowBinding(config, state.binding);
                return result;
              }),
            () =>
              Effect.sync(() => {
                busy = false;
              }),
          );
        });
      return yield* Effect.suspend(() => use({admission, run})).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active = false;
          }),
        ),
      );
    }),
  );

const manifestDocument = (binding: WorkflowBinding, artifacts: WorkflowJournal['artifacts'], timestamp: string) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'handoff',
      status: 'active',
      project: binding.project,
      topic: workflowStateTopic(binding),
      memoryId: `tn_${Effect2.pipe(binding.bindingId, EffectString.slice(0, 20))}`,
      timestamp,
      sourceAgentClient: 'threadnote',
      sourceSessionId: binding.workflowRunId,
    },
    stableJson({protocolVersion: 1, binding, artifacts}),
  );

export const workflowTransition = (
  previous: WorkflowJournal,
  updated: WorkflowJournal,
  timestamp: string,
): WorkflowJournal => ({
  ...updated,
  previousManifestContent: previous.manifestContent,
  manifestContent: manifestDocument(updated.binding, updated.artifacts, timestamp),
  manifestCommitted: false,
});

const validateTransition = Effect.fn('workflowMemory.validateTransition')(function* (
  config: RuntimeConfig,
  previous: WorkflowJournal,
  prepared: WorkflowJournal,
) {
  const sharedRoots = yield* readWorkflowSharedRoots(config, prepared.binding);
  const cache = yield* CurrentWorkflowReadCache;
  yield* Effect.try({
    try: () => assertWorkflowJournalIntegrity(prepared, previous.manifestContent, sharedRoots, cache),
    catch: () =>
      workflowError(
        'operation-transition-conflict',
        'This operation would invalidate workflow ownership or unfinished intent. Recover the existing operations first.',
      ),
  });
});

/** Admit the completion image before writing intent or touching native artifacts. */
export const assertWorkflowTransition = Effect.fn('workflowMemory.transition')(function* (
  config: RuntimeConfig,
  previous: WorkflowJournal,
  updated: WorkflowJournal,
) {
  const prepared = workflowTransition(previous, updated, DateTime.formatIso(yield* DateTime.now));
  const cache = yield* CurrentWorkflowReadCache;
  yield* validateWorkflowInput(() => assertWorkflowJournalCapacity(prepared, cache?.compactJournal));
  yield* validateWorkflowInput(() =>
    assertWorkflowJournalCapacity({...prepared, manifestCommitted: true}, cache?.compactJournal),
  );
  yield* validateTransition(config, previous, prepared);
});

export const persistWorkflowState = Effect.fn('workflowMemory.persistState')(function* (
  config: RuntimeConfig,
  previous: WorkflowJournal,
  updated: WorkflowJournal,
) {
  const prepared = workflowTransition(previous, updated, DateTime.formatIso(yield* DateTime.now));
  yield* validateTransition(config, previous, prepared);
  yield* writeJournalFile(config, prepared);
  yield* reconcileManifest(config, prepared, true);
  const committed = {...prepared, manifestCommitted: true};
  yield* writeJournalFile(config, committed);
  return committed;
});

export const bindWorkflow = Effect.fn('workflowMemory.bind')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  options: {readonly requireEmpty?: boolean} = {},
) {
  const existing = yield* readJournalFile(config, binding.bindingId);
  if (existing) {
    yield* verifyWorkflowBinding(config, existing.binding);
    if (
      options.requireEmpty &&
      (EffectRecord.keys(existing.artifacts).length || EffectRecord.keys(existing.operations).length)
    )
      return yield* workflowError(
        'unsupported-state',
        'A populated memory binding cannot initialize a fresh native run. Restore its original native state or start a new native run.',
      );
    yield* reconcileManifest(config, existing, true);
    if (stableJson(binding) !== stableJson(existing.binding))
      return yield* workflowError('binding-drift', 'Existing workflow binding differs from the requested context.');
    return existing;
  }
  const state: WorkflowJournal = {
    protocolVersion: 1,
    binding,
    artifacts: {},
    operations: {},
    manifestCommitted: false,
    manifestUri: `threadnote://user/${uriSegment(config.user)}/memories/handoffs/active/${uriSegment(binding.project)}/${uriSegment(workflowStateTopic(binding))}.md`,
    manifestContent: manifestDocument(binding, {}, DateTime.formatIso(yield* DateTime.now)),
  };
  yield* writeJournalFile(config, state);
  yield* reconcileManifest(config, state, true);
  const committed = {...state, manifestCommitted: true};
  yield* writeJournalFile(config, committed);
  return committed;
});
