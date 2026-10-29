import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  collectionTrialIdentity,
  parseThreadnote5CollectionPlan,
  projectNativeRecord,
  THREADNOTE_5_COLLECTION_MATRIX,
  threadnote5CollectionPlanHash,
  type CollectionRecipe,
} from './threadnote-5-release-collection.js';
import {canonicalizeThreadnote5ScenarioRuntimeBoundariesV1} from './threadnote-5-release-readiness-capture.js';
import {
  threadnote5LocalSubsystemReceiptDigest,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from './threadnote-5-release-readiness-receipts.js';
import * as EffectRecord from 'effect/Record';

export function deriveThreadnote5PrivateCollection(
  planValue: unknown,
  transcriptsValue: unknown,
  boundariesValue: unknown,
) {
  const plan = parseThreadnote5CollectionPlan(planValue);
  if (
    !EffectArray.isArray(transcriptsValue) ||
    new TextEncoder().encode(canonicalJson(transcriptsValue)).byteLength > 64 * 1024 * 1024
  )
    throw new Error('Private transcript set is missing or exceeds its bound.');
  const runtimeBoundaries = canonicalizeThreadnote5ScenarioRuntimeBoundariesV1(
    plan.candidate,
    EffectArray.map(plan.recipes, recipe => recipe.scenario),
    boundariesValue,
  );
  const records: Threadnote5LocalSubsystemReceiptRecordV1[] = [];
  const provenance: {
    scenario: string;
    kind: string;
    trials: readonly {trialId: string; observationDigest: string}[];
  }[] = [];
  const seen = new Map<string, string>();
  let cursor = 0;
  for (const recipe of plan.recipes) {
    const matrix = EffectOption.getOrUndefined(
      EffectArray.findFirst(THREADNOTE_5_COLLECTION_MATRIX, item => item[0] === recipe.scenario),
    )!;
    const count = EffectArray.some(matrix[1], item => item[1] > 1) ? plan.measuredTrials : 1;
    const trials = Array.from({length: count}, (_, index) => {
      const value = exact(transcriptsValue[cursor++], ['identity', 'scenario', 'steps', 'mcpStderr']);
      const identity = collectionTrialIdentity(plan.runId, recipe.scenario, index);
      if (canonicalJson(value.identity) !== canonicalJson(identity) || value.scenario !== recipe.scenario)
        throw new Error('Transcript identity/scenario order is duplicated, missing, or drifting.');
      const stderr = object(value.mcpStderr);
      if (
        EffectArray.some(
          EffectRecord.toEntries(stderr),
          ([key, value]) =>
            !['primary', 'secondary'].includes(key) ||
            !EffectArray.isArray(value) ||
            EffectArray.some(value, item => typeof item !== 'string'),
        )
      )
        throw new Error('Invalid private MCP stderr capture.');
      const outputs = transcriptOutputs(recipe, value.steps, identity);
      assertUniqueNativeIdentities(outputs, identity.trialId, seen);
      return outputs;
    });
    for (const [kind] of matrix[1]) {
      const projected = projectNativeRecord(plan, recipe, kind, trials);
      const source = {
        version: 1 as const,
        candidate: plan.candidate,
        scenario: recipe.scenario,
        kind,
        artifact: projected.artifact,
      };
      records.push({...source, digest: threadnote5LocalSubsystemReceiptDigest(source)});
      provenance.push({scenario: recipe.scenario, kind, trials: projected.provenance});
    }
  }
  if (cursor !== transcriptsValue.length) throw new Error('Private transcript set has extra trials.');
  const envelope = {
    version: 1 as const,
    planHash: threadnote5CollectionPlanHash(plan),
    records,
    runtimeBoundaries,
    transcriptDigest: sha256HexSync(canonicalJson(transcriptsValue)),
    provenance,
  };
  return {...envelope, collectionHash: sha256HexSync(`threadnote-5-private-collection-v1\0${canonicalJson(envelope)}`)};
}

export type PrivateCollection = ReturnType<typeof deriveThreadnote5PrivateCollection>;

export function verifyThreadnote5PrivateCollection(input: {
  collection: unknown;
  plan: unknown;
  transcripts: unknown;
}): PrivateCollection {
  const collection = exact(input.collection, [
    'version',
    'planHash',
    'records',
    'runtimeBoundaries',
    'transcriptDigest',
    'provenance',
    'collectionHash',
  ]);
  const derived = deriveThreadnote5PrivateCollection(input.plan, input.transcripts, collection.runtimeBoundaries);
  if (canonicalJson(collection) !== canonicalJson(derived))
    throw new Error(
      'Private collection differs from its recomputed plan, transcripts, native records, provenance, or digest.',
    );
  return derived;
}

export function threadnote5CollectionAuthorityBindingHash(value: unknown): string {
  const binding = exact(value, ['version', 'collectionHash', 'authorityManifestHash']);
  if (binding.version !== 1 || !hash(binding.collectionHash) || !hash(binding.authorityManifestHash))
    throw new Error('Invalid collection authority binding.');
  return sha256HexSync(`threadnote-5-collection-authority-binding-v1\0${canonicalJson(binding)}`);
}

export function verifyThreadnote5CollectionAuthorityBinding(input: {
  binding: unknown;
  expectedBindingSha256: string;
  collectionHash: string;
  authorityManifestHash: string;
}): void {
  const digest = threadnote5CollectionAuthorityBindingHash(input.binding);
  if (
    !hash(input.expectedBindingSha256) ||
    digest !== input.expectedBindingSha256 ||
    canonicalJson(input.binding) !==
      canonicalJson({
        version: 1,
        collectionHash: input.collectionHash,
        authorityManifestHash: input.authorityManifestHash,
      })
  )
    throw new Error('Collection is not bound to independently reviewed authority.');
}

function transcriptOutputs(
  recipe: CollectionRecipe,
  value: unknown,
  identity: ReturnType<typeof collectionTrialIdentity>,
): Record<string, unknown> {
  if (!EffectArray.isArray(value) || value.length !== recipe.steps.length)
    throw new Error('Transcript steps do not exactly cover the reviewed recipe.');
  const outputs: Record<string, unknown> = {};
  for (const [index, raw] of value.entries()) {
    const item = exact(raw, ['step', 'bindings', 'output']);
    const step = recipe.steps[index];
    if (canonicalJson(item.step) !== canonicalJson(step))
      throw new Error('Transcript step differs from the reviewed recipe.');
    const bindings = exact(item.bindings, [
      'laneId',
      'trialId',
      'reviewId',
      'proposalId',
      'activationId',
      'home',
      'userHome',
      'repo',
      'primaryRepo',
      'secondaryRepo',
      'remote',
    ]);
    if (EffectArray.some(EffectRecord.values(bindings), value => typeof value !== 'string'))
      throw new Error('Invalid private transcript bindings.');
    if (EffectArray.some(EffectRecord.toEntries(identity), ([key, value]) => bindings[key] !== value))
      throw new Error('Private transcript bindings reuse another trial identity.');
    if (step.type === 'write') {
      if (item.output !== null) throw new Error('Synthetic writes cannot supply native observations.');
      continue;
    }
    if (step.type === 'cli') {
      const result = exact(item.output, ['stdout', 'stderr', 'exitCode', 'elapsedMilliseconds', 'json']);
      if (
        typeof result.stdout !== 'string' ||
        typeof result.stderr !== 'string' ||
        result.exitCode !== step.expectedExit ||
        typeof result.elapsedMilliseconds !== 'number' ||
        !Number.isSafeInteger(result.elapsedMilliseconds) ||
        result.elapsedMilliseconds < 0
      )
        throw new Error('Invalid native CLI transcript.');
      let json: unknown = null;
      try {
        json = JSON.parse(result.stdout);
      } catch {
        /* Native text remains text. */
      }
      if (canonicalJson(json) !== canonicalJson(result.json))
        throw new Error('CLI JSON differs from the captured raw stdout.');
    }
    if (step.type === 'mcp' && object(item.output).isError === true)
      throw new Error('Failed MCP calls cannot supply observations.');
    outputs[step.id] = item.output;
  }
  return outputs;
}

export function assertUniqueNativeIdentities(value: unknown, trial: string, seen: Map<string, string>): void {
  if (EffectArray.isArray(value)) {
    EffectArray.forEach(value, item => assertUniqueNativeIdentities(item, trial, seen));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This recursively validated input is an arbitrary object.
  for (const [key, item] of Object.entries(value)) {
    if (
      ['laneId', 'trialId', 'reviewId', 'proposalId', 'activationId'].includes(key) &&
      typeof item === 'string' &&
      item.length > 0
    ) {
      const identity = `${key}\0${item}`;
      const previous = seen.get(identity);
      if (previous !== undefined && previous !== trial)
        throw new Error('Native identities were reused across collection trials.');
      seen.set(identity, trial);
    }
    assertUniqueNativeIdentities(item, trial, seen);
  }
}

function hash(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error('Private collection field must be an object.');
  return value;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (canonicalJson(EffectRecord.keys(result).sort()) !== canonicalJson([...keys].sort()))
    throw new Error('Private collection object has missing or extra fields.');
  return result;
}
