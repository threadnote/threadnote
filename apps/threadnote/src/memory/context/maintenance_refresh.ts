import {Array as EffectArray, Option as EffectOption} from 'effect';
import {
  readState,
  writeState,
  withStateLock,
  readContextMaintenancePacket,
  ContextMaintenanceError,
  contextMaintenanceStatePath,
} from './maintenance.js';
import {DateTime, Effect, FileSystem, Path, Result} from 'effect';
import {isFileLockTimeout} from '@threadnote/platform/file/lock';
import {ContextMaintenanceBusy} from './maintenance_contracts.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
import {isAgentArtifactUri, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {localMemoryPathForUri, localUserMemoriesRoot} from '@threadnote/memory/local-path';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {readBoundedContainedStableRegularFile} from '@threadnote/graph/inventory/contained_file';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {buildContextHealthReport, type ContextHealthReportV1} from '@threadnote/context/health';
import {findContextHealthSemanticContradiction} from '@threadnote/context/health_semantic';
import {
  contextHealthCitationCaseSlotV2,
  contextHealthCaseIdV2,
  contextHealthFindingCaseIdentityV2,
} from '@threadnote/context/health_maintenance';
import {validateContextHealthMemoryCitations} from '@threadnote/context/citation_validation';
import {readMemoryRecordsByUri, readMemoryRecordsByUriWithSourceHash} from '../../mcp/server/memory.js';
import {readMaintenanceMemoryRecords} from '../maintenance/records.js';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {ContextBriefMemoryCitationValidationV2} from '@threadnote/context/types';
import type {
  ContextMaintenanceCaseV2,
  ContextMaintenanceRelationEvidence,
  ContextMaintenanceRelationResourceObservation,
  MaintenanceState,
} from './maintenance_contracts.js';
import {maintenanceContentHash, resolveRelationTarget, resolveMaintenanceRelationPolicy} from './maintenance_policy.js';
import {collectContextMaintenanceCitationEvidence, readContextMaintenanceSourceEpoch} from './maintenance_evidence.js';
import {maintenanceRecordRevision, recordSourceRevision} from './maintenance_source.js';
import {observeTopicMaintenanceCase} from './maintenance_topic.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Only this invocation's state-lock acquisition is retryable; nested failures retain their original semantics. */
export function withMaintenanceOperationLock<A, E, R>(config: RuntimeConfig, effect: Effect.Effect<A, E, R>) {
  return Effect.suspend(() =>
    Effect.gen(function* () {
      const lockPath = `${yield* contextMaintenanceStatePath(config)}.lock`;
      let entered = false;
      return yield* withStateLock(
        config,
        Effect.gen(function* () {
          entered = true;
          return yield* effect;
        }),
      ).pipe(
        Effect.catchIf(
          error => !entered && isFileLockTimeout(error) && error.lockPath === lockPath,
          () => Effect.fail(ContextMaintenanceBusy.make({})),
        ),
      );
    }),
  );
}

/** Observe only the selected subjects. Refreshing never repairs canonical documents. */
export const observeSelectedMaintenanceCase = Effect.fn('contextMaintenance.observeSelected')(function* (
  config: RuntimeConfig,
  state: MaintenanceState,
  item: ContextMaintenanceCaseV2,
  fallbackCwd: string,
) {
  if (item.family === 'relation' || item.family === 'shared-owner-proposal')
    return yield* observeSelectedRelationMaintenanceCase(config, state, item, fallbackCwd);
  const uris = [
    ...new Set([
      ...EffectArray.map(item.subjectContentHashes ?? [], source => source.uri),
      ...(item.subjectUri ? [item.subjectUri] : []),
    ]),
  ];
  if (uris.length === 0 || uris.length > 32)
    return {outcome: 'unavailable' as const, reason: 'The selected memory reference is unavailable.'};
  const subjects = yield* readMemoryRecordsByUriWithSourceHash(config, uris);
  const records = EffectArray.map(subjects, subject => subject.record);
  const close = <A>(result: A) =>
    readMemoryRecordsByUriWithSourceHash(config, uris).pipe(
      Effect.map(after =>
        subjects.length === after.length &&
        EffectArray.every(subjects, subject =>
          EffectArray.some(
            after,
            current => current.record.uri === subject.record.uri && current.sourceHash === subject.sourceHash,
          ),
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
    EffectArray.some(records, record => record.metadata.status !== 'active' || record.metadata.project !== item.project)
  )
    return {outcome: 'unavailable' as const, reason: 'A selected memory is no longer available in this project.'};
  const record =
    EffectOption.getOrUndefined(
      EffectArray.findFirst(records, record => (record.metadata.memoryId ?? record.uri) === item.memoryId),
    ) ?? (item.family === 'semantic-contradiction' ? records[0] : undefined);
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
      Effect2.pipe(item.slot, EffectString.split(':')),
    );
    if (!evidence) {
      const report = buildContextHealthReport({
        project: item.project,
        records,
        duplicateCorpus: records,
        now: yield* DateTime.nowAsDate,
      });
      if (report.semanticCompleteness.state !== 'complete')
        return yield* close({
          outcome: 'incomplete' as const,
          reason:
            'The bounded comparison check could not review every statement. Your choice is saved; check current evidence after reviewing the source memories.',
        });
      const comparisons = EffectArray.filter(report.findings, finding => Boolean(finding.semanticEvidence));
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
      subjectContentHashes: EffectArray.map(records, source => ({
        uri: source.uri,
        hash: maintenanceContentHash(source.content),
      })),
    };
  } else if (item.family === 'topic-maintenance') {
    const observed = yield* observeTopicMaintenanceCase(
      config,
      record,
      maintenanceContentHash(record.content),
      root,
      now,
      state.topicCheckpoints ?? {},
      new Map(EffectArray.map(state.cases, value => [value.caseId, value])),
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
    const validations = yield* collectContextMaintenanceCitationEvidence(
      config,
      item.project,
      [{...record, metadata: {...record.metadata, codeCitations: currentMemoryCodeCitations(record)}}],
      [{uri: record.uri, codeCitations: citations}],
      root,
      {
        mode: 'diagnostic',
        validate: selected =>
          validateContextHealthMemoryCitations(
            config,
            {kind: 'repository', callerCwd: root, project: item.project},
            selected,
            {fullScan: false},
          ),
      },
    );
    const selectedCitation =
      item.family === 'citation-coverage'
        ? (EffectOption.getOrUndefined(
            EffectArray.findFirst(
              citations,
              citation => !maintenanceCoverageCurrent(record.uri, [citation], validations),
            ),
          ) ?? citations[0])
        : citations[0];
    const receipt = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(
          EffectArray.filter(
            validations,
            (validation: ContextBriefMemoryCitationValidationV2) => validation.uri === record.uri,
          ),
          (validation: ContextBriefMemoryCitationValidationV2) => validation.receipts,
        ),
        (value: ContextBriefMemoryCitationValidationV2['receipts'][number]) => value.citationId === selectedCitation.id,
      ),
    );
    const report = buildContextHealthReport({
      project: item.project,
      records: [{...record, metadata: {...record.metadata, codeCitations: citations}}],
      duplicateCorpus: [record],
      citationValidations: validations,
      now: yield* DateTime.nowAsDate,
    });
    const finding = EffectOption.getOrUndefined(
      EffectArray.findFirst(report.findings, value =>
        Effect2.pipe(value.category, EffectString.startsWith('citation-')),
      ),
    );
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
    JSON.stringify(next.relationEvidence) === JSON.stringify(item.relationEvidence) &&
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
          ? EffectArray.map(state.cases, value => (value.caseId === item.caseId ? next : value))
          : [
              ...EffectArray.filter(
                EffectArray.map(state.cases, value =>
                  value.caseId === item.caseId
                    ? {...value, disposition: 'historical' as const, reason: 'selected-statements-changed'}
                    : value,
                ),
                value => value.caseId !== next.caseId,
              ),
              next,
            ],
    },
  });
});

