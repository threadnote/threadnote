import * as EffectString from 'effect/String';
import * as Effect from 'effect';
export function xcodeNativeTargetNames(content: string): readonly string[] {
  const targets: string[] = [];
  let nativeTarget = false;
  for (const rawLine of Effect.pipe(content, EffectString.split(/\r?\n/u))) {
    const line = Effect.pipe(rawLine, EffectString.trim);
    const equals = Effect.pipe(
      line,
      EffectString.indexOf('='),
      Effect.Option.getOrElse(() => -1),
    );
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const semicolon = line.indexOf(';', equals + 1);
    if (equals < 0 || semicolon < 0) continue;
    const key = Effect.pipe(line, EffectString.slice(0, equals), EffectString.trim);
    const value = Effect.pipe(line, EffectString.slice(equals + 1, semicolon), EffectString.trim);
    if (key === 'isa') {
      nativeTarget = value === 'PBXNativeTarget';
      continue;
    }
    if (!nativeTarget || key !== 'name') continue;
    const unquoted =
      Effect.pipe(value, EffectString.startsWith('"')) && Effect.pipe(value, EffectString.endsWith('"'))
        ? Effect.pipe(value, EffectString.slice(1, -1))
        : value;
    if (unquoted) targets.push(unquoted);
    nativeTarget = false;
  }
  return targets;
}
