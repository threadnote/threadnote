import {DateTime, Effect, Result} from 'effect';
import {
  collectContextMaintenanceCitationEvidence,
  ContextMaintenanceEvidenceRequestError,
} from './maintenance_evidence.js';
import {maintenanceWorkerRecordValidations, type MaintenanceWorkerEvidence} from './maintenance_batch.js';
import {contextHealthCitationCoverageV2} from '@threadnote/context/health_maintenance';
import {shellQuote} from '@threadnote/platform/command';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import {validateContextHealthMemoryCitations} from '@threadnote/context/citation_validation';
import type {ContextBriefMemoryCandidateV1} from '@threadnote/context/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {classifyMemoryIdentityCandidates} from '@threadnote/recall/memory/identity';
import {recordHealthValueSnapshot} from '../../value_report/events.js';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {
  buildContextHealthReport,
  type ContextHealthCandidateEvidenceV1,
  type ContextHealthRelationEvidenceV1,
} from '@threadnote/context/health';
import {readActiveProjectMemoryRecords, readMaintenanceMemoryRecords} from '../maintenance/records.js';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {MemoryOperationError} from '../migrations.js';
import {guidanceHealthEvidence} from '../../guidance/index.js';
import {
  contextHealthSelectorCliFlags,
  contextHealthSelectorDescription,
  contextHealthSelectorFindingUris,
  normalizeContextHealthSelector,
  projectContextHealthRecords,
  type ContextHealthSelectorV1,
} from './health_selector.js';

export interface RunContextHealthOptionsV1 {
  readonly after?: string;
  readonly findingCategory?: string;
  readonly json?: boolean;
  readonly kind?: string;
  readonly project: string;
  readonly topic?: string;
}

export const runContextHealth = Effect.fn('memory.contextHealth.command')(function* (
  config: RuntimeConfig,
  options: RunContextHealthOptionsV1,
) {
  const project = options.project.trim();
  if (!project) {
    return yield* MemoryOperationError.make({message: 'Provide --project for scoped context health.'});
  }
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const selector = normalizeContextHealthSelector(options);
  const selectedRecords = projectContextHealthRecords(records, selector);
  const system = yield* SystemInfo;
  const report = yield* collectContextHealth(config, project, selectedRecords, system.currentDirectory(), {
    after: selector?.after,
    duplicateCorpus: records,
    ...(selector === undefined ? {} : {includeFindingCombination: 'all' as const}),
    ...(selector?.findingCategory === undefined ? {} : {includeFindingCategories: [selector.findingCategory]}),
    ...(contextHealthSelectorFindingUris(selector, selectedRecords) === undefined
      ? {}
      : {includeFindingUris: contextHealthSelectorFindingUris(selector, selectedRecords)}),
  });
  if (selector === undefined) {
    yield* recordHealthValueSnapshot(config.agentContextHome, {
      activeFindings: report.maintenance?.affectedMemories ?? report.findings.length + report.omittedFindings,
      project,
      timestamp: (yield* DateTime.nowAsDate).toISOString(),
    }).pipe(Effect.ignore);
  }
  yield* writeFinalCliOutput(options.json ? JSON.stringify(report) : renderContextHealth(report, selector));
});

