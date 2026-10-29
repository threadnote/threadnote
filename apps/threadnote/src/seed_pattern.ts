import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const UTF8 = new TextEncoder();
const WINDOWS_DRIVE = /^[a-z]:/iu;

export const PROJECT_SEED_PATTERN_BYTES_MAXIMUM = 1_024;
export const PROJECT_SEED_PATTERN_COUNT_MAXIMUM = 256;
export const PROJECT_SEED_PATTERNS_BYTES_MAXIMUM = 64 * 1_024;

export class InvalidProjectSeedPattern extends Schema.TaggedError<
  InvalidProjectSeedPattern,
  {readonly brand: unique symbol}
>()('InvalidProjectSeedPattern', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Validate a repository-relative seed path/glob without rewriting its bytes. */
export function validateProjectSeedPattern(pattern: string): string {
  if (
    pattern.length === 0 ||
    UTF8.encode(pattern).byteLength > PROJECT_SEED_PATTERN_BYTES_MAXIMUM ||
    hasControlCharacter(pattern)
  ) {
    throw InvalidProjectSeedPattern.make({
      message: 'Seed patterns must be non-empty bounded text without control characters.',
    });
  }
  const normalized = Effect.pipe(pattern, EffectString.replaceAll('\\', '/'));
  if (
    Effect.pipe(normalized, EffectString.startsWith('/')) ||
    Effect.pipe(normalized, EffectString.startsWith('~/')) ||
    WINDOWS_DRIVE.test(pattern) ||
    Effect.pipe(normalized, EffectString.split('/')).includes('..')
  ) {
    throw InvalidProjectSeedPattern.make({message: 'Seed patterns must stay within the configured project root.'});
  }
  return pattern;
}

export function validateProjectSeedPatterns(patterns: readonly string[]): readonly string[] {
  if (patterns.length > PROJECT_SEED_PATTERN_COUNT_MAXIMUM) {
    throw InvalidProjectSeedPattern.make({
      message: `A project may configure at most ${PROJECT_SEED_PATTERN_COUNT_MAXIMUM} seed patterns.`,
    });
  }
  let bytes = 0;
  return EffectArray.map(patterns, pattern => {
    const validated = validateProjectSeedPattern(pattern);
    bytes += UTF8.encode(validated).byteLength;
    if (bytes > PROJECT_SEED_PATTERNS_BYTES_MAXIMUM) {
      throw InvalidProjectSeedPattern.make({message: 'The aggregate seed-pattern payload exceeds the safe limit.'});
    }
    return validated;
  });
}

function hasControlCharacter(value: string): boolean {
  return EffectArray.some([...value], character => {
    const code =
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      ) ?? 0;
    return code <= 31 || code === 127;
  });
}
