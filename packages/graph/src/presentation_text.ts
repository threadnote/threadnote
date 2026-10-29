import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/** Replace terminal controls and bidi overrides while preserving code-point length. */
export function sanitizeCodeGraphPresentationText(value: string, maximumCharacters = Number.MAX_SAFE_INTEGER): string {
  const limit = Number.isFinite(maximumCharacters)
    ? Math.max(0, Math.floor(maximumCharacters))
    : Number.MAX_SAFE_INTEGER;
  let output = '';
  let length = 0;
  for (const character of value) {
    if (length >= limit) break;
    const codePoint =
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      ) ?? 0;
    output +=
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
        ? ' '
        : character;
    length += 1;
  }
  return output;
}
