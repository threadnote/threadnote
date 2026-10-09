import React, {useEffect, useState} from 'react';
import {Plus, RefreshCw, Search} from 'lucide-react';
import {filteredIntegrationProducts, IntegrationLogo} from './integration_catalog.js';
import type {IntegrationRegistration} from './integration_registration.js';
import {PageActions} from './workspace.js';
import {api, errorMessage} from './ui/support.js';

export function IntegrationsPanel({
  integrations,
  onChanged,
  onReviews,
}: {
  readonly integrations: readonly IntegrationRegistration[];
  readonly onChanged: () => Promise<void>;
  readonly onReviews: () => void;
}): React.ReactElement {
  const [data, setData] = useState<Readonly<Record<string, unknown>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [setup, setSetup] = useState<{readonly product: string; readonly action: string}>();
  const [query, setQuery] = useState('');
  const [productFilter, setProductFilter] = useState<string>('all');
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
    void api<Readonly<Record<string, unknown>>>('/api/integrations', undefined, {signal: controller.signal})
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

  const integrationProducts = integrations.map(integration => integration.product);
  const connectionCount = integrations.reduce(
    (sum, integration) => sum + integration.count(data[integration.product.id], ''),
    0,
  );
  const filteredCount = integrations.reduce(
    (sum, integration) =>
      sum +
      (productFilter === 'all' || productFilter === integration.product.id
        ? integration.count(data[integration.product.id], query)
        : 0),
    0,
  );
  const products = filteredIntegrationProducts(integrationProducts, query).filter(
    product => productFilter === 'all' || product.id === productFilter,
  );
  const showConnections = !loading && activeTab === 'connections';
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
      <div className="workspace-stack">
        {loading ? (
          <p role="status">Loading connections…</p>
        ) : (
          <>
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
                        {product.badge ? <span className="workspace-status neutral">{product.badge}</span> : null}
                      </div>
                      <p>{product.description}</p>
                      <div className="integration-capabilities">
                        {product.capabilities.map(value => (
                          <span key={value}>{value}</span>
                        ))}
                      </div>
                      <div className="integration-product-actions">
                        {(product.setupActions ?? [{id: 'connect', label: product.setupLabel}]).map(action => (
                          <button
                            key={action.id}
                            disabled={busy}
                            onClick={() => setSetup({product: product.id, action: action.id})}
                          >
                            {'icon' in action ? action.icon : null} {action.label}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                  {products.length === 0 ? (
                    <p className="integration-no-match">No integrations match your search.</p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </>
        )}
        <section
          style={showConnections ? undefined : {display: 'contents'}}
          id={showConnections ? 'integration-connections-panel' : undefined}
          className={showConnections ? 'workspace-card integration-connections' : undefined}
          role={showConnections ? 'tabpanel' : undefined}
          aria-labelledby={showConnections ? 'integration-connections-tab' : undefined}
        >
          {showConnections ? (
            <>
              <header>
                <p className="muted">Manage scope, sync, and access for each connection.</p>
              </header>
              {filteredCount === 0 ? (
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
            </>
          ) : null}
          {integrations.map(({product, View}) => (
            <View
              key={product.id}
              data={data[product.id]}
              query={query}
              visible={showConnections && (productFilter === 'all' || productFilter === product.id)}
              setupAction={setup?.product === product.id ? setup.action : undefined}
              onSetupClosed={() => setSetup(undefined)}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
              setNotice={setNotice}
              onChanged={changed}
              onSaved={async message => {
                showTab('connections');
                await changed(message);
              }}
              onReviews={onReviews}
            />
          ))}
        </section>
      </div>
    </section>
  );
}
