import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  CodeMemoryLinkScaleProvenanceLive,
  verifyCodeMemoryLinkScaleProvenance,
} from '../../../../scripts/code-memory-link-scale-provenance.js';
import {parseScaleProvenanceArguments} from '../../../../scripts/verify-code-memory-link-scale-provenance.js';
import {CommandExecutor, CommandFailed} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
  CODE_MEMORY_LINK_SCALE_ATTEST_STEP,
  CODE_MEMORY_LINK_SCALE_CAPTURE_STEP,
  CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
  CODE_MEMORY_LINK_SCALE_GITHUB_JOB_NAME,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
  CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH,
  CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
  CODE_MEMORY_LINK_SCALE_SCENARIOS,
  codeMemoryLinkScaleAttestationSubjectV1,
  codeMemoryLinkScaleCandidateBindingV1,
  codeMemoryLinkScaleExpectedTruncatedSelectorCount,
  codeMemoryLinkScaleExpectedUris,
  evaluateCodeMemoryLinkScaleCapture,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const commit = Effect2.pipe('1', EffectString.repeat(40));
const repoUrl = `https://github.com/${CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY}`;
const ref = 'refs/heads/main';
const workflowUrl = `${repoUrl}/${CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH}@${ref}`;
const candidate = codeMemoryLinkScaleCandidateBindingV1(commit, {version: '5.0.0', packageManager: 'bun@1.4.2'});

