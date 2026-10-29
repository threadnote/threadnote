import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeMemoryLinkClientProjectionHash} from './code-memory-link-client-descriptor.js';
import {Predicate} from 'effect';
import {
  assertCodeMemoryLinkExpectedCodexClientProjectionV1,
  codeMemoryLinkArmPacketHashV1,
  codeMemoryLinkContextBriefResponseReceiptHashV1,
  deriveCodeMemoryLinkCodexAppServerProjectionV1,
  parseCodeMemoryLinkContextBriefResponseReceiptV1,
  parseCodeMemoryLinkExpectedCodexClientV1,
  parseCodeMemoryLinkProxyToolV1,
  parseCodeMemoryLinkRubricV1,
  parseCodeMemoryLinkCodexAppServerEvidenceV1,
  type CodeMemoryLinkCodexAppServerEvidenceV1,
  type CodeMemoryLinkContextBriefResponseReceiptV1,
  type CodeMemoryLinkExpectedCodexClientV1,
  type CodeMemoryLinkProxyToolV1,
  type CodeMemoryLinkRubricV1,
} from './code-memory-link-agent-protocol.js';
import * as EffectRecord from 'effect/Record';

export const CODE_MEMORY_LINK_CODEX_RAW_EVIDENCE_VERSION = 1 as const;

export interface CodeMemoryLinkCodexRawEvidenceV1 {
  readonly appServer: CodeMemoryLinkCodexAppServerEvidenceV1;
  readonly clientProtocol: {
    readonly configurationProjectionHash: string;
    readonly environmentPolicyHash: string;
    readonly executionBundleHash: string;
    readonly expectedClient: CodeMemoryLinkExpectedCodexClientV1;
    readonly expectedClientProjectionHash: string;
    readonly proxyTool: CodeMemoryLinkProxyToolV1;
  };
  readonly bindings: {
    readonly approvalCommit: string;
    readonly arm: 'anchored' | 'no-memory' | 'task-only';
    readonly armPacketHash: string;
    readonly armPosition: 1 | 2 | 3;
    readonly assignmentHash: string;
    readonly blindLabel: 'X' | 'Y' | 'Z';
    readonly budget: {readonly steps: number; readonly tokens: number};
    readonly candidateCommit: string;
    readonly candidateExecutableSha256: string;
    readonly clientDescriptorHash: string;
    readonly clientId: string;
    readonly fixtureHash: string;
    readonly invocationNonceDigest: string;
    readonly manifestHash: string;
    readonly packetHash: string;
    readonly rubricHash: string;
    readonly runNonce: string;
    readonly runBindingHash: string;
    readonly runOrder: number;
    readonly suiteHash: string;
    readonly taskId: string;
    readonly taskKind: 'hidden-constraint' | 'negative-control';
  };
  readonly evidenceHash: string;
  readonly finalPublicArtifacts: readonly {
    readonly byteCount: number;
    readonly contentSha256: string;
    readonly pathDigest: string;
    readonly type: 'file';
  }[];
  readonly graphPreflight: CodeMemoryLinkCodexGraphPreflightEvidenceV1;
  readonly judge: {
    readonly adjudicationHash: string;
    readonly commandArtifactId: string;
    readonly commandSha256: string;
    readonly programArtifactId: string;
    readonly programSha256: string;
    readonly repositorySnapshotHash: string;
    readonly runBindingHash: string;
    readonly staticObservationHash: string;
    readonly stderrSha256: string;
    readonly stdoutSha256: string;
  };
  readonly rubric: CodeMemoryLinkRubricV1;
  readonly version: typeof CODE_MEMORY_LINK_CODEX_RAW_EVIDENCE_VERSION;
}

