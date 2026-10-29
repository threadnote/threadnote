import {Array as EffectArray} from 'effect';
import React, {useEffect, useState} from 'react';
import type {GitHubSource} from '../manager-contracts.js';
import {IntegrationLogo} from '@threadnote/manager/integration-catalog';
import {product} from './catalog.js';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

function repositoryList(value: string): readonly string[] {
  return [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(Effect.pipe(value, EffectString.split(/[\n,]/)), item => Effect.pipe(item, EffectString.trim)),
        Boolean,
      ),
    ),
  ];
}

export function GitHubConnectionForm({
  source,
  reusableCredential = false,
  onClose,
  onSaved,
}: {
  readonly source?: GitHubSource;
  readonly reusableCredential?: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [id, setId] = useState(source?.id ?? '');
  const [repositories, setRepositories] = useState(
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(source?.repositories), __effectArrayJoinReceiver =>
        EffectArray.join(__effectArrayJoinReceiver, '\n'),
      ),
    ) ?? '',
  );
  const [token, setToken] = useState('');
  const [credentialMode, setCredentialMode] = useState<'reuse' | 'local' | 'environment'>(
    source ? (source.credentialStorage !== 'local' ? 'environment' : 'local') : reusableCredential ? 'reuse' : 'local',
  );
  const [credentialEnv, setCredentialEnv] = useState(source?.credentialEnv ?? 'THREADNOTE_GITHUB_TOKEN');
  const [projectMode, setProjectMode] = useState(source ? (source.project === null ? 'projectless' : 'project') : '');
  const [project, setProject] = useState(source?.project ?? '');
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(source?.refreshIntervalMinutes ?? 15);
  const [maxStaleHours, setMaxStaleHours] = useState(source?.maxStaleHours ?? 24);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const repos = repositoryList(repositories);
  const credentialReady =
    credentialMode === 'reuse'
      ? reusableCredential
      : credentialMode === 'environment'
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
    if (
      busy ||
      repos.length === 0 ||
      !credentialReady ||
      !projectMode ||
      (projectMode === 'project' && !Effect.pipe(project, EffectString.trim))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/api/integrations/github', {
        action: 'save-source',
        id,
        editing: !!source,
        repositories: repos,
        ...(credentialMode === 'environment' ? {credentialEnv} : token ? {token} : {}),
        project: projectMode === 'projectless' ? null : Effect.pipe(project, EffectString.trim),
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
    <DetailModal title={source ? 'GitHub settings' : 'Connect GitHub'} onClose={() => void close()}>
      <form className="integration-form" onSubmit={event => void save(event)} onChange={() => setDirty(true)}>
        <div className="integration-form-product">
          <IntegrationLogo product={product} decorative />
          <p>Select the repositories to import. Threadnote reads issues, pull requests, and their discussions.</p>
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
              placeholder="engineering"
            />
          </label>
          {credentialMode === 'reuse' ? (
            <p className="muted">An available GitHub credential will be reused for this connection.</p>
          ) : credentialMode === 'local' ? (
            <label>
              Fine grained personal access token{' '}
              {source?.credentialStorage === 'local' ? (
                <span className="muted">(leave blank to keep the saved token)</span>
              ) : null}
              <input
                type="password"
                autoComplete="new-password"
                required={!source || source.credentialStorage !== 'local'}
                value={token}
                onChange={event => setToken(event.target.value)}
              />
              <small>The token stays on this device. Limit it to the repositories selected below.</small>
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
            Repositories
            <textarea
              required
              rows={4}
              value={repositories}
              onChange={event => setRepositories(event.target.value)}
              placeholder={'owner/repository\nhttps://github.com/owner/another-repository'}
            />
            <small>Enter one owner/repository or GitHub repository link per line.</small>
          </label>
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
              {!source && reusableCredential ? (
                <label className="integration-checkbox">
                  <input
                    type="radio"
                    name="github-credential-mode"
                    checked={credentialMode === 'reuse'}
                    onChange={() => {
                      setCredentialMode('reuse');
                      setToken('');
                    }}
                  />{' '}
                  Reuse an available GitHub credential
                </label>
              ) : null}
              <label className="integration-checkbox">
                <input
                  type="radio"
                  name="github-credential-mode"
                  checked={credentialMode === 'local'}
                  onChange={() => {
                    setCredentialMode('local');
                    setToken('');
                  }}
                />{' '}
                Save token on this device
              </label>
              <label className="integration-checkbox">
                <input
                  type="radio"
                  name="github-credential-mode"
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
            disabled={
              busy ||
              repos.length === 0 ||
              !credentialReady ||
              !projectMode ||
              (projectMode === 'project' && !Effect.pipe(project, EffectString.trim))
            }
          >
            {busy ? 'Saving…' : source ? 'Save settings' : 'Connect and sync'}
          </button>
        </footer>
      </form>
    </DetailModal>
  );
}
