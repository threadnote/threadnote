import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseContextBriefContinuationCard} from '@threadnote/context/memory-evidence';
import {codexResumeContinuationEvidenceState} from '@threadnote/threadnote/codex/resume_hook';
import {matchedEvaluationPromptHashV1} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  createMatchedContinuationPhaseTwoVerificationCheckReceiptV1,
  createMatchedContinuationPhaseTwoVerificationPlanV1,
  createMatchedContinuationPhaseTwoVerificationReceiptV1,
  createMatchedEvaluationVerificationReceiptV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {
  createMatchedContinuationStudyV1,
  MATCHED_CONTINUATION_VARIANTS,
  type MatchedContinuationStudyTaskV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import type {MatchedEvaluationMetricsV1} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  matchedContinuationDeterministicallyVerifiedV1,
  parseAndVerifyMatchedContinuationTaskReportV1,
  projectMatchedContinuationOutcomesV1,
  publishMatchedContinuationFinalizationV1,
  type ParsedAttempt,
  type ParsedTaskReport,
} from '../../../../scripts/finalize-matched-continuation-study.js';
import {
  assertMatchedContinuationPhaseTwoBaselineResultV1,
  assertMatchedEvaluationContinuationDiagnosticSourceCitationPathsV1,
  assertMatchedEvaluationContinuationDiagnosticSourceCitationsV1,
  assertMatchedEvaluationContinuationGraphEvidenceResultV1,
  buildMatchedEvaluationContinuationAnchoredGraphQueryV1,
  buildMatchedEvaluationContinuationDiagnosticHandoffV1,
  extractMatchedEvaluationContinuationPhaseOneEvidenceV1,
  extractMatchedEvaluationContinuationPhaseOneEvidenceV2,
  initializeMatchedEvaluationContinuationNonceStatesV1,
  markMatchedEvaluationContinuationNonceStartedV1,
  matchedContinuationDiagnosticParserForCommandV1,
  normalizeMatchedEvaluationContinuationGraphQueryV1,
  parseMatchedEvaluationContinuationAutomaticHandoffReadV1,
  parseMatchedEvaluationContinuationPilotPlanV1,
  projectMatchedEvaluationContinuationSelectionCheckpointV1,
  recoverMatchedEvaluationContinuationAttemptsV1,
  selectMatchedEvaluationContinuationInBoundsSourceCitationsV1,
  type MatchedEvaluationContinuationPilotPlanV3,
  type MatchedEvaluationContinuationPilotPlanV4,
} from '../../../../scripts/run-matched-evaluation.js';

type TestContinuationPlan = MatchedEvaluationContinuationPilotPlanV3 | MatchedEvaluationContinuationPilotPlanV4;

