import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
  parseCodeMemoryLinkExpectedCodexClientV1 as parseExpectedClient,
  parseCodeMemoryLinkProxyToolV1 as parseProxyTool,
  type CodeMemoryLinkExpectedCodexClientV1,
  type CodeMemoryLinkProxyToolV1,
} from './code-memory-link-agent-client-identity.js';
import {
  assertSyntheticArtifactContent,
  assertSyntheticJsonValue,
  assertSyntheticText,
  boolean,
  boundedText,
  boundedUtf8Content,
  canonicalUnique,
  compareStrings,
  exactKeys,
  hashArray,
  invalid,
  literal,
  literalArray,
  matchingHash,
  matchingIdentifier,
  matchingText,
  nonnegativeInteger,
  normalizeJsonValue,
  parseStepTokenBudget,
  positiveInteger,
  protocolDigest,
  protocolVersion,
  record,
  unique,
  uniqueMap,
  validateCodeMemoryLinkThreadSettingsUpdateV1,
  validateResolvedServerRequestV1,
} from './code-memory-link-agent-protocol-primitives.js';
import {
  ALLOWED_ITEM_TYPES,
  IGNORED_MATCHING_TURN_METHOD_VALUES,
  IGNORED_MATCHING_TURN_METHODS,
  type AllowedItemType,
} from './code-memory-link-agent-protocol-items.js';
import * as contextBriefProtocol from './code-memory-link-context-brief-protocol.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

import type {AppServerItemStatus} from './code-memory-link-agent-protocol-contracts.js';
import {
  CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  CODE_MEMORY_LINK_SEALED_HIDDEN_TASKS,
  CODE_MEMORY_LINK_SEALED_NEGATIVE_CONTROL_TASKS,
  CODE_MEMORY_LINK_TASK_KINDS,
  CODE_MEMORY_LINK_ARM_POLICIES,
  CODE_MEMORY_LINK_BLIND_LABELS,
  CODE_MEMORY_LINK_PREDICATE_ROLES,
  CODE_MEMORY_LINK_QUALIFYING_ACTION_ITEM_TYPES,
  CODE_MEMORY_LINK_STATIC_ASSERTION_KINDS,
} from './code-memory-link-agent-protocol-contracts.js';
import type {
  CodeMemoryLinkPredicateRole,
  CodeMemoryLinkArtifactV1,
  CodeMemoryLinkFixtureV1,
  CodeMemoryLinkJudgeV1,
  CodeMemoryLinkTaskPacketV1,
  CodeMemoryLinkPredicateV1,
  CodeMemoryLinkStaticArtifactInputV1,
  CodeMemoryLinkRubricV1,
  CodeMemoryLinkSealedSuiteV1,
  CodeMemoryLinkArmPacketV1,
  CodeMemoryLinkStaticObservationV1,
  CodeMemoryLinkStaticJudgmentV1,
  CodeMemoryLinkProviderUsageV1,
  CodeMemoryLinkCodexAppServerProjectionV1,
  CodeMemoryLinkCodexTraceCheckpointV1,
  CodeMemoryLinkCodexTraceCheckpointWithoutOrdinalV1,
  CodeMemoryLinkCodexAppServerEvidenceV1,
  CodeMemoryLinkCodexAppServerTraceInputV1,
  CodeMemoryLinkAppServerApprovalReceiptV1,
} from './code-memory-link-agent-protocol-contracts.js';
export {
  CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  CODE_MEMORY_LINK_SEALED_HIDDEN_TASKS,
  CODE_MEMORY_LINK_SEALED_NEGATIVE_CONTROL_TASKS,
  CODE_MEMORY_LINK_TASK_KINDS,
  CODE_MEMORY_LINK_ARM_POLICIES,
  CODE_MEMORY_LINK_BLIND_LABELS,
  CODE_MEMORY_LINK_PREDICATE_ROLES,
  CODE_MEMORY_LINK_QUALIFYING_ACTION_ITEM_TYPES,
  CODE_MEMORY_LINK_STATIC_ASSERTION_KINDS,
} from './code-memory-link-agent-protocol-contracts.js';
export type {
  AppServerItemStatus,
  CodeMemoryLinkTaskKind,
  CodeMemoryLinkArmPolicy,
  CodeMemoryLinkBlindLabel,
  CodeMemoryLinkPredicateRole,
  CodeMemoryLinkQualifyingActionItemType,
  CodeMemoryLinkStaticAssertionKind,
  CodeMemoryLinkJsonValue,
  CodeMemoryLinkArtifactV1,
  CodeMemoryLinkFixtureV1,
  CodeMemoryLinkJudgeV1,
  CodeMemoryLinkTaskPacketV1,
  CodeMemoryLinkPredicateV1,
  CodeMemoryLinkStaticArtifactInputV1,
  CodeMemoryLinkRubricV1,
  CodeMemoryLinkSuiteTaskV1,
  CodeMemoryLinkSealedSuiteV1,
  CodeMemoryLinkArmPacketV1,
  CodeMemoryLinkPredicateObservationV1,
  CodeMemoryLinkStaticObservationV1,
  CodeMemoryLinkStaticJudgmentV1,
  CodeMemoryLinkProviderUsageV1,
  CodeMemoryLinkCodexAppServerProjectionV1,
  CodeMemoryLinkCodexTraceCheckpointV1,
  CodeMemoryLinkCodexTraceCheckpointWithoutOrdinalV1,
  CodeMemoryLinkCodexAppServerEvidenceV1,
  CodeMemoryLinkCodexAppServerTraceInputV1,
  CodeMemoryLinkAppServerApprovalReceiptV1,
} from './code-memory-link-agent-protocol-contracts.js';
export {
  CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
  assertCodeMemoryLinkExpectedCodexClientProjectionV1,
  parseCodeMemoryLinkExpectedCodexClientV1,
  parseCodeMemoryLinkProxyToolV1,
  projectCodeMemoryLinkExpectedCodexClientV1,
  type CodeMemoryLinkExpectedCodexClientProjectionV1,
  type CodeMemoryLinkExpectedCodexClientV1,
  type CodeMemoryLinkProxyToolV1,
} from './code-memory-link-agent-client-identity.js';

export * from './code-memory-link-context-brief-protocol.js';

const ARTIFACT_ID = /^art_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const SUITE_ID = /^sui_[0-9a-f]{16,64}$/u;
const PREDICATE_ID = /^prd_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{16,64}$/u;
const VERSION_ID = /^ver_[0-9a-f]{16,64}$/u;
const UTF8 = new TextEncoder();
const MAXIMUM_ARTIFACTS = 256;
const MAXIMUM_EVENTS = 100_000;
const MAXIMUM_PROMPT_BYTES = 16 * 1_024;
const MAXIMUM_EVENT_TEXT_BYTES = 1_024 * 1_024;
const MAXIMUM_STATIC_ARTIFACT_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_STATIC_ARTIFACT_TOTAL_BYTES = 4 * 1_024 * 1_024;

const ALLOWED_NON_TURN_METHODS = new Set([
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated',
  'mcpServer/startupStatus/updated',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'thread/started',
  'thread/settings/updated',
  'thread/status/changed',
]);

const TRACE_METHODS = new Set([
  ...ALLOWED_NON_TURN_METHODS,
  ...IGNORED_MATCHING_TURN_METHODS,
  'item/completed',
  'item/started',
  'model/rerouted',
  'thread/tokenUsage/updated',
  'turn/completed',
  'turn/started',
]);

export function codeMemoryLinkFixtureHashV1(input: {
  readonly artifacts: readonly CodeMemoryLinkArtifactV1[];
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}): string {
  const normalized = normalizeArtifactSet(input, 'fixture');
  return protocolDigest('fixture', normalized);
}

export function parseCodeMemoryLinkFixtureV1(value: unknown): CodeMemoryLinkFixtureV1 {
  const fixture = record(value, 'fixture');
  exactKeys(fixture, ['artifacts', 'fixtureHash', 'version'], 'fixture');
  const normalized = normalizeArtifactSet(fixture, 'fixture');
  const fixtureHash = matchingHash(fixture.fixtureHash, 'fixture');
  if (fixtureHash !== protocolDigest('fixture', normalized)) invalid('fixture hash does not match its artifacts');
  return {...normalized, fixtureHash};
}

export function codeMemoryLinkJudgeHashV1(input: {
  readonly artifacts: readonly CodeMemoryLinkArtifactV1[];
  readonly judgeVersion: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}): string {
  const normalized = normalizeJudge(input);
  return protocolDigest('judge', normalized);
}

export function parseCodeMemoryLinkJudgeV1(value: unknown): CodeMemoryLinkJudgeV1 {
  const judge = record(value, 'judge');
  exactKeys(judge, ['artifacts', 'judgeHash', 'judgeVersion', 'version'], 'judge');
  const normalized = normalizeJudge(judge);
  const judgeHash = matchingHash(judge.judgeHash, 'judge');
  if (judgeHash !== protocolDigest('judge', normalized)) invalid('judge hash does not match its artifacts');
  return {...normalized, judgeHash};
}

export function codeMemoryLinkTaskPacketHashV1(input: Omit<CodeMemoryLinkTaskPacketV1, 'packetHash'>): string {
  return protocolDigest('task-packet', normalizeTaskPacket(input, false));
}

export function parseCodeMemoryLinkTaskPacketV1(value: unknown): CodeMemoryLinkTaskPacketV1 {
  const packet = record(value, 'task packet');
  exactKeys(packet, ['budget', 'fixtureHash', 'packetHash', 'prompt', 'taskId', 'taskKind', 'version'], 'task packet');
  const normalized = normalizeTaskPacket(packet, false);
  const packetHash = matchingHash(packet.packetHash, 'task packet');
  if (packetHash !== protocolDigest('task-packet', normalized)) {
    invalid('task packet hash does not match its canonical contents');
  }
  return {...normalized, packetHash};
}

export function codeMemoryLinkRubricHashV1(input: Omit<CodeMemoryLinkRubricV1, 'rubricHash'>): string {
  return protocolDigest('rubric', normalizeRubric(input, false));
}

export function parseCodeMemoryLinkRubricV1(value: unknown): CodeMemoryLinkRubricV1 {
  const rubric = record(value, 'rubric');
  exactKeys(
    rubric,
    [
      'fixtureHash',
      'goldCitationDigests',
      'predicates',
      'qualifyingActionItemTypes',
      'rubricHash',
      'taskId',
      'taskKind',
      'version',
    ],
    'rubric',
  );
  const normalized = normalizeRubric(rubric, false);
  const rubricHash = matchingHash(rubric.rubricHash, 'rubric');
  if (rubricHash !== protocolDigest('rubric', normalized)) invalid('rubric hash does not match its predicates');
  return {...normalized, rubricHash};
}

