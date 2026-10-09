import {Redacted} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {describeSuperhumanSelection, resolveSuperhumanBrowserLinks} from '../src/links.js';
import {mergeResolvedSuperhumanSelections} from '../src/selection.js';

const credential = Redacted.make('synthetic-manager-token');
const icon = {name: 'Banknotes', type: 'image/png', browserLink: 'https://cdn.coda.io/icons/png/color/money.png'};
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const resolved = (type: 'doc' | 'page', documentId: string, pageId?: string, name?: string) => ({
  type: 'apiLink',
  resource: {
    type,
    id: pageId ?? documentId,
    href: `https://docs.superhuman.com/apis/v1/docs/${documentId}${pageId ? `/pages/${pageId}` : ''}`,
    name,
  },
});

describe('Saved Superhuman selection metadata', () => {
  it('reads only the selected document/page metadata and preserves the exact saved scope', async () => {
    const calls: {url: URL; method?: string}[] = [];
    const documents = [{id: 'doc_one', pages: ['page_a']}, {id: 'doc_two'}];
    const result = await describeSuperhumanSelection(documents, credential, {
      fetch: async (url, init) => {
        calls.push({url, method: init.method});
        return json(
          url.pathname.endsWith('/page_a')
            ? {
                type: 'page',
                id: 'page_a',
                name: 'Checklist',
                icon,
                browserLink: 'https://docs.superhuman.com/d/_ddoc_one/Checklist_spage_a',
              }
            : {type: 'doc', id: 'doc_two', name: 'Handbook', browserLink: 'https://coda.io/d/_ddoc_two'},
        );
      },
    });
    expect(result.documents).toEqual(documents);
    expect(result.selections).toEqual([
      {
        documentId: 'doc_one',
        pageId: 'page_a',
        name: 'Checklist',
        iconUrl: icon.browserLink,
        browserLink: 'https://docs.superhuman.com/d/_ddoc_one/Checklist_spage_a',
      },
      {documentId: 'doc_two', name: 'Handbook', browserLink: 'https://docs.superhuman.com/d/_ddoc_two'},
    ]);
    expect(calls.map(item => [item.url.pathname, item.method])).toEqual([
      ['/apis/v1/docs/doc_one/pages/page_a', 'GET'],
      ['/apis/v1/docs/doc_two', 'GET'],
    ]);
  });

  it('keeps optional artwork on provider asset origins and falls back for missing or unsafe icons', async () => {
    const urls = [
      icon.browserLink,
      'https://codahosted.io/docs/doc_one/blobs/upload/icon.png',
      'https://cdn.coda.io.evil.example/icons/money.png',
      'http://cdn.coda.io/icons/money.png',
      'https://127.0.0.1/icon.png',
      'https://cdn.coda.io:9443/icon.png',
      'https://username@cdn.coda.io/icon.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
    ];
    for (const [index, url] of urls.entries()) {
      const result = await describeSuperhumanSelection([{id: 'doc_one'}], credential, {
        fetch: async () => json({type: 'doc', id: 'doc_one', name: 'Handbook', icon: {...icon, browserLink: url}}),
      });
      expect(result.selections[0].iconUrl).toBe(index < 2 ? url : undefined);
      expect(result.documents).toEqual([{id: 'doc_one'}]);
    }
    for (const invalidIcon of [undefined, null, 'money', {...icon, type: 'text/html'}, {...icon, browserLink: 42}]) {
      const result = await describeSuperhumanSelection([{id: 'doc_one'}], credential, {
        fetch: async () => json({type: 'doc', id: 'doc_one', icon: invalidIcon}),
      });
      expect(result.selections[0]).not.toHaveProperty('iconUrl');
    }
    await expect(
      describeSuperhumanSelection([{id: 'doc_one'}], credential, {
        fetch: async () =>
          json({
            type: 'doc',
            id: 'doc_one',
            icon: {...icon, browserLink: 'https://cdn.coda.io/icons/%73ynthetic-manager-token.png'},
          }),
      }),
    ).rejects.toThrow(/sensitive/);
  });

  it('rejects mismatched resource identities, unsafe links and reflected credentials', async () => {
    for (const resource of [
      {type: 'page', id: 'other_page'},
      {type: 'page', id: 'page_a', browserLink: 'https://other.example/d/doc'},
      {type: 'page', id: 'page_a', name: 'synthetic-manager-token'},
      {type: 'page', id: 'page_a', browserLink: 'https://docs.superhuman.com/d/synthetic-manager-token'},
    ]) {
      await expect(
        describeSuperhumanSelection([{id: 'doc_one', pages: ['page_a']}], credential, {
          fetch: async () => json(resource),
        }),
      ).rejects.toThrow(/invalid|Superhuman Docs|sensitive/);
    }
  });

  it('bounds metadata lookups while retaining IDs for selections beyond the budget', async () => {
    const pages = Array.from({length: 65}, (_, index) => `page_${index}`);
    let requests = 0;
    const result = await describeSuperhumanSelection([{id: 'doc_one', pages}], credential, {
      fetch: async url => {
        requests++;
        return json({type: 'page', id: url.pathname.split('/').at(-1), name: 'Selected title'});
      },
    });
    expect(requests).toBe(64);
    expect(result.selections).toHaveLength(65);
    expect(result.selections.at(-1)?.name).toBe('Page page_64');
    expect(result.documents).toEqual([{id: 'doc_one', pages}]);
  });
});

