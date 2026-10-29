import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '@threadnote/graph/fact/budget';
import {
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES,
  assessCodeGraphIncrementalFactBytes,
  codeGraphIncrementalFactBatchesFitBudget,
  codeGraphIncrementalWorkFitsBudget,
  measureCodeGraphIncrementalWork,
  planCodeGraphIncrementalFoldForwardPaths,
} from '@threadnote/graph/incremental/work';
import {overlayFallbackDescription} from '@threadnote/graph/indexer/incremental';
import {PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES} from '@threadnote/graph/indexer/materialization';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

describe('incremental rewrite work', () => {
  it('matches one governed persistent materialization transaction', () => {
    expect(CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES).toBe(PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES);
    expect(CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES * CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM).toBe(
      CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
    );
  });

  it('describes the current four-batch project closure envelope', () => {
    expect(overlayFallbackDescription('project-closure-unbounded')).toBe(
      'the project dependency closure exceeded the bounded four-batch materialization envelope',
    );
  });

  it('admits at most four per-file-bounded fact batches under the aggregate rewrite envelope', () => {
    const maximumBatchBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
    const batches = fc.array(
      fc.array(fc.record({bytes: fc.integer({max: maximumBatchBytes + 1, min: -1})}), {
        maxLength: 4,
        minLength: 0,
      }),
      {maxLength: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES + 1, minLength: 0},
    );
    fc.assert(
      fc.property(batches, value => {
        const batchBytes = EffectArray.map(value, batch =>
          EffectArray.reduce(batch, 0, (total, fact) => total + fact.bytes),
        );
        const factBytes = EffectArray.flatMap(value, batch => EffectArray.map(batch, fact => fact.bytes));
        const expected =
          value.length >= 1 &&
          value.length <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES &&
          EffectArray.every(value, (batch, index) => batch.length > 0 && batchBytes[index] <= maximumBatchBytes) &&
          EffectArray.every(
            factBytes,
            bytes => Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maximumBatchBytes,
          ) &&
          EffectArray.reduce(batchBytes, 0, (total, bytes) => total + bytes) <=
            CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES;
        expect(codeGraphIncrementalFactBatchesFitBudget(value)).toBe(expected);
      }),
      {numRuns: 250},
    );

    expect(
      codeGraphIncrementalFactBatchesFitBudget(
        Array.from({length: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES}, () => [{bytes: maximumBatchBytes}]),
      ),
    ).toBe(true);
    expect(
      codeGraphIncrementalFactBatchesFitBudget(
        Array.from({length: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES + 1}, () => [{bytes: 1}]),
      ),
    ).toBe(false);
  });

  it('distinguishes corrupt per-file facts from aggregate incremental overflow', () => {
    const maximumFileBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
    expect(
      assessCodeGraphIncrementalFactBytes({
        aggregateBytes: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
        factBytes: Array.from({length: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES}, () => maximumFileBytes),
      }),
    ).toEqual({mode: 'eligible'});
    expect(
      assessCodeGraphIncrementalFactBytes({
        aggregateBytes: maximumFileBytes + 1,
        factBytes: [maximumFileBytes + 1],
      }),
    ).toEqual({limit: maximumFileBytes, mode: 'exceeded', observedAtDecision: maximumFileBytes + 1});
    expect(
      assessCodeGraphIncrementalFactBytes({
        aggregateBytes: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES + 1,
        factBytes: [
          ...Array.from({length: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES}, () => maximumFileBytes),
          1,
        ],
      }),
    ).toEqual({
      limit: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
      mode: 'exceeded',
      observedAtDecision: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES + 1,
    });
    expect(assessCodeGraphIncrementalFactBytes({aggregateBytes: 2, factBytes: [1]})).toEqual({mode: 'invalid'});
  });

  it('rejects a combined added-and-deleted cache envelope that only exceeds in aggregate', () => {
    const perFile = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
    const addedFactBytes = [perFile, perFile];
    const deletedFactBytes = [perFile, perFile, 1];

    expect(
      assessCodeGraphIncrementalFactBytes({
        aggregateBytes: EffectArray.reduce(
          [...addedFactBytes, ...deletedFactBytes],
          0,
          (total, bytes) => total + bytes,
        ),
        factBytes: [...addedFactBytes, ...deletedFactBytes],
      }),
    ).toEqual({
      limit: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
      mode: 'exceeded',
      observedAtDecision: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES + 1,
    });
  });

  it('plans carried and cumulative paths as a deterministic bounded set union', () => {
    const paths = fc
      .uniqueArray(fc.integer({max: 400, min: 0}), {maxLength: 80})
      .map(values => EffectArray.map(values, value => `src/file-${value}.ts`));
    fc.assert(
      fc.property(paths, paths, (prior, fresh) => {
        const plan = planCodeGraphIncrementalFoldForwardPaths(prior, fresh);
        const expectedCumulative = [...new Set([...prior, ...fresh])].sort();
        expect(plan?.cumulativePaths).toEqual(expectedCumulative);
        expect(plan?.carriedPaths).toEqual(EffectArray.filter(prior, path => !fresh.includes(path)).sort());
        expect(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(plan?.carriedPaths), __effectArrayReceiver =>
              EffectArray.every(__effectArrayReceiver, path => !fresh.includes(path)),
            ),
          ),
        ).toBe(true);
        expect(planCodeGraphIncrementalFoldForwardPaths(prior, fresh)).toEqual(plan);
      }),
      {numRuns: 250},
    );
    expect(
      planCodeGraphIncrementalFoldForwardPaths(
        Array.from({length: CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES}, (_, index) => `src/p-${index}.ts`),
        ['src/overflow.ts'],
      ),
    ).toBeUndefined();
  });

  it('measures final fact bytes and every row presented to incremental staging', () => {
    const file: CodeGraphInventoryFile = {
      blobId: Effect.pipe('a', EffectString.repeat(40)),
      contentHash: Effect.pipe('b', EffectString.repeat(64)),
      language: 'typescript',
      mode: '100644',
      path: 'src/value.ts',
      size: 123,
      source: 'commit',
    };
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: file.path,
      references: [],
      symbols: [
        {
          contentHash: file.contentHash,
          exported: true,
          id: 'symbol',
          kind: 'function',
          language: file.language,
          lookupKeys: ['typescript:name:value'],
          name: 'value',
          path: file.path,
          qualifiedName: 'value',
          span: {column: 1, endColumn: 6, endLine: 1, line: 1},
        },
      ],
    };

    const measured = measureCodeGraphIncrementalWork({
      deletedPaths: ['src/removed.ts', 'src/removed.ts'],
      facts: [facts],
      files: [file],
      totalFiles: 10_000,
    });

    expect(measured).toMatchObject({
      attributionContextFiles: 0,
      baseFactsLoaded: 1,
      changedFiles: 1,
      deletedFiles: 1,
      inventoryFilesInspected: 10_000,
      probedDependencyPaths: 0,
      sourceBytes: 123,
      totalFiles: 10_000,
    });
    expect(measured.factBytes).toBe(new TextEncoder().encode(JSON.stringify(facts)).byteLength);
    expect(measured.plannedRows).toBeGreaterThanOrEqual(4);
    expect(codeGraphIncrementalWorkFitsBudget(measured)).toBe(true);
  });

  it('is independent of unrelated repository size, downward closed, and fails every exact budget overflow', () => {
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES, min: 1}),
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES, min: 0}),
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES, min: 0}),
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS, min: 1}),
        fc.integer({max: 1_000_000, min: 0}),
        (changedFiles, sourceBytes, factBytes, plannedRows, unrelatedFiles) => {
          const work = {
            attributionContextFiles: 0,
            baseFactsLoaded: changedFiles,
            changedFiles,
            deletedFiles: 0,
            factBytes,
            plannedRows,
            probedDependencyPaths: 0,
            sourceBytes,
            totalFiles: changedFiles + unrelatedFiles,
            inventoryFilesInspected: changedFiles + unrelatedFiles,
          };
          expect(codeGraphIncrementalWorkFitsBudget(work)).toBe(true);
          expect(codeGraphIncrementalWorkFitsBudget({...work, totalFiles: work.totalFiles + 10_000_000})).toBe(true);
          expect(
            codeGraphIncrementalWorkFitsBudget({
              ...work,
              changedFiles: Math.max(1, Math.floor(changedFiles / 2)),
              factBytes: Math.floor(factBytes / 2),
              plannedRows: Math.max(1, Math.floor(plannedRows / 2)),
              sourceBytes: Math.floor(sourceBytes / 2),
            }),
          ).toBe(true);
        },
      ),
      {numRuns: 250},
    );

    const boundary = {
      attributionContextFiles: 10_000,
      baseFactsLoaded: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
      changedFiles: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
      deletedFiles: 0,
      factBytes: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
      plannedRows: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS,
      probedDependencyPaths: 4_096,
      sourceBytes: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES,
      totalFiles: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
      inventoryFilesInspected: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
    };
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, changedFiles: boundary.changedFiles + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, factBytes: boundary.factBytes + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, plannedRows: boundary.plannedRows + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, sourceBytes: boundary.sourceBytes + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, attributionContextFiles: 10_001})).toBe(false);
    expect(
      codeGraphIncrementalWorkFitsBudget({
        ...boundary,
        baseFactsLoaded: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES + 1,
      }),
    ).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, probedDependencyPaths: 4_097})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, inventoryFilesInspected: boundary.totalFiles + 1})).toBe(
      false,
    );
  });

  it('admits a bounded deletion-only staged delta', () => {
    const deletionOnly = {
      attributionContextFiles: 0,
      baseFactsLoaded: 0,
      changedFiles: 0,
      deletedFiles: 1,
      factBytes: 0,
      plannedRows: 1,
      probedDependencyPaths: 0,
      sourceBytes: 0,
      totalFiles: 12,
      inventoryFilesInspected: 12,
    };
    expect(codeGraphIncrementalWorkFitsBudget(deletionOnly)).toBe(true);
    expect(codeGraphIncrementalWorkFitsBudget({...deletionOnly, deletedFiles: 0})).toBe(false);
  });
});
