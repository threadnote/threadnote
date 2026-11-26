import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Option, String as EffectString} from 'effect';
import {observationKey, type Observation} from '@threadnote/semantic/contracts';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {assembleNavigationAnswer} from '@threadnote/context/navigation/assemble';
import {navigationSourceId, type NavigationInput, type NavigationScope} from '@threadnote/context/navigation/model';
import {
  acquireSemanticNavigationEvidence,
  withSemanticNavigationEvidence,
  type SemanticNavigationDocument,
  type SemanticNavigationQuery,
} from '../../src/context_brief/navigation_evidence.js';

const worktreeUri = 'file:///fixture/worktree';
const scope: NavigationScope = {
  repository: 'fixture-repository',
  worktree: 'fixture-worktree',
  project: 'fixture-project',
  view: {kind: 'disk', id: 'disk', owner: 'graph', epoch: 0},
};
const operationSource = navigationSourceId(scope, 'src/operation.ts', 'graph-operation');
const storeSource = navigationSourceId(scope, 'src/store.ts', 'graph-store');

function structural(): NavigationInput {
  return {
    scope,
    target: {kind: 'anchors', candidateIds: ['save']},
    sources: [
      {
        ...scope,
        id: operationSource,
        path: 'src/operation.ts',
        contentHash: 'graph-operation',
        freshness: 'verified-current',
        snapshot: 'snapshot',
      },
      {
        ...scope,
        id: storeSource,
        path: 'src/store.ts',
        contentHash: 'graph-store',
        freshness: 'verified-current',
        snapshot: 'snapshot',
      },
    ],
    candidates: [
      {
        id: 'handle',
        sourceId: operationSource,
        startLine: 20,
        endLine: 24,
        roles: ['entrypoint'],
        reason: 'Structural caller.',
        relevance: 1,
        basis: ['structural'],
        support: 'evidenced',
      },
      {
        id: 'save',
        sourceId: operationSource,
        startLine: 5,
        endLine: 12,
        roles: ['implementation'],
        reason: 'Structural implementation.',
        relevance: 1,
        basis: ['structural', 'inspected-source'],
        support: 'evidenced',
      },
      {
        id: 'write',
        sourceId: storeSource,
        startLine: 3,
        endLine: 8,
        roles: ['implementation'],
        reason: 'Structural store function.',
        relevance: 0.5,
        basis: ['structural'],
        support: 'evidenced',
      },
    ],
    links: [
      {
        from: 'handle',
        to: 'save',
        relation: 'calls',
        basis: 'structural',
        compatibility: 'verified',
        reason: 'Structural call.',
      },
      {
        from: 'save',
        to: 'write',
        relation: 'reads_or_writes',
        basis: 'structural',
        compatibility: 'verified',
        reason: 'Structural reads_or_writes relation.',
      },
    ],
    coverage: {status: 'complete', description: 'Bounded fixture.'},
  };
}

