import {isOneOf} from '@threadnote/platform/validation';
import {
  Array as EffectArray,
  Option as EffectOption,
  Record as EffectRecord,
  String as EffectString,
  Effect,
  FileSystem,
  Path,
  Predicate,
  Schema,
  pipe,
} from 'effect';
import * as Effect2 from 'effect';
import {checkNativeCycleScope} from '@threadnote/workflow-automations/cycle';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError, type WorkflowArtifact} from '@threadnote/workflow-automations/contracts';
import {prepareNativeCloseout, NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import {renderNativeDocument} from '@threadnote/workflow-automations/documents';
import {planNativeCloseoutDocuments} from './closeout_documents.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runWorkflowMemory} from '../workflow_memory/index.js';
import {inspectWorkflowJournal, readOptionalResource, withWorkflowLock} from '../workflow_memory/journal.js';
import {assertWorkflowPublicationVerified, CurrentWorkflowArchivePublication} from '../workflow_memory/publication.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {withWorkflowRecallRefreshBatch} from '../workflow_memory/recall_refresh.js';
import {PublicationWriterReasonSchema} from '../workflow_memory/publication_contract.js';
import {CurrentNativeCloseoutSave, readNativeWorkflowState} from './store.js';
import {
  reserveNativeCloseoutCapacity,
  clearNativeCloseoutCapacity,
  inspectPristineNativeCloseoutCapacity,
  releasePristineNativeCloseoutCapacity,
  nativeCloseoutPlannedOperationIds,
} from './closeout_capacity.js';
import {captureNativeCycleSource} from './cycle_git.js';
import {decodeJournal, nativeCloseoutRequestSchema, type Journal} from './closeout_request_schema.js';
export {nativeCloseoutRequestSchema} from './closeout_request_schema.js';
import {assertNativeJobLiveSource, CurrentNativeJobBoundary, CurrentNativeJobSourceView} from './native_jobs.js';
import {encodeAuthoringDocument, type NativeAuthoringCall} from './authoring_artifacts.js';
import {nativeWorkflowError} from './memory.js';
import {loadNativeCloseoutInputs} from './closeout_inputs.js';
import {
  assertNativeCloseoutJournalCapacity,
  readNativeCloseoutJournal,
  writeNativeCloseoutJournal,
  withNativeCloseoutLock,
} from './closeout_store.js';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const attempt = <A>(f: () => A) => Effect.try({try: f, catch: nativeWorkflowError});
const hash = (value: unknown) => sha256HexSync(stableJson(value));
const ref = (artifact: WorkflowArtifact) => ({
  uri: artifact.uri,
  memoryId: artifact.memoryId,
  revision: artifact.revision,
});
const closeoutArtifactSchema = Schema.Struct({
  uri: Schema.String,
  memoryId: Schema.String,
  revision: Schema.String,
  body: Schema.String,
  storageKind: Schema.Literals(['durable', 'handoff']),
  state: Schema.Literals(['active', 'archived']),
});
const artifact = (input: unknown): WorkflowArtifact => {
  if (!input || typeof input !== 'object' || !Predicate.isObject(input))
    throw fail('invalid-readback', 'Expected verified native memory readback.');
  const value = input;
  if (
    value.verifiedReadback !== true ||
    typeof value.canonicalUri !== 'string' ||
    typeof value.memoryId !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.body !== 'string' ||
    !isOneOf(['durable', 'handoff'], value.storageKind) ||
    !isOneOf(['active', 'archived'], value.state)
  )
    throw fail('invalid-readback', 'Expected verified native memory readback.');
  return {
    uri: value.canonicalUri,
    memoryId: value.memoryId,
    revision: value.revision,
    body: value.body,
    storageKind: value.storageKind,
    state: value.state,
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
    ...(journal.admissionEpoch ? {admissionEpoch: journal.admissionEpoch} : {}),
    retainedAdmissions: journal.history?.length ?? 0,
    owned: journal.owned.length,
    archived: EffectRecord.keys(journal.archives).length,
    outputs: EffectArray.map(
      EffectArray.filter(EffectRecord.toEntries(journal.outputs), ([key]) =>
        ['architecture', 'behavior', 'handoff', 'decisions-0', 'history-0'].includes(key),
      ),
      ([key, reference]) => ({key, ...reference}),
    ),
    ...(journal.approvalDigest
      ? {approvalDigest: journal.approvalDigest, decision: journal.decision ?? 'pending'}
      : {}),
  },
});

