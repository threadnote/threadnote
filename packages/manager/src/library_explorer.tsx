import {Folder, FileText} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import type {TreeNode} from '@threadnote/manager/ui/contracts';
import {nodeMatches, treeItemClass} from '@threadnote/manager/ui/support';

import {ActionMenu, type MenuAction} from './action_menu.js';
import {descendantMemoryUris, libraryExplorerNodes, libraryItemTitle} from './library_model.js';

const EMPTY_SELECTED_URIS: ReadonlySet<string> = new Set();

export function LibraryExplorer(props: {
  readonly scopeLabel?: string;
  readonly actions: (node: TreeNode) => readonly MenuAction[];
  readonly busy: boolean;
  readonly controlsBlocked: boolean;
  readonly filter: string;
  readonly navTreeTab: 'memories' | 'resources';
  readonly onFilter: (filter: string) => void;
  readonly onRefresh: () => void;
  readonly onSelect: (uri: string) => void;
  readonly onShowSystem: (show: boolean) => void;
  readonly onTab: (tab: 'memories' | 'resources') => void;
  readonly onToggleSelection: (node: TreeNode, checked: boolean) => void;
  readonly resourceTree?: TreeNode;
  readonly selectedUri?: string;
  readonly selectedUris: ReadonlySet<string>;
  readonly showSystem: boolean;
  readonly tree?: TreeNode;
}): React.ReactElement {
  return (
    <aside className="library-explorer" aria-label="Memory browser">
      <header className="explorer-heading">
        <span>{props.navTreeTab === 'resources' ? 'Sources' : (props.scopeLabel ?? 'Local')}</span>
        <span>
          {(props.navTreeTab === 'resources' ? props.resourceTree : props.tree)
            ? descendantMemoryUris((props.navTreeTab === 'resources' ? props.resourceTree : props.tree)!).length
            : 0}
        </span>
      </header>
      <nav className="tree" aria-label="Context tree">
        {libraryExplorerNodes(props.navTreeTab === 'resources' ? props.resourceTree : props.tree).map(node => (
          <Tree
            key={node.uri}
            depth={0}
            actions={props.actions}
            filter={props.filter}
            node={node}
            onSelect={props.onSelect}
            onToggleSelection={props.onToggleSelection}
            selectable={props.navTreeTab === 'memories'}
            selectedUri={props.selectedUri}
            selectedUris={props.selectedUris}
            selectionDisabled={props.busy || props.controlsBlocked}
            showSystem={props.showSystem}
          />
        ))}
      </nav>
      <p className="explorer-note">
        {props.navTreeTab === 'resources'
          ? 'Resources keep their source identity. Memories capture what you learned from them.'
          : 'Selecting a folder includes collapsed and filtered descendants.'}
      </p>
    </aside>
  );
}

function Tree(props: {
  readonly depth?: number;
  readonly actions: (node: TreeNode) => readonly MenuAction[];
  readonly filter: string;
  readonly node: TreeNode;
  readonly onSelect: (uri: string) => void;
  readonly onToggleSelection?: (node: TreeNode, checked: boolean) => void;
  readonly selectable?: boolean;
  readonly selectedUri?: string;
  readonly selectedUris?: ReadonlySet<string>;
  readonly selectionDisabled?: boolean;
  readonly showSystem: boolean;
}): React.ReactElement | null {
  const [open, setOpen] = useState((props.depth ?? 0) === 0);
  const selectable = props.selectable !== false && !props.node.isSystem;
  const selectedUris = props.selectedUris ?? EMPTY_SELECTED_URIS;
  if (!props.showSystem && props.node.isSystem) return null;
  if (props.filter && !nodeMatches(props.node, props.filter)) return null;
  if (props.node.isDir) {
    const selectableUris = selectable ? descendantMemoryUris(props.node) : [];
    const selectedCount = selectableUris.filter(uri => selectedUris.has(uri)).length;
    const checked = selectableUris.length > 0 && selectedCount === selectableUris.length;
    const indeterminate = selectedCount > 0 && selectedCount < selectableUris.length;
    return (
      <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary
          className={treeItemClass(props.selectedUri === props.node.uri, !selectable)}
          title={props.node.uri}
          style={{paddingLeft: 7 + 13 * (props.depth ?? 0)}}
        >
          {selectable ? (
            <TreeSelectionCheckbox
              label={`Select folder ${props.node.name} and all descendant memories`}
              checked={checked}
              disabled={props.selectionDisabled === true || selectableUris.length === 0}
              indeterminate={indeterminate}
              onChange={next => props.onToggleSelection?.(props.node, next)}
            />
          ) : null}
          <span aria-hidden="true" className="tree-caret" />
          <span className="tree-name">
            <Folder aria-hidden="true" />
            {libraryItemTitle(props.node)}
          </span>
          <span className="tree-count">{descendantMemoryUris(props.node).length}</span>
          {!props.node.isSystem ? (
            <ActionMenu
              label={`Actions for ${props.node.name}`}
              actions={props.actions(props.node)}
              disabled={props.selectionDisabled}
            />
          ) : null}
        </summary>
        <div className="tree-children">
          {(props.node.children ?? []).map(child => (
            <Tree key={child.uri} {...props} node={child} depth={(props.depth ?? 0) + 1} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <div
      className={treeItemClass(props.selectedUri === props.node.uri, !selectable, 'tree-row')}
      style={{paddingLeft: 7 + 13 * (props.depth ?? 0)}}
    >
      {selectable ? (
        <input
          aria-label={`Select ${props.node.name}`}
          checked={selectedUris.has(props.node.uri)}
          disabled={props.selectionDisabled === true}
          onChange={event => props.onToggleSelection?.(props.node, event.target.checked)}
          type="checkbox"
        />
      ) : null}
      <button className="tree-file" onClick={() => props.onSelect(props.node.uri)} title={props.node.uri}>
        <span className="tree-name">
          <FileText aria-hidden="true" />
          {libraryItemTitle(props.node)}
        </span>
      </button>
      {!props.node.isSystem ? (
        <ActionMenu
          label={`Actions for ${props.node.name}`}
          actions={props.actions(props.node)}
          disabled={props.selectionDisabled}
        />
      ) : null}
    </div>
  );
}

function TreeSelectionCheckbox(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly indeterminate: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.indeterminate;
  }, [props.indeterminate]);
  return (
    <input
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={event => props.onChange(event.target.checked)}
      onClick={event => event.stopPropagation()}
      ref={ref}
      type="checkbox"
    />
  );
}
