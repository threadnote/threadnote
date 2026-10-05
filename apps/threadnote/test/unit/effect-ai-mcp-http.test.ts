import {Effect, Layer} from 'effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {McpSchema} from 'effect/ai';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  EffectMcpServerAdapter,
  type McpRequestContext,
  MCP_RESOURCE_ERROR_DATA,
} from '@threadnote/threadnote/effect/ai/mcp';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const HTTP_CONTEXT_TOOL = 'request_context_fixture';

interface JsonRpcResponse {
  readonly id?: number | string;
  readonly jsonrpc: '2.0';
  readonly result?: Record<string, unknown>;
}

interface McpHttpFixture {
  readonly dispose: () => Promise<void>;
  readonly handler: (request: Request) => Promise<Response>;
}

function makeFixture(allowedOrigins?: ReadonlyArray<string>): McpHttpFixture {
  const server = new EffectMcpServerAdapter('threadnote-memory-fixture', '1.0.0', 'Remote fixture instructions.');
  server.registerTool(
    HTTP_CONTEXT_TOOL,
    {
      annotations: {readOnlyHint: true},
      description: 'Return bounded request-context fixture data.',
      inputSchema: {},
    },
    (_arguments, {progress, requestContext}) => ({
      content: [{type: 'text', text: JSON.stringify(requestContext)}],
      structuredContent: {
        ...requestContext,
        progressEnabled: progress.enabled,
      },
    }),
  );
  server.registerResourceTemplate(
    {
      name: 'Invalid resource fixture',
      routerPath: '*',
      uriTemplate: 'threadnote://{+resourcePath}',
    },
    () =>
      Effect.fail(
        McpSchema.InvalidParams.make({
          data: MCP_RESOURCE_ERROR_DATA,
          message: 'Expected a canonical threadnote:// URI.',
        }),
      ),
  );
  const httpLayer = server
    .httpLayer({
      allowedOrigins,
      path: '/mcp',
      resolveRequestContext: request => {
        if (request.headers.authorization !== 'Bearer fixture-token') {
          return Effect.fail(
            HttpServerResponse.empty({
              headers: {'www-authenticate': 'Bearer resource_metadata="https://memory.example.test/.well-known"'},
              status: 401,
            }),
          );
        }
        return Effect.succeed({
          correlationId: request.headers['x-request-id'] ?? 'missing-request-id',
          deadlineEpochMilliseconds: 4_102_444_800_000,
          identity: {principalId: request.headers['x-principal'] ?? 'missing-principal'},
          policy: {version: request.headers['x-policy-version'] ?? 'fixture-policy'},
        });
      },
    })
    .pipe(Layer.provide(ApplicationLayer));
  return HttpRouter.toWebHandler(httpLayer, {disableLogger: true});
}

async function initialize(
  fixture: McpHttpFixture,
  protocolVersion = MCP_PROTOCOL_VERSION,
  origin?: string,
): Promise<string> {
  const response = await rpcRequest(
    fixture,
    {
      id: 1,
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: {name: 'threadnote-http-fixture', version: '1.0.0'},
        protocolVersion,
      },
    },
    {origin, protocolVersion},
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  expect(await response.json()).toMatchObject({
    id: 1,
    jsonrpc: '2.0',
    result: {
      capabilities: {resources: {listChanged: true, subscribe: false}, tools: {listChanged: true}},
      instructions: 'Remote fixture instructions.',
      protocolVersion,
      serverInfo: {name: 'threadnote-memory-fixture', version: '1.0.0'},
    },
  });
  return sessionId ?? '';
}

