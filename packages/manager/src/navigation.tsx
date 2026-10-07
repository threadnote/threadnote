import React from 'react';
import {ShieldCheck} from 'lucide-react';
import {ThemeSwitch} from './theme.js';
import type {PanelName} from './ui/contracts.js';
import {panelIcon, panelNavDescription, tabTitle, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN} from './ui/support.js';

export function ManagerNavigation(props: {
  readonly panel: PanelName;
  readonly disabled: boolean;
  readonly connected: boolean;
  readonly onSelect: (panel: PanelName) => void;
  readonly width: number;
  readonly onResizeKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  readonly onResizePointerDown: React.PointerEventHandler<HTMLDivElement>;
  readonly updateIndicator?: {readonly label: string; readonly detail: string};
}): React.ReactElement {
  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">
            <img alt="" className="brand-logo" src="/threadnote-logo.svg" />
            <div>
              <h1>Threadnote</h1>
            </div>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Manager sections">
          {(
            [
              {label: 'Knowledge', items: ['home', 'memory', 'context', 'reviews', 'context-health', 'graph']},
              {label: 'Workspace', items: ['worksets', 'shares']},
              {label: 'System', items: ['processes', 'doctor']},
            ] as const
          ).map(group => (
            <div className="nav-group" key={group.label}>
              <p className="sidebar-label">{group.label}</p>
              {group.items.map(name => (
                <button
                  aria-current={props.panel === name ? 'page' : undefined}
                  className={props.panel === name ? 'is-active' : undefined}
                  disabled={props.disabled}
                  key={name}
                  onClick={() => props.onSelect(name)}
                  title={panelNavDescription(name)}
                  type="button"
                >
                  <span aria-hidden="true" className="nav-icon">
                    {panelIcon(name)}
                  </span>
                  <strong>{tabTitle(name)}</strong>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <ThemeSwitch />

        <div className="sidebar-product-note">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Local runtime</strong>
            <p>{props.connected ? 'Private by default' : 'Connecting…'}</p>
          </div>
        </div>
        {props.updateIndicator ? (
          <div className="sidebar-update">
            <span>{props.updateIndicator.label}</span>
            <strong>{props.updateIndicator.detail}</strong>
          </div>
        ) : null}
      </aside>
      <div
        aria-label="Resize navigation panel"
        aria-orientation="vertical"
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuenow={props.width}
        className="sidebar-resizer"
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizePointerDown}
        role="separator"
        tabIndex={0}
        title="Drag to resize navigation"
      />
    </>
  );
}