/** Shared read-only evidence collection for health and CI; never prepares a graph. */
export const collectContextHealthEvidence = Effect.fn('memory.contextHealth.collectEvidence')(function* (
  config: RuntimeConfig,
  project: string,
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
  cwd: string,
  options: {
    readonly after?: string;
    readonly evidenceMode?: 'foreground' | 'worker';
    readonly workerEvidence?: MaintenanceWorkerEvidence;
    readonly citationRecords?: Parameters<typeof buildContextHealthReport>[0]['records'];
    readonly duplicateCorpus?: Parameters<typeof buildContextHealthReport>[0]['records'];
    readonly includeCitationCoverageFindings?: boolean;
    readonly includeFindingCategories?: Parameters<typeof buildContextHealthReport>[0]['includeFindingCategories'];
    readonly includeFindingCombination?: Parameters<typeof buildContextHealthReport>[0]['includeFindingCombination'];
    readonly includeFindingUris?: readonly string[];
    readonly limit?: number;
    readonly relationCorpus?: Parameters<typeof buildContextHealthReport>[0]['records'];
  } = {},
) {
  const now = yield* DateTime.nowAsDate;
  const includedUris = options.includeFindingUris === undefined ? undefined : new Set(options.includeFindingUris);
  const evidenceRecords = includedUris === undefined ? records : records.filter(record => includedUris.has(record.uri));
  const citationRecords = options.citationRecords ?? evidenceRecords;
  const citationResult =
    options.evidenceMode === 'worker' && options.workerEvidence !== undefined
      ? Result.succeed(
          citationRecords.flatMap(record => maintenanceWorkerRecordValidations(options.workerEvidence!, record)),
        )
      : yield* collectContextMaintenanceCitationEvidence(
          config,
          project,
          citationRecords,
          citationCandidates(citationRecords),
          cwd,
          {
            mode:
              options.evidenceMode ?? (options.includeCitationCoverageFindings === true ? 'diagnostic' : 'foreground'),
            validate: selected =>
              validateContextHealthMemoryCitations(config, {callerCwd: cwd, kind: 'repository', project}, selected, {
                fullScan: options.evidenceMode === 'worker',
              }),
          },
        ).pipe(Effect.result);
  if (Result.isFailure(citationResult) && citationResult.failure instanceof ContextMaintenanceEvidenceRequestError)
    return yield* citationResult.failure;
  const citationValidations = Result.isSuccess(citationResult) ? citationResult.success : [];
  const relationEvidence = yield* relationStatusEvidence(
    config,
    options.includeFindingCategories?.includes('relation-target-conflicted') === true ? records : evidenceRecords,
    options.relationCorpus,
  );
  const candidateEvidence = yield* candidateStatusEvidence(config, project);
  const guidanceEvidence = yield* guidanceHealthEvidence(config, project, cwd);
  const report = buildContextHealthReport({
    after: options.after,
    candidateEvidence,
    guidanceEvidence,
    citationValidations,
    citationCoverage: contextHealthCitationCoverageV2({
      records: options.citationRecords ?? evidenceRecords,
      validations: citationValidations,
    }),
    duplicateCorpus: options.duplicateCorpus,
    includeCitationCoverageFindings: options.includeCitationCoverageFindings,
    includeFindingCategories: options.includeFindingCategories,
    includeFindingCombination: options.includeFindingCombination,
    includeFindingUris: options.includeFindingUris,
    limit: options.limit,
    now,
    project,
    records,
    relationEvidence,
  });
  return {report, citationValidations};
});

export const collectContextHealth = Effect.fn('memory.contextHealth.collect')(function* (
  ...args: Parameters<typeof collectContextHealthEvidence>
) {
  return (yield* collectContextHealthEvidence(...args)).report;
});

function citationCandidates(
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
): readonly ContextBriefMemoryCandidateV1[] {
  return records.flatMap((record, rank) => {
    if (record.metadata.kind !== 'durable' && record.metadata.kind !== 'handoff') return [];
    return [
      {
        citationErrorCount: record.metadata.citationErrors?.length ?? 0,
        codeCitations: record.metadata.codeCitations ?? [],
        excerpt: '',
        kind: record.metadata.kind,
        ...(record.metadata.memoryId === undefined ? {} : {memoryId: record.metadata.memoryId}),
        project: record.metadata.project,
        rank,
        uri: record.uri,
      },
    ];
  });
}

