import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  assertCodeMemoryLinkSealedSuiteBindingsV1,
  assertCodeMemoryLinkExpectedCodexClientProjectionV1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkAppServerOpaqueIdDigest,
  codeMemoryLinkArmPacketHashV1,
  codeMemoryLinkCodexAppServerEvidenceHashV1,
  codeMemoryLinkContextBriefProxyDecisionHashV1,
  codeMemoryLinkContextBriefRawRequestHashV1,
  codeMemoryLinkContextBriefResponseReceiptHashV1,
  codeMemoryLinkFixtureHashV1,
  codeMemoryLinkGoldCitationDigest,
  codeMemoryLinkJudgeHashV1,
  codeMemoryLinkRubricHashV1,
  codeMemoryLinkSealedSuiteHashV1,
  codeMemoryLinkStaticArtifactSha256,
  codeMemoryLinkTaskPacketHashV1,
  deriveCodeMemoryLinkCodexAppServerProjectionV1,
  evaluateCodeMemoryLinkStaticArtifactsV1,
  normalizeCodeMemoryLinkCodexAppServerEvidenceV1,
  parseCodeMemoryLinkCodexAppServerEvidenceV1,
  parseCodeMemoryLinkSealedSuiteV1,
  projectCodeMemoryLinkCodexAppServerTraceV1,
  projectCodeMemoryLinkContextBriefRequestV1,
  projectCodeMemoryLinkExpectedCodexClientV1,
  type CodeMemoryLinkArmPacketV1,
  type CodeMemoryLinkCodexAppServerEvidenceV1,
  type CodeMemoryLinkFixtureV1,
  type CodeMemoryLinkJudgeV1,
  type CodeMemoryLinkRubricV1,
  type CodeMemoryLinkSealedSuiteV1,
  type CodeMemoryLinkStaticArtifactInputV1,
  type CodeMemoryLinkTaskKind,
  type CodeMemoryLinkTaskPacketV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {parseContextBriefJsonText, parseContextBriefV1, renderContextBriefText} from '@threadnote/context/projector';

const HASH_A = 'a'.repeat(64);
const GOLD_CITATION_ID = `tncc_${'1'.repeat(40)}`;
const TASK_ID = `tsk_${'1'.repeat(16)}`;
const PREDICATE_CONSTRAINT = `prd_${'1'.repeat(16)}`;
const PREDICATE_HARM = `prd_${'2'.repeat(16)}`;
const PREDICATE_MEMORY = `prd_${'3'.repeat(16)}`;
const PREDICATE_ACTION = `prd_${'4'.repeat(16)}`;
const THREAD_ID = '0198-thread';
const TURN_ID = '0198-turn';
const ACTION_ITEM_ID = 'item-action';
const STATIC_TEXT_ARTIFACT_ID = `art_${'a'.repeat(16)}`;
const STATIC_JSON_ARTIFACT_ID = `art_${'b'.repeat(16)}`;
const PROXY = {server: 'code-memory-link-proxy', tool: 'context_brief'} as const;
const ARM_PACKET_HASH = 'c'.repeat(64);
const RUN_BINDING_HASH = 'd'.repeat(64);
const CLIENT = {
  appServerVersion: '0.149.0-alpha.4.1',
  model: 'gpt-5.6-luna',
  modelProvider: 'openai',
  reasoningEffort: 'medium',
} as const;

