import {sha256HexSync} from '@threadnote/platform/sha256';
import {applyScrubber, credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {Data} from 'effect';
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

export class SuperhumanSecretBlocked extends Data.TaggedError('SuperhumanSecretBlocked')<{
  readonly message: string;
}> {}

export class SuperhumanPageTooLarge extends Data.TaggedError('SuperhumanPageTooLarge')<{
  readonly message: string;
}> {}

export function normalizeSuperhumanDisplayText(value: string): string {
  return [...value.replace(/\r\n?/g, '\n')]
    .filter(character => {
      const code = character.charCodeAt(0);
      return (code >= 32 || code === 10 || code === 9) && (code < 127 || code > 159);
    })
    .join('');
}

export function normalizeSuperhumanTitle(value: string): string {
  return [...normalizeSuperhumanDisplayText(value)]
    .map(character => (character === '\n' || character === '\t' ? ' ' : character))
    .join('');
}

export function renderSuperhumanDocument(snapshot: SuperhumanDocumentSnapshot): readonly SuperhumanChunk[] {
  const selectedText = snapshot.pages.flatMap(({lines}) => lines.map(line => line.content ?? '')).join('');
  if (
    snapshot.pages.some(
      ({page, lines}) =>
        credentialScrubberBlocker(page.name) || lines.some(line => credentialScrubberBlocker(line.style ?? '')),
    ) ||
    credentialScrubberBlocker(selectedText) ||
    credentialScrubberBlocker(normalizeSuperhumanDisplayText(selectedText))
  )
    throw new SuperhumanSecretBlocked({message: 'Selected Superhuman document contains credential-like content.'});
  return snapshot.pages.map(({page, lines}) => {
    const title = splitUtf8(normalizeSuperhumanTitle(scrub(page.name)), 512)[0] ?? '';
    const paragraphs = lines.flatMap(line =>
      line.content === undefined || line.content === '' ? [] : [formatLine(line, scrub(line.content))],
    );
    const body = [`# ${title}`, ...paragraphs].join('\n\n');
    if (Buffer.byteLength(body) > SUPERHUMAN_PAGE_LIMIT_BYTES)
      throw new SuperhumanPageTooLarge({message: 'Selected Superhuman page exceeds the resource size limit.'});
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
    throw new SuperhumanSecretBlocked({message: 'Selected Superhuman document contains credential-like content.'});
  return normalizeSuperhumanDisplayText(result.cleaned);
}

function formatLine(line: SuperhumanLine, content: string): string {
  const style = scrub(line.style ?? 'plain').toLowerCase();
  const heading = /^h([1-6])$/.exec(style);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${content}`;
  return content;
}

export function superhumanPageFingerprint(page: SuperhumanPage): string {
  return sha256HexSync(JSON.stringify(page));
}

export {splitUtf8} from '@threadnote/integration-core/render';
import {splitUtf8} from '@threadnote/integration-core/render';
