import React from 'react';
import {Archive, Download, Files, ListChecks, Trash2, Upload} from 'lucide-react';
import type {MenuAction} from './action_menu.js';
import type {TreeNode} from './ui/contracts.js';
import {canPublishMemoryFromManager, canPublishSelectedMemoriesFromManager, isResourceUri} from './ui/support.js';
import {descendantMemoryUris, type LibraryScope} from './library_model.js';

export function libraryItemActions(
  node: TreeNode,
  actions: {
    readonly tree?: TreeNode;
    readonly scope: LibraryScope;
    readonly open: (uri: string) => Promise<void>;
    readonly select: (node: TreeNode) => void;
    readonly removeResource: (node: TreeNode) => Promise<void>;
    readonly removeFolder: (node: TreeNode) => Promise<void>;
    readonly bulk: (action: 'archive' | 'forget' | 'publish' | 'unpublish', uris: readonly string[]) => Promise<void>;
    readonly unpublish: (uri: string, team?: string) => Promise<void>;
    readonly publish: (uri: string) => Promise<void>;
    readonly archive: (uri: string) => Promise<void>;
    readonly forget: (uri: string) => Promise<void>;
  },
): readonly MenuAction[] {
  if (isResourceUri(node.uri))
    return [
      {label: 'Open resource', icon: <Files />, onSelect: () => void actions.open(node.uri)},
      {
        label: 'Remove indexed copy…',
        icon: <Trash2 />,
        disabled: node.isDir,
        danger: true,
        onSelect: () => void actions.removeResource(node),
      },
    ];
  if (node.isDir) {
    const uris = descendantMemoryUris(node);
    return [
      {
        label: `Select ${uris.length} memories`,
        icon: <ListChecks />,
        disabled: uris.length === 0,
        onSelect: () => actions.select(node),
      },
      ...(node.isShared
        ? [
            {
              label: 'Unpublish contents…',
              icon: <Download />,
              disabled: !uris.length,
              onSelect: () => void actions.bulk('unpublish', uris),
            },
          ]
        : [
            {
              label: 'Archive contents…',
              icon: <Archive />,
              disabled: actions.scope !== 'local' || node.isShared || !uris.length,
              onSelect: () => void actions.bulk('archive', uris),
            },
            {
              label: 'Publish contents…',
              icon: <Upload />,
              disabled: !canPublishSelectedMemoriesFromManager(actions.tree, uris),
              onSelect: () => void actions.bulk('publish', uris),
            },
            {
              label: 'Remove folder and forget…',
              icon: <Trash2 />,
              danger: true,
              disabled: actions.scope !== 'local' || !node.relativePath || node.isShared,
              onSelect: () => void actions.removeFolder(node),
            },
          ]),
    ];
  }
  return [
    {label: 'Open memory', icon: <Files />, onSelect: () => void actions.open(node.uri)},
    ...(node.isShared
      ? [{label: 'Unpublish…', icon: <Download />, onSelect: () => void actions.unpublish(node.uri, node.sharedTeam)}]
      : [
          {
            label: 'Publish…',
            icon: <Upload />,
            disabled: !canPublishMemoryFromManager(node.uri, node.metadata),
            onSelect: () => void actions.publish(node.uri),
          },
          {label: 'Archive…', icon: <Archive />, onSelect: () => void actions.archive(node.uri)},
          {label: 'Forget…', icon: <Trash2 />, danger: true, onSelect: () => void actions.forget(node.uri)},
        ]),
  ];
}
