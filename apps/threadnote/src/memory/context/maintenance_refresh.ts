import {readState, writeState, withStateLock, readContextMaintenancePacket} from './maintenance.js';
import {DateTime, Effect, Result} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
import type {MemoryRecord} from '@threadnote/memory/document';
import {buildContextHealthReport, type ContextHealthReportV1} from '@threadnote/context/health';
import {findContextHealthSemanticContradiction} from '@threadnote/context/health_semantic';
import {
  contextHealthCitationCaseSlotV2,
  contextHealthCaseIdV2,
  contextHealthFindingCaseIdentityV2,
} from '@threadnote/context/health_maintenance';
import {validateContextHealthMemoryCitations} from '@threadnote/context/citation_validation';
import {readMemoryRecordsByUriWithSourceHash} from '../../mcp/server/memory.js';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {ContextBriefMemoryCitationValidationV2} from '@threadnote/context/types';
import type {ContextMaintenanceCaseV2, MaintenanceState} from './maintenance_contracts.js';
import {maintenanceContentHash} from './maintenance_policy.js';
import {readContextMaintenanceSourceEpoch} from './maintenance_evidence.js';
import {recordSourceRevision} from './maintenance_source.js';
import {observeTopicMaintenanceCase} from './maintenance_topic.js';

/** Observe only the selected subjects. Refreshing never repairs canonical documents. */
export const observeSelectedMaintenanceCase = Effect.fn('contextMaintenance.observeSelected')(function* (
  config: RuntimeConfig,
  state: MaintenanceState,
  item: ContextMaintenanceCaseV2,
  fallbackCwd: string,
) {
  const uris = [
    ...new Set([
      ...(item.subjectContentHashes ?? []).map(source => source.uri),
      ...(item.subjectUri ? [item.subjectUri] : []),
    ]),
  ];
  if (uris.length === 0 || uris.length > 32)
    return {outcome: 'unavailable' as const, reason: 'The selected memory reference is unavailable.'};
  const subjects = yield* readMemoryRecordsByUriWithSourceHash(config, uris);
  const records = subjects.map(subject => subject.record);
  const close = <A>(result: A) =>
    readMemoryRecordsByUriWithSourceHash(config, uris).pipe(
      Effect.map(after =>
        subjects.length === after.length &&
        subjects.every(subject =>
          after.some(current => current.record.uri === subject.record.uri && current.sourceHash === subject.sourceHash),
        )
          ? result
          : {
              outcome: 'changing' as const,
              reason: 'The selected memory changed during the check. Check again when the edit is saved.',
            },
      ),
    );
  if (
    records.length !== uris.length ||
    records.some(record => record.metadata.status !== 'active' || record.metadata.project !== item.project)
  )
    return {outcome: 'unavailable' as const, reason: 'A selected memory is no longer available in this project.'};
  const record =
    records.find(record => (record.metadata.memoryId ?? record.uri) === item.memoryId) ??
    (item.family === 'semantic-contradiction' ? records[0] : undefined);
  if (!record)
    return {
      outcome: 'unavailable' as const,
      reason: 'The selected memory identity changed. Review its current references before making a decision.',
    };
  const root = item.sourceSnapshot?.cwd ?? fallbackCwd;
  const now = DateTime.formatIso(yield* DateTime.now);
  let next: ContextMaintenanceCaseV2 = item;
  let reference: {path: string; citationId: string; status: string} | undefined;
  let repairFinding: ContextHealthReportV1['findings'][number] | undefined;
  let topicCheckpoints = state.topicCheckpoints;
  if (item.family === 'semantic-contradiction') {
    const evidence = findContextHealthSemanticContradiction(
      records,
      undefined,
      item.slot.split(':') as [string, string],
    );
    if (!evidence) {
      const comparisons = buildContextHealthReport({
        project: item.project,
        records,
        duplicateCorpus: records,
        now: yield* DateTime.nowAsDate,
      }).findings.filter(finding => finding.semanticEvidence);
      if (comparisons.length !== 1)
        return yield* close(
          superseded(
            state,
            item,
            comparisons.length === 0
              ? 'These statements no longer conflict. No memory content was changed.'
              : 'The updated memories contain several comparisons. Review their current statements before choosing a new decision.',
          ),
        );
      const identity = contextHealthFindingCaseIdentityV2({project: item.project, finding: comparisons[0], records});
      next = {
        ...item,
        ...identity,
        caseId: contextHealthCaseIdV2(identity),
        reason: 'opposing-canonical-claims',
        disposition: 'needs-decision',
        firstSeen: now,
        lastSeen: now,
        lastChecked: now,
      };
    }
    next = {
      ...next,
      subjectContentHashes: records.map(source => ({uri: source.uri, hash: maintenanceContentHash(source.content)})),
    };
  } else if (item.family === 'topic-maintenance') {
    const observed = yield* observeTopicMaintenanceCase(
      config,
      record,
      maintenanceContentHash(record.content),
      root,
      now,
      state.topicCheckpoints ?? {},
      new Map(state.cases.map(value => [value.caseId, value])),
    );
    if (!observed)
      return {
        outcome: 'changing' as const,
        reason: 'The selected source is still changing. Check again when the edit is saved.',
      };
    next = observed.item;
    topicCheckpoints = {...state.topicCheckpoints, [item.caseId]: observed.checkpoint};
  } else if (item.family === 'citation' || item.family === 'citation-coverage') {
    const citations = selectedMaintenanceCitations(record, item);
    if (citations.length === 0)
      return yield* close(
        superseded(
          state,
          item,
          'This saved code reference was removed or replaced. Review the memory’s current references.',
        ),
      );
    const epoch = yield* readContextMaintenanceSourceEpoch(config, root);
    const revision = yield* recordSourceRevision(config, record, root);
    const validations = yield* validateContextHealthMemoryCitations(
      config,
      {kind: 'repository', callerCwd: root, project: item.project},
      [{uri: record.uri, codeCitations: citations}],
      {fullScan: false},
    );
    const selectedCitation =
      item.family === 'citation-coverage'
        ? (citations.find(citation => !maintenanceCoverageCurrent(record.uri, [citation], validations)) ?? citations[0])
        : citations[0];
    const receipt = validations
      .filter(validation => validation.uri === record.uri)
      .flatMap(validation => validation.receipts)
      .find(value => value.citationId === selectedCitation.id);
    const report = buildContextHealthReport({
      project: item.project,
      records: [{...record, metadata: {...record.metadata, codeCitations: citations}}],
      duplicateCorpus: [record],
      citationValidations: validations,
      now: yield* DateTime.nowAsDate,
    });
    const finding = report.findings.find(value => value.category.startsWith('citation-'));
    reference = {path: selectedCitation.path, citationId: selectedCitation.id, status: receipt?.status ?? 'unknown'};
    repairFinding = finding;
    next = {
      ...item,
      evidenceRevision: revision,
      subjectContentHashes: [{uri: record.uri, hash: maintenanceContentHash(record.content)}],
      sourceSnapshot: {cwd: root, generation: epoch, revision},
      lastChecked: now,
      disposition:
        item.family === 'citation-coverage'
          ? maintenanceCoverageCurrent(record.uri, citations, validations)
            ? 'resolved'
            : 'waiting-evidence'
          : receipt?.status === 'exact' || receipt?.status === 'relocated'
            ? 'resolved'
            : receipt?.status === 'unknown' || !receipt
              ? 'waiting-evidence'
              : 'needs-decision',
      reason:
        item.family === 'citation-coverage' && !maintenanceCoverageCurrent(record.uri, citations, validations)
          ? 'citation-evidence-incomplete'
          : (receipt?.reason ?? finding?.category ?? 'citation-evidence-unavailable'),
      ...(receipt
        ? {anchorEvidence: {status: receipt.status, coverage: receipt.coverage, provenance: receipt.provenance}}
        : {}),
    };
    if (
      (yield* readContextMaintenanceSourceEpoch(config, root)) !== epoch ||
      (yield* recordSourceRevision(config, record, root)) !== revision
    )
      return {
        outcome: 'changing' as const,
        reason: 'The selected source is still changing. Check again when the edit is saved.',
      };
  } else
    return {
      outcome: 'unavailable' as const,
      reason: 'This check does not support a source refresh. Open the selected memory to review this reference.',
    };
  if (
    next.evidenceRevision === item.evidenceRevision &&
    next.disposition === item.disposition &&
    next.reason === item.reason &&
    JSON.stringify(next.subjectContentHashes) === JSON.stringify(item.subjectContentHashes) &&
    JSON.stringify(next.sourceSnapshot) === JSON.stringify(item.sourceSnapshot) &&
    JSON.stringify(next.anchorEvidence) === JSON.stringify(item.anchorEvidence)
  ) {
    next = item;
    topicCheckpoints = state.topicCheckpoints;
  }
  return yield* close({
    outcome: 'observed' as const,
    records,
    item: next,
    reference,
    repairFinding,
    state: {
      ...state,
      topicCheckpoints,
      cases:
        next.caseId === item.caseId
          ? state.cases.map(value => (value.caseId === item.caseId ? next : value))
          : [
              ...state.cases
                .map(value =>
                  value.caseId === item.caseId
                    ? {...value, disposition: 'historical' as const, reason: 'selected-statements-changed'}
                    : value,
                )
                .filter(value => value.caseId !== next.caseId),
              next,
            ],
    },
  });
});

