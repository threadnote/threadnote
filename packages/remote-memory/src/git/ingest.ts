import {Array as EffectArray, Option as EffectOption} from 'effect';
import type {ISql} from 'postgres';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {randomUuidV4} from '@threadnote/platform/uuid';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import {formatRemoteMemoryLogicalKey, REMOTE_MEMORY_REVISION_VERSION} from '@threadnote/memory/remote/revisions';
import {parseMemoryDocument} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {AuthorizedRemotePrincipal} from '../authorization.js';
import {remoteMemoryError} from '../errors.js';
import {
  GitCanonicalMemoryStore,
  gitIngestProjectsToEnsure,
  parseGitCanonicalSharePath,
  type GitCanonicalSnapshot,
} from './canonical_store.js';
import {classifyGitIngestDocument, type GitIngestRejection, type GitIngestStatus} from './ingest_document.js';
import {
  principalAllows,
  principalAllowsProject,
  requireActiveProject,
  requireShareState,
} from '../repository_policy.js';
import {acquireRemoteRelationAdmissionTransactionLock} from '../relation_admission.js';
import {replaceRemoteCodeLinkBacklinks} from '../code_link_backlinks.js';

const CANDIDATE_LIMIT = 256;
type WithTenant = <A>(use: (transaction: ISql) => Promise<A>) => Promise<A>;
type Path = GitCanonicalSnapshot['paths'][number];
interface Head {
  readonly head_id: string;
  readonly current_revision_id: string;
  readonly content_hash: string;
  readonly git_commit: string | null;
  readonly git_observed_commit: string | null;
  readonly git_path: string | null;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly topic: string;
  readonly status: GitIngestStatus;
  readonly expires_at: Date | null;
}
interface Progress {
  readonly git_ingest_snapshot_commit: string | null;
  readonly git_ingest_cursor: string | null;
  readonly git_ingest_rejected_path: string | null;
}
interface Candidate {
  readonly gitPath: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly topic: string;
  readonly path?: Path;
  readonly current?: Head;
}
interface Mutation {
  readonly citations: readonly MemoryCodeCitationV1[];
  readonly contentHash: string;
  readonly gitCommit: string;
  readonly status: GitIngestStatus;
}
interface Plan {
  readonly mutation?: Mutation;
  readonly rejected?: GitIngestRejection;
}

