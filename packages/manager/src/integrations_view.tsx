import React, {useEffect, useState} from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
  Check,
  Inbox,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import {ActionMenu} from './action_menu.js';
import {DetailModal} from './detail_modal.js';
import {PageActions} from './workspace.js';
import {api, errorMessage} from './ui/support.js';
import type {
  IntegrationResult,
  ObsidianAction,
  ObsidianIntegration,
  ObsidianProjection,
  ObsidianSource,
} from './integrations_contracts.js';
import {ObsidianConnectionForm} from './obsidian_connection_form.js';

type Connection =
  | {readonly kind: 'source'; readonly value?: ObsidianSource}
  | {readonly kind: 'projection'; readonly value?: ObsidianProjection};
interface Operation {
  readonly id: string;
  readonly action: ObsidianAction;
  readonly title: string;
  readonly result: IntegrationResult;
}
const empty: ObsidianIntegration = {sources: [], projections: []};

export function IntegrationsPanel({
  onChanged,
  onReviews,
}: {
  readonly onChanged: () => Promise<void>;
  readonly onReviews: () => void;
}): React.ReactElement {
  const [data, setData] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState<Connection>();
  const [operation, setOperation] = useState<Operation>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<ObsidianIntegration>('/api/integrations/obsidian', undefined, {signal: controller.signal})
      .then(value => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [generation]);
  async function changed(message: string): Promise<void> {
    setGeneration(value => value + 1);
    setNotice(message);
    await onChanged();
  }
  async function preview(action: ObsidianAction, id: string, title: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<IntegrationResult>('/api/integrations/obsidian', {action, id, apply: false});
      setOperation({action, id, title, result});
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(kind: 'source' | 'projection', value: ObsidianSource | ObsidianProjection): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/integrations/obsidian', {
        action: 'set-enabled',
        kind,
        id: value.id,
        enabled: !value.enabled,
        apply: true,
        confirm: true,
      });
      await changed(value.enabled ? 'Connection paused.' : 'Connection enabled.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel is-active integrations-workspace">
      <PageActions>
        <button disabled={loading || busy} onClick={() => setGeneration(value => value + 1)}>
          <RefreshCw /> Refresh
        </button>
      </PageActions>
      <div className="integration-intro">
        <span className="integration-mark">
          <BookOpen aria-hidden="true" />
        </span>
        <div>
          <h3>Obsidian</h3>
          <p>Bring vault notes into context and read Threadnote memories in your vault. No Obsidian plugin required.</p>
        </div>
        <span className="memory-tag">{data.sources.length + data.projections.length} connections</span>
      </div>
      {error ? (
        <p role="alert" className="workspace-note danger-text">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="workspace-note">
          {notice}
        </p>
      ) : null}
      {loading ? (
        <p role="status">Loading connections…</p>
      ) : (
        <div className="workspace-stack">
          <section className="workspace-card">
            <header>
              <h3>
                <ArrowDownToLine /> Vault sources
              </h3>
              <button disabled={busy} onClick={() => setConnection({kind: 'source'})}>
                <Plus /> Add vault source
              </button>
            </header>
            <p className="workspace-pad muted">
              Import selected Markdown notes as resources for recall. Source notes stay in your vault; enabled sources
              refresh when agents request context.
            </p>
            {data.sources.length === 0 ? (
              <div className="integration-empty">
                <BookOpen />
                <h4>Bring your notes into context</h4>
                <p>Choose a vault and the folders Threadnote may read.</p>
                <button disabled={busy} onClick={() => setConnection({kind: 'source'})}>
                  Connect a vault
                </button>
              </div>
            ) : (
              data.sources.map(source => (
                <div className="integration-row" key={source.id}>
                  <div className="integration-row-main">
                    <h4>
                      {source.id}{' '}
                      <span className={'workspace-status ' + (source.enabled ? '' : 'neutral')}>
                        {source.enabled ? 'Enabled' : 'Paused'}
                      </span>
                    </h4>
                    <p className="integration-path">{source.vault}</p>
                    <p className="muted">
                      Include: {source.include.join(', ')}
                      {source.inbox ? ' · Inbox: ' + source.inbox : ''}
                    </p>
                  </div>
                  <div className="integration-row-actions">
                    {source.inbox ? (
                      <button
                        disabled={busy || !source.enabled}
                        onClick={() => void preview('scan-inbox', source.id, 'Review Inbox notes')}
                      >
                        <Inbox /> Scan Inbox
                      </button>
                    ) : null}
                    <button
                      disabled={busy || !source.enabled}
                      onClick={() => void preview('sync-source', source.id, 'Preview vault import')}
                    >
                      <RefreshCw /> Preview import
                    </button>
                    <ActionMenu
                      label={'Actions for vault source ' + source.id}
                      disabled={busy}
                      actions={[
                        {
                          label: 'Connection settings…',
                          icon: <Pencil />,
                          onSelect: () => setConnection({kind: 'source', value: source}),
                        },
                        {
                          label: source.enabled ? 'Pause connection' : 'Enable connection',
                          icon: source.enabled ? <Pause /> : <Play />,
                          onSelect: () => void toggle('source', source),
                        },
                        {
                          label: 'Disconnect source…',
                          icon: <Unplug />,
                          danger: true,
                          onSelect: () => void preview('remove-source', source.id, 'Disconnect vault source'),
                        },
                      ]}
                    />
                  </div>
                </div>
              ))
            )}
          </section>
          <section className="workspace-card">
            <header>
              <h3>
                <ArrowUpFromLine /> Memory exports
              </h3>
              <button disabled={busy} onClick={() => setConnection({kind: 'projection'})}>
                <Plus /> Add memory export
              </button>
            </header>
            <p className="workspace-pad muted">
              Write readable copies of selected memories to a managed vault folder. Edits made in Obsidian are protected
              from being overwritten.
            </p>
            {data.projections.length === 0 ? (
              <div className="integration-empty">
                <ArrowUpFromLine />
                <h4>Read your memories in Obsidian</h4>
                <p>Choose what to export and preview every sync before applying it.</p>
                <button disabled={busy} onClick={() => setConnection({kind: 'projection'})}>
                  Set up memory export
                </button>
              </div>
            ) : (
              data.projections.map(projection => (
                <div className="integration-row" key={projection.id}>
                  <div className="integration-row-main">
                    <h4>
                      {projection.id}{' '}
                      <span className={'workspace-status ' + (projection.enabled ? '' : 'neutral')}>
                        {projection.enabled ? 'Enabled' : 'Paused'}
                      </span>
                    </h4>
                    <p className="integration-path">
                      {projection.vault} / {projection.folder}
                    </p>
                    <p className="muted">
                      {projection.selectedUris === undefined
                        ? 'All matching memories'
                        : projection.selectedUris.length + ' selected memories'}{' '}
                      · {projection.kinds.join(', ')} · {projection.statuses.join(', ')}
                      {projection.includeShared ? ' · Includes shared' : ' · Personal only'}
                    </p>
                  </div>
                  <div className="integration-row-actions">
                    <button
                      disabled={busy || !projection.enabled}
                      onClick={() => void preview('sync-projection', projection.id, 'Preview memory export')}
                    >
                      <RefreshCw /> Preview export
                    </button>
                    <ActionMenu
                      label={'Actions for memory export ' + projection.id}
                      disabled={busy}
                      actions={[
                        {
                          label: 'Export settings…',
                          icon: <Pencil />,
                          onSelect: () => setConnection({kind: 'projection', value: projection}),
                        },
                        {
                          label: projection.enabled ? 'Pause connection' : 'Enable connection',
                          icon: projection.enabled ? <Pause /> : <Play />,
                          onSelect: () => void toggle('projection', projection),
                        },
                        {
                          label: 'Disconnect export…',
                          icon: <Unplug />,
                          danger: true,
                          onSelect: () => void preview('remove-projection', projection.id, 'Disconnect memory export'),
                        },
                      ]}
                    />
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}
      {connection ? (
        <ObsidianConnectionForm
          connection={connection}
          onClose={() => setConnection(undefined)}
          onSaved={async () => {
            setConnection(undefined);
            await changed('Obsidian connection saved.');
          }}
        />
      ) : null}
      {operation ? (
        <IntegrationPreview
          operation={operation}
          onClose={() => setOperation(undefined)}
          onApplied={() => changed('Obsidian operation completed.')}
          onReviews={onReviews}
        />
      ) : null}
    </section>
  );
}

function IntegrationPreview({
  operation,
  onClose,
  onApplied,
  onReviews,
}: {
  readonly operation: Operation;
  readonly onClose: () => void;
  readonly onApplied: () => Promise<void>;
  readonly onReviews: () => void;
}): React.ReactElement {
  const [result, setResult] = useState(operation.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const removing = operation.action.startsWith('remove-');
  async function apply(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setResult(
        await api<IntegrationResult>('/api/integrations/obsidian', {
          action: operation.action,
          id: operation.id,
          apply: true,
          confirm: true,
        }),
      );
      await onApplied();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const changes = result.entries.filter(entry => ['add', 'update', 'remove'].includes(entry.action)).length;
  return (
    <DetailModal
      title={operation.title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">{operation.id}</p>
      {error ? (
        <p className="workspace-note danger-text" role="alert">
          {error}
        </p>
      ) : null}
      {result.applied ? (
        <p className="workspace-note" role="status">
          <Check /> Completed.
        </p>
      ) : (
        <p className="workspace-note">
          Preview only.{' '}
          {removing
            ? operation.action === 'remove-source'
              ? 'Removes the connection and imported resources from Threadnote. Your vault notes and memories stay intact.'
              : 'Removes the connection and unedited managed export files. Your vault and original memories stay intact; edited exports block removal.'
            : operation.action === 'scan-inbox'
              ? 'Only notes explicitly marked threadnote_candidate: true become proposals. You decide whether to save them in Reviews.'
              : 'Review the changes below before applying them. Files changed in the meantime are rechecked.'}
        </p>
      )}
      {result.reviewCount !== undefined ? (
        <p>
          <strong>{result.reviewCount}</strong> {result.applied ? 'reviews created' : 'notes ready for review'}
        </p>
      ) : null}
      {result.entries.length ? (
        <div className="integration-preview-list">
          {result.entries.map((entry, index) => (
            <div key={entry.relativePath + index}>
              <span className={'integration-action ' + entry.action}>
                {entry.action === 'drift' ? 'Edited in vault' : entry.action}
              </span>
              <span>
                {entry.relativePath}
                {entry.detail ? <small>{entry.detail}</small> : null}
              </span>
            </div>
          ))}
        </div>
      ) : !removing && result.reviewCount === undefined ? (
        <p>No file changes needed.</p>
      ) : null}
      <details className="integration-operation-details">
        <summary>Operation details</summary>
        <pre>{result.output}</pre>
      </details>
      <footer className="conflict-footer">
        <button disabled={busy} onClick={onClose}>
          {result.applied ? 'Done' : 'Cancel'}
        </button>
        {result.applied && operation.action === 'scan-inbox' ? (
          <button
            className="primary"
            onClick={() => {
              onClose();
              onReviews();
            }}
          >
            Open Reviews
          </button>
        ) : !result.applied ? (
          <button
            className={removing ? 'danger' : 'primary'}
            disabled={busy || (!removing && changes === 0 && !result.reviewCount)}
            onClick={() => void apply()}
          >
            {busy
              ? 'Applying…'
              : removing
                ? 'Disconnect'
                : operation.action === 'scan-inbox'
                  ? 'Send to Reviews'
                  : 'Apply changes'}
          </button>
        ) : null}
      </footer>
    </DetailModal>
  );
}
