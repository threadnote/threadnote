import React, {useState} from 'react';
import {Check, GitBranch, Pencil, Plus, RefreshCw, Unlink, Users} from 'lucide-react';
import {ActionMenu} from './action_menu.js';
import {useManagerDialogs} from './dialog.js';
import {PageActions} from './workspace.js';
import type {ShareSummary} from './ui/contracts.js';
import {api, errorMessage} from './ui/support.js';

export function SharingPanel(props: {
  readonly shares: readonly ShareSummary[];
  readonly onChanged: () => Promise<void>;
  readonly onBrowse: (team: string) => void;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function run(team: string, path: string, body: Record<string, unknown>): Promise<void> {
    if (busy) return;
    setBusy(team || 'new');
    setNotice('');
    setError('');
    try {
      await api(path, body);
      await props.onChanged();
      setNotice('Team settings updated.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function connect(): Promise<void> {
    const values = await dialogs.prompt({
      title: 'Connect a team',
      confirmLabel: 'Connect team',
      message: 'Use a Git repository to share reviewed knowledge with your team.',
      fields: [
        {id: 'team', label: 'Team name', required: true},
        {
          id: 'remoteUrl',
          label: 'Git repository URL',
          required: true,
          placeholder: 'git@github.com:team/shared-context.git',
        },
      ],
    });
    if (values) await run(values.team, '/api/shares/init', {...values, confirm: true});
  }
  async function configure(share: ShareSummary, rename: boolean): Promise<void> {
    const values = await dialogs.prompt({
      title: rename ? 'Rename team' : 'Team repository',
      confirmLabel: 'Save changes',
      detail: share.name,
      fields: [
        rename
          ? {id: 'to', label: 'Team name', initialValue: share.name, required: true}
          : {id: 'remoteUrl', label: 'Git repository URL', initialValue: share.remote, required: true},
      ],
    });
    if (values)
      await run(share.name, rename ? '/api/shares/rename' : '/api/shares/set-url', {
        ...values,
        team: share.name,
        confirm: true,
      });
  }
  async function disconnect(share: ShareSummary): Promise<void> {
    const values = await dialogs.prompt({
      title: `Disconnect ${share.name}?`,
      confirmLabel: 'Disconnect team',
      tone: 'danger',
      message: 'Retire this team’s shared Library from local recall. Review which local copies to keep.',
      fields: [
        {
          id: 'memories',
          label: 'Personal memories',
          options: ['Keep personal copies', 'Do not create personal copies'],
          initialValue: 'Keep personal copies',
          required: true,
        },
        {
          id: 'files',
          label: 'Repository files',
          options: ['Keep repository files', 'Remove managed repository files'],
          initialValue: 'Keep repository files',
          required: true,
        },
      ],
    });
    if (values)
      await run(share.name, '/api/shares/remove', {
        team: share.name,
        confirm: true,
        preserveLocal: values.memories === 'Keep personal copies',
        keepFiles: values.files === 'Keep repository files',
      });
  }
  return (
    <section className="panel is-active sharing-workspace">
      <PageActions>
        <button className="primary" disabled={!!busy} onClick={() => void connect()}>
          <Plus aria-hidden="true" />
          Connect team
        </button>
      </PageActions>
      {error ? (
        <p className="workspace-note danger-text" role="alert">
          {error}
        </p>
      ) : notice ? (
        <p className="workspace-note" role="status">
          {notice}
        </p>
      ) : null}
      <div className="workspace-stack">
        {props.shares.length ? (
          props.shares.map(share => (
            <section className="workspace-card" key={share.name}>
              <header>
                <h3>
                  <Users aria-hidden="true" /> {share.name}
                </h3>
                {share.default ? <span className="muted">Default team</span> : null}
              </header>
              <div className="workspace-pad">
                <div className="memory-tags">
                  <span
                    className={`workspace-status ${share.dirty || share.warning || share.behind || share.ahead ? 'warn' : ''}`}
                  >
                    <Check />
                    {share.dirty
                      ? 'Local changes'
                      : share.warning
                        ? 'Needs attention'
                        : share.behind
                          ? `${share.behind} incoming`
                          : share.ahead
                            ? `${share.ahead} outgoing`
                            : 'In sync'}
                  </span>
                  <span className="muted">Shared team knowledge</span>
                </div>
                <p className="sharing-remote">
                  <GitBranch aria-hidden="true" />
                  {share.remote || 'No remote configured'}
                </p>
                {share.warning ? <p className="danger-text">{share.warning}</p> : null}
                <div className="sharing-actions">
                  <button disabled={!!busy} onClick={() => props.onBrowse(share.name)}>
                    Browse memories
                  </button>
                  <span className="workspace-spacer" />
                  <button
                    disabled={!!busy}
                    onClick={() => void run(share.name, '/api/shares/sync', {team: share.name})}
                  >
                    <RefreshCw />
                    {busy === share.name ? 'Working…' : 'Sync'}
                  </button>
                  <ActionMenu
                    label={`Actions for ${share.name}`}
                    disabled={!!busy}
                    actions={[
                      {label: 'Rename team…', icon: <Pencil />, onSelect: () => void configure(share, true)},
                      {
                        label: 'Repository settings…',
                        icon: <GitBranch />,
                        onSelect: () => void configure(share, false),
                      },
                      {
                        label: 'Disconnect team…',
                        icon: <Unlink />,
                        danger: true,
                        onSelect: () => void disconnect(share),
                      },
                    ]}
                  />
                </div>
              </div>
            </section>
          ))
        ) : (
          <div className="workspace-card workspace-empty">
            <Users />
            <h3>Share knowledge with your team</h3>
            <p>Connect a Git repository to publish reviewed memories and browse team context.</p>
            <button onClick={() => void connect()}>Connect team</button>
          </div>
        )}
      </div>
    </section>
  );
}
