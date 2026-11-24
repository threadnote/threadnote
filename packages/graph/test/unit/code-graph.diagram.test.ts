import {it as effectIt} from '@effect/vitest';
import {Array as Arr, Effect, FileSystem, Layer, Option, Path, Schema, String as Str} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {CodeGraphDiagramResultSchema, type CodeGraphDiagramResult} from '../../src/query/diagram_contract.js';
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

function requireDiagram(result: CodeGraphDiagramResult) {
  if (result.status !== 'diagram') throw new Error(JSON.stringify(result));
  return result;
}

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
          relation('private-check', 'calls', other, check, 3),
          relation('read', 'calls', check, storage, 3),
          relation('config', 'configures', api, db, 3, 'declared'),
          relation('unrelated', 'calls', api, alternative, 8),
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
      expect(architecture.source).toContain('  n1:R --> L:n2');
      expect(architecture.evidence.edges).toEqual([
        {
          id: 'config',
          source: 'n1',
          target: 'n2',
          relation: 'configures',
          provenance: 'declared',
          path: api.path,
          span: span(3),
        },
      ]);
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

  it.effect('distinguishes exact selector case and finds the caller when names match', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const exact = symbol('Login', 'function', {id: 'exact', path: 'src/Auth.ts'});
      const wrongPath = symbol('Login', 'function', {id: 'wrong-path', path: 'src/auth.ts'});
      const wrongName = symbol('login', 'function', {id: 'wrong-name', path: exact.path});
      const named = symbol('Authenticate', 'function');
      const similar = symbol('Authentication', 'function');
      const caller = symbol('load', 'function', {id: 'caller', path: 'src/caller.ts'});
      const sink = symbol('load', 'function', {id: 'sink', path: 'src/sink.ts'});
      const snapshot = yield* f.save(
        '8',
        [exact, wrongPath, wrongName, named, similar, caller, sink],
        [
          relation('wrong-path-call', 'calls', wrongPath, sink, 3),
          relation('wrong-name-call', 'calls', wrongName, sink, 4),
          relation('similar-call', 'calls', similar, sink, 5),
          relation('nested-call', 'calls', caller, sink, 7),
        ],
      );
      const run = (question: string) =>
        readCodeGraphDiagram(f.store, f.databasePath, {
          question,
          scope: f.snapshotScope(snapshot),
          freshness: 'current',
        });

      for (const [question, subject] of [
        ['Show src/Auth.ts#Login.', exact],
        ['How does Authenticate work?', named],
      ] as const) {
        expect(yield* run(question)).toMatchObject({
          status: 'incomplete',
          coverage: {subject: {id: subject.id, path: subject.path}, gaps: [{kind: 'missing-evidence'}]},
        });
      }
      expect(yield* run('Show src/Auth.ts#LOGIN.')).toMatchObject({status: 'unavailable'});
      for (const [question, id] of [
        ['Show src/auth.ts#Login.', 'wrong-path-call'],
        ['Show src/Auth.ts#login.', 'wrong-name-call'],
      ] as const) {
        const selected = requireDiagram(yield* run(question));
        expect(selected.evidence.edges).toEqual([expect.objectContaining({id})]);
      }

      const sequence = requireDiagram(yield* run('Show the load sequence.'));
      expect(sequence.source).toBe(
        'sequenceDiagram\n  participant n1 as load\n  participant n2 as load\n  n1->>n2: calls',
      );
      expect(sequence.evidence.nodes).toMatchObject([{id: caller.id}, {id: sink.id}]);
      expect(sequence.evidence.edges).toEqual([
        {
          id: 'nested-call',
          source: 'n1',
          target: 'n2',
          relation: 'calls',
          provenance: 'resolved',
          path: caller.path,
          span: span(7),
        },
      ]);
    }).pipe(TestClock.withLive),
  );

  it.effect('keeps exact hostile label evidence and emits inert diagram labels', () =>
    Effect.gen(function* () {
      const f = yield* storedDiagramFixture;
      const tail = Str.repeat(600)('x');
      const label = '认识😁"\nclick n1 href "https://example.test"\n%%{init:{}}%% <script>' + tail;
      const auth = symbol('auth', 'module', {label, packageName: 'auth'});
      const cache = symbol('cache', 'package', {packageName: 'cache'});
      const snapshot = yield* f.save(
        '9',
        [auth, cache],
        [relation('imports', 'imports', auth, cache, 4), relation('inferred', 'depends_on', cache, auth, 6, 'model')],
      );
      const result = requireDiagram(
        yield* readCodeGraphDiagram(f.store, f.databasePath, {
          question: 'Show dependencies for auth.',
          diagramType: 'flowchart',
          scope: f.snapshotScope(snapshot),
          freshness: 'stale',
        }),
      );
      expect(result.source).not.toMatch(/https:|<|%%|^\s*click\b/mu);
      expect(result.source).toContain(tail);
      expect(result.evidence.nodes[0]).toMatchObject({id: auth.id, label, path: auth.path, span: auth.span});
      expect(result.evidence.groups).toEqual([
        {diagramId: 'g1', label: 'auth', members: ['n1']},
        {diagramId: 'g2', label: 'cache', members: ['n2']},
      ]);
      expect(result.evidence.edges).toEqual([
        {
          id: 'imports',
          source: 'n1',
          target: 'n2',
          relation: 'imports',
          path: auth.path,
          provenance: 'resolved',
          span: span(4),
        },
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
