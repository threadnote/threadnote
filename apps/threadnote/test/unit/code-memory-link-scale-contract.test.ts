import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  parseCodeMemoryLinkScaleTargetArguments,
  identityFromEnvironment,
} from '../../../../scripts/benchmark-code-memory-link-scale-target.js';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
  CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
  CODE_MEMORY_LINK_SCALE_LEGACY_GITHUB_REPOSITORY,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
  CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
  CODE_MEMORY_LINK_SCALE_SCENARIOS,
  codeMemoryLinkScaleCandidateBindingV1,
  codeMemoryLinkScaleExpectedTruncatedSelectorCount,
  codeMemoryLinkScaleExpectedUris,
  codeMemoryLinkScaleFixtureHash,
  codeMemoryLinkScaleReleaseIdentityFailures,
  evaluateCodeMemoryLinkScaleCapture,
  parseCodeMemoryLinkScaleArtifactV1,
  parseCodeMemoryLinkScaleBudgetV1,
  type CodeMemoryLinkScaleIdentityV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const BUDGET_FILE = 'apps/threadnote/test/evaluation/baselines/code-memory-link-scale-v1/budget.json';
const budget = parseCodeMemoryLinkScaleBudgetV1(JSON.parse(await Bun.file(BUDGET_FILE).text()) as unknown);

