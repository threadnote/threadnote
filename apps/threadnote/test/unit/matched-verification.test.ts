import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createMatchedContinuationPhaseTwoVerificationCheckReceiptV1,
  createMatchedContinuationPhaseTwoVerificationPlanV1,
  createMatchedContinuationPhaseTwoVerificationReceiptV1,
  createMatchedEvaluationVerificationCalibrationV1,
  createMatchedEvaluationVerificationPlanV1,
  createMatchedEvaluationVerificationReceiptV1,
  matchedEvaluationVerificationIdV1,
  parseMatchedContinuationFailureIdsV1,
  parseMatchedContinuationPhaseTwoVerificationPlanV1,
  parseMatchedContinuationPhaseTwoVerificationReceiptV1,
  parseMatchedContinuationPytestFailureIdsV1,
  parseMatchedContinuationThreadnoteVerifierFailureIdsV1,
  parseMatchedContinuationVitestFailureIdsV1,
  parseMatchedEvaluationVerificationPlanV1,
  parseMatchedEvaluationVerificationReceiptV1,
} from '@threadnote/threadnote/evaluation/matched-verification';

describe('matched evaluation deterministic verification', () => {
  it('canonicalizes task order and rejects a tampered plan', () => {
    const first = task('tsk_1111111111111111', 'alpha');
    const second = task('tsk_2222222222222222', 'beta');
    const plan = createMatchedEvaluationVerificationPlanV1({
      environmentDirectory: '/tmp/verifier-environment',
      environmentHash: '1'.repeat(64),
      interpreter: '/tmp/verifier-environment/bin/python',
      interpreterHash: '2'.repeat(64),
      runner: '/tmp/verifier.py',
      runnerHash: '3'.repeat(64),
      sandbox: {executable: '/usr/bin/sandbox-exec', executableHash: '4'.repeat(64), policy: 'darwin-seatbelt-v1'},
      tasks: [second, first],
      timeoutMilliseconds: 120_000,
    });

    expect(plan.tasks.map(candidate => candidate.taskId)).toEqual([first.taskId, second.taskId]);
    expect(parseMatchedEvaluationVerificationPlanV1(plan)).toEqual(plan);
    expect(() => parseMatchedEvaluationVerificationPlanV1({...plan, runnerHash: '5'.repeat(64)})).toThrow(
      'plan hash does not match',
    );
  });

  it('binds every artifact hash into a parse-verified receipt', () => {
    fc.assert(
      fc.property(fc.uint8Array({minLength: 32, maxLength: 32}), bytes => {
        const artifactHash = Buffer.from(bytes).toString('hex');
        const receipt = createMatchedEvaluationVerificationReceiptV1({
          artifactHash,
          diagnosticHash: '1'.repeat(64),
          durationMilliseconds: 12,
          environmentHash: '2'.repeat(64),
          exitCode: 0,
          interpreterHash: '3'.repeat(64),
          planHash: '4'.repeat(64),
          runnerHash: '5'.repeat(64),
          sandboxExecutableHash: '6'.repeat(64),
          status: 'passed',
          taskId: 'tsk_1111111111111111',
          verificationId: '7'.repeat(64),
        });

        expect(parseMatchedEvaluationVerificationReceiptV1(receipt)).toEqual(receipt);
        const changedArtifactHash = `${artifactHash[0] === '0' ? '1' : '0'}${artifactHash.slice(1)}`;
        expect(
          createMatchedEvaluationVerificationReceiptV1({...receipt, artifactHash: changedArtifactHash}).receiptHash,
        ).not.toBe(receipt.receiptHash);
      }),
      {numRuns: 50},
    );
  });

  it('rejects status and exit-code disagreement', () => {
    expect(() =>
      createMatchedEvaluationVerificationReceiptV1({
        artifactHash: '0'.repeat(64),
        diagnosticHash: '1'.repeat(64),
        durationMilliseconds: 0,
        environmentHash: '2'.repeat(64),
        exitCode: 1,
        interpreterHash: '3'.repeat(64),
        planHash: '4'.repeat(64),
        runnerHash: '5'.repeat(64),
        sandboxExecutableHash: '6'.repeat(64),
        status: 'passed',
        taskId: 'tsk_1111111111111111',
        verificationId: '7'.repeat(64),
      }),
    ).toThrow('status and exit code disagree');
  });

  it('requires the target to pass and rejects compatibility failures not present at baseline', () => {
    const plan = continuationPlan();
    const suite = plan.checks.find(check => check.policy === 'no-new-failures')!;
    const target = plan.checks.find(check => check.policy === 'must-pass')!;
    const artifactHash = '8'.repeat(64);
    const resume = createMatchedContinuationPhaseTwoVerificationReceiptV1({
      artifactHash,
      checks: [
        checkReceipt(plan.planHash, artifactHash, target, 0, []),
        checkReceipt(plan.planHash, artifactHash, suite, 1, ['tests/test_text.py::test_assemble_meta']),
      ],
      durationMilliseconds: 35,
      plan,
      protectedPathViolations: [],
    });
    expect(resume.status).toBe('passed');
    expect(resume.durationMilliseconds).toBe(35);
    expect(parseMatchedContinuationPhaseTwoVerificationReceiptV1({artifactHash, plan, receipt: resume})).toEqual(
      resume,
    );
    expect(
      createMatchedContinuationPhaseTwoVerificationReceiptV1({
        artifactHash,
        checks: resume.checks,
        plan,
        protectedPathViolations: ['tests/test_text.py'],
      }).status,
    ).toBe('task-failed');

    const compatibilityRegression = createMatchedContinuationPhaseTwoVerificationReceiptV1({
      artifactHash,
      checks: [
        checkReceipt(plan.planHash, artifactHash, target, 0, []),
        checkReceipt(plan.planHash, artifactHash, suite, 1, [
          'tests/test_text.py::test_assemble_meta',
          'tests/test_text.py::test_wrap_compatibility',
        ]),
      ],
      plan,
      protectedPathViolations: [],
    });
    expect(compatibilityRegression.status).toBe('task-failed');

    const targetStillFails = createMatchedContinuationPhaseTwoVerificationReceiptV1({
      artifactHash,
      checks: [
        checkReceipt(plan.planHash, artifactHash, target, 1, [
          'tests/test_text.py::test_wrap_preserves_double_width_characters',
        ]),
        checkReceipt(plan.planHash, artifactHash, suite, 1, [
          'tests/test_text.py::test_assemble_meta',
          'tests/test_text.py::test_wrap_preserves_double_width_characters',
        ]),
      ],
      plan,
      protectedPathViolations: [],
    });
    expect(targetStillFails.status).toBe('task-failed');
  });

  it('rejects missing, extra, and duplicate checks instead of accepting focused-only evidence', () => {
    const plan = continuationPlan();
    const suite = plan.checks.find(check => check.policy === 'no-new-failures')!;
    const target = plan.checks.find(check => check.policy === 'must-pass')!;
    const artifactHash = '8'.repeat(64);
    const focused = checkReceipt(plan.planHash, artifactHash, target, 0, []);
    expect(() =>
      createMatchedContinuationPhaseTwoVerificationReceiptV1({
        artifactHash,
        checks: [focused],
        plan,
        protectedPathViolations: [],
      }),
    ).toThrow('coverage is incomplete');
    expect(() =>
      createMatchedContinuationPhaseTwoVerificationReceiptV1({
        artifactHash,
        checks: [focused, focused],
        plan,
        protectedPathViolations: [],
      }),
    ).toThrow('duplicate checks');
    const otherPlan = createMatchedContinuationPhaseTwoVerificationPlanV1({
      checks: [
        {
          allowedBaselineFailureIds: [],
          commandTokens: ['python', '-m', 'pytest', 'tests/test_other.py'],
          diagnosticParser: 'pytest-summary-v1',
          policy: 'must-pass',
        },
      ],
      protectedPaths: ['tests/test_other.py'],
      taskId: plan.taskId,
    });
    const extra = checkReceipt(otherPlan.planHash, artifactHash, otherPlan.checks[0], 0, []);
    expect(() =>
      createMatchedContinuationPhaseTwoVerificationReceiptV1({
        artifactHash,
        checks: [focused, checkReceipt(plan.planHash, artifactHash, suite, 0, []), extra],
        plan,
        protectedPathViolations: [],
      }),
    ).toThrow('coverage is incomplete');
  });

  it('canonicalizes check receipts independently of execution order', () => {
    const plan = continuationPlan();
    const artifactHash = '8'.repeat(64);
    const receipts = plan.checks.map(check =>
      checkReceipt(
        plan.planHash,
        artifactHash,
        check,
        check.policy === 'must-pass' ? 0 : 1,
        check.policy === 'must-pass' ? [] : ['tests/test_text.py::test_assemble_meta'],
      ),
    );
    fc.assert(
      fc.property(fc.shuffledSubarray(receipts, {minLength: receipts.length, maxLength: receipts.length}), shuffled => {
        expect(
          createMatchedContinuationPhaseTwoVerificationReceiptV1({
            artifactHash,
            checks: shuffled,
            plan,
            protectedPathViolations: [],
          }).receiptHash,
        ).toBe(
          createMatchedContinuationPhaseTwoVerificationReceiptV1({
            artifactHash,
            checks: receipts,
            plan,
            protectedPathViolations: [],
          }).receiptHash,
        );
      }),
      {numRuns: 20},
    );
  });

  it('extracts canonical pytest failure and error ids', () => {
    expect(
      parseMatchedContinuationPytestFailureIdsV1(
        'FAILED tests/test_text.py::test_b - AssertionError\nFAILED tests/test_text.py::test_a - AssertionError\n',
        'ERROR tests/test_text.py::test_c - RuntimeError\n',
      ),
    ).toEqual(['tests/test_text.py::test_a', 'tests/test_text.py::test_b', 'tests/test_text.py::test_c']);
  });

  it('extracts failure ids in linear time from diagnostics with long whitespace runs', () => {
    const whitespace = '\t'.repeat(10_000);
    expect(
      parseMatchedContinuationPytestFailureIdsV1(
        `FAILED${whitespace}tests/test_text.py::test_a${whitespace}-${whitespace}AssertionError`,
        '',
      ),
    ).toEqual(['tests/test_text.py::test_a']);
    expect(
      parseMatchedContinuationVitestFailureIdsV1(
        `FAIL${whitespace}packages/example.test.ts > schema > handles whitespace`,
        '',
      ),
    ).toEqual(['packages/example.test.ts > schema > handles whitespace']);
  });

  it('extracts and dispatches canonical Vitest failure ids', () => {
    const escape = String.fromCodePoint(27);
    const stdout = [
      `${escape}[41m${escape}[1m FAIL ${escape}[22m${escape}[49m packages/zod/src/example.test.ts${escape}[2m > ${escape}[22mschema > handles beta`,
      ' FAIL  packages/zod/src/example.test.ts > schema > handles alpha',
      ' FAIL  packages/zod/src/example.test.ts > schema > handles beta',
    ].join('\n');
    const expected = [
      'packages/zod/src/example.test.ts > schema > handles alpha',
      'packages/zod/src/example.test.ts > schema > handles beta',
    ];

    expect(parseMatchedContinuationVitestFailureIdsV1(stdout, '')).toEqual(expected);
    expect(parseMatchedContinuationFailureIdsV1('vitest-summary-v1', stdout, '')).toEqual(expected);
    expect(
      parseMatchedContinuationFailureIdsV1(
        'pytest-summary-v1',
        'FAILED tests/test_text.py::test_a - AssertionError\n',
        '',
      ),
    ).toEqual(['tests/test_text.py::test_a']);
  });

  it('reduces a sealed Threadnote verifier diagnostic to one stable failure id', () => {
    const stderr =
      'pluggy verifier failed: {"completed":true,"failures":["held-out-contract exited 1: assertion failed"]}\n';
    expect(parseMatchedContinuationThreadnoteVerifierFailureIdsV1('', stderr)).toEqual(['sealed-verifier-failure']);
    expect(parseMatchedContinuationFailureIdsV1('threadnote-verifier-v1', '', stderr)).toEqual([
      'sealed-verifier-failure',
    ]);
    expect(
      parseMatchedContinuationThreadnoteVerifierFailureIdsV1(
        '',
        'pluggy verifier failed: {"completed":false,"infrastructureError":"sandbox unavailable"}\n',
      ),
    ).toEqual([]);
  });

  it('keeps the Threadnote verifier failure identity independent of private diagnostic text', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 256}), failure => {
        const stderr = `echo verifier failed: ${JSON.stringify({completed: true, failures: [failure]})}\n`;
        expect(parseMatchedContinuationThreadnoteVerifierFailureIdsV1('', stderr)).toEqual(['sealed-verifier-failure']);
      }),
      {numRuns: 50},
    );
  });

  it('canonicalizes Vitest failure ids independently of diagnostic order and duplicates', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 10_000}), {minLength: 1, maxLength: 24}), values => {
        const ids = values.map(value => `packages/example-${value}.test.ts > handles ${value}`);
        const diagnostics = [...ids, ...ids]
          .reverse()
          .map(id => ` FAIL  ${id}`)
          .join('\n');
        expect(parseMatchedContinuationVitestFailureIdsV1(diagnostics, '')).toEqual([...ids].sort());
      }),
      {numRuns: 50},
    );
  });

  it('round-trips a Vitest parser through sealed plan and receipt hashes', () => {
    const failureId = 'packages/example.test.ts > schema > rejects ambiguous input';
    const plan = createMatchedContinuationPhaseTwoVerificationPlanV1({
      checks: [
        {
          allowedBaselineFailureIds: [failureId],
          commandTokens: ['nub', 'exec', '--node', 'vitest', 'run', 'packages/example.test.ts'],
          diagnosticParser: 'vitest-summary-v1',
          policy: 'no-new-failures',
        },
      ],
      protectedPaths: ['packages/example.test.ts'],
      taskId: 'tsk_1111111111111111',
    });
    expect(parseMatchedContinuationPhaseTwoVerificationPlanV1(plan)).toEqual(plan);

    const artifactHash = '8'.repeat(64);
    const receipt = createMatchedContinuationPhaseTwoVerificationReceiptV1({
      artifactHash,
      checks: [checkReceipt(plan.planHash, artifactHash, plan.checks[0], 1, [failureId])],
      plan,
      protectedPathViolations: [],
    });
    expect(receipt.status).toBe('passed');
    expect(parseMatchedContinuationPhaseTwoVerificationReceiptV1({artifactHash, plan, receipt})).toEqual(receipt);
  });
});

