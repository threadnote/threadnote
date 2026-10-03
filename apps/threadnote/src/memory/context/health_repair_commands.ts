import {Crypto, DateTime, Effect, FileSystem, Option, Path, Result} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {shellQuote} from '@threadnote/platform/command';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {SystemInfo} from '@threadnote/platform/system';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  readMemoryRecordsByUri,
  resourceExists,
  resourceStoreLocation,
  writeMemoryContentWithExpectedHash,
} from '../../mcp/server/memory.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {memoryIdentityLockKey, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {validateContextHealthMemoryCitations} from '@threadnote/context/citation_validation';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import type {ContextHealthReportV1} from '@threadnote/context/health';
import type {ContextHealthFindingCategoryV1} from '@threadnote/context/health';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {collectContextHealth} from './health_commands.js';
import {
  applyContextHealthRepairProposalV1,
  isAutomaticRelationRepairTargetV1,
  memoryContentWithCitationReplacementsV1,
  previewContextHealthRepairPlanV1,
  type ContextHealthRepairApplyReceiptV1,
  type ContextHealthRepairConflictV1,
  type ContextHealthRepairPlanV1,
  type ContextHealthRepairProposalV1,
  type ContextHealthSemanticDirectionV1,
} from './health_repair.js';
import {readMaintenanceMemoryRecords} from '../maintenance/records.js';
import {MemoryOperationError} from '../migrations.js';
import {discardDeferredCodeAnchorIntentsWithin} from '../deferred/code_anchor.js';
import {
  contextHealthSelectorCliFlags,
  contextHealthSelectorDescription,
  contextHealthSelectorFindingUris,
  contextHealthSelectorsEqual,
  normalizeContextHealthSelector,
  projectContextHealthRecords,
  type ContextHealthSelectorV1,
} from './health_selector.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';

const REPAIR_JOURNAL_VERSION = 1 as const;
const MAXIMUM_REPAIR_JOURNAL_BYTES = 512 * 1_024;
const REPAIR_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 5 * 60 * 1_000,
  waitTimeoutMilliseconds: 5_000,
} as const;

type RepairArchiveKind = Extract<MemoryRecord['metadata']['kind'], 'durable' | 'handoff' | 'incident'>;

export interface RunContextHealthRepairPreviewOptionsV1 {
  readonly after?: string;
  readonly contradictionId?: string;
  readonly currentUri?: string;
  readonly findingCategory?: string;
  readonly findingCategories?: readonly ContextHealthFindingCategoryV1[];
  readonly json?: boolean;
  readonly kind?: string;
  readonly limit?: number;
  readonly project: string;
  readonly reportRevision?: string;
  readonly staleUri?: string;
  readonly topic?: string;
}

export interface RunContextHealthRepairApplyOptionsV1 {
  readonly after?: string;
  readonly approved?: boolean;
  readonly findingCategory?: string;
  readonly json?: boolean;
  readonly kind?: string;
  readonly project: string;
  readonly proposalId: string;
  readonly revision: string;
  readonly topic?: string;
}

export type ContextHealthRepairApplyCommandResultV1 =
  | {
      readonly conflict: ContextHealthRepairConflictV1;
      readonly proposalId: string;
      readonly revision: string;
      readonly status: 'conflict';
      readonly version: 1;
    }
  | {
      readonly proposalId: string;
      readonly revision: string;
      readonly status: 'review-required';
      readonly version: 1;
    }
  | {
      readonly receipt: ContextHealthRepairApplyReceiptV1;
      readonly proposalId: string;
      readonly revision: string;
      readonly status: 'applied' | 'already-applied';
      readonly version: 1;
    };

export interface ContextHealthCitationRepairBatchItemV1 {
  readonly findingId: string;
  readonly status: 'applied' | 'conflict';
  readonly error?: string;
}

