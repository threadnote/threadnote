import {Effect, Schema} from 'effect';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {NativeAuthoringDocumentSchema} from '@threadnote/workflow-automations/authoring';
import {NativeCycleStateSchema} from '@threadnote/workflow-automations/cycle';
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
export type Journal = typeof journalSchema.Type;
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const hash = (value: unknown) => sha256HexSync(stableJson(value));
export const decodeJournal = (input: unknown): Journal => {
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
/** Read the exact admitted transaction without mutating its journal. */
export const readNativeCloseoutJobBasis = Effect.fn('workflowAutomation.closeoutJobBasis')(function* (
  config: RuntimeConfig,
  runId: string,
  generation: string,
) {
  const saved = yield* readNativeCloseoutJournal(config, runId, decodeJournal);
  if (!saved || saved.state.generation !== generation)
    return yield* fail('closeout-not-prepared', 'Prepare this exact closeout transaction before submitting finish.');
  return {
    bindingId: saved.state.bindingId,
    transactionId: saved.state.transactionId,
    source: saved.state.source,
    codeRefs: saved.state.proposal.architecture.codeRefs,
  };
});