export function codeMemoryLinkArmPacketHashV1(input: Omit<CodeMemoryLinkArmPacketV1, 'armPacketHash'>): string {
  return protocolDigest('arm-packet', normalizeArmPacket(input, false));
}

export function parseCodeMemoryLinkArmPacketV1(value: unknown): CodeMemoryLinkArmPacketV1 {
  const packet = record(value, 'arm packet');
  exactKeys(
    packet,
    [
      'armPacketHash',
      'assignmentHash',
      'blindLabel',
      'fixtureHash',
      'packetHash',
      'policy',
      'rubricHash',
      'runNonce',
      'taskId',
      'taskKind',
      'version',
    ],
    'arm packet',
  );
  const normalized = normalizeArmPacket(packet, false);
  const armPacketHash = matchingHash(packet.armPacketHash, 'arm packet');
  if (armPacketHash !== protocolDigest('arm-packet', normalized)) {
    invalid('arm packet hash does not match its sealed run contract');
  }
  return {...normalized, armPacketHash};
}

export function codeMemoryLinkSealedSuiteHashV1(input: Omit<CodeMemoryLinkSealedSuiteV1, 'suiteHash'>): string {
  return protocolDigest('sealed-suite', normalizeSealedSuite(input, false));
}

export function parseCodeMemoryLinkSealedSuiteV1(value: unknown): CodeMemoryLinkSealedSuiteV1 {
  const suite = record(value, 'sealed suite');
  exactKeys(suite, ['fixture', 'judge', 'suiteHash', 'suiteId', 'tasks', 'version'], 'sealed suite');
  const normalized = normalizeSealedSuite(suite, false);
  const suiteHash = matchingHash(suite.suiteHash, 'sealed suite');
  if (suiteHash !== protocolDigest('sealed-suite', normalized)) {
    invalid('sealed suite hash does not match its fixture, judge, and task roster');
  }
  return {...normalized, suiteHash};
}

export function assertCodeMemoryLinkSealedSuiteBindingsV1(input: {
  readonly rubrics: readonly unknown[];
  readonly suite: unknown;
  readonly taskPackets: readonly unknown[];
}): void {
  const suite = parseCodeMemoryLinkSealedSuiteV1(input.suite);
  const packets = EffectArray.map(input.taskPackets, parseCodeMemoryLinkTaskPacketV1);
  const rubrics = EffectArray.map(input.rubrics, parseCodeMemoryLinkRubricV1);
  if (packets.length !== suite.tasks.length || rubrics.length !== suite.tasks.length) {
    invalid('sealed suite requires exactly one packet and rubric for every task');
  }
  const packetByTask = uniqueMap(packets, value => value.taskId, 'task packets');
  const rubricByTask = uniqueMap(rubrics, value => value.taskId, 'rubrics');
  for (const task of suite.tasks) {
    const packet = packetByTask.get(task.taskId);
    const rubric = rubricByTask.get(task.taskId);
    if (!packet || !rubric) invalid(`sealed suite task ${task.taskId} is missing its packet or rubric`);
    if (
      packet.packetHash !== task.packetHash ||
      rubric.rubricHash !== task.rubricHash ||
      packet.taskKind !== task.taskKind ||
      rubric.taskKind !== task.taskKind ||
      packet.fixtureHash !== suite.fixture.fixtureHash ||
      rubric.fixtureHash !== suite.fixture.fixtureHash
    ) {
      invalid(`sealed suite task ${task.taskId} is not bound to its exact packet, rubric, and fixture`);
    }
  }
}

export function codeMemoryLinkStaticObservationHashV1(
  input: Omit<CodeMemoryLinkStaticObservationV1, 'observationHash'>,
): string {
  return protocolDigest('static-observation', normalizeObservation(input, false));
}

export function parseCodeMemoryLinkStaticObservationV1(value: unknown): CodeMemoryLinkStaticObservationV1 {
  const observation = record(value, 'static observation');
  exactKeys(
    observation,
    [
      'artifactHash',
      'fixtureHash',
      'observationHash',
      'predicates',
      'qualifyingActionItemDigest',
      'rubricHash',
      'taskId',
      'version',
    ],
    'static observation',
  );
  const normalized = normalizeObservation(observation, false);
  const observationHash = matchingHash(observation.observationHash, 'static observation');
  if (observationHash !== protocolDigest('static-observation', normalized)) {
    invalid('static observation hash does not match its independently extracted facts');
  }
  return {...normalized, observationHash};
}

export function codeMemoryLinkStaticArtifactSha256(content: string): string {
  if (typeof content !== 'string') invalid('static artifact content must be a string');
  return sha256HexSync(content);
}

/** Evaluate the static rubric from bounded bytes; paths and symlink aliases cannot enter this boundary. */
export function evaluateCodeMemoryLinkStaticArtifactsV1(input: {
  readonly artifacts: readonly unknown[];
  readonly qualifyingActionItemId: string | null;
  readonly rubric: unknown;
}): {
  readonly judgment: CodeMemoryLinkStaticJudgmentV1;
  readonly observation: CodeMemoryLinkStaticObservationV1;
} {
  const rubric = parseCodeMemoryLinkRubricV1(input.rubric);
  const qualifyingActionItemDigest =
    input.qualifyingActionItemId === null
      ? null
      : codeMemoryLinkAppServerOpaqueIdDigest(
          'item',
          boundedText(input.qualifyingActionItemId, 'qualifying action item id', 256),
        );
  return evaluateStaticArtifactsWithDigest(input.artifacts, qualifyingActionItemDigest, rubric);
}

function evaluateStaticArtifactsWithDigest(
  artifactsInput: readonly unknown[],
  qualifyingActionItemDigest: string | null,
  rubric: CodeMemoryLinkRubricV1,
): {
  readonly judgment: CodeMemoryLinkStaticJudgmentV1;
  readonly observation: CodeMemoryLinkStaticObservationV1;
} {
  const artifacts = parseStaticArtifacts(artifactsInput);
  const requiredArtifactIds = [
    ...new Set(EffectArray.map(rubric.predicates, predicate => predicate.assertion.artifactId)),
  ].sort(compareStrings);
  if (
    artifacts.length !== requiredArtifactIds.length ||
    EffectArray.some(artifacts, (artifact, index) => artifact.artifactId !== requiredArtifactIds[index])
  ) {
    invalid('static judge inputs must contain exactly the content-addressed artifacts referenced by the rubric');
  }
  const byId = new Map(EffectArray.map(artifacts, artifact => [artifact.artifactId, artifact]));
  const predicates = EffectArray.map(rubric.predicates, predicate => ({
    predicateId: predicate.predicateId,
    value: evaluateStaticAssertion(predicate.assertion, byId.get(predicate.assertion.artifactId)!),
  }));
  const artifactHash = protocolDigest(
    'static-artifact-set',
    EffectArray.map(artifacts, ({artifactId, mediaType, sha256}) => ({
      artifactId,
      mediaType,
      sha256,
    })),
  );
  const withoutHash = {
    artifactHash,
    fixtureHash: rubric.fixtureHash,
    predicates,
    qualifyingActionItemDigest,
    rubricHash: rubric.rubricHash,
    taskId: rubric.taskId,
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  };
  const observation = {
    ...withoutHash,
    observationHash: codeMemoryLinkStaticObservationHashV1(withoutHash),
  } satisfies CodeMemoryLinkStaticObservationV1;
  return {
    judgment: judgeCodeMemoryLinkTaskV1({observation, rubric}),
    observation,
  };
}

/** Deterministic adjudication over sealed boolean predicates; no model output is accepted as a judgment. */
export function judgeCodeMemoryLinkTaskV1(input: {
  readonly observation: unknown;
  readonly rubric: unknown;
}): CodeMemoryLinkStaticJudgmentV1 {
  const rubric = parseCodeMemoryLinkRubricV1(input.rubric);
  const observation = parseCodeMemoryLinkStaticObservationV1(input.observation);
  if (
    observation.fixtureHash !== rubric.fixtureHash ||
    observation.rubricHash !== rubric.rubricHash ||
    observation.taskId !== rubric.taskId
  ) {
    invalid('static observation does not match the exact rubric, task, and fixture');
  }
  if (observation.predicates.length !== rubric.predicates.length) {
    invalid('static observation must report every rubric predicate exactly once');
  }
  const observed = uniqueMap(observation.predicates, value => value.predicateId, 'predicate observations');
  const matches = new Map<string, boolean>();
  for (const predicate of rubric.predicates) {
    const fact = observed.get(predicate.predicateId);
    if (!fact) invalid(`static observation is missing predicate ${predicate.predicateId}`);
    matches.set(predicate.predicateId, fact.value === predicate.expected);
  }
  const predicatesWithRole = (role: CodeMemoryLinkPredicateRole): readonly CodeMemoryLinkPredicateV1[] =>
    EffectArrayPipe(rubric.predicates, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (predicate, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues && predicate.roles.includes(role),
      ),
    );
  const allMatch = (role: CodeMemoryLinkPredicateRole): boolean =>
    EffectArray.every(predicatesWithRole(role), predicate => matches.get(predicate.predicateId) === true);
  const constraints = predicatesWithRole('constraint');
  const harmful = predicatesWithRole('harmful-acceptance');
  const memoryExclusive = predicatesWithRole('memory-exclusive');
  const qualifyingActionPredicates = predicatesWithRole('qualifying-action');
  const qualifyingActionQualified =
    qualifyingActionPredicates.length > 0 &&
    EffectArray.every(qualifyingActionPredicates, predicate => matches.get(predicate.predicateId) === true);
  const acceptedStaleOrHarmful = EffectArray.some(harmful, predicate => matches.get(predicate.predicateId) !== true);
  const taskPassed = allMatch('task-pass') && !acceptedStaleOrHarmful;
  const qualifyingActionItemDigest = observation.qualifyingActionItemDigest;
  if (qualifyingActionQualified && qualifyingActionItemDigest === null) {
    invalid('a qualifying static action requires its app-server item id');
  }
  const projection = {
    acceptedStaleOrHarmful,
    artifactHash: observation.artifactHash,
    constraintAdherence: {
      satisfied: EffectArray.filter(constraints, predicate => matches.get(predicate.predicateId) === true).length,
      total: constraints.length,
    },
    memoryExclusiveSatisfied: memoryExclusive.length === 1 && matches.get(memoryExclusive[0].predicateId) === true,
    observationHash: observation.observationHash,
    qualifyingActionItemDigest,
    qualifyingActionQualified,
    rubricHash: rubric.rubricHash,
    taskId: rubric.taskId,
    taskPassed,
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  };
  return {
    ...projection,
    adjudicationHash: protocolDigest('static-adjudication', projection),
  };
}

