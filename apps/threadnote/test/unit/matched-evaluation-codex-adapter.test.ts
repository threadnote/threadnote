import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {delimiter, dirname, join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  assertMatchedEvaluationContextDeliveryV1,
  assertMatchedEvaluationMcpInventoryV1,
  assertMatchedEvaluationPreloadedContextV1,
  assertMatchedEvaluationProductionCodexResumeHookV1,
  analyzeMatchedEvaluationAttributionV1,
  countMatchedEvaluationBlockedActionsV1,
  createMatchedEvaluationAppServerFailureEvidenceV1,
  extractMatchedEvaluationProviderUsageV1,
  matchedEvaluationCodexEnvironmentPolicyHashV1,
  matchedEvaluationDependencyProjectionFixtureHashV1,
  matchedEvaluationPreparedHomeFixtureHashV1,
  matchedEvaluationVerifierEnvironmentHashV1,
  matchedEvaluationVerifierStatusFromDiagnosticV1,
  materializeMatchedEvaluationDependencyProjectionV1,
  parseMatchedEvaluationCodexAdapterRequestV1,
  parseMatchedEvaluationCodexAdapterConfigV1,
  persistMatchedEvaluationFailureTranscriptsV1,
  renderMatchedEvaluationAgentPromptV1,
  renderMatchedEvaluationApprovedCommandV1,
  renderMatchedEvaluationJudgePromptV1,
  renderMatchedEvaluationCommandReviewRulesV1,
  renderMatchedEvaluationAgentInstructionsV1,
  renderVerifierSeatbeltProfile,
  runMatchedEvaluationActionPreflightV1,
  runMatchedEvaluationCodexAdapter,
  runMatchedEvaluationDeterministicVerifierV1,
  type MatchedEvaluationExpectedContextDeliveryV1,
} from '../../../../scripts/matched-evaluation-codex-adapter.js';
import {tokenizeCodeMemoryLinkCommandV1} from '../../../../scripts/code-memory-link-app-server-policy.js';
import {MATCHED_EVALUATION_CONTEXT_PROXY_VERSION} from '../../../../scripts/matched-evaluation-context-proxy.js';
import {hashMatchedEvaluationContextRequest} from '../../../../scripts/matched-evaluation-context-proxy.js';
import {
  createMatchedEvaluationVerificationCalibrationV1,
  createMatchedEvaluationVerificationPlanV1,
  matchedEvaluationVerificationIdV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {captureCodeMemoryLinkProcessGroup} from '../../../../scripts/code-memory-link-process-boundary.js';
import {observeMatchedEvaluationRepositoryV1} from '../../../../scripts/matched-evaluation-runtime-integrity.js';

describe('matched evaluation Codex adapter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('instructs both interactive arms to use graph follow-ups and only the linked arm to use memory', () => {
    for (const detail of ['compact', 'graph-only'] as const) {
      const instructions = renderMatchedEvaluationAgentInstructionsV1(detail);
      expect(instructions).toContain('inspect_code_graph and analyze_code_graph');
      expect(instructions).not.toContain('only MCP tool is context_brief');
      expect(instructions).toContain('prepared base');
    }
    expect(renderMatchedEvaluationAgentInstructionsV1('compact')).toContain('recall_context and read_context');
    expect(renderMatchedEvaluationAgentInstructionsV1('graph-only')).toContain('Memory tools are unavailable');
    expect(renderMatchedEvaluationAgentInstructionsV1('compact', 1)).toContain('use at most 1');
    expect(renderMatchedEvaluationAgentInstructionsV1('source')).toContain('only MCP tool is context_brief');
    expect(renderMatchedEvaluationAgentInstructionsV1(null)).toContain('No MCP tools are available');
    expect(renderMatchedEvaluationAgentInstructionsV1(null)).toContain(
      'never place multiple commands on literal newline-separated shell lines',
    );
  });

  it('accepts only the four coherent sealed continuation treatments', () => {
    const manualHandoff = 'Task: continue phase two\n\nNext step: update the focused test.';
    const treatments = [
      {
        arm: 'files',
        continuationTreatment: {
          variant: 'files-bare',
          contextMode: null,
          manualHandoff: null,
          manualHandoffSha256: null,
          automaticHandoffUri: null,
          requiredGraphQuery: null,
          resumeEvidenceMarker: null,
        },
      },
      {
        arm: 'files',
        continuationTreatment: {
          variant: 'manual-handoff',
          contextMode: null,
          manualHandoff,
          manualHandoffSha256: sha256HexSync(manualHandoff),
          automaticHandoffUri: null,
          requiredGraphQuery: null,
          resumeEvidenceMarker: null,
        },
      },
      {
        arm: 'threadnote-graph',
        continuationTreatment: {
          variant: 'threadnote-graph',
          contextMode: 'brief',
          manualHandoff: null,
          manualHandoffSha256: null,
          automaticHandoffUri: null,
          requiredGraphQuery: null,
          resumeEvidenceMarker: null,
        },
      },
      {
        arm: 'threadnote-compact',
        continuationTreatment: {
          variant: 'threadnote-resume',
          contextMode: 'resume',
          manualHandoff: null,
          manualHandoffSha256: null,
          automaticHandoffUri: 'threadnote://handoff/phase-one',
          requiredGraphQuery: null,
          resumeEvidenceMarker: 'resume-marker-123',
        },
      },
      {
        arm: 'threadnote-compact',
        continuationTreatment: {
          variant: 'threadnote-preloaded-resume',
          contextMode: 'resume',
          manualHandoff: null,
          manualHandoffSha256: null,
          automaticHandoffUri: 'threadnote://handoff/phase-one',
          requiredGraphQuery: 'find the production caller that violates the verified invariant',
          resumeEvidenceMarker: 'resume-marker-123',
        },
      },
    ] as const;
    for (const treatment of treatments) {
      expect(
        parseMatchedEvaluationCodexAdapterRequestV1(adapterRequest(treatment.arm, treatment.continuationTreatment)),
      ).toMatchObject(treatment);
    }
    expect(() =>
      parseMatchedEvaluationCodexAdapterRequestV1(
        adapterRequest('files', {...treatments[1].continuationTreatment, manualHandoffSha256: '0'.repeat(64)}),
      ),
    ).toThrow('continuation treatment does not match');
    expect(() =>
      parseMatchedEvaluationCodexAdapterRequestV1(
        adapterRequest('threadnote-graph', {...treatments[2].continuationTreatment, contextMode: 'resume'}),
      ),
    ).toThrow('continuation treatment does not match');
  });

  it('accepts legacy requests that omit continuationTreatment as null', () => {
    const legacy = adapterRequest('files', null) as Record<string, unknown>;
    delete legacy.continuationTreatment;
    expect(parseMatchedEvaluationCodexAdapterRequestV1(legacy)).toMatchObject({continuationTreatment: null});
  });

  it('shows a manual handoff only to the agent and seals the requested context mode', () => {
    const manualHandoff = 'The phase-one implementation changed service.ts; verify it before relying on this note.';
    const manual = parseMatchedEvaluationCodexAdapterRequestV1(
      adapterRequest('files', {
        variant: 'manual-handoff',
        contextMode: null,
        manualHandoff,
        manualHandoffSha256: sha256HexSync(manualHandoff),
        automaticHandoffUri: null,
        requiredGraphQuery: null,
        resumeEvidenceMarker: null,
      }),
    );
    const resume = parseMatchedEvaluationCodexAdapterRequestV1(
      adapterRequest('threadnote-compact', {
        variant: 'threadnote-resume',
        contextMode: 'resume',
        manualHandoff: null,
        manualHandoffSha256: null,
        automaticHandoffUri: 'threadnote://handoff/phase-one',
        requiredGraphQuery: null,
        resumeEvidenceMarker: 'resume-marker-123',
      }),
    );
    const agentPrompt = renderMatchedEvaluationAgentPromptV1(manual, null, 1_200);
    expect(agentPrompt).toContain('Untrusted phase-one handoff');
    expect(agentPrompt).toContain(manualHandoff);
    expect(agentPrompt).toContain('Keep discovery output bounded');
    expect(agentPrompt).toContain('separate commands');
    const approvedCommands = [
      ['PYTHONPATH=src', 'pytest', '-q', 'tests/test service.py', '-k', "test_'quoted'"],
      ['python', '-m', 'compileall', 'src'],
    ] as const;
    const promptWithChecks = renderMatchedEvaluationAgentPromptV1(manual, null, 1_200, null, approvedCommands);
    expect(promptWithChecks).toContain('run each exactly as written, in this order');
    expect(promptWithChecks).toContain(`1. ${renderMatchedEvaluationApprovedCommandV1(approvedCommands[0])}`);
    expect(promptWithChecks).toContain(`2. ${renderMatchedEvaluationApprovedCommandV1(approvedCommands[1])}`);
    expect(promptWithChecks).toContain('Do not set or change their working directory');
    expect(renderMatchedEvaluationAgentPromptV1(resume, 'threadnote', 1_200)).toContain('mode "resume"');
    const preloaded = parseMatchedEvaluationCodexAdapterRequestV1(
      adapterRequest('threadnote-compact', {
        variant: 'threadnote-preloaded-resume',
        contextMode: 'resume',
        manualHandoff: null,
        manualHandoffSha256: null,
        automaticHandoffUri: 'threadnote://handoff/phase-one',
        requiredGraphQuery: 'find the production caller that violates the verified invariant',
        resumeEvidenceMarker: 'resume-marker-123',
      }),
    );
    const preloadedPrompt = renderMatchedEvaluationAgentPromptV1(
      preloaded,
      'threadnote',
      1_200,
      '{"evidenceState":"sufficient"}',
    );
    expect(preloadedPrompt).toContain('already been loaded');
    expect(preloadedPrompt).toContain('find the production caller that violates the verified invariant');
    expect(preloadedPrompt).toContain('Omit budgetTokens');
    expect(preloadedPrompt).not.toContain('{"evidenceState":"sufficient"}');
    expect(preloadedPrompt).not.toContain('call context_brief exactly once');
    const preloadedInstructions = renderMatchedEvaluationAgentInstructionsV1(
      'compact',
      1,
      'preloaded',
      '{"evidenceState":"sufficient"}',
      'find the production caller that violates the verified invariant',
    );
    expect(preloadedInstructions).toContain('Do not call context_brief');
    expect(preloadedInstructions).toContain('Omit budgetTokens');
    expect(preloadedInstructions).toContain('{"evidenceState":"sufficient"}');
    const judgePrompt = renderMatchedEvaluationJudgePromptV1(manual, {
      agentResult: {completed: true},
      patch: '',
      patchSha256: sha256HexSync(''),
    });
    expect(judgePrompt).not.toContain(manualHandoff);
    expect(judgePrompt).toContain(manual.agentTask.prompt);
  });

  it('renders every approved command token sequence without changing its shell meaning', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            'PYTHONPATH=src',
            'pytest',
            '-q',
            'tests/test_service.py',
            'name with spaces',
            "single'quote",
            'selector[case]',
          ),
          {maxLength: 12, minLength: 1},
        ),
        tokens => {
          expect(tokenizeCodeMemoryLinkCommandV1(renderMatchedEvaluationApprovedCommandV1(tokens))).toEqual(tokens);
        },
      ),
      {numRuns: 100},
    );
  });

  it('requires successful context delivery bound to the sealed prompt, run, home and response', () => {
    const {event, expected, item, receipt, result} = contextDelivery();
    expect(() => assertMatchedEvaluationContextDeliveryV1([event], expected)).not.toThrow();
    expect(receipt.mode).toBe(expected.mode);
    expect(() => assertMatchedEvaluationContextDeliveryV1([], null)).not.toThrow();
    expect(() => assertMatchedEvaluationContextDeliveryV1([event], null)).toThrow('Files-only arm');
    for (const events of [[], [event, event]]) {
      expect(() => assertMatchedEvaluationContextDeliveryV1(events, expected)).toThrow();
    }
    const withItem = (patch: Record<string, unknown>) => [{...event, params: {item: {...item, ...patch}}}];
    const withResult = (patch: Record<string, unknown>) => withItem({result: {...result, ...patch}});
    // The pilot counted this failed request as valid solely because item/completed existed.
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1(
        withItem({
          status: 'failed',
          result: {content: [{type: 'text', text: 'Context request task differs from the sealed task prompt.'}]},
        }),
        expected,
      ),
    ).toThrow('did not complete successfully');
    for (const patch of [{status: 'inProgress'}, {error: {message: 'failed'}}, {server: 'other'}]) {
      expect(() => assertMatchedEvaluationContextDeliveryV1(withItem(patch), expected)).toThrow();
    }
    for (const patch of [
      {isError: true},
      {_meta: null},
      {structuredContent: {}},
      {content: []},
      {content: [{type: 'text', text: ''}]},
      {content: [{type: 'image', data: 'unexpected'}]},
      {content: [...result.content, ...result.content]},
      {content: [{type: 'text', text: 'changed after receipt'}]},
    ]) {
      expect(() => assertMatchedEvaluationContextDeliveryV1(withResult(patch), expected)).toThrow();
    }
    for (const key of Object.keys(receipt)) {
      expect(() =>
        assertMatchedEvaluationContextDeliveryV1(
          withResult({_meta: {matchedEvaluation: {...receipt, [key]: 'mismatch'}}}),
          expected,
        ),
      ).toThrow('receipt mismatch');
    }
  });

  it('validates a pre-turn resume payload and forbids a duplicate context brief', () => {
    const base = contextDelivery('{"evidenceState":"sufficient"}');
    const expected = {
      ...base.expected,
      expectedResumeHash: '7'.repeat(64),
      initialBriefDelivery: 'preloaded' as const,
      maximumFollowupCalls: 1,
      mode: 'resume' as const,
    };
    const request = {
      budgetTokens: 1_500,
      callerCwd: '/isolated/repository',
      mode: 'resume',
      project: 'threadnote',
    };
    const receipt = {
      ...base.receipt,
      expectedResumeHash: expected.expectedResumeHash,
      mode: expected.mode,
      requestSha256: hashMatchedEvaluationContextRequest('context_brief', request),
    };
    const preloaded = assertMatchedEvaluationPreloadedContextV1(
      {content: base.result.content, meta: {matchedEvaluation: receipt}},
      expected,
      17,
      request,
    );
    expect(preloaded).toMatchObject({
      receipt: {elapsedMilliseconds: 17, source: 'adapter-pre-turn'},
      text: '{"evidenceState":"sufficient"}',
    });
    expect(() =>
      assertMatchedEvaluationPreloadedContextV1(
        {content: base.result.content, meta: {matchedEvaluation: {...receipt, requestSha256: '0'.repeat(64)}}},
        expected,
        17,
        request,
      ),
    ).toThrow('requestSha256');
    expect(() =>
      assertMatchedEvaluationPreloadedContextV1(
        {content: [...base.result.content, ...base.result.content], meta: {matchedEvaluation: receipt}},
        expected,
        17,
        request,
      ),
    ).toThrow('exactly one text body');
    expect(() => assertMatchedEvaluationContextDeliveryV1([], expected)).not.toThrow();
    expect(() => assertMatchedEvaluationContextDeliveryV1([base.event], expected)).toThrow(
      'unexpected MCP server or tool',
    );
  });

  it('requires the sealed graph query as the first and only diagnostic continuation action', () => {
    const base = contextDelivery();
    const requiredGraphQuery = 'find callers from normalizeNode to renderSuggestion';
    const diagnosticBase = {
      ...base,
      expected: {
        ...base.expected,
        initialBriefDelivery: 'preloaded' as const,
        maximumFollowupCalls: 1,
        requiredGraphQuery,
      },
    };
    const graph = contextFollowup(
      diagnosticBase,
      'inspect_code_graph',
      {operation: 'query', query: requiredGraphQuery},
      'completed',
      false,
    );
    const startedGraph = {...graph.event, method: 'item/started'};
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1([startedGraph, graph.event], diagnosticBase.expected),
    ).not.toThrow();
    const startedCommand = {
      method: 'item/started',
      params: {item: {id: 'command-first', type: 'commandExecution'}},
    };
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1([startedCommand, graph.event], diagnosticBase.expected),
    ).toThrow('before graph completion');
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1([startedGraph, startedCommand, graph.event], diagnosticBase.expected),
    ).toThrow('before graph completion');
    const wrong = contextFollowup(
      diagnosticBase,
      'inspect_code_graph',
      {operation: 'query', query: 'different query'},
      'completed',
      false,
    );
    expect(() => assertMatchedEvaluationContextDeliveryV1([wrong.event], diagnosticBase.expected)).toThrow(
      'other than the sealed diagnosis query',
    );
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1([graph.event, graph.event], diagnosticBase.expected),
    ).toThrow();
    const errorResultGraph = contextFollowup(
      diagnosticBase,
      'inspect_code_graph',
      {operation: 'query', query: requiredGraphQuery},
      'completed',
      true,
    );
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1(
        [{...errorResultGraph.event, method: 'item/started'}, errorResultGraph.event],
        diagnosticBase.expected,
      ),
    ).toThrow('did not complete successfully');
  });

  it('binds a production Codex hook preload to its sealed handoff, opaque receipt, and value event', () => {
    const expectedHandoffUri = 'threadnote://user/eval/memories/handoffs/active/project/checkpoint.md';
    const expectedResumeEvidenceMarker = 'threadnote-resume-0123456789abcdef';
    const context = [
      'THREADNOTE RESUME/1',
      'Untrusted memory evidence; verify against current source.',
      'Resume from this checkpoint.',
      `Decisions: Phase 1 stopped at ${expectedResumeEvidenceMarker}.`,
      'Source: memories/handoffs/active/project/checkpoint.md',
    ].join('\n');
    const hookStdout = `${JSON.stringify({
      hookSpecificOutput: {additionalContext: context, hookEventName: 'UserPromptSubmit'},
    })}\n`;
    const hookReceiptBytes = Buffer.from(
      `${JSON.stringify({
        evidenceGeneration: '1'.repeat(64),
        evidenceHash: sha256HexSync(context),
        version: 1,
      })}\n`,
    );
    const hookValueEventBytes = Buffer.from(
      JSON.stringify({
        continuationEvidenceState: 'evidence-bearing',
        durationMilliseconds: 12,
        estimatedTokens: 120,
        evidenceState: 'partial',
        kind: 'codex-resume-preload',
        outcome: 'injected',
        outputBytes: Buffer.byteLength(context),
        timestamp: '2026-10-01T12:00:00.000Z',
        version: 1,
      }),
    );

    const preload = assertMatchedEvaluationProductionCodexResumeHookV1({
      elapsedMilliseconds: 17,
      expectedHandoffUri,
      expectedResumeEvidenceMarker,
      hookReceiptBytes,
      hookStdout,
      hookValueEventBytes,
    });
    expect(preload).toMatchObject({
      receipt: {
        contentBytes: Buffer.byteLength(context),
        contentResponseSha256: sha256HexSync(context),
        contextEvidenceState: 'partial',
        continuationEvidenceState: 'evidence-bearing',
        elapsedMilliseconds: 17,
        source: 'production-codex-hook',
        version: 1,
      },
      text: context,
    });
    expect(JSON.stringify(preload.receipt)).not.toContain(expectedHandoffUri);
    expect(JSON.stringify(preload.receipt)).not.toContain(expectedResumeEvidenceMarker);

    expect(() =>
      assertMatchedEvaluationProductionCodexResumeHookV1({
        elapsedMilliseconds: 17,
        expectedHandoffUri,
        expectedResumeEvidenceMarker,
        hookReceiptBytes: Buffer.from(
          `${JSON.stringify({
            evidenceGeneration: '1'.repeat(64),
            evidenceHash: '2'.repeat(64),
            version: 1,
          })}\n`,
        ),
        hookStdout,
        hookValueEventBytes,
      }),
    ).toThrow('does not bind');
    expect(() =>
      assertMatchedEvaluationProductionCodexResumeHookV1({
        elapsedMilliseconds: 17,
        expectedHandoffUri,
        expectedResumeEvidenceMarker: 'missing-sealed-marker',
        hookReceiptBytes,
        hookStdout,
        hookValueEventBytes,
      }),
    ).toThrow('resume evidence marker');
    expect(() =>
      assertMatchedEvaluationProductionCodexResumeHookV1({
        elapsedMilliseconds: 17,
        expectedHandoffUri,
        expectedResumeEvidenceMarker,
        hookReceiptBytes,
        hookStdout,
        hookValueEventBytes: Buffer.from(
          JSON.stringify({
            continuationEvidenceState: 'evidence-bearing',
            durationMilliseconds: 12,
            estimatedTokens: 801,
            evidenceState: 'partial',
            kind: 'codex-resume-preload',
            outcome: 'injected',
            outputBytes: Buffer.byteLength(context),
            timestamp: '2026-10-01T12:00:00.000Z',
            version: 1,
          }),
        ),
      }),
    ).toThrow('estimated tokens');
    expect(() =>
      assertMatchedEvaluationProductionCodexResumeHookV1({
        elapsedMilliseconds: 17,
        expectedHandoffUri,
        expectedResumeEvidenceMarker,
        hookReceiptBytes,
        hookStdout,
        hookValueEventBytes: Buffer.from(
          JSON.stringify({
            continuationEvidenceState: 'background',
            durationMilliseconds: 12,
            estimatedTokens: 120,
            evidenceState: 'degraded',
            kind: 'codex-resume-preload',
            outcome: 'injected',
            outputBytes: Buffer.byteLength(context),
            timestamp: '2026-10-01T12:00:00.000Z',
            version: 1,
          }),
        ),
      }),
    ).toThrow('does not attest');
  });

  it('detects any changed delivered content while accepting deterministic receipt bindings', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 128}), text => {
        const {event, expected, item, result} = contextDelivery(JSON.stringify({answer: text}));
        expect(() => assertMatchedEvaluationContextDeliveryV1([event], expected)).not.toThrow();
        const changed = {
          ...event,
          params: {
            item: {
              ...item,
              result: {
                ...result,
                content: [{type: 'text', text: `${result.content[0].text} `}],
              },
            },
          },
        };
        expect(() => assertMatchedEvaluationContextDeliveryV1([changed], expected)).toThrow('contentResponseSha256');
      }),
      {numRuns: 40},
    );
  });

  it('accepts compact graph and memory follow-ups, binds original arguments, and retains failed receipts', () => {
    const base = contextDelivery();
    const graph = contextFollowup(base, 'inspect_code_graph', {query: 'service'}, 'completed', false);
    const memory = contextFollowup(
      {...base, event: graph.event},
      'recall_context',
      {query: 'prior decision'},
      'completed',
      false,
      'memory-call',
    );
    const failed = contextFollowup(
      {...base, event: memory.event},
      'read_context',
      {uri: 'threadnote://bounded'},
      'failed',
      true,
      'failed-call',
    );
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1([base.event, graph.event, memory.event, failed.event], base.expected),
    ).not.toThrow();
    const normalizedFailedReceipt = {
      ...failed.event,
      params: {
        item: {
          ...failed.item,
          result: {
            ...failed.item.result,
            isError: undefined,
            structuredContent: null,
          },
        },
      },
    };
    expect(
      assertMatchedEvaluationContextDeliveryV1(
        [base.event, graph.event, memory.event, normalizedFailedReceipt],
        base.expected,
      ),
    ).toEqual({incompleteOptionalFailures: 0, optionalFailures: 1, version: 1});
    const tampered = {...graph.event, params: {item: {...graph.item, arguments: {query: 'changed'}}}};
    expect(() => assertMatchedEvaluationContextDeliveryV1([base.event, tampered], base.expected)).toThrow(
      'requestSha256',
    );
    for (const field of ['runNonce', 'frozenPromptSha256', 'runtimeManifestSha256'] as const) {
      const receipt = {...base.receipt, [field]: 'tampered'};
      const event = {
        ...base.event,
        params: {item: {...base.item, result: {...base.result, _meta: {matchedEvaluation: receipt}}}},
      };
      expect(() => assertMatchedEvaluationContextDeliveryV1([event], base.expected)).toThrow('receipt mismatch');
    }
    const sourceExpected = {...base.expected, detail: 'source' as const};
    expect(() => assertMatchedEvaluationContextDeliveryV1([base.event, graph.event], sourceExpected)).toThrow(
      'unexpected MCP server or tool',
    );
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1([base.event, graph.event, memory.event], {
        ...base.expected,
        maximumFollowupCalls: 1,
      }),
    ).toThrow('follow-up call budget');
  });

  it('retains an auditable optional MCP failure when app-server omits its error payload', () => {
    const base = contextDelivery();
    const failed = contextFollowup(base, 'inspect_code_graph', {query: 'service'}, 'failed', false);
    const missingFailurePayload = {
      ...failed.event,
      params: {item: {...failed.item, error: null, result: null}},
    };

    expect(assertMatchedEvaluationContextDeliveryV1([base.event, missingFailurePayload], base.expected)).toEqual({
      incompleteOptionalFailures: 1,
      optionalFailures: 1,
      version: 1,
    });
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1(
        [
          base.event,
          {
            ...missingFailurePayload,
            params: {item: {...missingFailurePayload.params.item, error: {message: 'ambiguous failure'}}},
          },
        ],
        base.expected,
      ),
    ).toThrow('reported an error');
    expect(() =>
      assertMatchedEvaluationContextDeliveryV1(
        [
          {
            ...base.event,
            params: {item: {...base.item, error: null, result: null, status: 'failed'}},
          },
        ],
        base.expected,
      ),
    ).toThrow('context_brief did not complete successfully');
  });

  it('retains a normalized optional budget rejection after the allowed context was delivered', () => {
    const base = contextDelivery();
    const graph = contextFollowup(base, 'inspect_code_graph', {query: 'service'}, 'completed', false);
    const rejected = contextFollowup(
      {...base, event: graph.event},
      'inspect_code_graph',
      {query: 'second query'},
      'failed',
      false,
      'rejected-call',
    );
    const normalized = {
      ...rejected.event,
      params: {
        item: {
          ...rejected.item,
          error: null,
          result: {
            content: [{type: 'text', text: 'Context follow-up call exceeds the sealed treatment budget.'}],
            structuredContent: null,
            _meta: null,
          },
        },
      },
    };

    expect(
      assertMatchedEvaluationContextDeliveryV1([base.event, graph.event, normalized], {
        ...base.expected,
        maximumFollowupCalls: 1,
      }),
    ).toEqual({
      incompleteOptionalFailures: 1,
      optionalFailures: 1,
      version: 1,
    });
    for (const itemPatch of [
      {error: {message: 'ambiguous failure'}},
      {result: {...rejected.item.result, isError: 'yes'}},
    ]) {
      expect(() =>
        assertMatchedEvaluationContextDeliveryV1(
          [base.event, graph.event, {...normalized, params: {item: {...normalized.params.item, ...itemPatch}}}],
          {...base.expected, maximumFollowupCalls: 1},
        ),
      ).toThrow();
    }
  });

  it('counts declined command and edit attempts separately from executed actions', () => {
    const events = ['commandExecution', 'fileChange', 'mcpToolCall'].flatMap(type =>
      ['item/started', 'item/completed'].flatMap(method =>
        ['declined', 'completed', 'failed'].map(status => ({method, params: {item: {type, status}}})),
      ),
    );
    expect(countMatchedEvaluationBlockedActionsV1(events)).toBe(2);
  });

  it('preflights source reads, one-shot file changes, and unsafe-action rejection before a provider turn', async () => {
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    await mkdir(repository);
    await writeFile(join(repository, 'service.ts'), 'export const value = 1;\nsecond line\n');

    const receipt = await runMatchedEvaluationActionPreflightV1({
      repositoryRoot: repository,
      runNonce: 'run_0123456789abcdef0123456789abcdef',
      safeExecutablePath: '/usr/bin:/bin',
      sourcePath: 'service.ts',
    });

    expect(receipt).toMatchObject({
      appliedAndReverted: true,
      approvedActions: 6,
      rejectedActions: 4,
      sourcePath: 'service.ts',
      version: 1,
    });
    expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.sourceReadSha256).toBe(sha256HexSync('export const value = 1;\n'));
    expect((await readdir(repository)).filter(name => name.startsWith('.threadnote-evaluation-preflight-'))).toEqual(
      [],
    );
  });

  it('preflights every exact task-approved command before a provider turn', async () => {
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    await mkdir(repository);
    await writeFile(join(repository, 'service.ts'), 'export const value = 1;\n');

    const receipt = await runMatchedEvaluationActionPreflightV1({
      approvedCommandTokens: [['PYTHONPATH=src', 'pytest', '-q', 'tests/test_service.py']],
      repositoryRoot: repository,
      runNonce: 'run_0123456789abcdef0123456789abcdef',
      safeExecutablePath: '/usr/bin:/bin',
      sourcePath: 'service.ts',
    });

    expect(receipt).toMatchObject({approvedActions: 7, rejectedActions: 4});
  });

  it('materializes a hash-bound dependency projection with repository-local workspace symlinks', async () => {
    const root = await temporaryRoot(roots);
    const sourceRepository = join(root, 'source-repository');
    const targetRepository = join(root, 'target-repository');
    for (const repository of [sourceRepository, targetRepository]) {
      await mkdir(join(repository, 'packages'), {recursive: true});
      await writeFile(join(repository, 'bun.lock'), 'sealed-lock\n');
      await writeFile(join(repository, 'packages', 'workspace.js'), 'export const workspace = true;\n');
    }
    const sourceDependencies = join(sourceRepository, 'node_modules');
    await mkdir(join(sourceDependencies, '.store', 'pkg'), {recursive: true});
    await writeFile(join(sourceDependencies, '.store', 'pkg', 'index.js'), 'export const pkg = true;\n');
    await symlink('.store/pkg', join(sourceDependencies, 'pkg'));
    await symlink('../packages/workspace.js', join(sourceDependencies, 'workspace.js'));
    await symlink('.store/optional-missing', join(sourceDependencies, 'optional-missing'));
    const fixtureHash = await matchedEvaluationDependencyProjectionFixtureHashV1(sourceDependencies, sourceRepository);
    const projection = {
      architecture: process.arch,
      fixtureHash,
      lockFileRelativePath: 'bun.lock',
      lockFileSha256: sha256HexSync('sealed-lock\n'),
      platform: process.platform,
      sourceDirectory: sourceDependencies,
      sourceRepositoryDirectory: sourceRepository,
      targetRelativePath: 'node_modules',
      taskId: 'tsk_0123456789abcdef',
    } as const;

    const materialized = await materializeMatchedEvaluationDependencyProjectionV1({
      projection,
      repositoryRoot: targetRepository,
    });

    expect(materialized.fixtureHash).toBe(fixtureHash);
    expect(
      await matchedEvaluationDependencyProjectionFixtureHashV1(
        join(targetRepository, 'node_modules'),
        targetRepository,
      ),
    ).toBe(fixtureHash);
    expect(await readFile(join(targetRepository, 'node_modules', 'pkg', 'index.js'), 'utf8')).toContain('pkg = true');
    expect(await readFile(join(targetRepository, 'node_modules', 'workspace.js'), 'utf8')).toContain(
      'workspace = true',
    );
  });

  it('rejects a dependency projection symlink that escapes its source repository', async () => {
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    const dependencies = join(repository, 'node_modules');
    await mkdir(dependencies, {recursive: true});
    await writeFile(join(root, 'outside.js'), 'outside\n');
    await symlink('../../outside.js', join(dependencies, 'escape.js'));

    await expect(matchedEvaluationDependencyProjectionFixtureHashV1(dependencies, repository)).rejects.toThrow(
      'escapes its source repository',
    );
  });

  it('rejects a dependency lock symlink that escapes its source repository', async () => {
    const root = await temporaryRoot(roots);
    const sourceRepository = join(root, 'source');
    const targetRepository = join(root, 'target');
    const dependencies = join(sourceRepository, 'node_modules');
    await Promise.all([mkdir(dependencies, {recursive: true}), mkdir(targetRepository)]);
    await writeFile(join(dependencies, 'package.js'), 'package\n');
    await writeFile(join(root, 'outside.lock'), 'outside\n');
    await symlink('../outside.lock', join(sourceRepository, 'bun.lock'));
    await writeFile(join(targetRepository, 'bun.lock'), 'outside\n');
    const fixtureHash = await matchedEvaluationDependencyProjectionFixtureHashV1(dependencies, sourceRepository);

    await expect(
      materializeMatchedEvaluationDependencyProjectionV1({
        projection: {
          architecture: process.arch,
          fixtureHash,
          lockFileRelativePath: 'bun.lock',
          lockFileSha256: sha256HexSync('outside\n'),
          platform: process.platform,
          sourceDirectory: dependencies,
          sourceRepositoryDirectory: sourceRepository,
          targetRelativePath: 'node_modules',
          taskId: 'tsk_0123456789abcdef',
        },
        repositoryRoot: targetRepository,
      }),
    ).rejects.toThrow('lock escapes its repository');
  });

  it('hashes dependency projections independently of filesystem creation order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            content: fc.string({maxLength: 64}),
            name: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/u),
          }),
          {maxLength: 8, minLength: 1, selector: entry => entry.name},
        ),
        async entries => {
          const root = await temporaryRoot(roots);
          const repositories = [join(root, 'forward'), join(root, 'reverse')];
          for (const [index, repository] of repositories.entries()) {
            const dependencies = join(repository, 'node_modules');
            await mkdir(dependencies, {recursive: true});
            const ordered = index === 0 ? entries : [...entries].reverse();
            for (const entry of ordered) await writeFile(join(dependencies, entry.name), entry.content);
          }
          await expect(
            Promise.all(
              repositories.map(repository =>
                matchedEvaluationDependencyProjectionFixtureHashV1(join(repository, 'node_modules'), repository),
              ),
            ),
          ).resolves.toEqual([expect.any(String), expect.any(String)]);
          expect(
            await matchedEvaluationDependencyProjectionFixtureHashV1(
              join(repositories[0], 'node_modules'),
              repositories[0],
            ),
          ).toBe(
            await matchedEvaluationDependencyProjectionFixtureHashV1(
              join(repositories[1], 'node_modules'),
              repositories[1],
            ),
          );
        },
      ),
      {numRuns: 10},
    );
  });

  it('parses a pinned files-only adapter configuration and rejects treatment context in that arm', () => {
    const config = adapterConfig();

    expect(parseMatchedEvaluationCodexAdapterConfigV1(config)).toEqual(config);
    const legacyConfig = {...config} as Record<string, unknown>;
    delete legacyConfig.approvedCommands;
    expect(parseMatchedEvaluationCodexAdapterConfigV1(legacyConfig)).toMatchObject({approvedCommands: []});
    expect(() =>
      parseMatchedEvaluationCodexAdapterConfigV1({
        ...config,
        contextHomes: [
          {
            expectedContext: {
              graphContentHash: '8'.repeat(64),
              graphSnapshotHash: '9'.repeat(64),
              linkReceiptsHash: null,
              memoryAccess: 'disabled',
              taskContextHash: null,
            },
            homeDirectory: '/tmp/prepared-threadnote-home',
            homeFixtureHash: 'b'.repeat(64),
            identity: {account: 'local', user: 'evaluation-user'},
            project: 'threadnote',
            taskId: 'tsk_0123456789abcdef',
          },
        ],
      }),
    ).toThrow('only Threadnote arms may configure prepared context homes');
  });

  it('accepts only bounded task-scoped approved command tokens', () => {
    const command = {
      taskId: 'tsk_0123456789abcdef',
      tokens: [
        'PYTHONPATH=src',
        'pytest',
        '-q',
        'tests/test_markers.py',
        '-k',
        'test_marker_str_roundtrip_preserves_nested_group_precedence',
      ],
    };
    expect(parseMatchedEvaluationCodexAdapterConfigV1({...adapterConfig(), approvedCommands: [command]})).toMatchObject(
      {
        approvedCommands: [command],
      },
    );
    for (const tokens of [
      ['HOME=/tmp', 'pytest', '-q', 'tests/test_markers.py'],
      ['PYTHONPATH=src', '/tmp/pytest', '-q', 'tests/test_markers.py'],
      ['PYTHONPATH=src', 'pytest', '-q', '../outside/test_markers.py'],
      ['PYTHONPATH=src', 'pytest', '-q', 'tests/test_markers.py;pwd'],
    ]) {
      expect(() =>
        parseMatchedEvaluationCodexAdapterConfigV1({
          ...adapterConfig(),
          approvedCommands: [{taskId: command.taskId, tokens}],
        }),
      ).toThrow('approved command');
    }
  });

  it('parses task-scoped dependency projection identities and rejects repository escapes', () => {
    const projection = {
      architecture: 'arm64',
      fixtureHash: '7'.repeat(64),
      lockFileRelativePath: 'bun.lock',
      lockFileSha256: '8'.repeat(64),
      platform: 'darwin',
      sourceDirectory: '/tmp/source/node_modules',
      sourceRepositoryDirectory: '/tmp/source',
      targetRelativePath: 'node_modules',
      taskId: 'tsk_0123456789abcdef',
    };
    expect(
      parseMatchedEvaluationCodexAdapterConfigV1({...adapterConfig(), dependencyProjections: [projection]}),
    ).toMatchObject({dependencyProjections: [projection]});
    expect(() =>
      parseMatchedEvaluationCodexAdapterConfigV1({
        ...adapterConfig(),
        dependencyProjections: [{...projection, sourceDirectory: '/tmp/outside'}],
      }),
    ).toThrow('source directory must be inside');
  });

  it('keeps the study hash out of immutable prepared-home configuration', () => {
    const expectedContext = {
      graphContentHash: '8'.repeat(64),
      graphSnapshotHash: '9'.repeat(64),
      linkReceiptsHash: 'a'.repeat(64),
      memoryAccess: 'linked' as const,
      taskContextHash: 'b'.repeat(64),
    };
    const config = {
      ...adapterConfig(),
      arm: 'threadnote-compact' as const,
      contextHomes: [
        {
          expectedContext,
          homeDirectory: '/tmp/prepared-threadnote-home',
          homeFixtureHash: 'c'.repeat(64),
          identity: {account: 'local', user: 'evaluation-user'},
          project: 'threadnote',
          taskId: 'tsk_0123456789abcdef',
        },
      ],
    };

    expect(parseMatchedEvaluationCodexAdapterConfigV1(config)).toEqual(config);
    expect(() =>
      parseMatchedEvaluationCodexAdapterConfigV1({
        ...config,
        contextHomes: [
          {
            ...config.contextHomes[0],
            expectedContext: {...expectedContext, studyHash: 'd'.repeat(64)},
          },
        ],
      }),
    ).toThrow('unsupported or missing fields');
  });

  it('accepts lossy one-server MCP inventory while rejecting rerouted or expanded metadata', () => {
    const inventory = (server: Record<string, unknown>) => ({data: [server], nextCursor: null});
    const base = {name: 'matched_evaluation_context', resourceTemplates: [], resources: []};

    for (const server of [{...base}, {...base, tools: {}}]) {
      expect(() => assertMatchedEvaluationMcpInventoryV1(inventory(server), base.name)).not.toThrow();
    }
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {context_brief: {name: 'context_brief'}}}),
        base.name,
        'source',
      ),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {recall_context: {name: 'recall_context'}}}),
        base.name,
        'graph-only',
      ),
    ).toThrow('unexpected context tool');
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {recall_context: {name: 'recall_context'}}}),
        base.name,
        'compact',
        'preloaded',
        null,
      ),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {recall_context: {name: 'recall_context'}}}),
        base.name,
        'compact',
        'preloaded',
        'find callers from normalizeNode to renderSuggestion',
      ),
    ).toThrow('unexpected context tool');
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {inspect_code_graph: {name: 'inspect_code_graph'}}}),
        base.name,
        'compact',
        'preloaded',
        'find callers from normalizeNode to renderSuggestion',
      ),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, tools: {context_brief: {name: 'recall_context'}}}),
        base.name,
      ),
    ).toThrow('rerouted tool name');
    expect(() =>
      assertMatchedEvaluationMcpInventoryV1(
        inventory({...base, resources: [{uri: 'threadnote://unexpected'}]}),
        base.name,
      ),
    ).toThrow('unexpected resources');
  });

  it('forces every admitted shell executable through pre-execution review', () => {
    const rules = renderMatchedEvaluationCommandReviewRulesV1();
    const lines = rules.trim().split('\n');

    expect(lines).toHaveLength(18);
    expect(new Set(lines).size).toBe(lines.length);
    for (const executable of [
      '/bin/zsh',
      'awk',
      'cat',
      'file',
      'find',
      'git',
      'grep',
      'head',
      'ls',
      'nl',
      'od',
      'pwd',
      'rg',
      'sed',
      'stat',
      'tail',
      'wc',
      'xargs',
    ]) {
      expect(lines).toContain(`prefix_rule(pattern=[${JSON.stringify(executable)}], decision="prompt")`);
    }
    expect(rules).not.toContain('decision="allow"');
  });

  it('uses the last cumulative provider report and rejects inconsistent accounting', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 1_000_000}),
        (inputTokens, outputTokens, cachedSeed, reasoningSeed) => {
          const cachedInputTokens = Math.min(inputTokens, cachedSeed);
          const reasoningOutputTokens = Math.min(outputTokens, reasoningSeed);
          const expected = {
            cachedInputTokens,
            inputTokens,
            outputTokens,
            reasoningOutputTokens,
            totalTokens: inputTokens + outputTokens,
          };
          expect(
            extractMatchedEvaluationProviderUsageV1([
              usageEvent({
                cachedInputTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 0,
              }),
              usageEvent(expected),
            ]),
          ).toEqual(expected);
        },
      ),
      {numRuns: 50},
    );

    expect(() =>
      extractMatchedEvaluationProviderUsageV1([
        usageEvent({cachedInputTokens: 1, inputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 6}),
      ]),
    ).toThrow('provider token components are inconsistent');
  });

  it('retains the latest available provider usage and partial events for infrastructure failures', () => {
    const events = [
      usageEvent({
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 110,
      }),
      {method: 'item/started', params: {item: {id: 'grep', type: 'commandExecution'}}},
    ];
    expect(
      createMatchedEvaluationAppServerFailureEvidenceV1({
        cause: new Error('completed action was outside the reviewed policy'),
        events,
        stderr: 'bounded stderr',
      }),
    ).toEqual({
      events,
      failureMessage: 'completed action was outside the reviewed policy',
      stderr: 'bounded stderr',
      usage: {
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 110,
      },
      usageUnavailableReason: null,
      version: 1,
    });
    expect(
      createMatchedEvaluationAppServerFailureEvidenceV1({cause: 'early failure', events: [], stderr: ''}),
    ).toMatchObject({usage: null, usageUnavailableReason: 'Completed Codex turn did not report provider usage.'});
  });

  it('persists failure transcripts independently without replacing existing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-failure-transcript-'));
    roots.push(root);
    const transcriptPath = join(root, 'run.jsonl');
    const agentTranscriptPath = `${transcriptPath}.agent.jsonl`;
    await writeFile(agentTranscriptPath, 'preserved evidence\n');

    await expect(
      persistMatchedEvaluationFailureTranscriptsV1({transcript: 'new failure evidence\n', transcriptPath}),
    ).resolves.toEqual({failedWrites: 1, successfulWrites: 1, version: 1});
    await expect(readFile(agentTranscriptPath, 'utf8')).resolves.toBe('preserved evidence\n');
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe('new failure evidence\n');
  });

  it('attributes cumulative usage and safe completed-item metadata without retaining item bodies', () => {
    const events = [
      usageEvent({
        cacheWriteTokens: 0,
        cachedInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      }),
      completedEvent('brief', 'mcpToolCall', {tool: 'context_brief'}),
      usageEvent({
        cacheWriteTokens: 4,
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 110,
      }),
      usageEvent({
        cacheWriteTokens: 4,
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 110,
      }),
      completedEvent('graph', 'mcpToolCall', {
        arguments: {
          budgetTokens: 800,
          edgeLimit: 12,
          nodeId: 'sensitive-node-id',
          nodeLimit: 8,
          operation: 'node',
          query: 'prompt or source body',
        },
        elapsedMilliseconds: 12,
        evidenceState: 'sufficient',
        status: 'completed',
        tool: 'inspect_code_graph',
      }),
      completedEvent('failed-recall', 'mcpToolCall', {
        result: {content: 'prompt or source body'},
        status: 'failed',
        tool: 'recall_context',
      }),
      completedEvent('read', 'commandExecution'),
      completedEvent('edit', 'fileChange'),
      completedEvent('second-read', 'commandExecution'),
      usageEvent({
        cacheWriteTokens: 6,
        cachedInputTokens: 100,
        inputTokens: 140,
        outputTokens: 20,
        reasoningOutputTokens: 6,
        totalTokens: 160,
      }),
    ];
    const attribution = analyzeMatchedEvaluationAttributionV1(events, 17);
    expect(attribution).toMatchObject({
      firstSufficientEvidenceMilliseconds: 12,
      graphRequests: [{budgetTokens: 800, edgeLimit: 12, nodeLimit: 8, operation: 'node'}],
      lastTwoModelCallTokens: {cacheWriteTokens: 6, rawInputTokens: 140, totalTokens: 160},
      modelCallCount: 2,
      modelCalls: [
        {cacheWriteTokens: 4, rawInputTokens: 100, reasoningOutputTokens: 3, totalTokens: 110},
        {cacheWriteTokens: 2, rawInputTokens: 40, reasoningOutputTokens: 3, totalTokens: 50},
      ],
      modelVisibleBytes: {promptBytes: 17},
      repeatedToolCalls: {commandExecution: 1, contextBrief: 0, fileChange: 0, inspectCodeGraph: 0},
      tokens: {
        cacheWriteTokens: 6,
        cachedInputTokens: 100,
        newTokens: 66,
        outputTokens: 20,
        processedTokens: 166,
        rawInputTokens: 140,
        uncachedInputTokens: 40,
      },
    });
    expect(attribution.completedItemBytes.commandExecution).toBeGreaterThan(0);
    expect(attribution.modelVisibleBytes.totalBytes).toBe(
      attribution.modelVisibleBytes.promptBytes + attribution.modelVisibleBytes.completedItemBytes,
    );
    expect(JSON.stringify(attribution)).not.toContain('prompt or source body');
    expect(JSON.stringify(attribution)).not.toContain('sensitive-node-id');
  });

  it('keeps cache writes unknown and derives the same attribution across unrelated completed-item orderings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('commandExecution', 'fileChange', 'mcpToolCall'), {maxLength: 12}),
        types => {
          const usage = usageEvent({
            cachedInputTokens: 20,
            inputTokens: 30,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 40,
          });
          const completed = types.map((type, index) =>
            completedEvent(`item-${index}`, type, type === 'mcpToolCall' ? {tool: 'read_context'} : {}),
          );
          const first = analyzeMatchedEvaluationAttributionV1([usage, ...completed]);
          const second = analyzeMatchedEvaluationAttributionV1([usage, ...[...completed].reverse()]);
          expect(first).toEqual(second);
          expect(first.tokens).toMatchObject({cacheWriteTokens: null, newTokens: null, processedTokens: null});
        },
      ),
      {numRuns: 50},
    );
  });

  it('derives sufficient-evidence time from real app-server context completion metadata without retaining response text', () => {
    const usage = usageEvent({
      cachedInputTokens: 2,
      inputTokens: 4,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 5,
    });
    const context = {
      method: 'item/completed',
      params: {
        completedAtMs: 150,
        item: {
          id: 'context-brief',
          result: {
            content: [
              {
                text: JSON.stringify({evidenceState: 'sufficient', source: 'private source and task text'}),
                type: 'text',
              },
            ],
          },
          status: 'completed',
          tool: 'context_brief',
          type: 'mcpToolCall',
        },
      },
    };
    const attribution = analyzeMatchedEvaluationAttributionV1([
      usage,
      {method: 'item/started', params: {startedAtMs: 100}},
      context,
      context,
    ]);
    expect(attribution.firstSufficientEvidenceMilliseconds).toBe(50);
    expect(attribution.repeatedToolCalls.contextBrief).toBe(0);
    expect(attribution.completedItemBytes.mcpToolCall).toBeGreaterThan(0);
    expect(JSON.stringify(attribution)).not.toContain('private source and task text');

    const malformed = analyzeMatchedEvaluationAttributionV1([
      usage,
      {method: 'item/started', params: {startedAtMs: 100}},
      {
        method: 'item/completed',
        params: {
          completedAtMs: 150,
          item: {
            id: 'malformed-context-brief',
            result: {content: [{text: '{not-json', type: 'text'}]},
            status: 'completed',
            tool: 'context_brief',
            type: 'mcpToolCall',
          },
        },
      },
    ]);
    expect(malformed.firstSufficientEvidenceMilliseconds).toBeNull();
  });

  it('counts only privacy-safe completed work after timestamped sufficient evidence', () => {
    const usage = usageEvent({
      cachedInputTokens: 2,
      inputTokens: 4,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 5,
    });
    const events = [
      usage,
      {method: 'item/started', params: {startedAtMs: 100}},
      {
        method: 'item/completed',
        params: {
          completedAtMs: 120,
          item: {
            id: 'context-brief',
            result: {content: [{text: JSON.stringify({evidenceState: 'sufficient'}), type: 'text'}]},
            status: 'completed',
            tool: 'context_brief',
            type: 'mcpToolCall',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          completedAtMs: 130,
          item: {
            command: 'private source-bearing command',
            id: 'declined-command',
            status: 'declined',
            type: 'commandExecution',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          completedAtMs: 140,
          item: {changes: ['private patch'], id: 'edit', status: 'completed', type: 'fileChange'},
        },
      },
    ];
    const attribution = analyzeMatchedEvaluationAttributionV1(events);
    expect(attribution.postSufficientEvidence).toMatchObject({
      commandExecutions: 1,
      completedItems: 2,
      declinedCommandExecutions: 1,
      fileChanges: 1,
      mcpToolCalls: 0,
    });
    expect(attribution.postSufficientEvidence?.completedItemBytes).toBeGreaterThan(0);
    expect(JSON.stringify(attribution.postSufficientEvidence)).not.toContain('private');
  });

  it('records an evidence-bearing preload at agent start without upgrading its sufficiency', () => {
    const usage = usageEvent({
      cachedInputTokens: 2,
      inputTokens: 4,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 5,
    });
    const events = [
      usage,
      {method: 'item/started', params: {startedAtMs: 100}},
      {
        method: 'item/completed',
        params: {
          completedAtMs: 120,
          item: {id: 'read', status: 'completed', type: 'commandExecution'},
        },
      },
    ];

    const evidenceBearing = analyzeMatchedEvaluationAttributionV1(events, 0, {
      initialContinuationEvidenceState: 'evidence-bearing',
    });
    const background = analyzeMatchedEvaluationAttributionV1(events, 0, {
      initialContinuationEvidenceState: 'background',
    });

    expect(evidenceBearing.initialContinuationEvidenceState).toBe('evidence-bearing');
    expect(evidenceBearing.firstSufficientEvidenceMilliseconds).toBeNull();
    expect(evidenceBearing.postSufficientEvidence).toBeNull();
    expect(background.initialContinuationEvidenceState).toBe('background');
    expect(background.firstSufficientEvidenceMilliseconds).toBeNull();
    expect(background.postSufficientEvidence).toBeNull();
  });

  it('partitions arbitrary command outcomes at the sufficient-evidence boundary', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            after: fc.boolean(),
            status: fc.constantFrom('completed', 'declined', 'failed'),
          }),
          {maxLength: 20},
        ),
        commands => {
          const usage = usageEvent({
            cachedInputTokens: 2,
            inputTokens: 4,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 5,
          });
          const context = {
            method: 'item/completed',
            params: {
              completedAtMs: 120,
              item: {
                evidenceState: 'sufficient',
                id: 'sufficient',
                status: 'completed',
                type: 'mcpToolCall',
              },
            },
          };
          const commandEvents = commands.map((command, index) => ({
            method: 'item/completed',
            params: {
              completedAtMs: command.after ? 130 + index : 110,
              item: {id: `command-${index}`, status: command.status, type: 'commandExecution'},
            },
          }));
          const observation = analyzeMatchedEvaluationAttributionV1([
            usage,
            context,
            ...commandEvents,
          ]).postSufficientEvidence;
          expect(observation?.commandExecutions).toBe(commands.filter(command => command.after).length);
          expect(observation?.declinedCommandExecutions).toBe(
            commands.filter(command => command.after && command.status === 'declined').length,
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('partitions one to many cumulative usage updates into exact model-call deltas', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({min: 0, max: 1_000}),
            fc.integer({min: 0, max: 1_000}),
            fc.integer({min: 0, max: 1_000}),
          ),
          {maxLength: 8, minLength: 1},
        ),
        increments => {
          let cachedInputTokens = 0;
          let inputTokens = 0;
          let outputTokens = 0;
          let cacheWriteTokens = 0;
          const events = increments.map(([input, output, cacheWrite]) => {
            inputTokens += input;
            cachedInputTokens += Math.floor(input / 2);
            outputTokens += output;
            cacheWriteTokens += cacheWrite;
            return usageEvent({
              cacheWriteTokens,
              cachedInputTokens,
              inputTokens,
              outputTokens,
              reasoningOutputTokens: Math.floor(outputTokens / 2),
              totalTokens: inputTokens + outputTokens,
            });
          });
          const attribution = analyzeMatchedEvaluationAttributionV1(events);
          expect(attribution.tokens).toMatchObject({
            cacheWriteTokens,
            cachedInputTokens,
            outputTokens,
            rawInputTokens: inputTokens,
            totalTokens: inputTokens + outputTokens,
          });
          expect(attribution.lastTwoModelCallTokens.totalTokens).toBe(
            attribution.modelCalls.slice(-2).reduce((total, call) => total + call.totalTokens, 0),
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('fails closed when a cumulative provider update is incomplete', () => {
    expect(() =>
      analyzeMatchedEvaluationAttributionV1([
        {method: 'thread/tokenUsage/updated', params: {tokenUsage: {total: {inputTokens: 10}}}},
      ]),
    ).toThrow('cached input tokens');
  });

  it('hashes prepared homes deterministically and binds file bytes and modes', async () => {
    const root = await temporaryRoot(roots);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await Promise.all([
      mkdir(join(first, 'nested'), {recursive: true}),
      mkdir(join(second, 'nested'), {recursive: true}),
    ]);
    await writeFile(join(first, 'a.json'), '{}\n', {mode: 0o600});
    await writeFile(join(first, 'nested', 'b.txt'), 'context\n', {mode: 0o640});
    await writeFile(join(second, 'nested', 'b.txt'), 'context\n', {mode: 0o640});
    await writeFile(join(second, 'a.json'), '{}\n', {mode: 0o600});

    const baseline = await matchedEvaluationPreparedHomeFixtureHashV1(first);
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(first)).toBe(baseline);
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).toBe(baseline);

    await writeFile(join(second, 'nested', 'b.txt'), 'changed\n', {mode: 0o640});
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).not.toBe(baseline);
    await writeFile(join(second, 'nested', 'b.txt'), 'context\n', {mode: 0o640});
    await chmod(join(second, 'nested', 'b.txt'), 0o600);
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).not.toBe(baseline);
    await chmod(join(second, 'nested', 'b.txt'), 0o640);
    await mkdir(join(second, 'empty'), {mode: 0o700});
    expect(await matchedEvaluationPreparedHomeFixtureHashV1(second)).not.toBe(baseline);
  });

  it('binds verifier-environment symlinks to their resolved file contents', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const environment = join(root, 'environment');
    const target = join(root, 'interpreter');
    await mkdir(join(environment, 'bin'), {recursive: true});
    await writeFile(target, '#!/bin/sh\nexit 0\n');
    await chmod(target, 0o700);
    await symlink(target, join(environment, 'bin', 'python'));

    const baseline = await matchedEvaluationVerifierEnvironmentHashV1(environment);
    await writeFile(target, '#!/bin/sh\nexit 1\n');
    expect(await matchedEvaluationVerifierEnvironmentHashV1(environment)).not.toBe(baseline);
  });

  it('admits exact verifier directory roots as well as their descendants', () => {
    const profile = renderVerifierSeatbeltProfile({
      environmentDirectory: '/fixture/environment',
      repositoryRoot: '/fixture/repository',
      root: '/fixture/runtime',
      runner: '/fixture/verify.py',
      temporaryDirectory: '/fixture/repository/.threadnote-verifier-tmp-fixture',
    });

    for (const directory of ['/fixture/environment', '/fixture/repository', '/fixture/runtime']) {
      expect(profile).toContain(`(literal "${directory}") (subpath "${directory}")`);
    }
    expect(profile).toContain(
      '(literal "/fixture/repository/.threadnote-verifier-tmp-fixture") (subpath "/fixture/repository/.threadnote-verifier-tmp-fixture")',
    );
  });

  it('separates verifier task failures from invalid sandbox diagnostics', async () => {
    const root = await temporaryRoot(roots);
    const environmentDirectory = join(root, 'verifier-environment');
    const interpreter = join(environmentDirectory, 'bin', 'python');
    const runner = join(root, 'verify');
    const sandbox = join(root, 'sandbox');
    await mkdir(dirname(interpreter), {recursive: true});
    await writeFile(interpreter, '#!/bin/sh\nexec "$@"\n');
    await writeFile(
      runner,
      '#!/bin/sh\ncase "$TMPDIR" in "$2"/.threadnote-verifier-tmp-*) : ;; *) printf "%s verifier failed: {\\"completed\\":false,\\"infrastructureError\\":\\"invalid scratch\\"}\\n" "$1" >&2; exit 1 ;; esac\n: > "$TMPDIR/probe"\ncase "$2" in *pass*) printf "%s verifier passed\\n" "$1"; exit 0 ;; *fail*) printf "%s verifier failed: fixture\\n" "$1" >&2; exit 1 ;; *) printf "sandbox-exec: denied\\n" >&2; exit 1 ;; esac\n',
    );
    await writeFile(sandbox, '#!/bin/sh\nshift 2\nexec "$@"\n');
    await Promise.all([chmod(interpreter, 0o700), chmod(runner, 0o700), chmod(sandbox, 0o700)]);
    const taskId = 'tsk_0123456789abcdef';
    const selector = 'fixture';
    const plan = createMatchedEvaluationVerificationPlanV1({
      environmentDirectory,
      environmentHash: await matchedEvaluationVerifierEnvironmentHashV1(environmentDirectory),
      interpreter,
      interpreterHash: sha256HexSync(await readFile(interpreter)),
      runner,
      runnerHash: sha256HexSync(await readFile(runner)),
      sandbox: {
        executable: sandbox,
        executableHash: sha256HexSync(await readFile(sandbox)),
        policy: 'darwin-seatbelt-v1',
      },
      tasks: [
        {
          calibration: createMatchedEvaluationVerificationCalibrationV1({
            baseDiagnosticHash: '1'.repeat(64),
            baseExitCode: 1,
            baseRepositoryFixtureHash: '2'.repeat(64),
            baseRevision: '3'.repeat(40),
            fixDiagnosticHash: '4'.repeat(64),
            fixExitCode: 0,
            fixRepositoryFixtureHash: '5'.repeat(64),
            fixRevision: '6'.repeat(40),
          }),
          selector,
          taskId,
          verificationId: matchedEvaluationVerificationIdV1(taskId, selector),
        },
      ],
      timeoutMilliseconds: 10_000,
    });
    const passRepository = join(root, 'pass-repository');
    const failRepository = join(root, 'fail-repository');
    const deniedRepository = join(root, 'denied-repository');
    const setupRepository = join(root, 'setup-repository');
    const setupRoot = join(root, 'setup-runtime');
    await Promise.all([
      mkdir(passRepository),
      mkdir(failRepository),
      mkdir(deniedRepository),
      mkdir(setupRepository),
      mkdir(join(setupRoot, 'home'), {recursive: true}),
    ]);

    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: '7'.repeat(64),
        plan,
        repositoryRoot: passRepository,
        root: join(root, 'pass-runtime'),
        taskId,
      }),
    ).resolves.toMatchObject({exitCode: 0, status: 'passed'});
    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: '8'.repeat(64),
        plan,
        repositoryRoot: failRepository,
        root: join(root, 'fail-runtime'),
        taskId,
      }),
    ).resolves.toMatchObject({exitCode: 1, status: 'task-failed'});
    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: '9'.repeat(64),
        plan,
        repositoryRoot: deniedRepository,
        root: join(root, 'denied-runtime'),
        taskId,
      }),
    ).rejects.toThrow('invalid diagnostic protocol');
    await expect(
      runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: 'a'.repeat(64),
        plan,
        repositoryRoot: setupRepository,
        root: setupRoot,
        taskId,
      }),
    ).rejects.toMatchObject({code: 'EEXIST'});
    for (const repository of [passRepository, failRepository, deniedRepository, setupRepository]) {
      expect((await readdir(repository)).filter(entry => entry.startsWith('.threadnote-verifier-tmp-'))).toEqual([]);
    }
  });

  it('rejects structured verifier failures that attest incomplete execution', () => {
    const common = {
      exitCode: 1 as const,
      selector: 'fixture',
      stdout: '',
      verificationId: 'verification-fixture',
    };
    expect(
      matchedEvaluationVerifierStatusFromDiagnosticV1({
        ...common,
        stderr: 'fixture verifier failed: {"completed":true,"failures":[{"case":"semantic"}]}\n',
      }),
    ).toBe('task-failed');
    expect(() =>
      matchedEvaluationVerifierStatusFromDiagnosticV1({
        ...common,
        stderr: 'fixture verifier failed: {"completed":false,"infrastructureError":"CollectionError"}\n',
      }),
    ).toThrow('reported incomplete execution');
    expect(() =>
      matchedEvaluationVerifierStatusFromDiagnosticV1({
        ...common,
        stderr: 'fixture verifier failed: {"completed":false,"failures":[{"case":"no collectors"}]}\n',
      }),
    ).toThrow('reported incomplete execution');
    expect(() =>
      matchedEvaluationVerifierStatusFromDiagnosticV1({
        ...common,
        stderr: 'fixture verifier failed: {"completed":true,\n',
      }),
    ).toThrow('invalid diagnostic protocol');
  });

  it('runs files-only and budget outcomes but retains failed-delivery evidence without an observation', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    await mkdir(repository);
    await git(repository, ['init', '-q']);
    await git(repository, ['config', 'user.email', 'evaluation@example.invalid']);
    await git(repository, ['config', 'user.name', 'Evaluation Fixture']);
    await git(repository, ['remote', 'add', 'origin', 'https://github.com/example/adapter-fixture.git']);
    await writeFile(join(repository, 'service.ts'), 'export const value = 1;\n');
    await git(repository, ['add', 'service.ts']);
    await git(repository, ['commit', '-qm', 'fixture']);
    const observed = await observeMatchedEvaluationRepositoryV1(repository);
    const bunExecutable = await realpath(process.execPath);
    const gitExecutable = await realpath('/usr/bin/git');
    const selfExecutable = await realpath('/usr/bin/true');
    const fakeAppServer = join(process.cwd(), 'packages/testing/src/fake-matched-evaluation-app-server.ts');
    const authSourcePath = join(root, 'auth.json');
    await writeFile(authSourcePath, '{}\n', {mode: 0o600});
    await chmod(authSourcePath, 0o600);
    const config = {
      ...adapterConfig(),
      approvedCommands: [{taskId: 'tsk_0123456789abcdef', tokens: ['PYTHONPATH=src', 'true', '--version']}],
      appServer: {
        argumentsAfterSubcommand: ['--exercise-approvals', '--exercise-auto-approval', '--exercise-task-command'],
        argumentsBeforeSubcommand: [fakeAppServer],
        executable: bunExecutable,
        executableSha256: sha256HexSync(await readFile(bunExecutable)),
        version: 'codex-cli matched-evaluation-test-v1',
      },
      authSourcePath,
      git: {executable: gitExecutable, executableSha256: sha256HexSync(await readFile(gitExecutable))},
      judgeModel: {...adapterConfig().judgeModel, reasoningEffort: 'medium'},
      safeBinaries: [{path: selfExecutable, sha256: sha256HexSync(await readFile(selfExecutable))}],
      safeExecutablePath: [dirname(bunExecutable), dirname(gitExecutable)].join(delimiter),
      temporaryRoot: root,
    };
    const configPath = join(root, 'adapter-config.json');
    const configBytes = Buffer.from(`${JSON.stringify(config)}\n`);
    await writeFile(configPath, configBytes);
    const requestPath = join(root, 'request.json');
    const responsePath = join(root, 'response.json');
    const artifactPath = join(root, 'artifact.json');
    const transcriptPath = join(root, 'transcript.jsonl');
    const request = {
      adapterArtifactHash: sha256HexSync(await readFile(selfExecutable)),
      adapterConfigurationHash: sha256HexSync(configBytes),
      adapterProtocol: 'matched-evaluation-adapter-v5',
      agentTask: {
        category: 'architecture-discovery',
        memoryFixtures: [],
        prompt: 'Inspect the service and report completion.',
        repositoryFixtureHash: observed.fixtureHash,
        taskId: 'tsk_0123456789abcdef',
        variant: 'implementation',
      },
      arm: 'files',
      artifactPath,
      blindLabel: 'A',
      continuationTreatment: null,
      environmentPolicyHash: config.environmentPolicyHash,
      judgeTask: {
        negativeControls: [],
        rubric: {completion: 'The task is complete.', criteria: ['The answer is correct.'], requiredEvidenceIds: []},
        sourceGold: [],
      },
      manifestHash: '6'.repeat(64),
      model: {model: config.model.id, parametersHash: config.model.parametersHash, provider: config.model.provider},
      preparedContext: null,
      repository: observed,
      runNonce: 'run_0123456789abcdef0123456789abcdef',
      runOrder: 0,
      tool: {
        artifactHash: null,
        detail: null,
        executable: null,
        lockIdentityHash: null,
        name: 'files-only',
        version: '1',
      },
      transcriptPath,
      verificationPlanHash: null,
      version: 4,
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);
    const originalCwd = process.cwd();
    try {
      process.chdir(repository);
      await runMatchedEvaluationCodexAdapter({configPath, requestPath, responsePath, selfExecutable});
    } finally {
      process.chdir(originalCwd);
    }

    const response = JSON.parse(await readFile(responsePath, 'utf8')) as {
      readonly artifactHash: string;
      readonly transcriptHash: string;
    };
    expect(response).toMatchObject({
      metrics: {
        completion: {completed: true},
        context: null,
        correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
        usage: {providerTokens: {inputTokens: 100, outputTokens: 50, totalTokens: 150}},
        validity: {failureCount: 0, valid: true},
      },
      version: 5,
    });
    expect(sha256HexSync(await readFile(artifactPath))).toBe(response.artifactHash);
    expect(sha256HexSync(await readFile(transcriptPath))).toBe(response.transcriptHash);

    const unpinnedConfig = {...config, safeBinaries: []};
    const unpinnedConfigPath = join(root, 'unpinned-adapter-config.json');
    const unpinnedConfigBytes = Buffer.from(`${JSON.stringify(unpinnedConfig)}\n`);
    const unpinnedRequestPath = join(root, 'unpinned-request.json');
    await writeFile(unpinnedConfigPath, unpinnedConfigBytes);
    await writeFile(
      unpinnedRequestPath,
      `${JSON.stringify({
        ...request,
        adapterConfigurationHash: sha256HexSync(unpinnedConfigBytes),
        runNonce: 'run_11111111111111111111111111111111',
      })}\n`,
    );
    try {
      process.chdir(repository);
      await expect(
        runMatchedEvaluationCodexAdapter({
          configPath: unpinnedConfigPath,
          requestPath: unpinnedRequestPath,
          responsePath: join(root, 'unpinned-response.json'),
          selfExecutable,
        }),
      ).rejects.toThrow('not the first matching hash-pinned safe binary');
    } finally {
      process.chdir(originalCwd);
    }

    const budgetConfig = {...config, taskBudget: {steps: 100, tokens: 100}};
    const budgetConfigPath = join(root, 'budget-adapter-config.json');
    const budgetConfigBytes = Buffer.from(`${JSON.stringify(budgetConfig)}\n`);
    const budgetRequestPath = join(root, 'budget-request.json');
    const budgetResponsePath = join(root, 'budget-response.json');
    const budgetArtifactPath = join(root, 'budget-artifact.json');
    const budgetTranscriptPath = join(root, 'budget-transcript.jsonl');
    await writeFile(budgetConfigPath, budgetConfigBytes);
    await writeFile(
      budgetRequestPath,
      `${JSON.stringify({
        ...request,
        adapterConfigurationHash: sha256HexSync(budgetConfigBytes),
        artifactPath: budgetArtifactPath,
        runNonce: 'run_fedcba9876543210fedcba9876543210',
        transcriptPath: budgetTranscriptPath,
      })}\n`,
    );
    try {
      process.chdir(repository);
      await runMatchedEvaluationCodexAdapter({
        configPath: budgetConfigPath,
        requestPath: budgetRequestPath,
        responsePath: budgetResponsePath,
        selfExecutable,
      });
    } finally {
      process.chdir(originalCwd);
    }
    const budgetResponse = JSON.parse(await readFile(budgetResponsePath, 'utf8')) as {
      readonly metrics: {readonly completion: {readonly completed: boolean}};
    };
    expect(budgetResponse).toMatchObject({
      metrics: {
        completion: {completed: false},
        correctness: {judgeCompleted: true, scoreMilli: 1_000},
        drift: {falseCurrentOutcomes: 0},
        usage: {providerTokens: {inputTokens: 100, outputTokens: 50, totalTokens: 150}},
        validity: {failureCount: 0, valid: true},
      },
      version: 5,
    });
    const [budgetAgentTranscript] = (await readFile(budgetTranscriptPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(budgetAgentTranscript ?? 'null') as unknown).toMatchObject({
      kind: 'agent',
      terminal: 'provider-token-budget',
      version: 2,
    });

    const contextHome = join(root, 'prepared-home');
    await mkdir(contextHome);
    const expectedContext = {
      graphContentHash: '8'.repeat(64),
      graphSnapshotHash: '9'.repeat(64),
      linkReceiptsHash: null,
      memoryAccess: 'disabled' as const,
      taskContextHash: null,
    };
    const failedConfig = {
      ...config,
      arm: 'threadnote-graph',
      appServer: {...config.appServer, argumentsAfterSubcommand: ['--failed-context']},
      contextHomes: [
        {
          expectedContext,
          homeDirectory: contextHome,
          homeFixtureHash: await matchedEvaluationPreparedHomeFixtureHashV1(contextHome),
          identity: {account: 'local', user: 'evaluation-user'},
          project: 'threadnote',
          taskId: request.agentTask.taskId,
        },
      ],
    };
    const failedConfigPath = join(root, 'failed-config.json');
    const failedConfigBytes = Buffer.from(`${JSON.stringify(failedConfig)}\n`);
    const failedRequestPath = join(root, 'failed-request.json');
    const failedResponsePath = join(root, 'failed-response.json');
    const failedArtifactPath = join(root, 'failed-artifact.json');
    const failedTranscriptPath = join(root, 'failed-transcript.jsonl');
    await writeFile(failedConfigPath, failedConfigBytes);
    await writeFile(
      failedRequestPath,
      `${JSON.stringify({
        ...request,
        arm: failedConfig.arm,
        adapterConfigurationHash: sha256HexSync(failedConfigBytes),
        artifactPath: failedArtifactPath,
        transcriptPath: failedTranscriptPath,
        runNonce: 'run_123456789abcdef0123456789abcdef0',
        preparedContext: {memoryAccess: 'disabled', graphContext: expectedContext, studyHash: '7'.repeat(64)},
        tool: {
          ...request.tool,
          artifactHash: request.adapterArtifactHash,
          executable: selfExecutable,
          detail: 'graph-only',
          name: 'threadnote',
          version: '5.0.6',
          lockIdentityHash: 'a'.repeat(64),
        },
      })}\n`,
    );
    try {
      process.chdir(repository);
      await expect(
        runMatchedEvaluationCodexAdapter({
          configPath: failedConfigPath,
          requestPath: failedRequestPath,
          responsePath: failedResponsePath,
          selfExecutable,
        }),
      ).rejects.toThrow('context_brief did not complete successfully');
    } finally {
      process.chdir(originalCwd);
    }
    await expect(readFile(failedResponsePath)).rejects.toMatchObject({code: 'ENOENT'});
    const failedTranscript = (await readFile(failedTranscriptPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(failedTranscript.map(row => row.kind)).toEqual(['agent', 'context-delivery-failure']);
    expect(failedTranscript[0]).toMatchObject({usage: {inputTokens: 100, outputTokens: 50, totalTokens: 150}});
    expect(JSON.parse(await readFile(failedArtifactPath, 'utf8')) as unknown).toMatchObject({
      arm: 'threadnote-graph',
      patchSha256: sha256HexSync(''),
    });
    expect(await readFile(`${failedTranscriptPath}.agent.jsonl`, 'utf8')).toContain('"totalTokens":150');
    expect((await readdir(root)).filter(name => name.startsWith('matched-evaluation-codex-'))).toEqual([]);
  }, 30_000);
});

