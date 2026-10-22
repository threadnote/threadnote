import {Effect, FileSystem, Option, Path, Result} from 'effect';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  resolveAutomaticSharedMemorySource,
  authorizeAutomaticSharedMemorySource,
} from '../../git_proposal/topic_maintenance_commands.js';
import type {ApprovedSourceDescriptorV1} from '@threadnote/memory/reviewed-support';
import {readSeedManifest, uriSegment} from '@threadnote/workspace/manifest';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {verifyAuthoredMemoryRelationTargetIdentities} from '../relations.js';
import {expandPath} from '@threadnote/platform/paths';
import {
  isAgentArtifactUri,
  isSharedMemoryUri,
  MAX_MEMORY_RELATIONS,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {MAX_MEMORY_CODE_CITATIONS} from '@threadnote/memory/code/citation';
import {
  automaticMaintenanceEvidenceId,
  automaticMaintenanceMemoryScope,
  automaticMaintenanceSections,
  MAX_AUTOMATIC_MAINTENANCE_V2_EVIDENCE,
  type AutomaticMaintenanceEvidenceV1,
} from '@threadnote/memory/automatic-maintenance';
import {
  MAX_CONSOLIDATION_SOURCES,
  validateConsolidationProvenance,
  validateConsolidationProvenanceV2,
} from '@threadnote/memory/consolidation';
import {prepareMemoryMaintenanceBasis, memoryMaintenanceFragmentSource} from '@threadnote/context/memory_maintenance';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {captureMemoryCodeCitations, memoryCodeCitationProjectScopeReceipt} from '@threadnote/context/citation/capture';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  captureAutomaticCurrentSymbol,
  automaticSymbolSelectorKey,
  automaticSupportedSymbolMatchesExcerpt,
} from './maintenance_code_capture.js';
import {resolveRelationTarget, resolveMaintenanceRelationPolicy} from './maintenance_policy.js';
import {
  readContextMaintenanceCanonicalRecord,
  type prepareContextMaintenanceInventory,
} from './maintenance_inventory.js';
import {
  AUTOMATIC_PREPARATION_MAPPER,
  AUTOMATIC_PREPARATION_V2_MAX_CANDIDATES,
  selectAutomaticPreparationUris,
  readAutomaticPreparationCursor,
  writeAutomaticPreparationCursor,
  writeAutomaticPreparationFailure,
  writePreparedMemory,
  AutomaticPreparationError,
  type PreparedMemoryV1,
} from './maintenance_preparation_state.js';

type InventorySnapshot = Effect.Success<ReturnType<typeof prepareContextMaintenanceInventory>>;
type Candidate = PreparedMemoryV1['candidates'][number];
type Read = PreparedMemoryV1['reads'][number];
const hash = (value: unknown) => sha256HexSync(JSON.stringify(value));
const RELATED_SOURCE_BUDGET = 8;

/** Match public memory reads, narrowed to the already eligible team for a shared target. */
export function automaticMemorySourceUriScopes(config: RuntimeConfig, record: MemoryRecord): readonly string[] {
  const root = `threadnote://user/${uriSegment(config.user)}/memories`;
  return [isSharedMemoryUri(record.uri) ? `${root}/shared/${record.uri.split('/shared/')[1].split('/')[0]}` : root];
}

/** Meaning-bearing policy only: incidental timestamps and other assessments cannot recursively churn support. */
export function automaticPreparationMemoryContext(record: MemoryRecord) {
  const m = record.metadata;
  return {
    uri: record.uri,
    memoryId: m.memoryId,
    kind: m.kind,
    status: m.status,
    project: m.project,
    schemaVersion: m.schemaVersion,
    authority: m.authority,
    trust: m.trust,
    visibility: m.visibility,
    owner: m.owner,
    validFrom: m.validFrom,
    validTo: m.validTo,
    workspaceScope: m.workspaceScope,
    citationErrors: m.citationErrors,
    consolidationError: m.consolidationError,
    topicMaintenanceError: m.topicMaintenanceError,
    sourceEvidenceError: m.sourceEvidenceError,
    obsidianEvidenceError: m.obsidianEvidenceError,
    supersedes: m.supersedes,
  };
}

function preservedOrigin(record: MemoryRecord): PreparedMemoryV1['origin'] {
  const receipt = record.metadata.consolidation;
  if (!receipt) return undefined;
  if (receipt.version === 2) validateConsolidationProvenanceV2(receipt, record.body);
  else validateConsolidationProvenance(receipt, record.body);
  return {receiptHash: hash(receipt), receipt};
}

function reviewedOriginSupports(origin: PreparedMemoryV1['origin']) {
  const receipt = origin?.receipt.version === 2 ? origin.receipt.origin : origin?.receipt;
  return (
    receipt?.reviews
      .flatMap(review => review.supports)
      .sort((a, b) => a.sourceUri.localeCompare(b.sourceUri) || a.fragment - b.fragment) ?? []
  );
}

