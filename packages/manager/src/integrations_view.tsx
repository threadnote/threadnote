import React, {useEffect, useState} from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Inbox,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Unplug,
} from 'lucide-react';
import {ActionMenu} from './action_menu.js';
import {DetailModal} from './detail_modal.js';
import {useManagerDialogs} from './dialog.js';
import {
  filteredIntegrationProducts,
  integrationProduct,
  integrationProducts,
  IntegrationLogo,
} from './integration_catalog.js';
import type {
  IntegrationProductId,
  IntegrationResult,
  ManagerIntegrations,
  ObsidianAction,
  ObsidianProjection,
  ObsidianSource,
  SuperhumanSource,
} from './integrations_contracts.js';
import {ObsidianConnectionForm} from './obsidian_connection_form.js';
import {SuperhumanConnectionForm} from './superhuman_connection_form.js';
import {PageActions} from './workspace.js';
import {api, errorMessage} from './ui/support.js';

type Connection =
  | {readonly kind: 'source'; readonly value?: ObsidianSource}
  | {readonly kind: 'projection'; readonly value?: ObsidianProjection}
  | {readonly kind: 'superhuman'; readonly value?: SuperhumanSource};
interface Operation {
  readonly id: string;
  readonly action: ObsidianAction;
  readonly title: string;
  readonly result: IntegrationResult;
}
const empty: ManagerIntegrations = {obsidian: {sources: [], projections: []}, superhuman: {sources: []}};

