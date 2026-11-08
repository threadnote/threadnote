import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import {Digest, SecureRandom} from 'effect/crypto';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256FileHex} from '@threadnote/platform/digest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {createHash} from '@threadnote/testing/node-crypto';

const layer = Layer.merge(cryptoLayer, BunFileSystem.layer);
const encoder = new TextEncoder();

describe('Effect crypto compatibility', () => {
  effectIt.layer(layer)(layerIt => {
    fcEffectProp(
      layerIt,
      'preserves SHA-256 for byte views and UTF-8 text',
      {bytes: fc.uint8Array({maxLength: 1024}), text: fc.string({maxLength: 128})},
      ({bytes, text}) =>
        Effect.gen(function* () {
          const digest = yield* Digest.Digest;
          const expectedText = createHash('sha256').update(text).digest('hex');
          expect(sha256HexSync(text)).toBe(expectedText);
          expect(withoutNativeBunSha256(() => sha256HexSync(text))).toBe(expectedText);

          const padded = new Uint8Array(bytes.length + 7).fill(255);
          padded.set(bytes, 3);
          const view = padded.subarray(3, 3 + bytes.length);
          const before = padded.slice();
          for (const input of [view, encoder.encode(text), encoder.encode('ø漢字🙂\u0000')]) {
            const expected = createHash('sha256').update(input).digest('hex');
            expect(yield* digest.digestHex(Digest.sha256, input)).toBe(expected);
            expect(sha256HexSync(input)).toBe(expected);
            expect(withoutNativeBunSha256(() => sha256HexSync(input))).toBe(expected);
          }
          expect(view).toEqual(bytes);
          expect(padded).toEqual(before);
        }),
      {fastCheck: {numRuns: 100}},
    );

    fcEffectProp(
      layerIt,
      'matches UTF-8 replacement behavior for malformed UTF-16 strings',
      {
        prefix: fc.string({maxLength: 24}),
        suffix: fc.string({maxLength: 24}),
        surrogate: fc.constantFrom('\ud800', '\udfff'),
      },
      ({prefix, suffix, surrogate}) => {
        const text = `${prefix}${surrogate}${suffix}`;
        return Effect.sync(() => {
          const expected = createHash('sha256').update(text).digest('hex');
          expect(sha256HexSync(text)).toBe(expected);
          expect(withoutNativeBunSha256(() => sha256HexSync(text))).toBe(expected);
        });
      },
      {fastCheck: {numRuns: 100}},
    );

    fcEffectProp(
      layerIt,
      'preserves streamed file hashes',
      {bytes: fc.uint8Array({maxLength: 32 * 1024})},
      ({bytes}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = yield* fs.makeTempFileScoped();
          yield* fs.writeFile(file, bytes);
          expect(yield* sha256FileHex(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
        }),
      {fastCheck: {numRuns: 25}},
    );

    fcEffectProp(
      layerIt,
      'keeps UUID v4 encoding and does not mutate its entropy',
      {bytes: fc.uint8Array({minLength: 16, maxLength: 16})},
      ({bytes}) =>
        Effect.gen(function* () {
          const before = bytes.slice();
          const random = SecureRandom.make(() => bytes.slice());
          const uuid = yield* random.uuidV4();
          expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
          expect(bytes).toEqual(before);
          expect(yield* random.uuidV4()).toBe(uuid);
        }),
      {fastCheck: {numRuns: 100}},
    );
  });
});

function withoutNativeBunSha256<T>(action: () => T): T {
  const hashDescriptor = Object.getOwnPropertyDescriptor(Bun.SHA256, 'hash');
  if (hashDescriptor === undefined) throw new Error('Bun.SHA256.hash descriptor is unavailable');
  try {
    Object.defineProperty(Bun.SHA256, 'hash', {...hashDescriptor, value: undefined});
    return action();
  } finally {
    Object.defineProperty(Bun.SHA256, 'hash', hashDescriptor);
  }
}
