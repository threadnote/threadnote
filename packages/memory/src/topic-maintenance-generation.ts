import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const MAX_TOPIC_GENERATION_RECEIPT_BYTES = 256 * 1024;
export const MAX_TOPIC_GENERATION_OUTPUT_BYTES = 32 * 1024;
export const TOPIC_GENERATION_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TOPIC_GENERATION_RECEIPTS = 100;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const TopicGenerationReceiptId = Schema.String.check(Schema.isPattern(/^topic-generation-[a-f0-9]{32}$/u));
export const TopicGenerationUsage = Schema.Union([
  Schema.Struct({status: Schema.Literal('unavailable')}),
  Schema.Struct({status: Schema.Literal('measured'), inputTokens: Count, outputTokens: Count}),
]);
const Representation = Schema.Literals(['provider-text', 'decoded-json']);
const Output = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('unavailable'),
    reason: Schema.Literals(['not-returned', 'provider-decode-failed', 'interrupted']),
  }),
  Schema.Struct({status: Schema.Literal('observed'), representation: Representation, hash: Hash, bytes: Count}),
]);
export const TopicGenerationAttempt = Schema.Struct({
  ordinal: Schema.Literals([1, 2]),
  promptHash: Hash,
  promptBytes: Count.check(Schema.isLessThanOrEqualTo(80 * 1024)),
  status: Schema.Literals([
    'started',
    'not-dispatched',
    'accepted',
    'draft-invalid',
    'provider-output-invalid',
    'provider-failed',
    'deadline',
    'interrupted',
  ]),
  elapsedMilliseconds: Schema.NullOr(Count),
  usage: TopicGenerationUsage,
  output: Output,
});
const fields = {
  version: Schema.Literal(1),
  receiptId: TopicGenerationReceiptId,
  caseId: Schema.String.check(Schema.isPattern(/^health-case-[a-f0-9]{40}$/u)),
  reviewId: Schema.String.check(Schema.isPattern(/^review-[a-f0-9]{24}$/u)),
  targetHash: Hash,
  observationRevision: Hash,
  packetDigest: Hash,
  agent: Schema.Literals(['local-ai', 'effect-ai']),
  model: Text,
  modelVersion: Schema.optionalKey(Text),
  promptVersion: Text,
  state: Schema.Literals(['started', 'completed', 'failed', 'interrupted']),
  phase: Schema.Literals(['generation', 'validation', 'closing-fence', 'review-save']),
  elapsedMilliseconds: Schema.NullOr(Count),
  promptScope: Schema.Literal('user-prompt-utf8-sha256'),
  attempts: Schema.Array(TopicGenerationAttempt).check(Schema.isMaxLength(2)),
};
export const TopicGenerationSummary = Schema.Struct(fields);
export const RetainedTopicGenerationOutput = Schema.Struct({
  attempt: Schema.Literals([1, 2]),
  representation: Representation,
  hash: Hash,
  bytes: Count,
  retainedBytes: Count.check(Schema.isLessThanOrEqualTo(MAX_TOPIC_GENERATION_OUTPUT_BYTES)),
  truncated: Schema.Boolean,
  text: Schema.String,
});
const Receipt = Schema.Struct({
  ...fields,
  createdAtMilliseconds: Count,
  firstFailedOutput: Schema.optionalKey(RetainedTopicGenerationOutput),
});
export type TopicGenerationSummaryV1 = typeof TopicGenerationSummary.Type;
export type TopicGenerationReceiptV1 = typeof Receipt.Type;
export type TopicGenerationAttemptV1 = typeof TopicGenerationAttempt.Type;
export type TopicGenerationUsageV1 = typeof TopicGenerationUsage.Type;
export type TopicGenerationOutputV1 = typeof RetainedTopicGenerationOutput.Type;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const strict = {onExcessProperty: 'error' as const};