function contextDelivery(text = '{"answer":"Relevant evidence","graph":{"cards":[{"path":"service.ts"}]}}') {
  const expected: MatchedEvaluationExpectedContextDeliveryV1 = {
    graphContentHash: '1'.repeat(64),
    graphSnapshotHash: '2'.repeat(64),
    linkReceiptsHash: '3'.repeat(64),
    memoryAccess: 'linked',
    studyHash: '4'.repeat(64),
    taskContextHash: '5'.repeat(64),
    detail: 'compact',
    mode: 'brief',
    frozenPromptSha256: sha256HexSync('Task with `formatting` and trailing space. '),
    initialBriefDelivery: 'mcp',
    maximumFollowupCalls: 4,
    requiredGraphQuery: null,
    runNonce: 'run_0123456789abcdef0123456789abcdef',
    runtimeManifestSha256: '6'.repeat(64),
    expectedResumeHash: null,
  };
  const receipt = {
    graphContentHash: expected.graphContentHash,
    graphSnapshotHash: expected.graphSnapshotHash,
    linkReceiptsHash: expected.linkReceiptsHash,
    memoryAccess: expected.memoryAccess,
    studyHash: expected.studyHash,
    taskContextHash: expected.taskContextHash,
    expectedResumeHash: expected.expectedResumeHash,
    contentResponseSha256: sha256HexSync(text),
    graphReady: true,
    mode: expected.mode,
    frozenPromptSha256: expected.frozenPromptSha256,
    runNonce: expected.runNonce,
    runtimeManifestSha256: expected.runtimeManifestSha256,
    requestSha256: hashMatchedEvaluationContextRequest('context_brief', {}),
    success: true,
    toolName: 'context_brief',
    version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
  };
  const result = {content: [{type: 'text', text}], _meta: {matchedEvaluation: receipt}};
  const item = {
    type: 'mcpToolCall',
    id: 'context-call',
    server: 'matched_evaluation_context',
    tool: 'context_brief',
    arguments: {},
    status: 'completed',
    error: null,
    result,
  };
  const event = {method: 'item/completed', params: {item}};
  return {event, expected, item, receipt, result};
}

