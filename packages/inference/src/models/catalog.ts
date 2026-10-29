import {Array as EffectArray} from 'effect';
import {Context, Effect, Layer, Schema} from 'effect';
import {ModelManifestInvalid} from '../engine/errors.js';

import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const LOCAL_MODEL_MANIFEST_VERSION = 1 as const;
export const LOCAL_MODEL_ROLES = ['embedding', 'generation', 'reranker'] as const;
export type LocalModelRole = (typeof LOCAL_MODEL_ROLES)[number];

const LocalModelManifestSchema = Schema.Struct({
  architecture: Schema.String,
  contextLimit: Schema.Int,
  dimensions: Schema.optionalKey(Schema.Int),
  file: Schema.String,
  id: Schema.String,
  license: Schema.String,
  minimumRamBytes: Schema.Int,
  normalization: Schema.optionalKey(Schema.Literals(['l2', 'none'])),
  promptPrefixes: Schema.optionalKey(
    Schema.Struct({
      document: Schema.optionalKey(Schema.String),
      query: Schema.optionalKey(Schema.String),
    }),
  ),
  quantization: Schema.String,
  repository: Schema.String,
  revision: Schema.String,
  role: Schema.Literals(LOCAL_MODEL_ROLES),
  runtime: Schema.Struct({
    darwinArm64EmbeddingGpuLayers: Schema.optionalKey(Schema.Int),
    nodeLlamaCpp: Schema.String,
  }),
  sha256: Schema.String,
  size: Schema.Int,
  task: Schema.optionalKey(Schema.String),
  version: Schema.Literal(LOCAL_MODEL_MANIFEST_VERSION),
});

export type LocalModelManifest = typeof LocalModelManifestSchema.Type;

export interface LocalModelCatalogShape {
  readonly get: (modelId: string) => Effect.Effect<LocalModelManifest, ModelManifestInvalid>;
  readonly list: (role?: LocalModelRole) => Effect.Effect<readonly LocalModelManifest[]>;
  readonly selected: (role: LocalModelRole) => Effect.Effect<LocalModelManifest, ModelManifestInvalid>;
}

export class LocalModelCatalog extends Context.Service<LocalModelCatalog, LocalModelCatalogShape>()(
  '@threadnote/inference/models/catalog/LocalModelCatalog',
) {
  static layer(manifests: readonly unknown[], selected: Readonly<Partial<Record<LocalModelRole, string>>> = {}) {
    return Layer.effect(LocalModelCatalog, makeLocalModelCatalog(manifests, selected));
  }
}

export function parseLocalModelManifest(value: unknown): LocalModelManifest {
  const manifest = Schema.decodeUnknownSync(LocalModelManifestSchema)(value);
  const problem = validateManifest(manifest);
  if (problem) {
    throw ModelManifestInvalid.make({
      message: problem,
      modelId: manifest.id,
    });
  }
  return manifest;
}

function makeLocalModelCatalog(
  values: readonly unknown[],
  selected: Readonly<Partial<Record<LocalModelRole, string>>>,
) {
  return Effect.try({
    try: () => {
      const manifests = EffectArray.map(values, parseLocalModelManifest);
      const byId = new Map<string, LocalModelManifest>();
      for (const manifest of manifests) {
        if (byId.has(manifest.id)) {
          throw ModelManifestInvalid.make({
            message: `Duplicate local model ID: ${manifest.id}.`,
            modelId: manifest.id,
          });
        }
        byId.set(manifest.id, manifest);
      }
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
      for (const [role, id] of Object.entries(selected)) {
        const manifest = id ? byId.get(id) : undefined;
        if (!manifest || manifest.role !== role) {
          throw ModelManifestInvalid.make({
            message: `Selected ${role} model ${id ?? '(missing)'} does not exist with that role.`,
            modelId: id ?? '',
          });
        }
      }
      return LocalModelCatalog.of({
        get: modelId => {
          const manifest = byId.get(modelId);
          return manifest
            ? Effect.succeed(manifest)
            : Effect.fail(
                ModelManifestInvalid.make({
                  message: `Unknown local model: ${modelId}.`,
                  modelId,
                }),
              );
        },
        list: role =>
          Effect.succeed(
            EffectArray.filter(manifests, manifest => role === undefined || manifest.role === role).sort(
              (left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id)),
            ),
          ),
        selected: role => {
          const id = selected[role];
          const manifest = id ? byId.get(id) : undefined;
          return manifest
            ? Effect.succeed(manifest)
            : Effect.fail(
                ModelManifestInvalid.make({
                  message: `No default ${role} model has been selected by the measured model bake-off.`,
                  modelId: id ?? '',
                }),
              );
        },
      });
    },
    catch: cause =>
      Schema.is(ModelManifestInvalid)(cause)
        ? cause
        : ModelManifestInvalid.make({
            message: cause instanceof Error ? cause.message : String(cause),
            modelId: '',
          }),
  });
}

function validateManifest(manifest: LocalModelManifest): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(manifest.id)) {
    return `Invalid local model ID: ${manifest.id}.`;
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    return `Model ${manifest.id} must have a lowercase 64-character SHA-256.`;
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.revision)) {
    return `Model ${manifest.id} must pin a 40-character immutable revision.`;
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(manifest.repository)) {
    return `Model ${manifest.id} must declare a safe owner/repository identifier.`;
  }
  const fileSegments = Effect2.pipe(manifest.file, EffectString.split('/'));
  if (
    fileSegments.length === 0 ||
    EffectArray.some(
      fileSegments,
      segment => !segment || segment === '.' || segment === '..' || /[\\?#]/.test(segment),
    ) ||
    !Effect2.pipe(manifest.file, EffectString.toLowerCase, EffectString.endsWith('.gguf'))
  ) {
    return `Model ${manifest.id} must declare a safe relative GGUF filename.`;
  }
  if (manifest.size <= 0 || manifest.minimumRamBytes <= 0 || manifest.contextLimit <= 0) {
    return `Model ${manifest.id} has invalid size, RAM, or context limits.`;
  }
  if (
    manifest.runtime.darwinArm64EmbeddingGpuLayers !== undefined &&
    manifest.runtime.darwinArm64EmbeddingGpuLayers < 0
  ) {
    return `Model ${manifest.id} has an invalid macOS arm64 embedding GPU-layer policy.`;
  }
  if (manifest.role === 'embedding') {
    if (!manifest.dimensions || manifest.dimensions <= 0) {
      return `Embedding model ${manifest.id} must declare positive dimensions.`;
    }
    if (manifest.normalization !== 'l2') {
      return `Embedding model ${manifest.id} must declare l2 normalization for the 4.0 vector index.`;
    }
    if (manifest.promptPrefixes?.query === undefined || manifest.promptPrefixes.document === undefined) {
      return `Embedding model ${manifest.id} must declare query and document prefixes, including explicit empty prefixes.`;
    }
  } else if (
    manifest.dimensions !== undefined ||
    manifest.normalization !== undefined ||
    manifest.runtime.darwinArm64EmbeddingGpuLayers !== undefined
  ) {
    return `Non-embedding model ${manifest.id} cannot declare embedding-only metadata or runtime policy.`;
  }
  return undefined;
}
