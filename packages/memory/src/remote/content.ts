import {Schema} from 'effect';
import type {RemoteMemoryKind} from './contracts.js';
import {parseRemoteShareAddress} from './address.js';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryRecord,
} from '../document.js';
import {memoryCodeCitationSharingBlocker, memoryCodeCitationSharingBlockerMessage} from '../code/citation-policy.js';
import {applyScrubber, type ScrubberPattern} from '@threadnote/platform/scrubber';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const REMOTE_MEMORY_CONTENT_CONTRACT_VERSION = 1 as const;

export type RemoteMemoryContentBlockCategory = 'credential' | 'machine_local_path';

export type RemoteMemoryContentDecisionV1 =
  | {
      readonly allowed: true;
      readonly canonicalContent: string;
      readonly version: typeof REMOTE_MEMORY_CONTENT_CONTRACT_VERSION;
    }
  | {
      readonly allowed: false;
      readonly category: RemoteMemoryContentBlockCategory;
      readonly reason: string;
      readonly version: typeof REMOTE_MEMORY_CONTENT_CONTRACT_VERSION;
    };

export interface RemoteCanonicalMemoryDocumentV1 {
  readonly content: string;
  readonly kind: RemoteMemoryKind;
  readonly project: string;
  readonly record: MemoryRecord;
  readonly topic: string;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_CONTENT_CONTRACT_VERSION;
}

export interface RemoteMemoryContentPolicy {
  /** Additional fail-closed deployment patterns; the baseline cannot be removed. */
  readonly additionalPatterns?: readonly ScrubberPattern[];
}

export class InvalidRemoteMemoryDocument extends Schema.TaggedError<
  InvalidRemoteMemoryDocument,
  {readonly brand: unique symbol}
>()('InvalidRemoteMemoryDocument', {message: Schema.String, reason: Schema.String}) {}

/**
 * Apply Threadnote's fail-closed baseline scrubber without returning the input or
 * matched value. Deployments may add stricter customer-data policy before commit.
 */
export function inspectRemoteMemoryContent(
  content: string,
  policy: RemoteMemoryContentPolicy = {},
): RemoteMemoryContentDecisionV1 {
  const scrubbed = applyScrubber(content, {additionalPatterns: policy.additionalPatterns, redact: false});
  if (scrubbed.blocker) {
    return {
      allowed: false,
      category: Effect.pipe(scrubbed.blocker, EffectString.endsWith(' path')) ? 'machine_local_path' : 'credential',
      reason: scrubbed.blocker,
      version: REMOTE_MEMORY_CONTENT_CONTRACT_VERSION,
    };
  }
  return {
    allowed: true,
    canonicalContent: canonicalMemoryDocumentContent(scrubbed.cleaned),
    version: REMOTE_MEMORY_CONTENT_CONTRACT_VERSION,
  };
}

export function parseRemoteCanonicalMemoryDocument(input: {
  readonly content: string;
  readonly kind: RemoteMemoryKind;
  readonly project: string;
  readonly topic: string;
  readonly uri: string;
}): RemoteCanonicalMemoryDocumentV1 {
  const inspection = inspectRemoteMemoryContent(input.content);
  if (!inspection.allowed) return invalidDocument(`content blocked by ${inspection.category} policy`);
  const address = parseRemoteShareAddress(input.uri);
  if (address.kind !== input.kind || address.project !== input.project || address.topic !== input.topic) {
    return invalidDocument('document identity does not match the remote share address');
  }
  const record = parseMemoryDocument(input.uri, inspection.canonicalContent);
  if (!record) return invalidDocument('content is not canonical Threadnote Markdown');
  const citationBlocker = memoryCodeCitationSharingBlocker(record.metadata);
  if (citationBlocker) {
    return invalidDocument(
      `content blocked by code-citation sharing policy: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}`,
    );
  }
  if (record.metadata.kind !== input.kind) return invalidDocument('document kind does not match the mutation kind');
  if (record.metadata.project !== input.project) return invalidDocument('document project does not match the address');
  if (record.metadata.topic !== input.topic) return invalidDocument('document topic does not match the address');
  if (input.kind === 'handoff' && record.headerTitle !== 'HANDOFF') {
    return invalidDocument('handoff content must use the HANDOFF header');
  }
  if (input.kind === 'durable' && record.headerTitle !== 'MEMORY') {
    return invalidDocument('durable content must use the MEMORY header');
  }
  if (formatMemoryDocument(record.headerTitle, record.metadata, record.body) !== inspection.canonicalContent) {
    return invalidDocument('document does not use canonical Threadnote Markdown formatting');
  }
  return {
    content: inspection.canonicalContent,
    kind: input.kind,
    project: input.project,
    record,
    topic: input.topic,
    uri: record.uri,
    version: REMOTE_MEMORY_CONTENT_CONTRACT_VERSION,
  };
}

function invalidDocument(reason: string): never {
  throw InvalidRemoteMemoryDocument.make({message: `Invalid remote memory document: ${reason}.`, reason});
}