describe('matched continuation finalization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('seals exactly one supported diagnostic parser from each approved command', () => {
    expect(
      matchedContinuationDiagnosticParserForCommandV1(['python', '-m', 'pytest', '-q', 'tests/test_target.py']),
    ).toBe('pytest-summary-v1');
    expect(
      matchedContinuationDiagnosticParserForCommandV1(['nub', 'exec', '--node', 'vitest', 'run', 'target.test.ts']),
    ).toBe('vitest-summary-v1');
    expect(
      matchedContinuationDiagnosticParserForCommandV1(['pytest-source-runner', '-q', 'tests/test_target.py']),
    ).toBe('pytest-summary-v1');
    expect(matchedContinuationDiagnosticParserForCommandV1(['/sealed/bin/v19-verifier.py', 'pluggy'])).toBe(
      'threadnote-verifier-v1',
    );
    expect(
      matchedContinuationDiagnosticParserForCommandV1(['qualify-typescript-eslint'], {
        stderr: '',
        stdout:
          ' FAIL  tests/rules/no-unnecessary-type-parameters.test.ts > rule > invalid > regression\n' +
          'AssertionError: expected output to match\n',
      }),
    ).toBe('vitest-summary-v1');
    expect(() => matchedContinuationDiagnosticParserForCommandV1(['node', 'custom-test.js'])).toThrow(
      'exactly one supported diagnostic parser',
    );
    expect(() => matchedContinuationDiagnosticParserForCommandV1(['pytest', 'vitest'])).toThrow(
      'exactly one supported diagnostic parser',
    );
  });

  it('recognizes path-qualified pytest wrapper commands without inspecting corpus-specific arguments', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom('a', 'b', 'c', '0', '1', '-'), {minLength: 1, maxLength: 16})
          .map(characters => characters.join('')),
        suffix => {
          expect(
            matchedContinuationDiagnosticParserForCommandV1([
              `/sealed/tooling/pytest-${suffix}`,
              '-q',
              'tests/test_target.py',
            ]),
          ).toBe('pytest-summary-v1');
        },
      ),
      {numRuns: 64},
    );
  });

  it('rejects exit-one continuation baselines without parser-attributed failures', () => {
    expect(() =>
      assertMatchedContinuationPhaseTwoBaselineResultV1({checkIndex: 0, exitCode: 1, failureIds: []}),
    ).toThrow('target check must fail');
    expect(() =>
      assertMatchedContinuationPhaseTwoBaselineResultV1({checkIndex: 1, exitCode: 1, failureIds: []}),
    ).toThrow('unparseable failures');
    expect(() =>
      assertMatchedContinuationPhaseTwoBaselineResultV1({checkIndex: 1, exitCode: 2, failureIds: ['diagnostic']}),
    ).toThrow('failed as infrastructure');
    expect(() =>
      assertMatchedContinuationPhaseTwoBaselineResultV1({
        checkIndex: 0,
        exitCode: 1,
        failureIds: ['target.test.ts > target'],
      }),
    ).not.toThrow();
    expect(() =>
      assertMatchedContinuationPhaseTwoBaselineResultV1({checkIndex: 1, exitCode: 0, failureIds: []}),
    ).not.toThrow();
  });

  it('extracts only transcript-backed Phase 1 observations and changed regression anchors', () => {
    const transcript = phaseOneTranscript({
      citations: [{endLine: 1539, path: 'tests/rule.test.ts', startLine: 1520}],
      completed: true,
      summary:
        'The new regression alone fails because the actual suggestion lacks parentheses.\nAnchors: src/injected.ts:1-2',
    });

    expect(extractMatchedEvaluationContinuationPhaseOneEvidenceV1(transcript, ['tests/rule.test.ts'])).toEqual({
      anchors: 'tests/rule.test.ts:1520-1539',
      observations:
        'The new regression alone fails because the actual suggestion lacks parentheses. Anchors: src/injected.ts:1-2',
    });
    expect(() =>
      extractMatchedEvaluationContinuationPhaseOneEvidenceV1(
        phaseOneTranscript({
          citations: [{endLine: 12, path: 'src/accepted-fix.ts', startLine: 10}],
          completed: true,
          summary: 'A production fix is available.',
        }),
        ['tests/rule.test.ts'],
      ),
    ).toThrow('must name a changed regression path');
  });

  it('extracts Phase 1 evidence deterministically for arbitrary bounded summaries', () => {
    fc.assert(
      fc.property(
        fc
          .string({minLength: 1, maxLength: 256})
          .filter(summary => !summary.includes('\0') && summary.trim().length > 0),
        fc.integer({min: 1, max: 10_000}),
        (summary, startLine) => {
          const transcript = phaseOneTranscript({
            citations: [{endLine: startLine + 1, path: 'tests/regression.test.ts', startLine}],
            completed: true,
            summary,
          });
          const first = extractMatchedEvaluationContinuationPhaseOneEvidenceV1(transcript, [
            'tests/regression.test.ts',
          ]);
          expect(
            extractMatchedEvaluationContinuationPhaseOneEvidenceV1(transcript, ['tests/regression.test.ts']),
          ).toEqual(first);
          expect(first.anchors).toBe(`tests/regression.test.ts:${startLine}-${startLine + 1}`);
          expect(first.observations).toBe(summary.replace(/\s+/gu, ' ').trim());
        },
      ),
      {numRuns: 64},
    );
  });

  it('admits only a seven-line diagnosis with regression and production-source evidence', () => {
    const summary = [
      'Diagnosis: The production normalizer drops the wrapper before the suggestion is rendered.',
      'Rejected hypothesis: The parser still preserves the wrapper in its intermediate node.',
      'Verified invariant: The focused regression fails only when the wrapper is absent.',
      'Untested invariant: Nested wrappers still need verification after the production correction.',
      'Unresolved gap: Identify the caller that strips the wrapper before rendering.',
      'Graph question: Which production caller passes the normalized node into the renderer?',
      'Graph query: find callers from normalizeNode to renderSuggestion',
    ].join('\n');
    const transcript = phaseOneTranscript({
      citations: [
        {endLine: 42, path: 'tests/regression.test.ts', startLine: 31},
        {endLine: 88, path: 'src/normalizer.ts', startLine: 72},
      ],
      completed: true,
      summary,
    });

    expect(extractMatchedEvaluationContinuationPhaseOneEvidenceV2(transcript, ['tests/regression.test.ts'])).toEqual({
      diagnosticEvidence: {
        diagnosticConclusion: 'The production normalizer drops the wrapper before the suggestion is rendered.',
        graphQuery: 'find callers from normalizeNode to renderSuggestion',
        graphQuestion: 'Which production caller passes the normalized node into the renderer?',
        rejectedHypothesis: 'The parser still preserves the wrapper in its intermediate node.',
        sourceCitations: [{endLine: 88, path: 'src/normalizer.ts', startLine: 72}],
        unresolvedGap: 'Identify the caller that strips the wrapper before rendering.',
        untestedInvariant: 'Nested wrappers still need verification after the production correction.',
        verifiedInvariant: 'The focused regression fails only when the wrapper is absent.',
      },
      regressionAnchors: 'tests/regression.test.ts:31-42',
    });
    expect(() =>
      extractMatchedEvaluationContinuationPhaseOneEvidenceV2(
        phaseOneTranscript({
          citations: [{endLine: 42, path: 'tests/regression.test.ts', startLine: 31}],
          completed: true,
          summary,
        }),
        ['tests/regression.test.ts'],
      ),
    ).toThrow('production-source citation');
    expect(() =>
      extractMatchedEvaluationContinuationPhaseOneEvidenceV2(
        phaseOneTranscript({
          citations: [
            {endLine: 42, path: 'tests/regression.test.ts', startLine: 31},
            {endLine: 88, path: 'src/normalizer.ts', startLine: 72},
          ],
          completed: true,
          summary: `${summary}\nExtra: forbidden`,
        }),
        ['tests/regression.test.ts'],
      ),
    ).toThrow('exactly the seven ordered contract lines');
  });

  it('requires v4 source citations to resolve to in-range tracked production files', () => {
    const citation = (path: string, startLine = 1, endLine = 2) => [{endLine, path, startLine}];
    const validate = (path: string, options: {readonly allowed?: readonly string[]; readonly content?: string} = {}) =>
      assertMatchedEvaluationContinuationDiagnosticSourceCitationsV1({
        changedPaths: ['tests/regression.test.ts'],
        phaseOneAllowedPaths: options.allowed ?? [],
        sourceCitations: citation(path),
        trackedRegularFiles: options.content === undefined ? new Map() : new Map([[path, options.content]]),
      });

    expect(() => validate('tests/unchanged.test.ts', {content: 'one\ntwo\n'})).toThrow('not production source');
    expect(() => validate('docs/architecture.md', {content: 'one\ntwo\n'})).toThrow('not production source');
    expect(() => validate('fixture.ts', {content: 'one\ntwo\n'})).toThrow('not production source');
    expect(() => validate('generated.ts', {content: 'one\ntwo\n'})).toThrow('not production source');
    expect(() => validate('src/__fixtures__/case.ts', {content: 'one\ntwo\n'})).toThrow('not production source');
    expect(() => validate('src/normalizer.ts')).toThrow('not a tracked regular file');
    expect(() => validate('src/normalizer.ts', {content: 'only one line'})).toThrow('out of bounds');
    expect(() => validate('src/normalizer.ts', {allowed: ['src/normalizer.ts'], content: 'one\ntwo\n'})).toThrow(
      'not production source',
    );
    expect(() => validate('src/normalizer.ts', {content: 'one\ntwo\n'})).not.toThrow();
  });

  it('discards an overlong extra citation without rewriting the valid source anchor or raw ranges', () => {
    const sourceCitations = [
      {endLine: 12, path: 'src/fields.py', startLine: 8},
      {endLine: 103, path: 'src/html.py', startLine: 88},
    ];
    const selected = selectMatchedEvaluationContinuationInBoundsSourceCitationsV1({
      sourceCitations,
      trackedRegularFiles: new Map([
        ['src/fields.py', `${Array.from({length: 20}, (_, index) => index).join('\n')}\n`],
        ['src/html.py', `${Array.from({length: 95}, (_, index) => index).join('\n')}\n`],
      ]),
    });

    expect(selected).toEqual([{endLine: 12, path: 'src/fields.py', startLine: 8}]);
    expect(sourceCitations).toEqual([
      {endLine: 12, path: 'src/fields.py', startLine: 8},
      {endLine: 103, path: 'src/html.py', startLine: 88},
    ]);
  });

  it('rejects an overlong forbidden citation before bounds selection can discard it', () => {
    const trackedRegularFiles = new Map([
      ['src/fields.py', 'one\ntwo\n'],
      ['tests/regression.py', 'one\ntwo\n'],
    ]);
    const sourceCitations = [
      {endLine: 2, path: 'src/fields.py', startLine: 1},
      {endLine: 100, path: 'tests/regression.py', startLine: 1},
    ];

    expect(() =>
      assertMatchedEvaluationContinuationDiagnosticSourceCitationPathsV1({
        changedPaths: ['tests/regression.py'],
        phaseOneAllowedPaths: ['tests/regression.py'],
        sourceCitations,
        trackedRegularFiles,
      }),
    ).toThrow('not production source');
  });

  it('selects in-bounds citations without changing retained ranges and is idempotent', () => {
    fc.assert(
      fc.property(
        fc
          .integer({min: 1, max: 200})
          .chain(lineCount =>
            fc
              .integer({min: 1, max: lineCount})
              .chain(startLine =>
                fc.integer({min: startLine, max: lineCount + 200}).map(endLine => ({endLine, lineCount, startLine})),
              ),
          ),
        ({endLine, lineCount, startLine}) => {
          const trackedRegularFiles = new Map([
            ['src/source.ts', `${Array.from({length: lineCount}, (_, index) => index).join('\n')}\n`],
          ]);
          const first = selectMatchedEvaluationContinuationInBoundsSourceCitationsV1({
            sourceCitations: [{endLine, path: 'src/source.ts', startLine}],
            trackedRegularFiles,
          });
          const second = selectMatchedEvaluationContinuationInBoundsSourceCitationsV1({
            sourceCitations: first,
            trackedRegularFiles,
          });

          expect(first).toEqual(endLine <= lineCount ? [{endLine, path: 'src/source.ts', startLine}] : []);
          expect(second).toEqual(first);
        },
      ),
      {numRuns: 64},
    );
  });

  it('wires v4 diagnostic evidence into a source-grounded handoff while retaining the v3 projection', () => {
    const diagnosticEvidence = {
      diagnosticConclusion: 'The normalizer removes the wrapper before rendering.',
      graphQuery: 'find callers from normalizeNode to renderSuggestion',
      graphQuestion: 'Which production caller passes the normalized node to rendering?',
      rejectedHypothesis: 'The parser drops the wrapper before normalization.',
      sourceCitations: [{endLine: 12, path: 'src/normalizer.ts', startLine: 8}],
      unresolvedGap: 'Trace which caller selects the normalized node.',
      untestedInvariant: 'Nested wrappers still need a regression after the fix.',
      verifiedInvariant: 'The focused test fails when the wrapper is absent.',
    } as const;
    const shared = {
      changedPaths: ['tests/regression.test.ts'],
      phaseTwoPrompt: 'Continue phase two.',
      resumeEvidenceMarker: 'resume-evidence-marker',
      verification: 'bun test target.test.ts fails with exit code 1 at this checkpoint.',
    };
    const v4 = buildMatchedEvaluationContinuationDiagnosticHandoffV1({
      ...shared,
      diagnosticEvidence,
      legacyEvidence: {anchors: 'tests/regression.test.ts:4-5', observations: ''},
    });
    expect(v4.planVersion).toBe(4);
    expect(v4.codeRefs).toEqual(['tests/regression.test.ts', 'src/normalizer.ts']);
    expect(v4.sourceAnchors).toBe('src/normalizer.ts:8-12');
    expect(v4.handoff).toContain('Graph query: find callers from normalizeNode to renderSuggestion');
    expect(v4.handoff).toContain('Anchors: regression tests/regression.test.ts:4-5; source src/normalizer.ts:8-12');
    expect(v4.handoff).toContain('First run exactly one inspect_code_graph query using the Graph query above');
    expect(codexResumeContinuationEvidenceState(parseContextBriefContinuationCard(v4.handoff))).toBe(
      'evidence-bearing',
    );
    const v3 = buildMatchedEvaluationContinuationDiagnosticHandoffV1({
      ...shared,
      diagnosticEvidence: null,
      legacyEvidence: {anchors: 'tests/regression.test.ts:4-5', observations: 'The failing assertion is reproducible.'},
    });
    expect(v3.planVersion).toBe(3);
    expect(v3.codeRefs).toEqual(['tests/regression.test.ts']);
    expect(v3.sourceAnchors).toBeNull();
    expect(v3.handoff).toContain('Observed: The failing assertion is reproducible.');
    expect(v3.handoff).not.toContain('Graph query:');
  });

  it('seals the semantic graph argument and keeps it intact in the resume next step', () => {
    const invocation = 'inspect_code_graph("Node.search queue transition to static child")';
    expect(normalizeMatchedEvaluationContinuationGraphQueryV1(invocation)).toBe(
      'Node.search queue transition to static child',
    );
    const projected = buildMatchedEvaluationContinuationDiagnosticHandoffV1({
      changedPaths: ['tests/regression.test.ts'],
      diagnosticEvidence: {
        diagnosticConclusion: 'The queue transition skips the static child.',
        graphQuery: invocation,
        graphQuestion: 'Which transition advances the queue?',
        rejectedHypothesis: 'The regular expression itself matches.',
        sourceCitations: [{endLine: 12, path: 'src/node.ts', startLine: 8}],
        unresolvedGap: 'Choose the correct queue offset update.',
        untestedInvariant: 'Wildcard traversal remains unchanged.',
        verifiedInvariant: 'The focused regression isolates the traversal.',
      },
      legacyEvidence: {anchors: 'tests/regression.test.ts:4-5', observations: ''},
      phaseTwoPrompt: 'Continue phase two.',
      resumeEvidenceMarker: 'resume-evidence-marker',
      verification: 'The focused regression fails.',
    });
    expect(projected.handoff).toContain(
      'Next step: First inspect_code_graph query: Node.search queue transition to static child.',
    );
    expect(projected.handoff).toContain('Task: resume-evidence-marker. Node.search queue transition to static child');
    expect(projected.handoff).not.toContain(invocation);
  });

  it('keeps graph queries semantic instead of injecting source paths or tool-call prose', () => {
    const query = buildMatchedEvaluationContinuationAnchoredGraphQueryV1({
      fallbackQuery: 'inspect_code_graph("Node.search find the transition to staticChild")',
      graphQuestion: `Which transition advances the queue? ${'detail '.repeat(80)}`,
      sourceCitations: [{path: 'src/router/node.ts'}],
    });
    expect(query).toBe('Node.search find the transition to staticChild');
    expect(query).not.toContain('Which transition advances the queue?');
    expect(Buffer.byteLength(query, 'utf8')).toBeLessThanOrEqual(256);
    expect(
      Buffer.byteLength(
        buildMatchedEvaluationContinuationAnchoredGraphQueryV1({
          fallbackQuery: 'find the transition',
          graphQuestion: `Which transition? ${'é'.repeat(300)}`,
          sourceCitations: [{path: 'src/router/node.ts'}],
        }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(256);
    expect(
      buildMatchedEvaluationContinuationAnchoredGraphQueryV1({
        fallbackQuery: 'inspect_code_graph for find the transition',
        graphQuestion: 'Which transition advances the queue?',
        sourceCitations: [{path: `src/${'nested/'.repeat(30)}node.ts`}],
      }),
    ).toBe('find the transition');
  });

  it('preserves the sealed code identities regardless of graph-question prose', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 512}), graphQuestion => {
        expect(
          buildMatchedEvaluationContinuationAnchoredGraphQueryV1({
            fallbackQuery: 'inspect_code_graph("html.parse_html_dict callers DictField.get_value")',
            graphQuestion,
            sourceCitations: [{path: 'rest_framework/fields.py'}],
          }),
        ).toBe('html.parse_html_dict callers DictField.get_value');
      }),
      {numRuns: 64},
    );
  });

  it('requires structural relationship evidence on a cited source path', () => {
    const sourceCitations = [{path: 'src/normalizer.ts'}];
    expect(() =>
      assertMatchedEvaluationContinuationGraphEvidenceResultV1(
        {
          edges: [{sourceId: 'normalizer', targetId: 'renderer'}],
          nodes: [
            {id: 'normalizer', path: 'src/normalizer.ts', resolutionDomain: 'typescript'},
            {id: 'renderer', path: 'src/renderer.ts', resolutionDomain: 'typescript'},
          ],
          operation: 'query',
        },
        sourceCitations,
      ),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationContinuationGraphEvidenceResultV1(
        {
          edges: [{sourceId: 'normalizer', targetId: 'renderer'}],
          nodes: [{id: 'normalizer', path: 'src/normalizer.ts', resolutionDomain: 'degraded'}],
          operation: 'query',
        },
        sourceCitations,
      ),
    ).toThrow('did not return relationship evidence');
    expect(() =>
      assertMatchedEvaluationContinuationGraphEvidenceResultV1(
        {
          edges: [],
          nodes: [{id: 'normalizer', path: 'src/normalizer.ts', resolutionDomain: 'typescript'}],
          operation: 'query',
        },
        sourceCitations,
      ),
    ).toThrow('did not return relationship evidence');
    expect(() =>
      assertMatchedEvaluationContinuationGraphEvidenceResultV1(
        {
          edges: [{sourceId: 'normalizer', targetId: 'renderer'}],
          nodes: [{id: 'normalizer', path: 'src/normalizer.ts'}],
          operation: 'query',
        },
        sourceCitations,
      ),
    ).toThrow('did not return relationship evidence');
  });

  it('never accepts degraded cited nodes as continuation graph evidence', () => {
    fc.assert(
      fc.property(fc.array(fc.string({maxLength: 32}), {maxLength: 16}), unrelatedIds => {
        const nodes = [
          {id: 'cited', path: 'src/normalizer.ts', resolutionDomain: 'degraded'},
          ...unrelatedIds.map((id, index) => ({
            id: `${index}-${id}`,
            path: `src/unrelated-${index}.ts`,
            resolutionDomain: 'typescript',
          })),
        ];
        const edges = nodes.map(node => ({sourceId: 'cited', targetId: node.id}));
        expect(() =>
          assertMatchedEvaluationContinuationGraphEvidenceResultV1({edges, nodes, operation: 'query'}, [
            {path: 'src/normalizer.ts'},
          ]),
        ).toThrow('did not return relationship evidence');
      }),
      {numRuns: 64},
    );
  });

  it('attests every exact-current handoff citation and selects the regression citation', () => {
    const citation = (id: string, path: string) =>
      JSON.stringify({
        id,
        path,
        sourceCommit: 'a'.repeat(40),
        sourceDirty: false,
        sourceGraphContentId: 'graph-content',
        sourceSnapshotId: 'snapshot',
        target: {kind: 'file'},
      });
    const stdout = [
      'memory_id: tn_handoff',
      `code_citation: ${citation(`tncc_${'1'.repeat(40)}`, 'tests/regression.test.ts')}`,
      `code_citation: ${citation(`tncc_${'2'.repeat(40)}`, 'src/normalizer.ts')}`,
    ].join('\n');

    expect(
      parseMatchedEvaluationContinuationAutomaticHandoffReadV1({
        expectedCodeRefs: ['tests/regression.test.ts', 'src/normalizer.ts'],
        graphContentId: 'graph-content',
        regressionPath: 'tests/regression.test.ts',
        repositoryRevision: 'a'.repeat(40),
        snapshotId: 'snapshot',
        stdout,
      }),
    ).toEqual({citationId: `tncc_${'1'.repeat(40)}`, managedMemoryId: 'tn_handoff'});
    expect(() =>
      parseMatchedEvaluationContinuationAutomaticHandoffReadV1({
        expectedCodeRefs: ['tests/regression.test.ts'],
        graphContentId: 'graph-content',
        regressionPath: 'tests/regression.test.ts',
        repositoryRevision: 'a'.repeat(40),
        snapshotId: 'snapshot',
        stdout,
      }),
    ).toThrow('citations differ');
  });

  it('rehashes task-report evidence and rejects partial or tampered reports', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-finalizer-')));
    roots.push(root);
    const study = createStudy();
    const task = study.tasks[0];
    const plan = continuationPlan(task, study.sourceEvidence.verificationPlanHash);
    expect(parseMatchedEvaluationContinuationPilotPlanV1(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const attempts = await Promise.all(
      plan.attempts.map(attempt =>
        completedReportAttempt(
          root,
          plan,
          attempt,
          metrics(task.taskId, hex(700 + attempt.runOrder), study.sourceEvidence.verificationPlanHash),
        ),
      ),
    );
    const report = taskReport(plan, study, attempts);

    const parsed = await parseAndVerifyMatchedContinuationTaskReportV1({
      plan,
      reportInput: report,
      sourceReportSha256: hex(900),
      study,
    });
    expect(parsed.attempts).toHaveLength(5);
    expect(parsed.phaseOne.providerTokens.totalTokens).toBe(30);

    const unavailableAttempt = {
      ...attempts[0],
      accountingStatus: 'retained-observation',
      diagnostics: 'verification command failed as infrastructure',
      phaseTwoVerification: null,
      status: 'verification-unavailable',
    } as const;
    const unavailableParsed = await parseAndVerifyMatchedContinuationTaskReportV1({
      plan,
      reportInput: {...report, attempts: [unavailableAttempt, ...attempts.slice(1)], completed: false},
      sourceReportSha256: hex(904),
      study,
    });
    expect(unavailableParsed.attempts[0]).toMatchObject({
      accountingStatus: 'retained-observation',
      status: 'verification-unavailable',
    });
    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: {
          ...report,
          attempts: [
            {
              ...unavailableAttempt,
              metrics: {
                ...unavailableAttempt.metrics,
                usage: {...unavailableAttempt.metrics.usage, providerTokens: null},
              },
            },
            ...attempts.slice(1),
          ],
          completed: false,
        },
        sourceReportSha256: hex(905),
        study,
      }),
    ).rejects.toThrow('lacks measured provider usage');

    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: {...report, identities: {...report.identities, runtimeVersion: 3}},
        sourceReportSha256: hex(903),
        study,
      }),
    ).rejects.toThrow('task report identities differ from the sealed study');

    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: {...report, attempts: attempts.slice(0, 4), completed: false},
        sourceReportSha256: hex(901),
        study,
      }),
    ).rejects.toThrow('every planned terminal attempt');

    await writeFile(attempts[0].rawArtifactPath, '{"tampered":true}\n');
    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: report,
        sourceReportSha256: hex(902),
        study,
      }),
    ).rejects.toThrow('artifact differs from its report hash');
  });

  it('accepts a v4 task report only when its report identity matches the v4 plan', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-finalizer-v4-')));
    roots.push(root);
    const study = createStudy();
    const plan = continuationPlanV4(continuationPlan(study.tasks[0], study.sourceEvidence.verificationPlanHash));
    const attempts = await Promise.all(
      plan.attempts.map(attempt =>
        completedReportAttempt(
          root,
          plan,
          attempt,
          metrics(study.tasks[0].taskId, hex(950 + attempt.runOrder), study.sourceEvidence.verificationPlanHash),
        ),
      ),
    );
    const report = taskReport(plan, study, attempts);

    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: report,
        sourceReportSha256: hex(960),
        study,
      }),
    ).resolves.toMatchObject({sourceReportSha256: hex(960)});
    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: {...report, planVersion: 3},
        sourceReportSha256: hex(961),
        study,
      }),
    ).rejects.toThrow('task report identity is invalid');
  });

  it('recovers only terminal-journal attempts and blocks provider-ambiguous nonces', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-resume-')));
    roots.push(root);
    const pilotDirectory = join(root, 'pilot');
    const study = createStudy();
    const plan = continuationPlan(study.tasks[0], study.sourceEvidence.verificationPlanHash);
    const first = plan.attempts[0];
    const runDirectory = join(pilotDirectory, 'runs', first.runNonce);
    const transcriptDirectory = join(pilotDirectory, 'transcripts');
    await Promise.all([mkdir(runDirectory, {recursive: true}), mkdir(transcriptDirectory, {recursive: true})]);
    const rawArtifactPath = join(runDirectory, 'artifact.json');
    const requestPath = join(runDirectory, 'request.json');
    const responsePath = join(runDirectory, 'response.json');
    const transcriptPath = join(transcriptDirectory, `${first.runNonce}.jsonl`);
    const artifactBytes = Buffer.from('{"artifact":true}\n');
    const requestBytes = Buffer.from('{"request":true}\n');
    const responseBytes = Buffer.from('{"response":true}\n');
    const transcriptBytes = Buffer.from('{"transcript":true}\n');
    await Promise.all([
      writeFile(rawArtifactPath, artifactBytes),
      writeFile(requestPath, requestBytes),
      writeFile(responsePath, responseBytes),
      writeFile(transcriptPath, transcriptBytes),
    ]);
    const artifactSha256 = sha256HexSync(artifactBytes);
    const terminal = {
      accountingStatus: 'retained-observation',
      arm: underlyingArm(first.variant),
      artifactSha256,
      checkpointPath: `${transcriptPath}.agent.jsonl`,
      diagnostics: 'verification infrastructure unavailable',
      metrics: metrics(plan.taskId, artifactSha256, study.sourceEvidence.verificationPlanHash),
      phaseTwoVerification: null,
      rawArtifactPath,
      requestPath,
      requestSha256: sha256HexSync(requestBytes),
      responsePath,
      responseSha256: sha256HexSync(responseBytes),
      runNonce: first.runNonce,
      runOrder: first.runOrder,
      status: 'verification-unavailable',
      taskId: plan.taskId,
      transcriptHash: sha256HexSync(transcriptBytes),
      transcriptPath,
      variant: first.variant,
    } as const;
    await writeFile(join(runDirectory, 'terminal-attempt.json'), `${JSON.stringify(terminal)}\n`);
    const selected = plan.attempts.map(attempt => ({
      arm: underlyingArm(attempt.variant),
      row: {runNonce: attempt.runNonce, runOrder: attempt.runOrder},
      variant: attempt.variant,
    }));
    await initializeMatchedEvaluationContinuationNonceStatesV1({pilotDirectory, plan, selected});
    await markMatchedEvaluationContinuationNonceStartedV1({pilotDirectory, plan, row: selected[0].row});

    const recovered = await recoverMatchedEvaluationContinuationAttemptsV1({
      pilotDirectory,
      plan,
      reportPath: join(pilotDirectory, 'continuation-pilot-report.json'),
      selected,
      selection: {},
    });
    expect(recovered).toEqual([terminal]);

    const second = plan.attempts[1];
    const secondRunDirectory = join(pilotDirectory, 'runs', second.runNonce);
    await mkdir(secondRunDirectory, {recursive: true});
    await writeFile(join(secondRunDirectory, 'request.json'), '{}\n');
    await expect(
      recoverMatchedEvaluationContinuationAttemptsV1({
        pilotDirectory,
        plan,
        reportPath: join(pilotDirectory, 'continuation-pilot-report.json'),
        selected,
        selection: {},
      }),
    ).rejects.toThrow('provider-ambiguous evidence without a terminal journal');

    await rm(runDirectory, {force: true, recursive: true});
    await expect(
      recoverMatchedEvaluationContinuationAttemptsV1({
        pilotDirectory,
        plan,
        reportPath: join(pilotDirectory, 'continuation-pilot-report.json'),
        selected,
        selection: {},
      }),
    ).rejects.toThrow('started without a terminal journal; replay is forbidden');
  });

  it('projects the sealed global schedule and retains failed-attempt lifecycle accounting', () => {
    const study = createStudy();
    const reports = new Map<string, ParsedTaskReport>();
    for (const task of study.tasks) {
      const plan = continuationPlan(task, study.sourceEvidence.verificationPlanHash);
      const scheduled = study.schedule.filter(entry => entry.taskId === task.taskId);
      const attempts: ParsedAttempt[] = scheduled.map((entry, index) => {
        if (entry.globalRunOrder === 1) {
          return {
            accountingStatus: 'retained-agent-checkpoint',
            artifactSha256: null,
            diagnostics: 'adapter failed with exit code 1',
            providerUsage: tokens(12),
            rawArtifactPath: `/tmp/${entry.runNonce}-artifact.json`,
            requestPath: `/tmp/${entry.runNonce}-request.json`,
            requestSha256: null,
            responsePath: `/tmp/${entry.runNonce}-response.json`,
            responseSha256: null,
            runNonce: entry.runNonce,
            runOrder: entry.withinTaskRunOrder,
            status: 'failed',
            taskId: task.taskId,
            timing: {agentTaskMilliseconds: 80, preparationMilliseconds: 20},
            transcriptPath: `/tmp/${entry.runNonce}.jsonl`,
            variant: entry.variant,
          };
        }
        const artifactSha256 = hex(1_000 + entry.globalRunOrder);
        if (entry.globalRunOrder === 2) {
          return {
            accountingStatus: 'retained-observation',
            artifactSha256,
            diagnostics: 'verification command failed as infrastructure',
            metrics: metrics(task.taskId, artifactSha256, study.sourceEvidence.verificationPlanHash),
            rawArtifactPath: `/tmp/${entry.runNonce}-artifact.json`,
            requestPath: `/tmp/${entry.runNonce}-request.json`,
            requestSha256: hex(1_100 + entry.globalRunOrder),
            responsePath: `/tmp/${entry.runNonce}-response.json`,
            responseSha256: hex(1_200 + entry.globalRunOrder),
            runNonce: entry.runNonce,
            runOrder: entry.withinTaskRunOrder,
            status: 'verification-unavailable',
            taskId: task.taskId,
            transcriptHash: hex(1_300 + index),
            transcriptPath: `/tmp/${entry.runNonce}.jsonl`,
            variant: entry.variant,
          };
        }
        return {
          artifactSha256,
          metrics:
            entry.globalRunOrder === 4
              ? failedHeldOutMetrics(task.taskId, artifactSha256, study.sourceEvidence.verificationPlanHash)
              : metrics(task.taskId, artifactSha256, study.sourceEvidence.verificationPlanHash),
          phaseTwoVerification:
            entry.globalRunOrder === 3
              ? failingPhaseTwoVerification(plan, artifactSha256)
              : passingPhaseTwoVerification(plan, artifactSha256),
          rawArtifactPath: `/tmp/${entry.runNonce}-artifact.json`,
          requestPath: `/tmp/${entry.runNonce}-request.json`,
          requestSha256: hex(1_100 + entry.globalRunOrder),
          responsePath: `/tmp/${entry.runNonce}-response.json`,
          responseSha256: hex(1_200 + entry.globalRunOrder),
          runNonce: entry.runNonce,
          runOrder: entry.withinTaskRunOrder,
          status: 'completed',
          taskId: task.taskId,
          transcriptHash: hex(1_300 + index),
          transcriptPath: `/tmp/${entry.runNonce}.jsonl`,
          variant: entry.variant,
        };
      });
      reports.set(task.taskId, {
        attempts,
        phaseOne: {accountingSource: 'sealed-phase-one', elapsedMilliseconds: 50, providerTokens: tokens(10)},
        sourceReportSha256: hex(1_400 + reports.size),
      });
    }

    const outcomes = projectMatchedContinuationOutcomesV1({reports, study});

    expect(outcomes).toHaveLength(25);
    expect(outcomes.map(outcome => outcome.globalRunOrder)).toEqual(Array.from({length: 25}, (_, index) => index + 1));
    expect(outcomes[0]).toMatchObject({
      assessment: null,
      phaseOne: {elapsedMilliseconds: 50, providerTokens: {totalTokens: 10}},
      phaseTwo: {accountingSource: 'failure-checkpoint', elapsedMilliseconds: 100, providerTokens: {totalTokens: 12}},
      status: 'failed',
    });
    expect(outcomes[1].previousOutcomeHash).toBe(outcomes[0].outcomeHash);
    expect(outcomes[1]).toMatchObject({
      assessment: null,
      phaseTwo: {accountingSource: 'verification-unavailable', elapsedMilliseconds: 120},
      status: 'unavailable',
    });
    expect(outcomes[2]).toMatchObject({
      assessment: {deterministicVerified: false},
      phaseTwo: {accountingSource: 'observation', elapsedMilliseconds: 130, providerTokens: {totalTokens: 50}},
      status: 'completed',
    });
    expect(outcomes[3]).toMatchObject({
      assessment: {deterministicVerified: false},
      status: 'completed',
    });
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          study.tasks.map(task => task.taskId),
          {minLength: study.tasks.length, maxLength: study.tasks.length},
        ),
        taskOrder => {
          const reordered = new Map(taskOrder.map(taskId => [taskId, reports.get(taskId)!]));
          expect(projectMatchedContinuationOutcomesV1({reports: reordered, study})).toEqual(outcomes);
        },
      ),
      {numRuns: 20},
    );
  });

  it('requires both held-out and visible continuation verification', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (heldOutPassed, phaseTwoPassed) => {
        expect(
          matchedContinuationDeterministicallyVerifiedV1({
            heldOutStatus: heldOutPassed ? 'passed' : 'task-failed',
            phaseTwoStatus: phaseTwoPassed ? 'passed' : 'task-failed',
          }),
        ).toBe(heldOutPassed && phaseTwoPassed);
      }),
      {numRuns: 64},
    );
  });

  it('publishes one complete output directory and refuses concurrent or later overwrites', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-publisher-')));
    roots.push(root);
    const output = join(root, '.context', 'finalized');
    const first = finalizationArtifacts('first');
    const second = finalizationArtifacts('second');

    const results = await Promise.allSettled([
      publishMatchedContinuationFinalizationV1(output, first),
      publishMatchedContinuationFinalizationV1(output, second),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const receipt = await readFile(join(output, 'continuation-finalization-receipt.json'), 'utf8');
    const selected = receipt === 'first-receipt' ? first : second;
    expect(receipt).toBe(Buffer.from(selected.receipt).toString('utf8'));
    await expect(readFile(join(output, 'continuation-outcomes.jsonl'), 'utf8')).resolves.toBe(
      Buffer.from(selected.outcomeLedger).toString('utf8'),
    );
    await expect(readFile(join(output, 'continuation-report.json'), 'utf8')).resolves.toBe(
      Buffer.from(selected.report).toString('utf8'),
    );
    await expect(readFile(join(output, 'continuation-article-evidence.md'), 'utf8')).resolves.toBe(
      Buffer.from(selected.articleEvidence).toString('utf8'),
    );
    await expect(publishMatchedContinuationFinalizationV1(output, first)).rejects.toThrow('overwrite is not allowed');
    expect((await readdir(join(root, '.context'))).filter(entry => entry.includes('.staging-'))).toEqual([]);
  });
});

