import React, {useState} from 'react';
import {AlertTriangle, Check, Pause, Pencil, Play, RefreshCw, Unplug} from 'lucide-react';
import {ActionMenu} from '@threadnote/manager/action-menu';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {IntegrationLogo, matchesIntegrationQuery} from '@threadnote/manager/integration-catalog';
import {defineIntegration, type IntegrationViewProps} from '@threadnote/manager/integration-registration';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import type {SuperhumanSource} from '../manager-contracts.js';
import {SuperhumanConnectionForm} from './connection-form.js';
import {product} from './catalog.js';

type Connections = {readonly sources: readonly SuperhumanSource[]};
function matchingSources(data: Connections | undefined, query: string): readonly SuperhumanSource[] {
  return (data?.sources ?? []).filter(source =>
    matchesIntegrationQuery(product, query, source.id, source.project ?? ''),
  );
}

export function SuperhumanIntegrationView({
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
  const [editing, setConnection] = useState<{readonly kind: 'superhuman'; readonly value?: SuperhumanSource}>();
  const connection = editing ?? (setupAction ? {kind: 'superhuman' as const} : undefined);
  const [superhumanResult, setSuperhumanResult] = useState<IntegrationResult>();
  function closeConnection(): void {
    setConnection(undefined);
    onSetupClosed();
  }
  async function superhumanAction(
    action: 'sync-source' | 'remove-source' | 'set-enabled',
    source: SuperhumanSource,
  ): Promise<void> {
    if (busy) return;
    if (
      action === 'remove-source' &&
      !(await dialogs.confirm({
        title: 'Disconnect Superhuman Docs?',
        message:
          'This removes the local connection, cached content, and saved token. It does not change the original documents.',
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<IntegrationResult>('/api/integrations/superhuman', {
        action,
        id: source.id,
        ...(action === 'set-enabled' ? {enabled: !source.enabled} : {}),
        apply: true,
        confirm: true,
      });
      if (action === 'sync-source') setSuperhumanResult(result);
      if (!result.applied) {
        if (action !== 'sync-source') throw new Error('Connection change was not applied.');
        setNotice('Document import did not apply.');
        return;
      }
      await onChanged(
        action === 'sync-source'
          ? result.warnings?.length
            ? 'Some documents could not be imported. Review the sync result.'
            : 'Document import completed.'
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
  const documents = matchingSources(data, query);
  return (
    <>
      {visible ? (
        <>
          {documents.map(source => (
            <div className="integration-row" key={'superhuman-' + source.id}>
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
                  Superhuman Docs · Import canvas text · {source.project ?? 'Projectless'}
                </p>
                <p className="muted">
                  {source.documents.length} {source.documents.length === 1 ? 'document' : 'documents'} ·{' '}
                  {scopeSummary(source)}
                  {source.lastSyncedAt ? ' · Last synced ' + new Date(source.lastSyncedAt).toLocaleString() : ''}
                  {source.nextAttemptAt ? ' · Next attempt ' + new Date(source.nextAttemptAt).toLocaleString() : ''}
                </p>
              </div>
              <div className="integration-row-actions">
                <button
                  disabled={busy || !source.enabled || !source.credentialConfigured}
                  onClick={() => void superhumanAction('sync-source', source)}
                >
                  <RefreshCw /> Sync now
                </button>
                <ActionMenu
                  label={'Actions for Superhuman Docs ' + source.id}
                  disabled={busy}
                  actions={[
                    {
                      label: 'Connection settings…',
                      icon: <Pencil />,
                      onSelect: () => setConnection({kind: 'superhuman', value: source}),
                    },
                    {
                      label: source.enabled ? 'Pause connection' : 'Enable connection',
                      icon: source.enabled ? <Pause /> : <Play />,
                      onSelect: () => void superhumanAction('set-enabled', source),
                    },
                    {
                      label: 'Disconnect…',
                      icon: <Unplug />,
                      danger: true,
                      onSelect: () => void superhumanAction('remove-source', source),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </>
      ) : null}
      {connection ? (
        <SuperhumanConnectionForm
          source={connection.value}
          onClose={closeConnection}
          onSaved={async () => {
            closeConnection();
            await onSaved('Superhuman Docs connection saved.');
          }}
        />
      ) : null}
      {superhumanResult ? (
        <DetailModal title="Document import results" onClose={() => setSuperhumanResult(undefined)}>
          <p role="status" className="workspace-note">
            {superhumanResult.applied ? <Check /> : <AlertTriangle />}{' '}
            {superhumanResult.applied
              ? superhumanResult.warnings?.length
                ? 'Sync finished with warnings.'
                : 'Sync completed.'
              : 'Sync did not apply.'}
          </p>
          {superhumanResult.warnings?.length ? (
            <ul className="integration-warnings">
              {superhumanResult.warnings.map((warning, index) => (
                <li key={index}>
                  <AlertTriangle /> {warning}
                </li>
              ))}
            </ul>
          ) : null}
          <p>{superhumanResult.output}</p>
          <footer className="conflict-footer">
            <button onClick={() => setSuperhumanResult(undefined)}>Done</button>
          </footer>
        </DetailModal>
      ) : null}
    </>
  );
}

function integrationStatus(source: Pick<SuperhumanSource, 'enabled' | 'credentialConfigured' | 'status'>): string {
  if (!source.enabled) return 'Paused';
  if (!source.credentialConfigured) return 'Token required';
  if (source.status === 'needs-attention') return 'Needs attention';
  return source.status === 'needs-sync' ? 'Ready to sync' : 'Up to date';
}

function scopeSummary(source: SuperhumanSource): string {
  const whole = source.documents.filter(document => document.pages === undefined).length;
  const pages = source.documents.reduce((sum, document) => sum + (document.pages?.length ?? 0), 0);
  return [
    whole ? `${whole} whole ${whole === 1 ? 'document' : 'documents'}` : '',
    pages ? `${pages} selected ${pages === 1 ? 'page' : 'pages'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export const superhumanIntegration = defineIntegration<Connections>({
  product,
  count: (data, query) => matchingSources(data, query).length,
  View: SuperhumanIntegrationView,
});
