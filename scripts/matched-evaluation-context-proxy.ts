#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed MCP proxy owns one bounded pinned Threadnote child process. */

import {createHash} from 'node:crypto';
import {readFile, realpath, stat, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Schema} from 'effect';
import {EffectSchemaSdkTools} from '@threadnote/threadnote/mcp/effect_schema_sdk_tools';

export const MATCHED_EVALUATION_CONTEXT_PACKET_ENV = 'MATCHED_EVALUATION_CONTEXT_PACKET' as const;
export const MATCHED_EVALUATION_CONTEXT_SERVER_NAME = 'matched_evaluation_context' as const;
export const MATCHED_EVALUATION_CONTEXT_PROXY_VERSION = 7 as const;

type MatchedEvaluationContextBriefMode = 'brief' | 'resume';

export interface MatchedEvaluationContextProxyPacketV1 {
  readonly budgetTokens: number;
  readonly detail: 'compact' | 'graph-only' | 'source';
  /** Whether the first brief is model-requested or injected before the first model turn. */
  readonly initialBriefDelivery: 'mcp' | 'preloaded';
  /** The Context Brief mode is sealed by the runner, not selected by the agent. */
  readonly mode: MatchedEvaluationContextBriefMode;
  readonly expectedContext: {
    readonly graphContentHash: string;
    readonly graphSnapshotHash: string;
    readonly linkReceiptsHash: string | null;
    readonly memoryAccess: 'disabled' | 'linked';
    readonly studyHash: string;
    readonly taskContextHash: string | null;
  };
  readonly expectedResume: {
    readonly automaticHandoffUri: string;
    readonly requiredGraphQuery: string | null;
    readonly resumeEvidenceMarker: string;
  } | null;
  readonly maximumFollowupCalls: number;
  readonly project: string;
  readonly prompt: string;
  readonly repositoryRoot: string;
  readonly runNonce: string;
  readonly runtimeManifestPath: string;
  readonly runtimeManifestSha256: string;
  readonly threadnoteAccount: string;
  readonly threadnoteExecutable: string;
  readonly threadnoteExecutableSha256: string;
  readonly threadnoteHome: string;
  readonly threadnoteUser: string;
  readonly version: typeof MATCHED_EVALUATION_CONTEXT_PROXY_VERSION;
}

export interface MatchedEvaluationContextProxyRequestV1 {
  readonly budgetTokens?: number;
  readonly callerCwd: string;
  readonly codeRefs?: string | readonly string[];
  readonly mode?: (typeof MODES)[number];
  readonly project?: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;
const CGS = /^cgs_[0-9a-f]{16,128}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODES = ['brief', 'resume', 'locate', 'explain', 'trace', 'impact'] as const;
const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const PathOrId = NonEmptyText.check(Schema.isMaxLength(4_096));

export function hashMatchedEvaluationContextContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashMatchedEvaluationContextRequest(toolName: string, requestInput: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return hashMatchedEvaluationContextContent(JSON.stringify(canonical({toolName, arguments: requestInput})));
}

export function matchedEvaluationContextTools(
  detail: MatchedEvaluationContextProxyPacketV1['detail'],
  initialBriefDelivery: MatchedEvaluationContextProxyPacketV1['initialBriefDelivery'] = 'mcp',
  requiredGraphQuery: string | null = null,
): readonly string[] {
  if (detail === 'source') return ['context_brief'];
  if (initialBriefDelivery === 'preloaded' && requiredGraphQuery !== null) return ['inspect_code_graph'];
  const graph = [
    ...(initialBriefDelivery === 'mcp' ? ['context_brief'] : []),
    'inspect_code_graph',
    'analyze_code_graph',
  ];
  return detail === 'compact' ? [...graph, 'recall_context', 'read_context'] : graph;
}

const ScopeFields = {
  callerCwd: PathOrId,
  project: Schema.optionalKey(NonEmptyText.check(Schema.isMaxLength(128))),
};
const optionalText = Schema.optionalKey(PathOrId);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const boundedInt = (minimum: number, maximum: number) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum, maximum})));
export const MATCHED_EVALUATION_INSPECT_INPUT_SCHEMA = Schema.Struct({
  ...ScopeFields,
  operation: Schema.Literals(['query', 'node', 'neighbors', 'explain', 'path', 'impact']),
  query: optionalText,
  symbol: optionalText,
  nodeId: optionalText,
  from: optionalText,
  to: optionalText,
  package: optionalText,
  cursor: optionalText,
  depth: boundedInt(0, 8),
  nodeLimit: boundedInt(1, 200),
  edgeLimit: boundedInt(1, 500),
  budgetTokens: boundedInt(1, 1_500),
  readTimeoutMilliseconds: boundedInt(4_000, 55_000),
  direction: Schema.optionalKey(Schema.Literals(['incoming', 'outgoing', 'both'])),
  includeHeuristic: optionalBoolean,
  includeModelAssociations: optionalBoolean,
});
export const MATCHED_EVALUATION_ANALYZE_INPUT_SCHEMA = Schema.Struct({
  ...ScopeFields,
  operation: Schema.Literals([
    'stats',
    'communities',
    'community',
    'groups',
    'hubs',
    'surprises',
    'confidence',
    'full',
  ]),
  communityId: optionalText,
  memberLimit: boundedInt(1, 100),
  includeHeuristic: optionalBoolean,
  includeModelAssociations: optionalBoolean,
});
export const MATCHED_EVALUATION_RECALL_INPUT_SCHEMA = Schema.Struct({
  ...ScopeFields,
  query: PathOrId,
  budgetTokens: boundedInt(700, 1_500),
  nodeLimit: boundedInt(1, 20),
});
export const MATCHED_EVALUATION_READ_INPUT_SCHEMA = Schema.Struct({
  uri: PathOrId,
  mode: Schema.optionalKey(Schema.Literals(['content', 'outline'])),
  offsetBytes: boundedInt(0, 10_000_000),
  section: optionalText,
  sourceHash: optionalText,
});

