import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Redacted} from 'effect';
import {makeSuperhumanClientBudget, readSuperhumanDocument, SuperhumanClientError} from '../client.js';
import {renderSuperhumanDocument, splitUtf8, SuperhumanSecretBlocked} from '../render.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const page = {
  id: 'page_one',
  type: 'page',
  name: 'Notes',
  isHidden: false,
  isEffectivelyHidden: false,
  contentType: 'canvas',
  updatedAt: '2026-10-08T10:00:00Z',
};
const line = {id: 'line_one', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'hello'}};

function fixtureFetch(log: URL[], repeated = false) {
  return async (url: URL) => {
    log.push(url);
    if (url.pathname.endsWith('/content')) {
      if (url.searchParams.has('pageToken')) return json({items: [line]});
      return json({items: [], nextPageToken: 'opaque_cursor'});
    }
    if (url.pathname.endsWith('/pages/page_one')) return json(page);
    if (url.searchParams.has('pageToken'))
      return json({items: repeated ? [] : [page], ...(repeated ? {nextPageToken: 'same_cursor'} : {})});
    return json({items: [], nextPageToken: repeated ? 'same_cursor' : 'inventory_cursor'});
  };
}

describe('Superhuman read client', () => {
  it('enumerates inventory and content with token-only continuations', async () => {
    const calls: URL[] = [];
    const result = await readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {
      fetch: fixtureFetch(calls),
      maxRequests: 16,
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.lines[0]?.id).toBe('line_one');
    for (const url of calls.filter(url => url.searchParams.has('pageToken')))
      expect([...url.searchParams.keys()]).toEqual(['pageToken']);
    expect(calls.every(url => url.origin === 'https://docs.superhuman.com')).toBe(true);
  });

  it('rejects repeated cursors without publishing a partial snapshot', async () => {
    await expect(
      readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {
        fetch: fixtureFetch([], true),
        maxRequests: 16,
      }),
    ).rejects.toMatchObject({code: 'contract-incomplete'});
  });

  it('rejects a page metadata change across the content fence', async () => {
    let pageReads = 0;
    const calls: URL[] = [];
    const fetch = async (url: URL) => {
      if (url.pathname.endsWith('/pages/page_one')) {
        pageReads++;
        return json({...page, updatedAt: pageReads > 1 ? '2026-10-08T11:00:00Z' : page.updatedAt});
      }
      return fixtureFetch(calls)(url);
    };
    await expect(
      readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {fetch, maxRequests: 16}),
    ).rejects.toMatchObject({code: 'contract-incomplete'});
  });

  it('does not expose a remote error body or header in error text', async () => {
    const error = await readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {
      fetch: async () => json({secret: 'provider-secret'}, 403, {'x-secret': 'header-secret'}),
    }).catch(error => error);
    expect(error).toBeInstanceOf(SuperhumanClientError);
    expect(error.code).toBe('access-rejected');
    expect(JSON.stringify(error)).not.toMatch(/provider-secret|header-secret/);
  });

  it('makes no HTTP call after the shared budget expires', async () => {
    let calls = 0;
    const budget = makeSuperhumanClientBudget(20_000, 16);
    const expired = {...budget, deadlineAt: Date.now() - 1};
    await expect(
      readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {
        budget: expired,
        fetch: async () => {
          calls++;
          return json({items: []});
        },
      }),
    ).rejects.toMatchObject({code: 'deadline-exceeded'});
    expect(calls).toBe(0);
  });

  it('rejects exact transport-token reflection in selected title, style, body, and across lines', async () => {
    const credential = 'synthetic-token';
    const lineFor = (id: string, content: string, style = 'p') => ({
      id,
      type: 'line',
      itemContent: {style, format: 'plainText', content},
    });
    const cases = [
      {metadata: {...page, name: `title ${credential}`}, lines: [lineFor('one', 'safe')]},
      {metadata: page, lines: [lineFor('one', 'safe', `style ${credential}`)]},
      {metadata: page, lines: [lineFor('one', `body ${credential}`)]},
      {metadata: page, lines: [lineFor('one', 'synthetic'), lineFor('two', '-token')]},
    ];
    for (const example of cases) {
      const fetch = async (url: URL) =>
        url.pathname.endsWith('/content')
          ? json({items: example.lines})
          : url.pathname.endsWith('/pages/page_one')
            ? json(example.metadata)
            : json({items: [example.metadata]});
      const error = await readSuperhumanDocument(Redacted.make(credential), 'doc_one', undefined, false, {fetch}).catch(
        error => error,
      );
      expect(error).toMatchObject({code: 'credential-reflected'});
      expect(JSON.stringify(error)).not.toContain(credential);
    }
  });

  it('rejects a token formed when renderer removes terminal controls', async () => {
    const credential = 'synthetic-token';
    for (const field of ['title', 'style', 'body', 'split-lines'] as const) {
      const reflected = 'syntheti\u0001c-token';
      const metadata = field === 'title' ? {...page, name: reflected} : page;
      const lines =
        field === 'style'
          ? [{id: 'one', type: 'line', itemContent: {style: reflected, format: 'plainText', content: 'safe'}}]
          : field === 'split-lines'
            ? [
                {id: 'one', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'syntheti\u0001'}},
                {id: 'two', type: 'line', itemContent: {style: 'p', format: 'plainText', content: 'c-token'}},
              ]
            : [
                {
                  id: 'one',
                  type: 'line',
                  itemContent: {style: 'p', format: 'plainText', content: field === 'body' ? reflected : 'safe'},
                },
              ];
      const fetch = async (url: URL) =>
        url.pathname.endsWith('/content')
          ? json({items: lines})
          : url.pathname.endsWith('/pages/page_one')
            ? json(metadata)
            : json({items: [metadata]});
      const error = await readSuperhumanDocument(Redacted.make(credential), 'doc_one', undefined, false, {fetch}).catch(
        error => error,
      );
      expect(error).toMatchObject({code: 'credential-reflected'});
      expect(JSON.stringify(error)).not.toContain(credential);
    }
  });

  it('rechecks complete ordered content when page revision is absent', async () => {
    const revisionless = {...page, updatedAt: undefined};
    let observations = 0;
    const fetch = async (url: URL) => {
      if (url.pathname.endsWith('/content')) {
        if (url.searchParams.has('pageToken'))
          return json({
            items: [
              {
                ...line,
                id: 'second',
                itemContent: {...line.itemContent, content: observations === 1 ? 'stable' : 'changed'},
              },
            ],
          });
        observations++;
        return json({items: [line], nextPageToken: `cursor_${observations}`});
      }
      return url.pathname.endsWith('/pages/page_one') ? json(revisionless) : json({items: [revisionless]});
    };
    await expect(
      readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {fetch}),
    ).rejects.toMatchObject({code: 'contract-incomplete'});
    expect(observations).toBe(2);
  });

  it('retains a valid Retry-After longer than one hour without waiting', async () => {
    const error = await readSuperhumanDocument(Redacted.make('synthetic-token'), 'doc_one', undefined, false, {
      fetch: async () => json({}, 429, {'retry-after': '7200'}),
    }).catch(error => error);
    expect(error).toMatchObject({code: 'quota-rejected', retryAfterMilliseconds: 7_200_000});
  });
});