export async function ingestGitShare(input: {
  readonly gitStore: GitCanonicalMemoryStore;
  readonly principal: AuthorizedRemotePrincipal;
  readonly requestId: string;
  readonly now: Date;
  readonly withTenant: WithTenant;
}): Promise<{readonly ingested: number; readonly skipped: number}> {
  const {gitStore, principal, withTenant} = input;
  const snapshot = await gitStore.snapshot();
  const progress = await admitSnapshot(withTenant, gitStore, principal, snapshot.gitCommit);
  const loaded = await withTenant(async transaction => {
    await requireShareState(transaction, principal);
    const knownProjects = await transaction<{name: string}[]>`
      SELECT name FROM remote_memory.projects WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
    `;
    for (const project of gitIngestProjectsToEnsure({
      allowedProjects: principal.allowedProjects,
      gitProjects: EffectArray.map(snapshot.paths, path => path.project),
      knownProjects: new Set(EffectArray.map(knownProjects, project => project.name)),
    })) {
      await transaction`
        INSERT INTO remote_memory.projects(tenant_id, share_id, name, status)
        VALUES (${principal.tenantId}, ${principal.shareId}, ${project}, 'active')
        ON CONFLICT (tenant_id, share_id, name) DO NOTHING
      `;
    }
    const heads = await transaction<Head[]>`
      SELECT h.id AS head_id, h.current_revision_id, h.kind, h.project, h.topic, h.status, h.expires_at,
        r.content_hash, r.git_commit, r.git_path, r.git_observed_commit
      FROM remote_memory.memory_heads h JOIN remote_memory.memory_revisions r
        ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
      WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
    `;
    const projects = await transaction<{name: string}[]>`
      SELECT name FROM remote_memory.projects
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND status = 'active'
    `;
    return {heads, projects: new Set(EffectArray.map(projects, project => project.name))};
  });
  const candidates = new Map<string, Candidate>();
  for (const path of snapshot.paths) candidates.set(path.gitPath, {...path, path});
  for (const current of loaded.heads) {
    if (!current.git_path) continue;
    const parsed = parseGitCanonicalSharePath(current.git_path);
    if (!parsed) continue;
    candidates.set(current.git_path, {
      ...parsed,
      ...candidates.get(current.git_path),
      gitPath: current.git_path,
      current,
    });
  }
  const rejectedPath = progress.git_ingest_rejected_path;
  if (rejectedPath && !candidates.has(rejectedPath)) {
    const parsed = parseGitCanonicalSharePath(rejectedPath);
    if (!parsed) throw remoteMemoryError('service_unavailable', 'The Git ingestion rejection path is invalid.');
    candidates.set(rejectedPath, {...parsed, gitPath: rejectedPath});
  }
  const ordered = [...candidates.values()].sort((left, right) =>
    left.gitPath < right.gitPath ? -1 : left.gitPath > right.gitPath ? 1 : 0,
  );
  const afterCursor = EffectOption.getOrElse(
    EffectArray.findFirstIndex(
      ordered,
      candidate => progress.git_ingest_cursor === null || candidate.gitPath > progress.git_ingest_cursor,
    ),
    () => -1,
  );
  const rotated = afterCursor < 0 ? ordered : [...ordered.slice(afterCursor), ...ordered.slice(0, afterCursor)];
  const prioritized = rejectedPath
    ? [candidates.get(rejectedPath)!, ...EffectArray.filter(rotated, candidate => candidate.gitPath !== rejectedPath)]
    : rotated;
  const blobCache = new Map<string, ReadonlyMap<string, string>>();
  const verifiedAncestors = new Set([snapshot.gitCommit]);
  const blobsAt = async (commit: string) => {
    let blobs = blobCache.get(commit);
    if (!blobs) {
      blobs = await gitStore.listBlobIds(commit);
      blobCache.set(commit, blobs);
    }
    return blobs;
  };
  let cursor = progress.git_ingest_cursor;
  let expectedRejection = rejectedPath;
  let ingested = 0;
  let skipped = 0;
  for (const candidate of prioritized.slice(0, CANDIDATE_LIMIT)) {
    if (!canIngest(principal, candidate) || !loaded.projects.has(candidate.project)) {
      if (candidate.gitPath === rejectedPath) throw ingestionRejected('metadata');
      skipped += 1;
    } else {
      const observation = candidate.current?.git_observed_commit ?? candidate.current?.git_commit;
      if (observation && !verifiedAncestors.has(observation)) {
        if (!(await gitStore.isAncestor(observation, snapshot.gitCommit))) throw supersededSnapshot();
        verifiedAncestors.add(observation);
      }
      const priorBlob = observation ? (await blobsAt(observation)).get(candidate.gitPath) : undefined;
      const needsValidation =
        candidate.path !== undefined &&
        (candidate.gitPath === rejectedPath ||
          !candidate.path.readable ||
          !candidate.current?.git_observed_commit ||
          priorBlob !== candidate.path.blobId);
      let plan: Plan = {};
      if (needsValidation && candidate.path) {
        const content = candidate.path.readable
          ? await gitStore.read({commit: snapshot.gitCommit, path: candidate.gitPath})
          : '';
        const classification = candidate.path.readable
          ? classifyGitIngestDocument(content, candidate)
          : {accepted: false as const, reason: 'unsupported_entry' as const};
        if (!classification.accepted) {
          plan = {
            rejected: classification.reason,
            mutation: preservedMutation(
              candidate.current,
              priorBlob !== undefined && priorBlob !== candidate.path.blobId,
            ),
          };
        } else {
          const contentHash = sha256HexSync(content);
          const expired = candidate.current?.expires_at && candidate.current.expires_at <= input.now;
          const status =
            expired && classification.status === 'active'
              ? candidate.current.status === 'active'
                ? 'expired'
                : candidate.current.status
              : classification.status;
          if (
            candidate.current?.content_hash !== contentHash ||
            candidate.current.status !== status ||
            priorBlob === undefined
          ) {
            const canonicalUri = formatRemoteMemoryUri({
              kind: candidate.kind,
              project: candidate.project,
              shareId: principal.shareId,
              topic: candidate.topic,
            });
            const record = parseMemoryDocument(canonicalUri, content);
            plan = {
              mutation: {
                citations: record?.metadata.codeCitations ?? [],
                contentHash,
                gitCommit: snapshot.gitCommit,
                status,
              },
            };
          }
        }
      } else if (!candidate.path && priorBlob !== undefined) {
        plan = {mutation: preservedMutation(candidate.current, true)};
      }
      if (plan.mutation || plan.rejected) {
        const changed = await applyPlan({
          ...input,
          candidate,
          plan,
          snapshotCommit: snapshot.gitCommit,
          expectedRejectedPath: expectedRejection,
        });
        if (changed) ingested += 1;
        else skipped += 1;
      } else skipped += 1;
      if (plan.rejected) throw ingestionRejected(plan.rejected);
    }
    if (candidate.gitPath === expectedRejection) {
      await withTenant(async transaction => {
        await requireShareState(transaction, principal);
        const rows = await transaction<{id: string}[]>`
          UPDATE remote_memory.shares SET git_ingest_rejected_path = NULL
          WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId}
            AND git_ingest_snapshot_commit = ${snapshot.gitCommit}
            AND git_ingest_rejected_path = ${expectedRejection}
            AND git_ingest_cursor IS NOT DISTINCT FROM ${progress.git_ingest_cursor}::text
          RETURNING id
        `;
        if (!rows[0]) throw supersededSnapshot();
      });
      expectedRejection = null;
    }
    cursor = candidate.gitPath;
  }
  if (prioritized.length > 0) {
    await withTenant(async transaction => {
      await requireShareState(transaction, principal);
      const rows = await transaction<{id: string}[]>`
        UPDATE remote_memory.shares SET git_ingest_cursor = ${cursor}
        WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId}
          AND git_ingest_snapshot_commit = ${snapshot.gitCommit}
          AND git_ingest_cursor IS NOT DISTINCT FROM ${progress.git_ingest_cursor}::text
          AND git_ingest_rejected_path IS NOT DISTINCT FROM ${expectedRejection}::text
        RETURNING id
      `;
      if (!rows[0]) throw supersededSnapshot();
    });
  }
  return {ingested, skipped};
}

