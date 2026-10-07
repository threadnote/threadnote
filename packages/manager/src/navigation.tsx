import React, {useState} from 'react';
import {PanelLeftClose, PanelLeftOpen, ShieldCheck} from 'lucide-react';
import {ThemeSwitch} from './theme.js';
import {readManagerPreference, writeManagerPreference} from './preferences.js';
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
      <aside className="sidebar" id="manager-navigation">
        <div className="brand">
          <div className="brand-title">
            <img alt="" className="brand-logo brand-logo-light" src="/threadnote-logo-dark.svg" />
            <img alt="" className="brand-logo brand-logo-dark" src="/threadnote-logo-light.svg" />
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

export function useNavigationCollapse(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(
    () => readManagerPreference('threadnote.manager.navigationCollapsed') === 'true',
  );
  return [
    collapsed,
    () =>
      setCollapsed(current => {
        writeManagerPreference('threadnote.manager.navigationCollapsed', String(!current));
        return !current;
      }),
  ];
}

export function NavigationToggle(props: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): React.ReactElement {
  const label = props.collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <button
      type="button"
      className="quiet-icon navigation-toggle"
      aria-label={label}
      title={label}
      aria-controls="manager-navigation"
      aria-expanded={!props.collapsed}
      onClick={props.onToggle}
    >
      {props.collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
    </button>
  );
}
