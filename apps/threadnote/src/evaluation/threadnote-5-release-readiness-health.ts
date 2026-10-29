import {isOneOf as checkedIsOneOf, isFiniteNumber as checkedIsFiniteNumber} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  buildContextHealthReport,
  type ContextHealthReportInputV1,
  type ContextHealthReportV1,
  type ContextHealthCandidateEvidenceV1,
  type ContextHealthFindingCategoryV1,
  type ContextHealthGuidanceEvidenceV1,
  type ContextHealthRelationEvidenceV1,
} from '@threadnote/context/health';
import {
  applyContextHealthRepairProposalV1,
  contextHealthRepairProposalRevisionV1,
  contextHealthReportRevisionV1,
  previewContextHealthRepairPlanV1,
} from '../memory/context/health_repair.js';
import {
  aggregateContextHealthReportsV1,
  buildContextHealthSchedulePlanV1,
  type ContextHealthAggregateSourceV1,
} from '@threadnote/context/health_schedule';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import type {ContextHealthCitationCoverageV2} from '@threadnote/context/health_maintenance';
import type {ContextBriefMemoryCitationValidationV2} from '@threadnote/context/types';
import type {Threadnote5LocalAuthorityEntryV1} from './threadnote-5-release-readiness-authority.js';
import type {Threadnote5MeasurementV1, Threadnote5ReleaseScenario} from './threadnote-5-release-readiness-contract.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const MAX_ATTEMPTS = 64;

