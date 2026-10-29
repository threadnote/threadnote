import type {
  CodeGraphEffectiveFileHashMatches,
  CodeGraphEffectiveFilePathObservation,
  CodeGraphEffectiveSnapshotCitationEvidence,
} from '@threadnote/graph/citation/primitives';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {receipt} from './receipt.js';
import type {ReceiptObservation} from './receipt.js';
import type {ContextBriefCitationValidationReceiptV2} from '../types.js';

export function validateContextBriefFileCitation(
  citation: MemoryCodeCitationV1,
  pathObservation: CodeGraphEffectiveFilePathObservation | undefined,
  relocation: CodeGraphEffectiveFileHashMatches | undefined,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  observedAt: string,
  fileInventoryCoverage: CodeGraphEffectiveSnapshotCitationEvidence['fileInventoryCoverage'] = 'incomplete',
): ContextBriefCitationValidationReceiptV2 {
  const result = (
    status: ContextBriefCitationValidationReceiptV2['status'],
    reason: ContextBriefCitationValidationReceiptV2['reason'],
    observation: ReceiptObservation,
  ) => receipt(citation, snapshot, status, reason, observation, observedAt);
  const exactFile = pathObservation?.file;
  if (
    exactFile?.contentHash === citation.fileContentHash.value ||
    exactFile?.rawContentHash === citation.fileContentHash.value
  ) {
    return result('exact', 'exact', {
      candidateCount: 1,
      coverage: 'current-complete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  // An occupied original locator with different bytes is changed. A duplicate
  // elsewhere must never rescue it into a false-fresh relocation.
  if (exactFile) {
    return result('changed', 'source-changed', {
      candidateCount: 1,
      coverage: 'current-complete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  const matches = relocation?.files ?? [];
  if (relocation?.truncated || matches.length > 1) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: matches.length,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  if (matches.length === 1) {
    return result(
      matches[0].path === citation.path ? 'exact' : 'relocated',
      matches[0].path === citation.path ? 'exact' : 'relocated',
      {
        candidateCount: 1,
        coverage: 'current-complete',
        observedPath: matches[0].path,
        strategy: 'content-hash',
      },
    );
  }
  if (fileInventoryCoverage === 'complete') {
    return result('deleted', 'source-deleted', {
      candidateCount: 0,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  // The graph intentionally excludes unsupported/ignored/generated paths, so
  // absence from its inventory is not repository-wide deletion proof.
  return result('unknown', 'graph-incomplete', {
    candidateCount: 0,
    coverage: 'incomplete',
    strategy: 'content-hash',
  });
}
