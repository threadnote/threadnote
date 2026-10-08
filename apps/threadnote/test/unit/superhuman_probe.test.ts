import {describe, expect, it, vi} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import fc from 'fast-check';
import {Effect, Redacted} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  discoverSuperhumanTools,
  ProbeError,
  probeSuperhumanTools,
  SUPERHUMAN_MCP_URL,
} from '@threadnote/threadnote/superhuman/probe';

const token = Redacted.make('synthetic-private-token-123456');

function reply(id: unknown, result: unknown): Response {
  return Response.json({jsonrpc: '2.0', id, result});
}

function syntheticFetch(
  page: (cursor: string | undefined) => unknown,
  onRequest?: (method: string, init: RequestInit) => void,
): FetchLike {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {id?: unknown; method: string; params?: {cursor?: string}};
    onRequest?.(request.method, init ?? {});
    switch (request.method) {
      case 'initialize':
        return reply(request.id, {
          protocolVersion: '2025-03-26',
          capabilities: {tools: {}},
          serverInfo: {name: 'synthetic', version: '1'},
        });
      case 'notifications/initialized':
        return new Response(null, {status: 202});
      case 'tools/list':
        return reply(request.id, page(request.params?.cursor));
      default:
        throw new Error('unexpected method');
    }
  };
}

function tool(name: string, schema: Record<string, unknown> = {type: 'object'}) {
  return {name, inputSchema: schema, description: 'untrusted provider prose'};
}

async function errorCode(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeError);
    return (error as ProbeError).code;
  }
  throw new Error('expected probe failure');
}