export interface Threadnote5HealthDerivedClaimsV1 {
  readonly assertions: readonly string[];
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

export function deriveThreadnote5HealthClaimsV1(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): Threadnote5HealthDerivedClaimsV1 {
  const source = exactObject(
    value,
    scenario === 'health-maintenance' ? ['aggregate', 'repairs', 'reports', 'schedule'] : ['repairs', 'reports'],
    'context-health artifact',
  );
  const reports = EffectArray.map(
    boundedArray(source.reports, 'context-health reports', 0, MAX_ATTEMPTS),
    parseHealthReportCapture,
  );
  const repairs = EffectArray.map(
    boundedArray(source.repairs, 'context-health repairs', 0, MAX_ATTEMPTS),
    parseHealthRepairCapture,
  );
  if (!unique(EffectArray.map(reports, contextHealthReportRevisionV1)))
    throw new Error('Context-health reports must be unique.');
  if (!unique(EffectArray.map(repairs, repair => repair.proposalId))) {
    throw new Error('Context-health repair trials must be unique.');
  }
  if (scenario === 'stale-citation') {
    const categories = new Set(
      EffectArray.flatMap(reports, report => EffectArray.map(report.findings, finding => finding.category)),
    );
    return {
      assertions: [
        ...(categories.has('citation-changed') ? ['changed-never-current'] : []),
        ...(categories.has('citation-missing') ? ['missing-never-current'] : []),
        ...(categories.has('citation-unknown') ? ['unknown-remains-distinct'] : []),
      ],
      measurements: [],
    };
  }
  if (scenario === 'contradiction-triage') {
    const findings = EffectArray.flatMap(reports, report => report.findings);
    const categories = new Set(EffectArray.map(findings, finding => finding.category));
    return {
      assertions: [
        ...(categories.has('candidate-contradiction') ? ['contradiction-category-observed'] : []),
        ...(categories.has('candidate-possible-duplicate') ? ['possible-duplicate-category-observed'] : []),
        ...(EffectArray.some(findings, finding => finding.repairability === 'manual-review')
          ? ['manual-review-required']
          : []),
        'ordering-stable',
      ],
      measurements: [],
    };
  }
  if (scenario === 'health-maintenance') {
    const schedule = parseHealthScheduleCapture(source.schedule);
    const aggregate = parseHealthAggregateCapture(source.aggregate);
    const resolved = EffectArray.filter(
      repairs,
      (repair, __effectArrayIndex) => __effectArrayIndex in repairs && repair.resolved,
    ).length;
    const authorityMissing = authority === undefined;
    if (!authorityMissing && authority?.type !== 'context-health-read-only') {
      throw new Error('Context health authority type does not match its source record.');
    }
    const teamAggregateVerified = authorityMissing
      ? false
      : verifyHealthReadOnlyAuthority(authority, schedule, aggregate);
    return {
      assertions: [
        ...(repairs.length > 0 ? ['health-issue-detected'] : []),
        ...(resolved === repairs.length && repairs.length > 0 ? ['health-resolution-recorded'] : []),
        ...(!authorityMissing ? ['local-scheduled-invocation-read-only'] : []),
        ...(teamAggregateVerified ? ['configured-git-team-aggregation-read-only'] : []),
      ],
      measurements: [{eligibleCount: repairs.length, id: 'health-resolution-rate', positiveCount: resolved}],
      ...(authorityMissing
        ? {missingKinds: ['context-health-schedule-authority', 'context-health-team-aggregate-authority']}
        : teamAggregateVerified
          ? {}
          : {missingKinds: ['context-health-team-selection-evidence']}),
    };
  }
  throw new Error(`Context-health evidence is unsupported for ${scenario}.`);
}

function parseHealthScheduleCapture(value: unknown) {
  const capture = exactObject(value, ['input', 'observedArgv', 'plan'], 'context-health schedule capture');
  const input = exactObject(capture.input, ['cadenceMinutes', 'project', 'teams'], 'context-health schedule input');
  if (!EffectArray.isArray(input.teams) || !EffectArray.every(input.teams, team => typeof team === 'string')) {
    throw new Error('Context-health schedule teams are invalid.');
  }
  if (typeof input.cadenceMinutes !== 'number' || typeof input.project !== 'string') {
    throw new Error('Context-health schedule cadence or project is invalid.');
  }
  const plan = buildContextHealthSchedulePlanV1({
    cadenceMinutes: input.cadenceMinutes,
    project: input.project,
    teams: input.teams,
  });
  if (canonicalJson(plan) !== canonicalJson(capture.plan)) {
    throw new Error('Context-health schedule plan does not match its source inputs.');
  }
  const observedArgv = boundedArgv(capture.observedArgv, 'context-health observed argv');
  if (canonicalJson(observedArgv) !== canonicalJson(['threadnote', ...plan.argv])) {
    throw new Error('Context-health observed argv does not match its recomputed schedule plan.');
  }
  return plan;
}

function parseHealthAggregateCapture(value: unknown) {
  const capture = exactObject(value, ['aggregate', 'input'], 'context-health aggregate capture');
  const input = exactObject(capture.input, ['personal', 'project', 'teams'], 'context-health aggregate input');
  if (!EffectArray.isArray(input.teams)) throw new Error('Context-health aggregate team sources are invalid.');
  if (typeof input.project !== 'string') throw new Error('Context-health aggregate project is invalid.');
  const personal = parseHealthAggregateSource(input.personal, 'personal');
  const teams = EffectArray.map(input.teams, source => parseHealthTeamAggregateSource(source));
  const aggregate = aggregateContextHealthReportsV1({
    personal,
    project: input.project,
    teams,
  });
  if (canonicalJson(aggregate) !== canonicalJson(capture.aggregate)) {
    throw new Error('Context-health aggregate does not match its bounded production sources.');
  }
  return {aggregate, input: {...input, teams}};
}

function parseHealthAggregateSource(
  value: unknown,
  scope: 'personal',
): Extract<ContextHealthAggregateSourceV1, {readonly scope: 'personal'}>;
function parseHealthAggregateSource(
  value: unknown,
  scope: 'team',
): Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team'}>;
function parseHealthAggregateSource(
  value: unknown,
  scope: 'team-selection',
): Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team-selection'}>;
function parseHealthAggregateSource(
  value: unknown,
  scope: 'personal' | 'team' | 'team-selection',
): ContextHealthAggregateSourceV1 {
  const source = object(value, 'context-health aggregate source');
  const base = scope === 'team' ? ['scope', 'state', 'team'] : ['scope', 'state'];
  if (source.scope !== scope || (scope === 'team' && typeof source.team !== 'string')) {
    throw new Error('Context-health aggregate source scope is invalid.');
  }
  if (source.state === 'complete') {
    if (scope === 'team-selection') {
      throw new Error('Context-health team selection cannot contain a complete report.');
    }
    exactHealthSourceKeys(source, [...base, 'evidenceRevision', 'report'], 'complete context-health aggregate source');
    if (typeof source.evidenceRevision !== 'string') {
      throw new Error('Context-health source evidence revision is invalid.');
    }
    object(source.report, 'context-health source report');
  } else if (source.state === 'unknown') {
    exactHealthSourceKeys(
      source,
      source.evidenceRevision === undefined ? [...base, 'reason'] : [...base, 'evidenceRevision', 'reason'],
      'unknown context-health aggregate source',
    );
    if (
      !checkedIsOneOf(
        [
          'citation-evidence-unavailable',
          'configured-teams-invalid',
          'evidence-incomplete',
          'snapshot-dirty',
          'snapshot-missing',
          'snapshot-raced',
          'snapshot-unreadable',
          'team-not-configured',
        ],
        source.reason,
      ) ||
      (source.evidenceRevision !== undefined && typeof source.evidenceRevision !== 'string')
    ) {
      throw new Error('Context-health unknown source is invalid.');
    }
    if (
      scope === 'team-selection' &&
      source.reason !== 'configured-teams-invalid' &&
      source.reason !== 'snapshot-unreadable'
    ) {
      throw new Error('Context-health team selection reason is invalid.');
    }
  } else {
    throw new Error('Context-health aggregate source state is invalid.');
  }
  if (source.state === 'complete') {
    if (scope === 'team-selection') throw new Error('Context-health team selection cannot contain a complete report.');
    if (typeof source.evidenceRevision !== 'string' || !isContextHealthReport(source.report)) {
      throw new Error('Context-health complete source report is invalid.');
    }
    if (scope === 'personal')
      return {scope, state: 'complete', evidenceRevision: source.evidenceRevision, report: source.report};
    if (typeof source.team !== 'string') throw new Error('Context-health aggregate source scope is invalid.');
    return {
      scope,
      team: source.team,
      state: 'complete',
      evidenceRevision: source.evidenceRevision,
      report: source.report,
    };
  }
  const reason = source.reason;
  if (
    !checkedIsOneOf(
      [
        'citation-evidence-unavailable',
        'configured-teams-invalid',
        'evidence-incomplete',
        'snapshot-dirty',
        'snapshot-missing',
        'snapshot-raced',
        'snapshot-unreadable',
        'team-not-configured',
      ],
      reason,
    ) ||
    (source.evidenceRevision !== undefined && typeof source.evidenceRevision !== 'string')
  ) {
    throw new Error('Context-health unknown source is invalid.');
  }
  if (scope === 'team' && typeof source.team !== 'string')
    throw new Error('Context-health aggregate source scope is invalid.');
  if (scope === 'personal')
    return {
      scope,
      state: 'unknown',
      reason,
      ...(source.evidenceRevision === undefined ? {} : {evidenceRevision: source.evidenceRevision}),
    };
  if (scope === 'team' && typeof source.team === 'string')
    return {
      scope,
      team: source.team,
      state: 'unknown',
      reason,
      ...(source.evidenceRevision === undefined ? {} : {evidenceRevision: source.evidenceRevision}),
    };
  if (scope === 'team-selection')
    return {
      scope,
      state: 'unknown',
      reason,
      ...(source.evidenceRevision === undefined ? {} : {evidenceRevision: source.evidenceRevision}),
    };
  throw new Error('Context-health aggregate source scope is invalid.');
}

function parseHealthTeamAggregateSource(
  value: unknown,
):
  | Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team'}>
  | Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team-selection'}> {
  const source = object(value, 'context-health team aggregate source');
  return source.scope === 'team-selection'
    ? parseHealthAggregateSource(source, 'team-selection')
    : parseHealthAggregateSource(source, 'team');
}

function exactHealthSourceKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (EffectRecord.keys(value).length !== keys.length || !allowedKeys(value, keys)) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function verifyHealthReadOnlyAuthority(
  authority: Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'context-health-read-only'}>,
  schedule: ReturnType<typeof parseHealthScheduleCapture>,
  aggregate: ReturnType<typeof parseHealthAggregateCapture>,
): boolean {
  if (
    authority.schedule.networkActivityCount !== 0 ||
    authority.schedule.writeActivityCount !== 0 ||
    authority.aggregate.networkActivityCount !== 0 ||
    authority.aggregate.writeActivityCount !== 0
  ) {
    throw new Error('Context-health authority does not prove read-only, network-disabled execution.');
  }
  if (schedule.project !== aggregate.aggregate.project) {
    throw new Error('Context-health schedule and aggregate projects do not match.');
  }
  const selectedTeams = EffectArray.flatMap(aggregate.input.teams, source =>
    source.scope === 'team' ? [source.team] : [],
  ).sort(compareText);
  const selectionUnknown = EffectArray.some(aggregate.input.teams, source => source.scope === 'team-selection');
  if (
    schedule.teams.length > 0 &&
    (selectionUnknown || canonicalJson(schedule.teams) !== canonicalJson(selectedTeams))
  ) {
    throw new Error('Context-health schedule and aggregate team selections do not match.');
  }
  const snapshots = authority.aggregate.teamSnapshots;
  if (
    snapshots.length !== selectedTeams.length ||
    canonicalJson(EffectArray.map(snapshots, snapshot => snapshot.team)) !== canonicalJson(selectedTeams) ||
    EffectArray.some(
      snapshots,
      snapshot =>
        snapshot.preHead !== snapshot.postHead ||
        snapshot.preIndexDigest !== snapshot.postIndexDigest ||
        snapshot.preWorktreeDigest !== snapshot.postWorktreeDigest,
    )
  ) {
    throw new Error('Context-health authority does not prove stable selected-team snapshots.');
  }
  if (selectionUnknown) return false;
  if (selectedTeams.length === 0) {
    throw new Error('Context-health no-team schedule must retain configured team sources.');
  }
  return true;
}

function boundedArgv(value: unknown, label: string): readonly string[] {
  if (!EffectArray.isArray(value) || value.length < 1 || value.length > 128) throw new Error(`${label} is invalid.`);
  return EffectArray.map(value, item => text(item, label, 512));
}

