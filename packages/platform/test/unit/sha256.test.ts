import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {createHash} from '@threadnote/testing/node-crypto';

describe('pure SHA-256', () => {
  it('matches the standard empty-string and abc vectors', () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes UTF-8 bytes deterministically', () => {
    expect(sha256HexSync('Threadnote 🧵')).toBe('83900c7d5e984efc7ea3057975bd0a4b033150a0b0a4bddd8babf25a6afb593a');
  });

  it('encodes lone UTF-16 surrogates as UTF-8 replacement characters', () => {
    for (const value of ['\ud800', '\udfff', 'a\ud800b', '\udc00\ud800']) {
      expect(sha256HexSync(value)).toBe(createHash('sha256').update(value).digest('hex'));
    }
  });
});
