import {Array as EffectArray, Option as EffectOption} from 'effect';
import {DateTime, Effect} from 'effect';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {nativeWorkflowIntentDigest, type NativeWorkflowState} from '@threadnote/workflow-automations/native';
import type {WorkflowJournal} from '../workflow_memory/protocol.js';
import {readWorkflowSharedRoots} from '../workflow_memory/scopes.js';
import {workflowOwnedArtifacts} from '../workflow_memory/journal_validation.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {prepareWorkflowOperation} from '../workflow_memory/artifacts.js';
import {serializeWorkflowJournal, workflowTransition} from '../workflow_memory/journal.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {nativeWorkflowError, workflowWriteRequest} from './memory.js';
import {serializeNativeWorkflowState} from './store.js';
import type {NativeCloseoutPlannedDocument} from './closeout_documents.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Read-only byte model, never a substitute for actual write/identity admission.
 * Real preparation validates body, citation and naming with relations omitted;
 * relation snapshots below are used solely to size the concrete postimages.
 */
export const projectNativeCloseoutKnowledge = Effect.fn('workflowAutomation.projectCloseoutKnowledge')(function* (
  config: RuntimeConfig,
  state: NativeWorkflowState,
  original: WorkflowJournal,
  transactionId: string,
  documents: readonly NativeCloseoutPlannedDocument[],
  codeRefs: readonly string[],
) {
  const store = yield* ResourceStore;
  const contents = new Map<string, string>();
  const overlay = {
    ...store,
    read: (location: Parameters<typeof store.read>[0], uri: string, options?: Parameters<typeof store.read>[2]) =>
      contents.has(uri) ? Effect.succeed(contents.get(uri)!) : store.read(location, uri, options),
  };
  let journal = original;
  let native = state;
  const sizes = (nextJournal: WorkflowJournal, nextNative: NativeWorkflowState) =>
    Effect.try({
      try: () => ({
        journal: new TextEncoder().encode(serializeWorkflowJournal(nextJournal, true)).byteLength,
        native: new TextEncoder().encode(serializeNativeWorkflowState(nextNative)).byteLength,
      }),
      catch: nativeWorkflowError,
    });
  const initial = yield* sizes(journal, native);
  let maximumJournal = initial.journal;
  let maximumNative = initial.native;
  let remaining = 0;
  const seen = new Set<string>();
  for (const document of documents) {
    const repeated = seen.has(document.key);
    seen.add(document.key);
    const operationId =
      'closeout-' +
      Effect2.pipe(transactionId, EffectString.slice(0, 24)) +
      '-' +
      document.key +
      (repeated ? '-final' : '');
    const existing = EffectOption.getOrUndefined(
      EffectArray.findFirst(native.operations, operation => operation.intent.operationId === operationId),
    );
    const previous = repeated ? journal.artifacts[document.uri] : undefined;
    const intent: NativeWorkflowState['operations'][number]['intent'] = {
      operationId,
      artifactKey: 'closeout-' + Effect2.pipe(transactionId, EffectString.slice(0, 24)) + '-' + document.key,
      bindingId: state.bindingId,
      sourceRunId: state.runId,
      role: 'closeout-' + document.key,
      nameHint: document.key,
      body: document.body,
      expectedRevision: previous?.revision ?? null,
      ...(previous ? {uri: previous.canonicalUri} : {}),
      storageKind: state.profile === 'desktop' ? 'durable' : 'handoff',
      codeRefs,
      relations: document.relations,
    };
    if (existing) {
      if (
        existing.intent.body !== document.body ||
        stableJson(existing.intent.relations ?? []) !== stableJson(document.relations)
      )
        return yield* nativeWorkflowError(new Error('The reserved closeout output intent changed.'));
      const operation = journal.operations[operationId];
      if (existing.status === 'verified' && operation?.status === 'verified') continue;
    }
    const request = workflowWriteRequest(existing?.intent ?? intent);
    let operation = journal.operations[operationId];
    if (!operation) {
      const base = yield* prepareWorkflowOperation(config, journal, {...request, relations: undefined}).pipe(
        Effect.provideService(ResourceStore, overlay),
      );
      const record = parseMemoryDocument(base.artifact.canonicalUri, base.desired);
      if (!record) return yield* nativeWorkflowError(new Error('Invalid prepared closeout document.'));
      const sharedRoots = yield* readWorkflowSharedRoots(config, journal.binding);
      const scopes = [
        ...sharedRoots,
        ...EffectArray.map(workflowOwnedArtifacts(journal), item => item.canonicalUri),
        ...EffectArray.map(document.relations, item => item.uri),
      ];
      const targets = [];
      const relations = [];
      for (const relation of document.relations) {
        const content = yield* overlay.read(
          {account: config.account, home: config.agentContextHome, user: config.user},
          relation.uri,
        );
        const target = parseMemoryDocument(relation.uri, content);
        if (!target?.metadata.memoryId)
          return yield* nativeWorkflowError(new Error('Missing concrete closeout relation target.'));
        targets.push({allowedUriScopes: scopes, content, memoryId: target.metadata.memoryId, uri: relation.uri});
        relations.push({type: relation.type, uri: memoryIdentityAlias(target.metadata.memoryId)});
      }
      relations.sort(
        (left, right) =>
          Effect2.pipe(left.type, EffectString.localeCompare(right.type)) ||
          Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)),
      );
      targets.sort((left, right) => Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)));
      const desired = document.relations.length
        ? formatMemoryDocument('MEMORY', {...record.metadata, relations}, record.body)
        : base.desired;
      operation = {
        ...base,
        request,
        intentDigest: sha256HexSync(stableJson(request)),
        desired,
        relations: targets,
        artifact: {...base.artifact, revision: sha256HexSync(desired)},
      };
    }
    if (operation.artifact.canonicalUri !== document.uri)
      return yield* nativeWorkflowError(new Error('Closeout output prediction changed.'));
    remaining++;
    const nativeOperation = existing ?? {
      status: 'prepared' as const,
      intent,
      intentDigest: nativeWorkflowIntentDigest(intent, sha256HexSync),
    };
    const pendingNative = existing ? native : {...native, operations: [...native.operations, nativeOperation]};
    const pendingJournal = {...journal, operations: {...journal.operations, [operationId]: operation}};
    const preparedSize = yield* sizes(pendingJournal, pendingNative);
    maximumJournal = Math.max(maximumJournal, preparedSize.journal);
    maximumNative = Math.max(maximumNative, preparedSize.native);
    const transition = workflowTransition(
      pendingJournal,
      {
        ...pendingJournal,
        artifacts: {...pendingJournal.artifacts, [document.uri]: operation.artifact},
        operations: {...pendingJournal.operations, [operationId]: {...operation, status: 'verified' as const}},
      },
      DateTime.formatIso(yield* DateTime.now),
    );
    native = {
      ...pendingNative,
      operations: EffectArray.map(pendingNative.operations, item =>
        item.intent.operationId === operationId
          ? {
              ...item,
              status: 'verified' as const,
              artifact: {
                uri: document.uri,
                memoryId: operation.artifact.memoryId,
                revision: operation.artifact.revision,
                body: document.body,
                storageKind: operation.artifact.storageKind,
                state: 'active' as const,
              },
            }
          : item,
      ),
    };
    const transitionSize = yield* sizes(transition, native);
    journal = {...transition, manifestCommitted: true};
    const committedSize = yield* sizes(journal, native);
    maximumJournal = Math.max(maximumJournal, transitionSize.journal, committedSize.journal);
    maximumNative = Math.max(maximumNative, transitionSize.native, committedSize.native);
    contents.set(document.uri, operation.desired);
  }
  return {
    journal,
    native,
    initialJournalBytes: initial.journal,
    initialNativeBytes: initial.native,
    maximumJournalBytes: maximumJournal + remaining * 4096,
    maximumNativeBytes: maximumNative + remaining * 4096,
  };
});
