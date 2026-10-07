import React, {useState} from 'react';
import {Check, CircleAlert, CircleCheck, Database, Plug, RefreshCw, Settings2, ShieldCheck} from 'lucide-react';

export interface RuntimeCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: 'fail' | 'ok' | 'warn';
}

export function runtimeHealthGroups(checks: readonly RuntimeCheck[]) {
  const groups = [
    {
      label: 'Runtime identity',
      description: 'Installation, executable and runtime readiness',
      icon: CircleCheck,
      checks: [] as RuntimeCheck[],
    },
    {
      label: 'Storage and search',
      description: 'Local stores, recall indexes and models',
      icon: Database,
      checks: [] as RuntimeCheck[],
    },
    {
      label: 'Agent integrations',
      description: 'Agent clients, skills and context connections',
      icon: Plug,
      checks: [] as RuntimeCheck[],
    },
    {
      label: 'Workspace configuration',
      description: 'Project setup and local preferences',
      icon: Settings2,
      checks: [] as RuntimeCheck[],
    },
  ];
  for (const check of checks) {
    const group = /index|storage|model|embedding|vector|sqlite|recall|database/iu.test(check.name)
      ? 1
      : /mcp|agent|claude|codex|cursor|hook|skill|copilot|integration/iu.test(check.name)
        ? 2
        : /runtime|install|executable|binary|version|bun|node|native|release/iu.test(check.name)
          ? 0
          : 3;
    groups[group].checks.push(check);
  }
  return groups
    .filter(group => group.checks.length)
    .map(group => ({
      ...group,
      status: group.checks.some(check => check.status === 'fail')
        ? ('fail' as const)
        : group.checks.some(check => check.status === 'warn')
          ? ('warn' as const)
          : ('ok' as const),
    }));
}

export function RuntimeHealthPanel(props: {
  readonly checks: readonly RuntimeCheck[];
  readonly busy?: string;
  readonly output: string;
  readonly onVerify: () => void;
  readonly onPreviewRepair: () => Promise<boolean>;
  readonly onRepair: () => void;
  readonly onRefresh: () => void;
  readonly version?: string;
  readonly latestVersion?: string;
  readonly updateAvailable?: boolean;
  readonly policy?: 'automatic' | 'notify';
  readonly updateNotice?: string;
}): React.ReactElement {
  const [tab, setTab] = useState<'diagnostics' | 'repair' | 'updates'>('diagnostics');
  const [previewed, setPreviewed] = useState(false);
  const groups = runtimeHealthGroups(props.checks);
  return (
    <section className="panel health-panel is-active" aria-busy={!!props.busy}>
      <div className="workspace-tabs" role="tablist" aria-label="Runtime Health sections">
        {(['diagnostics', 'repair', 'updates'] as const).map(value => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'is-active' : undefined}
            onClick={() => setTab(value)}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      {props.busy ? (
        <div className="workspace-note" role="status">
          <RefreshCw />
          {props.busy}…
        </div>
      ) : null}
      {tab === 'diagnostics' ? (
        <>
          <section className="workspace-card">
            <header>
              <h3>Installation checks</h3>
            </header>
            {groups.length ? (
              groups.map(group => (
                <details className="runtime-check-group" key={group.label}>
                  <summary className="workspace-row">
                    <group.icon aria-hidden="true" />
                    <div className="row-copy">
                      <strong>{group.label}</strong>
                      <p>
                        {group.description} · {group.checks.length} checks
                      </p>
                    </div>
                    <span
                      className={`workspace-status ${group.status === 'fail' ? 'error' : group.status === 'warn' ? 'warn' : ''}`}
                    >
                      {group.status === 'ok' ? <Check /> : <CircleAlert />}
                      {group.status === 'ok' ? 'Passed' : group.status === 'warn' ? 'Needs attention' : 'Failed'}
                    </span>
                  </summary>
                  <div className="runtime-check-details">
                    {group.checks.map(check => (
                      <div key={check.name}>
                        <span
                          className={`workspace-status ${check.status === 'ok' ? '' : check.status === 'warn' ? 'warn' : 'error'}`}
                        >
                          {check.status === 'ok' ? 'Passed' : check.status === 'warn' ? 'Warning' : 'Failed'}
                        </span>
                        <strong>{check.name}</strong>
                        <p>{check.detail}</p>
                      </div>
                    ))}
                  </div>
                </details>
              ))
            ) : (
              <p className="workspace-empty">
                {props.busy ? 'Checking the installation…' : 'Run diagnostics to inspect this installation.'}
              </p>
            )}
          </section>
          <details className="health-technical">
            <summary>Technical diagnostic output</summary>
            <pre>
              {props.checks
                .map(check => `${check.status.toUpperCase()} · ${check.name}\n${check.detail}`)
                .join('\n\n') || 'No diagnostic results yet.'}
            </pre>
            {props.output ? <pre>{props.output}</pre> : null}
            <button disabled={!!props.busy} onClick={props.onVerify}>
              Verify runtime
            </button>
          </details>
        </>
      ) : tab === 'repair' ? (
        <section className="workspace-card">
          <header>
            <h3>Preview a runtime repair</h3>
          </header>
          <div className="workspace-pad">
            <p className="muted">Review the proposed changes before repairing the local installation.</p>
            <div className="action-row">
              <button
                disabled={!!props.busy}
                onClick={() => void props.onPreviewRepair().then(success => setPreviewed(success))}
              >
                Preview repair
              </button>
              <button disabled={!!props.busy || !previewed} onClick={props.onRepair}>
                Apply repair…
              </button>
            </div>
            {props.output ? <pre className="output">{props.output}</pre> : null}
          </div>
        </section>
      ) : (
        <section className="workspace-card">
          <header>
            <h3>Updates</h3>
          </header>
          <div className="workspace-row">
            <ShieldCheck />
            <div className="row-copy">
              <strong>Installed runtime</strong>
              <p>{props.version ? `Version ${props.version}` : 'Version unavailable'}</p>
            </div>
            {props.updateAvailable && props.latestVersion ? (
              <span className="workspace-status warn">v{props.latestVersion} available</span>
            ) : (
              <span className="workspace-status neutral">
                {props.latestVersion ? 'Up to date' : 'No update information'}
              </span>
            )}
          </div>
          <div className="workspace-row">
            <Settings2 />
            <div className="row-copy">
              <strong>Update policy</strong>
              <p>
                {props.policy === 'automatic'
                  ? 'Install eligible updates automatically.'
                  : 'Notify when a new version is available.'}
              </p>
              {props.updateNotice ? <p>{props.updateNotice}</p> : null}
            </div>
            <button onClick={props.onRefresh}>
              <RefreshCw />
              Refresh status
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
