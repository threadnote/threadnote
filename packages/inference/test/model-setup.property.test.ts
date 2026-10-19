import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  initialModelSetupState,
  parseModelSetup,
  transitionModelSetup,
  type ModelSetupFence,
  type ModelSetupPhase,
  type ModelSetupState,
} from '@threadnote/inference/models/setup';
import {parseModelSelection} from '@threadnote/inference/models/selection';

const job = {home: '/canonical/home', modelId: 'fixture-generation', revision: 'a'.repeat(40), sha256: 'b'.repeat(64)};
const owner = {token: 'one', processId: 1, processStartIdentity: 'process-start-one'};
const identity = {size: '4', device: '1', inode: '2', modifiedAtNs: '3', changedAtNs: '4'};
const receipt = {sha256: job.sha256, fileIdentity: identity};
const phases: ModelSetupPhase[] = [
  'pending',
  'downloading',
  'verifying',
  'ready',
  'retry-wait',
  'action-required',
  'off',
];

function stateAt(phase: ModelSetupPhase, epoch: number, attempts: number, bytes: number): ModelSetupState {
  const initial = {...initialModelSetupState(job), intentEpoch: epoch, attempts, bytes};
  switch (phase) {
    case 'pending':
      return initial;
    case 'off':
      return {...initial, policy: 'off', phase};
    case 'downloading':
    case 'verifying':
      return {...initial, phase, owner};
    case 'ready':
      return {...initial, phase, receipt};
    case 'retry-wait':
      return {...initial, phase, reason: 'offline', nextAttemptAt: 42};
    case 'action-required':
      return {...initial, phase, reason: 'checksum'};
  }
}

describe('model setup domain properties', () => {
  it('round-trips every phase, safe epoch, progress, and private readiness binding', () => {
    FC.assert(
      FC.property(
        FC.constantFrom(...phases),
        FC.maxSafeNat(),
        FC.nat(100),
        FC.maxSafeNat(),
        (phase, epoch, attempts, bytes) => {
          const state = stateAt(phase, epoch, attempts, bytes);
          expect(parseModelSetup(JSON.stringify(state))).toEqual({status: 'valid', state});
        },
      ),
      {numRuns: 150},
    );
  });

  it('never accepts unknown versions, invalid phase payloads or inconsistent policy/readiness', () => {
    FC.assert(
      FC.property(FC.constantFrom(...phases), FC.integer({min: 2, max: 1000}), (phase, version) => {
        const state = stateAt(phase, 0, 0, 0);
        expect(parseModelSetup(JSON.stringify({...state, version})).status).toBe('malformed');
        expect(parseModelSetup(JSON.stringify({...state, intentEpoch: -1})).status).toBe('malformed');
        expect(parseModelSetup(JSON.stringify({...state, unexpected: true})).status).toBe('malformed');
        expect(
          parseModelSetup(JSON.stringify({...state, policy: state.policy === 'off' ? 'automatic' : 'off'})).status,
        ).toBe('malformed');
      }),
      {numRuns: 80},
    );
  });

  it('round-trips valid role maps without inventing roles or losing explicit identities', () => {
    FC.assert(
      FC.property(FC.subarray(['embedding', 'generation', 'reranker'] as const), FC.nat(), (roles, id) => {
        const selection = {version: 1, roles: Object.fromEntries(roles.map(role => [role, `model-${id}`]))};
        expect(parseModelSelection(JSON.stringify(selection))).toEqual({status: 'valid', selection});
      }),
      {numRuns: 100},
    );
  });

  it('matches an independent intent/owner model and makes stale completions inert through arbitrary command sequences', () => {
    FC.assert(
      FC.property(
        FC.array(FC.constantFrom('off', 'on', 'restart', 'claim', 'verify', 'ready', 'stale', 'failure'), {
          maxLength: 80,
        }),
        actions => {
          let state = initialModelSetupState(job);
          let epoch = 0;
          let allowed = true;
          let attempts = 0;
          let phase: ModelSetupPhase = 'pending';
          const historical: ModelSetupFence[] = [];
          for (const action of actions) {
            const previous = state;
            const previousSnapshot = structuredClone(state);
            const fence: ModelSetupFence = {intentEpoch: epoch, job, owner};
            if (action === 'off' || action === 'on') {
              const nextAllowed = action === 'on';
              if (allowed !== nextAllowed) {
                epoch += 1;
                attempts = 0;
                phase = nextAllowed ? 'pending' : 'off';
              }
              allowed = nextAllowed;
              state = transitionModelSetup(state, {type: 'policy', policy: allowed ? 'automatic' : 'off'});
            } else if (action === 'restart') {
              if (allowed) {
                epoch += 1;
                phase = 'pending';
              }
              state = transitionModelSetup(state, {type: 'request', job, restart: true});
            } else if (action === 'claim') {
              if (allowed && phase === 'pending') {
                phase = 'downloading';
                attempts += 1;
                historical.push(fence);
              }
              state = transitionModelSetup(state, {type: 'claim', ...fence});
            } else if (action === 'verify') {
              if (phase === 'downloading') phase = 'verifying';
              state = transitionModelSetup(state, {type: 'verifying', fence});
            } else if (action === 'ready') {
              if (phase === 'verifying') phase = 'ready';
              state = transitionModelSetup(state, {type: 'ready', fence, receipt});
            } else if (action === 'failure') {
              if (phase === 'downloading' || phase === 'verifying') phase = 'retry-wait';
              state = transitionModelSetup(state, {type: 'retry-wait', fence, reason: 'offline', nextAttemptAt: 42});
            } else {
              const stale = historical.find(candidate => candidate.intentEpoch !== epoch) ?? {
                ...fence,
                owner: {...owner, token: 'impostor'},
              };
              state = transitionModelSetup(state, {type: 'ready', fence: stale, receipt});
              expect(state).toBe(previous);
            }
            expect(state.intentEpoch).toBe(epoch);
            expect(state.intentEpoch).toBeGreaterThanOrEqual(previous.intentEpoch);
            expect(state.policy).toBe(allowed ? 'automatic' : 'off');
            expect(state.phase).toBe(phase);
            expect(state.attempts).toBe(attempts);
            expect(parseModelSetup(JSON.stringify(state))).toEqual({status: 'valid', state});
            expect(previous).toEqual(previousSnapshot);
          }
        },
      ),
      {numRuns: 150},
    );
  });

  it('rejects cross-home/model/revision/digest and process identity fences without mutating state', () => {
    FC.assert(
      FC.property(
        FC.constantFrom('home', 'modelId', 'revision', 'sha256', 'token', 'processId', 'processStartIdentity'),
        key => {
          const state = stateAt('verifying', 2, 1, 4);
          const copy = structuredClone(state);
          const fence: ModelSetupFence = {intentEpoch: 2, job, owner};
          const changed =
            key in job
              ? {...fence, job: {...job, [key]: `${job[key as keyof typeof job]}different`}}
              : {...fence, owner: {...owner, [key]: key === 'processId' ? 2 : 'different'}};
          expect(transitionModelSetup(state, {type: 'ready', fence: changed, receipt})).toBe(state);
          expect(state).toEqual(copy);
        },
      ),
      {numRuns: 75},
    );
  });
});
