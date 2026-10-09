import React, {useEffect, useState} from 'react';
import type {LinearSource, ResolvedLinearSelection} from '../manager-contracts.js';
import {IntegrationLogo} from '@threadnote/manager/integration-catalog';
import {product} from './catalog.js';
import {DetailModal} from '@threadnote/manager/detail-modal';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {api, errorMessage} from '@threadnote/manager/ui/support';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseLinearIds(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map(part => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function LinearConnectionForm({
  source,
  onClose,
  onSaved,
}: {
  readonly source?: LinearSource;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [id, setId] = useState(source?.id ?? '');
  const [token, setToken] = useState('');
  const [credentialMode, setCredentialMode] = useState<'local' | 'environment'>(
    source && source.credentialStorage !== 'local' ? 'environment' : 'local',
  );
  const [credentialEnv, setCredentialEnv] = useState(source?.credentialEnv ?? 'THREADNOTE_LINEAR_API_KEY');
  const [organizationId, setOrganizationId] = useState(source?.organizationId ?? '');
  const [principalId, setPrincipalId] = useState(source?.principalId ?? '');
  const [teamIds, setTeamIds] = useState(source?.teamIds.join('\n') ?? '');
  const [projectIds, setProjectIds] = useState(source?.projectIds.join('\n') ?? '');
  const [issueIds, setIssueIds] = useState(source?.issueIds.join('\n') ?? '');
  const [project, setProject] = useState(source?.project ?? '');
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(source?.refreshIntervalMinutes ?? 60);
  const [maxStaleHours, setMaxStaleHours] = useState(source?.maxStaleHours ?? 24);
  const [selection, setSelection] = useState<ResolvedLinearSelection>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const teams = parseLinearIds(teamIds);
  const projects = parseLinearIds(projectIds);
  const issues = parseLinearIds(issueIds);
  const validIds =
    teams.length > 0 &&
    projects.length + issues.length > 0 &&
    [...teams, ...projects, ...issues].every(value => uuid.test(value)) &&
    (!organizationId || uuid.test(organizationId)) &&
    (!principalId || uuid.test(principalId));
  const credentialReady =
    credentialMode === 'environment'
      ? /^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)
      : !!token || (source?.credentialStorage === 'local' && source.credentialConfigured);
  const ready = validIds && credentialReady && /^[a-z0-9][a-z0-9._-]*$/.test(project.trim());

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

  function requestFields(): Record<string, unknown> {
    return {
      id,
      teamIds: teams,
      projectIds: projects,
      issueIds: issues,
      ...(organizationId ? {organizationId} : {}),
      ...(principalId ? {principalId} : {}),
      ...(credentialMode === 'environment' ? {credentialEnv} : token ? {token} : {}),
    };
  }

  async function verify(): Promise<void> {
    if (busy || !validIds || !credentialReady) return;
    setBusy(true);
    setError('');
    setSelection(undefined);
    try {
      const resolved = await api<ResolvedLinearSelection>('/api/integrations/linear', {
        action: 'resolve-selection',
        ...requestFields(),
      });
      setOrganizationId(resolved.organizationId);
      setPrincipalId(resolved.principalId);
      setSelection(resolved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !ready || !selection) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/integrations/linear', {
        action: 'save-source',
        ...requestFields(),
        organizationId: selection.organizationId,
        principalId: selection.principalId,
        editing: !!source,
        project: project.trim(),
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
    <DetailModal title={source ? 'Linear settings' : 'Connect Linear'} onClose={() => void close()}>
      <form
        className="integration-form"
        onSubmit={event => void save(event)}
        onChange={() => {
          setDirty(true);
          setSelection(undefined);
        }}
      >
        <div className="integration-form-product">
          <IntegrationLogo product={product} decorative />
          <p>
            <span className="workspace-status neutral">Beta</span> Choose the teams and specific projects or issues that
            this connection may read.
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
              placeholder="my-linear"
            />
          </label>
          {credentialMode === 'local' ? (
            <label>
              Linear API key{' '}
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
              <small>Use a read-only key restricted to the teams you select. The key stays on this device.</small>
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
              <small>Make this variable available to the Threadnote process. Its value is never shown here.</small>
            </label>
          )}
          <label>
            Allowed team IDs
            <textarea
              required
              value={teamIds}
              onChange={event => setTeamIds(event.target.value)}
              placeholder="One team UUID per line"
            />
          </label>
          <label>
            Selected project IDs
            <textarea
              value={projectIds}
              onChange={event => setProjectIds(event.target.value)}
              placeholder="One project UUID per line"
            />
          </label>
          <label>
            Selected issue IDs
            <textarea
              value={issueIds}
              onChange={event => setIssueIds(event.target.value)}
              placeholder="One issue UUID per line"
            />
          </label>
          <small>
            Select at least one project or issue. Only issues in an allowed team and a selected project, or issues
            selected by ID, are included.
          </small>
          <label>
            Threadnote project slug
            <input
              required
              pattern="[a-z0-9][a-z0-9._-]*"
              value={project}
              onChange={event => setProject(event.target.value)}
              placeholder="my-project"
            />
          </label>
          <details className="integration-advanced">
            <summary>Advanced settings</summary>
            <fieldset className="integration-credential-choice">
              <legend>Credential method</legend>
              <label className="integration-checkbox">
                <input
                  type="radio"
                  name="linear-credential-mode"
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
                  name="linear-credential-mode"
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
              Minimum refresh interval (minutes)
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
          <button type="button" disabled={!validIds || !credentialReady || busy} onClick={() => void verify()}>
            {busy ? 'Checking…' : 'Verify selection'}
          </button>
          {selection ? (
            <div role="status" className="workspace-note">
              <p>Verified for this Linear account:</p>
              <p>
                {selection.teams.map(item => item.name).join(', ')} · {selection.projects.length} projects ·{' '}
                {selection.issues.length} issues
              </p>
              {selection.issues.length ? (
                <ul>
                  {selection.issues.map(item => (
                    <li key={item.id}>
                      {item.identifier}: {item.title}
                    </li>
                  ))}
                </ul>
              ) : null}
              <small>
                Issue descriptions and published discussion are included. Inline comments and project update comments
                are not available in this connection.
              </small>
            </div>
          ) : null}
        </fieldset>
        <footer className="conflict-footer">
          <button type="button" disabled={busy} onClick={() => void close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !ready || !selection}>
            {busy ? 'Saving…' : source ? 'Save settings' : 'Connect'}
          </button>
        </footer>
      </form>
    </DetailModal>
  );
}
