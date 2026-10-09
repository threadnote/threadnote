import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import type {MaintenanceState} from '../../src/memory/context/maintenance.js';
import {publicStatus} from '../../src/memory/context/maintenance_projection.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

function legacyProgress(eligibleRecords = 2, cursor = 1, totalBatches = 1) {
  return {generation: 'legacy-generation', eligibleRecords, cursor, totalBatches, partial: false};
}

function state(progress: unknown): MaintenanceState {
  return {
    version: 2,
    paused: true,
    state: 'idle',
    generation: 'generation',
    projects: [],
    cases: [],
    receipts: [],
    checkpoints: {},
    semanticProgress: progress as MaintenanceState['semanticProgress'],
  };
}

const incomplete = {
  state: 'partial',
  checkedBatches: 0,
  extractedRecords: 0,
  extractionComplete: false,
  comparisonComplete: false,
  comparedClaimPairs: 0,
  unsupportedRecords: 0,
  unsupportedClaims: 0,
  bodyLimitedRecords: 0,
  outputOmittedFindings: 0,
  churnCount: 0,
  dirtyRecordPairsRemaining: 0,
};

describe('maintenance status semantic checkpoint compatibility', () => {
  it.each([{}, {version: 1}, {version: 2, analyzerVersion: 1}])(
    'shows obsolete completed progress %j as incomplete without rewriting it',
    version => {
      const original = state({threadnote: {...legacyProgress(), ...version}});
      const before = structuredClone(original);
      expect(publicStatus(original, 'threadnote').semanticCoverage).toEqual([
        {...incomplete, project: 'threadnote', eligibleRecords: 2, totalRecords: 2, totalBatches: 1},
      ]);
      expect(original).toEqual(before);
    },
  );

  it('never promotes arbitrary legacy counters to current completed evidence', () => {
    fc.assert(
      fc.property(
        fc.nat({max: 10_000}),
        fc.nat({max: 10_000}),
        fc.nat({max: 10_000}),
        (eligibleRecords, cursor, totalBatches) => {
          const original = state({
            selected: legacyProgress(eligibleRecords, cursor, totalBatches),
            other: legacyProgress(),
          });
          const before = structuredClone(original);
          const scoped = publicStatus(original, 'selected').semanticCoverage!;
          expect(scoped).toEqual([
            {...incomplete, project: 'selected', eligibleRecords, totalRecords: eligibleRecords, totalBatches},
          ]);
          expect(scoped[0]).not.toHaveProperty('totalClaimPairs');
          expect(publicStatus(original, 'absent').semanticCoverage).toEqual([]);
          expect(publicStatus(original).semanticCoverage?.map(item => item.project)).toEqual(['selected', 'other']);
          expect(original).toEqual(before);
        },
      ),
      {numRuns: 100},
    );
  });

  it('retains detailed current checkpoint coverage', () => {
    const current = {
      version: 2,
      analyzerVersion: 2,
      generation: 'current-generation',
      cursor: 1,
      totalBatches: 1,
      eligibleRecords: 2,
      records: [
        {uri: 'synthetic-left', hash: 'left', claims: 1, reasons: [], unsupportedClaims: 0},
        {uri: 'synthetic-right', hash: 'right', claims: 1, reasons: [], unsupportedClaims: 0},
      ],
      comparison: {pairCursor: 1, claimCursor: 0, seenCaseIds: []},
      dirty: [],
      comparedClaimPairs: 1,
      churnCount: 0,
      outputOmittedFindings: 0,
    };
    expect(publicStatus(state({threadnote: current})).semanticCoverage).toEqual([
      {
        ...incomplete,
        project: 'threadnote',
        state: 'complete',
        eligibleRecords: 2,
        checkedBatches: 1,
        totalBatches: 1,
        extractedRecords: 2,
        totalRecords: 2,
        extractionComplete: true,
        comparisonComplete: true,
        comparedClaimPairs: 1,
        totalClaimPairs: 1,
      },
    ]);
  });

  effectIt.effect('serves Manager project status with legacy progress and preserves saved bytes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-legacy-status-'});
      const directory = path.join(home, 'context-maintenance');
      yield* fs.makeDirectory(directory);
      const file = path.join(directory, 'state-v2.json');
      const original = `${JSON.stringify(state({threadnote: legacyProgress(), other: legacyProgress()}), null, 2)}\n`;
      yield* fs.writeFileString(file, original);
      const canonical = path.join(home, 'canonical-sentinel.md');
      yield* fs.writeFileString(canonical, 'Synthetic canonical sentinel.');
      const response = yield* handleManagerAttentionAction({
        body: Effect.die('GET must not read a mutation body'),
        config: {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          manifestPath: path.join(home, 'manifest.json'),
          user: 'tester',
        },
        method: 'GET',
        url: new URL('http://127.0.0.1/api/attention/context-maintenance?project=threadnote&limit=30'),
      });
      expect(response).toMatchObject({
        status: 200,
        body: {paused: true, semanticCoverage: [{...incomplete, project: 'threadnote'}]},
      });
      expect(yield* fs.readFileString(file)).toBe(original);
      expect(yield* fs.readFileString(canonical)).toBe('Synthetic canonical sentinel.');
    }).pipe(
      provideTestLayer(
        Layer.mergeAll(
          StandaloneBrokerLayer,
          Layer.mock(ResourceStore, {}),
          CodeGraphLanguagePackRegistry.layer,
          Layer.mock(CodeGraphQueryService, {}),
          Layer.mock(CodeGraphStore, {}),
          Layer.mock(LocalModelCatalog, {}),
          Layer.mock(LocalModelRuntime, {}),
          Layer.mock(LocalModelStore, {
            path: () => {
              throw new Error('Maintenance status must not resolve model paths');
            },
          }),
        ),
      ),
    ),
  );
});