/** Apply the sealed arm while preserving one agent-visible schema: forward refs, strip refs, or return empty. */
export function projectCodeMemoryLinkContextBriefRequestV1(input: {
  readonly armPacket: unknown;
  readonly request: unknown;
  readonly taskPacket: unknown;
}): contextBriefProtocol.CodeMemoryLinkContextBriefProxyDecisionV1 {
  const arm = parseCodeMemoryLinkArmPacketV1(input.armPacket);
  const task = parseCodeMemoryLinkTaskPacketV1(input.taskPacket);
  if (
    arm.taskId !== task.taskId ||
    arm.taskKind !== task.taskKind ||
    arm.packetHash !== task.packetHash ||
    arm.fixtureHash !== task.fixtureHash
  ) {
    invalid('arm packet does not match the exact task packet');
  }
  return contextBriefProtocol.projectParsedCodeMemoryLinkContextBriefRequestV1({
    policy: arm.policy,
    prompt: task.prompt,
    request: input.request,
  });
}

/** Normalize raw app-server notifications to sealed, privacy-safe evidence suitable for retention. */
export function normalizeCodeMemoryLinkCodexAppServerEvidenceV1(
  input: CodeMemoryLinkCodexAppServerTraceInputV1,
): CodeMemoryLinkCodexAppServerEvidenceV1 {
  const expectedClient = parseExpectedClient(input.expectedClient);
  const proxyTool = parseProxyTool(input.proxyTool);
  const rubric = parseCodeMemoryLinkRubricV1(input.rubric);
  const session = parseThreadStartResponse(input.threadStartResponse, expectedClient);
  if (!EffectArray.isArray(input.events) || input.events.length === 0 || input.events.length > MAXIMUM_EVENTS) {
    invalid(`app-server trace must contain 1-${MAXIMUM_EVENTS} notifications`);
  }
  const notifications = EffectArray.map(input.events, (event, index) => parseTraceNotification(event, index));
  const state = collectTraceState(notifications, session.threadId, proxyTool);
  const staticArtifacts = parseStaticArtifacts(input.staticArtifacts);
  const qualifyingActionItemDigest =
    input.qualifyingActionItemId === null
      ? null
      : codeMemoryLinkAppServerOpaqueIdDigest(
          'item',
          boundedText(input.qualifyingActionItemId, 'qualifying action item id', 256),
        );
  const {observation} = evaluateStaticArtifactsWithDigest(staticArtifacts, qualifyingActionItemDigest, rubric);
  const approvalReceipts = parseApprovalReceipts(input.approvalReceipts);
  const runBindingHash = matchingHash(input.runBindingHash, 'run binding');
  const threadIdDigest = codeMemoryLinkAppServerOpaqueIdDigest('thread', session.threadId);
  const turnIdDigest = codeMemoryLinkAppServerOpaqueIdDigest('turn', state.turnId);
  const withoutHash = {
    approvalReceipts,
    appServerVersion: CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
    checkpoints: buildTraceCheckpoints(notifications, state, proxyTool),
    effectiveModel: session.effectiveModel,
    eventCount: notifications.length,
    modelProviderDigest: protocolDigest('model-provider', session.modelProvider),
    preTurn: summarizePreTurn(notifications),
    proxyToolDigest: protocolDigest('proxy-tool', proxyTool),
    qualifyingActionItemDigest,
    reasoningEffortDigest: protocolDigest('reasoning-effort', session.reasoningEffort),
    rubricHash: rubric.rubricHash,
    runBindingHash,
    staticArtifactSetHash: observation.artifactHash,
    staticArtifacts,
    staticObservationHash: observation.observationHash,
    threadIdDigest,
    turnIdDigest,
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  } satisfies Omit<CodeMemoryLinkCodexAppServerEvidenceV1, 'evidenceHash'>;
  const normalized = normalizeCodexEvidence(withoutHash, false);
  const evidence = {
    ...normalized,
    evidenceHash: protocolDigest('codex-app-server-evidence', normalized),
  };
  deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence, rubric});
  return evidence;
}

export function codeMemoryLinkCodexAppServerEvidenceHashV1(
  input: Omit<CodeMemoryLinkCodexAppServerEvidenceV1, 'evidenceHash'>,
): string {
  return protocolDigest('codex-app-server-evidence', normalizeCodexEvidence(input, false));
}

export function parseCodeMemoryLinkCodexAppServerEvidenceV1(value: unknown): CodeMemoryLinkCodexAppServerEvidenceV1 {
  const evidence = record(value, 'Codex app-server evidence');
  const normalized = normalizeCodexEvidence(evidence, true);
  const evidenceHash = matchingHash(evidence.evidenceHash, 'Codex app-server evidence');
  if (evidenceHash !== protocolDigest('codex-app-server-evidence', normalized)) {
    invalid('Codex app-server evidence hash does not match its normalized trace');
  }
  return {...normalized, evidenceHash};
}

/** Recompute cost and deterministic judgment from retained evidence, without raw events or caller booleans. */
export function deriveCodeMemoryLinkCodexAppServerProjectionV1(input: {
  readonly evidence: unknown;
  readonly rubric: unknown;
}): CodeMemoryLinkCodexAppServerProjectionV1 {
  return deriveProjectionFromEvidence(
    parseCodeMemoryLinkCodexAppServerEvidenceV1(input.evidence),
    parseCodeMemoryLinkRubricV1(input.rubric),
  );
}

/** Convenience composition for callers that do not persist the normalized evidence separately. */
export function projectCodeMemoryLinkCodexAppServerTraceV1(
  input: CodeMemoryLinkCodexAppServerTraceInputV1,
): CodeMemoryLinkCodexAppServerProjectionV1 {
  const evidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1(input);
  return deriveCodeMemoryLinkCodexAppServerProjectionV1({
    evidence,
    rubric: input.rubric,
  });
}

export function codeMemoryLinkAppServerOpaqueIdDigest(kind: 'item' | 'thread' | 'turn', id: string): string {
  return protocolDigest(`app-server-${kind}-id`, boundedText(id, `${kind} id`, 256));
}

function normalizeArtifactSet(value: unknown, label: string): Omit<CodeMemoryLinkFixtureV1, 'fixtureHash'> {
  const artifactSet = record(value, label);
  const version = protocolVersion(artifactSet.version, label);
  const artifacts = parseArtifacts(artifactSet.artifacts, label);
  return {artifacts, version};
}

function normalizeJudge(value: unknown): Omit<CodeMemoryLinkJudgeV1, 'judgeHash'> {
  const judge = record(value, 'judge');
  return {
    artifacts: parseArtifacts(judge.artifacts, 'judge'),
    judgeVersion: matchingText(judge.judgeVersion, VERSION_ID, 'judge version'),
    version: protocolVersion(judge.version, 'judge'),
  };
}

function parseArtifacts(value: unknown, label: string): readonly CodeMemoryLinkArtifactV1[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > MAXIMUM_ARTIFACTS) {
    invalid(`${label} artifacts must contain 1-${MAXIMUM_ARTIFACTS} entries`);
  }
  const artifacts = EffectArray.map(value, (entry, index) => {
    const artifact = record(entry, `${label} artifact ${index + 1}`);
    exactKeys(artifact, ['artifactId', 'sha256'], `${label} artifact ${index + 1}`);
    return {
      artifactId: matchingText(artifact.artifactId, ARTIFACT_ID, `${label} artifact id`),
      sha256: matchingHash(artifact.sha256, `${label} artifact`),
    };
  });
  canonicalUnique(
    EffectArray.map(artifacts, artifact => artifact.artifactId),
    `${label} artifact ids`,
  );
  unique(
    EffectArray.map(artifacts, artifact => artifact.sha256),
    `${label} artifact hashes`,
  );
  return artifacts;
}

function normalizeTaskPacket(value: unknown, hasHash: boolean): Omit<CodeMemoryLinkTaskPacketV1, 'packetHash'> {
  const packet = record(value, 'task packet');
  if (hasHash) matchingHash(packet.packetHash, 'task packet');
  return {
    budget: parseStepTokenBudget(packet.budget),
    fixtureHash: matchingHash(packet.fixtureHash, 'task packet fixture'),
    prompt: boundedText(packet.prompt, 'task prompt', MAXIMUM_PROMPT_BYTES, false),
    taskId: matchingText(packet.taskId, TASK_ID, 'task id'),
    taskKind: literal(packet.taskKind, CODE_MEMORY_LINK_TASK_KINDS, 'task kind'),
    version: protocolVersion(packet.version, 'task packet'),
  };
}

function normalizeRubric(value: unknown, hasHash: boolean): Omit<CodeMemoryLinkRubricV1, 'rubricHash'> {
  const rubric = record(value, 'rubric');
  if (hasHash) matchingHash(rubric.rubricHash, 'rubric');
  const taskKind = literal(rubric.taskKind, CODE_MEMORY_LINK_TASK_KINDS, 'rubric task kind');
  const predicates = parsePredicates(rubric.predicates);
  const goldCitationDigests = hashArray(rubric.goldCitationDigests, 'gold citation digests', 64);
  const qualifyingActionItemTypes = literalArray(
    rubric.qualifyingActionItemTypes,
    CODE_MEMORY_LINK_QUALIFYING_ACTION_ITEM_TYPES,
    'qualifying action item types',
  );
  const roleCount = (role: CodeMemoryLinkPredicateRole): number =>
    EffectArray.filter(
      predicates,
      (predicate, __effectArrayIndex) => __effectArrayIndex in predicates && predicate.roles.includes(role),
    ).length;
  if (roleCount('task-pass') === 0) invalid('rubric requires a task-pass predicate');
  if (taskKind === 'hidden-constraint') {
    if (roleCount('constraint') === 0) invalid('hidden rubric requires at least one constraint predicate');
    if (roleCount('memory-exclusive') !== 1) {
      invalid('hidden rubric requires exactly one final memory-exclusive predicate');
    }
    if (roleCount('qualifying-action') === 0 || qualifyingActionItemTypes.length === 0) {
      invalid('hidden rubric requires a static qualifying action contract');
    }
    if (goldCitationDigests.length === 0) invalid('hidden rubric requires at least one gold citation digest');
  } else if (roleCount('memory-exclusive') !== 0 || goldCitationDigests.length !== 0) {
    invalid('negative-control rubric cannot declare memory-exclusive predicates or gold citations');
  }
  return {
    fixtureHash: matchingHash(rubric.fixtureHash, 'rubric fixture'),
    goldCitationDigests,
    predicates,
    qualifyingActionItemTypes,
    taskId: matchingText(rubric.taskId, TASK_ID, 'rubric task id'),
    taskKind,
    version: protocolVersion(rubric.version, 'rubric'),
  };
}