async function rpcRequest(
  fixture: McpHttpFixture,
  message: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
  options: {
    readonly principal?: string;
    readonly origin?: string;
    readonly protocolVersion?: string | null;
    readonly requestId?: string;
    readonly sessionId?: string;
    readonly token?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${options.token ?? 'fixture-token'}`,
    'content-type': 'application/json',
    'x-policy-version': 'policy-v1',
    'x-principal': options.principal ?? 'fixture-principal',
    'x-request-id': options.requestId ?? 'fixture-request',
  };
  if (options.protocolVersion !== null) {
    headers['mcp-protocol-version'] = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
  }
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.sessionId !== undefined) headers['mcp-session-id'] = options.sessionId;
  const body = Array.isArray(message) ? message.map(item => ({jsonrpc: '2.0', ...item})) : {jsonrpc: '2.0', ...message};
  return fixture.handler(
    new Request('https://memory.example.test/mcp', {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    }),
  );
}

async function callContextTool(
  fixture: McpHttpFixture,
  sessionId: string,
  principal: string,
  requestId: string,
): Promise<McpRequestContext & {readonly progressEnabled: boolean}> {
  const response = await rpcRequest(
    fixture,
    {
      id: requestId,
      method: 'tools/call',
      params: {_meta: {progressToken: `progress-${requestId}`}, arguments: {}, name: HTTP_CONTEXT_TOOL},
    },
    {principal, requestId, sessionId},
  );
  expect(response.status).toBe(200);
  const envelope = (await response.json()) as JsonRpcResponse;
  const result = envelope.result as {readonly structuredContent?: unknown};
  return result.structuredContent as McpRequestContext & {readonly progressEnabled: boolean};
}

describe('Effect MCP Streamable HTTP transport', () => {
  it('negotiates the MCP protocol and exposes only registered tools', async () => {
    const fixture = makeFixture();
    try {
      const sessionId = await initialize(fixture);
      const response = await rpcRequest(fixture, {id: 2, method: 'tools/list', params: {}}, {sessionId});

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: 2,
        jsonrpc: '2.0',
        result: {tools: [{name: HTTP_CONTEXT_TOOL}]},
      });

      const unsupportedVersion = await rpcRequest(
        fixture,
        {id: 3, method: 'tools/list', params: {}},
        {protocolVersion: '2099-01-01', sessionId},
      );
      expect(unsupportedVersion.status).toBe(400);

      const methodResponse = await fixture.handler(
        new Request('https://memory.example.test/mcp', {
          headers: {authorization: 'Bearer fixture-token'},
          method: 'GET',
        }),
      );
      expect(methodResponse.status).toBe(405);
      expect(methodResponse.headers.get('allow')).toBe('POST');
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects the whole MCP endpoint before initialization when request context cannot be established', async () => {
    const fixture = makeFixture();
    try {
      const response = await rpcRequest(
        fixture,
        {
          id: 1,
          method: 'initialize',
          params: {
            capabilities: {},
            clientInfo: {name: 'unauthorized-fixture', version: '1.0.0'},
            protocolVersion: MCP_PROTOCOL_VERSION,
          },
        },
        {token: 'wrong-token'},
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects browser origins by default and admits only an explicit allowlist', async () => {
    const origin = 'https://browser.example.test';
    const rejectedFixture = makeFixture();
    const allowedFixture = makeFixture([origin]);
    try {
      const rejected = await rpcRequest(
        rejectedFixture,
        {
          id: 1,
          method: 'initialize',
          params: {
            capabilities: {},
            clientInfo: {name: 'browser-fixture', version: '1.0.0'},
            protocolVersion: MCP_PROTOCOL_VERSION,
          },
        },
        {origin},
      );
      const sessionId = await initialize(allowedFixture, MCP_PROTOCOL_VERSION, origin);

      expect(rejected.status).toBe(403);
      expect(sessionId).not.toBe('');
    } finally {
      await Promise.all([rejectedFixture.dispose(), allowedFixture.dispose()]);
    }
  });

  it('serializes branded resource failures as their MCP protocol error over HTTP', async () => {
    const fixture = makeFixture();
    try {
      const sessionId = await initialize(fixture);
      const response = await rpcRequest(
        fixture,
        {id: 2, method: 'resources/read', params: {uri: 'threadnote://not-canonical'}},
        {sessionId},
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        error: {code: -32_602, message: 'Expected a canonical threadnote:// URI.'},
        id: 2,
        jsonrpc: '2.0',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('repairs every branded resource failure in an HTTP JSON-RPC batch', async () => {
    const fixture = makeFixture();
    try {
      const protocolVersion = '2025-03-26';
      const sessionId = await initialize(fixture, protocolVersion);
      const response = await rpcRequest(
        fixture,
        [
          {id: 2, method: 'resources/read', params: {uri: 'threadnote://not-canonical'}},
          {id: 'three', method: 'resources/read', params: {uri: 'threadnote://also-not-canonical'}},
        ],
        {protocolVersion, sessionId},
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          error: {code: -32_602, message: 'Expected a canonical threadnote:// URI.'},
          id: 2,
          jsonrpc: '2.0',
        },
        {
          error: {code: -32_602, message: 'Expected a canonical threadnote:// URI.'},
          id: 'three',
          jsonrpc: '2.0',
        },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['2024-11-05', '2025-06-18', '2025-11-25'])('rejects JSON-RPC batches for %s', async protocolVersion => {
    const fixture = makeFixture();
    try {
      const sessionId = await initialize(fixture, protocolVersion);
      const response = await rpcRequest(
        fixture,
        [
          {id: 2, method: 'tools/list', params: {}},
          {id: 3, method: 'tools/list', params: {}},
        ],
        {protocolVersion, sessionId},
      );

      expect(response.status).toBe(400);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['2024-11-05', '2025-03-26'])(
    'accepts %s session requests without a version header',
    async protocolVersion => {
      const fixture = makeFixture();
      try {
        const sessionId = await initialize(fixture, protocolVersion);
        const response = await rpcRequest(
          fixture,
          {id: 2, method: 'tools/list', params: {}},
          {
            protocolVersion: null,
            sessionId,
          },
        );

        expect(response.status).toBe(200);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(['2025-06-18', '2025-11-25'])(
    'requires the %s version header after initialization',
    async protocolVersion => {
      const fixture = makeFixture();
      try {
        const sessionId = await initialize(fixture, protocolVersion);
        const response = await rpcRequest(
          fixture,
          {id: 2, method: 'tools/list', params: {}},
          {
            protocolVersion: null,
            sessionId,
          },
        );

        expect(response.status).toBe(400);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it('rejects unsupported cross-POST cancellation instead of falsely acknowledging it', async () => {
    const fixture = makeFixture();
    try {
      const sessionId = await initialize(fixture);
      const cancellation = await rpcRequest(
        fixture,
        {method: 'notifications/cancelled', params: {requestId: 7}},
        {sessionId},
      );

      expect(cancellation.status).toBe(400);
      expect(await cancellation.json()).toEqual({
        error: {
          code: -32_600,
          message: 'Streamable HTTP cancellation is not supported until requests can be interrupted across POSTs.',
        },
        id: null,
        jsonrpc: '2.0',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects HTTP cancellation for every MCP request-id representation', async () => {
    const fixture = makeFixture();
    try {
      const sessionId = await initialize(fixture);
      await fc.assert(
        fc.asyncProperty(fc.oneof(fc.integer(), headerValue()), async requestId => {
          const cancellation = await rpcRequest(
            fixture,
            {method: 'notifications/cancelled', params: {requestId}},
            {sessionId},
          );

          expect(cancellation.status).toBe(400);
          expect(await cancellation.json()).toMatchObject({error: {code: -32_600}, id: null, jsonrpc: '2.0'});
        }),
        {numRuns: 20},
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps concurrent multi-user request context isolated and leaves stdio-only progress disabled', async () => {
    const fixture = makeFixture();
    try {
      const sessionId = await initialize(fixture);
      await fc.assert(
        fc.asyncProperty(headerValue(), headerValue(), async (first, second) => {
          const [firstResult, secondResult] = await Promise.all([
            callContextTool(fixture, sessionId, `principal-${first}`, `request-${first}`),
            callContextTool(fixture, sessionId, `principal-${second}`, `request-${second}`),
          ]);

          expect(firstResult).toMatchObject({
            correlationId: `request-${first}`,
            identity: {principalId: `principal-${first}`},
            policy: {version: 'policy-v1'},
            progressEnabled: false,
            transport: 'http',
          });
          expect(secondResult).toMatchObject({
            correlationId: `request-${second}`,
            identity: {principalId: `principal-${second}`},
            policy: {version: 'policy-v1'},
            progressEnabled: false,
            transport: 'http',
          });
        }),
        {numRuns: 20},
      );
    } finally {
      await fixture.dispose();
    }
  });
});

function headerValue(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {maxLength: 16, minLength: 1})
    .map(characters => characters.join(''));
}