function phaseOneTranscript(finalAnswer: {
  readonly citations: readonly {readonly endLine: number; readonly path: string; readonly startLine: number}[];
  readonly completed: boolean;
  readonly summary: string;
}): string {
  return [
    JSON.stringify({
      events: [
        {
          method: 'item/completed',
          params: {item: {phase: 'final_answer', text: JSON.stringify(finalAnswer), type: 'agentMessage'}},
        },
      ],
      kind: 'agent',
    }),
    JSON.stringify({events: [], kind: 'judge'}),
  ].join('\n');
}

function finalizationArtifacts(label: string) {
  return {
    articleEvidence: Buffer.from(`${label}-article`),
    outcomeLedger: Buffer.from(`${label}-ledger`),
    receipt: Buffer.from(`${label}-receipt`),
    report: Buffer.from(`${label}-report`),
  };
}

async function completedReportAttempt(
  root: string,
  plan: TestContinuationPlan,
  attempt: TestContinuationPlan['attempts'][number],
  attemptMetrics: MatchedEvaluationMetricsV1,
) {
  const prefix = join(root, attempt.runNonce);
  const rawArtifactPath = `${prefix}-artifact.json`;
  const requestPath = `${prefix}-request.json`;
  const responsePath = `${prefix}-response.json`;
  const transcriptPath = `${prefix}.jsonl`;
  const checkpointPath = `${transcriptPath}.agent.jsonl`;
  const artifactBytes = Buffer.from(`${JSON.stringify({runNonce: attempt.runNonce})}\n`);
  const requestBytes = Buffer.from(`${JSON.stringify({request: attempt.runNonce})}\n`);
  const responseBytes = Buffer.from(`${JSON.stringify({response: attempt.runNonce})}\n`);
  const transcriptBytes = Buffer.from(`${JSON.stringify({transcript: attempt.runNonce})}\n`);
  await Promise.all([
    writeFile(rawArtifactPath, artifactBytes),
    writeFile(requestPath, requestBytes),
    writeFile(responsePath, responseBytes),
    writeFile(transcriptPath, transcriptBytes),
  ]);
  const variant = attempt.variant;
  return {
    arm: underlyingArm(variant),
    artifactSha256: sha256HexSync(artifactBytes),
    checkpointPath,
    metrics: {
      ...attemptMetrics,
      verification: createMatchedEvaluationVerificationReceiptV1({
        ...attemptMetrics.verification!,
        artifactHash: sha256HexSync(artifactBytes),
      }),
    },
    phaseTwoVerification: passingPhaseTwoVerification(plan, sha256HexSync(artifactBytes)),
    rawArtifactPath,
    requestPath,
    requestSha256: sha256HexSync(requestBytes),
    responsePath,
    responseSha256: sha256HexSync(responseBytes),
    runNonce: attempt.runNonce,
    runOrder: attempt.runOrder,
    status: 'completed' as const,
    taskId: plan.taskId,
    transcriptHash: sha256HexSync(transcriptBytes),
    transcriptPath,
    variant,
  };
}

