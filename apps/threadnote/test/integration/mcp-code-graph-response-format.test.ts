import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {Effect, Schema} from 'effect';
import {
  indexPreparedCodeGraphWorksetFixture,
  publishIndexedCodeGraphWorksetCatalog,
} from '../../../../scripts/support/code-graph-workset-harness.js';
import {
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
} from '../../../../scripts/support/code-graph-workset-fixture.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {
  codeGraphEvaluationFixtureHash,
  parseCodeGraphEvaluationFixtureV1,
} from '@threadnote/threadnote/evaluation/code-graph';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const graphResponseProjectionSchema = Schema.Struct({
  continuation: Schema.optional(Schema.Struct({cursor: Schema.optional(Schema.String)})),
  edges: Schema.Array(Schema.Unknown),
  nodes: Schema.Array(Schema.Unknown),
  operation: Schema.Unknown,
  output: Schema.Struct({returnedEdges: Schema.Finite, returnedNodes: Schema.Finite}),
  repository: Schema.Unknown,
  snapshot: Schema.Unknown,
  trust: Schema.Unknown,
});

const graphResponseBaselineSchema = Schema.Struct({
  agentEnvelopeComparison: Schema.Struct({
    after: Schema.Struct({
      queries: Schema.Array(
        Schema.Struct({
          agentBytes: Schema.Finite,
          dualBytes: Schema.Finite,
          id: Schema.String,
          textBytes: Schema.Finite,
        }),
      ),
      totals: Schema.Struct({
        agentBytes: Schema.Finite,
        dualBytes: Schema.Finite,
        estimatedTokens: Schema.Finite,
        textBytes: Schema.Finite,
      }),
    }),
    before: Schema.Struct({totals: Schema.Struct({agentBytes: Schema.Finite})}),
    savings: Schema.Struct({agentBytes: Schema.Finite, percent: Schema.Finite}),
  }),
  fixtureHash: Schema.String,
  queries: Schema.Array(Schema.Struct({dualBytes: Schema.Finite, id: Schema.String, textBytes: Schema.Finite})),
  totals: Schema.Struct({dualBytes: Schema.Finite, textBytes: Schema.Finite}),
});

function parseGraphResponseProjection(value: unknown) {
  return Schema.decodeUnknownSync(graphResponseProjectionSchema)(value);
}

