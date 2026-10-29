import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {augmentRationaleFacts, captureRationaleInputs} from '@threadnote/graph/rationale';
import {parseCodeGraphRationaleCacheSnapshot} from '../helpers/rationale-cache.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const rationaleText = FC.array(
  FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,'),
  {maxLength: 96, minLength: 1},
)
  .map(characters => Effect.pipe(EffectArray.join(characters, ''), EffectString.trim))
  .filter(value => value.length > 0);

describe('code graph rationale cache properties', () => {
  fcProp(
    it,
    'keeps source-backed and JSON-cache-backed derivation equivalent after source release',
    {
      documentation: rationaleText,
      marker: FC.constantFrom('NOTE', 'WHY', 'HACK', 'RATIONALE', 'DECISION', 'SAFETY', 'INVARIANT'),
    },
    ({documentation, marker}) => {
      const content = `export function retry() {\n  // ${marker}: ${documentation}\n}\n`;
      const file: CodeGraphInventoryFile = {
        blobId: 'blob',
        content,
        contentHash: 'hash',
        language: 'typescript',
        mode: '100644',
        path: 'src/retry.ts',
        size: content.length,
        source: 'commit',
      };
      const facts: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [],
        path: file.path,
        symbols: [ownerSymbol(marker)],
      };
      const captured = captureRationaleInputs(file, facts);
      const cached = parseCodeGraphRationaleCacheSnapshot(JSON.stringify(captured));

      const sourceBacked = augmentRationaleFacts(file, captured);
      const cacheBacked = augmentRationaleFacts({...file, content: undefined}, cached);

      expect(cacheBacked.symbols).toEqual(sourceBacked.symbols);
      expect(cacheBacked.edges).toEqual(sourceBacked.edges);
      expect(EffectArray.filter(cacheBacked.symbols, symbol => symbol.kind === 'rationale')).toHaveLength(1);
    },
  );
});

function ownerSymbol(name: string): CodeGraphSymbol {
  return {
    contentHash: 'hash',
    exported: true,
    id: `symbol:${name}`,
    kind: 'function',
    language: 'typescript',
    name: 'retry',
    path: 'src/retry.ts',
    qualifiedName: 'retry',
    span: {column: 1, endColumn: 2, endLine: 3, line: 1},
  };
}