function taskReport(
  plan: TestContinuationPlan,
  study: ReturnType<typeof createStudy>,
  attempts: readonly Awaited<ReturnType<typeof completedReportAttempt>>[],
) {
  return {
    attempts,
    candidate: plan.candidate,
    checkpoint: projectMatchedEvaluationContinuationSelectionCheckpointV1(plan),
    completed: true,
    completionMeaning: 'completed only when all five fresh phase-two attempts completed',
    comparativeClaimsEligible: false,
    identities: {
      manifestHash: study.sourceEvidence.manifestHash,
      planFileHash: study.tasks.find(task => task.taskId === plan.taskId)!.planSha256,
      runtimeVersion: 4,
      studyHash: study.sourceEvidence.matchedStudyHash,
      verificationPlanHash: study.sourceEvidence.verificationPlanHash,
    },
    limitations: ['No retries are allowed.'],
    phaseTwoPromptSha256: plan.phaseTwoPromptSha256,
    phaseTwoVerificationPlanHash: plan.phaseTwoVerification.planHash,
    planVersion: plan.version,
    rows: plan.attempts.map(attempt => ({
      arm: underlyingArm(attempt.variant),
      blindLabel: attempt.blindLabel,
      position: attempt.runOrder,
      repetition: 1,
      runNonce: attempt.runNonce,
      runOrder: attempt.runOrder,
      taskId: plan.taskId,
      variant: attempt.variant,
    })),
    sourceTask: {
      promptSha256: plan.sourceTask.promptSha256,
      repositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
      repositoryRevision: plan.sourceTask.repositoryRevision,
      taskId: plan.sourceTask.taskId,
    },
    taskId: plan.taskId,
    version: 2,
  };
}

