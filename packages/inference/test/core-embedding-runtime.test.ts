import {Array as EffectArray, Option, Schema} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {expect, it} from 'vitest';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '../src/models/builtin.js';

const Dependencies = Schema.Struct({dependencies: Schema.Record(Schema.String, Schema.String)});
const pin = (file: string) =>
  Schema.decodeUnknownSync(Dependencies)(JSON.parse(readFileSync(file, 'utf8'))).dependencies['node-llama-cpp'];

it('keeps core embedding runtime metadata aligned with both exact dependency declarations', () => {
  const root = pin('package.json');
  const inference = pin('packages/inference/package.json');
  const core = Option.getOrThrow(
    EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
  );
  expect(root).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(inference).toBe(root);
  expect(core.runtime.nodeLlamaCpp).toBe(root);
});
