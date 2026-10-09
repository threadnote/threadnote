import React, {useState} from 'react';
import {AlertTriangle, Pause, Pencil, Play, RefreshCw, Unplug} from 'lucide-react';
import {ActionMenu} from '@threadnote/manager/action-menu';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {IntegrationLogo, matchesIntegrationQuery} from '@threadnote/manager/integration-catalog';
import {defineIntegration, type IntegrationViewProps} from '@threadnote/manager/integration-registration';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import type {LinearSource} from '../manager-contracts.js';
import {LinearConnectionForm} from './connection-form.js';
import {product} from './catalog.js';

type Connections = {readonly sources: readonly LinearSource[]};
function matchingSources(data: Connections | undefined, query: string): readonly LinearSource[] {
  return (data?.sources ?? []).filter(source =>
    matchesIntegrationQuery(product, query, source.id, source.project ?? ''),
  );
}

export function LinearIntegrationView({
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
}: IntegrationViewProps<Connections>): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [editing, setConnection] = useState<{readonly kind: 'linear'; readonly value?: LinearSource}>();
  const connection = editing ?? (setupAction ? {kind: 'linear' as const} : undefined);
  const [linearResult, setLinearResult] = useState<IntegrationResult>();
  function closeConnection(): void {
    setConnection(undefined);
    onSetupClosed();
  }
  async function linearAction(
    action: 'sync-source' | 'remove-source' | 'set-enabled',
    source: LinearSource,
  ): Promise<void> {
    if (busy) return;
    if (
      action === 'remove-source' &&
      !(await dialogs.confirm({
        title: 'Disconnect Linear?',
        message:
          'This removes the local connection, imported content, and saved key. It does not change your Linear issues.',
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<IntegrationResult>('/api/integrations/linear', {
        action,
        id: source.id,
        ...(action === 'set-enabled' ? {enabled: !source.enabled} : {}),
        apply: true,
        confirm: true,
      });
      if (action === 'sync-source') setLinearResult(result);
      if (!result.applied) throw new Error('Connection change was not applied.');
      await onChanged(
        action === 'sync-source'
          ? result.warnings?.length
            ? 'Linear sync finished with warnings.'
            : 'Linear sync completed.'
          : action === 'remove-source'
            ? 'Connection disconnected.'
            : source.enabled
              ? 'Connection paused.'
              : 'Connection enabled.',
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const linearSources = matchingSources(data, query);
  return (
    <>
      {visible ? (
        <>
          {linearSources.map(source => (
            <div className="integration-row" key={'linear-' + source.id}>
              <IntegrationLogo product={product} decorative />
              <div className="integration-row-main">
                <h4>
                  {source.id}
                  <span className="workspace-status neutral">Beta</span>
                  <span
                    className={
                      'workspace-status ' +
                      (source.enabled && source.credentialConfigured && source.status === 'active' ? '' : 'neutral')
                    }
                  >
                    {integrationStatus(source)}
                  </span>
                </h4>
                <p className="integration-path">
                  Linear · Selected issues and projects · {source.project ?? 'Projectless'}
                </p>
                <p className="muted">
                  {source.teamIds.length} teams · {source.projectIds.length} selected projects ·{' '}
                  {source.issueIds.length} selected issues
                  {' · '}
                  {source.issues} imported issues · {source.documents} documents · {source.updates} updates ·{' '}
                  {source.chunks} chunks
                  {source.progress ? ` · Sync progress: ${source.progress.completed} of ${source.progress.total}` : ''}
                  {source.lastSyncedAt ? ' · Last synced ' + new Date(source.lastSyncedAt).toLocaleString() : ''}
                  {source.nextAttemptAt ? ' · Next attempt ' + new Date(source.nextAttemptAt).toLocaleString() : ''}
                </p>
                <p className="muted">
                  Published issue discussion and selected project context. Inline comments and project update comments
                  are unavailable.
                </p>
              </div>
              <div className="integration-row-actions">
                <button
                  disabled={busy || !source.enabled || !source.credentialConfigured}
                  onClick={() => void linearAction('sync-source', source)}
                >
                  <RefreshCw /> Sync now
                </button>
                <ActionMenu
                  label={'Actions for Linear ' + source.id}
                  disabled={busy}
                  actions={[
                    {
                      label: 'Connection settings…',
                      icon: <Pencil />,
                      onSelect: () => setConnection({kind: 'linear', value: source}),
                    },
                    {
                      label: source.enabled ? 'Pause connection' : 'Enable connection',
                      icon: source.enabled ? <Pause /> : <Play />,
                      onSelect: () => void linearAction('set-enabled', source),
                    },
                    {
                      label: 'Disconnect…',
                      icon: <Unplug />,
                      danger: true,
                      onSelect: () => void linearAction('remove-source', source),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </>
      ) : null}
      {connection ? (
        <LinearConnectionForm
          source={connection.value}
          onClose={closeConnection}
          onSaved={async () => {
            closeConnection();
            await onSaved(
              connection.value
                ? 'Linear settings saved.'
                : 'Linear connection saved. Choose Sync now to import selected evidence.',
            );
          }}
        />
      ) : null}
      {linearResult ? (
        <DetailModal title="Linear sync results" onClose={() => setLinearResult(undefined)}>
          <p role="status" className="workspace-note">
            {linearResult.warnings?.length ? 'Sync finished with warnings.' : 'Sync completed.'}
          </p>
          {linearResult.warnings?.length ? (
            <ul className="integration-warnings">
              {linearResult.warnings.map((warning, index) => (
                <li key={index}>
                  <AlertTriangle /> {warning}
                </li>
              ))}
            </ul>
          ) : null}
          <p>{linearResult.output}</p>
          <footer className="conflict-footer">
            <button onClick={() => setLinearResult(undefined)}>Done</button>
          </footer>
        </DetailModal>
      ) : null}
    </>
  );
}

function integrationStatus(source: Pick<LinearSource, 'enabled' | 'credentialConfigured' | 'status'>): string {
  if (!source.enabled) return 'Paused';
  if (!source.credentialConfigured) return 'Token required';
  if (source.status === 'needs-attention') return 'Needs attention';
  return source.status === 'needs-sync' ? 'Ready to sync' : 'Up to date';
}

export const linearIntegration = defineIntegration<Connections>({
  product,
  count: (data, query) => matchingSources(data, query).length,
  View: LinearIntegrationView,
});
