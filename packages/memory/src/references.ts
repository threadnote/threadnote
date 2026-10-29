import {parseResourceId} from '@threadnote/store/resource-id';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/**
 * Validates and dedupes caller-supplied reference URIs so a handoff can record
 * one-way, read-only pointers to other memories/sessions. Invalid URIs throw
 * (loud failure) rather than silently dropping; returns undefined when empty so
 * the `references:` header lines are omitted entirely.
 */
export function normalizeReferenceUris(references: readonly string[] | undefined): readonly string[] | undefined {
  if (!references || references.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const raw of references) {
    const uri = Effect.pipe(raw, EffectString.trim);
    if (!uri) {
      continue;
    }
    const canonicalUri = parseResourceId(uri).canonicalUri;
    seen.add(canonicalUri);
  }
  return seen.size > 0 ? [...seen] : undefined;
}
