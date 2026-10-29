import {Array as EffectArray, Option as EffectOption} from 'effect';
import {
  assertMatchedContinuationRuntimeMatchesStudyV1,
  parseMatchedContinuationStudyRuntimeV1,
  parseMatchedContinuationStudyV1,
  type MatchedContinuationStudyRuntimeV1,
  type MatchedContinuationStudyV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import {assertMatchedEvaluationPinnedFileV1} from './matched-evaluation-runtime-integrity.js';

export async function assertMatchedContinuationRuntimeFilesV1(
  studyInput: MatchedContinuationStudyV1 | unknown,
  runtimeInput: MatchedContinuationStudyRuntimeV1 | unknown,
): Promise<void> {
  const study = parseMatchedContinuationStudyV1(studyInput);
  const runtime = parseMatchedContinuationStudyRuntimeV1(runtimeInput);
  assertMatchedContinuationRuntimeMatchesStudyV1(study, runtime);

  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      runtime.exposureAuditPath,
      study.sourceEvidence.exposureAuditSha256,
      false,
      'continuation exposure audit',
    ),
    assertMatchedEvaluationPinnedFileV1(
      runtime.matchedPreparationReceiptPath,
      study.sourceEvidence.matchedPreparationReceiptSha256,
      false,
      'continuation matched preparation receipt',
    ),
    ...EffectArray.map(runtime.tasks, runtimeTask => {
      const task = EffectOption.getOrUndefined(
        EffectArray.findFirst(study.tasks, candidate => candidate.taskId === runtimeTask.taskId),
      );
      if (task === undefined) throw new Error(`Continuation runtime task ${runtimeTask.taskId} is not sealed.`);
      return assertMatchedEvaluationPinnedFileV1(
        runtimeTask.planPath,
        task.planSha256,
        false,
        `continuation plan ${runtimeTask.taskId}`,
      );
    }),
  ]);
}