describe('authenticated inverse scale provenance', () => {
  it('rejects binding files and alternate verification authorities at the executable boundary', () => {
    for (const option of ['--runner-binding', '--bundle', '--hostname', '--custom-trusted-root']) {
      expect(() => parseScaleProvenanceArguments([option, '/tmp/forged.json'])).toThrow('Unknown');
    }
  });

  effectIt.effect('verifies the exact capture digest, certificate, run and governed macOS job before promotion', () =>
    Effect.gen(function* () {
      const capture = fixture();
      expect(capture.evidenceClass).toBe('development-smoke');
      const calls: string[][] = [];
      const verified = yield* verifyCodeMemoryLinkScaleProvenance(capture, candidate).pipe(
        provideTestLayer(testLayer({calls})),
      );
      expect(verified.artifact.evidenceClass).toBe('release-scale');
      expect(verified.artifact.gate.passed).toBe(true);
      expect(codeMemoryLinkScaleAttestationSubjectV1(verified.artifact)).toBe(
        codeMemoryLinkScaleAttestationSubjectV1(capture),
      );
      const verify = EffectOption.getOrUndefined(EffectArray.findFirst(calls, args => args[0] === 'attestation'))!;
      expect(verify).toEqual(
        expect.arrayContaining([
          '--hostname',
          'github.com',
          '--deny-self-hosted-runners',
          '--source-digest',
          commit,
          '--signer-digest',
          '--signer-workflow',
        ]),
      );
      expect(verify).not.toContain('--bundle');
      expect(
        EffectArray.some(calls, args =>
          args.includes(
            `repos/${CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY}/actions/runs/123/attempts/2/jobs?per_page=100`,
          ),
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect('does not promote fabricated claims when cryptographic verification fails', () =>
    Effect.gen(function* () {
      const failure = yield* verifyCodeMemoryLinkScaleProvenance(fixture(), candidate).pipe(
        provideTestLayer(testLayer({unsigned: true})),
        Effect.flip,
      );
      expect(String(failure)).toContain('No valid signature');
    }),
  );

  effectIt.effect('rejects modified observations even with a certificate for the original capture', () =>
    Effect.gen(function* () {
      const capture = fixture();
      const originalHash = sha256HexSync(codeMemoryLinkScaleAttestationSubjectV1(capture));
      const tampered = {
        ...capture,
        capture: {...capture.capture, resources: {...capture.capture.resources, indexBuildMilliseconds: 12}},
      };
      const failure = yield* verifyCodeMemoryLinkScaleProvenance(tampered, candidate).pipe(
        provideTestLayer(testLayer({subjectHash: originalHash})),
        Effect.flip,
      );
      expect(String(failure)).toContain('does not bind this scale capture');
    }),
  );

  effectIt.effect('rejects mismatched signed identity fields and untrusted job metadata', () =>
    Effect.gen(function* () {
      for (const key of EffectRecord.keys(certificate())) {
        const failure = yield* verifyCodeMemoryLinkScaleProvenance(fixture(), candidate).pipe(
          provideTestLayer(testLayer({certificateOverride: {[key]: 'forged'}})),
          Effect.flip,
        );
        expect(String(failure)).toContain('does not bind this scale capture');
      }
      for (const jobOverride of [
        {labels: ['self-hosted', 'macos-15']},
        {labels: ['ubuntu-latest']},
        {run_attempt: 1},
        {steps: []},
        {conclusion: 'failure', status: 'completed'},
      ]) {
        const failure = yield* verifyCodeMemoryLinkScaleProvenance(fixture(), candidate).pipe(
          provideTestLayer(testLayer({jobOverride})),
          Effect.flip,
        );
        expect(String(failure)).toContain('does not establish the governed scale runner');
      }
      const failedRun = yield* verifyCodeMemoryLinkScaleProvenance(fixture(), candidate).pipe(
        provideTestLayer(testLayer({runOverride: {head_sha: Effect2.pipe('2', EffectString.repeat(40))}})),
        Effect.flip,
      );
      expect(String(failedRun)).toContain('does not establish the governed scale runner');
    }),
  );

  it('binds every observation to the attestation subject digest (property)', () => {
    const capture = fixture();
    const before = sha256HexSync(codeMemoryLinkScaleAttestationSubjectV1(capture));
    fc.assert(
      fc.property(fc.integer({min: 2, max: 1000}), value => {
        const altered = {
          ...capture,
          capture: {
            ...capture.capture,
            scenarios: EffectArray.map(capture.capture.scenarios, (scenario, index) =>
              index === 0
                ? {
                    ...scenario,
                    samples: EffectArray.map(scenario.samples, (sample, sampleIndex) =>
                      sampleIndex === 0 ? {...sample, milliseconds: value} : sample,
                    ),
                  }
                : scenario,
            ),
          },
        };
        expect(sha256HexSync(codeMemoryLinkScaleAttestationSubjectV1(altered))).not.toBe(before);
      }),
      {numRuns: 20},
    );
  });
});

function testLayer(options: {
  readonly calls?: string[][];
  readonly unsigned?: boolean;
  readonly subjectHash?: string;
  readonly certificateOverride?: Record<string, unknown>;
  readonly jobOverride?: Record<string, unknown>;
  readonly runOverride?: Record<string, unknown>;
}) {
  const command = Layer.effect(
    CommandExecutor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return CommandExecutor.of({
        execute: (executable, args) =>
          Effect.gen(function* () {
            expect(executable).toBe('gh');
            options.calls?.push([...args]);
            let body: unknown;
            if (args[0] === 'attestation') {
              if (options.unsigned)
                return yield* CommandFailed.make({
                  executable,
                  args,
                  exitCode: 1,
                  message: 'No valid signature',
                  stdout: '',
                  stderr: '',
                });
              const hash = options.subjectHash ?? sha256HexSync(yield* fs.readFileString(args[2]).pipe(Effect.orDie));
              body = [
                {
                  verificationResult: {
                    signature: {certificate: {...certificate(), ...options.certificateOverride}},
                    statement: {subject: [{digest: {sha256: hash}}]},
                  },
                },
              ];
            } else if (Effect2.pipe(args[3], EffectString.includes('/jobs?'))) {
              body = {
                total_count: 1,
                jobs: [
                  {
                    name: CODE_MEMORY_LINK_SCALE_GITHUB_JOB_NAME,
                    run_id: 123,
                    run_attempt: 2,
                    head_sha: commit,
                    labels: ['macos-15'],
                    status: 'in_progress',
                    conclusion: null,
                    steps: EffectArray.map(
                      [CODE_MEMORY_LINK_SCALE_CAPTURE_STEP, CODE_MEMORY_LINK_SCALE_ATTEST_STEP],
                      name => ({
                        name,
                        status: 'completed',
                        conclusion: 'success',
                      }),
                    ),
                    ...options.jobOverride,
                  },
                ],
              };
            } else {
              body = {
                id: 123,
                run_attempt: 2,
                head_sha: commit,
                event: 'workflow_dispatch',
                path: CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH,
                repository: {
                  id: Number(CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID),
                  full_name: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
                },
                ...options.runOverride,
              };
            }
            return {exitCode: 0, stdout: JSON.stringify(body), stderr: ''};
          }),
        executeStreaming: () => Effect.die('Unexpected streaming command'),
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
  return CodeMemoryLinkScaleProvenanceLive.pipe(Layer.provide(Layer.merge(BunServices.layer, command)));
}

function certificate() {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    sourceRepositoryURI: repoUrl,
    sourceRepositoryIdentifier: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
    sourceRepositoryDigest: commit,
    sourceRepositoryRef: ref,
    buildSignerURI: workflowUrl,
    buildSignerDigest: commit,
    buildConfigURI: workflowUrl,
    buildConfigDigest: commit,
    buildTrigger: 'workflow_dispatch',
    runInvocationURI: `${repoUrl}/actions/runs/123/attempts/2`,
    runnerEnvironment: 'github-hosted',
  };
}

function fixture() {
  return evaluateCodeMemoryLinkScaleCapture({
    budget: CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
    candidateBinding: candidate,
    createdAt: '2026-08-29T00:00:00.000Z',
    identity: {
      ...candidate,
      observedCommit: commit,
      dirty: false,
      gitStatusObserved: true,
      builtArtifactSha256: Effect2.pipe('2', EffectString.repeat(64)),
      invocationMode: 'release-scale',
      architecture: 'arm64',
      cpu: 'Apple M1',
      operatingSystem: 'macOS 15.0',
      memoryBytes: 16 * 1024 ** 3,
      runnerClass: CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
      runnerArchitecture: 'ARM64',
      runnerEnvironment: 'github-hosted',
      runnerOperatingSystem: 'macOS',
      github: {
        actions: true,
        eventName: 'workflow_dispatch',
        job: CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
        ref,
        repository: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
        repositoryId: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
        runId: 123,
        runAttempt: 2,
        sha: commit,
        workflowSha: commit,
        workflowRef: Effect2.pipe(workflowUrl, EffectString.slice('https://github.com/'.length)),
      },
    },
    capture: {
      fixtureHash: CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
      corpus: {
        corpusBytes: 10000,
        denseBacklinkMemoryCount: 99996,
        directBacklinkMemoryCount: 3,
        indexedMemoryCount: 100000,
        isolationDecoyMemoryCount: 1,
        materializedMemoryCount: 100000,
        noiseMemoryCount: 99996,
      },
      resources: {
        addedPeakRssBytes: 100,
        baselineRssBytes: 100,
        peakRssBytes: 200,
        indexBuildMilliseconds: 10,
        materializationMilliseconds: 10,
        recallDatabaseBytes: 100,
        recallStorageBytes: 200,
      },
      scenarios: EffectArray.map(CODE_MEMORY_LINK_SCALE_SCENARIOS, id => {
        const expectedUris = codeMemoryLinkScaleExpectedUris(id);
        const expectedTruncatedSelectorCount = codeMemoryLinkScaleExpectedTruncatedSelectorCount(id);
        const observation = {
          canonicalMismatchCount: 0,
          milliseconds: 1,
          returnedUris: expectedUris,
          truncatedSelectorCount: expectedTruncatedSelectorCount,
        };
        return {
          id,
          cold: observation,
          expectedUris,
          expectedTruncatedSelectorCount,
          samples: Array.from({length: 25}, () => observation),
          warmups: Array.from({length: 5}, () => observation),
        };
      }),
    },
  });
}