function observation(path: string, content: string, overrides: Partial<Observation> = {}): Observation {
  return {
    version: 1,
    repository: 'fixture-repository',
    worktree: worktreeUri,
    project: worktreeUri,
    configuration: EffectString.repeat(64)('a'),
    toolchain: EffectString.repeat(64)('b'),
    provider: {id: 'typescript', version: '1', generation: 1},
    view: {kind: 'disk', id: 'agent-disk', owner: 'agent-disk:fixture', epoch: 0},
    uri: `${worktreeUri}/${path}`,
    content,
    documentVersion: null,
    projectEpoch: 1,
    ...overrides,
  };
}
function document(
  path: string,
  graphHash: string,
  observed = observation(path, `${path}-bytes`),
): SemanticNavigationDocument {
  return {
    path,
    observation: observed,
    binding:
      observed.view.kind === 'disk'
        ? {
            version: 1,
            scope: 'document',
            observation: sha256HexSync(observationKey(observed)),
            semanticContent: observed.content,
            graph: {repositoryId: 'fixture-repository', snapshotId: 'snapshot', path, contentHash: graphHash},
          }
        : null,
    closingObservationKey: observationKey(observed),
  };
}
const range = (line: number) => ({start: {line, character: 0}, end: {line, character: 4}});
function callHierarchy(
  observed: Observation,
  calls: {readonly incoming?: readonly [string, number][]; readonly outgoing?: readonly [string, number][]},
  capability: SemanticNavigationQuery['capability'] = 'qualified',
): SemanticNavigationQuery {
  const item = (path: string, line: number) => ({
    name: 'symbol',
    kind: 12,
    uri: `${worktreeUri}/${path}`,
    range: range(line),
    selectionRange: range(line),
  });
  return {
    operation: 'call-hierarchy',
    path: 'src/operation.ts',
    anchorCandidateId: 'save',
    capability,
    result: {
      version: 1,
      status: 'ok',
      evidence: {basis: 'semantic', observation: observed, scope: 'document', completeness: 'partial', limitations: []},
      items: [
        {
          root: item('src/operation.ts', 5),
          incoming: EffectArray.map(calls.incoming ?? [], ([path, line]) => ({
            from: item(path, line),
            fromRanges: [range(line)],
          })),
          outgoing: EffectArray.map(calls.outgoing ?? [], ([path, line]) => ({
            to: item(path, line),
            fromRanges: [range(6)],
          })),
        },
      ],
      offset: 0,
      remaining: 0,
      next: null,
    },
  };
}
const roleStatus = (result: ReturnType<typeof assembleNavigationAnswer>, role: string) =>
  Option.getOrUndefined(EffectArray.findFirst(result.roles, item => item.role === role))?.status;
const hasSemanticLink = (result: ReturnType<typeof assembleNavigationAnswer>) =>
  EffectArray.some(result.links, link => link.basis === 'qualified-semantic');
const operationDocument = () => document('src/operation.ts', 'graph-operation');
const answer = (documents: readonly SemanticNavigationDocument[], queries: readonly SemanticNavigationQuery[]) =>
  assembleNavigationAnswer(withSemanticNavigationEvidence(structural(), {worktreeUri, documents, queries}));

