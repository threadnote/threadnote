import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {assessResolutionCandidateIncrementalClosure} from '@threadnote/graph/indexer/resolution_candidate_closure';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
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

  effectIt.effect('keeps the aggregate cap when the base cannot own recorded evidence', () =>
    Effect.gen(function* () {
      const files = Array.from({length: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES + 1}, (_, index) =>
        inventory(`src/oversized-${index}.ts`),
      );
      const store = new Proxy(
        {},
        {
          get: (_target, property) => {
            if (property === 'resolutionCandidateIndex') return () => Effect.succeed({state: 'unavailable'});
            if (property === 'matchResolutionCandidateIndex' || property === 'recordResolutionCandidateIndex') {
              return () => Effect.die(new Error('an unavailable owner cannot be matched or recorded'));
            }
            throw new Error(`oversized precheck touched ${String(property)}`);
          },
        },
      );
      const result = yield* assessResolutionCandidateIncrementalClosure({
        baseFileSetFingerprint: 'base',
        baseFiles: files,
        baseSnapshotId: 'base',
        candidateReexports: [],
        committedWorkspace: {diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []},
        currentChangedFiles: [],
        currentFiles: files,
        // @ts-expect-error -- The bounded-size early return must not inspect the current workspace.
        currentWorkspace: undefined,
        initialLookupKeys: [{key: 'typescript:path:src%2Fvalue.ts:name:value', resolutionDomain: 'typescript'}],
        languagePacks: BUILTIN_LANGUAGE_PACK_REGISTRY,
        // @ts-expect-error -- Only the database path is read before the bounded-size return.
        layout: {databasePath: '/unused/graph.sqlite'},
        projectCount: 1,
        // @ts-expect-error -- Reading cached facts or any other store method throws.
        store,
      });

      expect(result).toMatchObject({
        fallbackBoundary: {
          metric: 'candidate-scan-files',
          observedAtDecision: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES + 1,
        },
        mode: 'fallback',
      });
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
