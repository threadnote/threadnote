import {describe, expect, it} from 'vitest';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {Redacted} from 'effect';
import fc from 'fast-check';
import {summarizeContractObservation} from '../src/contract-probe.js';
import {probeSelectedPageContractRaw, ProbeError} from '../src/probe.js';

const selectedUrl = 'https://docs.superhuman.com/d/Synthetic_do1/Page_pa1';
const token = Redacted.make('synthetic-contract-token');
const pageUri = 'coda://docs/do1/pages/pa1';
const docUri = 'coda://docs/do1';

function syntheticFetch(
  calls: Array<{name: string; args: Record<string, unknown>}>,
  decodedUri = pageUri,
  decodedDocUri = docUri,
): FetchLike {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id?: unknown;
      method: string;
      params?: {name: string; arguments: Record<string, unknown>};
    };
    if (request.method === 'initialize')
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {tools: {}},
          serverInfo: {name: 'synthetic', version: '1'},
        },
      });
    if (request.method === 'notifications/initialized') return new Response(null, {status: 202});
    if (request.method !== 'tools/call' || !request.params) throw new Error('unexpected request');
    calls.push({name: request.params.name, args: request.params.arguments});
    const value =
      request.params.name === 'url_convert'
        ? {result: {uri: decodedUri, docUri: decodedDocUri}}
        : request.params.name === 'tool_guide'
          ? {guidance: 'Markdown blocks use offset and limit.'}
          : request.params.name === 'document_outline'
            ? {pages: [{uri: pageUri, title: 'private title'}], totalCount: 1}
            : request.params.name === 'page_describe'
              ? {uri: pageUri, title: 'private title', revision: 'private-revision'}
              : {uri: pageUri, markdownBlocks: [{id: 'private-block-id', content: 'private body'}], totalCount: 1};
    return Response.json({jsonrpc: '2.0', id: request.id, result: {content: [], structuredContent: value}});
  };
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

