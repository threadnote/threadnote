import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {resolveRepositoryIdentity} from '../repository.js';
import {inventoryRepository} from '../inventory.js';
import {
  resolveCodeGraphIndexScope,
  resolveCodeGraphWorkspaceCatalog,
  type ResolvedCodeGraphIndexScope,
} from '../index_scope.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../languages/registry.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_PROJECT_SCOPE_PREVIEW_VERSION = 1 as const;

export interface CodeGraphProjectScopePreview {
  readonly inventory: {
    readonly excluded: {readonly bytes: number; readonly files: number};
    readonly included: {readonly bytes: number; readonly files: number};
  };
  readonly project: {
    readonly graph: ProjectManifest['graph'];
    readonly name: string;
  };
  readonly repository: {readonly commit: string; readonly dirty: boolean; readonly displayName: string};
  readonly scope: {
    readonly completeness: ResolvedCodeGraphIndexScope['completeness'];
    readonly controlPaths: readonly string[];
    readonly dependencyComponents: readonly string[];
    readonly diagnostics: readonly string[];
    readonly includes: readonly string[];
    readonly rootComponents: readonly string[];
    readonly roots: readonly string[];
  };
  /** Scope configuration is preview-only until scoped inventory/storage lands. */
  readonly snapshotReuse: 'not-evaluated';
  readonly type: 'code-graph-project-scope-preview';
  readonly version: typeof CODE_GRAPH_PROJECT_SCOPE_PREVIEW_VERSION;
}

export class CodeGraphProjectScopePreviewError extends Schema.TaggedError<
  CodeGraphProjectScopePreviewError,
  {readonly brand: unique symbol}
>()('CodeGraphProjectScopePreviewError', {message: Schema.String}) {}

/**
 * Resolves one manifest project's graph definition against the current local
 * workspace. This is deliberately read-only: it does not publish a scoped
 * snapshot or imply that indexing/query routing is scoped yet.
 */
export const previewCodeGraphProjectScope = Effect.fn('codeGraph.previewProjectScope')(function* (
  project: ProjectManifest,
  cwd: string,
) {
  const identity = yield* resolveRepositoryIdentity(cwd).pipe(
    Effect.mapError(() =>
      CodeGraphProjectScopePreviewError.make({
        message: 'The configured project is not an available local Git repository.',
      }),
    ),
  );
  const inventory = yield* inventoryRepository(identity).pipe(
    Effect.mapError(() =>
      CodeGraphProjectScopePreviewError.make({message: 'The project inventory could not be read for scope preview.'}),
    ),
  );
  const catalog = yield* resolveCodeGraphWorkspaceCatalog(inventory.files, BUILTIN_LANGUAGE_PACK_REGISTRY).pipe(
    Effect.mapError(() =>
      CodeGraphProjectScopePreviewError.make({
        message: 'The project workspace could not be resolved for scope preview.',
      }),
    ),
  );
  const resolved = yield* Effect.try({
    try: () => resolveCodeGraphIndexScope(project, catalog),
    catch: cause =>
      CodeGraphProjectScopePreviewError.make({
        message: cause instanceof Error ? cause.message : 'The project graph scope could not be resolved.',
      }),
  });
  const rootComponents = new Set(resolved.rootProjectIds);
  const inventoryFiles = inventory.files;
  const included = EffectArray.filter(
    inventoryFiles,
    (file, __effectArrayIndex) => __effectArrayIndex in inventoryFiles && scopeAdmitsPath(resolved, file.path),
  );
  const includedBytes = EffectArray.reduce(included, 0, (total, file) => total + file.size);
  return {
    inventory: {
      excluded: {
        bytes: EffectArray.reduce(inventory.files, 0, (total, file) => total + file.size) - includedBytes,
        files: inventory.files.length - included.length,
      },
      included: {bytes: includedBytes, files: included.length},
    },
    project: {graph: project.graph, name: project.name},
    repository: {commit: identity.headCommit, dirty: inventory.dirty, displayName: identity.displayName},
    scope: {
      completeness: resolved.completeness,
      controlPaths: resolved.controlPaths,
      dependencyComponents: EffectArray.filter(resolved.includedProjectIds, id => !rootComponents.has(id)),
      diagnostics: resolved.diagnostics,
      includes: project.graph?.include ?? [],
      rootComponents: resolved.rootProjectIds,
      roots: project.graph?.roots ?? [],
    },
    snapshotReuse: 'not-evaluated' as const,
    type: 'code-graph-project-scope-preview' as const,
    version: CODE_GRAPH_PROJECT_SCOPE_PREVIEW_VERSION,
  } satisfies CodeGraphProjectScopePreview;
});

function scopeAdmitsPath(scope: ResolvedCodeGraphIndexScope, path: string): boolean {
  return (
    scope.controlPaths.includes(path) ||
    EffectArray.some(
      scope.admittedPrefixes,
      prefix => prefix === '' || path === prefix || Effect2.pipe(path, EffectString.startsWith(`${prefix}/`)),
    )
  );
}