describe('Code Memory Link real-agent protocol', () => {
  it('recomputes and binds the sealed 12+16 suite, packet, rubric, fixture, and judge hashes', () => {
    const corpus = suiteCorpus();

    expect(parseCodeMemoryLinkSealedSuiteV1(corpus.suite)).toEqual(corpus.suite);
    expect(() =>
      assertCodeMemoryLinkSealedSuiteBindingsV1({
        rubrics: corpus.rubrics,
        suite: corpus.suite,
        taskPackets: corpus.packets,
      }),
    ).not.toThrow();

    const tampered = structuredClone(corpus.suite);
    (tampered.tasks as unknown as {packetHash: string}[])[0].packetHash = HASH_A;
    expect(() => parseCodeMemoryLinkSealedSuiteV1(tampered)).toThrow(/suite hash/u);
    expect(() => parseCodeMemoryLinkSealedSuiteV1({...corpus.suite, unexpected: true})).toThrow(
      /unsupported or missing fields/u,
    );
  });

  it('uses only static sealed predicates for deterministic judgment', () => {
    const rubric = hiddenRubric();
    const firstEvaluation = evaluateCodeMemoryLinkStaticArtifactsV1({
      artifacts: passingStaticArtifacts(),
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
    });
    const first = firstEvaluation.judgment;
    const second = evaluateCodeMemoryLinkStaticArtifactsV1({
      artifacts: structuredClone(passingStaticArtifacts()),
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric: structuredClone(rubric),
    }).judgment;

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      acceptedStaleOrHarmful: false,
      constraintAdherence: {satisfied: 2, total: 2},
      memoryExclusiveSatisfied: true,
      qualifyingActionQualified: true,
      taskPassed: true,
    });
    const failed = evaluateCodeMemoryLinkStaticArtifactsV1({
      artifacts: failingStaticArtifacts(),
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
    }).judgment;
    expect(failed).toMatchObject({
      acceptedStaleOrHarmful: true,
      constraintAdherence: {satisfied: 0, total: 2},
      memoryExclusiveSatisfied: false,
      taskPassed: false,
    });
  });

  it('accepts only exact content-addressed static bytes and no filesystem path metadata', () => {
    const rubric = hiddenRubric();
    const [text, json] = structuredClone(passingStaticArtifacts());
    expect(() =>
      evaluateCodeMemoryLinkStaticArtifactsV1({
        artifacts: [{...text, sha256: HASH_A}, json],
        qualifyingActionItemId: ACTION_ITEM_ID,
        rubric,
      }),
    ).toThrow(/content hash/u);
    expect(() =>
      evaluateCodeMemoryLinkStaticArtifactsV1({
        artifacts: [{...text, path: '/private/result.txt'}, json],
        qualifyingActionItemId: ACTION_ITEM_ID,
        rubric,
      }),
    ).toThrow(/unsupported or missing fields/u);
  });

  it('applies all three arm policies without mutating the agent request', () => {
    const task = taskPacket(TASK_ID, 'hidden-constraint');
    const request = {
      budgetTokens: 1_250,
      callerCwd: '/opaque/sandbox',
      codeRefs: ['src/example.ts', `cgs_${'1'.repeat(32)}`],
      mode: 'brief',
      project: 'threadnote',
      task: task.prompt,
    };
    const original = structuredClone(request);
    const anchored = projectCodeMemoryLinkContextBriefRequestV1({
      armPacket: armPacket(task, 'anchored', 'X'),
      request,
      taskPacket: task,
    });
    const taskOnly = projectCodeMemoryLinkContextBriefRequestV1({
      armPacket: armPacket(task, 'task-only', 'Y'),
      request,
      taskPacket: task,
    });
    const noMemory = projectCodeMemoryLinkContextBriefRequestV1({
      armPacket: armPacket(task, 'no-memory', 'Z'),
      request,
      taskPacket: task,
    });

    expect(request).toEqual(original);
    expect(anchored).toMatchObject({action: 'forward', request: {codeRefs: original.codeRefs}});
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    expect(
      projectCodeMemoryLinkContextBriefRequestV1({
        armPacket: armPacket(task, 'anchored', 'X'),
        request: reordered,
        taskPacket: task,
      }),
    ).toEqual(anchored);
    expect(taskOnly.action).toBe('forward');
    if (taskOnly.action === 'forward') expect(taskOnly.request).not.toHaveProperty('codeRefs');
    expect(noMemory).toEqual({
      action: 'return-empty',
      response: CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
      responseHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(() =>
      projectCodeMemoryLinkContextBriefRequestV1({
        armPacket: armPacket(task, 'anchored', 'X'),
        request: {...request, budgetTokens: '1250'},
        taskPacket: task,
      }),
    ).toThrow(/token budget/u);
  });

  it('projects a successful pinned trace without retaining task, memory, code, or path text', () => {
    const rubric = hiddenRubric();
    const events = traceEvents([100, 200, 300, 400]);
    const input = {
      approvalReceipts: actionApprovalReceipts(),
      events,
      expectedClient: CLIENT,
      proxyTool: PROXY,
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
      runBindingHash: RUN_BINDING_HASH,
      staticArtifacts: passingStaticArtifacts(),
      threadStartResponse: threadStart(),
    } as const;
    const evidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1(input);
    const timestampedEvidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1({
      ...input,
      events: events.map((event, index) => ({
        ...(event as Record<string, unknown>),
        emittedAtMs: 1_788_307_000_000 + index,
      })),
    });
    const parsedEvidence = parseCodeMemoryLinkCodexAppServerEvidenceV1(structuredClone(evidence));
    const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: parsedEvidence, rubric});

    expect(projectCodeMemoryLinkCodexAppServerTraceV1(input)).toEqual(projection);
    expect(timestampedEvidence).toEqual(evidence);
    expect(evidence).toMatchObject({
      preTurn: {remoteControlDisabled: true, threadStarted: true},
      staticArtifactSetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      staticObservationHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(evidence.checkpoints.map(checkpoint => checkpoint.ordinal)).toEqual(
      evidence.checkpoints.map((_checkpoint, index) => index + 1),
    );
    expect(projection).toMatchObject({
      acceptedStaleOrHarmful: false,
      contextBriefProtocolAdhered: true,
      constraintAdherence: {satisfied: 2, total: 2},
      effectiveModel: CLIENT.model,
      firstUsefulMemoryUse: {steps: 2, tokens: 200},
      providerUsage: {totalTokens: 400},
      taskPassed: true,
      totalTaskUsage: {steps: 4, tokens: 400},
    });
    expect(projection.contextBriefCalls).toEqual([
      expect.objectContaining({
        associatedStep: 2,
        associatedTokens: 200,
        beforeQualifyingAction: true,
        goldCitationCount: 1,
        goldCitationMatched: true,
        succeeded: true,
      }),
    ]);
    const retained = JSON.stringify({evidence, projection});
    for (const forbidden of [
      GOLD_CITATION_ID,
      ACTION_ITEM_ID,
      THREAD_ID,
      TURN_ID,
      'private-installation-id',
      'private-server-name',
      'src/private/implementation.ts',
      'Memory says the hidden constraint.',
      'Implement the hidden constraint.',
    ]) {
      expect(retained).not.toContain(forbidden);
    }

    const notUseful = projectCodeMemoryLinkCodexAppServerTraceV1({
      approvalReceipts: actionApprovalReceipts(),
      events,
      expectedClient: CLIENT,
      proxyTool: PROXY,
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
      runBindingHash: RUN_BINDING_HASH,
      staticArtifacts: failingStaticArtifacts(),
      threadStartResponse: threadStart(),
    });
    expect(notUseful).toMatchObject({
      acceptedStaleOrHarmful: true,
      constraintAdherence: {satisfied: 0, total: 2},
      firstUsefulMemoryUse: null,
      taskPassed: false,
    });
  });

  it('retains a missing Context Brief call as a deterministic intention-to-treat failure', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 1, max: 1_000}), {minLength: 4, maxLength: 4}), increments => {
        let total = 0;
        const totals = increments.map(increment => (total += increment));
        const events = traceEvents(totals).filter(event => !hasItemId(event, 'item-memory'));
        const projection = projectCodeMemoryLinkCodexAppServerTraceV1({
          approvalReceipts: actionApprovalReceipts(),
          events,
          expectedClient: CLIENT,
          proxyTool: PROXY,
          qualifyingActionItemId: ACTION_ITEM_ID,
          rubric: hiddenRubric(),
          runBindingHash: RUN_BINDING_HASH,
          staticArtifacts: passingStaticArtifacts(),
          threadStartResponse: threadStart(),
        });

        expect(projection.contextBriefCalls).toEqual([]);
        expect(projection.contextBriefProtocolAdhered).toBe(false);
        expect(projection.constraintAdherence).toEqual({satisfied: 2, total: 2});
        expect(projection.taskPassed).toBe(false);
      }),
      {numRuns: 50},
    );
  });

  it('retains declined actions without requiring an accepted-action approval receipt', () => {
    const rubric = hiddenRubric();
    const events = traceEvents([100, 200, 300, 400]);
    const actionStartIndex = eventIndex(events, 'item/started', ACTION_ITEM_ID);
    events.splice(
      actionStartIndex,
      0,
      itemStarted('item-declined', 'commandExecution'),
      notification('item/completed', {
        item: {id: 'item-declined', status: 'declined', type: 'commandExecution'},
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    );

    const evidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1({
      approvalReceipts: actionApprovalReceipts(),
      events,
      expectedClient: CLIENT,
      proxyTool: PROXY,
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
      runBindingHash: RUN_BINDING_HASH,
      staticArtifacts: passingStaticArtifacts(),
      threadStartResponse: threadStart(),
    });
    expect(evidence.checkpoints).toContainEqual(
      expect.objectContaining({itemType: 'commandExecution', method: 'item/completed', status: 'declined'}),
    );
    expect(parseCodeMemoryLinkCodexAppServerEvidenceV1(evidence)).toEqual(evidence);
  });

  it('rederives from retained evidence and rejects tampering, reordered boundaries, and nonmonotone accounting', () => {
    const rubric = hiddenRubric();
    const evidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1({
      approvalReceipts: actionApprovalReceipts(),
      events: traceEvents([100, 200, 300, 400]),
      expectedClient: CLIENT,
      proxyTool: PROXY,
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
      runBindingHash: RUN_BINDING_HASH,
      staticArtifacts: passingStaticArtifacts(),
      threadStartResponse: threadStart(),
    });
    expect(() => parseCodeMemoryLinkCodexAppServerEvidenceV1({...evidence, effectiveModel: 'tampered'})).toThrow(
      /evidence hash/u,
    );

    const reordered = structuredClone(evidence.checkpoints) as unknown as Array<Record<string, unknown>>;
    const callIndex = reordered.findIndex(
      checkpoint => checkpoint.method === 'item/completed' && checkpoint.itemType === 'mcpToolCall',
    );
    const actionStartIndex = reordered.findIndex(
      checkpoint => checkpoint.method === 'item/started' && checkpoint.itemType === 'commandExecution',
    );
    const [actionStart] = reordered.splice(actionStartIndex, 1);
    reordered.splice(callIndex + 1, 0, actionStart);
    reordered.forEach((checkpoint, index) => {
      checkpoint.ordinal = index + 1;
    });
    expect(() =>
      deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: rehashEvidence(evidence, reordered), rubric}),
    ).toThrow(/immediately followed/u);

    const nonmonotone = structuredClone(evidence.checkpoints) as unknown as Array<Record<string, unknown>>;
    const secondUsage = nonmonotone.filter(checkpoint => checkpoint.method === 'thread/tokenUsage/updated')[1];
    secondUsage.total = {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    expect(() =>
      deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: rehashEvidence(evidence, nonmonotone), rubric}),
    ).toThrow(/nonmonotone/u);
  });

  it('recognizes v2 lexical gold receipts and accepts compact v3 direct relations', () => {
    const rubric = hiddenRubric();
    const lexicalEvents = traceEvents([100, 200, 300, 400]);
    const lexicalBrief = contextBriefResult(lexicalEvents);
    lexicalBrief.version = 2;
    lexicalBrief.durableDecisions = [
      {
        citationReceipts: [{citationId: GOLD_CITATION_ID, reason: 'exact', status: 'exact'}],
        excerpt: 'Memory says the hidden constraint.',
        selectionBasis: 'task',
        uri: 'threadnote://user/test/memories/hidden-constraint.md',
      },
    ];
    sealContextBriefResult(lexicalEvents);
    expect(projectTrace(lexicalEvents, rubric, passingStaticArtifacts()).firstUsefulMemoryUse).toEqual({
      steps: 2,
      tokens: 200,
    });

    const compact = traceEvents([100, 200, 300, 400]);
    expect(contextBriefResult(compact).durableDecisions).toEqual([
      expect.not.objectContaining({citationReceipts: expect.anything()}),
    ]);
    expect(projectTrace(compact, rubric, passingStaticArtifacts()).firstUsefulMemoryUse).toEqual({
      steps: 2,
      tokens: 200,
    });

    const unrelated = traceEvents([100, 200, 300, 400]);
    const unrelatedDirect = contextBriefResult(unrelated).durableDecisions as Array<Record<string, unknown>>;
    unrelatedDirect[0].citationReceipts = [{citationId: `tncc_${'2'.repeat(40)}`, reason: 'exact', status: 'exact'}];
    sealContextBriefResult(unrelated);
    expect(projectTrace(unrelated, rubric, passingStaticArtifacts()).firstUsefulMemoryUse).toEqual({
      steps: 2,
      tokens: 200,
    });

    const inconsistent = traceEvents([100, 200, 300, 400]);
    const direct = contextBriefResult(inconsistent).durableDecisions as Array<Record<string, unknown>>;
    direct[0].citationReceipts = [{citationId: GOLD_CITATION_ID, reason: 'changed', status: 'changed'}];
    expect(() => projectTrace(inconsistent, rubric, passingStaticArtifacts())).toThrow(/inconsistent/u);

    const conflictingRelations = contextBriefStructuredContent();
    const conflictingMemory = (conflictingRelations.durableDecisions as Array<Record<string, unknown>>)[0];
    conflictingMemory.codeRelations = [
      {anchorOrdinal: 0, citationId: GOLD_CITATION_ID, kind: 'file', status: 'exact'},
      {anchorOrdinal: 1, citationId: GOLD_CITATION_ID, kind: 'file', status: 'changed'},
    ];
    expect(() => canonicalizeCodeMemoryLinkContextBriefResultV1(conflictingRelations)).toThrow(/inconsistent/u);
  });

  it('canonicalizes complete v2/v3 and empty results into nonempty client-compatible text', () => {
    for (const version of [2, 3] as const) {
      const structured = contextBriefStructuredContent();
      structured.version = version;
      (structured.output as Record<string, unknown>).projectorVersion = version;
      const memory = (structured.durableDecisions as Array<Record<string, unknown>>)[0];
      memory.excerpt = `Unicode evidence survives: Łódź → 東京 (${version}).`;
      if (version === 2) {
        delete memory.codeRelations;
        delete memory.selectionBasis;
      }
      const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(structured, {requireAgentView: true});
      const expectedText = renderContextBriefText(parseContextBriefV1(canonical.structuredContent));
      expect(canonical.content).toEqual([{text: expectedText, type: 'text'}]);
      expect(parseContextBriefJsonText(expectedText)).toMatchObject({
        briefVersion: version,
        durableDecisions: [expect.objectContaining({excerpt: memory.excerpt})],
        type: 'context-brief-agent-view',
        version: 1,
      });
      expect(
        measureAgentToolResponse({structuredContent: canonical.structuredContent, text: expectedText}).totalBytes,
      ).toBeLessThanOrEqual(1_250 * 3);
    }

    const empty = canonicalizeCodeMemoryLinkContextBriefResultV1(
      CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
    );
    expect(empty.content).toHaveLength(1);
    expect(JSON.parse(empty.content[0].text)).toEqual(empty.structuredContent);
  });

  it('preserves the brief version independently of optional code-anchor coverage', () => {
    fc.assert(
      fc.property(fc.constantFrom(2 as const, 3 as const), fc.boolean(), (version, includeCodeAnchors) => {
        const structured = contextBriefStructuredContent();
        structured.version = version;
        (structured.output as Record<string, unknown>).projectorVersion = version;
        const memory = (structured.durableDecisions as Array<Record<string, unknown>>)[0];
        if (version === 2) {
          delete memory.codeRelations;
          delete memory.selectionBasis;
        }
        const coverage = structured.coverage as Record<string, unknown>;
        const memoryCoverage = coverage.memory as Record<string, unknown>;
        if (includeCodeAnchors) {
          memoryCoverage.codeAnchors = {complete: true, matchedMemories: 1, requested: 1, resolved: 1};
        } else {
          delete memoryCoverage.codeAnchors;
        }

        const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(structured, {requireAgentView: true});
        const projected = JSON.parse(canonical.content[0].text) as Record<string, unknown>;

        expect(parseContextBriefJsonText(canonical.content[0].text).briefVersion).toBe(version);
        expect(Object.hasOwn(projected, 'briefVersion')).toBe(version !== 3 || !includeCodeAnchors);
      }),
      {numRuns: 20},
    );
  });

  it('treats MCP content object-key order as insignificant while preserving exact content', () => {
    fc.assert(
      fc.property(fc.boolean(), textFirst => {
        const events = traceEvents([100, 200, 300, 400]);
        const item = eventItem(events, 'item/completed', 'item-memory');
        const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(contextBriefStructuredContent());
        const block = canonical.content[0];
        item.result = {
          ...contextBriefResultPayload(canonical.structuredContent),
          content: [textFirst ? {text: block.text, type: block.type} : {type: block.type, text: block.text}],
        };

        expect(projectTrace(events, hiddenRubric(), passingStaticArtifacts()).contextBriefCalls).toHaveLength(1);
      }),
      {numRuns: 10},
    );

    const tampered = traceEvents([100, 200, 300, 400]);
    eventItem(tampered, 'item/completed', 'item-memory').result = {
      ...contextBriefResultPayload(),
      content: [{text: 'different model-visible content', type: 'text'}],
    };
    expect(() => projectTrace(tampered, hiddenRubric(), passingStaticArtifacts())).toThrow(
      /model-visible Context Brief content differs/u,
    );
  });

  it('treats unrelated claims as non-interfering and rejects same-citation contradictions across the response', () => {
    const currentStatus = fc.constantFrom('exact' as const, 'relocated' as const);
    const receiptStatus = fc.constantFrom(
      'exact' as const,
      'relocated' as const,
      'changed' as const,
      'deleted' as const,
      'unknown' as const,
    );
    fc.assert(
      fc.property(
        currentStatus,
        fc.array(receiptStatus, {maxLength: 8}),
        fc.array(receiptStatus, {maxLength: 8}),
        fc.array(receiptStatus, {maxLength: 7}),
        fc.array(receiptStatus, {maxLength: 8}),
        (relationStatus, sameCitationStatuses, unrelatedStatuses, relationStatuses, handoffStatuses) => {
          const structured = contextBriefStructuredContent();
          const memory = (structured.durableDecisions as Array<Record<string, unknown>>)[0];
          memory.codeRelations = [
            {anchorOrdinal: 0, citationId: GOLD_CITATION_ID, kind: 'file', status: relationStatus},
            ...relationStatuses.map((status, index) => ({
              anchorOrdinal: index + 1,
              citationId: GOLD_CITATION_ID,
              kind: 'file',
              status,
            })),
          ];
          memory.citationReceipts = [
            ...sameCitationStatuses.map(status => ({citationId: GOLD_CITATION_ID, reason: status, status})),
            ...unrelatedStatuses.map((status, index) => ({
              citationId: `tncc_${(index + 2).toString(16).padStart(40, '0')}`,
              reason: status,
              status,
            })),
          ];
          if (handoffStatuses.length > 0) {
            structured.activeHandoffs = [
              {
                codeRelations: handoffStatuses.map((status, anchorOrdinal) => ({
                  anchorOrdinal,
                  citationId: GOLD_CITATION_ID,
                  kind: 'symbol',
                  status,
                })),
                excerpt: 'A second memory making a claim about the same citation.',
                selectionBasis: 'code-citation',
                uri: 'threadnote://user/test/memories/cross-memory-claim.md',
              },
            ];
          }

          const canonicalize = () => canonicalizeCodeMemoryLinkContextBriefResultV1(structured);
          const sameIdStatuses = [...sameCitationStatuses, ...relationStatuses, ...handoffStatuses];
          if (sameIdStatuses.some(status => status !== relationStatus)) {
            expect(canonicalize).toThrow(/inconsistent/u);
          } else {
            expect(canonicalize().receipt.directCurrentRelationDigests).toEqual([
              codeMemoryLinkGoldCitationDigest(GOLD_CITATION_ID),
            ]);
          }
        },
      ),
      {numRuns: 50},
    );
  });

  it('retains non-gold current citations in negative controls without labeling them useful', () => {
    const rubric = rubricFor(TASK_ID, 'negative-control');
    const text = 'control=pass\n';
    const artifacts = staticArtifacts(text, '{"unused":true}').slice(0, 1);
    const projection = projectTrace(traceEvents([100, 200, 300, 400]), rubric, artifacts, null);
    expect(projection).toMatchObject({firstUsefulMemoryUse: null, taskPassed: true});
    expect(projection.contextBriefCalls[0]).toMatchObject({goldCitationCount: 0, goldCitationMatched: false});
  });

  it.each([
    [
      'intervening item boundary',
      (events: unknown[]) =>
        events.splice(
          eventIndex(events, 'item/completed', 'item-memory') + 1,
          0,
          itemStarted('intervening', 'reasoning'),
        ),
    ],
    [
      'nonmonotone usage',
      (events: unknown[]) => {
        events[usageIndexes(events)[1]] = usageEvent(90);
      },
    ],
    [
      'model reroute',
      (events: unknown[]) => {
        events.splice(
          eventIndex(events, 'turn/started') + 1,
          0,
          notification('model/rerouted', {threadId: THREAD_ID, turnId: TURN_ID}),
        );
      },
    ],
    [
      'late remote-control lifecycle',
      (events: unknown[]) => {
        const remote = events.splice(eventIndex(events, 'remoteControl/status/changed'), 1)[0]!;
        events.splice(eventIndex(events, 'turn/started') + 1, 0, remote);
      },
    ],
    [
      'enabled remote control',
      (events: unknown[]) => {
        const event = events[eventIndex(events, 'remoteControl/status/changed')] as {params: Record<string, unknown>};
        event.params.status = 'connected';
      },
    ],
    [
      'changed MCP request',
      (events: unknown[]) => {
        eventItem(events, 'item/started', 'item-memory').arguments = {...mcpArguments(), task: 'different-task'};
      },
    ],
    [
      'unexpected direct tool',
      (events: unknown[]) => {
        const item = eventItem(events, 'item/completed', 'item-memory');
        item.server = 'threadnote';
      },
    ],
    [
      'duplicate completed id',
      (events: unknown[]) => {
        const item = eventItem(events, 'item/completed', ACTION_ITEM_ID);
        item.id = 'item-memory';
      },
    ],
    [
      'missing later inference',
      (events: unknown[]) => {
        events.splice(eventIndex(events, 'item/completed', ACTION_ITEM_ID) + 1);
        events.push(turnCompleted());
      },
    ],
  ])('fails closed for %s', (_label, mutate) => {
    const rubric = hiddenRubric();
    const events = structuredClone(traceEvents([100, 200, 300, 400]));
    mutate(events);
    expect(() =>
      projectCodeMemoryLinkCodexAppServerTraceV1({
        approvalReceipts: actionApprovalReceipts(),
        events,
        expectedClient: CLIENT,
        proxyTool: PROXY,
        qualifyingActionItemId: ACTION_ITEM_ID,
        rubric,
        runBindingHash: RUN_BINDING_HASH,
        staticArtifacts: passingStaticArtifacts(),
        threadStartResponse: threadStart(),
      }),
    ).toThrow(/Invalid Code Memory Link real-agent protocol/u);
  });

  it('fails closed when the app server changes the reviewed model, provider, or effort', () => {
    const rubric = hiddenRubric();
    for (const response of [
      {...threadStart(), model: 'gpt-5.6-terra'},
      {...threadStart(), modelProvider: 'other'},
      {...threadStart(), reasoningEffort: 'high'},
    ]) {
      expect(() =>
        projectCodeMemoryLinkCodexAppServerTraceV1({
          approvalReceipts: actionApprovalReceipts(),
          events: traceEvents([100, 200, 300, 400]),
          expectedClient: CLIENT,
          proxyTool: PROXY,
          qualifyingActionItemId: ACTION_ITEM_ID,
          rubric,
          runBindingHash: RUN_BINDING_HASH,
          staticArtifacts: passingStaticArtifacts(),
          threadStartResponse: response,
        }),
      ).toThrow(/effective Codex model/u);
    }
  });

  it('canonically binds retained client identity to the reviewed model, provider, effort, and proxy', () => {
    const identity = projectCodeMemoryLinkExpectedCodexClientV1({expectedClient: CLIENT, proxyTool: PROXY});
    expect(identity).toEqual({
      appServerVersion: '0.149.0-alpha.4.1',
      effectiveModel: CLIENT.model,
      modelProviderDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      proxyToolDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      reasoningEffortDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(
      projectCodeMemoryLinkExpectedCodexClientV1({
        expectedClient: Object.fromEntries(Object.entries(CLIENT).reverse()),
        proxyTool: {tool: PROXY.tool, server: PROXY.server},
      }),
    ).toEqual(identity);
    expect(
      assertCodeMemoryLinkExpectedCodexClientProjectionV1({
        expectedClient: CLIENT,
        proxyTool: PROXY,
        retainedIdentity: identity,
      }),
    ).toEqual(identity);
    for (const retainedIdentity of [
      {...identity, effectiveModel: 'tampered-model'},
      {...identity, modelProviderDigest: HASH_A},
      {...identity, reasoningEffortDigest: HASH_A},
      {...identity, proxyToolDigest: HASH_A},
    ]) {
      expect(() =>
        assertCodeMemoryLinkExpectedCodexClientProjectionV1({
          expectedClient: CLIENT,
          proxyTool: PROXY,
          retainedIdentity,
        }),
      ).toThrow(/differs from the reviewed client/u);
    }
  });

  it('does not call a gold retrieval useful when it follows the sealed qualifying action', () => {
    const rubric = hiddenRubric();
    const events = traceEvents([100, 200, 300, 400]);
    const actionStart = events.splice(eventIndex(events, 'item/started', ACTION_ITEM_ID), 1)[0]!;
    const actionCompleted = events.splice(eventIndex(events, 'item/completed', ACTION_ITEM_ID), 1)[0]!;
    events.splice(eventIndex(events, 'item/started', 'item-memory'), 0, actionStart, actionCompleted);
    const projection = projectCodeMemoryLinkCodexAppServerTraceV1({
      approvalReceipts: actionApprovalReceipts(),
      events,
      expectedClient: CLIENT,
      proxyTool: PROXY,
      qualifyingActionItemId: ACTION_ITEM_ID,
      rubric,
      runBindingHash: RUN_BINDING_HASH,
      staticArtifacts: passingStaticArtifacts(),
      threadStartResponse: threadStart(),
    });

    expect(projection.contextBriefCalls[0]).toMatchObject({beforeQualifyingAction: false, goldCitationMatched: true});
    expect(projection.firstUsefulMemoryUse).toBeNull();
  });

  it('hashes canonical field order deterministically and never mutates hash inputs', () => {
    const promptText = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), {
        minLength: 1,
        maxLength: 64,
      })
      .map(characters => characters.join(''))
      .filter(prompt => prompt.trim().length > 0);
    fc.assert(
      fc.property(promptText, prompt => {
        const forward = {
          budget: {steps: 20, tokens: 2_000},
          fixtureHash: HASH_A,
          prompt,
          taskId: TASK_ID,
          taskKind: 'hidden-constraint' as const,
          version: 1 as const,
        };
        const reordered = {
          version: 1 as const,
          taskKind: 'hidden-constraint' as const,
          taskId: TASK_ID,
          prompt,
          fixtureHash: HASH_A,
          budget: {tokens: 2_000, steps: 20},
        };
        const before = structuredClone(forward);
        expect(codeMemoryLinkTaskPacketHashV1(reordered)).toBe(codeMemoryLinkTaskPacketHashV1(forward));
        expect(forward).toEqual(before);
      }),
      {numRuns: 50},
    );
  });

  it('derives monotone token/step accounting and rejects adversarial call ordering as properties', () => {
    const increments = fc.array(fc.integer({min: 1, max: 10_000}), {minLength: 4, maxLength: 4});
    fc.assert(
      fc.property(increments, deltas => {
        const totals = deltas.reduce<number[]>((values, delta) => [...values, (values.at(-1) ?? 0) + delta], []);
        const rubric = hiddenRubric();
        const input = {
          approvalReceipts: actionApprovalReceipts(),
          expectedClient: CLIENT,
          proxyTool: PROXY,
          qualifyingActionItemId: ACTION_ITEM_ID,
          rubric,
          runBindingHash: RUN_BINDING_HASH,
          staticArtifacts: passingStaticArtifacts(),
          threadStartResponse: threadStart(),
        };
        const events = traceEvents(totals);
        const before = structuredClone(events);
        const projection = projectCodeMemoryLinkCodexAppServerTraceV1({
          ...input,
          events,
        });
        const evidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1({...input, events});
        const parsedEvidence = parseCodeMemoryLinkCodexAppServerEvidenceV1(structuredClone(evidence));
        expect(deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: parsedEvidence, rubric})).toEqual(projection);
        expect(projectCodeMemoryLinkCodexAppServerTraceV1({...input, events: structuredClone(events)})).toEqual(
          projection,
        );
        expect(events).toEqual(before);
        expect(projection.firstUsefulMemoryUse).toEqual({steps: 2, tokens: totals[1]});
        expect(projection.totalTaskUsage).toEqual({steps: 4, tokens: totals[3]});

        const adversarial = structuredClone(traceEvents(totals));
        adversarial.splice(
          eventIndex(adversarial, 'item/completed', 'item-memory') + 1,
          0,
          itemStarted(`boundary-${totals[0]}`, 'reasoning'),
          itemCompleted(`boundary-${totals[0]}`, 'reasoning'),
        );
        expect(() => projectCodeMemoryLinkCodexAppServerTraceV1({...input, events: adversarial})).toThrow(
          /immediately followed/u,
        );
      }),
      {numRuns: 50},
    );
  });
});

