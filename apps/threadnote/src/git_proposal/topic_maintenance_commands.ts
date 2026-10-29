import {uriSegment} from '@threadnote/workspace/manifest';
import {assertApprovedSourceDescriptor, type ApprovedSourceDescriptorV1} from '@threadnote/memory/reviewed-support';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlocker,
} from '@threadnote/memory/code/citation-policy';
import {isMemoryId, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {readMaintenanceMemoryRecords} from '../memory/maintenance/records.js';
import {resolveRelationTarget} from '../memory/context/maintenance_policy.js';
import {assertMemoryMaintenanceFragmentSource} from '@threadnote/context/memory_maintenance';
import type {AutomaticMaintenanceSourceV1} from '@threadnote/memory/automatic-maintenance';
import {Console, DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {parseResourceId, validatePortableSegment} from '@threadnote/store/resource-id';
import {
  canonicalMemoryDocumentContent,
  isAgentArtifactUri,
  isSharedMemoryUri,
  parseMemoryDocument,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {
  loadCandidateReviewOptional,
  saveCandidateReview,
  withCandidateReviewLock,
  type CandidateReview,
} from '@threadnote/memory/candidate';
import {
  parseTopicMaintenanceDraft,
  validateTopicMaintenanceReviewPayload,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  prepareAutomaticMaintenanceAcceptance,
  prepareTopicMaintenanceAcceptance,
} from '@threadnote/memory/topic-maintenance-acceptance';
import {
  buildTopicMaintenanceEvidencePacket,
  observeTopicMaintenanceEvidence,
} from '@threadnote/context/topic_maintenance';
import {MemoryOperationError} from '../memory/migrations.js';
import {sharedDurablePath} from './knowledge_delta.js';
import {
  basisFromPacket,
  privateReview,
  readyEvidence,
  reviewEvidenceFromPacket,
} from '../memory/context/maintenance_draft.js';
import {prepareTopicMaintenanceReview} from '../memory/context/maintenance_review.js';
import {verifyTopicMaintenanceReviewSource} from '../memory/context/maintenance_review_source.js';
import {readContextMaintenanceSourceEpoch} from '../memory/context/maintenance_evidence.js';
import {
  assertSafeShareRelativePath,
  assertShareTeamWritable,
  resolveTeam,
  shareTeamAccess,
  sharedMemoryUriParts,
  ShareOperationError,
} from '../share/core.js';
import {
  buildAutomaticMaintenanceGitProposal,
  buildTopicMaintenanceGitProposal,
  type AutomaticMaintenanceGitProposalV3,
  type TopicMaintenanceGitProposalV2,
} from './topic_maintenance_proposal.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

export interface SharedTopicProposalOptions {
  readonly uri: string;
  readonly sourceCwd: string;
  readonly draftFile?: string;
  readonly draftJson?: string;
  readonly reviewId?: string;
  readonly revision?: number;
  readonly team?: string;
}

/** Resolve the accepted shared Git file, never a personal projection or cached accepted copy. */
export const readSharedTopicGitBaseline = Effect.fn('gitProposal.readSharedTopicBaseline')(function* (
  config: RuntimeConfig,
  uri: string,
  requestedTeam?: string,
) {
  const parts = sharedMemoryUriParts(config, uri);
  const resource = yield* Effect.try({
    try: () => parseResourceId(uri),
    catch: () => fail('Invalid shared topic URI.'),
  });
  if (
    !parts?.project ||
    !parts.topic ||
    parts.kind !== 'durable' ||
    resource.canonicalUri !== uri ||
    resource.anchor !== undefined
  )
    return yield* fail('Select an exact existing shared durable project/topic URI.');
  const projectName = parts.project;
  const topicName = parts.topic;
  const project = yield* Effect.try({
    try: () => validatePortableSegment(decodeURIComponent(projectName)),
    catch: () => fail('Invalid shared project.'),
  });
  const topic = yield* Effect.try({
    try: () => validatePortableSegment(decodeURIComponent(topicName)),
    catch: () => fail('Invalid shared topic.'),
  });
  const team = yield* resolveTeam(config, requestedTeam ?? decodeURIComponent(parts.team));
  if (team.name !== decodeURIComponent(parts.team))
    return yield* fail('Shared topic team does not match the selected team.');
  yield* Effect.try({
    try: () => assertShareTeamWritable(team, 'propose reviewed topic maintenance'),
    catch: cause => fail(String(cause)),
  });
  const repository = yield* resolveRepositoryIdentity(team.config.worktree);
  if (!repository.remoteIdentity || /^0+$/u.test(repository.headCommit))
    return yield* fail('Shared proposals require a committed Git base with a portable remote identity.');
  const path = sharedDurablePath(project, topic);
  const command = yield* CommandExecutor;
  const read = (args: readonly string[]) =>
    command.execute('git', ['--no-optional-locks', ...args], {
      cwd: team.config.worktree,
      timeoutMs: 30_000,
      maxOutputBytes: 512 * 1024,
    });
  if (
    Effect2.pipe(
      (yield* read(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).stdout,
      EffectString.trim,
    )
  )
    return yield* fail('Shared Git worktree must be clean before topic proposal review.');
  const treeEntry = (yield* read(['ls-tree', repository.headCommit, '--', path])).stdout;
  if (!Effect2.pipe(treeEntry, EffectString.startsWith('100644 blob ')))
    return yield* fail('Shared topic must be an existing regular Git file.');
  const rawContent = (yield* read(['show', `${repository.headCommit}:${path}`])).stdout;
  const record = parseMemoryDocument(uri, rawContent);
  if (
    !record ||
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active' ||
    record.metadata.visibility !== 'shared' ||
    record.metadata.project !== project ||
    record.metadata.topic !== topic ||
    !record.metadata.memoryId ||
    !record.metadata.topicMaintenance ||
    record.metadata.topicMaintenanceError
  )
    return yield* fail(
      'Shared topic must already have valid enrolled identity and provenance. Live shared enrollment remains gated.',
    );
  return {team, repository, path, record, rawContent};
});

/** All-kind automatic review resolves the actual committed owner path; it never derives a durable filename. */
export const readSharedAutomaticMemoryGitBaseline = Effect.fn('gitProposal.readSharedAutomaticBaseline')(function* (
  config: RuntimeConfig,
  uri: string,
  requestedTeam?: string,
  options: {readonly requireWritable?: boolean; readonly historicalProvenance?: boolean} = {},
) {
  const parts = sharedMemoryUriParts(config, uri);
  const resource = yield* Effect.try({
    try: () => parseResourceId(uri),
    catch: () => fail('Invalid shared memory URI.'),
  });
  if (
    !parts ||
    resource.canonicalUri !== uri ||
    resource.anchor !== undefined ||
    resource.namespace !== 'user' ||
    resource.segments[1] !== 'memories' ||
    resource.segments[2] !== 'shared' ||
    resource.segments.length < 6 ||
    isAgentArtifactUri(uri)
  )
    return yield* fail('Select one exact existing managed shared memory URI.');
  const team = yield* resolveTeam(config, requestedTeam ?? decodeURIComponent(parts.team));
  if (team.name !== decodeURIComponent(parts.team))
    return yield* fail('Shared memory team does not match the selected team.');
  if (options.requireWritable !== false)
    yield* Effect.try({
      try: () => assertShareTeamWritable(team, 'propose reviewed automatic memory maintenance'),
      catch: cause => fail(String(cause)),
    });
  const path = yield* Effect.try({
    try: () =>
      assertSafeShareRelativePath(
        EffectArray.join(EffectArray.map(resource.segments.slice(4), decodeURIComponent), '/'),
      ),
    catch: () => fail('Invalid existing shared memory path.'),
  });
  const kind = resource.segments[4];
  if (
    !['durable', 'handoff', 'incident', 'preference', 'smoke'].includes(kind) ||
    !Effect2.pipe(path, EffectString.endsWith('.md'))
  )
    return yield* fail('Select a managed ordinary-kind shared memory file.');
  const repository = yield* resolveRepositoryIdentity(team.config.worktree);
  if (!repository.remoteIdentity || /^0+$/u.test(repository.headCommit))
    return yield* fail('Shared proposals require a committed Git base with a portable remote identity.');
  const command = yield* CommandExecutor;
  const read = (args: readonly string[]) =>
    command.execute('git', ['--no-optional-locks', ...args], {
      cwd: team.config.worktree,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    });
  if (
    Effect2.pipe(
      (yield* read(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).stdout,
      EffectString.trim,
    )
  )
    return yield* fail('Shared Git worktree must be clean before automatic review.');
  const treeEntry = (yield* read(['ls-tree', repository.headCommit, '--', path])).stdout;
  if (!Effect2.pipe(treeEntry, EffectString.startsWith('100644 blob ')))
    return yield* fail('Shared memory must be an existing regular Git file.');
  const rawContent = (yield* read(['show', `${repository.headCommit}:${path}`])).stdout;
  const record = parseMemoryDocument(uri, rawContent);
  if (
    !record ||
    record.metadata.kind !== kind ||
    (!options.historicalProvenance && record.metadata.status !== 'active') ||
    record.metadata.visibility !== 'shared' ||
    (options.requireWritable !== false && !record.metadata.memoryId) ||
    record.metadata.topicMaintenanceError ||
    record.metadata.reviewedSupportError ||
    record.metadata.consolidationError ||
    record.metadata.citationErrors?.length ||
    record.metadata.obsidianEvidenceError ||
    record.metadata.sourceEvidenceError
  )
    return yield* fail(
      'Shared automatic review requires an active managed canonical record with valid identity and provenance.',
    );
  return {team, repository, path, record, rawContent};
});

/** Resolve the portable locator through the current authorized store, then bind exact source bytes. */
export const resolveAutomaticSharedMemorySource = Effect.fn('gitProposal.resolveAutomaticSharedSource')(function* (
  config: RuntimeConfig,
  source: Extract<AutomaticMaintenanceSourceV1, {kind: 'memory'}>,
  locator?: ApprovedSourceDescriptorV1['locator'],
) {
  if (locator)
    yield* Effect.try({
      try: () =>
        assertApprovedSourceDescriptor({id: automaticMaintenanceEvidenceId(source), source, scope: 'shared', locator}),
      catch: () => fail('Shared source portable locator is malformed.'),
    });
  const uri = locator
    ? `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(locator.teamId)}/${EffectArray.join(EffectArray.map(Effect2.pipe(locator.path, EffectString.split('/')), uriSegment), '/')}`
    : source.uri;
  const baseline = yield* readSharedAutomaticMemoryGitBaseline(config, uri, locator?.teamId, {requireWritable: false});
  if (locator && baseline.repository.repositoryId !== locator.repositoryId)
    return yield* fail('The authorized shared source repository changed.');
  if (
    !source.memoryId ||
    source.memoryId !== baseline.record.metadata.memoryId ||
    source.canonicalHash !== sha256HexSync(canonicalMemoryDocumentContent(baseline.rawContent))
  )
    return yield* fail('Shared source identity or exact canonical revision changed before authorization.');
  yield* Effect.try({
    try: () => assertMemoryMaintenanceFragmentSource({...source, uri}, baseline.record),
    catch: () => fail('Shared source fragment changed before authorization.'),
  });
  return {
    ...baseline,
    uri,
    locator: {repositoryId: baseline.repository.repositoryId, teamId: baseline.team.name, path: baseline.path},
  };
});

/** Capture a portable locator only after an authorized exact committed source read. */
export const authorizeAutomaticSharedMemorySource = Effect.fn('gitProposal.authorizeAutomaticSharedSource')(function* (
  config: RuntimeConfig,
  source: Extract<AutomaticMaintenanceSourceV1, {kind: 'memory'}>,
  locator?: ApprovedSourceDescriptorV1['locator'],
) {
  return (yield* resolveAutomaticSharedMemorySource(config, source, locator)).locator;
});

interface SharedProvenanceSelector {
  readonly uri: string;
  readonly memoryId?: string;
  readonly locator?: ApprovedSourceDescriptorV1['locator'];
}

/** Reauthorize every retained provenance edge; historical revisions never become current support. */
const readAutomaticSharingClosure = Effect.fn('gitProposal.readAutomaticSharingClosure')(function* (
  config: RuntimeConfig,
  finalRecord: MemoryRecord,
) {
  const selectors: SharedProvenanceSelector[] = [];
  const append = (record: MemoryRecord): boolean => {
    for (const relation of record.metadata.relations ?? []) selectors.push({uri: relation.uri});
    const support = record.metadata.reviewedSupport;
    for (const snapshot of [support?.active, support?.initialApproval])
      for (const descriptor of snapshot?.sources ?? []) {
        if (descriptor.source.kind === 'memory')
          selectors.push({
            uri: descriptor.source.uri,
            memoryId: descriptor.source.memoryId,
            locator: descriptor.locator,
          });
      }
    const origin = support?.legacyOrigin;
    for (const relation of origin?.relations ?? []) selectors.push({uri: relation.uri});
    // Already-public sources may still use an old root receipt rather than the new origin attachment.
    for (const stored of [record.metadata.consolidation, origin?.consolidation]) {
      const receipt = stored?.version === 2 ? stored.origin : stored;
      for (const source of receipt?.sources ?? []) {
        if (memoryCodeCitationSharingBlocker({codeCitations: source.codeCitations})) return false;
        selectors.push({uri: source.uri, memoryId: source.memoryId});
        for (const relation of source.relations) selectors.push({uri: relation.uri});
      }
    }
    return true;
  };
  if (memoryCodeCitationContentSharingBlocker(finalRecord.uri, finalRecord.content))
    return yield* fail('The complete approved support contains non-public or malformed provenance.');
  if (!append(finalRecord))
    return yield* fail('The complete approved support contains non-public consolidated provenance.');
  let corpus: readonly MemoryRecord[] | undefined;
  const proofs = new Map<string, {readonly memoryId: string; readonly baseline: ReturnType<typeof baselineKey>}>();
  for (let index = 0; index < selectors.length; index++) {
    if (selectors.length > 4096 || proofs.size > 128)
      return yield* fail('Complete shared provenance exceeds the bounded authorization read budget.');
    const selector = selectors[index];
    let uri = selector.uri;
    let memoryId = selector.memoryId;
    const alias = memoryIdFromIdentityAlias(uri);
    if (alias) {
      corpus ??= yield* readMaintenanceMemoryRecords(config);
      const resolved = resolveRelationTarget(corpus, uri);
      if (
        !resolved.record ||
        (resolved.state !== 'active' && resolved.state !== 'inactive') ||
        !isSharedMemoryUri(resolved.record.uri)
      )
        return yield* fail('A retained relation has no unique currently authorized shared identity.');
      uri = resolved.record.uri;
      memoryId = alias;
    }
    const resource = yield* Effect.try({
      try: () => parseResourceId(uri),
      catch: () => fail('Retained shared provenance has an invalid memory URI.'),
    });
    if (
      resource.canonicalUri !== uri ||
      resource.anchor !== undefined ||
      resource.namespace !== 'user' ||
      resource.segments[1] !== 'memories' ||
      resource.segments[2] !== 'shared' ||
      resource.segments.length < 6
    )
      return yield* fail('Retained provenance is outside an authorized shared memory namespace.');
    const team = selector.locator?.teamId ?? decodeURIComponent(resource.segments[3]);
    const path =
      selector.locator?.path ?? EffectArray.join(EffectArray.map(resource.segments.slice(4), decodeURIComponent), '/');
    const currentUri = `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team)}/${EffectArray.join(EffectArray.map(Effect2.pipe(path, EffectString.split('/')), uriSegment), '/')}`;
    const baseline = yield* readSharedAutomaticMemoryGitBaseline(config, currentUri, team, {
      requireWritable: false,
      historicalProvenance: true,
    }).pipe(
      Effect.catchDefect(cause =>
        Schema.is(ShareOperationError)(cause)
          ? fail('Retained shared provenance is no longer readable through the configured team policy.')
          : Effect.die(cause),
      ),
    );
    const actualId = baseline.record.metadata.memoryId;
    if (
      !actualId ||
      !isMemoryId(actualId) ||
      (memoryId !== undefined && actualId !== memoryId) ||
      (selector.locator && baseline.repository.repositoryId !== selector.locator.repositoryId) ||
      baseline.record.metadata.authority === 'external' ||
      baseline.record.metadata.trust === 'untrusted' ||
      memoryCodeCitationContentSharingBlocker(currentUri, baseline.rawContent)
    )
      return yield* fail('Retained provenance identity, repository, or current public authority changed.');
    const key = `${baseline.repository.repositoryId}\0${baseline.team.name}\0${baseline.path}`;
    const proof = {memoryId: actualId, baseline: baselineKey(baseline)};
    const prior = proofs.get(key);
    if (prior && canonicalJson(prior) !== canonicalJson(proof))
      return yield* fail('Retained shared provenance changed during authorization reads.');
    if (!prior) {
      if (proofs.size >= 128)
        return yield* fail('Complete shared provenance exceeds the bounded authorization read budget.');
      proofs.set(key, proof);
      if (!append(baseline.record))
        return yield* fail('A retained current source contains non-public consolidated provenance.');
    }
  }
  return sha256HexSync(
    canonicalJson(
      [...proofs.entries()].sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right))),
    ),
  );
});

/** Manual author proposal uses the existing private review, with an honest zero-model-call receipt. */
export const proposeSharedTopicMaintenance = Effect.fn('gitProposal.proposeSharedTopic')(function* (
  config: RuntimeConfig,
  input: SharedTopicProposalOptions,
) {
  if (!(yield* Path.Path).isAbsolute(input.sourceCwd)) return yield* fail('Topic sourceCwd must be absolute.');
  if (input.draftFile && input.draftJson) return yield* fail('Choose draftFile or draftJson, not both.');
  const baseline = yield* readSharedTopicGitBaseline(config, input.uri, input.team);
  const baselineProject = baseline.record.metadata.project;
  const baselineTopic = baseline.record.metadata.topic;
  if (baselineProject === undefined || baselineTopic === undefined)
    return yield* fail('The selected shared memory has no project or topic metadata.');
  const openingEpoch = yield* readContextMaintenanceSourceEpoch(config, input.sourceCwd);
  const observed = yield* observeTopicMaintenanceEvidence(config, baseline.record, input.sourceCwd);
  const built = yield* buildTopicMaintenanceEvidencePacket(config, baseline.record, input.sourceCwd, observed);
  const packet = yield* Effect.try({
    try: () => readyEvidence(built),
    catch: cause => fail(String(cause)),
  });
  const basis = yield* Effect.try({try: () => basisFromPacket(packet), catch: cause => fail(String(cause))});
  if ((yield* readContextMaintenanceSourceEpoch(config, input.sourceCwd)) !== openingEpoch)
    return yield* fail('Topic source changed while preparing the manual proposal packet.');
  if (!input.draftFile && input.draftJson === undefined)
    return {origin: 'manual' as const, modelCalls: 0, basis, packet};
  const json = input.draftJson ?? (yield* (yield* FileSystem.FileSystem).readFileString(input.draftFile!));
  const payload = yield* Effect.try({
    try: () =>
      validateTopicMaintenanceReviewPayload({
        version: 1,
        basis,
        proposal: parseTopicMaintenanceDraft(basis, json),
        reviewEvidence: reviewEvidenceFromPacket(packet),
        generation: {
          origin: 'manual',
          agent: 'manual',
          model: 'none',
          promptVersion: 'manual-topic-v1',
          attempts: 0,
          usage: {status: 'unavailable'},
        },
      }),
    catch: cause => fail(cause instanceof Error ? cause.message : 'Invalid canonical manual draft.'),
  });
  const reviewId = `review-${Effect2.pipe(sha256HexSync(`topic-maintenance\0${input.uri}`), EffectString.slice(0, 24))}`;
  const review = yield* withCandidateReviewLock(
    config.agentContextHome,
    reviewId,
    Effect.gen(function* () {
      const prior = yield* loadCandidateReviewOptional(config.agentContextHome, reviewId);
      if (prior && (input.reviewId !== reviewId || input.revision !== prior.revision))
        return yield* fail(
          'The shared topic already has a private review. Echo its exact reviewId and revision to edit it.',
        );
      if (!prior && (input.reviewId !== undefined || input.revision !== undefined))
        return yield* fail('The requested shared topic review is missing.');
      if (prior && (!prior.maintenance || prior.candidates[0]?.state !== 'pending'))
        return yield* fail('Resolve or resume the existing private topic review before proposing an edit.');
      const latest = yield* readSharedTopicGitBaseline(config, input.uri, input.team);
      if (canonicalJson(baselineKey(latest)) !== canonicalJson(baselineKey(baseline)))
        return yield* fail('Shared Git base, target or policy changed during manual proposal preparation.');
      yield* verifyTopicMaintenanceReviewSource(config, latest.record, payload, input.sourceCwd);
      const at = DateTime.formatIso(yield* DateTime.now);
      const next = privateReview(
        prior,
        basis,
        payload,
        baselineProject,
        baselineTopic,
        ['Explicit manual author proposal; zero model calls.'],
        at,
      );
      yield* saveCandidateReview(config.agentContextHome, next);
      return next;
    }),
  );
  const prepared = yield* prepareTopicMaintenanceReview(
    config,
    {reviewId, revision: review.revision, sourceCwd: input.sourceCwd},
    baseline.record,
  );
  const closing = yield* readSharedTopicGitBaseline(config, input.uri, input.team);
  if (canonicalJson(baselineKey(closing)) !== canonicalJson(baselineKey(baseline)))
    return yield* fail('Shared Git base, target or policy changed during approval preview.');
  if (prepared.maintenance === undefined) return yield* fail('The prepared topic maintenance review is unavailable.');
  yield* verifyTopicMaintenanceReviewSource(config, closing.record, prepared.maintenance, input.sourceCwd);
  return {origin: 'manual' as const, modelCalls: 0, review: prepared};
});

export const runSharedTopicProposal = Effect.fn('gitProposal.sharedTopicCommand')(function* (
  config: RuntimeConfig,
  input: SharedTopicProposalOptions,
) {
  yield* Console.log(JSON.stringify(yield* proposeSharedTopicMaintenance(config, input)));
});

/** Caller holds the existing review lock. Preview and approved export use the same exact assembly. */
export const buildReviewedTopicMaintenanceGitProposal = Effect.fn('gitProposal.buildReviewedTopic')(function* (
  config: RuntimeConfig,
  review: CandidateReview,
  options: {
    readonly team?: string;
    readonly sourceCwd?: string;
    readonly approved?: boolean;
    readonly approvalDigest?: string;
    readonly candidateIds: readonly string[];
  },
) {
  const payload = review.maintenance;
  const approval = review.maintenanceApproval;
  if (
    !payload ||
    (payload.version !== 1 && payload.version !== 3) ||
    approval?.stage !== 'preview' ||
    approval.reviewRevision !== review.revision ||
    (payload.version === 1 && !options.sourceCwd)
  )
    return yield* fail(
      'Prepare the exact shared review; legacy code reviews also require sourceCwd before Git proposal preview/export.',
    );
  if (
    options.candidateIds.length > 1 ||
    (options.candidateIds.length === 1 && options.candidateIds[0] !== review.candidates[0]?.candidateId)
  )
    return yield* fail('Select only the exact shared maintenance candidate.');
  const baseline = yield* payload.version === 3
    ? readSharedAutomaticMemoryGitBaseline(config, payload.basis.targetUri, options.team)
    : readSharedTopicGitBaseline(config, payload.basis.targetUri, options.team);
  yield* verifyTopicMaintenanceReviewSource(config, baseline.record, payload, options.sourceCwd);
  const preview = approval.preview;
  const reproduced = yield* Effect.try({
    try: () => {
      const options = {
        reviewId: review.reviewId,
        approvedAt: preview.approvedAt,
        editedDraftJson: JSON.stringify(preview.approvedProposal.draft),
      };
      if (payload.version === 3) {
        if (preview.version !== 3) throw new Error('Automatic review requires its own exact approval preview.');
        return prepareAutomaticMaintenanceAcceptance(baseline.record, payload, options);
      }
      if (preview.version !== 1) throw new Error('Legacy review requires its original exact approval preview.');
      return prepareTopicMaintenanceAcceptance(baseline.record, payload, options);
    },
    catch: cause => fail(cause instanceof Error ? cause.message : 'The exact shared document cannot be reproduced.'),
  });
  if (canonicalJson(reproduced) !== canonicalJson(preview))
    return yield* fail('The stored shared approval differs from the exact reviewed transformation.');
  const finalRecord = parseMemoryDocument(baseline.record.uri, reproduced.content);
  if (!finalRecord) return yield* fail('The exact shared final document is unavailable.');
  const sharingClosureHash =
    payload.version === 3 ? yield* readAutomaticSharingClosure(config, finalRecord) : undefined;
  const built = yield* Effect.try({
    try: () => {
      const input = {
        baseCommit: baseline.repository.headCommit,
        baseBranch: baseline.repository.branch ?? null,
        target: {repositoryId: baseline.repository.repositoryId, team: baseline.team.name},
        path: baseline.path,
        record: baseline.record,
        rawContent: baseline.rawContent,
        review,
        prepared: reproduced,
        access: 'read-write' as const,
      };
      return payload.version === 3
        ? buildAutomaticMaintenanceGitProposal({...input, sharingClosureHash: sharingClosureHash!})
        : buildTopicMaintenanceGitProposal(input);
    },
    catch: cause => fail(cause instanceof Error ? cause.message : 'Invalid shared maintenance proposal.'),
  });
  const closing = yield* payload.version === 3
    ? readSharedAutomaticMemoryGitBaseline(config, payload.basis.targetUri, options.team)
    : readSharedTopicGitBaseline(config, payload.basis.targetUri, options.team);
  if (canonicalJson(baselineKey(closing)) !== canonicalJson(baselineKey(baseline)))
    return yield* fail('Shared Git base, target or policy changed during proposal export.');
  yield* verifyTopicMaintenanceReviewSource(config, closing.record, review.maintenance, options.sourceCwd);
  if (payload.version === 3 && (yield* readAutomaticSharingClosure(config, finalRecord)) !== sharingClosureHash)
    return yield* fail('Retained provenance source, repository, or access policy changed during proposal export.');
  if (options.approved === true && options.approvalDigest !== built.proposal.proposalHash)
    return yield* fail(
      'Shared maintenance export requires the exact preview proposalHash as approvalDigest. Review the complete Git artifact again.',
    );
  return built;
});

export const verifyTopicMaintenanceMaterialization = Effect.fn('gitProposal.verifyTopicMaterialization')(function* (
  config: RuntimeConfig,
  proposal: TopicMaintenanceGitProposalV2 | AutomaticMaintenanceGitProposalV3,
  options: {readonly sourceCwd?: string; readonly team?: string},
) {
  const review = yield* loadCandidateReviewOptional(config.agentContextHome, proposal.knowledgeDelta.reviewId);
  if (!review || review.revision !== proposal.knowledgeDelta.expectedRevision)
    return yield* fail('Shared maintenance private review is missing or its revision changed.');
  const built = yield* buildReviewedTopicMaintenanceGitProposal(config, review, {
    ...options,
    candidateIds: [proposal.files[0].approval.candidateId],
  });
  if (canonicalJson(built.proposal) !== canonicalJson(proposal))
    return yield* fail(
      'Shared maintenance Git base, approval, target, source or policy changed. Prepare a new preview.',
    );
});

function baselineKey(baseline: Effect.Success<ReturnType<typeof readSharedTopicGitBaseline>>) {
  return {
    commit: baseline.repository.headCommit,
    branch: baseline.repository.branch ?? null,
    repositoryId: baseline.repository.repositoryId,
    path: baseline.path,
    rawHash: sha256HexSync(baseline.rawContent),
    canonicalHash: sha256HexSync(canonicalMemoryDocumentContent(baseline.rawContent)),
    team: baseline.team.name,
    access: shareTeamAccess(baseline.team.config),
  };
}

function fail(message: string) {
  return MemoryOperationError.make({message});
}
