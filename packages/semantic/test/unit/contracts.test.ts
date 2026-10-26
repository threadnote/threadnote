import {Effect, Schema} from 'effect';
import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  FileUri,
  Observation,
  QueryOutcome,
  canonicalFileUri,
  observationKey,
  resolveSymbol,
} from '../../src/contracts.js';
import {sameOwnedView} from '../../src/views.js';
import {prepareChange} from '../../src/changes.js';
import {hash, observation, evidence, owned, candidate, proposal} from '../fixtures.js';

describe('semantic contracts', () => {
  effectIt.effect('decodes versioned observation contracts and rejects invalid counters', () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(Observation)(observation);
      expect(decoded).toEqual(observation);
      const invalid = yield* Schema.decodeEffect(Observation)({
        ...observation,
        documentVersion: -1,
      }).pipe(Effect.flip);
      expect(invalid).toBeDefined();
    }),
  );

  it('keeps empty, partial, unsupported and timeout outcomes distinct', () => {
    const decode = Schema.decodeUnknownSync(QueryOutcome);
    const empty = decode({version: 1, status: 'ok', evidence, items: []});
    const partial = decode({
      version: 1,
      status: 'ok',
      evidence: {
        ...evidence,
        completeness: 'partial',
        limitations: ['import-denied'],
      },
      items: [],
    });
    const unsupported = decode({
      version: 1,
      status: 'unsupported',
      evidence: null,
      reason: 'missing-capability',
    });
    const timeout = decode({
      version: 1,
      status: 'timeout',
      evidence: null,
      reason: 'deadline',
    });
    expect(new Set([empty, partial, unsupported, timeout].map(x => JSON.stringify(x))).size).toBe(4);
    expect(() => decode({version: 2, status: 'ok', evidence, items: []})).toThrow();
    expect(() => decode({version: 1, status: 'ok', items: []})).toThrow();
  });

  it('does not turn lexical candidates, ambiguous occurrences or stale anchors into exact symbols', () => {
    expect(resolveSymbol({kind: 'name', name: 'Name'}, observation, [candidate]).status).toBe('candidates');
    const locator = {
      kind: 'occurrence' as const,
      observation,
      position: {line: 0, character: 6},
    };
    expect(resolveSymbol(locator, observation, [candidate]).status).toBe('exact');
    expect(resolveSymbol(locator, observation, [candidate, {...candidate, id: 'symbol-b'}]).status).toBe('candidates');
    expect(resolveSymbol({...locator, position: {line: 0, character: 8}}, observation, [candidate]).status).toBe(
      'unresolved',
    );
    expect(
      resolveSymbol({kind: 'anchor', observation, anchor: 'anchor-a'}, {...observation, projectEpoch: 2}, [candidate])
        .status,
    ).toBe('stale');
    expect(resolveSymbol({kind: 'anchor', observation, anchor: 'other'}, observation, [candidate]).status).toBe(
      'unresolved',
    );
  });

  it('separates every worktree, project, configuration, provider and source-view identity dimension', () => {
    const variants: Observation[] = [
      {...observation, repository: 'other'},
      {...observation, worktree: 'file:///worktree/b'},
      {...observation, project: 'file:///worktree/a/other'},
      {...observation, configuration: hash('d')},
      {...observation, toolchain: hash('d')},
      {...observation, provider: {...observation.provider, id: 'other'}},
      {...observation, provider: {...observation.provider, version: '2'}},
      {...observation, provider: {...observation.provider, generation: 2}},
      {...observation, view: {...observation.view, kind: 'overlay'}},
      {...observation, view: {...observation.view, id: 'other'}},
      {...observation, view: {...observation.view, owner: 'other'}},
      {...observation, view: {...observation.view, epoch: 2}},
      {...observation, uri: 'file:///worktree/a/other.ts'},
      {...observation, content: hash('d')},
      {...observation, documentVersion: 2},
      {...observation, projectEpoch: 2},
    ];
    expect(new Set([observation, ...variants].map(observationKey)).size).toBe(variants.length + 1);
    for (const changed of variants) expect(sameOwnedView(owned, {...owned, observation: changed})).toBe(false);
    expect(sameOwnedView(owned, {...owned, fence: 2})).toBe(false);
    expect(sameOwnedView(owned, {...owned, authority: 'other'})).toBe(false);
  });

  it('identity is independent of serialization order and delimiter-like strings', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 60}), name => {
        const left = {
          ...observation,
          repository: name,
          view: {...observation.view, owner: `${name}:suffix`},
        };
        const right = Object.fromEntries(Object.entries(left).reverse()) as Observation;
        expect(observationKey(left)).toBe(observationKey(right));
        expect(observationKey(left)).not.toBe(
          observationKey({
            ...left,
            repository: `${name}:suffix`,
            view: {...left.view, owner: name},
          }),
        );
      }),
      {numRuns: 100},
    );
  });

  it('rejects URI aliases before raw strings can become different target identities', () => {
    const canonical = 'file:///worktree/a/project/main.ts';
    for (const alias of [
      'file:///worktree/a/project/./main.ts',
      'file:///worktree//a/project/main.ts',
      'file:///worktree/a/project/%6dain.ts',
      'file://localhost/worktree/a/project/main.ts',
    ]) {
      expect(canonicalFileUri(alias)).toBe(canonical);
      expect(Schema.is(FileUri)(alias)).toBe(false);
      const p = proposal(2);
      expect(() =>
        prepareChange('op', {
          ...p,
          targets: p.targets.map((t, i) => ({
            ...t,
            before: {
              ...t.before,
              observation: {...observation, uri: i === 0 ? canonical : alias},
            },
          })),
        }),
      ).toThrow();
    }
    expect(Schema.is(FileUri)('file:///a%2fb')).toBe(false);
    expect(Schema.is(FileUri)(canonical)).toBe(true);
    expect(canonicalFileUri('file:///c:/a')).toBe('file:///C:/a');
  });
});