export const applyContextHealthCitationRepairBatch = Effect.fn('memory.contextHealthRepair.applyCitationBatch')(
  function* (
    config: RuntimeConfig,
    input: {readonly project: string; readonly proposals: readonly ContextHealthRepairProposalV1[]},
  ) {
    const groups = new Map<string, ContextHealthRepairProposalV1[]>();
    for (const proposal of input.proposals) {
      if (proposal.project !== input.project || proposal.mutation.kind !== 'replace-citation') continue;
      const group = groups.get(proposal.mutation.subjectUri) ?? [];
      group.push(proposal);
      groups.set(proposal.mutation.subjectUri, group);
    }
    const fs = yield* FileSystem.FileSystem;
    const groupedResults = yield* Effect.forEach(
      [...groups.entries()],
      ([subjectUri, proposals]) =>
        withMemoryUriLocks(
          fs,
          config.agentContextHome,
          [subjectUri],
          Effect.gen(function* () {
            const [source] = yield* readMemoryRecordsByUri(config, [subjectUri]);
            if (source === undefined) return batchConflicts(proposals, 'The affected memory no longer exists.');
            const invalid = proposals.find(proposal => {
              const verification = applyContextHealthRepairProposalV1({
                expectedRevision: proposal.revision,
                proposal,
                records: [source],
              });
              return verification.status !== 'applied';
            });
            if (invalid !== undefined) {
              return batchConflicts(proposals, 'The memory or citation evidence changed after this preview.');
            }
            const content = memoryContentWithCitationReplacementsV1(
              source,
              proposals.flatMap(proposal =>
                proposal.mutation.kind === 'replace-citation'
                  ? [{citationId: proposal.mutation.citationId, replacement: proposal.mutation.replacement}]
                  : [],
              ),
            );
            if (content === undefined) {
              return batchConflicts(proposals, 'The reviewed citations cannot be combined safely in this memory.');
            }
            const written = yield* writeMemoryContentWithExpectedHash(
              config,
              'threadnote-native',
              source.uri,
              content,
              source.content,
              {alreadyLocked: true},
            );
            return written.isError === true
              ? batchConflicts(proposals, callResultText(written))
              : proposals.map(proposal => ({findingId: proposal.findingId, status: 'applied' as const}));
          }),
        ).pipe(Effect.result),
      {concurrency: 4},
    );
    return groupedResults.flatMap((result, index) =>
      Result.isSuccess(result)
        ? result.success
        : batchConflicts(
            [...groups.values()][index] ?? [],
            'The affected memory could not be updated. Preview the repairs again.',
          ),
    );
  },
);

function batchConflicts(
  proposals: readonly ContextHealthRepairProposalV1[],
  error: string,
): readonly ContextHealthCitationRepairBatchItemV1[] {
  return proposals.map(proposal => ({error, findingId: proposal.findingId, status: 'conflict'}));
}

interface ContextHealthRepairJournalV1 {
  readonly archive?: {
    readonly contentHash: string;
    readonly kind: RepairArchiveKind;
    readonly timestamp: string;
    readonly uri: string;
  };
  readonly proposal: ContextHealthRepairProposalV1;
  readonly receipt?: ContextHealthRepairApplyReceiptV1;
  readonly state: 'applied' | 'applying';
  readonly version: typeof REPAIR_JOURNAL_VERSION;
}

export const previewContextHealthRepairs = Effect.fn('memory.contextHealthRepair.preview')(function* (
  config: RuntimeConfig,
  projectInput: string,
  cwd: string,
  directionInput: Omit<RunContextHealthRepairPreviewOptionsV1, 'json' | 'project'> = {},
) {
  const project = projectInput.trim();
  if (!project) return yield* repairError('Provide --project for scoped context repair.');
  const records = yield* readMaintenanceMemoryRecords(config);
  const activeRecords = records.filter(
    record => record.metadata.status === 'active' && record.metadata.project === project,
  );
  const selector = normalizeContextHealthSelector(directionInput);
  const selectedRecords = projectContextHealthRecords(activeRecords, selector);
  const report = yield* collectContextHealth(config, project, selectedRecords, cwd, {
    after: selector?.after,
    duplicateCorpus: activeRecords,
    ...(selector === undefined ? {} : {includeFindingCombination: 'all' as const}),
    ...(directionInput.findingCategories === undefined
      ? selector?.findingCategory === undefined
        ? {}
        : {includeFindingCategories: [selector.findingCategory]}
      : {includeFindingCategories: directionInput.findingCategories}),
    ...(contextHealthSelectorFindingUris(selector, selectedRecords) === undefined
      ? {}
      : {includeFindingUris: contextHealthSelectorFindingUris(selector, selectedRecords)}),
    relationCorpus: records,
    limit: directionInput.limit,
  });
  const repairTargetUris = report.findings.flatMap(finding =>
    finding.category === 'relation-target-missing' &&
    finding.repair.subjectUri !== undefined &&
    finding.repair.targetUri !== undefined &&
    isAutomaticRelationRepairTargetV1(finding.repair.subjectUri, finding.repair.targetUri)
      ? [finding.repair.targetUri]
      : [],
  );
  const absentTargetUris = [
    ...(yield* storageAbsentUris(
      config,
      repairTargetUris.filter(uri => memoryIdFromIdentityAlias(uri) === undefined),
    )),
    ...repairTargetUris.filter(uri => {
      const memoryId = memoryIdFromIdentityAlias(uri);
      return memoryId !== undefined && !records.some(record => record.metadata.memoryId === memoryId);
    }),
  ];
  const semanticDirection = semanticDirectionFromInput(directionInput);
  const citationReplacements = yield* captureCitationReplacements(config, project, cwd, records, report);
  return previewContextHealthRepairPlanV1(report, records, {
    absentTargetUris,
    citationReplacements,
    limit: directionInput.limit,
    ...(selector === undefined ? {} : {selector}),
    ...(semanticDirection === undefined ? {} : {semanticDirection}),
  });
});