function fixture(): CodeMemoryLinkFixtureV1 {
  const input = {
    artifacts: [{artifactId: `art_${'1'.repeat(16)}`, sha256: '1'.repeat(64)}],
    version: 1 as const,
  };
  return {...input, fixtureHash: codeMemoryLinkFixtureHashV1(input)};
}

function judge(): CodeMemoryLinkJudgeV1 {
  const input = {
    artifacts: [{artifactId: `art_${'2'.repeat(16)}`, sha256: '2'.repeat(64)}],
    judgeVersion: `ver_${'1'.repeat(16)}`,
    version: 1 as const,
  };
  return {...input, judgeHash: codeMemoryLinkJudgeHashV1(input)};
}

function taskPacket(
  taskId = TASK_ID,
  taskKind: CodeMemoryLinkTaskKind = 'hidden-constraint',
): CodeMemoryLinkTaskPacketV1 {
  const input = {
    budget: {steps: 40, tokens: 20_000},
    fixtureHash: fixture().fixtureHash,
    prompt: taskKind === 'hidden-constraint' ? 'Implement the hidden constraint.' : 'Diagnose the safe no-memory case.',
    taskId,
    taskKind,
    version: 1 as const,
  };
  return {...input, packetHash: codeMemoryLinkTaskPacketHashV1(input)};
}

