import {describe, expect, it} from 'vitest';
import {javascriptStringLiteral, optionalNativePackageFallbackModule} from '../../../../scripts/effect/javascript.js';

describe('build-time JavaScript string serialization', () => {
  it('preserves the value without emitting script-breaking characters', () => {
    const value = '</script> "quoted" \\\nline\u2028separator\u2029paragraph';
    const literal = javascriptStringLiteral(value);

    expect(literal).not.toMatch(/[<>\u2028\u2029]/);
    expect(JSON.parse(literal)).toBe(value);
  });

  it('executes the optional native package fallback with a self-contained error', async () => {
    const source = optionalNativePackageFallbackModule();
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const fallback: unknown = await import(moduleUrl);
    if (!isNativePackageFallback(fallback)) throw new Error('Optional native package fallback was invalid.');

    expect(() => fallback.getBinsDir()).toThrowError(
      new Error('Optional native package is not included in this Threadnote artifact.'),
    );
  });
});

function isNativePackageFallback(value: unknown): value is {readonly getBinsDir: () => unknown} {
  return typeof value === 'object' && value !== null && 'getBinsDir' in value && typeof value.getBinsDir === 'function';
}
