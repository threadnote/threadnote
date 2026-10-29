import {Array as EffectArray} from 'effect';
import {ScriptError} from '../effect/errors.js';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const RECALL_RERANKER_PARITY_FIXTURE_VERSION = 1 as const;
export const DEFAULT_RERANKER_PARITY_MAXIMUM_ABSOLUTE_ERROR = 0.02;
export const DEFAULT_RERANKER_PARITY_MINIMUM_ORDERING_GAP = 0.01;

export interface RecallRerankerParityCandidateV1 {
  readonly candidateId: string;
  readonly document: string;
  readonly pythonScore: number;
  readonly relevance: number;
}

export interface RecallRerankerParityGroupV1 {
  readonly candidates: readonly RecallRerankerParityCandidateV1[];
  readonly groupId: string;
  readonly query: string;
}

export interface RecallRerankerParityFixtureV1 {
  readonly configurationSha256: string;
  readonly dataset: {
    readonly groupFileSha256: string;
    readonly groupsSha256: string;
    readonly manifestSha256: string;
    readonly purpose: string;
  };
  readonly groups: readonly RecallRerankerParityGroupV1[];
  readonly kind: 'threadnote_recall_reranker_python_parity';
  readonly run: {
    readonly modelTreeSha256: string;
    readonly runJsonSha256: string;
    readonly trainingCodeRevision: string;
  };
  readonly runtimeTarget: {
    readonly architecture: string;
    readonly contextLimit: number;
    readonly documentCharacterLimit: number;
    readonly nodeLlamaCpp: string;
  };
  readonly scoring: {
    readonly backend: 'sentence-transformers-cross-encoder';
    readonly device: string;
    readonly python: string;
    readonly sentenceTransformers: string;
    readonly torch: string;
    readonly transformers: string;
  };
  readonly selection: {
    readonly algorithm: 'sha256-stratified-answerability-v1';
    readonly maximumGroups: number;
  };
  readonly split: 'validation';
  readonly version: typeof RECALL_RERANKER_PARITY_FIXTURE_VERSION;
}

export interface RecallRerankerParityThresholds {
  readonly maximumAbsoluteError: number;
  readonly minimumOrderingGap: number;
}

export interface RecallRerankerParityResult {
  readonly absoluteError: {
    readonly maximum: number;
    readonly mean: number;
    readonly failures: number;
  };
  readonly groups: readonly {
    readonly candidates: readonly {
      readonly absoluteError: number;
      readonly candidateId: string;
      readonly nativeScore: number;
      readonly pythonScore: number;
    }[];
    readonly groupId: string;
  }[];
  readonly ordering: {
    readonly comparisons: number;
    readonly failures: readonly {
      readonly leftCandidateId: string;
      readonly rightCandidateId: string;
      readonly groupId: string;
      readonly nativeDelta: number;
      readonly pythonDelta: number;
    }[];
  };
  readonly pairs: number;
  readonly passed: boolean;
}

const NonEmptyString = Schema.String;
const ParityCandidateSchemaV1 = Schema.Struct({
  candidateId: NonEmptyString,
  document: NonEmptyString,
  pythonScore: Schema.Finite,
  relevance: Schema.Int,
});
const ParityGroupSchemaV1 = Schema.Struct({
  candidates: Schema.Array(ParityCandidateSchemaV1),
  groupId: NonEmptyString,
  query: NonEmptyString,
});
const Sha256 = Schema.String;

const RecallRerankerParityFixtureSchemaV1 = Schema.Struct({
  configurationSha256: Sha256,
  dataset: Schema.Struct({
    groupFileSha256: Sha256,
    groupsSha256: Sha256,
    manifestSha256: Sha256,
    purpose: NonEmptyString,
  }),
  groups: Schema.Array(ParityGroupSchemaV1),
  kind: Schema.Literal('threadnote_recall_reranker_python_parity'),
  run: Schema.Struct({
    modelTreeSha256: Sha256,
    runJsonSha256: Sha256,
    trainingCodeRevision: Schema.String,
  }),
  runtimeTarget: Schema.Struct({
    architecture: NonEmptyString,
    contextLimit: Schema.Int,
    documentCharacterLimit: Schema.Int,
    nodeLlamaCpp: NonEmptyString,
  }),
  scoring: Schema.Struct({
    backend: Schema.Literal('sentence-transformers-cross-encoder'),
    device: NonEmptyString,
    python: NonEmptyString,
    sentenceTransformers: NonEmptyString,
    torch: NonEmptyString,
    transformers: NonEmptyString,
  }),
  selection: Schema.Struct({
    algorithm: Schema.Literal('sha256-stratified-answerability-v1'),
    maximumGroups: Schema.Int,
  }),
  split: Schema.Literal('validation'),
  version: Schema.Literal(RECALL_RERANKER_PARITY_FIXTURE_VERSION),
});