export const captureCitationReplacements = Effect.fn('memory.contextHealthRepair.captureCitations')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
  records: readonly MemoryRecord[],
  report: ContextHealthReportV1,
) {
  const recordsByUri = new Map(records.map(record => [record.uri, record]));
  const candidates = report.findings.flatMap(finding => {
    if (
      finding.repair.kind !== 'repair-citation' ||
      (finding.category !== 'citation-missing' && finding.category !== 'citation-unknown')
    ) {
      return [];
    }
    const subjectUri = finding.repair.subjectUri;
    const targetUri = finding.repair.targetUri;
    if (subjectUri === undefined || targetUri === undefined) return [];
    const citationId = targetUri.slice(targetUri.lastIndexOf('#') + 1);
    const current = recordsByUri.get(subjectUri)?.metadata.codeCitations?.find(item => item.id === citationId);
    if (current === undefined) return [];
    return [{current, subjectUri, findingId: finding.id, reference: citationReference(current)}];
  });
  if (candidates.length === 0) return new Map<string, MemoryCodeCitationV1>();
  const validations = yield* validateContextHealthMemoryCitations(
    config,
    {callerCwd: cwd, kind: 'repository', project},
    records
      .filter(
        record =>
          (record.metadata.kind === 'durable' || record.metadata.kind === 'handoff') &&
          candidates.some(candidate => candidate.subjectUri === record.uri),
      )
      .map((record, rank) => ({
        uri: record.uri,
        rank,
        excerpt: '',
        kind: record.metadata.kind as 'durable' | 'handoff',
        memoryId: record.metadata.memoryId,
        project: record.metadata.project,
        codeCitations: (record.metadata.codeCitations ?? []).filter(citation =>
          candidates.some(candidate => candidate.subjectUri === record.uri && candidate.current.id === citation.id),
        ),
        citationErrorCount: record.metadata.citationErrors?.length ?? 0,
      })),
  ).pipe(Effect.orElseSucceed(() => []));
  const receipts = new Map(
    validations.flatMap(validation => validation.receipts.map(receipt => [receipt.citationId, receipt] as const)),
  );
  const verifiedCandidates = candidates.filter(candidate => {
    const receipt = receipts.get(candidate.current.id);
    return (
      receipt !== undefined &&
      (receipt.status === 'exact' || receipt.status === 'relocated') &&
      receipt.coverage === 'current-complete' &&
      receipt.provenance !== 'historical-verified'
    );
  });
  const captures = yield* Effect.forEach(
    verifiedCandidates,
    candidate =>
      Effect.gen(function* () {
        const receipt = receipts.get(candidate.current.id)!;
        const reference = receipt.observedNodeId ?? receipt.observedPath ?? candidate.reference;
        const captured = yield* captureMemoryCodeCitations(config, {
          callerCwd: receipt.recovery?.callerCwd ?? cwd,
          omitUnresolved: true,
          project,
          refs: [reference],
        }).pipe(Effect.orElseSucceed(() => [] as readonly MemoryCodeCitationV1[]));
        const replacement = captured[0];
        if (
          replacement === undefined ||
          replacement.id === candidate.current.id ||
          replacement.repositoryId !== candidate.current.repositoryId ||
          replacement.repositoryIdentityKind !== candidate.current.repositoryIdentityKind
        )
          return undefined;
        const unchangedSupport =
          replacement.target.kind === 'symbol' && candidate.current.target.kind === 'symbol'
            ? replacement.target.fragmentHash.value === candidate.current.target.fragmentHash.value
            : replacement.fileContentHash.value === candidate.current.fileContentHash.value;
        return unchangedSupport ? ([candidate.findingId, replacement] as const) : undefined;
      }),
    {concurrency: 4},
  );
  return new Map(captures.filter((item): item is readonly [string, MemoryCodeCitationV1] => item !== undefined));
});

function citationReference(citation: MemoryCodeCitationV1): string {
  return citation.target.kind === 'symbol' ? citation.target.nodeId : citation.path;
}

export const runContextHealthRepairPreview = Effect.fn('memory.contextHealthRepair.previewCommand')(function* (
  config: RuntimeConfig,
  options: RunContextHealthRepairPreviewOptionsV1,
) {
  const cwd = (yield* SystemInfo).currentDirectory();
  const selector = normalizeContextHealthSelector(options);
  const plan = yield* previewContextHealthRepairs(config, options.project, cwd, options);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(plan) : renderContextHealthRepairPlan(plan, selector));
});

function semanticDirectionFromInput(
  input: Omit<RunContextHealthRepairPreviewOptionsV1, 'json' | 'project'>,
): ContextHealthSemanticDirectionV1 | undefined {
  const contradictionId = input.contradictionId?.trim();
  const currentUri = input.currentUri?.trim();
  const reportRevision = input.reportRevision?.trim();
  const staleUri = input.staleUri?.trim();
  const supplied = [contradictionId, currentUri, reportRevision, staleUri].filter(value => value !== undefined);
  if (supplied.length === 0) return undefined;
  if (!contradictionId || !currentUri || !reportRevision || !staleUri) {
    throw MemoryOperationError.make({
      message: 'Semantic direction requires contradiction ID, report revision, stale URI, and current URI together.',
    });
  }
  return {
    contradictionId,
    currentUri,
    reportRevision,
    staleUri,
    type: 'context-health-semantic-direction',
    version: 1,
  };
}