export function validateTopicGenerationSummary(input: unknown): TopicGenerationSummaryV1 {
  const result = Schema.decodeUnknownSync(TopicGenerationSummary, strict)(input);
  if (EffectArray.some(result.attempts, (attempt, index) => attempt.ordinal !== index + 1))
    throw new Error('Invalid generation attempt order.');
  if (result.attempts.length === 2 && result.attempts[0].status !== 'draft-invalid')
    throw new Error('Only invalid draft output permits a repair attempt.');
  if (result.state === 'completed' && result.attempts.at(-1)?.status !== 'accepted')
    throw new Error('Completed generation requires an accepted attempt.');
  return result;
}

export function validateTopicGenerationReceipt(input: unknown): TopicGenerationReceiptV1 {
  if (bytes(JSON.stringify(input)) > MAX_TOPIC_GENERATION_RECEIPT_BYTES)
    throw new Error('Generation receipt exceeds its limit.');
  const result = Schema.decodeUnknownSync(Receipt, strict)(input);
  validateTopicGenerationSummary(projectTopicGenerationSummary(result));
  const output = result.firstFailedOutput;
  if (output) {
    const attempt = result.attempts[output.attempt - 1];
    const firstFailure = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        result.attempts,
        entry => entry.status !== 'accepted' && entry.status !== 'started' && entry.output.status === 'observed',
      ),
    );
    if (
      !attempt ||
      firstFailure?.ordinal !== output.attempt ||
      attempt.status === 'accepted' ||
      attempt.output.status !== 'observed' ||
      attempt.output.hash !== output.hash ||
      attempt.output.bytes !== output.bytes ||
      attempt.output.representation !== output.representation ||
      bytes(output.text) !== output.retainedBytes ||
      output.retainedBytes > output.bytes ||
      output.truncated !== output.retainedBytes < output.bytes ||
      (!output.truncated && sha256HexSync(output.text) !== output.hash)
    )
      throw new Error('Invalid retained generation output.');
  }
  return result;
}

export function projectTopicGenerationSummary(receipt: TopicGenerationReceiptV1): TopicGenerationSummaryV1 {
  const {
    version,
    receiptId,
    caseId,
    reviewId,
    targetHash,
    observationRevision,
    packetDigest,
    agent,
    model,
    modelVersion,
    promptVersion,
    state,
    phase,
    elapsedMilliseconds,
    promptScope,
    attempts,
  } = receipt;
  return {
    version,
    receiptId,
    caseId,
    reviewId,
    targetHash,
    observationRevision,
    packetDigest,
    agent,
    model,
    ...(modelVersion === undefined ? {} : {modelVersion}),
    promptVersion,
    state,
    phase,
    elapsedMilliseconds,
    promptScope,
    attempts: EffectArray.map(attempts, attempt => ({
      ...attempt,
      usage: {...attempt.usage},
      output: {...attempt.output},
    })),
  };
}

export function retainedTopicGenerationOutput(
  attempt: 1 | 2,
  text: string,
  representation: 'provider-text' | 'decoded-json',
  limit = MAX_TOPIC_GENERATION_OUTPUT_BYTES,
): TopicGenerationOutputV1 {
  let retained = '';
  let retainedBytes = 0;
  for (const character of text) {
    const size = bytes(character);
    if (retainedBytes + size > limit) break;
    retained += character;
    retainedBytes += size;
  }
  return {
    attempt,
    representation,
    hash: sha256HexSync(text),
    bytes: bytes(text),
    retainedBytes,
    truncated: retained !== text,
    text: retained,
  };
}

export function topicGenerationUsage(usages: readonly TopicGenerationUsageV1[]): TopicGenerationUsageV1 {
  let inputTokens = 0;
  let outputTokens = 0;
  if (!usages.length) return {status: 'unavailable'};
  for (const usage of usages) {
    if (usage.status !== 'measured') return {status: 'unavailable'};
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  return Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)
    ? {status: 'measured', inputTokens, outputTokens}
    : {status: 'unavailable'};
}

export function topicGenerationDiagnosticSummary(input: unknown): TopicGenerationSummaryV1 | undefined {
  try {
    return validateTopicGenerationSummary(input);
  } catch {
    return undefined;
  }
}
