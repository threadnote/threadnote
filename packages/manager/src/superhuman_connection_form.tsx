import React, {useEffect, useRef, useState} from 'react';
import {X} from 'lucide-react';
import {SuperhumanSelectionIcon} from './superhuman_selection_icon.js';
import {
  MAX_SUPERHUMAN_MANAGER_LINKS,
  mergeResolvedSuperhumanSelections,
  retainedSuperhumanSelection,
} from './superhuman_selection.js';
import type {
  ResolvedSuperhumanSelection,
  SuperhumanDocumentSelection,
  SuperhumanSource,
} from './integrations_contracts.js';
import {integrationProduct, IntegrationLogo} from './integration_catalog.js';
import {DetailModal} from './detail_modal.js';
import {useManagerDialogs} from './dialog.js';
import {api, errorMessage} from './ui/support.js';

const product = integrationProduct('superhuman');

function linksFrom(value: string): readonly string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function scopeSummary(documents: readonly SuperhumanDocumentSelection[]): string {
  const whole = documents.filter(document => document.pages === undefined).length;
  const pages = documents.reduce((sum, document) => sum + (document.pages?.length ?? 0), 0);
  return [
    whole ? `${whole} whole ${whole === 1 ? 'document' : 'documents'}` : '',
    pages ? `${pages} selected ${pages === 1 ? 'page' : 'pages'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SuperhumanConnectionForm({
  source,
  onClose,
  onSaved,
}: {
  readonly source?: SuperhumanSource;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [id, setId] = useState(source?.id ?? '');
  const [links, setLinks] = useState('');
  const linkInput = useRef<HTMLTextAreaElement>(null);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [titleStatus, setTitleStatus] = useState(source ? 'Loading saved selection titles…' : '');
  const [scopeChanged, setScopeChanged] = useState(false);
  const [token, setToken] = useState('');
  const [credentialMode, setCredentialMode] = useState<'local' | 'environment'>(
    source && source.credentialStorage !== 'local' ? 'environment' : 'local',
  );
  const [credentialEnv, setCredentialEnv] = useState(source?.credentialEnv ?? 'SUPERHUMAN_DOCS_API_TOKEN');
  const [resolved, setResolved] = useState<ResolvedSuperhumanSelection | undefined>(
    source ? retainedSuperhumanSelection(source.documents) : undefined,
  );
  const [projectMode, setProjectMode] = useState(source ? (source.project === null ? 'projectless' : 'project') : '');
  const [project, setProject] = useState(source?.project ?? '');
  const [includeHidden, setIncludeHidden] = useState(source?.includeHidden ?? false);
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(source?.refreshIntervalMinutes ?? 15);
  const [maxStaleHours, setMaxStaleHours] = useState(source?.maxStaleHours ?? 24);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const credentialReady =
    credentialMode === 'environment'
      ? /^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)
      : !!token || source?.credentialStorage === 'local';
  const checkedLinks = [
    ...new Set([
      ...linksFrom(links),
      ...(needsCheck ? (resolved?.selections.flatMap(item => (item.browserLink ? [item.browserLink] : [])) ?? []) : []),
    ]),
  ];

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    void api<ResolvedSuperhumanSelection>(
      '/api/integrations/superhuman',
      {action: 'describe-selection', id: source.id},
      {signal: controller.signal},
    ).then(
      selection => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(selection.selections)) {
          setTitleStatus('Titles could not be loaded. Your saved selection is still available.');
          return;
        }
        // Hydrate labels only: an in-flight response must never restore a removed chip.
        setResolved(current =>
          current
            ? {
                ...current,
                selections: current.selections.map(
                  item =>
                    selection.selections.find(
                      fetched => fetched.documentId === item.documentId && fetched.pageId === item.pageId,
                    ) ?? item,
                ),
              }
            : current,
        );
        setTitleStatus('');
      },
      () => {
        if (!controller.signal.aborted)
          setTitleStatus('Titles could not be loaded. Your saved selection is still available.');
      },
    );
    return () => controller.abort();
  }, [source]);

  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);

  async function close(): Promise<void> {
    if (busy) return;
    if (
      dirty &&
      !(await dialogs.confirm({title: 'Discard connection changes?', confirmLabel: 'Discard changes', tone: 'danger'}))
    )
      return;
    setToken('');
    onClose();
  }

  async function checkLinks(): Promise<void> {
    if (busy || checkedLinks.length === 0 || !credentialReady) return;
    setBusy(true);
    setError('');
    try {
      const selection = await api<ResolvedSuperhumanSelection>('/api/integrations/superhuman', {
        action: 'resolve-links',
        links: checkedLinks,
        ...(credentialMode === 'environment' ? {credentialEnv} : token ? {token} : {}),
        ...(source ? {id: source.id} : {}),
      });
      if (selection.documents.length === 0) throw new Error('No document or page was selected.');
      if (
        mergeResolvedSuperhumanSelections([...(resolved?.selections ?? []), ...selection.selections]).selections
          .length > MAX_SUPERHUMAN_MANAGER_LINKS
      )
        throw new Error(`Choose up to ${MAX_SUPERHUMAN_MANAGER_LINKS} document or page links.`);
      setResolved(current =>
        mergeResolvedSuperhumanSelections([
          ...(current?.selections.filter(item => !needsCheck || !item.browserLink) ?? []),
          ...selection.selections.map(item => ({
            ...item,
            // Resolution responses associate titles with browser links. A single-link
            // response from an older Manager can still be displayed as a linked chip.
            ...(item.browserLink === undefined && checkedLinks.length === 1 ? {browserLink: checkedLinks[0]} : {}),
          })),
        ]),
      );
      setLinks('');
      setNeedsCheck(false);
      setScopeChanged(true);
      setDirty(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function removeSelection(documentId: string, pageId?: string): void {
    setResolved(
      current =>
        current &&
        mergeResolvedSuperhumanSelections(
          current.selections.filter(item => item.documentId !== documentId || item.pageId !== pageId),
        ),
    );
    setDirty(true);
    linkInput.current?.focus();
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (
      busy ||
      !resolved?.documents.length ||
      needsCheck ||
      linksFrom(links).length ||
      !credentialReady ||
      !projectMode ||
      (projectMode === 'project' && !project.trim())
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/api/integrations/superhuman', {
        action: 'save-source',
        id,
        editing: !!source,
        ...(credentialMode === 'environment' ? {credentialEnv} : token ? {token} : {}),
        documents: resolved.documents,
        project: projectMode === 'projectless' ? null : project.trim(),
        includeHidden,
        refreshIntervalMinutes,
        maxStaleHours,
        apply: true,
        confirm: true,
      });
      setToken('');
      setDirty(false);
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailModal title={source ? 'Superhuman Docs settings' : 'Connect Superhuman Docs'} onClose={() => void close()}>
      <form className="integration-form" onSubmit={event => void save(event)} onChange={() => setDirty(true)}>
        <div className="integration-form-product">
          <IntegrationLogo product={product} decorative />
          <p>Import canvas text from the documents or pages you choose. Tables and attachments are excluded.</p>
        </div>
        {error ? (
          <p role="alert" className="workspace-note danger-text">
            {error}
          </p>
        ) : null}
        <fieldset disabled={busy}>
          <label>
            Connection name
            <input
              required
              maxLength={128}
              pattern="[a-z0-9][a-z0-9._-]*"
              value={id}
              disabled={!!source}
              onChange={event => setId(event.target.value)}
              placeholder="team-docs"
            />
          </label>
          {credentialMode === 'local' ? (
            <label>
              API Read token{' '}
              {source?.credentialStorage === 'local' ? (
                <span className="muted">(leave blank to keep the saved token)</span>
              ) : null}
              <input
                type="password"
                autoComplete="new-password"
                required={!source || source.credentialStorage !== 'local'}
                value={token}
                onChange={event => {
                  setToken(event.target.value);
                  if (!source || scopeChanged) setNeedsCheck(true);
                }}
              />
              <small>
                Create a Read only API token in{' '}
                <a href="https://docs.superhuman.com/account" target="_blank" rel="noreferrer">
                  Superhuman Docs account settings
                </a>
                . The token stays on this device.
              </small>
            </label>
          ) : (
            <label>
              Environment variable name
              <input
                required
                maxLength={128}
                pattern="[A-Z_][A-Z0-9_]*"
                value={credentialEnv}
                onChange={event => {
                  setCredentialEnv(event.target.value);
                  if (!source || scopeChanged) setNeedsCheck(true);
                }}
              />
              <small>The variable must be available to the Threadnote process. Its value is never shown here.</small>
            </label>
          )}
          <div className="integration-link-picker">
            <label htmlFor="superhuman-links">Document or page links</label>
            {resolved?.selections.length ? (
              <ul className="integration-link-chips" aria-label="Selected documents and pages">
                {resolved.selections.map(item => (
                  <li
                    className="integration-link-chip"
                    key={`${item.documentId}/${item.pageId ?? ''}`}
                    data-kind={item.pageId ? 'page' : 'document'}
                  >
                    <SuperhumanSelectionIcon iconUrl={item.iconUrl} page={item.pageId !== undefined} />
                    <span className="integration-link-chip-label">
                      {item.browserLink ? (
                        <a href={item.browserLink} target="_blank" rel="noreferrer" title={item.name}>
                          {item.name}
                        </a>
                      ) : (
                        <span title={item.name}>{item.name}</span>
                      )}
                      <small>{item.pageId ? 'Selected page' : 'Whole document'}</small>
                    </span>
                    <button
                      type="button"
                      className="integration-link-chip-remove"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => removeSelection(item.documentId, item.pageId)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <textarea
              id="superhuman-links"
              ref={linkInput}
              rows={1}
              value={links}
              onChange={event => setLinks(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void checkLinks();
                }
              }}
              placeholder="https://docs.superhuman.com/d/…"
              aria-describedby="superhuman-links-help"
            />
            <small id="superhuman-links-help">
              Paste a link and press Enter to add it. You can paste several links, one per line. A document link selects
              its whole document; a page link selects that page. Hidden pages are excluded by default.
            </small>
            {titleStatus ? <small role="status">{titleStatus}</small> : null}
            <button
              type="button"
              disabled={!checkedLinks.length || !credentialReady || busy}
              onClick={() => void checkLinks()}
            >
              {busy ? 'Checking…' : needsCheck && !linksFrom(links).length ? 'Check links' : 'Add links'}
            </button>
          </div>
          {resolved?.documents.length ? (
            <div className="integration-selection" role="status">
              <strong>{scopeSummary(resolved.documents)}</strong>
              {needsCheck ? <p>Check links with the updated credential before saving.</p> : null}
            </div>
          ) : (
            <p className="muted">Add links to choose the documents or pages to import.</p>
          )}
          <label>
            Project association
            <select required value={projectMode} onChange={event => setProjectMode(event.target.value)}>
              <option value="">Choose an option…</option>
              <option value="project">Associate with a project</option>
              <option value="projectless">Keep projectless</option>
            </select>
          </label>
          {projectMode === 'project' ? (
            <label>
              Project slug
              <input
                required
                pattern="[a-z0-9][a-z0-9._-]*"
                value={project}
                onChange={event => setProject(event.target.value)}
                placeholder="my-project"
              />
            </label>
          ) : null}
          <details className="integration-advanced">
            <summary>Advanced settings</summary>
            <fieldset className="integration-credential-choice">
              <legend>Credential method</legend>
              <label className="integration-checkbox">
                <input
                  type="radio"
                  name="superhuman-credential-mode"
                  checked={credentialMode === 'local'}
                  onChange={() => {
                    setCredentialMode('local');
                    setToken('');
                    if (!source || scopeChanged) setNeedsCheck(true);
                  }}
                />{' '}
                Save API token on this device
              </label>
              <label className="integration-checkbox">
                <input
                  type="radio"
                  name="superhuman-credential-mode"
                  checked={credentialMode === 'environment'}
                  onChange={() => {
                    setCredentialMode('environment');
                    setToken('');
                    if (!source || scopeChanged) setNeedsCheck(true);
                  }}
                />{' '}
                Use environment variable
              </label>
            </fieldset>
            <label className="integration-checkbox">
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={event => setIncludeHidden(event.target.checked)}
              />{' '}
              Include hidden pages
            </label>
            <label>
              Refresh interval (minutes)
              <input
                type="number"
                min={1}
                max={10080}
                required
                value={refreshIntervalMinutes}
                onChange={event => setRefreshIntervalMinutes(Number(event.target.value))}
              />
            </label>
            <label>
              Maximum stale age (hours)
              <input
                type="number"
                min={1}
                max={8760}
                required
                value={maxStaleHours}
                onChange={event => setMaxStaleHours(Number(event.target.value))}
              />
            </label>
          </details>
        </fieldset>
        <footer className="conflict-footer">
          <button type="button" disabled={busy} onClick={() => void close()}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              busy ||
              !resolved?.documents.length ||
              needsCheck ||
              !!linksFrom(links).length ||
              !credentialReady ||
              !projectMode ||
              (projectMode === 'project' && !project.trim())
            }
          >
            {busy ? 'Saving…' : source ? 'Save settings' : 'Create connection'}
          </button>
        </footer>
      </form>
    </DetailModal>
  );
}