export const applyContextHealthRepair = Effect.fn('memory.contextHealthRepair.apply')(function* (
  config: RuntimeConfig,
  input: {
    readonly after?: string;
    readonly approved?: boolean;
    readonly cwd: string;
    readonly findingCategory?: string;
    readonly kind?: string;
    readonly project: string;
    readonly proposalId: string;
    readonly revision: string;
    readonly topic?: string;
  },
) {
  const project = input.project.trim();
  if (!project) return yield* repairError('Provide --project for scoped context repair.');
  const proposalId = input.proposalId.trim();
  if (!/^health-repair-[0-9a-f]{40}$/u.test(proposalId)) {
    return yield* repairError('Provide a valid proposal ID from context repair preview.');
  }
  const revision = input.revision.trim();
  if (!/^[0-9a-f]{64}$/u.test(revision)) {
    return yield* repairError('Provide a valid exact proposal revision from context repair preview.');
  }
  if (input.approved !== true) {
    return yield* repairError('Applying a context-health repair requires --approved after explicit review.');
  }
  const selector = normalizeContextHealthSelector(input);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const journalPath = repairJournalPath(path, config.agentContextHome, proposalId, revision);
  return yield* withExclusiveFileLock(
    fs,
    `${journalPath}.lock`,
    REPAIR_LOCK_OPTIONS,
    applyLocked(config, {cwd: input.cwd, journalPath, project, proposalId, revision, selector}),
  );
});

export const applyAutomaticContextHealthArchive = Effect.fn('memory.contextHealthRepair.automaticArchive')(function* <
  E = never,
  R = never,
>(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  cwd: string,
  timestamp?: string,
  archiveGuard?: (source: MemoryRecord) => Effect.Effect<void, E, R>,
) {
  if (
    proposal.mutation.kind !== 'archive-memory' ||
    !['validity-expired', 'exact-duplicate'].includes(proposal.category)
  ) {
    return yield* repairError('Automatic archival requires explicit validity or exact duplication evidence.');
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const journalPath = repairJournalPath(path, config.agentContextHome, proposal.proposalId, proposal.revision);
  return yield* withExclusiveFileLock(
    fs,
    `${journalPath}.lock`,
    REPAIR_LOCK_OPTIONS,
    applyLocked(config, {
      cwd,
      journalPath,
      project: proposal.project,
      proposalId: proposal.proposalId,
      revision: proposal.revision,
      automaticProposal: proposal,
      archiveTimestamp: timestamp,
      archiveGuard,
    }),
  );
});

export const runContextHealthRepairApply = Effect.fn('memory.contextHealthRepair.applyCommand')(function* (
  config: RuntimeConfig,
  options: RunContextHealthRepairApplyOptionsV1,
) {
  const cwd = (yield* SystemInfo).currentDirectory();
  const result = yield* applyContextHealthRepair(config, {...options, cwd});
  yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderContextHealthRepairApply(result));
});

