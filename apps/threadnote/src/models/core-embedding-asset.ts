import {Array as EffectArray, Option as EffectOption} from 'effect';
import coreEmbeddingModelPath from '../../embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf' with {type: 'file'};
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';

export const BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH =
  'apps/threadnote/embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf';

export const BUNDLED_CORE_EMBEDDING_MANIFEST = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, manifest => manifest.id === CORE_EMBEDDING_MODEL_ID),
)!;

export interface BundledModelSource {
  readonly sourcePath: string;
  readonly sourceUrl: string;
}

export function bundledCoreEmbeddingSource(manifest: LocalModelManifest): BundledModelSource | undefined {
  if (
    manifest.id !== BUNDLED_CORE_EMBEDDING_MANIFEST.id ||
    manifest.role !== 'embedding' ||
    manifest.sha256 !== BUNDLED_CORE_EMBEDDING_MANIFEST.sha256 ||
    manifest.size !== BUNDLED_CORE_EMBEDDING_MANIFEST.size
  ) {
    return undefined;
  }
  return {
    sourcePath: coreEmbeddingModelPath,
    sourceUrl: `embedded://threadnote/${manifest.id}/${manifest.sha256}.gguf`,
  };
}
