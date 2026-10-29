import {Array as EffectArray} from 'effect';
import type {ResolvedSuperhumanSelection, SuperhumanDocumentSelection} from './selection-contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const MAX_SUPERHUMAN_MANAGER_LINKS = 64;

export function retainedSuperhumanSelection(
  documents: readonly SuperhumanDocumentSelection[],
): ResolvedSuperhumanSelection {
  return {
    documents,
    selections: EffectArray.flatMap(documents, document =>
      document.pages === undefined
        ? [{documentId: document.id, name: `Document ${document.id}`}]
        : EffectArray.map(document.pages, pageId => ({documentId: document.id, pageId, name: `Page ${pageId}`})),
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
  const documents = EffectArray.map(
    [...byDocument].sort(([left], [right]) => Effect.pipe(left, EffectString.localeCompare(right))),
    ([id, pages]) => (pages === null ? {id} : {id, pages: [...pages].sort()}),
  );
  const bySelection = new Map<string, ResolvedSuperhumanSelection['selections'][number]>();
  for (const selection of selections) {
    if (byDocument.get(selection.documentId) === null && selection.pageId !== undefined) continue;
    const key = `${selection.documentId}\0${selection.pageId ?? ''}`;
    const previous = bySelection.get(key);
    const rank = (item: typeof selection) =>
      `${item.browserLink === undefined ? '1' : '0'}${item.iconUrl === undefined ? '1' : '0'}\0${item.name}\0${item.browserLink ?? ''}\0${item.iconUrl ?? ''}`;
    if (!previous || Effect.pipe(rank(selection), EffectString.localeCompare(rank(previous))) < 0)
      bySelection.set(key, selection);
  }
  return {
    documents,
    selections: EffectArray.map(
      [...bySelection].sort(([left], [right]) => Effect.pipe(left, EffectString.localeCompare(right))),
      ([, selection]) => selection,
    ),
  };
}