function rubricFor(taskId: string, taskKind: CodeMemoryLinkTaskKind): CodeMemoryLinkRubricV1 {
  const hidden = taskKind === 'hidden-constraint';
  const input = {
    fixtureHash: fixture().fixtureHash,
    goldCitationDigests: hidden ? [codeMemoryLinkGoldCitationDigest(`${GOLD_CITATION_ID}-${taskId}`)] : [],
    predicates: hidden
      ? [
          {
            assertion: {artifactId: STATIC_TEXT_ARTIFACT_ID, expected: 'required=true', kind: 'utf8-contains' as const},
            expected: true,
            predicateId: PREDICATE_CONSTRAINT,
            roles: ['constraint', 'task-pass'] as const,
          },
          {
            assertion: {
              artifactId: STATIC_TEXT_ARTIFACT_ID,
              expected: 'harmful=true',
              kind: 'utf8-not-contains' as const,
            },
            expected: true,
            predicateId: PREDICATE_HARM,
            roles: ['harmful-acceptance'] as const,
          },
          {
            assertion: {
              artifactId: STATIC_JSON_ARTIFACT_ID,
              expected: {memoryExclusive: true},
              kind: 'json-equals' as const,
            },
            expected: true,
            predicateId: PREDICATE_MEMORY,
            roles: ['constraint', 'memory-exclusive', 'task-pass'] as const,
          },
          {
            assertion: {
              artifactId: STATIC_TEXT_ARTIFACT_ID,
              expected: 'action=qualifying',
              kind: 'utf8-contains' as const,
            },
            expected: true,
            predicateId: PREDICATE_ACTION,
            roles: ['qualifying-action'] as const,
          },
        ]
      : [
          {
            assertion: {artifactId: STATIC_TEXT_ARTIFACT_ID, expected: 'control=pass', kind: 'utf8-contains' as const},
            expected: true,
            predicateId: PREDICATE_CONSTRAINT,
            roles: ['task-pass'] as const,
          },
        ],
    qualifyingActionItemTypes: hidden ? (['commandExecution', 'fileChange'] as const) : [],
    taskId,
    taskKind,
    version: 1 as const,
  };
  return {...input, rubricHash: codeMemoryLinkRubricHashV1(input)};
}