describe('Superhuman Docs MCP discovery probe', () => {
  it('initializes and follows bounded tool pages without calling tools or disclosing the token', async () => {
    const methods: string[] = [];
    const catalog = await discoverSuperhumanTools(token, {
      fetch: syntheticFetch(
        cursor =>
          cursor === undefined
            ? {tools: [tool('read_a')], nextCursor: 'page-2'}
            : {tools: [tool('read_b', {type: 'object', properties: {id: {type: 'string'}}})]},
        (method, init) => {
          methods.push(method);
          expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${Redacted.value(token)}`);
          expect(init.redirect).toBe('manual');
        },
      ),
    });
    expect(catalog).toEqual({
      endpoint: SUPERHUMAN_MCP_URL,
      pages: 2,
      tools: [
        {name: 'read_a', inputSchema: {type: 'object'}},
        {name: 'read_b', inputSchema: {type: 'object', properties: {id: {type: 'string'}}}},
      ],
    });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(JSON.stringify(catalog)).not.toContain(Redacted.value(token));
  });

  it('rejects authentication without relaying provider text', async () => {
    const fetchImpl: FetchLike = async () => new Response('private provider diagnostic', {status: 401});
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: fetchImpl}))).toBe('authentication-rejected');
  });

  it('rejects redirects and oversized bodies', async () => {
    const redirect: FetchLike = async () =>
      new Response(null, {status: 302, headers: {Location: 'https://example.com'}});
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: redirect}))).toBe('transport-rejected');
    const oversize: FetchLike = async () =>
      new Response('x'.repeat(256 * 1024 + 1), {
        headers: {'content-type': 'application/json'},
      });
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: oversize}))).toBe('response-too-large');
  });

  it('rejects repeated cursors and excessive pages', async () => {
    const repeated = syntheticFetch(() => ({tools: [], nextCursor: 'same'}));
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: repeated}))).toBe('catalog-incomplete');
    let pageNumber = 0;
    const endless = syntheticFetch(() => ({tools: [], nextCursor: String(++pageNumber)}));
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: endless}))).toBe('catalog-incomplete');
  });

  it('rejects duplicate names, malformed schemas, and secret-bearing errors', async () => {
    const duplicate = syntheticFetch(() => ({tools: [tool('same'), tool('same')]}));
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: duplicate}))).toBe('catalog-invalid');
    const malformed = syntheticFetch(() => ({tools: [{name: 'bad', inputSchema: {type: 'string'}}]}));
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: malformed}))).toBe('transport-rejected');
    const failure: FetchLike = async () => {
      throw new Error(`private ${Redacted.value(token)}`);
    };
    const caught = await errorCode(discoverSuperhumanTools(token, {fetch: failure}));
    expect(caught).toBe('transport-rejected');
    expect(caught).not.toContain(Redacted.value(token));
  });

  it('does not compile provider output schemas or print unknown formats', async () => {
    const echoed = Redacted.value(token);
    const output: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      output.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      output.push(String(chunk));
      return true;
    });
    try {
      const fetchImpl = syntheticFetch(() => ({
        tools: [
          {
            ...tool('read'),
            outputSchema: {type: 'object', properties: {field: {type: 'string', format: echoed}}},
          },
        ],
      }));
      expect(await errorCode(discoverSuperhumanTools(token, {fetch: fetchImpl}))).toBe('catalog-invalid');
      expect(output.join('\n')).not.toContain(echoed);
      expect(output).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('accepts a matching SSE result while the provider stream remains open, then cancels it', async () => {
    let cancelled = 0;
    const json = syntheticFetch(() => ({tools: []}));
    const fetchImpl: FetchLike = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as {id?: unknown; method: string};
      if (request.method !== 'tools/list') return json(url, init);
      const event = `event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: request.id, result: {tools: [tool('sse_read')]}})}\n\n`;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event));
          },
          cancel() {
            cancelled += 1;
          },
        }),
        {headers: {'content-type': 'text/event-stream'}},
      );
    };
    const catalog = await discoverSuperhumanTools(token, {
      fetch: fetchImpl,
      requestTimeoutMs: 100,
      totalTimeoutMs: 500,
    });
    expect(catalog.tools.map(item => item.name)).toEqual(['sse_read']);
    expect(cancelled).toBe(1);
  });

  it('cancels a stalled response body on request deadline and public abort', async () => {
    for (const cancelViaPublicSignal of [false, true]) {
      let cancelled = 0;
      const publicController = new AbortController();
      const json = syntheticFetch(() => ({tools: []}));
      const fetchImpl: FetchLike = async (url, init) => {
        const request = JSON.parse(String(init?.body)) as {method: string};
        if (request.method !== 'tools/list') return json(url, init);
        if (cancelViaPublicSignal) queueMicrotask(() => publicController.abort());
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled += 1;
            },
          }),
          {
            headers: {'content-type': 'text/event-stream'},
          },
        );
      };
      expect(
        await errorCode(
          discoverSuperhumanTools(token, {
            fetch: fetchImpl,
            signal: publicController.signal,
            requestTimeoutMs: 20,
            totalTimeoutMs: 200,
          }),
        ),
      ).toBe('deadline-exceeded');
      expect(cancelled).toBe(1);
    }
  });

  it('counts UTF-8 SSE bytes before the SDK parser sees an oversized event', async () => {
    const json = syntheticFetch(() => ({tools: []}));
    const fetchImpl: FetchLike = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as {method: string};
      if (request.method !== 'tools/list') return json(url, init);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${'🌟'.repeat(70_000)}\n\n`));
          },
        }),
        {headers: {'content-type': 'text/event-stream'}},
      );
    };
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: fetchImpl}))).toBe('response-too-large');
  });

  it('caps aggregate response bytes across pages', async () => {
    let pageNumber = 0;
    const padded = syntheticFetch(() => ({
      tools: [],
      nextCursor: String(++pageNumber),
      ignoredProviderField: 'x'.repeat(240 * 1024),
    }));
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: padded}))).toBe('response-too-large');
  });

  it('projects only boolean tool hints', async () => {
    const catalog = await discoverSuperhumanTools(token, {
      fetch: syntheticFetch(() => ({
        tools: [
          {...tool('hinted'), annotations: {title: 'provider prose', readOnlyHint: true, destructiveHint: false}},
        ],
      })),
    });
    expect(catalog.tools[0]?.annotations).toEqual({readOnlyHint: true, destructiveHint: false});
    expect(JSON.stringify(catalog)).not.toContain('provider prose');
  });

  it('aborts an active request and closes on cancellation', async () => {
    const controller = new AbortController();
    let aborted = false;
    const hanging: FetchLike = async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('private synthetic abort detail'));
          },
          {once: true},
        );
        controller.abort();
      });
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: hanging, signal: controller.signal}))).toBe(
      'deadline-exceeded',
    );
    expect(aborted).toBe(true);
  });

  it('applies a per-request deadline to an unresponsive transport', async () => {
    let aborted = false;
    const hanging: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('private timeout detail'));
          },
          {once: true},
        );
      });
    expect(
      await errorCode(
        discoverSuperhumanTools(token, {
          fetch: hanging,
          requestTimeoutMs: 10,
          totalTimeoutMs: 100,
        }),
      ),
    ).toBe('deadline-exceeded');
    expect(aborted).toBe(true);
  });

  it('settles by the per-request deadline even when fetch ignores abort', async () => {
    const uncooperative: FetchLike = async () => new Promise<Response>(() => undefined);
    expect(
      await errorCode(
        discoverSuperhumanTools(token, {
          fetch: uncooperative,
          requestTimeoutMs: 10,
          totalTimeoutMs: 100,
        }),
      ),
    ).toBe('deadline-exceeded');
  });

  effectIt.effect('validates the environment reference before reading the environment', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const configuredSystem = SystemInfo.of({
        ...system,
        environment: () => {
          throw new Error('Environment must not be read');
        },
      });
      const error = yield* Effect.flip(probeSuperhumanTools('bad-reference')).pipe(
        Effect.provideService(SystemInfo, configuredSystem),
      );
      expect(error.code).toBe('invalid-credential-reference');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('reads only the named environment credential', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const configuredSystem = SystemInfo.of({
        ...system,
        environment: () => ({PROBE_TEST_TOKEN: Redacted.value(token)}),
      });
      const catalog = yield* probeSuperhumanTools('PROBE_TEST_TOKEN', {
        fetch: syntheticFetch(() => ({tools: [tool('read')]})),
      }).pipe(Effect.provideService(SystemInfo, configuredSystem));
      expect(catalog.tools.map(item => item.name)).toEqual(['read']);
      expect(JSON.stringify(catalog)).not.toContain(Redacted.value(token));
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('reports a missing named credential safely', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const configuredSystem = SystemInfo.of({
        ...system,
        environment: () => ({UNRELATED_TOKEN: Redacted.value(token)}),
      });
      const error = yield* Effect.flip(probeSuperhumanTools('PROBE_TEST_TOKEN')).pipe(
        Effect.provideService(SystemInfo, configuredSystem),
      );
      expect(error.code).toBe('missing-credential');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  it('never emits an echoed token for arbitrary schema placements', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({maxLength: 30}), async prefix => {
        const fetchImpl = syntheticFetch(() => ({
          tools: [
            tool('safe_name', {
              type: 'object',
              properties: {field: {type: 'string', default: `${prefix}${Redacted.value(token)}`}},
            }),
          ],
        }));
        expect(await errorCode(discoverSuperhumanTools(token, {fetch: fetchImpl}))).toBe('catalog-invalid');
      }),
      {numRuns: 25},
    );
  });

  it('never emits credentials containing JSON escape characters', async () => {
    const character = fc.constantFrom('a', 'Z', '0', '-', '_', '"', '\\');
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('"', '\\'),
        fc.array(character, {maxLength: 12}).map(parts => parts.join('')),
        async (escape, suffix) => {
          const secret = `synthetic${escape}${suffix}`;
          const credential = Redacted.make(secret);
          const fetchImpl = syntheticFetch(() => ({
            tools: [
              tool('safe', {
                type: 'object',
                properties: {[secret]: {type: 'string', default: secret}},
              }),
            ],
          }));
          expect(await errorCode(discoverSuperhumanTools(credential, {fetch: fetchImpl}))).toBe('catalog-invalid');
        },
      ),
      {numRuns: 30},
    );
  });

  it('blocks unrelated credential-shaped schema values after JSON decoding', async () => {
    const fetchImpl = syntheticFetch(() => ({
      tools: [
        tool('safe', {
          type: 'object',
          properties: {field: {type: 'string', default: 'prefix"github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'}},
        }),
      ],
    }));
    expect(await errorCode(discoverSuperhumanTools(token, {fetch: fetchImpl}))).toBe('catalog-invalid');
  });
});
