import {Array as EffectArray, Clock, Effect} from 'effect';
import {resolutionCandidateFileEvidence} from '../materialization/candidate_evidence.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphMaterializationMetrics} from '../types.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../store.js';
import type {
  CodeGraphBuildAndActivateInput,
  CodeGraphIndexResourceGate,
  IncrementalOverlayAssessment,
} from './types.js';
import {
  addMaterializationReplayMetrics,
  loadCachedFacts,
  type CodeGraphMaterializationReplayMetrics,
} from './materialization.js';
import {measureCodeGraphAttribution} from './build_coordination.js';

/** Optional evidence construction accounts for its additional warm-shard work separately and in aggregate. */
export function makeResolutionCandidateEvidenceBuilder(
  input: Pick<CodeGraphBuildAndActivateInput, 'store' | 'layout' | 'building' | 'languagePacks'>,
  runPreparation: CodeGraphIndexResourceGate,
  protector?: CodeGraphDirectPersistentCapacityProtector,
) {
  let rawFilesLoaded = 0;
  let unsupportedFiles = 0;
  const progress = {
    rawFactReplayBytesCompleted: 0,
    attributedFilesCompleted: 0,
    loadingMilliseconds: 0,
    attributionMilliseconds: 0,
    stagingMilliseconds: 0,
  };
  const stage = Effect.fn('codeGraph.stageOptionalCandidateEvidence')(function* (
    files: readonly CodeGraphInventoryFile[],
    source: readonly CodeGraphFileFacts[],
    bounded: readonly CodeGraphFileFacts[],
  ) {
    if (!input.store.stageResolutionCandidateIndex) return;
    const started = yield* Clock.currentTimeMillis;
    const evidence = resolutionCandidateFileEvidence(files, source, bounded, input.building.id);
    unsupportedFiles += files.length - evidence.files.length;
    yield* input.store.stageResolutionCandidateIndex(
      input.layout.databasePath,
      {snapshotId: input.building.id, ...evidence},
      protector,
    );
    progress.stagingMilliseconds += (yield* Clock.currentTimeMillis) - started;
  });
  return {
    enabled: input.store.stageResolutionCandidateIndex !== undefined,
    progress,
    summary: () => ({rawFilesLoaded, rawFactBytesLoaded: progress.rawFactReplayBytesCompleted, unsupportedFiles}),
    stageFull: Effect.fn('codeGraph.stageFullCandidateEvidence')(function* (batch: {
      readonly files: readonly CodeGraphInventoryFile[];
      readonly facts: readonly CodeGraphFileFacts[];
      readonly bounded: readonly CodeGraphFileFacts[];
      readonly warm: boolean;
      readonly attributeFacts: (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[];
    }) {
      if (!input.store.stageResolutionCandidateIndex) return;
      let source = batch.facts;
      if (batch.warm) {
        const started = yield* Clock.currentTimeMillis;
        const loaded = yield* runPreparation(
          loadCachedFacts(input.store, input.layout.databasePath, batch.files, input.languagePacks),
        );
        progress.loadingMilliseconds += (yield* Clock.currentTimeMillis) - started;
        rawFilesLoaded += loaded.facts.size;
        progress.rawFactReplayBytesCompleted += loaded.bytes;
        const complete = EffectArray.every(batch.files, file => loaded.facts.has(file.path));
        source = [];
        if (complete) {
          const [elapsed, attributed] = yield* measureCodeGraphAttribution(
            runPreparation,
            Effect.sync(() =>
              batch.attributeFacts(
                EffectArray.map(batch.files, file =>
                  input.languagePacks.postprocessFile(file, loaded.facts.get(file.path)!),
                ),
              ),
            ),
          );
          progress.attributionMilliseconds += elapsed;
          progress.attributedFilesCompleted += batch.files.length;
          source = attributed;
        }
      }
      yield* stage(batch.files, source, batch.bounded);
    }),
    stageIncremental: (assessment: Extract<IncrementalOverlayAssessment, {readonly mode: 'eligible'}>) =>
      stage(assessment.files, assessment.candidateFacts ?? assessment.facts, assessment.facts),
    metrics: (
      graph: CodeGraphMaterializationReplayMetrics,
      timing: {
        readonly loadingMilliseconds: number;
        readonly attributionMilliseconds: number;
        readonly stageMilliseconds: CodeGraphMaterializationMetrics['stageMilliseconds'];
      },
    ) => ({
      ...addMaterializationReplayMetrics(graph, {
        rawFactReplayBytes: progress.rawFactReplayBytesCompleted,
        attributedFiles: progress.attributedFilesCompleted,
      }),
      loadingMilliseconds: timing.loadingMilliseconds + progress.loadingMilliseconds,
      attributionMilliseconds: timing.attributionMilliseconds + progress.attributionMilliseconds,
      graphMaterialization: {
        ...graph,
        loadingMilliseconds: timing.loadingMilliseconds,
        attributionMilliseconds: timing.attributionMilliseconds,
      },
      candidateIndex: {...progress},
      stageMilliseconds: {
        ...timing.stageMilliseconds,
        'loading-cache': timing.loadingMilliseconds + progress.loadingMilliseconds,
        attributing: timing.attributionMilliseconds + progress.attributionMilliseconds,
        'writing-candidates': (timing.stageMilliseconds?.['writing-candidates'] ?? 0) + progress.stagingMilliseconds,
      },
    }),
  };
}
