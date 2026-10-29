import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {assertRemoteBodyReplacementSupported} from '@threadnote/remote-memory/document_compatibility';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {richRemoteMemoryMetadata} from '@threadnote/memory/test/helpers/remote-memory-document';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('remote body replacement compatibility', () => {
  it('rejects unknown header fields without consuming or rewriting them', () => {
    FC.assert(
      FC.property(
        FC.stringMatching(/^[a-z]{1,24}$/u),
        FC.string({maxLength: 40}).filter(value => !/[\r\n]/u.test(value)),
        (key, value) => {
          const document = `MEMORY\nkind: durable\nx_${key}: ${value}\n\nOriginal body`;
          expect(() => assertRemoteBodyReplacementSupported(document)).toThrow('metadata');
        },
      ),
      {numRuns: 100},
    );
  });

  it('supports basic and rich documents without changing the source metadata', () => {
    expect(() =>
      assertRemoteBodyReplacementSupported('MEMORY\nkind: durable\n\nThe documentation mentions `<!-- MEMORY_FIELDS`.'),
    ).not.toThrow();
    expect(() =>
      assertRemoteBodyReplacementSupported('MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_123\n\nBody'),
    ).not.toThrow();
    const metadata = richRemoteMemoryMetadata();
    const before = structuredClone(metadata);
    const document = formatMemoryDocument('MEMORY', metadata, 'Original body');
    for (const newline of ['\n', '\r\n', '\r']) {
      expect(() =>
        assertRemoteBodyReplacementSupported(Effect.pipe(document, EffectString.replaceAll('\n', newline))),
      ).not.toThrow();
    }
    expect(metadata).toEqual(before);
  });

  it('accepts repeated list metadata including duplicate values', () => {
    FC.assert(
      FC.property(
        FC.array(FC.stringMatching(/^[a-z][a-z0-9 -]{0,30}[a-z]$/u), {minLength: 1, maxLength: 20}),
        keywords => {
          const metadata = {...richRemoteMemoryMetadata(), keywords: [...keywords, ...keywords]};
          const document = formatMemoryDocument('MEMORY', metadata, 'Original body');
          expect(() => assertRemoteBodyReplacementSupported(document)).not.toThrow();
        },
      ),
      {numRuns: 50},
    );
  });

  it('rejects metadata that tolerant parsing would discard or change', () => {
    for (const field of [
      'code_citation: invalid',
      'relation: invalid threadnote://memory/tn_123',
      'keywords:',
      'trust: invented',
      'status: invented',
      'status: active\nstatus: active',
      'memory_id: tn_first\nmemory_id: tn_second',
      'workspace_scope:  src',
      'schema_version: 999',
      'this header is malformed',
    ]) {
      expect(() => assertRemoteBodyReplacementSupported(`MEMORY\nkind: durable\n${field}\n\nBody`)).toThrow();
    }
    expect(() => assertRemoteBodyReplacementSupported('Plain Git document')).toThrow();
    expect(() =>
      assertRemoteBodyReplacementSupported(
        'MEMORY\nkind: durable\n\nBody\n\n<!-- MEMORY_FIELDS\nreferences: legacy\n-->',
      ),
    ).toThrow();
  });

  it('rejects citations that cannot cross the sharing boundary', () => {
    const metadata = richRemoteMemoryMetadata();
    const {id: _id, ...citation} = metadata.codeCitations![0];
    for (const unsafe of [
      createMemoryCodeCitation({...citation, sourceDirty: true}),
      createMemoryCodeCitation({...citation, repositoryIdentityKind: 'local'}),
    ]) {
      const document = formatMemoryDocument('MEMORY', {...metadata, codeCitations: [unsafe]}, 'Original body');
      expect(() => assertRemoteBodyReplacementSupported(document)).toThrow('metadata');
    }
  });
});