function parsePredicates(value: unknown): readonly CodeMemoryLinkPredicateV1[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > 128) {
    invalid('rubric predicates must contain 1-128 entries');
  }
  const predicates = EffectArray.map(value, (entry, index) => {
    const predicate = record(entry, `rubric predicate ${index + 1}`);
    exactKeys(predicate, ['assertion', 'expected', 'predicateId', 'roles'], `rubric predicate ${index + 1}`);
    return {
      assertion: parseStaticAssertion(predicate.assertion, `rubric predicate ${index + 1}`),
      expected: boolean(predicate.expected, 'predicate expectation'),
      predicateId: matchingText(predicate.predicateId, PREDICATE_ID, 'predicate id'),
      roles: literalArray(predicate.roles, CODE_MEMORY_LINK_PREDICATE_ROLES, 'predicate roles'),
    };
  });
  if (EffectArray.some(predicates, predicate => predicate.roles.length === 0))
    invalid('every predicate requires at least one role');
  canonicalUnique(
    EffectArray.map(predicates, predicate => predicate.predicateId),
    'rubric predicate ids',
  );
  return predicates;
}

function parseStaticAssertion(value: unknown, label: string): CodeMemoryLinkPredicateV1['assertion'] {
  const assertion = record(value, `${label} assertion`);
  exactKeys(assertion, ['artifactId', 'expected', 'kind'], `${label} assertion`);
  const artifactId = matchingText(assertion.artifactId, ARTIFACT_ID, `${label} assertion artifact id`);
  const kind = literal(assertion.kind, CODE_MEMORY_LINK_STATIC_ASSERTION_KINDS, `${label} assertion kind`);
  if (kind === 'json-equals') {
    const expected = normalizeJsonValue(assertion.expected, `${label} JSON expectation`);
    assertSyntheticJsonValue(expected, `${label} JSON expectation`);
    return {artifactId, expected, kind};
  }
  const expected = boundedText(assertion.expected, `${label} text expectation`, 64 * 1_024, false);
  assertSyntheticText(expected, `${label} text expectation`);
  return {artifactId, expected, kind};
}

function normalizeArmPacket(value: unknown, hasHash: boolean): Omit<CodeMemoryLinkArmPacketV1, 'armPacketHash'> {
  const packet = record(value, 'arm packet');
  if (hasHash) matchingHash(packet.armPacketHash, 'arm packet');
  return {
    assignmentHash: matchingHash(packet.assignmentHash, 'arm packet assignment'),
    blindLabel: literal(packet.blindLabel, CODE_MEMORY_LINK_BLIND_LABELS, 'blind label'),
    fixtureHash: matchingHash(packet.fixtureHash, 'arm packet fixture'),
    packetHash: matchingHash(packet.packetHash, 'arm packet task'),
    policy: literal(packet.policy, CODE_MEMORY_LINK_ARM_POLICIES, 'arm policy'),
    rubricHash: matchingHash(packet.rubricHash, 'arm packet rubric'),
    runNonce: matchingText(packet.runNonce, RUN_NONCE, 'run nonce'),
    taskId: matchingText(packet.taskId, TASK_ID, 'arm packet task id'),
    taskKind: literal(packet.taskKind, CODE_MEMORY_LINK_TASK_KINDS, 'arm packet task kind'),
    version: protocolVersion(packet.version, 'arm packet'),
  };
}

function normalizeSealedSuite(value: unknown, hasHash: boolean): Omit<CodeMemoryLinkSealedSuiteV1, 'suiteHash'> {
  const suite = record(value, 'sealed suite');
  if (hasHash) matchingHash(suite.suiteHash, 'sealed suite');
  if (!EffectArray.isArray(suite.tasks)) invalid('sealed suite tasks must be an array');
  const tasks = EffectArray.map(suite.tasks, (entry, index) => {
    const task = record(entry, `sealed suite task ${index + 1}`);
    exactKeys(task, ['packetHash', 'rubricHash', 'taskId', 'taskKind'], `sealed suite task ${index + 1}`);
    return {
      packetHash: matchingHash(task.packetHash, 'suite task packet'),
      rubricHash: matchingHash(task.rubricHash, 'suite task rubric'),
      taskId: matchingText(task.taskId, TASK_ID, 'suite task id'),
      taskKind: literal(task.taskKind, CODE_MEMORY_LINK_TASK_KINDS, 'suite task kind'),
    };
  });
  const hidden = EffectArray.filter(tasks, task => task.taskKind === 'hidden-constraint').length;
  const controls = EffectArray.filter(tasks, task => task.taskKind === 'negative-control').length;
  if (hidden !== CODE_MEMORY_LINK_SEALED_HIDDEN_TASKS || controls !== CODE_MEMORY_LINK_SEALED_NEGATIVE_CONTROL_TASKS) {
    invalid(
      `sealed suite requires exactly ${CODE_MEMORY_LINK_SEALED_HIDDEN_TASKS} hidden tasks and ${CODE_MEMORY_LINK_SEALED_NEGATIVE_CONTROL_TASKS} negative controls`,
    );
  }
  canonicalUnique(
    EffectArray.map(tasks, task => task.taskId),
    'sealed suite task ids',
  );
  unique(
    EffectArray.map(tasks, task => task.packetHash),
    'sealed suite packet hashes',
  );
  unique(
    EffectArray.map(tasks, task => task.rubricHash),
    'sealed suite rubric hashes',
  );
  return {
    fixture: parseCodeMemoryLinkFixtureV1(suite.fixture),
    judge: parseCodeMemoryLinkJudgeV1(suite.judge),
    suiteId: matchingText(suite.suiteId, SUITE_ID, 'suite id'),
    tasks,
    version: protocolVersion(suite.version, 'sealed suite'),
  };
}

function normalizeObservation(
  value: unknown,
  hasHash: boolean,
): Omit<CodeMemoryLinkStaticObservationV1, 'observationHash'> {
  const observation = record(value, 'static observation');
  if (hasHash) matchingHash(observation.observationHash, 'static observation');
  if (!EffectArray.isArray(observation.predicates) || observation.predicates.length === 0) {
    invalid('static observation predicates must be a non-empty array');
  }
  const predicates = EffectArray.map(observation.predicates, (entry, index) => {
    const predicate = record(entry, `predicate observation ${index + 1}`);
    exactKeys(predicate, ['predicateId', 'value'], `predicate observation ${index + 1}`);
    return {
      predicateId: matchingText(predicate.predicateId, PREDICATE_ID, 'observed predicate id'),
      value: boolean(predicate.value, 'observed predicate value'),
    };
  });
  canonicalUnique(
    EffectArray.map(predicates, predicate => predicate.predicateId),
    'predicate observation ids',
  );
  const qualifyingActionItemDigest =
    observation.qualifyingActionItemDigest === null
      ? null
      : matchingHash(observation.qualifyingActionItemDigest, 'qualifying action item');
  return {
    artifactHash: matchingHash(observation.artifactHash, 'observation artifact'),
    fixtureHash: matchingHash(observation.fixtureHash, 'observation fixture'),
    predicates,
    qualifyingActionItemDigest,
    rubricHash: matchingHash(observation.rubricHash, 'observation rubric'),
    taskId: matchingText(observation.taskId, TASK_ID, 'observation task id'),
    version: protocolVersion(observation.version, 'static observation'),
  };
}

