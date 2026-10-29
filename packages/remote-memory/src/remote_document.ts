import {randomUuidV4} from '@threadnote/platform/uuid';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {type MemoryCodeCitationV1, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {inspectRemoteMemoryContent} from '@threadnote/memory/remote/content';
import type {RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {assertRemoteBodyReplacementSupported} from './document_compatibility.js';
import {remoteMemoryError} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function makeRemoteDocument(
  input: RemoteRememberInputV1,
  hasCurrent: boolean,
  uri: string,
  sourceAgentClient: 'cursor' | 'remote',
  now: Date,
  priorBody: string | undefined,
  memoryId?: string,
  codeCitations?: readonly MemoryCodeCitationV1[],
): {readonly content: string; readonly contentHash: string; readonly relations?: readonly MemoryRelation[]} {
  const timestamp = now.toISOString();
  const prior = hasCurrent && priorBody ? parseMemoryDocument(uri, priorBody) : undefined;
  if (hasCurrent && priorBody) assertRemoteBodyReplacementSupported(priorBody);
  const metadata: MemoryMetadata = {
    ...prior?.metadata,
    codeCitations: codeCitations === undefined ? prior?.metadata.codeCitations : codeCitations,
    createdAt: prior?.metadata.createdAt ?? prior?.metadata.timestamp ?? timestamp,
    kind: input.kind,
    memoryId:
      prior?.metadata.memoryId ?? memoryId ?? `tn_${Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''))}`,
    project: input.project,
    relations: input.relations === undefined ? prior?.metadata.relations : input.relations,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient,
    status: 'active',
    timestamp,
    topic: input.topic,
    updatedAt: timestamp,
    visibility: 'shared',
  };
  const formatted = formatMemoryDocument(
    input.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata,
    Effect.pipe(input.text, EffectString.trim),
  );
  const inspected = inspectRemoteMemoryContent(formatted);
  if (!inspected.allowed) {
    throw remoteMemoryError('invalid_request', `Remote memory content was blocked by ${inspected.category} policy.`);
  }
  return {
    content: inspected.canonicalContent,
    contentHash: sha256HexSync(inspected.canonicalContent),
    ...(metadata.relations?.length ? {relations: metadata.relations} : {}),
  };
}