/** One logical observation; failures and aliases remain unknown, without scanning a corpus or inferring absence. */
export const readSelectedMaintenanceRelationResource = Effect.fn('contextMaintenance.readRelationResource')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const read = yield* Effect.gen(function* () {
    const file = yield* localMemoryPathForUri(config, uri);
    if (!file) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resourceRoot = yield* localUserMemoriesRoot(config);
    const root = yield* fs.realPath(resourceRoot);
    const bytes = yield* readBoundedContainedStableRegularFile(
      fs,
      path,
      root,
      EffectArray.join(Effect2.pipe(path.relative(resourceRoot, file), EffectString.split(path.sep)), '/'),
      8 * 1_024 * 1_024,
    );
    const content = yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
    const record = parseMemoryDocument(uri, content) ?? undefined;
    const observation: ContextMaintenanceRelationResourceObservation = {
      uri,
      sourceHash: sha256HexSync(bytes),
      ...(record?.metadata.memoryId === undefined ? {} : {memoryId: record.metadata.memoryId}),
      ...(record === undefined ? {} : {status: record.metadata.status}),
    };
    return {record, observation};
  }).pipe(Effect.result);
  return Result.isSuccess(read) && read.success !== undefined ? read.success : {record: undefined, observation: {uri}};
});

/** Packet callers separately check the subject using their existing subject read, avoiding duplicate observations. */
export const relationMaintenanceEvidenceCurrent = Effect.fn('contextMaintenance.relationEvidenceCurrent')(function* (
  config: RuntimeConfig,
  evidence: ContextMaintenanceRelationEvidence,
) {
  if (!validRelationMaintenanceEvidence(evidence)) return false;
  for (const expected of evidence.observations) {
    const current = yield* readSelectedMaintenanceRelationResource(config, expected.uri);
    if (JSON.stringify(current.observation) !== JSON.stringify(expected)) return false;
  }
  return true;
});

