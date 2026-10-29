import {Array as EffectArray} from 'effect';
import {extractFileFacts} from '@threadnote/graph/extractor';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const content = 'export function bundledExample() { return 1; }';
const facts = extractFileFacts({
  blobId: Effect.pipe('b', EffectString.repeat(40)),
  content,
  contentHash: Effect.pipe('a', EffectString.repeat(64)),
  language: 'typescript',
  mode: '100644',
  path: 'src/example.ts',
  size: Buffer.byteLength(content),
  source: 'commit',
});
process.stdout.write(JSON.stringify(EffectArray.map(facts.symbols, symbol => symbol.name)) + '\n');