/** Every changed path needs a newly accepted current phase; historical merged owners may overlap it. */
export const freshCloseoutChangedPathCoverage = (
  changed: readonly string[],
  phases: Journal['cycle']['plan']['phases'],
  qualified: ReadonlySet<string>,
): string[] | undefined => {
  const covered = new Set<string>();
  for (const path of changed) {
    const owners = EffectArray.filter(phases, phase => qualified.has(phase.id) && checkNativeCycleScope(phase, [path]));
    if (!owners.length) return undefined;
    for (const owner of owners) covered.add(owner.id);
  }
  return [...covered];
};

const freshReadmission = Effect.fn('workflowAutomation.closeout.freshReadmission')(function* (
  previous: Journal,
  current: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  source: Journal['source'],
) {
  const runtime = current.state.cycle;
  if (!runtime || !previous.recovery)
    return yield* fail('closeout-recovery', 'The fenced admission or current cycle is unavailable.');
  const carried = previous.recovery.carriedQualification;
  const baseline =
    carried && hash(carried.source) === hash(source) && carried.cycleRuntimeDigest === hash(runtime)
      ? carried
      : previous.recovery;
  const oldAttempts = new Set(baseline.acceptedAttemptIds);
  const oldSnapshots = new Set(baseline.snapshotIds);
  const snapshots = new Map(EffectArray.map(runtime.snapshots, entry => [entry.snapshot.snapshotId, entry.snapshot]));
  const fresh = new Set(
    pipe(
      runtime.attempts,
      EffectArray.filter(
        item =>
          item.status === 'accepted' &&
          !oldAttempts.has(item.id) &&
          !oldSnapshots.has(item.snapshotId) &&
          EffectArray.some(runtime.reviews, review => review.snapshotId === item.snapshotId),
      ),
      EffectArray.map(item => snapshots.get(item.snapshotId)),
      EffectArray.filter((item): item is NonNullable<typeof item> => !!item && item.tree === source.tree),
      EffectArray.map(item => item.phaseId),
    ),
  );
  const qualified = new Set(
    EffectArray.filter(
      [...fresh],
      id =>
        runtime.state.phases[id]?.validation?.snapshotTree === source.tree &&
        runtime.state.phases[id]?.head === source.head,
    ),
  );
  const affected = new Set<string>(baseline === carried ? carried.affectedPhaseIds : []);
  if (!affected.size) {
    const changed =
      source.head === previous.source.head
        ? []
        : EffectArray.filter(
            EffectString.split(
              (yield* runCommandEffect(
                'git',
                [
                  '--no-optional-locks',
                  '-C',
                  source.repo,
                  'diff',
                  '--no-renames',
                  '--name-only',
                  '-z',
                  previous.source.head,
                  source.head,
                ],
                {timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024},
              )).stdout,
              '\0',
            ),
            Boolean,
          );
    if (changed.length) {
      const coverage = freshCloseoutChangedPathCoverage(changed, runtime.state.plan.phases, qualified);
      if (!coverage)
        return yield* fail(
          'closeout-acceptance-stale',
          'Fresh accepted phase coverage is required for every changed source path.',
        );
      for (const id of coverage) affected.add(id);
    } else
      for (const phase of runtime.state.plan.phases)
        if (hash(runtime.state.phases[phase.id]) !== hash(previous.cycle.phases[phase.id])) affected.add(phase.id);
  }
  if (!affected.size || EffectArray.some([...affected], id => !qualified.has(id)))
    return yield* fail(
      'closeout-acceptance-stale',
      'Fresh affected-phase source review and cycle acceptance are required after the superseded admission.',
    );
  return [...affected];
});

