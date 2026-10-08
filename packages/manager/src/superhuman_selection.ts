import type {ResolvedSuperhumanSelection, SuperhumanDocumentSelection} from './integrations_contracts.js';

export const MAX_SUPERHUMAN_MANAGER_LINKS = 64;

export function retainedSuperhumanSelection(
  documents: readonly SuperhumanDocumentSelection[],
): ResolvedSuperhumanSelection {
  return {
    documents,
    selections: documents.flatMap(document =>
      document.pages === undefined
        ? [{documentId: document.id, name: `Document ${document.id}`}]
        : document.pages.map(pageId => ({documentId: document.id, pageId, name: `Page ${pageId}`})),
    ),
  };
}

/** Whole-document scope subsumes its pages; duplicate identities remain one chip. */
export function mergeResolvedSuperhumanSelections(
  selections: ResolvedSuperhumanSelection['selections'],
): ResolvedSuperhumanSelection {
  const byDocument = new Map<string, Set<string> | null>();
  for (const selection of selections) {
    const previous = byDocument.get(selection.documentId);
    if (selection.pageId === undefined) byDocument.set(selection.documentId, null);
    else if (previous !== null) byDocument.set(selection.documentId, (previous ?? new Set()).add(selection.pageId));
  }
  const documents = [...byDocument]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, pages]) => (pages === null ? {id} : {id, pages: [...pages].sort()}));
  const bySelection = new Map<string, ResolvedSuperhumanSelection['selections'][number]>();
  for (const selection of selections) {
    if (byDocument.get(selection.documentId) === null && selection.pageId !== undefined) continue;
    const key = `${selection.documentId}\0${selection.pageId ?? ''}`;
    const previous = bySelection.get(key);
    const rank = (item: typeof selection) =>
      `${item.browserLink === undefined ? '1' : '0'}${item.iconUrl === undefined ? '1' : '0'}\0${item.name}\0${item.browserLink ?? ''}\0${item.iconUrl ?? ''}`;
    if (!previous || rank(selection).localeCompare(rank(previous)) < 0) bySelection.set(key, selection);
  }
  return {
    documents,
    selections: [...bySelection].sort(([left], [right]) => left.localeCompare(right)).map(([, selection]) => selection),
  };
}
