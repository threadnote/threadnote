import {Effect, FileSystem, Path} from 'effect';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {withCodeGraphCandidateStageSlot, codeGraphCandidateStageOwnership} from '../builder/admission.js';
import type {CodeGraphBuilderAdmissionIdentity} from '../builder/admission_scheduler.js';
import {CodeGraphBuildResourceOrderError, type CodeGraphBuildResourceCoordinator} from '../build/resources.js';
import type {CodeGraphIndexResourceGate} from './types.js';

/** Preserve the actual owner capabilities through ordinary/extraction wrappers without changing their lifetimes. */
export function makeCandidatePreparationGates(input: {
  readonly admit: CodeGraphIndexResourceGate;
  readonly ordinaryPreparation: CodeGraphIndexResourceGate;
  readonly resources: CodeGraphBuildResourceCoordinator;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly system: SystemInfoShape;
  readonly threadnoteHome: string;
  readonly identity: CodeGraphBuilderAdmissionIdentity;
}) {
  const preparationGate: CodeGraphIndexResourceGate = Object.assign(input.ordinaryPreparation, {
    candidateStage: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withCodeGraphCandidateStageSlot(
        {threadnoteHome: input.threadnoteHome, identity: input.identity},
        owned =>
          input.admit(
            Effect.acquireUseRelease(
              input.resources.acquireCandidateStage,
              () => owned,
              () => input.resources.releaseCandidateStage,
            ),
          ),
        effect,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, input.fs),
        Effect.provideService(Path.Path, input.path),
        Effect.provideService(SystemInfo, input.system),
      ),
    coveredPreparation: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      codeGraphCandidateStageOwnership({
        threadnoteHome: input.threadnoteHome,
        identity: input.identity,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, input.fs),
        Effect.provideService(Path.Path, input.path),
        Effect.provideService(SystemInfo, input.system),
        Effect.flatMap(mode =>
          mode === 'borrowed'
            ? input.resources.current.pipe(
                Effect.flatMap(current =>
                  Effect.gen(function* () {
                    if (!current.legacyBuilder || current.preparation || current.writer)
                      return yield* CodeGraphBuildResourceOrderError.make({
                        message: 'Borrowed candidate preparation lacks its actual legacy compute owner.',
                      });
                    return yield* effect;
                  }),
                ),
              )
            : Effect.acquireUseRelease(
                input.resources.acquirePreparation,
                () => effect,
                () => input.resources.releasePreparation,
              ),
        ),
      ),
  });
  const extractionPreparationGate: CodeGraphIndexResourceGate = Object.assign(
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      input.resources.current.pipe(
        Effect.flatMap(current => (current.legacyBuilder ? effect : preparationGate(effect))),
      ),
    {
      candidateStage: preparationGate.candidateStage,
      coveredPreparation: preparationGate.coveredPreparation,
    },
  );
  return {preparationGate, extractionPreparationGate};
}
