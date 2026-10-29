import {Schema} from 'effect';
import {isIntegrationResult} from '@threadnote/manager/api/response-guards';
import {Array as EffectArray} from 'effect';
import React, {useState} from 'react';
import {AlertTriangle, Pause, Pencil, Play, RefreshCw, Unplug} from 'lucide-react';
import {ActionMenu} from '@threadnote/manager/action-menu';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {IntegrationLogo, matchesIntegrationQuery} from '@threadnote/manager/integration-catalog';
import {defineIntegration, type IntegrationViewProps} from '@threadnote/manager/integration-registration';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import type {GitHubSource} from '../manager-contracts.js';
import {GitHubConnectionForm} from './connection-form.js';
import {product} from './catalog.js';
import {Option as EffectOption} from 'effect';

type Connections = {readonly sources: readonly GitHubSource[]};
function matchingSources(data: Connections | undefined, query: string): readonly GitHubSource[] {
  const sources = data?.sources ?? [];
  return EffectArray.filter(
    sources,
    (source, __effectArrayIndex) =>
      __effectArrayIndex in sources &&
      matchesIntegrationQuery(product, query, source.id, source.project ?? '', ...source.repositories),
  );
}

export function GitHubIntegrationView({
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
  const [editing, setConnection] = useState<{readonly kind: 'github'; readonly value?: GitHubSource}>();
  const connection = editing ?? (setupAction ? {kind: 'github' as const} : undefined);
  const [githubResult, setGithubResult] = useState<IntegrationResult>();
  function closeConnection(): void {
    setConnection(undefined);
    onSetupClosed();
  }
  async function githubAction(
    action: 'sync-source' | 'remove-source' | 'set-enabled',
    source: GitHubSource,
  ): Promise<void> {
    if (busy) return;
    if (
      action === 'remove-source' &&
      !(await dialogs.confirm({
        title: 'Disconnect GitHub?',
        message: 'This removes the local connection, imported discussions, and saved token.',
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<IntegrationResult>(
        '/api/integrations/github',
        {
          action,
          id: source.id,
          ...(action === 'set-enabled' ? {enabled: !source.enabled} : {}),
          apply: true,
          confirm: true,
        },
        undefined,
        isIntegrationResult,
      );
      if (action === 'sync-source') setGithubResult(result);
      if (!result.applied) throw new Error('Connection change was not applied.');
      await onChanged(
        action === 'sync-source'
          ? result.warnings?.length
            ? 'Some repository discussions could not be imported. Review the sync result.'
            : 'GitHub sync completed.'
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

  const repositories = matchingSources(data, query);
  return (
    <>
      {visible ? (
        <>
          {EffectArray.map(repositories, source => (
            <div className="integration-row" key={'github-' + source.id}>
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
                  GitHub · {EffectArray.join(source.repositories, ', ')} · {source.project ?? 'Projectless'}
                </p>
                <p className="muted">
                  {source.conversations} {source.conversations === 1 ? 'conversation' : 'conversations'} ·{' '}
                  {source.chunks} chunks
                  {source.progress
                    ? ` · Importing ${source.progress.repository}, page ${source.progress.page}, ${source.progress.offset} processed`
                    : ''}
                  {source.lastSyncedAt ? ' · Last synced ' + new Date(source.lastSyncedAt).toLocaleString() : ''}
                  {source.lastReconciledAt
                    ? ' · Discussions checked ' + new Date(source.lastReconciledAt).toLocaleString()
                    : ''}
                  {source.nextAttemptAt ? ' · Next attempt ' + new Date(source.nextAttemptAt).toLocaleString() : ''}
                </p>
              </div>
              <div className="integration-row-actions">
                <button
                  disabled={busy || !source.enabled || !source.credentialConfigured}
                  onClick={() => void githubAction('sync-source', source)}
                >
                  <RefreshCw /> Sync now
                </button>
                <ActionMenu
                  label={'Actions for GitHub ' + source.id}
                  disabled={busy}
                  actions={[
                    {
                      label: 'Connection settings…',
                      icon: <Pencil />,
                      onSelect: () => setConnection({kind: 'github', value: source}),
                    },
                    {
                      label: source.enabled ? 'Pause connection' : 'Enable connection',
                      icon: source.enabled ? <Pause /> : <Play />,
                      onSelect: () => void githubAction('set-enabled', source),
                    },
                    {
                      label: 'Disconnect…',
                      icon: <Unplug />,
                      danger: true,
                      onSelect: () => void githubAction('remove-source', source),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </>
      ) : null}
      {connection ? (
        <GitHubConnectionForm
          source={connection.value}
          reusableCredential={
            !connection.value &&
            (EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(data?.sources), __effectArrayReceiver =>
                EffectArray.some(
                  __effectArrayReceiver,
                  __effectArrayValue => !!(source => source.credentialConfigured)(__effectArrayValue),
                ),
              ),
            ) ??
              false)
          }
          onClose={closeConnection}
          onSaved={async () => {
            closeConnection();
            await onSaved('GitHub connection saved.');
          }}
        />
      ) : null}
      {githubResult ? (
        <DetailModal title="GitHub sync results" onClose={() => setGithubResult(undefined)}>
          <p role="status" className="workspace-note">
            {githubResult.warnings?.length ? 'Sync finished with warnings.' : 'Sync completed.'}
          </p>
          {githubResult.warnings?.length ? (
            <ul className="integration-warnings">
              {EffectArray.map(githubResult.warnings, (warning, index) => (
                <li key={index}>
                  <AlertTriangle /> {warning}
                </li>
              ))}
            </ul>
          ) : null}
          <p>{githubResult.output}</p>
          <footer className="conflict-footer">
            <button onClick={() => setGithubResult(undefined)}>Done</button>
          </footer>
        </DetailModal>
      ) : null}
    </>
  );
}

function integrationStatus(source: Pick<GitHubSource, 'enabled' | 'credentialConfigured' | 'status'>): string {
  if (!source.enabled) return 'Paused';
  if (!source.credentialConfigured) return 'Token required';
  if (source.status === 'needs-attention') return 'Needs attention';
  return source.status === 'needs-sync' ? 'Ready to sync' : 'Up to date';
}

export const githubIntegration = defineIntegration<Connections>({
  product,
  isData: Schema.is(
    Schema.Struct({
      sources: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          enabled: Schema.Boolean,
          project: Schema.Union([Schema.Null, Schema.String]),
          repositories: Schema.Array(Schema.String),
          credentialEnv: Schema.String,
          credentialStorage: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.Literal('local')])),
          credentialConfigured: Schema.Boolean,
          refreshIntervalMinutes: Schema.Finite,
          maxStaleHours: Schema.Finite,
          status: Schema.Union([
            Schema.Literal('active'),
            Schema.Literal('needs-sync'),
            Schema.Literal('needs-attention'),
          ]),
          conversations: Schema.Finite,
          chunks: Schema.Finite,
          lastSyncedAt: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.Finite])),
          nextAttemptAt: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.Finite])),
          progress: Schema.optionalKey(
            Schema.Union([
              Schema.Undefined,
              Schema.Struct({repository: Schema.String, page: Schema.Finite, offset: Schema.Finite}),
            ]),
          ),
          lastReconciledAt: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.Finite])),
        }),
      ),
    }),
  ),
  count: (data, query) => matchingSources(data, query).length,
  View: GitHubIntegrationView,
});