function continuationPlan(
  task: MatchedContinuationStudyTaskV1,
  verificationPlanHash: string,
): MatchedEvaluationContinuationPilotPlanV3 {
  const sourcePrompt = 'Implement the source task.';
  const phaseOnePrompt = `${sourcePrompt}\n\nImplement phase one.`;
  const phaseTwoPrompt = 'Continue phase two.';
  const marker = 'resume-marker-1';
  const handoff = `Task: Continue\nDecisions: frozen\nConstraints: no retries\nRationale: matched\nVerification: ${verificationPlanHash}\nNext step: ${marker}\n`;
  return {
    attempts: Array.from({length: 5}, (_, index) => ({
      blindLabel: ['A', 'B', 'C', 'D', 'E'][index] as 'A' | 'B' | 'C' | 'D' | 'E',
      runNonce: `run_${(index + 1).toString(16).padStart(32, '0')}`,
      runOrder: index + 1,
      variant: MATCHED_CONTINUATION_VARIANTS[index],
    })),
    candidate: {toolArtifactHash: hex(3), toolVersion: '5.1.0-beta.1.local.test'},
    checkpoint: {
      adapterConfigurations: {
        threadnoteCompactSha256: hex(120),
        threadnoteGraphSha256: hex(121),
      },
      automaticHandoffReadSha256: hex(101),
      automaticHandoffUri: 'threadnote://memory/handoff/test',
      handoff,
      handoffSha256: sha256HexSync(handoff),
      phaseOneAccounting: {elapsedMilliseconds: 100, providerTokens: tokens(30), providerTokensMeasured: true},
      phaseOneExecution: {
        adapterArtifactHash: hex(102),
        adapterConfigurationFileSha256: hex(103),
        adapterConfigurationHash: hex(104),
        adapterProtocol: 'matched-evaluation-adapter-v5',
        appServerExecutableSha256: hex(105),
        appServerVersion: 'test',
        artifactSha256: hex(106),
        environmentPolicyHash: hex(107),
        model: {id: 'test', parametersHash: hex(108), provider: 'test', reasoningEffort: 'low'},
        requestSha256: hex(109),
        responseSha256: hex(110),
        runNonce: 'run_000000000000000000000000000000aa',
        transcriptHash: hex(111),
        transcriptSha256: hex(112),
      },
      phaseOnePatchSha256: hex(113),
      phaseOnePrompt,
      phaseOnePromptSha256: sha256HexSync(phaseOnePrompt),
      preparedContext: {
        graphContentHash: hex(114),
        graphSnapshotHash: hex(115),
        linkReceiptsHash: hex(116),
        taskContextHash: hex(117),
      },
      preparedGraphHome: {fixtureHash: hex(122), identitySha256: hex(123)},
      preparedHome: {fixtureHash: hex(118), identitySha256: hex(119)},
      repositoryFixtureHash: task.checkpointRepositoryFixtureHash,
      repositoryRevision: task.checkpointRevision,
      resumeEvidenceMarker: marker,
    },
    phaseTwoPrompt,
    phaseTwoPromptSha256: sha256HexSync(phaseTwoPrompt),
    phaseTwoVerification: createMatchedContinuationPhaseTwoVerificationPlanV1({
      checks: [
        {
          allowedBaselineFailureIds: [],
          commandTokens: ['python', '-m', 'pytest', '-q', 'tests/test_target.py'],
          diagnosticParser: 'pytest-summary-v1',
          policy: 'must-pass',
        },
        {
          allowedBaselineFailureIds: ['tests/test_full.py::test_baseline'],
          commandTokens: ['python', '-m', 'pytest', '-q', 'tests/test_full.py'],
          diagnosticParser: 'pytest-summary-v1',
          policy: 'no-new-failures',
        },
      ],
      protectedPaths: ['tests/test_target.py'],
      taskId: task.taskId,
    }),
    retries: 0,
    sourceTask: {
      prompt: sourcePrompt,
      promptSha256: matchedEvaluationPromptHashV1(sourcePrompt),
      repositoryFixtureHash: task.sourceRepositoryFixtureHash,
      repositoryRevision: task.sourceRevision,
      taskId: task.taskId,
    },
    taskId: task.taskId,
    version: 3,
  };
}