function normalizeCodexEvidence(
  value: unknown,
  hasHash: boolean,
): Omit<CodeMemoryLinkCodexAppServerEvidenceV1, 'evidenceHash'> {
  const evidence = record(value, 'Codex app-server evidence');
  const keys = [
    'approvalReceipts',
    'appServerVersion',
    'checkpoints',
    'effectiveModel',
    'eventCount',
    ...(hasHash ? ['evidenceHash'] : []),
    'modelProviderDigest',
    'preTurn',
    'proxyToolDigest',
    'qualifyingActionItemDigest',
    'reasoningEffortDigest',
    'rubricHash',
    'runBindingHash',
    'staticArtifactSetHash',
    'staticArtifacts',
    'staticObservationHash',
    'threadIdDigest',
    'turnIdDigest',
    'version',
  ];
  exactKeys(evidence, keys, 'Codex app-server evidence');
  const preTurn = record(evidence.preTurn, 'Codex app-server pre-turn evidence');
  exactKeys(
    preTurn,
    ['proxyStartupNotifications', 'remoteControlDisabled', 'threadStarted'],
    'Codex app-server pre-turn evidence',
  );
  if (preTurn.remoteControlDisabled !== true || preTurn.threadStarted !== true) {
    invalid('retained evidence requires disabled remote control and one matching thread start');
  }
  const proxyStartupNotifications = nonnegativeInteger(
    preTurn.proxyStartupNotifications,
    'proxy startup notification count',
  );
  const checkpoints = parseEvidenceCheckpoints(evidence.checkpoints);
  const approvalReceipts = parseApprovalReceipts(evidence.approvalReceipts);
  const runBindingHash = matchingHash(evidence.runBindingHash, 'run binding');
  const completedCalls = EffectArray.filter(
    checkpoints,
    checkpoint => checkpoint.method === 'item/completed' && checkpoint.itemType === 'mcpToolCall',
  );
  for (const call of completedCalls) {
    if (call.succeeded && call.proxyReceipt?.runBindingHash !== runBindingHash) {
      invalid('Context Brief proxy receipt does not match the retained run binding');
    }
  }
  const publicActions = EffectArray.flatMap(checkpoints, checkpoint =>
    checkpoint.method === 'item/completed' &&
    checkpoint.status !== 'declined' &&
    (checkpoint.itemType === 'commandExecution' || checkpoint.itemType === 'fileChange')
      ? [
          {
            itemIdDigest: checkpoint.itemIdDigest,
            itemType: checkpoint.itemType,
          },
        ]
      : [],
  );
  if (
    publicActions.length !== approvalReceipts.length ||
    EffectArray.some(
      approvalReceipts,
      receipt =>
        !EffectArray.some(
          publicActions,
          action => action.itemIdDigest === receipt.itemIdDigest && action.itemType === receipt.itemType,
        ),
    )
  ) {
    invalid('retained action checkpoints and pre-execution approval receipts differ');
  }
  const eventCount = positiveInteger(evidence.eventCount, 'app-server event count');
  if (eventCount > MAXIMUM_EVENTS || eventCount < checkpoints.length + proxyStartupNotifications + 2) {
    invalid('app-server event count is inconsistent with retained checkpoints and pre-turn evidence');
  }
  if (!EffectArray.isArray(evidence.staticArtifacts)) invalid('static artifacts must be an array');
  const staticArtifacts = parseStaticArtifacts(evidence.staticArtifacts);
  const staticArtifactSetHash = matchingHash(evidence.staticArtifactSetHash, 'static artifact set');
  const recomputedArtifactSetHash = protocolDigest(
    'static-artifact-set',
    EffectArray.map(staticArtifacts, ({artifactId, mediaType, sha256}) => ({
      artifactId,
      mediaType,
      sha256,
    })),
  );
  if (staticArtifactSetHash !== recomputedArtifactSetHash) {
    invalid('retained static artifact set hash does not match its content-addressed artifacts');
  }
  if (evidence.appServerVersion !== CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION) {
    invalid(`Codex app-server evidence version must be ${CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION}`);
  }
  return {
    approvalReceipts,
    appServerVersion: CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
    checkpoints,
    effectiveModel: boundedText(evidence.effectiveModel, 'effective model', 128),
    eventCount,
    modelProviderDigest: matchingHash(evidence.modelProviderDigest, 'model provider'),
    preTurn: {
      proxyStartupNotifications,
      remoteControlDisabled: true,
      threadStarted: true,
    },
    proxyToolDigest: matchingHash(evidence.proxyToolDigest, 'proxy tool'),
    qualifyingActionItemDigest:
      evidence.qualifyingActionItemDigest === null
        ? null
        : matchingHash(evidence.qualifyingActionItemDigest, 'qualifying action item'),
    reasoningEffortDigest: matchingHash(evidence.reasoningEffortDigest, 'reasoning effort'),
    rubricHash: matchingHash(evidence.rubricHash, 'evidence rubric'),
    runBindingHash,
    staticArtifactSetHash,
    staticArtifacts,
    staticObservationHash: matchingHash(evidence.staticObservationHash, 'static observation'),
    threadIdDigest: matchingHash(evidence.threadIdDigest, 'thread id'),
    turnIdDigest: matchingHash(evidence.turnIdDigest, 'turn id'),
    version: protocolVersion(evidence.version, 'Codex app-server evidence'),
  };
}

function parseApprovalReceipts(value: unknown): readonly CodeMemoryLinkAppServerApprovalReceiptV1[] {
  if (!EffectArray.isArray(value) || value.length > 512) {
    invalid('app-server approval receipts must be a bounded array');
  }
  const receipts = EffectArray.map(value, (entry, index) => {
    const receipt = record(entry, `approval receipt ${index + 1}`);
    exactKeys(receipt, ['itemIdDigest', 'itemType', 'requestDigest'], `approval receipt ${index + 1}`);
    return {
      itemIdDigest: matchingHash(receipt.itemIdDigest, `approval receipt ${index + 1} item id`),
      itemType: literal(
        receipt.itemType,
        ['commandExecution', 'fileChange'] as const,
        `approval receipt ${index + 1} item type`,
      ),
      requestDigest: matchingHash(receipt.requestDigest, `approval receipt ${index + 1} request`),
    };
  });
  unique(
    EffectArray.map(receipts, receipt => receipt.itemIdDigest),
    'approval receipt item ids',
  );
  return receipts;
}

function parseEvidenceCheckpoints(value: unknown): readonly CodeMemoryLinkCodexTraceCheckpointV1[] {
  if (!EffectArray.isArray(value) || value.length < 2 || value.length > MAXIMUM_EVENTS) {
    invalid('retained trace checkpoints must be a bounded non-empty array');
  }
  return EffectArray.map(value, (entry, index): CodeMemoryLinkCodexTraceCheckpointV1 => {
    const checkpoint = record(entry, `trace checkpoint ${index + 1}`);
    if (checkpoint.ordinal !== index + 1) invalid('trace checkpoint ordinals must be contiguous and ordered');
    const method = boundedText(checkpoint.method, `trace checkpoint ${index + 1} method`, 128);
    if (method === 'turn/started') {
      exactKeys(checkpoint, ['method', 'ordinal'], `trace checkpoint ${index + 1}`);
      return {method, ordinal: index + 1};
    }
    if (method === 'turn/completed') {
      exactKeys(checkpoint, ['method', 'ordinal', 'status'], `trace checkpoint ${index + 1}`);
      if (checkpoint.status !== 'completed') invalid('retained turn must complete successfully');
      return {method, ordinal: index + 1, status: 'completed'};
    }
    if (method === 'thread/tokenUsage/updated') {
      exactKeys(checkpoint, ['method', 'ordinal', 'total'], `trace checkpoint ${index + 1}`);
      return {
        method,
        ordinal: index + 1,
        total: parseUsage({total: checkpoint.total}),
      };
    }
    if (method === 'item/started' || method === 'item/completed') {
      const itemType = literal(checkpoint.itemType, ALLOWED_ITEM_TYPES, `trace checkpoint ${index + 1} item type`);
      const itemIdDigest = matchingHash(checkpoint.itemIdDigest, `trace checkpoint ${index + 1} item id`);
      const status = parseItemStatus(checkpoint.status);
      if (itemType === 'mcpToolCall') {
        const fields =
          method === 'item/started'
            ? ['itemIdDigest', 'itemType', 'method', 'ordinal', 'requestDigest', 'status']
            : [
                'itemIdDigest',
                'itemType',
                'method',
                'ordinal',
                'proxyReceipt',
                'requestDigest',
                'response',
                'status',
                'succeeded',
              ];
        exactKeys(checkpoint, fields, `trace checkpoint ${index + 1}`);
        const requestDigest = matchingHash(checkpoint.requestDigest, 'Context Brief request');
        if (method === 'item/started') {
          return {
            itemIdDigest,
            itemType,
            method: 'item/started',
            ordinal: index + 1,
            requestDigest,
            status,
          };
        }
        const terminalStatus = literal(checkpoint.status, ['completed', 'failed'] as const, 'MCP terminal status');
        const succeeded = boolean(checkpoint.succeeded, 'MCP success');
        if (succeeded && terminalStatus !== 'completed') invalid('successful MCP evidence must have completed status');
        const response =
          checkpoint.response === null
            ? null
            : contextBriefProtocol.parseCodeMemoryLinkContextBriefResponseReceiptV1(checkpoint.response);
        if ((response !== null) !== succeeded) invalid('MCP response receipt must exist exactly for successful calls');
        const proxyReceipt =
          checkpoint.proxyReceipt === null
            ? null
            : contextBriefProtocol.parseCodeMemoryLinkContextBriefProxyReceiptV1(checkpoint.proxyReceipt);
        if ((proxyReceipt !== null) !== succeeded) {
          invalid('MCP proxy receipt must exist exactly for successful calls');
        }
        if (
          response !== null &&
          proxyReceipt !== null &&
          proxyReceipt.responseHash !== contextBriefProtocol.codeMemoryLinkContextBriefResponseReceiptHashV1(response)
        ) {
          invalid('retained MCP proxy receipt does not bind the retained response');
        }
        return {
          itemIdDigest,
          itemType,
          method: 'item/completed',
          ordinal: index + 1,
          proxyReceipt,
          requestDigest,
          response,
          status: terminalStatus,
          succeeded,
        };
      }
      exactKeys(
        checkpoint,
        ['itemIdDigest', 'itemType', 'method', 'ordinal', 'status'],
        `trace checkpoint ${index + 1}`,
      );
      return method === 'item/started'
        ? {
            itemIdDigest,
            itemType,
            method: 'item/started',
            ordinal: index + 1,
            status,
          }
        : {
            itemIdDigest,
            itemType,
            method: 'item/completed',
            ordinal: index + 1,
            status,
          };
    }
    if (IGNORED_MATCHING_TURN_METHODS.has(method)) {
      exactKeys(checkpoint, ['method', 'ordinal'], `trace checkpoint ${index + 1}`);
      return {
        method: literal(method, IGNORED_MATCHING_TURN_METHOD_VALUES, 'ignored trace method'),
        ordinal: index + 1,
      };
    }
    invalid(`retained trace contains unexpected checkpoint method ${method}`);
  });
}

