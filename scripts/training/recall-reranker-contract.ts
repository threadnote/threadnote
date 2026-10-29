import {Array as EffectArray} from 'effect';
import {ScriptError} from '../effect/errors.js';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {detectSecretMatches} from '@threadnote/platform/scrubber';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const RECALL_RERANKER_DATASET_VERSION = 1 as const;
export const RECALL_RERANKER_MAX_CANDIDATES = 32 as const;

export const RECALL_RERANKER_DATASET_PURPOSES = ['evaluation_holdout', 'harness_smoke', 'training_candidate'] as const;
export const RECALL_RERANKER_SPLITS = ['train', 'validation', 'test'] as const;
export const RECALL_RERANKER_ANSWERABILITY = ['answerable', 'no_answer'] as const;
export const RECALL_RERANKER_SOURCE_KINDS = [
  'opt_in_sanitized',
  'public_dataset',
  'public_repository',
  'self_authored_synthetic',
] as const;
export const RECALL_RERANKER_PRIVACY_BASES = ['explicit_opt_in', 'public_licensed', 'self_authored'] as const;
export const RECALL_RERANKER_NEGATIVE_KINDS = [
  'adversarial',
  'cross_repository',
  'lexical_hard',
  'low_authority',
  'no_answer_distractor',
  'random',
  'semantic_hard',
  'stale',
  'wrong_scope',
  'wrong_version',
] as const;

export type RecallRerankerDatasetPurpose = (typeof RECALL_RERANKER_DATASET_PURPOSES)[number];
export type RecallRerankerSplit = (typeof RECALL_RERANKER_SPLITS)[number];
export type RecallRerankerAnswerability = (typeof RECALL_RERANKER_ANSWERABILITY)[number];
export type RecallRerankerSourceKind = (typeof RECALL_RERANKER_SOURCE_KINDS)[number];
export type RecallRerankerPrivacyBasis = (typeof RECALL_RERANKER_PRIVACY_BASES)[number];
export type RecallRerankerNegativeKind = (typeof RECALL_RERANKER_NEGATIVE_KINDS)[number];

export interface RecallRerankerSourceV1 {
  readonly consentReference?: string;
  readonly id: string;
  readonly kind: RecallRerankerSourceKind;
  readonly license: string;
  readonly licenseUrl: string;
  readonly privacyBasis: RecallRerankerPrivacyBasis;
  readonly provenance: string;
  readonly redistributionApproved: boolean;
  readonly revision: string;
  readonly sourceUri: string;
  readonly trainingApproved: boolean;
}

export interface RecallRerankerCandidateV1 {
  readonly id: string;
  readonly language: string;
  readonly negativeKind?: RecallRerankerNegativeKind;
  readonly provenanceRecord: string;
  readonly relevance: number;
  readonly reviewed: boolean;
  readonly sourceId: string;
  readonly text: string;
  readonly title?: string;
}

export interface RecallRerankerQueryGroupV1 {
  readonly answerability: RecallRerankerAnswerability;
  readonly candidates: readonly RecallRerankerCandidateV1[];
  readonly id: string;
  readonly language: string;
  readonly partitionKey: string;
  readonly provenanceRecord: string;
  readonly query: string;
  readonly sourceId: string;
  readonly split: RecallRerankerSplit;
  readonly version: typeof RECALL_RERANKER_DATASET_VERSION;
}

export interface RecallRerankerDatasetCountsV1 {
  readonly candidates: number;
  readonly groups: number;
  readonly noAnswerGroups: number;
  readonly splits: Readonly<Record<RecallRerankerSplit, number>>;
}

export interface RecallRerankerReservedEvaluationV1 {
  readonly name: string;
  readonly sha256: string;
}

export interface RecallRerankerDatasetManifestV1 {
  readonly counts: RecallRerankerDatasetCountsV1;
  readonly createdAt: string;
  readonly description: string;
  readonly generatorRevision: string;
  readonly groupFile: string;
  readonly groupFileSha256: string;
  readonly groupsSha256: string;
  readonly labelMethod: string;
  readonly name: string;
  readonly partitionStrategy: string;
  readonly privacyReviewed: boolean;
  readonly purpose: RecallRerankerDatasetPurpose;
  readonly reservedEvaluations: readonly RecallRerankerReservedEvaluationV1[];
  readonly seed: number;
  readonly sources: readonly RecallRerankerSourceV1[];
  readonly version: typeof RECALL_RERANKER_DATASET_VERSION;
}