type ContextResult = {
  readonly content: readonly [{readonly text: string; readonly type: 'text'}];
  readonly meta: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly structuredContent?: never;
};

function receipt(
  packet: MatchedEvaluationContextProxyPacketV1,
  toolName: string,
  request: unknown,
  text: string,
  success: boolean,
): ContextResult {
  return {
    content: [{type: 'text', text}],
    ...(success ? {} : {isError: true}),
    meta: {
      matchedEvaluation: {
        ...packet.expectedContext,
        expectedResumeHash: hashExpectedResume(packet.expectedResume),
        graphReady: true,
        mode: packet.mode,
        runNonce: packet.runNonce,
        runtimeManifestSha256: packet.runtimeManifestSha256,
        contentResponseSha256: hashMatchedEvaluationContextContent(text),
        frozenPromptSha256: hashMatchedEvaluationContextContent(packet.prompt),
        toolName,
        requestSha256: hashMatchedEvaluationContextRequest(toolName, request),
        success,
        version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
      },
    },
  };
}

export function hashExpectedResume(
  expectedResume: MatchedEvaluationContextProxyPacketV1['expectedResume'],
): string | null {
  return expectedResume === null ? null : hashMatchedEvaluationContextContent(JSON.stringify(expectedResume));
}

export const MATCHED_EVALUATION_CONTEXT_INPUT_SCHEMA = Schema.Struct({
  budgetTokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 800, maximum: 1_500}))),
  callerCwd: PathOrId,
  codeRefs: Schema.optionalKey(Schema.Union([PathOrId, Schema.Array(PathOrId).check(Schema.isMaxLength(8))])),
  mode: Schema.optionalKey(Schema.Literals(MODES)),
  project: Schema.optionalKey(NonEmptyText.check(Schema.isMaxLength(128))),
});

