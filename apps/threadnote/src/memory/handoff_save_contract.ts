import {parseResourceId} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/workspace/manifest';
import {Context, Effect, Schema} from 'effect';
import type {PreparedPersonalMemoryWrite} from '../mcp/server/memory.js';

export const HANDOFF_SAVE_WORKER_ARGUMENT = '--threadnote-handoff-save-worker-v1';
export const HANDOFF_SAVE_READY_MILLISECONDS = 3_000;
export const HANDOFF_SAVE_RESULT_MILLISECONDS = 1_000;
export const HANDOFF_SAVE_RECEIPT_BYTES = 32 * 1024;
export const HANDOFF_SAVE_HISTORY_LIMIT = 64;
export const handoffSaveOperationIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);
export const runtimeSourceIdentitySchema = Schema.Struct({
  version: Schema.Literal(1),
  commit: Schema.String,
  tree: Schema.String,
  bun: Schema.String,
  target: Schema.String,
});
export type HandoffSaveSourceIdentity = typeof runtimeSourceIdentitySchema.Type;
export function compiledHandoffSaveIdentity(): HandoffSaveSourceIdentity | undefined {
  return typeof THREADNOTE_RUNTIME_SOURCE_IDENTITY === 'undefined' || THREADNOTE_RUNTIME_SOURCE_IDENTITY === null
    ? undefined
    : THREADNOTE_RUNTIME_SOURCE_IDENTITY;
}
export type HandoffSaveStage =
  | 'preparing'
  | 'prepared'
  | 'authorized'
  | 'canonical-wait'
  | 'canonical-possibly-applied'
  | 'canonical-observed'
  | 'lexical'
  | 'recall-demand'
  | 'complete'
  | 'failed'
  | 'not-started';
export const handoffSaveStageSchema = Schema.Literals([
  'preparing',
  'prepared',
  'authorized',
  'canonical-wait',
  'canonical-possibly-applied',
  'canonical-observed',
  'lexical',
  'recall-demand',
  'complete',
  'failed',
  'not-started',
]);
export const handoffSaveResponseSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({type: Schema.Literal('text'), text: Schema.String.check(Schema.isMaxLength(8192))}),
  ).check(Schema.isMaxLength(16)),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export const handoffSaveReceiptSchema = Schema.Struct({
  format: Schema.Literal('threadnote-handoff-save'),
  version: Schema.Literal(1),
  operationId: handoffSaveOperationIdSchema,
  account: Schema.String,
  user: Schema.String,
  source: runtimeSourceIdentitySchema,
  intentDigest: Schema.String,
  processId: Schema.Int,
  processStartIdentity: Schema.String,
  sequence: Schema.Int,
  stage: handoffSaveStageSchema,
  updatedAt: Schema.Finite,
  goPossible: Schema.Boolean,
  authorized: Schema.Boolean,
  possiblyApplied: Schema.Boolean,
  canonicalObserved: Schema.Boolean,
  lexicalVerified: Schema.Boolean,
  prepared: Schema.optionalKey(
    Schema.Struct({
      uri: Schema.String,
      memoryId: Schema.String,
      desiredRevision: Schema.String,
      previousRevision: Schema.optionalKey(Schema.String),
    }),
  ),
  sourceWitnesses: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({uri: Schema.String, revision: Schema.String, memoryId: Schema.optionalKey(Schema.String)}),
    ),
  ),
  lexicalGeneration: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(handoffSaveResponseSchema),
  result: Schema.optionalKey(Schema.Struct({memoryUri: Schema.String, replacementCleanupPending: Schema.Boolean})),
}).check(
  Schema.makeFilter(value =>
    value.stage === 'complete' &&
    (!value.authorized || !value.canonicalObserved || !value.lexicalVerified || !value.result)
      ? 'Completion lacks verified required outcomes.'
      : value.stage === 'not-started' && (value.authorized || value.possiblyApplied)
        ? 'An authorized save cannot be called not-started.'
        : undefined,
  ),
);
export type HandoffSaveReceipt = typeof handoffSaveReceiptSchema.Type;
/** Child-only observer. No observer changes the normal synchronous write contract. */
export const CurrentHandoffSaveObserver = Context.Reference<
  | {
      readonly prepared: (value: PreparedPersonalMemoryWrite) => Effect.Effect<void>;
      readonly stage: (value: HandoffSaveStage) => Effect.Effect<void>;
    }
  | undefined
>('threadnote/HandoffSaveObserver', {defaultValue: () => undefined});

export function personalHandoffReplacement(uri: unknown, user: string): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const parsed = parseResourceId(uri);
    return (
      parsed.inputScheme === 'threadnote' &&
      parsed.canonicalUri === uri &&
      parsed.anchor === undefined &&
      parsed.namespace === 'user' &&
      parsed.segments[0] === uriSegment(user) &&
      parsed.segments[1] === 'memories' &&
      parsed.segments[2] === 'handoffs' &&
      parsed.segments.length > 3
    );
  } catch {
    return false;
  }
}

export function eligibleOwnedHandoff(args: Readonly<Record<string, unknown>>, user?: string): boolean {
  if (args.replaceUri !== undefined && (user === undefined || !personalHandoffReplacement(args.replaceUri, user)))
    return false;
  return (
    args.kind === 'handoff' &&
    typeof args.text === 'string' &&
    Buffer.byteLength(JSON.stringify(args)) <= 16 * 1024 &&
    args.codeRefs === undefined &&
    args.citationPolicy === undefined &&
    args.regenerateKeywords === undefined &&
    args.team === undefined
  );
}
