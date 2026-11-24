import {it as effectIt} from '@effect/vitest';
import {Array as Arr, Effect, FileSystem, Layer, Option, Path, Schema, String as Str} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_DIAGRAM_EVIDENCE_LIMITS,
  prepareCodeGraphDiagramQuery,
  projectCodeGraphDiagram,
  type CodeGraphDiagramInput,
} from '../../src/query/diagram.js';
import {CodeGraphDiagramResultSchema} from '../../src/query/diagram_contract.js';
import {readCodeGraphDiagram, readCodeGraphDiagramForStatus} from '../../src/query/diagram_evidence.js';
import {extractRepositoryFacts, resolveExtractedRepositoryFacts} from '../../src/extractor.js';
import {extractBazelFacts} from '../../src/languages/bazel/extractor.js';
import {codeGraphLayout} from '../../src/layout.js';
import {CodeGraphStore} from '../../src/store.js';
import {
  CodeGraphStoreError,
  type CodeGraphEdge,
  type CodeGraphInventoryFile,
  type CodeGraphQueryNode,
  type CodeGraphRelation,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '../../src/types.js';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

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

const diagramStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(citationPlatformLayer));
const diagramSourceFile = (path: string, language: string, content: string): CodeGraphInventoryFile => ({
  blobId: Str.repeat(40)('e'),
  contentHash: 'content',
  language,
  mode: '100644',
  path,
  size: content.length,
  source: 'commit',
  content,
});

const storedDiagramFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-diagram-'});
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: Str.repeat(64)('d'),
    displayName: 'Fixture',
    gitCommonDirectory: path.join(home, '.git'),
    headCommit: Str.repeat(40)('b'),
    objectFormat: 'sha1',
    repoRoot: home,
    repositoryId: Str.repeat(64)('a'),
    worktreeId: Str.repeat(64)('c'),
  };
  const {databasePath} = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  const save = (key: string, nodes: readonly CodeGraphSymbol[], edges: readonly CodeGraphEdge[]) =>
    Effect.gen(function* () {
      const files: CodeGraphInventoryFile[] = Arr.map([...new Set(Arr.map(nodes, node => node.path))], path => ({
        blobId: Str.repeat(40)('e'),
        contentHash: 'content',
        language: 'typescript',
        mode: '100644',
        path,
        size: 0,
        source: 'commit',
      }));
      const snapshot: CodeGraphSnapshot = {
        id: 'cgsn_' + Str.repeat(40)(key),
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
        commit: identity.headCommit,
        extractorSet: 'fixture',
        dirty: false,
        fileCount: files.length,
        symbolCount: nodes.length,
        edgeCount: edges.length,
        state: 'ready',
      };
      yield* store.activate(databasePath, identity, snapshot, files, nodes, edges);
      return snapshot;
    });
  const snapshotScope = (snapshot: CodeGraphSnapshot) => ({
    repositoryId: snapshot.repositoryId,
    repositoryName: identity.displayName,
    snapshotId: snapshot.id,
    commit: snapshot.commit,
  });
  return {databasePath, identity, save, snapshotScope, store};
});

