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
    lexicalV2: FC.boolean(),
    lexicalTermCount: FC.integer({max: 1_000_000, min: 0}),
    rowCounts: FC.array(FC.integer({max: 1_000_000, min: 0}), {
      maxLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
      minLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
    }),
  },
  ({lexicalTermCount, rowCounts, lexicalV2}) => {
    const surfaces = EffectArray.map(CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES, (surface, index) => ({
      name: surface.name,
      rowCount: rowCounts[index],
    }));
    const plan = codeGraphMaterializationSpoolApplyPlan({
      batches: [],
      lexicalV2,
      lexicalTermCount,
      spoolIdentity: Effect.pipe('a', EffectString.repeat(64)),
      surfaces,
    });
    expect(EffectArray.map(plan, surface => surface.name)).toEqual(
      EffectArray.map(CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES, surface => surface.name),
    );
    // Literal independent physical contracts; source positions retain the
    // append protocol while apply cursors explicitly exclude legacy V2 rows.
    expect(plan).toEqual([
      {name: 'symbols', rowCount: rowCounts[0]},
      {name: 'lookup', rowCount: rowCounts[1]},
      {name: 'edges', rowCount: rowCounts[2]},
      {name: 'references', rowCount: rowCounts[3]},
      {name: 'reexports', rowCount: rowCounts[4]},
      {name: 'monikers', rowCount: rowCounts[5]},
      {name: 'lexical_snapshot', rowCount: 1},
      {name: 'lexical_symbols', rowCount: lexicalV2 ? 0 : rowCounts[0]},
      {name: 'lexical_terms', rowCount: lexicalTermCount},
      {name: 'symbol_terms', rowCount: lexicalV2 ? 0 : rowCounts[11]},
      {name: 'lexical_scopes', rowCount: rowCounts[6]},
      {name: 'lexical_members', rowCount: rowCounts[7]},
      {name: 'lexical_owners', rowCount: rowCounts[8]},
      {name: 'lexical_shared', rowCount: rowCounts[9]},
    ]);
    expect(EffectArray.map(surfaces, surface => surface.rowCount)).toEqual(rowCounts);
  },
  {fastCheck: {numRuns: 100}},
);
