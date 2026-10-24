import {Crypto, DateTime, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {ResourceStore} from '@threadnote/store/resource-store';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {uriSegment} from '@threadnote/store/resource-segment';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  stableJson,
  validateWorkflowInput,
  workflowError,
  WorkflowMemoryError,
  type WorkflowBinding,
  type WorkflowJournal,
} from './protocol.js';
import {verifyWorkflowBinding} from './profile.js';
import {assertWorkflowJournalIntegrity} from './journal_validation.js';
import {readWorkflowSharedRoots} from './scopes.js';
import {decodeWorkflowJournal, encodeWorkflowJournal} from './journal_codec.js';

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
  return yield* fromPromiseInterruptible(
    async signal => {
      const parsed = JSON.parse(await decodeWorkflowJournal(text, signal)) as WorkflowJournal;
      if (
        parsed.protocolVersion !== 1 ||
        parsed.binding?.bindingId !== bindingId ||
        typeof parsed.manifestContent !== 'string' ||
        typeof parsed.manifestUri !== 'string' ||
        !parsed.artifacts ||
        !parsed.operations ||
        typeof parsed.manifestCommitted !== 'boolean'
      )
        throw new Error('Invalid journal');
      return parsed;
    },
    () =>
      workflowError(
        'invalid-journal',
        'Workflow task state is invalid; restore the original context instead of rebinding.',
      ),
  );
});

export const writeJournalFile = Effect.fn('workflowMemory.writeJournalFile')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
) {
  const serialized = yield* validateWorkflowInput(() => serializeWorkflowJournal(state));
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
});

export function serializeWorkflowJournal(state: WorkflowJournal): string {
  const content = `${stableJson(state)}\n`;
  try {
    return encodeWorkflowJournal(content);
  } catch {
    throw workflowError(
      'journal-capacity',
      'This workflow has reached its bounded task-state capacity. No new operation was applied; preserve its existing receipts.',
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
  yield* Effect.try({
    try: () => assertWorkflowJournalIntegrity(state, current, sharedRoots),
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
  yield* store.write(workflowLocation(config), state.manifestUri, state.manifestContent, {
    mode: current === undefined ? 'create' : 'replace',
    ...(current === undefined ? {} : {expectedFingerprint: yield* store.fingerprint(current)}),
  });
});

export const loadWorkflowJournal = Effect.fn('workflowMemory.loadJournal')(function* (
  config: RuntimeConfig,
  bindingId: string,
  recoverManifest = false,
) {
  const state = yield* readJournalFile(config, bindingId);
  if (!state)
    return yield* workflowError(
      'task-state-lost',
      'The workflow binding is unavailable. Its local cloud workspace may have expired; do not create a new binding to reinterpret old receipts.',
    );
  yield* verifyWorkflowBinding(config, state.binding);
  yield* reconcileManifest(config, state, recoverManifest);
  return state;
});

const manifestDocument = (binding: WorkflowBinding, artifacts: WorkflowJournal['artifacts'], timestamp: string) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'handoff',
      status: 'active',
      project: binding.project,
      topic: `workflow-${binding.bindingId}-manifest`,
      memoryId: `tn_${binding.bindingId.slice(0, 20)}`,
      timestamp,
      sourceAgentClient: 'threadnote',
      sourceSessionId: binding.workflowRunId,
    },
    stableJson({protocolVersion: 1, binding, artifacts}),
  );

const workflowTransition = (
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
  yield* Effect.try({
    try: () => assertWorkflowJournalIntegrity(prepared, previous.manifestContent, sharedRoots),
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
  yield* validateWorkflowInput(() => serializeWorkflowJournal(prepared));
  yield* validateWorkflowInput(() => serializeWorkflowJournal({...prepared, manifestCommitted: true}));
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
) {
  const existing = yield* readJournalFile(config, binding.bindingId);
  if (existing) {
    yield* verifyWorkflowBinding(config, existing.binding);
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
    manifestUri: `threadnote://user/${uriSegment(config.user)}/memories/handoffs/active/${uriSegment(binding.project)}/workflow-${binding.bindingId}-manifest.md`,
    manifestContent: manifestDocument(binding, {}, DateTime.formatIso(yield* DateTime.now)),
  };
  yield* writeJournalFile(config, state);
  yield* reconcileManifest(config, state, true);
  const committed = {...state, manifestCommitted: true};
  yield* writeJournalFile(config, committed);
  return committed;
});