function graphWorksetCursor(value: unknown): string | undefined {
  const projection = Schema.decodeUnknownSync(
    Schema.StructWithRest(
      Schema.Struct({continuation: Schema.optional(Schema.Struct({cursor: Schema.optional(Schema.String)}))}),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  )(value);
  return projection.continuation?.cursor;
}

describe('MCP code graph response format', () => {
  it('preserves the complete projected graph across explicit dual/text and default agent formats', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-format-'));
    const repository = join(root, 'repository');
    const home = join(root, 'home');
    const fixture = parseCodeGraphEvaluationFixtureV1(
      await Bun.file(join(process.cwd(), 'apps/threadnote/test/evaluation/fixtures/code-graph-v1/fixture.json')).json(),
    );
    const baseline = Schema.decodeUnknownSync(graphResponseBaselineSchema)(
      await Bun.file(
        join(process.cwd(), 'apps/threadnote/test/evaluation/baselines/graph-response-single-channel-v1/baseline.json'),
      ).json(),
    );
    let client: Client | undefined;
    try {
      cpSync(
        join(process.cwd(), 'apps/threadnote/test/evaluation/fixtures/code-graph-v1', fixture.repositoryRoot),
        repository,
        {
          recursive: true,
        },
      );
      mkdirSync(home);
      writeFileSync(join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
      execFileSync('git', ['init', '-q'], {cwd: repository});
      execFileSync('git', ['add', '.'], {cwd: repository});
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Threadnote Evaluation',
          '-c',
          'user.email=evaluation@threadnote.local',
          'commit',
          '-qm',
          'fixture',
        ],
        {cwd: repository},
      );
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, threadnoteHome: home});
        }),
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), 'apps/threadnote/src/standalone.ts'), 'mcp-server'],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          THREADNOTE_HOME: home,
          THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_TELEMETRY: '0',
          THREADNOTE_MCP_TOOLSET: 'core',
        },
      });
      client = new Client({name: 'graph-format-evaluation', version: '1'});
      await client.connect(transport);
      const tool = EffectOption.getOrUndefined(
        EffectArray.findFirst((await client.listTools()).tools, candidate => candidate.name === 'inspect_code_graph'),
      );
      expect(JSON.stringify(tool?.inputSchema)).toContain('responseFormat');
      expect(JSON.stringify(tool?.inputSchema)).not.toContain('readTimeoutMilliseconds');
      expect(JSON.stringify(tool?.inputSchema)).toContain('impact agent defaults to 1250');
      expect(JSON.stringify(tool?.inputSchema)).toContain('Ceiling:');
      expect(JSON.stringify(tool?.inputSchema)).toContain('agent shows 3 unless set');

      let agentBytes = 0;
      let dualBytes = 0;
      let textBytes = 0;
      const measurements: {agentBytes: number; dualBytes: number; id: string; textBytes: number}[] = [];
      for (const query of fixture.queries) {
        const args = {
          callerCwd: repository,
          operation: query.operation,
          ...(query.query === undefined ? {} : {query: query.query}),
          ...(query.from === undefined ? {} : {from: query.from}),
          ...(query.to === undefined ? {} : {to: query.to}),
        };
        const dual = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'dual'},
        });
        const text = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'text'},
        });
        const agent = await client.callTool({name: 'inspect_code_graph', arguments: args});
        expect(dual.isError).not.toBe(true);
        expect(text.isError).not.toBe(true);
        expect(agent.isError).not.toBe(true);
        expect(dual.structuredContent).toBeDefined();
        expect(text.structuredContent).toBeUndefined();
        expect(agent.structuredContent).toBeUndefined();
        if (!EffectArray.isArray(text.content)) throw new Error('Graph response content was not an array');
        expect(text.content).toHaveLength(1);
        const dualText = firstText(dual.content);
        const textOnly = firstText(text.content);
        const agentOnly = firstText(agent.content);
        const parsed = parseGraphResponseProjection(JSON.parse(textOnly));
        const dualProjection = parseGraphResponseProjection(dual.structuredContent);
        expect(parsed).toMatchObject({
          operation: dualProjection.operation,
          repository: dualProjection.repository,
          snapshot: dualProjection.snapshot,
          trust: dualProjection.trust,
        });
        expect(parsed.nodes).toEqual(expect.arrayContaining([...dualProjection.nodes]));
        expect(parsed.edges).toEqual(expect.arrayContaining([...dualProjection.edges]));
        expect(parsed.output.returnedNodes).toBeGreaterThanOrEqual(dualProjection.output.returnedNodes);
        expect(parsed.output.returnedEdges).toBeGreaterThanOrEqual(dualProjection.output.returnedEdges);
        expect(parsed.trust).toEqual(dualProjection.trust);
        expect(parsed.snapshot).toEqual(dualProjection.snapshot);
        expect(Effect2.pipe(agentOnly, EffectString.startsWith('TN-GRAPH/1\n'))).toBe(true);
        expect(agentOnly).toContain('Coverage:');
        expect(agentOnly).not.toContain('\noperation\t');
        expect(agentOnly).not.toContain('\nrepository\t');
        expect(agentOnly).not.toContain('\nsnapshot\t');
        expect(agentOnly).not.toContain('\ntrust\t');
        expect(agentOnly).not.toContain('\nsourceVersion\t');
        if (query.operation === 'impact' || query.operation === 'query') {
          for (const symbol of query.relevantSymbols ?? []) {
            expect(agentOnly).toContain(symbol);
          }
          if (query.operation === 'query' && query.answerable && (query.relevantPaths?.length ?? 0) > 0) {
            expect(
              EffectOption.getOrUndefined(
                EffectOption.map(EffectOption.fromNullishOr(query.relevantPaths), __effectArrayReceiver =>
                  EffectArray.some(
                    __effectArrayReceiver,
                    __effectArrayValue =>
                      !!(path => Effect2.pipe(agentOnly, EffectString.includes(path)))(__effectArrayValue),
                  ),
                ),
              ),
            ).toBe(true);
          }
          expect(agentGraphHasOnlyVisibleEdgeAliases(agentOnly)).toBe(true);
          const largerCeiling = await client.callTool({
            name: 'inspect_code_graph',
            arguments: {...args, budgetTokens: 1_500},
          });
          expect(largerCeiling.isError).not.toBe(true);
          expect(firstText(largerCeiling.content)).toBe(agentOnly);
          if (query.operation === 'query' && query.answerable) {
            const expanded = await client.callTool({
              name: 'inspect_code_graph',
              arguments: {...args, budgetTokens: 1_500, nodeLimit: 8},
            });
            expect(expanded.isError).not.toBe(true);
            const expandedText = firstText(expanded.content);
            expect(agentGraphHasOnlyVisibleEdgeAliases(expandedText)).toBe(true);
            expect(agentGraphNodeCount(expandedText)).toBeGreaterThan(agentGraphNodeCount(agentOnly));
          }
        }
        const measuredDualBytes = measureAgentToolResponse({
          text: dualText,
          structuredContent: dual.structuredContent,
        }).totalBytes;
        const measuredTextBytes = measureAgentToolResponse({text: textOnly}).totalBytes;
        const measuredAgentBytes = measureAgentToolResponse({text: agentOnly}).totalBytes;
        dualBytes += measuredDualBytes;
        textBytes += measuredTextBytes;
        agentBytes += measuredAgentBytes;
        measurements.push({
          agentBytes: measuredAgentBytes,
          dualBytes: measuredDualBytes,
          id: query.id,
          textBytes: measuredTextBytes,
        });
      }
      expect(codeGraphEvaluationFixtureHash(fixture)).toBe(baseline.fixtureHash);
      const comparison = baseline.agentEnvelopeComparison;
      expect(measurements).toEqual(comparison.after.queries);
      expect({agentBytes, dualBytes, estimatedTokens: Math.ceil(agentBytes / 3), textBytes}).toEqual(
        comparison.after.totals,
      );
      expect(EffectArray.map(measurements, ({dualBytes, id, textBytes}) => ({dualBytes, id, textBytes}))).toEqual(
        baseline.queries,
      );
      expect({dualBytes, textBytes}).toEqual(baseline.totals);
      expect(textBytes).toBeLessThan(dualBytes * 0.9);
      expect(agentBytes).toBeLessThan(textBytes);
      expect(comparison.before.totals.agentBytes - agentBytes).toBe(comparison.savings.agentBytes);
      expect(
        Number(
          (((comparison.before.totals.agentBytes - agentBytes) / comparison.before.totals.agentBytes) * 100).toFixed(1),
        ),
      ).toBe(comparison.savings.percent);
    } finally {
      await client?.close();
      rmSync(root, {recursive: true, force: true});
    }
  }, 120_000);

  it('defaults named Workset projections to lossless text while preserving explicit dual', async () => {
    const fixture = await prepareCodeGraphWorksetFixture({size: 1});
    let client: Client | undefined;
    try {
      await runEffect(
        Effect.gen(function* () {
          yield* indexPreparedCodeGraphWorksetFixture(fixture);
          yield* publishIndexedCodeGraphWorksetCatalog(fixture, [fixture.identity.worksetName]);
        }),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), 'apps/threadnote/src/standalone.ts'), 'mcp-server'],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          THREADNOTE_HOME: fixture.home,
          THREADNOTE_MANIFEST: fixture.manifestPath,
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_TELEMETRY: '0',
          THREADNOTE_MCP_TOOLSET: 'core',
        },
      });
      client = new Client({name: 'graph-format-workset-evaluation', version: '1'});
      await client.connect(transport);
      const callerCwd = fixture.repositories[0].path;
      const workset = fixture.identity.worksetName;
      const query = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          fixture.plan.queries,
          __effectArrayValue =>
            !!(candidate => candidate.sizes.includes(1) && candidate.operation === 'query')(__effectArrayValue),
        ),
      );
      if (query === undefined) throw new Error('Workset fixture had no size-1 query');
      for (const args of [
        {budgetTokens: 500, callerCwd, operation: 'query', query: query.query, workset},
        {callerCwd, operation: 'topology', workset},
      ]) {
        const dual = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'dual'},
        });
        const defaultText = await client.callTool({name: 'inspect_code_graph', arguments: args});
        const text = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'text'},
        });
        const agent = await client.callTool({
          name: 'inspect_code_graph',
          arguments: {...args, responseFormat: 'agent'},
        });
        expect(dual.isError).not.toBe(true);
        expect(defaultText.isError).not.toBe(true);
        expect(text.isError).not.toBe(true);
        expect(agent.isError).toBe(true);
        expect(JSON.stringify(agent.content)).toContain('only for local repository inspections');
        expect(defaultText.structuredContent).toBeUndefined();
        expect(text.structuredContent).toBeUndefined();
        const parsed: unknown = JSON.parse(firstText(text.content));
        expect(withoutWorksetCursor(JSON.parse(firstText(defaultText.content)))).toEqual(withoutWorksetCursor(parsed));
        expect(withoutWorksetCursor(parsed)).toEqual(withoutWorksetCursor(dual.structuredContent));
        if (args.operation === 'query') {
          const textCursor = graphWorksetCursor(parsed);
          const dualCursor = graphWorksetCursor(dual.structuredContent);
          expect(textCursor).toMatch(/^cgwc_/);
          expect(dualCursor).toMatch(/^cgwc_/);
          if (textCursor === undefined || dualCursor === undefined) throw new Error('Missing Workset continuation');
          const dualContinued = await client.callTool({
            name: 'inspect_code_graph',
            arguments: {callerCwd, cursor: dualCursor, operation: 'query', responseFormat: 'dual', workset},
          });
          const textContinued = await client.callTool({
            name: 'inspect_code_graph',
            arguments: {callerCwd, cursor: textCursor, operation: 'query', responseFormat: 'text', workset},
          });
          expect(dualContinued.isError).not.toBe(true);
          expect(textContinued.isError).not.toBe(true);
          expect(textContinued.structuredContent).toBeUndefined();
          expect(withoutWorksetCursor(JSON.parse(firstText(textContinued.content)))).toEqual(
            withoutWorksetCursor(dualContinued.structuredContent),
          );
        }
      }
      const localTooSmall = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {budgetTokens: 500, callerCwd, operation: 'query', query: query.query},
      });
      expect(localTooSmall.isError).toBe(true);
      expect(JSON.stringify(localTooSmall.content)).toContain('800 to 1500');
    } finally {
      await client?.close();
      await removePreparedCodeGraphWorksetFixture(fixture);
    }
  }, 120_000);
});