export async function handleMatchedEvaluationContextRequest(
  packetInput: MatchedEvaluationContextProxyPacketV1 | unknown,
  requestInput: MatchedEvaluationContextProxyRequestV1 | unknown,
): Promise<ContextResult> {
  const packet = parseMatchedEvaluationContextProxyPacketV1(packetInput);
  const request = Schema.decodeUnknownSync(MATCHED_EVALUATION_CONTEXT_INPUT_SCHEMA, {
    onExcessProperty: 'error',
  })(requestInput);
  const callerCwd = await realpath(request.callerCwd);
  if (callerCwd !== packet.repositoryRoot) throw new Error('Context request escaped the isolated repository.');
  const preparedHome = await realpath(packet.threadnoteHome);
  if (!isContained(dirname(packet.repositoryRoot), preparedHome) || isContained(packet.repositoryRoot, preparedHome)) {
    throw new Error('Prepared Threadnote home escaped its isolated private root.');
  }
  if (request.project !== undefined && request.project !== packet.project) {
    throw new Error('Context request project differs from the prepared project.');
  }
  if (request.budgetTokens !== undefined && request.budgetTokens !== packet.budgetTokens) {
    throw new Error('Context request budget differs from the preregistered dose.');
  }
  if (request.mode !== undefined && request.mode !== packet.mode) {
    throw new Error('Context request mode differs from the sealed treatment.');
  }
  const requestedRefs =
    request.codeRefs === undefined ? [] : typeof request.codeRefs === 'string' ? [request.codeRefs] : request.codeRefs;
  const codeRefs = requestedRefs.map(reference => validatedCodeRef(reference, packet.repositoryRoot));
  await Promise.all([
    assertPinnedExecutable(packet.threadnoteExecutable, packet.threadnoteExecutableSha256),
    assertRuntimeManifest(packet, preparedHome),
  ]);
  const structuredContent = await runThreadnoteContextBrief(packet, {
    codeRefs,
    mode: packet.mode,
  });
  const responseText = JSON.stringify(structuredContent);
  if (
    packet.mode === 'resume' &&
    packet.expectedResume !== null &&
    !hasExpectedResumeDelivery(
      structuredContent,
      packet.expectedResume.automaticHandoffUri,
      packet.expectedResume.requiredGraphQuery,
      packet.expectedResume.resumeEvidenceMarker,
    )
  ) {
    throw new Error('Resume Context Brief omitted the sealed automatic handoff URI, continuation evidence, or marker.');
  }
  return receipt(packet, 'context_brief', requestInput, responseText, true);
}

function hasExpectedResumeDelivery(
  structuredContent: Record<string, unknown>,
  automaticHandoffUri: string,
  requiredGraphQuery: string | null,
  resumeEvidenceMarker: string,
): boolean {
  if (!Array.isArray(structuredContent.activeHandoffs)) return false;
  return structuredContent.activeHandoffs.some(candidate => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const handoff = candidate as Record<string, unknown>;
    const card = handoff.continuationCard;
    const cardText =
      typeof card === 'object' && card !== null && !Array.isArray(card)
        ? Object.values(card)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .join('\n')
        : '';
    const answer = typeof structuredContent.answer === 'string' ? structuredContent.answer : '';
    const continuationEvidence = `${answer}\n${cardText}`;
    return (
      handoff.uri === automaticHandoffUri &&
      continuationEvidence.trim().length > 0 &&
      continuationEvidence.includes(resumeEvidenceMarker) &&
      (requiredGraphQuery === null || continuationEvidence.includes(requiredGraphQuery))
    );
  });
}