export function parseRecallRerankerParityFixtureV1(value: unknown): RecallRerankerParityFixtureV1 {
  const fixture = Schema.decodeUnknownSync(RecallRerankerParityFixtureSchemaV1)(value);
  const shaValues = [
    fixture.configurationSha256,
    fixture.dataset.groupFileSha256,
    fixture.dataset.groupsSha256,
    fixture.dataset.manifestSha256,
    fixture.run.modelTreeSha256,
    fixture.run.runJsonSha256,
  ];
  if (EffectArray.some(shaValues, value => !/^[0-9a-f]{64}$/.test(value))) {
    throw ScriptError.make({message: 'Recall reranker parity fixture contains an invalid SHA-256.'});
  }
  if (!/^[0-9a-f]{40}$/.test(fixture.run.trainingCodeRevision)) {
    throw ScriptError.make({message: 'Recall reranker parity fixture must pin an immutable training source revision.'});
  }
  if (
    fixture.groups.length === 0 ||
    fixture.selection.maximumGroups <= 0 ||
    fixture.groups.length > fixture.selection.maximumGroups
  ) {
    throw ScriptError.make({message: 'Recall reranker parity fixture contains an invalid validation-group selection.'});
  }
  if (fixture.runtimeTarget.contextLimit <= 0 || fixture.runtimeTarget.documentCharacterLimit <= 0) {
    throw ScriptError.make({message: 'Recall reranker parity fixture contains invalid runtime limits.'});
  }
  const groupIds = new Set<string>();
  for (const group of fixture.groups) {
    if (
      !Effect.pipe(group.groupId, EffectString.trim) ||
      !Effect.pipe(group.query, EffectString.trim) ||
      groupIds.has(group.groupId)
    ) {
      throw ScriptError.make({message: 'Recall reranker parity fixture contains an invalid or duplicate group.'});
    }
    groupIds.add(group.groupId);
    if (group.candidates.length < 2) {
      throw ScriptError.make({
        message: `Recall reranker parity group ${group.groupId} requires at least two candidates.`,
      });
    }
    const candidateIds = new Set<string>();
    for (const candidate of group.candidates) {
      if (
        !Effect.pipe(candidate.candidateId, EffectString.trim) ||
        !Effect.pipe(candidate.document, EffectString.trim) ||
        candidateIds.has(candidate.candidateId) ||
        !Number.isFinite(candidate.pythonScore) ||
        !Number.isInteger(candidate.relevance) ||
        candidate.relevance < 0 ||
        candidate.relevance > 3
      ) {
        throw ScriptError.make({
          message: `Recall reranker parity group ${group.groupId} contains an invalid candidate.`,
        });
      }
      candidateIds.add(candidate.candidateId);
    }
  }
  return fixture;
}

export function evaluateRecallRerankerParity(
  fixture: RecallRerankerParityFixtureV1,
  nativeScores: ReadonlyMap<string, readonly number[]>,
  thresholds: RecallRerankerParityThresholds,
): RecallRerankerParityResult {
  validateThresholds(thresholds);
  const groups: RecallRerankerParityResult['groups'][number][] = [];
  const orderingFailures: RecallRerankerParityResult['ordering']['failures'][number][] = [];
  let absoluteErrorTotal = 0;
  let maximumAbsoluteError = 0;
  let absoluteErrorFailures = 0;
  let orderingComparisons = 0;
  let pairs = 0;

  for (const group of fixture.groups) {
    const scores = nativeScores.get(group.groupId);
    if (
      !scores ||
      scores.length !== group.candidates.length ||
      EffectArray.some(scores, score => !Number.isFinite(score))
    ) {
      throw ScriptError.make({message: `Native reranker returned invalid scores for parity group ${group.groupId}.`});
    }
    const candidates = EffectArray.map(group.candidates, (candidate, index) => {
      const nativeScore = scores[index];
      const absoluteError = Math.abs(nativeScore - candidate.pythonScore);
      pairs += 1;
      absoluteErrorTotal += absoluteError;
      maximumAbsoluteError = Math.max(maximumAbsoluteError, absoluteError);
      if (absoluteError > thresholds.maximumAbsoluteError) absoluteErrorFailures += 1;
      return {
        absoluteError,
        candidateId: candidate.candidateId,
        nativeScore,
        pythonScore: candidate.pythonScore,
      };
    });
    for (let left = 0; left < group.candidates.length; left += 1) {
      for (let right = left + 1; right < group.candidates.length; right += 1) {
        const pythonDelta = group.candidates[left].pythonScore - group.candidates[right].pythonScore;
        if (Math.abs(pythonDelta) < thresholds.minimumOrderingGap) continue;
        orderingComparisons += 1;
        const nativeDelta = scores[left] - scores[right];
        if (Math.sign(nativeDelta) !== Math.sign(pythonDelta)) {
          orderingFailures.push({
            groupId: group.groupId,
            leftCandidateId: group.candidates[left].candidateId,
            nativeDelta,
            pythonDelta,
            rightCandidateId: group.candidates[right].candidateId,
          });
        }
      }
    }
    groups.push({candidates, groupId: group.groupId});
  }
  if (nativeScores.size !== fixture.groups.length) {
    throw ScriptError.make({message: 'Native reranker parity scores contain unexpected groups.'});
  }
  return {
    absoluteError: {
      failures: absoluteErrorFailures,
      maximum: maximumAbsoluteError,
      mean: pairs === 0 ? 0 : absoluteErrorTotal / pairs,
    },
    groups,
    ordering: {comparisons: orderingComparisons, failures: orderingFailures},
    pairs,
    passed: absoluteErrorFailures === 0 && orderingFailures.length === 0,
  };
}

function validateThresholds(thresholds: RecallRerankerParityThresholds): void {
  if (
    !Number.isFinite(thresholds.maximumAbsoluteError) ||
    thresholds.maximumAbsoluteError < 0 ||
    !Number.isFinite(thresholds.minimumOrderingGap) ||
    thresholds.minimumOrderingGap < 0
  ) {
    throw ScriptError.make({message: 'Recall reranker parity thresholds must be finite non-negative numbers.'});
  }
}
