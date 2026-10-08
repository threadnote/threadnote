import React, {useEffect, useState} from 'react';
import type {PocketSource} from './integrations_contracts.js';
import {integrationProduct, IntegrationLogo} from './integration_catalog.js';
import {DetailModal} from './detail_modal.js';
import {useManagerDialogs} from './dialog.js';
import {api, errorMessage} from './ui/support.js';

const product = integrationProduct('pocket');

export function PocketConnectionForm({
  source,
  onClose,
  onSaved,
}: {
  readonly source?: PocketSource;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [id, setId] = useState(source?.id ?? '');
  const [token, setToken] = useState('');
  const [credentialMode, setCredentialMode] = useState<'local' | 'environment'>(
    source && source.credentialStorage !== 'local' ? 'environment' : 'local',
  );
  const [credentialEnv, setCredentialEnv] = useState(source?.credentialEnv ?? 'POCKET_API_KEY');
  const [projectMode, setProjectMode] = useState(source ? (source.project === null ? 'projectless' : 'project') : '');
  const [project, setProject] = useState(source?.project ?? '');
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(source?.refreshIntervalMinutes ?? 15);
  const [maxStaleHours, setMaxStaleHours] = useState(source?.maxStaleHours ?? 24);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const credentialReady =
    credentialMode === 'environment'
      ? /^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)
      : !!token || source?.credentialStorage === 'local';

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

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !credentialReady || !projectMode || (projectMode === 'project' && !project.trim())) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/integrations/pocket', {
        action: 'save-source',
        id,
        editing: !!source,
        ...(credentialMode === 'environment' ? {credentialEnv} : token ? {token} : {}),
        project: projectMode === 'projectless' ? null : project.trim(),
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
    <DetailModal title={source ? 'Pocket settings' : 'Connect Pocket'} onClose={() => void close()}>
      <form className="integration-form" onSubmit={event => void save(event)} onChange={() => setDirty(true)}>
        <div className="integration-form-product">
          <IntegrationLogo product={product} decorative />
          <p>
            All recordings accessible to this API key are imported automatically, including available transcripts,
            summaries, and action items.
          </p>
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
              placeholder="my-pocket"
            />
          </label>
          {credentialMode === 'local' ? (
            <label>
              Pocket API key{' '}
              {source?.credentialStorage === 'local' ? (
                <span className="muted">(leave blank to keep the saved key)</span>
              ) : null}
              <input
                type="password"
                autoComplete="new-password"
                required={!source || source.credentialStorage !== 'local'}
                value={token}
                onChange={event => setToken(event.target.value)}
              />
              <small>The key stays on this device. Create one in your Pocket account settings.</small>
            </label>
          ) : (
            <label>
              Environment variable name
              <input
                required
                maxLength={128}
                pattern="[A-Z_][A-Z0-9_]*"
                value={credentialEnv}
                onChange={event => setCredentialEnv(event.target.value)}
              />
              <small>The variable must be available to the Threadnote process. Its value is never shown here.</small>
            </label>
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
                  name="pocket-credential-mode"
                  checked={credentialMode === 'local'}
                  onChange={() => {
                    setCredentialMode('local');
                    setToken('');
                  }}
                />{' '}
                Save API key on this device
              </label>
              <label className="integration-checkbox">
                <input
                  type="radio"
                  name="pocket-credential-mode"
                  checked={credentialMode === 'environment'}
                  onChange={() => {
                    setCredentialMode('environment');
                    setToken('');
                  }}
                />{' '}
                Use environment variable
              </label>
            </fieldset>
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
            disabled={busy || !credentialReady || !projectMode || (projectMode === 'project' && !project.trim())}
          >
            {busy ? 'Saving…' : source ? 'Save settings' : 'Connect and sync'}
          </button>
        </footer>
      </form>
    </DetailModal>
  );
}
