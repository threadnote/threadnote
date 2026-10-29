import {Array as EffectArray} from 'effect';
import {SiteShell} from '../components/SiteShell';
import {
  agentCapabilityNames,
  agentIntegrationCatalogVersion,
  agentIntegrations,
  capabilityLabel,
  tierLabels,
} from '../content/agentIntegrations';
import {docsArticleHref, setDocumentMeta} from '../lib/site';

export default function AgentsPage() {
  setDocumentMeta(
    'Supported agents',
    'Catalog-backed Threadnote integration support by concrete product surface, capability, scope, platform, and verification date.',
  );

  return (
    <SiteShell page="agents" fullBleed>
      <section className="subpage-hero agents-hero">
        <div>
          <span className="eyebrow">Catalog-backed support</span>
          <h1>Supported agents, with the boundaries visible.</h1>
          <p>
            Each card is a concrete product surface. It shows exactly what Threadnote manages, where it can install, and
            what remains manual or experimental.
          </p>
        </div>
        <div className="subpage-hero__metric">
          <strong>{agentIntegrations.length}</strong>
          <span>catalog surfaces</span>
          <small>Catalog version {agentIntegrationCatalogVersion} · capability-level status</small>
        </div>
      </section>

      <section className="content-section agents-intro">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Read the tier with the capability</span>
            <h2>One host can expose several surfaces.</h2>
          </div>
          <p>
            Full and Core entries have managed artifacts only for their listed capabilities. Project-only, Manual, and
            Experimental entries retain their own limits rather than inheriting a stronger product-wide claim.
          </p>
        </header>
      </section>

      <section className="content-section agents-grid-section" aria-label="Supported agent catalog">
        <div className="agents-grid">
          {EffectArray.map(agentIntegrations, integration => (
            <article className="agent-card" data-agent-id={integration.id} key={integration.id}>
              <header className="agent-card__header">
                <div>
                  <span className={`agent-tier agent-tier--${integration.tier}`}>{tierLabels[integration.tier]}</span>
                  <h2>{integration.displayName}</h2>
                </div>
                <code>{integration.id}</code>
              </header>

              <dl className="agent-card__facts">
                <div>
                  <dt>Product</dt>
                  <dd>{integration.agentId}</dd>
                </div>
                <div>
                  <dt>Scopes</dt>
                  <dd>
                    {integration.scopes.length
                      ? EffectArray.join(integration.scopes, ', ')
                      : 'No managed install scope'}
                  </dd>
                </div>
                <div>
                  <dt>Platforms</dt>
                  <dd>{EffectArray.join(integration.platforms, ', ')}</dd>
                </div>
                <div>
                  <dt>Last verified</dt>
                  <dd>{integration.lastVerified}</dd>
                </div>
              </dl>

              <ul className="agent-card__capabilities" aria-label={`${integration.displayName} capabilities`}>
                {EffectArray.map(agentCapabilityNames, capability => {
                  const details = integration.capabilities[capability];
                  return (
                    <li key={capability}>
                      <span>{capabilityLabel(capability)}</span>
                      <strong data-status={details.status}>{details.status}</strong>
                    </li>
                  );
                })}
              </ul>

              <p className="agent-card__verification">{integration.verification}</p>
              {integration.caveats.length > 0 && (
                <p className="agent-card__caveat">{EffectArray.join(integration.caveats, ' ')}</p>
              )}
              {integration.setup.length > 0 && <p className="agent-card__setup">{integration.setup[0]}</p>}

              <footer className="agent-card__footer">
                <a href={docsArticleHref(`agent-${integration.id}`)}>Surface details</a>
                {EffectArray.map(integration.officialDocs, (url, index) => (
                  <a href={url} key={url} rel="noreferrer" target="_blank">
                    Official docs {integration.officialDocs.length > 1 ? index + 1 : ''} ↗
                  </a>
                ))}
              </footer>
            </article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