function hiddenRubric(): CodeMemoryLinkRubricV1 {
  const input = rubricFor(TASK_ID, 'hidden-constraint');
  const goldCitationDigests = [codeMemoryLinkGoldCitationDigest(GOLD_CITATION_ID)];
  const withoutHash = {...input, goldCitationDigests, rubricHash: undefined};
  delete withoutHash.rubricHash;
  return {
    ...withoutHash,
    rubricHash: codeMemoryLinkRubricHashV1(withoutHash),
  };
}

function suiteCorpus(): {
  readonly packets: readonly CodeMemoryLinkTaskPacketV1[];
  readonly rubrics: readonly CodeMemoryLinkRubricV1[];
  readonly suite: CodeMemoryLinkSealedSuiteV1;
} {
  const packets = Array.from({length: 28}, (_, index) => {
    const taskId = `tsk_${(index + 1).toString(16).padStart(16, '0')}`;
    return taskPacket(taskId, index < 12 ? 'hidden-constraint' : 'negative-control');
  });
  const rubrics = packets.map(packet => rubricFor(packet.taskId, packet.taskKind));
  const withoutHash = {
    fixture: fixture(),
    judge: judge(),
    suiteId: `sui_${'1'.repeat(16)}`,
    tasks: packets.map((packet, index) => ({
      packetHash: packet.packetHash,
      rubricHash: rubrics[index].rubricHash,
      taskId: packet.taskId,
      taskKind: packet.taskKind,
    })),
    version: 1 as const,
  };
  return {
    packets,
    rubrics,
    suite: {...withoutHash, suiteHash: codeMemoryLinkSealedSuiteHashV1(withoutHash)},
  };
}

