import * as EffectString from 'effect/String';
import * as Effect from 'effect';
/** Makes untrusted checkpoint labels visible without emitting terminal controls. */
export function checkpointTerminalText(value: string): string {
  let output = '';
  for (const character of value) {
    const codePoint = Effect.pipe(
      character,
      EffectString.codePointAt(0),
      Effect.Option.getOrElse(() => undefined),
    )!;
    output +=
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? `\\u{${Effect.pipe(codePoint.toString(16), EffectString.padStart(4, '0'))}}`
        : character;
  }
  return output;
}
