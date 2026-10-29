import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {createHash} from '@threadnote/testing/node-crypto';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Option} from 'effect';
import {codeGraphBlobExtractionReuseClass, codeGraphBlobReuseCacheKey} from '@threadnote/graph/blob_reuse';
import {
  extractStructuredSchemaFacts,
  relocateStructuredSchemaFacts,
} from '@threadnote/graph/languages/schemas/extractor';
import {captureRationaleInputs} from '@threadnote/graph/rationale';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const extractionContext = {packageName: Option.none(), project: Option.none()};

describe('code graph Git blob extraction reuse', () => {
  it('admits only committed, fully loaded, bounded structured object blobs', () => {
    const eligible = inventoryFile('config/base.json', '{"nested":{"enabled":true}}');

    expect(codeGraphBlobExtractionReuseClass(eligible)).toBe('structured-object-v1:json:full');
    expect(codeGraphBlobReuseCacheKey(eligible, 'schemas-v1')).toContain(eligible.blobId);
    expect(codeGraphBlobExtractionReuseClass({...eligible, source: 'worktree'})).toBeUndefined();
    expect(codeGraphBlobExtractionReuseClass({...eligible, blobId: 'not-a-git-object'})).toBeUndefined();
    expect(codeGraphBlobExtractionReuseClass({...eligible, contentOmittedReason: 'metadata-only'})).toBeUndefined();
    expect(codeGraphBlobExtractionReuseClass({...eligible, contentOmittedReason: 'size-budget'})).toBeUndefined();
    expect(codeGraphBlobExtractionReuseClass({...eligible, size: 4 * 1_048_576 + 1})).toBeUndefined();
    expect(codeGraphBlobExtractionReuseClass({...eligible, path: 'fixtures/base.json'})).toBeUndefined();
    expect(
      codeGraphBlobExtractionReuseClass({...eligible, language: 'image', path: 'fixtures/base.svg'}),
    ).toBeUndefined();
  });

  it('relocates duplicate JSON, JSONC, and YAML facts without merging source locations', () => {
    for (const sample of [
      {content: '{"flat.key":{"leaf":true},"flat":{"key":{"leaf":false}}}', extension: 'json'},
      {content: '{// WHY: preserve this fixture\n"nested":{"enabled":true,},}', extension: 'jsonc'},
      {content: 'root:\n  with/slash:\n    enabled: true\n', extension: 'yaml'},
    ]) {
      const donor = inventoryFile(`config/donor.${sample.extension}`, sample.content);
      const target = inventoryFile(`config/copies/target.${sample.extension}`, sample.content);
      const donorFacts = captureRationaleInputs(donor, extractStructuredSchemaFacts(donor, extractionContext));
      const freshTargetFacts = captureRationaleInputs(target, extractStructuredSchemaFacts(target, extractionContext));

      expect(relocateStructuredSchemaFacts(target, donorFacts)).toEqual(freshTargetFacts);
      expect(new Set(EffectArray.map(donorFacts.symbols, symbol => symbol.id))).not.toEqual(
        new Set(EffectArray.map(freshTargetFacts.symbols, symbol => symbol.id)),
      );
      expect(EffectArray.every(donorFacts.symbols, symbol => symbol.path === donor.path)).toBe(true);
      expect(EffectArray.every(freshTargetFacts.symbols, symbol => symbol.path === target.path)).toBe(true);
    }
  });

  it('relocates malformed structured diagnostics exactly', () => {
    const donor = inventoryFile('config/broken.json', '{"broken":');
    const target = inventoryFile('config/copies/broken.json', donor.content!);
    const donorFacts = extractStructuredSchemaFacts(donor, extractionContext);
    const freshTargetFacts = extractStructuredSchemaFacts(target, extractionContext);

    expect(relocateStructuredSchemaFacts(target, donorFacts)).toEqual(freshTargetFacts);
  });

  fcProp(
    it,
    'is equivalent to a fresh target-path extraction for bounded JSON values',
    {value: FC.jsonValue()},
    ({value}) => {
      const content = JSON.stringify(value);
      const donor = inventoryFile('generated/donor.json', content);
      const target = inventoryFile('generated/target.json', content);
      const donorFacts = captureRationaleInputs(donor, extractStructuredSchemaFacts(donor, extractionContext));
      const freshTargetFacts = captureRationaleInputs(target, extractStructuredSchemaFacts(target, extractionContext));

      expect(relocateStructuredSchemaFacts(target, donorFacts)).toEqual(freshTargetFacts);
    },
    {fastCheck: {numRuns: 100}},
  );
});

function inventoryFile(path: string, content: string): CodeGraphInventoryFile {
  const language = Effect.pipe(path, EffectString.endsWith('.jsonc'))
    ? 'jsonc'
    : Effect.pipe(path, EffectString.endsWith('.yaml'))
      ? 'yaml'
      : 'json';
  return {
    blobId: createHash('sha1').update(content).digest('hex'),
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}
