import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Result, Schema} from 'effect';
import type {LocalModelCatalogShape, LocalModelRole} from './catalog.js';
import * as EffectRecord from 'effect/Record';

class ModelSelectionError extends Schema.TaggedError<ModelSelectionError, {readonly brand: unique symbol}>()(
  'ModelSelectionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const MODEL_SELECTION_VERSION = 1 as const;

export type EmbeddingPurpose = 'graph' | 'recall';
const MODEL_SELECTION_ROLES: ReadonlyArray<LocalModelRole> = ['embedding', 'generation', 'reranker'];
const EMBEDDING_PURPOSES: ReadonlyArray<EmbeddingPurpose> = ['graph', 'recall'];

export interface ModelSelection {
  /** Shared role selection retained for v1 compatibility and as a purpose fallback. */
  readonly roles: Readonly<Partial<Record<LocalModelRole, string>>>;
  /** Optional purpose-specific embedding choices. */
  readonly purposes?: Readonly<Partial<Record<EmbeddingPurpose, string>>>;
  readonly version: typeof MODEL_SELECTION_VERSION;
}

const EMPTY_SELECTION: ModelSelection = {roles: {}, version: MODEL_SELECTION_VERSION};

export type ModelSelectionInspection =
  | {readonly status: 'missing'}
  | {readonly status: 'malformed'}
  | {readonly status: 'valid'; readonly selection: ModelSelection};

/** Strict inspection for choice-sensitive callers; the legacy reader still tolerates invalid files. */
export function parseModelSelection(raw: string): ModelSelectionInspection {
  const parsed = Result.try(() => JSON.parse(raw) as unknown);
  return Result.isFailure(parsed) || !isModelSelection(parsed.success)
    ? {status: 'malformed'}
    : {selection: parsed.success, status: 'valid'};
}

export const inspectModelSelection = Effect.fn('models.inspectSelection')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(home, 'models', 'selection.json');
  if (!(yield* fs.exists(file))) return {status: 'missing'} as const;
  return parseModelSelection(yield* fs.readFileString(file));
});

export const readModelSelection = Effect.fn('models.readSelection')(function* (home: string) {
  const inspected = yield* inspectModelSelection(home);
  return inspected.status === 'valid' ? inspected.selection : EMPTY_SELECTION;
});

/** Resolve an embedding choice while preserving the legacy shared role as fallback. */
export function selectedEmbeddingModelId(selection: ModelSelection, purpose: EmbeddingPurpose): string | undefined {
  return selection.purposes?.[purpose] ?? selection.roles.embedding;
}

/** Return every role and embedding purpose that still points at a model. */
export function modelSelectionReferences(selection: ModelSelection, modelId: string): readonly string[] {
  return [
    ...EffectArray.map(
      EffectArray.filter(MODEL_SELECTION_ROLES, role => selection.roles[role] === modelId),
      role => role,
    ),
    ...EffectArray.map(
      EffectArray.filter(EMBEDDING_PURPOSES, purpose => selection.purposes?.[purpose] === modelId),
      purpose => purpose,
    ),
  ];
}

export const writeModelSelection = Effect.fn('models.writeSelection')(function* (
  home: string,
  selection: ModelSelection,
) {
  const crypto = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, 'models');
  const target = path.join(directory, 'selection.json');
  const temporary = path.join(directory, `.selection.${yield* crypto.uuidV4()}.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(temporary, `${JSON.stringify(selection, undefined, 2)}\n`, {mode: 0o600});
  yield* fs.rename(temporary, target);
});

export const selectLocalModel = Effect.fn('models.select')(function* (
  home: string,
  catalog: LocalModelCatalogShape,
  role: LocalModelRole,
  modelId: string,
) {
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== role) {
    return yield* ModelSelectionError.make({message: `Model ${modelId} has role ${manifest.role}, not ${role}.`});
  }
  const current = yield* readModelSelection(home);
  const selection: ModelSelection = {
    ...current,
    roles: {...current.roles, [role]: modelId},
    version: MODEL_SELECTION_VERSION,
  };
  yield* writeModelSelection(home, selection);
  return selection;
});

export const selectLocalModelForPurpose = Effect.fn('models.selectPurpose')(function* (
  home: string,
  catalog: LocalModelCatalogShape,
  purpose: EmbeddingPurpose,
  modelId: string,
) {
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding') {
    return yield* ModelSelectionError.make({message: `Model ${modelId} has role ${manifest.role}, not embedding.`});
  }
  const current = yield* readModelSelection(home);
  const selection: ModelSelection = {
    ...current,
    purposes: {...current.purposes, [purpose]: modelId},
  };
  yield* writeModelSelection(home, selection);
  return selection;
});

export const clearLocalModelPurposeSelection = Effect.fn('models.clearPurposeSelection')(function* (
  home: string,
  purpose: EmbeddingPurpose,
) {
  const current = yield* readModelSelection(home);
  if (current.purposes?.[purpose] === undefined) return current;
  const purposes = {...current.purposes};
  delete purposes[purpose];
  const hasPurposes = EffectArray.some(EMBEDDING_PURPOSES, key => purposes[key] !== undefined);
  const selection: ModelSelection = {
    roles: current.roles,
    version: MODEL_SELECTION_VERSION,
    ...(hasPurposes ? {purposes} : {}),
  };
  yield* writeModelSelection(home, selection);
  return selection;
});

export const clearLocalModelSelection = Effect.fn('models.clearSelection')(function* (
  home: string,
  role: LocalModelRole,
) {
  const current = yield* readModelSelection(home);
  if (current.roles[role] === undefined) return current;
  const roles = {...current.roles};
  delete roles[role];
  const selection: ModelSelection = {...current, roles, version: MODEL_SELECTION_VERSION};
  yield* writeModelSelection(home, selection);
  return selection;
});

function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  if (EffectArray.some(EffectRecord.keys(value), key => key !== 'version' && key !== 'roles' && key !== 'purposes'))
    return false;
  const candidate = value as Partial<ModelSelection>;
  if (
    candidate.version !== MODEL_SELECTION_VERSION ||
    typeof candidate.roles !== 'object' ||
    !candidate.roles ||
    EffectArray.isArray(candidate.roles)
  ) {
    return false;
  }
  return (
    EffectArray.every(EffectRecord.keys(candidate.roles as Readonly<Record<string, unknown>>), role =>
      EffectArray.some(MODEL_SELECTION_ROLES, allowedRole => role === allowedRole),
    ) &&
    EffectArray.every(MODEL_SELECTION_ROLES, role => {
      const id = candidate.roles?.[role];
      return id === undefined || (typeof id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(id));
    }) &&
    (candidate.purposes === undefined ||
      (typeof candidate.purposes === 'object' &&
        candidate.purposes !== null &&
        !EffectArray.isArray(candidate.purposes) &&
        EffectArray.every(EffectRecord.keys(candidate.purposes as Readonly<Record<string, unknown>>), purpose =>
          EffectArray.some(EMBEDDING_PURPOSES, allowedPurpose => purpose === allowedPurpose),
        ) &&
        EffectArray.every(EMBEDDING_PURPOSES, purpose => {
          const id = candidate.purposes?.[purpose];
          return id === undefined || (typeof id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(id));
        })))
  );
}
