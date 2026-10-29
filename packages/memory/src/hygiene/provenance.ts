import {parseResourceId} from '@threadnote/store/resource-id';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

export const MEMORY_HYGIENE_SOURCES_HEADING = '## Threadnote Hygiene Sources';
export const MEMORY_HYGIENE_SOURCES_MARKER = '<!-- threadnote:hygiene-sources:v1 -->';

export interface ParsedMemoryHygieneSources {
  readonly body: string;
  readonly uris: readonly string[];
  readonly versioned: boolean;
}

/**
 * Parses Threadnote's terminal hygiene-provenance trailer. The unmarked legacy
 * form is accepted only when it is separated from the body and consists solely
 * of canonical URI bullets, so ordinary user-authored Markdown is preserved.
 */
export function parseMemoryHygieneSources(content: string): ParsedMemoryHygieneSources | undefined {
  const lines = Effect.pipe(content, EffectString.split(/\r?\n/));
  const markerIndex = lines.lastIndexOf(MEMORY_HYGIENE_SOURCES_MARKER);
  const headingIndex = lines.lastIndexOf(MEMORY_HYGIENE_SOURCES_HEADING);
  const versioned = markerIndex !== -1 && headingIndex === markerIndex + 1;
  const trailerStart = versioned ? markerIndex : headingIndex;
  if (
    trailerStart === -1 ||
    (!versioned &&
      trailerStart > 0 &&
      Effect.pipe(lines[trailerStart - 1], effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      ) !== '')
  ) {
    return undefined;
  }
  let bulletStart = headingIndex + 1;
  while (
    Effect.pipe(lines[bulletStart], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) === ''
  )
    bulletStart += 1;
  let trailerEnd = lines.length;
  while (
    trailerEnd > bulletStart &&
    Effect.pipe(lines[trailerEnd - 1], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) === ''
  )
    trailerEnd -= 1;
  if (bulletStart >= trailerEnd) return undefined;
  const uris: string[] = [];
  for (const line of lines.slice(bulletStart, trailerEnd)) {
    const rawUri = /^- (threadnote:\/\/\S+)$/.exec(line)?.[1];
    const uri = rawUri ? canonicalResourceInput(rawUri) : undefined;
    if (!uri || uri !== rawUri) return undefined;
    uris.push(uri);
  }
  return {
    body: Effect.pipe(EffectArray.join(lines.slice(0, trailerStart), '\n'), EffectString.replace(/\s+$/u, '')),
    uris: [...new Set(uris)].sort(),
    versioned,
  };
}

/**
 * Removes a generated trailer, including the strict terminal URI-only grammar
 * written before v1 markers were introduced. Prose under the same heading is
 * never recognized as provenance.
 */
export function stripGeneratedMemoryHygieneSources(content: string): string {
  const parsed = parseMemoryHygieneSources(content);
  return parsed?.body ?? content;
}

function canonicalResourceInput(uri: string): string | undefined {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return undefined;
  }
}
