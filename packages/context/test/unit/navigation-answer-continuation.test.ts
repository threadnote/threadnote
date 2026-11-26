import {describe, expect, it} from '@effect/vitest';
import {Array as EffectArray} from 'effect';
import {assembleNavigationAnswer} from '../../src/navigation/assemble.js';
import {
  navigationAnswerBinding,
  navigationEffectsDelta,
  navigationEffectsFollowUpAnchors,
  revalidateNavigationContinuation,
} from '../../src/navigation/continuation.js';
import type {NavigationInput, NavigationScope, NavigationSource} from '../../src/navigation/model.js';

const scope: NavigationScope = {
  repository: 'fixture-repository',
  worktree: 'file:///fixture/worktree',
  project: 'file:///fixture/worktree/project',
  view: {kind: 'disk', id: 'disk-view', owner: 'fixture-owner', epoch: 1},
};
const source = (id: string, path: string, hash: string, semanticKey?: string): NavigationSource => ({
  ...scope,
  id,
  path,
  contentHash: hash,
  freshness: 'verified-current',
  ...(semanticKey ? {semantic: {observationKey: semanticKey, observationJson: '{}'}} : {}),
});
function input(write = 'path', operationHash = 'operation-hash', semanticKey = 'epoch-3'): NavigationInput {
  return {
    scope,
    target: {kind: 'anchors', candidateIds: ['entrypoint']},
    sources: [
      source('operation', 'operation.ts', operationHash, semanticKey),
      source('tests', 'operation.test.ts', 't'),
    ],
    candidates: [
      {
        id: 'entrypoint',
        sourceId: 'operation',
        startLine: 14,
        endLine: 14,
        roles: ['entrypoint'],
        reason: 'Entrypoint.',
        relevance: 1,
        basis: ['structural'],
        support: 'evidenced',
      },
      {
        id: 'effects',
        sourceId: 'operation',
        startLine: 9,
        endLine: 9,
        roles: ['effects'],
        reason: 'Possible write.',
        relevance: 1,
        basis: ['structural', 'inspected-source'],
        support: 'evidenced',
        possibleEffect: {kind: 'durable-write', target: write, condition: 'then branch of (persist)'},
      },
    ],
    links: [
      {
        from: 'entrypoint',
        to: 'effects',
        relation: 'calls',
        basis: 'structural',
        compatibility: 'verified',
        reason: 'Structural call.',
      },
    ],
    coverage: {status: 'complete', description: 'Fixture.'},
  };
}

describe('navigation continuation binding', () => {
  it('stays current for the same observation and becomes stale when only the project epoch changes', () => {
    const answer = assembleNavigationAnswer(input());
    const binding = navigationAnswerBinding(answer);
    const stale = {status: 'stale', reason: 'navigation-binding-changed'};
    expect(revalidateNavigationContinuation(binding, assembleNavigationAnswer(input()))).toEqual({status: 'current'});
    // The semantic observation key includes the project epoch; equal content is not enough.
    expect(
      revalidateNavigationContinuation(binding, assembleNavigationAnswer(input('path', 'operation-hash', 'epoch-4'))),
    ).toEqual(stale);
    const moved = {...input(), scope: {...scope, view: {...scope.view, epoch: 2}}};
    expect(revalidateNavigationContinuation(binding, assembleNavigationAnswer(moved))).toEqual(stale);
  });
});

describe('navigation effects follow-up delta', () => {
  it('reports unchanged, changed and invalidated write boundaries without repeating the route', () => {
    const previous = assembleNavigationAnswer(input());
    expect(navigationEffectsDelta(previous, assembleNavigationAnswer(input())).status).toBe('unchanged');
    const changed = navigationEffectsDelta(previous, assembleNavigationAnswer(input('backup-path', 'new-hash')));
    expect(changed.status).toBe('changed');
    expect(EffectArray.map(changed.effects, node => node.id)).toEqual(['effects']);
    expect(EffectArray.map(changed.sources, item => item.id)).toEqual(['operation']);
    const moved = assembleNavigationAnswer({...input(), scope: {...scope, worktree: 'file:///other'}});
    expect(navigationEffectsDelta(previous, moved)).toMatchObject({
      status: 'invalidated',
      reason: 'navigation-scope-changed',
    });
  });
  it('invalidates instead of reporting removal when the follow-up did not read the effect again', () => {
    const previous = assembleNavigationAnswer(input());
    const unread = assembleNavigationAnswer({
      ...input(),
      candidates: [input().candidates[0]],
      links: [],
      coverage: {status: 'partial', description: 'Deadline exhausted before the effect file was read.'},
    });
    expect(navigationEffectsDelta(previous, unread)).toMatchObject({
      status: 'invalidated',
      reason: 'navigation-effects-not-reacquired',
    });
  });
  it('invalidates a smaller effect set when the follow-up acquisition was incomplete', () => {
    const base = input();
    const second = {...base.candidates[1], id: 'second-effect', startLine: 11, endLine: 11};
    const previous = assembleNavigationAnswer({
      ...base,
      candidates: [...base.candidates, second],
      links: [...base.links, {...base.links[0], to: 'second-effect'}],
    });
    const partial = assembleNavigationAnswer({...base, gaps: ['navigation-facts-omitted']});
    expect(navigationEffectsDelta(previous, partial)).toMatchObject({
      status: 'invalidated',
      reason: 'navigation-effects-not-reacquired',
    });
    expect(navigationEffectsDelta(previous, assembleNavigationAnswer(base)).status).toBe('changed');
  });
  it('anchors a follow-up only on the previous effect nodes found again', () => {
    const previous = assembleNavigationAnswer(input());
    const node = (id: string, kind: string) => ({
      id,
      kind,
      name: id,
      qualifiedName: id,
      language: 'typescript',
      path: 'operation.ts',
      contentHash: 'operation-hash',
      exported: false,
      span: {line: 1, column: 1, endLine: 1, endColumn: 2},
      rank: 0,
      score: 1,
    });
    const result = {
      repository: {repositoryId: 'repository', displayName: 'fixture'},
      snapshot: {id: 'snapshot', worktreeId: 'worktree', commit: 'commit', dirty: false},
      freshness: 'current',
      operation: 'node',
      nodes: [node('effects', 'function'), node('module', 'module'), node('entrypoint', 'function')],
      edges: [],
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      warnings: [],
      version: 1,
    } as const;
    expect(EffectArray.map(navigationEffectsFollowUpAnchors(previous, result)?.nodes ?? [], item => item.id)).toEqual([
      'effects',
    ]);
    expect(navigationEffectsFollowUpAnchors(previous, {...result, nodes: [node('module', 'module')]})).toBeUndefined();
  });
});
