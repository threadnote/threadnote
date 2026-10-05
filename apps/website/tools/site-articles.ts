import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {createElement} from 'react';
import ReactMarkdown from 'react-markdown';
import {renderToStaticMarkup} from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import {parse as parseYaml} from 'yaml';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {loadLatestMajorWebsiteReleases, type WebsiteRelease} from './site-release-notes.js';
import {renderWebsiteReleaseSocialImagePng} from './site-release-social-image.js';
import {
  filterWebsiteUpdatesByKind,
  orderWebsiteUpdatesDescending,
  websiteArticleSocialImageHeight,
  websiteArticleSocialImageWidth,
  websiteSocialImageForArticle,
  websiteSocialImageForRelease,
  type WebsiteArticle,
  type WebsiteSocialImage,
} from '../src/content/websiteArticles.js';
import {whatsNewArticlePath, whatsNewReleasePath} from '../src/lib/routes.js';
import {loadPreparedWebsiteMetadataFromEnvironment, type PreparedWebsiteMetadata} from './site-prepared-metadata.js';

const publicOrigin = 'https://threadnote.io/';
const articleFilePattern = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)--([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const articleSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const articleSocialImagePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const generatedSitemapStart = '  <!-- BEGIN GENERATED WHATS NEW POSTS -->';
const generatedSitemapEnd = '  <!-- END GENERATED WHATS NEW POSTS -->';
const articleMetadataKeys = new Set([
  'author',
  'authorUrl',
  'publishedAt',
  'slug',
  'socialImage',
  'socialImageAlt',
  'summary',
  'title',
]);

type ArticleMetadata = Readonly<{
  author: string;
  authorUrl?: string;
  publishedAt: string;
  socialImage?: string;
  socialImageAlt?: string;
  slug: string;
  summary: string;
  title: string;
}>;

export type WebsitePost =
  WebsiteArticle | (WebsiteRelease & {readonly author: 'Threadnote'; readonly kind: 'release'; readonly title: string});

function articleError(fileName: string, detail: string): ScriptError {
  return ScriptError.make({message: `apps/website/articles/${fileName}: ${detail}`});
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function articleHighlights(body: string): readonly string[] {
  return [
    ...new Set(
      body
        .split('\n')
        .map(line => /^#{2,3}\s+(.+)$/.exec(line.trim())?.[1])
        .filter((heading): heading is string => Boolean(heading))
        .map(plainText)
        .filter(Boolean),
    ),
  ];
}

function requiredMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: keyof ArticleMetadata,
  fileName: string,
): string {
  const value = metadata[key];
  if (typeof value !== 'string' || !value.trim()) throw articleError(fileName, `frontmatter ${key} must be a string`);
  if (value !== value.trim()) throw articleError(fileName, `frontmatter ${key} must not have surrounding whitespace`);
  return value;
}

function parseArticleMetadata(
  fileName: string,
  source: string,
): {readonly body: string; readonly metadata: ArticleMetadata} {
  const normalized = source.replace(/\r\n?/g, '\n');
  const document = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(normalized);
  if (!document?.[1] || !document[2]?.trim()) {
    throw articleError(fileName, 'expected YAML frontmatter followed by a non-empty Markdown body');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(document[1]);
  } catch (error) {
    throw articleError(fileName, `frontmatter is not valid YAML: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw articleError(fileName, 'frontmatter must be a mapping');
  }
  const raw = parsed as Readonly<Record<string, unknown>>;
  const unknownKeys = Object.keys(raw).filter(key => !articleMetadataKeys.has(key));
  if (unknownKeys.length > 0) throw articleError(fileName, `unknown frontmatter field(s): ${unknownKeys.join(', ')}`);

  const title = requiredMetadataString(raw, 'title', fileName);
  const summary = requiredMetadataString(raw, 'summary', fileName);
  const author = requiredMetadataString(raw, 'author', fileName);
  const publishedAt = requiredMetadataString(raw, 'publishedAt', fileName);
  const slug = requiredMetadataString(raw, 'slug', fileName);
  const authorUrlValue = raw.authorUrl;
  if (authorUrlValue !== undefined && (typeof authorUrlValue !== 'string' || !authorUrlValue.trim())) {
    throw articleError(fileName, 'frontmatter authorUrl must be a non-empty HTTPS URL when present');
  }
  const authorUrl = authorUrlValue;
  if (authorUrl && authorUrl !== authorUrl.trim()) {
    throw articleError(fileName, 'frontmatter authorUrl must not have surrounding whitespace');
  }
  const socialImageValue = raw.socialImage;
  const socialImageAltValue = raw.socialImageAlt;
  if ((socialImageValue === undefined) !== (socialImageAltValue === undefined)) {
    throw articleError(fileName, 'frontmatter socialImage and socialImageAlt must be provided together');
  }
  if (socialImageValue !== undefined && (typeof socialImageValue !== 'string' || !socialImageValue.trim())) {
    throw articleError(fileName, 'frontmatter socialImage must be a non-empty PNG filename when present');
  }
  if (socialImageAltValue !== undefined && (typeof socialImageAltValue !== 'string' || !socialImageAltValue.trim())) {
    throw articleError(fileName, 'frontmatter socialImageAlt must be a non-empty string when present');
  }
  const socialImage = socialImageValue;
  const socialImageAlt = socialImageAltValue;
  if (socialImage && socialImage !== socialImage.trim()) {
    throw articleError(fileName, 'frontmatter socialImage must not have surrounding whitespace');
  }
  if (socialImageAlt && socialImageAlt !== socialImageAlt.trim()) {
    throw articleError(fileName, 'frontmatter socialImageAlt must not have surrounding whitespace');
  }

  if (title.length > 140) throw articleError(fileName, 'frontmatter title must be at most 140 characters');
  if (summary.length > 280) throw articleError(fileName, 'frontmatter summary must be at most 280 characters');
  if (author.length > 100) throw articleError(fileName, 'frontmatter author must be at most 100 characters');
  if (socialImage && !articleSocialImagePattern.test(socialImage)) {
    throw articleError(fileName, 'frontmatter socialImage must be a root-level lowercase PNG filename');
  }
  if (socialImageAlt && socialImageAlt.length > 300) {
    throw articleError(fileName, 'frontmatter socialImageAlt must be at most 300 characters');
  }
  if (!articleSlugPattern.test(slug)) throw articleError(fileName, `frontmatter slug is not URL-safe: ${slug}`);
  const parsedPublishedAt = Date.parse(publishedAt);
  const canonicalPublishedAt = Number.isFinite(parsedPublishedAt)
    ? new Date(parsedPublishedAt).toISOString().replace('.000Z', 'Z')
    : undefined;
  if (!exactTimestampPattern.test(publishedAt) || canonicalPublishedAt !== publishedAt) {
    throw articleError(fileName, 'frontmatter publishedAt must be an exact UTC timestamp such as 2026-08-26T14:30:00Z');
  }
  if (authorUrl) {
    let url: URL;
    try {
      url = new URL(authorUrl);
    } catch {
      throw articleError(fileName, 'frontmatter authorUrl must be a valid HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw articleError(fileName, 'frontmatter authorUrl must be a credential-free HTTPS URL');
    }
  }

  const fileMatch = articleFilePattern.exec(fileName);
  if (!fileMatch) {
    throw articleError(fileName, 'filename must be <UTC timestamp>--<slug>.md with colons written as hyphens');
  }
  const fileTimestamp = fileMatch[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  if (fileTimestamp !== publishedAt || fileMatch[2] !== slug) {
    throw articleError(fileName, 'filename timestamp and slug must exactly match frontmatter publishedAt and slug');
  }

  return {
    body: document[2].trim(),
    metadata: {
      author,
      ...(authorUrl ? {authorUrl} : {}),
      publishedAt,
      ...(socialImage && socialImageAlt ? {socialImage, socialImageAlt} : {}),
      slug,
      summary,
      title,
    },
  };
}

export function parseWebsiteArticle(fileName: string, source: string): WebsiteArticle {
  if (/publication placeholder/i.test(source)) {
    throw articleError(fileName, 'publication placeholders are forbidden in published articles');
  }
  const {body, metadata} = parseArticleMetadata(fileName, source);
  return {...metadata, body, highlights: articleHighlights(body), kind: 'article'};
}

async function validateArticleSocialImage(
  repositoryRoot: string,
  fileName: string,
  article: WebsiteArticle,
): Promise<void> {
  if (!article.socialImage) return;
  const image = Bun.file(`${repositoryRoot}/apps/website/public/${article.socialImage}`);
  if (!(await image.exists())) {
    throw articleError(
      fileName,
      `frontmatter socialImage does not exist in apps/website/public: ${article.socialImage}`,
    );
  }
  const header = new Uint8Array(await image.slice(0, 24).arrayBuffer());
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasPngSignature =
    header.length === 24 &&
    pngSignature.every((byte, index) => header[index] === byte) &&
    String.fromCharCode(...header.slice(12, 16)) === 'IHDR';
  if (!hasPngSignature) {
    throw articleError(fileName, `frontmatter socialImage is not a valid PNG: ${article.socialImage}`);
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== websiteArticleSocialImageWidth || height !== websiteArticleSocialImageHeight) {
    throw articleError(
      fileName,
      `frontmatter socialImage must be ${websiteArticleSocialImageWidth}x${websiteArticleSocialImageHeight}, received ${width}x${height}`,
    );
  }
}

export async function loadWebsiteArticles(repositoryRoot: string): Promise<readonly WebsiteArticle[]> {
  const fileNames: string[] = [];
  const glob = new Bun.Glob('apps/website/articles/*.md');
  for await (const path of glob.scan({cwd: repositoryRoot, onlyFiles: true})) {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    if (fileName.toLowerCase() !== 'readme.md') fileNames.push(fileName);
  }
  fileNames.sort();

  const articles = await Promise.all(
    fileNames.map(async fileName => {
      const article = parseWebsiteArticle(
        fileName,
        await Bun.file(`${repositoryRoot}/apps/website/articles/${fileName}`).text(),
      );
      await validateArticleSocialImage(repositoryRoot, fileName, article);
      return article;
    }),
  );
  const slugs = new Set<string>();
  for (const article of articles) {
    if (slugs.has(article.slug))
      throw articleError(fileNames[articles.indexOf(article)], `duplicate slug: ${article.slug}`);
    slugs.add(article.slug);
  }
  return articles.sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || left.slug.localeCompare(right.slug),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTagAttribute(
  html: string,
  tagName: string,
  identifyingAttribute: string,
  identifyingValue: string,
  updatedAttribute: string,
  updatedValue: string,
): string {
  const tagPattern = new RegExp(
    `<${tagName}\\b[^>]*\\b${escapeRegExp(identifyingAttribute)}="${escapeRegExp(identifyingValue)}"[^>]*>`,
    'i',
  );
  const tag = html.match(tagPattern)?.[0];
  if (!tag)
    throw ScriptError.make({
      message: `What's New HTML template is missing ${tagName}[${identifyingAttribute}="${identifyingValue}"]`,
    });
  const attributePattern = new RegExp(`\\b${escapeRegExp(updatedAttribute)}="[^"]*"`, 'i');
  if (!attributePattern.test(tag)) {
    throw ScriptError.make({
      message: `What's New HTML template ${tagName}[${identifyingAttribute}="${identifyingValue}"] is missing ${updatedAttribute}`,
    });
  }
  const updatedTag = tag.replace(attributePattern, `${updatedAttribute}="${escapeHtml(updatedValue)}"`);
  return html.replace(tagPattern, updatedTag);
}

function postDetails(post: WebsitePost): {
  readonly author: string;
  readonly body: string;
  readonly canonicalUrl: string;
  readonly kindLabel: string;
  readonly pageTitle: string;
  readonly socialImage: WebsiteSocialImage;
} {
  if (post.kind === 'article') {
    return {
      author: post.author,
      body: post.body,
      canonicalUrl: new URL(whatsNewArticlePath(post.slug), publicOrigin).href,
      kindLabel: 'Article',
      pageTitle: `${post.title} — Threadnote`,
      socialImage: websiteSocialImageForArticle(post),
    };
  }
  return {
    author: post.author,
    body: post.body,
    canonicalUrl: new URL(whatsNewReleasePath(post.version), publicOrigin).href,
    kindLabel: 'Release',
    pageTitle: `${post.title} — Threadnote`,
    socialImage: websiteSocialImageForRelease(post),
  };
}

function replaceSocialImageMetadata(html: string, socialImage: WebsiteSocialImage): string {
  let updated = html;
  updated = replaceTagAttribute(updated, 'meta', 'property', 'og:image', 'content', socialImage.url);
  updated = replaceTagAttribute(updated, 'meta', 'property', 'og:image:type', 'content', socialImage.type);
  updated = replaceTagAttribute(updated, 'meta', 'property', 'og:image:width', 'content', String(socialImage.width));
  updated = replaceTagAttribute(updated, 'meta', 'property', 'og:image:height', 'content', String(socialImage.height));
  updated = replaceTagAttribute(updated, 'meta', 'property', 'og:image:alt', 'content', socialImage.alt);
  updated = replaceTagAttribute(updated, 'meta', 'name', 'twitter:image', 'content', socialImage.url);
  return replaceTagAttribute(updated, 'meta', 'name', 'twitter:image:alt', 'content', socialImage.alt);
}

function crawlerFallback(post: WebsitePost): string {
  const details = postDetails(post);
  const shareText = encodeURIComponent(post.title);
  const shareUrl = encodeURIComponent(details.canonicalUrl);
  const markdown = renderToStaticMarkup(createElement(ReactMarkdown, {remarkPlugins: [remarkGfm]}, details.body));
  return [
    '<main class="crawler-post">',
    '<article>',
    `<p>${details.kindLabel} · ${escapeHtml(post.publishedAt)} · By ${escapeHtml(details.author)}</p>`,
    `<h1>${escapeHtml(post.title)}</h1>`,
    `<p>${escapeHtml(post.summary)}</p>`,
    markdown,
    '<aside aria-label="Share this post">',
    `<label>Permanent public URL <input readonly value="${escapeHtml(details.canonicalUrl)}" /></label>`,
    `<p><a href="https://x.com/intent/post?text=${shareText}&amp;url=${shareUrl}">Share on X</a> · ` +
      `<a href="https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}">Share on LinkedIn</a></p>`,
    '</aside>',
    '</article>',
    '</main>',
  ].join('');
}

function postStableId(post: WebsitePost): string {
  return post.kind === 'article' ? `article:${post.slug}` : `release:${post.version}`;
}

export function orderWebsitePostsDescending(posts: readonly WebsitePost[]): readonly WebsitePost[] {
  return orderWebsiteUpdatesDescending(
    posts.map(post => ({post, publishedAt: post.publishedAt, stableId: postStableId(post)})),
  ).map(({post}) => post);
}

function crawlerIndexFallback(posts: readonly WebsitePost[]): string {
  const renderPostList = (kind: 'article' | 'release', heading: string, view: 'articles' | 'releases') => [
    `<section><h2><a href="${new URL(`whats-new/?view=${view}`, publicOrigin).href}">${heading}</a></h2>`,
    '<ol>',
    ...filterWebsiteUpdatesByKind(posts, kind).map(post => {
      const details = postDetails(post);
      return [
        '<li><article>',
        `<p>${details.kindLabel} · ${escapeHtml(post.publishedAt)} · By ${escapeHtml(details.author)}</p>`,
        `<h3><a href="${escapeHtml(details.canonicalUrl)}">${escapeHtml(post.title)}</a></h3>`,
        `<p>${escapeHtml(post.summary)}</p>`,
        '</article></li>',
      ].join('');
    }),
    '</ol></section>',
  ];

  return [
    '<main class="crawler-post crawler-post--index">',
    "<header><p>What's new</p><h1>Threadnote articles and releases</h1>",
    '<p>Engineering stories and stable release posts, kept in separate views.</p></header>',
    ...renderPostList('article', 'Articles', 'articles'),
    ...renderPostList('release', 'Release notes', 'releases'),
    '</main>',
  ].join('');
}

export function renderWhatsNewIndexHtml(template: string, posts: readonly WebsitePost[]): string {
  const orderedPosts = orderWebsitePostsDescending(posts);
  const latestPost = filterWebsiteUpdatesByKind(orderedPosts, 'article')[0] ?? orderedPosts[0];
  if (!latestPost) throw ScriptError.make({message: "What's New index requires at least one post"});
  const latestSocialImage = postDetails(latestPost).socialImage;
  if (!template.includes('<div id="root"></div>'))
    throw ScriptError.make({message: "What's New HTML template is missing #root"});
  if (!template.includes('</head>')) throw ScriptError.make({message: "What's New HTML template is missing </head>"});
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    hasPart: orderedPosts.map(post => {
      const details = postDetails(post);
      return {
        '@type': post.kind === 'article' ? 'Article' : 'TechArticle',
        name: post.title,
        url: details.canonicalUrl,
      };
    }),
    image: latestSocialImage.url,
    name: "What's new in Threadnote",
    url: new URL('whats-new/', publicOrigin).href,
  };
  const structuredData = JSON.stringify(itemList).replaceAll('<', '\\u003c');
  return replaceSocialImageMetadata(template, latestSocialImage)
    .replace(
      '</head>',
      `    <script type="application/ld+json" data-threadnote-index>${structuredData}</script>\n  </head>`,
    )
    .replace('<div id="root"></div>', `<div id="root">${crawlerIndexFallback(orderedPosts)}</div>`);
}

function postStructuredData(post: WebsitePost): Readonly<Record<string, unknown>> {
  const details = postDetails(post);
  const author =
    post.kind === 'article'
      ? {'@type': 'Person', name: post.author, ...(post.authorUrl ? {url: post.authorUrl} : {})}
      : {'@type': 'Organization', name: 'Threadnote', url: publicOrigin};
  return {
    '@context': 'https://schema.org',
    '@type': post.kind === 'article' ? 'Article' : 'TechArticle',
    author,
    datePublished: post.publishedAt,
    description: post.summary,
    headline: post.title,
    image: details.socialImage.url,
    mainEntityOfPage: details.canonicalUrl,
    publisher: {'@type': 'Organization', name: 'Threadnote', url: publicOrigin},
    url: details.canonicalUrl,
  };
}

export function renderWebsitePostHtml(template: string, post: WebsitePost): string {
  const details = postDetails(post);
  let html = template;
  html = replaceTagAttribute(html, 'meta', 'name', 'description', 'content', post.summary);
  html = replaceTagAttribute(html, 'link', 'rel', 'canonical', 'href', details.canonicalUrl);
  html = replaceTagAttribute(html, 'link', 'rel', 'icon', 'href', '../../../favicon.svg');
  html = replaceTagAttribute(html, 'meta', 'property', 'og:title', 'content', details.pageTitle);
  html = replaceTagAttribute(html, 'meta', 'property', 'og:description', 'content', post.summary);
  html = replaceTagAttribute(html, 'meta', 'property', 'og:type', 'content', 'article');
  html = replaceTagAttribute(html, 'meta', 'property', 'og:url', 'content', details.canonicalUrl);
  html = replaceSocialImageMetadata(html, details.socialImage);
  html = replaceTagAttribute(html, 'meta', 'name', 'twitter:title', 'content', details.pageTitle);
  html = replaceTagAttribute(html, 'meta', 'name', 'twitter:description', 'content', post.summary);
  if (!/<title>[^<]*<\/title>/i.test(html))
    throw ScriptError.make({message: "What's New HTML template is missing its title"});
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(details.pageTitle)}</title>`);

  const structuredData = JSON.stringify(postStructuredData(post)).replaceAll('<', '\\u003c');
  const postMetadata = [
    `<meta property="article:published_time" content="${escapeHtml(post.publishedAt)}" />`,
    `<meta property="article:author" content="${escapeHtml(details.author)}" />`,
    `<script type="application/ld+json" data-threadnote-post>${structuredData}</script>`,
  ].join('\n    ');
  if (!html.includes('</head>')) throw ScriptError.make({message: "What's New HTML template is missing </head>"});
  html = html.replace('</head>', `    ${postMetadata}\n  </head>`);
  if (!html.includes('<div id="root"></div>'))
    throw ScriptError.make({message: "What's New HTML template is missing #root"});
  return html.replace('<div id="root"></div>', `<div id="root">${crawlerFallback(post)}</div>`);
}

export function renderWebsitePostsSitemap(sitemap: string, posts: readonly WebsitePost[]): string {
  const generated = [
    generatedSitemapStart,
    ...posts.map(post => {
      const path = post.kind === 'article' ? whatsNewArticlePath(post.slug) : whatsNewReleasePath(post.version);
      return `  <url><loc>${new URL(path, publicOrigin).href}</loc><lastmod>${post.publishedAt}</lastmod></url>`;
    }),
    generatedSitemapEnd,
  ].join('\n');
  const generatedPattern = new RegExp(
    `${escapeRegExp(generatedSitemapStart)}[\\s\\S]*?${escapeRegExp(generatedSitemapEnd)}`,
  );
  if (generatedPattern.test(sitemap)) return sitemap.replace(generatedPattern, generated);
  if (!sitemap.includes('</urlset>')) throw ScriptError.make({message: 'Website sitemap is missing </urlset>'});
  return sitemap.replace('</urlset>', `${generated}\n</urlset>`);
}

export const generateWebsitePostPages = Effect.fn('siteArticles.generatePostPages')(function* (
  siteDist?: string,
  prepared?: Pick<PreparedWebsiteMetadata, 'articles' | 'releases'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = process.cwd();
  const outputRoot = siteDist ?? path.resolve(repositoryRoot, 'site-dist');
  const articles =
    prepared?.articles ??
    (yield* Effect.tryPromise({
      try: () => loadWebsiteArticles(repositoryRoot),
      catch: error =>
        Schema.is(ScriptError)(error)
          ? error
          : ScriptError.make({message: `Could not load website articles: ${String(error)}`}),
    }));
  const releases =
    prepared?.releases ??
    (yield* Effect.try({
      try: () => loadLatestMajorWebsiteReleases(repositoryRoot),
      catch: error =>
        Schema.is(ScriptError)(error)
          ? error
          : ScriptError.make({message: `Could not load website releases: ${String(error)}`}),
    }));
  const posts = orderWebsitePostsDescending([
    ...articles,
    ...releases.map(release => ({
      ...release,
      author: 'Threadnote' as const,
      kind: 'release' as const,
      title: `Threadnote ${release.version.replace(/^v/, '')}`,
    })),
  ]);
  const templatePath = path.join(outputRoot, 'whats-new', 'index.html');
  const [template, sitemap] = yield* Effect.all(
    [fs.readFileString(templatePath), fs.readFileString(path.join(outputRoot, 'sitemap.xml'))],
    {concurrency: 2},
  );

  yield* Effect.forEach(
    releases,
    release =>
      Effect.gen(function* () {
        const imagePath = path.join(outputRoot, release.socialImage);
        const image = yield* Effect.try({
          try: () => renderWebsiteReleaseSocialImagePng(repositoryRoot, release),
          catch: error =>
            ScriptError.make({message: `Could not render ${release.version} social image: ${String(error)}`}),
        });
        yield* fs.makeDirectory(path.dirname(imagePath), {recursive: true});
        yield* fs.writeFile(imagePath, image);
      }),
    {concurrency: 1},
  );

  yield* Effect.forEach(
    posts,
    post =>
      Effect.gen(function* () {
        const relativePath =
          post.kind === 'article' ? whatsNewArticlePath(post.slug) : whatsNewReleasePath(post.version);
        const outputPath = path.join(outputRoot, relativePath, 'index.html');
        yield* fs.makeDirectory(path.dirname(outputPath), {recursive: true});
        yield* fs.writeFileString(outputPath, renderWebsitePostHtml(template, post));
      }),
    {concurrency: 1},
  );

  yield* fs.writeFileString(path.join(outputRoot, 'sitemap.xml'), renderWebsitePostsSitemap(sitemap, posts));
  yield* fs.writeFileString(templatePath, renderWhatsNewIndexHtml(template, posts));
  return {articleCount: articles.length, releaseCount: releases.length};
});

if (import.meta.main) {
  const prepared = await loadPreparedWebsiteMetadataFromEnvironment(process.env.THREADNOTE_SITE_BASE ?? '/');
  BunRuntime.runMain(
    provideScriptLayer(
      generateWebsitePostPages(undefined, prepared).pipe(
        Effect.tap(({articleCount, releaseCount}) =>
          Console.log(`Generated ${articleCount} article page(s) and ${releaseCount} release post page(s).`),
        ),
      ),
      BunServices.layer,
    ),
  );
}
