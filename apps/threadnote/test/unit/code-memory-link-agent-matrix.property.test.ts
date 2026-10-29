import {Array as EffectArray} from 'effect';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {createCodeMemoryLinkAgentSuiteCorpusV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-suite';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  parseCodeMemoryLinkSealedSuiteV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkClientArgumentVectorHash,
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientPathDigest,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {
  assembleCalibrationPlanV1,
  codeMemoryLinkAgentPreparedMemoryDirectory,
  type CodeMemoryLinkPreparedClientV1,
  type CodeMemoryLinkPreparedTaskV1,
} from '../../../../scripts/prepare-code-memory-link-agent-ab.js';
import {
  assertCodeMemoryLinkCalibrationPrefixV1,
  boundedCodeMemoryLinkChildFailureDiagnostic,
  calibrationResultDigest,
  codeMemoryLinkReleaseRunnerEnvironment,
  codeMemoryLinkReleaseLedgerPathsV1,
  createCalibrationResult,
  materializeCodeMemoryLinkCalibrationSandboxV1,
  parseCalibrationPlan,
  parseCodeMemoryLinkCalibrationResultsJsonl,
  releaseInvocationArguments,
  resolveCodeMemoryLinkAgentTrialRunner,
  type CodeMemoryLinkCalibrationResultV1,
} from '../../../../scripts/run-code-memory-link-agent-matrix.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Code Memory Link sequential matrix', () => {
  it('accepts only the canonical complete calibration schedule regardless of the chosen swapped positions', () => {
    const plan = calibrationPlan();
    expect(parseCalibrationPlan(plan)).toEqual(plan);

    fc.assert(
      fc.property(
        fc.integer({min: 0, max: plan.runs.length - 1}),
        fc.integer({min: 0, max: plan.runs.length - 2}),
        (left, compressedRight) => {
          const right = compressedRight >= left ? compressedRight + 1 : compressedRight;
          const runs = [...plan.runs];
          [runs[left], runs[right]] = [runs[right], runs[left]];
          expect(() => parseCalibrationPlan({...plan, runs})).toThrow('canonical non-outcome-dependent order');
        },
      ),
      {numRuns: 60},
    );
  });

  it('chains only the exact frozen calibration prefix and cannot parse as a release suite', () => {
    const plan = parseCalibrationPlan(calibrationPlan());
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[0-9a-f]{64}$/u), {minLength: 0, maxLength: 12}), diagnostics => {
        const bounded = diagnostics.slice(0, plan.runs.length);
        const initialResults: CodeMemoryLinkCalibrationResultV1[] = [];
        const results = EffectArray.reduce(bounded, initialResults, (prior, diagnosticsHash, index) => {
          const previousResultDigest = index === 0 ? null : calibrationResultDigest(prior[index - 1]);
          const run = plan.runs[index];
          prior.push(
            createCalibrationResult(
              plan,
              run,
              {
                arm: run.arm,
                clientId: run.clientId,
                diagnosticsHash,
                kind: 'non-evidence-calibration',
                planHash: plan.planHash,
                runOrder: run.runOrder,
                taskId: run.taskId,
                version: 1,
              },
              previousResultDigest,
            ),
          );
          return prior;
        });
        const parsed = parseCodeMemoryLinkCalibrationResultsJsonl(
          results.length === 0
            ? ''
            : `${EffectArray.join(
                EffectArray.map(results, result => JSON.stringify(result)),
                '\n',
              )}\n`,
        );
        expect(parsed).toEqual(results);
        expect(() => assertCodeMemoryLinkCalibrationPrefixV1(plan, parsed)).not.toThrow();
      }),
      {numRuns: 50},
    );
    expect(() => parseCodeMemoryLinkSealedSuiteV1(plan)).toThrow();
  });

  it('passes the canonical evidence sibling to the exact trial runner exactly once', () => {
    const root = '/tmp/code-memory-link-prepared';
    const trials = '/tmp/code-memory-link-results/trials.jsonl';
    const evidence = `${trials}.evidence.jsonl`;
    const arguments_ = releaseInvocationArguments({
      client: preparedClient(),
      options: {
        approvalCommit: Effect.pipe('7', EffectString.repeat(40)),
        attemptsPath: `${trials}.attempts.jsonl`,
        candidateCommit: Effect.pipe('8', EffectString.repeat(40)),
        candidateExecutable: '/opt/threadnote/4.6.0/threadnote',
        candidateExecutableSha256: Effect.pipe('9', EffectString.repeat(64)),
        evidencePath: evidence,
        mode: 'release',
        pacingMilliseconds: 0,
        root,
        timeoutMilliseconds: 1_000,
        trialsPath: trials,
      },
      root,
      runnerScript: '/src/trial.ts',
    });
    const evidenceIndex = arguments_.indexOf('--evidence');
    expect(evidenceIndex).toBeGreaterThan(0);
    expect(arguments_[evidenceIndex + 1]).toBe(evidence);
    expect(EffectArray.filter(arguments_, argument => argument === '--evidence')).toHaveLength(1);
  });

  it('projects arbitrary verified install roots into the exact trusted runner environment', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u), {minLength: 1, maxLength: 5}), segments => {
        const installRoot = `/private/${EffectArray.join(segments, '/')}`;

        expect(codeMemoryLinkReleaseRunnerEnvironment(installRoot)).toEqual({
          HOME: '/nonexistent',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          PATH: '/usr/bin:/bin',
          THREADNOTE_INSTALL_ROOT: installRoot,
          TMPDIR: '/tmp',
        });
      }),
      {numRuns: 60},
    );
    expect(() => codeMemoryLinkReleaseRunnerEnvironment('relative/threadnote')).toThrow(
      'must be a normalized absolute path',
    );
  });

  it('retains bounded stdout-only Effect failures and both child streams', () => {
    const stdoutOnly = boundedCodeMemoryLinkChildFailureDiagnostic({
      stderr: '',
      stdout: 'The managed Threadnote active release pointer is missing or invalid.',
    });
    expect(stdoutOnly).toContain('stdout:');
    expect(stdoutOnly).toContain('active release pointer is missing or invalid');
    expect(boundedCodeMemoryLinkChildFailureDiagnostic({stderr: '', stdout: ''})).toBe(
      '(child produced no stdout or stderr)',
    );

    fc.assert(
      fc.property(fc.string({maxLength: 5_000}), fc.string({maxLength: 5_000}), (stderr, stdout) => {
        const diagnostic = boundedCodeMemoryLinkChildFailureDiagnostic({stderr, stdout});
        expect(diagnostic.length).toBeLessThanOrEqual(2_048);
        if (stderr) expect(diagnostic).toContain('stderr:');
        if (stdout) expect(diagnostic).toContain('stdout:');
      }),
      {numRuns: 60},
    );

    fc.assert(
      fc.property(fc.string({maxLength: 5_000}), fc.string({maxLength: 5_000}), (stderr, stdout) => {
        const stderrTail = 'stderr-tail-marker';
        const stdoutTail = 'stdout-tail-marker';
        const diagnostic = boundedCodeMemoryLinkChildFailureDiagnostic({
          stderr: `${stderr}${stderrTail}`,
          stdout: `${stdout}${stdoutTail}`,
        });
        expect(diagnostic).toContain(stderrTail);
        expect(diagnostic).toContain(stdoutTail);
        expect(diagnostic.length).toBeLessThanOrEqual(2_048);
      }),
      {numRuns: 60},
    );
  });

  it('resolves the matrix trial runner through the same canonical file check used by release execution', async () => {
    await expect(resolveCodeMemoryLinkAgentTrialRunner()).resolves.toBe(
      await realpath(join(process.cwd(), 'scripts/run-code-memory-link-agent-trial.ts')),
    );
  });

  it('derives the pending commit beside canonical outside-root release ledgers', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,24}$/u), name => {
        const trialsPath = `/private/results/${name}.jsonl`;
        expect(
          codeMemoryLinkReleaseLedgerPathsV1({
            attemptsPath: `${trialsPath}.attempts.jsonl`,
            evidencePath: `${trialsPath}.evidence.jsonl`,
            preparedRoot: '/private/prepared',
            trialsPath,
          }),
        ).toEqual({
          attemptsPath: `${trialsPath}.attempts.jsonl`,
          evidencePath: `${trialsPath}.evidence.jsonl`,
          pendingPath: `${trialsPath}.pending.json`,
          trialsPath,
        });
      }),
      {numRuns: 60},
    );
    expect(() =>
      codeMemoryLinkReleaseLedgerPathsV1({
        attemptsPath: '/private/prepared/trials.jsonl.attempts.jsonl',
        evidencePath: '/private/prepared/trials.jsonl.evidence.jsonl',
        preparedRoot: '/private/prepared',
        trialsPath: '/private/prepared/trials.jsonl',
      }),
    ).toThrow('outside');
  });

  it('materializes calibration into a workspace with no release suite or rubric bytes', async () => {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const assembly = assembleCalibrationPlanV1({
      clients: [`cli_${Effect.pipe('1', EffectString.repeat(32))}`, `cli_${Effect.pipe('2', EffectString.repeat(32))}`],
      tasks: EffectArray.map(corpus.calibrationTasks, preparedTask),
    });
    const preparedRoot = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-calibration-prepared-')));
    let sandbox: string | null = null;
    try {
      for (const [relativePath, content] of assembly.files) {
        const destination = join(preparedRoot, relativePath);
        await mkdir(dirname(destination), {recursive: true});
        await writeFile(destination, content);
      }
      await writeFile(join(preparedRoot, 'calibration/plan.json'), `${JSON.stringify(assembly.plan, null, 2)}\n`);
      await writeFile(join(preparedRoot, 'suite.json'), 'release-private-rubric-sentinel\n');

      sandbox = await materializeCodeMemoryLinkCalibrationSandboxV1(preparedRoot, assembly.plan);
      await expect(readFile(join(sandbox, 'suite.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      expect(await readFile(join(sandbox, 'calibration/plan.json'), 'utf8')).not.toContain(
        'release-private-rubric-sentinel',
      );
      const firstFixture = assembly.plan.fixtureFiles[0];
      expect(await readFile(join(sandbox, firstFixture.source), 'utf8')).toBe(
        await readFile(join(preparedRoot, firstFixture.source), 'utf8'),
      );
    } finally {
      await Promise.all([
        rm(preparedRoot, {force: true, recursive: true}),
        ...(sandbox === null ? [] : [rm(sandbox, {force: true, recursive: true})]),
      ]);
    }
  });
});