function firstText(content: unknown): string {
  if (!EffectArray.isArray(content)) throw new Error('Graph response content was not an array');
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null || !('type' in first) || first.type !== 'text') {
    throw new Error('Graph response did not contain text');
  }
  if (!('text' in first) || typeof first.text !== 'string') throw new Error('Graph response text was invalid');
  return first.text;
}

function agentGraphHasOnlyVisibleEdgeAliases(text: string): boolean {
  const lines = Effect2.pipe(text, EffectString.trimEnd, EffectString.split('\n'));
  const aliases = new Set(
    EffectArray.flatMap(
      lines,
      line =>
        Effect2.pipe(
          line,
          EffectString.match(/^(n\d+)\. /u),
          Effect2.Option.getOrElse(() => null),
        )?.slice(1) ?? [],
    ),
  );
  return EffectArray.every(
    EffectArray.flatMap(
      lines,
      line =>
        Effect2.pipe(
          line,
          EffectString.match(/^(.+?) → (.+?): /u),
          Effect2.Option.getOrElse(() => null),
        )?.slice(1) ?? [],
    ),
    alias => aliases.has(alias),
  );
}

function agentGraphNodeCount(text: string): number {
  return EffectArray.filter(
    Effect2.pipe(text, EffectString.trimEnd, EffectString.split('\n')),
    __effectArrayValue2 => !!(line => /^n\d+\. /u.test(line))(__effectArrayValue2),
  ).length;
}

function withoutWorksetCursor(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === 'cursor' && typeof item === 'string' ? '<cursor>' : item)),
  );
}
