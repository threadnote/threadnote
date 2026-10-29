import {Array as EffectArray} from 'effect';
import type {ISql} from 'postgres';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseMemoryDocument} from '@threadnote/memory/document';
import type {RemoteRecallInputV1} from '@threadnote/memory/remote/contracts';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import type {AuthorizedRemotePrincipal} from '../authorization.js';
import {citationMatchesRemoteBacklink} from '../code_link_backlinks.js';
import {
  remoteContextBriefAnchorSelectors,
  type RemoteContextBriefInputV1,
  type RemoteContextBriefResult,
} from './brief.js';
import {remoteMemoryError} from '../errors.js';
import {gitCanonicalSharePath} from '../git/canonical_store.js';
import {requireJsonValue} from '../json.js';
import type {RemoteMemoryRecallResult} from '../postgres/repository.js';
import {requireActiveProject, requireShareState, type ShareStateRow} from '../repository_policy.js';
import {remoteMemoryExcerpt} from '../recall/text.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface ContextBriefHeadRow {
  readonly canonical_uri: string;
  readonly content_hash: string;
  readonly current_revision_id: string;
  readonly git_commit: string | null;
  readonly git_path: string | null;
  readonly head_id: string;
  readonly kind: 'durable' | 'handoff';
  readonly markdown_body: string;
  readonly project: string;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
}

interface BacklinkRow extends ContextBriefHeadRow {
  readonly anchor_ordinal: number;
  readonly citation_ordinal: number;
  readonly selector_digest: string;
  readonly selector_kind: 'file-content' | 'file-path' | 'symbol-locator' | 'symbol-node';
}

interface CodeLinkRepairState {
  readonly processed: number;
  readonly total: number;
}

interface CompileRemoteContextBriefDependencies {
  readonly gitStoreConfigured: boolean;
  readonly makeReceipt: (state: ShareStateRow) => RemoteMemoryReceiptV1;
  readonly recall: (
    input: RemoteRecallInputV1,
  ) => Promise<{readonly receipt: RemoteMemoryReceiptV1; readonly results: readonly RemoteMemoryRecallResult[]}>;
  readonly revisionBody: (
    head: Pick<ContextBriefHeadRow, 'git_commit' | 'git_path' | 'markdown_body'>,
  ) => Promise<string>;
  readonly withTenant: <A>(use: (transaction: ISql) => Promise<A>) => Promise<A>;
}

export interface RemoteMemoryContextBriefResult {
  readonly directSearchComplete: boolean;
  readonly directSearchTruncated: boolean;
  readonly matchedAnchorOrdinals: readonly number[];
  readonly receipt: RemoteMemoryReceiptV1;
  readonly results: readonly RemoteContextBriefResult[];
}