function codeRelevantRevision(candidates: readonly Candidate[], evidenceId: string, symbol: boolean) {
  return candidates
    .flatMap(candidate => {
      const excerpt = candidate.excerpt;
      if (candidate.evidenceId !== evidenceId || excerpt?.provenance !== 'current-verified') return [];
      return [
        {
          repositoryId: excerpt.source.repositoryId,
          path: excerpt.source.path,
          sourceDirty: excerpt.source.sourceDirty,
          // A bounded prefix cannot prove unchanged cited support; use the already verified full file hash.
          contentHash:
            symbol && !excerpt.truncated && excerpt.supportsCitation ? excerpt.excerptHash : excerpt.fileBytesHash,
          truncated: excerpt.truncated,
          supportsCitation: excerpt.supportsCitation,
        },
      ];
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Pure projection. Exact text reuse is a provisional mapping; relations and search ranks never imply entailment. */
export function prepareAutomaticMemory(
  record: MemoryRecord,
  input: {
    readonly sources?: readonly MemoryRecord[];
    readonly evidence?: readonly AutomaticMaintenanceEvidenceV1[];
    readonly candidates?: readonly Candidate[];
    readonly reads?: readonly Read[];
    readonly scopeRevision: string;
    readonly searchedScopes?: readonly string[];
    readonly omissions?: readonly string[];
    readonly omittedSources?: number;
  },
): PreparedMemoryV1 {
  const omissions = [...(input.omissions ?? [])];
  let omittedSources = input.omittedSources ?? 0;
  const origin = preservedOrigin(record);
  const originSupports = reviewedOriginSupports(origin);
  const originUris = new Set(originSupports.map(support => support.sourceUri));
  const evidence = [...prepareMemoryMaintenanceBasis(record).assessment.evidence];
  for (const item of input.evidence ?? []) {
    const index = evidence.findIndex(prior => prior.id === item.id);
    if (index < 0) evidence.push(item);
    else evidence[index] = item;
  }
  const candidates = [...(input.candidates ?? [])];
  const evidenceBudget = record.metadata.reviewedSupport
    ? MAX_AUTOMATIC_MAINTENANCE_V2_EVIDENCE
    : MAX_MEMORY_CODE_CITATIONS;
  const candidateBudget = record.metadata.reviewedSupport ? AUTOMATIC_PREPARATION_V2_MAX_CANDIDATES : 16;
  const sourceContexts: unknown[] = [];
  const sections = automaticMaintenanceSections(record.body);
  if (!sections) omissions.push('target-paragraph-bounds');
  for (const source of [...(input.sources ?? [])].sort(
    (a, b) => Number(originUris.has(b.uri)) - Number(originUris.has(a.uri)) || a.uri.localeCompare(b.uri),
  )) {
    const sourceSections = automaticMaintenanceSections(source.body);
    if (!sourceSections) {
      omissions.push('source-paragraph-bounds');
      omittedSources++;
      continue;
    }
    sourceContexts.push(automaticPreparationMemoryContext(source));
    const preferred: number[] = [];
    const receipt = origin?.receipt.version === 2 ? origin.receipt.origin : origin?.receipt;
    for (const support of originSupports.filter(item => item.sourceUri === source.uri)) {
      const captured = receipt?.sources.find(item => item.uri === support.sourceUri)?.fragments[support.fragment];
      if (captured !== undefined && sourceSections[support.fragment] === captured) preferred.push(support.fragment);
      else {
        const matches = sourceSections.flatMap((text, ordinal) => (text === captured ? [ordinal] : []));
        if (matches.length === 1) preferred.push(matches[0]);
        else {
          omissions.push(matches.length ? 'origin-current-fragment-ambiguous' : 'origin-current-fragment-unresolved');
          if (support.fragment < sourceSections.length) preferred.push(support.fragment);
        }
      }
    }
    const ordinals = [...new Set([...preferred, ...sourceSections.keys()])];
    for (const ordinal of ordinals) {
      const text = sourceSections[ordinal];
      const descriptor = memoryMaintenanceFragmentSource(source, ordinal);
      const id = automaticMaintenanceEvidenceId(descriptor);
      const existing = evidence.findIndex(item => item.id === id);
      if ((existing < 0 && evidence.length >= evidenceBudget) || candidates.length >= candidateBudget) {
        omissions.push('evidence-budget');
        omittedSources++;
        break;
      }
      if (existing >= 0) {
        evidence[existing] = {...evidence[existing], availability: 'available'};
        candidates.push({evidenceId: id, text});
        continue;
      }
      evidence.push({
        id,
        source: descriptor,
        scope: automaticMaintenanceMemoryScope(source.uri),
        authority: 'provisional',
        availability: 'available',
      });
      candidates.push({evidenceId: id, text});
    }
  }
  const inferences = (sections ?? []).map((section, ordinal) => {
    const ids = candidates
      .filter(
        candidate =>
          candidate.text === section &&
          evidence.some(
            item =>
              item.id === candidate.evidenceId && item.source.kind === 'memory' && item.availability === 'available',
          ),
      )
      .map(candidate => candidate.evidenceId);
    const approved = record.metadata.reviewedSupport?.active.paragraphs[ordinal];
    const retained =
      approved &&
      approved.evidenceIds.length > 0 &&
      approved.evidenceIds.every(id => {
        const descriptor = record.metadata.reviewedSupport!.active.sources.find(source => source.id === id);
        if (!descriptor) return false;
        return candidates.some(candidate => {
          if (candidate.evidenceId !== id) return false;
          if (descriptor.source.kind === 'memory')
            return (
              evidence.some(item => item.id === id && item.availability === 'available') &&
              sha256HexSync(candidate.text) === descriptor.source.fragment.hash
            );
          if (descriptor.source.kind === 'code')
            return (
              candidate.excerpt?.provenance === 'current-verified' &&
              candidate.excerpt.supportsCitation &&
              !candidate.excerpt.truncated &&
              (candidate.excerpt.source.fileContentHash === descriptor.source.citation.fileContentHash.value ||
                candidate.excerpt.fileBytesHash === descriptor.source.citation.fileContentHash.value) &&
              candidate.excerpt.source.sourceDirty === descriptor.source.citation.sourceDirty
            );
          return false;
        });
      });
    return {
      ordinal,
      role: 'unknown' as const,
      support: retained ? approved.support : ids.length ? ('direct' as const) : ('unresolved' as const),
      currentEvidenceIds: retained ? approved.evidenceIds : [...new Set(ids)].sort(),
    };
  });
  if (
    record.metadata.citationErrors?.length ||
    record.metadata.consolidationError ||
    record.metadata.sourceEvidenceError
  )
    omissions.push('malformed-recorded-evidence');
  for (const candidate of candidates) {
    const excerpt = candidate.excerpt;
    if (
      excerpt?.provenance !== 'current-verified' ||
      !evidence.some(item => item.id === candidate.evidenceId && item.source.kind === 'code')
    )
      continue;
    if (excerpt.truncated) omissions.push('current-code-excerpt-truncated');
    if (!excerpt.supportsCitation) omissions.push('current-code-citation-unsupported');
  }
  const uniqueOmissions = [...new Set(omissions)].sort();
  omittedSources += evidence.filter(item => item.availability !== 'available').length;
  const assessment = prepareMemoryMaintenanceBasis(record, {
    readOnly: isSharedMemoryUri(record.uri) || record.metadata.visibility === 'external',
    evidence,
    inferences,
    coverage: {
      outcome: uniqueOmissions.length || omittedSources ? 'partial' : 'complete',
      scope: input.searchedScopes?.length ? 'bounded-search' : evidence.length ? 'recorded-only' : 'none',
      searchedScopes: [...new Set(input.searchedScopes ?? [])].sort(),
      omittedSources,
    },
  }).assessment;
  // Evidence IDs include whole canonical hashes. Generation suppression instead binds selected text and relevant policy.
  const semanticEvidence = assessment.evidence
    .map(item => {
      const candidate = candidates.find(entry => entry.evidenceId === item.id);
      const source = item.source;
      return {
        availability: item.availability,
        authority: item.authority,
        scope: item.scope,
        source:
          source.kind === 'memory'
            ? {
                kind: source.kind,
                uri: source.uri,
                memoryId: source.memoryId,
                fragment: {ordinal: source.fragment.ordinal, hash: source.fragment.hash},
              }
            : source.kind === 'code'
              ? {
                  kind: source.kind,
                  repositoryId: source.citation.repositoryId,
                  path: source.citation.path,
                  target: source.citation.target.kind === 'symbol' ? source.citation.target.qualifiedName : 'file',
                  current: codeRelevantRevision(candidates, item.id, source.citation.target.kind === 'symbol'),
                }
              : source,
        textHash: source.kind !== 'code' && candidate ? sha256HexSync(candidate.text) : null,
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const relevantRevision = hash({
    mapper: AUTOMATIC_PREPARATION_MAPPER,
    target: automaticPreparationMemoryContext(record),
    body: assessment.target.bodyHash,
    relations: [...(record.metadata.relations ?? [])].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    preparation: assessment.preparation,
    origin: origin?.receiptHash,
    scopeRevision: input.scopeRevision,
    sources: sourceContexts,
    semanticEvidence,
    omissions: uniqueOmissions,
    paragraphs: assessment.paragraphs.map(p => ({
      ordinal: p.ordinal,
      hash: p.hash,
      role: p.role,
      roleAuthority: p.roleAuthority,
      support: p.currentSupport,
      scope: p.scope,
      validity: p.validity,
    })),
  });
  return {
    version: 1,
    mapper: AUTOMATIC_PREPARATION_MAPPER,
    assessment,
    reads: [...(input.reads ?? [{uri: record.uri, hash: sha256HexSync(record.content)}])].sort((a, b) =>
      a.uri.localeCompare(b.uri),
    ),
    scopeRevision: input.scopeRevision,
    relevantRevision,
    candidates,
    ...(origin ? {origin} : {}),
    omissions: uniqueOmissions,
    state: assessment.paragraphs.some(p => p.role === 'unknown' || p.currentSupport === 'unresolved')
      ? 'waiting-mapping'
      : 'assessed',
  };
}

export const readAutomaticCodeEvidence = Effect.fn('automaticPreparation.readCodeEvidence')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  configuredRoot: string | undefined,
) {
  const evidence: AutomaticMaintenanceEvidenceV1[] = [];
  const candidates: Candidate[] = [];
  const reads: Read[] = [];
  const omissions: string[] = [];
  const searchedScopes: string[] = [];
  const query = yield* Effect.serviceOption(CodeGraphQueryService);
  if (Option.isNone(query))
    return {evidence, candidates, reads, omissions: ['code-service-unavailable'], searchedScopes};
  // Recorded repository routes are independent of configured uncited discovery roots.
  const citations = [...(record.metadata.codeCitations ?? [])];
  for (const descriptor of record.metadata.reviewedSupport?.active.sources ?? []) {
    const source = descriptor.source;
    if (source.kind === 'code' && !citations.some(citation => citation.id === source.citation.id))
      citations.push(source.citation);
  }
  const recordedIds = new Set(citations.map(citation => citation.id));
  if (
    citations.length === 0 &&
    configuredRoot &&
    record.metadata.project &&
    config.manifestSource !== 'bundled-example'
  ) {
    const discovered = yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(configuredRoot);
      const status = yield* query.value.status(config.agentContextHome, root, {
        project: record.metadata.project,
        manifestPath: config.manifestPath,
        requestMaintenance: false,
        observeWorktree: true,
      });
      if (
        status.stale ||
        status.freshness !== 'current' ||
        !status.readySnapshot ||
        status.projectCoverage?.project !== record.metadata.project
      ) {
        omissions.push('code-graph-not-ready');
        return [];
      }
      const selector = [...(record.metadata.topic ?? record.body)]
        .map(character => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character))
        .join('')
        .trim()
        .slice(0, 512);
      if (!selector) {
        omissions.push('code-query-empty');
        return [];
      }
      const store = yield* CodeGraphStore;
      // General graph queries can embed lexical misses. Use its bounded lexical primitive under a ready-snapshot
      // lease, then let existing exact-current capture fence repository, project, source bytes and symbol identity.
      const groups = yield* store.withSession(
        status.databasePath,
        Effect.acquireUseRelease(
          store.acquireSnapshotLease(status.databasePath, status.readySnapshot.id, 60_000),
          () => store.searchSymbolsMany(status.databasePath, status.readySnapshot!.id, [selector], 3),
          token => store.releaseSnapshotLease(status.databasePath, token).pipe(Effect.ignore),
        ),
      );
      const nodes = groups.flat();
      searchedScopes.push(`project:${record.metadata.project}`);
      omissions.push('bounded-code-search');
      if (status.projectCoverage?.completeness !== 'complete') omissions.push('project-coverage-partial');
      if (!nodes.length) return [];
      const captured = yield* captureMemoryCodeCitations(config, {
        callerCwd: root,
        project: record.metadata.project,
        expectedCallerIdentity: status.identity,
        expectedProjectScope: memoryCodeCitationProjectScopeReceipt(status) ?? {kind: 'full'},
        planOnly: true,
        refs: nodes.slice(0, 3).map(node => node.id),
      });
      return [...captured];
    }).pipe(
      Effect.orElseSucceed(() => {
        omissions.push('code-discovery-unavailable');
        return [];
      }),
    );
    citations.push(...discovered);
  } else if (citations.length === 0) omissions.push('code-project-unbound');
  // Reviewed records may retain eight immutable roots and eight distinct active pins.
  const codeBudget = record.metadata.reviewedSupport ? MAX_MEMORY_CODE_CITATIONS * 2 : 4;
  if (citations.length > codeBudget) omissions.push('code-source-budget');
  for (const citation of citations.slice(0, codeBudget)) {
    const result = yield* readContextHealthCitationEvidence(
      config,
      {kind: 'repository', callerCwd: configuredRoot ?? config.agentContextHome},
      citation,
      {maximumBytes: 4096, maximumLines: 24, symbolSpanOnly: true},
    ).pipe(Effect.result);
    const id = automaticMaintenanceEvidenceId({kind: 'code', citation});
    const recorded = recordedIds.has(citation.id);
    const current = Result.isSuccess(result)
      ? result.success.excerpts.find(item => item.provenance === 'current-verified')
      : undefined;
    evidence.push({
      id,
      source: {kind: 'code', citation},
      scope: 'repository',
      authority: recorded ? 'recorded' : 'provisional',
      availability: current ? 'available' : 'unknown',
    });
    if (Result.isSuccess(result)) {
      for (const excerpt of result.success.excerpts)
        if (recorded || excerpt.provenance === 'current-verified')
          candidates.push({evidenceId: id, text: excerpt.content, excerpt});
      reads.push({
        uri: `code:${citation.repositoryId}:${citation.id}`,
        hash: hash({
          generation: result.success.generation,
          excerpts: result.success.excerpts.map(excerpt => [
            excerpt.provenance,
            excerpt.fileBytesHash,
            excerpt.excerptHash,
          ]),
        }),
      });
      if (!result.success.routesComplete) omissions.push('code-routes-partial');
    }
    if (!current) omissions.push('current-code-evidence-unavailable');
  }
  if (citations.length > codeBudget) omissions.push('code-evidence-budget');
  // Historical pins keep their original validation outcome. A declared symbol selector may independently
  // capture a new current pin, including when the historical extractor cannot validate the old symbol.
  const selectors = new Set<string>();
  for (const citation of citations.slice(0, codeBudget)) {
    if (!configuredRoot || citation.target.kind !== 'symbol') continue;
    const selector = automaticSymbolSelectorKey(citation)!;
    if (selectors.has(selector)) continue;
    selectors.add(selector);
    // An unrelated commit/snapshot must not replace a still-supported canonical source identity.
    if (
      candidates.some(
        candidate =>
          candidate.excerpt &&
          evidence.some(
            item =>
              item.id === candidate.evidenceId &&
              item.source.kind === 'code' &&
              automaticSymbolSelectorKey(item.source.citation) === selector &&
              automaticSupportedSymbolMatchesExcerpt(item.source.citation, candidate.excerpt!),
          ),
      )
    )
      continue;
    const current = yield* captureAutomaticCurrentSymbol(
      config,
      configuredRoot,
      citation,
      record.metadata.project,
    ).pipe(Effect.option);
    if (Option.isNone(current) || current.value === undefined) {
      omissions.push('current-symbol-capture-unavailable');
      continue;
    }
    const captured = current.value;
    const id = automaticMaintenanceEvidenceId({kind: 'code', citation: captured.citation});
    if (evidence.some(item => item.id === id)) continue;
    if (
      evidence.length >=
        (record.metadata.reviewedSupport ? MAX_AUTOMATIC_MAINTENANCE_V2_EVIDENCE : MAX_MEMORY_CODE_CITATIONS) ||
      candidates.length >= (record.metadata.reviewedSupport ? AUTOMATIC_PREPARATION_V2_MAX_CANDIDATES : 16) ||
      reads.length >= (record.metadata.reviewedSupport ? 32 : 16)
    ) {
      omissions.push('code-evidence-budget');
      continue;
    }
    evidence.push({
      id,
      source: {kind: 'code', citation: captured.citation},
      scope: 'repository',
      authority: 'provisional',
      availability: 'available',
    });
    candidates.push({evidenceId: id, text: captured.excerpt.content, excerpt: captured.excerpt});
    reads.push({
      uri: `code:${captured.citation.repositoryId}:${captured.citation.id}`,
      hash: hash({generation: captured.generation, current: captured.excerpt}),
    });
  }
  return {evidence, candidates, reads, omissions, searchedScopes};
});

/** Called under the existing maintenance state lock; no provider/model readiness or generation path is referenced. */
export const advanceAutomaticPreparation = Effect.fn('automaticPreparation.advance')(function* <E, R>(
  config: RuntimeConfig,
  snapshot: InventorySnapshot,
  roots: ReadonlyMap<string, string>,
  readCode: (
    record: MemoryRecord,
    root: string | undefined,
  ) => Effect.Effect<Effect.Success<ReturnType<typeof readAutomaticCodeEvidence>>, E, R>,
  options: {readonly project?: string; readonly maxRecords?: number} = {},
) {
  const cursor = yield* readAutomaticPreparationCursor(config, options.project);
  const uris = selectAutomaticPreparationUris(
    snapshot.records
      .filter(
        record =>
          record.metadata.status === 'active' &&
          !isAgentArtifactUri(record.uri) &&
          (options.project === undefined || (record.metadata.project ?? 'unscoped') === options.project),
      )
      .map(record => record.uri),
    cursor.lastUri,
    options.maxRecords ?? 1,
  );
  let prepared = 0;
  let failed = 0;
  for (const uri of uris) {
    // Cursor persistence precedes a potentially interrupted read: even a permanently bad target advances fairly.
    yield* writeAutomaticPreparationCursor(config, options.project, uri);
    const attempt = yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const openingGeneration = yield* readCanonicalMutationGeneration(
        fs,
        path,
        config.agentContextHome,
        config.account,
      );
      const target = yield* readContextMaintenanceCanonicalRecord(config, uri);
      if (target.record.metadata.status !== 'active') return;
      const sources: MemoryRecord[] = [];
      const reads: Read[] = [{uri, hash: target.hash}];
      const omissions: string[] = snapshot.complete ? [] : ['inventory-partial'];
      let omittedSources = 0;
      const origin = preservedOrigin(target.record);
      const original = origin?.receipt.version === 2 ? origin.receipt.origin : origin?.receipt;
      const reviewedUris = [...new Set(reviewedOriginSupports(origin).map(item => item.sourceUri))];
      const refs = [
        ...new Set([
          ...(target.record.metadata.reviewedSupport?.active.sources ?? []).flatMap(entry =>
            entry.source.kind === 'memory' ? [entry.source.uri] : [],
          ),
          ...reviewedUris,
          ...(original?.sources ?? []).map(item => item.uri).sort(),
          ...(target.record.metadata.relations ?? []).map(item => item.uri).sort(),
        ]),
      ];
      const visited = new Set([uri]);
      // Reviewed-origin references are a subset of the validated receipt's source vector.
      const selectorBudget = RELATED_SOURCE_BUDGET + MAX_CONSOLIDATION_SOURCES + MAX_MEMORY_RELATIONS;
      if (refs.length > selectorBudget) {
        omissions.push('related-source-budget');
        omittedSources += refs.length - selectorBudget;
      }
      for (const ref of refs.slice(0, selectorBudget)) {
        const resolved = resolveRelationTarget(snapshot.records, ref);
        if (resolved.state === 'conflicted') {
          omissions.push('related-source-ambiguous');
          omittedSources++;
          continue;
        }
        const relation = target.record.metadata.relations?.find(item => item.uri === ref);
        const policy = relation
          ? resolveMaintenanceRelationPolicy(target.record, relation, snapshot.records, snapshot.complete)
          : undefined;
        if (policy?.state === 'ambiguous') {
          omissions.push('related-successor-ambiguous');
          omittedSources++;
          continue;
        }
        if (policy?.successor && (policy.lineage?.length ?? 0) > 2) {
          omissions.push('related-successor-hop-boundary');
          omittedSources++;
          continue;
        }
        const projected = policy?.successor ?? resolved.record;
        if (policy?.successor) omissions.push('related-successor-candidate');
        if (!projected) {
          omissions.push(snapshot.complete ? 'related-source-unavailable' : 'related-source-unknown');
          omittedSources++;
          continue;
        }
        if (visited.has(projected.uri)) continue;
        visited.add(projected.uri);
        if (visited.size - 1 > RELATED_SOURCE_BUDGET) {
          omissions.push('related-source-budget');
          omittedSources++;
          continue;
        }
        if (projected.metadata.status !== 'active') {
          omissions.push('related-source-inactive');
          omittedSources++;
          continue;
        }
        if (
          (target.record.metadata.project ?? '') !== (projected.metadata.project ?? '') ||
          (isSharedMemoryUri(uri) &&
            (!isSharedMemoryUri(projected.uri) ||
              uri.split('/shared/')[1]?.split('/')[0] !== projected.uri.split('/shared/')[1]?.split('/')[0])) ||
          projected.metadata.visibility === 'external' ||
          projected.metadata.trust === 'untrusted' ||
          projected.metadata.authority === 'external' ||
          projected.metadata.citationErrors?.length ||
          projected.metadata.consolidationError ||
          projected.metadata.topicMaintenanceError
        ) {
          omissions.push('related-source-policy');
          omittedSources++;
          continue;
        }
        const source = yield* readContextMaintenanceCanonicalRecord(config, projected.uri).pipe(Effect.result);
        if (Result.isFailure(source)) {
          omissions.push('related-source-unreadable');
          omittedSources++;
          continue;
        }
        if (
          JSON.stringify(automaticPreparationMemoryContext(source.success.record)) !==
          JSON.stringify(automaticPreparationMemoryContext(projected))
        ) {
          omissions.push('related-source-changed');
          omittedSources++;
          continue;
        }
        sources.push(source.success.record);
        reads.push({uri: projected.uri, hash: source.success.hash});
      }
      const root = target.record.metadata.project ? roots.get(target.record.metadata.project) : undefined;
      const codeResult = yield* readCode(target.record, root).pipe(Effect.timeoutOption(2_000));
      const code = Option.getOrElse(codeResult, () => ({
        evidence: [],
        candidates: [],
        reads: [],
        omissions: ['code-evidence-time-boundary'],
        searchedScopes: [],
      }));
      const scopeRevision = hash({
        project: target.record.metadata.project,
        root: root ?? null,
        sourcePolicy: 'same-project-and-shared-team-v1',
        mapper: AUTOMATIC_PREPARATION_MAPPER,
      });
      const result = yield* Effect.try(() =>
        prepareAutomaticMemory(target.record, {
          sources,
          evidence: code.evidence,
          candidates: code.candidates,
          reads: [...reads, ...code.reads],
          scopeRevision,
          searchedScopes: code.searchedScopes,
          omissions: [...omissions, ...code.omissions],
          omittedSources,
        }),
      );
      for (const read of reads) {
        const closing = yield* readContextMaintenanceCanonicalRecord(config, read.uri);
        if (closing.hash !== read.hash) return yield* new AutomaticPreparationError({reason: 'memory-fence-changed'});
      }
      if (code.reads.length) {
        const closingCode = yield* readCode(target.record, root).pipe(Effect.timeoutOption(2_000));
        if (Option.isNone(closingCode) || hash(closingCode.value.reads) !== hash(code.reads))
          return yield* new AutomaticPreparationError({reason: 'code-fence-changed'});
      }
      if (
        openingGeneration !==
        (yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account))
      )
        return yield* new AutomaticPreparationError({reason: 'memory-fence-changed'});
      yield* writePreparedMemory(config, result);
      prepared++;
    }).pipe(Effect.result);
    if (Result.isFailure(attempt)) {
      failed++;
      yield* writeAutomaticPreparationFailure(config, uri, 'target-preparation-unavailable');
    }
  }
  return {attempted: uris.length, prepared, failed, complete: snapshot.complete};
});