describe('semantic navigation evidence', () => {
  it('keeps a qualified compiler call next to structural import and reads_or_writes bases (GNAS07)', () => {
    const operation = operationDocument();
    const result = answer(
      [operation, document('src/store.ts', 'graph-store')],
      [callHierarchy(operation.observation, {incoming: [['src/operation.ts', 21]], outgoing: [['src/store.ts', 2]]})],
    );
    const bases = (from: string, to: string) =>
      EffectArray.map(
        EffectArray.filter(result.links, link => link.from === from && link.to === to),
        link => link.basis,
      ).sort();
    expect(bases('handle', 'save')).toEqual(['qualified-semantic', 'structural']);
    expect(bases('save', 'write')).toEqual(['qualified-semantic', 'structural']);
    expect(
      Option.getOrUndefined(EffectArray.findFirst(result.links, link => link.relation === 'reads_or_writes'))?.basis,
    ).toBe('structural');
    // A compiler call does not prove a durable write: no possible effect appears.
    expect(EffectArray.some(result.nodes, node => node.possibleEffect !== undefined)).toBe(false);
    expect(EffectArray.filter(result.sources, source => source.semantic !== undefined)).toHaveLength(2);
  });

  it('reports an experimental provider as a limitation and keeps the structural route (GNAS09)', () => {
    const operation = operationDocument();
    const result = answer(
      [operation],
      [callHierarchy(operation.observation, {incoming: [['src/operation.ts', 21]]}, 'experimental')],
    );
    expect(result.gaps).toContain('semantic-provider-unqualified');
    expect(EffectArray.every(result.links, link => link.basis === 'structural')).toBe(true);
    expect(roleStatus(result, 'entrypoint')).toBe('supported');
  });

  it('separates unsaved buffer evidence from older disk bytes with a precise next query (GNAS08)', () => {
    const buffer = observation('src/operation.ts', 'buffer-bytes', {
      view: {kind: 'overlay', id: 'buffer-handle', owner: 'agent', epoch: 3},
      documentVersion: 4,
    });
    const result = answer(
      [document('src/operation.ts', 'graph-operation', buffer)],
      [callHierarchy(buffer, {incoming: [['src/operation.ts', 21]]})],
    );
    expect(result.outcome).toBe('conflict');
    expect(result.gaps).toEqual(expect.arrayContaining(['semantic-buffer-view-unbound', 'source-view-conflict']));
    expect(hasSemanticLink(result)).toBe(false);
    expect(result.followUps).toContainEqual(
      expect.objectContaining({kind: 'query', selector: 'semantic disk src/operation.ts'}),
    );
  });

  it('discards semantic facts after drift or mixed project epochs (GNAS10)', () => {
    const operation = operationDocument();
    const query = callHierarchy(operation.observation, {incoming: [['src/operation.ts', 21]]});
    const drifted = answer(
      [{...operation, closingObservationKey: observationKey({...operation.observation, projectEpoch: 2})}],
      [query],
    );
    expect(drifted.gaps).toContain('semantic-observation-drift');
    expect(hasSemanticLink(drifted)).toBe(false);
    const store = document(
      'src/store.ts',
      'graph-store',
      observation('src/store.ts', 'src/store.ts-bytes', {projectEpoch: 2}),
    );
    const mixed = answer([operation, store], [query]);
    expect(mixed.gaps).toContain('semantic-observation-conflict');
    expect(hasSemanticLink(mixed)).toBe(false);
  });

  it('does not verify a cross-file route when the far document has no disk join', () => {
    const operation = operationDocument();
    const result = answer([operation], [callHierarchy(operation.observation, {outgoing: [['src/store.ts', 2]]})]);
    expect(result.gaps).toEqual(
      expect.arrayContaining(['semantic-target-source-unbound', 'relationship-view-unverified']),
    );
    expect(hasSemanticLink(result)).toBe(false);
  });

  it('keeps zero results, unsupported, unavailable and timeout outcomes distinguishable (GNAS13)', () => {
    const operation = operationDocument();
    const base = callHierarchy(operation.observation, {});
    const failure = (status: 'unsupported' | 'unavailable' | 'timeout'): SemanticNavigationQuery => ({
      ...base,
      result: {version: 1, status, reason: 'fixture', evidence: null},
    });
    const empty = answer([operation], [base]);
    expect(EffectArray.filter(empty.gaps, gap => EffectString.startsWith('semantic-')(gap))).toEqual([]);
    for (const status of ['unsupported', 'unavailable', 'timeout'] as const) {
      const result = answer([operation], [failure(status)]);
      expect(result.gaps).toContain(`semantic-${status}`);
      expect(roleStatus(result, 'entrypoint')).toBe('supported');
    }
  });
});

describe('semantic navigation attachment', () => {
  const definition = (path: string, line: number): SemanticNavigationQuery => {
    const base = callHierarchy(operationDocument().observation, {});
    if (base.result.status !== 'ok') throw new Error('Expected a successful fixture result.');
    return {
      ...base,
      operation: 'definition',
      result: {...base.result, items: [{uri: `${worktreeUri}/${path}`, range: range(line)}]},
    };
  };
  it('attaches a definition only to a candidate that starts on its line, never to an enclosing one', () => {
    const documents = [operationDocument()];
    const atHandle = withSemanticNavigationEvidence(structural(), {
      worktreeUri,
      documents,
      queries: [definition('src/operation.ts', 19)],
    });
    expect(EffectArray.filter(atHandle.links, link => link.basis === 'qualified-semantic')).toMatchObject([
      {from: 'save', to: 'handle', relation: 'references'},
    ]);
    // Line 10 is inside `save` (5-12) but no candidate starts there: a semantic-only candidate is created.
    const inside = withSemanticNavigationEvidence(structural(), {
      worktreeUri,
      documents,
      queries: [definition('src/operation.ts', 9)],
    });
    const created = EffectArray.filter(inside.candidates, candidate => candidate.basis.includes('qualified-semantic'));
    expect(created).toMatchObject([{startLine: 10, endLine: 10, roles: ['implementation']}]);
  });
  it('skips an attachment with two equally small candidates', () => {
    const operation = operationDocument();
    const input = structural();
    const twin = {...input.candidates[0], id: 'handle-twin'};
    const result = withSemanticNavigationEvidence(
      {...input, candidates: [...input.candidates, twin]},
      {
        worktreeUri,
        documents: [operation],
        queries: [callHierarchy(operation.observation, {incoming: [['src/operation.ts', 21]]})],
      },
    );
    expect(result.gaps).toContain('semantic-attachment-ambiguous');
    expect(EffectArray.some(result.links, link => link.basis === 'qualified-semantic')).toBe(false);
  });
  it('refuses a disk join that names an earlier observation or another snapshot', () => {
    const operation = operationDocument();
    const query = callHierarchy(operation.observation, {incoming: [['src/operation.ts', 21]]});
    for (const binding of [
      {...operation.binding!, observation: sha256HexSync(observationKey({...operation.observation, projectEpoch: 0}))},
      {...operation.binding!, graph: {...operation.binding!.graph, snapshotId: 'older-snapshot'}},
    ]) {
      const result = withSemanticNavigationEvidence(structural(), {
        worktreeUri,
        documents: [{...operation, binding}],
        queries: [query],
      });
      expect(result.gaps).toContain('semantic-graph-source-unbound');
      expect(EffectArray.some(result.links, link => link.basis === 'qualified-semantic')).toBe(false);
    }
  });
  it('reports a line-convention refusal of the disk join with its own gap', () => {
    const operation = {...operationDocument(), binding: null, refusal: 'line-convention-unsupported' as const};
    const result = withSemanticNavigationEvidence(structural(), {
      worktreeUri,
      documents: [operation],
      queries: [callHierarchy(operation.observation, {incoming: [['src/operation.ts', 21]]})],
    });
    expect(result.gaps).toContain('semantic-line-convention-unsupported');
    expect(EffectArray.some(result.links, link => link.basis === 'qualified-semantic')).toBe(false);
  });
});