function applyLocked<E = never, R = never>(
  config: RuntimeConfig,
  input: {
    readonly cwd: string;
    readonly journalPath: string;
    readonly automaticProposal?: ContextHealthRepairProposalV1;
    readonly archiveTimestamp?: string;
    readonly archiveGuard?: (source: MemoryRecord) => Effect.Effect<void, E, R>;
    readonly project: string;
    readonly proposalId: string;
    readonly revision: string;
    readonly selector?: ContextHealthSelectorV1;
  },
) {
  return Effect.gen(function* () {
    let journal = yield* readRepairJournal(input.journalPath);
    let proposal: ContextHealthRepairProposalV1;
    if (journal) {
      proposal = journal.proposal;
      if (
        proposal.project !== input.project ||
        proposal.proposalId !== input.proposalId ||
        proposal.revision !== input.revision ||
        !contextHealthSelectorsEqual(proposal.selector, input.selector)
      ) {
        return yield* repairError(
          'The stored repair journal belongs to another project, selector, or proposal revision.',
        );
      }
      if (journal.state === 'applied' && journal.receipt) {
        const verified = applyContextHealthRepairProposalV1({
          expectedRevision: input.revision,
          proposal,
          receipt: journal.receipt,
          records: yield* readMaintenanceMemoryRecords(config),
        });
        return publicApplyResult(verified, proposal);
      }
    } else {
      const proposals =
        input.automaticProposal === undefined
          ? (yield* previewContextHealthRepairs(config, input.project, input.cwd, input.selector)).proposals
          : [input.automaticProposal];
      const matched = proposals.find(item => item.proposalId === input.proposalId);
      if (!matched) {
        return yield* repairError(
          `Repair proposal ${input.proposalId} is no longer present. Preview context repairs again.`,
        );
      }
      proposal = matched;
      const records = yield* readMaintenanceMemoryRecords(config);
      const preflight = applyContextHealthRepairProposalV1({
        absentTargetUris: yield* proposalAbsentTargetUris(config, proposal),
        expectedRevision: input.revision,
        proposal,
        records,
      });
      if (preflight.status === 'conflict' || preflight.status === 'review-required') {
        return publicApplyResult(preflight, proposal);
      }
      const subject = mutationSubject(proposal, records);
      const archiveBlocker = subject === undefined ? undefined : archiveSourceBlocker(subject);
      if (proposal.mutation.kind === 'archive-memory' && archiveBlocker !== undefined) {
        return yield* repairError(archiveBlocker);
      }
      const archive =
        proposal.mutation.kind === 'archive-memory' && subject !== undefined
          ? repairArchiveJournal(
              config,
              proposal,
              subject,
              input.archiveTimestamp ?? DateTime.formatIso(yield* DateTime.now),
            )
          : undefined;
      journal = {
        ...(archive === undefined ? {} : {archive}),
        proposal,
        state: 'applying',
        version: REPAIR_JOURNAL_VERSION,
      };
      yield* writeRepairJournal(input.journalPath, journal);
    }

    const records = yield* readMaintenanceMemoryRecords(config);
    const recovered = recoveredArchiveReceipt(config, proposal, journal, records);
    if (recovered) {
      yield* writeRepairJournal(input.journalPath, {...journal, receipt: recovered, state: 'applied'});
      return publicApplyResult({receipt: recovered, status: 'already-applied'}, proposal);
    }
    const planned = applyContextHealthRepairProposalV1({
      absentTargetUris: yield* proposalAbsentTargetUris(config, proposal),
      expectedRevision: input.revision,
      proposal,
      records,
    });
    if (planned.status === 'conflict' || planned.status === 'review-required') {
      return publicApplyResult(planned, proposal);
    }
    if (planned.status === 'already-applied') {
      yield* writeRepairJournal(input.journalPath, {...journal, receipt: planned.receipt, state: 'applied'});
      return publicApplyResult(planned, proposal);
    }

    yield* executeRepairMutation(config, proposal, journal, input.archiveGuard);
    yield* writeRepairJournal(input.journalPath, {...journal, receipt: planned.receipt, state: 'applied'});
    return publicApplyResult(planned, proposal);
  });
}