export async function handleMatchedEvaluationFollowupRequest(
  packetInput: unknown,
  toolName: string,
  requestInput: unknown,
  invoke: typeof runThreadnoteTool = runThreadnoteTool,
): Promise<ContextResult> {
  const packet = parseMatchedEvaluationContextProxyPacketV1(packetInput);
  const requiredGraphQuery = packet.expectedResume?.requiredGraphQuery ?? null;
  const allowedTools = matchedEvaluationContextTools(packet.detail, packet.initialBriefDelivery, requiredGraphQuery);
  if (toolName === 'context_brief' || !allowedTools.includes(toolName)) {
    throw new Error('Tool is not allowed by the sealed treatment.');
  }
  const schemas = {
    inspect_code_graph: MATCHED_EVALUATION_INSPECT_INPUT_SCHEMA,
    analyze_code_graph: MATCHED_EVALUATION_ANALYZE_INPUT_SCHEMA,
    recall_context: MATCHED_EVALUATION_RECALL_INPUT_SCHEMA,
    read_context: MATCHED_EVALUATION_READ_INPUT_SCHEMA,
  };
  const schema = schemas[toolName as keyof typeof schemas];
  const request = Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(requestInput) as Record<
    string,
    unknown
  >;
  if (
    packet.initialBriefDelivery === 'preloaded' &&
    requiredGraphQuery !== null &&
    (toolName !== 'inspect_code_graph' || request.operation !== 'query' || request.query !== requiredGraphQuery)
  ) {
    throw new Error('Preloaded continuation must use its sealed diagnostic graph query.');
  }
  const preparedHome = await realpath(packet.threadnoteHome);
  if (!isContained(dirname(packet.repositoryRoot), preparedHome) || isContained(packet.repositoryRoot, preparedHome)) {
    throw new Error('Prepared Threadnote home escaped its isolated private root.');
  }
  if (toolName !== 'read_context') {
    if ((await realpath(String(request.callerCwd))) !== packet.repositoryRoot)
      throw new Error('Context request escaped the isolated repository.');
    if (request.project !== undefined && request.project !== packet.project)
      throw new Error('Context request project differs from the prepared project.');
  } else {
    const uri = String(request.uri);
    const personalPrefix = `threadnote://user/${packet.threadnoteUser}/memories/`;
    const path = uri.startsWith(personalPrefix) ? uri.slice(personalPrefix.length) : undefined;
    if (
      !/^threadnote:\/\/memory\/tn_[A-Za-z0-9_-]+$/u.test(uri) &&
      !(
        path &&
        !/[\\%?#]/u.test(path) &&
        !path.includes('\0') &&
        path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
      )
    ) {
      throw new Error('Memory URI is outside the isolated prepared memory namespace.');
    }
  }
  await Promise.all([
    assertPinnedExecutable(packet.threadnoteExecutable, packet.threadnoteExecutableSha256),
    assertRuntimeManifest(packet, preparedHome),
  ]);
  const arguments_ =
    toolName === 'read_context'
      ? {...request, responseFormat: 'text'}
      : {
          ...request,
          callerCwd: packet.repositoryRoot,
          project: packet.project,
          ...(toolName === 'analyze_code_graph' ? {freshness: 'allow-stale'} : {}),
          responseFormat: 'agent',
        };
  try {
    const result = await invoke(packet, toolName, arguments_);
    // read_context has structured metadata, not a second evidence body. Prefer
    // the native text projection so neither metadata nor dual output replaces it.
    const nativeText = (result.content as {type: string; text?: string}[])
      .filter(item => item.type === 'text')
      .map(item => item.text ?? '')
      .join('\n');
    const text = nativeText || (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent));
    if (!text || Buffer.byteLength(text) > 256 * 1_024)
      throw new Error('Tool response is empty or exceeds the bounded response limit.');
    return receipt(packet, toolName, requestInput, text, result.isError !== true);
  } catch (cause) {
    return receipt(
      packet,
      toolName,
      requestInput,
      JSON.stringify({error: cause instanceof Error ? cause.message : 'Threadnote follow-up failed.'}),
      false,
    );
  }
}

export function assertMatchedEvaluationFollowupBudgetV1(packetInput: unknown, attemptedCalls: number): void {
  const packet = parseMatchedEvaluationContextProxyPacketV1(packetInput);
  if (!Number.isSafeInteger(attemptedCalls) || attemptedCalls < 1) {
    throw new Error('Follow-up call count must be a positive safe integer.');
  }
  if (attemptedCalls > packet.maximumFollowupCalls) {
    throw new Error('Context follow-up call exceeds the sealed treatment budget.');
  }
}

async function runThreadnoteTool(
  packet: MatchedEvaluationContextProxyPacketV1,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const client = new Client({
    name: 'matched-evaluation-pinned-backend',
    version: String(MATCHED_EVALUATION_CONTEXT_PROXY_VERSION),
  });
  const transport = new StdioClientTransport({
    command: packet.threadnoteExecutable,
    args: ['mcp-server'],
    cwd: packet.repositoryRoot,
    env: {
      ...threadnoteEnvironment(packet),
      THREADNOTE_MANIFEST: packet.runtimeManifestPath,
      LOGNAME: packet.threadnoteUser,
      USER: packet.threadnoteUser,
      SHELL: '/bin/sh',
      TERM: 'dumb',
    },
    stderr: 'pipe',
    maxBufferSize: 2 * 1_024 * 1_024,
  });
  transport.stderr?.on('data', () => undefined);
  try {
    await client.connect(transport, {timeout: 30_000});
    return await client.callTool({name, arguments: arguments_}, undefined, {timeout: 120_000});
  } finally {
    await client.close();
    await transport.close();
  }
}

