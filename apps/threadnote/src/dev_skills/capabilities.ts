import {Effect} from 'effect';
import type {DevSkillsInstalled, DevSkillsManifest, DevSkillsRuntimeCapabilities} from './contract.js';
import {devSkillsRuntimeVersion} from './manifest.js';

export const installedSummary = (manifest: DevSkillsManifest): DevSkillsInstalled => ({
  releaseVersion: manifest.releaseVersion,
  digest: manifest.digest,
  workflowProtocol: manifest.workflowProtocol,
  stateSchema: manifest.stateSchema,
  minimumRuntime: manifest.minimumRuntime,
});
export const readDevSkillsRuntimeCapabilities = Effect.fn('devSkills.runtimeCapabilities')(function* () {
  return {
    schemaVersion: 1,
    runtimeVersion: yield* devSkillsRuntimeVersion(),
    workflowProtocols: [1],
    stateSchemas: [1],
    enrollmentSchemas: [1, 2],
  } satisfies DevSkillsRuntimeCapabilities;
});