export interface RecallRerankerDatasetV1 {
  readonly groups: readonly RecallRerankerQueryGroupV1[];
  readonly manifest: RecallRerankerDatasetManifestV1;
}

export interface RecallRerankerValidationPolicyV1 {
  readonly forbiddenTextsSha256: string;
  readonly receiptFile: string;
  readonly reservedEvaluation: RecallRerankerReservedEvaluationV1;
  readonly validatorId: string;
  readonly version: 1;
}

export interface RecallRerankerValidationReceiptV1 {
  readonly datasetName: string;
  readonly datasetVersion: typeof RECALL_RERANKER_DATASET_VERSION;
  readonly forbiddenTextsSha256: string;
  readonly groupFileSha256: string;
  readonly groupsSha256: string;
  readonly manifestSha256: string;
  readonly reservedEvaluation: RecallRerankerReservedEvaluationV1;
  readonly validationPolicySha256: string;
  readonly validatorId: string;
  readonly version: 1;
}

export interface RecallRerankerDatasetDraftV1 {
  readonly createdAt: string;
  readonly description: string;
  readonly generatorRevision: string;
  readonly groupFile?: string;
  readonly labelMethod: string;
  readonly name: string;
  readonly partitionStrategy: string;
  readonly privacyReviewed: boolean;
  readonly purpose: RecallRerankerDatasetPurpose;
  readonly reservedEvaluations?: readonly RecallRerankerReservedEvaluationV1[];
  readonly seed: number;
  readonly sources: readonly RecallRerankerSourceV1[];
}

export interface RecallRerankerValidationOptions {
  readonly forbiddenTexts?: Iterable<string>;
  readonly requireAllSplits?: boolean;
}

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const RecallRerankerDatasetPurposeSchema = Schema.Literals(RECALL_RERANKER_DATASET_PURPOSES);
const RecallRerankerSplitSchema = Schema.Literals(RECALL_RERANKER_SPLITS);
const RecallRerankerAnswerabilitySchema = Schema.Literals(RECALL_RERANKER_ANSWERABILITY);
const RecallRerankerSourceKindSchema = Schema.Literals(RECALL_RERANKER_SOURCE_KINDS);
const RecallRerankerPrivacyBasisSchema = Schema.Literals(RECALL_RERANKER_PRIVACY_BASES);
const RecallRerankerNegativeKindSchema = Schema.Literals(RECALL_RERANKER_NEGATIVE_KINDS);

const RecallRerankerReservedEvaluationSchemaV1 = Schema.Struct({
  name: NonEmptyString,
  sha256: NonEmptyString,
});

const RecallRerankerSourceSchemaV1 = Schema.Struct({
  consentReference: Schema.optionalKey(NonEmptyString),
  id: NonEmptyString,
  kind: RecallRerankerSourceKindSchema,
  license: NonEmptyString,
  licenseUrl: NonEmptyString,
  privacyBasis: RecallRerankerPrivacyBasisSchema,
  provenance: NonEmptyString,
  redistributionApproved: Schema.Boolean,
  revision: NonEmptyString,
  sourceUri: NonEmptyString,
  trainingApproved: Schema.Boolean,
});

const RecallRerankerCandidateSchemaV1 = Schema.Struct({
  id: NonEmptyString,
  language: NonEmptyString,
  negativeKind: Schema.optionalKey(RecallRerankerNegativeKindSchema),
  provenanceRecord: NonEmptyString,
  relevance: NonNegativeInteger,
  reviewed: Schema.Boolean,
  sourceId: NonEmptyString,
  text: NonEmptyString,
  title: Schema.optionalKey(NonEmptyString),
});

export const RecallRerankerQueryGroupSchemaV1 = Schema.Struct({
  answerability: RecallRerankerAnswerabilitySchema,
  candidates: Schema.Array(RecallRerankerCandidateSchemaV1),
  id: NonEmptyString,
  language: NonEmptyString,
  partitionKey: NonEmptyString,
  provenanceRecord: NonEmptyString,
  query: NonEmptyString,
  sourceId: NonEmptyString,
  split: RecallRerankerSplitSchema,
  version: Schema.Literal(RECALL_RERANKER_DATASET_VERSION),
});

