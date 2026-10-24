import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync as portableSha256HexSync} from '@threadnote/platform/sha256';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';

describe('native SHA-256 adapter', () => {
  it('matches independent known vectors for strings and raw bytes', () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexSync(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const unicode = 'Snow ☃ — 雪 🌊';
    const unicodeBytes = new TextEncoder().encode(unicode);
    expect(sha256HexSync(unicode)).toBe('38d57f0252f9b87c02d1d428f28a5435c09c6d2e14e583d964fb32ceac19ec5b');
    expect(sha256HexSync(unicodeBytes)).toBe('38d57f0252f9b87c02d1d428f28a5435c09c6d2e14e583d964fb32ceac19ec5b');
  });

  it('remains bit-identical to the portable implementation across bounded text and byte inputs', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({maxLength: 2_048}), fc.uint8Array({maxLength: 4_096})), input => {
        expect(sha256HexSync(input)).toBe(portableSha256HexSync(input));
      }),
      {numRuns: 80},
    );
  });
});
