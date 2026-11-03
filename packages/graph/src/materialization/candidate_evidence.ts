import {Array as EffectArray} from 'effect';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';
import {
  RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
  resolutionCandidateFileRepresentable,
} from '../store/resolution/candidate_index.js';

/** The reference stream precedes final fact compaction; direct-symbol lookup must still cover its complete key surface. */
export function resolutionCandidateFileEvidence(
  files: readonly CodeGraphInventoryFile[],
  source: readonly CodeGraphFileFacts[],
  bounded: readonly CodeGraphFileFacts[],
  snapshotId: string,
) {
  const filesByPath = new Map(EffectArray.map(files, file => [file.path, file]));
  const boundedByPath = new Map(EffectArray.map(bounded, facts => [facts.path, facts]));
  const eligible = EffectArray.filter(source, facts => {
    const final = boundedByPath.get(facts.path);
    if (!final || !filesByPath.has(facts.path)) return false;
    const finalSymbols = new Map(EffectArray.map(final.symbols, symbol => [symbol.id, symbol]));
    for (const symbol of facts.symbols) {
      if ((symbol.lookupKeys?.length ?? 0) === 0) continue;
      const target = finalSymbols.get(symbol.id);
      if (!target || target.resolutionDomain !== symbol.resolutionDomain || target.path !== symbol.path) return false;
      const keys = new Set(target.lookupKeys);
      if (
        keys.size !== new Set(symbol.lookupKeys).size ||
        EffectArray.some(symbol.lookupKeys ?? [], key => !keys.has(key))
      )
        return false;
    }
    const references = facts.references ?? [];
    if (!resolutionCandidateFileRepresentable(snapshotId, filesByPath.get(facts.path)!, references)) return false;
    if (new Set(EffectArray.map(references, reference => reference.edgeId)).size !== references.length) return false;
    return EffectArray.every(
      references,
      reference =>
        reference.evidencePath === facts.path &&
        reference.resolutionDomain.length > 0 &&
        EffectArray.every(
          [...EffectArray.flatMap(reference.lookupTiers, tier => tier), ...(reference.aliasLookupKeys ?? [])],
          key => key.length > 0,
        ) &&
        Buffer.byteLength(JSON.stringify(reference)) <= RESOLUTION_CANDIDATE_INDEX_PAYLOAD_BYTES,
    );
  });
  return {
    files: EffectArray.map(eligible, facts => filesByPath.get(facts.path)!),
    references: EffectArray.flatMap(eligible, facts => facts.references ?? []),
  };
}
