import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {memoryCodeCitationContentSharingBlocker} from '@threadnote/memory/code/citation-policy';
import {inspectRemoteMemoryContent} from '@threadnote/memory/remote/content';
import type {GitCanonicalListedPath} from './canonical_store.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type GitIngestStatus = 'active' | 'archived' | 'expired' | 'superseded';
export type GitIngestRejection = 'content_policy' | 'metadata' | 'unsupported_entry';
export type GitIngestDocument =
  | {readonly accepted: true; readonly status: GitIngestStatus}
  | {readonly accepted: false; readonly reason: GitIngestRejection};

function isGitIngestStatus(value: string): value is GitIngestStatus {
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded';
}
const criticalFields = new Set(['kind', 'status', 'project', 'repo', 'topic', 'schema_version']);

export function classifyGitIngestDocument(
  content: string,
  path: Pick<GitCanonicalListedPath, 'kind' | 'project' | 'topic'>,
): GitIngestDocument {
  if (!inspectRemoteMemoryContent(content).allowed) return {accepted: false, reason: 'content_policy'};
  if (memoryCodeCitationContentSharingBlocker('threadnote://share/ingest/memories/durable/project/topic.md', content)) {
    return {accepted: false, reason: 'metadata'};
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const header = Effect.pipe(content, EffectString.trim, EffectString.replace(/\r\n?/gu, '\n')).split('\n\n', 1)[0];
  const lines = Effect.pipe(header, EffectString.split('\n'));
  const marker = Effect.pipe(lines[0], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (marker !== 'MEMORY' && marker !== 'HANDOFF') return {accepted: true, status: 'active'};
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z_]+):\s*(.*)$/u.exec(Effect.pipe(line, EffectString.trim));
    if (!match) return {accepted: false, reason: 'metadata'};
    const [, key, value] = match;
    if (!criticalFields.has(key)) continue;
    if (fields.has(key) || !Effect.pipe(value, EffectString.trim)) return {accepted: false, reason: 'metadata'};
    fields.set(key, Effect.pipe(value, EffectString.trim));
  }
  const schema = fields.get('schema_version');
  const status = fields.get('status');
  if (
    (schema !== undefined && (!/^[1-9][0-9]*$/u.test(schema) || Number(schema) > MEMORY_SCHEMA_VERSION)) ||
    (status !== undefined && !isGitIngestStatus(status)) ||
    (fields.has('project') && fields.has('repo')) ||
    (fields.has('kind') && fields.get('kind') !== path.kind) ||
    (fields.has('project') && fields.get('project') !== path.project) ||
    (fields.has('repo') && fields.get('repo') !== path.project) ||
    (fields.has('topic') && fields.get('topic') !== path.topic) ||
    marker !== (path.kind === 'handoff' ? 'HANDOFF' : 'MEMORY')
  )
    return {accepted: false, reason: 'metadata'};
  const parsed = parseMemoryDocument('threadnote://share/ingest/memories/durable/project/topic.md', content);
  if (!parsed || parsed.metadata.kind !== path.kind) return {accepted: false, reason: 'metadata'};
  return {accepted: true, status: status ?? 'active'};
}