function armPacket(
  task: CodeMemoryLinkTaskPacketV1,
  policy: CodeMemoryLinkArmPacketV1['policy'],
  blindLabel: CodeMemoryLinkArmPacketV1['blindLabel'],
): CodeMemoryLinkArmPacketV1 {
  const withoutHash = {
    assignmentHash: '3'.repeat(64),
    blindLabel,
    fixtureHash: task.fixtureHash,
    packetHash: task.packetHash,
    policy,
    rubricHash: '4'.repeat(64),
    runNonce: `run_${'1'.repeat(16)}`,
    taskId: task.taskId,
    taskKind: task.taskKind,
    version: 1 as const,
  };
  return {...withoutHash, armPacketHash: codeMemoryLinkArmPacketHashV1(withoutHash)};
}

function passingStaticArtifacts(): readonly CodeMemoryLinkStaticArtifactInputV1[] {
  return staticArtifacts('required=true\naction=qualifying\n', '{"memoryExclusive":true}');
}

function failingStaticArtifacts(): readonly CodeMemoryLinkStaticArtifactInputV1[] {
  return staticArtifacts('harmful=true\naction=qualifying\n', '{"memoryExclusive":false}');
}

function staticArtifacts(text: string, json: string): readonly CodeMemoryLinkStaticArtifactInputV1[] {
  return [
    {
      artifactId: STATIC_TEXT_ARTIFACT_ID,
      content: text,
      mediaType: 'text/plain',
      sha256: codeMemoryLinkStaticArtifactSha256(text),
    },
    {
      artifactId: STATIC_JSON_ARTIFACT_ID,
      content: json,
      mediaType: 'application/json',
      sha256: codeMemoryLinkStaticArtifactSha256(json),
    },
  ];
}

