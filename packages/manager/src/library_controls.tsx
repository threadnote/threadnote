import React from 'react';
import {Array as EffectArray, pipe as effectPipe} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Brain, Files, HardDrive, Info, Pencil, Users} from 'lucide-react';
import {ActionMenu, type MenuAction} from './action_menu.js';
import {libraryItemTitle, type LibraryScope} from './library_model.js';
import type {TreeNode, ShareSummary} from './ui/contracts.js';

export function LibraryReaderHeader(props: {
  readonly authoringMemory: boolean;
  readonly creatingMemory: boolean;
  readonly selectedNode?: TreeNode;
  readonly selectedUri?: string;
  readonly selectedIsDir: boolean;
  readonly selectedIsResource: boolean;
  readonly selectedIsReadable: boolean;
  readonly controlsBlocked: boolean;
  readonly canMutate: boolean;
  readonly itemActions: (node: TreeNode) => readonly MenuAction[];
  readonly onToggleView: () => void;
  readonly onDetails: () => void;
  readonly onMove: () => void;
}): React.ReactElement {
  return (
    <div className="pane-head reader-head">
      <span className="reader-location">
        {props.authoringMemory
          ? props.creatingMemory
            ? 'New memory · Unsaved'
            : props.selectedNode
              ? libraryItemTitle(props.selectedNode)
              : 'Memory draft'
          : props.selectedNode
            ? EffectArray.join(
                effectPipe(Effect.pipe(props.selectedNode.relativePath, EffectString.split('/')).slice(0, -1), values =>
                  EffectArray.filter(values, (value, index) => index in values && Boolean(value)),
                ).slice(-1),
                ' / ',
              ) || 'Library'
            : 'Library'}
      </span>
      <div className="action-row">
        {props.selectedUri && !props.selectedIsDir && !props.selectedIsResource ? (
          <button disabled={props.selectedNode?.isSystem || props.controlsBlocked} onClick={props.onToggleView}>
            {props.authoringMemory ? <Files aria-hidden="true" /> : <Pencil aria-hidden="true" />}
            {props.authoringMemory ? 'Preview' : 'Edit'}
          </button>
        ) : null}
        {props.selectedNode ? (
          <button
            className="quiet-icon"
            aria-label="Memory details"
            disabled={!props.selectedIsReadable && !props.selectedIsDir}
            onClick={props.onDetails}
          >
            <Info aria-hidden="true" />
          </button>
        ) : null}
        {props.selectedNode && !props.selectedNode.isSystem ? (
          <ActionMenu
            label={`Actions for ${props.selectedNode.name}`}
            disabled={props.controlsBlocked}
            actions={[
              ...props.itemActions(props.selectedNode),
              ...(!props.selectedNode.isDir && !props.selectedIsResource
                ? [{label: 'Move…', disabled: !props.canMutate, onSelect: () => void props.onMove()}]
                : []),
            ]}
          />
        ) : null}
      </div>
    </div>
  );
}

export function LibraryScopeControls(props: {
  readonly navTreeTab: 'memories' | 'resources';
  readonly controlsBlocked: boolean;
  readonly libraryScope: LibraryScope;
  readonly shares: readonly ShareSummary[];
  readonly onScope: (scope: LibraryScope) => void;
}): React.ReactElement {
  return props.navTreeTab === 'memories' ? (
    <div className="library-scope">
      <div className="segmented-control" aria-label="Memory scope">
        <button
          className={props.libraryScope === 'local' ? 'is-active' : undefined}
          disabled={props.controlsBlocked}
          aria-pressed={props.libraryScope === 'local'}
          onClick={() => {
            void props.onScope('local');
          }}
        >
          <HardDrive aria-hidden="true" />
          Local
        </button>
        <button
          className={props.libraryScope !== 'local' ? 'is-active' : undefined}
          disabled={props.controlsBlocked || props.shares.length === 0}
          aria-pressed={props.libraryScope !== 'local'}
          onClick={() => {
            void props.onScope(`team:${props.shares[0]?.name ?? ''}`);
          }}
        >
          <Users aria-hidden="true" />
          Team
        </button>
      </div>
      {props.libraryScope !== 'local' ? (
        <select
          aria-label="Shared team"
          value={Effect.pipe(props.libraryScope, EffectString.slice(5))}
          disabled={props.controlsBlocked}
          onChange={event => {
            void props.onScope(`team:${event.target.value}`);
          }}
        >
          {EffectArray.map(props.shares, share => (
            <option key={share.name} value={share.name}>
              {share.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  ) : (
    <span className="muted">Indexed source material · read-only</span>
  );
}

export function LibraryContentTabs(props: {
  readonly navTreeTab: 'memories' | 'resources';
  readonly controlsBlocked: boolean;
  readonly onTab: (tab: 'memories' | 'resources') => void;
}): React.ReactElement {
  return (
    <div className="library-tabs">
      <div className="segmented-control" aria-label="Library content">
        {EffectArray.map(['memories', 'resources'] as const, tab => (
          <button
            key={tab}
            aria-pressed={props.navTreeTab === tab}
            className={props.navTreeTab === tab ? 'is-active' : undefined}
            disabled={props.controlsBlocked}
            onClick={() => {
              void props.onTab(tab);
            }}
          >
            {tab === 'memories' ? <Brain aria-hidden="true" /> : <Files aria-hidden="true" />}
            {tab === 'memories' ? 'Memories' : 'Resources'}
          </button>
        ))}
      </div>
    </div>
  );
}