function contextFollowup(
  base: ReturnType<typeof contextDelivery>,
  tool: 'inspect_code_graph' | 'recall_context' | 'read_context',
  arguments_: Record<string, unknown>,
  status: 'completed' | 'failed',
  isError: boolean,
  id = `${tool}-call`,
) {
  const text = JSON.stringify({tool, arguments: arguments_});
  const item = {
    ...base.item,
    arguments: arguments_,
    id,
    result: {
      content: [{type: 'text', text}],
      isError,
      _meta: {
        matchedEvaluation: {
          graphContentHash: base.expected.graphContentHash,
          graphSnapshotHash: base.expected.graphSnapshotHash,
          linkReceiptsHash: base.expected.linkReceiptsHash,
          memoryAccess: base.expected.memoryAccess,
          studyHash: base.expected.studyHash,
          taskContextHash: base.expected.taskContextHash,
          expectedResumeHash: base.expected.expectedResumeHash,
          mode: base.expected.mode,
          frozenPromptSha256: base.expected.frozenPromptSha256,
          runNonce: base.expected.runNonce,
          runtimeManifestSha256: base.expected.runtimeManifestSha256,
          contentResponseSha256: sha256HexSync(text),
          graphReady: true,
          requestSha256: hashMatchedEvaluationContextRequest(tool, arguments_),
          success: status === 'completed' && !isError,
          toolName: tool,
          version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
        },
      },
      structuredContent: undefined,
    },
    status,
    tool,
  };
  return {event: {method: 'item/completed', params: {item}}, item};
}

