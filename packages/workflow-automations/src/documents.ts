import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const invalidDocument = (message: string) => WorkflowAutomationError.make({code: 'invalid-document', message});
const DOCUMENT_CONTROL_CHARACTER = /[^\u0020-\u007e\u00a0-\u{10ffff}]/u;
const heading = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.trim).length === 0 || DOCUMENT_CONTROL_CHARACTER.test(value)
      ? 'Heading is blank or contains a control character.'
      : undefined,
  ),
);
const sectionId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.includes('..')) ||
    value === 'constructor' ||
    value === 'prototype' ||
    value === '__proto__'
      ? 'Reserved section identifiers are not allowed.'
      : undefined,
  ),
);
const sectionSchema = Schema.Struct({id: sectionId, heading, body: Schema.String});
export const NativeDocumentEnvelopeSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  templateVersion: Schema.Literal(1),
  kind: Schema.Literals([
    'spec',
    'plan',
    'architecture-current',
    'architecture-target',
    'decisions',
    'alternatives',
    'phase',
    'handoff',
    'source',
    'history',
    'index',
    'experience',
  ]),
  title: heading,
  sections: Schema.Array(sectionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export type NativeDocumentEnvelope = typeof NativeDocumentEnvelopeSchema.Type;
export type NativeDocumentKind = NativeDocumentEnvelope['kind'];

const renderedBytes = (document: NativeDocumentEnvelope): number =>
  new TextEncoder().encode(renderDecoded(document)).byteLength;
const renderDecoded = (document: NativeDocumentEnvelope): string =>
  `# ${document.title}\n\n${EffectArray.join(
    EffectArray.map(
      document.sections,
      section => `## ${section.heading}\n\n${Effect.pipe(section.body, EffectString.trim)}`,
    ),
    '\n\n',
  )}\n`;

export function decodeNativeDocument(input: unknown): NativeDocumentEnvelope {
  let document: NativeDocumentEnvelope;
  try {
    document = Schema.decodeUnknownSync(NativeDocumentEnvelopeSchema, {onExcessProperty: 'error'})(input);
  } catch {
    throw invalidDocument('The native document envelope is malformed or contains unsupported fields.');
  }
  if (new Set(EffectArray.map(document.sections, section => section.id)).size !== document.sections.length)
    throw invalidDocument('Native document section identifiers must be unique.');
  if (renderedBytes(document) > 60_000)
    throw invalidDocument('The rendered native document exceeds 60000 UTF-8 bytes.');
  return document;
}

export function renderNativeDocument(envelope: NativeDocumentEnvelope): string {
  return renderDecoded(decodeNativeDocument(envelope));
}

export function outlineNativeDocument(envelope: NativeDocumentEnvelope): {
  readonly kind: NativeDocumentEnvelope['kind'];
  readonly title: string;
  readonly sections: readonly {readonly id: string; readonly heading: string; readonly bytes: number}[];
} {
  const document = decodeNativeDocument(envelope);
  return {
    kind: document.kind,
    title: document.title,
    sections: EffectArray.map(document.sections, section => ({
      id: section.id,
      heading: section.heading,
      bytes: new TextEncoder().encode(Effect.pipe(section.body, EffectString.trim)).byteLength,
    })),
  };
}

export interface NativeDocumentSectionPage {
  readonly kind: NativeDocumentKind;
  readonly title: string;
  readonly sectionId: string;
  readonly heading: string;
  readonly content: string;
  readonly offsetBytes: number;
  readonly nextOffsetBytes: number | null;
  readonly sourceDigest: string;
}

export interface NativeDocumentSectionReadOptions {
  /** UTF-8 byte offset into the trimmed section body. Must land at a code-point boundary. */
  readonly offsetBytes?: number;
  /** Page size in UTF-8 bytes. The default is 4000; the maximum is 16000. */
  readonly maxBytes?: number;
  /** Digest returned by an earlier page, used to reject paging across document changes. */
  readonly sourceDigest?: string;
}

/** Read one bounded section page without loading section bodies from an external store. */
export function readNativeDocumentSection(
  envelope: NativeDocumentEnvelope,
  sectionId: string,
  options: NativeDocumentSectionReadOptions = {},
): NativeDocumentSectionPage {
  const document = decodeNativeDocument(envelope);
  const section = EffectOption.getOrUndefined(
    EffectArray.findFirst(document.sections, candidate => candidate.id === sectionId),
  );
  if (!section) throw invalidDocument('The requested native document section does not exist.');

  const offsetBytes = options.offsetBytes ?? 0;
  const maxBytes = options.maxBytes ?? 4_000;
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0)
    throw invalidDocument('Section offsets must be nonnegative safe UTF-8 byte offsets.');
  // Four bytes is the largest possible UTF-8 encoding for one Unicode code point.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 16_000)
    throw invalidDocument('Section page size must be between 4 and 16000 UTF-8 bytes.');

  const content = Effect.pipe(section.body, EffectString.trim);
  const bytes = new TextEncoder().encode(content);
  const sourceDigest = sha256HexSync(renderDecoded(document));
  if (options.sourceDigest !== undefined && options.sourceDigest !== sourceDigest)
    throw invalidDocument('The native document changed while its section was being paged.');
  if (offsetBytes > bytes.byteLength || (offsetBytes < bytes.byteLength && isContinuationByte(bytes[offsetBytes])))
    throw invalidDocument('The section offset is outside the body or splits a UTF-8 code point.');

  let end = Math.min(offsetBytes + maxBytes, bytes.byteLength);
  while (end < bytes.byteLength && isContinuationByte(bytes[end])) end -= 1;
  const pageContent = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offsetBytes, end));
  return {
    kind: document.kind,
    title: document.title,
    sectionId: section.id,
    heading: section.heading,
    content: pageContent,
    offsetBytes,
    nextOffsetBytes: end < bytes.byteLength ? end : null,
    sourceDigest,
  };
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;