function executeRepairMutation<E = never, R = never>(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  journal: ContextHealthRepairJournalV1,
  archiveGuard?: (source: MemoryRecord) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const mutation = proposal.mutation;
    if (mutation.kind === 'review-only') return yield* repairError('Review-only proposals cannot be applied.');
    if (mutation.subjectUri.includes('/memories/shared/')) {
      return yield* repairError('Context-health repair apply never mutates shared memories.');
    }
    const fs = yield* FileSystem.FileSystem;
    if (mutation.kind === 'archive-memory') {
      const archive = journal.archive;
      if (!archive || archive.uri !== repairArchiveUri(config, proposal, archive.kind)) {
        return yield* repairError(
          'The repair journal does not contain the exact archive destination for this revision.',
        );
      }
      const lockedUris = [...proposal.preconditions.map(precondition => precondition.uri), archive.uri];
      return yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        lockedUris,
        Effect.gen(function* () {
          const current = yield* readMemoryRecordsByUri(config, lockedUris);
          const source = current.find(record => record.uri === mutation.subjectUri);
          const existingArchive = current.find(record => record.uri === archive.uri);
          if (!source) {
            if (existingArchive && memoryContentHash(existingArchive.content) === archive.contentHash) return;
            return yield* repairError(`Repair subject ${mutation.subjectUri} is no longer readable.`);
          }
          if (!isArchiveRepairableKind(source.metadata.kind)) {
            return yield* repairError(`Memory kind ${source.metadata.kind} requires manual lifecycle review.`);
          }
          if (source.metadata.kind !== archive.kind) {
            return yield* repairError('The repair subject kind changed after the archive journal was created.');
          }
          const archiveBlocker = archiveSourceBlocker(source);
          if (archiveBlocker !== undefined) return yield* repairError(archiveBlocker);
          const lockedPlan = applyContextHealthRepairProposalV1({
            absentTargetUris: yield* proposalAbsentTargetUris(config, proposal),
            expectedRevision: proposal.revision,
            proposal,
            records: current,
          });
          if (lockedPlan.status !== 'applied') {
            return yield* repairError('Memory content changed while the approved archive repair was starting.');
          }
          const content = repairArchiveContent(proposal, source, archive.timestamp);
          if (memoryContentHash(content) !== archive.contentHash) {
            return yield* repairError('The approved archive fingerprint no longer matches its repair journal.');
          }
          if (existingArchive && memoryContentHash(existingArchive.content) !== archive.contentHash) {
            return yield* repairError(`Archive destination ${archive.uri} contains different content.`);
          }
          const store = yield* ResourceStore;
          const location = resourceStoreLocation(config);
          const mutations: ResourceStoreMutation[] = [
            ...(existingArchive
              ? []
              : [{type: 'write' as const, uri: archive.uri, content, options: {mode: 'create' as const}}]),
            {type: 'remove', uri: source.uri, options: {expectedFingerprint: yield* store.fingerprint(source.content)}},
          ];
          yield* store.mutateChecked(
            location,
            mutations,
            Effect.gen(function* () {
              const checked = yield* readMemoryRecordsByUri(config, lockedUris);
              const checkedPlan = applyContextHealthRepairProposalV1({
                absentTargetUris: yield* proposalAbsentTargetUris(config, proposal),
                expectedRevision: proposal.revision,
                proposal,
                records: checked,
              });
              if (
                checkedPlan.status !== 'applied' ||
                current.some(record => checked.find(item => item.uri === record.uri)?.content !== record.content)
              ) {
                return yield* repairError('Memory content changed before the approved archive mutation.');
              }
              if (archiveGuard !== undefined) yield* archiveGuard(source);
            }),
          );
          yield* discardDeferredCodeAnchorIntentsWithin(config, source.uri);
          const [storedArchive] = yield* readMemoryRecordsByUri(config, [archive.uri]);
          if (!storedArchive || memoryContentHash(storedArchive.content) !== archive.contentHash) {
            return yield* repairError(`Archive verification failed for ${archive.uri}.`);
          }
          if ((yield* readMemoryRecordsByUri(config, [source.uri])).length > 0) {
            return yield* repairError(`Archive was stored, but repair subject ${source.uri} could not be removed.`);
          }
        }),
      );
    }
    const lockScope = contextHealthRepairLockScopeV1(proposal);
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      lockScope.lockKeys,
      Effect.gen(function* () {
        const current = yield* readMemoryRecordsByUri(config, lockScope.recordUris);
        const lockedPlan = applyContextHealthRepairProposalV1({
          absentTargetUris: yield* proposalAbsentTargetUris(config, proposal),
          expectedRevision: proposal.revision,
          proposal,
          records: current,
        });
        if (lockedPlan.status === 'already-applied') return;
        if (lockedPlan.status !== 'applied') {
          return yield* repairError('Memory or relation-target state changed while the approved repair was starting.');
        }
        const source = current.find(record => record.uri === mutation.subjectUri);
        const updated = lockedPlan.records.find(record => record.uri === mutation.subjectUri);
        if (!source || !updated) return yield* repairError(`Repair did not produce ${mutation.subjectUri}.`);
        const result = yield* writeMemoryContentWithExpectedHash(
          config,
          'threadnote-native',
          source.uri,
          updated.content,
          source.content,
          {alreadyLocked: true},
        );
        if (result.isError === true) return yield* repairError(callResultText(result));
      }),
    );
  });
}

export function contextHealthRepairLockScopeV1(proposal: ContextHealthRepairProposalV1): {
  readonly lockKeys: readonly string[];
  readonly recordUris: readonly string[];
} {
  const recordUris = [
    ...proposal.preconditions.map(precondition => precondition.uri),
    ...(proposal.mutation.kind === 'remove-relations' &&
    memoryIdFromIdentityAlias(proposal.mutation.targetUri) === undefined
      ? [proposal.mutation.targetUri]
      : []),
  ];
  const targetIdentityLockKey =
    proposal.mutation.kind === 'remove-relations'
      ? memoryIdentityLockKey(memoryIdFromIdentityAlias(proposal.mutation.targetUri))
      : undefined;
  return {
    lockKeys: [...recordUris, ...(targetIdentityLockKey === undefined ? [] : [targetIdentityLockKey])],
    recordUris,
  };
}

function recoveredArchiveReceipt(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  journal: ContextHealthRepairJournalV1,
  records: readonly MemoryRecord[],
): ContextHealthRepairApplyReceiptV1 | undefined {
  if (proposal.mutation.kind !== 'archive-memory' || journal.archive === undefined) return undefined;
  if (journal.archive.uri !== repairArchiveUri(config, proposal, journal.archive.kind)) return undefined;
  if (records.some(record => record.uri === proposal.mutation.subjectUri)) return undefined;
  const archive = records.filter(record => record.uri === journal.archive?.uri);
  if (archive.length !== 1 || memoryContentHash(archive[0]?.content ?? '') !== journal.archive.contentHash)
    return undefined;
  const subjectPrecondition = proposal.preconditions.find(item => item.uri === proposal.mutation.subjectUri);
  if (!subjectPrecondition) return undefined;
  return {
    proposalId: proposal.proposalId,
    resultHash: subjectPrecondition.expectedContentHash,
    revision: proposal.revision,
    version: 1,
  };
}