function canIngest(principal: AuthorizedRemotePrincipal, candidate: Candidate): boolean {
  return (
    principalAllowsProject(principal, candidate.project) &&
    (candidate.kind === 'durable'
      ? principalAllows(principal, 'memory:write:durable', 'remote_memory_durable_write')
      : principalAllows(principal, 'memory:write:handoff', 'remote_memory_handoff_write'))
  );
}

function preservedMutation(current: Head | undefined, presenceChanged: boolean): Mutation | undefined {
  if (!current?.git_commit || (current.status !== 'active' && !presenceChanged)) return undefined;
  return {
    citations: [],
    contentHash: current.content_hash,
    gitCommit: current.git_commit,
    status: current.status === 'active' ? 'archived' : current.status,
  };
}

async function admitSnapshot(
  withTenant: WithTenant,
  gitStore: GitCanonicalMemoryStore,
  principal: AuthorizedRemotePrincipal,
  commit: string,
): Promise<Progress> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = await withTenant(async transaction => {
      await requireShareState(transaction, principal);
      const [row] = await transaction<Progress[]>`
        SELECT git_ingest_snapshot_commit, git_ingest_cursor, git_ingest_rejected_path
        FROM remote_memory.shares WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId}
      `;
      return row;
    });
    const previousCommit = prior.git_ingest_snapshot_commit;
    if (previousCommit && previousCommit !== commit && !(await gitStore.isAncestor(previousCommit, commit))) {
      if (await gitStore.isAncestor(commit, previousCommit)) throw supersededSnapshot();
      throw remoteMemoryError('service_unavailable', 'The Git ingestion history diverged from the admitted snapshot.');
    }
    const admitted = await withTenant(async transaction => {
      await requireShareState(transaction, principal);
      return transaction<Progress[]>`
        UPDATE remote_memory.shares SET git_ingest_snapshot_commit = ${commit}
        WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId}
          AND git_ingest_snapshot_commit IS NOT DISTINCT FROM ${previousCommit}::text
        RETURNING git_ingest_snapshot_commit, git_ingest_cursor, git_ingest_rejected_path
      `;
    });
    if (admitted[0]) return admitted[0];
  }
  throw supersededSnapshot();
}