function parseHealthReportCapture(value: unknown): ContextHealthReportV1 {
  const capture = exactObject(value, ['input', 'report'], 'context-health report capture');
  const input = healthInput(capture.input);
  const rebuilt = buildContextHealthReport(input);
  if (canonicalJson(rebuilt) !== canonicalJson(capture.report)) {
    throw new Error('Context-health report does not match its source inputs.');
  }
  contextHealthReportRevisionV1(rebuilt);
  return rebuilt;
}

function parseHealthRepairCapture(value: unknown): {readonly proposalId: string; readonly resolved: boolean} {
  const capture = exactObject(
    value,
    ['input', 'plan', 'proposal', 'receipt', 'report'],
    'context-health repair capture',
  );
  const input = healthInput(capture.input);
  const report = buildContextHealthReport(input);
  if (canonicalJson(report) !== canonicalJson(capture.report)) {
    throw new Error('Context-health repair report does not match its source inputs.');
  }
  const plan = previewContextHealthRepairPlanV1(report, input.records);
  if (canonicalJson(plan) !== canonicalJson(capture.plan)) throw new Error('Context-health repair plan changed.');
  const proposal = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      plan.proposals,
      item => item.proposalId === object(capture.proposal, 'context-health proposal').proposalId,
    ),
  );
  if (proposal === undefined || contextHealthRepairProposalRevisionV1(proposal) !== proposal.revision) {
    throw new Error('Context-health repair proposal is not part of the current plan.');
  }
  if (canonicalJson(proposal) !== canonicalJson(capture.proposal)) {
    throw new Error('Context-health repair proposal differs from the current plan.');
  }
  const applied = applyContextHealthRepairProposalV1({
    expectedRevision: proposal.revision,
    proposal,
    records: input.records,
  });
  if (applied.status !== 'applied' || canonicalJson(applied.receipt) !== canonicalJson(capture.receipt)) {
    throw new Error('Context-health repair receipt cannot be reproduced.');
  }
  const postReport = buildContextHealthReport({...input, records: applied.records});
  return {
    proposalId: proposal.proposalId,
    resolved: !EffectArray.some(postReport.findings, finding => finding.id === proposal.findingId),
  };
}

function healthInput(value: unknown): ContextHealthReportInputV1 {
  const source = object(value, 'context-health input');
  const now = source.now instanceof Date ? source.now : new Date(String(source.now));
  if (!checkedIsFiniteNumber(now.getTime())) throw new Error('Context-health input is invalid.');
  const records = parseMemoryRecords(source.records);
  const duplicateCorpus = source.duplicateCorpus === undefined ? undefined : parseMemoryRecords(source.duplicateCorpus);
  const input = {...source, now, records, ...(duplicateCorpus === undefined ? {} : {duplicateCorpus})};
  if (!isContextHealthReportInput(input)) throw new Error('Context-health input has invalid fields.');
  return input;
}