export function previewAutomaticContextHealthArchiveReceipt(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  source: MemoryRecord,
  timestamp: string,
) {
  if (proposal.mutation.kind !== 'archive-memory' || !isArchiveRepairableKind(source.metadata.kind))
    throw new Error('Cannot preview a non-archive receipt.');
  return {
    uri: repairArchiveUri(config, proposal, source.metadata.kind),
    content: repairArchiveContent(proposal, source, timestamp),
  };
}

function repairArchiveJournal(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  source: MemoryRecord,
  timestamp: string,
): NonNullable<ContextHealthRepairJournalV1['archive']> {
  if (proposal.mutation.kind !== 'archive-memory' || !isArchiveRepairableKind(source.metadata.kind)) {
    throw new Error('Cannot journal a non-archive health repair.');
  }
  const content = repairArchiveContent(proposal, source, timestamp);
  return {
    contentHash: memoryContentHash(content),
    kind: source.metadata.kind,
    timestamp,
    uri: repairArchiveUri(config, proposal, source.metadata.kind),
  };
}

function repairArchiveContent(
  proposal: ContextHealthRepairProposalV1,
  source: MemoryRecord,
  timestamp: string,
): string {
  if (!isArchiveRepairableKind(source.metadata.kind)) throw new Error('Cannot archive this memory kind.');
  return formatMemoryDocument(
    'MEMORY',
    memoryArchiveMetadata(
      {
        ...source.metadata,
        ...(proposal.mutation.kind === 'archive-memory' && proposal.mutation.survivorUri !== undefined
          ? {references: [...new Set([...(source.metadata.references ?? []), proposal.mutation.survivorUri])]}
          : {}),
      },
      {
        archivedFrom: source.uri,
        kind: source.metadata.kind,
        project: proposal.project,
        sourceAgentClient: 'threadnote',
        timestamp,
        topic: source.metadata.topic,
      },
    ),
    memoryArchiveBody(source.body),
  );
}

function repairArchiveUri(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  kind: RepairArchiveKind,
): string {
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  const project = uriSegment(proposal.project);
  const directory =
    kind === 'durable'
      ? `${base}/durable/archived/${project}`
      : `${base}/${kind === 'handoff' ? 'handoffs' : 'incidents'}/archived/${project}`;
  return `${directory}/${proposal.proposalId}-${proposal.revision}.md`;
}

function memoryContentHash(content: string): string {
  return sha256HexSync(canonicalMemoryDocumentContent(content));
}

function proposalAbsentTargetUris(config: RuntimeConfig, proposal: ContextHealthRepairProposalV1) {
  if (proposal.mutation.kind !== 'remove-relations' || proposal.mutation.targetPrecondition.state !== 'absent') {
    return Effect.succeed([] as readonly string[]);
  }
  const targetUri = proposal.mutation.targetUri;
  const targetMemoryId = memoryIdFromIdentityAlias(targetUri);
  if (targetMemoryId === undefined) return storageAbsentUris(config, [targetUri]);
  return readMaintenanceMemoryRecords(config).pipe(
    Effect.map(records => (records.some(record => record.metadata.memoryId === targetMemoryId) ? [] : [targetUri])),
  );
}

const storageAbsentUris = Effect.fn('memory.contextHealthRepair.storageAbsentUris')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const observations = yield* Effect.forEach(
    [...new Set(uris)].sort(),
    uri => resourceExists('threadnote-native', config, uri).pipe(Effect.map(exists => ({exists, uri}))),
    {concurrency: 16},
  );
  return observations.flatMap(observation => (observation.exists ? [] : [observation.uri]));
});

function isArchiveRepairableKind(kind: MemoryRecord['metadata']['kind']): kind is RepairArchiveKind {
  return kind === 'durable' || kind === 'handoff' || kind === 'incident';
}

function archiveSourceBlocker(record: MemoryRecord): string | undefined {
  if ((record.metadata.citationErrors?.length ?? 0) > 0) {
    const reasons = [...new Set(record.metadata.citationErrors?.map(error => error.reason) ?? [])].sort().join(', ');
    return `Cannot archive ${record.uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`;
  }
  try {
    assertMemoryDocumentSchemaWritable(record.content);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : `Memory ${record.uri} uses an unsupported schema.`;
  }
}

function mutationSubject(proposal: ContextHealthRepairProposalV1, records: readonly MemoryRecord[]) {
  return proposal.mutation.kind === 'review-only'
    ? undefined
    : records.find(record => record.uri === proposal.mutation.subjectUri);
}

function publicApplyResult(
  result:
    | {readonly conflict: ContextHealthRepairConflictV1; readonly status: 'conflict'}
    | {readonly status: 'review-required'}
    | {
        readonly receipt: ContextHealthRepairApplyReceiptV1;
        readonly status: 'applied' | 'already-applied';
      },
  proposal: ContextHealthRepairProposalV1,
): ContextHealthRepairApplyCommandResultV1 {
  const proposalId = proposal.proposalId;
  const revision = proposal.revision;
  if (result.status === 'conflict')
    return {conflict: result.conflict, proposalId, revision, status: 'conflict', version: 1};
  if (result.status === 'review-required') return {proposalId, revision, status: 'review-required', version: 1};
  return {proposalId, receipt: result.receipt, revision, status: result.status, version: 1};
}