export function validRelationMaintenanceEvidence(input: unknown): input is ContextMaintenanceRelationEvidence {
  if (typeof input !== 'object' || input === null) return false;
  const evidence = input as Partial<ContextMaintenanceRelationEvidence>;
  const stamp = (value: unknown): value is ContextMaintenanceRelationResourceObservation => {
    if (typeof value !== 'object' || value === null) return false;
    const item = value as Partial<ContextMaintenanceRelationResourceObservation>;
    return (
      typeof item.uri === 'string' &&
      item.uri.length > 0 &&
      item.uri.length <= 4_096 &&
      (item.sourceHash === undefined ||
        (typeof item.sourceHash === 'string' && /^[a-f0-9]{64}$/u.test(item.sourceHash))) &&
      (item.memoryId === undefined || (typeof item.memoryId === 'string' && item.memoryId.length <= 256)) &&
      (item.status === undefined || (typeof item.status === 'string' && item.status.length <= 64))
    );
  };
  if (evidence.completeness !== 'selected-only' || evidence.provenance !== 'bounded-selected-resource-read')
    return false;
  const subject = evidence.subject;
  if (!stamp(subject)) return false;
  const observations = evidence.observations;
  const isValidObservations = (value: unknown): value is ReadonlyArray<ContextMaintenanceRelationResourceObservation> =>
    EffectArray.isArray(value) && EffectArray.every(value, stamp);
  if (!isValidObservations(observations) || observations.length >= 32) return false;
  return new Set([subject.uri, ...EffectArray.map(observations, item => item.uri)]).size === observations.length + 1;
}

/** Reuse one bounded read per identity for packet construction and each closing fence. */
export const readCurrentRelationMaintenanceRecords = Effect.fn('contextMaintenance.currentRelationRecords')(function* (
  config: RuntimeConfig,
  item: ContextMaintenanceCaseV2,
  latest?: ContextMaintenanceCaseV2,
) {
  const evidence = item.relationEvidence;
  if (
    !['relation', 'shared-owner-proposal'].includes(item.family) ||
    !validRelationMaintenanceEvidence(evidence) ||
    (latest && JSON.stringify(latest.relationEvidence) !== JSON.stringify(evidence))
  )
    return undefined;
  const expected = [evidence.subject, ...evidence.observations];
  const observed = yield* Effect.forEach(
    expected,
    observation => readSelectedMaintenanceRelationResource(config, observation.uri),
    {concurrency: 16},
  );
  return EffectArray.every(
    observed,
    (value, index) => JSON.stringify(value.observation) === JSON.stringify(expected[index]),
  )
    ? EffectArray.flatMap(observed, value => (value.record ? [value.record] : []))
    : undefined;
});

