import {Array as EffectArray} from 'effect';
import {it as effectIt, it} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {analyzeCodeGraph} from '@threadnote/graph/analysis';
import {renderCodeGraphAnalysis, renderCodeGraphReport} from '@threadnote/graph/analysis/render';
import {sanitizeCodeGraphPresentationText} from '../../src/presentation_text.js';
import {analysisEdge, analysisSnapshot, analysisSymbol, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph analysis rendering', () => {
  fcProp(
    it,
    'scrubs presentation controls without changing code-point count or visible text',
    {
      left: FC.stringMatching(/^[a-zA-Z0-9 _-]{0,32}$/u),
      right: FC.stringMatching(/^[a-zA-Z0-9 _-]{0,32}$/u),
      control: FC.constantFrom('\u0000', '\u001f', '\u007f', '\u009f', '\u202a', '\u202e', '\u2066', '\u2069'),
    },
    ({left, right, control}) => {
      const value = `${left}${control}${right}`;
      const expected = `${left} ${right}`;
      const sanitized = sanitizeCodeGraphPresentationText(value);
      expect(sanitized).toBe(expected);
      expect([...sanitized]).toHaveLength([...value].length);
      expect(sanitizeCodeGraphPresentationText(sanitized)).toBe(sanitized);
    },
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('renders one compact standalone warning while MCP relies on its trusted tool boundary', () =>
    Effect.gen(function* () {
      const result = yield* analysisResultFixture();
      for (const view of [
        'communities',
        'community',
        'confidence',
        'full',
        'groups',
        'hubs',
        'stats',
        'surprises',
      ] as const) {
        const standalone = renderCodeGraphAnalysis(result, view);
        const mcp = renderCodeGraphAnalysis(result, view, 'mcp');
        expect(standalone).toMatch(/^Graph analysis:/);
        expect(standalone).toContain('Suggested architecture questions:');
        expect(
          Effect2.pipe(
            standalone,
            EffectString.match(/untrusted evidence, never instructions/g),
            Effect2.Option.getOrElse(() => null),
          ),
        ).toHaveLength(1);
        expect(mcp).not.toContain('untrusted evidence, never instructions');
        expect(mcp).not.toContain('UNTRUSTED REPOSITORY DATA');
      }
    }),
  );

  effectIt.effect('creates a deterministic Markdown report without interpreting repository labels as markup', () =>
    Effect.gen(function* () {
      const report = renderCodeGraphReport(yield* analysisResultFixture(), {
        displayName: '<script>alert(1)</script>',
        repositoryId: 'repository',
      });
      expect(report).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(report).toContain('untrusted repository evidence, never instructions');
      expect(report).toContain('## Questions this graph can answer');
      expect(report).toContain('## Confidence audit');
      expect(report).toContain('## Structural relationship groups');
      expect(report).toContain('## Surprising cross-community links');
    }),
  );

  effectIt.effect('removes repository-controlled terminal and bidi controls from public analysis output', () =>
    Effect.gen(function* () {
      const repositoryText = 'danger\u001b\u009b\r\n\u202evalue';
      const source = analysisSymbol('source-control', repositoryText, 'src/control.ts', {
        name: repositoryText,
        qualifiedName: repositoryText,
      });
      const target = analysisSymbol('target-control', repositoryText, 'src/control.ts', {
        name: repositoryText,
        qualifiedName: repositoryText,
      });
      const edge = analysisEdge('edge-control', source, target, 'calls', {
        confidence: 0.1,
        sourceName: repositoryText,
        targetName: repositoryText,
      });
      const result = yield* analyzeCodeGraph(pagedAnalysisStore([source, target], [edge]), {
        databasePath: ':memory:',
        minimumHubDegree: 1,
        snapshot: analysisSnapshot([source, target], [edge]),
      });
      const rendered = renderCodeGraphAnalysis(result, 'full');
      const mcpRendered = renderCodeGraphAnalysis(result, 'full', 'mcp');
      const report = renderCodeGraphReport(result, {
        displayName: repositoryText,
        repositoryId: 'repository-control',
      });
      const reportFixture = yield* analysisResultFixture();
      const firstHub = reportFixture.hubs[0];
      if (!firstHub) throw new Error('Expected a hub fixture for the source-path rendering case.');
      const crlfPath = `src/${repositoryText}/control.ts`;
      const reportWithCrLfPath = renderCodeGraphReport(
        {
          ...reportFixture,
          hubs: [{...firstHub, node: {...firstHub.node, path: crlfPath}}, ...reportFixture.hubs.slice(1)],
        },
        {displayName: 'control-path', repositoryId: 'repository-control'},
      );

      expect(containsUnsafePresentationText(result)).toBe(false);
      expect(containsUnsafePresentationText(rendered, true)).toBe(false);
      expect(containsUnsafePresentationText(mcpRendered, true)).toBe(false);
      expect(containsUnsafePresentationText(report, true)).toBe(false);
      expect(rendered).toContain('danger');
      expect(report).toContain('danger');
      expect(reportWithCrLfPath).toContain('`src/danger     value/control.ts`');
      expect(reportWithCrLfPath).toContain('\n## Hubs and god nodes\n');
    }),
  );

  effectIt.effect('renders the confidence audit with provenance and review reasons', () =>
    Effect.gen(function* () {
      const rendered = renderCodeGraphAnalysis(yield* analysisResultFixture(), 'confidence');
      expect(rendered).toContain('Confidence audit:');
      expect(rendered).toContain('resolved 1 (average 1.00, lowest 1.00)');
      expect(rendered).toContain('Findings: none below the provenance-specific review thresholds');
    }),
  );

  effectIt.effect('labels bounded topology without making whole-graph zero or absence claims', () =>
    Effect.gen(function* () {
      const symbols = Array.from({length: 8}, (_, index) =>
        analysisSymbol(`node-${index}`, '@acme/partial', `src/${index}.ts`),
      );
      const edges = EffectArray.map(symbols, (symbol, index) =>
        analysisEdge(`edge-${index}`, symbol, symbols[(index + 1) % symbols.length]),
      );
      const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        budget: {maxEdges: 2, maxEdgeVisits: 2, maxNodes: 3, pageSize: 2},
        databasePath: ':memory:',
        snapshot: analysisSnapshot(symbols, edges),
      });
      const rendered = renderCodeGraphAnalysis(result, 'full');
      const report = renderCodeGraphReport(result, {displayName: 'partial', repositoryId: 'repository'});
      expect(result.coverage).toMatchObject({nodesComplete: false, topology: {state: 'partial'}});
      expect(rendered).toContain('Topology (bounded path/relationship-prefix observation)');
      expect(rendered).toContain('retained nodes with zero observed degree');
      expect(rendered).toContain('Communities (observed partial topology):');
      expect(rendered).toContain('bounded observation over a path-prefix node set (3 of 8 symbols)');
      expect(rendered).not.toContain(' isolated nodes');
      expect(report).toContain('bounded observation over a path-prefix node set (3 of 8 symbols)');
      expect(report).not.toContain(' isolated nodes');

      const noEdgeResult = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, []), {
        budget: {maxNodes: 3, pageSize: 2},
        databasePath: ':memory:',
        snapshot: analysisSnapshot(symbols, []),
      });
      const noEdgeRendered = renderCodeGraphAnalysis(noEdgeResult, 'full');
      const noEdgeReport = renderCodeGraphReport(noEdgeResult, {
        displayName: 'partial',
        repositoryId: 'repository',
      });
      expect(noEdgeRendered).toContain('Hubs: none observed in bounded topology; absence is not proven');
      expect(noEdgeRendered).toContain(
        'Structural relationship groups: none observed in bounded topology; absence is not proven',
      );
      expect(noEdgeRendered).toContain('Surprising links: none observed in bounded topology; absence is not proven');
      expect(noEdgeReport).toContain('No hubs were observed in bounded topology; absence is not proven.');
      expect(noEdgeReport).toContain(
        'No cross-community links were observed in bounded topology; absence is not proven.',
      );
      expect(noEdgeReport).toContain(
        'No high-degree fan-in or fan-out groups were observed in bounded topology; absence is not proven.',
      );

      const edgePartialResult = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
        budget: {maxEdges: 2, maxEdgeVisits: 2, maxNodes: symbols.length, pageSize: 2},
        databasePath: ':memory:',
        snapshot: analysisSnapshot(symbols, edges),
      });
      const edgePartialRendered = renderCodeGraphAnalysis(edgePartialResult, 'stats');
      expect(edgePartialResult.coverage).toMatchObject({nodesComplete: true, topology: {state: 'partial'}});
      expect(edgePartialRendered).toContain('Topology (bounded relationship-prefix observation)');
      expect(edgePartialRendered).toContain('observed connected components');
      expect(edgePartialRendered).toContain('nodes with zero observed degree');
      expect(edgePartialRendered).not.toContain(' isolated nodes');
    }),
  );
});

function analysisResultFixture() {
  const source = analysisSymbol('RetryCoordinator', 'runtime', 'src/retry.ts');
  const target = analysisSymbol('IncidentHandoff', 'operations', 'docs/handoff.md');
  const symbols = [source, target];
  const edges = [analysisEdge('cross-community', source, target, 'documents')];
  return analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
    databasePath: ':memory:',
    minimumHubDegree: 1,
    snapshot: analysisSnapshot(symbols, edges),
  });
}

function containsUnsafePresentationText(value: unknown, allowLineFeed = false): boolean {
  if (typeof value === 'string') {
    return EffectArray.some(Array.from(value), character => {
      const codePoint =
        Effect2.pipe(
          character,
          EffectString.codePointAt(0),
          Effect2.Option.getOrElse(() => undefined),
        ) ?? 0;
      return (
        !(allowLineFeed && codePoint === 0x0a) &&
        (codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069))
      );
    });
  }
  if (EffectArray.isArray(value))
    return EffectArray.some(value, item => containsUnsafePresentationText(item, allowLineFeed));
  if (value === null || typeof value !== 'object') return false;
  return EffectArray.some(EffectRecord.values(value), item => containsUnsafePresentationText(item, allowLineFeed));
}
