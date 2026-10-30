// @vitest-environment happy-dom

import {beforeEach, describe, expect, it} from 'vitest';
import {websiteDefaultSiteSocialImage, type WebsiteSocialImage} from '../src/content/websiteArticles.js';
import {setDocumentMeta} from '../src/lib/site.js';

const articleImage: WebsiteSocialImage = {
  alt: 'Before You Rewrite It in Rust article card.',
  height: 630,
  type: 'image/png',
  url: 'https://threadnote.io/before-you-rewrite-it-in-rust-og.png',
  width: 1200,
};

function metaContent(selector: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(selector)?.content;
}

describe('website document metadata', () => {
  beforeEach(() => {
    document.head.innerHTML = `
      <meta name="description" content="" />
      <link rel="canonical" href="https://threadnote.io/" />
      <meta property="og:url" content="https://threadnote.io/" />
      <meta property="og:title" content="" />
      <meta property="og:description" content="" />
      <meta property="og:image" content="https://threadnote.io/og.png" />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="Threadnote — your team remembers" />
      <meta name="twitter:title" content="" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:description" content="" />
      <meta name="twitter:image" content="https://threadnote.io/og.png" />
      <meta name="twitter:image:alt" content="Threadnote — your team remembers" />
    `;
  });

  it('resets an article card when client navigation reaches a page without a custom image', () => {
    setDocumentMeta('Before You Rewrite It in Rust', 'Article summary.', articleImage);
    expect(metaContent('meta[property="og:image"]')).toBe(articleImage.url);
    expect(metaContent('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(metaContent('meta[name="twitter:image:alt"]')).toBe(articleImage.alt);

    setDocumentMeta('Docs', 'Threadnote documentation.');

    expect(metaContent('meta[property="og:image"]')).toBe(websiteDefaultSiteSocialImage.url);
    expect(metaContent('meta[property="og:image:type"]')).toBe(websiteDefaultSiteSocialImage.type);
    expect(metaContent('meta[property="og:image:width"]')).toBe(String(websiteDefaultSiteSocialImage.width));
    expect(metaContent('meta[property="og:image:height"]')).toBe(String(websiteDefaultSiteSocialImage.height));
    expect(metaContent('meta[property="og:image:alt"]')).toBe(websiteDefaultSiteSocialImage.alt);
    expect(metaContent('meta[name="twitter:image"]')).toBe(websiteDefaultSiteSocialImage.url);
    expect(metaContent('meta[name="twitter:image:alt"]')).toBe(websiteDefaultSiteSocialImage.alt);
    expect(metaContent('meta[name="twitter:card"]')).toBe('summary');
  });
});
