import {Schema} from 'effect';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';

export const REMOTE_MEMORY_RECEIPT_VERSION = 1 as const;
export const REMOTE_MEMORY_CONSISTENCY_VALUES = ['current', 'recent-write-overlay', 'stale-index'] as const;

export type RemoteMemoryConsistency = (typeof REMOTE_MEMORY_CONSISTENCY_VALUES)[number];

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const OpaqueIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RemoteMemoryActorSchemaV1 = Schema.Struct({
  cloudAgentId: Schema.optionalKey(OpaqueIdentifier),
  principalId: OpaqueIdentifier,
  provider: Schema.optionalKey(Schema.Literal('cursor')),
  turnId: Schema.optionalKey(OpaqueIdentifier),
});

export type RemoteMemoryActorV1 = typeof RemoteMemoryActorSchemaV1.Type;

export const RemoteMemoryReceiptSchemaV1 = Schema.Struct({
  actor: Schema.optionalKey(RemoteMemoryActorSchemaV1),
  consistency: Schema.Literals(REMOTE_MEMORY_CONSISTENCY_VALUES),
  indexedGeneration: Generation,
  policyVersion: OpaqueIdentifier,
  sharePolicyVersion: OpaqueIdentifier,
  requestId: OpaqueIdentifier,
  revision: Schema.optionalKey(OpaqueIdentifier),
  shareGeneration: Generation,
  shareId: OpaqueIdentifier,
  tenantId: OpaqueIdentifier,
  uri: Schema.optionalKey(NonEmptyString),
  version: Schema.Literal(REMOTE_MEMORY_RECEIPT_VERSION),
});

export type RemoteMemoryReceiptV1 = typeof RemoteMemoryReceiptSchemaV1.Type;

export class InvalidRemoteMemoryReceipt extends Schema.TaggedError<
  InvalidRemoteMemoryReceipt,
  {readonly brand: unique symbol}
>()('InvalidRemoteMemoryReceipt', {message: Schema.String}) {}

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseRemoteMemoryReceiptV1(value: unknown): RemoteMemoryReceiptV1 {
  const receipt = Schema.decodeUnknownSync(RemoteMemoryReceiptSchemaV1, STRICT_PARSE_OPTIONS)(value);
  if (receipt.indexedGeneration > receipt.shareGeneration) {
    throw InvalidRemoteMemoryReceipt.make({
      message: 'Remote memory indexed generation cannot exceed the committed share generation.',
    });
  }
  const caughtUp = receipt.indexedGeneration === receipt.shareGeneration;
  if ((receipt.consistency === 'current') !== caughtUp) {
    throw InvalidRemoteMemoryReceipt.make({
      message: 'Remote memory receipt consistency must match its committed and indexed generations.',
    });
  }
  const blocker = credentialScrubberBlocker(JSON.stringify(receipt));
  if (blocker) {
    throw InvalidRemoteMemoryReceipt.make({message: `Remote memory receipt contains a prohibited ${blocker}.`});
  }
  return receipt;
}