interface ParsedNotification {
  readonly eventIndex: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface ParsedCompletedItem {
  readonly eventIndex: number;
  readonly id: string;
  readonly status: AppServerItemStatus | null;
  readonly type: AllowedItemType;
}

interface ParsedContextBriefCall extends ParsedCompletedItem {
  readonly citationDigests: readonly string[];
  readonly requestDigest: string;
  readonly proxyReceipt: contextBriefProtocol.CodeMemoryLinkContextBriefProxyReceiptV1 | null;
  readonly response: contextBriefProtocol.CodeMemoryLinkContextBriefResponseReceiptV1 | null;
  readonly succeeded: boolean;
  readonly type: 'mcpToolCall';
}

interface ParsedUsage {
  readonly eventIndex: number;
  readonly step: number;
  readonly total: CodeMemoryLinkProviderUsageV1;
}

function parseThreadStartResponse(
  value: unknown,
  expected: CodeMemoryLinkExpectedCodexClientV1,
): {
  readonly effectiveModel: string;
  readonly modelProvider: string;
  readonly reasoningEffort: string;
  readonly threadId: string;
} {
  const response = record(value, 'Codex thread/start response');
  const effectiveModel = boundedText(response.model, 'effective model', 128);
  const modelProvider = boundedText(response.modelProvider, 'effective model provider', 128);
  const reasoningEffort = boundedText(response.reasoningEffort, 'effective reasoning effort', 64);
  const thread = record(response.thread, 'Codex thread/start response thread');
  const threadId = boundedText(thread.id, 'thread id', 256);
  if (
    effectiveModel !== expected.model ||
    modelProvider !== expected.modelProvider ||
    reasoningEffort !== expected.reasoningEffort
  ) {
    invalid('effective Codex model, provider, or reasoning effort differs from the reviewed client descriptor');
  }
  return {effectiveModel, modelProvider, reasoningEffort, threadId};
}

function parseTraceNotification(value: unknown, eventIndex: number): ParsedNotification {
  const notification = record(value, `app-server notification ${eventIndex + 1}`);
  exactKeys(
    notification,
    ['emittedAtMs', 'jsonrpc', 'method', 'params'],
    `app-server notification ${eventIndex + 1}`,
    true,
  );
  if (notification.emittedAtMs !== undefined) nonnegativeInteger(notification.emittedAtMs, 'notification timestamp');
  if (notification.jsonrpc !== undefined && notification.jsonrpc !== '2.0') {
    invalid(`app-server notification ${eventIndex + 1} has an unsupported JSON-RPC version`);
  }
  const method = boundedText(notification.method, `app-server notification ${eventIndex + 1} method`, 128);
  if (!TRACE_METHODS.has(method)) invalid(`app-server notification ${eventIndex + 1} uses unexpected method ${method}`);
  return {
    eventIndex,
    method,
    params: record(notification.params, `app-server notification ${eventIndex + 1} params`),
  };
}
function collectTraceState(
  notifications: readonly ParsedNotification[],
  threadId: string,
  proxyTool: CodeMemoryLinkProxyToolV1,
): {
  readonly calls: readonly ParsedContextBriefCall[];
  readonly completedItems: readonly ParsedCompletedItem[];
  readonly turnId: string;
  readonly usage: readonly ParsedUsage[];
} {
  const starts = EffectArray.filter(notifications, event => event.method === 'turn/started');
  if (starts.length !== 1) invalid('app-server trace requires exactly one turn/started notification');
  const started = starts[0];
  matchingIdentifier(started.params.threadId, threadId, 'turn/started thread id');
  const startedTurn = record(started.params.turn, 'turn/started turn');
  const turnId = boundedText(startedTurn.id, 'turn id', 256);
  if (startedTurn.status !== 'inProgress') invalid('turn/started must identify an in-progress turn');

  const completedItems: ParsedCompletedItem[] = [];
  const calls: ParsedContextBriefCall[] = [];
  const startedItemIds: string[] = [];
  const startedMcpRequestDigests = new Map<string, string>();
  const completedItemIds: string[] = [];
  const usage: ParsedUsage[] = [];
  let turnActive = false;
  let completedTurn = false;
  let previousUsage: CodeMemoryLinkProviderUsageV1 | undefined;

  for (const notification of notifications) {
    if (notification.method === 'model/rerouted') invalid('model/rerouted is forbidden in release evidence');
    if (notification.method === 'turn/started') {
      turnActive = true;
      continue;
    }
    if (ALLOWED_NON_TURN_METHODS.has(notification.method)) {
      if (
        ['mcpServer/startupStatus/updated', 'remoteControl/status/changed', 'thread/started'].includes(
          notification.method,
        ) &&
        (turnActive || completedTurn)
      ) {
        invalid(`${notification.method} must precede the selected turn`);
      }
      validateNonTurnNotification(notification, threadId, proxyTool);
      continue;
    }
    if (!turnActive) invalid('matching-turn evidence appeared before turn/started');
    validateMatchingTurn(notification, threadId, turnId);
    if (completedTurn) invalid('app-server trace contains a matching-turn notification after turn completion');
    if (notification.method === 'item/started') {
      const item = parseItemIdentity(notification.params.item, 'item/started');
      startedItemIds.push(item.id);
      validateAllowedItem(item, proxyTool);
      if (item.type === 'mcpToolCall') {
        startedMcpRequestDigests.set(item.id, contextBriefRequestDigest(item.item.arguments));
      }
      continue;
    }
    if (notification.method === 'item/completed') {
      const item = parseCompletedItem(notification, proxyTool);
      completedItems.push(item);
      completedItemIds.push(item.id);
      if ('citationDigests' in item) calls.push(item);
      continue;
    }
    if (notification.method === 'thread/tokenUsage/updated') {
      const current = parseUsage(notification.params.tokenUsage);
      if (previousUsage && !strictlyMonotoneUsage(previousUsage, current)) {
        invalid('provider token usage must be componentwise monotone with strictly increasing total tokens');
      }
      previousUsage = current;
      usage.push({
        eventIndex: notification.eventIndex,
        step: usage.length + 1,
        total: current,
      });
      continue;
    }
    if (notification.method === 'turn/completed') {
      const turn = record(notification.params.turn, 'turn/completed turn');
      matchingIdentifier(turn.id, turnId, 'turn/completed turn id');
      if (turn.status !== 'completed') invalid('release trace requires a successfully completed turn');
      completedTurn = true;
      turnActive = false;
      continue;
    }
    if (!IGNORED_MATCHING_TURN_METHODS.has(notification.method)) {
      invalid(`unexpected app-server trace method ${notification.method}`);
    }
  }
  if (!completedTurn) invalid('app-server trace is missing turn/completed');
  unique(startedItemIds, 'started app-server item ids');
  unique(completedItemIds, 'completed app-server item ids');
  for (const id of completedItemIds) {
    if (!startedItemIds.includes(id)) invalid('every completed app-server item must have one matching item/started');
  }
  for (const call of calls) {
    if (startedMcpRequestDigests.get(call.id) !== call.requestDigest) {
      invalid('Context Brief MCP request changed between item start and completion');
    }
  }
  return {calls, completedItems, turnId, usage};
}

function summarizePreTurn(
  notifications: readonly ParsedNotification[],
): CodeMemoryLinkCodexAppServerEvidenceV1['preTurn'] {
  const remote = EffectArray.filter(
    notifications,
    notification => notification.method === 'remoteControl/status/changed',
  );
  const thread = EffectArray.filter(notifications, notification => notification.method === 'thread/started');
  const turn = EffectOption.getOrUndefined(
    EffectArray.findFirst(notifications, notification => notification.method === 'turn/started'),
  );
  if (remote.length !== 1 || thread.length !== 1 || !turn) {
    invalid('trace requires exactly one disabled remote-control status and one thread start before the selected turn');
  }
  if (!(remote[0].eventIndex < thread[0].eventIndex && thread[0].eventIndex < turn.eventIndex)) {
    invalid('pre-turn evidence must order disabled remote control before thread start and selected turn');
  }
  return {
    proxyStartupNotifications: EffectArray.filter(
      notifications,
      notification => notification.method === 'mcpServer/startupStatus/updated',
    ).length,
    remoteControlDisabled: true,
    threadStarted: true,
  };
}

function buildTraceCheckpoints(
  notifications: readonly ParsedNotification[],
  state: ReturnType<typeof collectTraceState>,
  proxyTool: CodeMemoryLinkProxyToolV1,
): readonly CodeMemoryLinkCodexTraceCheckpointV1[] {
  const completedByEvent = new Map(EffectArray.map(state.completedItems, item => [item.eventIndex, item]));
  const callByEvent = new Map(EffectArray.map(state.calls, call => [call.eventIndex, call]));
  const usageByEvent = new Map(EffectArray.map(state.usage, entry => [entry.eventIndex, entry]));
  const checkpoints: CodeMemoryLinkCodexTraceCheckpointV1[] = [];
  const append = (checkpoint: CodeMemoryLinkCodexTraceCheckpointWithoutOrdinalV1): void => {
    checkpoints.push({...checkpoint, ordinal: checkpoints.length + 1});
  };
  for (const notification of notifications) {
    if (ALLOWED_NON_TURN_METHODS.has(notification.method) || notification.method === 'model/rerouted') continue;
    if (notification.method === 'turn/started') {
      append({method: 'turn/started'});
      continue;
    }
    if (notification.method === 'turn/completed') {
      append({method: 'turn/completed', status: 'completed'});
      continue;
    }
    if (notification.method === 'thread/tokenUsage/updated') {
      const entry = usageByEvent.get(notification.eventIndex);
      if (!entry) invalid('normalized provider usage checkpoint is missing');
      append({method: 'thread/tokenUsage/updated', total: entry.total});
      continue;
    }
    if (notification.method === 'item/started') {
      const identity = parseItemIdentity(notification.params.item, 'item/started');
      validateAllowedItem(identity, proxyTool);
      const shared = {
        itemIdDigest: codeMemoryLinkAppServerOpaqueIdDigest('item', identity.id),
        method: 'item/started' as const,
        status: parseItemStatus(identity.item.status),
      };
      append(
        identity.type === 'mcpToolCall'
          ? {
              ...shared,
              itemType: identity.type,
              requestDigest: contextBriefRequestDigest(identity.item.arguments),
            }
          : {...shared, itemType: identity.type},
      );
      continue;
    }
    if (notification.method === 'item/completed') {
      const item = completedByEvent.get(notification.eventIndex);
      if (!item) invalid('normalized completed item checkpoint is missing');
      const call = callByEvent.get(notification.eventIndex);
      const shared = {
        itemIdDigest: codeMemoryLinkAppServerOpaqueIdDigest('item', item.id),
        method: 'item/completed' as const,
        status: item.status,
      };
      if (call) {
        append({
          ...shared,
          itemType: 'mcpToolCall',
          proxyReceipt: call.proxyReceipt,
          requestDigest: call.requestDigest,
          response: call.response,
          status: literal(call.status, ['completed', 'failed'] as const, 'MCP terminal status'),
          succeeded: call.succeeded,
        });
      } else {
        if (item.type === 'mcpToolCall') invalid('normalized MCP tool call checkpoint is missing');
        append({...shared, itemType: item.type});
      }
      continue;
    }
    if (IGNORED_MATCHING_TURN_METHODS.has(notification.method)) {
      append({
        method: literal(notification.method, IGNORED_MATCHING_TURN_METHOD_VALUES, 'ignored selected-turn method'),
      });
      continue;
    }
    invalid(`cannot retain unsupported selected-turn method ${notification.method}`);
  }
  return checkpoints;
}

function deriveProjectionFromEvidence(
  evidence: CodeMemoryLinkCodexAppServerEvidenceV1,
  rubric: CodeMemoryLinkRubricV1,
): CodeMemoryLinkCodexAppServerProjectionV1 {
  if (evidence.rubricHash !== rubric.rubricHash) invalid('retained evidence does not match the sealed rubric');
  const {judgment, observation} = evaluateStaticArtifactsWithDigest(
    evidence.staticArtifacts,
    evidence.qualifyingActionItemDigest,
    rubric,
  );
  if (
    observation.observationHash !== evidence.staticObservationHash ||
    observation.artifactHash !== evidence.staticArtifactSetHash
  ) {
    invalid('retained static observation cannot be reproduced from the sealed judge artifacts');
  }
  const started = new Map<
    string,
    {
      readonly ordinal: number;
      readonly requestDigest?: string;
      readonly type: AllowedItemType;
    }
  >();
  const completedIds = new Set<string>();
  const completed: Array<{
    readonly digest: string;
    readonly startOrdinal: number;
    readonly status: AppServerItemStatus | null;
    readonly type: AllowedItemType;
  }> = [];
  const calls: Array<{
    readonly checkpoint: Extract<
      CodeMemoryLinkCodexTraceCheckpointV1,
      {readonly itemType: 'mcpToolCall'; readonly method: 'item/completed'}
    >;
    readonly boundaryIndex: number;
  }> = [];
  const boundaries: Array<{
    readonly kind: 'completed' | 'started' | 'turn-completed' | 'usage';
    readonly ordinal: number;
  }> = [];
  const usage: Array<{
    readonly ordinal: number;
    readonly step: number;
    readonly total: CodeMemoryLinkProviderUsageV1;
  }> = [];
  let turnActive = false;
  let turnCompleted = false;
  for (const checkpoint of evidence.checkpoints) {
    if (checkpoint.method === 'turn/started') {
      if (turnActive || turnCompleted || checkpoint.ordinal !== 1)
        invalid('retained trace has a duplicate or reordered turn start');
      turnActive = true;
      continue;
    }
    if (!turnActive || turnCompleted) invalid('retained selected-turn checkpoint is outside the active turn');
    if (checkpoint.method === 'turn/completed') {
      if (checkpoint.ordinal !== evidence.checkpoints.length)
        invalid('retained turn completion must be the final checkpoint');
      turnActive = false;
      turnCompleted = true;
      boundaries.push({kind: 'turn-completed', ordinal: checkpoint.ordinal});
      continue;
    }
    if (checkpoint.method === 'item/started') {
      if (started.has(checkpoint.itemIdDigest)) invalid('retained trace contains a duplicate item start');
      started.set(checkpoint.itemIdDigest, {
        ...('requestDigest' in checkpoint ? {requestDigest: checkpoint.requestDigest} : {}),
        ordinal: checkpoint.ordinal,
        type: checkpoint.itemType,
      });
      boundaries.push({kind: 'started', ordinal: checkpoint.ordinal});
      continue;
    }
    if (checkpoint.method === 'item/completed') {
      const start = started.get(checkpoint.itemIdDigest);
      if (!start || start.type !== checkpoint.itemType || completedIds.has(checkpoint.itemIdDigest)) {
        invalid('retained completed item lacks exactly one matching start and type');
      }
      if (
        checkpoint.itemType === 'mcpToolCall' &&
        ('requestDigest' in start ? start.requestDigest : undefined) !== checkpoint.requestDigest
      ) {
        invalid('retained Context Brief request digest changed between start and completion');
      }
      completedIds.add(checkpoint.itemIdDigest);
      completed.push({
        digest: checkpoint.itemIdDigest,
        startOrdinal: start.ordinal,
        status: checkpoint.status,
        type: checkpoint.itemType,
      });
      boundaries.push({kind: 'completed', ordinal: checkpoint.ordinal});
      if (checkpoint.itemType === 'mcpToolCall') {
        calls.push({checkpoint, boundaryIndex: boundaries.length - 1});
      }
      continue;
    }
    if (checkpoint.method === 'thread/tokenUsage/updated') {
      const previous = usage.at(-1);
      if (previous && !strictlyMonotoneUsage(previous.total, checkpoint.total)) {
        invalid('retained provider usage is nonmonotone');
      }
      usage.push({
        ordinal: checkpoint.ordinal,
        step: usage.length + 1,
        total: checkpoint.total,
      });
      boundaries.push({kind: 'usage', ordinal: checkpoint.ordinal});
    }
  }
  if (!turnCompleted || started.size !== completedIds.size) {
    invalid('retained trace has an incomplete turn or unterminated item');
  }
  const lastUsage = usage.at(-1);
  if (!lastUsage) invalid('retained completed trace has no provider token usage');
  const action = qualifyingActionFromEvidence(completed, judgment, rubric);
  const callProjections = EffectArray.map(calls, ({boundaryIndex, checkpoint}) => {
    const next = boundaries[boundaryIndex + 1];
    if (!next || next.kind !== 'usage') {
      invalid('every completed Context Brief call must be immediately followed by provider usage');
    }
    const associated = EffectOption.getOrUndefined(
      EffectArray.findFirst(usage, entry => entry.ordinal === next.ordinal),
    );
    if (!associated) invalid('retained Context Brief usage association is missing');
    const response = checkpoint.response;
    const usefulDigests =
      response?.responseClass === 'anchored-v3'
        ? response.directCurrentRelationDigests
        : (response?.citationDigests ?? []);
    const matchingGold = EffectArray.filter(
      usefulDigests,
      (digest, __effectArrayIndex) =>
        __effectArrayIndex in usefulDigests && rubric.goldCitationDigests.includes(digest),
    );
    return {
      associatedStep: associated.step,
      associatedTokens: associated.total.totalTokens,
      beforeQualifyingAction: action !== null && checkpoint.ordinal < action.startOrdinal,
      callIdDigest: checkpoint.itemIdDigest,
      goldCitationCount: matchingGold.length,
      goldCitationMatched: matchingGold.length > 0,
      modelVisibleContentHash: response?.modelVisibleContentHash ?? null,
      responseClass: response?.responseClass ?? null,
      structuredContentHash: response?.structuredContentHash ?? null,
      succeeded: checkpoint.succeeded,
    } satisfies contextBriefProtocol.CodeMemoryLinkCodexContextBriefCallProjectionV1;
  });
  const useful = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      callProjections,
      call =>
        call.succeeded &&
        call.goldCitationMatched &&
        call.beforeQualifyingAction &&
        judgment.memoryExclusiveSatisfied &&
        judgment.qualifyingActionQualified,
    ),
  );
  if (useful && !EffectArray.some(usage, entry => entry.step > useful.associatedStep)) {
    invalid('a useful Context Brief call must be followed by a later provider inference');
  }
  const contextBriefProtocolAdhered = callProjections.length === 1 && callProjections[0].succeeded;
  const itemCounts = {
    agentMessage: 0,
    commandExecution: 0,
    fileChange: 0,
    mcpToolCall: 0,
    plan: 0,
    reasoning: 0,
    userMessage: 0,
  } satisfies Record<AllowedItemType, number>;
  for (const item of completed) itemCounts[item.type] += 1;
  const providerUsageHash = protocolDigest('provider-usage', {
    threadIdDigest: evidence.threadIdDigest,
    timeline: EffectArray.map(usage, entry => ({
      step: entry.step,
      total: entry.total,
    })),
    turnIdDigest: evidence.turnIdDigest,
  });
  const withoutHash = {
    acceptedStaleOrHarmful: judgment.acceptedStaleOrHarmful,
    adjudicationHash: judgment.adjudicationHash,
    appServerVersion: evidence.appServerVersion,
    contextBriefCalls: callProjections,
    contextBriefProtocolAdhered,
    constraintAdherence: judgment.constraintAdherence,
    effectiveModel: evidence.effectiveModel,
    evidenceHash: evidence.evidenceHash,
    eventCount: evidence.eventCount,
    firstUsefulMemoryUse: useful ? {steps: useful.associatedStep, tokens: useful.associatedTokens} : null,
    itemCounts,
    modelProviderDigest: evidence.modelProviderDigest,
    providerUsage: lastUsage.total,
    providerUsageHash,
    proxyToolDigest: evidence.proxyToolDigest,
    reasoningEffortDigest: evidence.reasoningEffortDigest,
    taskPassed: judgment.taskPassed && contextBriefProtocolAdhered,
    threadIdDigest: evidence.threadIdDigest,
    totalTaskUsage: {
      steps: lastUsage.step,
      tokens: lastUsage.total.totalTokens,
    },
    turnIdDigest: evidence.turnIdDigest,
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  } satisfies Omit<CodeMemoryLinkCodexAppServerProjectionV1, 'projectionHash'>;
  return {
    ...withoutHash,
    projectionHash: protocolDigest('codex-app-server-projection', withoutHash),
  };
}
function qualifyingActionFromEvidence(
  completed: readonly {
    readonly digest: string;
    readonly startOrdinal: number;
    readonly status: AppServerItemStatus | null;
    readonly type: AllowedItemType;
  }[],
  judgment: CodeMemoryLinkStaticJudgmentV1,
  rubric: CodeMemoryLinkRubricV1,
): (typeof completed)[number] | null {
  if (judgment.qualifyingActionItemDigest === null) return null;
  const matching = EffectArray.filter(completed, item => item.digest === judgment.qualifyingActionItemDigest);
  if (matching.length !== 1) invalid('static qualifying action does not identify exactly one retained completed item');
  const action = matching[0];
  if (!(rubric.qualifyingActionItemTypes as readonly string[]).includes(action.type) || action.status !== 'completed') {
    invalid('static qualifying action is not a successfully completed item of the sealed type');
  }
  return action;
}

