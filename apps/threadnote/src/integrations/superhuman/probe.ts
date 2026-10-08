import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {SystemInfo} from '@threadnote/platform/system';
import {Data, Effect, Redacted} from 'effect';

export const SUPERHUMAN_MCP_URL = 'https://docs.superhuman.com/apis/mcp';
export const SUPERHUMAN_TOKEN_ENV = 'SUPERHUMAN_DOCS_API_TOKEN';

const REQUEST_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_PAGES = 8;
const MAX_TOOLS = 128;
const MAX_CURSOR_BYTES = 512;

export type ProbeErrorCode =
  | 'missing-credential'
  | 'invalid-credential-reference'
  | 'transport-rejected'
  | 'authentication-rejected'
  | 'response-too-large'
  | 'catalog-invalid'
  | 'catalog-incomplete'
  | 'deadline-exceeded'
  | 'provider-error'
  | 'quota-rejected';

export class ProbeError extends Data.TaggedError('ProbeError')<{
  readonly code: ProbeErrorCode;
  readonly operation?: 'tool_guide' | 'url_convert' | 'document_outline' | 'page_describe' | 'content_read';
}> {}

export interface ProbeTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface ProbeCatalog {
  readonly endpoint: typeof SUPERHUMAN_MCP_URL;
  readonly pages: number;
  readonly tools: readonly ProbeTool[];
}

export interface ProbeOptions {
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface SelectedPageProbeOptions extends ProbeOptions {
  readonly expectedDocumentId?: string;
}

type ProbePolicy =
  | {readonly kind: 'discovery'}
  | {readonly kind: 'selected-read'; readonly authorizeCall: (name: string, args: unknown) => boolean};

function failed(code: ProbeErrorCode): never {
  throw new ProbeError({code});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'object';
}

function checkedTool(value: unknown): ProbeTool {
  if (!isRecord(value) || typeof value.name !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(value.name)) {
    return failed('catalog-invalid');
  }
  if (!validSchema(value.inputSchema) || (value.outputSchema !== undefined && !validSchema(value.outputSchema))) {
    return failed('catalog-invalid');
  }
  const annotations: Record<string, boolean> = {};
  if (value.annotations !== undefined) {
    if (!isRecord(value.annotations)) return failed('catalog-invalid');
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      const hint = value.annotations[key];
      if (hint === undefined) continue;
      if (typeof hint !== 'boolean') return failed('catalog-invalid');
      annotations[key] = hint;
    }
  }
  return {
    name: value.name,
    inputSchema: value.inputSchema,
    ...(value.outputSchema === undefined ? {} : {outputSchema: value.outputSchema}),
    ...(Object.keys(annotations).length === 0 ? {} : {annotations}),
  };
}

function boundedTimeout(requested: number | undefined, maximum: number): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, maximum)
    : maximum;
}

function validateCatalog(catalog: ProbeCatalog, token: string): ProbeCatalog {
  const json = JSON.stringify(catalog);
  if (Buffer.byteLength(json, 'utf8') > MAX_CATALOG_BYTES) return failed('response-too-large');
  if (containsSensitiveText(catalog, token) || credentialScrubberBlocker(json) !== undefined)
    return failed('catalog-invalid');
  return catalog;
}

function containsSensitiveText(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token) || credentialScrubberBlocker(value) !== undefined;
  if (Array.isArray(value)) return value.some(item => containsSensitiveText(item, token));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => containsSensitiveText(key, token) || containsSensitiveText(item, token),
  );
}

function boundedResponse(
  response: Response,
  budget: {bytes: number},
  totalByteLimit: number,
  signal: AbortSignal,
  reportFailure: (code: ProbeErrorCode) => void,
): Response {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return failed('response-too-large');
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    return failed('transport-rejected');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let count = 0;
  let finished = false;
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stop = (error?: ProbeError) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
    if (error) {
      if (error.code !== 'deadline-exceeded') reportFailure(error.code);
      try {
        output.error(error);
      } catch {
        /* Already closed by the SDK. */
      }
    }
  };
  const onAbort = () => stop(new ProbeError({code: 'deadline-exceeded'}));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener('abort', onAbort, {once: true});
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finished = true;
          signal.removeEventListener('abort', onAbort);
          controller.close();
          return;
        }
        count += next.value.byteLength;
        budget.bytes += next.value.byteLength;
        if (count > MAX_RESPONSE_BYTES || budget.bytes > totalByteLimit) {
          stop(new ProbeError({code: 'response-too-large'}));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        stop(new ProbeError({code: 'transport-rejected'}));
      }
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {status: response.status, headers: response.headers});
}

