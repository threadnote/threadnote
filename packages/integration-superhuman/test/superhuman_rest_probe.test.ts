import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Redacted} from 'effect';
import {probeSuperhumanRestPage, RestProbeError, SUPERHUMAN_REST_URL} from '../src/rest-probe.js';

const token = Redacted.make('synthetic-secret-token');
const selected = 'https://docs.superhuman.com/d/_dDoc/Selected_sPage#_selected';

function page(id: string, hidden = false) {
  return {
    id,
    type: 'page',
    name: 'private page title',
    isHidden: hidden,
    isEffectivelyHidden: hidden,
    contentType: 'canvas',
    children: [],
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function line(id: string, content: string) {
  return {id, type: 'line', itemContent: {style: 'paragraph', format: 'plainText', content}};
}

function harness(
  lines: readonly ReturnType<typeof line>[],
  options: {
    pages?: readonly ReturnType<typeof page>[];
    documentId?: string;
    onRequest?: (url: URL, init: RequestInit) => void;
  } = {},
) {
  const documentId = options.documentId ?? 'Doc';
  const pageHref = `${SUPERHUMAN_REST_URL}/docs/${documentId}/pages/canvas-Page`;
  const pagesPath = `/apis/v1/docs/${documentId}/pages`;
  const pages = options.pages ?? [page('canvas-Page'), page('canvas-Other', true), page('canvas-Third')];
  const contentTokens = new Map<string, {index: number; limit: number}>();
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    options.onRequest?.(url, init);
    if (url.searchParams.has('pageToken') && [...url.searchParams.keys()].length !== 1)
      return new Response('Pagination continuation cannot repeat initial query options', {status: 400});
    if (url.pathname.endsWith('/resolveBrowserLink'))
      return Response.json({
        type: 'apiLink',
        href: url.href,
        resource: {type: 'page', id: 'canvas-Page', href: pageHref},
      });
    if (url.pathname === `${pagesPath}/canvas-Page`) return Response.json(page('canvas-Page'));
    if (url.pathname === pagesPath) {
      const index = Number(url.searchParams.get('pageToken') ?? 0);
      const items = pages.slice(index, index + 2);
      return Response.json({items, nextPageToken: index + 2 < pages.length ? String(index + 2) : undefined});
    }
    if (url.pathname.endsWith('/content')) {
      const continuation = contentTokens.get(url.searchParams.get('pageToken') ?? '');
      const index = continuation?.index ?? 0;
      const limit = continuation?.limit ?? Number(url.searchParams.get('limit'));
      const items = lines.slice(index, index + limit);
      const nextToken = `content-${index + limit}-${limit}`;
      contentTokens.set(nextToken, {index: index + limit, limit});
      return Response.json({
        items,
        href: url.href,
        nextPageToken: index + limit < lines.length ? nextToken : undefined,
      });
    }
    throw new Error('unexpected route');
  };
  return fetchImpl;
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(RestProbeError);
    return (error as RestProbeError).code;
  }
  throw new Error('expected failure');
}