export const RecallRerankerDatasetManifestSchemaV1 = Schema.Struct({
  counts: Schema.Struct({
    candidates: NonNegativeInteger,
    groups: PositiveInteger,
    noAnswerGroups: NonNegativeInteger,
    splits: Schema.Struct({
      test: NonNegativeInteger,
      train: NonNegativeInteger,
      validation: NonNegativeInteger,
    }),
  }),
  createdAt: NonEmptyString,
  description: NonEmptyString,
  generatorRevision: NonEmptyString,
  groupFile: NonEmptyString,
  groupFileSha256: NonEmptyString,
  groupsSha256: NonEmptyString,
  labelMethod: NonEmptyString,
  name: NonEmptyString,
  partitionStrategy: NonEmptyString,
  privacyReviewed: Schema.Boolean,
  purpose: RecallRerankerDatasetPurposeSchema,
  reservedEvaluations: Schema.Array(RecallRerankerReservedEvaluationSchemaV1),
  seed: Schema.Int,
  sources: Schema.Array(RecallRerankerSourceSchemaV1),
  version: Schema.Literal(RECALL_RERANKER_DATASET_VERSION),
});

export const RecallRerankerDatasetDraftSchemaV1 = Schema.Struct({
  createdAt: NonEmptyString,
  description: NonEmptyString,
  generatorRevision: NonEmptyString,
  groupFile: Schema.optionalKey(NonEmptyString),
  labelMethod: NonEmptyString,
  name: NonEmptyString,
  partitionStrategy: NonEmptyString,
  privacyReviewed: Schema.Boolean,
  purpose: RecallRerankerDatasetPurposeSchema,
  reservedEvaluations: Schema.optionalKey(Schema.Array(RecallRerankerReservedEvaluationSchemaV1)),
  seed: Schema.Int,
  sources: Schema.Array(RecallRerankerSourceSchemaV1),
});

export const RecallRerankerValidationPolicySchemaV1 = Schema.Struct({
  forbiddenTextsSha256: NonEmptyString,
  receiptFile: NonEmptyString,
  reservedEvaluation: RecallRerankerReservedEvaluationSchemaV1,
  validatorId: NonEmptyString,
  version: Schema.Literal(1),
});

export const RecallRerankerValidationReceiptSchemaV1 = Schema.Struct({
  datasetName: NonEmptyString,
  datasetVersion: Schema.Literal(RECALL_RERANKER_DATASET_VERSION),
  forbiddenTextsSha256: NonEmptyString,
  groupFileSha256: NonEmptyString,
  groupsSha256: NonEmptyString,
  manifestSha256: NonEmptyString,
  reservedEvaluation: RecallRerankerReservedEvaluationSchemaV1,
  validationPolicySha256: NonEmptyString,
  validatorId: NonEmptyString,
  version: Schema.Literal(1),
});

export function parseRecallRerankerDatasetManifestV1(value: unknown): RecallRerankerDatasetManifestV1 {
  return Schema.decodeUnknownSync(RecallRerankerDatasetManifestSchemaV1)(value);
}

export function parseRecallRerankerDatasetDraftV1(value: unknown): RecallRerankerDatasetDraftV1 {
  return Schema.decodeUnknownSync(RecallRerankerDatasetDraftSchemaV1)(value);
}

export function parseRecallRerankerQueryGroupV1(value: unknown): RecallRerankerQueryGroupV1 {
  return Schema.decodeUnknownSync(RecallRerankerQueryGroupSchemaV1)(value);
}

export function parseRecallRerankerValidationPolicyV1(value: unknown): RecallRerankerValidationPolicyV1 {
  const policy = Schema.decodeUnknownSync(RecallRerankerValidationPolicySchemaV1)(value);
  assertSha256(policy.forbiddenTextsSha256, 'validation policy forbidden texts');
  assertSha256(policy.reservedEvaluation.sha256, 'validation policy reserved evaluation');
  if (!isSafeRelativeFile(policy.receiptFile)) {
    throw ScriptError.make({message: 'Recall reranker validation receipt must be a repository-relative file name.'});
  }
  return policy;
}

