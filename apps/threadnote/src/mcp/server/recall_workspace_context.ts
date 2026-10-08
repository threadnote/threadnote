import {Effect, Result} from 'effect';
import {inferProjectFromQuery, inferWorksetFromQuery, requireWorkset} from '@threadnote/workspace/manifest';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {
  enrichRecallQueryWithWorkspaceProjectContext,
  recallQueryRequestsBranchContext,
  resolveWorkspaceBranch,
  resolveWorkspaceComponentContext,
  resolveWorkspaceRepoName,
  trimTrailingSlash,
} from '../../utils.js';
import {recallScoreThresholdPolicy} from '@threadnote/recall/threshold';
import {exactRecallTerms, type ExactMatch, type RecallHit} from '@threadnote/recall/results';
import {resolveEffectAiConfiguration} from '../../effect/ai/consolidator.js';
import {jevConfiguration} from '../../effect/ai/jev.js';
import {SystemInfo} from '@threadnote/platform/system';
import {loadRecallExactMatches} from '@threadnote/recall/index';
import {deriveRecallEligibilityPolicy, type RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
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
      !navigationOnly && !params.pinnedUri && !params.workset
        ? yield* resolveWorkspaceComponentContext({cwd: params.callerCwd, includeProcessCwd: false})
        : undefined;
    const workspaceBranch =
      !navigationOnly && !params.pinnedUri && !params.workset && recallQueryRequestsBranchContext(query)
        ? yield* resolveWorkspaceBranch({cwd: params.callerCwd, includeProcessCwd: false})
        : undefined;
    const projectQuery = navigationOnly
      ? ''
      : yield* enrichRecallQueryWithWorkspaceProjectContext(query, {
          cwd: params.callerCwd,
          includeProcessCwd: false,
        });
    const explicitProjectName = params.pinnedUri ? undefined : params.project;
    const queryProject = params.pinnedUri
      ? undefined
      : yield* inferProjectFromQuery(config.manifestPath, explicitProjectName ?? params.query);
    const project =
      queryProject ??
      (navigationOnly || params.pinnedUri || explicitProjectName
        ? undefined
        : yield* inferProjectFromQuery(config.manifestPath, projectQuery));
    const inferredProjectMemoryName = params.pinnedUri
      ? undefined
      : (project?.name ??
        (navigationOnly
          ? undefined
          : yield* resolveWorkspaceRepoName({cwd: params.callerCwd, includeProcessCwd: false})));
    const recallProjectName = explicitProjectName ?? inferredProjectMemoryName;
    const thresholdPolicy =
      params.threshold === undefined
        ? yield* recallScoreThresholdPolicy()
        : {source: 'call' as const, value: params.threshold};
    const threshold = thresholdPolicy.value;
    const thresholdConfigured = thresholdPolicy.source !== 'default';
    const explicitWorkset = params.workset ? yield* requireWorkset(config.manifestPath, params.workset) : undefined;
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
    const workset = params.pinnedUri
      ? undefined
      : explicitWorkset
        ? explicitWorkset
        : navigationOnly
          ? undefined
          : yield* inferWorksetFromQuery(config.manifestPath, projectQuery);
    if (workset && workset.projects.length > 0) {
      sections.push(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
      const alreadyScoped = new Set(
        [params.pinnedUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
      );
      const worksetScopes = worksetScopeUris(config, workset)
        .filter(uri => !alreadyScoped.has(uri))
        .slice(0, MAX_WORKSET_PASSES);
      for (const scope of worksetScopes) {
        scopedRecallUris.add(scope);
      }
    }

    const eligibility = deriveRecallEligibilityPolicy({
      explicitProject: params.project,
      originalQuery: query,
      pinnedHardUri: params.pinnedUri !== undefined,
      workspaceProject: workset ? undefined : recallProjectName,
      worksetProjectNames: workset?.projects.map(member => member.name),
    });

    const exactLookup = yield* collectExactMemoryMatches(
      config,
      query,
      params.includeArchived,
      eligibility,
      recallProjectName,
      project,
      params.allowedUriScopes,
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
  projectName: string | undefined,
  project: ProjectManifest | undefined,
  allowedUriScopes?: readonly string[],
) {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) {
    return {
      matches: [] as readonly ExactMatch[],
      operationalWarnings: [] as readonly RecallOperationalWarning[],
    };
  }
  const scopes = allowedUriScopes ?? exactMemoryScopes(config, includeArchived, query, projectName, project);
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
