import {Array as EffectArray} from 'effect';
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
import {type RecallOperationalWarning} from '@threadnote/recall/warning';
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

const MCP_PROGRESS_TEST_WORKSPACE_DELAY_ENV = 'THREADNOTE_TEST_MCP_PROGRESS_WORKSPACE_DELAY_MILLISECONDS';
const MCP_PROGRESS_TEST_WORKSPACE_DELAY_MAX_MILLISECONDS = 1_000;
function mcpProgressTestWorkspaceDelayMilliseconds(environment: NodeJS.ProcessEnv): number {
  if (environment.NODE_ENV !== 'test') return 0;
  const configured = Number(environment[MCP_PROGRESS_TEST_WORKSPACE_DELAY_ENV]);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MCP_PROGRESS_TEST_WORKSPACE_DELAY_MAX_MILLISECONDS)
    : 0;
}

export function resolveRecallWorkspaceContext(config: RuntimeConfig, params: RecallWorkspaceContextParams) {
  return Effect.gen(function* () {
    const delay = mcpProgressTestWorkspaceDelayMilliseconds((yield* SystemInfo).environment());
    if (delay > 0) yield* Effect.sleep(delay);
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
      EffectArray.filter(
        [params.pinnedUri, ...(params.allowedUriScopes ?? [])],
        (uri): uri is string => uri !== undefined,
      ),
    );
    for (const scope of projectMemoryScopeUris(config, recallProjectName, params.includeArchived)) {
      if (!scopedRecallUris.has(scope)) {
        scopedRecallUris.add(scope);
      }
    }
    const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native optional-chain guard narrows `seededUri` for insertion.
    if (seededUri?.startsWith('threadnote://') && seededUri !== params.pinnedUri) {
      scopedRecallUris.add(seededUri);
    }

    const sections: string[] = [];
    const workset = scope.workset;
    if (workset && workset.projects.length > 0) {
      sections.push(
        `Workset scope: ${workset.name} (${EffectArray.join(
          EffectArray.map(workset.projects, member => member.name),
          ', ',
        )})`,
      );
      for (const uri of worksetScopeUris(config, workset).slice(0, MAX_WORKSET_PASSES)) scopedRecallUris.add(uri);
    }
    const eligibility = scope.eligibility;

    const exactRead = navigationOnly
      ? undefined
      : {
          terms: exactRecallTerms(query),
          uriScopes: params.pinnedUri
            ? [params.pinnedUri]
            : (params.allowedUriScopes ??
              exactMemoryScopes(config, params.includeArchived, query, undefined, undefined)),
          limitPerTerm: 25,
        };
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
      exactRead,
      exactMatches: [] as readonly ExactMatch[],
      navigationOnly,
      operationalWarnings: [] as readonly RecallOperationalWarning[],
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
