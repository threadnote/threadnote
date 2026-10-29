import * as MigrationSchema from 'effect/Schema';
import {pipe as EffectArrayPipe} from 'effect';

import {Array as EffectArray, Option as EffectOption} from 'effect';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
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
import type {ContextHealthCitationSubjectV1} from '@threadnote/context/types';
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
import {isAgentArtifactUri} from '@threadnote/memory/document';
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
import {reviewedSemanticContradictionIds} from './semantic_review_state.js';
import {nextContextHealthChangeAt} from '@threadnote/context/health';
import {ManagerHealthObservationHints} from '../../manager/live_health_sources.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
  const project = Effect2.pipe(options.project, EffectString.trim);
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
    /** Only the complete Manager health resource registers live source coverage. */
    readonly liveObservation?: boolean;
    readonly relationCorpus?: Parameters<typeof buildContextHealthReport>[0]['records'];
  } = {},
) {
  const now = yield* DateTime.nowAsDate;
  const includedUris = options.includeFindingUris === undefined ? undefined : new Set(options.includeFindingUris);
  const evidenceRecords =
    includedUris === undefined
      ? records
      : EffectArray.filter(
          records,
          (record: (typeof records)[number], __effectArrayIndex) =>
            __effectArrayIndex in records && includedUris.has(record.uri),
        );
  const citationRecords =
    options.citationRecords ??
    EffectArray.map(evidenceRecords, record => ({
      ...record,
      metadata: {...record.metadata, codeCitations: currentMemoryCodeCitations(record)},
    }));
  const workerEvidence = options.workerEvidence;
  const citationResult =
    options.evidenceMode === 'worker' && workerEvidence !== undefined
      ? Result.succeed(
          EffectArray.flatMap(citationRecords, (record, __effectArrayIndex4) =>
            __effectArrayIndex4 in citationRecords ? maintenanceWorkerRecordValidations(workerEvidence, record) : [],
          ),
        )
      : yield* collectContextMaintenanceCitationEvidence(
          config,
          project,
          citationRecords,
          citationCandidates(citationRecords, project),
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
  if (
    Result.isFailure(citationResult) &&
    MigrationSchema.is(ContextMaintenanceEvidenceRequestError)(citationResult.failure)
  )
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
    reviewedSemanticContradictionIds: yield* reviewedSemanticContradictionIds(config, project, records),
    after: options.after,
    candidateEvidence,
    guidanceEvidence,
    citationValidations,
    citationCoverage: contextHealthCitationCoverageV2({
      records: citationRecords,
      validations: citationValidations,
      citationSelection: 'provided',
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
  // Register the report's actual source selection, including cited repositories.
  // Non-Manager callers receive the no-op reference and do no observation work.
  if (options.liveObservation === true) {
    const deadlines = EffectArray.filter(
      [
        nextContextHealthChangeAt({records, duplicateCorpus: options.duplicateCorpus, project, now}),
        ...EffectArray.flatMap(citationValidations, (validation, __effectArrayIndex4) =>
          __effectArrayIndex4 in citationValidations
            ? EffectArray.map(
                EffectArrayPipe(validation.receipts, __effectArrayValues =>
                  EffectArray.filter(
                    __effectArrayValues,
                    (receipt, __effectArrayIndex2) =>
                      __effectArrayIndex2 in __effectArrayValues &&
                      receipt.status === 'unknown' &&
                      receipt.provenance !== 'historical-verified',
                  ),
                ),
                receipt => Date.parse(receipt.observedAt) + 60_000,
              )
            : [],
        ),
      ],
      (value): value is number => value !== undefined && Number.isFinite(value) && value > now.getTime(),
    );
    yield* (yield* ManagerHealthObservationHints).register(project, {
      cwd,
      citations: EffectArray.flatMap(citationRecords, (record, __effectArrayIndex3) =>
        __effectArrayIndex3 in citationRecords ? (record.metadata.codeCitations ?? []) : [],
      ),
      ...(deadlines.length === 0 ? {} : {nextChangeAt: Math.min(...deadlines)}),
    });
  }
  return {report, citationValidations};
});

export const collectContextHealth = Effect.fn('memory.contextHealth.collect')(function* (
  ...args: Parameters<typeof collectContextHealthEvidence>
) {
  return (yield* collectContextHealthEvidence(...args)).report;
});

function citationCandidates(
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
  project: string,
): readonly ContextHealthCitationSubjectV1[] {
  return EffectArray.flatMap(records, (record, effectFlatMapIndex) =>
    effectFlatMapIndex in records
      ? record.metadata.status === 'active' &&
        record.metadata.project === project &&
        record.metadata.codeCitations?.length
        ? [{codeCitations: record.metadata.codeCitations, uri: record.uri}]
        : []
      : [],
  );
}

const relationStatusEvidence = Effect.fn('memory.contextHealth.relationEvidence')(function* (
  config: RuntimeConfig,
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
  selectedCorpus?: Parameters<typeof buildContextHealthReport>[0]['records'],
) {
  const corpus = selectedCorpus ?? (yield* readMaintenanceMemoryRecords(config));
  const identityCandidates = EffectArray.map(corpus, record => ({
    memoryId: record.metadata.memoryId,
    status: record.metadata.status,
    uri: record.uri,
  }));
  const allowedScopes = [`threadnote://user/${uriSegment(config.user)}/memories`];
  return EffectArray.flatMap(records, (record, __effectArrayIndex5) =>
    __effectArrayIndex5 in records
      ? EffectArray.map(
          EffectArrayPipe(record.metadata.relations ?? [], __effectArrayValues3 =>
            EffectArray.filter(
              __effectArrayValues3,
              (relation, __effectArrayIndex4) =>
                __effectArrayIndex4 in __effectArrayValues3 && !isAgentArtifactUri(relation.uri),
            ),
          ),
          relation => {
            const memoryId = memoryIdFromIdentityAlias(relation.uri);
            const resolution =
              memoryId === undefined
                ? undefined
                : classifyMemoryIdentityCandidates(identityCandidates, memoryId, allowedScopes);
            const directMatches =
              memoryId === undefined
                ? EffectArray.filter(
                    corpus,
                    (candidate: (typeof corpus)[number], __effectArrayIndex) =>
                      __effectArrayIndex in corpus &&
                      (candidate.uri === relation.uri ||
                        (candidate.metadata.status !== 'active' && candidate.metadata.archivedFrom === relation.uri)),
                  )
                : undefined;
            const target =
              resolution?.state === 'resolved'
                ? EffectOption.getOrUndefined(
                    EffectArray.findFirst(corpus, candidate => candidate.uri === resolution.uri),
                  )
                : memoryId === undefined
                  ? directMatches?.length === 1
                    ? directMatches[0]
                    : undefined
                  : undefined;
            const inactiveIdentityMatches =
              memoryId === undefined
                ? []
                : EffectArray.filter(
                    corpus,
                    (candidate: (typeof corpus)[number], __effectArrayIndex) =>
                      __effectArrayIndex in corpus &&
                      candidate.metadata.memoryId === memoryId &&
                      candidate.metadata.status !== 'active',
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
          },
        )
      : [],
  );
});

const candidateStatusEvidence = Effect.fn('memory.contextHealth.candidateEvidence')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const reviews = yield* listCandidateReviews(config.agentContextHome);
  return EffectArray.flatMap(
    EffectArray.filter(
      reviews,
      (review: (typeof reviews)[number], __effectArrayIndex) =>
        __effectArrayIndex in reviews && review.project === project,
    ),
    (review: (typeof reviews)[number]) =>
      EffectArrayPipe(review.candidates, __effectFlatMapValues =>
        EffectArray.flatMap(__effectFlatMapValues, (candidate, __effectFlatMapIndex) =>
          __effectFlatMapIndex in __effectFlatMapValues
            ? candidate.state === 'pending' || candidate.state === 'deferred' || candidate.state === 'applying'
              ? [
                  {
                    candidateId: candidate.candidateId,
                    comparison: candidate.comparison,
                    project: candidate.project ?? review.project,
                    ...(candidate.targetUri === undefined ? {} : {targetUri: candidate.targetUri}),
                  } satisfies ContextHealthCandidateEvidenceV1,
                ]
              : []
            : [],
        ),
      ),
  );
});

export function renderContextHealth(
  report: ReturnType<typeof buildContextHealthReport>,
  selector?: ContextHealthSelectorV1,
): string {
  const visibleFindings =
    selector === undefined && report.maintenance !== undefined
      ? EffectArrayPipe(report.findings, __effectFilterValues =>
          EffectArray.filter(
            __effectFilterValues,
            (finding, __effectFilterIndex) =>
              __effectFilterIndex in __effectFilterValues && finding.classification === 'actionable',
          ),
        )
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
    `Bounded English extraction: ${report.semanticCompleteness.state}; ${report.semanticCompleteness.analyzedRecords}/${report.semanticCompleteness.eligibleRecords} durable record(s) analyzed, ${report.semanticCompleteness.unknownRecords} unknown.`,
  ];
  if (visibleFindings.length <= 12) {
    lines.push(
      ...EffectArray.flatMap(visibleFindings, (finding, effectFlatMapIndex2) =>
        effectFlatMapIndex2 in visibleFindings
          ? [
              `- ${finding.severity} ${finding.category}: ${finding.summary}`,
              ...(findingOwner(finding) === undefined ? [] : [`  owner: ${findingOwner(finding)}`]),
              ...(finding.semanticEvidence === undefined
                ? []
                : [
                    `  comparison: ${finding.semanticEvidence.reason}; ${finding.semanticEvidence.classification}${finding.semanticEvidence.uncertainty.length === 0 ? '' : `; needs context: ${EffectArray.join(finding.semanticEvidence.uncertainty, ', ')}`}`,
                    ...EffectArray.map(
                      [finding.semanticEvidence.left, finding.semanticEvidence.right],
                      claim =>
                        `  claim: ${JSON.stringify(claim.text)} (${claim.role}; environment=${claim.context.environment ?? 'unknown'}; headings=${EffectArray.join(claim.context.headings, ' / ') || 'none'}; workspace=${claim.context.workspaceScope ?? 'repository'}; validity=${claim.context.validFrom ?? 'unknown'}..${claim.context.validTo ?? 'unknown'}; uri=${claim.recordUri}; body-span=${claim.span.start}..${claim.span.end}; revision=${claim.recordContentFingerprint})`,
                    ),
                  ]),
            ]
          : [],
      ),
    );
  } else {
    lines.push('Shown findings grouped by severity and category:');
    for (const group of findingGroups(visibleFindings)) {
      const owners = [
        ...new Set(
          EffectArrayPipe(group.findings, __effectArrayValues2 =>
            EffectArray.flatMap(__effectArrayValues2, (finding, __effectArrayIndex3) => {
              if (!(__effectArrayIndex3 in __effectArrayValues2)) return [];
              const owner = findingOwner(finding);
              return owner === undefined ? [] : [owner];
            }),
          ),
        ),
      ];
      lines.push(
        `- ${group.findings.length} ${group.severity} ${group.category} finding${group.findings.length === 1 ? '' : 's'} across ${owners.length} owning memor${owners.length === 1 ? 'y' : 'ies'}.`,
      );
      lines.push(
        ...EffectArray.map(group.findings.slice(0, 2), finding => {
          const owner = findingOwner(finding);
          return `  example: ${finding.summary}${owner === undefined ? '' : ` (owner: ${owner})`}`;
        }),
      );
    }
  }
  if (report.semanticCompleteness.unknownReasons.length > 0) {
    lines.push(
      `- Semantic unknown evidence: ${EffectArray.join(
        EffectArray.map(report.semanticCompleteness.unknownReasons, item => `${item.reason}=${item.count}`),
        ', ',
      )}.`,
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
    const reviewable = EffectArray.filter(
      visibleFindings,
      (finding: (typeof visibleFindings)[number], __effectArrayIndex) =>
        __effectArrayIndex in visibleFindings && finding.repairability === 'reviewable',
    ).length;
    const manualReview = EffectArray.filter(
      visibleFindings,
      (finding: (typeof visibleFindings)[number], __effectArrayIndex) =>
        __effectArrayIndex in visibleFindings && finding.repairability === 'manual-review',
    ).length;
    const requiresEvidence = EffectArray.filter(
      visibleFindings,
      (finding: (typeof visibleFindings)[number], __effectArrayIndex) =>
        __effectArrayIndex in visibleFindings && finding.repairability === 'requires-evidence',
    ).length;
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
  return EffectArray.join(lines, '\n');
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
