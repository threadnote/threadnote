import {Schema} from 'effect';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT, type ContextHealthReportV1} from './health.js';
import {
  CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
  MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS,
  type ContextHealthSemanticCompletenessV2,
  type ContextHealthSemanticUnknownReasonV2,
} from './health_semantic.js';

export const CONTEXT_HEALTH_AGGREGATE_VERSION = 1 as const;
export const CONTEXT_HEALTH_SCHEDULE_VERSION = 1 as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const TEAM = /^[a-z0-9][a-z0-9._-]*$/u;
const MINIMUM_CADENCE_MINUTES = 5;
const MAXIMUM_CADENCE_MINUTES = 30 * 24 * 60;
const MAXIMUM_TEAM_SOURCES = 32;
const MAXIMUM_TEAM_BYTES = 128;
const MAXIMUM_FINDING_ID_BYTES = 8_192;
const MAXIMUM_REPORT_RECORDS = 1_000_000;

export class ContextHealthScheduleError extends Schema.TaggedError<ContextHealthScheduleError>()(
  'ContextHealthScheduleError',
  {message: Schema.String},
) {}

export type ContextHealthAggregateUnknownReasonV1 =
  | 'citation-evidence-unavailable'
  | 'configured-teams-invalid'
  | 'evidence-incomplete'
  | 'snapshot-dirty'
  | 'snapshot-missing'
  | 'snapshot-raced'
  | 'snapshot-unreadable'
  | 'team-not-configured';

interface ContextHealthAggregatePersonalSourceV1 {
  readonly scope: 'personal';
}

interface ContextHealthAggregateTeamSourceV1 {
  readonly scope: 'team';
  readonly team: string;
}

interface ContextHealthAggregateTeamSelectionSourceV1 {
  readonly scope: 'team-selection';
}

export type ContextHealthAggregateSourceV1 =
  | ((ContextHealthAggregatePersonalSourceV1 | ContextHealthAggregateTeamSourceV1) & {
      readonly evidenceRevision: string;
      readonly report: ContextHealthReportV1;
      readonly state: 'complete';
    })
  | ((
      | ContextHealthAggregatePersonalSourceV1
      | ContextHealthAggregateTeamSourceV1
      | ContextHealthAggregateTeamSelectionSourceV1
    ) & {
      readonly evidenceRevision?: string;
      readonly reason: ContextHealthAggregateUnknownReasonV1;
      readonly report?: ContextHealthReportV1;
      readonly state: 'unknown';
    });

export interface ContextHealthAggregateFindingV1 {
  readonly findingId: string;
  readonly sourceKey: string;
}

export interface ContextHealthAggregateV1 {
  readonly aggregateId: string;
  readonly completeSources: number;
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly ContextHealthAggregateFindingV1[];
  readonly knownFindings: number;
  readonly project: string;
  readonly sources: readonly ContextHealthAggregateSourceSummaryV1[];
  readonly status: 'clean' | 'findings' | 'unknown';
  readonly unknownSources: number;
  readonly version: typeof CONTEXT_HEALTH_AGGREGATE_VERSION;
}

export type ContextHealthAggregateSourceSummaryV1 =
  | {
      readonly evidenceRevision: string;
      readonly findingCount: number;
      readonly recordsScanned: number;
      readonly sourceKey: string;
      readonly state: 'complete';
    }
  | {
      readonly evidenceRevision?: string;
      readonly findingCount?: number;
      readonly recordsScanned?: number;
      readonly reason: ContextHealthAggregateUnknownReasonV1;
      readonly sourceKey: string;
      readonly state: 'unknown';
    };

export interface ContextHealthSchedulePlanV1 {
  readonly argv: readonly string[];
  readonly cadenceMinutes: number;
  readonly execution: {readonly network: 'disabled'; readonly readOnly: true};
  readonly project: string;
  readonly resultPolicy: {readonly clean: 0; readonly findings: 1; readonly unknown: 2};
  readonly scheduleId: string;
  readonly teams: readonly string[];
  readonly version: typeof CONTEXT_HEALTH_SCHEDULE_VERSION;
}