/** Keep configured-source preparation out of the scheduler; selected-case refresh retains its existing lane. */
export const prepareAutomaticMaintenance = Effect.fn('automaticPreparation.prepareConfigured')(function* (
  config: RuntimeConfig,
  snapshot: InventorySnapshot,
  options: {readonly project?: string; readonly caseId?: string},
) {
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.result);
  const roots = new Map<string, string>();
  if (Result.isSuccess(manifest)) {
    for (const project of manifest.success.projects) {
      const root = yield* expandPath(project.path).pipe(Effect.result);
      if (Result.isSuccess(root)) roots.set(project.name, root.success);
    }
  }
  const automaticRoots = new Map(roots);
  if (Result.isSuccess(manifest)) {
    const names = manifest.success.projects.map(project => project.name);
    for (const name of names) if (names.indexOf(name) !== names.lastIndexOf(name)) automaticRoots.delete(name);
  }
  if (options.caseId === undefined)
    yield* advanceAutomaticPreparation(
      config,
      snapshot,
      automaticRoots,
      (record, root) =>
        record.metadata.topicMaintenance
          ? Effect.succeed({
              evidence: [],
              candidates: [],
              reads: [],
              omissions: ['legacy-topic-observation-owned'],
              searchedScopes: [],
            })
          : readAutomaticCodeEvidence(config, record, root),
      {project: options.project, maxRecords: 1},
    );
  return roots;
});

