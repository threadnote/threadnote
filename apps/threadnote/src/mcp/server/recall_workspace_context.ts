import {Effect, Result} from 'effect';
import {resolveRecallScope} from '../../memory/recall_scope.js';
import {errorMessage} from '@threadnote/platform/errors';
import {
  recallQueryRequestsBranchContext,
  resolveWorkspaceBranch,
  resolveWorkspaceComponentContext,
  trimTrailingSlash,
} from '../../utils.js';
import {recallScoreThresholdPolicy} from '@threadnote/recall/threshold';
import {exactRecallTerms, type ExactMatch, type RecallHit} from '@threadnote/recall/results';
import {resolveEffectAiConfiguration} from '../../effect/ai/consolidator.js';
import {jevConfiguration} from '../../effect/ai/jev.js';
import {SystemInfo} from '@threadnote/platform/system';
import {loadRecallExactMatches} from '@threadnote/recall/index';
import {type RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {lexicalIndexUnavailableWarning, type RecallOperationalWarning} from '@threadnote/recall/warning';
import {
  exactMemoryScopes,
  MAX_WORKSET_PASSES,
  projectMemoryScopeUris,
  type RuntimeConfig,
  worksetScopeUris,
} from './common.js';

export interface RecallWorkspaceContextParams {
  readonly allowedUriScopes: readonly string[] | undefined;
  readonly callerCwd: string | undefined;
  readonly inferScope?: boolean;
  readonly includeArchived: boolean;
  readonly pinnedUri: string | undefined;
  readonly project: string | undefined;
  readonly query: string;
  readonly threshold: string | undefined;
  readonly workset: string | undefined;
}

export function resolveRecallWorkspaceContext(config: RuntimeConfig, params: RecallWorkspaceContextParams) {
  return Effect.gen(function* () {
    const query = params.query;
    const navigationOnly = query.length === 0;
    const workspaceComponent =
      !navigationOnly && params.inferScope !== false && !params.pinnedUri && !params.workset
        ? yield* resolveWorkspaceComponentContext({cwd: params.callerCwd, includeProcessCwd: false})
        : undefined;
    const workspaceBranch =
      !navigationOnly &&
      params.inferScope !== false &&
      !params.pinnedUri &&
      !params.workset &&
      recallQueryRequestsBranchContext(query)
        ? yield* resolveWorkspaceBranch({cwd: params.callerCwd, includeProcessCwd: false})
        : undefined;
    const scope = yield* resolveRecallScope(config, params);
    const project = scope.preferredManifestProject;
    const recallProjectName = scope.preferredProject;
    const thresholdPolicy =
      params.threshold === undefined
        ? yield* recallScoreThresholdPolicy()
        : {source: 'call' as const, value: params.threshold};
    const threshold = thresholdPolicy.value;
    const thresholdConfigured = thresholdPolicy.source !== 'default';
    const passes: Array<readonly RecallHit[]> = [];
    const scopedRecallUris = new Set(
      [params.pinnedUri, ...(params.allowedUriScopes ?? [])].filter((uri): uri is string => uri !== undefined),
    );
    for (const scope of projectMemoryScopeUris(config, recallProjectName, params.includeArchived)) {
      if (!scopedRecallUris.has(scope)) {
        scopedRecallUris.add(scope);
      }
    }
    const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
    if (seededUri?.startsWith('threadnote://') && seededUri !== params.pinnedUri) {
      scopedRecallUris.add(seededUri);
    }

    const sections: string[] = [];
    const workset = scope.workset;
    if (workset && workset.projects.length > 0) {
      sections.push(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
      for (const uri of worksetScopeUris(config, workset).slice(0, MAX_WORKSET_PASSES)) scopedRecallUris.add(uri);
    }
    const eligibility = scope.eligibility;

    const exactLookup = yield* collectExactMemoryMatches(
      config,
      query,
      params.includeArchived,
      eligibility,
      params.pinnedUri ? [params.pinnedUri] : params.allowedUriScopes,
    );
    const effectAiResult = navigationOnly
      ? undefined
      : yield* resolveEffectAiConfiguration(config, (yield* SystemInfo).environment()).pipe(Effect.result);
    const effectAi =
      effectAiResult !== undefined && Result.isSuccess(effectAiResult) ? effectAiResult.success : undefined;
    const jev = navigationOnly ? undefined : jevConfiguration((yield* SystemInfo).environment());
    if (effectAiResult !== undefined && Result.isFailure(effectAiResult)) {
      sections.push(
        `Local AI recall unavailable: ${errorMessage(effectAiResult.failure)}. Deterministic recall continued.`,
      );
    }
    return {
      effectAi,
      jev,
      eligibility,
      exactMatches: exactLookup.matches,
      navigationOnly,
      operationalWarnings: exactLookup.operationalWarnings,
      passes,
      query,
      recallProjectName,
      scopeProvenance: scope.provenance,
      scopedRecallUris,
      sections,
      seededUri,
      threshold,
      thresholdConfigured,
      workspaceBranch,
      workspaceComponent,
    };
  });
}

const collectExactMemoryMatches = Effect.fn('mcp_server.collectExactMemoryMatches')(function* (
  config: RuntimeConfig,
  query: string,
  includeArchived: boolean,
  eligibility: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return {
      matches: [] as readonly ExactMatch[],
      operationalWarnings: [] as readonly RecallOperationalWarning[],
    };
  }
  const scopes = allowedUriScopes ?? exactMemoryScopes(config, includeArchived, query, undefined, undefined);
  const result = yield* loadRecallExactMatches(config, {
    eligibility,
    includeInactive: includeArchived,
    limitPerTerm: 25,
    terms,
    uriScopes: scopes,
  }).pipe(Effect.result);
  return Result.isSuccess(result)
    ? {matches: result.success, operationalWarnings: []}
    : {matches: [], operationalWarnings: [lexicalIndexUnavailableWarning()]};
});