async function withBoundedSession<T>(
  token: Redacted.Redacted<string>,
  options: ProbeOptions,
  policy: ProbePolicy,
  totalByteLimit: number,
  operation: (
    client: Client,
    withDeadline: <A>(action: () => Promise<A>) => Promise<A>,
    protocolVersion: string,
  ) => Promise<T>,
): Promise<T> {
  const secret = Redacted.value(token);
  if (secret.trim().length === 0) return failed('missing-credential');
  const endpoint = new URL(SUPERHUMAN_MCP_URL);
  if (endpoint.username || endpoint.password) return failed('transport-rejected');
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  const budget = {bytes: 0};
  const totalTimer = setTimeout(() => controller.abort(), boundedTimeout(options.totalTimeoutMs, TOTAL_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, {once: true});
  let activeRequest: AbortController | undefined;
  let requestTimedOut = false;
  let boundaryFailure: ProbeErrorCode | undefined;
  const withRequestDeadline = async <T>(action: () => Promise<T>): Promise<T> => {
    const request = new AbortController();
    activeRequest = request;
    const onTotalAbort = () => request.abort();
    controller.signal.addEventListener('abort', onTotalAbort, {once: true});
    const timer = setTimeout(
      () => {
        requestTimedOut = true;
        request.abort();
      },
      boundedTimeout(options.requestTimeoutMs, REQUEST_TIMEOUT_MS),
    );
    const deadline = Promise.withResolvers<never>();
    request.signal.addEventListener('abort', () => deadline.reject(new ProbeError({code: 'deadline-exceeded'})), {
      once: true,
    });
    try {
      return await Promise.race([deadline.promise, action()]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onTotalAbort);
      request.abort();
      activeRequest = undefined;
    }
  };
  const guardedFetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.href !== SUPERHUMAN_MCP_URL || url.username || url.password) return failed('transport-rejected');
    if (init?.method === 'GET') return new Response(null, {status: 405});
    if (init?.method !== 'POST' || typeof init.body !== 'string') return failed('transport-rejected');
    let message: unknown;
    try {
      message = JSON.parse(init.body);
    } catch {
      return failed('transport-rejected');
    }
    if (!isRecord(message)) return failed('transport-rejected');
    const method = message.method;
    const permitted =
      method === 'initialize' ||
      method === 'notifications/initialized' ||
      (policy.kind === 'discovery' && method === 'tools/list') ||
      (policy.kind === 'selected-read' &&
        method === 'tools/call' &&
        isRecord(message.params) &&
        typeof message.params.name === 'string' &&
        policy.authorizeCall(message.params.name, message.params.arguments));
    if (!permitted) {
      return failed('transport-rejected');
    }
    const requestSignal = activeRequest?.signal;
    if (!requestSignal) return failed('transport-rejected');
    const signal = init.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${secret}`);
    const requestInit = {
      ...init,
      headers,
      redirect: 'manual' as const,
      signal,
    };
    const visited = new Set([url.href]);
    let requestUrl = url;
    let response = await (options.fetch ?? fetch)(requestUrl, requestInit);
    for (let redirects = 0; response.status === 307 || response.status === 308; redirects++) {
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (redirects >= 2 || location === null) return failed('transport-rejected');
      const next = new URL(location, requestUrl);
      if (
        next.origin !== endpoint.origin ||
        !next.pathname.startsWith('/apis/mcp/') ||
        next.username ||
        next.password ||
        next.search ||
        next.hash ||
        visited.has(next.href)
      ) {
        return failed('transport-rejected');
      }
      visited.add(next.href);
      requestUrl = next;
      response = await (options.fetch ?? fetch)(requestUrl, requestInit);
    }
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      return failed('deadline-exceeded');
    }
    if (response.redirected || new URL(response.url || url.href).origin !== endpoint.origin) {
      void response.body?.cancel().catch(() => undefined);
      return failed('transport-rejected');
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return failed('authentication-rejected');
    }
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      return failed('quota-rejected');
    }
    return boundedResponse(response, budget, totalByteLimit, signal, code => {
      boundaryFailure = code;
      activeRequest?.abort();
    });
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: guardedFetch,
    reconnectionOptions: {
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({name: 'threadnote-superhuman-contract-probe', version: '0.1.0'}, {capabilities: {}});
  try {
    if (controller.signal.aborted) return failed('deadline-exceeded');
    const deadline = Promise.withResolvers<never>();
    controller.signal.addEventListener('abort', () => deadline.reject(new ProbeError({code: 'deadline-exceeded'})), {
      once: true,
    });
    return await Promise.race([
      deadline.promise,
      (async () => {
        await withRequestDeadline(() => client.connect(transport));
        const protocolVersion = transport.protocolVersion;
        if (protocolVersion === undefined || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
          return failed('catalog-invalid');
        }
        return operation(client, withRequestDeadline, protocolVersion);
      })(),
    ]);
  } catch (error) {
    if (boundaryFailure !== undefined) return failed(boundaryFailure);
    if (error instanceof ProbeError) throw error;
    return failed(controller.signal.aborted || requestTimedOut ? 'deadline-exceeded' : 'transport-rejected');
  } finally {
    clearTimeout(totalTimer);
    activeRequest?.abort();
    controller.abort();
    options.signal?.removeEventListener('abort', onAbort);
    await client.close().catch(() => undefined);
  }
}

export async function discoverSuperhumanTools(
  token: Redacted.Redacted<string>,
  options: ProbeOptions = {},
): Promise<ProbeCatalog> {
  return withBoundedSession(token, options, {kind: 'discovery'}, MAX_TOTAL_BYTES, async (client, withDeadline) => {
    const tools: ProbeTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) return failed('catalog-incomplete');
      const page = await withDeadline(() =>
        client.request({method: 'tools/list', params: cursor === undefined ? {} : {cursor}}, ListToolsResultSchema),
      );
      if (!Array.isArray(page.tools)) return failed('catalog-invalid');
      for (const item of page.tools) {
        const tool = checkedTool(item);
        if (names.has(tool.name)) return failed('catalog-invalid');
        names.add(tool.name);
        tools.push(tool);
        if (tools.length > MAX_TOOLS) return failed('catalog-incomplete');
      }
      const next = page.nextCursor;
      if (
        next !== undefined &&
        (typeof next !== 'string' ||
          next.length === 0 ||
          Buffer.byteLength(next) > MAX_CURSOR_BYTES ||
          cursors.has(next))
      )
        return failed('catalog-incomplete');
      if (next !== undefined) cursors.add(next);
      cursor = next;
    } while (cursor !== undefined);
    return validateCatalog({endpoint: SUPERHUMAN_MCP_URL, pages, tools}, Redacted.value(token));
  });
}

type ContractToolName = 'tool_guide' | 'url_convert' | 'document_outline' | 'page_describe' | 'content_read';

export interface RawContractObservation {
  readonly protocolVersion?: string;
  readonly calls: ReadonlyArray<{readonly name: ContractToolName; readonly value: unknown}>;
  readonly scopeMatched: boolean;
  readonly identitySignals?: {
    readonly pageUriFound: boolean;
    readonly declaredDocUriIsDoc?: boolean;
    readonly declaredDocMatchesParentIgnoringScheme?: boolean;
  };
}

export async function probeSelectedPageContractRaw(
  token: Redacted.Redacted<string>,
  selectedUrl: string,
  stage: 'identity' | 'primary',
  options: SelectedPageProbeOptions = {},
): Promise<RawContractObservation> {
  if (options.expectedDocumentId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.expectedDocumentId)) {
    return failed('catalog-invalid');
  }
  let selected: URL;
  try {
    selected = new URL(selectedUrl);
  } catch {
    return failed('catalog-invalid');
  }
  const segments = selected.pathname.split('/').filter(Boolean);
  if (
    selected.origin !== 'https://docs.superhuman.com' ||
    selected.username ||
    selected.password ||
    segments.length < 3 ||
    segments[0] !== 'd' ||
    !segments[1]?.includes('_') ||
    !segments[2]?.includes('_')
  ) {
    return failed('catalog-invalid');
  }
  selected.hash = '';
  const pageUrl = selected.href;
  let pageUri: string | undefined;
  let docUri: string | undefined;
  let calls = 0;
  const authorizeCall = (name: string, value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (name === 'tool_guide')
      return JSON.stringify(value) === JSON.stringify({topic: ['page', 'document', 'content']});
    if (name === 'url_convert') return value.action === 'decode' && value.url === pageUrl && value.scope === 'page';
    if (name === 'document_outline')
      return (
        docUri !== undefined &&
        value.uri === docUri &&
        value.pageLimit === 1 &&
        value.pageOffset === 0 &&
        value.includePermissions === false
      );
    if (name === 'page_describe') return pageUri !== undefined && value.uri === pageUri;
    if (name === 'content_read')
      return (
        pageUri !== undefined &&
        value.uri === pageUri &&
        JSON.stringify(value.contentTypesToInclude) === '["markdown"]' &&
        value.markdownBlockOffset === 0 &&
        value.markdownBlockLimit === 100 &&
        value.markdownBlockContentLimit === undefined &&
        value.markdownSearchTerms === undefined
      );
    return false;
  };
  return withBoundedSession(
    token,
    options,
    {kind: 'selected-read', authorizeCall},
    2 * MAX_TOTAL_BYTES,
    async (client, withDeadline, protocolVersion) => {
      const observations: Array<{name: ContractToolName; value: unknown}> = [];
      const read = async (name: ContractToolName, args: Record<string, unknown>): Promise<unknown> => {
        if (++calls > 16) return failed('catalog-incomplete');
        try {
          const response = await withDeadline(() =>
            client.request({method: 'tools/call', params: {name, arguments: args}}, CallToolResultSchema),
          );
          if (response.isError) throw new ProbeError({code: 'provider-error'});
          const value = response.structuredContent ?? parseToolText(response.content);
          observations.push({name, value});
          return value;
        } catch (error) {
          throw new ProbeError({
            code: error instanceof ProbeError ? error.code : 'transport-rejected',
            operation: name,
          });
        }
      };
      await read('tool_guide', {topic: ['page', 'document', 'content']});
      const decoded = await read('url_convert', {action: 'decode', url: pageUrl, scope: 'page'});
      const decodedResult = isRecord(decoded) && isRecord(decoded.result) ? decoded.result : decoded;
      pageUri = isRecord(decodedResult) ? findPageUri(decodedResult.uri) : undefined;
      const declaredDocUri = isRecord(decodedResult) ? decodedResult.docUri : undefined;
      if (!pageUri || typeof declaredDocUri !== 'string') {
        if (stage === 'identity')
          return {
            calls: observations,
            protocolVersion,
            scopeMatched: false,
            identitySignals: {
              pageUriFound: false,
            },
          };
        return failed('catalog-invalid');
      }
      const pagePath = pageUri.split('#')[0];
      const parentUri = pagePath?.slice(0, pagePath.indexOf('/pages/'));
      const declaredDocPath = declaredDocUri.split('#')[0];
      docUri = declaredDocUri;
      const identitySignals = {
        pageUriFound: true,
        declaredDocUriIsDoc: /^(?:coda|superhuman):\/\/docs\/[A-Za-z0-9_-]{1,128}(?:#[^\s]{1,2048})?$/.test(
          declaredDocUri,
        ),
        declaredDocMatchesParentIgnoringScheme:
          declaredDocPath?.replace(/^[^:]+:/, '') === parentUri?.replace(/^[^:]+:/, ''),
      };
      const scopeMatched =
        identitySignals.declaredDocUriIsDoc &&
        identitySignals.declaredDocMatchesParentIgnoringScheme &&
        (options.expectedDocumentId === undefined || parentUri?.endsWith(`/${options.expectedDocumentId}`));
      if (!scopeMatched && stage === 'identity')
        return {calls: observations, protocolVersion, scopeMatched: false, identitySignals};
      if (!scopeMatched) return failed('catalog-invalid');
      if (stage === 'primary') {
        await read('document_outline', {uri: docUri, pageLimit: 1, pageOffset: 0, includePermissions: false});
        await read('page_describe', {uri: pageUri});
        await read('content_read', {
          uri: pageUri,
          contentTypesToInclude: ['markdown'],
          markdownBlockOffset: 0,
          markdownBlockLimit: 100,
        });
      }
      return {calls: observations, protocolVersion, scopeMatched, identitySignals};
    },
  );
}

function parseToolText(content: ReadonlyArray<{readonly type: string; readonly text?: string}>): unknown {
  const texts = content.filter(item => item.type === 'text' && typeof item.text === 'string');
  if (texts.length !== 1) return failed('catalog-invalid');
  const text = texts[0]?.text;
  if (text === undefined) return failed('catalog-invalid');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findPageUri(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return /^(?:coda|superhuman):\/\/docs\/[A-Za-z0-9_-]{1,128}\/pages\/[A-Za-z0-9_-]{1,128}(?:#[^\s]{1,2048})?$/.test(
      value,
    )
      ? value
      : undefined;
  }
  if (Array.isArray(value)) return value.map(findPageUri).find(Boolean);
  if (!isRecord(value)) return undefined;
  return Object.values(value).map(findPageUri).find(Boolean);
}

export function probeSuperhumanTools(credentialEnvironmentName = SUPERHUMAN_TOKEN_ENV, options: ProbeOptions = {}) {
  return Effect.gen(function* () {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialEnvironmentName)) {
      return yield* new ProbeError({code: 'invalid-credential-reference'});
    }
    const system = yield* SystemInfo;
    const value = system.environment()[credentialEnvironmentName];
    if (value === undefined || value.trim().length === 0) {
      return yield* new ProbeError({code: 'missing-credential'});
    }
    const token = Redacted.make(value);
    return yield* fromPromiseInterruptible(
      signal => discoverSuperhumanTools(token, {...options, signal}),
      error => (error instanceof ProbeError ? error : new ProbeError({code: 'transport-rejected'})),
    );
  });
}
