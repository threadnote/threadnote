import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';
export interface WebsiteArticle {
  readonly author: string;
  readonly authorUrl?: string;
  readonly body: string;
  readonly highlights: readonly string[];
  readonly kind: 'article';
  readonly publishedAt: string;
  readonly socialImage?: string;
  readonly socialImageAlt?: string;
  readonly slug: string;
  readonly summary: string;
  readonly title: string;
}

export interface WebsiteSocialImage {
  readonly alt: string;
  readonly height: number;
  readonly type: 'image/png';
  readonly url: string;
  readonly width: number;
}

export const websiteArticleSocialImageWidth = 1200;
export const websiteArticleSocialImageHeight = 630;
export const websiteDefaultSiteSocialImage: WebsiteSocialImage = Object.freeze({
  alt: 'Threadnote logo on a dark background',
  height: 1024,
  type: 'image/png',
  url: 'https://threadnote.io/brand/avatars/threadnote-avatar-brand-dark-1024.png',
  width: 1024,
});

export function websiteSocialImageForArticle(
  article: Pick<WebsiteArticle, 'socialImage' | 'socialImageAlt'>,
): WebsiteSocialImage {
  return article.socialImage && article.socialImageAlt
    ? {
        alt: article.socialImageAlt,
        height: websiteArticleSocialImageHeight,
        type: 'image/png',
        url: new URL(article.socialImage, 'https://threadnote.io/').href,
        width: websiteArticleSocialImageWidth,
      }
    : websiteDefaultSiteSocialImage;
}

export function websiteSocialImageForRelease(
  release: Readonly<{socialImage: string; socialImageAlt: string}>,
): WebsiteSocialImage {
  return {
    alt: release.socialImageAlt,
    height: websiteArticleSocialImageHeight,
    type: 'image/png',
    url: new URL(release.socialImage, 'https://threadnote.io/').href,
    width: websiteArticleSocialImageWidth,
  };
}

export interface WebsiteUpdateOrderRef {
  readonly publishedAt: string;
  readonly stableId: string;
}

export type WebsiteUpdateKind = 'article' | 'release';

export function filterWebsiteUpdatesByKind<T extends Readonly<{kind: WebsiteUpdateKind}>>(
  updates: readonly T[],
  kind: WebsiteUpdateKind,
): readonly T[] {
  return EffectArray.filter(updates, update => update.kind === kind);
}

export function orderWebsiteUpdatesDescending<T extends WebsiteUpdateOrderRef>(updates: readonly T[]): readonly T[] {
  return [...updates].sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
      Effect.pipe(left.stableId, EffectString.localeCompare(right.stableId)),
  );
}
