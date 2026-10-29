import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const CODE_IDENTIFIER_TOKEN_PATTERN =
  /(?<![\p{L}\p{M}\p{N}_$\u200c\u200d])\p{L}[\p{L}\p{M}\p{N}]*(?![\p{L}\p{M}\p{N}_$\u200c\u200d])/gu;
const CODE_IDENTIFIER_WHOLE_TOKEN_PATTERN = /^\p{L}[\p{L}\p{M}\p{N}]*$/u;
const CASE_TRANSITION_PATTERN = /[\p{Ll}\p{N}]\p{M}*[\p{Lu}\p{Lt}]/u;
const ACRONYM_WORD_TRANSITION_PATTERN = /[\p{Lu}\p{Lt}]{2,}\p{Ll}/u;

/**
 * Extract identifier tokens whose internal casing distinguishes them from
 * ordinary words. NFC preserves exact spelling while making canonically
 * equivalent source text comparable.
 */
export function casedCodeIdentifiers(value: string): readonly string[] {
  return EffectArray.filter(
    EffectArray.map(
      [...Effect.pipe(value, EffectString.normalize('NFC'), EffectString.matchAll(CODE_IDENTIFIER_TOKEN_PATTERN))],
      match => match[0],
    ),
    isDistinctivelyCasedCodeIdentifier,
  );
}

/** Return a normalized identifier only when the entire value is one code token. */
export function exactCasedCodeIdentifier(value: string): string | undefined {
  const normalized = Effect.pipe(value, EffectString.trim, EffectString.normalize('NFC'));
  return CODE_IDENTIFIER_WHOLE_TOKEN_PATTERN.test(normalized) && isDistinctivelyCasedCodeIdentifier(normalized)
    ? normalized
    : undefined;
}

/** Match only exact, case-sensitive cased identifiers present in the original query. */
export function hasExactCasedCodeIdentifierMatch(query: string, identifiers: readonly string[]): boolean {
  const declared = new Set(
    EffectArray.filter(
      EffectArray.map(identifiers, exactCasedCodeIdentifier),
      (identifier): identifier is string => identifier !== undefined,
    ),
  );
  return declared.size > 0 && EffectArray.some(casedCodeIdentifiers(query), identifier => declared.has(identifier));
}

function isDistinctivelyCasedCodeIdentifier(identifier: string): boolean {
  return CASE_TRANSITION_PATTERN.test(identifier) || ACRONYM_WORD_TRANSITION_PATTERN.test(identifier);
}