function continuationPlan() {
  return createMatchedContinuationPhaseTwoVerificationPlanV1({
    checks: [
      {
        allowedBaselineFailureIds: [],
        commandTokens: [
          'PYTHONPATH=src',
          'python',
          '-m',
          'pytest',
          '-q',
          'tests/test_text.py',
          '-k',
          'test_wrap_preserves_double_width_characters',
        ],
        diagnosticParser: 'pytest-summary-v1',
        policy: 'must-pass',
      },
      {
        allowedBaselineFailureIds: [
          'tests/test_text.py::test_assemble_meta',
          'tests/test_text.py::test_wrap_preserves_double_width_characters',
        ],
        commandTokens: ['PYTHONPATH=src', 'python', '-m', 'pytest', '-q', 'tests/test_text.py'],
        diagnosticParser: 'pytest-summary-v1',
        policy: 'no-new-failures',
      },
    ],
    protectedPaths: ['tests/test_text.py'],
    taskId: 'tsk_1111111111111111',
  });
}

function checkReceipt(
  planHash: string,
  artifactHash: string,
  check: ReturnType<typeof continuationPlan>['checks'][number],
  exitCode: 0 | 1,
  failureIds: readonly string[],
) {
  return createMatchedContinuationPhaseTwoVerificationCheckReceiptV1({
    artifactHash,
    check,
    diagnosticHash: '9'.repeat(64),
    durationMilliseconds: 10,
    exitCode,
    failureIds,
    planHash,
  });
}

function task(taskId: string, selector: string) {
  return {
    calibration: createMatchedEvaluationVerificationCalibrationV1({
      baseDiagnosticHash: 'a'.repeat(64),
      baseExitCode: 1,
      baseRepositoryFixtureHash: 'b'.repeat(64),
      baseRevision: 'c'.repeat(40),
      fixDiagnosticHash: 'd'.repeat(64),
      fixExitCode: 0,
      fixRepositoryFixtureHash: 'e'.repeat(64),
      fixRevision: 'f'.repeat(40),
    }),
    selector,
    taskId,
    verificationId: matchedEvaluationVerificationIdV1(taskId, selector),
  };
}
