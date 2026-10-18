import {Effect, FileSystem, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {isMemoryId, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {
  buildTopicMaintenanceManifest,
  buildTopicMaintenanceObsidianManifest,
  proposeTopicMaintenanceObsidianEnrollment,
  topicMaintenanceObsidianCitationId,
  type TopicMaintenanceObsidianManifestV3,
  proposeTopicMaintenanceEnrollment,
  validateTopicMaintenanceEnrollmentInput,
  type TopicMaintenanceManifestV1,
} from '@threadnote/memory/topic-maintenance';
import {
  observeCleanRepositoryWorktree,
  resolvePublishedRepositoryReadFence,
  resolveRepositoryIdentity,
} from '@threadnote/graph/repository';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {
  readContextHealthCitationEvidence,
  validateContextHealthMemoryCitations,
} from '@threadnote/context/citation_validation';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri, writeMemoryContentWithExpectedHash} from '../../mcp/server/memory.js';
import {inspectTopicObsidianOrigin} from '../context/maintenance_obsidian.js';
import {resolveLocalMemoryReplacementTarget} from '../replacement_target.js';

class TopicEnrollmentSourceError extends Schema.TaggedError<TopicEnrollmentSourceError>()(
  'TopicEnrollmentSourceError',
  {message: Schema.String},
) {}
type EnrollmentSourceCheck = Effect.Effect<
  void,
  unknown,
  | Effect.Services<ReturnType<typeof inspectTopicObsidianOrigin>>
  | Effect.Services<ReturnType<typeof sourceStillCurrent>>
>;
const enrollmentSourceCheck = (check: EnrollmentSourceCheck) => check;

export interface TopicEnrollmentOptions {
  readonly uri: string;
  readonly callerCwd?: string;
  readonly project?: string;
  readonly input: unknown;
}

export interface TopicEnrollmentProposal {
  readonly targetUri: string;
  readonly expectedContentHash: string;
  readonly manifest: TopicMaintenanceManifestV1 | TopicMaintenanceObsidianManifestV3;
  readonly source:
    | {readonly repositoryId: string; readonly commit: string}
    | {readonly sourceKind: 'obsidian'; readonly revision: string};
  readonly revision: string;
}

interface TopicEnrollmentConflict {
  readonly status: 'conflict';
  readonly code: string;
  readonly message: string;
}

const conflict = (code: string, message: string): TopicEnrollmentConflict => ({status: 'conflict', code, message});

export const inspectTopicEnrollment = Effect.fn('topicMaintenance.inspect')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const target = yield* resolveLocalMemoryReplacementTarget(config, isMemoryId(uri) ? memoryIdentityAlias(uri) : uri);
  if (!target.record) return conflict('target-missing', 'The topic target is not readable.');
  const record = target.record;
  if (
    record.metadata.obsidianEvidence ||
    record.metadata.obsidianEvidenceError ||
    (record.metadata.topicMaintenance?.version === 3 && record.metadata.topicMaintenance.sourceKind === 'obsidian')
  ) {
    const checked = yield* inspectTopicObsidianOrigin(config, record).pipe(Effect.result);
    if (checked._tag === 'Failure')
      return conflict('imported-evidence-unavailable', 'The imported source is unavailable.');
    return {
      status: record.metadata.topicMaintenance ? ('enrolled' as const) : ('not-enrolled' as const),
      sourceKind: 'obsidian' as const,
      project: record.metadata.project,
      targetUri: record.uri,
      memoryId: record.metadata.memoryId,
      body: record.body,
      contentHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
      manifest: record.metadata.topicMaintenance,
      error: record.metadata.topicMaintenanceError,
      originCitationId: topicMaintenanceObsidianCitationId(checked.success.origin),
      originEvidence: checked.success.origin,
    };
  }
  return {
    status: record.metadata.topicMaintenance ? ('enrolled' as const) : ('not-enrolled' as const),
    targetUri: record.uri,
    memoryId: record.metadata.memoryId,
    body: record.body,
    contentHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
    manifest: record.metadata.topicMaintenance,
    error: record.metadata.topicMaintenanceError,
    citations: record.metadata.codeCitations ?? [],
  };
});