function threadStart(): Record<string, unknown> {
  return {
    model: CLIENT.model,
    modelProvider: CLIENT.modelProvider,
    reasoningEffort: CLIENT.reasoningEffort,
    thread: {id: THREAD_ID},
  };
}

function traceEvents(totals: readonly number[]): unknown[] {
  if (totals.length !== 4) throw new Error('test trace requires four usage totals');
  return [
    notification('remoteControl/status/changed', {
      environmentId: null,
      installationId: 'private-installation-id',
      serverName: 'private-server-name',
      status: 'disabled',
    }),
    notification('thread/started', {thread: {id: THREAD_ID}}),
    notification('turn/started', {threadId: THREAD_ID, turn: {id: TURN_ID, status: 'inProgress'}}),
    itemStarted('item-reasoning', 'reasoning'),
    itemCompleted('item-reasoning', 'reasoning'),
    usageEvent(totals[0]),
    itemStarted('item-memory', 'mcpToolCall'),
    itemCompleted('item-memory', 'mcpToolCall'),
    usageEvent(totals[1]),
    itemStarted(ACTION_ITEM_ID, 'commandExecution'),
    itemCompleted(ACTION_ITEM_ID, 'commandExecution'),
    usageEvent(totals[2]),
    itemStarted('item-final', 'agentMessage'),
    itemCompleted('item-final', 'agentMessage'),
    usageEvent(totals[3]),
    turnCompleted(),
  ];
}

function hasItemId(event: unknown, id: string): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const params = Reflect.get(event, 'params');
  if (typeof params !== 'object' || params === null) return false;
  const item = Reflect.get(params, 'item');
  return typeof item === 'object' && item !== null && Reflect.get(item, 'id') === id;
}

function itemStarted(id: string, type: string): unknown {
  return notification('item/started', {
    item:
      type === 'mcpToolCall'
        ? {arguments: mcpArguments(), id, server: PROXY.server, tool: PROXY.tool, type}
        : {id, type},
    threadId: THREAD_ID,
    turnId: TURN_ID,
  });
}

function itemCompleted(id: string, type: string): unknown {
  const item =
    type === 'mcpToolCall'
      ? {
          arguments: mcpArguments(),
          error: null,
          id,
          result: contextBriefResultPayload(),
          server: PROXY.server,
          status: 'completed',
          tool: PROXY.tool,
          type,
        }
      : {id, status: 'completed', type};
  return notification('item/completed', {item, threadId: THREAD_ID, turnId: TURN_ID});
}

function mcpArguments(): Record<string, unknown> {
  return {
    callerCwd: '/private/evaluation/repository',
    codeRefs: ['src/private/implementation.ts'],
    task: 'Implement the hidden constraint.',
  };
}

function contextBriefResult(events: readonly unknown[]): Record<string, unknown> {
  const result = eventItem(events, 'item/completed', 'item-memory').result as Record<string, unknown>;
  return result.structuredContent as Record<string, unknown>;
}

