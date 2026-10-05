import {Effect} from 'effect';
import {inspectCodeGraphImpactIsolated} from '@threadnote/graph/isolated/impact_query';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CommandExecutor} from '@threadnote/platform/command';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import {guidanceSourceUrisForChangedPaths} from '../guidance/index.js';
import {readActiveProjectMemoryRecords} from '../memory/maintenance/records.js';
import {buildContextHealthReport} from '@threadnote/context/health';
import {collectContextHealth} from '../memory/context/health_commands.js';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {citedDocumentCitationUris, selectContextCheckGraphImpact} from './graph_impact.js';
import {
  buildContextCheckReport,
  projectContextCheckReportSarif,
  type ContextCheckReportV2,
} from '@threadnote/context/check';

export interface ContextCheckOptions {
  readonly base?: string;
  readonly format?: 'json' | 'sarif' | 'text';
  readonly json?: boolean;
  readonly project: string;
  readonly sarif?: boolean;
}

/** Path-scoped CI checks do not imply coverage of uncited memories or transitive dependencies. */
export const runContextCheck = Effect.fn('contextCheck.command')(function* (
  config: RuntimeConfig,
  options: ContextCheckOptions,
) {
  const system = yield* SystemInfo;
  const project = options.project.trim();
  const formats = new Set([
    ...(options.format === undefined ? [] : [options.format]),
    ...(options.json === true ? (['json'] as const) : []),
    ...(options.sarif === true ? (['sarif'] as const) : []),
  ]);
  const format = formats.size === 0 ? 'text' : [...formats][0];
  const invalid = project.length === 0 || formats.size > 1;
  const report = invalid
    ? unavailableReport(project, 'invalid')
    : yield* checkRepository(config, project, options.base ?? 'HEAD', system.currentDirectory());
  const output =
    format === 'sarif'
      ? JSON.stringify(projectContextCheckReportSarif(report))
      : format === 'json'
        ? JSON.stringify(report)
        : renderContextCheck(report);
  yield* writeFinalCliOutput(output);
  yield* Effect.sync(() => system.setExitCode(report.exitCode));
});

const checkRepository = Effect.fn('contextCheck.repository')(function* (
  config: RuntimeConfig,
  project: string,
  base: string,
  cwd: string,
) {
  const selection = yield* changedRepositoryPaths(cwd, base).pipe(Effect.option);
  if (selection._tag === 'None') return unavailableReport(project, 'changed-path-evidence-unavailable');
  const {baseCommit, paths, repositoryId, repoRoot, caseMode} = selection.value;
  return yield* Effect.gen(function* () {
    const records = yield* readActiveProjectMemoryRecords(config, project);
    // Invalid citation headers cannot prove absence from this change's scope.
    if (paths.length > 0 && records.some(record => (record.metadata.citationErrors?.length ?? 0) > 0)) {
      return unavailableReport(project, 'affected-memory-evidence-unavailable');
    }
    const guidanceUris: readonly string[] = yield* guidanceSourceUrisForChangedPaths(config, project, repoRoot, paths);
    const direct = selectAffectedMemories(records, repositoryId, paths, caseMode);
    const directlyAffected = [
      ...new Map(
        [...direct, ...records.filter(record => guidanceUris.includes(record.uri))].map(record => [record.uri, record]),
      ).values(),
    ];
    const directlyAffectedMemoryUris = [
      ...new Set([...directlyAffected.map(record => record.uri), ...guidanceUris]),
    ].sort();
    const graph = yield* CodeGraphQueryService;
    const graphStatus =
      paths.length === 0
        ? undefined
        : yield* graph
            .status(config.agentContextHome, repoRoot, {observeWorktree: true, requestMaintenance: false})
            .pipe(
              Effect.option,
              Effect.map(option => (option._tag === 'Some' ? option.value : undefined)),
            );
    const impactResult =
      paths.length === 0
        ? undefined
        : graphStatus?.freshness !== 'current' || graphStatus.stale || graphStatus.readySnapshot === undefined
          ? undefined
          : yield* inspectCodeGraphImpactIsolated({
              baseCommit,
              cwd: repoRoot,
              depth: 8,
              edgeLimit: 500,
              nodeLimit: 200,
              query: 'changed paths',
              seedQueries: paths,
              threadnoteHome: config.agentContextHome,
            }).pipe(
              Effect.option,
              Effect.map(option => (option._tag === 'Some' ? option.value : undefined)),
            );
    const graphSelection =
      paths.length === 0 ? selection : yield* changedRepositoryPaths(cwd, base).pipe(Effect.option);
    if (graphSelection._tag === 'None' || !sameChangedPathSelection(selection.value, graphSelection.value)) {
      return unavailableReport(project, 'changed-path-evidence-unavailable');
    }
    const finalGraphStatus =
      impactResult === undefined
        ? undefined
        : yield* graph
            .status(config.agentContextHome, repoRoot, {observeWorktree: true, requestMaintenance: false})
            .pipe(
              Effect.option,
              Effect.map(option => (option._tag === 'Some' ? option.value : undefined)),
            );
    const impact =
      paths.length === 0
        ? ({captureAdvisoryIds: [], impactedMemoryUris: [], status: 'complete'} as const)
        : impactResult === undefined
          ? ({reason: 'graph-impact-evidence-unavailable', status: 'unknown'} as const)
          : !contextCheckReadFenceIntact(
                selection.value,
                graphSelection.value,
                impactResult.snapshot.id,
                finalGraphStatus,
              )
            ? ({reason: 'graph-impact-evidence-incomplete', status: 'unknown'} as const)
            : selectContextCheckGraphImpact(impactResult, records, repositoryId, paths, directlyAffectedMemoryUris);
    const graphImpactedMemoryUris = impact.status === 'complete' ? impact.impactedMemoryUris : [];
    const affectedMemoryUris = [...new Set([...directlyAffectedMemoryUris, ...graphImpactedMemoryUris])].sort();
    const healthReport = yield* collectContextHealth(config, project, records, repoRoot, {
      includeCitationCoverageFindings: true,
      includeFindingCategories: ['candidate-contradiction', 'relation-target-conflicted'],
      includeFindingUris: affectedMemoryUris,
    });
    const finalSelection = yield* changedRepositoryPaths(cwd, base).pipe(Effect.option);
    if (finalSelection._tag === 'None' || !sameChangedPathSelection(selection.value, finalSelection.value)) {
      return unavailableReport(project, 'changed-path-evidence-unavailable');
    }
    return buildContextCheckReport({
      healthReport,
      selection: {
        affectedMemoryUris,
        captureAdvisoryIds: impact.status === 'complete' ? impact.captureAdvisoryIds : [],
        changedPaths: paths,
        citedDocumentCitationUris: citedDocumentCitationUris(records, repositoryId, affectedMemoryUris),
        ...(impact.status === 'unknown' ? {evidenceReason: impact.reason} : {}),
        graphImpactedMemoryUris,
        status: 'available',
      },
    });
  }).pipe(Effect.orElseSucceed(() => unavailableReport(project, 'affected-memory-evidence-unavailable')));
});