export const readPacketRecords = Effect.fn('contextMaintenance.packetRecords')(function* (
  config: RuntimeConfig,
  item: ContextMaintenanceCaseV2,
  selected?: readonly MemoryRecord[],
) {
  if (selected) return selected;
  if (item.relationEvidence) {
    const current = yield* readCurrentRelationMaintenanceRecords(config, item);
    if (!current)
      return yield* ContextMaintenanceError.make({
        message: 'The selected relation changed. Refresh this exact decision.',
      });
    return current;
  }
  return yield* readMaintenanceMemoryRecords(config, {requireReadable: true});
});

export const readPacketSubjects = Effect.fn('contextMaintenance.packetSubjects')(function* (
  config: RuntimeConfig,
  item: ContextMaintenanceCaseV2,
  latest: ContextMaintenanceCaseV2,
) {
  if (item.relationEvidence) {
    const current = yield* readCurrentRelationMaintenanceRecords(config, item, latest);
    if (!current)
      return yield* ContextMaintenanceError.make({
        message: 'The selected relation changed. Refresh this exact decision.',
      });
    return current;
  }
  return yield* readMemoryRecordsByUri(
    config,
    EffectArray.map(item.subjectContentHashes ?? [], subject => subject.uri),
  );
});

const observeSelectedRelationMaintenanceCase = Effect.fn('contextMaintenance.observeSelectedRelation')(function* (
  config: RuntimeConfig,
  state: MaintenanceState,
  item: ContextMaintenanceCaseV2,
  fallbackCwd: string,
) {
  const subjectUri = item.subjectUri ?? item.subjectContentHashes?.[0]?.uri;
  if (!subjectUri || (item.subjectContentHashes?.length ?? 0) > 1)
    return {outcome: 'unavailable' as const, reason: 'Select the exact canonical relation subject before refreshing.'};
  const subject = yield* readSelectedMaintenanceRelationResource(config, subjectUri);
  const record = subject.record;
  if (
    !record ||
    record.metadata.status !== 'active' ||
    record.metadata.project !== item.project ||
    (record.metadata.memoryId ?? record.uri) !== item.memoryId
  )
    return {
      outcome: 'unavailable' as const,
      reason: 'The selected relation subject is unreadable or its identity changed. Review the current memory first.',
    };
  const relations = EffectArray.filter(record.metadata.relations ?? [], relation => !isAgentArtifactUri(relation.uri));
  const exact = EffectArray.filter(
    relations,
    relation => relation.uri === item.slot || memoryIdFromIdentityAlias(relation.uri) === item.slot,
  );
  const selected = item.family === 'relation' && exact.length > 0 ? exact : relations;
  const identities = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(selected, relation => relation.uri),
        uri => uri !== subjectUri,
      ),
    ),
  ].sort();
  if (identities.length + 1 > 32)
    return {
      outcome: 'incomplete' as const,
      reason:
        'This selection exceeds 32 subject/target lookup identities. Review its exact references before retrying; no evidence or memory was changed.',
    };
  const targets = yield* Effect.forEach(identities, uri => readSelectedMaintenanceRelationResource(config, uri), {
    concurrency: 16,
  });
  const records = [record, ...EffectArray.flatMap(targets, target => (target.record ? [target.record] : []))];
  const matching = EffectArray.filter(
    selected,
    relation =>
      relation.uri === item.slot ||
      memoryIdFromIdentityAlias(relation.uri) === item.slot ||
      resolveRelationTarget(records, relation.uri).record?.metadata.memoryId === item.slot,
  );
  if (item.family === 'relation' && matching.length === 0)
    return {
      outcome: 'incomplete' as const,
      reason:
        'The saved relation target no longer resolves to this exact identity. Review the memory’s current references before retrying.',
    };
  const evidence: ContextMaintenanceRelationEvidence = {
    completeness: 'selected-only',
    provenance: 'bounded-selected-resource-read',
    subject: subject.observation,
    observations: EffectArray.map(targets, target => target.observation),
  };
  const root = item.sourceSnapshot?.cwd ?? fallbackCwd;
  const epoch = item.sourceSnapshot ? yield* readContextMaintenanceSourceEpoch(config, root) : undefined;
  const sourceRevision = item.sourceSnapshot ? yield* recordSourceRevision(config, record, root) : undefined;
  const policies = EffectArray.map(item.family === 'relation' ? matching : selected, relation =>
    resolveMaintenanceRelationPolicy(record, relation, records, false),
  );
  const unknown = EffectArray.some(policies, policy => policy.state === 'unknown' || policy.state === 'ambiguous');
  const now = DateTime.formatIso(yield* DateTime.now);
  let next: ContextMaintenanceCaseV2 = {
    ...item,
    evidenceRevision: maintenanceRecordRevision(record, records, false, epoch, sourceRevision),
    disposition:
      item.family === 'shared-owner-proposal' || unknown
        ? 'waiting-evidence'
        : EffectArray.every(policies, policy => policy.state === 'active')
          ? 'resolved'
          : 'needs-decision',
    reason:
      item.family === 'shared-owner-proposal'
        ? 'shared-owner-authority-unverified'
        : unknown
          ? 'selected-relation-evidence-incomplete'
          : 'selected-relation-evidence-observed',
    subjectContentHashes: [{uri: record.uri, hash: maintenanceContentHash(record.content)}],
    relationEvidence: evidence,
    ...(epoch !== undefined && sourceRevision !== undefined
      ? {sourceSnapshot: {cwd: root, generation: epoch, revision: sourceRevision}}
      : {}),
    lastChecked: now,
  };
  const closed = yield* readSelectedMaintenanceRelationResource(config, subjectUri);
  if (
    JSON.stringify(closed.observation) !== JSON.stringify(subject.observation) ||
    !(yield* relationMaintenanceEvidenceCurrent(config, evidence)) ||
    (epoch !== undefined &&
      ((yield* readContextMaintenanceSourceEpoch(config, root)) !== epoch ||
        (yield* recordSourceRevision(config, record, root)) !== sourceRevision))
  )
    return {
      outcome: 'changing' as const,
      reason: 'The selected subject, target or source changed during the check. Retry after the edit is saved.',
    };
  if (
    next.evidenceRevision === item.evidenceRevision &&
    next.disposition === item.disposition &&
    next.reason === item.reason &&
    JSON.stringify(next.subjectContentHashes) === JSON.stringify(item.subjectContentHashes) &&
    JSON.stringify(next.relationEvidence) === JSON.stringify(item.relationEvidence) &&
    JSON.stringify(next.sourceSnapshot) === JSON.stringify(item.sourceSnapshot)
  )
    next = item;
  return {
    outcome: 'observed' as const,
    records,
    item: next,
    reference: undefined,
    repairFinding: undefined,
    state: {...state, cases: EffectArray.map(state.cases, value => (value.caseId === item.caseId ? next : value))},
  };
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
  return EffectArray.take(
    EffectArray.filter(current, citation =>
      item.citationId ? citation.id === item.citationId : contextHealthCitationCaseSlotV2(citation) === item.slot,
    ),
    64,
  );
}