describe('Superhuman Docs REST selected-page contract probe', () => {
  it('sends only the opaque page token when continuing a paginated request', async () => {
    const continuationOptions: string[][] = [];
    const summary = await probeSuperhumanRestPage(token, selected, {
      fetch: harness([line('cl-1', 'first'), line('cl-2', 'second'), line('cl-3', 'third')], {
        onRequest(url) {
          if (url.searchParams.has('pageToken')) continuationOptions.push([...url.searchParams.keys()]);
        },
      }),
    });
    expect(summary.content.orderedEqual).toBe(true);
    expect(continuationOptions).toEqual([['pageToken'], ['pageToken'], ['pageToken']]);
  });

  it('returns a static probe error for malformed resolved resource URLs', async () => {
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: async () =>
            Response.json({type: 'apiLink', resource: {type: 'page', id: 'canvas-Page', href: 'http://['}}),
        }),
      ),
    ).toBe('transport-rejected');
  });

  it('uses fixed GET routes, follows page and content cursors, and emits only safe structural evidence', async () => {
    const paths: string[] = [];
    const lines = [
      line('cl-1', 'private body one'),
      line('cl-2', 'private body two'),
      line('cl-3', 'private body three'),
    ];
    const summary = await probeSuperhumanRestPage(token, selected, {
      fetch: harness(lines, {
        onRequest(url, init) {
          paths.push(url.pathname);
          expect(init.method).toBe('GET');
          expect(init.redirect).toBe('manual');
          expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${Redacted.value(token)}`);
          expect(url.origin).toBe('https://docs.superhuman.com');
        },
      }),
    });
    expect(summary).toMatchObject({
      resolution: {pageResource: true, stableIdMatch: true},
      inventory: {complete: true, pages: 3, batches: 2, selectedIncluded: true, hiddenPages: 1},
      content: {complete: true, items: 3, fullBatches: 1, smallBatches: 3, orderedEqual: true},
    });
    expect(paths).toEqual([
      '/apis/v1/resolveBrowserLink',
      '/apis/v1/docs/Doc/pages/canvas-Page',
      '/apis/v1/docs/Doc/pages',
      '/apis/v1/docs/Doc/pages',
      '/apis/v1/docs/Doc/pages/canvas-Page/content',
      '/apis/v1/docs/Doc/pages/canvas-Page/content',
      '/apis/v1/docs/Doc/pages/canvas-Page/content',
      '/apis/v1/docs/Doc/pages/canvas-Page/content',
    ]);
    const output = JSON.stringify(summary);
    for (const privateText of [selected, 'canvas-Page', 'private body', 'private page title', Redacted.value(token)])
      expect(output).not.toContain(privateText);
  });

  it('rejects credentials, alternate origins, and malformed selected URLs before network access', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error('unexpected');
    };
    for (const url of [
      'https://elsewhere.example/d/_dDoc/Selected_sPage#_selected',
      'https://user:pass@docs.superhuman.com/d/_dDoc/Selected_sPage#_selected',
      'https://docs.superhuman.com/apis/v1/whoami#_selected',
      'https://docs.superhuman.com/d/_dDoc',
    ])
      expect(await code(probeSuperhumanRestPage(token, url, {fetch: fetchImpl}))).toBe('invalid-selected-url');
    expect(calls).toBe(0);
  });

  it('resolves anchored and unanchored page URLs through the same canonical browser link', async () => {
    const resolvedUrls: string[] = [];
    const fetchImpl = harness([], {
      pages: [page('canvas-Page')],
      onRequest(url) {
        if (url.pathname.endsWith('/resolveBrowserLink')) resolvedUrls.push(url.searchParams.get('url') ?? '');
      },
    });
    const unanchored = 'https://docs.superhuman.com/d/_dDoc/Selected_sPage';
    await probeSuperhumanRestPage(token, unanchored, {fetch: fetchImpl});
    await probeSuperhumanRestPage(token, `${unanchored}#_block`, {fetch: fetchImpl});
    expect(resolvedUrls).toEqual([unanchored, unanchored]);
  });

  it('uses resolved IDs with internal underscores and gates the expected doc before metadata reads', async () => {
    const url = 'https://docs.superhuman.com/d/_dDoc_Inner_S/Selected_sPage#_selected';
    const paths: string[] = [];
    const fetchImpl = harness([line('cl-1', 'private body')], {
      documentId: 'Doc_Inner_S',
      pages: [page('canvas-Page')],
      onRequest(request) {
        paths.push(request.pathname);
      },
    });
    const summary = await probeSuperhumanRestPage(token, url, {
      expectedDocumentId: 'Doc_Inner_S',
      fetch: fetchImpl,
    });
    expect(summary.content.orderedEqual).toBe(true);
    expect(paths).toContain('/apis/v1/docs/Doc_Inner_S/pages/canvas-Page');
    expect(JSON.stringify(summary)).not.toContain('Doc_Inner_S');
    paths.length = 0;
    expect(
      await code(probeSuperhumanRestPage(token, url, {expectedDocumentId: 'Different_Doc', fetch: fetchImpl})),
    ).toBe('scope-mismatch');
    expect(paths).toEqual(['/apis/v1/resolveBrowserLink']);
  });

  it('classifies authorization, quota, redirect, and oversize failures without provider text', async () => {
    for (const [status, expected] of [
      [401, 'authentication-rejected'],
      [403, 'access-rejected'],
      [404, 'not-found'],
      [429, 'quota-rejected'],
    ] as const) {
      expect(
        await code(
          probeSuperhumanRestPage(token, selected, {
            fetch: async () => new Response(`private ${Redacted.value(token)}`, {status}),
          }),
        ),
      ).toBe(expected);
    }
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: async () =>
            new Response(null, {status: 302, headers: {location: 'https://evil.example/apis/v1/whoami'}}),
        }),
      ),
    ).toBe('transport-rejected');
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: async () =>
            new Response(null, {status: 302, headers: {location: 'https://docs.superhuman.com/apis/v1/whoami'}}),
        }),
      ),
    ).toBe('transport-rejected');
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: async () => new Response('x'.repeat(256 * 1024 + 1), {headers: {'content-type': 'application/json'}}),
        }),
      ),
    ).toBe('response-too-large');
  });

  it('rejects repeated cursors, duplicate IDs, and an unlisted selected page', async () => {
    const repeated = harness([], {onRequest() {}});
    const repeatedFetch = async (url: URL, init: RequestInit) => {
      if (url.pathname === '/apis/v1/docs/Doc/pages')
        return Response.json({items: [page('canvas-Page')], nextPageToken: 'same'});
      return repeated(url, init);
    };
    expect(await code(probeSuperhumanRestPage(token, selected, {fetch: repeatedFetch}))).toBe('contract-incomplete');
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: harness([], {pages: [page('canvas-Page'), page('canvas-Page')]}),
        }),
      ),
    ).toBe('contract-incomplete');
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: harness([], {pages: [page('canvas-Other')]}),
        }),
      ),
    ).toBe('contract-incomplete');
  });

  it('terminates when fetch or a body reader ignores cancellation', async () => {
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: async () => new Promise<Response>(() => undefined),
          requestTimeoutMs: 10,
          totalTimeoutMs: 30,
        }),
      ),
    ).toBe('deadline-exceeded');
    let cancelled = false;
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          fetch: async () =>
            new Response(
              new ReadableStream({
                pull() {
                  return new Promise<void>(() => undefined);
                },
                cancel() {
                  cancelled = true;
                },
              }),
              {headers: {'content-type': 'application/json'}},
            ),
          requestTimeoutMs: 10,
          totalTimeoutMs: 30,
        }),
      ),
    ).toBe('deadline-exceeded');
    expect(cancelled).toBe(true);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    expect(
      await code(
        probeSuperhumanRestPage(token, selected, {
          signal: controller.signal,
          fetch: async () => {
            calls++;
            throw new Error('unexpected');
          },
        }),
      ),
    ).toBe('deadline-exceeded');
    expect(calls).toBe(0);
  });

  it('reports changed content between complete pagination passes without disclosing either body', async () => {
    const base = harness([line('cl-1', 'private original body')], {pages: [page('canvas-Page')]});
    const result = await probeSuperhumanRestPage(token, selected, {
      fetch: async (url, init) => {
        if (url.pathname.endsWith('/content') && url.searchParams.get('limit') === '1')
          return Response.json({items: [line('cl-1', 'private changed body')], href: url.href});
        return base(url, init);
      },
    });
    expect(result.content.orderedEqual).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('preserves ordered equality across arbitrary content pagination without leaking generated text', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({maxLength: 20}), {maxLength: 10}), async values => {
        const lines = values.map((value, index) => line(`cl-${index}`, `private-line-${index}-${value}`));
        const result = await probeSuperhumanRestPage(token, selected, {
          fetch: harness(lines, {pages: [page('canvas-Page')]}),
        });
        expect(result.content.items).toBe(values.length);
        expect(result.content.orderedEqual).toBe(true);
        for (const item of lines) expect(JSON.stringify(result)).not.toContain(item.itemContent.content);
      }),
      {numRuns: 30},
    );
  });
});