export async function compileRemoteContextBrief(
  principal: AuthorizedRemotePrincipal,
  input: RemoteContextBriefInputV1,
  dependencies: CompileRemoteContextBriefDependencies,
  attempt = 0,
): Promise<RemoteMemoryContextBriefResult> {
  const selectors = remoteContextBriefAnchorSelectors(input.anchors);
  const loaded = await dependencies.withTenant(async transaction => {
    const state = await requireShareState(transaction, principal);
    await requireActiveProject(transaction, principal, input.project);
    const repairState = await codeLinkRepairState(transaction, principal);
    if (selectors.length === 0) return {repairState, rows: [] satisfies readonly BacklinkRow[], state};
    const rows = await transaction<BacklinkRow[]>`
      WITH query_selectors AS (
        SELECT
          (selector->>'anchorOrdinal')::integer AS anchor_ordinal,
          selector->>'selectorDigest' AS selector_digest
        FROM jsonb_array_elements(${transaction.json(requireJsonValue(selectors))}::jsonb) AS selector
      ), ranked_matches AS (
        SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
          h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, q.anchor_ordinal,
          b.citation_ordinal, b.selector_kind, b.selector_digest,
          row_number() OVER (
            PARTITION BY q.anchor_ordinal
            ORDER BY h.kind DESC, h.canonical_uri, b.citation_ordinal
          ) AS anchor_rank
        FROM query_selectors q
        JOIN remote_memory.code_link_backlinks b
          ON b.selector_kind = 'file-path' AND b.selector_digest = q.selector_digest
        JOIN remote_memory.memory_heads h
          ON h.tenant_id = b.tenant_id AND h.share_id = b.share_id AND h.id = b.head_id
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = b.tenant_id AND r.share_id = b.share_id AND r.id = b.revision_id
        JOIN remote_memory.projects p
          ON p.tenant_id = h.tenant_id AND p.share_id = h.share_id AND p.name = h.project AND p.status = 'active'
        WHERE b.tenant_id = ${principal.tenantId} AND b.share_id = ${principal.shareId}
          AND h.current_revision_id = b.revision_id AND h.status = 'active' AND h.project = ${input.project}
      )
      SELECT * FROM ranked_matches
      ORDER BY anchor_rank, anchor_ordinal, kind DESC, canonical_uri, citation_ordinal
      LIMIT 25
    `;
    return {repairState, rows, state};
  });
  const directRows = loaded.rows.slice(0, 24);
  const directSearchTruncated = loaded.rows.length > directRows.length;
  const direct: RemoteContextBriefResult[] = [];
  const directHeads = new Map<string, {readonly rows: BacklinkRow[]; readonly row: BacklinkRow}>();
  for (const row of directRows.sort(compareBacklinkRows)) {
    const key = `${row.head_id}\n${row.current_revision_id}`;
    const selected = directHeads.get(key);
    if (selected) selected.rows.push(row);
    else directHeads.set(key, {row, rows: [row]});
  }
  const matchedAnchorOrdinals = new Set<number>();
  const seen = new Set<string>();
  for (const {row, rows} of directHeads.values()) {
    if (
      row.git_commit &&
      (row.git_path !== gitCanonicalSharePath(row.kind, row.project, row.topic) || !dependencies.gitStoreConfigured)
    ) {
      continue;
    }
    if (!row.git_commit && row.git_path) continue;
    const body = await dependencies.revisionBody(row);
    if (sha256HexSync(body) !== row.content_hash) continue;
    const record = parseMemoryDocument(row.canonical_uri, body);
    if (
      !record ||
      record.metadata.status !== 'active' ||
      record.metadata.kind !== row.kind ||
      record.metadata.project !== input.project
    ) {
      continue;
    }
    const anchorOrdinals = [
      ...new Set(
        EffectArray.flatMap(rows, candidate => {
          const citation = record.metadata.codeCitations?.[candidate.citation_ordinal];
          return citation !== undefined &&
            citationMatchesRemoteBacklink(citation, candidate.selector_kind, candidate.selector_digest)
            ? [candidate.anchor_ordinal]
            : [];
        }),
      ),
    ].sort((left, right) => left - right);
    if (anchorOrdinals.length === 0) continue;
    for (const ordinal of anchorOrdinals) matchedAnchorOrdinals.add(ordinal);
    seen.add(row.canonical_uri);
    direct.push({
      anchorOrdinals,
      evidence: 'anchor',
      excerpt: remoteMemoryExcerpt(body, input.task),
      kind: row.kind,
      project: row.project,
      revision: row.current_revision_id,
      score: 1,
      status: row.status,
      topic: row.topic,
      uri: row.canonical_uri,
    });
  }
  const lexical = await dependencies.recall({
    limit: 24,
    project: input.project,
    query: input.task,
    version: 1,
  });
  const merged: RemoteContextBriefResult[] = [...direct];
  for (const result of lexical.results) {
    if (seen.has(result.uri)) continue;
    seen.add(result.uri);
    merged.push({...result, evidence: 'lexical'});
  }
  const final = await dependencies.withTenant(async transaction => {
    const state = await requireShareState(transaction, principal);
    await requireActiveProject(transaction, principal, input.project);
    const repairState = await codeLinkRepairState(transaction, principal);
    if (
      generationNumber(state.share_generation) !== generationNumber(loaded.state.share_generation) ||
      generationNumber(state.share_generation) !== lexical.receipt.shareGeneration ||
      repairState.total !== loaded.repairState.total ||
      repairState.processed !== loaded.repairState.processed
    ) {
      return undefined;
    }
    if (directHeads.size === 0) return {repairState, state};
    const headIds = EffectArray.map([...directHeads.values()], selected => selected.row.head_id);
    const current = await transaction<{current_revision_id: string; id: string; project: string; status: string}[]>`
      SELECT id, current_revision_id, project, status
      FROM remote_memory.memory_heads
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
        AND id = ANY(${transaction.array(headIds)})
    `;
    const currentById = new Map(EffectArray.map(current, head => [head.id, head]));
    return EffectArray.every([...directHeads.values()], ({row}) => {
      const head = currentById.get(row.head_id);
      return (
        head?.current_revision_id === row.current_revision_id &&
        head.project === input.project &&
        head.status === 'active'
      );
    })
      ? {repairState, state}
      : undefined;
  });
  if (!final) {
    if (attempt === 0) return compileRemoteContextBrief(principal, input, dependencies, 1);
    throw remoteMemoryError('service_unavailable', 'The remote Context Brief changed while it was being compiled.');
  }
  return {
    directSearchComplete: !directSearchTruncated && final.repairState.total === final.repairState.processed,
    directSearchTruncated,
    matchedAnchorOrdinals: [...matchedAnchorOrdinals].sort((left, right) => left - right),
    receipt: dependencies.makeReceipt(final.state),
    results: merged,
  };
}

async function codeLinkRepairState(
  transaction: ISql,
  principal: Pick<AuthorizedRemotePrincipal, 'shareId' | 'tenantId'>,
): Promise<CodeLinkRepairState> {
  const rows = await transaction<{processed: string | number; total: string | number}[]>`
    SELECT count(*) AS total, count(*) FILTER (WHERE processed_at IS NOT NULL) AS processed
    FROM remote_memory.outbox_events
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
      AND event_type = 'code_link_backfill'
  `;
  return {processed: generationNumber(rows[0]?.processed ?? 0), total: generationNumber(rows[0]?.total ?? 0)};
}

function compareBacklinkRows(left: BacklinkRow, right: BacklinkRow): number {
  return (
    left.anchor_ordinal - right.anchor_ordinal ||
    (left.kind === right.kind ? 0 : left.kind === 'durable' ? -1 : 1) ||
    Effect.pipe(left.canonical_uri, EffectString.localeCompare(right.canonical_uri)) ||
    left.citation_ordinal - right.citation_ordinal
  );
}

function generationNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) && !Number.isFinite(parsed)) {
    throw remoteMemoryError('service_unavailable', 'A remote memory generation was invalid.');
  }
  return parsed;
}
