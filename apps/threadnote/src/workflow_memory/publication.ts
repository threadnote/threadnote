import {Context, Crypto, DateTime, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {workflowMemoryStem} from '@threadnote/workflow-automations/naming';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readAnonymousTelemetryDiagnostic} from '../telemetry/diagnostic.js';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {cursorCloudMemoryRoot} from '../cursor/cloud.js';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {normalizeMemoryRelationInputs, resolveAuthoredMemoryRelations} from '../memory/relations.js';
import {
  prepareCursorCloudSharedMemory,
  writeCursorCloudSharedMemory,
  type PreparedSharedMemoryWrite,
} from '../mcp/server/memory.js';
import {resolveTeam, resourceUriToWorktreeRelative} from '../share/core.js';
import {
  assertShareGitPublicationImages,
  assertShareGitPublicationTarget,
  type ShareGitPublicationReceipt,
} from '../share/git.js';
import {loadWorkflowJournal, readOptionalResource} from './journal.js';
import {
  requiredText,
  stableJson,
  workflowError,
  WorkflowMemoryError,
  type WorkflowBinding,
  type WorkflowJournal,
} from './protocol.js';
import {
  assertPublicationText,
  normalizePublicationNodes,
  publicationDigest,
  PublicationWriterReasonSchema,
  publicationPreview,
  WorkflowPublicationRequestSchema,
  type PublicationIntent,
  type PublicationJournal,
  type PublicationNode,
  type PublicationProgress,
  type PublicationStage,
  type WorkflowPublicationRequest,
} from './publication_contract.js';

const invalidProjection = (cause: unknown) =>
  Schema.is(WorkflowMemoryError)(cause)
    ? cause
    : workflowError(
        'invalid-publication-graph',
        cause instanceof Error ? cause.message : 'Publication projection is invalid.',
      );

const nativeWriterErrorCodes = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EIO',
  'EISDIR',
  'EINVAL',
  'ENAMETOOLONG',
  'ENETUNREACH',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPIPE',
  'EROFS',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPERM',
]);
// Only fixed share/git.ts diagnostics may cross this privacy boundary.
const pendingWriterReason = (text: string | undefined): typeof PublicationWriterReasonSchema.Type | undefined => {
  if (text === 'Shared publication commit content changed.') return 'commit-content-changed';
  if (text?.startsWith('Shared commit readback failed:')) return 'commit-readback-failed';
  if (text?.startsWith('Shared publication verification failed:')) return 'git-verification-failed';
  if (text?.startsWith('git commit failed:')) return 'git-commit-failed';
  return undefined;
};
const pendingWriterCause = (result: {
  readonly isError?: boolean;
  readonly content?: readonly {readonly type: string; readonly text?: string}[];
}) => {
  const diagnostic = readAnonymousTelemetryDiagnostic(result);
  const boundedErrorCode = result.content
    ?.filter(item => item.type === 'text')
    .flatMap(item => item.text?.match(/\bE[A-Z0-9]{2,12}\b/gu) ?? [])
    .find(code => nativeWriterErrorCodes.has(code));
  const reason = result.content
    ?.filter(item => item.type === 'text')
    .map(item => pendingWriterReason(item.text))
    .find(value => value !== undefined);
  return {
    kind: 'shared-writer-error' as const,
    errorType: diagnostic?.errorType ?? 'UnknownError',
    ...(boundedErrorCode ? {nativeCode: boundedErrorCode} : {}),
    ...(reason ? {reason} : {}),
  };
};

