import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as EffectRecord from 'effect/Record';
import * as EffectOption from 'effect/Option';
import {describe, expect, it} from '@effect/vitest';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import oracle from '../fixtures/navigation-answers/v1/manifest.json' with {type: 'json'};
import {assembleNavigationAnswer} from '../../src/navigation/assemble.js';
import {
  NAVIGATION_INPUT_LIMITS,
  NAVIGATION_ROLES,
  type NavigationCandidate,
  type NavigationInput,
  type NavigationLink,
  type NavigationRole,
  type NavigationScope,
  type NavigationSource,
} from '../../src/navigation/model.js';
const scope: NavigationScope = {
  repository: 'fixture-repository',
  worktree: 'file:///fixture/worktree',
  project: 'file:///fixture/worktree/project',
  view: {kind: 'disk', id: 'disk-view', owner: 'fixture-owner', epoch: 1},
};
const source = (id: string, path: string, hash: string): NavigationSource => ({
  ...scope,
  id,
  path,
  contentHash: hash,
  freshness: 'verified-current',
});
const node = (
  id: string,
  role: NavigationRole,
  sourceId: string,
  startLine: number,
  endLine = startLine,
): NavigationCandidate => ({
  id,
  sourceId,
  startLine,
  endLine,
  roles: [role],
  reason: `Read ${id} for the save operation.`,
  relevance: 0.5,
  basis: ['inspected-source'],
  support: 'evidenced',
});
const link = (from: string, to: string): NavigationLink => ({
  from,
  to,
  relation: 'calls',
  basis: 'structural',
  compatibility: 'verified',
  reason: 'The source callsite relates these locations.',
});
function fixture(): NavigationInput {
  return {
    scope,
    target: {kind: 'anchors', candidateIds: ['entrypoint']},
    sources: [
      source('operation', 'operation.ts', oracle.sources[0].sha256),
      source('tests', 'operation.test.ts', oracle.sources[1].sha256),
    ],
    candidates: [
      node('entrypoint', 'entrypoint', 'operation', 14),
      node('implementation', 'implementation', 'operation', 6, 12),
      {
        ...node('effects', 'effects', 'operation', 9),
        possibleEffect: {kind: 'durable-write', target: 'path', condition: 'persist'},
      },
      {...node('tests', 'tests', 'tests', 4, 7), testAssociation: 'source-supported'},
      {...node('unrelated', 'implementation', 'operation', 4), relevance: 1},
    ],
    links: [
      link('entrypoint', 'implementation'),
      link('implementation', 'effects'),
      {...link('tests', 'implementation'), relation: 'tests'},
    ],
    coverage: {status: 'complete', description: 'The bounded authored fixture and its direct relationships.'},
  };
}
describe('navigation answer model', () => {
  it('retains the approved scenario oracle and independently authored source locations', () => {
    expect(oracle.specDocumentHash).toBe('12f5b77cdf10c8e2f8e2c811e5bb00644a1bf65a5be4cf0e53810c7bc1767b5e');
    expect(EffectArray.map(oracle.scenarios, scenario => scenario.id)).toEqual(
      Array.from({length: 18}, (_, index) => `GNAS${EffectString.padStart(2, '0')(String(index + 1))}`),
    );
    expect(new Set(EffectArray.map(oracle.requirements, requirement => requirement.id)).size).toBe(11);
    const sources = new Map(EffectArray.map(oracle.sources, item => [item.id, item]));
    for (const item of oracle.sources) expect(sha256HexSync(item.content)).toBe(item.sha256);
    for (const scenario of oracle.scenarios) {
      expect(scenario.given.length).toBeGreaterThan(0);
      expect(scenario.when.length).toBeGreaterThan(0);
      expect(scenario.then.length).toBeGreaterThan(0);
      expect(scenario.oracle.sourceLocations.length).toBeGreaterThan(0);
      for (const location of scenario.oracle.sourceLocations) {
        const specimen = sources.get(location.source);
        if (!specimen) throw new Error('Oracle location has no source specimen.');
        expect(location.startLine).toBeGreaterThan(0);
        expect(location.endLine).toBeGreaterThanOrEqual(location.startLine);
        expect(location.endLine).toBeLessThanOrEqual(
          EffectString.split(EffectString.trimEnd(specimen.content), '\n').length,
        );
      }
    }
    expect(EffectString.split(oracle.sources[0].content, '\n')[8]).toBe('    await writeFile(path, normalized);');
    expect(EffectString.split(oracle.sources[0].content, '\n')[7]).toBe('  if (persist) {');
    expect(EffectString.split(oracle.sources[1].content, '\n')[5]).toBe("  assert.equal(result, 'note');");
    expect(oracle.classification).toContain('not execution evidence');
  });
  it('supplies the connected four-role map and excludes disconnected text similarity', () => {
    const result = assembleNavigationAnswer(fixture());
    expect(result.outcome).toBe('ok');
    expect(new Set(EffectArray.map(result.nodes, item => item.id))).toEqual(
      new Set(['entrypoint', 'implementation', 'effects', 'tests']),
    );
    expect(EffectArray.map(result.roles, role => [role.role, role.status])).toEqual(
      EffectArray.map(NAVIGATION_ROLES, role => [role, 'supported']),
    );
    expect(result.links).toHaveLength(3);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.nodes, item => item.id === 'effects'))?.possibleEffect,
    ).toEqual({
      kind: 'durable-write',
      target: 'path',
      condition: 'persist',
    });
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.nodes, item => item.id === 'tests'))?.testAssociation,
    ).toBe('source-supported');
    expect(result).not.toHaveProperty('executed');
    expect(result).not.toHaveProperty('passingTests');
  });
  it('keeps both real entrypoints and link direction rather than inventing a linear stack', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      candidates: [...input.candidates, node('preview', 'entrypoint', 'operation', 15)],
      links: [...input.links, link('preview', 'implementation')],
    });
    expect(result.roles[0].nodeIds).toEqual(['entrypoint', 'preview']);
    expect(result.links).toContainEqual(link('preview', 'implementation'));
    expect(result.links).not.toContainEqual(expect.objectContaining({from: 'entrypoint', to: 'preview'}));
  });
  it('preserves missing roles as unknown and never infers purity from an absent dependency edge', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      target: {kind: 'anchors', candidateIds: ['unrelated']},
      candidates: [input.candidates[4]],
      links: [],
      coverage: {status: 'partial', description: 'The dependency target was unresolved.'},
    });
    expect(result.outcome).toBe('partial');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.roles, role => role.role === 'effects'))?.status,
    ).toBe('unknown');
    expect(result.nodes[0]).not.toHaveProperty('possibleEffect');
  });
  it('does not upgrade a name-only test candidate or structural read/write relation', () => {
    const input = fixture();
    const nameOnly: NavigationCandidate = {
      ...node('name-only', 'tests', 'tests', 9, 11),
      relevance: 1,
      support: 'candidate',
      basis: ['inference'],
      testAssociation: 'name-only',
    };
    const result = assembleNavigationAnswer({
      ...input,
      candidates: [...input.candidates, nameOnly],
      links: [
        ...input.links,
        {...link('name-only', 'implementation'), relation: 'semantic_association', basis: 'inference'},
        {...link('implementation', 'effects'), relation: 'reads_or_writes'},
      ],
    });
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.roles, role => role.role === 'tests'))?.nodeIds,
    ).toEqual(['tests']);
    expect(
      EffectOption.getOrElse(
        EffectArray.findFirstIndex(result.nodes, item => item.id === 'tests'),
        () => -1,
      ),
    ).toBeLessThan(
      EffectOption.getOrElse(
        EffectArray.findFirstIndex(result.nodes, item => item.id === 'name-only'),
        () => -1,
      ),
    );
    expect(result.links).toContainEqual(expect.objectContaining({relation: 'reads_or_writes', basis: 'structural'}));
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.nodes, item => item.id === 'name-only'))?.support,
    ).toBe('candidate');
  });
  it('exposes scope-qualified ambiguous targets without selecting one or joining them', () => {
    const input = fixture();
    const foreign = {...input.sources[0], id: 'foreign', worktree: 'file:///another/worktree'};
    const other = {...node('other', 'implementation', foreign.id, 6, 12), relevance: 1};
    const result = assembleNavigationAnswer({
      ...input,
      target: {kind: 'ambiguous', candidateIds: ['implementation', 'other']},
      sources: [...input.sources, foreign],
      candidates: [...input.candidates, other],
      links: [...input.links, link('implementation', 'other')],
    });
    expect(result.outcome).toBe('ambiguous');
    expect(new Set(EffectArray.map(result.nodes, item => item.id))).toEqual(new Set(['implementation', 'other']));
    expect(result.links).toEqual([]);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.roles, role => role.role === 'implementation'))?.status,
    ).toBe('unknown');
    expect(result.sources).toHaveLength(2);
  });
  it('separates an incompatible overlay observation and never reports a mixed current route', () => {
    const input = fixture();
    const overlay: NavigationSource = {
      ...input.sources[0],
      id: 'overlay',
      view: {...scope.view, kind: 'overlay', epoch: 2},
    };
    const result = assembleNavigationAnswer({
      ...input,
      sources: [...input.sources, overlay],
      candidates: [
        ...input.candidates,
        {...node('overlay-implementation', 'implementation', overlay.id, 6, 12), basis: ['inspected-source']},
      ],
      links: [...input.links, link('entrypoint', 'overlay-implementation')],
      followUps: [
        {
          kind: 'read-source',
          selector: 'operation.ts:6-12@disk-view:1',
          reason: 'Acquire the compatible saved implementation.',
        },
      ],
    });
    expect(result.outcome).toBe('conflict');
    expect(result.gaps).toContain('source-view-conflict');
    expect(EffectArray.some(result.nodes, item => item.sourceId === overlay.id)).toBe(false);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.sources, item => item.id === overlay.id))?.view,
    ).toEqual(overlay.view);
    expect(result.followUps).toHaveLength(1);
  });
  it('does not join an unverified relationship even when both endpoints are current', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      links: [{...link('entrypoint', 'implementation'), compatibility: 'unknown'}],
    });
    expect(EffectArray.map(result.nodes, item => item.id)).toEqual(['entrypoint']);
    expect(result.links).toEqual([]);
    expect(result.gaps).toContain('relationship-view-unverified');
    expect(result.outcome).toBe('partial');
  });
  it('retains the complete opaque semantic observation and key without reserializing it', () => {
    const input = fixture();
    const observation = {
      version: 1,
      repository: scope.repository,
      worktree: scope.worktree,
      project: scope.project,
      configuration: 'configuration-digest',
      toolchain: 'toolchain-digest',
      provider: {id: 'provider', version: '1', generation: 2},
      view: scope.view,
      uri: 'file:///fixture/worktree/project/operation.ts',
      content: 'content-digest',
      documentVersion: null,
      projectEpoch: 3,
    };
    const semantic = {
      observationKey: JSON.stringify(EffectRecord.values(observation)),
      observationJson: JSON.stringify(observation),
    };
    const enriched = {...input.sources[0], semantic};
    const result = assembleNavigationAnswer({...input, sources: [enriched, input.sources[1], enriched]});
    const retained = EffectOption.getOrUndefined(
      EffectArray.findFirst(result.sources, item => item.id === enriched.id),
    )?.semantic;
    expect(retained).toBe(semantic);
    expect(JSON.parse(retained?.observationJson ?? 'null')).toEqual(observation);
    expect(retained?.observationKey).toBe(semantic.observationKey);
  });
  it('deduplicates overlapping locators and remaps links to one stable identity', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      candidates: [...input.candidates, {...input.candidates[1], id: 'copy-implementation'}],
      links: [...input.links, link('entrypoint', 'copy-implementation')],
    });
    expect(EffectArray.filter(result.nodes, item => item.startLine === 6)).toHaveLength(1);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.roles, role => role.role === 'implementation'))?.nodeIds,
    ).toEqual(['copy-implementation']);
    expect(
      EffectArray.filter(result.links, item => item.from === 'entrypoint' && item.to === 'copy-implementation'),
    ).toHaveLength(1);
  });
  it('resolves every explicit anchor alias before deduplicating shared locators (NAV01-C02)', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      target: {kind: 'anchors', candidateIds: ['entrypoint', 'entrypoint-copy']},
      candidates: [...input.candidates, {...input.candidates[0], id: 'entrypoint-copy'}],
    });
    expect(result.outcome).toBe('ok');
    expect(result.gaps).not.toContain('target-unresolved');
    expect(result.nodes).toHaveLength(4);
    expect(
      assembleNavigationAnswer({...input, target: {kind: 'anchors', candidateIds: ['entrypoint', 'missing']}}).gaps,
    ).toContain('target-unresolved');
  });
  it('quarantines conflicting file hashes across source aliases and preserves observations (NAV01-C01)', () => {
    const input = fixture();
    const semantic = {
      observationKey: 'observation-a',
      observationJson: '{"provider":{"id":"a"},"documentVersion":null}',
    };
    const operation = {...input.sources[0], semantic};
    const changed = {
      ...operation,
      id: 'changed-operation',
      contentHash: 'changed-hash',
      semantic: {
        observationKey: 'observation-b',
        observationJson: '{"provider":{"id":"b"},"documentVersion":3}',
      },
    };
    const result = assembleNavigationAnswer({
      ...input,
      sources: [operation, input.sources[1], changed],
      candidates: [
        input.candidates[0],
        input.candidates[1],
        {...input.candidates[2], sourceId: changed.id},
        input.candidates[3],
      ],
    });
    expect(result.outcome).not.toBe('ok');
    expect(result.gaps).toContain('source-identity-conflict');
    expect(result.nodes).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.sources).toEqual([changed, operation]);
    expect(result.sources[0].semantic).toBe(changed.semantic);
    expect(result.sources[1].semantic).toBe(semantic);
    const proof = assembleNavigationAnswer({
      ...input,
      sources: [operation, input.sources[1], changed],
      target: {kind: 'anchors', candidateIds: ['tests']},
      candidates: [input.candidates[3]],
      links: [],
      roleGaps: [
        {
          role: 'effects',
          status: 'not-applicable',
          reason: 'A disputed source cannot prove this.',
          sourceProof: {sourceId: operation.id, span: {startLine: 4, endLine: 4}},
        },
      ],
    });
    expect(proof.roles[2].status).toBe('unknown');
  });
  it('uses task relevance before test association when choosing the task seed (NAV01-C03)', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      target: {kind: 'task'},
      candidates: [
        {...input.candidates[1], relevance: 1},
        {...input.candidates[3], relevance: 0.01},
      ],
      links: [],
    });
    expect(EffectArray.map(result.nodes, item => item.id)).toEqual(['implementation']);
    expect(result.roles[1].status).toBe('supported');
    expect(result.roles[3].status).toBe('unknown');
  });
  it('keeps evidenced task routes ahead of higher relevance name-only candidates (NAV01-C04)', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      target: {kind: 'task'},
      candidates: [
        {...input.candidates[1], relevance: 0.9},
        {...input.candidates[3], relevance: 0.8},
        {
          ...node('name-only', 'tests', 'tests', 9, 11),
          relevance: 1,
          support: 'candidate',
          basis: ['inference'],
          testAssociation: 'name-only',
        },
      ],
      links: [{...link('tests', 'implementation'), relation: 'tests'}],
    });
    expect(new Set(EffectArray.map(result.nodes, item => item.id))).toEqual(new Set(['implementation', 'tests']));
    expect(result.roles[1].status).toBe('supported');
    expect(result.roles[3].nodeIds).toEqual(['tests']);
  });
  it('reports conflicting duplicate identity instead of selecting whichever observation arrived last', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      candidates: [...input.candidates, {...input.candidates[1], startLine: 17, endLine: 17}],
    });
    expect(result.outcome).toBe('conflict');
    expect(result.gaps).toContain('candidate-identity-conflict');
    expect(EffectArray.some(result.nodes, item => item.id === 'implementation')).toBe(false);
  });
  it('reports conflicting source identity rather than promoting one hash as current', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      sources: [...input.sources, {...input.sources[0], contentHash: 'changed-hash'}],
    });
    expect(result.outcome).toBe('unresolved');
    expect(result.gaps).toContain('source-identity-conflict');
    expect(result.nodes).toEqual([]);
    expect(new Set(EffectArray.map(result.sources, item => item.contentHash))).toEqual(
      new Set([input.sources[0].contentHash, 'changed-hash']),
    );
  });
  it('isolates conflicting observations from an unrelated worktree', () => {
    const input = fixture();
    const foreign = {...input.sources[0], id: 'foreign', worktree: 'file:///other/worktree'};
    expect(
      assembleNavigationAnswer({
        ...input,
        sources: [...input.sources, foreign, {...foreign, id: 'foreign-conflict', contentHash: 'changed-hash'}],
      }),
    ).toEqual(assembleNavigationAnswer(input));
  });
  it('requires affirmative current source evidence for not-applicable and retains that proof', () => {
    const input = fixture();
    const base = {
      ...input,
      candidates: [input.candidates[4]],
      target: {kind: 'anchors', candidateIds: ['unrelated']} as const,
      links: [],
    };
    const noProof = assembleNavigationAnswer({
      ...base,
      roleGaps: [{role: 'effects', status: 'not-applicable', reason: 'No effect was found.'}],
    });
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(noProof.roles, role => role.role === 'effects'))?.status,
    ).toBe('unknown');
    const sourceProof = {sourceId: 'operation', span: {startLine: 4, endLine: 4}};
    const proved = assembleNavigationAnswer({
      ...base,
      roleGaps: [
        {
          role: 'effects',
          status: 'not-applicable',
          reason: 'The inspected local normalization expression has no mutation.',
          sourceProof,
        },
      ],
    });
    expect(EffectOption.getOrUndefined(EffectArray.findFirst(proved.roles, role => role.role === 'effects'))).toEqual(
      expect.objectContaining({status: 'not-applicable', sourceProof}),
    );
  });
  it('keeps stale freshness and coverage outcomes separate from relevance', () => {
    const input = fixture();
    const result = assembleNavigationAnswer({
      ...input,
      sources: [{...input.sources[0], freshness: 'stale'}, input.sources[1]],
    });
    expect(result.outcome).toBe('partial');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.nodes, item => item.id === 'entrypoint'))?.freshness,
    ).toBe('stale');
    for (const status of ['empty', 'unavailable', 'timeout'] as const) {
      expect(
        assembleNavigationAnswer({
          ...input,
          target: {kind: 'task'},
          candidates: [],
          links: [],
          coverage: {status, description: 'Only the explicitly requested scope was searched.'},
        }).outcome,
      ).toBe(status);
    }
  });
  it('rejects item, aggregate UTF-8, invalid span and follow-up excess before assembly', () => {
    const input = fixture();
    expect(() =>
      assembleNavigationAnswer({...input, candidates: Array.from({length: 25}, () => input.candidates[0])}),
    ).toThrow('item limits');
    expect(() => assembleNavigationAnswer({...input, candidates: [{...input.candidates[0], startLine: 0}]})).toThrow(
      'Invalid navigation candidate',
    );
    expect(() => assembleNavigationAnswer({...input, target: {kind: 'anchors', candidateIds: []}})).toThrow(
      'item limits',
    );
    expect(() =>
      assembleNavigationAnswer({...input, candidates: [{...input.candidates[0], basis: ['qualified-semantic']}]}),
    ).toThrow('complete observation');
    expect(() =>
      assembleNavigationAnswer({...input, gaps: [EffectString.repeat(NAVIGATION_INPUT_LIMITS.stringBytes / 3)('😀')]}),
    ).toThrow('string limits');
    const longSources = Array.from({length: 17}, (_, index) => ({
      ...input.sources[0],
      id: `source-${index}`,
      semantic: {observationKey: EffectString.repeat(32768)('k'), observationJson: EffectString.repeat(32768)('j')},
    }));
    expect(() => assembleNavigationAnswer({...input, sources: longSources})).toThrow('string limits');
    const acquisition = {kind: 'query', selector: 'exact-target', reason: 'Resolve one remaining gap.'} as const;
    expect(() => assembleNavigationAnswer({...input, followUps: [acquisition, acquisition, acquisition]})).toThrow(
      'item limits',
    );
  });
  fcProp(
    it,
    'ordering and duplicate retrieval do not change the model or mutate input',
    {
      order: fc.shuffledSubarray([0, 1, 2, 3, 4], {minLength: 5, maxLength: 5}),
      repetitions: fc.integer({min: 1, max: 3}),
    },
    ({order, repetitions}) => {
      const input = fixture();
      const before = structuredClone(input);
      const permuted = {
        ...input,
        candidates: EffectArray.flatMap(order, index =>
          Array.from({length: repetitions}, () => input.candidates[index]),
        ),
        links: [...input.links].reverse(),
        sources: [...input.sources].reverse(),
      };
      expect(assembleNavigationAnswer(permuted)).toEqual(assembleNavigationAnswer(input));
      expect(input).toEqual(before);
    },
    {fastCheck: {numRuns: 80}},
  );
  fcProp(
    it,
    'conflicting observations remain lossless and order independent under duplicate retrieval',
    {
      reverse: fc.boolean(),
      repetitions: fc.integer({min: 1, max: 3}),
      sameAlias: fc.boolean(),
      sameHash: fc.boolean(),
      sameObservationKey: fc.boolean(),
      metadata: fc.string({maxLength: 64}),
    },
    ({reverse, repetitions, sameAlias, sameHash, sameObservationKey, metadata}) => {
      const input = fixture();
      const operation = {
        ...input.sources[0],
        semantic: {observationKey: 'first', observationJson: JSON.stringify({metadata, parent: {epoch: 1}})},
      };
      const changed = {
        ...operation,
        id: sameAlias ? operation.id : 'changed',
        contentHash: sameAlias && sameHash ? operation.contentHash : 'changed-hash',
        semantic: {
          observationKey: sameObservationKey ? 'first' : 'second',
          observationJson: JSON.stringify({metadata, parent: {epoch: 2}}),
        },
      };
      const original = {...input, sources: [operation, input.sources[1], changed]};
      const sources = EffectArray.flatMap(reverse ? [...original.sources].reverse() : original.sources, item =>
        Array.from({length: repetitions}, () => item),
      );
      const before = structuredClone(sources);
      const result = assembleNavigationAnswer({...original, sources});
      expect(result).toEqual(assembleNavigationAnswer(original));
      expect(result.sources).toHaveLength(2);
      expect(new Set(EffectArray.map(result.sources, source => source.semantic?.observationJson))).toEqual(
        new Set([operation.semantic.observationJson, changed.semantic.observationJson]),
      );
      expect(result.gaps).toContain('source-identity-conflict');
      expect(result.links).toEqual([]);
      expect(sources).toEqual(before);
    },
    {fastCheck: {numRuns: 80}},
  );
  fcProp(
    it,
    'higher similarity candidates cannot suppress an evidenced task route',
    {relevance: fc.integer({min: 0, max: 1000}), excess: fc.integer({min: 1, max: 1000}), reverse: fc.boolean()},
    ({relevance, excess, reverse}) => {
      const input = fixture();
      const candidates: NavigationCandidate[] = [
        {...input.candidates[1], relevance},
        {...input.candidates[3], relevance: relevance - 1},
        {
          ...node('name-only', 'tests', 'tests', 9, 11),
          relevance: relevance + excess,
          support: 'candidate',
          basis: ['inference'],
          testAssociation: 'name-only',
        },
      ];
      const result = assembleNavigationAnswer({
        ...input,
        target: {kind: 'task'},
        candidates: reverse ? candidates.reverse() : candidates,
        links: [link('tests', 'implementation')],
      });
      expect(new Set(EffectArray.map(result.nodes, item => item.id))).toEqual(new Set(['implementation', 'tests']));
      expect(result.roles[1].status).toBe('supported');
      expect(result.roles[3].status).toBe('supported');
    },
    {fastCheck: {numRuns: 80}},
  );
  fcProp(
    it,
    'bounded cycles and high fanout cannot create nodes or relationships',
    {
      edges: fc.array(fc.tuple(fc.integer({min: 0, max: 3}), fc.integer({min: 0, max: 3})), {maxLength: 60}),
    },
    ({edges}) => {
      const input = fixture();
      const names = ['entrypoint', 'implementation', 'effects', 'tests'];
      const links = [...input.links, ...EffectArray.map(edges, ([from, to]) => link(names[from], names[to]))];
      const answer = assembleNavigationAnswer({...input, links});
      expect(new Set(EffectArray.map(answer.nodes, item => item.id))).toEqual(new Set(names));
      expect(
        EffectArray.every(answer.links, item =>
          EffectArray.some(links, original => original.from === item.from && original.to === item.to),
        ),
      ).toBe(true);
      expect(new Set(EffectArray.map(answer.links, item => JSON.stringify(item))).size).toBe(answer.links.length);
    },
    {fastCheck: {numRuns: 80}},
  );
  fcProp(
    it,
    'unrelated repository or worktree evidence cannot displace an exact anchor',
    {
      name: fc.string({minLength: 1, maxLength: 64}),
      foreignWorktree: fc.boolean(),
    },
    ({name, foreignWorktree}) => {
      const input = fixture();
      const foreign: NavigationSource = {
        ...input.sources[0],
        id: 'foreign',
        ...(foreignWorktree ? {worktree: `file:///other/${encodeURIComponent(name)}`} : {repository: `other-${name}`}),
      };
      const candidate = {...node('foreign-node', 'implementation', foreign.id, 6, 12), relevance: 100};
      const actual = assembleNavigationAnswer({
        ...input,
        sources: [...input.sources, foreign],
        candidates: [...input.candidates, candidate],
        links: [...input.links, link(candidate.id, candidate.id)],
      });
      expect(actual).toEqual(assembleNavigationAnswer(input));
    },
    {fastCheck: {numRuns: 80}},
  );
});