export function aggregateContextHealthReportsV1(input: {
  readonly personal?: ContextHealthAggregateSourceV1;
  readonly project: string;
  readonly teams: readonly ContextHealthAggregateSourceV1[];
}): ContextHealthAggregateV1 {
  const project = canonicalContextHealthProjectV1(input.project);
  if (input.personal !== undefined && input.personal.scope !== 'personal') {
    fail('The personal aggregate source must use personal scope.');
  }
  if (input.teams.length > MAXIMUM_TEAM_SOURCES) {
    fail(`Context health aggregation supports at most ${MAXIMUM_TEAM_SOURCES} team sources.`);
  }
  const teams = input.teams.map(source => {
    if (source.scope !== 'team' && source.scope !== 'team-selection') {
      fail('Every team aggregate source must use team or team-selection scope.');
    }
    return canonicalSource(source, project);
  });
  const teamKeys = teams.map(source => source.sourceKey);
  if (new Set(teamKeys).size !== teamKeys.length) fail('Context health aggregate contains a duplicate team source.');
  const sources = [...(input.personal === undefined ? [] : [canonicalSource(input.personal, project)]), ...teams].sort(
    compareSource,
  );
  if (sources.length === 0) fail('Context health aggregation requires at least one evidence source.');
  const findings = sources
    .flatMap(source => (source.findingIds ?? []).map(findingId => ({findingId, sourceKey: source.sourceKey})))
    .sort(compareFinding);
  const sourceSummaries: ContextHealthAggregateSourceSummaryV1[] = sources.map(source =>
    source.state === 'complete'
      ? {
          evidenceRevision: source.evidenceRevision,
          findingCount: source.findingCount,
          recordsScanned: source.recordsScanned,
          sourceKey: source.sourceKey,
          state: 'complete',
        }
      : {
          ...(source.evidenceRevision === undefined ? {} : {evidenceRevision: source.evidenceRevision}),
          ...(source.findingCount === undefined
            ? {}
            : {findingCount: source.findingCount, recordsScanned: source.recordsScanned}),
          reason: source.reason,
          sourceKey: source.sourceKey,
          state: 'unknown',
        },
  );
  const unknownSources = sourceSummaries.filter(source => source.state === 'unknown').length;
  const knownFindings = sources.reduce((count, source) => count + (source.findingCount ?? 0), 0);
  const status = unknownSources > 0 ? 'unknown' : knownFindings > 0 ? 'findings' : 'clean';
  const exitCode = status === 'unknown' ? 2 : status === 'findings' ? 1 : 0;
  const unsigned = {
    completeSources: sourceSummaries.length - unknownSources,
    exitCode,
    findings,
    knownFindings,
    project,
    sources: sourceSummaries,
    status,
    unknownSources,
    version: CONTEXT_HEALTH_AGGREGATE_VERSION,
  } as const;
  return {...unsigned, aggregateId: `context-health-${sha256HexSync(canonicalJson(unsigned)).slice(0, 40)}`};
}

export function buildContextHealthSchedulePlanV1(input: {
  readonly cadenceMinutes: number;
  readonly project: string;
  readonly teams?: readonly string[];
}): ContextHealthSchedulePlanV1 {
  const project = canonicalContextHealthProjectV1(input.project);
  if (
    !Number.isSafeInteger(input.cadenceMinutes) ||
    input.cadenceMinutes < MINIMUM_CADENCE_MINUTES ||
    input.cadenceMinutes > MAXIMUM_CADENCE_MINUTES
  ) {
    fail(
      `Context health cadence must be an integer from ${MINIMUM_CADENCE_MINUTES} to ${MAXIMUM_CADENCE_MINUTES} minutes.`,
    );
  }
  const teams = canonicalContextHealthTeamsV1(input.teams ?? []);
  const argv = [
    'context',
    'health',
    'aggregate',
    '--project',
    project,
    '--json',
    ...teams.flatMap(team => ['--team', team]),
  ];
  const unsigned = {
    argv,
    cadenceMinutes: input.cadenceMinutes,
    execution: {network: 'disabled' as const, readOnly: true as const},
    project,
    resultPolicy: {clean: 0 as const, findings: 1 as const, unknown: 2 as const},
    teams,
    version: CONTEXT_HEALTH_SCHEDULE_VERSION,
  };
  return {...unsigned, scheduleId: `context-health-${sha256HexSync(canonicalJson(unsigned)).slice(0, 40)}`};
}