describe('Superhuman deterministic rendering', () => {
  const snapshot = (content: string) => ({
    documentId: 'doc_one',
    requests: 1,
    responseBytes: 1,
    excluded: [],
    missingSelectedPageIds: [],
    pages: [
      {
        page: {
          id: 'page_one',
          name: 'Notes',
          isHidden: false,
          isEffectivelyHidden: false,
          contentType: 'canvas' as const,
        },
        lines: [{id: 'line_one', style: 'p', content}],
      },
    ],
  });

  it('blocks a credential split across two page lines before chunking', () => {
    const selected = snapshot('github_pat_1234567890');
    selected.pages[0].lines.push({id: 'line_two', style: 'p', content: '12345678901234567890'});
    expect(() => renderSuperhumanDocument(selected)).toThrow(SuperhumanSecretBlocked);
  });

  it('keeps byte-bounded split parts exact across Unicode input', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 300}), text => {
        const pieces = splitUtf8(text, 11);
        expect(pieces.join('')).toBe(text);
        expect(pieces.every(piece => Buffer.byteLength(piece) <= 11)).toBe(true);
      }),
      {numRuns: 80},
    );
  });

  it('keeps chunk identities stable for identical line IDs after a title change', () => {
    const original = renderSuperhumanDocument(snapshot('hello'));
    const renamed = snapshot('hello');
    renamed.pages[0].page.name = 'Renamed';
    expect(renderSuperhumanDocument(renamed)[0]?.chunkId).toBe(original[0]?.chunkId);
  });

  it('strips terminal controls from plaintext while preserving Unicode, newlines and tabs', () => {
    const chunks = renderSuperhumanDocument(snapshot('é\r\n\tworld\u001b]52;c;injected\u0007'));
    expect(chunks[0]?.body).toContain('é\n\tworld');
    expect(chunks[0]?.body).not.toContain('\u001b');
    expect(chunks[0]?.body).not.toContain('\u0007');
  });

  it('renders identical safe snapshots deterministically and respects the byte budget', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 500}), content => {
        const input = snapshot(content);
        const first = renderSuperhumanDocument(input);
        expect(renderSuperhumanDocument(input)).toEqual(first);
        expect(first.every(chunk => Buffer.byteLength(chunk.body) < 17 * 1024)).toBe(true);
        expect(
          first.every(chunk =>
            [...chunk.body].every(character => {
              const code = character.charCodeAt(0);
              return (code >= 32 || code === 10 || code === 9) && (code < 127 || code > 159);
            }),
          ),
        ).toBe(true);
      }),
      {numRuns: 80},
    );
  });
});