export const previewTopicEnrollment = Effect.fn('topicMaintenance.previewEnrollment')(function* (
  config: RuntimeConfig,
  options: TopicEnrollmentOptions,
) {
  const target = yield* resolveLocalMemoryReplacementTarget(
    config,
    isMemoryId(options.uri) ? memoryIdentityAlias(options.uri) : options.uri,
  );
  if (!target.record) return conflict('target-missing', 'The topic target is not readable.');
  const prepared = yield* prepareEnrollment(config, target.record, options);
  if (prepared.status === 'conflict') return prepared;
  if (target.record.metadata.topicMaintenance)
    return conflict(
      'already-enrolled',
      'The topic is already enrolled. Inspect its evidence before proposing an update.',
    );
  return {status: 'preview' as const, proposal: prepared.proposal, body: target.record.body};
});

export const applyTopicEnrollment = Effect.fn('topicMaintenance.applyEnrollment')(function* (
  config: RuntimeConfig,
  options: TopicEnrollmentOptions & {
    readonly approved?: boolean;
    readonly expectedContentHash: string;
    readonly revision: string;
  },
) {
  if (options.approved !== true) return conflict('approval-required', 'Enrollment requires approval of the preview.');
  const target = yield* resolveLocalMemoryReplacementTarget(
    config,
    isMemoryId(options.uri) ? memoryIdentityAlias(options.uri) : options.uri,
  );
  if (!target.record) return conflict('target-missing', 'The topic target is not readable.');
  const fs = yield* FileSystem.FileSystem;
  const result = yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [target.canonicalUri],
    Effect.gen(function* () {
      const [current] = yield* readMemoryRecordsByUri(config, [target.canonicalUri]);
      if (!current) return conflict('target-missing', 'The topic target is no longer readable.');
      const prepared = yield* prepareEnrollment(config, current, options);
      if (prepared.status === 'conflict') return prepared;
      const approvedProposal = {...prepared.proposal, expectedContentHash: options.expectedContentHash};
      if (proposalRevision(approvedProposal) !== options.revision)
        return conflict('revision-changed', 'The evidence or enrollment decisions changed. Preview enrollment again.');
      if (current.metadata.topicMaintenance) {
        if (JSON.stringify(current.metadata.topicMaintenance) === JSON.stringify(prepared.proposal.manifest))
          return {status: 'already-enrolled' as const, targetUri: current.uri};
        return conflict('enrollment-changed', 'The topic already has different enrollment decisions.');
      }
      if (prepared.proposal.expectedContentHash !== options.expectedContentHash)
        return conflict('target-changed', 'The topic changed after preview. Preview enrollment again.');
      const proposed = yield* Effect.try({
        try: () =>
          prepared.proposal.manifest.version === 3
            ? proposeTopicMaintenanceObsidianEnrollment(current, validateTopicMaintenanceEnrollmentInput(options.input))
            : proposeTopicMaintenanceEnrollment(current, validateTopicMaintenanceEnrollmentInput(options.input)),
        catch: error => conflict('invalid-enrollment', error instanceof Error ? error.message : 'Invalid enrollment.'),
      }).pipe(Effect.result);
      if (proposed._tag === 'Failure') return proposed.failure;
      const write = yield* writeMemoryContentWithExpectedHash(
        config,
        'threadnote-native',
        current.uri,
        proposed.success.content,
        current.content,
        {
          alreadyLocked: true,
          topicEnrollment: prepared.proposal.manifest,
          sourceCheck: prepared.sourceCheck,
        },
      );
      if (write.isError) return conflict('write-conflict', 'The topic could not be updated with its exact preview.');
      if (
        !(yield* prepared.sourceCheck.pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ))
      )
        return conflict(
          'source-changed',
          'Enrollment was stored, but source changed during the write. Reinspect before use.',
        );
      return {status: 'enrolled' as const, targetUri: current.uri, manifest: prepared.proposal.manifest};
    }),
  );
  if (result.status === 'enrolled' || (result.status === 'conflict' && result.code === 'source-changed'))
    yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, [target.canonicalUri]);
  return result;
});