export function parseRecallRerankerValidationReceiptV1(value: unknown): RecallRerankerValidationReceiptV1 {
  const receipt = Schema.decodeUnknownSync(RecallRerankerValidationReceiptSchemaV1)(value);
  for (const [label, hash] of [
    ['forbidden texts', receipt.forbiddenTextsSha256],
    ['group file', receipt.groupFileSha256],
    ['canonical groups', receipt.groupsSha256],
    ['manifest', receipt.manifestSha256],
    ['reserved evaluation', receipt.reservedEvaluation.sha256],
    ['validation policy', receipt.validationPolicySha256],
  ] as const) {
    assertSha256(hash, `validation receipt ${label}`);
  }
  return receipt;
}

export function parseRecallRerankerGroupJsonLinesV1(content: string): readonly RecallRerankerQueryGroupV1[] {
  const lines = Effect.pipe(content, EffectString.split(/\r?\n/));
  const groups: RecallRerankerQueryGroupV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = Effect.pipe(lines[index], EffectString.trim);
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (cause) {
      throw ScriptError.make({message: `Could not parse recall reranker JSONL line ${index + 1}.`, cause});
    }
    groups.push(parseRecallRerankerQueryGroupV1(value));
  }
  if (groups.length === 0) throw ScriptError.make({message: 'Recall reranker dataset contains no query groups.'});
  return groups;
}

export function serializeRecallRerankerGroupsV1(groups: readonly RecallRerankerQueryGroupV1[]): string {
  return `${EffectArray.join(
    EffectArray.map(
      [...groups].sort((left, right) => compareRecallRerankerStringsV1(left.id, right.id)),
      group => JSON.stringify(group),
    ),
    '\n',
  )}\n`;
}

export function recallRerankerGroupsHashV1(groups: readonly Readonly<{id: string}>[]): string {
  const canonical = EffectArray.join(
    EffectArray.map(
      [...groups].sort((left, right) => compareRecallRerankerStringsV1(left.id, right.id)),
      group => canonicalJson(group),
    ),
    '\n',
  );
  return sha256HexSync(`${canonical}\n`);
}

export function recallRerankerForbiddenTextsHashV1(values: Iterable<string>): string {
  const canonical = EffectArray.join(
    EffectArray.map(
      [...new Set(Array.from(values, normalizeRecallRerankerText))].sort(compareRecallRerankerStringsV1),
      value => JSON.stringify(value),
    ),
    '\n',
  );
  return sha256HexSync(`${canonical}\n`);
}

export function createRecallRerankerValidationReceiptV1(input: {
  readonly dataset: RecallRerankerDatasetV1;
  readonly manifestContent: string;
  readonly policy: RecallRerankerValidationPolicyV1;
  readonly policyContent: string;
}): RecallRerankerValidationReceiptV1 {
  return {
    datasetName: input.dataset.manifest.name,
    datasetVersion: input.dataset.manifest.version,
    forbiddenTextsSha256: input.policy.forbiddenTextsSha256,
    groupFileSha256: input.dataset.manifest.groupFileSha256,
    groupsSha256: input.dataset.manifest.groupsSha256,
    manifestSha256: sha256HexSync(input.manifestContent),
    reservedEvaluation: input.policy.reservedEvaluation,
    validationPolicySha256: sha256HexSync(input.policyContent),
    validatorId: input.policy.validatorId,
    version: 1,
  };
}