function calibrationPlan() {
  const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
  return assembleCalibrationPlanV1({
    clients: [`cli_${Effect.pipe('1', EffectString.repeat(32))}`, `cli_${Effect.pipe('2', EffectString.repeat(32))}`],
    tasks: EffectArray.map(corpus.calibrationTasks, preparedTask),
  }).plan;
}

function preparedTask(
  definition: ReturnType<typeof createCodeMemoryLinkAgentSuiteCorpusV1>['calibrationTasks'][number],
): CodeMemoryLinkPreparedTaskV1 {
  const citationDigests = EffectArray.map(
    EffectArray.filter(definition.memorySeeds, seed => seed.citationPath !== null),
    (_, index) => digest(`${definition.taskId}:citation:${index}`),
  ).sort();
  return {
    citationDigests,
    definition,
    homeFiles: EffectArray.map(definition.memorySeeds, (seed, index) => ({
      content: `task=${definition.taskId}_${index}\n`,
      destination: `${codeMemoryLinkAgentPreparedMemoryDirectory(seed.status)}/${definition.taskId}-${index}.md`,
    })),
    preflightExpectedCitationDigests: citationDigests,
    preflightExpectedResponses: expectedResponses(),
    preflightExpectedSelectedMemories: [],
  };
}

function expectedResponses(): CodeMemoryLinkPreparedTaskV1['preflightExpectedResponses'] {
  return {
    anchored: canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version: 3,
    }).receipt,
    noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
      CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
    ).receipt,
    taskOnly: canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version: 2,
    }).receipt,
  };
}

