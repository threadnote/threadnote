import {
  isSafeInteger as checkedIsSafeInteger,
  isFiniteNumber as checkedIsFiniteNumber,
} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {parseExternalResourceIdentity, type ExternalProvider} from './external-resource.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_SOURCE_EVIDENCE_BYTES = 512 * 1024;
export const MAX_SOURCE_CITATION_BYTES = 4096;
const encoder = new TextEncoder();

export interface SourceEvidenceCitationV1 {
  readonly version: 1;
  readonly provider: ExternalProvider;
  readonly sourceId: string;
  readonly sourceInstanceId: string;
  readonly resourceUri: string;
  readonly accessHash: string;
  readonly revisionHash: string;
  readonly contentHash: string;
  readonly rendererVersion: string;
  readonly sanitizerVersion: string;
  readonly fragmentHash: string;
  readonly fragmentStart: number;
  readonly fragmentEnd: number;
  readonly pinId: string;
  readonly expiresAt: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function validSourceEvidenceVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    EffectArray.every([...value], character => {
      const code = Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      )!;
      return (code > 31 && code < 127) || code > 159;
    })
  );
}

function citationRecord(value: unknown): value is SourceEvidenceCitationV1 {
  if (!object(value)) return false;
  const identity = typeof value.resourceUri === 'string' ? parseExternalResourceIdentity(value.resourceUri) : undefined;
  if (
    EffectRecord.keys(value).length !== 15 ||
    value.version !== 1 ||
    !identity ||
    value.resourceUri !==
      `threadnote://resources/external/${identity.provider}/${identity.sourceId}/docs/${identity.documentId}/pages/${identity.pageId}/${identity.chunkId}.md` ||
    value.provider !== identity.provider ||
    value.sourceId !== identity.sourceId ||
    typeof value.sourceInstanceId !== 'string' ||
    !HASH.test(value.sourceInstanceId) ||
    typeof value.accessHash !== 'string' ||
    !HASH.test(value.accessHash) ||
    typeof value.revisionHash !== 'string' ||
    !HASH.test(value.revisionHash) ||
    typeof value.contentHash !== 'string' ||
    !HASH.test(value.contentHash) ||
    typeof value.fragmentHash !== 'string' ||
    !HASH.test(value.fragmentHash) ||
    !validSourceEvidenceVersion(value.rendererVersion) ||
    !validSourceEvidenceVersion(value.sanitizerVersion) ||
    typeof value.pinId !== 'string' ||
    !UUID.test(value.pinId) ||
    !checkedIsSafeInteger(value.fragmentStart) ||
    value.fragmentStart < 0 ||
    !checkedIsSafeInteger(value.fragmentEnd) ||
    value.fragmentEnd <= value.fragmentStart ||
    value.fragmentEnd > MAX_SOURCE_EVIDENCE_BYTES ||
    typeof value.expiresAt !== 'string' ||
    !checkedIsFiniteNumber(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    return false;
  return true;
}

export function validSourceEvidenceCitation(value: unknown): value is SourceEvidenceCitationV1 {
  return citationRecord(value) && bytes(JSON.stringify(value)) <= MAX_SOURCE_CITATION_BYTES;
}

export function serializeSourceEvidenceCitation(citation: SourceEvidenceCitationV1): string {
  if (!validSourceEvidenceCitation(citation)) throw new Error('Invalid source evidence citation.');
  return JSON.stringify({
    version: citation.version,
    provider: citation.provider,
    sourceId: citation.sourceId,
    sourceInstanceId: citation.sourceInstanceId,
    resourceUri: citation.resourceUri,
    accessHash: citation.accessHash,
    revisionHash: citation.revisionHash,
    contentHash: citation.contentHash,
    rendererVersion: citation.rendererVersion,
    sanitizerVersion: citation.sanitizerVersion,
    fragmentHash: citation.fragmentHash,
    fragmentStart: citation.fragmentStart,
    fragmentEnd: citation.fragmentEnd,
    pinId: citation.pinId,
    expiresAt: citation.expiresAt,
  });
}
