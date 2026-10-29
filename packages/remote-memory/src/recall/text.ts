import {Array as EffectArray} from 'effect';
import {parseMemoryDocument} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function remoteMemoryExcerpt(content: string, query: string): string {
  const record = parseMemoryDocument('threadnote://share/excerpt/memories/durable/project/topic.md', content);
  const body = Effect.pipe(record?.body ?? content, EffectString.replace(/\s+/g, ' '), EffectString.trim);
  const terms = EffectArray.filter(Effect.pipe(query, EffectString.toLowerCase, EffectString.split(/\s+/)), Boolean);
  const lower = Effect.pipe(body, EffectString.toLowerCase);
  const first =
    EffectArray.filter(
      EffectArray.map(terms, term =>
        Effect.pipe(
          lower,
          EffectString.indexOf(term),
          Effect.Option.getOrElse(() => -1),
        ),
      ),
      index => index >= 0,
    ).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 120);
  const excerpt = Effect.pipe(body, EffectString.slice(start, start + 600));
  return `${start > 0 ? '…' : ''}${excerpt}${start + 600 < body.length ? '…' : ''}`;
}

export function remoteRecallTextMatches(content: string, query: string): boolean {
  const haystack = Effect.pipe(content, EffectString.toLowerCase);
  return EffectArray.every(
    EffectArray.filter(Effect.pipe(query, EffectString.toLowerCase, EffectString.split(/\s+/)), Boolean),
    term => Effect.pipe(haystack, EffectString.includes(term)),
  );
}
