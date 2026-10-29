import {Array as EffectArray} from 'effect';
import {Effect, Option, Schema} from 'effect';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphInventoryFile} from '../types.js';

export class CodeGraphIndexOperationError extends Schema.TaggedError<
  CodeGraphIndexOperationError,
  {readonly brand: unique symbol}
>()('CodeGraphIndexOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}
export function sameOverlayState(
  left: {readonly dirty: boolean; readonly fingerprint?: string},
  right: {readonly dirty: boolean; readonly fingerprint?: string},
): boolean {
  return left.dirty === right.dirty && (!left.dirty || left.fingerprint === right.fingerprint);
}

export function sameInventoryPaths(
  left: readonly CodeGraphInventoryFile[],
  right: readonly CodeGraphInventoryFile[],
): boolean {
  return left.length === right.length && EffectArray.every(left, (file, index) => file.path === right[index]?.path);
}

/**
 * Committing an already-indexed worktree changes provenance from `worktree` to
 * `commit`, but not the effective source graph. Keep that transition exact:
 * every graph-relevant file field must still match in canonical path order.
 */
export function sameEffectiveCodeGraphInventory(
  left: readonly CodeGraphInventoryFile[],
  right: readonly CodeGraphInventoryFile[],
): boolean {
  if (
    new Set(EffectArray.map(left, file => file.path)).size !== left.length ||
    new Set(EffectArray.map(right, file => file.path)).size !== right.length
  ) {
    return false;
  }
  return (
    left.length === right.length &&
    EffectArray.every(left, (file, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        file.contentHash === other.contentHash &&
        file.language === other.language &&
        file.mode === other.mode &&
        file.path === other.path &&
        file.size === other.size
      );
    })
  );
}

export function codeGraphInventoryFileChanged(
  base: CodeGraphInventoryFile | undefined,
  current: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  changedPackIds: ReadonlySet<string>,
): boolean {
  return (
    !base ||
    base.contentHash !== current.contentHash ||
    base.language !== current.language ||
    base.mode !== current.mode ||
    base.size !== current.size ||
    base.source !== current.source ||
    Option.match(languagePacks.match(current.path), {
      onNone: () => false,
      onSome: match => changedPackIds.has(match.pack.id),
    })
  );
}

export function inventoryFilesForPaths(
  files: readonly CodeGraphInventoryFile[],
  paths: readonly string[],
): readonly CodeGraphInventoryFile[] | undefined {
  const selected: CodeGraphInventoryFile[] = [];
  let fileIndex = 0;
  for (const path of paths) {
    while (fileIndex < files.length && compareCodeUnits(files[fileIndex].path, path) < 0) fileIndex += 1;
    const file = files[fileIndex];
    if (!file || file.path !== path) return undefined;
    selected.push(file);
  }
  return selected;
}

export class WorktreeChangedDuringIndex extends Schema.TaggedError<
  WorktreeChangedDuringIndex,
  {readonly brand: unique symbol}
>()('WorktreeChangedDuringIndex', {
  message: Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.succeed('Worktree files changed during code graph indexing; retry the operation.'),
    ),
  ),
}) {}

export class CachedCodeGraphFactUnavailableDuringIndex extends Schema.TaggedError<
  CachedCodeGraphFactUnavailableDuringIndex,
  {readonly brand: unique symbol}
>()('CachedCodeGraphFactUnavailableDuringIndex', {
  message: Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.succeed('A cached code graph fact disappeared during indexing; retry with a full rebuild.'),
    ),
  ),
}) {}

export class RepositoryRegistrationLost extends Schema.TaggedError<
  RepositoryRegistrationLost,
  {readonly brand: unique symbol}
>()('RepositoryRegistrationLost', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed('Repository registration was lost during code graph indexing.')),
  ),
}) {}

export class RepositoryMaintenanceInterrupted extends Schema.TaggedError<
  RepositoryMaintenanceInterrupted,
  {readonly brand: unique symbol}
>()('RepositoryMaintenanceInterrupted', {
  message: Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.succeed('Code graph indexing was superseded by repair or purge; retry the operation.'),
    ),
  ),
}) {}
