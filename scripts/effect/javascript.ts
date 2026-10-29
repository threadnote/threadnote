const UNSAFE_JAVASCRIPT_STRING_CHARACTER = /[<>\u2028\u2029]/g;
const JAVASCRIPT_CHARACTER_ESCAPE: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
} as const;

export function javascriptStringLiteral(value: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
  return JSON.stringify(value).replace(
    UNSAFE_JAVASCRIPT_STRING_CHARACTER,
    character => JAVASCRIPT_CHARACTER_ESCAPE[character] ?? character,
  );
}

export function optionalNativePackageFallbackModule(): string {
  return "export const getBinsDir = () => { throw new Error('Optional native package is not included in this Threadnote artifact.'); };";
}
