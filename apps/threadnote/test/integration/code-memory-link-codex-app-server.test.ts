import {Schema} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_AGENT_DEVELOPER_INSTRUCTIONS,
  assertOnlyContextBriefProxy,
  assertTraceIsolation,
  runCodeMemoryLinkAppServerTurn,
} from '../../../../scripts/code-memory-link-app-server-client.js';
import {selectCodeMemoryLinkQualifyingActionItemId} from '../../../../scripts/run-code-memory-link-codex-client.js';
import {
  CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES,
  createCodeMemoryLinkCodexIsolation,
  type CodeMemoryLinkCodexClientConfigV1,
} from '../../../../scripts/code-memory-link-codex-isolation.js';
import {CodeMemoryLinkCodexTerminalError} from '../../../../scripts/code-memory-link-codex-terminal.js';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkArmPacketHashV1,
  codeMemoryLinkCodexAppServerEvidenceHashV1,
  codeMemoryLinkContextBriefProxyDecisionHashV1,
  codeMemoryLinkContextBriefRawRequestHashV1,
  codeMemoryLinkContextBriefResponseReceiptHashV1,
  codeMemoryLinkGoldCitationDigest,
  codeMemoryLinkRubricHashV1,
  codeMemoryLinkStaticArtifactSha256,
  deriveCodeMemoryLinkCodexAppServerProjectionV1,
  normalizeCodeMemoryLinkCodexAppServerEvidenceV1,
  type CodeMemoryLinkCodexAppServerEvidenceV1,
  type CodeMemoryLinkContextBriefResponseReceiptV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkCodexInvocationNonceDigestV1,
  codeMemoryLinkCodexPreflightReceiptHashV1,
  codeMemoryLinkCodexRunBindingHashV1,
  createCodeMemoryLinkCodexRawEvidenceV1,
  parseCodeMemoryLinkCodexRawEvidenceV1,
  type CodeMemoryLinkCodexGraphPreflightEvidenceV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-codex-evidence';