export function createRecallRerankerDatasetV1(
  draft: RecallRerankerDatasetDraftV1,
  groups: readonly RecallRerankerQueryGroupV1[],
  options: RecallRerankerValidationOptions = {},
): RecallRerankerDatasetV1 {
  const groupFile = draft.groupFile ?? 'groups.jsonl';
  const canonicalGroups = [...groups].sort((left, right) => compareRecallRerankerStringsV1(left.id, right.id));
  const groupContent = serializeRecallRerankerGroupsV1(canonicalGroups);
  const manifest: RecallRerankerDatasetManifestV1 = {
    counts: recallRerankerDatasetCountsV1(canonicalGroups),
    createdAt: draft.createdAt,
    description: draft.description,
    generatorRevision: draft.generatorRevision,
    groupFile,
    groupFileSha256: sha256HexSync(groupContent),
    groupsSha256: recallRerankerGroupsHashV1(canonicalGroups),
    labelMethod: draft.labelMethod,
    name: draft.name,
    partitionStrategy: draft.partitionStrategy,
    privacyReviewed: draft.privacyReviewed,
    purpose: draft.purpose,
    reservedEvaluations: [...(draft.reservedEvaluations ?? [])].sort((left, right) =>
      compareRecallRerankerStringsV1(left.name, right.name),
    ),
    seed: draft.seed,
    sources: [...draft.sources].sort((left, right) => compareRecallRerankerStringsV1(left.id, right.id)),
    version: RECALL_RERANKER_DATASET_VERSION,
  };
  const dataset = {groups: canonicalGroups, manifest};
  validateRecallRerankerDatasetV1(dataset, options);
  return dataset;
}

export function parseRecallRerankerDatasetV1(
  manifestValue: unknown,
  groupContent: string,
  options: RecallRerankerValidationOptions = {},
): RecallRerankerDatasetV1 {
  const manifest = parseRecallRerankerDatasetManifestV1(manifestValue);
  const groups = parseRecallRerankerGroupJsonLinesV1(groupContent);
  if (sha256HexSync(groupContent) !== manifest.groupFileSha256) {
    throw ScriptError.make({message: 'Recall reranker group file checksum does not match its manifest.'});
  }
  const dataset = {groups, manifest};
  validateRecallRerankerDatasetV1(dataset, options);
  return dataset;
}