describe('code-memory-link inverse-selector scale contract', () => {
  it('does not accept a caller-manufactured runner binding file as release authority', () => {
    expect(() =>
      parseCodeMemoryLinkScaleTargetArguments([
        '--candidate-commit',
        Effect.pipe('1', EffectString.repeat(40)),
        '--runner-binding',
        '/tmp/forged.json',
      ]),
    ).toThrow('Unknown');
  });
  it('requires external runner facts and rejects changed run identity before replay', () => {
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    expect(() => parseCodeMemoryLinkScaleArtifactV1(artifact, budget, releaseBinding())).toThrow(
      'independently supplied runner binding',
    );
    const selfAttested = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      capture: artifact.capture,
      createdAt: artifact.createdAt,
      identity: artifact.identity,
    });
    expect(selfAttested.evidenceClass).toBe('development-smoke');
    expect(selfAttested.gate.passed).toBe(false);
    for (const key of EffectRecord.keys(releaseRunnerBinding().github)) {
      const expected = releaseRunnerBinding();
      const value = expected.github[key];
      const changed = {
        ...expected,
        github: {
          ...expected.github,
          [key]: typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${value}-other`,
        },
      };
      expect(() => parseCodeMemoryLinkScaleArtifactV1(artifact, budget, releaseBinding(), changed)).toThrow();
    }
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1(artifact, budget, releaseBinding(), {
        ...releaseRunnerBinding(),
        runnerClass: 'local',
      }),
    ).toThrow();
  });

  it('rejects arbitrary fast sample or warmup padding before computing metrics', () => {
    fc.assert(
      fc.property(fc.constantFrom('samples', 'warmups'), fc.integer({min: 1, max: 50}), (kind, extra) => {
        const capture = releaseCapture();
        const scenario = capture.scenarios[0];
        scenario[kind] = [
          ...scenario[kind],
          ...Array.from({length: extra}, () => observation(scenario.expectedUris, 0)),
        ];
        for (const invocationMode of ['release-scale', 'development-smoke'] as const) {
          expect(() =>
            evaluateCodeMemoryLinkScaleCapture({
              budget,
              candidateBinding: releaseBinding(),
              runnerBinding: releaseRunnerBinding(),
              capture,
              createdAt: '2026-08-29T00:00:00.000Z',
              identity: {...releaseIdentity(), invocationMode},
            }),
          ).toThrow('count');
        }
      }),
      {numRuns: 40},
    );
  });

  it('fails closed for absent or malformed raw release run IDs and SHAs', () => {
    for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA']) {
      for (const bad of [undefined, '', 'not-valid', '0', '1.5']) {
        const environment = {
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_SHA: Effect.pipe('1', EffectString.repeat(40)),
          GITHUB_WORKFLOW_SHA: Effect.pipe('1', EffectString.repeat(40)),
          [key]: bad,
        };
        const input = {
          builtArtifactSha256: Effect.pipe('2', EffectString.repeat(64)),
          candidateBinding: releaseBinding(),
          candidateCommit: Effect.pipe('1', EffectString.repeat(40)),
          dirty: false,
          gitStatusObserved: true,
          hardware: {cpuModel: 'Apple M1', memoryBytes: 1024, operatingSystem: 'macOS 15'},
          invocationMode: 'release-scale' as const,
          observedCommit: Effect.pipe('1', EffectString.repeat(40)),
          sourceVersion: '4.6.0',
          system: {architecture: 'arm64', environment: () => environment, platform: 'darwin', runtimeVersion: '1.3.9'},
        };
        expect(() => identityFromEnvironment(input)).toThrow(key);
        expect(() => identityFromEnvironment({...input, invocationMode: 'development-smoke'})).not.toThrow();
      }
    }
  });

  it('bounds explicit development observation overrides', () => {
    for (const [option, value] of [
      ['--samples', '26'],
      ['--warmups', '6'],
    ]) {
      expect(() =>
        parseCodeMemoryLinkScaleTargetArguments([
          '--candidate-commit',
          Effect.pipe('1', EffectString.repeat(40)),
          '--development-smoke',
          option,
          value,
        ]),
      ).toThrow('maximum');
    }
  });
  it('pins the exact governed 100k release shape and fixed CLI defaults', () => {
    expect(budget).toEqual(CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET);
    expect(codeMemoryLinkScaleFixtureHash()).toBe(CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH);
    expect(
      parseCodeMemoryLinkScaleTargetArguments([
        '--candidate-commit',
        Effect.pipe('1', EffectString.repeat(40)),
        '--built-artifact-sha256',
        Effect.pipe('2', EffectString.repeat(64)),
      ]),
    ).toMatchObject({
      candidateCommit: Effect.pipe('1', EffectString.repeat(40)),
      developmentSmoke: false,
      memoryCandidates: 100_000,
      samples: 25,
      warmups: 5,
    });
    expect(() =>
      parseCodeMemoryLinkScaleTargetArguments([
        '--candidate-commit',
        Effect.pipe('1', EffectString.repeat(40)),
        '--memory-candidates',
        '99999',
      ]),
    ).toThrow('require --development-smoke');
  });

  it('passes exact candidate identity, correctness, no-answer, direct-first, and resource budgets', () => {
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });

    expect(artifact.evidenceClass).toBe('release-scale');
    expect(artifact.gate).toEqual({failures: [], passed: true});
    expect(artifact.metrics).toMatchObject({
      boundedResultAccuracy: 1,
      canonicalMismatchCount: 0,
      directFirstRate: 1,
      directPrecision: 1,
      directRecall: 1,
      duplicateResultCount: 0,
      maximumReturnedMemories: 8,
      noAnswerAccuracy: 1,
      truncatedSelectorCount: 62,
      unexpectedResultCount: 0,
      warmupCountMinimum: 5,
    });
    expect(artifact.metrics.lookupMilliseconds.samples).toBe(100);
    expect(
      parseCodeMemoryLinkScaleArtifactV1(
        JSON.parse(JSON.stringify(artifact)),
        budget,
        releaseBinding(),
        releaseRunnerBinding(),
      ),
    ).toEqual(artifact);
  });

  it('accepts legacy-repository evidence only when the workflow ref moves with it', () => {
    const baselineIdentity = releaseIdentity();
    const workflowRef = `${CODE_MEMORY_LINK_SCALE_LEGACY_GITHUB_REPOSITORY}/.github/workflows/benchmarks.yml@refs/heads/release/5.0.0`;
    const identity = {
      ...baselineIdentity,
      github: {
        ...baselineIdentity.github,
        repository: CODE_MEMORY_LINK_SCALE_LEGACY_GITHUB_REPOSITORY,
        workflowRef,
      },
    };
    const baselineRunnerBinding = releaseRunnerBinding();
    const runnerBinding = {
      ...baselineRunnerBinding,
      github: {
        ...baselineRunnerBinding.github,
        repository: CODE_MEMORY_LINK_SCALE_LEGACY_GITHUB_REPOSITORY,
        workflowRef,
      },
    };

    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding,
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity,
    });

    expect(artifact.gate.failures).not.toContainEqual(expect.stringContaining('GitHub repository'));
    expect(artifact.gate.failures).not.toContain(
      'GitHub workflow ref does not identify the governed benchmarks workflow at the claimed ref',
    );
  });

  it('cannot relabel a small or dirty run as release-scale evidence', () => {
    const explicitSmoke = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: {...releaseIdentity(), invocationMode: 'development-smoke'},
    });
    expect(explicitSmoke.evidenceClass).toBe('development-smoke');
    expect(explicitSmoke.gate.failures).toContain('invocation mode is development-smoke');

    const smoke = releaseCapture();
    smoke.corpus.materializedMemoryCount = 1_000;
    smoke.corpus.indexedMemoryCount = 1_000;
    smoke.corpus.denseBacklinkMemoryCount = 996;
    smoke.corpus.noiseMemoryCount = 996;
    for (const scenario of smoke.scenarios) {
      scenario.warmups = scenario.warmups.slice(0, 1);
      scenario.samples = scenario.samples.slice(0, 3);
    }
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture: smoke,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: {...releaseIdentity(), dirty: true, invocationMode: 'development-smoke'},
    });
    expect(artifact.evidenceClass).toBe('development-smoke');
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toEqual(
      expect.arrayContaining([
        'artifact is a development smoke, not release-scale evidence',
        'candidate checkout is dirty; required dirty=false',
        'indexed memory corpus 1000; required 100000',
        'materialized memory corpus 1000; required 100000',
      ]),
    );
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1(
        {...artifact, evidenceClass: 'release-scale'},
        budget,
        releaseBinding(),
        releaseRunnerBinding(),
      ),
    ).toThrow('evidence class is not derived correctly');
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1(
        {...artifact, execution: {...artifact.execution, inverseLookup: 'toy-array'}},
        budget,
        releaseBinding(),
        releaseRunnerBinding(),
      ),
    ).toThrow('execution path does not match');
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1(
        {...artifact, metrics: {...artifact.metrics, directRecall: 0}},
        budget,
        releaseBinding(),
        releaseRunnerBinding(),
      ),
    ).toThrow('metrics do not match');
  });

  it('fails closed when release-scale evidence is relabeled from another runner class', () => {
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: {...releaseIdentity(), runnerClass: 'local-unpinned'},
    });

    expect(artifact.evidenceClass).toBe('development-smoke');
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toContain(
      `runner class local-unpinned; required ${CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS}`,
    );
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1(
        {...artifact, evidenceClass: 'release-scale'},
        budget,
        releaseBinding(),
        releaseRunnerBinding(),
      ),
    ).toThrow('runnerClass differs from the trusted runner binding');
  });

  it('requires independently derived candidate facts and rejects every release-provenance relabel', () => {
    const capture = releaseCapture();
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    expect(() => parseCodeMemoryLinkScaleArtifactV1(artifact, budget)).toThrow(
      'independently derived candidate binding',
    );
    expect(capture).toEqual(releaseCapture());

    fc.assert(
      fc.property(
        fc.constantFrom<
          | 'candidateVersion'
          | 'cpu'
          | 'github.actions'
          | 'github.eventName'
          | 'github.job'
          | 'github.repository'
          | 'github.repositoryId'
          | 'github.sha'
          | 'github.workflowRef'
          | 'github.workflowSha'
          | 'gitStatusObserved'
          | 'packageManager'
          | 'runnerArchitecture'
          | 'runnerEnvironment'
          | 'runnerOperatingSystem'
          | 'runtime'
          | 'sourceVersion'
        >(
          'candidateVersion',
          'cpu',
          'github.actions',
          'github.eventName',
          'github.job',
          'github.repository',
          'github.repositoryId',
          'github.sha',
          'github.workflowRef',
          'github.workflowSha',
          'gitStatusObserved',
          'packageManager',
          'runnerArchitecture',
          'runnerEnvironment',
          'runnerOperatingSystem',
          'runtime',
          'sourceVersion',
        ),
        key => {
          const identity = releaseIdentity();
          const tampered = Effect.pipe(key, EffectString.startsWith('github.'))
            ? {
                ...identity,
                github: {
                  ...identity.github,
                  [Effect.pipe(key, EffectString.slice('github.'.length))]:
                    key === 'github.actions' ? false : 'tampered',
                },
              }
            : ({
                ...identity,
                [key]: key === 'gitStatusObserved' ? false : 'tampered',
              } as CodeMemoryLinkScaleIdentityV1);
          expect(
            codeMemoryLinkScaleReleaseIdentityFailures(tampered, releaseBinding(), releaseRunnerBinding()).length,
          ).toBeGreaterThan(0);
        },
      ),
      {numRuns: 40},
    );
  });

  it('fails on a no-answer leak, repository-isolation decoy, duplicate, or canonical mismatch', () => {
    const capture = releaseCapture();
    const noAnswer = EffectOption.getOrUndefined(
      EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'no-answer'),
    )!;
    noAnswer.samples[0] = observation(['threadnote://user/inverse-scale/memories/leaked.md'], 10, 1);
    const file = EffectOption.getOrUndefined(
      EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'file-backlinks'),
    )!;
    file.samples[0] = observation([file.expectedUris[0], file.expectedUris[0], 'threadnote://foreign/decoy.md']);
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });

    expect(artifact.gate.passed).toBe(false);
    expect(artifact.metrics).toMatchObject({
      canonicalMismatchCount: 1,
      duplicateResultCount: 1,
      unexpectedResultCount: 2,
    });
    expect(artifact.metrics.noAnswerAccuracy).toBeLessThan(1);
    expect(artifact.gate.failures).toEqual(
      expect.arrayContaining([
        'canonical selector mismatches 1; required 0',
        'duplicate selector results 1; required 0',
        'unexpected selector results 2; required 0',
      ]),
    );
  });

  it('does not let retained observations redefine frozen URI truth', () => {
    const capture = releaseCapture();
    capture.scenarios[0].expectedUris = ['threadnote://foreign/decoy.md'];
    capture.scenarios[0].cold.returnedUris = ['threadnote://foreign/decoy.md'];
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toContain('file-backlinks expected URI truth does not match the frozen fixture');
  });

  it('requires the frozen dense scenario to observe bounded shadow-search abstention', () => {
    const capture = releaseCapture();
    const dense = EffectOption.getOrUndefined(
      EffectArray.findFirst(capture.scenarios, scenario => scenario.id === 'dense-shared-selector'),
    )!;
    dense.samples[0].truncatedSelectorCount = 0;
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toContain(
      'dense-shared-selector must report exactly 2 bounded selector truncations per lookup',
    );
  });

  it('keeps metrics invariant under measured-sample order', () => {
    const capture = releaseCapture();
    const expected = evaluateCodeMemoryLinkScaleCapture({
      budget,
      candidateBinding: releaseBinding(),
      runnerBinding: releaseRunnerBinding(),
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    fc.assert(
      fc.property(fc.shuffledSubarray([...Array(25).keys()], {maxLength: 25, minLength: 25}), order => {
        const permuted = releaseCapture();
        for (const scenario of permuted.scenarios) {
          scenario.samples = EffectArray.map(order, index => scenario.samples[index]);
        }
        const actual = evaluateCodeMemoryLinkScaleCapture({
          budget,
          candidateBinding: releaseBinding(),
          runnerBinding: releaseRunnerBinding(),
          capture: permuted,
          createdAt: '2026-08-29T00:00:00.000Z',
          identity: releaseIdentity(),
        });
        expect(actual.metrics).toEqual(expected.metrics);
        expect(actual.gate).toEqual(expected.gate);
      }),
      {numRuns: 40},
    );
  });

  it.each([
    ['corpusMemoryCount', 99_999],
    ['denseBacklinkMemoryCount', 99_995],
    ['minimumSamples', 24],
    ['minimumWarmups', 4],
    ['maximumLookupP95Milliseconds', 251],
    ['maximumAddedPeakRssBytes', CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.maximumAddedPeakRssBytes + 1],
    ['maximumRecallStorageBytes', CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.maximumRecallStorageBytes + 1],
  ] as const)('rejects a weakened %s budget', (key, value) => {
    expect(() => parseCodeMemoryLinkScaleBudgetV1({...budget, [key]: value})).toThrow(`budget ${key}`);
  });
});

function releaseRunnerBinding() {
  const identity = releaseIdentity();
  return {
    github: identity.github,
    runnerClass: identity.runnerClass,
    runnerArchitecture: identity.runnerArchitecture,
    runnerEnvironment: identity.runnerEnvironment,
    runnerOperatingSystem: identity.runnerOperatingSystem,
  };
}

function releaseIdentity(): CodeMemoryLinkScaleIdentityV1 {
  return {
    architecture: 'arm64',
    builtArtifactSha256: Effect.pipe('2', EffectString.repeat(64)),
    candidateCommit: Effect.pipe('1', EffectString.repeat(40)),
    candidateVersion: '5.0.0',
    cpu: 'Apple M1',
    dirty: false,
    gitStatusObserved: true,
    github: {
      actions: true,
      eventName: 'workflow_dispatch',
      job: CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
      ref: 'refs/heads/release/5.0.0',
      repository: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
      repositoryId: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
      runAttempt: 1,
      runId: 1,
      sha: Effect.pipe('1', EffectString.repeat(40)),
      workflowRef: `${CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY}/.github/workflows/benchmarks.yml@refs/heads/release/5.0.0`,
      workflowSha: Effect.pipe('1', EffectString.repeat(40)),
    },
    invocationMode: 'release-scale',
    memoryBytes: 64 * 1024 * 1024 * 1024,
    observedCommit: Effect.pipe('1', EffectString.repeat(40)),
    operatingSystem: 'macOS 15.0',
    packageManager: 'bun@1.4.2',
    runnerClass: CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
    runnerArchitecture: 'ARM64',
    runnerEnvironment: 'github-hosted',
    runnerOperatingSystem: 'macOS',
    runtime: 'bun/1.4.2',
    sourceVersion: 'threadnote-5.0.0',
  };
}

function releaseBinding() {
  return codeMemoryLinkScaleCandidateBindingV1(Effect.pipe('1', EffectString.repeat(40)), {
    packageManager: 'bun@1.4.2',
    version: '5.0.0',
  });
}

function releaseCapture() {
  const fileUris = codeMemoryLinkScaleExpectedUris('file-backlinks');
  const symbolUris = codeMemoryLinkScaleExpectedUris('symbol-backlink');
  const denseUris = codeMemoryLinkScaleExpectedUris('dense-shared-selector');
  return {
    corpus: {
      corpusBytes: 32 * 1024 * 1024,
      denseBacklinkMemoryCount: 99_996,
      directBacklinkMemoryCount: 3,
      indexedMemoryCount: 100_000,
      isolationDecoyMemoryCount: 1,
      materializedMemoryCount: 100_000,
      noiseMemoryCount: 99_996,
    },
    fixtureHash: CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
    resources: {
      addedPeakRssBytes: 1024 * 1024 * 1024,
      baselineRssBytes: 128 * 1024 * 1024,
      indexBuildMilliseconds: 90_000,
      materializationMilliseconds: 20_000,
      peakRssBytes: 1152 * 1024 * 1024,
      recallDatabaseBytes: 300 * 1024 * 1024,
      recallStorageBytes: 320 * 1024 * 1024,
    },
    scenarios: [
      scenario('file-backlinks', fileUris, 1),
      scenario('symbol-backlink', symbolUris, 2),
      scenario('dense-shared-selector', denseUris, 3),
      scenario('no-answer', [], 4),
    ],
  };
}

function scenario(id: (typeof CODE_MEMORY_LINK_SCALE_SCENARIOS)[number], uris: readonly string[], offset: number) {
  const truncatedSelectorCount = codeMemoryLinkScaleExpectedTruncatedSelectorCount(id);
  return {
    cold: observation(uris, offset, 0, truncatedSelectorCount),
    expectedTruncatedSelectorCount: truncatedSelectorCount,
    expectedUris: [...uris],
    id,
    samples: Array.from({length: 25}, (_, index) => observation(uris, index + 1 + offset, 0, truncatedSelectorCount)),
    warmups: Array.from({length: 5}, (_, index) => observation(uris, index + offset, 0, truncatedSelectorCount)),
  };
}

function observation(
  returnedUris: readonly string[],
  milliseconds = 10,
  canonicalMismatchCount = 0,
  truncatedSelectorCount = 0,
) {
  return {canonicalMismatchCount, milliseconds, returnedUris: [...returnedUris], truncatedSelectorCount};
}