import {codeMemoryLinkClientProjectionHash} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {
  assertCodeMemoryLinkAgentEvidenceLedgerV1,
  codeMemoryLinkAgentEvidenceReceiptDigest,
  createCodeMemoryLinkAgentEvidenceReceiptV1,
  parseCodeMemoryLinkAgentClientOutputV1,
  parseCodeMemoryLinkAgentEvidenceJsonl,
  serializeCodeMemoryLinkAgentEvidenceJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-evidence';
import {
  createCodeMemoryLinkAgentAbTrialV1,
  type CodeMemoryLinkAgentAbAssignmentV1,
  type CodeMemoryLinkAgentAbClientTrialSummaryV1,
  type CodeMemoryLinkAgentAbManifestV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  createCodeMemoryLinkAgentPendingCommitV1,
  parseCodeMemoryLinkAgentPendingCommitJsonV1,
  parseCodeMemoryLinkAgentPendingCommitV1,
  reconcileCodeMemoryLinkAgentPendingCommitV1,
  serializeCodeMemoryLinkAgentPendingCommitJsonV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-pending';

describe('Code Memory Link Codex app-server transport', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('names the pinned code-mode edit surface without implying a direct apply_patch tool', () => {
    expect(CODE_MEMORY_LINK_AGENT_DEVELOPER_INSTRUCTIONS).toContain('tools.apply_patch through functions.exec');
    expect(CODE_MEMORY_LINK_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      'tools.exec_command for read-only shell inspection',
    );
    expect(CODE_MEMORY_LINK_AGENT_DEVELOPER_INSTRUCTIONS).not.toContain('built-in apply_patch');
  });

  it('completes a no-model JSONL canary and preserves authoritative event ordering', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'threadnote-codex-app-server-canary-'));
    temporaryRoots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, 'src'));
    await writeFile(join(repositoryRoot, 'src/service.ts'), 'export const service = true;\n');
    const fake = join(process.cwd(), 'packages/testing/src/fake-code-memory-link-app-server.ts');

    const trace = await runCodeMemoryLinkAppServerTurn({
      appServer: {argumentsBeforeSubcommand: [fake], executable: process.execPath},
      cwd: repositoryRoot,
      environment: {HOME: repositoryRoot, PATH: process.env.PATH ?? '/usr/bin:/bin'},
      expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
      outputSchema: {
        additionalProperties: false,
        properties: {status: {const: 'done', type: 'string'}},
        required: ['status'],
        type: 'object',
      },
      prompt: 'Complete the public fixture task.',
      proxyServerName: 'context_brief_gate',
      taskBudget: {steps: 2, tokens: 150},
      timeoutMilliseconds: 10_000,
    });

    const ordered = trace.events.map(event => event.method);
    const firstCompleted = ordered.indexOf('item/completed');
    const firstUsage = ordered.indexOf('thread/tokenUsage/updated');
    const turnCompleted = ordered.indexOf('turn/completed');
    expect(firstCompleted).toBeGreaterThan(-1);
    expect(firstUsage).toBeGreaterThan(firstCompleted);
    expect(turnCompleted).toBeGreaterThan(firstUsage);
    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0]).toMatchObject({itemType: 'commandExecution'});
    expect(trace.threadStartResponse).toMatchObject({
      instructionSources: [],
      model: 'gpt-5.6-luna',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    });

    const autoReviewedTrace = await runCodeMemoryLinkAppServerTurn({
      appServer: {argumentsBeforeSubcommand: [fake], executable: process.execPath},
      cwd: repositoryRoot,
      environment: {
        HOME: repositoryRoot,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        THREADNOTE_TEST_AUTO_APPROVAL_REVIEW: '1',
      },
      expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
      outputSchema: {
        additionalProperties: false,
        properties: {status: {const: 'done', type: 'string'}},
        required: ['status'],
        type: 'object',
      },
      prompt: 'Complete the public fixture task.',
      proxyServerName: 'context_brief_gate',
      taskBudget: {steps: 2, tokens: 150},
      timeoutMilliseconds: 10_000,
    });
    expect(autoReviewedTrace.approvals).toEqual([]);
    expect(autoReviewedTrace.events.map(event => event.method)).toContain('item/autoApprovalReview/completed');

    const artifactId = `art_${'1'.repeat(16)}`;
    const rubricInput = {
      fixtureHash: '1'.repeat(64),
      goldCitationDigests: [],
      predicates: [
        {
          assertion: {artifactId, expected: 'pass=true', kind: 'utf8-contains' as const},
          expected: true,
          predicateId: `prd_${'1'.repeat(16)}`,
          roles: ['task-pass'] as const,
        },
      ],
      qualifyingActionItemTypes: [],
      taskId: `tsk_${'1'.repeat(16)}`,
      taskKind: 'negative-control' as const,
      version: 1 as const,
    };
    const rubric = {...rubricInput, rubricHash: codeMemoryLinkRubricHashV1(rubricInput)};
    const content = 'pass=true\n';
    const expectedClient = {
      appServerVersion: '0.149.0-alpha.4.1' as const,
      model: 'gpt-5.6-luna',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    };
    const proxyTool = {server: 'context_brief_gate', tool: 'context_brief'};
    const bindingSeed = {
      approvalCommit: '1'.repeat(40),
      arm: 'no-memory' as const,
      armPosition: 3 as const,
      assignmentHash: '2'.repeat(64),
      blindLabel: 'Z' as const,
      budget: {steps: 2, tokens: 150},
      candidateCommit: '3'.repeat(40),
      candidateExecutableSha256: '4'.repeat(64),
      clientDescriptorHash: '5'.repeat(64),
      clientId: `cli_${'6'.repeat(16)}`,
      fixtureHash: rubric.fixtureHash,
      invocationNonceDigest: codeMemoryLinkCodexInvocationNonceDigestV1(`inv_${'7'.repeat(16)}`),
      manifestHash: '8'.repeat(64),
      packetHash: '9'.repeat(64),
      rubricHash: rubric.rubricHash,
      runNonce: `run_${'a'.repeat(16)}`,
      runOrder: 0,
      suiteHash: 'b'.repeat(64),
      taskId: rubric.taskId,
      taskKind: rubric.taskKind,
    };
    const armPacketHash = codeMemoryLinkArmPacketHashV1({
      assignmentHash: bindingSeed.assignmentHash,
      blindLabel: bindingSeed.blindLabel,
      fixtureHash: bindingSeed.fixtureHash,
      packetHash: bindingSeed.packetHash,
      policy: bindingSeed.arm,
      rubricHash: bindingSeed.rubricHash,
      runNonce: bindingSeed.runNonce,
      taskId: bindingSeed.taskId,
      taskKind: bindingSeed.taskKind,
      version: 1,
    });
    const runBindingHash = codeMemoryLinkCodexRunBindingHashV1({
      armPacketHash,
      candidateExecutableSha256: bindingSeed.candidateExecutableSha256,
      clientExecutionHash: bindingSeed.clientDescriptorHash,
      invocationNonceDigest: bindingSeed.invocationNonceDigest,
      manifestHash: bindingSeed.manifestHash,
      runNonce: bindingSeed.runNonce,
      suiteHash: bindingSeed.suiteHash,
      taskId: bindingSeed.taskId,
    });
    const responseReceipts = contextBriefArmReceipts();
    const releaseEvents = structuredClone(trace.events);
    sealTransportContextBriefResult({
      armPacketHash,
      events: releaseEvents,
      response: CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
      runBindingHash,
    });
    const sealedToolResult = (
      releaseEvents.find(candidate => {
        const params = candidate.params as {item?: {type?: unknown}} | undefined;
        return candidate.method === 'item/completed' && params?.item?.type === 'mcpToolCall';
      })?.params as {item?: {result?: {content?: readonly {text?: unknown; type?: unknown}[]}}} | undefined
    )?.item?.result;
    expect(sealedToolResult?.content).toHaveLength(1);
    expect(JSON.parse(String(sealedToolResult?.content?.[0]?.text))).toEqual(
      CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
    );
    const evidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1({
      approvalReceipts: trace.approvals,
      events: releaseEvents,
      expectedClient,
      proxyTool,
      qualifyingActionItemId: null,
      rubric,
      runBindingHash,
      staticArtifacts: [
        {artifactId, content, mediaType: 'text/plain', sha256: codeMemoryLinkStaticArtifactSha256(content)},
      ],
      threadStartResponse: trace.threadStartResponse,
    });
    expect(evidence.checkpoints.map(checkpoint => checkpoint.method)).toEqual(
      ordered.filter(method =>
        ['turn/started', 'item/started', 'item/completed', 'thread/tokenUsage/updated', 'turn/completed'].includes(
          String(method),
        ),
      ),
    );
    const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence, rubric});
    expect(projection.totalTaskUsage).toEqual({
      steps: 2,
      tokens: 150,
    });
    const rawEvidence = createCodeMemoryLinkCodexRawEvidenceV1({
      appServer: evidence,
      bindings: {
        ...bindingSeed,
        armPacketHash,
        runBindingHash,
      },
      clientProtocol: {
        configurationProjectionHash: 'c'.repeat(64),
        environmentPolicyHash: 'd'.repeat(64),
        executionBundleHash: 'e'.repeat(64),
        expectedClient,
        expectedClientProjectionHash: codeMemoryLinkClientProjectionHash('expected-client', {
          appServerVersion: expectedClient.appServerVersion,
          model: expectedClient.model,
          modelProvider: expectedClient.modelProvider,
          proxyTool,
          reasoningEffort: expectedClient.reasoningEffort,
        }),
        proxyTool,
      },
      finalPublicArtifacts: [{byteCount: 10, contentSha256: 'c'.repeat(64), pathDigest: 'd'.repeat(64), type: 'file'}],
      graphPreflight: withPreflightReceipt({
        commit: 'e'.repeat(40),
        graphContentDigest: 'f'.repeat(64),
        graphSnapshotDigest: '1'.repeat(64),
        observedCitationDigests: [],
        observedResponses: responseReceipts,
        observedSelectedMemories: [],
        originDigest: '2'.repeat(64),
        runBindingHash,
      }),
      judge: {
        adjudicationHash: projection.adjudicationHash,
        commandArtifactId: `art_${'3'.repeat(16)}`,
        commandSha256: '3'.repeat(64),
        programArtifactId: `art_${'4'.repeat(16)}`,
        programSha256: '4'.repeat(64),
        repositorySnapshotHash: '7'.repeat(64),
        runBindingHash,
        staticObservationHash: evidence.staticObservationHash,
        stderrSha256: '5'.repeat(64),
        stdoutSha256: '6'.repeat(64),
      },
      rubric,
      version: 1,
    });
    expect(parseCodeMemoryLinkCodexRawEvidenceV1(rawEvidence)).toEqual(rawEvidence);
    const {evidenceHash: _rawEvidenceHash, ...rawEvidenceWithoutHash} = rawEvidence;
    const missingCallEvidence = rehashAppServerEvidence(
      evidence,
      evidence.checkpoints.filter(checkpoint => !('itemType' in checkpoint) || checkpoint.itemType !== 'mcpToolCall'),
    );
    const missingCallRawEvidence = createCodeMemoryLinkCodexRawEvidenceV1({
      ...rawEvidenceWithoutHash,
      appServer: missingCallEvidence,
    });
    expect(parseCodeMemoryLinkCodexRawEvidenceV1(missingCallRawEvidence)).toEqual(missingCallRawEvidence);
    expect(deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: missingCallEvidence, rubric})).toMatchObject({
      contextBriefCalls: [],
      contextBriefProtocolAdhered: false,
      taskPassed: false,
    });

    const failedCallEvidence = rehashAppServerEvidence(
      evidence,
      evidence.checkpoints.map(checkpoint =>
        checkpoint.method === 'item/completed' && checkpoint.itemType === 'mcpToolCall'
          ? {...checkpoint, proxyReceipt: null, response: null, status: 'failed' as const, succeeded: false}
          : checkpoint,
      ),
    );
    const failedCallRawEvidence = createCodeMemoryLinkCodexRawEvidenceV1({
      ...rawEvidenceWithoutHash,
      appServer: failedCallEvidence,
    });
    expect(parseCodeMemoryLinkCodexRawEvidenceV1(failedCallRawEvidence)).toEqual(failedCallRawEvidence);
    expect(deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: failedCallEvidence, rubric})).toMatchObject({
      contextBriefCalls: [expect.objectContaining({succeeded: false})],
      contextBriefProtocolAdhered: false,
      taskPassed: false,
    });
    const directCitationId = `tncc_${'1'.repeat(40)}`;
    const anchoredReceipt = canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [
        {
          codeRelations: [{citationId: directCitationId, kind: 'file', status: 'exact'}],
          excerpt: 'Opaque direct memory.',
          selectionBasis: 'code-citation',
          uri: 'threadnote://user/test/memories/direct.md',
        },
      ],
      type: 'context-brief',
      version: 3,
    }).receipt;
    const directCitationDigest = codeMemoryLinkGoldCitationDigest(directCitationId);
    expect(anchoredReceipt).toMatchObject({
      citationDigests: [],
      directCurrentRelationDigests: [directCitationDigest],
    });
    const anchoredPreflightEvidence = createCodeMemoryLinkCodexRawEvidenceV1({
      ...rawEvidenceWithoutHash,
      graphPreflight: withPreflightReceipt({
        commit: rawEvidence.graphPreflight.commit,
        graphContentDigest: rawEvidence.graphPreflight.graphContentDigest,
        graphSnapshotDigest: rawEvidence.graphPreflight.graphSnapshotDigest,
        observedCitationDigests: [directCitationDigest],
        observedResponses: {...responseReceipts, anchored: anchoredReceipt},
        observedSelectedMemories: anchoredReceipt.selectedMemories,
        originDigest: rawEvidence.graphPreflight.originDigest,
        runBindingHash,
      }),
    });
    expect(parseCodeMemoryLinkCodexRawEvidenceV1(anchoredPreflightEvidence)).toEqual(anchoredPreflightEvidence);
    expect(() =>
      createCodeMemoryLinkCodexRawEvidenceV1({
        ...rawEvidenceWithoutHash,
        bindings: {...rawEvidence.bindings, arm: 'anchored'},
      }),
    ).toThrow(/arm packet hash/u);
    expect(() =>
      normalizeCodeMemoryLinkCodexAppServerEvidenceV1({
        approvalReceipts: trace.approvals,
        events: releaseEvents,
        expectedClient,
        proxyTool,
        qualifyingActionItemId: null,
        rubric,
        runBindingHash: '0'.repeat(64),
        staticArtifacts: [
          {artifactId, content, mediaType: 'text/plain', sha256: codeMemoryLinkStaticArtifactSha256(content)},
        ],
        threadStartResponse: trace.threadStartResponse,
      }),
    ).toThrow(/run binding/u);
    expect(() =>
      parseCodeMemoryLinkCodexRawEvidenceV1({
        ...rawEvidence,
        bindings: {...rawEvidence.bindings, packetHash: '0'.repeat(64)},
      }),
    ).toThrow(/arm packet hash/u);

    const trialSummary: CodeMemoryLinkAgentAbClientTrialSummaryV1 = {
      acceptedStaleOrHarmful: projection.acceptedStaleOrHarmful,
      adjudicationHash: projection.adjudicationHash,
      approvalCommit: rawEvidence.bindings.approvalCommit,
      armPosition: rawEvidence.bindings.armPosition,
      assignmentHash: rawEvidence.bindings.assignmentHash,
      blindLabel: rawEvidence.bindings.blindLabel,
      budget: rawEvidence.bindings.budget,
      clientId: rawEvidence.bindings.clientId,
      constraintAdherence: projection.constraintAdherence,
      evidenceKind: 'external-agent',
      firstUsefulMemoryUse: projection.firstUsefulMemoryUse,
      fixtureHash: rawEvidence.bindings.fixtureHash,
      manifestHash: rawEvidence.bindings.manifestHash,
      packetHash: rawEvidence.bindings.packetHash,
      providerUsageHash: projection.providerUsageHash,
      rubricHash: rawEvidence.bindings.rubricHash,
      runNonce: rawEvidence.bindings.runNonce,
      runOrder: rawEvidence.bindings.runOrder,
      taskId: rawEvidence.bindings.taskId,
      taskKind: rawEvidence.bindings.taskKind,
      taskPassed: projection.taskPassed,
      tokenAccounting: 'provider-reported',
      totalTaskUsage: projection.totalTaskUsage,
      version: 1,
    };
    const clientOutput = parseCodeMemoryLinkAgentClientOutputV1({rawEvidence, trial: trialSummary, version: 1});
    expect(clientOutput).toEqual({rawEvidence, trial: trialSummary, version: 1});
    expect(clientOutput.trial).not.toHaveProperty('trialId');
    expect(clientOutput.trial).not.toHaveProperty('suiteHash');
    expect(() =>
      parseCodeMemoryLinkAgentClientOutputV1({extra: true, rawEvidence, trial: trialSummary, version: 1}),
    ).toThrow('unsupported or missing fields');
    expect(() => parseCodeMemoryLinkAgentClientOutputV1({trial: trialSummary, version: 1})).toThrow(
      'unsupported or missing fields',
    );

    const invocationNonce = `inv_${'7'.repeat(16)}`;
    const candidate = {
      buildIdentityHash: rawEvidence.bindings.candidateExecutableSha256,
      commit: rawEvidence.bindings.candidateCommit,
      dirty: false as const,
    };
    const runtime = {
      executableSha256: candidate.buildIdentityHash,
      sourceCommit: candidate.commit,
    };
    const trial = createCodeMemoryLinkAgentAbTrialV1({
      candidate,
      invocationNonce,
      postRuntime: runtime,
      preRuntime: runtime,
      previousReceiptDigest: null,
      trial: clientOutput.trial,
      trialId: `trl_${'8'.repeat(16)}`,
    });
    const receipt = createCodeMemoryLinkAgentEvidenceReceiptV1({
      previousEvidenceDigest: null,
      rawEvidence: clientOutput.rawEvidence,
      trialId: trial.trialId,
    });
    const firstReceiptDigest = codeMemoryLinkAgentEvidenceReceiptDigest(receipt);
    const chainedRawEvidence = createCodeMemoryLinkCodexRawEvidenceV1({
      ...rawEvidenceWithoutHash,
      bindings: {...rawEvidenceWithoutHash.bindings, runOrder: 1},
    });
    const chainedReceipt = createCodeMemoryLinkAgentEvidenceReceiptV1({
      previousEvidenceDigest: firstReceiptDigest,
      rawEvidence: chainedRawEvidence,
      trialId: `trl_${'9'.repeat(16)}`,
    });
    const evidenceJsonl = serializeCodeMemoryLinkAgentEvidenceJsonl([receipt, chainedReceipt]);
    expect(parseCodeMemoryLinkAgentEvidenceJsonl(evidenceJsonl)).toEqual([receipt, chainedReceipt]);
    expect(chainedReceipt.previousEvidenceDigest).toBe(firstReceiptDigest);
    expect(firstReceiptDigest).toMatch(/^[0-9a-f]{64}$/u);

    const assignment: CodeMemoryLinkAgentAbAssignmentV1 = {
      assignmentHash: rawEvidence.bindings.assignmentHash,
      fixtureHash: rawEvidence.bindings.fixtureHash,
      labels: {X: 'anchored', Y: 'task-only', Z: 'no-memory'},
      version: 1,
    };
    const manifest: CodeMemoryLinkAgentAbManifestV1 = {
      adjudicationArtifactHash: '9'.repeat(64),
      assignmentHash: rawEvidence.bindings.assignmentHash,
      candidate,
      clients: [
        {
          clientId: rawEvidence.bindings.clientId,
          configurationProjectionHash: rawEvidence.clientProtocol.configurationProjectionHash,
          environmentPolicyHash: rawEvidence.clientProtocol.environmentPolicyHash,
          executionBundleHash: rawEvidence.clientProtocol.executionBundleHash,
          expectedClient: rawEvidence.clientProtocol.expectedClient,
          implementationDescriptorHash: rawEvidence.bindings.clientDescriptorHash,
        },
      ],
      evaluatorVersion: 'test-v1',
      experimentId: `exp_${'1'.repeat(16)}`,
      fixtureHash: rawEvidence.bindings.fixtureHash,
      judgeVersion: 'test-v1',
      manifestHash: rawEvidence.bindings.manifestHash,
      schedule: [
        {
          armPosition: rawEvidence.bindings.armPosition,
          blindLabel: rawEvidence.bindings.blindLabel,
          clientId: rawEvidence.bindings.clientId,
          runNonce: rawEvidence.bindings.runNonce,
          runOrder: rawEvidence.bindings.runOrder,
          taskId: rawEvidence.bindings.taskId,
        },
      ],
      scheduleAlgorithmVersion: 'sha256-counterbalanced-v1',
      scheduleSeed: 'a'.repeat(64),
      suiteHash: rawEvidence.bindings.suiteHash,
      tasks: [
        {
          budget: rawEvidence.bindings.budget,
          constraintTotal: projection.constraintAdherence.total,
          expectedResponseHashes: {
            anchored: codeMemoryLinkContextBriefResponseReceiptHashV1(responseReceipts.anchored),
            noMemory: codeMemoryLinkContextBriefResponseReceiptHashV1(responseReceipts.noMemory),
            taskOnly: codeMemoryLinkContextBriefResponseReceiptHashV1(responseReceipts.taskOnly),
          },
          packetHash: rawEvidence.bindings.packetHash,
          rubricHash: rawEvidence.bindings.rubricHash,
          scenarioFamily:
            rawEvidence.bindings.taskKind === 'hidden-constraint' ? 'hidden:lexical' : 'control:no-backlink',
          taskId: rawEvidence.bindings.taskId,
          taskKind: rawEvidence.bindings.taskKind,
        },
      ],
      version: 1,
    };
    expect(
      assertCodeMemoryLinkAgentEvidenceLedgerV1({assignment, evidence: [receipt], manifest, trials: [trial]}),
    ).toEqual([receipt]);

    const pending = createCodeMemoryLinkAgentPendingCommitV1({evidence: receipt, index: 0, trial});
    expect(
      parseCodeMemoryLinkAgentPendingCommitJsonV1(serializeCodeMemoryLinkAgentPendingCommitJsonV1(pending)),
    ).toEqual(pending);
    for (const [durableEvidence, durableTrial] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const reconciled = reconcileCodeMemoryLinkAgentPendingCommitV1({
        evidence: durableEvidence ? [receipt] : [],
        pending,
        trials: durableTrial ? [trial] : [],
      });
      expect(reconciled).toMatchObject({appendEvidence: !durableEvidence, appendTrial: !durableTrial});
      expect(reconciled.evidence).toEqual([receipt]);
      expect(reconciled.trials).toEqual([trial]);
    }
    expect(() => parseCodeMemoryLinkAgentPendingCommitV1({...pending, commitDigest: '0'.repeat(64)})).toThrow(
      'digest does not match',
    );
    const conflictingReceipt = createCodeMemoryLinkAgentEvidenceReceiptV1({
      previousEvidenceDigest: null,
      rawEvidence: chainedRawEvidence,
      trialId: trial.trialId,
    });
    expect(() =>
      reconcileCodeMemoryLinkAgentPendingCommitV1({evidence: [conflictingReceipt], pending, trials: []}),
    ).toThrow('durable evidence conflicts');
  });

  it.each([
    ['THREADNOTE_TEST_APPROVAL_BEFORE_RESPONSE', /before the selected turn was scoped/u],
    ['THREADNOTE_TEST_MALFORMED_TURN_RESPONSE', /turn id must be non-empty text/u],
  ])('fails closed for invalid turn selection ordering via %s', async (variable, expected) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'threadnote-codex-app-server-invalid-turn-'));
    temporaryRoots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, 'src'));
    await writeFile(join(repositoryRoot, 'src/service.ts'), 'export const service = true;\n');

    const cause = await runCodeMemoryLinkAppServerTurn({
      appServer: {
        argumentsBeforeSubcommand: [join(process.cwd(), 'packages/testing/src/fake-code-memory-link-app-server.ts')],
        executable: process.execPath,
      },
      cwd: repositoryRoot,
      environment: {
        HOME: repositoryRoot,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        [variable]: '1',
      },
      expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
      outputSchema: {
        additionalProperties: false,
        properties: {status: {const: 'done', type: 'string'}},
        required: ['status'],
        type: 'object',
      },
      prompt: 'Complete the public fixture task.',
      proxyServerName: 'context_brief_gate',
      taskBudget: {steps: 2, tokens: 150},
      timeoutMilliseconds: 10_000,
    }).then(
      () => null,
      error => error,
    );
    expect(cause).toBeInstanceOf(CodeMemoryLinkCodexTerminalError);
    if (!Schema.is(CodeMemoryLinkCodexTerminalError)(cause)) {
      throw TestError.make({cause, message: 'Expected CodeMemoryLinkCodexTerminalError'});
    }
    expect(cause.message).toMatch(expected);
    expect(cause.diagnostics).toMatchObject({
      contextBriefCallStarts: 0,
      totalTaskUsage: {steps: 0, tokens: 0},
      version: 1,
    });
  });

  it('turns an unsafe completed action into a bounded client failure', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'threadnote-codex-app-server-unsafe-completion-'));
    temporaryRoots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, 'src'));
    await writeFile(join(repositoryRoot, 'src/service.ts'), 'export const service = true;\n');

    await expect(
      runCodeMemoryLinkAppServerTurn({
        appServer: {
          argumentsBeforeSubcommand: [join(process.cwd(), 'packages/testing/src/fake-code-memory-link-app-server.ts')],
          executable: process.execPath,
        },
        cwd: repositoryRoot,
        environment: {
          HOME: repositoryRoot,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          THREADNOTE_TEST_COMPLETED_ACTION_VIOLATION: '1',
        },
        expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
        outputSchema: {type: 'object'},
        prompt: 'Complete the public fixture task.',
        proxyServerName: 'context_brief_gate',
        taskBudget: {steps: 2, tokens: 150},
        timeoutMilliseconds: 10_000,
      }),
    ).rejects.toThrow('outside the reviewed read-only allowlist');
  });

  it('cancels a denied command and lets the selected turn recover through reviewed actions', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'threadnote-codex-app-server-denied-recovery-'));
    temporaryRoots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, 'src'));
    await writeFile(join(repositoryRoot, 'src/service.ts'), 'export const service = true;\n');

    const trace = await runCodeMemoryLinkAppServerTurn({
      appServer: {
        argumentsBeforeSubcommand: [join(process.cwd(), 'packages/testing/src/fake-code-memory-link-app-server.ts')],
        executable: process.execPath,
      },
      cwd: repositoryRoot,
      environment: {
        HOME: repositoryRoot,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        THREADNOTE_TEST_RECOVER_FROM_DENIED_COMMAND: '1',
      },
      expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
      outputSchema: {type: 'object'},
      prompt: 'Complete the public fixture task.',
      proxyServerName: 'context_brief_gate',
      taskBudget: {steps: 2, tokens: 150},
      timeoutMilliseconds: 10_000,
    });

    const declined = trace.events.find(event => {
      const params = event.params as {item?: {id?: unknown; status?: unknown}} | undefined;
      return event.method === 'item/completed' && params?.item?.id === 'item_denied_command';
    });
    expect(declined).toMatchObject({params: {item: {status: 'declined'}}});
    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0]).toMatchObject({itemType: 'commandExecution'});
  });

  it.each([
    ['instruction-source', /unexpected host or repository instruction source/u],
    ['read-only-sandbox', /did not enforce the no-network workspace sandbox/u],
    ['network-enabled', /did not enforce the no-network workspace sandbox/u],
    ['wrong-cwd', /did not honor the pinned model, provider, effort, cwd, or approval policy/u],
    ['wrong-approval', /did not honor the pinned model, provider, effort, cwd, or approval policy/u],
    ['extra-server', /exactly one unpaginated proxy server/u],
    ['unexpected-server', /contains an unexpected server/u],
    ['extra-tool', /must expose only context_brief/u],
    ['rerouted-tool', /returned a rerouted tool name/u],
  ])('rejects the %s preflight violation before starting a model turn', async (violation, expected) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'threadnote-codex-app-server-invalid-preflight-'));
    temporaryRoots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, 'src'));
    await writeFile(join(repositoryRoot, 'src/service.ts'), 'export const service = true;\n');

    await expect(
      runCodeMemoryLinkAppServerTurn({
        appServer: {
          argumentsBeforeSubcommand: [join(process.cwd(), 'packages/testing/src/fake-code-memory-link-app-server.ts')],
          executable: process.execPath,
        },
        cwd: repositoryRoot,
        environment: {
          HOME: repositoryRoot,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          THREADNOTE_TEST_PREFLIGHT_VIOLATION: violation,
        },
        expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
        outputSchema: {type: 'object'},
        prompt: 'Complete the public fixture task.',
        proxyServerName: 'context_brief_gate',
        taskBudget: {steps: 2, tokens: 150},
        timeoutMilliseconds: 10_000,
      }),
    ).rejects.toThrow(expected);
  });

  it('rejects out-of-repository reads, process inspection, foreign changes, and rerouted tools', () => {
    const expected = {
      proxyServerName: 'context_brief_gate',
      repositoryRoot: '/public/repository',
      threadId: 'thr_test',
      turnId: 'turn_test',
    };
    const completed = {
      method: 'turn/completed',
      params: {threadId: 'thr_test', turn: {id: 'turn_test', status: 'completed'}},
    };
    const event = (item: Record<string, unknown>) => ({method: 'item/completed', params: {item}});

    expect(() =>
      assertTraceIsolation(
        [
          event({
            command: 'cat /private/rubric.json',
            commandActions: [
              {command: 'cat /private/rubric.json', name: 'rubric.json', path: '/private/rubric.json', type: 'read'},
            ],
            cwd: '/public/repository',
            type: 'commandExecution',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('outside the public task repository');
    expect(() =>
      assertTraceIsolation(
        [
          event({
            command: 'printenv',
            commandActions: [{command: 'printenv', type: 'unknown'}],
            cwd: '/public/repository',
            type: 'commandExecution',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('read-only allowlist');
    expect(() =>
      assertTraceIsolation(
        [
          event({
            changes: [{diff: 'secret', kind: {update: {movePath: null}}, path: '/private/output'}],
            type: 'fileChange',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('outside the public task repository');
    expect(() =>
      assertTraceIsolation(
        [event({server: 'threadnote', tool: 'recall_context', type: 'mcpToolCall'}), completed],
        expected,
      ),
    ).toThrow('unexpected or rerouted');
    expect(() =>
      assertTraceIsolation(
        [
          event({
            command: 'cat "$CODEX_HOME/auth.json"',
            commandActions: [{command: 'cat', type: 'read'}],
            cwd: '/public/repository',
            type: 'commandExecution',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('expansion inside double quotes');
    expect(() =>
      assertTraceIsolation(
        [
          event({
            command: "python -c 'print(1)'",
            commandActions: [{command: 'python', type: 'read'}],
            cwd: '/public/repository',
            type: 'commandExecution',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('read-only allowlist');
    expect(() =>
      assertTraceIsolation(
        [
          event({
            changes: [{diff: 'change', kind: {update: {movePath: null}}, path: 'src/../result.json'}],
            type: 'fileChange',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('forbidden parent');
    expect(() =>
      assertTraceIsolation(
        [
          event({
            command: 'git diff --output /public/repository/leak --ext-diff',
            commandActions: [],
            cwd: '/public/repository',
            type: 'commandExecution',
          }),
          completed,
        ],
        expected,
      ),
    ).toThrow('git diff revisions and options are outside the reviewed grammar');
  });

  it('accepts lossy one-server inventory while preserving topology and routing checks', () => {
    for (const server of [
      {name: 'context_brief_gate', resourceTemplates: [], resources: [], tools: {}},
      {name: 'context_brief_gate', resourceTemplates: [], resources: []},
    ]) {
      expect(() => assertOnlyContextBriefProxy({data: [server], nextCursor: null}, 'context_brief_gate')).not.toThrow();
    }
    expect(() =>
      assertOnlyContextBriefProxy(
        {data: [{name: 'threadnote', resourceTemplates: [], resources: [], tools: {}}], nextCursor: null},
        'context_brief_gate',
      ),
    ).toThrow(/unexpected server/u);
  });

  it('allows ordinary agent-message deltas but rejects actual subagent and collaboration methods', () => {
    const expected = {
      proxyServerName: 'context_brief_gate',
      repositoryRoot: '/public/repository',
      threadId: 'thr_test',
      turnId: 'turn_test',
    };
    const settings = {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thr_test',
        threadSettings: {
          activePermissionProfile: null,
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          cwd: '/public/repository',
          sandboxPolicy: {
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
            networkAccess: false,
            type: 'workspaceWrite',
            writableRoots: [],
          },
        },
      },
    };
    const completed = {
      method: 'turn/completed',
      params: {threadId: 'thr_test', turn: {id: 'turn_test', status: 'completed'}},
    };

    expect(() =>
      assertTraceIsolation([settings, {method: 'item/agentMessage/delta', params: {}}, completed], expected),
    ).not.toThrow();
    for (const method of ['item/subagent/started', 'collab/started']) {
      expect(() => assertTraceIsolation([settings, {method, params: {}}, completed], expected)).toThrow(
        /unexpected subagent operation/u,
      );
    }
  });

  it('binds usefulness to the earliest successfully completed qualifying action start', () => {
    const item = (method: 'item/completed' | 'item/started', id: string, type: string, status: string) => ({
      method,
      params: {item: {id, status, type}},
    });
    const retrieval = item('item/completed', 'memory-after-first-action', 'mcpToolCall', 'completed');
    expect(
      selectCodeMemoryLinkQualifyingActionItemId(
        [
          item('item/started', 'first-action', 'fileChange', 'inProgress'),
          item('item/completed', 'first-action', 'fileChange', 'completed'),
          retrieval,
          item('item/started', 'second-action', 'fileChange', 'inProgress'),
          item('item/completed', 'second-action', 'fileChange', 'completed'),
        ],
        ['fileChange'],
      ),
    ).toBe('first-action');
    expect(
      selectCodeMemoryLinkQualifyingActionItemId(
        [
          item('item/started', 'early-start', 'commandExecution', 'inProgress'),
          item('item/started', 'late-start', 'fileChange', 'inProgress'),
          item('item/completed', 'late-start', 'fileChange', 'completed'),
          item('item/completed', 'early-start', 'commandExecution', 'completed'),
        ],
        ['commandExecution', 'fileChange'],
      ),
    ).toBe('early-start');
  });

  it('runs the fake transport through a fresh reviewed config/home with only the proxy schema', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-codex-isolation-canary-')));
    temporaryRoots.push(root);
    const suiteRoot = join(root, 'suite');
    const fixtureRepository = join(root, 'fixture-repository');
    const fixtureHome = join(root, 'fixture-home');
    await Promise.all([mkdir(suiteRoot), mkdir(fixtureRepository), mkdir(fixtureHome)]);
    await writeFile(join(fixtureRepository, 'service.ts'), 'export const service = true;\n');
    const fakeSource = await readFile(
      join(process.cwd(), 'packages/testing/src/fake-code-memory-link-app-server.ts'),
      'utf8',
    );
    const bunExecutable = await realpath(process.execPath);
    const fakeExecutable = join(root, 'fake-codex');
    await writeFile(fakeExecutable, fakeSource.replace('#!/usr/bin/env bun', `#!${bunExecutable}`), {mode: 0o700});
    const auth = join(root, 'auth.json');
    await writeFile(auth, '{}\n', {mode: 0o600});
    const proxyBundle = join(root, 'context-proxy.bundle.js');
    await writeFile(proxyBundle, 'export {};\n', {mode: 0o700});
    const safeExecutablePath = join(root, 'safe-bin');
    await mkdir(safeExecutablePath);
    const safeBinaries = await Promise.all(
      CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES.map(async name => {
        const path = join(safeExecutablePath, name);
        await writeFile(path, '#!/bin/sh\nexit 0\n', {mode: 0o700});
        return {name, path, sha256: await sha256File(path)};
      }),
    );
    const gitExecutable = await realpath('/usr/bin/git');
    const config: CodeMemoryLinkCodexClientConfigV1 = {
      appServer: {
        executable: fakeExecutable,
        executableSha256: await sha256File(fakeExecutable),
        version: 'codex-cli 0.149.0-alpha.4.1',
      },
      authSourcePath: auth,
      git: {executable: gitExecutable, executableSha256: await sha256File(gitExecutable)},
      limits: {turnTimeoutMilliseconds: 10_000},
      model: {id: 'gpt-5.6-luna', provider: 'openai', reasoningEffort: 'medium'},
      proxy: {
        bunExecutable,
        bunExecutableSha256: await sha256File(bunExecutable),
        bundlePath: proxyBundle,
        bundleSha256: await sha256File(proxyBundle),
      },
      safeBinaries,
      safeExecutablePath,
      sealedSuite: {layoutArtifactId: `art_${'1'.repeat(16)}`, root: suiteRoot},
      temporaryRoot: root,
      version: 1,
    };
    const isolation = await createCodeMemoryLinkCodexIsolation({
      config,
      fixtureRepository,
      fixtureThreadnoteHome: fixtureHome,
      proxyPacket: paths => ({paths}),
    });
    try {
      const generated = await readFile(join(isolation.codexHome, 'config.toml'), 'utf8');
      expect(generated.match(/^\[mcp_servers\./gmu)).toHaveLength(1);
      expect(generated).toContain('[mcp_servers.context_brief_gate]');
      expect(Object.keys(isolation.environment).some(key => key.startsWith('THREADNOTE_'))).toBe(false);
      const trace = await runCodeMemoryLinkAppServerTurn({
        appServer: isolation.appServer,
        cwd: isolation.repositoryRoot,
        environment: isolation.environment,
        expected: {model: 'gpt-5.6-luna', modelProvider: 'openai', reasoningEffort: 'medium'},
        outputSchema: {type: 'object'},
        prompt: 'Complete the isolated fixture task.',
        proxyServerName: 'context_brief_gate',
        taskBudget: {steps: 2, tokens: 150},
        timeoutMilliseconds: 10_000,
      });
      expect(trace.events.map(event => event.method).slice(0, 3)).toEqual([
        'remoteControl/status/changed',
        'thread/started',
        'mcpServer/startupStatus/updated',
      ]);
    } finally {
      await isolation.dispose();
    }
  });
});

function contextBriefArmReceipts(): {
  readonly anchored: CodeMemoryLinkContextBriefResponseReceiptV1;
  readonly noMemory: CodeMemoryLinkContextBriefResponseReceiptV1;
  readonly taskOnly: CodeMemoryLinkContextBriefResponseReceiptV1;
} {
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

function sealTransportContextBriefResult(input: {
  readonly armPacketHash: string;
  readonly events: readonly Record<string, unknown>[];
  readonly response: unknown;
  readonly runBindingHash: string;
}): void {
  const event = input.events.find(candidate => {
    if (candidate.method !== 'item/completed') return false;
    const params = candidate.params as {item?: {type?: unknown}} | undefined;
    return params?.item?.type === 'mcpToolCall';
  });
  if (!event) throw new Error('Missing Context Brief completion in transport fixture.');
  const item = (event.params as {item: Record<string, unknown>}).item;
  const rawRequest = item.arguments;
  const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(input.response);
  item.result = {
    _meta: {
      codeMemoryLink: {
        armPacketHash: input.armPacketHash,
        proxyDecisionHash: codeMemoryLinkContextBriefProxyDecisionHashV1({
          action: 'return-empty',
          response: canonical.structuredContent,
        }),
        rawRequestHash: codeMemoryLinkContextBriefRawRequestHashV1(rawRequest),
        responseHash: codeMemoryLinkContextBriefResponseReceiptHashV1(canonical.receipt),
        runBindingHash: input.runBindingHash,
        version: 1,
      },
    },
    content: canonical.content,
    structuredContent: canonical.structuredContent,
  };
}

function withPreflightReceipt(
  input: Omit<CodeMemoryLinkCodexGraphPreflightEvidenceV1, 'preflightReceiptHash'>,
): CodeMemoryLinkCodexGraphPreflightEvidenceV1 {
  return {...input, preflightReceiptHash: codeMemoryLinkCodexPreflightReceiptHashV1(input)};
}

function rehashAppServerEvidence(
  evidence: CodeMemoryLinkCodexAppServerEvidenceV1,
  checkpoints: CodeMemoryLinkCodexAppServerEvidenceV1['checkpoints'],
): CodeMemoryLinkCodexAppServerEvidenceV1 {
  const {evidenceHash: _evidenceHash, ...withoutHash} = evidence;
  const ordered: CodeMemoryLinkCodexAppServerEvidenceV1['checkpoints'] = checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    ordinal: index + 1,
  }));
  const candidate = {...withoutHash, checkpoints: ordered};
  return {...candidate, evidenceHash: codeMemoryLinkCodexAppServerEvidenceHashV1(candidate)};
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
