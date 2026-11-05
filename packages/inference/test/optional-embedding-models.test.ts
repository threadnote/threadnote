import {Array as EffectArray, Option} from 'effect';
import {expect, it} from 'vitest';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '../src/models/builtin.js';
import {parseLocalModelManifest} from '../src/models/catalog.js';

const getModel = (id: string) =>
  parseLocalModelManifest(
    Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.id === id)),
  );

it('exposes the two optional embedding models without changing the core selection', () => {
  expect(CORE_EMBEDDING_MODEL_ID).toBe('bge-small-en-v1.5-q8');

  const gemma = getModel('embeddinggemma-2-q8');
  expect(gemma).toMatchObject({
    architecture: 'gemma-embedding2',
    contextLimit: 8192,
    dimensions: 768,
    file: 'embeddinggemma-2-Q8_0.gguf',
    license: 'Apache-2.0',
    minimumRamBytes: 2 * 1024 * 1024 * 1024,
    quantization: 'Q8_0',
    promptPrefixes: {
      document: 'title: none | text: ',
      query: 'task: search result | query: ',
    },
    revision: '6ea3e3a309d12a4779cfda98b8c19800d2d5da71',
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.22.2'},
    sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
    size: 309_855_456,
  });

  const qwen = getModel('qwen3-embedding-0.6b-q8');
  expect(qwen).toMatchObject({
    architecture: 'qwen3',
    contextLimit: 32768,
    dimensions: 1024,
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    license: 'Apache-2.0',
    minimumRamBytes: 8 * 1024 * 1024 * 1024,
    quantization: 'Q8_0',
    promptPrefixes: {
      document: '',
      query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    },
    revision: '370f27d7550e0def9b39c1f16d3fbaa13aa67728',
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.22.2'},
    sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
    size: 639_150_592,
  });
});
