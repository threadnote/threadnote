import {Array as EffectArray} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, Schema} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import {parseRemoteShareAddress} from '@threadnote/memory/remote/address';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const EXPECTED_TOOLS = [
  'begin_cursor_attestation',
  'list_context',
  'memory_status',
  'read_context',
  'recall_context',
  'remember_context',
  'transition_handoff',
] as const;

type CanaryMode = 'concurrency' | 'read' | 'write';

interface CanaryConfig {
  readonly attestationId?: string;
  readonly endpoint: URL;
  readonly expectedUri?: string;
  readonly mode: CanaryMode;
  readonly project: string;
  readonly shareId: string;
  readonly token: string;
}

interface JsonRpcResponse {
  readonly error?: {readonly code?: number};
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly tools?: readonly {readonly name?: string}[];
  };
}

class CanaryFailure extends Schema.TaggedError<CanaryFailure, {readonly brand: unique symbol}>()('CanaryFailure', {
  code: Schema.String,
  message: Schema.String,
}) {
  static of(code: string): CanaryFailure {
    return CanaryFailure.make({code, message: code});
  }
}

async function run(signal: AbortSignal): Promise<{
  readonly checks: readonly {readonly name: string; readonly status: 'ok'}[];
  readonly mode: CanaryMode;
  readonly status: 'ok';
  readonly version: 1;
}> {
  const config = canaryConfig(process.env);
  const checks: {name: string; status: 'ok'}[] = [];
  const initialized = await rpc(config, signal, 'initialize', {
    capabilities: {},
    clientInfo: {name: 'threadnote-remote-memory-canary', version: '1.0.0'},
    protocolVersion: PROTOCOL_VERSION,
  });
  requireResult(initialized, 'initialize_failed');
  checks.push({name: 'initialize', status: 'ok'});

  const tools = requireResult(await rpc(config, signal, 'tools/list', {}), 'tools_list_failed').tools ?? [];
  const names = EffectArray.flatMap(tools, (tool, __effectArrayIndex) =>
    __effectArrayIndex in tools ? (typeof tool.name === 'string' ? [tool.name] : []) : [],
  ).sort(compareCodeUnits);
  if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort(compareCodeUnits))) {
    throw CanaryFailure.of('unexpected_tool_surface');
  }
  checks.push({name: 'tool_surface', status: 'ok'});

  requireToolSuccess(await callTool(config, signal, 'memory_status', {version: 1}), 'status_failed');
  checks.push({name: 'status', status: 'ok'});

  requireToolSuccess(
    await callTool(config, signal, 'recall_context', {
      limit: 1,
      project: config.project,
      query: 'threadnote remote canary fixture',
      version: 1,
    }),
    'recall_failed',
  );
  checks.push({name: 'bounded_recall', status: 'ok'});

  if (config.expectedUri) {
    const address = parseRemoteShareAddress(config.expectedUri);
    if (address.shareId !== config.shareId) throw CanaryFailure.of('expected_uri_share_mismatch');
    requireToolSuccess(
      await callTool(config, signal, 'read_context', {uri: config.expectedUri, version: 1}),
      'expected_read_failed',
    );
    checks.push({name: 'fresh_run_read', status: 'ok'});
  }

  if (config.mode === 'write' || config.mode === 'concurrency') {
    const marker = randomUuidV4();
    const topic = `canary-${marker}`;
    const written = requireToolSuccess(
      await callTool(
        config,
        signal,
        'remember_context',
        rememberArguments(config, topic, `Fixture canary ${marker}.`, marker),
      ),
      'write_failed',
    );
    const uri = structuredUri(config, written);
    requireToolSuccess(
      await callTool(config, signal, 'read_context', {uri, version: 1}),
      'fresh_run_write_read_failed',
    );
    checks.push({name: 'write_then_fresh_read', status: 'ok'});
  }

  if (config.mode === 'concurrency') {
    const race = randomUuidV4();
    const raceTopic = `race-${race}`;
    const raceResults = await Promise.all([
      callTool(
        config,
        signal,
        'remember_context',
        rememberArguments(config, raceTopic, `Fixture race A ${race}.`, `${race}-a`),
      ),
      callTool(
        config,
        signal,
        'remember_context',
        rememberArguments(config, raceTopic, `Fixture race B ${race}.`, `${race}-b`),
      ),
    ]);
    const winners = EffectArray.filter(
      raceResults,
      (result, __effectArrayIndex) => __effectArrayIndex in raceResults && !result.result?.isError,
    ).length;
    const conflicts = EffectArray.filter(
      raceResults,
      (result, __effectArrayIndex) => __effectArrayIndex in raceResults && toolErrorCode(result) === 'conflict',
    ).length;
    if (winners !== 1 || conflicts !== 1) throw CanaryFailure.of('cas_race_contract_failed');
    checks.push({name: 'single_topic_cas_race', status: 'ok'});

    const independent = randomUuidV4();
    const independentResults = await Promise.all([
      callTool(
        config,
        signal,
        'remember_context',
        rememberArguments(
          config,
          `independent-a-${independent}`,
          `Fixture independent A ${independent}.`,
          `${independent}-a`,
        ),
      ),
      callTool(
        config,
        signal,
        'remember_context',
        rememberArguments(
          config,
          `independent-b-${independent}`,
          `Fixture independent B ${independent}.`,
          `${independent}-b`,
        ),
      ),
    ]);
    if (EffectArray.some(independentResults, result => result.result?.isError === true || result.error !== undefined)) {
      throw CanaryFailure.of('independent_write_progress_failed');
    }
    checks.push({name: 'independent_write_progress', status: 'ok'});
  }

  return {checks, mode: config.mode, status: 'ok', version: 1};
}