function continuationPlanV4(plan: MatchedEvaluationContinuationPilotPlanV3): MatchedEvaluationContinuationPilotPlanV4 {
  return {
    ...plan,
    checkpoint: {
      ...plan.checkpoint,
      diagnosticEvidence: {
        diagnosticConclusion: 'The focused regression isolates the production defect.',
        graphQuery: 'callers of normalizeNode',
        graphQuestion: 'Which callers depend on normalizeNode?',
        rejectedHypothesis: 'The parser is not the failing component.',
        sourceCitations: [{endLine: 12, path: 'src/normalizer.ts', startLine: 8}],
        unresolvedGap: 'Select the smallest production correction.',
        untestedInvariant: 'Adjacent callers remain covered by the sealed verifier.',
        verifiedInvariant: 'The regression fails at the checkpoint.',
      },
    },
    version: 4,
  };
}

function passingPhaseTwoVerification(plan: TestContinuationPlan, artifactHash: string) {
  return createMatchedContinuationPhaseTwoVerificationReceiptV1({
    artifactHash,
    checks: plan.phaseTwoVerification.checks.map(check =>
      createMatchedContinuationPhaseTwoVerificationCheckReceiptV1({
        artifactHash,
        check,
        diagnosticHash: hex(207),
        durationMilliseconds: 5,
        exitCode: 0,
        failureIds: [],
        planHash: plan.phaseTwoVerification.planHash,
      }),
    ),
    plan: plan.phaseTwoVerification,
    protectedPathViolations: [],
  });
}