export const runNativeCloseout = <R>(config: RuntimeConfig, input: unknown, nativeCall: NativeAuthoringCall<R>) =>
  Effect.gen(function* () {
    let activeTransactionId: string | undefined;
    const call: NativeAuthoringCall<R> = request =>
      nativeCall(request).pipe(Effect.provideService(CurrentNativeCloseoutSave, activeTransactionId));
    const request = yield* Schema.decodeUnknownEffect(nativeCloseoutRequestSchema, {onExcessProperty: 'error'})(
      input,
    ).pipe(Effect.mapError(() => fail('invalid-request', 'Provide a valid native closeout request.')));
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
        const admittedJob = yield* CurrentNativeJobSourceView;
        const assertJobPrepareBasis = (source: Journal['source'], bindingId: string) =>
          Effect.gen(function* () {
            if (
              admittedJob &&
              (bindingId !== admittedJob.bindingId ||
                source.repo !== admittedJob.repo ||
                source.head !== admittedJob.head ||
                source.tree !== admittedJob.tree)
            )
              return yield* fail('job-source-drift', 'The closeout preparation source changed after job admission.');
          });
        const assertJobPrepareLive = admittedJob ? assertNativeJobLiveSource(admittedJob) : Effect.void;
        if (admittedJob && (request.command === 'prepare' || request.command === 'finish')) {
          const controller = yield* readNativeWorkflowState(config, request.runId);
          const observedEpoch =
            saved?.state.status === 'superseded'
              ? hash({supersededRevision: saved.revision})
              : saved?.state.admissionEpoch;
          if (
            !controller ||
            controller.state.bindingId !== admittedJob.bindingId ||
            controller.state.generation !== request.generation ||
            !controller.state.cycle ||
            hash(controller.state.cycle.state) !== admittedJob.cycleDigest ||
            observedEpoch !== admittedJob.closeoutAdmissionEpoch ||
            (request.command === 'finish' &&
              (!saved ||
                saved.state.status === 'admitting' ||
                saved.state.status === 'superseded' ||
                saved.state.transactionId !== admittedJob.closeoutTransactionId ||
                saved.state.bindingId !== admittedJob.bindingId ||
                saved.state.source.repo !== admittedJob.repo ||
                saved.state.source.head !== admittedJob.head ||
                saved.state.source.tree !== admittedJob.tree ||
                hash(saved.state.cycle) !== admittedJob.cycleDigest ||
                stableJson(saved.state.proposal.architecture.codeRefs) !== stableJson(admittedJob.citationRefs)))
          )
            return yield* fail('job-closeout-drift', 'The admitted closeout job belongs to another admission.');
        }
        if (
          request.expectedRevision !== undefined &&
          request.expectedRevision !== (saved?.revision ?? null) &&
          !(request.command === 'recover' && saved?.state.status === 'superseded')
        )
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
            phases: EffectArray.map(inputs.cycle.plan.phases, phase => ({
              id: phase.id,
              acceptanceCriteria: phase.acceptanceCriteria,
            })),
            scenarios:
              inputs.spec?.kind === 'spec' ? EffectArray.map(inputs.spec.scenarios, item => ({id: item.id})) : [],
            decisions:
              inputs.plan.kind === 'plan'
                ? EffectArray.map(inputs.plan.decisions, item => ({id: item.id, selected: item.selected}))
                : [],
          };
        }
        if (request.command === 'prepare') {
          if (!request.proposal)
            return yield* fail('invalid-request', 'Provide actual implementation and combined verification evidence.');
          if (saved) {
            if (saved.state.status === 'admitting') {
              if (hash(saved.state.proposal) !== hash(request.proposal))
                return yield* fail(
                  'closeout-intent-conflict',
                  'Resume or recover the original admitted proposal first.',
                );
              const inputs = yield* loadNativeCloseoutInputs(config, request.runId, request.generation, call);
              if (hash(inputs.source) !== hash(saved.state.source) || hash(inputs.cycle) !== hash(saved.state.cycle))
                return yield* fail('closeout-drift', 'The uncommitted readmission source or acceptance changed.');
              yield* assertJobPrepareBasis(inputs.source, inputs.binding.bindingId);
              yield* assertJobPrepareLive;
              yield* reserveNativeCloseoutCapacity(
                config,
                request.runId,
                saved.state.transactionId,
                saved.state.documents,
                saved.state.proposal.architecture.codeRefs,
                saved.state.owned,
              );
              const prepared: Journal = {...saved.state, status: 'prepared'};
              const resumed = yield* writeNativeCloseoutJournal(
                config,
                request.runId,
                prepared,
                saved.revision,
                decodeJournal,
              );
              return summary(resumed.state, resumed.revision);
            }
            if (saved.state.status !== 'superseded') {
              if (hash(saved.state.proposal) !== hash(request.proposal))
                return yield* fail(
                  'closeout-intent-conflict',
                  'Resume this admitted closeout; its evidence cannot be replaced.',
                );
              return summary(saved.state, saved.revision);
            }
            const controller = yield* readNativeWorkflowState(config, request.runId);
            if (!controller)
              return yield* fail('closeout-recovery', 'The original controller is unavailable for readmission.');
            if (controller.state.closeoutSave)
              return yield* fail('closeout-recovery', 'Release the fenced exact reservation before readmission.');
            if ((saved.state.history?.length ?? 0) >= 4)
              return yield* fail('closeout-capacity', 'Retained closeout admission history is full.');
          }
          const inputs = yield* loadNativeCloseoutInputs(config, request.runId, request.generation, call);
          yield* assertJobPrepareBasis(inputs.source, inputs.binding.bindingId);
          if (saved?.state.status === 'superseded')
            yield* freshReadmission(
              saved.state,
              (yield* readNativeWorkflowState(config, request.runId))!,
              inputs.source,
            );
          const admission = yield* attempt(() =>
            prepareNativeCloseout(inputs.cycle, inputs.plan, request.proposal, inputs.spec),
          );
          // Admit every final document before any knowledge write or retirement.
          yield* attempt(() =>
            EffectArray.forEach(
              [
                admission.documents.architecture,
                ...admission.documents.decisions,
                admission.documents.handoff,
                ...(admission.documents.behavior ? [admission.documents.behavior] : []),
              ],
              encodeAuthoringDocument,
            ),
          );
          const admissionEpoch =
            saved?.state.status === 'superseded' ? hash({supersededRevision: saved.revision}) : undefined;
          const transactionId = hash({
            runId: request.runId,
            generation: request.generation,
            source: inputs.source,
            cycle: inputs.cycle,
            proposal: request.proposal,
            ...(admissionEpoch ? {admissionEpoch} : {}),
          });
          activeTransactionId = transactionId;
          const owned: Journal['owned'][number][] = [];
          for (const item of inputs.owned) {
            const operationId =
              'closeout-' +
              Effect2.pipe(
                hash({transactionId, bindingId: item.bindingId, uri: item.uri, revision: item.revision}),
                EffectString.slice(0, 48),
              );
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
              operationId: 'closeout-' + Effect2.pipe(transactionId, EffectString.slice(0, 24)) + '-' + key,
              artifactKey: 'closeout-' + Effect2.pipe(transactionId, EffectString.slice(0, 24)) + '-' + key,
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
          const journal: Journal = {
            format: 'threadnote-native-closeout',
            version: 1,
            runId: request.runId,
            generation: request.generation,
            bindingId: inputs.binding.bindingId,
            profile: inputs.state.profile,
            transactionId,
            ...(admissionEpoch ? {admissionEpoch} : {}),
            ...(admissionEpoch ? {cycleRuntimeDigest: hash(inputs.state.cycle)} : {}),
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
            ...(saved?.state.status === 'superseded'
              ? {
                  history: [
                    ...(saved.state.history ?? []),
                    (({history: _history, ...retired}) => ({
                      ...retired,
                      status: 'superseded' as const,
                      recovery: saved.state.recovery!,
                    }))(saved.state),
                  ],
                }
              : {}),
          };
          if (saved?.state.status === 'superseded') {
            yield* assertJobPrepareLive;
            const admitting: Journal = {...journal, status: 'admitting'};
            yield* assertNativeCloseoutJournalCapacity(journal, decodeJournal);
            yield* assertNativeCloseoutJournalCapacity(admitting, decodeJournal);
            saved = yield* writeNativeCloseoutJournal(config, request.runId, admitting, saved.revision, decodeJournal);
            yield* reserveNativeCloseoutCapacity(
              config,
              request.runId,
              transactionId,
              documents,
              admission.architecture.codeRefs,
              owned,
            );
            saved = yield* writeNativeCloseoutJournal(config, request.runId, journal, saved.revision, decodeJournal);
          } else {
            yield* assertJobPrepareLive;
            yield* reserveNativeCloseoutCapacity(
              config,
              request.runId,
              transactionId,
              documents,
              admission.architecture.codeRefs,
              owned,
            );
            saved = yield* writeNativeCloseoutJournal(config, request.runId, journal, null, decodeJournal);
          }
          return summary(saved.state, saved.revision);
        }
        if (!saved)
          return yield* fail('closeout-not-prepared', 'Prepare and verify this native closeout before finishing.');
        let journal = saved.state;
        if (request.command === 'recover') {
          if (!['prepared', 'admitting', 'superseded'].includes(journal.status))
            return yield* fail('closeout-recovery', 'Only a pristine admission can be superseded.');
          if (journal.status === 'prepared' || journal.status === 'admitting') {
            if (
              EffectRecord.keys(journal.outputs).length ||
              EffectRecord.keys(journal.archives).length ||
              journal.approvalDigest ||
              journal.decision ||
              journal.publication
            )
              return yield* fail('closeout-recovery', 'Final output, archive or publication receipts already exist.');
            const controller = yield* readNativeWorkflowState(config, request.runId);
            if (
              !controller ||
              controller.state.bindingId !== journal.bindingId ||
              controller.state.generation !== journal.generation
            )
              return yield* fail('closeout-recovery', 'Controller binding changed; preserve the original admission.');
            const reservation = controller.state.closeoutSave
              ? yield* inspectPristineNativeCloseoutCapacity(config, request.runId, journal.transactionId)
              : undefined;
            if (!reservation && journal.status === 'prepared')
              return yield* fail('closeout-recovery', 'The prepared admission lost its exact reservation.');
            const operationIds =
              reservation?.operationIds ?? nativeCloseoutPlannedOperationIds(journal.transactionId, journal.documents);
            if (
              !reservation &&
              EffectArray.some(controller.state.operations, item => operationIds.includes(item.intent.operationId))
            )
              return yield* fail('closeout-recovery', 'A lower closeout operation started without its reservation.');
            const fs = yield* FileSystem.FileSystem;
            const publicationFile = (yield* Path.Path).join(
              config.agentContextHome,
              'workflow-memory',
              journal.bindingId + '.publication.json',
            );
            if (yield* fs.exists(publicationFile))
              return yield* fail('closeout-recovery', 'A publication journal exists; preserve the original admission.');
            const bindings = new Set([journal.bindingId, ...EffectArray.map(journal.owned, item => item.bindingId)]);
            for (const bindingId of bindings) {
              const lower = yield* withWorkflowLock(config, bindingId, inspectWorkflowJournal(config, bindingId));
              if (
                EffectArray.some(
                  journal.owned,
                  item => item.bindingId === bindingId && !!lower.state.operations[item.operationId],
                )
              )
                return yield* fail(
                  'closeout-recovery',
                  'An archive lower operation started; preserve the original admission.',
                );
              if (bindingId === journal.bindingId && EffectArray.some(operationIds, id => !!lower.state.operations[id]))
                return yield* fail(
                  'closeout-recovery',
                  'A final output lower operation started; preserve the original admission.',
                );
            }
            for (const document of journal.documents)
              if ((yield* readOptionalResource(config, document.uri)) !== undefined)
                return yield* fail('closeout-recovery', 'A final output already exists at its admitted destination.');
            for (const item of journal.owned) {
              if ((yield* readOptionalResource(config, item.destination)) !== undefined)
                return yield* fail('closeout-recovery', 'An archive already exists at its admitted destination.');
              const observed = yield* runWorkflowMemory(config, {
                protocolVersion: 1,
                action: 'read',
                bindingId: item.bindingId,
                uri: item.uri,
              }).pipe(Effect.flatMap(value => attempt(() => artifact(value))));
              if (
                observed.memoryId !== item.memoryId ||
                observed.revision !== item.revision ||
                observed.state !== 'active'
              )
                return yield* fail('closeout-recovery', 'An owned draft changed; preserve the original admission.');
            }
            const currentSource = yield* Effect.result(captureNativeCycleSource(journal.source.repo, 'HEAD'));
            const prior = journal.status === 'admitting' ? journal.history?.at(-1) : undefined;
            const preserveQualification =
              prior?.recovery &&
              currentSource._tag === 'Success' &&
              currentSource.success.repo === journal.source.repo &&
              currentSource.success.head === journal.source.head &&
              currentSource.success.tree === journal.source.tree &&
              journal.cycleRuntimeDigest === hash(controller.state.cycle);
            const qualifiedPhases = preserveQualification
              ? yield* freshReadmission(prior, controller, journal.source)
              : undefined;
            const previousCarry = prior?.recovery?.carriedQualification;
            const validPreviousCarry =
              previousCarry &&
              hash(previousCarry.source) === hash(journal.source) &&
              previousCarry.cycleRuntimeDigest === journal.cycleRuntimeDigest;
            const carried = preserveQualification
              ? validPreviousCarry
                ? previousCarry
                : {
                    source: journal.source,
                    cycleRuntimeDigest: journal.cycleRuntimeDigest!,
                    affectedPhaseIds: qualifiedPhases!,
                    acceptedAttemptIds: prior.recovery.acceptedAttemptIds,
                    snapshotIds: prior.recovery.snapshotIds,
                  }
              : undefined;
            const fenced: Journal = {
              ...journal,
              status: 'superseded',
              recovery: {
                reservation,
                acceptedAttemptIds: pipe(
                  controller.state.cycle?.attempts ?? [],
                  EffectArray.filter(item => item.status === 'accepted'),
                  EffectArray.map(item => item.id),
                ),
                snapshotIds: EffectArray.map(controller.state.cycle?.snapshots ?? [], item => item.snapshot.snapshotId),
                ...(carried ? {carriedQualification: carried} : {}),
              },
            };
            saved = yield* writeNativeCloseoutJournal(config, request.runId, fenced, saved.revision, decodeJournal);
            journal = saved.state;
          }
          if (journal.recovery?.reservation)
            yield* releasePristineNativeCloseoutCapacity(config, request.runId, journal.recovery.reservation);
          return summary(journal, saved.revision);
        }
        if (request.command === 'inspect') {
          const current = yield* readNativeWorkflowState(config, request.runId);
          const source = yield* Effect.result(captureNativeCycleSource(journal.source.repo, 'HEAD'));
          return {
            ...summary(journal, saved.revision),
            drift: {
              binding:
                !current ||
                current.state.bindingId !== journal.bindingId ||
                current.state.generation !== journal.generation,
              cycle: !current?.state.cycle || hash(current.state.cycle.state) !== hash(journal.cycle),
              source:
                source._tag === 'Failure' ||
                source.success.head !== journal.source.head ||
                source.success.tree !== journal.source.tree,
            },
          };
        }
        if (journal.status === 'superseded' || journal.status === 'admitting')
          return yield* fail(
            'closeout-superseded',
            'This admission is fenced; reaccept the affected phase before preparing a new closeout.',
          );
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
          if (Effect2.pipe(head.stdout, EffectString.trim) !== journal.source.head || dirty.stdout.length !== 0)
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
              topic: Effect2.pipe(binding.featureId, EffectString.slice(0, 80)) + '-implemented',
              body:
                renderNativeDocument(admission.documents.architecture) +
                '\n' +
                EffectArray.join(EffectArray.map(admission.documents.decisions, renderNativeDocument), '\n'),
              codeRefs: [...admission.architecture.codeRefs],
              relations: admission.documents.behavior ? [{type: 'references', nodeKey: 'spec'}] : [],
            },
            ...(admission.documents.behavior
              ? [
                  {
                    key: 'spec',
                    role: 'spec' as const,
                    topic: Effect2.pipe(binding.featureId, EffectString.slice(0, 80)) + '-verified',
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
          const admitted = yield* CurrentNativeJobSourceView;
          if (admitted) yield* assertNativeJobLiveSource(admitted);
          const publication = yield* runWorkflowMemory(config, {
            protocolVersion: 1,
            action: 'publication-publish',
            bindingId: journal.bindingId,
            approvalDigest: journal.approvalDigest,
          });
          const pendingPublication =
            typeof publication === 'object' &&
            publication !== null &&
            'status' in publication &&
            publication.status === 'pending'
              ? publication
              : undefined;
          if (pendingPublication) {
            const rawStage = pendingPublication.stage;
            const stage =
              typeof rawStage === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(rawStage)
                ? rawStage
                : 'unknown';
            const cause = pendingPublication.cause;
            let causeSummary = 'the shared writer returned no publication receipt';
            if (
              typeof cause === 'object' &&
              cause !== null &&
              'kind' in cause &&
              cause.kind === 'shared-writer-error'
            ) {
              const errorType =
                'errorType' in cause &&
                typeof cause.errorType === 'string' &&
                /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(cause.errorType)
                  ? cause.errorType
                  : 'UnknownError';
              const nativeCode =
                'nativeCode' in cause &&
                typeof cause.nativeCode === 'string' &&
                /^[A-Z][A-Z0-9]{1,11}$/u.test(cause.nativeCode)
                  ? ` (${cause.nativeCode})`
                  : '';
              const reason =
                'reason' in cause && Schema.is(PublicationWriterReasonSchema)(cause.reason) ? ` [${cause.reason}]` : '';
              causeSummary = `the shared writer returned ${errorType}${nativeCode}${reason}`;
            }
            return yield* fail(
              'publication-incomplete',
              `Publication remains pending at stage ${stage}: ${causeSummary}. Check the configured shared worktree and retry this approved publication.`,
            );
          }
          yield* withWorkflowLock(
            config,
            journal.bindingId,
            assertWorkflowPublicationVerified(config, journal.bindingId),
          );
          if (admitted) yield* assertNativeJobLiveSource(admitted);
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
              'closeout-' +
              Effect2.pipe(journal.transactionId, EffectString.slice(0, 24)) +
              '-' +
              key +
              (replacing ? '-final' : '');
            const knownOperations = (yield* readNativeWorkflowState(config, request.runId))?.state.operations ?? [];
            const existing = EffectOption.getOrUndefined(
              EffectArray.findFirst(knownOperations, item => item.intent.operationId === operationId),
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
                    artifactKey:
                      'closeout-' + Effect2.pipe(journal.transactionId, EffectString.slice(0, 24)) + '-' + key,
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
            const value = result.artifact;
            if (!Schema.is(closeoutArtifactSchema)(value))
              return yield* fail('invalid-readback', 'Closeout write returned an invalid artifact.');
            const observed = yield* read(journal.bindingId, value.uri);
            if (
              observed.memoryId !== value.memoryId ||
              observed.revision !== value.revision ||
              observed.body !== body ||
              observed.state !== 'active'
            )
              return yield* fail('invalid-readback', 'Closeout knowledge failed independent current readback.');
            const admitted = yield* CurrentNativeJobSourceView;
            if (admitted) yield* assertNativeJobLiveSource(admitted);
            const reference = ref(observed);
            yield* save({...journal, outputs: {...journal.outputs, [key]: reference}});
            return reference;
          });
        const finalDocuments = new Map(EffectArray.map(journal.documents, document => [document.key, document]));
        const seen = new Set<string>();
        for (const document of journal.documents) {
          const boundary = yield* CurrentNativeJobBoundary;
          if (boundary) yield* boundary;
          if (!seen.has(document.key)) {
            const final = finalDocuments.get(document.key);
            if (final && final !== document) {
              const operationId =
                'closeout-' +
                Effect2.pipe(journal.transactionId, EffectString.slice(0, 24)) +
                '-' +
                document.key +
                '-final';
              const knownOperations = (yield* readNativeWorkflowState(config, request.runId))?.state.operations ?? [];
              const existing = EffectOption.getOrUndefined(
                EffectArray.findFirst(knownOperations, item => item.intent.operationId === operationId),
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
          const boundary = yield* CurrentNativeJobBoundary;
          if (boundary) yield* boundary;
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
        yield* withWorkflowRecallRefreshBatch(
          config,
          Effect.gen(function* () {
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
              if (
                archived.uri !== item.destination ||
                archived.memoryId !== item.memoryId ||
                archived.state !== 'archived'
              )
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
          }),
        );
        yield* save({...journal, status: 'complete'});
        yield* clearNativeCloseoutCapacity(config, request.runId, journal.transactionId);
        return summary(journal, saved.revision);
      }),
    );
  });