function adapterRequest(arm: 'files' | 'threadnote-graph' | 'threadnote-compact', continuationTreatment: unknown) {
  const detail = arm === 'files' ? null : arm === 'threadnote-graph' ? 'graph-only' : 'compact';
  return {
    adapterArtifactHash: '1'.repeat(64),
    adapterConfigurationHash: '2'.repeat(64),
    adapterProtocol: 'matched-evaluation-adapter-v5',
    agentTask: {
      category: 'architecture-discovery',
      memoryFixtures: [],
      prompt: 'Complete phase two in the isolated repository.',
      repositoryFixtureHash: '3'.repeat(64),
      taskId: 'tsk_0123456789abcdef',
      variant: 'implementation',
    },
    arm,
    artifactPath: '/tmp/artifact.json',
    blindLabel: 'A',
    continuationTreatment,
    environmentPolicyHash: '4'.repeat(64),
    judgeTask: {
      negativeControls: [],
      rubric: {completion: 'Complete.', criteria: ['Correct.'], requiredEvidenceIds: []},
      sourceGold: [],
    },
    manifestHash: '5'.repeat(64),
    model: {model: 'agent-model', parametersHash: '6'.repeat(64), provider: 'openai'},
    preparedContext: null,
    repository: {dirty: false, fixtureHash: '3'.repeat(64), identityHash: '7'.repeat(64), revision: '8'.repeat(40)},
    runNonce: 'run_0123456789abcdef0123456789abcdef',
    runOrder: 0,
    tool: {artifactHash: null, detail, executable: null, lockIdentityHash: null, name: 'fixture', version: '1'},
    transcriptPath: '/tmp/transcript.jsonl',
    verificationPlanHash: null,
    version: 4,
  };
}

