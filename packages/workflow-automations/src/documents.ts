import {Schema} from 'effect';
import {WorkflowAutomationError} from './contracts.js';

const invalidDocument = (message: string) => WorkflowAutomationError.make({code: 'invalid-document', message});
const heading = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter(value =>
    value.trim().length === 0 ||
    [...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
      ? 'Heading is blank or contains a control character.'
      : undefined,
  ),
);
const sectionId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    value.includes('..') || value === 'constructor' || value === 'prototype' || value === '__proto__'
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
    'alternatives',
    'phase',
    'experience',
  ]),
  title: heading,
  sections: Schema.Array(sectionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export type NativeDocumentEnvelope = typeof NativeDocumentEnvelopeSchema.Type;

const renderedBytes = (document: NativeDocumentEnvelope): number =>
  new TextEncoder().encode(renderDecoded(document)).byteLength;
const renderDecoded = (document: NativeDocumentEnvelope): string =>
  `# ${document.title}\n\n${document.sections.map(section => `## ${section.heading}\n\n${section.body.trim()}`).join('\n\n')}\n`;

export function decodeNativeDocument(input: unknown): NativeDocumentEnvelope {
  let document: NativeDocumentEnvelope;
  try {
    document = Schema.decodeUnknownSync(NativeDocumentEnvelopeSchema, {onExcessProperty: 'error'})(input);
  } catch {
    throw invalidDocument('The native document envelope is malformed or contains unsupported fields.');
  }
  if (new Set(document.sections.map(section => section.id)).size !== document.sections.length)
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
    sections: document.sections.map(section => ({
      id: section.id,
      heading: section.heading,
      bytes: new TextEncoder().encode(section.body.trim()).byteLength,
    })),
  };
}
