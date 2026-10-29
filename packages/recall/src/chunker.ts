import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const RECALL_CHUNKER_VERSION = 3 as const;
export const DEFAULT_CHUNK_MAX_CHARACTERS = 2400;
export const DEFAULT_CHUNK_OVERLAP_CHARACTERS = 240;

export interface RecallChunk {
  readonly content: string;
  readonly fingerprint: string;
  readonly heading: string;
  readonly id: string;
  readonly index: number;
  readonly uri: string;
}

export function chunkRecallDocument(
  uri: string,
  source: string,
  options: {
    readonly maxCharacters?: number;
    readonly overlapCharacters?: number;
  } = {},
): readonly RecallChunk[] {
  const maxCharacters = options.maxCharacters ?? DEFAULT_CHUNK_MAX_CHARACTERS;
  const overlapCharacters = options.overlapCharacters ?? DEFAULT_CHUNK_OVERLAP_CHARACTERS;
  if (maxCharacters < 256 || overlapCharacters < 0 || overlapCharacters >= maxCharacters / 2) {
    throw new Error('Recall chunk sizes are invalid.');
  }
  const normalized = normalizeChunkSource(source);
  if (!normalized) return [];
  const sections = markdownSections(normalized);
  const rawChunks: Array<{readonly content: string; readonly heading: string}> = [];
  for (const section of sections) {
    const prefix = section.heading ? `${section.heading}\n\n` : '';
    const available = maxCharacters - prefix.length;
    if (available < 128) continue;
    const windows = splitWithOverlap(section.body, available, overlapCharacters);
    for (const window of windows) {
      const content = Effect.pipe(`${prefix}${window}`, EffectString.trim);
      if (content) rawChunks.push({content, heading: section.heading});
    }
  }
  return EffectArray.map(rawChunks, (chunk, index) => {
    const fingerprint = digest(chunk.content);
    return {
      ...chunk,
      fingerprint,
      id: digest(`${RECALL_CHUNKER_VERSION}\n${uri}\n${index}\n${fingerprint}`),
      index,
      uri,
    };
  });
}

function normalizeChunkSource(value: string): string {
  return Effect.pipe(
    EffectArray.join(
      EffectArray.map(Effect.pipe(value, EffectString.replace(/\r\n?/g, '\n'), EffectString.split('\n')), line =>
        Effect.pipe(line, EffectString.replace(/[ \t]+$/g, '')),
      ),
      '\n',
    ),
    EffectString.replace(/\n{4,}/g, '\n\n\n'),
    EffectString.trim,
  );
}

function markdownSections(source: string): readonly {readonly body: string; readonly heading: string}[] {
  const sections: Array<{body: string; heading: string}> = [];
  const headingStack: string[] = [];
  let body: string[] = [];
  const flush = () => {
    const content = Effect.pipe(EffectArray.join(body, '\n'), EffectString.trim);
    if (content) sections.push({body: content, heading: EffectArray.join(headingStack, ' > ')});
    body = [];
  };
  for (const line of Effect.pipe(source, EffectString.split('\n'))) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      body.push(line);
      continue;
    }
    flush();
    const level = match[1].length;
    headingStack.splice(level - 1);
    headingStack[level - 1] = Effect.pipe(match[2], EffectString.trim);
  }
  flush();
  return sections.length > 0 ? sections : [{body: source, heading: ''}];
}

function splitWithOverlap(source: string, maximum: number, overlap: number): readonly string[] {
  if (source.length <= maximum) return [source];
  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + maximum);
    if (end < source.length) {
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
      const paragraph = source.lastIndexOf('\n\n', end);
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
      const line = source.lastIndexOf('\n', end);
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
      const space = source.lastIndexOf(' ', end);
      const boundary = EffectArray.filter(
        [paragraph >= 0 ? paragraph + 2 : -1, line >= 0 ? line + 1 : -1, space + 1],
        candidate => candidate > start + Math.floor(maximum * 0.6),
      ).sort((left, right) => right - left)[0];
      if (boundary !== undefined) end = boundary;
    }
    const chunk = Effect.pipe(source, EffectString.slice(start, end), EffectString.trim);
    if (chunk) chunks.push(chunk);
    if (end >= source.length) break;
    const next = Math.max(start + 1, end - overlap);
    start = skipWhitespace(source, next);
  }
  return chunks;
}

function skipWhitespace(source: string, index: number): number {
  let current = index;
  while (current < source.length && /\s/.test(source[current])) current += 1;
  return current;
}

function digest(value: string): string {
  return sha256HexSync(value);
}