const relationStatusEvidence = Effect.fn('memory.contextHealth.relationEvidence')(function* (
  config: RuntimeConfig,
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
  selectedCorpus?: Parameters<typeof buildContextHealthReport>[0]['records'],
) {
  const corpus = selectedCorpus ?? (yield* readMaintenanceMemoryRecords(config));
  const identityCandidates = corpus.map(record => ({
    memoryId: record.metadata.memoryId,
    status: record.metadata.status,
    uri: record.uri,
  }));
  const allowedScopes = [`threadnote://user/${uriSegment(config.user)}/memories`];
  return records.flatMap(record =>
    (record.metadata.relations ?? []).map(relation => {
      const memoryId = memoryIdFromIdentityAlias(relation.uri);
      const resolution =
        memoryId === undefined
          ? undefined
          : classifyMemoryIdentityCandidates(identityCandidates, memoryId, allowedScopes);
      const directMatches =
        memoryId === undefined
          ? corpus.filter(
              candidate =>
                candidate.uri === relation.uri ||
                (candidate.metadata.status !== 'active' && candidate.metadata.archivedFrom === relation.uri),
            )
          : undefined;
      const target =
        resolution?.state === 'resolved'
          ? corpus.find(candidate => candidate.uri === resolution.uri)
          : memoryId === undefined
            ? directMatches?.length === 1
              ? directMatches[0]
              : undefined
            : undefined;
      const inactiveIdentityMatches =
        memoryId === undefined
          ? []
          : corpus.filter(
              candidate => candidate.metadata.memoryId === memoryId && candidate.metadata.status !== 'active',
            );
      return {
        sourceUri: record.uri,
        status:
          resolution?.state === 'ambiguous' || (directMatches !== undefined && directMatches.length > 1)
            ? 'conflicted'
            : target?.metadata.status === 'active'
              ? 'active'
              : target !== undefined || inactiveIdentityMatches.length > 0
                ? 'inactive'
                : 'missing',
        targetUri: relation.uri,
      } satisfies ContextHealthRelationEvidenceV1;
    }),
  );
});

const candidateStatusEvidence = Effect.fn('memory.contextHealth.candidateEvidence')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const reviews = yield* listCandidateReviews(config.agentContextHome);
  return reviews
    .filter(review => review.project === project)
    .flatMap(review =>
      review.candidates.flatMap(candidate =>
        candidate.state === 'pending' || candidate.state === 'deferred' || candidate.state === 'applying'
          ? [
              {
                candidateId: candidate.candidateId,
                comparison: candidate.comparison,
                project: candidate.project,
                ...(candidate.targetUri === undefined ? {} : {targetUri: candidate.targetUri}),
              } satisfies ContextHealthCandidateEvidenceV1,
            ]
          : [],
      ),
    );
});

