import {assertMemoryDocumentSchemaWritable, isSharedMemoryUri} from '@threadnote/memory/document';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/hygiene';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {parseResourceId} from '@threadnote/store/resource-id';
import {MemoryOperationError} from './migrations.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function validateImportedMemory(uri: string, content: string): MemoryRecord | undefined {
  assertMemoryDocumentSchemaWritable(content);
  const parsed = parseMemoryDocument(uri, content);
  const marker = Effect.pipe(
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    Effect.pipe(content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n')).split('\n', 1)[0],
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if ((marker === 'MEMORY' || marker === 'HANDOFF') && !parsed) {
    throw MemoryOperationError.make({message: `Invalid Threadnote memory document in pack: ${uri}.`});
  }
  const blocker = memoryCodeCitationContentSharingBlocker(uri, content);
  if (
    blocker === 'malformed-citation' ||
    (blocker && (isSharedMemoryUri(uri) || parseResourceId(uri).namespace === 'share'))
  ) {
    throw MemoryOperationError.make({
      message: `Refusing to import ${uri}: ${memoryCodeCitationSharingBlockerMessage(blocker)}.`,
    });
  }
  return parsed;
}

export function assertImportedMemoryAssociation(
  uri: string,
  existing: string,
  incoming: MemoryRecord | undefined,
): void {
  const current = validateImportedMemory(uri, existing);
  if (
    current?.metadata.sourceEvidence &&
    JSON.stringify(current.metadata.sourceEvidence) !== JSON.stringify(incoming?.metadata.sourceEvidence)
  ) {
    throw MemoryOperationError.make({message: `Import would discard or change pinned source evidence: ${uri}.`});
  }
  if (
    current?.metadata.obsidianEvidence &&
    JSON.stringify(current.metadata.obsidianEvidence) !== JSON.stringify(incoming?.metadata.obsidianEvidence)
  ) {
    throw MemoryOperationError.make({message: `Import would discard or change pinned Obsidian evidence: ${uri}.`});
  }
}
