import React from 'react';
import {FileText, LockKeyhole, UserRound, Users} from 'lucide-react';
import type {MemoryMetadata, TreeNode} from './ui/contracts.js';
import {MarkdownViewer} from './ui/controls.js';
import {libraryItemTitle} from './library_model.js';
import {AutomaticMemoryPanel} from './attention/automatic_memory.js';
import {TopicExpansionPanel} from './attention/topic_expansion.js';
import {isAgentArtifactUri} from '@threadnote/memory/document';

export function LibraryArticle({
  node,
  metadata,
  markdown,
  resource,
  onChanged,
  onVerifiedUpdate,
  onPrepareGraph,
  onOpenMemory,
}: {
  readonly node: TreeNode;
  readonly metadata?: MemoryMetadata;
  readonly markdown: string;
  readonly resource: boolean;
  readonly onChanged?: () => void;
  readonly onVerifiedUpdate?: () => void;
  readonly onPrepareGraph?: () => void;
  readonly onOpenMemory?: (uri: string) => void;
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
      {!resource && !node.isSystem && !isAgentArtifactUri(node.uri) && metadata?.status === 'active' ? (
        <AutomaticMemoryPanel
          key={node.uri}
          uri={node.uri}
          onOpenMemory={onOpenMemory}
          project={metadata.project ?? 'unscoped'}
          onChanged={onVerifiedUpdate ?? onChanged}
        />
      ) : null}
      <MarkdownViewer markdown={markdown} onOpenMemory={onOpenMemory} />
      {!resource &&
      !node.isShared &&
      !node.isSystem &&
      metadata?.kind === 'durable' &&
      metadata.status === 'active' &&
      metadata.project &&
      metadata.topicMaintenance &&
      (metadata.topicMaintenance.version === 1 ||
        metadata.topicMaintenance.version === 2 ||
        (metadata.topicMaintenance.version === 3 && metadata.topicMaintenance.sourceKind === 'code')) ? (
        <TopicExpansionPanel
          key={`${node.uri}:${metadata.project}`}
          uri={node.uri}
          project={metadata.project}
          onChanged={onChanged}
          onPrepareGraph={onPrepareGraph}
        />
      ) : null}
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
