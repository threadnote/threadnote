import {Array as EffectArray} from 'effect';
import {extractNativeFileFacts} from '@threadnote/graph/extractor';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {createNativeTypeScriptSession} from '@threadnote/graph/typescript_runtime';
import {dirname, join} from 'node:path';

const content = 'export function bundledExample() { return 1; }';
// Composition root: source mode names the prepared asset; a compiled executable uses its packaged runtime.
const native = await createNativeTypeScriptSession({
  cwd: process.cwd(),
  deadline: Date.now() + 30000,
  assetDirectory: process.argv[2] ?? join(dirname(process.execPath), 'runtime', 'typescript'),
});
try {
  const facts = await extractNativeFileFacts(
    {
      blobId: Effect.pipe('b', EffectString.repeat(40)),
      content,
      contentHash: Effect.pipe('a', EffectString.repeat(64)),
      language: 'typescript',
      mode: '100644',
      path: 'src/example.ts',
      size: Buffer.byteLength(content),
      source: 'commit',
    },
    native,
  );
  process.stdout.write(JSON.stringify(EffectArray.map(facts.symbols, symbol => symbol.name)) + '\n');
} finally {
  await native.close();
}
