import {websiteDefaultSiteSocialImage, type WebsiteSocialImage} from '../content/websiteArticles.js';
import {docsArticlePath, siteCanonicalUrlForPathname, whatsNewArticlePath, whatsNewReleasePath} from './routes.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const base = import.meta.env.BASE_URL ?? '/';

export function siteHref(path = ''): string {
  const normalized = Effect.pipe(path, EffectString.replace(/^\/+/, ''));
  return `${base}${normalized}`;
}

export function docsArticleHref(articleId: string): string {
  return siteHref(docsArticlePath(articleId));
}

export function whatsNewArticleHref(slug: string): string {
  return siteHref(whatsNewArticlePath(slug));
}

export function whatsNewReleaseHref(version: string): string {
  return siteHref(whatsNewReleasePath(version));
}

export const githubUrl = 'https://github.com/threadnote/threadnote';
export const xUrl = 'https://x.com/threadnoteio';

export function setDocumentMeta(
  title: string,
  description: string,
  socialImage: WebsiteSocialImage = websiteDefaultSiteSocialImage,
): void {
  const pageTitle = `${title} — Threadnote`;
  const canonicalUrl = siteCanonicalUrlForPathname(window.location.pathname, base);
  document.title = pageTitle;
  const descriptionElement = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (descriptionElement) {
    descriptionElement.content = description;
  }
  const canonicalElement = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonicalElement) canonicalElement.href = canonicalUrl;
  const openGraphUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  if (openGraphUrl) openGraphUrl.content = canonicalUrl;
  const openGraphTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
  if (openGraphTitle) openGraphTitle.content = pageTitle;
  const openGraphDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
  if (openGraphDescription) openGraphDescription.content = description;
  const twitterTitle = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.content = pageTitle;
  const twitterDescription = document.querySelector<HTMLMetaElement>('meta[name="twitter:description"]');
  if (twitterDescription) twitterDescription.content = description;
  const openGraphImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]');
  if (openGraphImage) openGraphImage.content = socialImage.url;
  const openGraphImageType = document.querySelector<HTMLMetaElement>('meta[property="og:image:type"]');
  if (openGraphImageType) openGraphImageType.content = socialImage.type;
  const openGraphImageWidth = document.querySelector<HTMLMetaElement>('meta[property="og:image:width"]');
  if (openGraphImageWidth) openGraphImageWidth.content = String(socialImage.width);
  const openGraphImageHeight = document.querySelector<HTMLMetaElement>('meta[property="og:image:height"]');
  if (openGraphImageHeight) openGraphImageHeight.content = String(socialImage.height);
  const openGraphImageAlt = document.querySelector<HTMLMetaElement>('meta[property="og:image:alt"]');
  if (openGraphImageAlt) openGraphImageAlt.content = socialImage.alt;
  const twitterImage = document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]');
  if (twitterImage) twitterImage.content = socialImage.url;
  const twitterCard = document.querySelector<HTMLMetaElement>('meta[name="twitter:card"]');
  if (twitterCard) twitterCard.content = socialImage.width > socialImage.height ? 'summary_large_image' : 'summary';
  const twitterImageAlt = document.querySelector<HTMLMetaElement>('meta[name="twitter:image:alt"]');
  if (twitterImageAlt) twitterImageAlt.content = socialImage.alt;
}