export function canonicalContextHealthTeamsV1(input: readonly string[]): readonly string[] {
  if (input.length > MAXIMUM_TEAM_SOURCES) {
    fail(`Context health schedules support at most ${MAXIMUM_TEAM_SOURCES} teams.`);
  }
  return [...new Set(input.map(canonicalTeam))].sort(compareText);
}

export function renderContextHealthAggregate(aggregate: ContextHealthAggregateV1): string {
  return [
    `Context health aggregate for ${aggregate.project}: ${aggregate.status}; ${aggregate.completeSources} complete source(s), ${aggregate.unknownSources} unknown source(s), ${aggregate.knownFindings} known finding(s).`,
    ...aggregate.sources.map(source =>
      source.state === 'complete'
        ? `- ${source.sourceKey}: complete; ${source.recordsScanned} record(s), ${source.findingCount} finding(s), revision ${source.evidenceRevision}.`
        : `- ${source.sourceKey}: unknown (${source.reason})${source.evidenceRevision === undefined ? '.' : `, revision ${source.evidenceRevision}.`}`,
    ),
  ].join('\n');
}

export function renderContextHealthSchedulePlan(plan: ContextHealthSchedulePlanV1): string {
  return [
    `Context health schedule for ${plan.project}: every ${plan.cadenceMinutes} minute(s); read-only, network disabled.`,
    `Command argv: ${JSON.stringify(['threadnote', ...plan.argv])}`,
    `Exit policy: clean=${plan.resultPolicy.clean}, findings=${plan.resultPolicy.findings}, unknown=${plan.resultPolicy.unknown}.`,
  ].join('\n');
}

type CanonicalSource =
  | {
      readonly evidenceRevision: string;
      readonly findingCount: number;
      readonly findingIds: readonly string[];
      readonly recordsScanned: number;
      readonly sourceKey: string;
      readonly state: 'complete';
    }
  | {
      readonly evidenceRevision?: string;
      readonly findingCount?: number;
      readonly findingIds?: readonly string[];
      readonly recordsScanned?: number;
      readonly reason: ContextHealthAggregateUnknownReasonV1;
      readonly sourceKey: string;
      readonly state: 'unknown';
    };

function canonicalSource(source: ContextHealthAggregateSourceV1, project: string): CanonicalSource {
  const sourceKey =
    source.scope === 'personal'
      ? 'personal'
      : source.scope === 'team-selection'
        ? 'team-selection'
        : `team:${canonicalTeam(source.team)}`;
  if (source.state === 'unknown') {
    if (source.evidenceRevision !== undefined && !SHA256.test(source.evidenceRevision)) {
      fail(`Context health source ${sourceKey} has an invalid evidence revision.`);
    }
    return {
      ...(source.evidenceRevision === undefined ? {} : {evidenceRevision: source.evidenceRevision}),
      ...(source.report === undefined ? {} : canonicalKnownFindings(source.report, project, sourceKey)),
      reason: source.reason,
      sourceKey,
      state: 'unknown',
    };
  }
  if (!SHA256.test(source.evidenceRevision))
    fail(`Context health source ${sourceKey} has an invalid evidence revision.`);
  const knownFindings = canonicalKnownFindings(source.report, project, sourceKey);
  if (source.report.status === 'unknown') {
    return {
      evidenceRevision: source.evidenceRevision,
      ...(knownFindings.findingCount === 0 ? {} : knownFindings),
      reason: 'evidence-incomplete',
      sourceKey,
      state: 'unknown',
    };
  }
  return {
    evidenceRevision: source.evidenceRevision,
    ...knownFindings,
    sourceKey,
    state: 'complete',
  };
}

