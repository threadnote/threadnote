import {Array as EffectArray} from 'effect';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type {RemoteMemoryServiceConfig} from '@threadnote/remote-memory/config';
import {admitOrgCloudRequest, ORG_CLOUD_REPOSITORY_SET_HEADER} from '@threadnote/remote-memory/cloud_admission';
import {randomUuidV4} from '../crypto/uuid.js';
import {
  authorizeRemoteRequest,
  requestedRemoteShare,
  type AuthorizedRemotePrincipal,
} from '@threadnote/remote-memory/authorization';
import {completeCursorAttestation} from '@threadnote/remote-memory/cursor_oidc';
import {publicRemoteMemoryError, remoteMemoryError, type RemoteMemoryError} from '@threadnote/remote-memory/errors';
import {bearerTokenFromRequest, oauthChallenge, protectedResourceMetadata} from '@threadnote/remote-memory/oauth';
import type {LocalIdp} from './local_idp.js';
import {assertGitMemoryBinding} from '@threadnote/remote-memory/git/binding';
import {isLocalIdpPath} from './local_idp.js';
import type {RemoteMemoryServiceDependencies} from '@threadnote/remote-memory/service_types';
import {createRemoteMemoryMcpServer} from './tools.js';
import type {RemoteMemoryRequestExecution} from '@threadnote/remote-memory/request_execution';

import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface RemoteMemoryHttpHandlerOptions {
  readonly config: RemoteMemoryServiceConfig;
  readonly dependencies: RemoteMemoryServiceDependencies;
  readonly localIdp?: LocalIdp;
}

export function createRemoteMemoryHttpHandler(
  options: RemoteMemoryHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return request => handleRemoteMemoryHttpRequest(options, request);
}

export async function handleRemoteMemoryHttpRequest(
  options: RemoteMemoryHttpHandlerOptions,
  request: Request,
): Promise<Response> {
  const requestId = remoteRequestId(request);
  try {
    validateHost(request, options.config.allowedHosts);
    const path = new URL(request.url).pathname;
    if (path === '/healthz') return jsonResponse(200, {status: 'ok'}, requestId);
    if (path === '/readyz') {
      const ready = await withDeadline(options.config.requestTimeoutMilliseconds, request.signal, () =>
        options.dependencies.readiness(),
      );
      return jsonResponse(ready ? 200 : 503, {status: ready ? 'ready' : 'unavailable'}, requestId);
    }
    if (!options.config.globallyEnabled) {
      throw remoteMemoryError('service_unavailable', 'Remote memory traffic is disabled by the service kill switch.');
    }
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse(
        200,
        protectedResourceMetadata(options.config.publicBaseUrl, [options.config.accessTokenIssuer]),
        requestId,
      );
    }
    if (options.localIdp && isLocalIdpPath(path)) {
      const idpResponse = await options.localIdp.handle(request);
      if (idpResponse) return withRequestHeaders(idpResponse, requestId);
    }
    if (path === '/mcp') return await handleMcpRequest(options, request, requestId);
    if (path === '/attest/cursor/complete') {
      return await handleAttestationCompletion(options, request, requestId);
    }
    return jsonResponse(404, {error: 'not_found', requestId}, requestId);
  } catch (cause) {
    return publicErrorResponse(publicRemoteMemoryError(cause), requestId, options.config.publicBaseUrl);
  }
}

