import {Array as EffectArray} from 'effect';
import type {ISql} from 'postgres';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import type {RemoteCitationSource} from '@threadnote/memory/remote/citation_sources';
import {parseRemoteShareAddress} from '@threadnote/memory/remote/address';
import type {AuthorizedRemotePrincipal} from './authorization.js';
import {assertRemoteBodyReplacementSupported} from './document_compatibility.js';
import {remoteMemoryError} from './errors.js';
import {gitCanonicalSharePath, type GitCanonicalMemoryStore} from './git/canonical_store.js';
import {requireActiveProject, requirePrincipalProject} from './repository_policy.js';
import {Option as EffectOption} from 'effect';

export interface ResolvedRemoteCitationSources {
  readonly citations: readonly MemoryCodeCitationV1[];
  readonly expectedSourceHashes: readonly {readonly path: string; readonly contentHash: string}[];
}

export async function resolveRemoteCitationSources(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
  sources: readonly RemoteCitationSource[],
  gitStore: GitCanonicalMemoryStore | undefined,
): Promise<ResolvedRemoteCitationSources> {
  const citations = new Map<string, MemoryCodeCitationV1>();
  const expectedSourceHashes = [];
  for (const uri of new Set(EffectArray.map(sources, source => source.uri))) {
    const address = parseRemoteShareAddress(uri);
    requirePrincipalProject(principal, address.project);
    await requireActiveProject(transaction, principal, address.project);
    const rows = await transaction<{content_hash: string; git_commit: string | null; git_path: string | null}[]>`
      SELECT r.content_hash, r.git_commit, r.git_path
      FROM remote_memory.memory_heads h JOIN remote_memory.memory_revisions r
        ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
      WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
        AND h.canonical_uri = ${uri} AND h.status = 'active'
        AND (h.expires_at IS NULL OR h.expires_at > now())
    `;
    const row = rows[0];
    if (
      !gitStore ||
      !row?.git_commit ||
      row.git_path !== gitCanonicalSharePath(address.kind, address.project, address.topic)
    ) {
      throw remoteMemoryError('invalid_request', 'Citation sources must resolve to active Git-canonical memories.');
    }
    const content = await gitStore.read({commit: row.git_commit, path: row.git_path});
    if (sha256HexSync(content) !== row.content_hash) {
      throw remoteMemoryError('conflict', 'The citation source no longer matches its current memory head.');
    }
    for (const citation of selectRemoteCanonicalCitations(
      uri,
      content,
      EffectArray.filter(sources, source => source.uri === uri),
    )) {
      citations.set(citation.id, citation);
    }
    expectedSourceHashes.push({path: row.git_path, contentHash: row.content_hash});
  }
  return {citations: [...citations.values()], expectedSourceHashes};
}

export function selectRemoteCanonicalCitations(
  uri: string,
  content: string,
  sources: readonly RemoteCitationSource[],
): readonly MemoryCodeCitationV1[] {
  const address = parseRemoteShareAddress(uri);
  assertRemoteBodyReplacementSupported(content);
  const record = parseMemoryDocument(uri, content);
  if (
    !record ||
    record.metadata.status !== 'active' ||
    record.metadata.kind !== address.kind ||
    record.metadata.project !== address.project ||
    record.metadata.topic !== address.topic
  ) {
    throw remoteMemoryError(
      'invalid_request',
      'The citation source metadata does not identify an active donor memory.',
    );
  }
  return EffectArray.map(sources, source => {
    const citation = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(record.metadata.codeCitations), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(__effectArrayReceiver, candidate => candidate.id === source.citationId),
        ),
      ),
    );
    if (!citation)
      throw remoteMemoryError('invalid_request', 'The selected canonical citation does not exist in the donor memory.');
    return citation;
  });
}