export function parseMatchedEvaluationContextProxyPacketV1(
  value: MatchedEvaluationContextProxyPacketV1 | unknown,
): MatchedEvaluationContextProxyPacketV1 {
  const packet = object(value, 'context proxy packet');
  exactKeys(packet, [
    'budgetTokens',
    'detail',
    'mode',
    'expectedContext',
    'expectedResume',
    'initialBriefDelivery',
    'maximumFollowupCalls',
    'project',
    'prompt',
    'repositoryRoot',
    'runNonce',
    'runtimeManifestPath',
    'runtimeManifestSha256',
    'threadnoteAccount',
    'threadnoteExecutable',
    'threadnoteExecutableSha256',
    'threadnoteHome',
    'threadnoteUser',
    'version',
  ]);
  if (packet.version !== MATCHED_EVALUATION_CONTEXT_PROXY_VERSION) invalid('packet version must be 7');
  const expected = object(packet.expectedContext, 'expected context');
  exactKeys(expected, [
    'graphContentHash',
    'graphSnapshotHash',
    'linkReceiptsHash',
    'memoryAccess',
    'studyHash',
    'taskContextHash',
  ]);
  const memoryAccess = literal(expected.memoryAccess, ['disabled', 'linked'] as const, 'memory access');
  const detail = literal(packet.detail, ['compact', 'graph-only', 'source'] as const, 'context detail');
  if ((detail === 'graph-only') !== (memoryAccess === 'disabled')) {
    invalid('treatment detail and memory access disagree');
  }
  const linkReceiptsHash = nullableHash(expected.linkReceiptsHash, 'link receipts hash');
  const taskContextHash = nullableHash(expected.taskContextHash, 'task context hash');
  const mode = literal(packet.mode, ['brief', 'resume'] as const, 'Context Brief mode');
  const initialBriefDelivery = literal(
    packet.initialBriefDelivery,
    ['mcp', 'preloaded'] as const,
    'initial brief delivery',
  );
  const maximumFollowupCalls = integer(packet.maximumFollowupCalls, 0, 4, 'maximum follow-up calls');
  const expectedResume =
    packet.expectedResume === null
      ? null
      : (() => {
          const resume = object(packet.expectedResume, 'expected resume');
          exactKeys(resume, ['automaticHandoffUri', 'requiredGraphQuery', 'resumeEvidenceMarker']);
          return {
            automaticHandoffUri: boundedText(resume.automaticHandoffUri, 1, 4_096, 'automatic handoff URI'),
            requiredGraphQuery:
              resume.requiredGraphQuery === null
                ? null
                : boundedText(resume.requiredGraphQuery, 8, 512, 'required graph query'),
            resumeEvidenceMarker: boundedText(resume.resumeEvidenceMarker, 1, 4_096, 'resume evidence marker'),
          };
        })();
  if ((mode === 'resume') !== (expectedResume !== null)) {
    invalid('resume mode and expected resume evidence disagree');
  }
  if (initialBriefDelivery === 'preloaded' && (mode !== 'resume' || detail !== 'compact')) {
    invalid('preloaded initial context is supported only for compact resume');
  }
  if ((expectedResume?.requiredGraphQuery ?? null) !== null && initialBriefDelivery !== 'preloaded') {
    invalid('a required graph query is supported only for preloaded resume');
  }
  if ((detail === 'source' && maximumFollowupCalls !== 0) || (mode === 'resume' && maximumFollowupCalls > 1)) {
    invalid('context detail or resume mode disagrees with the follow-up call budget');
  }
  if (
    (memoryAccess === 'disabled' && (linkReceiptsHash !== null || taskContextHash !== null)) ||
    (memoryAccess === 'linked' && (linkReceiptsHash === null || taskContextHash === null))
  ) {
    invalid('memory access and prepared receipt fields disagree');
  }
  return {
    budgetTokens: integer(packet.budgetTokens, 800, 1_500, 'context budget'),
    detail,
    initialBriefDelivery,
    mode,
    expectedContext: {
      graphContentHash: matching(expected.graphContentHash, HASH, 'graph content hash'),
      graphSnapshotHash: matching(expected.graphSnapshotHash, HASH, 'graph snapshot hash'),
      linkReceiptsHash,
      memoryAccess,
      studyHash: matching(expected.studyHash, HASH, 'study hash'),
      taskContextHash,
    },
    expectedResume,
    maximumFollowupCalls,
    project: matching(packet.project, PROJECT, 'project'),
    prompt: boundedText(packet.prompt, 1, 4_096, 'prompt'),
    repositoryRoot: absolutePath(packet.repositoryRoot, 'repository root'),
    runNonce: matching(packet.runNonce, RUN_NONCE, 'run nonce'),
    runtimeManifestPath: absolutePath(packet.runtimeManifestPath, 'runtime manifest'),
    runtimeManifestSha256: matching(packet.runtimeManifestSha256, HASH, 'runtime manifest hash'),
    threadnoteAccount: matching(packet.threadnoteAccount, PROJECT, 'Threadnote account'),
    threadnoteExecutable: absolutePath(packet.threadnoteExecutable, 'Threadnote executable'),
    threadnoteExecutableSha256: matching(packet.threadnoteExecutableSha256, HASH, 'Threadnote executable hash'),
    threadnoteHome: absolutePath(packet.threadnoteHome, 'Threadnote home'),
    threadnoteUser: matching(packet.threadnoteUser, PROJECT, 'Threadnote user'),
    version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
  };
}

