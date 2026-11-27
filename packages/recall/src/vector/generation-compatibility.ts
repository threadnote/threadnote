import {Array as EffectArray} from 'effect';

/** Version of the stored chunk-to-scope mapping; a generation with another version is stale. */
export const VECTOR_SCOPE_MAPPING_VERSION = 1;

/** Stored metadata of one vector generation, as every vector read sees it. */
export interface RecallVectorGenerationMetadata {
  readonly generation: string;
  readonly job_id: string;
  readonly corpus_generation: string | null;
  readonly model_id: string;
  readonly model_sha256: string;
  readonly dimensions: number;
  readonly embedding_recipe: string;
  readonly chunker_version: number;
  readonly normalized: string;
  readonly scope_mapping_version?: number;
  readonly state: string;
}

/** The embedding space and mapping a reader expects of a stored generation. */
export interface RecallVectorModelExpectation {
  readonly modelId: string;
  readonly modelSha256: string;
  readonly dimensions: number | undefined;
  readonly embeddingRecipe: string;
  readonly chunkerVersion: number;
  readonly scopeMappingVersion: number;
}

/** Whether a stored generation has the expected embedding space. */
export function recallVectorGenerationMatchesModel(
  generation: RecallVectorGenerationMetadata,
  expected: RecallVectorModelExpectation,
): boolean {
  return (
    generation.model_id === expected.modelId &&
    generation.model_sha256 === expected.modelSha256 &&
    generation.dimensions === expected.dimensions &&
    generation.embedding_recipe === expected.embeddingRecipe &&
    generation.chunker_version === expected.chunkerVersion &&
    generation.normalized === 'l2'
  );
}

/** `?, ?, …` for an `IN` list of `count` bound values. */
export function sqlPlaceholders(count: number): string {
  return EffectArray.join(
    EffectArray.makeBy(count, () => '?'),
    ', ',
  );
}