function isContextHealthReportInput(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ContextHealthReportInputV1 {
  if (
    typeof value.project !== 'string' ||
    !EffectArray.isArray(value.records) ||
    !EffectArray.every(value.records, isMemoryRecord) ||
    !(value.now instanceof Date) ||
    !checkedIsFiniteNumber(value.now.getTime())
  )
    return false;
  if (value.after !== undefined && typeof value.after !== 'string') return false;
  if (value.candidateEvidence !== undefined && !isCandidateEvidenceArray(value.candidateEvidence)) return false;
  if (value.guidanceEvidence !== undefined && !isGuidanceEvidenceArray(value.guidanceEvidence)) return false;
  if (value.citationValidations !== undefined && !isCitationValidationArray(value.citationValidations)) return false;
  if (value.citationCoverage !== undefined && !isCitationCoverage(value.citationCoverage)) return false;
  if (value.includeCitationCoverageFindings !== undefined && typeof value.includeCitationCoverageFindings !== 'boolean')
    return false;
  if (
    value.duplicateCorpus !== undefined &&
    (!EffectArray.isArray(value.duplicateCorpus) || !EffectArray.every(value.duplicateCorpus, isMemoryRecord))
  )
    return false;
  if (value.includeFindingCategories !== undefined && !isFindingCategoryArray(value.includeFindingCategories))
    return false;
  if (
    value.includeFindingCombination !== undefined &&
    value.includeFindingCombination !== 'all' &&
    value.includeFindingCombination !== 'any'
  )
    return false;
  if (value.includeFindingUris !== undefined && !isStringArray(value.includeFindingUris)) return false;
  if (value.limit !== undefined && !checkedIsFiniteNumber(value.limit)) return false;
  if (value.relationEvidence !== undefined && !isRelationEvidenceArray(value.relationEvidence)) return false;
  if (value.reviewedSemanticContradictionIds !== undefined && !isStringArray(value.reviewedSemanticContradictionIds))
    return false;
  return true;
}

function parseMemoryRecords(value: unknown): readonly MemoryRecord[] {
  if (!EffectArray.isArray(value)) throw new Error('Context-health memory records are invalid.');
  return EffectArray.map(value, item => {
    if (!isMemoryRecord(item)) throw new Error('Context-health memory record does not match its canonical document.');
    return item;
  });
}
function canonicalMemoryRecordJson(record: MemoryRecord): string {
  const serialized = JSON.stringify(record);
  if (serialized === undefined) throw new Error('Context-health memory record cannot be serialized.');
  // The stored-record boundary is JSON. This removes parser-produced optional `undefined` fields exactly as the
  // wire encoder does, while canonicalJson still rejects any non-JSON properties supplied by the source.
  return canonicalJson(JSON.parse(serialized));
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (
    !Predicate.isObject(value) ||
    EffectArray.isArray(value) ||
    !('uri' in value) ||
    !('content' in value) ||
    typeof value.uri !== 'string' ||
    typeof value.content !== 'string'
  )
    return false;
  const parsed = parseMemoryDocument(value.uri, value.content);
  return parsed !== undefined && canonicalMemoryRecordJson(parsed) === canonicalJson(value);
}
function isStringArray(value: unknown): value is readonly string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, item => typeof item === 'string');
}
function isCandidateEvidenceArray(value: unknown): value is readonly ContextHealthCandidateEvidenceV1[] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(value, item => {
      if (!Predicate.isObject(item) || EffectArray.isArray(item)) return false;
      return (
        'candidateId' in item &&
        typeof item.candidateId === 'string' &&
        'comparison' in item &&
        checkedIsOneOf(['contradiction', 'duplicate', 'new', 'possible_duplicate', 'replacement'], item.comparison) &&
        'project' in item &&
        typeof item.project === 'string' &&
        (!('targetUri' in item) || item.targetUri === undefined || typeof item.targetUri === 'string')
      );
    })
  );
}
function isGuidanceEvidenceArray(value: unknown): value is readonly ContextHealthGuidanceEvidenceV1[] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(
      value,
      item =>
        Predicate.isObject(item) &&
        !EffectArray.isArray(item) &&
        'state' in item &&
        checkedIsOneOf(['locally-modified', 'missing-block', 'stale-sources', 'unavailable'], item.state) &&
        'sourceUris' in item &&
        isStringArray(item.sourceUris),
    )
  );
}
function isRelationEvidenceArray(value: unknown): value is readonly ContextHealthRelationEvidenceV1[] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(
      value,
      item =>
        Predicate.isObject(item) &&
        !EffectArray.isArray(item) &&
        'sourceUri' in item &&
        typeof item.sourceUri === 'string' &&
        'targetUri' in item &&
        typeof item.targetUri === 'string' &&
        'status' in item &&
        checkedIsOneOf(['active', 'conflicted', 'inactive', 'missing'], item.status),
    )
  );
}
function isFindingCategoryArray(value: unknown): value is readonly ContextHealthFindingCategoryV1[] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(value, item =>
      checkedIsOneOf(
        [
          'candidate-contradiction',
          'candidate-possible-duplicate',
          'citation-changed',
          'citation-missing',
          'citation-unknown',
          'exact-duplicate',
          'guidance-locally-modified',
          'guidance-missing-block',
          'guidance-stale-sources',
          'guidance-unavailable',
          'relation-target-conflicted',
          'relation-target-inactive',
          'relation-target-missing',
          'review-overdue',
          'semantic-contradiction',
          'validity-expired',
        ],
        item,
      ),
    )
  );
}
function isCitationValidationArray(value: unknown): value is readonly ContextBriefMemoryCitationValidationV2[] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(value, item => {
      if (
        !Predicate.isObject(item) ||
        EffectArray.isArray(item) ||
        !('uri' in item) ||
        typeof item.uri !== 'string' ||
        !('receipts' in item) ||
        !EffectArray.isArray(item.receipts)
      )
        return false;
      if ('cacheHits' in item && item.cacheHits !== undefined && !checkedIsFiniteNumber(item.cacheHits)) return false;
      return EffectArray.every(item.receipts, isCitationValidationReceipt);
    })
  );
}
function isCitationValidationReceipt(value: unknown): boolean {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  const requiredStrings = ['citationId', 'observedAt'];
  if (!EffectArray.every(requiredStrings, key => key in value && typeof value[key] === 'string')) return false;
  if (
    !('candidateCount' in value) ||
    !checkedIsFiniteNumber(value.candidateCount) ||
    !('coverage' in value) ||
    !checkedIsOneOf(['current-complete', 'incomplete'], value.coverage) ||
    !('kind' in value) ||
    !checkedIsOneOf(['file', 'symbol', 'malformed'], value.kind) ||
    !('reason' in value) ||
    !checkedIsOneOf(
      [
        'ambiguous-relocation',
        'citation-limit',
        'exact',
        'extractor-mismatch',
        'graph-incomplete',
        'graph-stale',
        'malformed-citation',
        'relocated',
        'repository-ambiguous',
        'repository-unavailable',
        'source-changed',
        'source-deleted',
        'validation-error',
      ],
      value.reason,
    ) ||
    !('status' in value) ||
    !checkedIsOneOf(['exact', 'relocated', 'changed', 'deleted', 'unknown'], value.status) ||
    !('strategy' in value) ||
    !checkedIsOneOf(['content-hash', 'file-path', 'node-id', 'none', 'semantic-locator'], value.strategy) ||
    !('validatorVersion' in value) ||
    value.validatorVersion !== 1
  )
    return false;
  for (const key of [
    'observedNodeId',
    'observedPath',
    'repositoryId',
    'snapshotCommit',
    'snapshotCompletedAt',
    'snapshotId',
    'sourcePath',
  ])
    if (key in value && value[key] !== undefined && typeof value[key] !== 'string') return false;
  if (
    'provenance' in value &&
    value.provenance !== undefined &&
    !checkedIsOneOf(['current-verified', 'historical-verified', 'unverified'], value.provenance)
  )
    return false;
  if (
    'repositoryRouteUnavailable' in value &&
    value.repositoryRouteUnavailable !== undefined &&
    value.repositoryRouteUnavailable !== true
  )
    return false;
  if ('observedLocator' in value && value.observedLocator !== undefined && !isObservedLocator(value.observedLocator))
    return false;
  if ('observedSpan' in value && value.observedSpan !== undefined && !isCodeGraphSpan(value.observedSpan)) return false;
  if ('recovery' in value && value.recovery !== undefined && !isCitationRecovery(value.recovery)) return false;
  return true;
}
function isObservedLocator(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    !EffectArray.isArray(value) &&
    EffectArray.every(
      ['kind', 'language', 'name', 'qualifiedName'],
      key => key in value && typeof value[key] === 'string',
    )
  );
}
function isCodeGraphSpan(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    !EffectArray.isArray(value) &&
    EffectArray.every(
      ['column', 'endColumn', 'endLine', 'line'],
      key => key in value && checkedIsFiniteNumber(value[key]),
    )
  );
}
function isCitationRecovery(value: unknown): boolean {
  if (
    !Predicate.isObject(value) ||
    EffectArray.isArray(value) ||
    !('callerCwd' in value) ||
    typeof value.callerCwd !== 'string' ||
    !('repositoryId' in value) ||
    typeof value.repositoryId !== 'string'
  )
    return false;
  if (!('aliasProof' in value) || value.aliasProof === undefined) return true;
  const proof = value.aliasProof;
  return (
    Predicate.isObject(proof) &&
    !EffectArray.isArray(proof) &&
    EffectArray.every(
      [
        'checkoutId',
        'evidenceRevision',
        'sourceCommit',
        'sourceRepositoryId',
        'sourceWorktreeId',
        'targetRepositoryId',
      ],
      key => key in proof && typeof proof[key] === 'string',
    ) &&
    'version' in proof &&
    proof.version === 1
  );
}
function isCitationCoverage(value: unknown): value is ContextHealthCitationCoverageV2 {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  for (const key of ['eligible', 'checked', 'deferred', 'currentVerified', 'historicalVerified', 'unverified'])
    if (!(key in value) || !checkedIsFiniteNumber(value[key])) return false;
  if ('pending' in value && value.pending !== undefined && !checkedIsFiniteNumber(value.pending)) return false;
  if ('unavailable' in value && value.unavailable !== undefined && !checkedIsFiniteNumber(value.unavailable))
    return false;
  return (
    'state' in value &&
    checkedIsOneOf(['complete', 'partial', 'unavailable'], value.state) &&
    'reasons' in value &&
    EffectArray.isArray(value.reasons) &&
    EffectArray.every(
      value.reasons,
      item =>
        Predicate.isObject(item) &&
        !EffectArray.isArray(item) &&
        'reason' in item &&
        typeof item.reason === 'string' &&
        'count' in item &&
        checkedIsFiniteNumber(item.count),
    )
  );
}

