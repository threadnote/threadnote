import {Schema, String as Str} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS,
  prepareCodeGraphDiagramQuery,
  projectCodeGraphDiagram,
  type CodeGraphDiagramInput,
} from '../../src/query/diagram.js';
import {CodeGraphDiagramResultSchema} from '../../src/query/diagram_contract.js';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphRelation} from '../../src/types.js';

const scope = {repositoryId: 'repo', repositoryName: 'Fixture', snapshotId: 'snapshot', commit: 'abc123'};
const span = (line: number) => ({line, column: 2, endLine: line, endColumn: 12});

function symbol(
  name: string,
  kind: string,
  options?: {
    readonly id?: string;
    readonly path?: string;
    readonly line?: number;
    readonly label?: string;
    readonly packageName?: string;
  },
): CodeGraphQueryNode {
  return {
    id: options?.id ?? name,
    name,
    qualifiedName: options?.label ?? name,
    kind,
    exported: true,
    contentHash: 'content',
    language: 'typescript',
    path: options?.path ?? `src/${name}.ts`,
    span: span(options?.line ?? 1),
    score: 1,
    ...(options?.packageName ? {packageName: options.packageName} : {}),
  };
}

function relation(
  id: string,
  relation: CodeGraphRelation,
  source: CodeGraphQueryNode,
  target: CodeGraphQueryNode,
  line: number,
  provenance: CodeGraphEdge['provenance'] = 'resolved',
): CodeGraphEdge {
  return {
    id,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
    evidencePath: source.path,
    evidenceSpan: span(line),
    confidence: 1,
    provenance,
  };
}

function project(
  input: Omit<CodeGraphDiagramInput, 'scope' | 'freshness'> & Partial<Pick<CodeGraphDiagramInput, 'freshness'>>,
) {
  return projectCodeGraphDiagram({scope, freshness: 'current', ...input});
}

function requireDiagram(result: ReturnType<typeof project>) {
  if (result.status !== 'diagram') throw new Error(JSON.stringify(result));
  return result;
}