export function validateRecallRerankerDatasetV1(
  dataset: RecallRerankerDatasetV1,
  options: RecallRerankerValidationOptions = {},
): void {
  const {groups, manifest} = dataset;
  if (!manifest.privacyReviewed) throw ScriptError.make({message: 'Recall reranker dataset must pass privacy review.'});
  if (!isSafeRelativeFile(manifest.groupFile)) {
    throw ScriptError.make({message: 'Recall reranker group file must be a repository-relative file name.'});
  }
  assertSha256(manifest.groupFileSha256, 'group file');
  assertSha256(manifest.groupsSha256, 'canonical groups');
  for (const reserved of manifest.reservedEvaluations)
    assertSha256(reserved.sha256, `reserved evaluation ${reserved.name}`);

  const sourceIds = new Set<string>();
  for (const source of manifest.sources) {
    if (sourceIds.has(source.id))
      throw ScriptError.make({message: `Duplicate recall reranker source ID: ${source.id}`});
    sourceIds.add(source.id);
    validateSource(source);
  }
  if (sourceIds.size === 0)
    throw ScriptError.make({message: 'Recall reranker dataset must declare at least one source.'});

  const groupIds = new Set<string>();
  const queryTexts = new Set<string>();
  const partitionSplits = new Map<string, RecallRerankerSplit>();
  const documentTextSplits = new Map<string, RecallRerankerSplit>();
  const forbiddenTexts = new Set(Array.from(options.forbiddenTexts ?? [], normalizeRecallRerankerText));
  const observedSplits = new Set<RecallRerankerSplit>();

  for (const group of groups) {
    if (groupIds.has(group.id))
      throw ScriptError.make({message: `Duplicate recall reranker query group ID: ${group.id}`});
    groupIds.add(group.id);
    observedSplits.add(group.split);
    validateSafeText(group.id, `query group ${group.id} ID`);
    validateSafeText(group.partitionKey, `query group ${group.id} partition key`);
    validateSafeText(group.provenanceRecord, `query group ${group.id} provenance record`);
    validateSafeText(group.query, `query group ${group.id} query`);
    if (!sourceIds.has(group.sourceId)) {
      throw ScriptError.make({
        message: `Recall reranker query group ${group.id} references missing source: ${group.sourceId}`,
      });
    }
    const normalizedQuery = normalizeRecallRerankerText(group.query);
    if (queryTexts.has(normalizedQuery))
      throw ScriptError.make({message: `Duplicate normalized recall reranker query: ${group.id}`});
    queryTexts.add(normalizedQuery);
    assertNotReserved(normalizedQuery, forbiddenTexts, `query group ${group.id} query`);
    assertOneSplit(partitionSplits, normalizeRecallRerankerText(group.partitionKey), group.split, 'partition key');

    if (group.candidates.length < 2 || group.candidates.length > RECALL_RERANKER_MAX_CANDIDATES) {
      throw ScriptError.make({
        message: `Recall reranker query group ${group.id} must contain 2-${RECALL_RERANKER_MAX_CANDIDATES} candidates.`,
      });
    }
    const candidateIds = new Set<string>();
    let positiveCount = 0;
    let negativeCount = 0;
    for (const candidate of group.candidates) {
      if (candidateIds.has(candidate.id)) {
        throw ScriptError.make({
          message: `Duplicate recall reranker candidate ID ${candidate.id} in query group ${group.id}.`,
        });
      }
      candidateIds.add(candidate.id);
      if (!sourceIds.has(candidate.sourceId)) {
        throw ScriptError.make({
          message: `Recall reranker candidate ${candidate.id} references missing source: ${candidate.sourceId}`,
        });
      }
      if (!Number.isInteger(candidate.relevance) || candidate.relevance < 0 || candidate.relevance > 3) {
        throw ScriptError.make({
          message: `Recall reranker candidate ${candidate.id} has invalid relevance grade ${candidate.relevance}.`,
        });
      }
      if (!candidate.reviewed) {
        throw ScriptError.make({message: `Recall reranker candidate ${candidate.id} must be reviewed.`});
      }
      validateSafeText(candidate.provenanceRecord, `candidate ${candidate.id} provenance record`);
      validateSafeText(candidate.text, `candidate ${candidate.id} text`);
      if (candidate.title !== undefined) validateSafeText(candidate.title, `candidate ${candidate.id} title`);
      const normalizedDocument = normalizeRecallRerankerText(candidate.text);
      assertNotReserved(normalizedDocument, forbiddenTexts, `candidate ${candidate.id} text`);
      assertOneSplit(documentTextSplits, normalizedDocument, group.split, 'document text');
      if (candidate.relevance > 0) {
        positiveCount += 1;
        if (candidate.negativeKind !== undefined) {
          throw ScriptError.make({
            message: `Relevant recall reranker candidate ${candidate.id} cannot declare a negative kind.`,
          });
        }
      } else {
        negativeCount += 1;
        if (candidate.negativeKind === undefined) {
          throw ScriptError.make({
            message: `Negative recall reranker candidate ${candidate.id} must declare a negative kind.`,
          });
        }
      }
    }
    if (group.answerability === 'answerable' && (positiveCount === 0 || negativeCount === 0)) {
      throw ScriptError.make({
        message: `Answerable recall reranker query group ${group.id} requires positive and negative candidates.`,
      });
    }
    if (group.answerability === 'no_answer' && positiveCount > 0) {
      throw ScriptError.make({
        message: `No-answer recall reranker query group ${group.id} cannot contain relevant candidates.`,
      });
    }
  }

  if (groups.length === 0) throw ScriptError.make({message: 'Recall reranker dataset contains no query groups.'});
  if (options.requireAllSplits !== false) {
    for (const split of RECALL_RERANKER_SPLITS) {
      if (!observedSplits.has(split))
        throw ScriptError.make({message: `Recall reranker dataset is missing the ${split} split.`});
    }
  }
  const counts = recallRerankerDatasetCountsV1(groups);
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) {
    throw ScriptError.make({message: 'Recall reranker dataset counts do not match its manifest.'});
  }
  if (recallRerankerGroupsHashV1(groups) !== manifest.groupsSha256) {
    throw ScriptError.make({message: 'Recall reranker canonical group hash does not match its manifest.'});
  }
}

export function recallRerankerDatasetCountsV1(
  groups: readonly RecallRerankerQueryGroupV1[],
): RecallRerankerDatasetCountsV1 {
  const splits: Record<RecallRerankerSplit, number> = {test: 0, train: 0, validation: 0};
  let candidates = 0;
  let noAnswerGroups = 0;
  for (const group of groups) {
    splits[group.split] += 1;
    candidates += group.candidates.length;
    if (group.answerability === 'no_answer') noAnswerGroups += 1;
  }
  return {candidates, groups: groups.length, noAnswerGroups, splits};
}

