import {Effect, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError, type WorkflowArtifact} from '@threadnote/workflow-automations/contracts';
import {NativeAuthoringDocumentSchema} from '@threadnote/workflow-automations/authoring';
import {NativeCycleStateSchema} from '@threadnote/workflow-automations/cycle';
import {prepareNativeCloseout, NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import {renderNativeDocument} from '@threadnote/workflow-automations/documents';
import {planNativeCloseoutDocuments} from './closeout_documents.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runWorkflowMemory} from '../workflow_memory/index.js';
import {inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {assertWorkflowPublicationVerified, CurrentWorkflowArchivePublication} from '../workflow_memory/publication.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {CurrentNativeCloseoutSave, readNativeWorkflowState} from './store.js';
import {reserveNativeCloseoutCapacity, clearNativeCloseoutCapacity} from './closeout_capacity.js';
import {captureNativeCycleSource} from './cycle_git.js';
import {encodeAuthoringDocument, type NativeAuthoringCall} from './authoring_artifacts.js';
import {nativeWorkflowError} from './memory.js';
import {loadNativeCloseoutInputs} from './closeout_inputs.js';
import {readNativeCloseoutJournal, writeNativeCloseoutJournal, withNativeCloseoutLock} from './closeout_store.js';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const reference = Schema.Struct({uri: text, memoryId: text, revision: digest});
const requestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('closeout'),
  command: Schema.Literals([
    'schema',
    'validation-input',
    'prepare',
    'inspect',
    'finish',
    'publication-preview',
    'publication-approve',
  ]),
  runId: id,
  generation: text,
  proposal: Schema.optionalKey(NativeCloseoutProposalSchema),
  expectedRevision: Schema.optionalKey(Schema.NullOr(digest)),
  approvalDigest: Schema.optionalKey(digest),
  decision: Schema.optionalKey(Schema.Literals(['approve', 'defer', 'reject'])),
  approvalEvidence: Schema.optionalKey(text),
});
const ownedSchema = Schema.Struct({
  runId: id,
  generation: text,
  bindingId: digest,
  artifactKey: id,
  role: id,
  sourceRunId: id,
  uri: text,
  memoryId: text,
  revision: digest,
  operationId: id,
  destination: text,
});
const journalSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-closeout'),
  version: Schema.Literal(1),
  runId: id,
  generation: text,
  bindingId: digest,
  profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
  transactionId: digest,
  source: Schema.Struct({repo: text, head: gitObject, tree: gitObject}),
  cycle: NativeCycleStateSchema,
  plan: NativeAuthoringDocumentSchema,
  spec: Schema.optionalKey(NativeAuthoringDocumentSchema),
  proposal: NativeCloseoutProposalSchema,
  owned: Schema.Array(ownedSchema).check(Schema.isMaxLength(4096)),
  documents: Schema.Array(
    Schema.Struct({
      key: id,
      body: Schema.String.check(Schema.isMaxLength(60000)),
      uri: text,
      relations: Schema.Array(Schema.Struct({type: Schema.Literal('references'), uri: text})).check(
        Schema.isMaxLength(16),
      ),
    }),
  ).check(Schema.isBetweenLength(1, 8192)),
  documentDigest: digest,
  outputs: Schema.Record(id, reference),
  archives: Schema.Record(text, reference),
  approvalDigest: Schema.optionalKey(digest),
  decision: Schema.optionalKey(Schema.Literals(['approve', 'defer', 'reject'])),
  publication: Schema.optionalKey(Schema.Unknown),
  status: Schema.Literals(['prepared', 'archiving', 'complete']),
});
type Journal = typeof journalSchema.Type;
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const attempt = <A>(f: () => A) => Effect.try({try: f, catch: nativeWorkflowError});
const hash = (value: unknown) => sha256HexSync(stableJson(value));
const ref = (artifact: WorkflowArtifact) => ({
  uri: artifact.uri,
  memoryId: artifact.memoryId,
  revision: artifact.revision,
});
const decodeJournal = (input: unknown): Journal => {
  const value = Schema.decodeUnknownSync(journalSchema, {onExcessProperty: 'error'})(input);
  prepareNativeCloseout(value.cycle, value.plan, value.proposal, value.spec);
  if (value.documentDigest !== hash(value.documents))
    throw fail('invalid-closeout-state', 'Admitted final document bytes changed.');
  if (
    value.transactionId !==
      hash({
        runId: value.runId,
        generation: value.generation,
        source: value.source,
        cycle: value.cycle,
        proposal: value.proposal,
      }) ||
    value.owned.some(item => !item.role.startsWith('authoring-') || item.sourceRunId !== item.runId)
  )
    throw fail('invalid-closeout-state', 'Closeout intent or authoring ownership changed.');
  if (
    new Set(value.owned.map(item => item.uri)).size !== value.owned.length ||
    Object.keys(value.archives).some(uri => !value.owned.some(item => item.uri === uri))
  )
    throw fail('invalid-closeout-state', 'Closeout history contains duplicate or unowned archives.');
  return value;
};
const artifact = (input: unknown): WorkflowArtifact => {
  if (!input || typeof input !== 'object') throw fail('invalid-readback', 'Expected verified native memory readback.');
  const value = input as Record<string, unknown>;
  if (
    value.verifiedReadback !== true ||
    typeof value.canonicalUri !== 'string' ||
    typeof value.memoryId !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.body !== 'string' ||
    !['active', 'archived'].includes(String(value.state))
  )
    throw fail('invalid-readback', 'Expected verified native memory readback.');
  return {
    uri: value.canonicalUri,
    memoryId: value.memoryId,
    revision: value.revision,
    body: value.body,
    storageKind: value.storageKind as 'durable' | 'handoff',
    state: value.state as 'active' | 'archived',
  };
};
const summary = (journal: Journal, revision: string) => ({
  protocolVersion: 1,
  executorVersion: 1,
  status: 'ok',
  closeout: {
    runId: journal.runId,
    state: journal.status,
    revision,
    sourceCommit: journal.source.head,
    owned: journal.owned.length,
    archived: Object.keys(journal.archives).length,
    outputs: Object.entries(journal.outputs)
      .filter(([key]) => ['architecture', 'behavior', 'handoff', 'decisions-0', 'history-0'].includes(key))
      .map(([key, reference]) => ({key, ...reference})),
    ...(journal.approvalDigest
      ? {approvalDigest: journal.approvalDigest, decision: journal.decision ?? 'pending'}
      : {}),
  },
});

