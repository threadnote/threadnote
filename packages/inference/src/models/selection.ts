import {Crypto, Effect, FileSystem, Path, Result, Schema} from 'effect';
import type {LocalModelCatalogShape, LocalModelRole} from './catalog.js';

class ModelSelectionError extends Schema.TaggedError<ModelSelectionError>()('ModelSelectionError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export const MODEL_SELECTION_VERSION = 1 as const;

export interface ModelSelection {
  readonly roles: Readonly<Partial<Record<LocalModelRole, string>>>;
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

export const writeModelSelection = Effect.fn('models.writeSelection')(function* (
  home: string,
  selection: ModelSelection,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, 'models');
  const target = path.join(directory, 'selection.json');
  const temporary = path.join(directory, `.selection.${yield* crypto.randomUUIDv4()}.tmp`);
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
    roles: {...current.roles, [role]: modelId},
    version: MODEL_SELECTION_VERSION,
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
  const selection: ModelSelection = {roles, version: MODEL_SELECTION_VERSION};
  yield* writeModelSelection(home, selection);
  return selection;
});

function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => key !== 'version' && key !== 'roles')) return false;
  const candidate = value as Partial<ModelSelection>;
  if (
    candidate.version !== MODEL_SELECTION_VERSION ||
    typeof candidate.roles !== 'object' ||
    !candidate.roles ||
    Array.isArray(candidate.roles)
  ) {
    return false;
  }
  return Object.entries(candidate.roles).every(
    ([role, id]) =>
      ['embedding', 'generation', 'reranker'].includes(role) &&
      typeof id === 'string' &&
      /^[a-z0-9][a-z0-9._-]*$/.test(id),
  );
}
