import {Data} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {applyScrubber, credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {splitUtf8} from '@threadnote/integration-core/render';
import type {GitHubConversation, GitHubComment} from './client.js';

export const GITHUB_RENDERER_VERSION = 'github-conversation-v1';
export const GITHUB_SCRUBBER_VERSION = 'credential-scrubber-v1';
export class GitHubSecretBlocked extends Data.TaggedError('GitHubSecretBlocked')<{readonly message: string}> {}
export class GitHubRenderDeferred extends Data.TaggedError('GitHubRenderDeferred')<{readonly message: string}> {}
export interface GitHubChunk {
  readonly pageId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly body: string;
  readonly browserLink: string;
  readonly remoteRevision: string;
  readonly contentHash: string;
}
function scrub(value: string): string {
  if (
    credentialScrubberBlocker(value) ||
    /\b(?:password|api[_-]?key|api[_-]?token|access[_-]?token|client[_-]?secret|authorization)\b\s*[:=]\s*\S/iu.test(
      value,
    ) ||
    /\bbearer\s+\S{8,}/iu.test(value) ||
    /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/u.test(value)
  )
    throw new GitHubSecretBlocked({message: 'GitHub conversation contains credential-like content.'});
  const result = applyScrubber(value, {redact: true});
  if (result.blocker) throw new GitHubSecretBlocked({message: 'GitHub conversation contains credential-like content.'});
  return [...result.cleaned.replace(/\r\n?/g, '\n')]
    .filter(character => {
      const code = character.charCodeAt(0);
      return (code >= 32 || code === 10 || code === 9) && (code < 127 || code > 159);
    })
    .join('');
}
export function renderGitHubConversation(value: GitHubConversation): readonly GitHubChunk[] {
  const title = splitUtf8(scrub(value.title).replaceAll('\n', ' '), 512)[0] ?? `#${value.number}`;
  const prefix = scrub(
    `GitHub ${value.kind} ${value.repository.name}#${value.number}: ${title}\nStatus: ${value.state}${value.merged === undefined ? '' : `; merged=${value.merged}; draft=${value.draft}`}\nConversation: ${value.url}\nCreated: ${value.createdAt}; updated: ${value.updatedAt}\n`,
  );
  const output: GitHubChunk[] = [];
  function emit(pageId: string, context: string, text: string, link: string, revision: string) {
    const cleanContext = scrub(context);
    const cleanText = scrub(text);
    const budget = Math.min(12 * 1024, 16 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(cleanContext) - 8);
    if (budget < 128)
      throw new GitHubRenderDeferred({message: 'GitHub conversation context exceeds the chunk budget.'});
    for (const [ordinal, fragment] of splitUtf8(cleanText || '(empty)', budget).entries()) {
      const body = `${prefix}\n${cleanContext}\n${fragment}`;
      output.push({
        pageId,
        chunkId: `part-${ordinal}`,
        title,
        body,
        browserLink: link,
        remoteRevision: revision,
        contentHash: sha256HexSync(`${GITHUB_RENDERER_VERSION}\n${GITHUB_SCRUBBER_VERSION}\n${body}`),
      });
      if (output.length > 2048)
        throw new GitHubRenderDeferred({message: 'GitHub conversation exceeds the chunk inventory budget.'});
    }
  }
  function provenance(comment: GitHubComment): string {
    return `Author: ${comment.author}\nCreated: ${comment.createdAt}; updated: ${comment.updatedAt}\nSource: ${comment.url}`;
  }

  emit('description', `Description by ${value.author}`, value.body, value.url, value.updatedAt);
  for (const comment of value.comments)
    emit(
      `comment-${comment.id}`,
      `Conversation comment\n${provenance(comment)}`,
      comment.body,
      comment.url,
      comment.updatedAt,
    );
  for (const review of value.reviews)
    emit(
      `review-${review.id}`,
      `Review: ${review.state}\n${provenance(review)}`,
      review.body,
      review.url,
      review.updatedAt,
    );
  for (const thread of value.threads) {
    const context = `Review thread: ${thread.id}\nFile: ${splitUtf8(scrub(thread.path), 1024)[0] ?? ''}${thread.line === null ? '' : `:${thread.line}`}\nResolved: ${thread.resolved}; outdated: ${thread.outdated}\nDiff context:\n${splitUtf8(scrub(thread.diffHunk), 2048)[0] ?? ''}\n`;
    for (const comment of thread.comments) {
      const parent = thread.comments[0];
      const reply =
        comment === parent
          ? ''
          : `Reply to ${parent.author} (${parent.url})\n${splitUtf8(scrub(parent.body), 512)[0] ?? ''}\n`;
      emit(
        `thread-${sha256HexSync(thread.id).slice(0, 32)}-${sha256HexSync(comment.id).slice(0, 32)}`,
        context + reply + provenance(comment),
        comment.body,
        comment.url,
        comment.updatedAt,
      );
    }
  }
  return output;
}