async function applyPlan(input: {
  readonly withTenant: WithTenant;
  readonly principal: AuthorizedRemotePrincipal;
  readonly candidate: Candidate;
  readonly plan: Plan;
  readonly snapshotCommit: string;
  readonly expectedRejectedPath: string | null;
  readonly requestId: string;
  readonly now: Date;
}): Promise<boolean> {
  const {principal, candidate, plan} = input;
  return input.withTenant(async transaction => {
    await acquireRemoteRelationAdmissionTransactionLock(transaction, principal.tenantId, principal.shareId);
    await requireShareState(transaction, principal);
    await requireActiveProject(transaction, principal, candidate.project);
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: candidate.kind,
      project: candidate.project,
      topic: candidate.topic,
      tenantId: principal.tenantId,
      shareId: principal.shareId,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
    const [current] = await transaction<{id: string; current_revision_id: string}[]>`
      SELECT id, current_revision_id FROM remote_memory.memory_heads
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
        AND kind = ${candidate.kind} AND project = ${candidate.project} AND topic = ${candidate.topic}
      FOR UPDATE
    `;
    if (current?.current_revision_id !== candidate.current?.current_revision_id) throw supersededSnapshot();
    const [generation] = await transaction<{share_generation: string | number}[]>`
      UPDATE remote_memory.shares SET share_generation = share_generation + ${plan.mutation ? 1 : 0},
        git_ingest_rejected_path = CASE WHEN ${plan.rejected !== undefined} THEN ${candidate.gitPath} ELSE git_ingest_rejected_path END
      WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId} AND status = 'active'
        AND policy_version = ${principal.sharePolicyVersion} AND policy_digest = ${principal.sharePolicyDigest}
        AND git_ingest_snapshot_commit = ${input.snapshotCommit}
        AND git_ingest_rejected_path IS NOT DISTINCT FROM ${input.expectedRejectedPath}::text
      RETURNING share_generation
    `;
    if (!generation) throw supersededSnapshot();
    const committed = await requireShareState(transaction, principal);
    if (!plan.mutation) return false;
    const headId = current?.id ?? randomUuidV4();
    const revisionId = randomUuidV4();
    const canonicalUri = formatRemoteMemoryUri({
      kind: candidate.kind,
      project: candidate.project,
      topic: candidate.topic,
      shareId: principal.shareId,
    });
    if (!current) {
      await transaction`
        INSERT INTO remote_memory.memory_heads(tenant_id, share_id, id, kind, project, topic, canonical_uri, status)
        VALUES (${principal.tenantId}, ${principal.shareId}, ${headId}, ${candidate.kind}, ${candidate.project}, ${candidate.topic}, ${canonicalUri}, ${plan.mutation.status})
      `;
    }
    await transaction`
      INSERT INTO remote_memory.memory_revisions(
        tenant_id, share_id, id, head_id, base_revision_id, generation, status,
        markdown_body, content_hash, git_commit, git_path, git_observed_commit, oauth_principal_id, operation_id
      ) VALUES (
        ${principal.tenantId}, ${principal.shareId}, ${revisionId}, ${headId}, ${current?.current_revision_id ?? null},
        ${Number(generation.share_generation)}, ${plan.mutation.status}, ${''}, ${plan.mutation.contentHash},
        ${plan.mutation.gitCommit}, ${candidate.gitPath}, ${input.snapshotCommit}, ${principal.principalId},
        ${`git-ingest:${input.snapshotCommit}:${candidate.gitPath}`}
      )
    `;
    await replaceRemoteCodeLinkBacklinks(transaction, {
      citations: plan.mutation.citations,
      headId,
      revisionId,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
    });
    await transaction`
      UPDATE remote_memory.memory_heads SET current_revision_id = ${revisionId}, status = ${plan.mutation.status}, updated_at = ${input.now.toISOString()}
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND id = ${headId}
    `;
    await transaction`
      INSERT INTO remote_memory.outbox_events(tenant_id, share_id, id, generation, event_type, aggregate_id)
      VALUES (${principal.tenantId}, ${principal.shareId}, ${randomUuidV4()}, ${Number(generation.share_generation)}, 'memory_head_changed', ${headId})
    `;
    await transaction`
      INSERT INTO remote_memory.audit_events(tenant_id, share_id, id, request_id, principal_id, operation, result, policy_version, share_policy_version, generation)
      VALUES (${principal.tenantId}, ${principal.shareId}, ${randomUuidV4()}, ${input.requestId}, ${principal.principalId},
        'ingest_git_share', ${plan.rejected ? `rejected_${plan.rejected}` : 'committed'}, ${principal.policyVersion}, ${committed.policy_version}, ${Number(generation.share_generation)})
    `;
    return true;
  });
}

function supersededSnapshot() {
  return remoteMemoryError(
    'service_unavailable',
    'The Git ingestion snapshot or memory head changed; retry the current snapshot.',
    {reason: 'git_ingest_snapshot_superseded'},
  );
}

function ingestionRejected(reason: GitIngestRejection) {
  return remoteMemoryError(
    'service_unavailable',
    'A canonical Git memory was rejected; correct the source publication before continuing ingestion.',
    {reason: `git_ingest_${reason}`},
  );
}
