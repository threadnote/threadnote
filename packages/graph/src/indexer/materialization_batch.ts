import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphStoreShape} from '../store.js';
import {Effect} from 'effect';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import type {PersistentMaterializationTransactionCandidate} from './materialization.js';
import type {CodeGraphSecondaryIndexRestorationProgressCallback} from '../store/models.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphMaterializationActivity,
  CodeGraphMaterializationMetrics,
  CodeGraphMaterializationRows,
  CodeGraphProgress,
  CodeGraphReference,
  CodeGraphSymbol,
} from '../types.js';

export interface PendingMaterializationBatch extends PersistentMaterializationTransactionCandidate {
  readonly attributionMilliseconds: number;
  readonly batchCachedFactBytes: number;
  readonly batchFiles: readonly CodeGraphInventoryFile[];
  readonly batchIndex: number;
  readonly edges: readonly CodeGraphEdge[];
  readonly loadingMilliseconds: number;
  readonly monikers: readonly CodeGraphMonikerV1[];
  readonly references: readonly CodeGraphReference[];
  rows: CodeGraphMaterializationRows;
  readonly stageMilliseconds: Map<string, number>;
  readonly symbols: readonly CodeGraphSymbol[];
}

export function secondaryIndexRestorationReporter(input: {
  readonly batchCompleted: number;
  readonly batchTotal: number;
  readonly completed: number;
  readonly metrics: () => CodeGraphMaterializationMetrics;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly refreshStorageFiles: () => Effect.Effect<void, unknown>;
  readonly reused: number;
  readonly stageMilliseconds: Partial<Record<CodeGraphMaterializationActivity['stage'], number>>;
  readonly total: number;
}): CodeGraphSecondaryIndexRestorationProgressCallback {
  return progress => {
    input.stageMilliseconds['restoring-indexes'] = progress.elapsedMilliseconds;
    return input.refreshStorageFiles().pipe(
      Effect.andThen(
        input.onProgress?.({
          activity: {
            batchCompleted: input.batchCompleted,
            batchTotal: input.batchTotal,
            elapsedMilliseconds: progress.elapsedMilliseconds,
            sourceBytes: 0,
            stage: 'restoring-indexes',
            stageElapsedMilliseconds: progress.elapsedMilliseconds,
          },
          completed: input.completed,
          metrics: input.metrics(),
          phase: 'materializing',
          reused: input.reused,
          total: input.total,
          unit: 'files',
        }) ?? Effect.void,
      ),
      Effect.ignore,
    );
  };
}

export function degradedParserCacheIdentity(activeIdentity: string): string {
  return sha256HexSync(`code-graph-parser-degraded-v1\n${activeIdentity}`);
}

export function cachedFactsMetadata(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<
  {readonly bytes: number; readonly bytesByPath: ReadonlyMap<string, number>; readonly files: number},
  unknown
> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, group.files, group.cacheIdentity, {decode: false});
        const activeKeys = active.keys ?? new Set(active.facts.keys());
        const missing = EffectArray.filter(group.files, file => !activeKeys.has(file.path));
        if (missing.length === 0)
          return {bytes: active.bytes, bytesByPath: active.bytesByPath ?? new Map(), keys: activeKeys};
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(group.cacheIdentity),
          {decode: false},
        );
        const degradedKeys = degraded.keys ?? new Set(degraded.facts.keys());
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          keys: new Set([...activeKeys, ...degradedKeys]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const bytesByPath = new Map(
        EffectArray.map(
          EffectArray.flatMap(groups, group => [...group.bytesByPath]),
          ([path, bytes]) => [path, bytes] as const,
        ),
      );
      return {
        bytes: EffectArray.reduce([...bytesByPath.values()], 0, (total, bytes) => total + bytes),
        bytesByPath,
        files: new Set(EffectArray.flatMap(groups, group => [...group.keys])).size,
      };
    }),
  );
}

export function groupFilesByCacheIdentity<T extends {readonly path: string}>(
  files: readonly T[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): readonly {readonly cacheIdentity: string; readonly files: readonly T[]}[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const matched = languagePacks.cacheIdentityForPath(file.path);
    const identity = matched._tag === 'Some' ? matched.value : 'unmatched';
    const group = groups.get(identity);
    if (group) group.push(file);
    else groups.set(identity, [file]);
  }
  return EffectArray.map(
    [...groups].sort(([left], [right]) => compareCodeUnits(left, right)),
    ([cacheIdentity, groupedFiles]) => ({cacheIdentity, files: groupedFiles}),
  );
}
