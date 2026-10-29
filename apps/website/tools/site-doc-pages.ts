import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';
import {docsSections, type DocsArticle} from '../src/content/docs.js';
import {docsArticlePath} from '../src/lib/routes.js';
import {loadPreparedWebsiteMetadataFromEnvironment} from './site-prepared-metadata.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const publicOrigin = 'https://threadnote.io/';
const generatedSitemapStart = '  <!-- BEGIN GENERATED DOCS ARTICLES -->';
const generatedSitemapEnd = '  <!-- END GENERATED DOCS ARTICLES -->';

export const docsArticles: readonly DocsArticle[] = EffectArray.flatMap(docsSections, section => section.articles);

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
      message: `Docs HTML template is missing ${tagName}[${identifyingAttribute}="${identifyingValue}"]`,
    });

  const attributePattern = new RegExp(`\\b${escapeRegExp(updatedAttribute)}="[^"]*"`, 'i');
  if (!attributePattern.test(tag)) {
    throw ScriptError.make({
      message: `Docs HTML template ${tagName}[${identifyingAttribute}="${identifyingValue}"] is missing ${updatedAttribute}`,
    });
  }
  const updatedTag = Effect2.pipe(
    tag,
    EffectString.replace(attributePattern, `${updatedAttribute}="${escapeHtml(updatedValue)}"`),
  );
  return Effect2.pipe(html, EffectString.replace(tagPattern, updatedTag));
}

export function renderDocsArticleHtml(
  template: string,
  article: Pick<DocsArticle, 'id' | 'summary' | 'title'>,
): string {
  const canonicalUrl = new URL(docsArticlePath(article.id), publicOrigin).href;
  const pageTitle = `${article.title} · Docs — Threadnote`;
  let html = template;
  html = replaceTagAttribute(html, 'meta', 'name', 'description', 'content', article.summary);
  html = replaceTagAttribute(html, 'link', 'rel', 'canonical', 'href', canonicalUrl);
  html = replaceTagAttribute(html, 'link', 'rel', 'icon', 'href', '../../favicon.svg');
  html = replaceTagAttribute(html, 'meta', 'property', 'og:title', 'content', pageTitle);
  html = replaceTagAttribute(html, 'meta', 'property', 'og:description', 'content', article.summary);
  html = replaceTagAttribute(html, 'meta', 'property', 'og:type', 'content', 'article');
  html = replaceTagAttribute(html, 'meta', 'property', 'og:url', 'content', canonicalUrl);
  html = replaceTagAttribute(html, 'meta', 'name', 'twitter:title', 'content', pageTitle);
  html = replaceTagAttribute(html, 'meta', 'name', 'twitter:description', 'content', article.summary);
  if (!/<title>[^<]*<\/title>/i.test(html))
    throw ScriptError.make({message: 'Docs HTML template is missing its title'});
  return Effect2.pipe(html, EffectString.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(pageTitle)}</title>`));
}

export function renderDocsSitemap(sitemap: string, articles: readonly Pick<DocsArticle, 'id'>[]): string {
  const generated = EffectArray.join(
    [
      generatedSitemapStart,
      ...EffectArray.map(
        articles,
        article => `  <url><loc>${new URL(docsArticlePath(article.id), publicOrigin).href}</loc></url>`,
      ),
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

export const generateDocsArticlePages = Effect.fn('siteDocs.generateArticlePages')(function* (siteDist?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputRoot = siteDist ?? path.resolve(process.cwd(), 'site-dist');
  const templatePath = path.join(outputRoot, 'docs', 'index.html');
  const [template, sitemap] = yield* Effect.all(
    [fs.readFileString(templatePath), fs.readFileString(path.join(outputRoot, 'sitemap.xml'))],
    {concurrency: 2},
  );
  const articleIds = new Set<string>();

  yield* Effect.forEach(
    docsArticles,
    article =>
      Effect.gen(function* () {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.id)) {
          throw ScriptError.make({message: `Docs article id is not a URL-safe slug: ${article.id}`});
        }
        if (articleIds.has(article.id)) throw ScriptError.make({message: `Duplicate docs article id: ${article.id}`});
        articleIds.add(article.id);
        const outputPath = path.join(outputRoot, docsArticlePath(article.id), 'index.html');
        yield* fs.makeDirectory(path.dirname(outputPath), {recursive: true});
        yield* fs.writeFileString(outputPath, renderDocsArticleHtml(template, article));
      }),
    {concurrency: 1},
  );

  yield* fs.writeFileString(path.join(outputRoot, 'sitemap.xml'), renderDocsSitemap(sitemap, docsArticles));
  return docsArticles.length;
});

if (import.meta.main) {
  await loadPreparedWebsiteMetadataFromEnvironment(process.env.THREADNOTE_SITE_BASE ?? '/');
  BunRuntime.runMain(
    provideScriptLayer(
      generateDocsArticlePages().pipe(
        Effect.tap(generatedCount => Console.log(`Generated ${generatedCount} crawler-visible documentation pages.`)),
      ),
      BunServices.layer,
    ),
  );
}