function validateMatchingTurn(notification: ParsedNotification, threadId: string, turnId: string): void {
  matchingIdentifier(notification.params.threadId, threadId, `${notification.method} thread id`);
  const observedTurnId =
    notification.method === 'turn/completed'
      ? record(notification.params.turn, 'turn/completed turn').id
      : notification.params.turnId;
  matchingIdentifier(observedTurnId, turnId, `${notification.method} turn id`);
}

function validateNonTurnNotification(
  notification: ParsedNotification,
  threadId: string,
  proxyTool: CodeMemoryLinkProxyToolV1,
): void {
  if (notification.method === 'thread/started') {
    const thread = record(notification.params.thread, 'thread/started thread');
    matchingIdentifier(thread.id, threadId, 'thread/started thread id');
    return;
  }
  if (notification.method === 'remoteControl/status/changed') {
    exactKeys(
      notification.params,
      ['environmentId', 'installationId', 'serverName', 'status'],
      'remote control status',
    );
    if (notification.params.environmentId !== null) invalid('remote control environment must remain disabled');
    boundedText(notification.params.installationId, 'remote control installation id', 256);
    boundedText(notification.params.serverName, 'remote control server name', 256);
    if (notification.params.status !== 'disabled') invalid('remote control must remain disabled');
    return;
  }
  if (notification.method === 'thread/status/changed') {
    matchingIdentifier(notification.params.threadId, threadId, 'thread/status/changed thread id');
    record(notification.params.status, 'thread/status/changed status');
    return;
  }
  if (notification.method === 'thread/settings/updated') {
    validateCodeMemoryLinkThreadSettingsUpdateV1(notification.params, threadId);
    return;
  }
  if (notification.method === 'mcpServer/startupStatus/updated') {
    const observedName = boundedText(notification.params.name, 'MCP startup server name', 128);
    if (observedName !== proxyTool.server) invalid('an unexpected MCP server appeared in the app-server trace');
    if (!['ready', 'starting'].includes(String(notification.params.status))) {
      invalid('the Context Brief proxy failed or was cancelled during startup');
    }
    if (notification.params.threadId != null)
      matchingIdentifier(notification.params.threadId, threadId, 'MCP startup thread id');
    return;
  }
  if (notification.method === 'serverRequest/resolved') {
    validateResolvedServerRequestV1(notification.params, threadId);
    return;
  }
  if (notification.method === 'account/rateLimits/updated') {
    record(notification.params.rateLimits, 'account rate limit update');
    return;
  }
  if (notification.method === 'app/list/updated') {
    if (!EffectArray.isArray(notification.params.data) || notification.params.data.length !== 0) {
      invalid('apps must remain disabled in the release trace');
    }
    return;
  }
  if (notification.method === 'account/updated') {
    if (
      notification.params.authMode !== undefined &&
      notification.params.authMode !== null &&
      typeof notification.params.authMode !== 'string'
    ) {
      invalid('account update auth mode is malformed');
    }
  }
}

