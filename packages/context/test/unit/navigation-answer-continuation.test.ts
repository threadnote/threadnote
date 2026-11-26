import {describe, expect, it} from '@effect/vitest';
import {Array as EffectArray} from 'effect';
import {assembleNavigationAnswer} from '../../src/navigation/assemble.js';
import {
  navigationAnswerBinding,
  navigationEffectsDelta,
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
    expect(revalidateNavigationContinuation(binding, scope, assembleNavigationAnswer(input()))).toEqual({
      status: 'current',
    });
    // The semantic observation key includes the project epoch; equal content is not enough.
    expect(
      revalidateNavigationContinuation(
        binding,
        scope,
        assembleNavigationAnswer(input('path', 'operation-hash', 'epoch-4')),
      ),
    ).toEqual({status: 'stale', reason: 'navigation-observation-changed'});
    expect(revalidateNavigationContinuation(binding, {...scope, view: {...scope.view, epoch: 2}}, answer)).toEqual({
      status: 'stale',
      reason: 'navigation-scope-changed',
    });
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
});
