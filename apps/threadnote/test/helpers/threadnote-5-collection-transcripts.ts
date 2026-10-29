import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Predicate} from 'effect';
import {
  collectionTrialIdentity,
  parseThreadnote5CollectionPlan,
  THREADNOTE_5_COLLECTION_MATRIX,
  type NativeProjection,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection';
import {deriveThreadnote5PrivateCollection} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection-envelope';
import {PRODUCTION_CAPTURE_CANDIDATE, productionCaptureFixture} from './threadnote-5-production-capture-fixture.js';
import * as EffectRecord from 'effect/Record';

/** Test-only native transcript doubles; no production adapter imports this helper. */
export function collectionTranscriptFixture() {
  const source = productionCaptureFixture();
  const runId = 'test_collection';
  const transcripts: unknown[] = [];
  const recipes = EffectArray.map(THREADNOTE_5_COLLECTION_MATRIX, ([scenario, kinds]) => {
    const count = EffectArray.some(kinds, item => item[1] > 1) ? 10 : 1;
    const outputs: Record<string, Record<string, unknown>>[] = Array.from({length: count}, () => ({}));
    const exports: Record<string, NativeProjection> = {};
    for (const [kind, required] of kinds) {
      const artifact = EffectOption.getOrUndefined(
        EffectArray.findFirst(source.records, record => record.scenario === scenario && record.kind === kind),
      )?.artifact;
      if (!Predicate.isObject(artifact))
        throw new TypeError(`Expected the ${kind} production fixture artifact to be an object.`);
      if (required === 1) {
        outputs[0][kind] = artifact;
        exports[kind] = {select: 'native', pointer: `/json/${kind}`, trial: 0};
        continue;
      }
      const fields: Record<string, NativeProjection> = {};
      for (let index = 0; index < count; index += 1) outputs[index][kind] = {};
      for (const [field, value] of EffectRecord.toEntries(artifact)) {
        if (EffectArray.isArray(value) && value.length === count) {
          fields[field] = {collect: 'native', pointer: `/json/${kind}/${field}`, flatten: true};
          for (let index = 0; index < count; index += 1) outputs[index][kind][field] = [value[index]];
        } else {
          fields[field] = {select: 'native', pointer: `/json/${kind}/${field}`, trial: 0};
          outputs[0][kind][field] = value;
        }
      }
      exports[kind] = {object: fields};
    }
    const steps = [{id: 'native', type: 'cli', surface: 'primary', argv: ['test-only-source-double'], expectedExit: 0}];
    for (let index = 0; index < count; index += 1) {
      const identity = collectionTrialIdentity(runId, scenario, index);
      transcripts.push({
        identity,
        scenario,
        mcpStderr: {},
        steps: [
          {
            step: steps[0],
            bindings: {
              ...identity,
              home: '/private/synthetic/home',
              userHome: '/private/synthetic/user',
              repo: '/private/synthetic/repo',
              primaryRepo: '/private/synthetic/repo',
              secondaryRepo: '/private/synthetic/worktree',
              remote: '/private/synthetic/team.git',
            },
            output: {
              stdout: JSON.stringify(outputs[index]),
              stderr: '',
              exitCode: 0,
              elapsedMilliseconds: 1,
              json: outputs[index],
            },
          },
        ],
      });
    }
    return {scenario, steps, exports};
  });
  const plan = parseThreadnote5CollectionPlan({
    version: 1,
    runId,
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    measuredTrials: 10,
    retentionHours: 1,
    recipes,
  });
  const runtime = {sourceCommit: plan.candidate.commit, executableSha256: plan.candidate.executableSha256};
  const boundaries = EffectArray.map(recipes, ({scenario}) => ({scenario, preRuntime: runtime, postRuntime: runtime}));
  return {...source, plan, transcripts, collection: deriveThreadnote5PrivateCollection(plan, transcripts, boundaries)};
}
