import {Array as EffectArray} from 'effect';
import {Effect, Path} from 'effect';
import {USER_MANIFEST_NAME} from '@threadnote/workspace/constants';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {
  observeCodeGraphAdmissionEnvironment,
  codeGraphSnapshotAdmissionCurrentForIdentity,
} from '../admission_freshness.js';
import {extractorSetIdentity} from '../indexer.js';
import {inventoryRepository} from '../inventory.js';
import {codeGraphInventoryScopeEvidence} from '../inventory/scope.js';
import {codeGraphIndexScopeMembershipDigest, type ResolvedCodeGraphIndexScope} from '../index_scope.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphLayout} from '../layout.js';
import type {CodeGraphAnalysisResult} from '../analysis.js';
import {resolveCodeGraphScopeRoute} from '../scope/routing.js';
import {
  assessCodeGraphScopeApplicability,
  codeGraphScopeAdmissionEvidence,
  codeGraphScopeAdmitsPath,
  type CodeGraphScopeApplicabilityEvidence,
} from '../scope/applicability.js';
import type {CodeGraphStoreShape} from '../store.js';
import type {
  CodeGraphProjectCoverage,
  CodeGraphQueryOptions,
  CodeGraphQueryResult,
  CodeGraphSnapshot,
  RepositoryIdentity,
} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface CodeGraphQueryScope {
  readonly project: Pick<ProjectManifest, 'name' | 'graph' | 'uri'>;
  readonly scope?: ResolvedCodeGraphIndexScope;
  readonly evidence?: CodeGraphScopeApplicabilityEvidence;
}

/**
 * Compact proof that an already-selected ready snapshot belongs to the
 * parent-observed project graph. Large path and workspace lists stay in the
 * parent process; the isolated reader only needs these persisted identities.
 */
export interface CodeGraphQueryScopeReceipt {
  readonly scope: Pick<ResolvedCodeGraphIndexScope, 'closureDigest' | 'definitionDigest' | 'scopeKey'> & {
    readonly membershipDigest: string;
  };
  readonly evidence: CodeGraphScopeApplicabilityEvidence;
}

export function codeGraphQueryScopeReceipt(
  selection: CodeGraphQueryScope | undefined,
): CodeGraphQueryScopeReceipt | undefined {
  if (selection?.scope === undefined || selection.evidence === undefined) return undefined;
  return {
    scope: {
      closureDigest: selection.scope.closureDigest,
      definitionDigest: selection.scope.definitionDigest,
      membershipDigest: codeGraphIndexScopeMembershipDigest(selection.scope),
      scopeKey: selection.scope.scopeKey,
    },
    evidence: selection.evidence,
  };
}

export function discloseCodeGraphAnalysisProjectCoverage(
  result: CodeGraphAnalysisResult,
  projectCoverage: CodeGraphProjectCoverage | undefined,
): CodeGraphAnalysisResult {
  if (projectCoverage === undefined) return result;
  return {
    ...result,
    projectCoverage,
    ...(projectCoverage.completeness === 'partial'
      ? {
          coverage: {...result.coverage, complete: false},
          warnings: [
            ...result.warnings,
            'The selected project graph has partial dependency coverage and cannot provide authoritative negative proof.',
          ],
        }
      : {}),
  };
}

export const observeCodeGraphQueryScope = Effect.fn('codeGraph.observeQueryScope')(function* (
  threadnoteHome: string,
  cwd: string,
  identity: RepositoryIdentity,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  options: {readonly project?: string; readonly manifestPath?: string},
) {
  const path = yield* Path.Path;
  const route = yield* resolveCodeGraphScopeRoute(
    options.manifestPath ?? path.join(threadnoteHome, USER_MANIFEST_NAME),
    cwd,
    options.project,
  );
  if (route.state === 'full') return undefined;
  if (route.project.graph === undefined) return {project: route.project} satisfies CodeGraphQueryScope;
  const inventory = yield* inventoryRepository(identity, {
    project: route.project,
    languagePacks,
    includeOpaqueCorpusAssets: false,
    scopeObservationOnly: true,
  });
  const policy = yield* observeCodeGraphAdmissionEnvironment(identity);
  return {
    project: route.project,
    scope: inventory.scope,
    evidence: codeGraphInventoryScopeEvidence(
      inventory,
      identity,
      extractorSetIdentity(inventory.files, languagePacks),
      policy,
    ),
  } satisfies CodeGraphQueryScope;
});

export const codeGraphQueryScopeCurrent = Effect.fn('codeGraph.queryScopeCurrent')(function* (
  selection: CodeGraphQueryScope | CodeGraphQueryScopeReceipt,
  store: CodeGraphStoreShape,
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  identity: RepositoryIdentity,
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  if (selection.scope === undefined || selection.evidence === undefined) return false;
  const active = yield* store.loadScopeApplicability(
    layout.databasePath,
    identity.worktreeId,
    selection.scope.scopeKey,
  );
  if (
    active === undefined ||
    active.snapshotId !== snapshot.id ||
    assessCodeGraphScopeApplicability(active, selection.evidence).buildRequired
  )
    return false;
  // The persisted admission receipt proves the older snapshot. The new observation
  // independently proves equivalent inputs at the current commit without a write.
  return yield* codeGraphSnapshotAdmissionCurrentForIdentity(
    layout,
    snapshot,
    {...identity, headCommit: active.observedCommit},
    languagePacks,
    false,
    codeGraphScopeAdmissionEvidence(active),
  );
});

