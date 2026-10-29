import {Array as EffectArray} from 'effect';
import {Base64} from 'effect/encoding';
import {
  memoryReadBoundedWarnings,
  type MemoryReadMode,
  type MemoryReadResource,
} from '@threadnote/memory/read/projection';
import {extractExactMemoryTokens, renderExactTokenAppendix} from './exact_tokens.js';
import type {RenderedMemoryImages} from './render.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const IMAGE_PROJECTION_MAX_PAGES = 8 as const;

export interface ImageProjectedReadResult {
  readonly _meta: {
    readonly 'threadnote.io/memory-scope'?: unknown;
    readonly 'threadnote.io/read-page': ImageProjectedReadPageMeta;
  };
  readonly content: readonly ImageProjectedContentBlock[];
  readonly structuredContent: ImageProjectedStructuredContent;
}

export interface ImageProjectedReadPageMeta {
  readonly canonicalUri?: string;
  readonly contentIndex: 0;
  readonly pageCount: number;
  readonly projection: 'image';
  readonly requestedUri?: string;
  readonly resource: number;
  readonly resourceCount: number;
  readonly type: 'threadnote-read-page';
  readonly uri: string;
  readonly version: 1;
}

export interface ImageProjectedStructuredContent {
  readonly budgetTokens: number;
  readonly canonicalUri?: string;
  readonly complete: true;
  readonly content: '';
  readonly contentBytes: 0;
  readonly estimatedTokens: 0;
  readonly mode: 'content';
  readonly pageCount: number;
  readonly projection: 'image';
  readonly requestedUri?: string;
  readonly resource: number;
  readonly resourceCount: number;
  readonly type: 'threadnote-read-page';
  readonly version: 1;
}

export type ImageProjectedContentBlock =
  | {readonly text: string; readonly type: 'text'}
  | {readonly data: string; readonly mimeType: 'image/png'; readonly type: 'image'};

export function imageProjectionAttemptEligible(options: {
  readonly mode?: MemoryReadMode;
  readonly requestedCursor?: string;
  readonly section?: string;
}): boolean {
  if (Effect.pipe(options.requestedCursor ?? '', EffectString.trim).length > 0) return false;
  if ((options.mode ?? 'content') !== 'content') return false;
  return Effect.pipe(options.section ?? '', EffectString.trim).length === 0;
}

export function imageProjectionSourceText(resources: readonly MemoryReadResource[]): string {
  if (resources.length === 1) return resources[0]?.text ?? '';
  return EffectArray.join(
    EffectArray.map(resources, resource => `## ${resource.uri}\n\n${resource.text}`),
    '\n\n',
  );
}

export function buildImageProjectedReadResult(options: {
  readonly budgetTokens: number;
  readonly memoryScopeReceipt?: unknown;
  readonly pages: RenderedMemoryImages['pages'];
  readonly resources: readonly MemoryReadResource[];
  readonly source: string;
  readonly warnings?: readonly string[];
}): ImageProjectedReadResult | undefined {
  if (options.pages.length === 0 || options.pages.length > IMAGE_PROJECTION_MAX_PAGES) return undefined;
  const resource = options.resources[0];
  if (resource === undefined) return undefined;
  const appendix = renderExactTokenAppendix(extractExactMemoryTokens(options.source));
  const caption = EffectArray.join(
    [
      `Full memory as ${options.pages.length} PNG page${options.pages.length === 1 ? '' : 's'}. Image projection is lossy for hex and identifiers.`,
      ...(memoryReadBoundedWarnings(options.warnings) ?? []),
    ],
    '\n',
  );
  const resourceIndex = 1;
  const structuredContent: ImageProjectedStructuredContent = {
    budgetTokens: options.budgetTokens,
    complete: true,
    content: '',
    contentBytes: 0,
    estimatedTokens: 0,
    mode: 'content',
    pageCount: options.pages.length,
    projection: 'image',
    resource: resourceIndex,
    resourceCount: options.resources.length,
    type: 'threadnote-read-page',
    version: 1,
    ...(resource.canonicalUri === undefined ? {} : {canonicalUri: resource.canonicalUri}),
    ...(resource.requestedUri === undefined ? {} : {requestedUri: resource.requestedUri}),
  };
  return {
    _meta: {
      ...(options.memoryScopeReceipt === undefined ? {} : {'threadnote.io/memory-scope': options.memoryScopeReceipt}),
      'threadnote.io/read-page': {
        contentIndex: 0,
        pageCount: options.pages.length,
        projection: 'image',
        resource: resourceIndex,
        resourceCount: options.resources.length,
        type: 'threadnote-read-page',
        uri: resource.uri,
        version: 1,
        ...(resource.canonicalUri === undefined ? {} : {canonicalUri: resource.canonicalUri}),
        ...(resource.requestedUri === undefined ? {} : {requestedUri: resource.requestedUri}),
      },
    },
    content: [
      {text: caption, type: 'text'},
      ...EffectArray.map(options.pages, page => ({
        data: Base64.encode(page.png),
        mimeType: 'image/png' as const,
        type: 'image' as const,
      })),
      ...(appendix === undefined ? [] : [{text: appendix, type: 'text' as const}]),
    ],
    structuredContent,
  };
}
