import {Array as EffectArray} from 'effect';
import {Clock, Effect} from 'effect';
import {estimatedMaterializationStorageBytes} from './materialization.js';
import type {CodeGraphBuildAndActivateInput, CodeGraphIndexResourceGate} from './types.js';

export const measureCodeGraphAttribution = <A, E, R>(
  preparationGate: CodeGraphIndexResourceGate,
  effect: Effect.Effect<A, E, R>,
) =>
  preparationGate(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const value = yield* effect;
      return [(yield* Clock.currentTimeMillis) - startedAt, value] as const;
    }),
  );

export function coordinateCodeGraphBuild<A, E, R>(
  input: CodeGraphBuildAndActivateInput,
  build: (input: CodeGraphBuildAndActivateInput) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  const splitPreparation =
    input.persistentOwnerToken !== undefined &&
    input.incrementalPrepared !== true &&
    input.incrementalAssessment?.mode !== 'eligible';
  if (!splitPreparation && input.legacyBuildAdmission) {
    return input.legacyBuildAdmission(build({...input, legacyBuildAdmission: undefined}));
  }
  if (splitPreparation && input.preparedSpoolBudgetGate) {
    const sourceBytes = EffectArray.reduce(input.inventory.files, 0, (total, file) =>
      Math.min(Number.MAX_SAFE_INTEGER, total + file.size),
    );
    const estimate = estimatedMaterializationStorageBytes(undefined, sourceBytes, 'direct-persistent');
    const preparedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      estimate.estimatedDurableSnapshotBytes + estimate.estimatedJournalBytes,
    );
    return input.preparedSpoolBudgetGate(
      preparedBytes,
      input.building.id,
      build({...input, preparedSpoolBudgetGate: undefined}),
    );
  }
  return build(input);
}
