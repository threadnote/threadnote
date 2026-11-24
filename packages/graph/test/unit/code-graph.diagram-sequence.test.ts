import {Array as Arr, Option, String as Str} from 'effect';
import {expect, it} from 'vitest';
import type {CodeGraphDiagramFact} from '../../src/query/diagram.js';
import {renderSourceBackedSequence} from '../../src/query/diagram_sequence.js';
import type {CodeGraphQueryNode, CodeGraphSpan} from '../../src/types.js';

const SOURCE = `import {Effect as Fx} from 'effect';
export const run = Fx.fn('private label')(function* () {
  yield* setup();
  if (mode('private mode').ready) {
    for (;;) {
      yield* claim();
      const task = Fx.gen(function* () {
        yield* runtime.embedMany();
        yield* infer();
      });
      schedule(() => delayed(), task);
      yield* persist();
      if (finished) break;
    }
  } else {
    yield* reuse();
  }
  yield* Fx.gen(function* () { yield* publish(); }).pipe(Fx.onExit(() => release()));
  yield* cleanup();
});`;

function spanIn(source: string, text: string): CodeGraphSpan {
  const start = Option.getOrThrowWith(Str.indexOf(text)(source), () => new Error(`Invalid fixture span for ${text}`));
  const parts = Str.split('\n')(Str.slice(0, start)(source));
  const end = Str.split('\n')(Str.slice(0, start + text.length)(source));
  return {
    line: parts.length,
    column: (parts.at(-1)?.length ?? 0) + 1,
    endLine: end.length,
    endColumn: (end.at(-1)?.length ?? 0) + 1,
  };
}

const spanOf = (text: string): CodeGraphSpan => spanIn(SOURCE, text);

function symbol(name: string, path: string, span: CodeGraphSpan): CodeGraphQueryNode {
  return {
    id: name,
    name,
    qualifiedName: name,
    language: 'typescript',
    kind: 'function',
    path,
    span,
    contentHash: 'fixture',
    exported: false,
    score: 0,
  };
}

const subjectStart = Option.getOrThrow(Str.indexOf('run = ')(SOURCE));
const subject = symbol('run', 'src/run.ts', spanOf(Str.slice(subjectStart, -1)(SOURCE)));
const names = ['setup', 'claim', 'infer', 'delayed', 'persist', 'reuse', 'publish', 'release', 'cleanup'];
const nodes = new Map([[subject.id, subject]]);
const facts: readonly CodeGraphDiagramFact[] = Arr.map(names, name => {
  const span = spanOf(`${name}()`);
  nodes.set(name, symbol(name, 'src/work.ts', span));
  return {
    id: `edge_${name}`,
    relation: 'calls',
    sourceId: subject.id,
    sourceName: subject.name,
    targetId: name,
    targetName: name,
    provenance: 'resolved',
    confidence: 1,
    evidencePath: subject.path,
    evidenceSpan: span,
  };
});
const input = {
  subject,
  nodes,
  facts,
  sources: new Map([[subject.path, new TextEncoder().encode(SOURCE)]]),
  gaps: [
    {
      kind: 'unresolved-target' as const,
      path: subject.path,
      edgeId: 'edge_dynamic',
      span: spanOf('runtime.embedMany()'),
      label: 'property.embedMany',
    },
  ],
};

it('projects branch and loop order while keeping deferred calls and unresolved receivers explicit', () => {
  const result = renderSourceBackedSequence(input);
  expect(result).toMatchObject({orderedCalls: 7, unorderedCalls: 2});
  if (!result) throw new Error('Expected source-backed sequence');
  const source = result.source;
  expect(source).toContain('alt Condition at line 4');
  expect(source).toContain('loop Local iteration at line 5');
  expect(source).toContain('else Otherwise');
  expect(source).toContain('%% Unresolved call edge_dynamic\n  p1->>p3: embedMany yielded at line 8');
  expect(source).toContain('participant p3 as Unresolved target');
  expect(result.lifelines).toEqual([
    {path: 'src/run.ts', diagramId: 'p1', label: 'src/run.ts'},
    {path: 'src/work.ts', diagramId: 'p2', label: 'src/work.ts'},
  ]);
  expect(result.discoveredGaps).toEqual([]);
  expect(source).toContain('Its order relative to other scopes is unknown');
  expect(source).not.toContain('private mode');
  expect(source).not.toContain('private label');
  const orderedFacts = Arr.filter(Str.split('\n')(source), Str.includes('%% Indexed call'));
  expect(Arr.map(orderedFacts, line => Str.split(' ')(line).at(-1))).toEqual([
    'edge_setup',
    'edge_claim',
    'edge_persist',
    'edge_reuse',
    'edge_publish',
    'edge_cleanup',
    'edge_infer',
  ]);
  for (const call of facts) expect(Str.split(call.id)(source)).toHaveLength(2);
  expect(source).toContain('Unordered indexed relationships in src/run.ts');
  expect(source).toContain('%% edge_delayed\n  %% edge_release\n  Note over p1');
  expect(source).toContain('run calls delayed at line 11');
  expect(source).toContain('run calls release at line 18');
});

