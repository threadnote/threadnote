import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, type ResolvedCodeGraphIndexScope} from '../index_scope.js';
import type {CodeGraphScopeAdmissionEvidence} from '../admission_freshness.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import {compareCodeUnits} from '../ordering.js';
import {mergeCodeGraphWorkspaces} from '../workspace.js';
import {Effect} from 'effect';
import {codeGraphContentIdentity} from '../graph_identity.js';
import {codeGraphInventoryReuseContract} from '../inventory/reuse.js';
import {observeCodeGraphAdmissionEnvironment} from '../admission_freshness.js';
import type {CodeGraphInventory} from '../inventory/models.js';
import type {CodeGraphInventoryFile, CodeGraphSnapshot, RepositoryIdentity} from '../types.js';
import type {CodeGraphReusableBaseReceipt} from '../store/models.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Catalog/commit changes trigger reassessment, but do not themselves invalidate a scoped view. */
export interface CodeGraphScopeApplicabilityEvidence {
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly scopeKey: string;
  readonly definitionDigest: string;
  readonly closureDigest: string;
  readonly inventoryFingerprint: string;
  readonly overlayFingerprint?: string;
  readonly extractorSet: string;
  readonly policyFingerprint: string;
  readonly observedCommit: string;
  readonly catalogFingerprint: string;
}

export function assessCodeGraphScopeApplicability(
  active: CodeGraphScopeApplicabilityEvidence | undefined,
  observed: CodeGraphScopeApplicabilityEvidence,
): {readonly buildRequired: boolean; readonly reason: string; readonly observedCommit: string} {
  const fields = [
    'repositoryId',
    'worktreeId',
    'scopeKey',
    'definitionDigest',
    'closureDigest',
    'inventoryFingerprint',
    'overlayFingerprint',
    'extractorSet',
    'policyFingerprint',
  ] as const;
  const mismatch =
    active === undefined
      ? 'missing-applicability'
      : observed.scopeKey === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY && active.observedCommit !== observed.observedCommit
        ? 'observedCommit'
        : EffectOption.getOrUndefined(EffectArray.findFirst(fields, field => active[field] !== observed[field]));
  return {
    buildRequired: mismatch !== undefined,
    reason: mismatch ?? 'equivalent-scope',
    observedCommit: observed.observedCommit,
  };
}

export function codeGraphScopeAdmissionEvidence(
  evidence: CodeGraphScopeApplicabilityEvidence,
): CodeGraphScopeAdmissionEvidence {
  return {
    scopeKey: evidence.scopeKey,
    definitionDigest: evidence.definitionDigest,
    closureDigest: evidence.closureDigest,
    inventoryFingerprint: evidence.inventoryFingerprint,
    observedCommit: evidence.observedCommit,
    ...(evidence.overlayFingerprint === undefined ? {} : {scopedOverlayFingerprint: evidence.overlayFingerprint}),
  };
}

export function codeGraphScopeAdmitsPath(
  scope: Pick<ResolvedCodeGraphIndexScope, 'admittedPrefixes' | 'controlPaths'> | undefined,
  path: string,
): boolean {
  return (
    scope === undefined ||
    scope.controlPaths.includes(path) ||
    EffectArray.some(
      scope.admittedPrefixes,
      prefix => prefix === '' || path === prefix || Effect2.pipe(path, EffectString.startsWith(`${prefix}/`)),
    )
  );
}

/** Content identity binds the immutable base to the exact definition and closure. */
export const codeGraphScopedBaseReusable = Effect.fn('codeGraph.scopedBaseReusable')(function* (
  input: {
    readonly inventory: Pick<CodeGraphInventory, 'scope' | 'workspace' | 'scopeIncludeOpaqueCorpusAssets'>;
    readonly identity: RepositoryIdentity;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  },
  base: {
    readonly snapshot: CodeGraphSnapshot;
    readonly files: readonly CodeGraphInventoryFile[];
    readonly receipt: CodeGraphReusableBaseReceipt;
  },
) {
  const scope = input.inventory.scope;
  if (scope === undefined)
    return (base.snapshot.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY;
  const admission = base.receipt.inventory;
  if (
    base.snapshot.scopeId !== scope.scopeKey ||
    base.snapshot.repositoryId !== input.identity.repositoryId ||
    base.snapshot.graphContentId !== codeGraphContentIdentity(base.snapshot.extractorSet, base.files, scope) ||
    EffectArray.some(base.files, file => !codeGraphScopeAdmitsPath(scope, file.path)) ||
    admission === undefined ||
    admission.includeOpaqueCorpusAssets !== (input.inventory.scopeIncludeOpaqueCorpusAssets !== false) ||
    admission.contract !== codeGraphInventoryReuseContract(input.languagePacks, admission.includeOpaqueCorpusAssets) ||
    admission.workspace.fingerprint !== input.inventory.workspace?.fingerprint
  )
    return false;
  return admission.environmentFingerprint === (yield* observeCodeGraphAdmissionEnvironment(input.identity));
});

/** Persist and attribute only the selected component catalog, while discovery remains repository-wide. */
export function scopedCodeGraphWorkspace(
  workspace: CodeGraphWorkspace,
  scope: ResolvedCodeGraphIndexScope,
): CodeGraphWorkspace {
  const selected = new Set(scope.includedProjectIds);
  const projects = EffectArrayPipe(workspace.projects, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (project, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && selected.has(project.id),
    ),
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  const workspaceIds = new Set(EffectArray.map(projects, project => project.workspaceId));
  const workspaces = EffectArrayPipe(workspace.workspaces, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (candidate, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && workspaceIds.has(candidate.id),
    ),
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  return mergeCodeGraphWorkspaces([
    {
      diagnostics: scope.diagnostics,
      fingerprint: workspace.fingerprint,
      projects,
      workspaces,
    },
  ]);
}
