import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const RECALL_TOKEN_PATTERN =
  /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}]|[._/'\u02bc\u2010-\u2015\u2019\u2212-](?=[\p{L}\p{N}]))*/gu;
const RECALL_CONNECTOR_PATTERN = /[._/'\u02bc\u2010-\u2015\u2019\u2212-]+/u;

/**
 * Extract human-language and identifier-shaped tokens without discarding
 * non-ASCII scripts. Tokens retain their original casing for callers such as
 * exact substring search, while NFC keeps canonically equivalent input stable.
 */
export function recallTokens(value: string): readonly string[] {
  return EffectArray.filter(
    EffectArray.map(
      [...Effect.pipe(normalizeRecallSearchText(value), EffectString.matchAll(RECALL_TOKEN_PATTERN))],
      match => match[0],
    ),
    token => {
      const characters = [...token];
      return (
        characters.length >= 3 ||
        (characters.length === 2 &&
          /\p{L}/u.test(token) &&
          EffectArray.some(
            characters,
            character =>
              (Effect.pipe(
                character,
                EffectString.codePointAt(0),
                Effect.Option.getOrElse(() => undefined),
              ) ?? 0) > 0x7f,
          ))
      );
    },
  );
}

/** Normalize canonically equivalent text and common human connector variants. */
export function normalizeRecallSearchText(value: string): string {
  return canonicalizeConnectors(Effect.pipe(value, EffectString.normalize('NFC')));
}

/**
 * Produce normalized lexical terms plus the components of compound identifiers.
 * Apostrophe and dash variants share one canonical form, so Ukrainian words and
 * hyphenated identifiers match even when clients use different typography.
 */
export function recallLexicalTerms(value: string): readonly string[] {
  return EffectArray.flatMap(recallTokens(value), token => {
    const canonical = canonicalizeConnectors(token);
    const normalized = Effect.pipe(canonical, EffectString.toLowerCase);
    const components = EffectArray.filter(
      EffectArray.map(
        Effect.pipe(
          canonical,
          EffectString.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2'),
          EffectString.split(RECALL_CONNECTOR_PATTERN),
        ),
        term => Effect.pipe(term, EffectString.toLowerCase),
      ),
      term => [...term].length >= 2 && term !== normalized,
    );
    return [normalized, ...components];
  });
}

function canonicalizeConnectors(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/[\u02bc\u2019]/gu, "'"),
    EffectString.replace(/[\u2010-\u2015\u2212]/gu, '-'),
  );
}