function canonicalKnownFindings(report: ContextHealthReportV1, project: string, sourceKey: string) {
  validateReport(report, project, sourceKey);
  const findingIds = report.findings.map(finding => finding.id).sort(compareText);
  if (new Set(findingIds).size !== findingIds.length) {
    fail(`Context health source ${sourceKey} contains a duplicate finding ID.`);
  }
  return {
    findingCount: report.findings.length + report.omittedFindings,
    findingIds,
    recordsScanned: report.recordsScanned,
  };
}

export function canonicalContextHealthProjectV1(input: string): string {
  const project = input.trim();
  if (
    !project ||
    project.startsWith('-') ||
    new TextEncoder().encode(project).byteLength > 256 ||
    hasControlCharacter(project)
  ) {
    fail('Context health project must be non-empty, control-free, and at most 256 UTF-8 bytes.');
  }
  try {
    return validatePortableSegment(project, input);
  } catch {
    return fail('Context health project must be one portable project identity segment.');
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function hasUnexpectedFindingIdControlCharacter(value: string): boolean {
  return (
    ![...value].some(character => character !== '\0') ||
    [...value].some(character => character !== '\0' && hasControlCharacter(character))
  );
}

function canonicalTeam(input: string): string {
  const team = input.trim();
  if (new TextEncoder().encode(team).byteLength > MAXIMUM_TEAM_BYTES || !TEAM.test(team) || /^\.+$/u.test(team)) {
    fail(`Invalid context health team ${JSON.stringify(input)}.`);
  }
  return team;
}

function validateReport(report: ContextHealthReportV1, project: string, sourceKey: string): void {
  if (report.version !== 1) fail(`Context health source ${sourceKey} has an unsupported report version.`);
  if (report.project !== project) fail(`Context health source ${sourceKey} belongs to another project.`);
  if (!Number.isSafeInteger(report.limit) || report.limit < 0 || report.limit > MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT) {
    fail(`Context health source ${sourceKey} has an invalid finding limit.`);
  }
  if (
    !Number.isSafeInteger(report.omittedFindings) ||
    report.omittedFindings < 0 ||
    report.omittedFindings > MAXIMUM_REPORT_RECORDS
  ) {
    fail(`Context health source ${sourceKey} has invalid omitted findings.`);
  }
  if (
    !Number.isSafeInteger(report.recordsScanned) ||
    report.recordsScanned < 0 ||
    report.recordsScanned > MAXIMUM_REPORT_RECORDS
  ) {
    fail(`Context health source ${sourceKey} has an invalid scanned-record count.`);
  }
  if (
    !Array.isArray(report.findings) ||
    report.findings.length > report.limit ||
    report.findings.length > MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT
  ) {
    fail(`Context health source ${sourceKey} has an invalid finding collection.`);
  }
  for (const finding of report.findings) {
    const candidate: unknown = finding;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('id' in candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      new TextEncoder().encode(candidate.id).byteLength > MAXIMUM_FINDING_ID_BYTES ||
      hasUnexpectedFindingIdControlCharacter(candidate.id)
    ) {
      fail(`Context health source ${sourceKey} has an invalid finding ID.`);
    }
  }
  validateSemanticCompleteness(report.semanticCompleteness, report.recordsScanned, sourceKey);
  const findingCount = report.findings.length + report.omittedFindings;
  const semanticComplete =
    report.semanticCompleteness.state === 'complete' &&
    (report.maintenance?.citationCoverage.state ?? 'complete') === 'complete';
  if (
    (report.status === 'clean' && (!semanticComplete || findingCount !== 0)) ||
    (report.status === 'findings' && (!semanticComplete || findingCount === 0)) ||
    (report.status === 'unknown' && semanticComplete && findingCount !== 0) ||
    (report.status !== 'clean' && report.status !== 'findings' && report.status !== 'unknown')
  ) {
    fail(`Context health source ${sourceKey} has an inconsistent report status.`);
  }
}

const SEMANTIC_UNKNOWN_REASONS = new Set<ContextHealthSemanticUnknownReasonV2>([
  'body-limit',
  'claim-budget',
  'claim-limit',
  'claim-too-large',
  'contradiction-limit',
  'no-claims',
  'record-limit',
  'unsupported-extraction',
]);

function validateSemanticCompleteness(
  completeness: ContextHealthSemanticCompletenessV2,
  recordsScanned: number,
  sourceKey: string,
): void {
  const candidate: unknown = completeness;
  if (typeof candidate !== 'object' || candidate === null) {
    fail(`Context health source ${sourceKey} has invalid semantic completeness.`);
  }
  const boundedCounts = [
    completeness.analyzedRecords,
    completeness.claimsAnalyzed,
    completeness.supportedClaims,
    completeness.unsupportedClaims,
    completeness.contradictionCount,
    completeness.eligibleRecords,
    completeness.omittedContradictions,
    completeness.pairsCompared,
    completeness.unknownRecords,
  ];
  if (boundedCounts.some(count => !Number.isSafeInteger(count) || count < 0 || count > MAXIMUM_REPORT_RECORDS)) {
    fail(`Context health source ${sourceKey} has invalid semantic completeness counts.`);
  }
  const maximumPairs = (completeness.claimsAnalyzed * (completeness.claimsAnalyzed - 1)) / 2;
  if (
    completeness.version !== CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION ||
    completeness.coverage !== 'bounded-English-extraction' ||
    completeness.supportedClaims + completeness.unsupportedClaims !== completeness.claimsAnalyzed ||
    completeness.eligibleRecords > recordsScanned ||
    completeness.analyzedRecords + completeness.unknownRecords !== completeness.eligibleRecords ||
    completeness.claimsAnalyzed > MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS ||
    completeness.pairsCompared > maximumPairs ||
    completeness.contradictionCount > completeness.pairsCompared ||
    completeness.omittedContradictions > completeness.contradictionCount ||
    !Array.isArray(completeness.unknownReasons) ||
    completeness.unknownReasons.length > SEMANTIC_UNKNOWN_REASONS.size
  ) {
    fail(`Context health source ${sourceKey} has invalid semantic completeness.`);
  }
  const seenReasons = new Set<ContextHealthSemanticUnknownReasonV2>();
  for (const entry of completeness.unknownReasons) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !SEMANTIC_UNKNOWN_REASONS.has(entry.reason) ||
      seenReasons.has(entry.reason) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0 ||
      entry.count > MAXIMUM_REPORT_RECORDS
    ) {
      fail(`Context health source ${sourceKey} has invalid semantic unknown reasons.`);
    }
    seenReasons.add(entry.reason);
  }
  if (
    completeness.omittedContradictions > 0 !== seenReasons.has('contradiction-limit') ||
    (completeness.state === 'complete' &&
      (completeness.unknownRecords !== 0 || completeness.omittedContradictions !== 0 || seenReasons.size !== 0)) ||
    (completeness.state === 'unavailable' &&
      (completeness.eligibleRecords === 0 ||
        completeness.analyzedRecords !== 0 ||
        completeness.unknownRecords === 0)) ||
    (completeness.state === 'partial' &&
      completeness.unknownRecords === 0 &&
      completeness.omittedContradictions === 0) ||
    (completeness.state !== 'complete' && completeness.state !== 'partial' && completeness.state !== 'unavailable')
  ) {
    fail(`Context health source ${sourceKey} has an inconsistent semantic completeness state.`);
  }
}

function compareSource(left: CanonicalSource, right: CanonicalSource): number {
  if (left.sourceKey === 'personal') return right.sourceKey === 'personal' ? 0 : -1;
  if (right.sourceKey === 'personal') return 1;
  return compareText(left.sourceKey, right.sourceKey);
}

function compareFinding(left: ContextHealthAggregateFindingV1, right: ContextHealthAggregateFindingV1): number {
  return compareText(`${left.sourceKey}\u0000${left.findingId}`, `${right.sourceKey}\u0000${right.findingId}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string): never {
  throw ContextHealthScheduleError.make({message});
}