describe('Superhuman Docs link resolution', () => {
  it('uses only validated API resource IDs, preserving underscores and whole-document selection', async () => {
    const calls: URL[] = [];
    const result = await resolveSuperhumanBrowserLinks(
      [
        'https://docs.superhuman.com/d/a-browser-slug_d_fake#heading',
        'https://docs.superhuman.com/d/another-browser-slug',
      ],
      credential,
      {
        fetch: async url => {
          calls.push(url);
          if (url.pathname === '/apis/v1/docs/doc_01')
            return json({type: 'doc', id: 'doc_01', name: 'Full document', icon});
          return json(
            calls.length === 1
              ? resolved('page', 'doc_01', 'page_a', 'First page')
              : resolved('doc', 'doc_01', undefined, 'Full document'),
          );
        },
      },
    );
    expect(result.documents).toEqual([{id: 'doc_01'}]);
    expect(result.selections).toEqual([
      {
        documentId: 'doc_01',
        name: 'Full document',
        browserLink: 'https://docs.superhuman.com/d/another-browser-slug',
        iconUrl: icon.browserLink,
      },
    ]);
    expect(calls.map(url => url.pathname)).toEqual([
      '/apis/v1/resolveBrowserLink',
      '/apis/v1/resolveBrowserLink',
      '/apis/v1/docs/doc_01',
    ]);
    expect(calls[0]?.searchParams.get('url')).toBe('https://docs.superhuman.com/d/a-browser-slug_d_fake#heading');
  });

  it('loads page artwork when adding links, including the maximum supported selection', async () => {
    const links = Array.from({length: 64}, (_, index) => `https://docs.superhuman.com/d/_ddoc_one/Page_spage_${index}`);
    const calls: {url: URL; method?: string}[] = [];
    const result = await resolveSuperhumanBrowserLinks(links, credential, {
      fetch: async (url, init) => {
        calls.push({url, method: init.method});
        if (url.pathname === '/apis/v1/resolveBrowserLink') {
          const pageId = url.searchParams.get('url')!.split('_s').at(-1)!;
          return json(resolved('page', 'doc_one', pageId, 'Page title'));
        }
        return json({type: 'page', id: url.pathname.split('/').at(-1), name: 'Page title', icon});
      },
    });
    expect(result.selections).toHaveLength(64);
    expect(result.selections.every(item => item.iconUrl === icon.browserLink && !!item.browserLink)).toBe(true);
    expect(result.documents[0].pages).toHaveLength(64);
    expect(calls).toHaveLength(128);
    expect(calls.every(item => item.url.origin === 'https://docs.superhuman.com' && item.method === 'GET')).toBe(true);
    expect(
      calls
        .filter(item => item.url.pathname.startsWith('/apis/v1/docs/'))
        .every(item => /^\/apis\/v1\/docs\/doc_one\/pages\/page_\d+$/.test(item.url.pathname)),
    ).toBe(true);
  });

  it('rejects cross-origin browser URLs and resource hrefs without echoing either token or provider reply', async () => {
    const fetch = async () =>
      json({
        type: 'apiLink',
        resource: {
          type: 'page',
          id: 'page_1',
          href: 'https://evil.example/apis/v1/docs/doc_1/pages/page_1',
          name: 'private',
        },
      });
    await expect(resolveSuperhumanBrowserLinks(['https://evil.example/d/a'], credential, {fetch})).rejects.toThrow(
      /Superhuman Docs/,
    );
    await expect(
      resolveSuperhumanBrowserLinks(['https://docs.superhuman.com/d/a'], credential, {fetch}),
    ).rejects.toThrow(/out-of-scope/);
    await expect(
      resolveSuperhumanBrowserLinks(['https://docs.superhuman.com/d/a'], credential, {
        fetch: async () =>
          json({
            type: 'apiLink',
            resource: {
              type: 'page',
              id: 'page_wrong',
              href: 'https://docs.superhuman.com/apis/v1/docs/doc_1/pages/page_right',
            },
          }),
      }),
    ).rejects.toThrow(/invalid/);
    await expect(
      resolveSuperhumanBrowserLinks(['https://docs.superhuman.com/d/a'], credential, {
        fetch: async () => json(resolved('page', 'doc_1', 'page_1', 'synthetic-manager-token')),
      }),
    ).rejects.toThrow(/sensitive/);
  });

  it('merges duplicate page selections independently of order and whole-doc links subsume pages', () => {
    const arb = fc.array(
      fc.record({
        documentId: fc.constantFrom('doc_one', 'doc_Two'),
        pageId: fc.option(fc.constantFrom('page_one', 'page_Two'), {nil: undefined}),
        name: fc.constantFrom('Alpha', 'Beta'),
        browserLink: fc.option(fc.constant('https://docs.superhuman.com/d/_ddoc_one'), {nil: undefined}),
        iconUrl: fc.option(fc.constantFrom(icon.browserLink, 'https://cdn.coda.io/icons/png/color/book.png'), {
          nil: undefined,
        }),
      }),
      {minLength: 1, maxLength: 12},
    );
    fc.assert(
      fc.property(arb, selections => {
        const left = mergeResolvedSuperhumanSelections(selections);
        const right = mergeResolvedSuperhumanSelections([...selections].reverse());
        expect(left).toEqual(right);
        expect(mergeResolvedSuperhumanSelections(left.selections)).toEqual(left);
        expect(new Set(left.documents.map(document => document.id)).size).toBe(left.documents.length);
      }),
      {numRuns: 100},
    );
  });
});
