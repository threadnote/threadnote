import {Effect} from 'effect';
import type {DevSkillsInstalled, DevSkillsManifest, DevSkillsRuntimeCapabilities} from './contract.js';
import {nativeRequirements, devSkillsRuntimeVersion} from './manifest.js';

export const installedSummary = (manifest: DevSkillsManifest): DevSkillsInstalled => ({
  ...(manifest.schemaVersion === 2
    ? {manifestSchema: 2 as const, nativeRequirements: manifest.nativeRequirements}
    : {}),
  releaseVersion: manifest.releaseVersion,
  digest: manifest.digest,
  workflowProtocol: manifest.workflowProtocol,
  stateSchema: manifest.stateSchema,
  minimumRuntime: manifest.minimumRuntime,
});
export const readDevSkillsRuntimeCapabilities = Effect.fn('devSkills.runtimeCapabilities')(function* () {
  return {
    schemaVersion: 2,
    manifestSchemas: [1, 2],
    nativeFeatures: nativeRequirements,
    runtimeVersion: yield* devSkillsRuntimeVersion(),
    workflowProtocols: [1],
    stateSchemas: [1],
    enrollmentSchemas: [1, 2],
  } satisfies DevSkillsRuntimeCapabilities;
});