function isContextHealthReport(value: unknown): value is ContextHealthReportV1 {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('project' in value) ||
    typeof value.project !== 'string' ||
    !('limit' in value) ||
    !checkedIsFiniteNumber(value.limit) ||
    !('omittedFindings' in value) ||
    !checkedIsFiniteNumber(value.omittedFindings) ||
    !('recordsScanned' in value) ||
    !checkedIsFiniteNumber(value.recordsScanned) ||
    !('findings' in value) ||
    !EffectArray.isArray(value.findings) ||
    !EffectArray.every(value.findings, isHealthFinding) ||
    !('semanticCompleteness' in value) ||
    !isSemanticCompleteness(value.semanticCompleteness) ||
    !('status' in value) ||
    !checkedIsOneOf(['clean', 'findings', 'unknown'], value.status)
  )
    return false;
  if ('maintenance' in value && value.maintenance !== undefined && !isHealthMaintenance(value.maintenance))
    return false;
  if ('nextCursor' in value && value.nextCursor !== undefined && typeof value.nextCursor !== 'string') return false;
  if (
    'remainingFindings' in value &&
    value.remainingFindings !== undefined &&
    !checkedIsFiniteNumber(value.remainingFindings)
  )
    return false;
  return true;
}
function isHealthFinding(value: unknown): boolean {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  if (
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('summary' in value) ||
    typeof value.summary !== 'string' ||
    !('uris' in value) ||
    !isStringArray(value.uris) ||
    !('category' in value) ||
    !checkedIsOneOf(
      [
        'candidate-contradiction',
        'candidate-possible-duplicate',
        'citation-changed',
        'citation-missing',
        'citation-unknown',
        'exact-duplicate',
        'guidance-locally-modified',
        'guidance-missing-block',
        'guidance-stale-sources',
        'guidance-unavailable',
        'relation-target-conflicted',
        'relation-target-inactive',
        'relation-target-missing',
        'review-overdue',
        'semantic-contradiction',
        'validity-expired',
      ],
      value.category,
    ) ||
    !('confidence' in value) ||
    !checkedIsOneOf(['high', 'low', 'medium'], value.confidence) ||
    !('repairability' in value) ||
    !checkedIsOneOf(['manual-review', 'requires-evidence', 'reviewable'], value.repairability) ||
    !('severity' in value) ||
    !checkedIsOneOf(['critical', 'high', 'low', 'medium'], value.severity) ||
    !('repair' in value) ||
    !isRepairDescriptor(value.repair)
  )
    return false;
  if ('caseId' in value && value.caseId !== undefined && typeof value.caseId !== 'string') return false;
  if (
    'classification' in value &&
    value.classification !== undefined &&
    !checkedIsOneOf(['actionable', 'automatically-managed', 'coverage', 'historical'], value.classification)
  )
    return false;
  if ('caseIdentity' in value && value.caseIdentity !== undefined && !isCaseIdentity(value.caseIdentity)) return false;
  if (
    'semanticEvidence' in value &&
    value.semanticEvidence !== undefined &&
    !isSemanticContradiction(value.semanticEvidence)
  )
    return false;
  return true;
}
function isRepairDescriptor(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    !EffectArray.isArray(value) &&
    'kind' in value &&
    checkedIsOneOf(
      [
        'archive-memory',
        'deduplicate-memory',
        'repair-guidance',
        'repair-citation',
        'repair-relation',
        'review-candidate',
        'review-memory',
      ],
      value.kind,
    ) &&
    'summary' in value &&
    typeof value.summary === 'string' &&
    (!('subjectUri' in value) || value.subjectUri === undefined || typeof value.subjectUri === 'string') &&
    (!('targetUri' in value) || value.targetUri === undefined || typeof value.targetUri === 'string')
  );
}
function isCaseIdentity(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    !EffectArray.isArray(value) &&
    EffectArray.every(['project', 'memoryId', 'family', 'slot'], key => key in value && typeof value[key] === 'string')
  );
}
function isSemanticCompleteness(value: unknown): boolean {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  const counts = [
    'analyzedRecords',
    'claimsAnalyzed',
    'supportedClaims',
    'unsupportedClaims',
    'contradictionCount',
    'eligibleRecords',
    'omittedContradictions',
    'pairsCompared',
    'unknownRecords',
  ];
  return (
    EffectArray.every(counts, key => key in value && checkedIsFiniteNumber(value[key])) &&
    'coverage' in value &&
    value.coverage === 'bounded-English-extraction' &&
    'state' in value &&
    checkedIsOneOf(['complete', 'partial', 'unavailable'], value.state) &&
    'unknownReasons' in value &&
    EffectArray.isArray(value.unknownReasons) &&
    EffectArray.every(
      value.unknownReasons,
      item =>
        Predicate.isObject(item) &&
        !EffectArray.isArray(item) &&
        'count' in item &&
        checkedIsFiniteNumber(item.count) &&
        'reason' in item &&
        checkedIsOneOf(
          [
            'body-limit',
            'claim-budget',
            'claim-limit',
            'claim-too-large',
            'contradiction-limit',
            'no-claims',
            'record-limit',
            'unsupported-extraction',
          ],
          item.reason,
        ),
    ) &&
    'version' in value &&
    value.version === 2
  );
}
function isHealthMaintenance(value: unknown): boolean {
  return (
    Predicate.isObject(value) &&
    !EffectArray.isArray(value) &&
    'version' in value &&
    value.version === 2 &&
    EffectArray.every(
      ['actionableFindings', 'automaticallyManagedFindings', 'historicalFindings', 'affectedMemories'],
      key => key in value && checkedIsFiniteNumber(value[key]),
    ) &&
    'citationCoverage' in value &&
    isCitationCoverage(value.citationCoverage) &&
    'semanticCoverage' in value &&
    isSemanticCompleteness(value.semanticCoverage)
  );
}
function isSemanticContradiction(value: unknown): boolean {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  return (
    EffectArray.every(['basisFingerprint', 'contradictionId'], key => key in value && typeof value[key] === 'string') &&
    'similarityMilli' in value &&
    checkedIsFiniteNumber(value.similarityMilli) &&
    'classification' in value &&
    checkedIsOneOf(['incompatibility', 'uncertain-comparison'], value.classification) &&
    'reason' in value &&
    checkedIsOneOf(
      ['incompatible-values', 'opposite-polarity', 'policy-conflict', 'unsupported-interpretation'],
      value.reason,
    ) &&
    'uncertainty' in value &&
    isStringArray(value.uncertainty) &&
    'left' in value &&
    isSemanticClaim(value.left) &&
    'right' in value &&
    isSemanticClaim(value.right)
  );
}
function isSemanticClaim(value: unknown): boolean {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  if (
    !EffectArray.every(
      ['claimFingerprint', 'claimId', 'recordUri', 'recordContentFingerprint', 'text'],
      key => key in value && typeof value[key] === 'string',
    ) ||
    !('role' in value) ||
    !checkedIsOneOf(['descriptive', 'normative', 'historical'], value.role) ||
    !('extraction' in value) ||
    !checkedIsOneOf(['numeric-constraint', 'finite-set', 'explicit-polarity', 'unsupported'], value.extraction)
  )
    return false;
  if ('subject' in value && value.subject !== undefined && typeof value.subject !== 'string') return false;
  if ('property' in value && value.property !== undefined && typeof value.property !== 'string') return false;
  if (
    !('span' in value) ||
    !Predicate.isObject(value.span) ||
    !('start' in value.span) ||
    !checkedIsFiniteNumber(value.span.start) ||
    !('end' in value.span) ||
    !checkedIsFiniteNumber(value.span.end) ||
    !('context' in value) ||
    !isSemanticContext(value.context)
  )
    return false;
  if ('constraint' in value && value.constraint !== undefined && !isSemanticConstraint(value.constraint)) return false;
  return true;
}
function isSemanticContext(value: unknown): boolean {
  if (
    !Predicate.isObject(value) ||
    EffectArray.isArray(value) ||
    !('headings' in value) ||
    !isStringArray(value.headings) ||
    !('headingEvidence' in value) ||
    !EffectArray.isArray(value.headingEvidence)
  )
    return false;
  if (
    !EffectArray.every(
      value.headingEvidence,
      item =>
        Predicate.isObject(item) &&
        'text' in item &&
        typeof item.text === 'string' &&
        'span' in item &&
        Predicate.isObject(item.span) &&
        'start' in item.span &&
        checkedIsFiniteNumber(item.span.start) &&
        'end' in item.span &&
        checkedIsFiniteNumber(item.span.end),
    )
  )
    return false;
  return EffectArray.every(
    ['project', 'workspaceScope', 'environment', 'validFrom', 'validTo'],
    key => !(key in value) || value[key] === undefined || typeof value[key] === 'string',
  );
}
function isSemanticConstraint(value: unknown): boolean {
  if (!Predicate.isObject(value) || EffectArray.isArray(value) || !('kind' in value)) return false;
  if (value.kind === 'numeric')
    return (
      'dimension' in value &&
      typeof value.dimension === 'string' &&
      'lower' in value &&
      (value.lower === null || checkedIsFiniteNumber(value.lower)) &&
      'upper' in value &&
      (value.upper === null || checkedIsFiniteNumber(value.upper)) &&
      'lowerInclusive' in value &&
      typeof value.lowerInclusive === 'boolean' &&
      'upperInclusive' in value &&
      typeof value.upperInclusive === 'boolean'
    );
  if (value.kind === 'set') return 'values' in value && isStringArray(value.values);
  return value.kind === 'polarity' && 'denied' in value && typeof value.denied === 'boolean';
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const source = object(value, label);
  if (canonicalJson(EffectRecord.keys(source).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  return source;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return EffectArray.every(EffectRecord.keys(value), key => set.has(key));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!EffectArray.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} entries.`);
  }
  return value;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || Effect.pipe(value, EffectString.trim).length === 0 || value.length > maximum) {
    throw new Error(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