export function renderContextHealthRepairPlan(
  plan: ContextHealthRepairPlanV1,
  selector?: ContextHealthSelectorV1,
): string {
  const lines = [
    `Context repair preview for ${plan.project}: ${plan.proposals.length} proposal${plan.proposals.length === 1 ? '' : 's'}.`,
    ...(selector === undefined ? [] : [`Active selector: ${contextHealthSelectorDescription(selector)}.`]),
    ...plan.proposals.map(proposal => {
      const suggested =
        proposal.mutation.kind === 'review-only' && proposal.mutation.suggestedMutation?.kind === 'supersede-memory'
          ? `\n  suggested: supersede ${proposal.mutation.suggestedMutation.subjectUri} with ${proposal.mutation.suggestedMutation.supersededByUri}`
          : '';
      return `- ${proposal.proposalId} ${proposal.mutation.kind}: ${proposal.summary}${suggested}\n  revision: ${proposal.revision}`;
    }),
    `Knowledge Delta: ${plan.knowledgeDelta.reviewId} revision ${plan.knowledgeDelta.revision}; ${plan.knowledgeDelta.items.length} item(s).`,
  ];
  if (plan.omittedProposals > 0) lines.push(`- ${plan.omittedProposals} additional proposal(s) omitted.`);
  if (plan.nextCursor !== undefined) {
    const nextSelector = {...selector, after: plan.nextCursor};
    lines.push(
      `- Continue this exact scope without duplicates: threadnote context repair preview --project ${shellQuote(plan.project)}${contextHealthSelectorCliFlags(nextSelector, shellQuote)}`,
    );
  }
  return lines.join('\n');
}

export function renderContextHealthRepairApply(result: ContextHealthRepairApplyCommandResultV1): string {
  if (result.status === 'conflict') {
    return `Repair conflict ${result.conflict.conflictId} (${result.conflict.code}): ${result.conflict.message}`;
  }
  if (result.status === 'review-required')
    return `Repair ${result.proposalId} requires manual review; nothing changed.`;
  return `Repair ${result.proposalId} ${result.status === 'applied' ? 'applied' : 'was already applied'} at revision ${result.revision}.`;
}

function repairJournalPath(path: Path.Path, home: string, proposalId: string, revision: string): string {
  return path.join(home, 'threadnote', 'context-health-repairs', 'v1', `${proposalId}-${revision}.json`);
}

const readRepairJournal = Effect.fn('memory.contextHealthRepair.readJournal')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return undefined;
  if (Option.isSome(yield* fs.readLink(path).pipe(Effect.option))) {
    return yield* repairError('Refusing to read a symbolic-link context-health repair journal.');
  }
  const info = yield* fs.stat(path);
  if (info.type !== 'File' || Number(info.size) > MAXIMUM_REPAIR_JOURNAL_BYTES) {
    return yield* repairError('Context-health repair journal is invalid or exceeds its size limit.');
  }
  const raw = yield* fs.readFileString(path);
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw),
    catch: () => MemoryOperationError.make({message: 'Context-health repair journal contains invalid JSON.'}),
  });
  if (!isRepairJournal(parsed)) return yield* repairError('Context-health repair journal has an unsupported shape.');
  return parsed;
});

const writeRepairJournal = Effect.fn('memory.contextHealthRepair.writeJournal')(function* (
  path: string,
  journal: ContextHealthRepairJournalV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const content = `${JSON.stringify(journal, undefined, 2)}\n`;
  if (new TextEncoder().encode(content).byteLength > MAXIMUM_REPAIR_JOURNAL_BYTES) {
    return yield* repairError('Context-health repair journal exceeds its size limit.');
  }
  yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
  const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, path)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
});

function isRepairJournal(value: unknown): value is ContextHealthRepairJournalV1 {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const archive = record.archive;
  const validArchive =
    archive === undefined ||
    (typeof archive === 'object' &&
      archive !== null &&
      /^(?:durable|handoff|incident)$/u.test(String((archive as Record<string, unknown>).kind)) &&
      /^[0-9a-f]{64}$/u.test(String((archive as Record<string, unknown>).contentHash)) &&
      typeof (archive as Record<string, unknown>).uri === 'string' &&
      isCanonicalIsoTimestamp((archive as Record<string, unknown>).timestamp));
  return (
    validArchive &&
    record.version === REPAIR_JOURNAL_VERSION &&
    (record.state === 'applying' || record.state === 'applied') &&
    typeof record.proposal === 'object' &&
    record.proposal !== null
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function repairError(message: string) {
  return MemoryOperationError.make({message});
}

function callResultText(result: {
  readonly content: readonly {readonly text?: string; readonly type: string}[];
}): string {
  return result.content
    .flatMap(item => (item.type === 'text' && item.text !== undefined ? [item.text] : []))
    .join('\n')
    .trim();
}