export function selectedMaintenanceCitations(
  record: MemoryRecord,
  item: Pick<ContextMaintenanceCaseV2, 'family' | 'slot' | 'citationId'>,
): readonly MemoryCodeCitationV1[] {
  const current = currentMemoryCodeCitations(record);
  if (item.family === 'citation-coverage') {
    const chunk = Number(item.slot);
    return Number.isSafeInteger(chunk) && chunk >= 0 && String(chunk) === item.slot
      ? current.slice(chunk * 64, (chunk + 1) * 64)
      : [];
  }
  return current
    .filter(citation =>
      item.citationId ? citation.id === item.citationId : contextHealthCitationCaseSlotV2(citation) === item.slot,
    )
    .slice(0, 64);
}

export function maintenanceCoverageCurrent(
  uri: string,
  citations: readonly MemoryCodeCitationV1[],
  validations: readonly ContextBriefMemoryCitationValidationV2[],
): boolean {
  const receipts = validations.filter(validation => validation.uri === uri).flatMap(validation => validation.receipts);
  return (
    citations.length > 0 &&
    citations.every(citation => {
      const matches = receipts.filter(receipt => receipt.citationId === citation.id);
      return (
        matches.length === 1 &&
        (matches[0].status === 'exact' || matches[0].status === 'relocated') &&
        matches[0].coverage === 'current-complete' &&
        (matches[0].provenance === undefined || matches[0].provenance === 'current-verified')
      );
    })
  );
}