function rememberArguments(
  config: CanaryConfig,
  topic: string,
  text: string,
  operationId: string,
): Readonly<Record<string, unknown>> {
  return {
    ...(config.attestationId ? {attestationId: config.attestationId} : {}),
    kind: 'durable',
    operationId,
    project: config.project,
    text,
    topic,
    version: 1,
  };
}

async function callTool(
  config: CanaryConfig,
  signal: AbortSignal,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<JsonRpcResponse> {
  return rpc(config, signal, 'tools/call', {arguments: arguments_, name});
}

async function rpc(
  config: CanaryConfig,
  signal: AbortSignal,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<JsonRpcResponse> {
  const response = await fetch(config.endpoint, {
    body: JSON.stringify({id: randomUuidV4(), jsonrpc: '2.0', method, params}),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'threadnote-share-id': config.shareId,
      'user-agent': 'threadnote-remote-memory-canary/1',
    },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw CanaryFailure.of(`http_${response.status}`);
  return boundedJson(response);
}

async function boundedJson(response: Response): Promise<JsonRpcResponse> {
  if (!response.body) throw CanaryFailure.of('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw CanaryFailure.of('response_too_large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isJsonRpcResponse(parsed)) throw CanaryFailure.of('invalid_json_response');
    return parsed;
  } catch {
    throw CanaryFailure.of('invalid_json_response');
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  if ('error' in value && value.error !== undefined) {
    if (typeof value.error !== 'object' || value.error === null || EffectArray.isArray(value.error)) return false;
    if ('code' in value.error && typeof value.error.code !== 'number') return false;
  }
  if ('result' in value && value.result !== undefined) {
    if (typeof value.result !== 'object' || value.result === null || EffectArray.isArray(value.result)) return false;
    if ('isError' in value.result && typeof value.result.isError !== 'boolean') return false;
    if ('tools' in value.result) {
      if (!EffectArray.isArray(value.result.tools)) return false;
      for (const tool of value.result.tools) {
        if (typeof tool !== 'object' || tool === null || EffectArray.isArray(tool)) return false;
        if ('name' in tool && typeof tool.name !== 'string') return false;
      }
    }
  }
  return true;
}

function requireResult(response: JsonRpcResponse, code: string): NonNullable<JsonRpcResponse['result']> {
  if (response.error || !response.result) throw CanaryFailure.of(code);
  return response.result;
}

function requireToolSuccess(response: JsonRpcResponse, code: string): NonNullable<JsonRpcResponse['result']> {
  const result = requireResult(response, code);
  if (result.isError) throw CanaryFailure.of(`${code}:${toolErrorCode(response) ?? 'tool_error'}`);
  return result;
}

function toolErrorCode(response: JsonRpcResponse): string | undefined {
  const structured = response.result?.structuredContent;
  if (!structured || typeof structured !== 'object' || !('code' in structured)) return undefined;
  return typeof structured.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(structured.code)
    ? structured.code
    : undefined;
}

function structuredUri(config: CanaryConfig, result: NonNullable<JsonRpcResponse['result']>): string {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object' || !('uri' in structured) || typeof structured.uri !== 'string') {
    throw CanaryFailure.of('write_receipt_missing_uri');
  }
  const address = parseRemoteShareAddress(structured.uri);
  if (address.shareId !== config.shareId) throw CanaryFailure.of('write_receipt_share_mismatch');
  return address.canonicalUri;
}

function required(value: string | undefined, name: string): string {
  const normalized = Effect2.pipe(value, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (!normalized) throw CanaryFailure.of(`missing_${Effect2.pipe(name, EffectString.replaceAll(' ', '_'))}`);
  return normalized;
}

function portable(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value))
    throw CanaryFailure.of(`invalid_${Effect2.pipe(name, EffectString.replaceAll(' ', '_'))}`);
  return value;
}

function optionalIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = Effect2.pipe(value, EffectString.trim);
  return normalized === '' ? undefined : portable(normalized, 'attestation_id');
}