const publicationScope = (binding: WorkflowBinding) => {
  if (binding.profile === 'desktop' || !binding.team || !binding.remote || !binding.branch)
    throw workflowError('unsupported-profile', 'Approved Git publication requires a bound personal cloud share.');
  const root = cursorCloudMemoryRoot(binding.user, binding.team);
  if (!binding.sharedRoots.includes(root))
    throw workflowError('binding-drift', 'The publication share is outside this workflow binding.');
  return {team: binding.team, root};
};
const assertSourceCommit = Effect.fn('workflowPublication.sourceCommit')(function* (
  binding: WorkflowBinding,
  expected: string,
) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(expected))
    return yield* workflowError('invalid-source-commit', 'Publication requires the full current source commit.');
  const head = (yield* runCommandEffect('git', ['-C', binding.repo, 'rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (head !== expected)
    return yield* workflowError(
      'publication-source-changed',
      'Source HEAD changed; review and approve a new publication preview.',
    );
});

const publicationFile = Effect.fn('workflowPublication.file')(function* (config: RuntimeConfig, bindingId: string) {
  if (!/^[a-f0-9]{64}$/u.test(bindingId)) return yield* workflowError('invalid-binding', 'Invalid binding identifier.');
  return (yield* Path.Path).join(config.agentContextHome, 'workflow-memory', `${bindingId}.publication.json`);
});
const journalContent = Effect.fn('workflowPublication.journalContent')(function* (journal: PublicationJournal) {
  const content = `${stableJson(journal)}\n`;
  if (new TextEncoder().encode(content).byteLength > 16 * 1024 * 1024)
    return yield* workflowError(
      'publication-journal-full',
      'Publication intent exceeds the private journal capacity; narrow the approved graph before publishing.',
    );
  return content;
});
const readPublication = Effect.fn('workflowPublication.readJournal')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* publicationFile(config, binding.bindingId);
  if (!(yield* fs.exists(file))) return undefined;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* workflowError('unsafe-journal', 'Publication journals cannot be symbolic links.');
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > 16 * 1024 * 1024)
    return yield* workflowError('invalid-journal', 'Publication journal is not a bounded regular file.');
  const content = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: () => {
      const journal = JSON.parse(content) as PublicationJournal;
      if (
        journal.intent.version !== 1 ||
        journal.intent.bindingId !== binding.bindingId ||
        publicationDigest(journal.intent) !== journal.approvalDigest ||
        !journal.progress ||
        journal.intent.stages.length < 1 ||
        journal.intent.stages.length > 3
      )
        throw workflowError('invalid-journal', 'Publication intent is invalid.');
      normalizePublicationNodes(journal.intent.nodes.map(node => node.input));
      const scope = publicationScope(binding);
      for (const stage of journal.intent.stages) {
        const record = parseMemoryDocument(stage.prepared.memoryUri, stage.prepared.memory);
        if (
          !record ||
          record.metadata.kind !== 'durable' ||
          record.metadata.visibility !== 'shared' ||
          !journal.intent.nodes.some(
            node => node.input.key === stage.nodeKey && node.prepared.memoryUri === stage.prepared.memoryUri,
          )
        )
          throw workflowError('invalid-journal', 'Publication stage is invalid.');
        assertPublicationText(record.body, binding, scope.root);
      }
      return journal;
    },
    catch: () => workflowError('invalid-journal', 'Publication task state is invalid; restore the original journal.'),
  });
});
const writePublication = Effect.fn('workflowPublication.writeJournal')(function* (
  config: RuntimeConfig,
  journal: PublicationJournal,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* publicationFile(config, journal.intent.bindingId);
  const content = yield* journalContent(journal);
  const directory = path.dirname(file);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  if (
    Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)) ||
    Option.isSome(yield* fs.readLink(file).pipe(Effect.option))
  )
    return yield* workflowError('unsafe-journal', 'Publication journals cannot be symbolic links.');
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.tmp`;
  yield* fs.writeFileString(temporary, content, {mode: 0o600});
  yield* fs.rename(temporary, file).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

const captureCitations = Effect.fn('workflowPublication.captureCitations')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  refs: readonly string[],
  sourceCommit: string,
  planOnly: boolean,
) {
  const citations = yield* captureMemoryCodeCitations(config, {
    callerCwd: binding.repo,
    project: binding.project,
    refs,
    planOnly,
  });
  const blocker = memoryCodeCitationSharingBlocker({codeCitations: citations});
  if (blocker)
    return yield* workflowError('publication-citations-blocked', memoryCodeCitationSharingBlockerMessage(blocker));
  if (citations.some(citation => citation.sourceCommit !== sourceCommit))
    return yield* workflowError(
      'publication-source-changed',
      'All shared citations must describe the approved current source commit.',
    );
  return citations;
});
const preparedWithRelations = (
  prepared: PreparedSharedMemoryWrite,
  body: string,
  relations: readonly MemoryRelation[],
  before?: string,
) => {
  const finalMetadata = {...prepared.finalMetadata, relations};
  return {
    ...prepared,
    finalMetadata,
    memory: formatMemoryDocument('MEMORY', finalMetadata, body),
    ...(before === undefined ? {} : {expectedReplaceContent: before}),
  };
};
const nodeTarget = (node: PublicationNode, prepared = node.prepared, root: string) => ({
  uri: prepared.memoryUri,
  content: prepared.memory,
  memoryId: prepared.finalMetadata.memoryId,
  allowedUriScopes: [root],
});

const preparePublication = Effect.fn('workflowPublication.prepare')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  request: Extract<WorkflowPublicationRequest, {action: 'publication-preview'}>,
  existing: PublicationJournal | undefined,
) {
  const scope = yield* Effect.try({try: () => publicationScope(binding), catch: invalidProjection});
  yield* assertSourceCommit(binding, request.sourceCommit);
  const inputs = yield* Effect.try({
    try: () => normalizePublicationNodes(request.graph.nodes),
    catch: invalidProjection,
  });
  const requestDigest = sha256HexSync(
    stableJson({bindingId: binding.bindingId, sourceCommit: request.sourceCommit, nodes: inputs}),
  );
  if (existing?.intent.requestDigest === requestDigest) {
    const validation = yield* revalidateCitations(config, binding, existing.intent, true).pipe(Effect.result);
    if (validation._tag === 'Success') return existing;
    if (
      !Schema.is(WorkflowMemoryError)(validation.failure) ||
      validation.failure.code !== 'publication-citations-changed'
    )
      return yield* validation.failure;
  }
  if (existing && Object.keys(existing.progress).length > 0)
    return yield* workflowError(
      'publication-intent-conflict',
      'Publication has started; resume its exact approved graph before starting another.',
    );
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  const nodes: PublicationNode[] = [];
  for (const input of inputs) {
    yield* Effect.try({
      try: () => {
        assertPublicationText(input.body, binding, scope.root);
        for (const ref of input.codeRefs) assertPublicationText(ref, binding, scope.root);
        for (const relation of input.relations)
          if (relation.uri) assertPublicationText(relation.uri, binding, scope.root);
      },
      catch: invalidProjection,
    });
    const citations = yield* captureCitations(config, binding, input.codeRefs, request.sourceCommit, true);
    const external = yield* resolveAuthoredMemoryRelations(
      config,
      input.relations.flatMap(relation => (relation.uri ? [{type: relation.type, uri: relation.uri}] : [])),
      {allowedUriScopes: [scope.root]},
    );
    const topic = yield* Effect.try({
      try: () =>
        binding.naming
          ? workflowMemoryStem(binding.naming, input.topic)
          : `${input.topic}-${binding.bindingId.slice(0, 16)}`,
      catch: invalidProjection,
    });
    const prepared = yield* prepareCursorCloudSharedMemory(config, scope, {
      operation: 'create',
      bodyText: input.body,
      metadata: {
        kind: 'durable',
        status: 'active',
        project: binding.project,
        topic,
        timestamp,
        memoryId: `tn_${sha256HexSync(`${binding.bindingId}\n${input.key}`).slice(0, 20)}`,
        sourceAgentClient: 'threadnote',
        codeCitations: citations,
        relations: external.relations,
      },
    });
    if ((yield* readOptionalResource(config, prepared.memoryUri)) !== undefined)
      return yield* workflowError(
        'publication-target-exists',
        'A publication destination already exists outside this approved run.',
      );
    nodes.push({input, prepared, citations, externalTargets: external.targets});
  }
  if (new Set(nodes.map(node => node.prepared.memoryUri)).size !== nodes.length)
    return yield* workflowError(
      'invalid-publication-graph',
      'Publication node topics must select distinct destinations.',
    );
  const finalNodes = yield* Effect.try({
    try: () =>
      nodes.map(node => {
        const relations = [...(node.prepared.finalMetadata.relations ?? [])];
        for (const relation of node.input.relations)
          if (relation.nodeKey) {
            const target = nodes.find(item => item.input.key === relation.nodeKey)!;
            relations.push({
              type: relation.type as MemoryRelation['type'],
              uri: memoryIdentityAlias(target.prepared.finalMetadata.memoryId!),
            });
          }
        if (nodes.length === 2 && !node.input.relations.some(relation => relation.nodeKey)) {
          const other = nodes.find(item => item !== node)!;
          relations.push({type: 'references', uri: memoryIdentityAlias(other.prepared.finalMetadata.memoryId!)});
        }
        return {
          ...node,
          prepared: preparedWithRelations(node.prepared, node.input.body, normalizeMemoryRelationInputs(relations)),
        };
      }),
    catch: invalidProjection,
  });
  const stages: PublicationStage[] = [];
  if (finalNodes.length === 1) {
    const node = finalNodes[0];
    stages.push({
      key: `${node.input.key}:create`,
      nodeKey: node.input.key,
      operation: 'create',
      prepared: node.prepared,
      sources: node.externalTargets,
    });
  } else {
    const architecture = finalNodes.find(node => node.input.role === 'architecture')!;
    const spec = finalNodes.find(node => node.input.role === 'spec')!;
    const architectureInitial = nodes.find(node => node.input.key === architecture.input.key)!.prepared;
    stages.push({
      key: `${architecture.input.key}:create`,
      nodeKey: architecture.input.key,
      operation: 'create',
      prepared: architectureInitial,
      sources: architecture.externalTargets,
    });
    stages.push({
      key: `${spec.input.key}:create`,
      nodeKey: spec.input.key,
      operation: 'create',
      prepared: spec.prepared,
      sources: [...spec.externalTargets, nodeTarget(architecture, architectureInitial, scope.root)],
    });
    stages.push({
      key: `${architecture.input.key}:final`,
      nodeKey: architecture.input.key,
      operation: 'replace',
      prepared: {...architecture.prepared, expectedReplaceContent: architectureInitial.memory},
      sources: [...architecture.externalTargets, nodeTarget(spec, spec.prepared, scope.root)],
    });
  }
  const intent: PublicationIntent = {
    version: 1,
    bindingId: binding.bindingId,
    sourceCommit: request.sourceCommit,
    requestDigest,
    nodes: finalNodes,
    stages,
  };
  const selected = yield* resolveTeam(config, scope.team);
  yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      yield* assertShareGitPublicationTarget(selected.config.worktree, binding.remote!, binding.branch!);
      for (const node of finalNodes)
        yield* assertShareGitPublicationImages(
          selected.config.worktree,
          resourceUriToWorktreeRelative(config, node.prepared.memoryUri, scope.team),
          undefined,
          node.prepared.memory,
          false,
        );
    }),
  );
  yield* assertSourceCommit(binding, request.sourceCommit);
  const journal: PublicationJournal = {intent, approvalDigest: publicationDigest(intent), progress: {}};
  yield* writePublication(config, journal);
  return journal;
});

const revalidateCitations = Effect.fn('workflowPublication.revalidateCitations')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  intent: PublicationIntent,
  planOnly: boolean,
) {
  yield* assertSourceCommit(binding, intent.sourceCommit);
  for (const node of intent.nodes) {
    const current = yield* captureCitations(config, binding, node.input.codeRefs, intent.sourceCommit, planOnly);
    if (stableJson(current) !== stableJson(node.citations))
      return yield* workflowError(
        'publication-citations-changed',
        'Current source citations differ from the approved preview; review a new preview.',
      );
  }
  yield* assertSourceCommit(binding, intent.sourceCommit);
});

/** One fetched remote HEAD must contain every exact final node and external relation target. */
const verifyFinalGraph = Effect.fn('workflowPublication.verifyFinalGraph')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  journal: PublicationJournal,
) {
  const scope = yield* Effect.try({try: () => publicationScope(binding), catch: invalidProjection});
  const selected = yield* resolveTeam(config, scope.team);
  return yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      yield* assertShareGitPublicationTarget(selected.config.worktree, binding.remote!, binding.branch!);
      const git = (args: readonly string[]) => runCommandEffect('git', ['-C', selected.config.worktree, ...args]);
      yield* git(['fetch', '--no-tags', 'origin', `refs/heads/${binding.branch!}`]);
      const remoteCommit = (yield* git(['rev-parse', '--verify', 'FETCH_HEAD'])).stdout.trim();
      const results = [];
      for (const node of journal.intent.nodes) {
        const final = [...journal.intent.stages].reverse().find(stage => stage.nodeKey === node.input.key)!;
        const receipt = journal.progress[final.key]?.verified;
        const path = resourceUriToWorktreeRelative(config, node.prepared.memoryUri, scope.team);
        if (
          !receipt ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(receipt.commit) ||
          receipt.remote !== binding.remote ||
          receipt.branch !== binding.branch ||
          receipt.path !== path ||
          receipt.contentHash !== sha256HexSync(node.prepared.memory)
        )
          return yield* workflowError(
            'publication-incomplete',
            'Every final node needs its own verified Git commit receipt.',
          );
        yield* git(['merge-base', '--is-ancestor', receipt.commit, remoteCommit]);
        const remoteContent = (yield* git(['show', `${remoteCommit}:${path}`])).stdout;
        if (
          remoteContent !== node.prepared.memory ||
          (yield* readOptionalResource(config, node.prepared.memoryUri)) !== node.prepared.memory
        )
          return yield* workflowError(
            'publication-readback-conflict',
            'A final native or remote document changed after publication.',
          );
        const relations = yield* resolveAuthoredMemoryRelations(config, node.prepared.finalMetadata.relations ?? [], {
          allowedUriScopes: [scope.root],
          sourceMemoryId: node.prepared.finalMetadata.memoryId,
          sourceUri: node.prepared.memoryUri,
        });
        if (stableJson(relations.relations ?? []) !== stableJson(node.prepared.finalMetadata.relations ?? []))
          return yield* workflowError(
            'publication-readback-conflict',
            'Final relation identity changed after publication.',
          );
        for (const target of node.externalTargets) {
          const approved = parseMemoryDocument(target.uri, target.content);
          if (
            !resourceIdIsWithin(target.uri, scope.root) ||
            !approved ||
            approved.metadata.status !== 'active' ||
            approved.metadata.memoryId !== target.memoryId ||
            (yield* readOptionalResource(config, target.uri)) !== target.content
          )
            return yield* workflowError(
              'publication-readback-conflict',
              'An approved external relation target changed or left the configured share.',
            );
          const targetPath = resourceUriToWorktreeRelative(config, target.uri, scope.team);
          const remote = yield* git(['show', `${remoteCommit}:${targetPath}`]).pipe(Effect.result);
          if (remote._tag === 'Failure' || remote.success.stdout !== target.content)
            return yield* workflowError(
              'publication-readback-conflict',
              'The approved external relation graph is missing or changed at the verified remote HEAD.',
            );
        }
        results.push({
          key: node.input.key,
          canonicalUri: node.prepared.memoryUri,
          revision: sha256HexSync(canonicalMemoryDocumentContent(node.prepared.memory)),
          bodySha256: sha256HexSync(node.input.body),
        });
      }
      return {
        protocolVersion: 1 as const,
        status: 'ok' as const,
        approvalDigest: journal.approvalDigest,
        verifiedReadback: true as const,
        remoteCommit,
        nodes: results,
      };
    }),
  );
});

/** Caller holds the workflow run lock, never the shared-repository lock. */
export const runWorkflowPublication = Effect.fn('workflowPublication.run')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  input: unknown,
) {
  const request = yield* Schema.decodeUnknownEffect(WorkflowPublicationRequestSchema)(input, {
    onExcessProperty: 'error',
  });
  const binding = state.binding;
  if (request.bindingId !== binding.bindingId)
    return yield* workflowError('binding-drift', 'Publication binding differs from the loaded workflow.');
  const scope = yield* Effect.try({try: () => publicationScope(binding), catch: invalidProjection});
  let journal = yield* readPublication(config, binding);
  if (request.action === 'publication-preview')
    return publicationPreview(yield* preparePublication(config, binding, request, journal));
  if (!journal || request.approvalDigest !== journal.approvalDigest)
    return yield* workflowError(
      'publication-approval-changed',
      'Review the current exact publication preview before approving or publishing.',
    );
  yield* assertSourceCommit(binding, journal.intent.sourceCommit);
  if (request.action === 'publication-approve') {
    const approvalEvidence = yield* Effect.try({
      try: () => requiredText(request.approvalEvidence, 'approvalEvidence'),
      catch: invalidProjection,
    });
    journal = {...journal, decision: request.decision, approvalEvidence};
    yield* writePublication(config, journal);
    return {
      protocolVersion: 1 as const,
      status: 'ok' as const,
      approvalDigest: journal.approvalDigest,
      decision: journal.decision,
    };
  }
  if (journal.decision !== 'approve' || !journal.approvalEvidence)
    return yield* workflowError(
      'publication-approval-required',
      'Concrete approval of this exact publication preview is required.',
    );
  // Reserve every remaining receipt before any native mutation. A write that
  // fits the prepared state must also fit its largest committed/verified state.
  const finalProgress = Object.fromEntries(
    journal.intent.stages.map(stage => {
      const receipt = {
        version: 1 as const,
        commit: 'f'.repeat(64),
        remote: binding.remote!,
        branch: binding.branch!,
        path: resourceUriToWorktreeRelative(config, stage.prepared.memoryUri, scope.team),
        contentHash: 'f'.repeat(64),
      };
      const verified = {...receipt, remoteCommit: 'f'.repeat(64), verified: true as const};
      return [stage.key, {started: true as const, committed: verified, verified}];
    }),
  );
  yield* journalContent({...journal, progress: finalProgress});
  yield* revalidateCitations(config, binding, journal.intent, false);
  const journalServices = yield* Effect.context<Effect.Services<ReturnType<typeof writePublication>>>();
  for (const stage of journal.intent.stages) {
    if (journal.progress[stage.key]?.verified) continue;
    yield* assertSourceCommit(binding, journal.intent.sourceCommit);
    const node = journal.intent.nodes.find(item => item.input.key === stage.nodeKey)!;
    const previous: PublicationProgress | undefined = journal.progress[stage.key];
    journal = {...journal, progress: {...journal.progress, [stage.key]: {...previous, started: true}}};
    yield* writePublication(config, journal);
    const result = yield* writeCursorCloudSharedMemory(config, scope, {
      operation: stage.operation,
      bodyText: node.input.body,
      metadata: stage.prepared.finalMetadata,
      ...(stage.operation === 'replace'
        ? {
            replaceUri: stage.prepared.memoryUri,
            expectedReplaceContent: stage.prepared.expectedReplaceContent,
            expectedReplaceMemoryId: stage.prepared.finalMetadata.memoryId,
            expectedReplaceContentHash: sha256HexSync(
              canonicalMemoryDocumentContent(stage.prepared.expectedReplaceContent!),
            ),
          }
        : {}),
      expectedSourceContent: stage.sources,
      sharedPublication: {
        prepared: stage.prepared,
        expectedRemote: binding.remote!,
        expectedBranch: binding.branch!,
        resume: previous?.started === true,
        committed: previous?.committed,
        onCommitted: receipt =>
          Effect.gen(function* () {
            journal = {...journal!, progress: {...journal!.progress, [stage.key]: {started: true, committed: receipt}}};
            yield* writePublication(config, journal);
          }).pipe(Effect.provide(journalServices)),
      },
    });
    if (result.isError || !result.structuredContent?.publication) {
      const writerCause = result.isError ? pendingWriterCause(result) : undefined;
      const cause = writerCause ?? {kind: 'publication-receipt-missing' as const};
      return {
        protocolVersion: 1 as const,
        status: 'pending' as const,
        approvalDigest: journal.approvalDigest,
        stage: stage.key.slice(0, 128),
        committed: journal.progress[stage.key]?.committed,
        cause,
        message: writerCause
          ? `The shared writer returned ${writerCause.errorType}${writerCause.nativeCode ? ` (${writerCause.nativeCode})` : ''}${writerCause.reason ? ` [${writerCause.reason}]` : ''}.`
          : 'The shared writer returned no publication receipt.',
      };
    }
    const receipt = result.structuredContent.publication as ShareGitPublicationReceipt;
    journal = {
      ...journal,
      progress: {...journal.progress, [stage.key]: {started: true, committed: receipt, verified: receipt}},
    };
    yield* writePublication(config, journal);
  }
  yield* revalidateCitations(config, binding, journal.intent, true);
  return yield* verifyFinalGraph(config, binding, journal);
});

/** Parent cloud archive admission calls this under its already-held workflow lock. */
export const assertWorkflowPublicationVerified = Effect.fn('workflowPublication.assertVerified')(function* (
  config: RuntimeConfig,
  bindingId: string,
) {
  const state = yield* loadWorkflowJournal(config, bindingId);
  const journal = yield* readPublication(config, state.binding);
  if (!journal || journal.decision !== 'approve' || !journal.approvalEvidence)
    return yield* workflowError(
      'publication-incomplete',
      'Keep private drafts until approved durable publication is verified.',
    );
  yield* revalidateCitations(config, state.binding, journal.intent, true);
  return yield* verifyFinalGraph(config, state.binding, journal);
});

/** Internal coordinated closeout authority; never accepted from a CLI request. */
export const CurrentWorkflowArchivePublication = Context.Reference<
  {readonly bindingId: string; readonly approvalDigest: string} | undefined
>('threadnote/WorkflowArchivePublication', {defaultValue: () => undefined});

export const assertWorkflowArchivePublication = Effect.fn('workflowPublication.assertArchive')(function* (
  config: RuntimeConfig,
  binding: import('./protocol.js').WorkflowBinding,
) {
  const approval = yield* CurrentWorkflowArchivePublication;
  const publishing = approval ? (yield* loadWorkflowJournal(config, approval.bindingId)).binding : binding;
  if (
    publishing.home !== binding.home ||
    publishing.repo !== binding.repo ||
    publishing.project !== binding.project ||
    publishing.featureId !== binding.featureId ||
    publishing.profile !== binding.profile ||
    publishing.team !== binding.team ||
    stableJson(publishing.sharedRoots) !== stableJson(binding.sharedRoots)
  )
    return yield* workflowError(
      'publication-binding-drift',
      'Publication does not authorize this feature and destination.',
    );
  const verified = yield* assertWorkflowPublicationVerified(config, publishing.bindingId);
  if (approval && verified.approvalDigest !== approval.approvalDigest)
    return yield* workflowError('publication-approval-changed', 'The approved closeout publication changed.');
  return verified;
});
