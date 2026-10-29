import {Array as EffectArray} from 'effect';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION} from '../inventory/policy.js';
import {codeGraphLanguagePackProvenance, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {compareCodeUnits} from '../ordering.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../store/build/core.js';
import type {CodeGraphLanguagePackProvenance} from '../store/models.js';
import {CODE_GRAPH_RESOLUTION_SURFACE_VERSION} from '../store/schema/revision.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../types.js';
import {CODE_GRAPH_WORKSPACE_MODEL_VERSION} from '../workspace.js';
import {canonicalJson} from './canonical_json.js';
import {
  CODE_GRAPH_CHECKPOINT_PATH_POLICY,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
  type CodeGraphCheckpointAbiInputV1,
} from './schema.js';

/**
 * Semantic contracts that are not SQLite schema revisions. A change to either
 * value means an imported logical graph must be rebuilt before current code can
 * extend it.
 */
export const CODE_GRAPH_CHECKPOINT_REFERENCE_RESOLUTION_VERSION =
  `resolution-surface-v${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}` as const;

export type CodeGraphCheckpointCompatibilityV1 =
  | {readonly compatible: true; readonly expected: CodeGraphCheckpointAbiInputV1}
  | {
      readonly compatible: false;
      readonly code: 'abi-mismatch' | 'language-pack-unavailable';
      readonly expected?: CodeGraphCheckpointAbiInputV1;
      readonly unavailablePackIds?: readonly string[];
    };

/** Assemble the logical ABI from authoritative runtime contracts and the exact active pack set. */
export function codeGraphCheckpointAbiInputV1(
  languagePacks: readonly CodeGraphLanguagePackProvenance[],
): CodeGraphCheckpointAbiInputV1 {
  return {
    checkpointSemanticVersion: CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
    graphSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    inventoryPolicyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
    languagePacks: EffectArray.map(
      [...languagePacks].sort((left, right) => compareCodeUnits(left.id, right.id)),
      pack => ({
        cacheIdentity: pack.cacheIdentity,
        derivationIdentity: pack.derivationIdentity,
        id: pack.id,
        resolutionDomain: pack.resolutionDomain,
        resolutionVersion: pack.resolutionVersion,
      }),
    ),
    lexicalLogicalFormatVersion: CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
    pathPolicy: CODE_GRAPH_CHECKPOINT_PATH_POLICY,
    referenceResolutionVersion: CODE_GRAPH_CHECKPOINT_REFERENCE_RESOLUTION_VERSION,
    workspaceModelVersion: CODE_GRAPH_WORKSPACE_MODEL_VERSION,
  };
}

/**
 * Compare an artifact ABI with the receiving runtime using only the packs the
 * artifact actually used. Unrelated newly installed packs do not invalidate a
 * checkpoint, while a missing or changed active pack does.
 */
export function inspectCodeGraphCheckpointCompatibilityV1(
  actual: CodeGraphCheckpointAbiInputV1,
  registry: CodeGraphLanguagePackRegistryShape,
): CodeGraphCheckpointCompatibilityV1 {
  const available = new Map(EffectArray.map(registry.packs, pack => [pack.id, codeGraphLanguagePackProvenance(pack)]));
  const unavailablePackIds = EffectArray.filter(
    EffectArray.map(actual.languagePacks, pack => pack.id),
    id => !available.has(id),
  ).sort(compareCodeUnits);
  if (unavailablePackIds.length > 0) {
    return {code: 'language-pack-unavailable', compatible: false, unavailablePackIds};
  }
  const expected = codeGraphCheckpointAbiInputV1(
    EffectArray.map(actual.languagePacks, pack => available.get(pack.id)!),
  );
  return canonicalJson(actual) === canonicalJson(expected)
    ? {compatible: true, expected}
    : {code: 'abi-mismatch', compatible: false, expected};
}