function canaryConfig(environment: Readonly<Record<string, string | undefined>>): CanaryConfig {
  const token = required(environment.THREADNOTE_CANARY_ACCESS_TOKEN, 'access token');
  if (Buffer.byteLength(token, 'utf8') > 64 * 1024) throw CanaryFailure.of('access_token_too_large');
  return {
    attestationId: optionalIdentifier(environment.THREADNOTE_CANARY_ATTESTATION_ID),
    endpoint: canaryEndpoint(required(environment.THREADNOTE_CANARY_ENDPOINT, 'endpoint')),
    expectedUri:
      Effect2.pipe(environment.THREADNOTE_CANARY_EXPECT_URI, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || undefined,
    mode: canaryMode(environment.THREADNOTE_CANARY_MODE),
    project: portable(
      Effect2.pipe(environment.THREADNOTE_CANARY_PROJECT, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || 'threadnote-canary',
      'project',
    ),
    shareId: portable(required(environment.THREADNOTE_CANARY_SHARE_ID, 'share id'), 'share id'),
    token,
  };
}

function canaryMode(value: string | undefined): CanaryMode {
  const normalized =
    Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || 'read';
  if (normalized === 'read' || normalized === 'write' || normalized === 'concurrency') return normalized;
  throw CanaryFailure.of('invalid_mode');
}

function canaryEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw CanaryFailure.of('invalid_endpoint');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((!local && url.protocol !== 'https:') || (local && url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw CanaryFailure.of('insecure_endpoint');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw CanaryFailure.of('invalid_endpoint');
  }
  return url;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const canaryProgram = fromPromiseInterruptible(run, cause => cause).pipe(
  Effect.flatMap(result => Console.log(JSON.stringify(result))),
  Effect.catch(cause => {
    const code = Schema.is(CanaryFailure)(cause) ? cause.code : 'unexpected_failure';
    return Console.error(JSON.stringify({error: code, status: 'failed', version: 1})).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    );
  }),
);

BunRuntime.runMain(canaryProgram);