export function IntegrationsPanel({
  onChanged,
  onReviews,
}: {
  readonly onChanged: () => Promise<void>;
  readonly onReviews: () => void;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [data, setData] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState<Connection>();
  const [operation, setOperation] = useState<Operation>();
  const [superhumanResult, setSuperhumanResult] = useState<IntegrationResult>();
  const [query, setQuery] = useState('');
  const [productFilter, setProductFilter] = useState<IntegrationProductId | 'all'>('all');
  const [activeTab, setActiveTab] = useState<'connections' | 'catalog'>('connections');
  const [generation, setGeneration] = useState(0);
  function showTab(tab: 'connections' | 'catalog'): void {
    setActiveTab(tab);
    setQuery('');
    setProductFilter('all');
  }
  function navigateTabs(event: React.KeyboardEvent<HTMLDivElement>): void {
    const tab =
      event.key === 'Home'
        ? 'connections'
        : event.key === 'End'
          ? 'catalog'
          : event.key === 'ArrowRight'
            ? 'catalog'
            : event.key === 'ArrowLeft'
              ? 'connections'
              : undefined;
    if (!tab) return;
    event.preventDefault();
    showTab(tab);
    document.getElementById(`integration-${tab}-tab`)?.focus();
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<ManagerIntegrations>('/api/integrations', undefined, {signal: controller.signal})
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
      await changed('Memory export completed.');
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
      await changed(value.enabled ? 'Connection paused.' : 'Connection enabled.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
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
      await changed(
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

  const matches = (product: IntegrationProductId, ...values: string[]) =>
    (productFilter === 'all' || productFilter === product) &&
    (!query.trim() ||
      [integrationProduct(product).name, ...values].some(value =>
        value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ));
  const sources = data.obsidian.sources.filter(source => matches('obsidian', source.id, source.vault));
  const projections = data.obsidian.projections.filter(item => matches('obsidian', item.id, item.vault));
  const documents = data.superhuman.sources.filter(source => matches('superhuman', source.id, source.project ?? ''));
  const connectionCount =
    data.obsidian.sources.length + data.obsidian.projections.length + data.superhuman.sources.length;
  const products = filteredIntegrationProducts(query).filter(
    product => productFilter === 'all' || product.id === productFilter,
  );
  const obsidian = integrationProduct('obsidian');
  const superhuman = integrationProduct('superhuman');

  return (
    <section className="panel is-active integrations-workspace">
      <PageActions>
        <button disabled={loading || busy} onClick={() => showTab('catalog')}>
          <Plus /> Add integration
        </button>
        <button disabled={loading || busy} onClick={() => setGeneration(value => value + 1)}>
          <RefreshCw /> Refresh
        </button>
      </PageActions>
      <div
        className="integration-section-tabs"
        role="tablist"
        aria-label="Integration sections"
        onKeyDown={navigateTabs}
      >
        <button
          id="integration-connections-tab"
          role="tab"
          aria-selected={activeTab === 'connections'}
          aria-controls="integration-connections-panel"
          tabIndex={activeTab === 'connections' ? 0 : -1}
          onClick={() => showTab('connections')}
        >
          Your connections <span>{connectionCount}</span>
        </button>
        <button
          id="integration-catalog-tab"
          role="tab"
          aria-selected={activeTab === 'catalog'}
          aria-controls="integration-catalog-panel"
          tabIndex={activeTab === 'catalog' ? 0 : -1}
          onClick={() => showTab('catalog')}
        >
          Available integrations <span>{integrationProducts.length}</span>
        </button>
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
          <div className="integration-filter-bar">
            <label className="integration-search">
              <Search aria-hidden="true" />
              <span className="sr-only">
                Search {activeTab === 'catalog' ? 'available integrations' : 'your connections'}
              </span>
              <input
                aria-label={activeTab === 'catalog' ? 'Search available integrations' : 'Search your connections'}
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={activeTab === 'catalog' ? 'Search available integrations' : 'Search your connections'}
              />
            </label>
            <div className="integration-filter-tabs" role="group" aria-label="Filter products">
              <button aria-pressed={productFilter === 'all'} onClick={() => setProductFilter('all')}>
                All
              </button>
              {integrationProducts.map(product => (
                <button
                  key={product.id}
                  aria-pressed={productFilter === product.id}
                  onClick={() => setProductFilter(product.id)}
                >
                  {product.name}
                </button>
              ))}
            </div>
          </div>
          {activeTab === 'catalog' ? (
            <section
              id="integration-catalog-panel"
              className="workspace-card integration-catalog"
              role="tabpanel"
              aria-labelledby="integration-catalog-tab"
            >
              <header>
                <p className="muted">Connect a product to choose its permitted data and actions.</p>
              </header>
              <div className="integration-product-grid">
                {products.map(product => (
                  <article className="integration-product" key={product.id}>
                    <div className="integration-product-title">
                      <IntegrationLogo product={product} decorative />
                      <h4>{product.name}</h4>
                    </div>
                    <p>{product.description}</p>
                    <div className="integration-capabilities">
                      {product.capabilities.map(value => (
                        <span key={value}>{value}</span>
                      ))}
                    </div>
                    <div className="integration-product-actions">
                      {product.id === 'obsidian' ? (
                        <>
                          <button disabled={busy} onClick={() => setConnection({kind: 'source'})}>
                            <ArrowDownToLine /> Import notes
                          </button>
                          <button disabled={busy} onClick={() => setConnection({kind: 'projection'})}>
                            <ArrowUpFromLine /> Export memories
                          </button>
                        </>
                      ) : (
                        <button disabled={busy} onClick={() => setConnection({kind: 'superhuman'})}>
                          {product.setupLabel}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
                {products.length === 0 ? (
                  <p className="integration-no-match">No integrations match your search.</p>
                ) : null}
              </div>
            </section>
          ) : (
            <section
              id="integration-connections-panel"
              className="workspace-card integration-connections"
              role="tabpanel"
              aria-labelledby="integration-connections-tab"
            >
              <header>
                <p className="muted">Manage scope, sync, and access for each connection.</p>
              </header>
              {sources.length + projections.length + documents.length === 0 ? (
                <div className="integration-empty">
                  <h4>{connectionCount ? 'No matching connections' : 'No connections yet'}</h4>
                  <p>
                    {connectionCount
                      ? 'Try another search or product filter.'
                      : 'Choose an integration to get started.'}
                  </p>
                  {!connectionCount ? <button onClick={() => showTab('catalog')}>Browse integrations</button> : null}
                </div>
              ) : null}
              {sources.map(source => (
                <div className="integration-row" key={'obsidian-source-' + source.id}>
                  <IntegrationLogo product={obsidian} decorative />
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
                  <IntegrationLogo product={obsidian} decorative />
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
              {documents.map(source => (
                <div className="integration-row" key={'superhuman-' + source.id}>
                  <IntegrationLogo product={superhuman} decorative />
                  <div className="integration-row-main">
                    <h4>
                      {source.id}
                      <span
                        className={
                          'workspace-status ' +
                          (source.enabled && source.credentialConfigured && source.status === 'active' ? '' : 'neutral')
                        }
                      >
                        {superhumanStatus(source)}
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
            </section>
          )}
        </div>
      )}
      {connection?.kind === 'superhuman' ? (
        <SuperhumanConnectionForm
          source={connection.value}
          onClose={() => setConnection(undefined)}
          onSaved={async () => {
            setConnection(undefined);
            showTab('connections');
            await changed('Superhuman Docs connection saved.');
          }}
        />
      ) : connection ? (
        <ObsidianConnectionForm
          connection={connection}
          onClose={() => setConnection(undefined)}
          onSaved={async () => {
            setConnection(undefined);
            showTab('connections');
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
    </section>
  );
}

function superhumanStatus(source: SuperhumanSource): string {
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
