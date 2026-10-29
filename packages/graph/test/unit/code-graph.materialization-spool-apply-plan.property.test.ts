import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  codeGraphMaterializationSpoolApplyPlan,
  CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES,
} from '@threadnote/graph/materialization/spool/apply_surfaces';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from '@threadnote/graph/materialization/spool/surfaces';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

fcProp(
  it,
  'maps physical row counts to every resumable main surface without mutation',
  {
    lexicalTermCount: FC.integer({max: 1_000_000, min: 0}),
    rowCounts: FC.array(FC.integer({max: 1_000_000, min: 0}), {
      maxLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
      minLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
    }),
  },
  ({lexicalTermCount, rowCounts}) => {
    const surfaces = EffectArray.map(CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES, (surface, index) => ({
      name: surface.name,
      rowCount: rowCounts[index],
    }));
    const plan = codeGraphMaterializationSpoolApplyPlan({
      batches: [],
      lexicalTermCount,
      spoolIdentity: Effect.pipe('a', EffectString.repeat(64)),
      surfaces,
    });
    expect(EffectArray.map(plan, surface => surface.name)).toEqual(
      EffectArray.map(CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES, surface => surface.name),
    );
    expect(EffectArray.map(plan, surface => surface.rowCount)).toEqual([
      rowCounts[0],
      rowCounts[1],
      rowCounts[2],
      rowCounts[3],
      rowCounts[4],
      rowCounts[5],
      1,
      rowCounts[0],
      lexicalTermCount,
      rowCounts[6],
    ]);
    expect(EffectArray.map(surfaces, surface => surface.rowCount)).toEqual(rowCounts);
  },
  {fastCheck: {numRuns: 100}},
);
