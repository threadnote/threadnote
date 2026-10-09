import React, {useState} from 'react';
import {AlertTriangle, ArrowUpFromLine, Check, Inbox, Pause, Pencil, Play, RefreshCw, Unplug} from 'lucide-react';
import {ActionMenu} from '@threadnote/manager/action-menu';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {IntegrationLogo, matchesIntegrationQuery} from '@threadnote/manager/integration-catalog';
import {defineIntegration, type IntegrationViewProps} from '@threadnote/manager/integration-registration';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import type {ObsidianAction, ObsidianIntegration, ObsidianSource, ObsidianProjection} from '../manager-contracts.js';
import {ObsidianConnectionForm} from './connection-form.js';
import {product} from './catalog.js';

type Connection =
  | {readonly kind: 'source'; readonly value?: ObsidianSource}
  | {readonly kind: 'projection'; readonly value?: ObsidianProjection};
interface Operation {
  readonly id: string;
  readonly action: ObsidianAction;
  readonly title: string;
  readonly result: IntegrationResult;
}
function matchingConnections(data: ObsidianIntegration | undefined, query: string): ObsidianIntegration {
  return {
    sources: (data?.sources ?? []).filter(source => matchesIntegrationQuery(product, query, source.id, source.vault)),
    projections: (data?.projections ?? []).filter(projection =>
      matchesIntegrationQuery(product, query, projection.id, projection.vault),
    ),
  };
}
export function ObsidianIntegrationView({
  data,
  query,
  visible,
  setupAction,
  onSetupClosed,
  busy,
  setBusy,
  setError,
  setNotice,
  onChanged,
  onSaved,
  onReviews,
}: IntegrationViewProps<ObsidianIntegration>): React.ReactElement {
  const [editing, setConnection] = useState<Connection>();
  const connection =
    editing ?? (setupAction === 'source' || setupAction === 'projection' ? {kind: setupAction} : undefined);
  const [operation, setOperation] = useState<Operation>();
  function closeConnection(): void {
    setConnection(undefined);
    onSetupClosed();
  }
  async function exportMemories(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<IntegrationResult>('/api/integrations/obsidian', {
        action: 'sync-projection',
        id,
        apply: true,
        confirm: true,
      });
      setOperation({action: 'sync-projection', id, title: 'Export results', result});
      await onChanged('Memory export completed.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
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
      await onChanged(value.enabled ? 'Connection paused.' : 'Connection enabled.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const {sources, projections} = matchingConnections(data, query);
  return (
    <>
      {visible ? (
        <>
          {sources.map(source => (
            <div className="integration-row" key={'obsidian-source-' + source.id}>
              <IntegrationLogo product={product} decorative />
              <div className="integration-row-main">
                <h4>
                  {source.id}
                  <span className={'workspace-status ' + (source.enabled ? '' : 'neutral')}>
                    {source.enabled ? 'Ready to import' : 'Paused'}
                  </span>
                </h4>
                <p className="integration-path">Obsidian · Import notes · {source.vault}</p>
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
          ))}
          {projections.map(projection => (
            <div className="integration-row" key={'obsidian-projection-' + projection.id}>
              <IntegrationLogo product={product} decorative />
              <div className="integration-row-main">
                <h4>
                  {projection.id}
                  <span className={'workspace-status ' + (projection.enabled ? '' : 'neutral')}>
                    {projection.enabled ? 'Ready to export' : 'Paused'}
                  </span>
                </h4>
                <p className="integration-path">
                  Obsidian · Export memories · {projection.vault} / {projection.folder}
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
                <button disabled={busy || !projection.enabled} onClick={() => void exportMemories(projection.id)}>
                  <ArrowUpFromLine /> Export memories
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
          ))}
        </>
      ) : null}
      {connection ? (
        <ObsidianConnectionForm
          connection={connection}
          onClose={closeConnection}
          onSaved={async () => {
            closeConnection();
            await onSaved('Obsidian connection saved.');
          }}
        />
      ) : null}
      {operation ? (
        <IntegrationPreview
          operation={operation}
          onClose={() => setOperation(undefined)}
          onApplied={() => onChanged('Obsidian operation completed.')}
          onReviews={onReviews}
        />
      ) : null}
    </>
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
  const protectedEdits = result.entries.filter(entry => entry.action === 'drift').length;
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
          {protectedEdits ? <AlertTriangle /> : <Check />}
          {protectedEdits
            ? `Completed. ${protectedEdits} ${protectedEdits === 1 ? 'edited file was' : 'edited files were'} left untouched.`
            : 'Completed.'}
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

export const obsidianIntegration = defineIntegration<ObsidianIntegration>({
  product,
  count: (data, query) => {
    const {sources, projections} = matchingConnections(data, query);
    return sources.length + projections.length;
  },
  View: ObsidianIntegrationView,
});
