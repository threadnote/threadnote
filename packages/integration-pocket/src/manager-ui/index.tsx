import React, {useState} from 'react';
import {AlertTriangle, Pause, Pencil, Play, RefreshCw, Unplug} from 'lucide-react';
import {ActionMenu} from '@threadnote/manager/action-menu';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {IntegrationLogo, matchesIntegrationQuery} from '@threadnote/manager/integration-catalog';
import {defineIntegration, type IntegrationViewProps} from '@threadnote/manager/integration-registration';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import type {PocketSource} from '../manager-contracts.js';
import {PocketConnectionForm} from './connection-form.js';
import {product} from './catalog.js';

type Connections = {readonly sources: readonly PocketSource[]};
function matchingSources(data: Connections | undefined, query: string): readonly PocketSource[] {
  return (data?.sources ?? []).filter(source =>
    matchesIntegrationQuery(product, query, source.id, source.project ?? ''),
  );
}

export function PocketIntegrationView({
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
  const [editing, setConnection] = useState<{readonly kind: 'pocket'; readonly value?: PocketSource}>();
  const connection = editing ?? (setupAction ? {kind: 'pocket' as const} : undefined);
  const [pocketResult, setPocketResult] = useState<IntegrationResult>();
  function closeConnection(): void {
    setConnection(undefined);
    onSetupClosed();
  }
  async function pocketAction(
    action: 'sync-source' | 'remove-source' | 'set-enabled',
    source: PocketSource,
  ): Promise<void> {
    if (busy) return;
    if (
      action === 'remove-source' &&
      !(await dialogs.confirm({
        title: 'Disconnect Pocket?',
        message:
          'This removes the local connection, cached recordings, and saved key. It does not change your Pocket recordings.',
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<IntegrationResult>('/api/integrations/pocket', {
        action,
        id: source.id,
        ...(action === 'set-enabled' ? {enabled: !source.enabled} : {}),
        apply: true,
        confirm: true,
      });
      if (action === 'sync-source') setPocketResult(result);
      if (!result.applied) throw new Error('Connection change was not applied.');
      await onChanged(
        action === 'sync-source'
          ? result.warnings?.length
            ? 'Some recordings could not be imported. Review the sync result.'
            : 'Pocket sync completed.'
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

  const recordings = matchingSources(data, query);
  return (
    <>
      {visible ? (
        <>
          {recordings.map(source => (
            <div className="integration-row" key={'pocket-' + source.id}>
              <IntegrationLogo product={product} decorative />
              <div className="integration-row-main">
                <h4>
                  {source.id}
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
                  Pocket · Import all accessible recordings · {source.project ?? 'Projectless'}
                </p>
                <p className="muted">
                  {source.recordings} {source.recordings === 1 ? 'recording' : 'recordings'} · {source.chunks} chunks
                  {source.progress
                    ? ` · Sync progress: page ${source.progress.page}, ${source.progress.offset} processed`
                    : ''}
                  {source.lastSyncedAt ? ' · Last synced ' + new Date(source.lastSyncedAt).toLocaleString() : ''}
                  {source.nextAttemptAt ? ' · Next attempt ' + new Date(source.nextAttemptAt).toLocaleString() : ''}
                </p>
              </div>
              <div className="integration-row-actions">
                <button
                  disabled={busy || !source.enabled || !source.credentialConfigured}
                  onClick={() => void pocketAction('sync-source', source)}
                >
                  <RefreshCw /> Sync now
                </button>
                <ActionMenu
                  label={'Actions for Pocket ' + source.id}
                  disabled={busy}
                  actions={[
                    {
                      label: 'Connection settings…',
                      icon: <Pencil />,
                      onSelect: () => setConnection({kind: 'pocket', value: source}),
                    },
                    {
                      label: source.enabled ? 'Pause connection' : 'Enable connection',
                      icon: source.enabled ? <Pause /> : <Play />,
                      onSelect: () => void pocketAction('set-enabled', source),
                    },
                    {
                      label: 'Disconnect…',
                      icon: <Unplug />,
                      danger: true,
                      onSelect: () => void pocketAction('remove-source', source),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </>
      ) : null}
      {connection ? (
        <PocketConnectionForm
          source={connection.value}
          onClose={closeConnection}
          onSaved={async () => {
            closeConnection();
            await onSaved('Pocket connection saved. Initial sync started.');
          }}
        />
      ) : null}
      {pocketResult ? (
        <DetailModal title="Pocket sync results" onClose={() => setPocketResult(undefined)}>
          <p role="status" className="workspace-note">
            {pocketResult.warnings?.length ? 'Sync finished with warnings.' : 'Sync completed.'}
          </p>
          {pocketResult.warnings?.length ? (
            <ul className="integration-warnings">
              {pocketResult.warnings.map((warning, index) => (
                <li key={index}>
                  <AlertTriangle /> {warning}
                </li>
              ))}
            </ul>
          ) : null}
          <p>{pocketResult.output}</p>
          <footer className="conflict-footer">
            <button onClick={() => setPocketResult(undefined)}>Done</button>
          </footer>
        </DetailModal>
      ) : null}
    </>
  );
}

function integrationStatus(source: Pick<PocketSource, 'enabled' | 'credentialConfigured' | 'status'>): string {
  if (!source.enabled) return 'Paused';
  if (!source.credentialConfigured) return 'Token required';
  if (source.status === 'needs-attention') return 'Needs attention';
  return source.status === 'needs-sync' ? 'Ready to sync' : 'Up to date';
}

export const pocketIntegration = defineIntegration<Connections>({
  product,
  count: (data, query) => matchingSources(data, query).length,
  View: PocketIntegrationView,
});