it('orders the receiver before optional arguments and guards continuation after an early return', () => {
  const source = `async function runOptional() {
  getService()?.run(buildInput());
  if (flag) return early();
  await unknown.execute(getArgument('private value'));
  later();
}`;
  const root = symbol('runOptional', 'src/run.ts', spanIn(source, source));
  const allNodes = new Map([[root.id, root]]);
  const calls: readonly CodeGraphDiagramFact[] = Arr.map(
    [
      ['getService', 'getService()'],
      ['buildInput', 'buildInput()'],
      ['run', 'getService()?.run(buildInput())'],
      ['early', 'early()'],
      ['later', 'later()'],
    ],
    ([name, site]) => {
      const span = spanIn(source, site);
      allNodes.set(name, symbol(name, 'src/work.ts', span));
      return {
        ...facts[0],
        id: `edge_${name}`,
        sourceId: root.id,
        sourceName: root.name,
        targetId: name,
        targetName: name,
        evidenceSpan: span,
      };
    },
  );
  const result = renderSourceBackedSequence({
    subject: root,
    facts: calls,
    nodes: allNodes,
    sources: new Map([[root.path, new TextEncoder().encode(source)]]),
    gaps: [],
  });
  expect(result).toMatchObject({
    orderedCalls: 5,
    unorderedCalls: 0,
    hasControls: true,
    discoveredGaps: [
      {
        kind: 'unresolved-target',
        label: 'unknown.execute',
        path: root.path,
        span: spanIn(source, "unknown.execute(getArgument('private value'))"),
      },
    ],
  });
  if (!result) throw new Error('Expected source-backed sequence');
  expect(result.source).toContain(
    Arr.join(
      [
        '  %% Indexed call edge_getService',
        '  p1->>p2: getService invoked at line 2',
        '  opt Optional chain continues at line 2',
        '  %% Indexed call edge_buildInput',
        '  p1->>p2: buildInput invoked at line 2',
        '  %% Indexed call edge_run',
        '  p1->>p2: run invoked at line 2',
        '  end',
      ],
      '\n',
    ),
  );
  expect(result.source).toContain(
    Arr.join(
      [
        '  %% Indexed call edge_early',
        '  p1->>p2: early invoked at line 3',
        '  Note over p1: Return at line 3. This scope exits',
        '  end',
        '  opt Control reaches line 4',
        '  Note over p1: execute awaited at line 4. Target identity is unknown',
        '  %% Indexed call edge_later',
        '  p1->>p2: later invoked at line 5',
        '  end',
      ],
      '\n',
    ),
  );
  expect(result.source).not.toContain('private value');
});

it('abstains when verified bytes or anchored call sites are unavailable', () => {
  expect(renderSourceBackedSequence({...input, sources: new Map()})).toBeUndefined();
  expect(
    renderSourceBackedSequence({...input, facts: Arr.filter(facts, fact => fact.targetName === 'delayed')}),
  ).toMatchObject({source: '', orderedCalls: 0, unorderedCalls: 1});
  const wrongSite = {...facts[0], evidenceSpan: {...facts[0].evidenceSpan, endColumn: 1}};
  expect(renderSourceBackedSequence({...input, facts: [wrongSite]})).toMatchObject({
    source: '',
    orderedCalls: 0,
    discoveredGaps: expect.arrayContaining([
      {kind: 'unresolved-target', label: 'setup', path: subject.path, span: facts[0].evidenceSpan},
    ]),
  });
});