describe('semantic navigation acquisition', () => {
  effectIt.effect('starts no semantic request when the parent deadline is exhausted', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const record = (name: string) => Effect.sync(() => void calls.push(name));
      const evidence = yield* acquireSemanticNavigationEvidence({
        worktreeUri,
        anchors: [{candidateId: 'save', path: 'src/operation.ts', position: {line: 4, character: 9}}],
        operations: ['call-hierarchy'],
        deadline: yield* makeReadDeadline(0),
        ports: {
          capability: () => record('capability').pipe(Effect.as('qualified' as const)),
          query: () =>
            record('query').pipe(Effect.as({version: 1, status: 'timeout', reason: 'x', evidence: null} as const)),
          observe: () => record('observe').pipe(Effect.as(null)),
          bind: () => record('bind').pipe(Effect.as({binding: null})),
        },
      });
      expect(calls).toEqual([]);
      expect(evidence.gaps).toEqual(['semantic-deadline-exhausted']);
    }),
  );

  effectIt.effect('observes every document again only after all queries and joins', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const operation = operationDocument();
      const query = callHierarchy(operation.observation, {outgoing: [['src/store.ts', 2]]});
      const store = observation('src/store.ts', 'src/store.ts-bytes');
      const evidence = yield* acquireSemanticNavigationEvidence({
        worktreeUri,
        anchors: [{candidateId: 'save', path: 'src/operation.ts', position: {line: 4, character: 9}}],
        operations: ['call-hierarchy'],
        deadline: yield* makeReadDeadline(60_000),
        ports: {
          capability: () => Effect.succeed('qualified' as const),
          query: request =>
            Effect.sync(() => void calls.push(`query ${request.milliseconds}`)).pipe(Effect.as(query.result)),
          observe: (path, milliseconds) =>
            Effect.sync(() => void calls.push(`observe ${path} ${milliseconds}`)).pipe(
              Effect.as(path === 'src/store.ts' ? store : operation.observation),
            ),
          bind: path => Effect.sync(() => void calls.push(`bind ${path}`)).pipe(Effect.as({binding: null})),
        },
      });
      // The test clock does not advance: the query keeps three 500 ms closing reservations, and each closing
      // observation keeps one reservation for every later document.
      expect(calls).toEqual([
        'query 58500',
        'observe src/store.ts 59000',
        'bind src/operation.ts',
        'bind src/store.ts',
        'observe src/operation.ts 59500',
        'observe src/store.ts 60000',
      ]);
      expect(EffectArray.map(evidence.documents, item => item.closingObservationKey)).toEqual([
        observationKey(operation.observation),
        observationKey(store),
      ]);
    }),
  );
});