describe('code graph diagrams', () => {
  it('preserves selectors and useful terms in a bounded retrieval query', () => {
    expect(prepareCodeGraphDiagramQuery('Show me the class diagram for src/auth.ts#SessionStore.')).toBe(
      'src/auth.ts#SessionStore',
    );
    expect(prepareCodeGraphDiagramQuery('How do SessionStore and Cache work together?')).toBe('SessionStore Cache');
    expect(prepareCodeGraphDiagramQuery('Explain ' + Str.repeat(400)('symbol '))).toBe('symbol');
  });

  it('selects class structure from a natural question and maps every item to exact source', () => {
    const store = symbol('SessionStore', 'class', {line: 7});
    const parent = symbol('BaseStore', 'class', {line: 3});
    const role = symbol('Storage', 'interface', {line: 5});
    const result = requireDiagram(
      project({
        question: 'Which interfaces and classes does SessionStore implement or inherit?',
        nodes: [role, parent, store],
        edges: [relation('b', 'implements', store, role, 7, 'declared'), relation('a', 'extends', store, parent, 7)],
      }),
    );
    expect(result.diagramType).toBe('class');
    expect(result.source).toBe(
      'classDiagram\n  class n1["SessionStore"]\n  class n2["BaseStore"]\n  class n3["Storage"]\n  n1 --|> n2\n  n1 ..|> n3',
    );
    expect(result.evidence.nodes).toEqual([
      {id: store.id, diagramId: 'n1', label: store.name, kind: 'class', path: store.path, span: span(7)},
      {id: parent.id, diagramId: 'n2', label: parent.name, kind: 'class', path: parent.path, span: span(3)},
      {id: role.id, diagramId: 'n3', label: role.name, kind: 'interface', path: role.path, span: span(5)},
    ]);
    expect(result.evidence.edges).toEqual([
      {
        id: 'a',
        source: 'n1',
        target: 'n2',
        relation: 'extends',
        path: store.path,
        provenance: 'resolved',
        span: span(7),
      },
      {
        id: 'b',
        source: 'n1',
        target: 'n3',
        relation: 'implements',
        path: store.path,
        provenance: 'declared',
        span: span(7),
      },
    ]);
    expect(Schema.decodeSync(CodeGraphDiagramResultSchema)(result)).toEqual(result);
  });

  it('uses only supported architecture connections and preserves dependency direction', () => {
    const api = symbol('AuthApi', 'service');
    const db = symbol('SessionDatabase', 'database');
    const unrelated = symbol('readConfig', 'function');
    const result = requireDiagram(
      project({
        question: 'Show the AuthApi architecture.',
        nodes: [api, db, unrelated],
        edges: [
          relation('config', 'configures', api, db, 8, 'declared'),
          relation('helper', 'calls', api, unrelated, 10),
        ],
      }),
    );
    expect(result.diagramType).toBe('architecture');
    expect(result.source).toBe(
      'architecture-beta\n  service n1[AuthApi]\n  service n2[SessionDatabase]\n  n1:R --> L:n2',
    );
    expect(result.evidence.edges).toEqual([
      {
        id: 'config',
        source: 'n1',
        target: 'n2',
        relation: 'configures',
        path: api.path,
        provenance: 'declared',
        span: span(8),
      },
    ]);
    expect(result.limits).toContain('The diagram shows only part of the available connected evidence.');
  });

  it('orders a nested static call path from the subject and retains evidence on reduction', () => {
    const accept = symbol('acceptRequest', 'function');
    const authenticate = symbol('authenticate', 'function');
    const read = symbol('readSession', 'function');
    const input = {
      question: 'Show the call chain from acceptRequest.',
      nodes: [read, authenticate, accept],
      edges: [
        relation('a', 'calls', authenticate, read, 12, 'syntactic'),
        relation('z', 'calls', accept, authenticate, 7),
      ],
    };
    const result = requireDiagram(project(input));
    expect(result.source).toBe(
      'sequenceDiagram\n  participant n1 as acceptRequest\n  participant n2 as authenticate\n  participant n3 as readSession\n  n1->>n2: calls\n  n2->>n3: calls',
    );
    expect(result.inferred).toBe(true);
    expect(result.evidence.edges).toEqual([
      {
        id: 'z',
        source: 'n1',
        target: 'n2',
        relation: 'calls',
        path: accept.path,
        provenance: 'resolved',
        span: span(7),
      },
      {
        id: 'a',
        source: 'n2',
        target: 'n3',
        relation: 'calls',
        path: authenticate.path,
        provenance: 'syntactic',
        span: span(12),
      },
    ]);
    const reduced = requireDiagram(project({...input, budget: {nodes: 2, edges: 1}}));
    expect(reduced.source).toBe(
      'sequenceDiagram\n  participant n1 as acceptRequest\n  participant n2 as authenticate\n  n1->>n2: calls',
    );
    expect(reduced.evidence.edges).toEqual(result.evidence.edges.slice(0, 1));
    expect(reduced.limits).toContain('The diagram shows only part of the available connected evidence.');
    expect(project({...input, budget: {nodes: 1}}).status).toBe('unavailable');
  });

  it('offers a directional flowchart when static calls do not establish sibling order', () => {
    const accept = symbol('acceptRequest', 'function');
    const authenticate = symbol('authenticate', 'function');
    const read = symbol('readSession', 'function');
    const input = {
      question: 'Show the call order from acceptRequest.',
      nodes: [accept, authenticate, read],
      edges: [relation('a', 'calls', accept, read, 12), relation('b', 'calls', accept, authenticate, 7)],
    };
    expect(project(input)).toMatchObject({status: 'unavailable', suggestedType: 'flowchart'});
    const result = requireDiagram(project({...input, diagramType: 'flowchart'}));
    expect(result.source).toContain('n1 -->|calls| n2\n  n1 -->|calls| n3');
    expect(result.inferred).toBe(false);
  });

  it('prefers the supported authentication subject and clarifies separate supported subjects', () => {
    const authenticate = symbol('authenticate', 'function', {id: 'auth', path: 'src/auth.ts'});
    const distractor = symbol('authenticate', 'function', {id: 'distractor', path: 'docs/example.ts'});
    const read = symbol('readSession', 'function');
    const isolated = symbol('performExample', 'function', {path: 'docs/example.ts'});
    const input = {
      question: 'How does authentication work?',
      nodes: [distractor, read, authenticate, isolated],
      edges: [relation('auth-call', 'calls', authenticate, read, 4)],
    };
    const result = requireDiagram(project(input));
    expect(result.evidence.nodes).toMatchObject([{id: 'auth'}, {id: read.id}]);
    const competing = {
      ...input,
      edges: [...input.edges, relation('example-call', 'calls', distractor, isolated, 7)],
    };
    expect(project(competing)).toMatchObject({
      status: 'clarification',
      candidates: [
        {id: 'auth', path: 'src/auth.ts', span: span(1)},
        {id: 'distractor', path: 'docs/example.ts', span: span(1)},
      ],
    });
    const explicit = requireDiagram(project({...competing, question: 'Show src/auth.ts#authenticate.'}));
    expect(explicit.evidence.nodes).toMatchObject([{id: 'auth'}, {id: read.id}]);
    expect(project({...input, question: 'Show the BillingWriter diagram.'}).status).toBe('unavailable');
    expect(project({...input, nodes: [], edges: []}).status).toBe('unavailable');
  });

  it('uses a grouped flowchart for automatic architecture intent with module dependencies', () => {
    const login = symbol('Login', 'module', {packageName: 'identity'});
    const session = symbol('Session', 'package', {packageName: 'session'});
    const input = {
      question: 'Show the Login architecture.',
      nodes: [login, session],
      edges: [relation('dependency', 'depends_on', login, session, 5, 'declared')],
    };
    const result = requireDiagram(project(input));
    expect(result.diagramType).toBe('flowchart');
    expect(result.source).toBe(
      'flowchart TD\n  subgraph g1["identity"]\n  n1["Login"]\n  end\n  subgraph g2["session"]\n  n2["Session"]\n  end\n  n1 -->|depends_on| n2',
    );
    expect(result.evidence).toEqual({
      nodes: [
        {id: login.id, diagramId: 'n1', label: login.name, kind: login.kind, path: login.path, span: login.span},
        {
          id: session.id,
          diagramId: 'n2',
          label: session.name,
          kind: session.kind,
          path: session.path,
          span: session.span,
        },
      ],
      edges: [
        {
          id: 'dependency',
          source: 'n1',
          target: 'n2',
          relation: 'depends_on',
          provenance: 'declared',
          path: login.path,
          span: span(5),
        },
      ],
      groups: [
        {diagramId: 'g1', label: 'identity', members: ['n1']},
        {diagramId: 'g2', label: 'session', members: ['n2']},
      ],
    });
    expect(project({...input, diagramType: 'architecture'})).toMatchObject({
      status: 'unavailable',
      suggestedType: 'flowchart',
    });
  });

  it.each([
    ['How authentication works?', 'authentication'],
    ['Authentication: how does it work?', 'authentication'],
    ['Authentication works how?', 'Authentication'],
    ['How does AUTHENTICATION work?', 'authentication'],
  ])('prefers supported authentication evidence for "%s"', (question, alternateName) => {
    const actual = symbol('authenticate', 'function');
    const isolated = symbol(alternateName, 'function', {path: 'examples/authentication.ts'});
    const verifier = symbol('verify', 'function');
    const input = {
      question,
      nodes: [isolated, actual, verifier],
      edges: [relation('check', 'calls', actual, verifier, 4)],
    };
    const result = requireDiagram(project(input));
    expect(result.evidence.nodes).toMatchObject([{id: actual.id}, {id: verifier.id}]);
    const exact = requireDiagram(project({...input, question: `Show examples/authentication.ts#${alternateName}.`}));
    expect(exact.evidence.nodes).toMatchObject([{id: isolated.id}]);
    expect(exact.evidence.edges).toEqual([]);
  });

  it('asks which equally supported same-name caller to use even when both call one helper', () => {
    const first = symbol('load', 'function', {id: 'loader-a', path: 'a/load.ts'});
    const second = symbol('load', 'function', {id: 'loader-b', path: 'b/load.ts'});
    const helper = symbol('fetchData', 'function');
    const input = {
      question: 'Show ' + Str.repeat(30)('load LOAD '),
      nodes: [second, helper, first],
      edges: [relation('b', 'calls', second, helper, 11), relation('a', 'calls', first, helper, 3)],
    };
    expect(project(input)).toMatchObject({
      status: 'clarification',
      candidates: [
        {id: first.id, path: first.path},
        {id: second.id, path: second.path},
      ],
    });
  });

  it('chooses an evidenced outgoing call path over a higher-ranked sink', () => {
    const caller = symbol('load', 'function', {id: 'caller', path: 'api/load.ts'});
    const sink = {...symbol('load', 'function', {id: 'sink', path: 'data/load.ts'}), score: 20};
    const result = requireDiagram(
      project({
        question: 'Show the load sequence.',
        nodes: [sink, caller],
        edges: [relation('nested', 'calls', caller, sink, 4)],
      }),
    );
    expect(result.source).toBe('sequenceDiagram\n  participant n1 as load\n  participant n2 as load\n  n1->>n2: calls');
    expect(result.evidence.nodes).toMatchObject([{id: caller.id}, {id: sink.id}]);
    expect(result.evidence.edges).toEqual([
      {
        id: 'nested',
        source: 'n1',
        target: 'n2',
        relation: 'calls',
        provenance: 'resolved',
        path: caller.path,
        span: span(4),
      },
    ]);
  });

  it.each([
    {question: 'Show the call order from authenticate', branch: true},
    {question: 'Show the call order from the authenticate function.', branch: true},
    {question: 'Show call path for Authenticate', branch: false},
  ])('keeps the explicit subject in "$question" when a similar name has an ordered path', ({question, branch}) => {
    const exact = symbol('authenticate', 'function');
    const alternate = symbol('authentication', 'function');
    const verify = symbol('verify', 'function');
    const audit = symbol('audit', 'function');
    const edges = [
      relation('alternate-path', 'calls', alternate, verify, 11),
      ...(branch ? [relation('verify', 'calls', exact, verify, 3), relation('audit', 'calls', exact, audit, 4)] : []),
    ];
    const input = {question, nodes: [alternate, verify, audit, exact], edges};
    expect(project(input)).toMatchObject({status: 'unavailable', suggestedType: 'flowchart'});
    const fallback = requireDiagram(project({...input, diagramType: 'flowchart'}));
    expect(fallback.evidence.nodes[0]).toMatchObject({id: exact.id, path: exact.path});
  });

  it('uses exact path case for explicit selectors even if the other case has stronger support', () => {
    const exact = symbol('login', 'function', {id: 'upper', path: 'src/Auth.ts'});
    const alternate = symbol('login', 'function', {id: 'lower', path: 'src/auth.ts'});
    const verify = symbol('verify', 'function');
    const input = {
      question: 'Show src/Auth.ts#login.',
      nodes: [alternate, verify, exact],
      edges: [relation('other', 'calls', alternate, verify, 6)],
    };
    expect(requireDiagram(project(input)).evidence.nodes).toMatchObject([{id: exact.id, path: exact.path}]);
    expect(requireDiagram(project({...input, question: 'Show src/auth.ts#login.'})).evidence.nodes).toMatchObject([
      {id: alternate.id, path: alternate.path},
      {id: verify.id, path: verify.path},
    ]);
  });

  it('preserves a capitalized identifier in a natural question with stronger alternate evidence', () => {
    const exact = symbol('Authenticate', 'function');
    const alternate = symbol('Authentication', 'function');
    const verify = symbol('verify', 'function');
    const result = requireDiagram(
      project({
        question: 'How does Authenticate work?',
        nodes: [alternate, verify, exact],
        edges: [relation('other', 'calls', alternate, verify, 6)],
      }),
    );
    expect(result.evidence.nodes).toMatchObject([{id: exact.id, label: exact.name, path: exact.path}]);
    expect(result.evidence.edges).toEqual([]);
  });

  it('selects the exact spelling in a path selector when symbols differ only in case', () => {
    const upper = symbol('Login', 'function', {id: 'upper', path: 'src/auth.ts'});
    const lower = symbol('login', 'function', {id: 'lower', path: 'src/auth.ts'});
    const verify = symbol('verify', 'function');
    const input = {
      question: 'Show src/auth.ts#Login.',
      nodes: [lower, verify, upper],
      edges: [relation('other', 'calls', lower, verify, 6)],
    };
    const exact = requireDiagram(project(input));
    expect(exact.evidence.nodes).toMatchObject([{id: upper.id, label: upper.name, path: upper.path}]);
    expect(exact.evidence.edges).toEqual([]);
    const other = requireDiagram(project({...input, question: 'Show src/auth.ts#login.'}));
    expect(other.evidence.nodes).toMatchObject([{id: lower.id}, {id: verify.id}]);
    expect(project({...input, question: 'Show src/auth.ts#LOGIN.'}).status).toBe('unavailable');
  });

  it('uses code selectors only to match evidence and ignores their terms for diagram intent', () => {
    const render = symbol('render', 'function', {path: 'src/class.ts'});
    const emit = symbol('writeHtml', 'function');
    const result = requireDiagram(
      project({
        question: 'Show src/class.ts#render.',
        nodes: [render, emit],
        edges: [relation('write', 'calls', render, emit, 6)],
      }),
    );
    expect(result.diagramType).toBe('flowchart');
    expect(result.evidence.nodes).toMatchObject([{id: render.id}, {id: emit.id}]);
  });

  it('examines only the ranked windows supplied by retrieval', () => {
    const first = symbol('entry', 'function');
    const target = symbol('verify', 'function');
    const late = symbol('LateSubject', 'function');
    const fillerNodes = Array.from({length: CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.nodes - 2}, (_, index) =>
      symbol(`Noise${index}`, 'function'),
    );
    const fillerEdges = Array.from({length: CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.edges}, (_, index) =>
      relation(`filler-${index}`, 'references', first, target, index + 1, 'model'),
    );
    const input = {
      question: 'Show entry.',
      nodes: [first, target, ...fillerNodes, late],
      edges: [...fillerEdges, relation('outside-window', 'calls', first, target, 7)],
    };
    const result = requireDiagram(project(input));
    expect(result.evidence.nodes).toMatchObject([{id: first.id}]);
    expect(result.evidence.edges).toEqual([]);
    expect(result.limits).toContain('The projection used a bounded evidence window.');
    expect(project({...input, question: 'Show LateSubject.'}).status).toBe('unavailable');
  });

  it('bounds hostile labels and drops incomplete or unsupported relationships as complete facts', () => {
    const bad = '认识😁' + '"\nclick n1 href "https://example.test"\n%%{init:{}}%% <script>' + Str.repeat(600)('x');
    const auth = symbol('auth', 'module', {label: bad, packageName: 'auth'});
    const cache = symbol('cache', 'module', {packageName: 'cache'});
    const hidden = symbol('hidden', 'module', {path: Str.repeat(520)('x')});
    const extras = Array.from({length: CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS.nodes}, (_, index) =>
      symbol(`Extra${index}`, 'module'),
    );
    const result = requireDiagram(
      project({
        question: 'Show dependencies for auth.',
        nodes: [auth, cache, hidden, ...extras],
        edges: [
          relation('good', 'imports', auth, cache, 4),
          relation('incomplete', 'imports', auth, hidden, 5),
          relation('inferred', 'depends_on', cache, auth, 6, 'model'),
        ],
        freshness: 'stale',
        limits: ['The graph query reached its node limit.'],
      }),
    );
    expect(result.scope).toEqual(scope);
    expect(result.source).toBe(
      'flowchart TD\n  subgraph g1["auth"]\n  n1["认识 click n1 href https example.test init script xxxxxxxx"]\n  end\n  subgraph g2["cache"]\n  n2["cache"]\n  end\n  n1 -->|imports| n2',
    );
    expect(result.source).not.toMatch(/https:|<|%%|\bhidden\b|\bdepends_on\b/u);
    expect(result.evidence.nodes).toEqual([
      {id: auth.id, diagramId: 'n1', label: Str.slice(0, 129)(bad), kind: auth.kind, path: auth.path, span: auth.span},
      {id: cache.id, diagramId: 'n2', label: cache.name, kind: cache.kind, path: cache.path, span: cache.span},
    ]);
    expect(result.evidence.groups).toEqual([
      {diagramId: 'g1', label: 'auth', members: ['n1']},
      {diagramId: 'g2', label: 'cache', members: ['n2']},
    ]);
    expect(result.evidence.edges).toEqual([
      {
        id: 'good',
        source: 'n1',
        target: 'n2',
        relation: 'imports',
        path: auth.path,
        provenance: 'resolved',
        span: span(4),
      },
    ]);
    expect(result.limits).toEqual([
      'The graph query reached its node limit.',
      'Snapshot freshness is stale.',
      'The projection used a bounded evidence window.',
      'The projection omitted evidence without a supported relationship or a complete source reference.',
    ]);
  });
});
