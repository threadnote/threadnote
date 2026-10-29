import {Array as EffectArray, Schema, Predicate} from 'effect';

import {sha256HexSync} from '@threadnote/platform/sha256';
import {applyScrubber, credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {splitUtf8} from '@threadnote/integration-core/render';
import type {PocketRecording} from './client.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const POCKET_RENDERER_VERSION = 'pocket-readable-v2';
export const POCKET_SCRUBBER_VERSION = 'credential-scrubber-v1';
export const POCKET_RECORD_LIMIT_BYTES = 480 * 1024;
export class PocketSecretBlocked extends Schema.TaggedError<PocketSecretBlocked, {readonly brand: unique symbol}>()(
  'PocketSecretBlocked',
  {message: Schema.String},
) {}
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
    throw PocketSecretBlocked.make({message: 'Pocket recording contains credential-like content.'});
  const result = applyScrubber(value, {redact: true});
  if (result.blocker) throw PocketSecretBlocked.make({message: 'Pocket recording contains credential-like content.'});
  return EffectArray.join(
    EffectArray.filter([...Effect.pipe(result.cleaned, EffectString.replace(/\r\n?/g, '\n'))], character => {
      const code = Effect.pipe(
        character,
        EffectString.charCodeAt(0),
        Effect.Option.getOrElse(() => NaN),
      );
      return (code >= 32 || code === 10 || code === 9) && (code < 127 || code > 159);
    }),
    '',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function flatten(value: unknown, path: string, output: string[], depth = 0): void {
  if (depth > 24 || output.length > 10_000)
    throw PocketSecretBlocked.make({message: 'Pocket content exceeds the structured text budget.'});
  if (typeof value === 'string' && Effect.pipe(value, EffectString.trim)) {
    if (/^(?:https?:\/\/|data:)/i.test(Effect.pipe(value, EffectString.trim))) return;
    output.push(`${path}: ${value}`);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    output.push(`${path}: ${value}`);
  } else if (EffectArray.isArray(value)) {
    EffectArray.forEach(value, (item, index) => flatten(item, `${path}[${index}]`, output, depth + 1));
  } else if (isRecord(value)) {
    for (const key of EffectRecord.keys(value).sort()) {
      if (/^(?:url|audio|video|download|signed|thumbnail|image|waveform|media|token|secret|key)$/i.test(key)) continue;
      flatten(value[key], `${path}.${key}`, output, depth + 1);
    }
  }
}

export function renderPocketRecord(record: PocketRecording): readonly PocketChunk[] {
  const title =
    splitUtf8(
      Effect.pipe(
        scrub(typeof record.title === 'string' ? record.title : record.id),
        EffectString.replaceAll('\n', ' '),
      ),
      512,
    )[0] ?? record.id;
  validateStructuredContent(record);
  const sections = [`# ${title}`];
  const metadata = EffectArray.filter(
    [
      text(record.recording_at) ? `Recorded: ${text(record.recording_at)}` : '',
      typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration >= 0
        ? `Duration: ${timestamp(record.duration)}`
        : '',
    ],
    Boolean,
  );
  if (metadata.length) sections.push(EffectArray.join(metadata, ' · '));
  const tags = EffectArray.filter(
    EffectArray.map(values(record.tags), tag => text(object(tag)?.name) || text(tag)),
    Boolean,
  );
  if (tags.length) sections.push(`Tags: ${EffectArray.join([...new Set(tags)], ', ')}`);
  const rendered = new Set<string>();
  let unsupported = false;
  for (const summary of summaries(record.summarizations)) {
    const value = object(summary);
    const content = object(value?.v2) ?? value;
    const markdown = contentText(content?.summary) || text(content?.markdown) || text(summary);
    const actions = renderActions(content?.actionItems ?? content?.action_items);
    const mindMap = renderMindMap(content?.mindMap ?? content?.mind_map);
    if (!markdown && !actions && !mindMap && summary !== null && summary !== undefined) unsupported = true;
    for (const [heading, body] of [
      ['Summary', markdown],
      ['Action items', actions],
      ['Mind map', mindMap],
    ]) {
      if (body && !rendered.has(`${heading}\n${body}`)) {
        rendered.add(`${heading}\n${body}`);
        sections.push(`## ${heading}\n\n${body}`);
      }
    }
  }
  if (unsupported) sections.push('Some summary content uses an unsupported format and could not be imported.');
  const transcript = renderTranscript(record.transcript, record.speakers);
  if (transcript) sections.push(`## Transcript\n\n${transcript}`);
  return [chunk('recording', title, EffectArray.join(sections, '\n\n'), record.updated_at)];
}

export function renderPocketCatalog(kind: 'folders' | 'tags', value: unknown): readonly PocketChunk[] {
  validateStructuredContent(value);
  const title = `Pocket ${kind}`;
  const lines: string[] = [];
  function visit(entry: unknown): void {
    if (EffectArray.isArray(entry)) {
      EffectArray.forEach(entry, visit);
      return;
    }
    const item = object(entry);
    if (!item) return;
    const name = text(item.name);
    if (name) lines.push(`- ${name}${text(item.description) ? `: ${text(item.description)}` : ''}`);
    for (const [key, child] of EffectRecord.toEntries(item)) {
      if (EffectArray.isArray(child) || (object(child) && !['metadata', 'settings'].includes(key))) visit(child);
    }
  }
  visit(value);
  return [
    chunk(
      kind,
      title,
      EffectArray.join(
        EffectArray.filter([`# ${title}`, EffectArray.join([...new Set(lines)], '\n')], Boolean),
        '\n\n',
      ),
    ),
  ];
}

function validateStructuredContent(value: unknown): void {
  const lines: string[] = [];
  flatten(value, 'recording', lines);
  scrub(EffectArray.join(lines, '\n'));
}

function chunk(pageId: string, title: string, content: string, revision?: unknown): PocketChunk {
  const body = scrub(content);
  if (Buffer.byteLength(body) > POCKET_RECORD_LIMIT_BYTES)
    throw PocketSecretBlocked.make({message: 'Pocket content exceeds the complete record byte budget.'});
  return {
    pageId,
    chunkId: 'content',
    title,
    body,
    contentHash: sha256HexSync(`${POCKET_RENDERER_VERSION}\n${POCKET_SCRUBBER_VERSION}\n${body}`),
    ...(typeof revision === 'string' ? {remoteRevision: revision} : {}),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? Effect.pipe(value, EffectString.trim) : '';
}

function contentText(value: unknown): string {
  const item = object(value);
  return text(value) || text(item?.markdown) || text(item?.text) || text(item?.content);
}

function values(value: unknown): readonly unknown[] {
  if (EffectArray.isArray(value)) return value;
  const item = object(value);
  return item ? EffectArray.map(EffectRecord.keys(item).sort(), key => item[key]) : [];
}

function summaries(value: unknown): readonly unknown[] {
  const item = object(value);
  if (
    typeof value === 'string' ||
    (item &&
      EffectArray.some(
        ['v2', 'summary', 'markdown', 'actionItems', 'action_items', 'mindMap', 'mind_map'],
        key => key in item,
      ))
  )
    return [value];
  return values(value);
}

function renderActions(value: unknown, depth = 0): string {
  if (depth > 24) return '';
  const item = object(value);
  const entries = EffectArray.isArray(value)
    ? value
    : typeof value === 'string' ||
        (item && EffectArray.some(['label', 'title', 'text', 'description'], key => key in item))
      ? [value]
      : values(item?.actions ?? item?.actionItems ?? item?.items);
  return EffectArray.join(
    EffectArray.filter(
      EffectArray.map(entries, entry => {
        const action = object(entry);
        const label =
          text(entry) || text(action?.label) || text(action?.title) || text(action?.text) || text(action?.description);
        if (!label) return '';
        const complete =
          action?.isCompleted === true || action?.is_completed === true || action?.status === 'COMPLETED';
        const assignee = text(action?.assignee);
        const description = text(action?.description);
        const context = text(action?.context);
        const details = [
          ...new Set(EffectArray.filter([description, context], detail => Boolean(detail && detail !== label))),
        ];
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const indent = '  '.repeat(depth);
        return EffectArray.join(
          EffectArray.filter(
            [
              `${indent}- [${complete ? 'x' : ' '}] ${label}${assignee ? ` — ${assignee}` : ''}${text(action?.dueDate) ? ` (due ${text(action?.dueDate)})` : ''}`,
              ...EffectArray.map(details, detail => `${indent}  ${detail}`),
              renderActions(action?.subtasks, depth + 1),
            ],
            Boolean,
          ),
          '\n',
        );
      }),
      Boolean,
    ),
    '\n',
  );
}

function renderMindMap(value: unknown): string {
  const nodes = EffectArray.filter(
    EffectArray.map(values(object(value)?.nodes ?? value), object),
    node => node !== undefined,
  );
  const id = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value));
  const byId = new Map(EffectArray.map(nodes, node => [id(node.node_id), node]));
  return EffectArray.join(
    EffectArray.filter(
      EffectArray.map(nodes, node => {
        const title = text(node.title);
        if (!title) return '';
        let parent = id(node.parent_node_id);
        const seen = new Set([id(node.node_id)]);
        let depth = 0;
        while (byId.has(parent) && !seen.has(parent) && depth < 24) {
          seen.add(parent);
          depth++;
          parent = id(byId.get(parent)?.parent_node_id);
        }
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        return `${'  '.repeat(depth)}- ${title}`;
      }),
      Boolean,
    ),
    '\n',
  );
}

function timestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return `${hours ? `${hours}:` : ''}${Effect.pipe(String(minutes), EffectString.padStart(2, '0'))}:${Effect.pipe(String(total % 60), EffectString.padStart(2, '0'))}`;
}

function renderTranscript(value: unknown, speakers: unknown): string {
  const transcript = object(value);
  const segments = EffectArray.isArray(value) ? value : values(transcript?.segments);
  const names = object(speakers);
  const lines = EffectArray.filter(
    EffectArray.map(segments, segment => {
      const item = object(segment);
      const content = text(segment) || text(item?.text) || text(item?.originalText);
      if (!content) return '';
      const speaker =
        text(item?.speakerName) || text(object(names?.[text(item?.speaker)])?.name) || text(item?.speaker);
      const time =
        typeof item?.start === 'number' && Number.isFinite(item.start) && item.start >= 0
          ? `[${timestamp(item.start)}] `
          : '';
      const original = text(item?.originalText);
      return `${time}${speaker ? `${speaker}: ` : ''}${content}${original && original !== content ? `\nOriginal: ${original}` : ''}`;
    }),
    Boolean,
  );
  return lines.length ? EffectArray.join(lines, '\n\n') : contentText(value);
}
