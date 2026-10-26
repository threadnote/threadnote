import {Context, DateTime, Effect} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  admitNativeAuthoringSave,
  nativeAuthoringPrefixDigest,
  nativeAuthoringSaveByteBudget,
} from '@threadnote/workflow-automations/native';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {
  inspectWorkflowJournal,
  withWorkflowLock,
  workflowJournalLogicalBytes,
  workflowLocation,
  workflowTransition,
  serializeWorkflowJournal,
  assertWorkflowJournalCapacity,
} from '../workflow_memory/journal.js';
import {workflowJournalLimits} from '../workflow_memory/journal_codec.js';
import {readWorkflowSharedRoots} from '../workflow_memory/scopes.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {prepareWorkflowOperation} from '../workflow_memory/artifacts.js';
import type {WorkflowJournal} from '../workflow_memory/protocol.js';
import {projectNativeCloseoutKnowledge} from './closeout_projection.js';
import {nativeWorkflowError} from './memory.js';
import {
  CurrentNativeOperationLimit,
  readNativeWorkflowState,
  withNativeWorkflowLock,
  writeNativeWorkflowState,
} from './store.js';
import type {NativeCloseoutPlannedDocument} from './closeout_documents.js';

const fail = (message: string) => WorkflowAutomationError.make({code: 'closeout-capacity', message});
const utf8 = new TextEncoder();
/** Internal tests may reduce, never enlarge, the storage protocol ceiling. */
export const CurrentNativeCloseoutByteLimit = Context.Reference<number>('threadnote/NativeCloseoutByteLimit', {
  defaultValue: () => 64 * 1024 * 1024,
});
export const CurrentNativeCloseoutStoredByteLimit = Context.Reference<number>(
  'threadnote/NativeCloseoutStoredByteLimit',
  {defaultValue: () => workflowJournalLimits.diskBytes},
);
export interface NativeCloseoutCapacityOwned {
  readonly bindingId: string;
  readonly uri: string;
  readonly revision: string;
  readonly operationId: string;
  readonly artifactKey: string;
  readonly role: string;
  readonly sourceRunId: string;
  readonly memoryId: string;
  readonly destination: string;
}
const archiveCapacity = Effect.fn('workflowAutomation.archiveCapacity')(function* (
  config: RuntimeConfig,
  owned: readonly NativeCloseoutCapacityOwned[],
  controllerBinding: string,
  byteLimit: number,
  storedLimit: number,
  controllerProjection: WorkflowJournal,
) {
  let controllerGrowth = 0;
  let controllerStoredMaximum = 0;
  for (const bindingId of new Set(owned.map(item => item.bindingId))) {
    const growth = yield* withWorkflowLock(
      config,
      bindingId,
      Effect.gen(function* () {
        const current = (yield* inspectWorkflowJournal(config, bindingId)).state;
        const original = bindingId === controllerBinding ? controllerProjection : current;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const checkStored = (stage: typeof original) =>
          Effect.try({
            try: () => {
              assertWorkflowJournalCapacity(stage, true);
              return utf8.encode(serializeWorkflowJournal(stage, true)).byteLength;
            },
            catch: nativeWorkflowError,
          });
        let maximumStored = yield* checkStored(original);
        let projected = original;
        let maximum = workflowJournalLogicalBytes(original, true);
        let remaining = 0;
        for (const item of owned.filter(entry => entry.bindingId === bindingId)) {
          const request = {
            protocolVersion: 1 as const,
            action: 'archive' as const,
            bindingId,
            operationId: item.operationId,
            artifactKey: item.artifactKey,
            role: item.role,
            sourceRunId: item.sourceRunId,
            uri: item.uri,
            expectedRevision: item.revision,
          };
          const existing = projected.operations[item.operationId];
          if (existing) {
            if (
              existing.intentDigest !== sha256HexSync(stableJson(request)) ||
              existing.sourceUri !== item.uri ||
              existing.artifact.canonicalUri !== item.destination ||
              existing.artifact.memoryId !== item.memoryId
            )
              return yield* fail('An existing archive operation differs from the admitted original draft.');
            const store = yield* ResourceStore;
            const content = yield* store
              .read(workflowLocation(config), existing.status === 'verified' ? item.destination : item.uri)
              .pipe(Effect.catch(() => store.read(workflowLocation(config), item.destination)));
            const observed = sha256HexSync(content);
            if (
              observed !== existing.artifact.revision &&
              (existing.status !== 'prepared' || observed !== item.revision)
            )
              return yield* fail('A previously admitted original draft or archive changed.');
            if (existing.status === 'prepared') {
              remaining++;
              const artifacts = {...projected.artifacts, [item.destination]: existing.artifact};
              delete artifacts[item.uri];
              const transition = workflowTransition(
                projected,
                {
                  ...projected,
                  artifacts,
                  operations: {...projected.operations, [item.operationId]: {...existing, status: 'verified' as const}},
                },
                timestamp,
              );
              maximumStored = Math.max(
                maximumStored,
                yield* checkStored(transition),
                yield* checkStored({...transition, manifestCommitted: true}),
              );
              projected = {...transition, manifestCommitted: true};
              maximum = Math.max(
                maximum,
                workflowJournalLogicalBytes(transition, true),
                workflowJournalLogicalBytes(projected, true),
              );
            }
            continue;
          }
          const operation = yield* prepareWorkflowOperation(config, projected, request);
          if (operation.artifact.canonicalUri !== item.destination || operation.artifact.memoryId !== item.memoryId)
            return yield* fail('The admitted archive destination or identity changed.');
          remaining++;
          const prepared = {...projected, operations: {...projected.operations, [item.operationId]: operation}};
          maximum = Math.max(maximum, workflowJournalLogicalBytes(prepared, true));
          maximumStored = Math.max(maximumStored, yield* checkStored(prepared));
          const artifacts = {...prepared.artifacts, [item.destination]: operation.artifact};
          delete artifacts[item.uri];
          const transition = workflowTransition(
            prepared,
            {
              ...prepared,
              artifacts,
              operations: {...prepared.operations, [item.operationId]: {...operation, status: 'verified' as const}},
            },
            timestamp,
          );
          maximumStored = Math.max(
            maximumStored,
            yield* checkStored(transition),
            yield* checkStored({...transition, manifestCommitted: true}),
          );
          projected = {...transition, manifestCommitted: true};
          maximum = Math.max(
            maximum,
            workflowJournalLogicalBytes(transition, true),
            workflowJournalLogicalBytes(projected, true),
          );
        }
        // Exact projection includes both complete before/desired images. Reserve a
        // bounded margin for timestamps and metadata while the real transition runs.
        const finalBytes = maximum + remaining * 4096;
        if (maximumStored + remaining * 4096 > storedLimit)
          return yield* fail(
            'An original authoring journal cannot retain every complete archive receipt within its stored byte limit.',
          );
        if (finalBytes > byteLimit)
          return yield* fail('An original authoring journal cannot retain every complete archive receipt.');
        return {
          logical: Math.max(0, finalBytes - workflowJournalLogicalBytes(original, true)),
          stored: maximumStored + remaining * 4096,
        };
      }),
    );
    if (bindingId === controllerBinding) {
      controllerGrowth += growth.logical;
      controllerStoredMaximum = Math.max(controllerStoredMaximum, growth.stored);
    }
  }
  return {logical: controllerGrowth, storedMaximum: controllerStoredMaximum};
});