function preparedClient(): CodeMemoryLinkPreparedClientV1 {
  const clientArguments = ['/reviewed/client.bundle.js'];
  const clientArtifactBindings = [
    {path: '/reviewed/client.bundle.js', role: 'client-bundle'},
    {path: '/reviewed/client.ts', role: 'client-entrypoint'},
    {path: '/reviewed/proxy.bundle.js', role: 'proxy-bundle'},
  ];
  const clientBinaryBindings = [
    {path: '/bin/bun', role: 'client-runtime'},
    {path: '/bin/codex', role: 'codex-app-server'},
    {path: '/bin/git', role: 'git'},
  ];
  const artifactBindings = EffectArray.map(clientArtifactBindings, (binding, index) => ({
    pathDigest: codeMemoryLinkClientPathDigest(binding.path),
    role: binding.role,
    sha256: Effect.pipe((index + 1).toString(16), EffectString.repeat(64)),
  }));
  const binaryBindings = EffectArray.map(clientBinaryBindings, (binding, index) => ({
    pathDigest: codeMemoryLinkClientPathDigest(binding.path),
    role: binding.role,
    sha256: Effect.pipe((index + 4).toString(16), EffectString.repeat(64)),
  }));
  const descriptor = {
    argumentVectorHash: codeMemoryLinkClientArgumentVectorHash(clientArguments),
    artifactBindings,
    binaryBindings,
    configurationHash: Effect.pipe('7', EffectString.repeat(64)),
    configurationProjectionHash: Effect.pipe('8', EffectString.repeat(64)),
    dependenciesLockHash: Effect.pipe('9', EffectString.repeat(64)),
    entrypointHash: artifactBindings[1].sha256,
    environmentPolicyHash: Effect.pipe('a', EffectString.repeat(64)),
    executionBundleHash: artifactBindings[0].sha256,
    expectedClientProjectionHash: Effect.pipe('b', EffectString.repeat(64)),
    version: 2 as const,
  };
  return {
    clientArguments,
    clientArtifactBindings,
    clientBinaryBindings,
    clientCommand: '/bin/bun',
    clientConfigurationProjectionPath: '/tmp/client.config-projection.json',
    clientConfigurationPath: '/tmp/client.config.json',
    clientDependenciesLockPath: '/tmp/client.lock',
    clientDescriptorPath: '/tmp/client.descriptor.json',
    clientId: `cli_${Effect.pipe('1', EffectString.repeat(32))}`,
    descriptor,
    implementationDescriptorHash: codeMemoryLinkClientImplementationDescriptorHash(descriptor),
    model: 'gpt-5.6-luna',
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
