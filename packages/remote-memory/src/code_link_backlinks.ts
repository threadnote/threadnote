import {Array as EffectArray} from 'effect';
import type {ISql} from 'postgres';
import {deriveIndexedRecallCodeLinks, type RecallCodeLinkMatchKind} from '@threadnote/recall/code_links';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';

/** Replace the current-head projection with opaque selectors for one canonical revision. */
export async function replaceRemoteCodeLinkBacklinks(
  transaction: ISql,
  input: {
    readonly citations: readonly MemoryCodeCitationV1[];
    readonly headId: string;
    readonly revisionId: string;
    readonly shareId: string;
    readonly tenantId: string;
  },
): Promise<void> {
  await transaction`
    DELETE FROM remote_memory.code_link_backlinks
    WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId} AND head_id = ${input.headId}
  `;
  const rows = deriveIndexedRecallCodeLinks(input.citations);
  for (const row of rows) {
    await transaction`
      INSERT INTO remote_memory.code_link_backlinks(
        tenant_id, share_id, head_id, revision_id, citation_ordinal, selector_kind, selector_digest
      ) VALUES (
        ${input.tenantId}, ${input.shareId}, ${input.headId}, ${input.revisionId}, ${row.citationOrdinal},
        ${row.selectorKind}, ${row.selectorDigest}
      ) ON CONFLICT DO NOTHING
    `;
  }
}

export function citationMatchesRemoteBacklink(
  citation: MemoryCodeCitationV1,
  selectorKind: RecallCodeLinkMatchKind,
  selectorDigest: string,
): boolean {
  return EffectArray.some(
    deriveIndexedRecallCodeLinks([citation]),
    selector => selector.selectorKind === selectorKind && selector.selectorDigest === selectorDigest,
  );
}
