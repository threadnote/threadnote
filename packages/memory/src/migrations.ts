import {Schema} from 'effect';
import {assertMemoryDocumentSchemaWritable, parseMemoryDocument} from './document.js';
import {MEMORY_SCHEMA_VERSION} from './code/citation.js';

export class MemoryOperationError extends Schema.TaggedError<MemoryOperationError>()('MemoryOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Upgrades only the canonical v4 header; all existing metadata, including citations, remains byte-for-byte intact. */
export function migrateMemoryDocumentV4ToV5(content: string): string {
  assertMemoryDocumentSchemaWritable(content);
  if (parseMemoryDocument('threadnote://memory/migration', content)?.metadata.schemaVersion !== 4) {
    return content;
  }
  return content.replace(/^schema_version: 4(\r?)$/mu, 'schema_version: 5$1');
}

/** Current authoring schema adds optional derivation; upgrading preserves existing evidence verbatim. */
export function migrateMemoryDocumentToCurrent(content: string): string {
  const v5 = migrateMemoryDocumentV4ToV5(content);
  return v5.replace(/^schema_version: 5(\r?)$/mu, `schema_version: ${MEMORY_SCHEMA_VERSION}$1`);
}