export const reserveNativeCloseoutCapacity = Effect.fn('workflowAutomation.reserveNativeCloseoutCapacity')(function* (
  config: RuntimeConfig,
  runId: string,
  transactionId: string,
  plannedDocuments: readonly NativeCloseoutPlannedDocument[],
  codeRefs: readonly string[],
  owned: readonly NativeCloseoutCapacityOwned[] = [],
) {
  const limit = yield* CurrentNativeOperationLimit;
  const storedLimit = Math.min(workflowJournalLimits.diskBytes, yield* CurrentNativeCloseoutStoredByteLimit);
  const byteLimit = Math.min(64 * 1024 * 1024, yield* CurrentNativeCloseoutByteLimit);
  return yield* withNativeWorkflowLock(
    config,
    runId,
    false,
    Effect.gen(function* () {
      const stored = yield* readNativeWorkflowState(config, runId);
      if (!stored) return yield* fail('The original native controller is missing.');
      const state = stored.state;
      if (state.authoringSave) return yield* fail('Finish the admitted authoring save before closeout.');
      const seen = new Set<string>();
      const operationIds = plannedDocuments.map(document => {
        const repeated = seen.has(document.key);
        seen.add(document.key);
        return 'closeout-' + transactionId.slice(0, 24) + '-' + document.key + (repeated ? '-final' : '');
      });
      const intentDigest = sha256HexSync(stableJson({transactionId, plannedDocuments, codeRefs, owned}));
      const prior = state.closeoutSave;
      if (prior) {
        if (
          prior.transactionId !== transactionId ||
          prior.intentDigest !== intentDigest ||
          stableJson(prior.operationIds) !== stableJson(operationIds)
        )
          return yield* fail('A different closeout already owns this finite reservation.');
      }
      if (
        !/^[a-f0-9]{64}$/u.test(transactionId) ||
        !operationIds.length ||
        new Set(operationIds).size !== operationIds.length ||
        (!prior && state.operations.some(operation => operation.status === 'prepared'))
      )
        return yield* fail('Closeout requires a complete unique operation plan and no pending child write.');
      const journal = yield* withWorkflowLock(config, state.bindingId, inspectWorkflowJournal(config, state.bindingId));
      const projection = yield* projectNativeCloseoutKnowledge(
        config,
        state,
        journal.state,
        transactionId,
        plannedDocuments,
        codeRefs,
      );
      const archives = yield* archiveCapacity(
        config,
        owned,
        state.bindingId,
        byteLimit,
        storedLimit,
        projection.journal,
      );
      const archiveGrowth = archives.logical;
      const projectedStoredMaximum = Math.max(projection.maximumJournalBytes, archives.storedMaximum);
      if (projectedStoredMaximum > storedLimit || projection.maximumNativeBytes > storedLimit)
        return yield* fail('The complete knowledge and archive transaction exceeds its stored byte allowance.');
      const currentStoredBytes = yield* Effect.try({
        try: () => utf8.encode(serializeWorkflowJournal(journal.state, true)).byteLength,
        catch: nativeWorkflowError,
      });
      const currentJournalBytes = workflowJournalLogicalBytes(journal.state, true);
      if (prior) {
        if (prior.journalStoredBytesAtStart + prior.reservedStoredBytes > storedLimit)
          return yield* fail('Current stored journal growth no longer fits the original closeout allowance.');
        if (
          prior.journalBytesAtStart + prior.reservedBytes > byteLimit ||
          currentJournalBytes + archiveGrowth > byteLimit
        )
          return yield* fail('Current journal growth no longer fits the original closeout allowance.');
        return prior;
      }
      const sharedRoots = yield* readWorkflowSharedRoots(config, journal.state.binding);
      const reservation = yield* Effect.try({
        try: () => {
          const scopeUris = [
            ...new Set([
              ...sharedRoots,
              ...state.operations.flatMap(operation => (operation.artifact ? [operation.artifact.uri] : [])),
              ...plannedDocuments.flatMap(document => [
                document.uri,
                ...document.relations.map(relation => relation.uri),
              ]),
            ]),
          ];
          const proposedBytes =
            archiveGrowth +
            nativeAuthoringSaveByteBudget({
              contentBytes: plannedDocuments.reduce(
                (total, document) => total + utf8.encode(document.body).byteLength,
                0,
              ),
              evidenceBytes: utf8.encode(stableJson(codeRefs)).byteLength,
              plannedOperations: operationIds.length,
              scopeBytes: utf8.encode(stableJson(scopeUris)).byteLength,
              maximumScopeEntryBytes: Math.max(
                0,
                ...scopeUris.map(uri => utf8.encode(JSON.stringify(uri)).byteLength + 1),
              ),
              requestMetadataBytes: utf8.encode(
                stableJson({binding: journal.state.binding, generation: state.generation, codeRefs}),
              ).byteLength,
            });
          if (
            currentJournalBytes + proposedBytes > byteLimit ||
            utf8.encode(stableJson(state)).byteLength + proposedBytes > byteLimit
          )
            throw fail('The complete knowledge and archive transaction exceeds its journal byte allowance.');

          const capacity = admitNativeAuthoringSave({
            intentDigest,
            rootUri: null,
            operationCount: state.operations.length,
            plannedOperations: operationIds.length,
            journalBytes: workflowJournalLogicalBytes(journal.state, true),
            stateBytes: utf8.encode(stableJson(state)).byteLength,
            plannedBytes: proposedBytes,
            prefixDigest: nativeAuthoringPrefixDigest(state.operations),
            operationLimit: limit,
          });
          const {rootUri: _root, ...fields} = capacity;
          return {
            ...fields,
            transactionId,
            operationIds,
            journalStoredBytesAtStart: currentStoredBytes,
            reservedStoredBytes: Math.max(0, projectedStoredMaximum - currentStoredBytes),
          };
        },
        catch: nativeWorkflowError,
      });
      yield* writeNativeWorkflowState(config, {...state, closeoutSave: reservation}, stored.revision);
      return reservation;
    }),
  ).pipe(Effect.mapError(nativeWorkflowError));
});

export const clearNativeCloseoutCapacity = Effect.fn('workflowAutomation.clearNativeCloseoutCapacity')(function* (
  config: RuntimeConfig,
  runId: string,
  transactionId: string,
) {
  yield* withNativeWorkflowLock(
    config,
    runId,
    false,
    Effect.gen(function* () {
      const stored = yield* readNativeWorkflowState(config, runId);
      if (!stored) return yield* fail('The original native controller is missing.');
      if (!stored.state.closeoutSave) return;
      if (stored.state.closeoutSave.transactionId !== transactionId)
        return yield* fail('Only the admitted closeout can release its reservation.');
      const {closeoutSave: _reservation, ...state} = stored.state;
      yield* writeNativeWorkflowState(config, state, stored.revision);
    }),
  ).pipe(Effect.mapError(nativeWorkflowError));
});