function superseded(state: MaintenanceState, item: ContextMaintenanceCaseV2, reason: string) {
  const updated = {...item, disposition: 'historical' as const, reason: 'selected-reference-superseded'};
  return {
    outcome: 'superseded' as const,
    reason,
    item: updated,
    state: {...state, cases: state.cases.map(value => (value.caseId === item.caseId ? updated : value))},
  };
}

/** Refresh one selected observation, retrying a read race once. Canonical sources remain untouched. */
export const refreshContextMaintenanceCase = Effect.fn('contextMaintenance.refreshCase')(function* (
  config: RuntimeConfig,
  input: {readonly project: string; readonly caseId: string; readonly cwd: string},
  selection: Parameters<typeof readContextMaintenancePacket>[2] = {},
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = yield* withStateLock(
      config,
      Effect.gen(function* () {
        const state = yield* readState(config);
        const item = state.cases.find(value => value.caseId === input.caseId && value.project === input.project);
        if (!item)
          return {outcome: 'unavailable' as const, reason: 'This decision is no longer available in this project.'};
        if (
          item.family === 'topic-maintenance' &&
          (selection.citationId !== undefined ||
            selection.startLine !== undefined ||
            selection.maximumLines !== undefined ||
            (selection.memoryUri !== undefined &&
              selection.memoryUri !==
                (item.subjectUri ??
                  (item.subjectContentHashes?.length === 1 ? item.subjectContentHashes[0].uri : undefined))))
        )
          return {outcome: 'unavailable' as const, reason: 'Select evidence from this exact topic memory.'};
        const result = yield* observeSelectedMaintenanceCase(config, state, item, input.cwd);
        if ('state' in result && result.state && JSON.stringify(result.state) !== JSON.stringify(state))
          yield* writeState(config, result.state);
        return result;
      }),
    );
    if (observed.outcome === 'changing') continue;
    if (observed.outcome !== 'observed') return observed;
    const packet = yield* readContextMaintenancePacket(
      config,
      observed.item.caseId,
      observed.item.family === 'topic-maintenance' ? {} : selection,
      observed.records,
    ).pipe(Effect.result);
    if (Result.isFailure(packet)) continue;
    return {
      outcome: observed.item.disposition === 'resolved' ? ('resolved' as const) : ('ready' as const),
      item: observed.item,
      packet: {...packet.success, reference: observed.reference, repairFinding: observed.repairFinding},
    };
  }
  return {
    outcome: 'changing' as const,
    reason: 'The selected source is still changing. Check again when the edit is saved.',
  };
});
