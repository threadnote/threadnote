import {Array as EffectArray, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {applyScrubber, credentialScrubberBlocker} from '@threadnote/platform/scrubber';

import type {SuperhumanDocumentSnapshot, SuperhumanLine, SuperhumanPage} from './client.js';

export const SUPERHUMAN_RENDERER_VERSION = 'canvas-page-text-v2';
export const SUPERHUMAN_SCRUBBER_VERSION = 'credential-scrubber-v1';
export const SUPERHUMAN_PAGE_LIMIT_BYTES = 480 * 1024;

export interface SuperhumanChunk {
  readonly pageId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly body: string;
  readonly remoteRevision?: string;
  readonly contentHash: string;
}

export class SuperhumanSecretBlocked extends Schema.TaggedError<
  SuperhumanSecretBlocked,
  {readonly brand: unique symbol}
>()('SuperhumanSecretBlocked', {message: Schema.String}) {}

export class SuperhumanPageTooLarge extends Schema.TaggedError<
  SuperhumanPageTooLarge,
  {readonly brand: unique symbol}
>()('SuperhumanPageTooLarge', {message: Schema.String}) {}

export function normalizeSuperhumanDisplayText(value: string): string {
  return EffectArray.join(
    EffectArray.filter([...Effect.pipe(value, EffectString.replace(/\r\n?/g, '\n'))], character => {
      const code = Effect.pipe(
        character,
        EffectString.charCodeAt(0),
        Effect.Option.getOrElse(() => NaN),
      );
      return (code >= 32 || code === 10 || code === 9) && (code < 127 || code > 159);
    }),
    '',
  );
}

export function normalizeSuperhumanTitle(value: string): string {
  return EffectArray.join(
    EffectArray.map([...normalizeSuperhumanDisplayText(value)], character =>
      character === '\n' || character === '\t' ? ' ' : character,
    ),
    '',
  );
}

export function renderSuperhumanDocument(snapshot: SuperhumanDocumentSnapshot): readonly SuperhumanChunk[] {
  const selectedText = EffectArray.join(
    EffectArray.flatMap(snapshot.pages, ({lines}) => EffectArray.map(lines, line => line.content ?? '')),
    '',
  );
  if (
    EffectArray.some(
      snapshot.pages,
      ({page, lines}) =>
        Boolean(credentialScrubberBlocker(page.name)) ||
        EffectArray.some(lines, line => Boolean(credentialScrubberBlocker(line.style ?? ''))),
    ) ||
    credentialScrubberBlocker(selectedText) ||
    credentialScrubberBlocker(normalizeSuperhumanDisplayText(selectedText))
  )
    throw SuperhumanSecretBlocked.make({message: 'Selected Superhuman document contains credential-like content.'});
  return EffectArray.map(snapshot.pages, ({page, lines}) => {
    const title = splitUtf8(normalizeSuperhumanTitle(scrub(page.name)), 512)[0] ?? '';
    const paragraphs = EffectArray.flatMap(lines, line =>
      line.content === undefined || line.content === '' ? [] : [formatLine(line, scrub(line.content))],
    );
    const body = EffectArray.join([`# ${title}`, ...paragraphs], '\n\n');
    if (Buffer.byteLength(body) > SUPERHUMAN_PAGE_LIMIT_BYTES)
      throw SuperhumanPageTooLarge.make({message: 'Selected Superhuman page exceeds the resource size limit.'});
    return {
      pageId: page.id,
      chunkId: 'page',
      title,
      body,
      ...(page.updatedAt === undefined ? {} : {remoteRevision: page.updatedAt}),
      contentHash: sha256HexSync(`${SUPERHUMAN_RENDERER_VERSION}\n${SUPERHUMAN_SCRUBBER_VERSION}\n${body}`),
    };
  });
}

function scrub(value: string): string {
  const result = applyScrubber(value, {redact: true});
  if (result.blocker)
    throw SuperhumanSecretBlocked.make({message: 'Selected Superhuman document contains credential-like content.'});
  return normalizeSuperhumanDisplayText(result.cleaned);
}

function formatLine(line: SuperhumanLine, content: string): string {
  const style = Effect.pipe(scrub(line.style ?? 'plain'), EffectString.toLowerCase);
  const heading = /^h([1-6])$/.exec(style);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${content}`;
  return content;
}

export function superhumanPageFingerprint(page: SuperhumanPage): string {
  return sha256HexSync(JSON.stringify(page));
}

export {splitUtf8} from '@threadnote/integration-core/render';
import {splitUtf8} from '@threadnote/integration-core/render';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
