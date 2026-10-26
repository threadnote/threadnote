import {expect} from 'vitest';
import type {Observation, SymbolCandidate} from '../src/contracts.js';
import type {OwnedView} from '../src/views.js';
import {advanceChange, type ChangeState, type ChangeEvent} from '../src/changes.js';

export const hash = (character: string) => character.repeat(64);
export const observation: Observation = {
  version: 1,
  repository: 'repo',
  worktree: 'file:///worktree/a',
  project: 'file:///worktree/a/project',
  configuration: hash('a'),
  toolchain: hash('b'),
  provider: {id: 'test', version: '1.0.0', generation: 1},
  view: {kind: 'editor', id: 'view-a', owner: 'client-a', epoch: 1},
  uri: 'file:///worktree/a/project/main.ts',
  content: hash('c'),
  documentVersion: 1,
  projectEpoch: 1,
};
export const evidence = {
  basis: 'semantic',
  observation,
  scope: 'project',
  completeness: 'complete',
  limitations: [],
} as const;
export const owned: OwnedView = {observation, authority: 'writer', fence: 1};
export const candidate: SymbolCandidate = {
  id: 'symbol-a',
  name: 'Name',
  observation,
  occurrence: {
    start: {line: 0, character: 4},
    end: {line: 0, character: 8},
  },
  verifiedAnchor: 'anchor-a',
};
export const step = (state: ChangeState, event: ChangeEvent): ChangeState => {
  const result = advanceChange(state, event);
  expect(result.status).toBe('accepted');
  return result.state;
};
export function proposal(count: number) {
  return {
    version: 1 as const,
    id: 'proposal',
    digest: hash('d'),
    targets: Array.from({length: count}, (_, i) => ({
      before: {
        ...owned,
        observation: {
          ...observation,
          uri: `file:///worktree/a/project/${i}.ts`,
        },
      },
      after: hash('e'),
    })),
  };
}
