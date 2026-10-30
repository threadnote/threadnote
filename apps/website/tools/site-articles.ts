import {Array as EffectArray} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PostMarkdown} from '../src/components/PostMarkdown.js';
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
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {pipe as effectPipe} from 'effect';
import {Option as EffectOption} from 'effect';

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
  return Effect2.pipe(
    markdown,
    EffectString.replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1'),
    EffectString.replace(/[`*_~]/g, ''),
    EffectString.replace(/\s+/g, ' '),
    EffectString.trim,
  );
}

function articleHighlights(body: string): readonly string[] {
  return [
    ...new Set(
      effectPipe(
        EffectOption.fromNullishOr(
          EffectArray.map(
            EffectArray.filter(
              EffectArray.map(
                Effect2.pipe(body, EffectString.split('\n')),
                line => /^#{2,3}\s+(.+)$/.exec(Effect2.pipe(line, EffectString.trim))?.[1],
              ),
              (heading): heading is string => Boolean(heading),
            ),
            plainText,
          ),
        ),
        EffectOption.map(values => EffectArray.filter(values, (value, index) => index in values && Boolean(value))),
        EffectOption.getOrUndefined,
      ),
    ),
  ];
}

function requiredMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: keyof ArticleMetadata,
  fileName: string,
): string {
  const value = metadata[key];
  if (typeof value !== 'string' || !Effect2.pipe(value, EffectString.trim))
    throw articleError(fileName, `frontmatter ${key} must be a string`);
  if (value !== Effect2.pipe(value, EffectString.trim))
    throw articleError(fileName, `frontmatter ${key} must not have surrounding whitespace`);
  return value;
}

function parseArticleMetadata(
  fileName: string,
  source: string,
): {readonly body: string; readonly metadata: ArticleMetadata} {
  const normalized = Effect2.pipe(source, EffectString.replace(/\r\n?/g, '\n'));
  const document = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(normalized);
  if (
    !document?.[1] ||
    !Effect2.pipe(document[2], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    throw articleError(fileName, 'expected YAML frontmatter followed by a non-empty Markdown body');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(document[1]);
  } catch (error) {
    throw articleError(fileName, `frontmatter is not valid YAML: ${String(error)}`);
  }
  if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(parsed)) {
    throw articleError(fileName, 'frontmatter must be a mapping');
  }
  const raw = parsed;
  const unknownKeys = EffectArray.filter(EffectRecord.keys(raw), key => !articleMetadataKeys.has(key));
  if (unknownKeys.length > 0)
    throw articleError(fileName, `unknown frontmatter field(s): ${EffectArray.join(unknownKeys, ', ')}`);

  const title = requiredMetadataString(raw, 'title', fileName);
  const summary = requiredMetadataString(raw, 'summary', fileName);
  const author = requiredMetadataString(raw, 'author', fileName);
  const publishedAt = requiredMetadataString(raw, 'publishedAt', fileName);
  const slug = requiredMetadataString(raw, 'slug', fileName);
  const authorUrlValue = raw.authorUrl;
  if (
    authorUrlValue !== undefined &&
    (typeof authorUrlValue !== 'string' || !Effect2.pipe(authorUrlValue, EffectString.trim))
  ) {
    throw articleError(fileName, 'frontmatter authorUrl must be a non-empty HTTPS URL when present');
  }
  const authorUrl = authorUrlValue;
  if (authorUrl && authorUrl !== Effect2.pipe(authorUrl, EffectString.trim)) {
    throw articleError(fileName, 'frontmatter authorUrl must not have surrounding whitespace');
  }
  const socialImageValue = raw.socialImage;
  const socialImageAltValue = raw.socialImageAlt;
  if ((socialImageValue === undefined) !== (socialImageAltValue === undefined)) {
    throw articleError(fileName, 'frontmatter socialImage and socialImageAlt must be provided together');
  }
  if (
    socialImageValue !== undefined &&
    (typeof socialImageValue !== 'string' || !Effect2.pipe(socialImageValue, EffectString.trim))
  ) {
    throw articleError(fileName, 'frontmatter socialImage must be a non-empty PNG filename when present');
  }
  if (
    socialImageAltValue !== undefined &&
    (typeof socialImageAltValue !== 'string' || !Effect2.pipe(socialImageAltValue, EffectString.trim))
  ) {
    throw articleError(fileName, 'frontmatter socialImageAlt must be a non-empty string when present');
  }
  const socialImage = socialImageValue;
  const socialImageAlt = socialImageAltValue;
  if (socialImage && socialImage !== Effect2.pipe(socialImage, EffectString.trim)) {
    throw articleError(fileName, 'frontmatter socialImage must not have surrounding whitespace');
  }
  if (socialImageAlt && socialImageAlt !== Effect2.pipe(socialImageAlt, EffectString.trim)) {
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
    ? Effect2.pipe(new Date(parsedPublishedAt).toISOString(), EffectString.replace('.000Z', 'Z'))
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
  const fileTimestamp = Effect2.pipe(fileMatch[1], EffectString.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'));
  if (fileTimestamp !== publishedAt || fileMatch[2] !== slug) {
    throw articleError(fileName, 'filename timestamp and slug must exactly match frontmatter publishedAt and slug');
  }

  return {
    body: Effect2.pipe(document[2], EffectString.trim),
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
    EffectArray.every(pngSignature, (byte, index) => header[index] === byte) &&
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
    const fileName = Effect2.pipe(
      path,
      EffectString.slice(
        Effect2.pipe(
          path,
          EffectString.lastIndexOf('/'),
          Effect2.Option.getOrElse(() => -1),
        ) + 1,
      ),
    );
    if (Effect2.pipe(fileName, EffectString.toLowerCase) !== 'readme.md') fileNames.push(fileName);
  }
  fileNames.sort();

  const articles = await Promise.all(
    EffectArray.map(fileNames, async fileName => {
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
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
      Effect2.pipe(left.slug, EffectString.localeCompare(right.slug)),
  );
}

function escapeHtml(value: string): string {
  return Effect2.pipe(
    value,
    EffectString.replaceAll('&', '&amp;'),
    EffectString.replaceAll('<', '&lt;'),
    EffectString.replaceAll('>', '&gt;'),
    EffectString.replaceAll('"', '&quot;'),
    EffectString.replaceAll("'", '&#39;'),
  );
}

function escapeRegExp(value: string): string {
  return Effect2.pipe(value, EffectString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
  const tag = Effect2.pipe(
    html,
    EffectString.match(tagPattern),
    Effect2.Option.getOrElse(() => null),
  )?.[0];
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
  const updatedTag = Effect2.pipe(
    tag,
    EffectString.replace(attributePattern, `${updatedAttribute}="${escapeHtml(updatedValue)}"`),
  );
  return Effect2.pipe(html, EffectString.replace(tagPattern, updatedTag));
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
  const markdown = renderToStaticMarkup(createElement(PostMarkdown, {children: details.body}));
  return EffectArray.join(
    [
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
    ],
    '',
  );
}

function postStableId(post: WebsitePost): string {
  return post.kind === 'article' ? `article:${post.slug}` : `release:${post.version}`;
}

export function orderWebsitePostsDescending(posts: readonly WebsitePost[]): readonly WebsitePost[] {
  return EffectArray.map(
    orderWebsiteUpdatesDescending(
      EffectArray.map(posts, post => ({post, publishedAt: post.publishedAt, stableId: postStableId(post)})),
    ),
    ({post}) => post,
  );
}

function crawlerIndexFallback(posts: readonly WebsitePost[]): string {
  const renderPostList = (kind: 'article' | 'release', heading: string, view: 'articles' | 'releases') => [
    `<section><h2><a href="${new URL(`whats-new/?view=${view}`, publicOrigin).href}">${heading}</a></h2>`,
    '<ol>',
    ...EffectArray.map(filterWebsiteUpdatesByKind(posts, kind), post => {
      const details = postDetails(post);
      return EffectArray.join(
        [
          '<li><article>',
          `<p>${details.kindLabel} · ${escapeHtml(post.publishedAt)} · By ${escapeHtml(details.author)}</p>`,
          `<h3><a href="${escapeHtml(details.canonicalUrl)}">${escapeHtml(post.title)}</a></h3>`,
          `<p>${escapeHtml(post.summary)}</p>`,
          '</article></li>',
        ],
        '',
      );
    }),
    '</ol></section>',
  ];

  return EffectArray.join(
    [
      '<main class="crawler-post crawler-post--index">',
      "<header><p>What's new</p><h1>Threadnote articles and releases</h1>",
      '<p>Engineering stories and stable release posts, kept in separate views.</p></header>',
      ...renderPostList('article', 'Articles', 'articles'),
      ...renderPostList('release', 'Release notes', 'releases'),
      '</main>',
    ],
    '',
  );
}

export function renderWhatsNewIndexHtml(template: string, posts: readonly WebsitePost[]): string {
  const orderedPosts = orderWebsitePostsDescending(posts);
  const latestPost = filterWebsiteUpdatesByKind(orderedPosts, 'article')[0] ?? orderedPosts[0];
  if (!latestPost) throw ScriptError.make({message: "What's New index requires at least one post"});
  const latestSocialImage = postDetails(latestPost).socialImage;
  if (!Effect2.pipe(template, EffectString.includes('<div id="root"></div>')))
    throw ScriptError.make({message: "What's New HTML template is missing #root"});
  if (!Effect2.pipe(template, EffectString.includes('</head>')))
    throw ScriptError.make({message: "What's New HTML template is missing </head>"});
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    hasPart: EffectArray.map(orderedPosts, post => {
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
  const structuredData = Effect2.pipe(JSON.stringify(itemList), EffectString.replaceAll('<', '\\u003c'));
  return Effect2.pipe(replaceSocialImageMetadata(template, latestSocialImage), __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(
      __effectPipeInput,
      EffectString.replace(
        '</head>',
        `    <script type="application/ld+json" data-threadnote-index>${structuredData}</script>\n  </head>`,
      ),
    );
    const __effectPipeStage1 = Effect2.pipe(
      __effectPipeStage0,
      EffectString.replace('<div id="root"></div>', `<div id="root">${crawlerIndexFallback(orderedPosts)}</div>`),
    );
    return __effectPipeStage1;
  });
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
  html = Effect2.pipe(
    html,
    EffectString.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(details.pageTitle)}</title>`),
  );

  const structuredData = Effect2.pipe(
    JSON.stringify(postStructuredData(post)),
    EffectString.replaceAll('<', '\\u003c'),
  );
  const postMetadata = EffectArray.join(
    [
      `<meta property="article:published_time" content="${escapeHtml(post.publishedAt)}" />`,
      `<meta property="article:author" content="${escapeHtml(details.author)}" />`,
      `<script type="application/ld+json" data-threadnote-post>${structuredData}</script>`,
    ],
    '\n    ',
  );
  if (!Effect2.pipe(html, EffectString.includes('</head>')))
    throw ScriptError.make({message: "What's New HTML template is missing </head>"});
  html = Effect2.pipe(html, EffectString.replace('</head>', `    ${postMetadata}\n  </head>`));
  if (!Effect2.pipe(html, EffectString.includes('<div id="root"></div>')))
    throw ScriptError.make({message: "What's New HTML template is missing #root"});
  return Effect2.pipe(
    html,
    EffectString.replace('<div id="root"></div>', `<div id="root">${crawlerFallback(post)}</div>`),
  );
}