export function maintenanceCoverageCurrent(
  uri: string,
  citations: readonly MemoryCodeCitationV1[],
  validations: readonly ContextBriefMemoryCitationValidationV2[],
): boolean {
  const receipts = EffectArray.flatMap(
    EffectArray.filter(validations, (validation: ContextBriefMemoryCitationValidationV2) => validation.uri === uri),
    (validation: ContextBriefMemoryCitationValidationV2) => validation.receipts,
  );
  return (
    citations.length > 0 &&
    EffectArray.every(citations, citation => {
      const matches = EffectArray.filter(receipts, receipt => receipt.citationId === citation.id);
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
    state: {...state, cases: EffectArray.map(state.cases, value => (value.caseId === item.caseId ? updated : value))},
  };
}

/** Refresh one selected observation, retrying a read race once. Canonical sources remain untouched. */
export const refreshContextMaintenanceCase = Effect.fn('contextMaintenance.refreshCase')(function* (
  config: RuntimeConfig,
  input: {readonly project: string; readonly caseId: string; readonly cwd: string},
  selection: Parameters<typeof readContextMaintenancePacket>[2] = {},
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = yield* withMaintenanceOperationLock(
      config,
      Effect.gen(function* () {
        const state = yield* readState(config);
        const item = EffectOption.getOrUndefined(
          EffectArray.findFirst(state.cases, value => value.caseId === input.caseId && value.project === input.project),
        );
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