export const runNativeCloseout = <R>(config: RuntimeConfig, input: unknown, nativeCall: NativeAuthoringCall<R>) =>
  Effect.gen(function* () {
    let activeTransactionId: string | undefined;
    const call: NativeAuthoringCall<R> = request =>
      nativeCall(request).pipe(Effect.provideService(CurrentNativeCloseoutSave, activeTransactionId));
    const request = yield* Schema.decodeUnknownEffect(requestSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(() => fail('invalid-request', 'Provide a valid native closeout request.')),
    );
    if (request.command === 'schema')
      return {
        protocolVersion: 1,
        executorVersion: 1,
        status: 'ok',
        schema: Schema.toJsonSchemaDocument(NativeCloseoutProposalSchema),
      };
    const base = (action: string) => ({
      protocolVersion: 1,
      executorVersion: 1,
      action,
      runId: request.runId,
      generation: request.generation,
    });
    yield* call(base('inspect'));
    return yield* withNativeCloseoutLock(
      config,
      request.runId,
      Effect.gen(function* () {
        let saved = yield* readNativeCloseoutJournal(config, request.runId, decodeJournal);
        activeTransactionId = saved?.state.transactionId;
        if (request.expectedRevision !== undefined && request.expectedRevision !== (saved?.revision ?? null))
          return yield* fail(
            'closeout-conflict',
            'Closeout receipts changed. Read their current revision before retrying.',
          );
        if (request.command === 'validation-input') {
          const inputs = yield* loadNativeCloseoutInputs(config, request.runId, request.generation, call);
          return {
            protocolVersion: 1,
            executorVersion: 1,
            status: 'ok',
            source: inputs.source,
            phases: inputs.cycle.plan.phases.map(phase => ({
              id: phase.id,
              acceptanceCriteria: phase.acceptanceCriteria,
            })),
            scenarios: inputs.spec?.kind === 'spec' ? inputs.spec.scenarios.map(item => ({id: item.id})) : [],
            decisions:
              inputs.plan.kind === 'plan'
                ? inputs.plan.decisions.map(item => ({id: item.id, selected: item.selected}))
                : [],
          };
        }
        if (request.command === 'prepare') {
          if (!request.proposal)
            return yield* fail('invalid-request', 'Provide actual implementation and combined verification evidence.');
          if (saved) {
            if (hash(saved.state.proposal) !== hash(request.proposal))
              return yield* fail(
                'closeout-intent-conflict',
                'Resume this admitted closeout; its evidence cannot be replaced.',
              );
            return summary(saved.state, saved.revision);
          }
          const inputs = yield* loadNativeCloseoutInputs(config, request.runId, request.generation, call);
          const admission = yield* attempt(() =>
            prepareNativeCloseout(inputs.cycle, inputs.plan, request.proposal, inputs.spec),
          );
          // Admit every final document before any knowledge write or retirement.
          yield* attempt(() =>
            [
              admission.documents.architecture,
              ...admission.documents.decisions,
              admission.documents.handoff,
              ...(admission.documents.behavior ? [admission.documents.behavior] : []),
            ].forEach(encodeAuthoringDocument),
          );
          const transactionId = hash({
            runId: request.runId,
            generation: request.generation,
            source: inputs.source,
            cycle: inputs.cycle,
            proposal: request.proposal,
          });
          activeTransactionId = transactionId;
          const owned: Journal['owned'][number][] = [];
          for (const item of inputs.owned) {
            const operationId =
              'closeout-' +
              hash({transactionId, bindingId: item.bindingId, uri: item.uri, revision: item.revision}).slice(0, 48);
            const preview = yield* runWorkflowMemory(config, {
              protocolVersion: 1,
              action: 'preflight',
              mutation: 'archive',
              bindingId: item.bindingId,
              operationId,
              artifactKey: item.artifactKey,
              role: item.role,
              sourceRunId: item.sourceRunId,
              uri: item.uri,
              expectedRevision: item.revision,
            });
            if (!('canonicalUri' in preview) || typeof preview.canonicalUri !== 'string')
              return yield* fail('invalid-readback', 'Archive preflight did not admit its exact destination.');
            owned.push({...item, operationId, destination: preview.canonicalUri});
          }
          const documents = yield* planNativeCloseoutDocuments(admission, owned, (key, body) =>
            call({
              ...base('preflight'),
              operationId: 'closeout-' + transactionId.slice(0, 24) + '-' + key,
              artifactKey: 'closeout-' + transactionId.slice(0, 24) + '-' + key,
              role: 'closeout-' + key,
              nameHint: key,
              body,
              expectedRevision: null,
              storageKind: inputs.state.profile === 'desktop' ? 'durable' : 'handoff',
              codeRefs: admission.architecture.codeRefs,
            }).pipe(
              Effect.flatMap(result =>
                result && typeof result === 'object' && 'uri' in result && typeof result.uri === 'string'
                  ? Effect.succeed({uri: result.uri})
                  : Effect.fail(
                      fail('invalid-readback', 'Final knowledge preflight did not return its exact destination.'),
                    ),
              ),
            ),
          );
          yield* reserveNativeCloseoutCapacity(
            config,
            request.runId,
            transactionId,
            documents,
            admission.architecture.codeRefs,
            owned,
          );
          const journal: Journal = {
            format: 'threadnote-native-closeout',
            version: 1,
            runId: request.runId,
            generation: request.generation,
            bindingId: inputs.binding.bindingId,
            profile: inputs.state.profile,
            transactionId,
            source: inputs.source,
            cycle: inputs.cycle,
            plan: inputs.plan,
            ...(inputs.spec ? {spec: inputs.spec} : {}),
            proposal: request.proposal,
            owned,
            documents,
            documentDigest: hash(documents),
            outputs: {},
            archives: {},
            status: 'prepared',
          };
          saved = yield* writeNativeCloseoutJournal(config, request.runId, journal, null, decodeJournal);
          return summary(saved.state, saved.revision);
        }
        if (!saved)
          return yield* fail('closeout-not-prepared', 'Prepare and verify this native closeout before finishing.');
        let journal = saved.state;
        const save = (next: Journal) =>
          writeNativeCloseoutJournal(config, request.runId, next, saved!.revision, decodeJournal).pipe(
            Effect.tap(value =>
              Effect.sync(() => {
                saved = value;
                journal = value.state;
              }),
            ),
          );
        const current = yield* readNativeWorkflowState(config, request.runId);
        if (
          !current?.state.cycle ||
          journal.bindingId !== current.state.bindingId ||
          journal.generation !== current.state.generation ||
          journal.profile !== current.state.profile ||
          (journal.status !== 'complete' && hash(current.state.cycle.state) !== hash(journal.cycle))
        )
          return yield* fail(
            'closeout-drift',
            'Cycle acceptance, delivery, or native binding changed after closeout admission.',
          );
        if (request.command === 'inspect') return summary(journal, saved.revision);
        if (journal.status === 'complete') {
          yield* clearNativeCloseoutCapacity(config, request.runId, journal.transactionId);
          return summary(journal, saved.revision);
        }
        const source = yield* captureNativeCycleSource(journal.source.repo, journal.source.head);
        if (source.head !== journal.source.head || source.tree !== journal.source.tree)
          return yield* fail(
            'closeout-source-drift',
            'Source changed after combined verification. Keep the original receipts and drafts.',
          );
        yield* reserveNativeCloseoutCapacity(
          config,
          request.runId,
          journal.transactionId,
          journal.documents,
          journal.proposal.architecture.codeRefs,
          journal.owned,
        );
        const admission = yield* attempt(() =>
          prepareNativeCloseout(journal.cycle, journal.plan, journal.proposal, journal.spec),
        );
        const journalState = yield* withWorkflowLock(
          config,
          journal.bindingId,
          inspectWorkflowJournal(config, journal.bindingId),
        );
        const binding = journalState.state.binding;
        const fresh = Effect.gen(function* () {
          const current = yield* readNativeWorkflowState(config, journal.runId);
          if (
            !current?.state.cycle ||
            current.state.bindingId !== journal.bindingId ||
            current.state.generation !== journal.generation ||
            hash(current.state.cycle.state) !== hash(journal.cycle)
          )
            return yield* fail('closeout-drift', 'Cycle acceptance or binding changed; keep remaining drafts.');
          const head = yield* runCommandEffect(
            'git',
            ['--no-optional-locks', '-C', journal.source.repo, 'rev-parse', '--verify', 'HEAD'],
            {timeoutMs: 30_000},
          );
          const dirty = yield* runCommandEffect(
            'git',
            [
              '--no-optional-locks',
              '-C',
              journal.source.repo,
              'status',
              '--porcelain=v2',
              '-z',
              '--ignore-submodules=none',
            ],
            {timeoutMs: 30_000},
          );
          if (head.stdout.trim() !== journal.source.head || dirty.stdout.length !== 0)
            return yield* fail('closeout-source-drift', 'Source changed during closeout; keep remaining drafts.');
        });
        for (const item of journal.owned) {
          const archived = journal.archives[item.uri];
          const owner = yield* withWorkflowLock(config, item.bindingId, inspectWorkflowJournal(config, item.bindingId));
          if (!archived && journal.status === 'archiving' && owner.state.operations[item.operationId]) continue;
          const observed = yield* runWorkflowMemory(config, {
            protocolVersion: 1,
            action: 'read',
            bindingId: item.bindingId,
            uri: archived?.uri ?? item.uri,
          }).pipe(Effect.flatMap(value => attempt(() => artifact(value))));
          if (
            observed.memoryId !== item.memoryId ||
            (archived
              ? observed.state !== 'archived' || observed.revision !== archived.revision
              : observed.state !== 'active' || observed.revision !== item.revision)
          )
            return yield* fail(
              'closeout-owned-drift',
              'An admitted owned draft or archive changed. Keep remaining drafts.',
            );
        }
        const graph = {
          nodes: [
            {
              key: 'architecture',
              role: 'architecture' as const,
              topic: binding.featureId.slice(0, 80) + '-implemented',
              body:
                renderNativeDocument(admission.documents.architecture) +
                '\n' +
                admission.documents.decisions.map(renderNativeDocument).join('\n'),
              codeRefs: [...admission.architecture.codeRefs],
              relations: admission.documents.behavior ? [{type: 'references', nodeKey: 'spec'}] : [],
            },
            ...(admission.documents.behavior
              ? [
                  {
                    key: 'spec',
                    role: 'spec' as const,
                    topic: binding.featureId.slice(0, 80) + '-verified',
                    body: renderNativeDocument(admission.documents.behavior),
                    codeRefs: [...admission.architecture.codeRefs],
                    relations: [{type: 'references', nodeKey: 'architecture'}],
                  },
                ]
              : []),
          ],
        };
        if (request.command === 'publication-preview') {
          if (journal.profile === 'desktop')
            return yield* fail('profile-mismatch', 'Desktop closeout stores private verified knowledge directly.');
          const result = yield* runWorkflowMemory(config, {
            protocolVersion: 1,
            action: 'publication-preview',
            bindingId: journal.bindingId,
            sourceCommit: journal.source.head,
            graph,
          });
          if (!('approvalDigest' in result) || typeof result.approvalDigest !== 'string')
            return yield* fail('invalid-readback', 'Publication preview did not return its approval digest.');
          if (journal.approvalDigest && journal.approvalDigest !== result.approvalDigest)
            return yield* fail(
              'publication-approval-changed',
              'The durable destination or concrete publication graph changed.',
            );
          yield* save({...journal, approvalDigest: result.approvalDigest});
          return {protocolVersion: 1, executorVersion: 1, status: 'ok', publication: result, revision: saved.revision};
        }
        if (request.command === 'publication-approve') {
          if (
            !request.approvalDigest ||
            request.approvalDigest !== journal.approvalDigest ||
            !request.decision ||
            !request.approvalEvidence
          )
            return yield* fail(
              'publication-approval-changed',
              'Approve the exact concrete digest with explicit decision evidence.',
            );
          const result = yield* runWorkflowMemory(config, {
            protocolVersion: 1,
            action: 'publication-approve',
            bindingId: journal.bindingId,
            approvalDigest: request.approvalDigest,
            decision: request.decision,
            approvalEvidence: request.approvalEvidence,
          });
          yield* save({...journal, decision: request.decision});
          return {protocolVersion: 1, executorVersion: 1, status: 'ok', publication: result, revision: saved.revision};
        }
        if (journal.profile !== 'desktop') {
          if (!journal.approvalDigest || journal.decision !== 'approve')
            return yield* fail(
              'publication-incomplete',
              'Keep task-local drafts until their exact durable graph is approved.',
            );
          const publication = yield* runWorkflowMemory(config, {
            protocolVersion: 1,
            action: 'publication-publish',
            bindingId: journal.bindingId,
            approvalDigest: journal.approvalDigest,
          });
          yield* withWorkflowLock(
            config,
            journal.bindingId,
            assertWorkflowPublicationVerified(config, journal.bindingId),
          );
          yield* save({...journal, publication});
        }
        const read = (bindingId: string, uri: string) =>
          runWorkflowMemory(config, {
            protocolVersion: 1,
            action: 'read',
            bindingId,
            uri,
          }).pipe(Effect.flatMap(value => attempt(() => artifact(value))));
        const archiveCall = (request: unknown) =>
          runWorkflowMemory(config, request).pipe(
            Effect.provideService(
              CurrentWorkflowArchivePublication,
              journal.profile === 'desktop'
                ? undefined
                : {
                    bindingId: journal.bindingId,
                    approvalDigest: journal.approvalDigest!,
                  },
            ),
            Effect.flatMap(value => attempt(() => artifact(value))),
          );
        const write = (
          key: string,
          body: string,
          relations: readonly {type: string; uri: string}[] = [],
          replacing = false,
        ) =>
          Effect.gen(function* () {
            const previous = journal.outputs[key];
            if (previous && !replacing) {
              const observed = yield* read(journal.bindingId, previous.uri);
              if (
                observed.memoryId !== previous.memoryId ||
                observed.revision !== previous.revision ||
                observed.body !== body
              )
                return yield* fail(
                  'closeout-output-drift',
                  'Previously verified closeout knowledge changed. Keep remaining drafts.',
                );
              return previous;
            }
            yield* fresh;
            const operationId =
              'closeout-' + journal.transactionId.slice(0, 24) + '-' + key + (replacing ? '-final' : '');
            const existing = (yield* readNativeWorkflowState(config, request.runId))?.state.operations.find(
              item => item.intent.operationId === operationId,
            );
            if (
              existing &&
              (existing.intent.body !== body || stableJson(existing.intent.relations ?? []) !== stableJson(relations))
            )
              return yield* fail(
                'closeout-intent-conflict',
                'A closeout output operation belongs to different admitted knowledge.',
              );
            const result = yield* call(
              existing
                ? {...base('recover'), operationId}
                : {
                    ...base('write'),
                    operationId,
                    artifactKey: 'closeout-' + journal.transactionId.slice(0, 24) + '-' + key,
                    role: 'closeout-' + key,
                    nameHint: key,
                    body,
                    expectedRevision: previous?.revision ?? null,
                    ...(previous ? {uri: previous.uri} : {}),
                    storageKind: journal.profile === 'desktop' ? 'durable' : 'handoff',
                    codeRefs: admission.architecture.codeRefs,
                    relations,
                  },
            );
            if (!result || typeof result !== 'object' || !('artifact' in result))
              return yield* fail('invalid-readback', 'Closeout write did not return its artifact.');
            const value = result.artifact as WorkflowArtifact;
            const observed = yield* read(journal.bindingId, value.uri);
            if (
              observed.memoryId !== value.memoryId ||
              observed.revision !== value.revision ||
              observed.body !== body ||
              observed.state !== 'active'
            )
              return yield* fail('invalid-readback', 'Closeout knowledge failed independent current readback.');
            const reference = ref(observed);
            yield* save({...journal, outputs: {...journal.outputs, [key]: reference}});
            return reference;
          });
        const finalDocuments = new Map(journal.documents.map(document => [document.key, document]));
        const seen = new Set<string>();
        for (const document of journal.documents) {
          if (!seen.has(document.key)) {
            const final = finalDocuments.get(document.key);
            if (final && final !== document) {
              const operationId = 'closeout-' + journal.transactionId.slice(0, 24) + '-' + document.key + '-final';
              const existing = (yield* readNativeWorkflowState(config, request.runId))?.state.operations.find(
                item => item.intent.operationId === operationId,
              );
              if (existing) {
                if (
                  existing.intent.body !== final.body ||
                  existing.intent.uri !== final.uri ||
                  existing.intent.bindingId !== journal.bindingId ||
                  existing.intent.role !== 'closeout-' + document.key ||
                  stableJson(existing.intent.relations ?? []) !== stableJson(final.relations)
                )
                  return yield* fail('closeout-intent-conflict', 'The final output differs from admitted knowledge.');
                // The final native write may have committed before its parent receipt.
                // Recover that original operation below instead of requiring the superseded revision.
                seen.add(document.key);
                continue;
              }
            }
          }
          const observed = yield* write(document.key, document.body, document.relations, seen.has(document.key));
          if (observed.uri !== document.uri)
            return yield* fail(
              'closeout-destination-drift',
              'A knowledge destination changed after final-size admission; keep remaining drafts.',
            );
          seen.add(document.key);
        }
        // Recover an archive whose response or parent receipt was lost, using its original native intent.
        for (const item of journal.owned) {
          if (journal.archives[item.uri]) continue;
          const observed = yield* withWorkflowLock(
            config,
            item.bindingId,
            inspectWorkflowJournal(config, item.bindingId),
          );
          const operation = observed.state.operations[item.operationId];
          if (!operation) continue;
          if (
            journal.status !== 'archiving' ||
            operation.request.action !== 'archive' ||
            operation.sourceUri !== item.uri ||
            operation.request.expectedRevision !== item.revision ||
            operation.artifact.canonicalUri !== item.destination ||
            operation.artifact.memoryId !== item.memoryId
          )
            return yield* fail(
              'closeout-intent-conflict',
              'Archive recovery differs from its original admitted intent.',
            );
          yield* fresh;
          const recovered = yield* archiveCall({
            protocolVersion: 1,
            action: 'recover',
            bindingId: item.bindingId,
            operationId: item.operationId,
          });
          const independentlyRead = yield* read(item.bindingId, recovered.uri);
          if (
            independentlyRead.uri !== item.destination ||
            independentlyRead.memoryId !== item.memoryId ||
            independentlyRead.state !== 'archived' ||
            independentlyRead.revision !== recovered.revision
          )
            return yield* fail('invalid-readback', 'Recovered archive failed independent readback.');
          yield* save({...journal, archives: {...journal.archives, [item.uri]: ref(independentlyRead)}});
        }
        // Check every preimage before the first retirement; retries check all remaining ones.
        for (const item of journal.owned) {
          const archived = journal.archives[item.uri];
          const observed = yield* read(item.bindingId, archived?.uri ?? item.uri);
          if (
            observed.memoryId !== item.memoryId ||
            (archived
              ? observed.state !== 'archived' || observed.revision !== archived.revision
              : observed.state !== 'active' || observed.revision !== item.revision)
          )
            return yield* fail('closeout-owned-drift', 'An owned draft or archive changed. Keep all remaining drafts.');
        }
        yield* save({...journal, status: 'archiving'});
        for (const item of journal.owned) {
          if (journal.archives[item.uri]) continue;
          yield* fresh;
          const archived = yield* archiveCall({
            protocolVersion: 1,
            action: 'archive',
            bindingId: item.bindingId,
            operationId: item.operationId,
            artifactKey: item.artifactKey,
            role: item.role,
            sourceRunId: item.sourceRunId,
            uri: item.uri,
            expectedRevision: item.revision,
          });
          if (archived.uri !== item.destination || archived.memoryId !== item.memoryId || archived.state !== 'archived')
            return yield* fail('invalid-readback', 'Archive result differs from its admitted owned destination.');
          const independentlyRead = yield* read(item.bindingId, archived.uri);
          if (
            independentlyRead.memoryId !== archived.memoryId ||
            independentlyRead.revision !== archived.revision ||
            independentlyRead.state !== 'archived'
          )
            return yield* fail('invalid-readback', 'Archive failed independent current readback.');
          yield* save({...journal, archives: {...journal.archives, [item.uri]: ref(independentlyRead)}});
        }
        yield* save({...journal, status: 'complete'});
        yield* clearNativeCloseoutCapacity(config, request.runId, journal.transactionId);
        return summary(journal, saved.revision);
      }),
    );
  });