function failingPhaseTwoVerification(plan: TestContinuationPlan, artifactHash: string) {
  return createMatchedContinuationPhaseTwoVerificationReceiptV1({
    artifactHash,
    checks: plan.phaseTwoVerification.checks.map(check =>
      createMatchedContinuationPhaseTwoVerificationCheckReceiptV1({
        artifactHash,
        check,
        diagnosticHash: hex(208),
        durationMilliseconds: 5,
        exitCode: check.policy === 'must-pass' ? 0 : 1,
        failureIds: check.policy === 'must-pass' ? [] : ['tests/test_full.py::test_new_regression'],
        planHash: plan.phaseTwoVerification.planHash,
      }),
    ),
    plan: plan.phaseTwoVerification,
    protectedPathViolations: [],
  });
}

function metrics(taskId: string, artifactHash: string, planHash: string): MatchedEvaluationMetricsV1 {
  return {
    auditability: {citations: 2, resolvableCitations: 2},
    completion: {completed: true},
    context: null,
    correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
    drift: {falseCurrentOutcomes: 0},
    providerCostMicros: null,
    retrieval: {recalledEvidence: 2, requiredEvidence: 2},
    safety: {authorizationLeaks: 0, blockedActions: 0, harmfulActions: 0},
    sourceSupport: {requiredClaims: 2, supportedClaims: 2},
    timing: {
      agentTaskMilliseconds: 80,
      deterministicVerifierMilliseconds: 5,
      endToEndMilliseconds: 120,
      firstSufficientEvidenceMilliseconds: 60,
      judgeSetupMilliseconds: 10,
      judgeTurnMilliseconds: 15,
      preparationMilliseconds: 10,
    },
    usage: {
      modelVisibleBytes: 1_000,
      modelVisibleTokens: 40,
      providerTokens: tokens(50),
      redundantFileReads: 0,
      toolTurns: 2,
    },
    validity: {failureCount: 0, valid: true},
    verification: createMatchedEvaluationVerificationReceiptV1({
      artifactHash,
      diagnosticHash: hex(201),
      durationMilliseconds: 5,
      environmentHash: hex(202),
      exitCode: 0,
      interpreterHash: hex(203),
      planHash,
      runnerHash: hex(204),
      sandboxExecutableHash: hex(205),
      status: 'passed',
      taskId,
      verificationId: hex(206),
    }),
  };
}