/** Explicit review reconstructs preparation from authorized canonical reads, never from the disposable cache. */
export const readLiveAutomaticPreparation = Effect.fn('automaticPreparation.readLiveReview')(function* (
  config: RuntimeConfig,
  uri: string,
  sourceCwd?: string,
) {
  const target = yield* readContextMaintenanceCanonicalRecord(config, uri);
  const record = target.record;
  if (record.metadata.status !== 'active' || isAgentArtifactUri(uri))
    return yield* new AutomaticPreparationError({reason: 'memory-fence-changed'});
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.result);
  let root: string | undefined;
  if (Result.isSuccess(manifest)) {
    const matches = manifest.success.projects.filter(project => project.name === record.metadata.project);
    if (matches.length === 1) root = yield* expandPath(matches[0].path);
  }
  if (sourceCwd !== undefined) {
    const path = yield* Path.Path;
    if (!path.isAbsolute(sourceCwd)) return yield* new AutomaticPreparationError({reason: 'code-fence-changed'});
    if (
      root &&
      (yield* (yield* FileSystem.FileSystem).realPath(root)) !==
        (yield* (yield* FileSystem.FileSystem).realPath(sourceCwd))
    )
      return yield* new AutomaticPreparationError({reason: 'code-fence-changed'});
    root = sourceCwd;
  }
  const refs = [
    ...new Set([
      ...(record.metadata.reviewedSupport?.active.sources ?? []).flatMap(item =>
        item.source.kind === 'memory' ? [item.source.uri] : [],
      ),
      ...(record.metadata.relations ?? []).map(item => item.uri),
    ]),
  ];
  const sources: MemoryRecord[] = [];
  const locators = new Map<string, ApprovedSourceDescriptorV1['locator']>();
  const portableReads = new Map<
    string,
    {
      readonly source: Extract<
        import('@threadnote/memory/automatic-maintenance').AutomaticMaintenanceSourceV1,
        {kind: 'memory'}
      >;
      readonly locator: ApprovedSourceDescriptorV1['locator'];
    }
  >();
  const reads: Read[] = [{uri, hash: target.hash}];
  // Approved paths and authored aliases can name the same source. Resolve the
  // bounded selectors before spending the budget on distinct canonical reads.
  const selectorBudget = RELATED_SOURCE_BUDGET + MAX_MEMORY_RELATIONS;
  const allowedUriScopes = automaticMemorySourceUriScopes(config, record);
  const visited = new Set([uri]);
  const liveSources = new Map<string, MemoryRecord>();
  let omittedSources = Math.max(0, refs.length - selectorBudget);
  const omissions: string[] = omittedSources ? ['related-source-budget'] : [];
  for (const ref of refs.slice(0, selectorBudget)) {
    const stored = record.metadata.reviewedSupport?.active.sources.find(
      entry => entry.source.kind === 'memory' && entry.source.uri === ref,
    );
    const portable =
      stored?.source.kind === 'memory' && stored.locator
        ? yield* resolveAutomaticSharedMemorySource(config, stored.source, stored.locator)
        : undefined;
    const route = portable
      ? undefined
      : yield* resolveMemoryIdentityAliases(config, [ref], allowedUriScopes, {
          validateNow: true,
        }).pipe(Effect.result);
    if (route && Result.isFailure(route)) {
      omittedSources++;
      omissions.push('related-source-unreadable');
      continue;
    }
    const identity = route && Result.isSuccess(route) ? route.success[0] : undefined;
    const actualUri = portable ? portable.uri : identity!.canonicalUri;
    if (!portable && isSharedMemoryUri(uri) && !allowedUriScopes.some(scope => resourceIdIsWithin(actualUri, scope))) {
      omittedSources++;
      omissions.push('related-source-policy');
      continue;
    }
    if (visited.has(actualUri)) {
      const prior = liveSources.get(actualUri);
      if (identity && prior) {
        const verified = yield* verifyResolvedMemoryIdentity(identity, actualUri, prior.content).pipe(Effect.result);
        if (Result.isFailure(verified)) {
          omittedSources++;
          omissions.push('related-source-unreadable');
        }
      }
      continue;
    }
    visited.add(actualUri);
    if (visited.size - 1 > RELATED_SOURCE_BUDGET) {
      omittedSources++;
      omissions.push('related-source-budget');
      continue;
    }
    const selected = portable
      ? Result.succeed({
          record: {...portable.record, uri: ref},
          hash: sha256HexSync(portable.record.content),
          actualUri,
        })
      : yield* readContextMaintenanceCanonicalRecord(config, actualUri).pipe(
          Effect.tap(value => verifyResolvedMemoryIdentity(identity!, actualUri, value.record.content)),
          Effect.map(value => ({...value, actualUri})),
          Effect.result,
        );
    if (Result.isFailure(selected)) {
      omittedSources++;
      omissions.push('related-source-unreadable');
      continue;
    }
    const source = selected.success.record;
    if (source.uri === uri) continue;
    if (
      source.metadata.status !== 'active' ||
      (source.metadata.project ?? '') !== (record.metadata.project ?? '') ||
      source.metadata.visibility === 'external' ||
      source.metadata.trust === 'untrusted' ||
      source.metadata.authority === 'external' ||
      source.metadata.citationErrors?.length ||
      source.metadata.consolidationError ||
      source.metadata.topicMaintenanceError ||
      source.metadata.reviewedSupportError ||
      (isSharedMemoryUri(uri) &&
        (!isSharedMemoryUri(source.uri) ||
          uri.split('/shared/')[1]?.split('/')[0] !== source.uri.split('/shared/')[1]?.split('/')[0]))
    ) {
      omittedSources++;
      omissions.push('related-source-policy');
      continue;
    }
    if (isSharedMemoryUri(source.uri)) {
      const descriptor = memoryMaintenanceFragmentSource(source, 0);
      const locator = portable?.locator ?? (yield* authorizeAutomaticSharedMemorySource(config, descriptor));
      locators.set(source.uri, locator);
    }
    if (portable && stored?.source.kind === 'memory')
      portableReads.set(selected.success.actualUri, {source: stored.source, locator: portable.locator});
    sources.push(source);
    liveSources.set(selected.success.actualUri, source);
    reads.push({uri: selected.success.actualUri, hash: selected.success.hash});
  }
  const code =
    record.metadata.codeCitations?.length || record.metadata.reviewedSupport?.active.sources.length || root
      ? yield* readAutomaticCodeEvidence(config, record, root)
      : {evidence: [], candidates: [], reads: [], omissions: [], searchedScopes: []};
  const scopeRevision = hash({
    project: record.metadata.project,
    root: root ?? null,
    sourcePolicy: 'same-project-and-shared-team-v1',
    mapper: AUTOMATIC_PREPARATION_MAPPER,
  });
  const prepared = yield* Effect.try(() =>
    prepareAutomaticMemory(record, {
      sources,
      evidence: code.evidence,
      candidates: code.candidates,
      reads: [...reads, ...code.reads],
      scopeRevision,
      searchedScopes: code.searchedScopes,
      omissions: [...omissions, ...code.omissions],
      omittedSources,
    }),
  );
  for (const read of reads) {
    const portable = portableReads.get(read.uri);
    const actual = portable
      ? sha256HexSync(
          (yield* resolveAutomaticSharedMemorySource(config, portable.source, portable.locator)).record.content,
        )
      : (yield* readContextMaintenanceCanonicalRecord(config, read.uri)).hash;
    if (actual !== read.hash) return yield* new AutomaticPreparationError({reason: 'memory-fence-changed'});
  }
  yield* verifyAuthoredMemoryRelationTargetIdentities(
    config,
    [...liveSources].flatMap(([sourceUri, source]) =>
      portableReads.has(sourceUri)
        ? []
        : [
            {
              content: source.content,
              memoryId: source.metadata.memoryId,
              uri: sourceUri,
              allowedUriScopes,
            },
          ],
    ),
  );
  const identity =
    root && code.candidates.some(candidate => candidate.excerpt?.provenance === 'current-verified')
      ? yield* resolveRepositoryIdentity(root)
      : undefined;
  const repositoryIdentity = identity
    ? {repositoryId: identity.repositoryId, kind: identity.remoteIdentity ? ('remote' as const) : ('local' as const)}
    : undefined;
  return {record, prepared, root, locators, repositoryIdentity};
});