function parseItemIdentity(
  value: unknown,
  label: string,
): {
  readonly id: string;
  readonly item: Record<string, unknown>;
  readonly type: string;
} {
  const item = record(value, `${label} item`);
  return {
    id: boundedText(item.id, `${label} item id`, 256),
    item,
    type: boundedText(item.type, `${label} item type`, 64),
  };
}

function validateAllowedItem(
  identity: ReturnType<typeof parseItemIdentity>,
  proxyTool: CodeMemoryLinkProxyToolV1,
): asserts identity is ReturnType<typeof parseItemIdentity> & {
  readonly type: AllowedItemType;
} {
  if (!(ALLOWED_ITEM_TYPES as readonly string[]).includes(identity.type)) {
    invalid(`unexpected app-server item type ${identity.type}`);
  }
  if (identity.type !== 'mcpToolCall') return;
  const server = boundedText(identity.item.server, 'MCP server', 128);
  const tool = boundedText(identity.item.tool, 'MCP tool', 128);
  if (server !== proxyTool.server || tool !== proxyTool.tool) {
    invalid('unexpected MCP tool call; direct Threadnote and unreviewed tools are forbidden');
  }
}

function parseCompletedItem(
  notification: ParsedNotification,
  proxyTool: CodeMemoryLinkProxyToolV1,
): ParsedCompletedItem | ParsedContextBriefCall {
  const identity = parseItemIdentity(notification.params.item, 'item/completed');
  validateAllowedItem(identity, proxyTool);
  if (identity.type !== 'mcpToolCall') {
    return {
      eventIndex: notification.eventIndex,
      id: identity.id,
      status: parseItemStatus(identity.item.status),
      type: identity.type,
    };
  }
  const parsed = parseContextBriefCallResult(identity.item);
  return {
    eventIndex: notification.eventIndex,
    citationDigests: parsed.citationDigests,
    id: identity.id,
    requestDigest: contextBriefRequestDigest(identity.item.arguments),
    proxyReceipt: parsed.proxyReceipt,
    response: parsed.response,
    status: literal(identity.item.status, ['completed', 'failed'] as const, 'MCP terminal status'),
    succeeded: parsed.succeeded,
    type: 'mcpToolCall',
  };
}

function parseContextBriefCallResult(item: Record<string, unknown>): {
  readonly citationDigests: readonly string[];
  readonly proxyReceipt: contextBriefProtocol.CodeMemoryLinkContextBriefProxyReceiptV1 | null;
  readonly response: contextBriefProtocol.CodeMemoryLinkContextBriefResponseReceiptV1 | null;
  readonly succeeded: boolean;
} {
  if (!['completed', 'failed'].includes(String(item.status))) invalid('MCP tool call has an invalid terminal status');
  const succeeded =
    item.status === 'completed' && item.result !== null && item.result !== undefined && item.error == null;
  if (!succeeded)
    return {
      citationDigests: [],
      proxyReceipt: null,
      response: null,
      succeeded: false,
    };
  const result = record(item.result, 'successful Context Brief result');
  if (!EffectArray.isArray(result.content)) invalid('successful Context Brief result requires MCP content');
  const canonical = contextBriefProtocol.canonicalizeCodeMemoryLinkContextBriefResultV1(result.structuredContent);
  const normalizedContent = normalizeJsonValue(result.content, 'model-visible Context Brief content');
  if (JSON.stringify(normalizedContent) !== JSON.stringify(canonical.content)) {
    invalid('model-visible Context Brief content differs from its structured content');
  }
  const metadata = record(result._meta, 'successful Context Brief result metadata');
  exactKeys(metadata, ['codeMemoryLink'], 'successful Context Brief result metadata');
  const proxyReceipt = contextBriefProtocol.parseCodeMemoryLinkContextBriefProxyReceiptV1(metadata.codeMemoryLink);
  if (
    proxyReceipt.responseHash !==
    contextBriefProtocol.codeMemoryLinkContextBriefResponseReceiptHashV1(canonical.receipt)
  ) {
    invalid('Context Brief proxy response receipt differs from the model-visible response');
  }
  return {
    citationDigests: canonical.receipt.citationDigests,
    proxyReceipt,
    response: canonical.receipt,
    succeeded: true,
  };
}
function contextBriefRequestDigest(value: unknown): string {
  const normalized = normalizeJsonValue(value, 'Context Brief MCP request');
  if (UTF8.encode(JSON.stringify(normalized)).byteLength > MAXIMUM_EVENT_TEXT_BYTES) {
    invalid('Context Brief MCP request exceeds the trace byte budget');
  }
  return protocolDigest('context-brief-mcp-request', normalized);
}
function parseItemStatus(value: unknown): AppServerItemStatus | null {
  if (value === undefined || value === null) return null;
  return literal(value, ['completed', 'declined', 'failed', 'inProgress'] as const, 'app-server item status');
}
function parseUsage(value: unknown): CodeMemoryLinkProviderUsageV1 {
  const usage = record(value, 'provider token usage');
  const total = record(usage.total, 'provider total token usage');
  const parsed = {
    cachedInputTokens: nonnegativeInteger(total.cachedInputTokens, 'cached input tokens'),
    inputTokens: nonnegativeInteger(total.inputTokens, 'input tokens'),
    outputTokens: nonnegativeInteger(total.outputTokens, 'output tokens'),
    reasoningOutputTokens: nonnegativeInteger(total.reasoningOutputTokens, 'reasoning output tokens'),
    totalTokens: nonnegativeInteger(total.totalTokens, 'total tokens'),
  };
  if (parsed.totalTokens < parsed.inputTokens || parsed.totalTokens < parsed.outputTokens) {
    invalid('provider total tokens cannot be smaller than input or output tokens');
  }
  return parsed;
}
function strictlyMonotoneUsage(
  previous: CodeMemoryLinkProviderUsageV1,
  current: CodeMemoryLinkProviderUsageV1,
): boolean {
  return (
    current.totalTokens > previous.totalTokens &&
    current.inputTokens >= previous.inputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.cachedInputTokens >= previous.cachedInputTokens &&
    current.reasoningOutputTokens >= previous.reasoningOutputTokens
  );
}
function parseStaticArtifacts(value: readonly unknown[]): readonly CodeMemoryLinkStaticArtifactInputV1[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > 128) {
    invalid('static judge artifacts must contain 1-128 content-addressed entries');
  }
  let totalBytes = 0;
  const artifacts = EffectArray.map(value, (entry, index) => {
    const artifact = record(entry, `static judge artifact ${index + 1}`);
    exactKeys(artifact, ['artifactId', 'content', 'mediaType', 'sha256'], `static judge artifact ${index + 1}`);
    const content = boundedUtf8Content(
      artifact.content,
      `static judge artifact ${index + 1} content`,
      MAXIMUM_STATIC_ARTIFACT_BYTES,
    );
    totalBytes += UTF8.encode(content).byteLength;
    const sha256 = matchingHash(artifact.sha256, `static judge artifact ${index + 1}`);
    if (sha256 !== codeMemoryLinkStaticArtifactSha256(content)) {
      invalid(`static judge artifact ${index + 1} content hash does not match`);
    }
    const parsed = {
      artifactId: matchingText(artifact.artifactId, ARTIFACT_ID, `static judge artifact ${index + 1} id`),
      content,
      mediaType: literal(
        artifact.mediaType,
        ['application/json', 'text/plain'] as const,
        `static judge artifact ${index + 1} media type`,
      ),
      sha256,
    };
    assertSyntheticArtifactContent(parsed, `static judge artifact ${index + 1}`);
    return parsed;
  });
  if (totalBytes > MAXIMUM_STATIC_ARTIFACT_TOTAL_BYTES) invalid('static judge artifacts exceed the total byte budget');
  canonicalUnique(
    EffectArray.map(artifacts, artifact => artifact.artifactId),
    'static judge artifact ids',
  );
  return artifacts;
}
function evaluateStaticAssertion(
  assertion: CodeMemoryLinkPredicateV1['assertion'],
  artifact: CodeMemoryLinkStaticArtifactInputV1,
): boolean {
  if (assertion.kind === 'json-equals') {
    if (artifact.mediaType !== 'application/json') invalid('json-equals requires an application/json artifact');
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifact.content) as unknown;
    } catch {
      invalid('json-equals artifact is not valid JSON');
    }
    return JSON.stringify(normalizeJsonValue(parsed, 'static JSON artifact')) === JSON.stringify(assertion.expected);
  }
  if (artifact.mediaType !== 'text/plain') invalid(`${assertion.kind} requires a text/plain artifact`);
  if (assertion.kind === 'utf8-equals') return artifact.content === assertion.expected;
  if (assertion.kind === 'utf8-contains')
    return Effect.pipe(artifact.content, EffectString.includes(assertion.expected));
  return !Effect.pipe(artifact.content, EffectString.includes(assertion.expected));
}