function contextBriefStructuredContent(): Record<string, unknown> {
  return {
    activeHandoffs: [],
    coverage: {
      gaps: [],
      graph: {
        complete: true,
        consideredRepositories: 1,
        readyRepositories: 1,
        requestedRepositories: 1,
        states: {current: 1},
      },
      memory: {
        codeAnchors: {complete: true, matchedMemories: 1, requested: 1, resolved: 1},
        consideredCandidates: 1,
        durableCandidates: 1,
        fresh: 1,
        handoffCandidates: 0,
        stale: 0,
        unknown: 0,
      },
      omissions: {
        activeHandoffs: 0,
        coverageGaps: 0,
        durableDecisions: 0,
        graphCards: 0,
        graphContracts: 0,
        recommendedFollowUps: 0,
        stalenessAndConflicts: 0,
      },
    },
    durableDecisions: [
      {
        authority: 'canonical_repo',
        codeRelations: [{anchorOrdinal: 0, citationId: GOLD_CITATION_ID, kind: 'file', status: 'exact'}],
        excerpt: 'Memory says the hidden constraint.',
        freshness: 'fresh',
        freshnessBasis: 'code-citations',
        preciseStatus: 'exact',
        selectionBasis: 'code-citation',
        trust: 'approved',
        uri: 'threadnote://user/test/memories/hidden-constraint.md',
      },
    ],
    graph: {
      cards: [
        {
          id: 'cbgc_test',
          rank: 0,
          reason: 'Indexed symbol match.',
          ref: `cgs_${'2'.repeat(32)}`,
          repositoryKey: 'threadnote',
          symbol: {
            kind: 'function',
            language: 'typescript',
            line: 42,
            name: 'compileContextBrief',
            path: 'apps/threadnote/src/context_brief/index.ts',
            qualifiedName: 'compileContextBrief',
          },
        },
      ],
      continuation: {cursor: `cgwc_${'3'.repeat(32)}`, remainingEstimate: 2, state: 'available'},
      contracts: [],
    },
    mode: 'brief',
    output: {omittedItems: 0, projectorVersion: 3, returnedItems: 2, truncated: false},
    recommendedFollowUps: [
      {id: 'cbfu_test', operation: 'read-memory', rank: 0, uri: 'threadnote://user/test/memories/hidden-constraint.md'},
    ],
    scope: {
      freshness: 'fresh',
      kind: 'repository',
      name: 'current-repository',
      readyRepositories: 1,
      requestedRepositories: 1,
    },
    stalenessAndConflicts: [],
    task: {summary: 'Implement the hidden constraint.', truncated: false},
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      memory: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    },
    type: 'context-brief',
    version: 3,
  };
}

function contextBriefResultPayload(
  structuredContent: unknown = contextBriefStructuredContent(),
): Record<string, unknown> {
  const canonical = canonicalizeCodeMemoryLinkContextBriefResultV1(structuredContent);
  return {
    _meta: {
      codeMemoryLink: {
        armPacketHash: ARM_PACKET_HASH,
        proxyDecisionHash: codeMemoryLinkContextBriefProxyDecisionHashV1({
          action: 'forward',
          request: mcpArguments(),
        }),
        rawRequestHash: codeMemoryLinkContextBriefRawRequestHashV1(mcpArguments()),
        responseHash: codeMemoryLinkContextBriefResponseReceiptHashV1(canonical.receipt),
        runBindingHash: RUN_BINDING_HASH,
        version: 1,
      },
    },
    content: canonical.content,
    structuredContent: canonical.structuredContent,
  };
}

function sealContextBriefResult(events: readonly unknown[]): void {
  const item = eventItem(events, 'item/completed', 'item-memory');
  const current = item.result as {structuredContent: unknown};
  item.result = contextBriefResultPayload(current.structuredContent);
}

function actionApprovalReceipts() {
  return [
    {
      itemIdDigest: codeMemoryLinkAppServerOpaqueIdDigest('item', ACTION_ITEM_ID),
      itemType: 'commandExecution' as const,
      requestDigest: codeMemoryLinkContextBriefRawRequestHashV1({
        command: 'cat src/example.ts',
        itemId: ACTION_ITEM_ID,
      }),
    },
  ];
}

function projectTrace(
  events: readonly unknown[],
  rubric: CodeMemoryLinkRubricV1,
  staticArtifacts: readonly CodeMemoryLinkStaticArtifactInputV1[],
  qualifyingActionItemId: string | null = ACTION_ITEM_ID,
) {
  return projectCodeMemoryLinkCodexAppServerTraceV1({
    approvalReceipts: actionApprovalReceipts(),
    events,
    expectedClient: CLIENT,
    proxyTool: PROXY,
    qualifyingActionItemId,
    rubric,
    runBindingHash: RUN_BINDING_HASH,
    staticArtifacts,
    threadStartResponse: threadStart(),
  });
}

function rehashEvidence(
  evidence: CodeMemoryLinkCodexAppServerEvidenceV1,
  checkpoints: readonly Record<string, unknown>[],
): CodeMemoryLinkCodexAppServerEvidenceV1 {
  const {evidenceHash: _evidenceHash, ...withoutHash} = evidence;
  const candidate = {
    ...withoutHash,
    checkpoints: checkpoints as unknown as CodeMemoryLinkCodexAppServerEvidenceV1['checkpoints'],
  };
  return {...candidate, evidenceHash: codeMemoryLinkCodexAppServerEvidenceHashV1(candidate)};
}

function usageEvent(totalTokens: number): unknown {
  return notification('thread/tokenUsage/updated', {
    threadId: THREAD_ID,
    tokenUsage: {
      last: {
        cachedInputTokens: 0,
        inputTokens: totalTokens,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens,
      },
      total: {
        cachedInputTokens: 0,
        inputTokens: totalTokens,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens,
      },
    },
    turnId: TURN_ID,
  });
}

function turnCompleted(): unknown {
  return notification('turn/completed', {
    threadId: THREAD_ID,
    turn: {id: TURN_ID, items: [], status: 'completed'},
  });
}

function notification(method: string, params: Record<string, unknown>): unknown {
  return {jsonrpc: '2.0', method, params};
}

function eventIndex(events: readonly unknown[], method: string, itemId?: string): number {
  const index = events.findIndex(event => {
    const value = event as {method?: unknown; params?: {item?: {id?: unknown}}};
    return value.method === method && (itemId === undefined || value.params?.item?.id === itemId);
  });
  if (index < 0) throw new Error(`Missing test event ${method}/${itemId ?? ''}.`);
  return index;
}

function eventItem(events: readonly unknown[], method: string, itemId: string): Record<string, unknown> {
  return (events[eventIndex(events, method, itemId)] as {params: {item: Record<string, unknown>}}).params.item;
}

function usageIndexes(events: readonly unknown[]): readonly number[] {
  return events.flatMap((event, index) =>
    (event as {method?: unknown}).method === 'thread/tokenUsage/updated' ? [index] : [],
  );
}
