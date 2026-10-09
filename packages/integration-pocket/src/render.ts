import {Data} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {applyScrubber, credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {splitUtf8} from '@threadnote/integration-core/render';
import type {PocketRecording} from './client.js';

export const POCKET_RENDERER_VERSION = 'pocket-text-v1';
export const POCKET_SCRUBBER_VERSION = 'credential-scrubber-v1';
export class PocketSecretBlocked extends Data.TaggedError('PocketSecretBlocked')<{readonly message: string}> {}
export interface PocketChunk {
  readonly pageId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly body: string;
  readonly contentHash: string;
  readonly remoteRevision?: string;
}

function scrub(value: string): string {
  if (
    credentialScrubberBlocker(value) ||
    /\b(?:password|api[_-]?key|api[_-]?token|access[_-]?token|client[_-]?secret|authorization)\b\s*[:=]\s*\S/iu.test(
      value,
    ) ||
    /\bbearer\s+\S{8,}/iu.test(value) ||
    /\bpk_[A-Za-z0-9_-]{8,}\b/u.test(value)
  )
    throw new PocketSecretBlocked({message: 'Pocket recording contains credential-like content.'});
  const result = applyScrubber(value, {redact: true});
  if (result.blocker) throw new PocketSecretBlocked({message: 'Pocket recording contains credential-like content.'});
  return [...result.cleaned.replace(/\r\n?/g, '\n')]
    .filter(character => {
      const code = character.charCodeAt(0);
      return (code >= 32 || code === 10 || code === 9) && (code < 127 || code > 159);
    })
    .join('');
}

function flatten(value: unknown, path: string, output: string[], depth = 0): void {
  if (depth > 24 || output.length > 10_000)
    throw new PocketSecretBlocked({message: 'Pocket content exceeds the structured text budget.'});
  if (typeof value === 'string' && value.trim()) {
    if (/^(?:https?:\/\/|data:)/i.test(value.trim())) return;
    output.push(`${path}: ${value}`);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    output.push(`${path}: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, output, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      if (/^(?:url|audio|video|download|signed|thumbnail|image|waveform|media|token|secret|key)$/i.test(key)) continue;
      flatten((value as Record<string, unknown>)[key], `${path}.${key}`, output, depth + 1);
    }
  }
}

export function renderPocketRecord(record: PocketRecording): readonly PocketChunk[] {
  const title =
    splitUtf8(scrub(typeof record.title === 'string' ? record.title : record.id).replaceAll('\n', ' '), 512)[0] ??
    record.id;
  const lines: string[] = [];
  flatten(record, 'recording', lines);
  const text = scrub(lines.join('\n'));
  const fragments = splitUtf8(text, 16 * 1024);
  return fragments.map((body, ordinal) => ({
    pageId: 'recording',
    chunkId: `part-${ordinal}`,
    title,
    body,
    contentHash: sha256HexSync(`${POCKET_RENDERER_VERSION}\n${POCKET_SCRUBBER_VERSION}\n${body}`),
    ...(typeof record.updated_at === 'string' ? {remoteRevision: record.updated_at} : {}),
  }));
}

export function renderPocketCatalog(kind: 'folders' | 'tags', value: unknown): readonly PocketChunk[] {
  const lines: string[] = [];
  flatten(value, kind, lines);
  return splitUtf8(scrub(lines.join('\n')), 16 * 1024).map((body, ordinal) => ({
    pageId: kind,
    chunkId: `part-${ordinal}`,
    title: `Pocket ${kind}`,
    body,
    contentHash: sha256HexSync(`${POCKET_RENDERER_VERSION}\n${POCKET_SCRUBBER_VERSION}\n${body}`),
  }));
}
