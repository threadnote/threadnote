import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {type CodeGraphBuildStatus, parseCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const resolutionCase = FC.record({
  aliasesDiscovered: FC.integer({max: 1_000_000, min: 0}),
  elapsedMilliseconds: FC.integer({max: 10_000_000, min: 0}),
  pageCompleted: FC.integer({max: 1_000, min: 0}),
  pageRemainder: FC.integer({max: 1_000, min: 0}),
  pagesBeforePass: FC.integer({max: 1_000_000, min: 0}),
  pass: FC.integer({max: 1_000, min: 1}),
  referencesCompleted: FC.integer({max: 1_000_000, min: 0}),
  referencesExaminedBeforePass: FC.integer({max: 10_000_000, min: 0}),
  referencesRemainder: FC.integer({max: 1_000_000, min: 0}),
  resolved: FC.integer({max: 1_000_000, min: 0}),
});

describe('code graph reference-resolution status properties', () => {
  fcProp(
    it,
    'round-trips bounded cumulative progress and rejects completed counts beyond the pass total',
    {sample: resolutionCase},
    ({sample}) => {
      const timestamp = '2026-08-01T10:00:00.000Z';
      const referencesTotal = sample.referencesCompleted + sample.referencesRemainder;
      const referencesExamined = sample.referencesExaminedBeforePass + sample.referencesCompleted;
      const resolved = Math.min(sample.resolved, referencesExamined);
      const pageTotal = sample.pageCompleted + sample.pageRemainder;
      const status: CodeGraphBuildStatus = {
        buildId: Effect.pipe('a', EffectString.repeat(32)),
        counters: {
          completed: sample.referencesCompleted,
          resolved,
          total: referencesTotal,
          unit: 'references',
        },
        identity: {
          checkoutId: Effect.pipe('b', EffectString.repeat(64)),
          commit: Effect.pipe('c', EffectString.repeat(40)),
          repositoryId: Effect.pipe('d', EffectString.repeat(64)),
          worktreeId: Effect.pipe('e', EffectString.repeat(64)),
        },
        owner: {processId: 42, runtime: 'bun', runtimeVersion: '1.3.14'},
        phase: 'resolving',
        resolution: {
          activity: {
            aliasesDiscovered: sample.aliasesDiscovered,
            elapsedMilliseconds: sample.elapsedMilliseconds,
            matchingMilliseconds: Math.floor(sample.elapsedMilliseconds / 2),
            pageCompleted: sample.pageCompleted,
            pageTotal,
            pagesCompleted: sample.pagesBeforePass + sample.pageCompleted,
            pass: sample.pass,
            referencesCompleted: sample.referencesCompleted,
            referencesExamined,
            referencesTotal,
            resolved,
            startedAt: timestamp,
            transactionMilliseconds: Math.floor(sample.elapsedMilliseconds / 3),
          },
        },
        schemaVersion: 1,
        state: 'running',
        subphase: 'references',
        timestamps: {
          heartbeatAt: timestamp,
          lastProgressAt: timestamp,
          phaseStartedAt: timestamp,
          startedAt: timestamp,
          updatedAt: timestamp,
        },
      };

      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(status)))?.resolution).toEqual(status.resolution);
      expect(
        parseCodeGraphBuildStatus({
          ...status,
          resolution: {
            activity: {...status.resolution!.activity, referencesCompleted: referencesTotal + 1},
          },
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 200}},
  );
});