/** Repository identity is essential: an equal path in another repository is unrelated. */
export function selectAffectedMemories(
  records: readonly MemoryRecord[],
  repositoryId: string,
  changedPaths: readonly string[],
  caseMode: 'insensitive' | 'sensitive' = 'sensitive',
): readonly MemoryRecord[] {
  const pathKey = (value: string) => (caseMode === 'insensitive' ? value.toLowerCase() : value);
  const paths = new Set(changedPaths.map(pathKey));
  return records.filter(record =>
    record.metadata.codeCitations?.some(
      citation => citation.repositoryId === repositoryId && paths.has(pathKey(citation.path)),
    ),
  );
}

const changedRepositoryPaths = Effect.fn('contextCheck.changedPaths')(function* (cwd: string, base: string) {
  const repository = yield* resolveRepositoryIdentity(cwd);
  const command = yield* CommandExecutor;
  const bounded = {cwd: repository.repoRoot, maxOutputBytes: 1_048_576, timeoutMs: 30_000};
  const verified = yield* command.execute(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    bounded,
  );
  const commit = verified.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return yield* Effect.fail('invalid-base');
  const [tracked, untracked] = yield* Effect.all(
    [
      // Disabling rename detection includes both deleted and added paths, preserving old citations.
      command.execute('git', ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', commit, '--'], bounded),
      command.execute('git', ['ls-files', '--others', '--exclude-standard', '-z'], bounded),
    ],
    {concurrency: 2},
  );
  const paths = [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))].sort();
  return {
    baseCommit: commit,
    paths,
    repositoryId: repository.repositoryId,
    repoRoot: repository.repoRoot,
    caseMode: repository.caseMode,
  };
});

export function sameChangedPathSelection(
  left: {
    readonly baseCommit: string;
    readonly caseMode: 'insensitive' | 'sensitive';
    readonly paths: readonly string[];
    readonly repositoryId: string;
    readonly repoRoot: string;
  },
  right: {
    readonly baseCommit: string;
    readonly caseMode: 'insensitive' | 'sensitive';
    readonly paths: readonly string[];
    readonly repositoryId: string;
    readonly repoRoot: string;
  },
): boolean {
  return (
    left.baseCommit === right.baseCommit &&
    left.caseMode === right.caseMode &&
    left.repositoryId === right.repositoryId &&
    left.repoRoot === right.repoRoot &&
    left.paths.length === right.paths.length &&
    left.paths.every((path, index) => path === right.paths[index])
  );
}

export function contextCheckReadFenceIntact(
  initial: Parameters<typeof sameChangedPathSelection>[0],
  finalSelection: Parameters<typeof sameChangedPathSelection>[1] | undefined,
  impactSnapshotId: string,
  finalGraphStatus:
    | {
        readonly freshness: 'current' | 'deferred' | 'stale';
        readonly readySnapshot?: {readonly id: string};
        readonly stale: boolean;
      }
    | undefined,
): boolean {
  return (
    finalSelection !== undefined &&
    sameChangedPathSelection(initial, finalSelection) &&
    finalGraphStatus?.freshness === 'current' &&
    !finalGraphStatus.stale &&
    finalGraphStatus.readySnapshot?.id === impactSnapshotId
  );
}

function renderContextCheck(report: ContextCheckReportV2): string {
  const lines = [
    `Context check: ${report.exitClassification}; ${report.findings.length} finding(s), ${report.omittedFindings} omitted.`,
    ...report.findings.map(
      finding =>
        `- ${finding.severity} ${finding.category}: ${finding.affectedMemoryCount} affected memory record(s) ` +
        `[${finding.fingerprint}]`,
    ),
  ];
  if (report.evidenceReason !== undefined) lines.push(`Evidence: ${report.evidenceReason}.`);
  lines.push(`Exit ${report.exitCode}.`);
  return lines.join('\n');
}

function unavailableReport(
  project: string,
  reason: 'invalid' | 'affected-memory-evidence-unavailable' | 'changed-path-evidence-unavailable',
): ContextCheckReportV2 {
  const healthReport = buildContextHealthReport({now: new Date(0), project, records: []});
  const report = buildContextCheckReport({
    healthReport,
    selection: {reason: reason === 'invalid' ? 'changed-path-evidence-unavailable' : reason, status: 'unavailable'},
  });
  if (reason !== 'invalid') return report;
  return {...report, evidenceReason: undefined, evidenceStatus: 'invalid'};
}