effectIt.layer(diagramStoreLayer)(it => {
  it.effect('reads the full effective snapshot across pages and local ownership bridges', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const entry = {
        ...symbol('managerGraphQuery', 'function', {id: 'cgs_' + Str.repeat(32)('1'), path: 'src/view.ts'}),
        span: {...span(1), endLine: 500},
        signature: '(viewId: string) => Graph',
      };
      const selection = {
        ...symbol('selection', 'variable', {path: entry.path, line: 5}),
        span: {...span(5), endLine: 400},
      };
      const callback = symbol('collect', 'callback', {path: entry.path, line: 6});
      const unrelated = symbol('managerGraphQueryExample', 'function');
      const callers = {...symbol('dispatch', 'function'), span: {...span(1), endLine: 15}};
      const request = symbol('request', 'variable', {path: callers.path, line: 8});
      const job = symbol('job', 'function');
      const view = symbol('resolveView', 'function');
      const old = symbol('obsolete', 'function');
      const active = symbol('newResult', 'function');
      const outside = symbol('remoteStore', 'outside-scope');
      const unused = symbol('unused', 'variable', {path: entry.path, line: 402});
      const pages = Array.from({length: 140}, (_, index) => symbol(`result${index}`, 'function'));
      const wide = Arr.map(pages, (node, index) =>
        relation(`step-${Str.padStart(3, '0')(String(index))}`, 'calls', selection, node, index + 10),
      );
      const removedEdges = Array.from({length: 128}, (_, index) =>
        relation(`blocked-delete-${index}`, 'calls', selection, old, 8),
      );
      const heuristicEdges = Array.from({length: 128}, (_, index) =>
        relation(`blocked-heuristic-${index}`, 'calls', selection, old, 8, 'heuristic'),
      );
      const shadowed = relation('blocked-shadow', 'calls', selection, old, 8);
      const importEdge = {
        ...relation('external', 'calls', callback, outside, 6, 'syntactic'),
        targetId: undefined,
        targetName: 'node:fs.readFile',
      };
      const base = yield* f.save(
        '1',
        [entry, selection, callback, unrelated, callers, request, job, view, old, outside, unused, ...pages],
        [
          ...wide,
          ...removedEdges,
          ...heuristicEdges,
          shadowed,
          relation('bridge', 'contains', entry, selection, 5, 'syntactic'),
          relation('callback', 'contains', selection, callback, 6, 'syntactic'),
          relation('unused-bridge', 'contains', entry, unused, 402, 'syntactic'),
          relation('resolve', 'calls', entry, view, 3),
          relation('cycle', 'calls', pages[139], entry, 1),
          relation('inbound-only', 'calls', request, entry, 8),
          relation('inbound-owner', 'contains', callers, request, 8, 'syntactic'),
          relation('inbound-job', 'calls', job, callers, 4),
          relation('other-branch', 'calls', callers, unrelated, 9),
          relation('removed', 'calls', entry, old, 4),
          relation('boundary', 'calls', callback, outside, 6),
          importEdge,
        ],
      );
      const overlay = yield* f.save(
        '2',
        [entry, active, unrelated],
        [relation('resolve', 'calls', entry, active, 4), relation(shadowed.id, 'calls', unrelated, active, 3)],
      );
      yield* f.store.withSession(
        f.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE snapshots SET base_snapshot_id = ${base.id}, dirty = 1 WHERE id = ${overlay.id}`;
          yield* sql`INSERT INTO snapshot_edge_deletions VALUES (${overlay.id}, 'removed')`;
          yield* sql`INSERT INTO snapshot_edge_deletions
            SELECT ${overlay.id}, value FROM json_each(${JSON.stringify(Arr.map(removedEdges, edge => edge.id))})`;
        }),
      );
      const first = yield* f.store.diagramAdjacentPage(
        f.databasePath,
        overlay.id,
        selection.id,
        'outgoing',
        ['calls'],
        '',
        128,
      );
      expect(first).toEqual({edges: [], nextCursor: expect.any(String)});

      const run = (question: string, store = f.store) =>
        readCodeGraphDiagramForStatus(
          store,
          {
            databasePath: f.databasePath,
            identity: f.identity,
            freshness: 'stale',
            languagePacks: [],
            readySnapshot: {...overlay, dirty: true, baseSnapshotId: base.id},
            stale: true,
          },
          {question},
        );
      const primaryKeyStore = CodeGraphStore.of({
        ...f.store,
        diagramSubjectPage: () => Effect.die('A stable symbol ID must use the primary-key lookup.'),
      });
      const result = requireDiagram(yield* run(`How does ${entry.id} work?`, primaryKeyStore));
      const expected = [
        ...Arr.map(wide, edge => edge.id),
        'bridge',
        'callback',
        'resolve',
        'cycle',
        'boundary',
        'external',
      ].sort();
      expect(Arr.map(result.evidence.edges, edge => edge.id)).toEqual(expected);
      expect(Option.getOrUndefined(Arr.findFirst(result.evidence.edges, edge => edge.id === 'resolve'))).toMatchObject({
        path: entry.path,
        span: span(4),
      });
      expect(result.evidence.nodes).toContainEqual(expect.objectContaining({id: active.id}));
      expect(result.evidence.nodes).not.toContainEqual(expect.objectContaining({id: view.id}));
      expect(result.evidence.nodes).toContainEqual(
        expect.objectContaining({label: importEdge.targetName, evidenceKind: 'boundary'}),
      );
      expect(result.coverage).toMatchObject({
        completeness: 'complete',
        subject: {id: entry.id, signature: entry.signature, path: entry.path, span: entry.span},
        boundaries: [
          {kind: 'outside-scope', label: outside.name, edgeId: 'boundary'},
          {kind: 'external', label: importEdge.targetName, edgeId: 'external'},
        ],
        gaps: [],
      });
      expect(result.scope).toEqual(f.snapshotScope(overlay));
      expect(result.freshness).toBe('stale');
      const ids = new Map(Arr.map(result.evidence.nodes, node => [node.label, node.diagramId] as const));
      const connector = (from: string, relationship: CodeGraphRelation, to: string) =>
        `  ${ids.get(from)} -->|${relationship}| ${ids.get(to)}`;
      const expectedConnectors = [
        ...Arr.map(pages, node => connector(selection.name, 'calls', node.name)),
        connector(entry.name, 'contains', selection.name),
        connector(selection.name, 'contains', callback.name),
        connector(entry.name, 'calls', active.name),
        connector(pages[139].name, 'calls', entry.name),
        connector(callback.name, 'calls', outside.name),
        connector(callback.name, 'calls', importEdge.targetName),
      ];
      const renderedConnectors = Arr.filter(Str.split('\n')(result.source), line => /^ {2}n\d+ -->\|/u.test(line));
      expect(renderedConnectors.sort()).toEqual(expectedConnectors.sort());
      expect(yield* Schema.decodeEffect(CodeGraphDiagramResultSchema)(result)).toEqual(result);

      const incoming = requireDiagram(yield* run('Who calls src/view.ts#managerGraphQuery?'));
      const incomingEdges = Arr.map(incoming.evidence.edges, edge => edge.id);
      expect(incomingEdges).toEqual(expect.arrayContaining(['inbound-only', 'inbound-owner', 'inbound-job']));
      expect(incomingEdges).not.toContain('other-branch');
    }).pipe(TestClock.withLive),
  );

  it.effect('retains a partial diagram for unresolved evidence and reports an interrupted page separately', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const entry = symbol('authenticate', 'function');
      const targets = Array.from({length: 132}, (_, index) => symbol(`worker${index}`, 'function'));
      const resolved = Arr.map(targets, (target, index) =>
        relation(`call-${Str.padStart(3, '0')(String(index))}`, 'calls', entry, target, index + 1),
      );
      const unresolved = {
        ...relation('dynamic', 'calls', entry, targets[0], 137, 'syntactic'),
        targetId: undefined,
        targetName: 'callback',
      };
      const snapshot = yield* f.save('3', [entry, ...targets], [...resolved, unresolved]);
      const input = {
        question: 'How does authenticate work?',
        freshness: 'current' as const,
        scope: f.snapshotScope(snapshot),
      };
      const incomplete = yield* readCodeGraphDiagram(f.store, f.databasePath, input);
      expect(incomplete).toMatchObject({
        status: 'incomplete',
        coverage: {
          completeness: 'incomplete',
          gaps: [{kind: 'unresolved-target', edgeId: 'dynamic', path: entry.path, span: span(137)}],
        },
      });
      if (incomplete.status !== 'incomplete') throw new Error('Expected an incomplete diagram');
      expect(incomplete.diagram?.evidence.edges).toHaveLength(132);

      const failingStore = CodeGraphStore.of({
        ...f.store,
        diagramAdjacentPage: (...args) =>
          args[5] ? Effect.fail(CodeGraphStoreError.of('fixture page failure')) : f.store.diagramAdjacentPage(...args),
      });
      const interrupted = yield* readCodeGraphDiagram(failingStore, f.databasePath, input);
      expect(interrupted).toMatchObject({
        status: 'incomplete',
        coverage: {completeness: 'incomplete', gaps: [{kind: 'interrupted'}]},
      });
      if (interrupted.status !== 'incomplete') throw new Error('Expected an interrupted diagram');
      expect(interrupted.diagram?.evidence.edges).toHaveLength(128);
    }).pipe(TestClock.withLive),
  );

  it.effect('reads every exact name match across shadowed and deleted raw subject pages', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const matches = Array.from({length: 270}, (_, index) =>
        symbol('Twin', 'function', {id: `subject-${Str.padStart(3, '0')(String(index))}`, path: `src/${index}.ts`}),
      );
      const base = yield* f.save('6', matches, []);
      const renamed = symbol('Renamed', 'function', {id: matches[0].id, path: matches[0].path});
      const overlay = yield* f.save('7', [renamed], []);
      const deleted = Arr.map(matches.slice(1, 128), item => item.id);
      yield* f.store.withSession(
        f.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE snapshots SET base_snapshot_id = ${base.id}, dirty = 1 WHERE id = ${overlay.id}`;
          yield* sql`INSERT INTO snapshot_symbol_deletions
          SELECT ${overlay.id}, value FROM json_each(${JSON.stringify(deleted)})`;
        }),
      );
      const page = (after: string) =>
        f.store.diagramSubjectPage(f.databasePath, overlay.id, ['Twin'], after, 128, 'exact');
      const first = yield* page('');
      expect(first).toEqual({symbols: [], nextCursor: matches[127].id});
      const ids: string[] = [];
      let cursor = first.nextCursor;
      while (cursor !== undefined) {
        const result = yield* page(cursor);
        ids.push(...Arr.map(result.symbols, match => match.id));
        cursor = result.nextCursor;
      }
      expect(ids).toEqual(Arr.map(matches.slice(128), match => match.id));
    }).pipe(TestClock.withLive),
  );

  it.effect('clarifies independent subjects and selects a type that preserves all evidence', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const lead = symbol('authenticationRoute', 'function', {id: 'public', path: 'src/public.ts'});
      const other = symbol('authenticationRoute', 'function', {id: 'private', path: 'src/private.ts'});
      const check = symbol('checkCredentials', 'function');
      const storage = symbol('readSession', 'function');
      const alternative = symbol('checkPermissions', 'function');
      const api = symbol('AuthApi', 'service', {packageName: 'auth'});
      const db = symbol('AuthDatabase', 'database', {packageName: 'storage'});
      const child = symbol('SessionStore', 'class');
      const parent = symbol('BaseStore', 'class');
      const role = symbol('Store', 'interface');
      const branch = symbol('dispatchSession', 'function');
      const snapshot = yield* f.save(
        '4',
        [lead, other, check, storage, alternative, api, db, child, parent, role, branch],
        [
          relation('public-check', 'calls', lead, check, 3),
          relation('private-check', 'calls', other, alternative, 3),
          relation('read', 'calls', check, storage, 3),
          relation('config', 'configures', api, db, 3, 'declared'),
          relation('inherit', 'extends', child, parent, 3),
          relation('implement', 'implements', child, role, 3),
          relation('branch-one', 'calls', branch, lead, 4),
          relation('branch-two', 'calls', branch, other, 5),
        ],
      );
      const run = (question: string, diagramType: 'auto' | 'sequence' = 'auto') =>
        readCodeGraphDiagram(f.store, f.databasePath, {
          question,
          diagramType,
          scope: f.snapshotScope(snapshot),
          freshness: 'current',
        });
      expect(yield* run('How does authentication work?')).toMatchObject({
        status: 'clarification',
        candidates: [
          {id: 'private', path: other.path},
          {id: 'public', path: lead.path},
        ],
      });
      expect(yield* run('How does unknownSubject work?')).toMatchObject({
        status: 'unavailable',
        coverage: {completeness: 'undetermined'},
      });
      const sequence = requireDiagram(yield* run('Show the call chain from src/public.ts#authenticationRoute.'));
      expect(sequence).toMatchObject({diagramType: 'sequence', inferred: true});
      expect(Arr.map(sequence.evidence.edges, edge => edge.id)).toEqual(['public-check', 'read']);
      const architecture = requireDiagram(yield* run('Show the AuthApi architecture.'));
      expect(architecture).toMatchObject({diagramType: 'architecture'});
      expect(architecture.source).toContain('group g2[storage]');
      expect(architecture.evidence.edges[0]).toMatchObject({id: 'config', relation: 'configures'});
      const classes = requireDiagram(yield* run('Which interfaces does SessionStore implement or inherit?'));
      expect(classes).toMatchObject({diagramType: 'class'});
      expect(Arr.map(classes.evidence.edges, edge => edge.id)).toEqual(['implement', 'inherit']);
      expect(yield* run('Show the call order from dispatchSession.', 'sequence')).toMatchObject({
        status: 'unavailable',
        suggestedType: 'flowchart',
        coverage: {completeness: 'complete'},
      });
      const unordered = requireDiagram(yield* run('Show the call order from dispatchSession.'));
      expect(unordered.diagramType).toBe('flowchart');
      expect(Arr.map(unordered.evidence.edges, edge => edge.id)).toEqual([
        'branch-one',
        'branch-two',
        'private-check',
        'public-check',
        'read',
      ]);
    }).pipe(TestClock.withLive),
  );

  it.effect('uses real declarations for exact Unicode, class members, and Bazel configuration', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const types = diagramSourceFile(
        'src/types.ts',
        'typescript',
        Arr.join(
          [
            'export interface Store { read(): void; "-privateName"(): void; }',
            'class BaseStore {}',
            'export class SessionStore extends BaseStore implements Store { read() {} "-privateName"() {} }',
            'export class Override extends BaseStore {}',
            'export class OverrideChild extends Override {}',
            'export function helper() { return derive(); }',
            'function derive() { return extend(); }',
            'function extend() { return override(); }',
            'function override() { return leaf(); }',
            'function inherit() { return leaf(); }',
            'function implement() { return leaf(); }',
            'function leaf() { return 1; }',
          ],
          '\n',
        ),
      );
      const combining = 'E\u0301Rate';
      const unicode = diagramSourceFile(
        'src/ÉRate.ts',
        'typescript',
        Arr.join(
          [
            'export function ÉRate() { return value(); }',
            `export function ${combining}() { return value(); }`,
            'function value() { return 1; }',
          ],
          '\n',
        ),
      );
      const payment = diagramSourceFile(
        'src/Payment API.ts',
        'typescript',
        'export function charge() { return authorize(); }\nfunction authorize() { return 1; }',
      );
      const rc = diagramSourceFile(
        '.bazelrc',
        'bazelrc',
        'build --config=common\ncommon --color=no\ntest --color=yes\n',
      );
      const typed = extractRepositoryFacts([types, unicode, payment]);
      const config = resolveExtractedRepositoryFacts(
        [extractBazelFacts(rc, {packageName: Option.none(), project: Option.none()})],
        [rc],
      );
      const files = [...typed, ...config];
      const snapshot = yield* f.save(
        '5',
        Arr.flatMap(files, file => file.symbols),
        Arr.flatMap(files, file => file.edges),
      );
      const run = (question: string, diagramType?: 'class') =>
        readCodeGraphDiagram(f.store, f.databasePath, {
          question,
          ...(diagramType === undefined ? {} : {diagramType}),
          scope: f.snapshotScope(snapshot),
          freshness: 'current',
        });

      const exact = requireDiagram(yield* run('How does src/ÉRate.ts#ÉRate work?'));
      expect(exact.coverage?.subject).toMatchObject({name: 'ÉRate', path: 'src/ÉRate.ts'});
      expect(exact.evidence.edges).toEqual([expect.objectContaining({relation: 'calls'})]);
      const decomposed = requireDiagram(yield* run(`How does src/ÉRate.ts#${combining} work?`));
      expect(decomposed.coverage?.subject).toMatchObject({name: combining, path: 'src/ÉRate.ts'});
      for (const question of [
        'How does "src/Payment API.ts#charge" work?',
        "What's 'src/Payment API.ts#charge' flow?",
      ]) {
        const quoted = requireDiagram(yield* run(question));
        expect(quoted.coverage?.subject).toMatchObject({name: 'charge', path: 'src/Payment API.ts'});
      }
      for (const [selector, name, calls] of [
        ['src/types.ts#helper', 'helper', 4],
        ['derive', 'derive', 3],
        ['extend', 'extend', 2],
        ['override', 'override', 1],
        ['inherit', 'inherit', 1],
        ['implement', 'implement', 1],
      ] as const) {
        const behavior = requireDiagram(yield* run(`How does ${selector} work?`));
        expect(behavior.coverage?.subject).toMatchObject({name, path: 'src/types.ts'});
        expect(behavior.evidence.edges).toHaveLength(calls);
        expect(Arr.every(behavior.evidence.edges, edge => edge.relation === 'calls')).toBe(true);
      }

      for (const override of [
        requireDiagram(yield* run('Show a class diagram of Override')),
        requireDiagram(yield* run('Override', 'class')),
      ]) {
        expect(override.coverage?.subject).toMatchObject({name: 'Override', path: 'src/types.ts'});
        expect(override.diagramType).toBe('class');
        expect(override.evidence.edges).toEqual([expect.objectContaining({relation: 'extends'})]);
      }
      const incomingOverride = requireDiagram(yield* run('What extends Override?'));
      const overrideTarget = Option.getOrUndefined(
        Arr.findFirst(incomingOverride.evidence.nodes, node => node.name === 'Override'),
      );
      const overrideChild = Option.getOrUndefined(
        Arr.findFirst(incomingOverride.evidence.nodes, node => node.name === 'OverrideChild'),
      );
      expect(incomingOverride.evidence.edges).toContainEqual(
        expect.objectContaining({
          relation: 'extends',
          source: overrideChild?.diagramId,
          target: overrideTarget?.diagramId,
        }),
      );

      for (const question of [
        'Which classes implement Store?',
        'What implements Store?',
        'Which classes are implementing Store?',
      ]) {
        const classes = requireDiagram(yield* run(question));
        expect(classes.diagramType).toBe('class');
        expect(classes.source).toContain(' : read()');
        expect(classes.source).toContain(' : −privateName()');
        expect(classes.source).not.toContain(' : -');
        expect(classes.evidence.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({relation: 'implements', path: 'src/types.ts'}),
            expect.objectContaining({relation: 'contains', path: 'src/types.ts'}),
          ]),
        );
        const implementing = Option.getOrUndefined(
          Arr.findFirst(classes.evidence.edges, edge => edge.relation === 'implements'),
        );
        expect(classes.evidence.nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({name: 'SessionStore', diagramId: implementing?.source}),
            expect.objectContaining({name: 'Store', diagramId: implementing?.target}),
            expect.objectContaining({name: '-privateName'}),
          ]),
        );
      }

      const architecture = requireDiagram(yield* run('Show the architecture of .bazelrc#build.'));
      expect(architecture.diagramType).toBe('architecture');
      expect(architecture.evidence.edges).toEqual([
        expect.objectContaining({relation: 'configures', path: '.bazelrc'}),
      ]);
      expect(Arr.map(architecture.evidence.nodes, node => node.kind)).toEqual(['config', 'config']);
      const fileArchitecture = requireDiagram(yield* run('Show architecture of .bazelrc'));
      expect(fileArchitecture.diagramType).toBe('architecture');
      expect(fileArchitecture.evidence.nodes).not.toContainEqual(expect.objectContaining({name: 'test'}));
      expect(Arr.map(fileArchitecture.evidence.edges, edge => edge.relation).sort()).toEqual([
        'configures',
        'contains',
        'contains',
      ]);
      expect(fileArchitecture.evidence.edges).toContainEqual(
        expect.objectContaining({
          id: architecture.evidence.edges[0].id,
          path: '.bazelrc',
          span: architecture.evidence.edges[0].span,
        }),
      );
    }).pipe(TestClock.withLive),
  );
});