function adapterConfig() {
  return {
    approvedCommands: [],
    appServer: {
      argumentsAfterSubcommand: [],
      argumentsBeforeSubcommand: [],
      executable: '/usr/bin/codex',
      executableSha256: '1'.repeat(64),
      version: 'codex-cli 1.0.0',
    },
    arm: 'files' as const,
    authSourcePath: '/tmp/auth.json',
    contextBudgetTokens: 1_200,
    contextHomes: [],
    dependencyProjections: [],
    environmentPolicyHash: matchedEvaluationCodexEnvironmentPolicyHashV1(),
    git: {executable: '/usr/bin/git', executableSha256: '3'.repeat(64)},
    judgeModel: {id: 'judge-model', parametersHash: '4'.repeat(64), provider: 'openai', reasoningEffort: 'low'},
    model: {id: 'agent-model', parametersHash: '5'.repeat(64), provider: 'openai', reasoningEffort: 'medium'},
    pricingMicrosPerMillionTokens: {cachedInput: 100_000, input: 1_000_000, output: 2_000_000},
    safeBinaries: [{path: '/usr/bin/git', sha256: '3'.repeat(64)}],
    safeExecutablePath: '/usr/bin:/bin',
    taskBudget: {steps: 100, tokens: 100_000},
    temporaryRoot: '/tmp',
    verificationPlan: null,
    version: 4 as const,
  };
}

function usageEvent(total: {
  readonly cacheWriteTokens?: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}): Record<string, unknown> {
  return {method: 'thread/tokenUsage/updated', params: {tokenUsage: {total}}};
}

function completedEvent(id: string, type: string, values: Record<string, unknown> = {}): Record<string, unknown> {
  return {method: 'item/completed', params: {item: {id, type, ...values}}};
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-adapter-')));
  roots.push(root);
  return root;
}

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', cwd, ...arguments_],
    command: 'git',
    cwd,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Matched evaluation adapter Git fixture',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
}
