import React from 'react';
import {FileText, LockKeyhole, UserRound, Users} from 'lucide-react';
import type {MemoryMetadata, TreeNode} from './ui/contracts.js';
import {MarkdownViewer} from './ui/controls.js';
import {libraryItemTitle} from './library_model.js';

export function LibraryArticle({
  node,
  metadata,
  markdown,
  resource,
}: {
  readonly node: TreeNode;
  readonly metadata?: MemoryMetadata;
  readonly markdown: string;
  readonly resource: boolean;
}): React.ReactElement {
  const author = metadata?.sourceAgentClient;
  const timestamp = metadata?.timestamp;
  return (
    <article className="library-article">
      <div className="memory-tags">
        <span className="memory-tag">{resource ? 'Resource' : (metadata?.kind ?? 'Memory')}</span>
        <span className="memory-tag">
          {resource ? <FileText /> : node.isShared ? <Users /> : <LockKeyhole />}
          {resource ? 'Indexed source' : (node.sharedTeam ?? 'Local only')}
        </span>
      </div>
      <h2>{libraryItemTitle(node)}</h2>
      <MarkdownViewer markdown={markdown} />
      <footer className="memory-document-footer">
        {resource ? <FileText /> : <UserRound />}
        <span>
          {resource
            ? 'Source content · read-only'
            : author === 'user'
              ? 'Written by you'
              : author
                ? `Written by ${author}`
                : 'Saved memory'}
        </span>
        {timestamp ? (
          <time dateTime={timestamp}>
            Updated {new Date(timestamp).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}
          </time>
        ) : null}
      </footer>
    </article>
  );
}
