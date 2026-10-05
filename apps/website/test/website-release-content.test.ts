import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  orderWebsitePostsDescending,
  parseWebsiteArticle,
  renderWhatsNewIndexHtml,
  renderWebsitePostHtml,
  renderWebsitePostsSitemap,
} from '../tools/site-articles.js';
import {
  loadLatestMajorWebsiteReleases,
  parseStableReleaseVersion,
  releaseHeadlineFromSummary,
  selectLatestMajorReleases,
  summarizeReleaseNote,
} from '../tools/site-release-notes.js';
import {
  layoutReleaseSocialHeadline,
  renderWebsiteReleaseSocialImagePng,
  renderWebsiteReleaseSocialImageSvg,
} from '../tools/site-release-social-image.js';
import {websiteSocialImageForArticle, websiteSocialImageForRelease} from '../src/content/websiteArticles.js';
import {readFile} from './helpers/node-fs-promises.js';
import {join} from './helpers/node-path.js';

const root = process.cwd();

describe('website release-content producers', () => {
  it('shows published stable releases from the latest major only', () => {
    const selected = selectLatestMajorReleases(
      [
        ['v3.9.0', '2026-07-01T00:00:00Z'],
        ['v4.0.0', '2026-08-01T00:00:00Z'],
        ['v4.1.0', '2026-08-10T00:00:00Z'],
      ].map(([version, publishedAt]) => ({...parseStableReleaseVersion(version)!, publishedAt})),
    );

    expect(parseStableReleaseVersion('v4.1.0-beta.3')).toBeUndefined();
    expect(selected.map(release => release.version)).toEqual(['v4.1.0', 'v4.0.0']);
    expect(summarizeReleaseNote("## What's new\n\nA concise **summary**.\n\n### Safer upgrades\n\n- Details")).toEqual({
      highlights: ['Safer upgrades'],
      summary: 'A concise summary.',
    });
    expect(
      releaseHeadlineFromSummary(
        'Threadnote 4.6 closes the loop between code graphs and memory. The rest belongs in the article summary.',
      ),
    ).toBe('Closes the loop between code graphs and memory.');
    expect(releaseHeadlineFromSummary('Threadnote 4.4.3 is a focused Manager reliability patch.')).toBe(
      'A focused Manager reliability patch.',
    );
    expect(() => releaseHeadlineFromSummary('Threadnote 4.7 has no terminal punctuation')).toThrow(
      'must contain a complete first sentence',
    );
    expect(() => releaseHeadlineFromSummary(`Threadnote 4.7 ${'long '.repeat(60)}.`)).toThrow(
      'social-card headline of at most 240 characters',
    );

    const releases = loadLatestMajorWebsiteReleases(root);
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.every(release => release.major === releases[0].major)).toBe(true);
    expect(releases.every(release => !release.version.includes('-'))).toBe(true);
    expect(releases.every(release => release.headline.endsWith('.'))).toBe(true);
    expect(releases.every(release => release.socialImage.startsWith(`whats-new/releases/${release.version}/`))).toBe(
      true,
    );
    expect(releases.every(release => release.socialImageAlt.includes(release.headline))).toBe(true);
    expect(releases.every(release => release.summary.length > 0)).toBe(true);
    expect(releases.every(release => release.releaseUrl.endsWith(`/tag/${release.version}`))).toBe(true);
  });

  it('renders deterministic release social cards without dropping headline words', () => {
    const release = loadLatestMajorWebsiteReleases(root)[0];
    const svg = renderWebsiteReleaseSocialImageSvg(release);
    const png = renderWebsiteReleaseSocialImagePng(root, release);
    const pngView = new DataView(png.buffer, png.byteOffset, png.byteLength);

    expect(svg).toContain(`>${release.version.slice(1)}<`);
    expect(svg).toContain('<tspan fill="#f7fafc">Threadnote</tspan><tspan dx="20" fill="#67e8c7">');
    for (const line of layoutReleaseSocialHeadline(release.headline).lines) expect(svg).toContain(`>${line}<`);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngView.getUint32(16)).toBe(1200);
    expect(pngView.getUint32(20)).toBe(630);
    expect(renderWebsiteReleaseSocialImageSvg({headline: 'Memory & <graphs>.', version: 'v4.6.0'})).toContain(
      'Memory &amp; &lt;graphs&gt;.',
    );

    const word = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/u);
    fc.assert(
      fc.property(
        fc.array(word, {maxLength: 30, minLength: 1}).map(words => `${words.join(' ')}.`),
        headline => {
          const layout = layoutReleaseSocialHeadline(headline);
          expect(layout.lines.join(' ')).toBe(headline);
          expect(layout.lines.every(line => line.length > 0)).toBe(true);
          expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(220);
        },
      ),
      {numRuns: 100},
    );
  });

  it('renders crawlable, authored article and release post pages with social metadata', async () => {
    const article = parseWebsiteArticle(
      '2026-08-26T14-30-00Z--evidence-before-rewrites.md',
      `---
author: Denys Kashkovskyi
publishedAt: 2026-08-26T14:30:00Z
slug: evidence-before-rewrites
socialImage: evidence-before-rewrites-og.png
socialImageAlt: Evidence before rewrites — a Threadnote engineering article.
summary: An evidence-led engineering story for readers outside the Threadnote project.
title: Evidence before rewrites
---

The full article remains visible to crawlers before the client application starts.

## Measure the system

Make the bottleneck observable.
`,
    );
    const release = loadLatestMajorWebsiteReleases(root)[0];
    const releasePost = {
      ...release,
      publishedAt: '2027-01-01T00:00:00Z',
      author: 'Threadnote' as const,
      kind: 'release' as const,
      title: `Threadnote ${release.version.replace(/^v/, '')}`,
    };
    const [template, sitemap] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'whats-new', 'index.html'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'sitemap.xml'), 'utf8'),
    ]);
    const renderedArticle = renderWebsitePostHtml(template, article);
    const renderedRelease = renderWebsitePostHtml(template, releasePost);
    const renderedIndex = renderWhatsNewIndexHtml(template, [releasePost, article]);
    const renderedSitemap = renderWebsitePostsSitemap(sitemap, [article, releasePost]);

    expect(renderedArticle).toContain('<title>Evidence before rewrites — Threadnote</title>');
    expect(renderedArticle).toContain(
      '<link rel="canonical" href="https://threadnote.io/whats-new/articles/evidence-before-rewrites/" />',
    );
    expect(renderedArticle).toContain('<link rel="icon" href="../../../favicon.svg"');
    expect(renderedRelease).toContain('<link rel="icon" href="../../../favicon.svg"');
    expect(renderedArticle).toContain('<meta property="og:type" content="article" />');
    expect(renderedArticle).toContain(
      '<meta property="og:image" content="https://threadnote.io/evidence-before-rewrites-og.png" />',
    );
    expect(renderedArticle).toContain('<meta property="og:image:type" content="image/png" />');
    expect(renderedArticle).toContain('<meta property="og:image:width" content="1200" />');
    expect(renderedArticle).toContain('<meta property="og:image:height" content="630" />');
    expect(renderedArticle).toContain(
      '<meta property="og:image:alt" content="Evidence before rewrites — a Threadnote engineering article." />',
    );
    expect(renderedArticle).toContain(
      '<meta name="twitter:image" content="https://threadnote.io/evidence-before-rewrites-og.png" />',
    );
    expect(renderedArticle).toContain(
      '<meta name="twitter:image:alt" content="Evidence before rewrites — a Threadnote engineering article." />',
    );
    expect(renderedArticle).toContain('"image":"https://threadnote.io/evidence-before-rewrites-og.png"');
    expect(renderedArticle).not.toContain('whats-new-og.png');
    expect(renderedArticle).toContain('<meta property="article:author" content="Denys Kashkovskyi" />');
    expect(renderedArticle).toContain('"@type":"Article"');
    expect(renderedArticle).toContain('"name":"Denys Kashkovskyi"');
    expect(renderedArticle).toContain('<h1>Evidence before rewrites</h1>');
    expect(renderedArticle).toContain('<h2>Measure the system</h2>');
    expect(renderedArticle).toContain('Permanent public URL');
    expect(renderedArticle).toContain('https://x.com/intent/post?');
    expect(renderedArticle).toContain('https://www.linkedin.com/sharing/share-offsite/?url=');
    expect(renderedRelease).toContain(
      `<link rel="canonical" href="https://threadnote.io/whats-new/releases/${release.version}/" />`,
    );
    const releaseSocialImage = websiteSocialImageForRelease(release);
    expect(renderedRelease).toContain(`<meta property="og:image" content="${releaseSocialImage.url}" />`);
    expect(renderedRelease).toContain(`<meta name="twitter:image" content="${releaseSocialImage.url}" />`);
    expect(renderedRelease).toContain(`<meta property="og:image:alt" content="${releaseSocialImage.alt}" />`);
    expect(renderedRelease).toContain(`"image":"${releaseSocialImage.url}"`);
    expect(renderedRelease).not.toContain('whats-new-og.png');
    expect(renderedRelease).toContain('"@type":"TechArticle"');
    expect(renderedSitemap).toContain('<loc>https://threadnote.io/whats-new/articles/evidence-before-rewrites/</loc>');
    expect(renderedSitemap).toContain(`<loc>https://threadnote.io/whats-new/releases/${release.version}/</loc>`);
    expect(renderWebsitePostsSitemap(renderedSitemap, [article, releasePost])).toBe(renderedSitemap);
    expect(renderedIndex).toContain('data-threadnote-index');
    expect(renderedIndex).toContain('<h1>Threadnote articles and releases</h1>');
    expect(renderedIndex).toContain('<h2><a href="https://threadnote.io/whats-new/?view=articles">Articles</a></h2>');
    expect(renderedIndex).toContain(
      '<h2><a href="https://threadnote.io/whats-new/?view=releases">Release notes</a></h2>',
    );
    const orderedPosts = orderWebsitePostsDescending([releasePost, article]);
    expect(orderedPosts[0].kind).toBe('release');
    const latestSocialImage = websiteSocialImageForArticle(article);
    expect(renderedIndex).toContain(`<meta property="og:image" content="${latestSocialImage.url}" />`);
    expect(renderedIndex).toContain(`<meta property="og:image:type" content="${latestSocialImage.type}" />`);
    expect(renderedIndex).toContain(`<meta property="og:image:width" content="${latestSocialImage.width}" />`);
    expect(renderedIndex).toContain(`<meta property="og:image:height" content="${latestSocialImage.height}" />`);
    expect(renderedIndex).toContain(`<meta property="og:image:alt" content="${latestSocialImage.alt}" />`);
    expect(renderedIndex).toContain(`<meta name="twitter:image" content="${latestSocialImage.url}" />`);
    expect(renderedIndex).toContain(`<meta name="twitter:image:alt" content="${latestSocialImage.alt}" />`);
    expect(renderedIndex).toContain(`"image":"${latestSocialImage.url}"`);
    expect(renderedIndex).not.toContain('whats-new-og.png');
    const crawlerIndex = renderedIndex.slice(renderedIndex.indexOf('<main class="crawler-post crawler-post--index">'));
    expect(crawlerIndex.indexOf('>Articles</a>')).toBeLessThan(crawlerIndex.indexOf(article.title));
    expect(crawlerIndex.indexOf(article.title)).toBeLessThan(crawlerIndex.indexOf('>Release notes</a>'));
    expect(crawlerIndex.indexOf('>Release notes</a>')).toBeLessThan(crawlerIndex.indexOf(releasePost.title));
  });
});