function failedHeldOutMetrics(taskId: string, artifactHash: string, planHash: string): MatchedEvaluationMetricsV1 {
  const passing = metrics(taskId, artifactHash, planHash);
  return {
    ...passing,
    completion: {completed: false},
    verification: createMatchedEvaluationVerificationReceiptV1({
      ...passing.verification!,
      diagnosticHash: hex(209),
      exitCode: 1,
      status: 'task-failed',
    }),
  };
}

function createStudy() {
  const tasks = Array.from({length: 5}, (_, index): MatchedContinuationStudyTaskV1 => ({
    checkpointRepositoryFixtureHash: hex(index + 40),
    checkpointRevision: commit(index + 40),
    clusterId: `cluster_${hex(index + 10).slice(-16)}`,
    planSha256: hex(index + 50),
    repositoryUrl: `https://example.com/org/repository-${index}.git`,
    sourceRepositoryFixtureHash: hex(index + 20),
    sourceRevision: commit(index + 20),
    taskId: `tsk_${hex(index + 30).slice(-16)}`,
  }));
  let globalRunOrder = 0;
  return createMatchedContinuationStudyV1({
    bootstrap: {confidenceLevelBasisPoints: 9_500, iterations: 200, seed: hex(1)},
    candidate: {
      adapterArtifactSha256: hex(2),
      sourceCommit: commit(2),
      toolArtifactHash: hex(3),
      toolVersion: '5.1.0-beta.1.local.test',
    },
    gates: {
      completionNonInferiorityBasisPoints: 500,
      maximumAuthorizationLeaks: 0,
      maximumFalseCurrentOutcomes: 0,
      maximumHarmfulActions: 0,
      minimumClusters: 5,
      minimumCorrectnessScoreMilli: 1_000,
      minimumTokenReductionBasisPoints: 500,
    },
    schedule: tasks.flatMap((task, taskIndex) =>
      Array.from({length: 5}, (_, position) => {
        globalRunOrder += 1;
        return {
          globalRunOrder,
          runNonce: `run_${globalRunOrder.toString(16).padStart(32, '0')}`,
          taskId: task.taskId,
          variant: MATCHED_CONTINUATION_VARIANTS[(position + taskIndex) % 5],
          withinTaskRunOrder: position + 1,
        };
      }),
    ),
    sourceEvidence: {
      corpusHash: hex(4),
      exposureAuditSha256: hex(9),
      manifestHash: hex(5),
      matchedPreparationReceiptSha256: hex(8),
      matchedStudyHash: hex(6),
      verificationPlanHash: hex(7),
    },
    studyId: 'held-out-continuation-v1',
    tasks,
    variants: MATCHED_CONTINUATION_VARIANTS,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt',
  });
}

function tokens(totalTokens: number) {
  return {
    cachedInputTokens: 0,
    inputTokens: Math.floor(totalTokens / 2),
    outputTokens: totalTokens - Math.floor(totalTokens / 2),
    reasoningOutputTokens: 0,
    totalTokens,
  };
}

function underlyingArm(variant: (typeof MATCHED_CONTINUATION_VARIANTS)[number]) {
  if (variant === 'files-bare' || variant === 'manual-handoff') return 'files' as const;
  if (variant === 'threadnote-graph') return 'threadnote-graph' as const;
  return 'threadnote-compact' as const;
}

function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function commit(seed: number): string {
  return seed.toString(16).padStart(40, '0');
}