export interface CodeMemoryLinkCodexGraphPreflightEvidenceV1 {
  readonly commit: string;
  readonly graphContentDigest: string;
  readonly graphSnapshotDigest: string;
  readonly observedCitationDigests: readonly string[];
  readonly observedResponses: {
    readonly anchored: CodeMemoryLinkContextBriefResponseReceiptV1;
    readonly noMemory: CodeMemoryLinkContextBriefResponseReceiptV1;
    readonly taskOnly: CodeMemoryLinkContextBriefResponseReceiptV1;
  };
  readonly observedSelectedMemories: readonly {
    readonly contentSha256: string;
    readonly memoryIdDigest: string;
  }[];
  readonly originDigest: string;
  readonly preflightReceiptHash: string;
  readonly runBindingHash: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const ARTIFACT_ID = /^art_[0-9a-f]{16,64}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const INVOCATION_NONCE = /^inv_[0-9a-f]{16,64}$/u;

export function codeMemoryLinkCodexInvocationNonceDigestV1(nonce: string): string {
  return domainDigest('invocation-nonce', matching(nonce, INVOCATION_NONCE, 'invocation nonce'));
}

export function codeMemoryLinkCodexRunBindingHashV1(input: {
  readonly armPacketHash: string;
  readonly candidateExecutableSha256: string;
  readonly clientExecutionHash: string;
  readonly invocationNonceDigest: string;
  readonly manifestHash: string;
  readonly runNonce: string;
  readonly suiteHash: string;
  readonly taskId: string;
}): string {
  return domainDigest(
    'run-binding',
    JSON.stringify({
      armPacketHash: matching(input.armPacketHash, HASH, 'arm packet hash'),
      candidateExecutableSha256: matching(input.candidateExecutableSha256, HASH, 'candidate executable hash'),
      clientExecutionHash: matching(input.clientExecutionHash, HASH, 'client execution hash'),
      invocationNonceDigest: matching(input.invocationNonceDigest, HASH, 'invocation nonce digest'),
      manifestHash: matching(input.manifestHash, HASH, 'manifest hash'),
      runNonce: matching(input.runNonce, RUN_NONCE, 'run nonce'),
      suiteHash: matching(input.suiteHash, HASH, 'suite hash'),
      taskId: matching(input.taskId, TASK_ID, 'task id'),
    }),
  );
}

export function codeMemoryLinkCodexPreflightReceiptHashV1(
  input: Omit<CodeMemoryLinkCodexGraphPreflightEvidenceV1, 'preflightReceiptHash'>,
): string {
  return domainDigest('graph-preflight-receipt', JSON.stringify(normalizeGraphPreflightWithoutHash(input, false)));
}

export function createCodeMemoryLinkCodexRawEvidenceV1(
  input: Omit<CodeMemoryLinkCodexRawEvidenceV1, 'evidenceHash'>,
): CodeMemoryLinkCodexRawEvidenceV1 {
  const normalized = normalize(input, false);
  return {...normalized, evidenceHash: codeMemoryLinkCodexRawEvidenceHashV1(normalized)};
}

export function codeMemoryLinkCodexRawEvidenceHashV1(
  input: Omit<CodeMemoryLinkCodexRawEvidenceV1, 'evidenceHash'>,
): string {
  const normalized = normalize(input, false);
  return domainDigest('raw-evidence', JSON.stringify(normalized));
}

export function parseCodeMemoryLinkCodexRawEvidenceV1(value: unknown): CodeMemoryLinkCodexRawEvidenceV1 {
  const evidence = object(value, 'raw evidence');
  const normalized = normalize(evidence, true);
  const evidenceHash = matching(evidence.evidenceHash, HASH, 'raw evidence hash');
  if (evidenceHash !== codeMemoryLinkCodexRawEvidenceHashV1(normalized)) {
    throw new Error('Raw Code Memory Link evidence hash does not match its canonical contents.');
  }
  return {...normalized, evidenceHash};
}

function normalize(value: unknown, hasHash: boolean): Omit<CodeMemoryLinkCodexRawEvidenceV1, 'evidenceHash'> {
  const evidence = object(value, 'raw evidence');
  exactKeys(
    evidence,
    [
      'appServer',
      'bindings',
      'clientProtocol',
      ...(hasHash ? ['evidenceHash'] : []),
      'finalPublicArtifacts',
      'graphPreflight',
      'judge',
      'rubric',
      'version',
    ],
    'raw evidence',
  );
  if (evidence.version !== CODE_MEMORY_LINK_CODEX_RAW_EVIDENCE_VERSION) invalid('raw evidence version must be 1');
  const appServer = parseCodeMemoryLinkCodexAppServerEvidenceV1(evidence.appServer);
  const clientProtocolInput = object(evidence.clientProtocol, 'client protocol');
  exactKeys(
    clientProtocolInput,
    [
      'configurationProjectionHash',
      'environmentPolicyHash',
      'executionBundleHash',
      'expectedClient',
      'expectedClientProjectionHash',
      'proxyTool',
    ],
    'client protocol',
  );
  const clientProtocol = {
    configurationProjectionHash: matching(
      clientProtocolInput.configurationProjectionHash,
      HASH,
      'client configuration projection hash',
    ),
    environmentPolicyHash: matching(clientProtocolInput.environmentPolicyHash, HASH, 'client environment policy hash'),
    executionBundleHash: matching(clientProtocolInput.executionBundleHash, HASH, 'client execution bundle hash'),
    expectedClient: parseCodeMemoryLinkExpectedCodexClientV1(clientProtocolInput.expectedClient),
    expectedClientProjectionHash: matching(
      clientProtocolInput.expectedClientProjectionHash,
      HASH,
      'expected client projection hash',
    ),
    proxyTool: parseCodeMemoryLinkProxyToolV1(clientProtocolInput.proxyTool),
  };
  if (
    clientProtocol.expectedClientProjectionHash !==
    codeMemoryLinkClientProjectionHash('expected-client', {
      appServerVersion: clientProtocol.expectedClient.appServerVersion,
      model: clientProtocol.expectedClient.model,
      modelProvider: clientProtocol.expectedClient.modelProvider,
      proxyTool: clientProtocol.proxyTool,
      reasoningEffort: clientProtocol.expectedClient.reasoningEffort,
    })
  ) {
    invalid('expected client projection hash differs from the retained client protocol');
  }
  assertCodeMemoryLinkExpectedCodexClientProjectionV1({
    ...clientProtocol,
    retainedIdentity: {
      appServerVersion: appServer.appServerVersion,
      effectiveModel: appServer.effectiveModel,
      modelProviderDigest: appServer.modelProviderDigest,
      proxyToolDigest: appServer.proxyToolDigest,
      reasoningEffortDigest: appServer.reasoningEffortDigest,
    },
  });
  const bindingInput = object(evidence.bindings, 'raw evidence bindings');
  exactKeys(
    bindingInput,
    [
      'approvalCommit',
      'arm',
      'armPacketHash',
      'armPosition',
      'assignmentHash',
      'blindLabel',
      'budget',
      'candidateCommit',
      'candidateExecutableSha256',
      'clientDescriptorHash',
      'clientId',
      'fixtureHash',
      'invocationNonceDigest',
      'manifestHash',
      'packetHash',
      'rubricHash',
      'runNonce',
      'runBindingHash',
      'runOrder',
      'suiteHash',
      'taskId',
      'taskKind',
    ],
    'raw evidence bindings',
  );
  const budgetInput = object(bindingInput.budget, 'raw evidence budget');
  exactKeys(budgetInput, ['steps', 'tokens'], 'raw evidence budget');
  const bindings = {
    approvalCommit: matching(bindingInput.approvalCommit, /^[0-9a-f]{40}$/u, 'approval commit'),
    arm: oneOf(bindingInput.arm, ['anchored', 'task-only', 'no-memory'] as const, 'arm'),
    armPacketHash: matching(bindingInput.armPacketHash, HASH, 'arm packet hash'),
    armPosition: armPosition(bindingInput.armPosition),
    assignmentHash: matching(bindingInput.assignmentHash, HASH, 'assignment hash'),
    blindLabel: oneOf(bindingInput.blindLabel, ['X', 'Y', 'Z'] as const, 'blind label'),
    budget: {
      steps: integer(budgetInput.steps, 'step budget', 1, 1_000),
      tokens: integer(budgetInput.tokens, 'token budget', 1, 10_000_000),
    },
    candidateCommit: matching(bindingInput.candidateCommit, /^[0-9a-f]{40}$/u, 'candidate commit'),
    candidateExecutableSha256: matching(bindingInput.candidateExecutableSha256, HASH, 'candidate executable hash'),
    clientDescriptorHash: matching(bindingInput.clientDescriptorHash, HASH, 'client descriptor hash'),
    clientId: matching(bindingInput.clientId, CLIENT_ID, 'client id'),
    fixtureHash: matching(bindingInput.fixtureHash, HASH, 'fixture hash'),
    invocationNonceDigest: matching(bindingInput.invocationNonceDigest, HASH, 'invocation nonce digest'),
    manifestHash: matching(bindingInput.manifestHash, HASH, 'manifest hash'),
    packetHash: matching(bindingInput.packetHash, HASH, 'packet hash'),
    rubricHash: matching(bindingInput.rubricHash, HASH, 'rubric hash'),
    runNonce: matching(bindingInput.runNonce, RUN_NONCE, 'run nonce'),
    runBindingHash: matching(bindingInput.runBindingHash, HASH, 'run binding hash'),
    runOrder: integer(bindingInput.runOrder, 'run order', 0, 1_000_000),
    suiteHash: matching(bindingInput.suiteHash, HASH, 'suite hash'),
    taskId: matching(bindingInput.taskId, TASK_ID, 'task id'),
    taskKind: oneOf(bindingInput.taskKind, ['hidden-constraint', 'negative-control'] as const, 'task kind'),
  };
  const expectedArmPacketHash = codeMemoryLinkArmPacketHashV1({
    assignmentHash: bindings.assignmentHash,
    blindLabel: bindings.blindLabel,
    fixtureHash: bindings.fixtureHash,
    packetHash: bindings.packetHash,
    policy: bindings.arm,
    rubricHash: bindings.rubricHash,
    runNonce: bindings.runNonce,
    taskId: bindings.taskId,
    taskKind: bindings.taskKind,
    version: 1,
  });
  if (bindings.armPacketHash !== expectedArmPacketHash) invalid('arm packet hash differs from the retained run fields');
  const expectedRunBindingHash = codeMemoryLinkCodexRunBindingHashV1({
    armPacketHash: bindings.armPacketHash,
    candidateExecutableSha256: bindings.candidateExecutableSha256,
    clientExecutionHash: bindings.clientDescriptorHash,
    invocationNonceDigest: bindings.invocationNonceDigest,
    manifestHash: bindings.manifestHash,
    runNonce: bindings.runNonce,
    suiteHash: bindings.suiteHash,
    taskId: bindings.taskId,
  });
  if (bindings.runBindingHash !== expectedRunBindingHash || appServer.runBindingHash !== expectedRunBindingHash) {
    invalid('retained evidence stages differ from the independently reconstructed run binding');
  }
  if (bindings.rubricHash !== appServer.rubricHash) invalid('app-server evidence uses another rubric hash');
  const rubric = parseCodeMemoryLinkRubricV1(evidence.rubric);
  if (
    rubric.rubricHash !== bindings.rubricHash ||
    rubric.fixtureHash !== bindings.fixtureHash ||
    rubric.taskId !== bindings.taskId ||
    rubric.taskKind !== bindings.taskKind
  ) {
    invalid('retained rubric differs from the bound rubric, fixture, or task');
  }

  if (!EffectArray.isArray(evidence.finalPublicArtifacts) || evidence.finalPublicArtifacts.length > 256) {
    invalid('final public artifact roster is invalid');
  }
  let totalPublicBytes = 0;
  const finalPublicArtifacts = EffectArray.map(evidence.finalPublicArtifacts, (entry, index) => {
    const artifact = object(entry, `final public artifact ${index + 1}`);
    exactKeys(artifact, ['byteCount', 'contentSha256', 'pathDigest', 'type'], `final public artifact ${index + 1}`);
    if (artifact.type !== 'file') invalid('final public artifacts must be files');
    const byteCount = integer(artifact.byteCount, 'final public artifact byte count', 0, 2 * 1_024 * 1_024);
    totalPublicBytes += byteCount;
    if (totalPublicBytes > 16 * 1_024 * 1_024) invalid('final public artifact aggregate exceeds its limit');
    return {
      byteCount,
      contentSha256: matching(artifact.contentSha256, HASH, 'final public content hash'),
      pathDigest: matching(artifact.pathDigest, HASH, 'final public path digest'),
      type: 'file' as const,
    };
  });
  unique(
    EffectArray.map(finalPublicArtifacts, artifact => artifact.pathDigest),
    'final public path digests',
  );

  const graphPreflight = parseGraphPreflight(evidence.graphPreflight);
  if (graphPreflight.runBindingHash !== expectedRunBindingHash) {
    invalid('graph preflight differs from the independently reconstructed run binding');
  }
  const contextCalls = EffectArray.filter(
    appServer.checkpoints,
    checkpoint => checkpoint.method === 'item/completed' && checkpoint.itemType === 'mcpToolCall',
  );
  const expectedResponseClass = {
    anchored: 'anchored-v3',
    'no-memory': 'empty-v1',
    'task-only': 'task-v2',
  }[bindings.arm];
  const preflightResponse =
    bindings.arm === 'anchored'
      ? graphPreflight.observedResponses.anchored
      : bindings.arm === 'task-only'
        ? graphPreflight.observedResponses.taskOnly
        : graphPreflight.observedResponses.noMemory;
  for (const contextCall of contextCalls) {
    if (!contextCall.succeeded) continue;
    if (!contextCall.proxyReceipt || !contextCall.response) {
      invalid('successful Context Brief evidence lacks its response receipt');
    }
    if (contextCall.proxyReceipt.armPacketHash !== expectedArmPacketHash) {
      invalid('Context Brief proxy receipt uses another arm packet');
    }
    if (contextCall.response.responseClass !== expectedResponseClass) {
      invalid('model-visible Context Brief response class differs from the assigned arm');
    }
    if (
      contextCall.proxyReceipt.responseHash !== codeMemoryLinkContextBriefResponseReceiptHashV1(preflightResponse) ||
      contextCall.proxyReceipt.responseHash !== codeMemoryLinkContextBriefResponseReceiptHashV1(contextCall.response)
    ) {
      invalid('model-visible Context Brief response differs from the exact preflight arm projection');
    }
  }

  const judgeInput = object(evidence.judge, 'judge evidence');
  exactKeys(
    judgeInput,
    [
      'adjudicationHash',
      'commandArtifactId',
      'commandSha256',
      'programArtifactId',
      'programSha256',
      'repositorySnapshotHash',
      'runBindingHash',
      'staticObservationHash',
      'stderrSha256',
      'stdoutSha256',
    ],
    'judge evidence',
  );
  const judge = {
    adjudicationHash: matching(judgeInput.adjudicationHash, HASH, 'adjudication hash'),
    commandArtifactId: matching(judgeInput.commandArtifactId, ARTIFACT_ID, 'judge command artifact id'),
    commandSha256: matching(judgeInput.commandSha256, HASH, 'judge command hash'),
    programArtifactId: matching(judgeInput.programArtifactId, ARTIFACT_ID, 'judge program artifact id'),
    programSha256: matching(judgeInput.programSha256, HASH, 'judge program hash'),
    repositorySnapshotHash: matching(judgeInput.repositorySnapshotHash, HASH, 'repository snapshot hash'),
    runBindingHash: matching(judgeInput.runBindingHash, HASH, 'judge run binding hash'),
    staticObservationHash: matching(judgeInput.staticObservationHash, HASH, 'static observation hash'),
    stderrSha256: matching(judgeInput.stderrSha256, HASH, 'judge stderr hash'),
    stdoutSha256: matching(judgeInput.stdoutSha256, HASH, 'judge stdout hash'),
  };
  if (judge.commandArtifactId === judge.programArtifactId) invalid('judge command and program artifacts must differ');
  if (judge.runBindingHash !== expectedRunBindingHash) invalid('judge evidence uses another run binding');
  if (judge.staticObservationHash !== appServer.staticObservationHash) {
    invalid('judge observation hash differs from retained app-server evidence');
  }
  const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({evidence: appServer, rubric});
  if (judge.adjudicationHash !== projection.adjudicationHash) {
    invalid('judge adjudication differs from independently rederived retained evidence');
  }
  return {
    appServer,
    bindings,
    clientProtocol,
    finalPublicArtifacts,
    graphPreflight,
    judge,
    rubric,
    version: CODE_MEMORY_LINK_CODEX_RAW_EVIDENCE_VERSION,
  };
}

function parseGraphPreflight(value: unknown): CodeMemoryLinkCodexGraphPreflightEvidenceV1 {
  const normalized = normalizeGraphPreflightWithoutHash(value, true);
  const preflight = object(value, 'graph preflight');
  const preflightReceiptHash = matching(preflight.preflightReceiptHash, HASH, 'graph preflight receipt hash');
  if (preflightReceiptHash !== codeMemoryLinkCodexPreflightReceiptHashV1(normalized)) {
    invalid('graph preflight receipt hash differs from its canonical evidence');
  }
  return {...normalized, preflightReceiptHash};
}

function normalizeGraphPreflightWithoutHash(
  value: unknown,
  hasHash: boolean,
): Omit<CodeMemoryLinkCodexGraphPreflightEvidenceV1, 'preflightReceiptHash'> {
  const preflight = object(value, 'graph preflight');
  exactKeys(
    preflight,
    [
      'commit',
      'graphContentDigest',
      'graphSnapshotDigest',
      'observedCitationDigests',
      'observedResponses',
      'observedSelectedMemories',
      'originDigest',
      ...(hasHash ? ['preflightReceiptHash'] : []),
      'runBindingHash',
    ],
    'graph preflight',
  );
  if (!EffectArray.isArray(preflight.observedCitationDigests) || preflight.observedCitationDigests.length > 64) {
    invalid('observed citation digests are invalid');
  }
  const observedCitationDigests = EffectArray.map(preflight.observedCitationDigests, value =>
    matching(value, HASH, 'observed citation digest'),
  );
  if (
    EffectArray.some(
      observedCitationDigests,
      (entry, index) => index > 0 && observedCitationDigests[index - 1] >= entry,
    )
  ) {
    invalid('observed citation digests must be unique and sorted');
  }
  const responses = object(preflight.observedResponses, 'graph preflight response projections');
  exactKeys(responses, ['anchored', 'noMemory', 'taskOnly'], 'graph preflight response projections');
  const observedResponses = {
    anchored: parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.anchored),
    noMemory: parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.noMemory),
    taskOnly: parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.taskOnly),
  };
  if (
    observedResponses.anchored.responseClass !== 'anchored-v3' ||
    observedResponses.noMemory.responseClass !== 'empty-v1' ||
    observedResponses.taskOnly.responseClass !== 'task-v2'
  ) {
    invalid('graph preflight response projections do not represent the three assigned arms');
  }
  if (!EffectArray.isArray(preflight.observedSelectedMemories) || preflight.observedSelectedMemories.length > 24) {
    invalid('observed selected-memory roster is invalid');
  }
  const observedSelectedMemories = EffectArray.map(preflight.observedSelectedMemories, (entry, index) => {
    const memory = object(entry, `observed selected memory ${index + 1}`);
    exactKeys(memory, ['contentSha256', 'memoryIdDigest'], `observed selected memory ${index + 1}`);
    return {
      contentSha256: matching(memory.contentSha256, HASH, 'selected memory content hash'),
      memoryIdDigest: matching(memory.memoryIdDigest, HASH, 'selected memory id digest'),
    };
  });
  if (
    EffectArray.some(observedSelectedMemories, (entry, index) => {
      if (index === 0) return false;
      const previous = observedSelectedMemories[index - 1];
      return (
        previous.memoryIdDigest > entry.memoryIdDigest ||
        (previous.memoryIdDigest === entry.memoryIdDigest && previous.contentSha256 >= entry.contentSha256)
      );
    })
  ) {
    invalid('observed selected-memory roster must be unique and canonically ordered');
  }
  unique(
    EffectArray.map(observedSelectedMemories, memory => memory.memoryIdDigest),
    'observed selected-memory ids',
  );
  if (
    JSON.stringify(observedCitationDigests) !==
      JSON.stringify(observedResponses.anchored.directCurrentRelationDigests) ||
    JSON.stringify(observedSelectedMemories) !== JSON.stringify(observedResponses.anchored.selectedMemories)
  ) {
    invalid('graph preflight citation or memory roster differs from its anchored response projection');
  }
  return {
    commit: matching(preflight.commit, /^[0-9a-f]{40}$/u, 'fixture commit'),
    graphContentDigest: matching(preflight.graphContentDigest, HASH, 'graph content digest'),
    graphSnapshotDigest: matching(preflight.graphSnapshotDigest, HASH, 'graph snapshot digest'),
    observedCitationDigests,
    observedResponses,
    observedSelectedMemories,
    originDigest: matching(preflight.originDigest, HASH, 'fixture origin digest'),
    runBindingHash: matching(preflight.runBindingHash, HASH, 'graph preflight run binding hash'),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is out of range`);
  }
  return value;
}

function armPosition(value: unknown): 1 | 2 | 3 {
  const parsed = integer(value, 'arm position', 1, 3);
  if (parsed === 1 || parsed === 2 || parsed === 3) return parsed;
  invalid('arm position is out of range');
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string') invalid(`${label} is invalid`);
  const match = EffectOption.getOrUndefined(EffectArray.findFirst(allowed, candidate => candidate === value));
  if (match === undefined) invalid(`${label} is invalid`);
  return match;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function domainDigest(domain: string, value: string): string {
  return sha256HexSync(`threadnote-code-memory-link-${domain}-v1\0${value}`);
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link Codex raw evidence: ${message}.`);
}
