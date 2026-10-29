import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {memoryCodeCitationSharingBlocker} from '@threadnote/memory/code/citation-policy';
import {remoteMemoryError} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function assertRemoteBodyReplacementSupported(content: string): void {
  assertMemoryDocumentSchemaWritable(content);
  const normalized = Effect.pipe(content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n'));
  if (/\n\n<!-- MEMORY_FIELDS\n[\s\S]*?\n-->\s*$/u.test(normalized)) unsupportedMetadata();
  const record = parseMemoryDocument('threadnote://share/compatibility/memories/durable/project/topic.md', content);
  if (!record) unsupportedMetadata();
  if (memoryCodeCitationSharingBlocker(record.metadata)) unsupportedMetadata();
  let formatted: string;
  try {
    formatted = formatMemoryDocument(record.headerTitle, record.metadata, '');
  } catch {
    unsupportedMetadata();
  }
  const remaining = new Map<string, number>();
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  for (const line of Effect.pipe(formatted.split('\n\n', 1)[0], EffectString.split('\n'))) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  // Tolerant readers may discard unknown or malformed fields; a rewrite must preserve every occurrence.
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  for (const line of Effect.pipe(normalized.split('\n\n', 1)[0], EffectString.split('\n'))) {
    const count = remaining.get(line) ?? 0;
    if (count === 0) unsupportedMetadata();
    remaining.set(line, count - 1);
  }
}

function unsupportedMetadata(): never {
  throw remoteMemoryError(
    'invalid_request',
    'This document contains metadata the remote body editor cannot preserve. Repair it through the Git share before editing remotely.',
    {reason: 'unsupported_remote_metadata'},
  );
}