export function renderWebsitePostsSitemap(sitemap: string, posts: readonly WebsitePost[]): string {
  const generated = EffectArray.join(
    [
      generatedSitemapStart,
      ...EffectArray.map(posts, post => {
        const path = post.kind === 'article' ? whatsNewArticlePath(post.slug) : whatsNewReleasePath(post.version);
        return `  <url><loc>${new URL(path, publicOrigin).href}</loc><lastmod>${post.publishedAt}</lastmod></url>`;
      }),
      generatedSitemapEnd,
    ],
    '\n',
  );
  const generatedPattern = new RegExp(
    `${escapeRegExp(generatedSitemapStart)}[\\s\\S]*?${escapeRegExp(generatedSitemapEnd)}`,
  );
  if (generatedPattern.test(sitemap)) return Effect2.pipe(sitemap, EffectString.replace(generatedPattern, generated));
  if (!Effect2.pipe(sitemap, EffectString.includes('</urlset>')))
    throw ScriptError.make({message: 'Website sitemap is missing </urlset>'});
  return Effect2.pipe(sitemap, EffectString.replace('</urlset>', `${generated}\n</urlset>`));
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
    ...EffectArray.map(releases, release => ({
      ...release,
      author: 'Threadnote' as const,
      kind: 'release' as const,
      title: `Threadnote ${Effect2.pipe(release.version, EffectString.replace(/^v/, ''))}`,
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
