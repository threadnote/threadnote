import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Predicate, Result, Stream} from 'effect';
import {applyScrubber} from './share/index.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_INTENTS = 5;
const MAX_INTENT_CHARS = 160;
const MAX_TOOLS = 12;

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return Effect2.pipe(content, EffectString.trim) || undefined;
  }
  if (!EffectArray.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (Predicate.isObject(part) && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  const joined = Effect2.pipe(EffectArray.join(parts, ' '), EffectString.trim);
  return joined || undefined;
}

function extractToolNames(content: unknown): readonly string[] {
  if (!EffectArray.isArray(content)) {
    return [];
  }
  const names: string[] = [];
  for (const part of content) {
    if (Predicate.isObject(part) && part.type === 'tool_use' && typeof part.name === 'string') {
      names.push(part.name);
    }
  }
  return names;
}

function truncate(value: string, max: number): string {
  const oneLine = Effect2.pipe(value, EffectString.replace(/\s+/g, ' '), EffectString.trim);
  return oneLine.length > max ? `${Effect2.pipe(oneLine, EffectString.slice(0, max - 1))}…` : oneLine;
}

/**
 * Best-effort, heuristic distillation of an agent transcript (Claude Code
 * JSONL) into a short summary: event count, tools used, and recent user
 * intents. Returns undefined on any read/parse failure or empty transcript so
 * the caller can fall back to a state-only handoff. The transcript format is
 * agent-specific and unstable, so every field is defensive. Callers MUST scrub
 * the result before persisting — user intents can contain secrets.
 */
export const distillTrace = Effect.fn('trace.distill')(function* (transcriptPath: string) {
  const raw = yield* readTranscriptTail(transcriptPath);
  if (raw === undefined) {
    return undefined;
  }
  if (!Effect2.pipe(raw, EffectString.trim)) {
    return undefined;
  }
  let events = 0;
  const tools = new Set<string>();
  const intents: string[] = [];
  for (const line of Effect2.pipe(raw, EffectString.split('\n'))) {
    const trimmed = Effect2.pipe(line, EffectString.trim);
    if (!trimmed) {
      continue;
    }
    const parsedResult = Result.try((): unknown => JSON.parse(trimmed));
    if (Result.isFailure(parsedResult)) {
      continue;
    }
    const parsed = parsedResult.success;
    if (!Predicate.isObject(parsed)) {
      continue;
    }
    events += 1;
    const message = Predicate.isObject(parsed.message) ? parsed.message : parsed;
    const role =
      typeof message.role === 'string' ? message.role : typeof parsed.type === 'string' ? parsed.type : undefined;
    if (role === 'user') {
      const text = extractText(message.content);
      if (text) {
        const scrubbed = applyScrubber(text, {redact: true});
        if (scrubbed.blocker) {
          return undefined;
        }
        intents.push(truncate(scrubbed.cleaned, MAX_INTENT_CHARS));
      }
    } else if (role === 'assistant') {
      for (const name of extractToolNames(message.content)) {
        tools.add(name);
      }
    }
  }
  if (events === 0) {
    return undefined;
  }
  const lines = [`- ${events} transcript events`];
  if (tools.size > 0) {
    lines.push(`- tools used: ${EffectArray.join([...tools].slice(0, MAX_TOOLS), ', ')}`);
  }
  const recentIntents = intents.slice(-MAX_INTENTS);
  if (recentIntents.length > 0) {
    lines.push('- recent intents:');
    for (const intent of recentIntents) {
      lines.push(`  - ${intent}`);
    }
  }
  return EffectArray.join(lines, '\n');
});

const readTranscriptTail = Effect.fn('trace.readTail')((transcriptPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(transcriptPath);
    const size = Number(info.size);
    if (size === 0) {
      return undefined;
    }
    if (size <= MAX_TRANSCRIPT_BYTES) {
      return yield* fs.readFileString(transcriptPath);
    }
    const start = size - MAX_TRANSCRIPT_BYTES;
    const chunks = yield* fs
      .stream(transcriptPath, {bytesToRead: MAX_TRANSCRIPT_BYTES, offset: start})
      .pipe(Stream.runCollect);
    const length = EffectArray.reduce(chunks, 0, (total, chunk) => total + chunk.byteLength);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Effect2.pipe(new TextDecoder().decode(bytes), EffectString.replace(/^[^\n]*(?:\n|$)/, ''));
  }).pipe(Effect.orElseSucceed(() => undefined)),
);