export function normalizeRecallRerankerText(value: string): string {
  let output = '';
  let pendingSpace = false;
  for (const character of Effect.pipe(value, EffectString.normalize('NFKC'))) {
    if (
      isRecallRerankerWhitespace(
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        )!,
      )
    ) {
      pendingSpace = output.length > 0;
    } else {
      if (pendingSpace) output += ' ';
      output += character;
      pendingSpace = false;
    }
  }
  return Effect.pipe(output, EffectString.toLowerCase);
}

export function compareRecallRerankerStringsV1(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function validateSource(source: RecallRerankerSourceV1): void {
  for (const [label, value] of [
    ['ID', source.id],
    ['license', source.license],
    ['license URL', source.licenseUrl],
    ['provenance', source.provenance],
    ['revision', source.revision],
    ['source URI', source.sourceUri],
  ] as const) {
    validateSafeText(value, `source ${source.id} ${label}`);
  }
  if (!source.trainingApproved)
    throw ScriptError.make({message: `Recall reranker source ${source.id} is not approved for training.`});
  if (!source.redistributionApproved) {
    throw ScriptError.make({message: `Recall reranker source ${source.id} is not approved for redistribution.`});
  }
  if (source.kind === 'self_authored_synthetic' && source.privacyBasis !== 'self_authored') {
    throw ScriptError.make({message: `Self-authored source ${source.id} must use the self_authored privacy basis.`});
  }
  if (
    (source.kind === 'public_dataset' || source.kind === 'public_repository') &&
    source.privacyBasis !== 'public_licensed'
  ) {
    throw ScriptError.make({message: `Public source ${source.id} must use the public_licensed privacy basis.`});
  }
  if (source.kind === 'opt_in_sanitized') {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain narrowing for the consent reference.
    if (source.privacyBasis !== 'explicit_opt_in' || !source.consentReference?.trim()) {
      throw ScriptError.make({message: `Opt-in source ${source.id} requires an explicit consent reference.`});
    }
    validateSafeText(source.consentReference, `source ${source.id} consent reference`);
  } else if (source.consentReference !== undefined) {
    throw ScriptError.make({message: `Non-opt-in source ${source.id} cannot declare a consent reference.`});
  }
}

function validateSafeText(value: string, label: string): void {
  const matches = detectSecretMatches(value);
  if (matches.length > 0)
    throw ScriptError.make({message: `${label} contains sensitive data (${EffectArray.join(matches, ', ')}).`});
  if (
    /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/mnt\/[a-z]\/(?:Users|home)\/|\\\\[^\\\s]+\\[^\\\s]+)/i.test(
      value,
    )
  ) {
    throw ScriptError.make({message: `${label} contains an absolute local path.`});
  }
}

function assertOneSplit(
  seen: Map<string, RecallRerankerSplit>,
  key: string,
  split: RecallRerankerSplit,
  label: string,
): void {
  const previous = seen.get(key);
  if (previous !== undefined && previous !== split) {
    throw ScriptError.make({message: `Recall reranker ${label} leaks across ${previous} and ${split} splits.`});
  }
  seen.set(key, split);
}

function assertNotReserved(value: string, forbidden: ReadonlySet<string>, label: string): void {
  if (forbidden.has(value)) throw ScriptError.make({message: `${label} duplicates reserved evaluation content.`});
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw ScriptError.make({message: `Recall reranker ${label} SHA-256 is invalid.`});
}

function isSafeRelativeFile(value: string): boolean {
  const normalized = Effect.pipe(value, EffectString.replaceAll('\\', '/'));
  return (
    normalized.length > 0 &&
    normalized.length <= 512 &&
    !Effect.pipe(normalized, EffectString.startsWith('/')) &&
    !/^[A-Za-z]:\//.test(normalized) &&
    EffectArray.every(
      Effect.pipe(normalized, EffectString.split('/')),
      segment => segment.length > 0 && segment !== '.' && segment !== '..',
    )
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (EffectArray.isArray(value)) return EffectArray.map(value, canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return EffectRecord.fromEntries(
    EffectArray.map(
      EffectRecord.toEntries(value).sort(([left], [right]) => compareRecallRerankerStringsV1(left, right)),
      ([key, item]) => [key, canonicalValue(item)],
    ),
  );
}

function isRecallRerankerWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

const UTF8_ENCODER = new TextEncoder();
