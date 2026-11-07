import {beforeEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import type {PassThrough} from '@threadnote/testing/node-stream';
import {Array as EffectArray, Option as EffectOption, String as EffectString} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {fixtureTool} from './reviews.js';

interface MockMcp {
  stage: 'none' | 'connect' | 'tools-call';
  chunks: readonly Uint8Array[];
  failure: Error;
  events: string[];
  requests: {readonly request: unknown; readonly options: readonly unknown[]}[];
  producedBytes: number;
  resultIsError: boolean;
}

const mcp = vi.hoisted<MockMcp>(() => ({
  stage: 'none',
  chunks: [],
  failure: Object.assign(new Error('synthetic original MCP timeout'), {code: -32001}),
  events: [],
  requests: [],
  producedBytes: 0,
  resultIsError: false,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async importOriginal => {
  const original = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>();
  const {PassThrough} = await import('@threadnote/testing/node-stream');
  return {
    ...original,
    StdioClientTransport: class {
      readonly stderr = new PassThrough({highWaterMark: 1_024});
      close() {
        mcp.events.push('transport-close');
        this.stderr.destroy();
        return Promise.resolve();
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/index.js')>();
  return {
    ...original,
    Client: class {
      async connect(transport: {readonly stderr: PassThrough}) {
        mcp.events.push('connect');
        // A real unread PassThrough stalls this producer before connect can finish.
        for (const chunk of mcp.chunks) {
          await new Promise<void>((resolve, reject) => {
            transport.stderr.write(chunk, error => (error ? reject(error) : resolve()));
          });
          mcp.producedBytes += chunk.byteLength;
        }
        if (mcp.stage === 'connect') throw mcp.failure;
      }
      callTool(request: unknown, ...options: readonly unknown[]) {
        mcp.events.push('tools-call');
        mcp.requests.push({request, options});
        if (mcp.stage === 'tools-call') return Promise.reject(mcp.failure);
        return Promise.resolve({
          ...(mcp.resultIsError ? {isError: true} : {}),
          content: [{type: 'text', text: 'synthetic tool payload never copied to failure diagnostics'}],
          structuredContent: {synthetic: true},
        });
      }
      close() {
        mcp.events.push('client-close');
        return Promise.resolve();
      }
    },
  };
});

const manager = {environment: {}, home: '/synthetic-manager-home', root: '/synthetic-manager-root'};

async function failure(name = 'context_maintain', args: Record<string, unknown> = {action: 'run'}) {
  try {
    await fixtureTool(manager, name, args);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const start = EffectOption.getOrThrow(EffectString.indexOf('{')(error.message));
    const metadata: unknown = JSON.parse(EffectString.slice(start)(error.message));
    if (!isJsonObject(metadata)) throw new Error('Expected bounded fixture MCP metadata.', {cause: error});
    return {error, metadata};
  }
  throw new Error('Expected the synthetic MCP boundary to fail.');
}

beforeEach(() => {
  mcp.stage = 'none';
  mcp.chunks = [];
  mcp.events = [];
  mcp.requests = [];
  mcp.producedBytes = 0;
  mcp.resultIsError = false;
});

describe('Manager fixture MCP boundary', () => {
  it('drains more than the pipe high-water mark before connecting without changing success or cleanup', async () => {
    mcp.chunks = [Buffer.alloc(1_048_576, 65)];
    const result = await fixtureTool(manager, 'context_maintenance_status', {project: 'synthetic'});
    expect(result.structuredContent).toEqual({synthetic: true});
    expect(mcp.producedBytes).toBe(1_048_576);
    expect(mcp.events).toEqual(['connect', 'tools-call', 'client-close', 'transport-close']);
    expect(mcp.requests).toEqual([
      {request: {name: 'context_maintenance_status', arguments: {project: 'synthetic'}}, options: []},
    ]);
  });

  it('attributes a tool timeout with capped numeric stderr metadata and preserves its original cause', async () => {
    mcp.stage = 'tools-call';
    mcp.chunks = [Buffer.from(EffectString.repeat(65_536)('private-stderr-canary'))];
    const {error, metadata} = await failure();
    expect(error.cause).toBe(mcp.failure);
    expect(metadata).toMatchObject({
      tool: 'context_maintain',
      action: 'run',
      phase: 'tools-call',
      stderrBytesUpToLimit: 65_536,
      stderrLimit: 65_536,
      stderrDiscarded: true,
    });
    expect(metadata.elapsedMs).toEqual(expect.any(Number));
    expect(error.message).not.toContain('private-stderr-canary');
    expect(mcp.requests[0]?.options).toEqual([]);
    expect(mcp.events).toEqual(['connect', 'tools-call', 'client-close', 'transport-close']);
  });

  it('attributes connection failure without echoing an unrecognized tool, action or request payload', async () => {
    mcp.stage = 'connect';
    const {error, metadata} = await failure('private-tool-canary', {
      action: 'private-action-canary',
      text: 'private-prompt-canary',
    });
    expect(error.cause).toBe(mcp.failure);
    expect(metadata).toMatchObject({tool: 'other-fixture-tool', action: 'none', phase: 'connect'});
    for (const value of ['private-tool-canary', 'private-action-canary', 'private-prompt-canary'])
      expect(error.message).not.toContain(value);
    expect(mcp.requests).toEqual([]);
    expect(mcp.events).toEqual(['connect', 'client-close', 'transport-close']);
  });

  it('still rejects a tool error result without copying its payload into diagnostics', async () => {
    mcp.resultIsError = true;
    const {error, metadata} = await failure();
    expect(metadata.phase).toBe('tools-call');
    expect(error.message).not.toContain('synthetic tool payload');
    expect(error.cause).toEqual(new Error('Fixture MCP returned an error result.'));
  });

  it('keeps the discarded byte count independent of stderr chunk boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.uint8Array({maxLength: 2_048}), {minLength: 1, maxLength: 8}), async chunks => {
        mcp.stage = 'tools-call';
        mcp.chunks = chunks;
        const fragmented = (await failure()).metadata;
        mcp.chunks = [Buffer.concat(EffectArray.map(chunks, chunk => Buffer.from(chunk)))];
        const combined = (await failure()).metadata;
        expect(fragmented.stderrBytesUpToLimit).toBe(combined.stderrBytesUpToLimit);
        expect(fragmented.stderrDiscarded).toBe(true);
        expect(combined.stderrDiscarded).toBe(true);
      }),
      {numRuns: 12},
    );
  });
});
