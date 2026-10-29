import {Array as EffectArray, Record as EffectRecord, String as EffectString, Effect, Schema} from 'effect';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {NativeAuthoringDocumentSchema} from '@threadnote/workflow-automations/authoring';
import {NativeCycleStateSchema} from '@threadnote/workflow-automations/cycle';
import {NativeCloseoutSaveReservationSchema} from '@threadnote/workflow-automations/native';
import {prepareNativeCloseout, NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {readNativeCloseoutJournal} from './closeout_store.js';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const reference = Schema.Struct({uri: text, memoryId: text, revision: digest});
export const nativeCloseoutRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('closeout'),
  command: Schema.Literals([
    'schema',
    'validation-input',
    'prepare',
    'inspect',
    'recover',
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
const journalFields = {
  format: Schema.Literal('threadnote-native-closeout'),
  version: Schema.Literal(1),
  runId: id,
  generation: text,
  bindingId: digest,
  profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
  transactionId: digest,
  admissionEpoch: Schema.optionalKey(digest),
  cycleRuntimeDigest: Schema.optionalKey(digest),
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
} as const;
const qualificationSchema = Schema.Struct({
  source: Schema.Struct({repo: text, head: gitObject, tree: gitObject}),
  cycleRuntimeDigest: digest,
  affectedPhaseIds: Schema.Array(id).check(Schema.isBetweenLength(1, 128)),
  acceptedAttemptIds: Schema.Array(id).check(Schema.isMaxLength(512)),
  snapshotIds: Schema.Array(id).check(Schema.isMaxLength(256)),
});
const recoverySchema = Schema.Struct({
  reservation: Schema.optionalKey(NativeCloseoutSaveReservationSchema),
  acceptedAttemptIds: Schema.Array(id).check(Schema.isMaxLength(512)),
  snapshotIds: Schema.Array(id).check(Schema.isMaxLength(256)),
  carriedQualification: Schema.optionalKey(qualificationSchema),
});
const retiredSchema = Schema.Struct({...journalFields, status: Schema.Literal('superseded'), recovery: recoverySchema});
const journalSchema = Schema.Struct({
  ...journalFields,
  status: Schema.Literals(['admitting', 'prepared', 'archiving', 'complete', 'superseded']),
  history: Schema.optionalKey(Schema.Array(retiredSchema).check(Schema.isMaxLength(4))),
  recovery: Schema.optionalKey(recoverySchema),
});
export type Journal = typeof journalSchema.Type;
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const hash = (value: unknown) => sha256HexSync(stableJson(value));
export const decodeJournal = (input: unknown): Journal => {
  const value = Schema.decodeUnknownSync(journalSchema, {onExcessProperty: 'error'})(input);
  if ((value.status === 'superseded') !== (value.recovery !== undefined))
    throw fail('invalid-closeout-state', 'A superseded admission must retain its exact reservation fence.');
  if (value.status === 'admitting' && (!value.admissionEpoch || !value.history?.length))
    throw fail('invalid-closeout-state', 'Readmission must retain its predecessor before reserving capacity.');
  if (value.status === 'admitting' && !value.cycleRuntimeDigest)
    throw fail('invalid-closeout-state', 'Readmission must retain its exact cycle runtime basis.');
  if (
    new Set([value.transactionId, ...EffectArray.map(value.history ?? [], item => item.transactionId)]).size !==
      1 + (value.history?.length ?? 0) ||
    EffectArray.some(
      value.history ?? [],
      item =>
        item.runId !== value.runId ||
        item.generation !== value.generation ||
        item.bindingId !== value.bindingId ||
        item.profile !== value.profile,
    )
  )
    throw fail('invalid-closeout-state', 'Retained admissions changed identity or reused a transaction.');
  for (const admission of [value, ...(value.history ?? [])]) {
    prepareNativeCloseout(admission.cycle, admission.plan, admission.proposal, admission.spec);
    if (admission.documentDigest !== hash(admission.documents))
      throw fail('invalid-closeout-state', 'Admitted final document bytes changed.');
    if (
      admission.transactionId !==
        hash({
          runId: admission.runId,
          generation: admission.generation,
          source: admission.source,
          cycle: admission.cycle,
          proposal: admission.proposal,
          ...(admission.admissionEpoch ? {admissionEpoch: admission.admissionEpoch} : {}),
        }) ||
      EffectArray.some(
        admission.owned,
        item => !EffectString.startsWith('authoring-')(item.role) || item.sourceRunId !== item.runId,
      )
    )
      throw fail('invalid-closeout-state', 'Closeout intent or authoring ownership changed.');
    if (
      new Set(EffectArray.map(admission.owned, item => item.uri)).size !== admission.owned.length ||
      EffectArray.some(
        EffectRecord.keys(admission.archives),
        uri => !EffectArray.some(admission.owned, item => item.uri === uri),
      )
    )
      throw fail('invalid-closeout-state', 'Closeout history contains duplicate or unowned archives.');
    if (
      admission.status === 'superseded' &&
      (EffectRecord.keys(admission.outputs).length ||
        EffectRecord.keys(admission.archives).length ||
        admission.approvalDigest ||
        admission.decision ||
        admission.publication ||
        (admission.recovery?.reservation !== undefined &&
          admission.recovery.reservation.transactionId !== admission.transactionId))
    )
      throw fail('invalid-closeout-state', 'A superseded admission must retain a pristine exact reservation.');
    const carried = admission.recovery?.carriedQualification;
    if (
      carried &&
      (!admission.cycleRuntimeDigest ||
        carried.cycleRuntimeDigest !== admission.cycleRuntimeDigest ||
        hash(carried.source) !== hash(admission.source) ||
        new Set(carried.affectedPhaseIds).size !== carried.affectedPhaseIds.length ||
        EffectArray.some(
          carried.affectedPhaseIds,
          phaseId => !EffectArray.some(admission.cycle.plan.phases, phase => phase.id === phaseId),
        ) ||
        !EffectArray.some(
          value.history ?? [],
          predecessor =>
            hash(predecessor.recovery.acceptedAttemptIds) === hash(carried.acceptedAttemptIds) &&
            hash(predecessor.recovery.snapshotIds) === hash(carried.snapshotIds),
        ))
    )
      throw fail('invalid-closeout-state', 'Carried qualification differs from its retained admission basis.');
    if (
      admission.status === 'admitting' &&
      (EffectRecord.keys(admission.outputs).length ||
        EffectRecord.keys(admission.archives).length ||
        admission.approvalDigest ||
        admission.decision ||
        admission.publication)
    )
      throw fail('invalid-closeout-state', 'An uncommitted admission cannot contain lower effects.');
  }
  return value;
};
/** Read the exact admitted transaction without mutating its journal. */
export const readNativeCloseoutJobBasis = Effect.fn('workflowAutomation.closeoutJobBasis')(function* (
  config: RuntimeConfig,
  runId: string,
  generation: string,
) {
  const saved = yield* readNativeCloseoutJournal(config, runId, decodeJournal);
  if (
    !saved ||
    saved.state.generation !== generation ||
    saved.state.status === 'superseded' ||
    saved.state.status === 'admitting'
  )
    return yield* fail('closeout-not-prepared', 'Prepare this exact closeout transaction before submitting finish.');
  return {
    bindingId: saved.state.bindingId,
    transactionId: saved.state.transactionId,
    admissionEpoch: saved.state.admissionEpoch,
    source: saved.state.source,
    codeRefs: saved.state.proposal.architecture.codeRefs,
  };
});

/** Stable for one admission, including the interval after a fence and before readmission. */
export const readNativeCloseoutJobEpoch = Effect.fn('workflowAutomation.closeoutJobEpoch')(function* (
  config: RuntimeConfig,
  runId: string,
  generation: string,
  command: 'prepare' | 'finish',
) {
  const saved = yield* readNativeCloseoutJournal(config, runId, decodeJournal);
  if (saved && saved.state.generation !== generation)
    return yield* fail('job-closeout-drift', 'The closeout generation changed.');
  if (command === 'finish') {
    if (!saved || saved.state.status === 'superseded' || saved.state.status === 'admitting')
      return yield* fail('closeout-not-prepared', 'Prepare the active closeout admission first.');
    return saved.state.admissionEpoch;
  }
  return saved?.state.status === 'superseded'
    ? hash({supersededRevision: saved.revision})
    : saved?.state.admissionEpoch;
});