const prepareEnrollment = Effect.fn('topicMaintenance.prepareEnrollment')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  options: TopicEnrollmentOptions,
) {
  if (record.metadata.obsidianEvidence || record.metadata.obsidianEvidenceError) {
    const checked = yield* Effect.gen(function* () {
      const manifest = yield* Effect.try({
        try: () =>
          buildTopicMaintenanceObsidianManifest(
            {...record, metadata: {...record.metadata, topicMaintenance: undefined}},
            validateTopicMaintenanceEnrollmentInput(options.input),
          ),
        catch: () => TopicEnrollmentSourceError.make({message: 'Invalid imported enrollment.'}),
      });
      const state = yield* inspectTopicObsidianOrigin(config, record);
      const sourceCheck = enrollmentSourceCheck(
        Effect.gen(function* () {
          const latest = yield* inspectTopicObsidianOrigin(config, record);
          if (latest.revision !== state.revision)
            return yield* TopicEnrollmentSourceError.make({message: 'Imported source changed.'});
        }),
      );
      const proposal = {
        targetUri: record.uri,
        expectedContentHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
        manifest,
        source: {sourceKind: 'obsidian' as const, revision: state.revision},
        revision: '',
      };
      return {status: 'prepared' as const, sourceCheck, proposal: {...proposal, revision: proposalRevision(proposal)}};
    }).pipe(Effect.result);
    return checked._tag === 'Failure'
      ? conflict('imported-evidence-unavailable', 'The imported enrollment or source is unavailable.')
      : checked.success;
  }
  if (!options.callerCwd) return conflict('source-required', 'Code enrollment requires a repository checkout.');
  const callerCwd = options.callerCwd;
  const manifest = yield* Effect.try({
    try: () => buildTopicMaintenanceManifest(record, validateTopicMaintenanceEnrollmentInput(options.input)),
    catch: error => conflict('invalid-enrollment', error instanceof Error ? error.message : 'Invalid enrollment.'),
  }).pipe(Effect.result);
  if (manifest._tag === 'Failure') return manifest.failure;
  const identity = yield* resolveRepositoryIdentity(callerCwd);
  if (manifest.success.repositoryId !== identity.repositoryId)
    return conflict('repository-mismatch', 'The declared evidence belongs to a different repository.');
  if (!(yield* observeCleanRepositoryWorktree(callerCwd)))
    return conflict('dirty-source', 'Enrollment requires a coherent committed worktree.');
  const scope = {
    kind: 'repository' as const,
    callerCwd: callerCwd,
    ...(options.project === undefined ? {} : {project: options.project}),
  };
  const citations = record.metadata.codeCitations!;
  const validations = yield* validateContextHealthMemoryCitations(config, scope, [
    {uri: record.uri, codeCitations: citations},
  ]);
  const receipts = validations.flatMap(validation => validation.receipts);
  if (
    receipts.length !== citations.length ||
    receipts.some(
      receipt =>
        receipt.status !== 'exact' ||
        receipt.coverage !== 'current-complete' ||
        receipt.snapshotCommit !== identity.headCommit,
    )
  )
    return conflict(
      'evidence-not-current',
      'Every declared citation needs exact current evidence. Prepare or repair evidence first.',
    );
  for (const citation of citations) {
    const evidence = yield* readContextHealthCitationEvidence(config, scope, citation, {
      maximumBytes: 1024,
      maximumLines: 8,
    });
    if (!evidence.excerpts.some(excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation))
      return conflict('historical-evidence-unavailable', 'The captured supporting revision is not recoverable.');
  }
  if (!(yield* sourceStillCurrent(callerCwd, identity)))
    return conflict('source-changed', 'Source changed during enrollment preparation. Retry with a coherent snapshot.');
  const proposal = {
    targetUri: record.uri,
    expectedContentHash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
    manifest: manifest.success,
    source: {repositoryId: identity.repositoryId, commit: identity.headCommit},
    revision: '',
  };
  return {
    status: 'prepared' as const,
    sourceCheck: enrollmentSourceCheck(
      sourceStillCurrent(callerCwd, identity).pipe(
        Effect.flatMap(valid =>
          valid ? Effect.void : Effect.fail(TopicEnrollmentSourceError.make({message: 'Source changed.'})),
        ),
      ),
    ),
    proposal: {...proposal, revision: proposalRevision(proposal)},
  };
});

function proposalRevision(proposal: TopicEnrollmentProposal): string {
  const {revision: _revision, ...payload} = proposal;
  return sha256HexSync(JSON.stringify(payload));
}

const sourceStillCurrent = Effect.fn('topicMaintenance.sourceStillCurrent')(function* (
  cwd: string,
  identity: RepositoryIdentity,
) {
  const observed = yield* resolvePublishedRepositoryReadFence(cwd, identity);
  return observed.headCommit === identity.headCommit && !observed.worktreeChanged;
});
