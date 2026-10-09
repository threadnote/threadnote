import {sha256HexSync} from '@threadnote/platform/sha256';
import {applyScrubber, credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {Data} from 'effect';
import type {SuperhumanDocumentSnapshot, SuperhumanLine, SuperhumanPage} from './client.js';

export const SUPERHUMAN_RENDERER_VERSION = 'canvas-plain-text-v1';
export const SUPERHUMAN_SCRUBBER_VERSION = 'credential-scrubber-v1';
export const SUPERHUMAN_CHUNK_LIMIT_BYTES = 16 * 1024;

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
  if (
    snapshot.pages.some(
      ({page, lines}) =>
        credentialScrubberBlocker(page.name) || lines.some(line => credentialScrubberBlocker(line.style ?? '')),
    ) ||
    credentialScrubberBlocker(snapshot.pages.flatMap(({lines}) => lines.map(line => line.content ?? '')).join(''))
  )
    throw new SuperhumanSecretBlocked({message: 'Selected Superhuman document contains credential-like content.'});
  const chunks: SuperhumanChunk[] = [];
  for (const {page, lines} of snapshot.pages) {
    const title = splitUtf8(normalizeSuperhumanTitle(scrub(page.name)), 512)[0] ?? '';
    for (const line of lines) {
      if (line.content === undefined || line.content === '') continue;
      const content = scrub(line.content);
      const fragments = splitUtf8(content, SUPERHUMAN_CHUNK_LIMIT_BYTES);
      for (let ordinal = 0; ordinal < fragments.length; ordinal++) {
        const body = formatLine(line, fragments[ordinal]);
        chunks.push({
          pageId: page.id,
          chunkId: `b-${sha256HexSync(line.id).slice(0, 24)}-${ordinal}`,
          title,
          body,
          ...(page.updatedAt === undefined ? {} : {remoteRevision: page.updatedAt}),
          contentHash: sha256HexSync(`${SUPERHUMAN_RENDERER_VERSION}\n${SUPERHUMAN_SCRUBBER_VERSION}\n${body}`),
        });
      }
    }
  }
  return chunks;
}

function scrub(value: string): string {
  const result = applyScrubber(value, {redact: true});
  if (result.blocker)
    throw new SuperhumanSecretBlocked({message: 'Selected Superhuman document contains credential-like content.'});
  return normalizeSuperhumanDisplayText(result.cleaned);
}

function formatLine(line: SuperhumanLine, content: string): string {
  const level = line.lineLevel === undefined ? '' : `level ${line.lineLevel}; `;
  const style = splitUtf8(scrub(line.style ?? 'plain'), 64)[0] ?? 'plain';
  return `[Superhuman Docs line: ${level}style ${JSON.stringify(style)}]
${content}`;
}

export function superhumanPageFingerprint(page: SuperhumanPage): string {
  return sha256HexSync(JSON.stringify(page));
}

export {splitUtf8} from '@threadnote/integration-core/render';
import {splitUtf8} from '@threadnote/integration-core/render';