async function handleMcpRequest(
  options: RemoteMemoryHttpHandlerOptions,
  request: Request,
  requestId: string,
): Promise<Response> {
  const deadlineEpochMilliseconds = Date.now() + options.config.requestTimeoutMilliseconds;
  if (request.method !== 'POST') return methodNotAllowed(requestId);
  requireJsonContentType(request);
  validateOrigin(request, options.config.allowedOrigins, false);
  validateDeclaredBodySize(request, options.config.maxBodyBytes);
  const deadline = deadlineController(request.signal, options.config.requestTimeoutMilliseconds);
  const {controller} = deadline;
  const execution = {deadlineEpochMilliseconds, signal: controller.signal};
  try {
    const principal = await withDeadlineUntil(
      deadlineEpochMilliseconds,
      controller.signal,
      () => authenticateRequest(options, request, execution),
      false,
    );
    const body = await withDeadlineUntil(
      deadlineEpochMilliseconds,
      controller.signal,
      () => readBoundedJson(request, options.config.maxBodyBytes, controller.signal),
      false,
    );
    const server = createRemoteMemoryMcpServer({
      attestationAudience: options.config.attestationAudience,
      attestationCompletionUrl: new URL('/attest/cursor/complete', options.config.publicBaseUrl).toString(),
      dependencies: options.dependencies,
      requestContext: {
        deadlineEpochMilliseconds,
        principal,
        requestId,
        signal: controller.signal,
      },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      keepAliveMs: 0,
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      const response = await withDeadlineUntil(deadlineEpochMilliseconds, controller.signal, () =>
        transport.handleRequest(request, {parsedBody: body}),
      );
      const result = withRequestHeaders(response, requestId);
      const repositorySet = request.headers.get(ORG_CLOUD_REPOSITORY_SET_HEADER);
      if (repositorySet) {
        result.headers.set(ORG_CLOUD_REPOSITORY_SET_HEADER, repositorySet);
        result.headers.set('threadnote-share-id', principal.shareId);
        result.headers.set('threadnote-memory-authority', 'git');
      }
      return result;
    } finally {
      await Promise.allSettled([transport.close(), server.close()]);
    }
  } finally {
    deadline.dispose();
  }
}

async function handleAttestationCompletion(
  options: RemoteMemoryHttpHandlerOptions,
  request: Request,
  requestId: string,
): Promise<Response> {
  const deadlineEpochMilliseconds = Date.now() + options.config.requestTimeoutMilliseconds;
  if (request.method !== 'POST') return methodNotAllowed(requestId);
  requireJsonContentType(request);
  validateOrigin(request, options.config.allowedOrigins, false);
  validateDeclaredBodySize(request, options.config.maxBodyBytes);
  const deadline = deadlineController(request.signal, options.config.requestTimeoutMilliseconds);
  const {controller} = deadline;
  try {
    const body = await withDeadlineUntil(
      deadlineEpochMilliseconds,
      controller.signal,
      () => readBoundedJson(request, options.config.maxBodyBytes, controller.signal),
      false,
    );
    const input = attestationCompletionInput(body);
    const principal = await withDeadlineUntil(deadlineEpochMilliseconds, controller.signal, () =>
      options.dependencies.attestations.principalForChallenge(input.challengeId, {
        deadlineEpochMilliseconds,
        signal: controller.signal,
      }),
    );
    if (!principal) throw remoteMemoryError('forbidden', 'The Cursor attestation challenge is invalid or expired.');
    assertGitMemoryBinding(options.config.gitBinding, principal);
    const attestation = await withDeadlineUntil(deadlineEpochMilliseconds, controller.signal, () =>
      completeCursorAttestation(
        options.dependencies.attestations,
        options.dependencies.cursorTokens,
        principal,
        input,
        new Date(),
        {deadlineEpochMilliseconds, signal: controller.signal},
      ),
    );
    return jsonResponse(
      200,
      {attestationId: attestation.attestationId, expiresAt: attestation.expiresAt, requestId},
      requestId,
    );
  } finally {
    deadline.dispose();
  }
}

async function authenticateRequest(
  options: RemoteMemoryHttpHandlerOptions,
  request: Request,
  execution: RemoteMemoryRequestExecution,
): Promise<AuthorizedRemotePrincipal> {
  const token = bearerTokenFromRequest(request);
  const claims = await options.dependencies.oauthTokens.verify(token);
  const principal = await authorizeRemoteRequest(
    options.dependencies.authorization,
    claims,
    requestedRemoteShare(request),
    execution,
  );
  assertGitMemoryBinding(options.config.gitBinding, principal);
  return admitOrgCloudRequest(
    request,
    principal,
    options.config.canonicalStore === 'git' ? options.config.gitBinding : undefined,
  );
}

function validateHost(request: Request, allowedHosts: readonly string[]): void {
  const host = Effect.pipe(
    request.headers.get('host'),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  if (!host || !EffectArray.some(allowedHosts, allowed => Effect.pipe(allowed, EffectString.toLowerCase) === host)) {
    throw remoteMemoryError('forbidden', 'The request Host is not allowed.');
  }
}

function validateOrigin(request: Request, allowedOrigins: readonly string[], required: boolean): void {
  const raw = request.headers.get('origin');
  if (!raw) {
    if (required) throw remoteMemoryError('forbidden', 'The request Origin is required.');
    return;
  }
  let origin: string;
  try {
    const parsed = new URL(raw);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (
      (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      raw !== parsed.origin
    ) {
      throw new Error('not an exact origin');
    }
    origin = parsed.origin;
  } catch {
    throw remoteMemoryError('forbidden', 'The request Origin is invalid.');
  }
  if (!EffectArray.some(allowedOrigins, allowed => allowed === origin)) {
    throw remoteMemoryError('forbidden', 'The request Origin is not allowed.');
  }
}

function requireJsonContentType(request: Request): void {
  const value = Effect.pipe(
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    request.headers.get('content-type')?.split(';', 1)[0],
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  if (value !== 'application/json') {
    throw remoteMemoryError('invalid_request', 'The request Content-Type must be application/json.');
  }
}

function validateDeclaredBodySize(request: Request, maximum: number): void {
  const value = request.headers.get('content-length');
  if (!value) return;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw remoteMemoryError('invalid_request', 'Content-Length is invalid.');
  if (bytes > maximum) throw remoteMemoryError('invalid_request', 'The request body is too large.');
}

async function readBoundedJson(request: Request, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (!request.body) throw remoteMemoryError('invalid_request', 'A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, {once: true});
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw remoteMemoryError('invalid_request', 'The request body is too large.');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw remoteMemoryError('invalid_request', 'The request body is not valid JSON.');
  }
}

function attestationCompletionInput(value: unknown): {readonly challengeId: string; readonly token: string} {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) {
    throw remoteMemoryError('invalid_request', 'The attestation request must be a JSON object.');
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- The parsed request is arbitrary JSON, not a ReadonlyRecord.
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('challengeId') || !keys.includes('token')) {
    throw remoteMemoryError('invalid_request', 'The attestation request has unsupported fields.');
  }
  const challengeId = 'challengeId' in value ? value.challengeId : undefined;
  const token = 'token' in value ? value.token : undefined;
  if (typeof challengeId !== 'string' || !REQUEST_ID_PATTERN.test(challengeId)) {
    throw remoteMemoryError('invalid_request', 'The attestation challenge identifier is invalid.');
  }
  if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > 16 * 1024) {
    throw remoteMemoryError('invalid_request', 'The Cursor workload token is invalid.');
  }
  return {challengeId, token};
}

async function withDeadline<A>(milliseconds: number, signal: AbortSignal, run: () => Promise<A>): Promise<A> {
  return withDeadlineUntil(Date.now() + milliseconds, signal, run, false);
}

async function withDeadlineUntil<A>(
  deadlineEpochMilliseconds: number,
  signal: AbortSignal,
  run: () => Promise<A>,
  drainOnInterrupt = true,
): Promise<A> {
  if (signal.aborted) throw remoteMemoryError('service_unavailable', 'The remote request was cancelled.');
  const milliseconds = deadlineEpochMilliseconds - Date.now();
  if (milliseconds <= 0) throw remoteMemoryError('service_unavailable', 'The remote request deadline expired.');
  const operation = Promise.resolve().then(run);
  const settled = operation.then(
    value => ({kind: 'value' as const, value}),
    cause => ({cause, kind: 'error' as const}),
  );
  const deadline = Promise.withResolvers<{readonly cause: RemoteMemoryError; readonly kind: 'interrupted'}>();
  const timeout = setTimeout(
    () =>
      deadline.resolve({
        cause: remoteMemoryError('service_unavailable', 'The remote request deadline expired.'),
        kind: 'interrupted',
      }),
    milliseconds,
  );
  const cancellation = Promise.withResolvers<{readonly cause: RemoteMemoryError; readonly kind: 'interrupted'}>();
  const abort = () =>
    cancellation.resolve({
      cause: remoteMemoryError('service_unavailable', 'The remote request was cancelled.'),
      kind: 'interrupted',
    });
  signal.addEventListener('abort', abort, {once: true});
  const removeAbortListener = () => signal.removeEventListener('abort', abort);
  try {
    const winner = await Promise.race([settled, deadline.promise, cancellation.promise]);
    if (winner.kind === 'interrupted') {
      // A cancellation response is not observable until any mutation has
      // committed or rolled back, preventing a response-before-late-commit.
      if (drainOnInterrupt) await settled;
      throw winner.cause;
    }
    if (winner.kind === 'error') throw winner.cause;
    return winner.value;
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
  }
}

function deadlineController(
  parent: AbortSignal,
  milliseconds: number,
): {readonly controller: AbortController; readonly dispose: () => void} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', abort, {once: true});
  const timeout = setTimeout(abort, milliseconds);
  timeout.unref?.();
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener('abort', abort);
      controller.abort();
    },
  };
}

function remoteRequestId(request: Request): string {
  const supplied = Effect.pipe(request.headers.get('x-request-id'), effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUuidV4();
}

function methodNotAllowed(requestId: string): Response {
  return jsonResponse(405, {error: 'method_not_allowed', requestId}, requestId, {allow: 'POST'});
}

function publicErrorResponse(error: RemoteMemoryError, requestId: string, publicBaseUrl: URL): Response {
  const headers: Record<string, string> = {};
  if (error.status === 401) headers['www-authenticate'] = oauthChallenge(publicBaseUrl);
  if (error.code === 'rate_limited' && typeof error.details.retryAfterSeconds === 'number') {
    headers['retry-after'] = String(error.details.retryAfterSeconds);
  }
  return jsonResponse(error.status, {error: error.code, message: error.message, requestId}, requestId, headers);
}

function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'content-type': JSON_CONTENT_TYPE,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
      ...headers,
    },
    status,
  });
}

function withRequestHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-request-id', requestId);
  return new Response(response.body, {headers, status: response.status, statusText: response.statusText});
}
