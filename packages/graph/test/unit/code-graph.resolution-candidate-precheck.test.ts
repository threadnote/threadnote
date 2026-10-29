import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {assessResolutionCandidateIncrementalClosure} from '@threadnote/graph/indexer/resolution_candidate_closure';
import {PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES} from '@threadnote/graph/store/resolution/candidate_closure';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';

describe('resolution-candidate precheck', () => {
  effectIt.effect('rejects oversized inventories before requesting cache metadata', () =>
    Effect.gen(function* () {
      const files = Array.from({length: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES + 1}, (_, index) =>
        inventory(`src/oversized-${index}.ts`),
      );
      let storeAccesses = 0;
      const store = new Proxy(
        {},
        {
          get: () => {
            storeAccesses += 1;
            throw new Error('oversized precheck touched the graph store');
          },
        },
      );
      const result = yield* assessResolutionCandidateIncrementalClosure({
        baseFileSetFingerprint: 'base',
        baseFiles: files,
        candidateReexports: [],
        // @ts-expect-error -- The bounded-size early return must not inspect either workspace dependency.
        committedWorkspace: undefined,
        currentChangedFiles: [],
        currentFiles: files,
        // @ts-expect-error -- The bounded-size early return must not inspect either workspace dependency.
        currentWorkspace: undefined,
        initialLookupKeys: [{key: 'typescript:path:src%2Fvalue.ts:name:value', resolutionDomain: 'typescript'}],
        // @ts-expect-error -- The bounded-size early return must not request language metadata.
        languagePacks: undefined,
        // @ts-expect-error -- The bounded-size early return must not read the graph database layout.
        layout: undefined,
        projectCount: 1,
        // @ts-expect-error -- The oversized inventory must return without accessing any graph-store method.
        store,
      });

      expect(result).toMatchObject({
        fallbackBoundary: {
          limit: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES,
          metric: 'candidate-scan-files',
          observedAtDecision: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES + 1,
        },
        mode: 'fallback',
        reason: 'project-closure-unbounded',
      });
      expect(storeAccesses).toBe(0);
    }),
  );
});

function inventory(path: string): CodeGraphInventoryFile {
  return {
    blobId: path,
    contentHash: path,
    language: 'typescript',
    mode: '100644',
    path,
    size: 1,
    source: 'worktree',
  };
}
