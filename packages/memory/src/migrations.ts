import {Schema} from 'effect';
import {assertMemoryDocumentSchemaWritable, parseMemoryDocument} from './document.js';
import {MEMORY_SCHEMA_VERSION} from './code/citation.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export class MemoryOperationError extends Schema.TaggedError<MemoryOperationError, {readonly brand: unique symbol}>()(
  'MemoryOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/** Upgrades only the canonical v4 header; all existing metadata, including citations, remains byte-for-byte intact. */
export function migrateMemoryDocumentV4ToV5(content: string): string {
  assertMemoryDocumentSchemaWritable(content);
  if (parseMemoryDocument('threadnote://memory/migration', content)?.metadata.schemaVersion !== 4) {
    return content;
  }
  return Effect.pipe(content, EffectString.replace(/^schema_version: 4(\r?)$/mu, 'schema_version: 5$1'));
}

/** Upgrade the canonical version header while preserving all existing evidence bytes. */
export function migrateMemoryDocumentToCurrent(content: string): string {
  const v5 = migrateMemoryDocumentV4ToV5(content);
  return Effect.pipe(
    v5,
    EffectString.replace(/^schema_version: [5-9](\r?)$/mu, `schema_version: ${MEMORY_SCHEMA_VERSION}$1`),
  );
}