export function renderMatchedEvaluationRuntimeManifestV1(
  projectInput: string,
  repositoryRootInput: string,
  runNonceInput: string,
): string {
  const project = matching(projectInput, PROJECT, 'project');
  const repositoryRoot = absolutePath(repositoryRootInput, 'repository root');
  const runNonce = matching(runNonceInput, RUN_NONCE, 'run nonce');
  return `${JSON.stringify({
    matchedEvaluationRun: runNonce,
    projects: [
      {
        name: project,
        path: repositoryRoot,
        seed: [],
        uri: `threadnote://resources/repos/${project}`,
      },
    ],
    version: 1,
  })}\n`;
}

async function runThreadnoteContextBrief(
  packet: MatchedEvaluationContextProxyPacketV1,
  request: {readonly codeRefs: readonly string[]; readonly mode: (typeof MODES)[number]},
): Promise<Record<string, unknown>> {
  const result = await runThreadnoteTool(packet, 'context_brief', {
    budgetTokens: packet.budgetTokens,
    callerCwd: packet.repositoryRoot,
    ...(request.codeRefs.length === 0 ? {} : {codeRefs: request.codeRefs}),
    detail: packet.detail === 'source' ? 'source' : 'compact',
    mode: request.mode,
    project: packet.project,
    responseFormat: 'agent',
    task: packet.prompt,
  });
  if (result.isError === true) throw new Error('Threadnote Context Brief tool call returned an error.');
  const text = (result.content as readonly {readonly text?: string; readonly type: string}[]).flatMap(content =>
    content.type === 'text' && typeof content.text === 'string' ? [content.text] : [],
  );
  if (text.length !== 1) throw new Error('Threadnote Context Brief tool result must contain exactly one text payload.');
  try {
    return object(JSON.parse(text[0]) as unknown, 'Threadnote Context Brief');
  } catch (cause) {
    throw new Error('Threadnote returned invalid Context Brief JSON.', {cause});
  }
}

function threadnoteEnvironment(packet: MatchedEvaluationContextProxyPacketV1): Record<string, string> {
  return {
    CI: '1',
    HOME: packet.threadnoteHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: '/usr/bin:/bin',
    THREADNOTE_ACCOUNT: packet.threadnoteAccount,
    THREADNOTE_HOME: packet.threadnoteHome,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_USER: packet.threadnoteUser,
  };
}

async function assertRuntimeManifest(
  packet: MatchedEvaluationContextProxyPacketV1,
  preparedHome: string,
): Promise<void> {
  const canonical = await realpath(packet.runtimeManifestPath);
  const metadata = await stat(canonical);
  const isolatedRoot = dirname(packet.repositoryRoot);
  if (
    canonical !== packet.runtimeManifestPath ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Runtime manifest is not one canonical owner-only file.');
  }
  if (
    !isContained(isolatedRoot, canonical) ||
    isContained(packet.repositoryRoot, canonical) ||
    isContained(preparedHome, canonical)
  ) {
    throw new Error('Runtime manifest escaped its isolated private root.');
  }
  const bytes = await readFile(canonical);
  if (createHash('sha256').update(bytes).digest('hex') !== packet.runtimeManifestSha256) {
    throw new Error('Runtime manifest differs from the sealed artifact.');
  }
  const expected = renderMatchedEvaluationRuntimeManifestV1(packet.project, packet.repositoryRoot, packet.runNonce);
  if (!bytes.equals(Buffer.from(expected))) {
    throw new Error('Runtime manifest does not bind the isolated repository and run.');
  }
}

async function assertPinnedExecutable(path: string, expectedHash: string): Promise<void> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (canonical !== path || !metadata.isFile()) throw new Error('Threadnote executable is not one canonical file.');
  const digest = createHash('sha256')
    .update(await readFile(canonical))
    .digest('hex');
  if (digest !== expectedHash) throw new Error('Threadnote executable differs from the pinned artifact.');
}

function validatedCodeRef(value: string, root: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (CGS.test(normalized)) return normalized;
  if (!normalized || normalized.includes('\0') || isAbsolute(normalized)) invalid('code reference is invalid');
  const absolute = resolve(root, normalized);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    invalid('code reference escaped the repository');
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

export async function runMatchedEvaluationContextProxy(): Promise<void> {
  const packetPath = process.env[MATCHED_EVALUATION_CONTEXT_PACKET_ENV];
  if (!packetPath || !isAbsolute(packetPath)) throw new Error('Missing matched evaluation context packet.');
  const packet = parseMatchedEvaluationContextProxyPacketV1(JSON.parse(await readFile(packetPath, 'utf8')) as unknown);
  await unlink(packetPath);
  const server = new McpServer(
    {name: MATCHED_EVALUATION_CONTEXT_SERVER_NAME, version: String(MATCHED_EVALUATION_CONTEXT_PROXY_VERSION)},
    {capabilities: {tools: {listChanged: false}}},
  );
  const tools = new EffectSchemaSdkTools();
  let briefStarted = packet.initialBriefDelivery === 'preloaded';
  let briefReady = packet.initialBriefDelivery === 'preloaded';
  let followupCalls = 0;
  if (packet.initialBriefDelivery === 'mcp') {
    tools.register(
      'context_brief',
      {
        annotations: {destructiveHint: false, idempotentHint: true, readOnlyHint: true},
        description: 'Read the preregistered Threadnote graph and linked-memory context for this evaluation task.',
        inputSchema: MATCHED_EVALUATION_CONTEXT_INPUT_SCHEMA,
      },
      async request => {
        if (briefStarted) throw new Error('The initial context brief may only be requested once.');
        briefStarted = true;
        const result = await handleMatchedEvaluationContextRequest(packet, request);
        briefReady = true;
        return {content: [...result.content], _meta: result.meta};
      },
    );
  }
  const followups = [
    [
      'inspect_code_graph',
      MATCHED_EVALUATION_INSPECT_INPUT_SCHEMA,
      'Query or traverse the isolated prepared code graph. Omit budgetTokens unless requesting a smaller response; defaults are ceilings, not target sizes. Verify returned paths against current files after edits.',
    ],
    [
      'analyze_code_graph',
      MATCHED_EVALUATION_ANALYZE_INPUT_SCHEMA,
      'Analyze the existing prepared graph snapshot. No remote worksets or cold indexing.',
    ],
    [
      'recall_context',
      MATCHED_EVALUATION_RECALL_INPUT_SCHEMA,
      'Recall task-relevant memories from the isolated prepared memory store.',
    ],
    [
      'read_context',
      MATCHED_EVALUATION_READ_INPUT_SCHEMA,
      'Read a prepared memory URI returned by the brief or recall.',
    ],
  ] as const;
  for (const [name, inputSchema, description] of followups) {
    if (
      !matchedEvaluationContextTools(
        packet.detail,
        packet.initialBriefDelivery,
        packet.expectedResume?.requiredGraphQuery ?? null,
      ).includes(name)
    )
      continue;
    tools.register(
      name,
      {
        annotations: {destructiveHint: false, readOnlyHint: true},
        description,
        inputSchema,
      },
      async request => {
        if (!briefReady) throw new Error('Read the initial context brief before follow-up calls.');
        followupCalls += 1;
        assertMatchedEvaluationFollowupBudgetV1(packet, followupCalls);
        const result = await handleMatchedEvaluationFollowupRequest(packet, name, request);
        return {content: [...result.content], _meta: result.meta, ...(result.isError ? {isError: true} : {})};
      },
    );
  }
  tools.install(server);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 2 * 1_024 * 1_024}));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid('object has unsupported or missing fields');
  }
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : matching(value, HASH, label);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation context proxy: ${message}.`);
}

if (import.meta.main) await runMatchedEvaluationContextProxy();
