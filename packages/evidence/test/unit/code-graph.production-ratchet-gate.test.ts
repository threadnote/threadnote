import {describe, expect, it} from 'vitest';
import {parseCodeGraphProductionRatchetGateArguments} from '../../../../tools/ci/code-graph-production-ratchet-gate.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph production ratchet gate', () => {
  it('requires an explicit paired control contract', () => {
    expect(
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
        '--expected-candidate-commit',
        Effect.pipe('b', EffectString.repeat(40)),
        '--expected-control-commit',
        Effect.pipe('a', EffectString.repeat(40)),
        '--initial-candidate',
        'initial-candidate.json',
      ]),
    ).toEqual({
      artifactPath: 'candidate.json',
      controlPath: 'control.json',
      expectedCandidateCommit: Effect.pipe('b', EffectString.repeat(40)),
      expectedControlCommit: Effect.pipe('a', EffectString.repeat(40)),
      initialCandidatePath: 'initial-candidate.json',
      ratchetPath: 'ratchet.json',
    });
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
      ]),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
        '--expected-candidate-commit',
        Effect.pipe('b', EffectString.repeat(40)),
        '--expected-control-commit',
        Effect.pipe('a', EffectString.repeat(40)),
      ]),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
        '--expected-candidate-commit',
        Effect.pipe('b', EffectString.repeat(40)),
      ]),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--unexpected',
        'value',
      ]),
    ).toThrow(/Unknown or incomplete/u);
  });
});