export const codeGraphQueryScopeSnapshotCompatible = Effect.fn('codeGraph.queryScopeSnapshotCompatible')(function* (
  selection: CodeGraphQueryScope | CodeGraphQueryScopeReceipt | undefined,
  store: CodeGraphStoreShape,
  databasePath: string,
  worktreeId: string,
  snapshot: CodeGraphSnapshot,
  requireExactClosure = false,
) {
  if (selection?.scope === undefined) return snapshot.scopeId === undefined || snapshot.scopeId === 'full-repository';
  const active = yield* store.loadScopeApplicability(databasePath, worktreeId, selection.scope.scopeKey);
  const receipt = yield* store.loadSnapshotScopeReceipt(databasePath, snapshot.id, selection.scope.scopeKey);
  const membershipDigest =
    'membershipDigest' in selection.scope
      ? selection.scope.membershipDigest
      : codeGraphIndexScopeMembershipDigest(selection.scope);
  return (
    active !== undefined &&
    receipt !== undefined &&
    active.snapshotId === snapshot.id &&
    receipt.snapshotId === snapshot.id &&
    active.definitionDigest === receipt.definitionDigest &&
    active.closureDigest === receipt.closureDigest &&
    active.definitionDigest === selection.scope.definitionDigest &&
    codeGraphIndexScopeMembershipDigest(receipt) === membershipDigest &&
    (!requireExactClosure || active.closureDigest === selection.scope.closureDigest)
  );
});

export function codeGraphProjectCoverage(
  selection: CodeGraphQueryScope | undefined,
  identity: RepositoryIdentity,
  snapshot: Pick<CodeGraphSnapshot, 'commit'> | undefined,
  current: boolean,
): CodeGraphProjectCoverage | undefined {
  if (selection === undefined) return undefined;
  const scope = selection.scope;
  return {
    project: selection.project.name,
    kind: scope === undefined ? 'full-repository' : 'project',
    configuredRoots: selection.project.graph?.roots ?? [],
    rootComponents: scope?.rootProjectIds.length ?? 0,
    dependencyComponents: scope === undefined ? 0 : scope.includedProjectIds.length - scope.rootProjectIds.length,
    completeness: scope?.completeness ?? 'complete',
    negativeProof: scope?.completeness === 'partial' ? 'unavailable' : 'selected-graph-only',
    ...(snapshot === undefined ? {} : {snapshotSourceCommit: snapshot.commit}),
    observedWorktreeCommit: identity.headCommit,
    reusedEquivalentSnapshot:
      scope !== undefined && current && snapshot !== undefined && snapshot.commit !== identity.headCommit,
  };
}

export function outsideCodeGraphProjectPaths(
  options: CodeGraphQueryOptions,
  scope: ResolvedCodeGraphIndexScope | undefined,
): readonly string[] {
  if (scope === undefined) return [];
  const selectors = options.operation === 'path' ? [options.from, options.to] : [options.query, options.symbol];
  return [
    ...new Set(
      EffectArray.flatMap(selectors, selector => {
        if (selector === undefined || /\s/u.test(selector)) return [];
        const candidate = Effect2.pipe(
          Effect2.pipe(selector, EffectString.split('#'))[0],
          EffectString.replaceAll('\\', '/'),
          EffectString.replace(/^\.\//u, ''),
        );
        if (
          (!Effect2.pipe(candidate, EffectString.includes('/')) && !/\.[A-Za-z0-9]+$/u.test(candidate)) ||
          Effect2.pipe(candidate, EffectString.startsWith('/')) ||
          EffectArray.some(Effect2.pipe(candidate, EffectString.split('/')), part => part === '..' || part === '.')
        )
          return [];
        return codeGraphScopeAdmitsPath(scope, candidate) ? [] : [candidate];
      }),
    ),
  ];
}

export function discloseCodeGraphProjectCoverage(
  result: CodeGraphQueryResult,
  coverage: CodeGraphProjectCoverage | undefined,
  outsidePaths: readonly string[] = [],
  outsideScopeChangedPaths?: number,
): CodeGraphQueryResult {
  if (coverage === undefined) return result;
  const partial = coverage.completeness === 'partial';
  return {
    ...result,
    projectCoverage: coverage,
    ...(outsideScopeChangedPaths === undefined ? {} : {outsideScopeChangedPaths}),
    ...(outsidePaths.length === 0
      ? {}
      : {
          outsideProjectGraph: {
            state: 'outside-project-graph' as const,
            paths: outsidePaths,
            suggestedActions: [
              'Select a project whose graph includes the requested paths.',
              'Select a configured project with full-repository coverage.',
            ],
          },
        }),
    ...(partial && result.searchCoverage?.status === 'exhaustive'
      ? {searchCoverage: {...result.searchCoverage, status: 'bounded' as const}}
      : {}),
    warnings: [
      ...result.warnings,
      ...(coverage.kind === 'project'
        ? [
            `Results cover the selected project graph (${coverage.project}); absence does not establish repository-wide absence.`,
          ]
        : []),
      ...(partial
        ? [
            'The selected project graph has partial dependency coverage and cannot provide authoritative negative proof.',
          ]
        : []),
      ...(outsidePaths.length > 0 ? ['Requested paths are outside the selected project graph.'] : []),
    ],
  };
}