describe('selected Superhuman page contract probe', () => {
  it('preserves embedded underscores when checking an explicit document ID', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const expectedDocumentId = 'Doc_Inner_S';
    const raw = await probeSelectedPageContractRaw(token, selectedUrl, 'primary', {
      expectedDocumentId,
      fetch: syntheticFetch(calls, `coda://docs/${expectedDocumentId}/pages/pa1`, `coda://docs/${expectedDocumentId}`),
    });
    expect(raw.scopeMatched).toBe(true);
  });

  it('rejects resolution to a different explicitly selected document before reads', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    expect(
      await errorCode(
        probeSelectedPageContractRaw(token, selectedUrl, 'primary', {
          expectedDocumentId: 'Different_Doc',
          fetch: syntheticFetch(calls),
        }),
      ),
    ).toBe('catalog-invalid');
    expect(calls.map(call => call.name)).toEqual(['tool_guide', 'url_convert']);
  });

  it('never exposes arbitrary provider strings or field names in structural diagnostics', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 200}), value => {
        const privateValue = `PRIVATE_VALUE_${value}`;
        const safe = JSON.stringify(
          summarizeContractObservation('identity', {
            scopeMatched: false,
            calls: [
              {
                name: 'url_convert',
                value: {
                  result: {
                    uri: privateValue,
                    docUri: privateValue,
                    [privateValue]: {content: [privateValue], title: privateValue, id: privateValue},
                  },
                },
              },
            ],
          }),
        );
        expect(safe).not.toContain(privateValue);
      }),
      {numRuns: 50},
    );
  });

  it('removes a block anchor before decoding the selected page URL', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const raw = await probeSelectedPageContractRaw(token, `${selectedUrl}#_block`, 'primary', {
      fetch: syntheticFetch(calls),
    });
    expect(raw.scopeMatched).toBe(true);
    expect(calls.find(call => call.name === 'url_convert')?.args.url).toBe(selectedUrl);
  });

  it('preserves provider URI context and compares document IDs independently of fragments', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const contextualPageUri = `${pageUri}#synthetic-page-context`;
    const contextualDocUri = `${docUri}#synthetic-document-context`;
    const raw = await probeSelectedPageContractRaw(token, selectedUrl, 'primary', {
      fetch: syntheticFetch(calls, contextualPageUri, contextualDocUri),
    });
    expect(raw.scopeMatched).toBe(true);
    expect(calls.find(call => call.name === 'document_outline')?.args.uri).toBe(contextualDocUri);
    expect(calls.find(call => call.name === 'page_describe')?.args.uri).toBe(contextualPageUri);
  });

  it('follows bounded redirects within the official MCP service without changing the call', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const normal = syntheticFetch(calls);
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as {method: string; params?: {name: string}};
      if (request.params?.name === 'page_describe') {
        urls.push(String(url));
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${Redacted.value(token)}`);
        if (String(url).endsWith('/apis/mcp'))
          return new Response(null, {status: 307, headers: {location: '/apis/mcp/synthetic-route'}});
      }
      return normal(url, init);
    };
    const raw = await probeSelectedPageContractRaw(token, selectedUrl, 'primary', {fetch: fetchImpl});
    expect(raw.scopeMatched).toBe(true);
    expect(urls).toEqual([
      'https://docs.superhuman.com/apis/mcp',
      'https://docs.superhuman.com/apis/mcp/synthetic-route',
    ]);
    expect(calls.filter(call => call.name === 'page_describe')).toHaveLength(1);
  });

  it('rejects redirects outside the MCP namespace and repeated redirect targets', async () => {
    for (const target of ['https://example.com/apis/mcp/route', '/login', '/apis/mcp/loop']) {
      const calls: Array<{name: string; args: Record<string, unknown>}> = [];
      const normal = syntheticFetch(calls);
      let redirects = 0;
      const fetchImpl: FetchLike = async (url, init) => {
        const request = JSON.parse(String(init?.body)) as {params?: {name: string}};
        if (request.params?.name === 'page_describe') {
          redirects++;
          return new Response(null, {status: 307, headers: {location: target}});
        }
        return normal(url, init);
      };
      expect(await errorCode(probeSelectedPageContractRaw(token, selectedUrl, 'primary', {fetch: fetchImpl}))).toBe(
        'transport-rejected',
      );
      expect(redirects).toBe(target.endsWith('/loop') ? 2 : 1);
    }
  });

  it('uses only five fixed read tools with selected document and page arguments', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const raw = await probeSelectedPageContractRaw(token, selectedUrl, 'primary', {fetch: syntheticFetch(calls)});
    expect(raw.scopeMatched).toBe(true);
    expect(raw.protocolVersion).toBe('2025-03-26');
    expect(calls).toEqual([
      {name: 'tool_guide', args: {topic: ['page', 'document', 'content']}},
      {name: 'url_convert', args: {action: 'decode', url: selectedUrl, scope: 'page'}},
      {name: 'document_outline', args: {uri: docUri, pageLimit: 1, pageOffset: 0, includePermissions: false}},
      {name: 'page_describe', args: {uri: pageUri}},
      {
        name: 'content_read',
        args: {uri: pageUri, contentTypesToInclude: ['markdown'], markdownBlockOffset: 0, markdownBlockLimit: 100},
      },
    ]);
    const safe = JSON.stringify(summarizeContractObservation('primary', raw));
    for (const privateValue of [
      'private title',
      'private body',
      'private-revision',
      'private-block-id',
      'do1',
      'pa1',
      Redacted.value(token),
    ]) {
      expect(safe).not.toContain(privateValue);
    }
    expect(safe).toContain('markdownBlocks');
    expect(JSON.parse(safe).protocolVersion).toBe('2025-03-26');
  });

  it('rejects a decoded page outside the selected URL before metadata or body reads', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    expect(
      await errorCode(
        probeSelectedPageContractRaw(token, selectedUrl, 'primary', {
          fetch: syntheticFetch(calls, 'coda://docs/other/pages/other'),
        }),
      ),
    ).toBe('catalog-invalid');
    expect(calls.map(call => call.name)).toEqual(['tool_guide', 'url_convert']);
  });

  it('keeps provider errors static and stops before a body read', async () => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const normal = syntheticFetch(calls);
    const fetchImpl: FetchLike = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as {method: string; params?: {name: string}};
      if (request.method === 'tools/call' && request.params?.name === 'page_describe') {
        calls.push({name: 'page_describe', args: {uri: pageUri}});
        return new Response('private provider detail', {status: 404});
      }
      return normal(url, init);
    };
    try {
      await probeSelectedPageContractRaw(token, selectedUrl, 'primary', {fetch: fetchImpl});
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProbeError);
      expect((error as ProbeError).code).toBe('transport-rejected');
      expect((error as ProbeError).operation).toBe('page_describe');
      expect(String(error)).not.toContain('private provider detail');
    }
    expect(calls.map(call => call.name)).toEqual(['tool_guide', 'url_convert', 'document_outline', 'page_describe']);
  });

  it('rejects other origins and credentials in the selected URL without network access', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      throw new Error('unexpected network');
    };
    expect(
      await errorCode(
        probeSelectedPageContractRaw(token, 'https://example.com/d/X_do1/Y_pa1', 'primary', {fetch: fetchImpl}),
      ),
    ).toBe('catalog-invalid');
    expect(
      await errorCode(
        probeSelectedPageContractRaw(token, 'https://user:pass@docs.superhuman.com/d/X_do1/Y_pa1', 'primary', {
          fetch: fetchImpl,
        }),
      ),
    ).toBe('catalog-invalid');
    expect(called).toBe(false);
  });
});