export function renderContextHealth(
  report: ReturnType<typeof buildContextHealthReport>,
  selector?: ContextHealthSelectorV1,
): string {
  const visibleFindings =
    selector === undefined && report.maintenance !== undefined
      ? report.findings.filter(finding => finding.classification === 'actionable')
      : report.findings;
  const shownFindings = visibleFindings.length;
  const totalFindings = shownFindings + report.omittedFindings;
  const lines = [
    report.maintenance === undefined
      ? `Context health for ${report.project}: status=${report.status}; ${report.recordsScanned} active records; ${totalFindings} findings (${shownFindings} shown).`
      : `Context health for ${report.project}: ${report.maintenance.affectedMemories} memories need decisions; ${report.maintenance.automaticallyManagedFindings} automatically managed findings; ${report.recordsScanned} active records.`,
    ...(report.maintenance === undefined
      ? []
      : [
          `Citation evidence: ${report.maintenance.citationCoverage.state}; ${report.maintenance.citationCoverage.currentVerified} current, ${report.maintenance.citationCoverage.historicalVerified} historical, ${report.maintenance.citationCoverage.deferred} deferred.`,
          `Maintenance progress: threadnote context maintain --action status --project ${shellQuote(report.project)}`,
        ]),
    ...(selector === undefined ? [] : [`Active selector: ${contextHealthSelectorDescription(selector)}.`]),
    `Semantic evidence: ${report.semanticCompleteness.state}; ${report.semanticCompleteness.analyzedRecords}/${report.semanticCompleteness.eligibleRecords} durable record(s) analyzed, ${report.semanticCompleteness.unknownRecords} unknown.`,
  ];
  if (visibleFindings.length <= 12) {
    lines.push(
      ...visibleFindings.flatMap(finding => [
        `- ${finding.severity} ${finding.category}: ${finding.summary}`,
        ...(findingOwner(finding) === undefined ? [] : [`  owner: ${findingOwner(finding)}`]),
      ]),
    );
  } else {
    lines.push('Shown findings grouped by severity and category:');
    for (const group of findingGroups(visibleFindings)) {
      const owners = [...new Set(group.findings.flatMap(finding => findingOwner(finding) ?? []))];
      lines.push(
        `- ${group.findings.length} ${group.severity} ${group.category} finding${group.findings.length === 1 ? '' : 's'} across ${owners.length} owning memor${owners.length === 1 ? 'y' : 'ies'}.`,
      );
      lines.push(
        ...group.findings.slice(0, 2).map(finding => {
          const owner = findingOwner(finding);
          return `  example: ${finding.summary}${owner === undefined ? '' : ` (owner: ${owner})`}`;
        }),
      );
    }
  }
  if (report.semanticCompleteness.unknownReasons.length > 0) {
    lines.push(
      `- Semantic unknown evidence: ${report.semanticCompleteness.unknownReasons
        .map(item => `${item.reason}=${item.count}`)
        .join(', ')}.`,
    );
  }
  if (report.status === 'unknown' && report.semanticCompleteness.state !== 'complete') {
    lines.push('Known findings remain actionable, but partial semantic evidence cannot establish clean health.');
  }
  const project = shellQuote(report.project);
  const selectorFlags = contextHealthSelectorCliFlags(selector, shellQuote);
  if (report.omittedFindings > 0) {
    lines.push(
      `- ${report.omittedFindings} finding(s) are outside this bounded page${report.remainingFindings === undefined ? '' : `; ${report.remainingFindings} remain after it`}.`,
    );
    if (report.nextCursor !== undefined) {
      const nextSelector = {...selector, after: report.nextCursor};
      lines.push(
        `- Continue this exact scope without duplicates: threadnote context health --project ${project}${contextHealthSelectorCliFlags(nextSelector, shellQuote)}`,
      );
    }
  }
  if (visibleFindings.length > 0) {
    const reviewable = visibleFindings.filter(finding => finding.repairability === 'reviewable').length;
    const manualReview = visibleFindings.filter(finding => finding.repairability === 'manual-review').length;
    const requiresEvidence = visibleFindings.filter(finding => finding.repairability === 'requires-evidence').length;
    lines.push('Next steps for the shown findings:');
    if (reviewable > 0) {
      lines.push(
        `- Preview ${reviewable} reviewable finding${reviewable === 1 ? '' : 's'} with owner metadata: threadnote context repair preview --project ${project}${selectorFlags} --json`,
      );
    }
    if (manualReview > 0) {
      lines.push(`- Manually review ${manualReview} finding${manualReview === 1 ? '' : 's'} before choosing a repair.`);
    }
    if (requiresEvidence > 0) {
      lines.push(
        `- Restore evidence for ${requiresEvidence} finding${requiresEvidence === 1 ? '' : 's'}: read an owner memory, run threadnote graph status in its cited repository/worktree, then rerun this command.`,
      );
    }
    lines.push(
      `- Inspect structured details for the shown findings: threadnote context health --project ${project}${selectorFlags} --json`,
    );
  }
  return lines.join('\n');
}

function findingOwner(finding: ReturnType<typeof buildContextHealthReport>['findings'][number]): string | undefined {
  return finding.repair.subjectUri ?? finding.uris[0];
}

function findingGroups(findings: ReturnType<typeof buildContextHealthReport>['findings']) {
  const groups = new Map<
    string,
    {
      readonly category: (typeof findings)[number]['category'];
      readonly findings: (typeof findings)[number][];
      readonly severity: (typeof findings)[number]['severity'];
    }
  >();
  for (const finding of findings) {
    const key = `${finding.severity}\u0000${finding.category}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {category: finding.category, findings: [finding], severity: finding.severity});
    } else {
      group.findings.push(finding);
    }
  }
  return [...groups.values()];
}
