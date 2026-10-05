import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import WhatsNewPage from '../src/pages/WhatsNewPage.js';

const posts = vi.hoisted(() => ({
  articles: [
    {
      author: 'Threadnote author',
      body: 'An article body.',
      highlights: ['Article highlight'],
      kind: 'article' as const,
      publishedAt: '2026-09-01T00:00:00Z',
      slug: 'latest-article',
      summary: 'Latest article summary.',
      title: 'Latest article',
    },
    {
      author: 'Threadnote author',
      body: 'An earlier article body.',
      highlights: [],
      kind: 'article' as const,
      publishedAt: '2026-08-01T00:00:00Z',
      slug: 'earlier-article',
      summary: 'Earlier article summary.',
      title: 'Earlier article',
    },
  ],
  releases: [
    {
      body: 'A release body.',
      highlights: ['Release highlight'],
      publishedAt: '2026-10-01T00:00:00Z',
      releaseUrl: 'https://github.com/threadnote/threadnote/releases/tag/v5.0.1',
      socialImage: 'release.png',
      socialImageAlt: 'Release preview',
      summary: 'Latest release summary.',
      version: 'v5.0.1',
    },
  ],
}));

vi.mock('virtual:threadnote-articles', () => ({default: posts.articles}));
vi.mock('virtual:threadnote-release-notes', () => ({default: posts.releases}));

const articles = [...posts.articles];
const releases = [...posts.releases];

function renderPage(search = '', pathname = '/whats-new/'): string {
  vi.stubGlobal('window', {location: {pathname, search}});
  return renderToStaticMarkup(createElement(WhatsNewPage));
}

describe("What's New content views", () => {
  beforeEach(() => {
    posts.articles.splice(0, posts.articles.length, ...articles);
    posts.releases.splice(0, posts.releases.length, ...releases);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['', '?view=articles', '?view=unknown'])('shows only articles for search %j', search => {
    const html = renderPage(search);
    expect(html).toContain('<h1 id="latest-update-title">Latest article</h1>');
    expect(html).toContain('<h3>Earlier article</h3>');
    expect(html).not.toContain('Latest release summary.');
    expect(html).toContain('href="/whats-new/?view=articles" aria-current="page"');
    expect(html).toContain('Articles <span>2</span>');
    expect(html).toContain('Release notes <span>1</span>');
  });

  it('shows only releases for the releases selector', () => {
    const html = renderPage('?view=releases');
    expect(html).toContain('<h1 id="latest-update-title">Threadnote 5.0.1</h1>');
    expect(html).toContain('Latest release summary.');
    expect(html).not.toContain('Latest article summary.');
    expect(html).not.toContain('<h3>Earlier article</h3>');
    expect(html).toContain('href="/whats-new/?view=releases" aria-current="page"');
  });

  it.each(['articles', 'releases'] as const)('keeps the switch available when %s are empty', view => {
    posts[view].length = 0;
    const html = renderPage(`?view=${view}`);
    expect(html).toContain(view === 'articles' ? 'No articles yet.' : 'No release notes yet.');
    expect(html).toContain('href="/whats-new/?view=articles"');
    expect(html).toContain('href="/whats-new/?view=releases"');
    expect(html).not.toContain('id="latest-update-title"');
  });

  it.each([
    ['/whats-new/articles/latest-article/', 'articles', 'All articles'],
    ['/whats-new/releases/v5.0.1/', 'releases', 'All release notes'],
  ])('returns %s to its matching index view', (pathname, view, label) => {
    const html = renderPage('', pathname);
    expect(html).toContain(`href="/whats-new/?view=${view}"`);
    expect(html).toContain(label);
    expect(html).toContain('class="post-detail"');
  });
});
