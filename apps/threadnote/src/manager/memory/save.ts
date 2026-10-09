import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {assertMemoryDocumentSchemaWritable, parseMemoryDocument} from '@threadnote/memory/document';
import {sharedMemoryUriParts} from '../../share/index.js';
import {applyScrubber} from '@threadnote/platform/scrubber';
import type {RuntimeConfig} from '@threadnote/workspace/config';

/** Fail-closed validation for Manager's exact raw shared-memory editor. */
export function assertManagerRawSharedMemorySave(
  config: RuntimeConfig,
  uri: string,
  existingContent: string,
  expectedContent: string | undefined,
  content: string,
): void {
  if (!expectedContent) {
    throw new Error('Raw shared memory saves require the original content returned by Manager. Reload and retry.');
  }
  if (existingContent !== expectedContent)
    throw new Error(`${uri} changed after it was opened in Manager. Reload and retry.`);
  assertMemoryDocumentSchemaWritable(existingContent);
  assertMemoryDocumentSchemaWritable(content);
  assertManagerRelationHeadersUnchanged(existingContent, content);
  assertManagerObsidianEvidenceUnchanged(existingContent, content);
  assertManagerSourceEvidenceUnchanged(existingContent, content);
  assertManagerMemoryIdentityUnchanged(uri, existingContent, content);
  const record = parseMemoryDocument(uri, content);
  if (!record) throw new Error('Raw shared memory content must be a valid Threadnote memory document.');
  const address = sharedMemoryUriParts(config, uri);
  if (
    address?.kind !== 'durable' ||
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== address.kind ||
    record.metadata.project !== address.project ||
    record.metadata.topic !== address.topic
  ) {
    throw new Error('Raw shared memory metadata must match its canonical shared URI.');
  }
  const citationBlocker = memoryCodeCitationContentSharingBlocker(uri, content);
  if (citationBlocker) throw new Error(memoryCodeCitationSharingBlockerMessage(citationBlocker));
  const scrub = applyScrubber(content, {redact: false});
  if (scrub.blocker) {
    throw new Error(`Refusing to save shared memory ${uri}: possible ${scrub.blocker}.`);
  }
}

export function assertManagerRawPersonalMemorySave(
  uri: string,
  existingContent: string,
  expectedContent: string | undefined,
  content: string,
): void {
  if (expectedContent !== undefined && existingContent !== expectedContent) {
    throw new Error(`${uri} changed after it was opened in Manager. Reload and retry.`);
  }
  assertMemoryDocumentSchemaWritable(existingContent);
  assertMemoryDocumentSchemaWritable(content);
  assertManagerRelationHeadersUnchanged(existingContent, content);
  assertManagerObsidianEvidenceUnchanged(existingContent, content);
  assertManagerSourceEvidenceUnchanged(existingContent, content);
  assertManagerMemoryIdentityUnchanged(uri, existingContent, content);
  const record = parseMemoryDocument(uri, content);
  if (!record) throw new Error('Raw personal memory content must be a valid Threadnote memory document.');
  if ((record.metadata.citationErrors?.length ?? 0) > 0) {
    throw new Error('Malformed code citation metadata must be repaired or recaptured before saving.');
  }
}

function assertManagerObsidianEvidenceUnchanged(existingContent: string, content: string): void {
  const header = (value: string) =>
    value
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n\n', 1)[0]
      ?.split('\n')
      .filter(line => /^\s*obsidian_evidence\s*:/u.test(line)) ?? [];
  if (JSON.stringify(header(existingContent)) !== JSON.stringify(header(content))) {
    throw new Error(
      'Raw Manager saves cannot change Obsidian evidence identity. Derive a new memory from the exact synced note revision.',
    );
  }
}

function assertManagerSourceEvidenceUnchanged(existingContent: string, content: string): void {
  const header = (value: string) =>
    value
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n\n', 1)[0]
      ?.split('\n')
      .filter(line => /^\s*source_evidence\s*:/u.test(line)) ?? [];
  if (JSON.stringify(header(existingContent)) !== JSON.stringify(header(content))) {
    throw new Error(
      'Raw Manager saves cannot change source evidence identity. Derive a new memory from the exact synced source revision.',
    );
  }
}

function assertManagerRelationHeadersUnchanged(existingContent: string, content: string): void {
  if (JSON.stringify(relationHeaderLines(existingContent)) !== JSON.stringify(relationHeaderLines(content))) {
    throw new Error(
      'Raw Manager saves cannot change typed memory relations. Use remember_context or threadnote remember until the structured relation editor is available.',
    );
  }
}

function assertManagerMemoryIdentityUnchanged(uri: string, existingContent: string, content: string): void {
  const existingMemoryId = parseMemoryDocument(uri, existingContent)?.metadata.memoryId;
  const updatedMemoryId = parseMemoryDocument(uri, content)?.metadata.memoryId;
  if (existingMemoryId !== updatedMemoryId) {
    throw new Error(
      'Raw Manager saves cannot change stable memory_id. Use remember_context or threadnote remember for identity-safe replacement.',
    );
  }
}

function relationHeaderLines(content: string): readonly string[] {
  const lines = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const headerEnd = lines.findIndex(line => line.trim() === '');
  return lines.slice(0, headerEnd === -1 ? lines.length : headerEnd).filter(line => line.startsWith('relation:'));
}
