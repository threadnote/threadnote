import {it as effectIt} from '@effect/vitest';
import {Context, Effect, Layer, Option} from 'effect';
import {describe, expect} from 'vitest';
import {assessIncrementalOverlay} from '@threadnote/graph/indexer/incremental';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import type {CodeGraphLayout} from '@threadnote/graph/layout';
import {
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  CodeGraphStore,
  type CodeGraphReusableBaseReceipt,
} from '@threadnote/graph/store';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSnapshot} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('incremental reusable-base receipt', () => {
  effectIt.effect('reuses the admitted immutable receipt and fails closed on a mismatched identity', () =>
    Effect.gen(function* () {
      const snapshot = readySnapshot('base');
      const file = inventoryFile();
      const facts = [{diagnostics: [], edges: [], path: file.path, symbols: []}] satisfies CodeGraphFileFacts[];
      const receipt = reusableReceipt(snapshot.id);
      let receiptReads = 0;
      const storeContext = yield* Layer.build(
        Layer.mock(CodeGraphStore, {
          reusableBaseReceipt: () =>
            Effect.sync(() => {
              receiptReads += 1;
              return receipt;
            }),
        }),
      );
      const store = Context.get(storeContext, CodeGraphStore);
      const common = {
        building: {...snapshot, id: 'overlay', state: 'building' as const},
        committedBase: {
          diagnostics: [],
          leaseToken: Option.none<string>(),
          snapshot,
          stagingReusable: false,
        },
        force: false,
        incrementalOverlayEnabled: true,
        inventory: {
          committedFiles: [file],
          committedParsedFiles: 0,
          diagnostics: [],
          dirty: true,
          files: [file],
          parsedFiles: 1,
          skipped: 0,
        },
        languagePacks: BUILTIN_LANGUAGE_PACK_REGISTRY,
        layout: {
          checkoutId: 'checkout',
          databasePath: '/tmp/graph.sqlite',
          databaseWriteLockPath: '/tmp/graph.sqlite.lock',
          lockPath: '/tmp/graph.lock',
          repositoryRoot: '/tmp/repository',
          staleMarkerPath: '/tmp/graph.stale',
          vectorRoot: '/tmp/vectors',
          worktreeId: 'worktree',
          worktreeLockRoot: '/tmp/worktree-locks',
        } satisfies CodeGraphLayout,
        store,
        totalFiles: 1,
      };
      const preassessment = {
        baseFileSetFingerprint: 'files',
        committedWorkspace: workspace,
        facts,
        files: [file],
        mode: 'compatible' as const,
      };

      const supplied = yield* assessIncrementalOverlay(
        {...common, committedBaseReceipt: receipt},
        workspace,
        preassessment,
      );
      expect(supplied.mode).toBe('eligible');
      expect(receiptReads).toBe(0);

      const mismatched = yield* assessIncrementalOverlay(
        {...common, committedBaseReceipt: {...receipt, snapshotId: 'other'}},
        workspace,
        preassessment,
      );
      expect(mismatched).toEqual({mode: 'fallback', reason: 'staging-unavailable'});
      expect(receiptReads).toBe(0);

      const loaded = yield* assessIncrementalOverlay(common, workspace, preassessment);
      expect(loaded.mode).toBe('eligible');
      expect(receiptReads).toBe(1);
    }),
  );
});

const workspace = {diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []} as const;

function reusableReceipt(snapshotId: string): CodeGraphReusableBaseReceipt {
  return {
    aliasCount: 0,
    fileSetFingerprint: 'files',
    formatVersion: CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
    lookupCount: 0,
    packProvenance: [],
    reexportCount: 0,
    resolutionSurfaceVersion: 1,
    snapshotId,
    workspaceFingerprint: workspace.fingerprint,
  };
}

function readySnapshot(id: string): CodeGraphSnapshot {
  return {
    commit: Effect2.pipe('a', EffectString.repeat(40)),
    dirty: false,
    edgeCount: 0,
    extractorSet: 'extractors',
    fileCount: 1,
    id,
    repositoryId: 'repository',
    state: 'ready',
    symbolCount: 0,
    worktreeId: 'worktree',
  };
}

function inventoryFile(): CodeGraphInventoryFile {
  return {
    blobId: Effect2.pipe('b', EffectString.repeat(40)),
    contentHash: Effect2.pipe('c', EffectString.repeat(64)),
    language: 'typescript',
    mode: '100644',
    path: 'src/value.ts',
    size: 1,
    source: 'commit',
  };
}
