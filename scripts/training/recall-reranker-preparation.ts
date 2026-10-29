import {Array as EffectArray} from 'effect';
import {ScriptError} from '../effect/errors.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {
  createRecallRerankerDatasetV1,
  parseRecallRerankerDatasetDraftV1,
  parseRecallRerankerGroupJsonLinesV1,
  type RecallRerankerDatasetV1,
} from './recall-reranker-contract.js';

export function prepareReviewedRecallRerankerDatasetV1(
  draftValue: unknown,
  groupContent: string,
): RecallRerankerDatasetV1 {
  const draft = parseRecallRerankerDatasetDraftV1(draftValue);
  if (draft.purpose !== 'training_candidate') {
    throw ScriptError.make({message: 'Reviewed dataset preparation only accepts purpose training_candidate.'});
  }
  if ((draft.reservedEvaluations?.length ?? 0) > 0) {
    throw ScriptError.make({
      message: 'The preparation helper manages reserved evaluations; remove them from the draft.',
    });
  }
  if (draft.groupFile !== undefined && draft.groupFile !== 'groups.jsonl') {
    throw ScriptError.make({message: 'The preparation helper writes the reviewed groups to groups.jsonl.'});
  }

  const fixture = createRecallEvaluationFixtureV2();
  const forbiddenTexts = [
    ...EffectArray.map(fixture.documents, document => document.text),
    ...EffectArray.map(fixture.queries, query => query.query),
  ];
  return createRecallRerankerDatasetV1(
    {
      ...draft,
      groupFile: 'groups.jsonl',
      reservedEvaluations: [
        {
          name: fixture.metadata.name,
          sha256: sha256HexSync(serializeRecallEvaluationFixtureV2Identity(fixture)),
        },
      ],
    },
    parseRecallRerankerGroupJsonLinesV1(groupContent),
    {forbiddenTexts},
  );
}
