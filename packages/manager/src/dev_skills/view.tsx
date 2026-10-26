import {Schema} from 'effect';
import React, {useEffect, useRef, useState} from 'react';
import {useManagerDialogs} from '../dialog.js';
import {api, errorMessage, ManagerApiError} from '../ui/support.js';
import type {RuntimeUpdates} from '../update_contracts.js';
import {
  MANAGER_DEV_SKILLS_ROUTES as routes,
  type ManagerDevSkillsAction,
  type ManagerDevSkillsApplyResponse,
  type ManagerDevSkillsCatalog,
  type ManagerDevSkillsPlan,
  type ManagerDevSkillsProjects,
  type ManagerDevSkillsScope,
  type ManagerDevSkillsSelector,
  type ManagerDevSkillsStatus,
  type ManagerDevSkillsTargetStatus,
} from './contracts.js';
import {PreviewDetails, TargetDetails, WorkflowCards} from './details.js';

const requestOptions = {timeoutMilliseconds: 20_000};

export function DevSkillsPanel(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [catalog, setCatalog] = useState<ManagerDevSkillsCatalog>();
  const [projects, setProjects] = useState<ManagerDevSkillsProjects['projects']>([]);
  const [surfaceId, setSurfaceId] = useState('');
  const [scope, setScope] = useState<ManagerDevSkillsScope>('user');
  const [cwd, setCwd] = useState('');
  const [status, setStatus] = useState<ManagerDevSkillsStatus>();
  const [preview, setPreview] = useState<ManagerDevSkillsPlan>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('Loading catalog');
  const [applying, setApplying] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [policy, setPolicy] = useState<RuntimeUpdates>();
  const [policyError, setPolicyError] = useState('');
  const [projectError, setProjectError] = useState('');
  const [recordedTargets, setRecordedTargets] = useState<readonly ManagerDevSkillsTargetStatus[]>([]);
  const [inventoryError, setInventoryError] = useState('');
  const epoch = useRef(0);
  const mounted = useRef(true);
  const surface = catalog?.surfaces.find(item => item.surfaceId === surfaceId);
  const managed = surface?.status === 'managed' ? surface : undefined;
  const platformSupported = !!managed && !!catalog && managed.platforms.includes(catalog.platform);
  const existingPaths = recordedTargets
    .filter(
      item =>
        item.enrolled &&
        item.enrollmentState === 'enrolled' &&
        item.target.surfaceId === managed?.surfaceId &&
        item.target.profile === managed.profile &&
        item.target.scope === scope &&
        item.target.cwd,
    )
    .map(item => item.target.cwd!);
  const projectPaths = [...new Set([...projects.map(project => project.path), ...existingPaths])];
  const selector: ManagerDevSkillsSelector | undefined =
    managed && platformSupported && (scope === 'user' || projectPaths.includes(cwd))
      ? {agent: managed.surfaceId, profile: managed.profile, scope, ...(scope === 'user' ? {} : {cwd})}
      : undefined;
  const selectorKey = selector ? JSON.stringify(selector) : '';
  const selection = useRef({managed, scope, cwd, projects});
  selection.current = {managed, scope, cwd, projects};

  useEffect(() => {
    const controller = new AbortController();
    void api<ManagerDevSkillsStatus>(routes.status, undefined, {...requestOptions, signal: controller.signal})
      .then(next => {
        if (controller.signal.aborted) return;
        const current = selection.current;
        const stillRecorded = next.targets.some(
          item =>
            item.enrolled &&
            item.enrollmentState === 'enrolled' &&
            item.target.surfaceId === current.managed?.surfaceId &&
            item.target.profile === current.managed.profile &&
            item.target.scope === current.scope &&
            item.target.cwd === current.cwd,
        );
        if (current.cwd && !current.projects.some(project => project.path === current.cwd) && !stillRecorded) {
          epoch.current += 1;
          setPreview(undefined);
          setStatus(undefined);
          setCwd('');
          setBusy('');
        }
        setRecordedTargets(next.targets);
        setInventoryError('');
      })
      .catch(cause => {
        if (!controller.signal.aborted) setInventoryError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<ManagerDevSkillsCatalog>(routes.catalog, undefined, {...requestOptions, signal: controller.signal})
      .then(next => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        const first = next.surfaces.find(item => item.status === 'managed');
        if (first?.status === 'managed') {
          setSurfaceId(first.surfaceId);
          setScope(first.defaultScope);
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy('');
      });
    void api<ManagerDevSkillsProjects>(routes.projects, undefined, {...requestOptions, signal: controller.signal})
      .then(next => {
        if (!controller.signal.aborted) setProjects(next.projects);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setProjectError(errorMessage(cause));
      });
    void api<RuntimeUpdates>('/api/runtime/updates?view=status', undefined, {
      ...requestOptions,
      signal: controller.signal,
    })
      .then(next => {
        if (!controller.signal.aborted) setPolicy(next);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setPolicyError(errorMessage(cause));
      });
    return () => {
      mounted.current = false;
      epoch.current += 1;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!selectorKey) return;
    const controller = new AbortController();
    const ticket = epoch.current;
    const query = new URLSearchParams(JSON.parse(selectorKey) as Record<string, string>);
    setBusy('Reading target status');
    void api<ManagerDevSkillsStatus>(`${routes.status}?${query}`, undefined, {
      ...requestOptions,
      signal: controller.signal,
    })
      .then(next => {
        if (!controller.signal.aborted && ticket === epoch.current) setStatus(next);
      })
      .catch(cause => {
        if (!controller.signal.aborted && ticket === epoch.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted && ticket === epoch.current) setBusy('');
      });
    return () => controller.abort();
  }, [selectorKey, refresh]);

  function invalidate(): void {
    epoch.current += 1;
    setPreview(undefined);
    setStatus(undefined);
    setError('');
    setNotice('');
    setBusy('');
  }

  async function previewAction(action: ManagerDevSkillsAction): Promise<void> {
    if (!selector || applying) return;
    const ticket = ++epoch.current;
    setPreview(undefined);
    setError('');
    setNotice('');
    setBusy(`Previewing ${action}`);
    try {
      const next = await api<ManagerDevSkillsPlan>(routes.preview, {action, selector}, requestOptions);
      if (mounted.current && ticket === epoch.current) setPreview(next);
    } catch (cause) {
      if (mounted.current && ticket === epoch.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current && ticket === epoch.current) setBusy('');
    }
  }

  async function confirmPreview(): Promise<void> {
    if (!preview?.canApply || !selector || busy || applying) return;
    const ticket = epoch.current;
    const captured = preview;
    const confirmed = await dialogs.confirm({
      title: `Confirm ${captured.action} development workflows`,
      confirmLabel: `Confirm ${captured.action}`,
      tone: captured.action === 'remove' ? 'danger' : 'default',
      message: `${captured.action} at ${captured.target.skillRoot}?`,
      detail: `${captured.changes.length} file changes; ${captured.consumers.length} shared consumers. Preview ${captured.previewDigest}. Installing does not execute development.`,
    });
    if (!confirmed || !mounted.current || ticket !== epoch.current) return;
    setApplying(true);
    setBusy(`Applying ${captured.action}`);
    setError('');
    setPreview(undefined);
    try {
      const response = await api<ManagerDevSkillsApplyResponse>(
        routes.apply,
        {
          action: captured.action,
          selector,
          previewDigest: captured.previewDigest,
          confirm: true,
        },
        requestOptions,
      );
      if (!mounted.current || ticket !== epoch.current) return;
      setStatus(response.status);
      setRecordedTargets(current => [
        ...current.filter(
          item =>
            !response.status.targets.some(
              next =>
                next.target.surfaceId === item.target.surfaceId &&
                next.target.profile === item.target.profile &&
                next.target.scope === item.target.scope &&
                next.target.cwd === item.target.cwd,
            ),
        ),
        ...response.status.targets,
      ]);
      const result = response.result;
      setNotice(
        `${result.applied ? 'Completed' : 'No changes applied'}: ${result.action}.${result.recovered ? ' Recovered an interrupted operation.' : ''}${result.retainedPaths.length ? ` Retained files: ${result.retainedPaths.join(', ')}` : ''}${result.issues.length ? ` ${result.issues.map(issue => issue.message).join(' ')}` : ''}`,
      );
      setRefresh(value => value + 1);
    } catch (cause) {
      if (!mounted.current || ticket !== epoch.current) return;
      setError(
        `${errorMessage(cause)}${Schema.is(ManagerApiError)(cause) && cause.status === 409 ? ' The preview is stale. Review a fresh preview before confirming again.' : ' Preview again before retrying.'}`,
      );
    } finally {
      if (mounted.current && ticket === epoch.current) {
        setApplying(false);
        setBusy('');
      }
    }
  }

  const target = status?.targets[0];
  // Legacy execution stays blocked; only verified, clean ownership can request a mutation preview.
  const legacyRepairable =
    target?.enrolled === true &&
    target.installed !== undefined &&
    target.issues.length === 1 &&
    target.issues[0].code === 'legacy-workflow-update-required';
  const actionable =
    !!selector &&
    !!target &&
    !busy &&
    !applying &&
    target.installationState !== 'unsupported' &&
    (target.installationState !== 'incompatible' || legacyRepairable);
  const canInstall =
    actionable &&
    !legacyRepairable &&
    (!target.enrolled ||
      !target.enabled ||
      target.enrollmentState === 'removed' ||
      target.installationState === 'absent');
  const canUpdate = actionable && target.enrollmentState === 'enrolled' && target.installationState !== 'absent';
  const canRemove =
    actionable &&
    target.enrollmentState !== 'removed' &&
    (target.enrolled || !!target.installed || !!target.installedDigest);
  return (
    <div className="workspace-stack" aria-busy={!!busy}>
      <WorkflowCards />
      <section className="workspace-card" aria-label="Workflow target">
        <header>
          <h3>Host and installation target</h3>
          <button
            type="button"
            disabled={!selector || !!busy || applying}
            onClick={() => {
              invalidate();
              setRefresh(value => value + 1);
            }}
          >
            Refresh status
          </button>
        </header>
        <div className="workspace-pad">
          <p>
            Desktop targets support native Windows, macOS and Linux according to the catalog. Personal Codex and Cursor
            cloud profiles manage supported targets reachable by this runtime.
          </p>
          <p>
            For another environment, run Threadnote setup, update or start there. Corporate profiles and remote server
            management are outside this page.
          </p>
          <div className="worksets-form-row">
            <label>
              Host / profile
              <select
                aria-label="Host / profile"
                disabled={applying || !catalog}
                value={surfaceId}
                onChange={event => {
                  invalidate();
                  setSurfaceId(event.target.value);
                  const next = catalog?.surfaces.find(item => item.surfaceId === event.target.value);
                  if (next?.status === 'managed') setScope(next.defaultScope);
                  setCwd('');
                }}
              >
                <option value="" disabled>
                  Select a host
                </option>
                {catalog?.surfaces.map(item => (
                  <option key={item.surfaceId} value={item.surfaceId}>
                    {item.displayName}
                    {item.status === 'managed' ? ` · ${item.profile}` : ' · unsupported'}
                  </option>
                ))}
              </select>
            </label>
            {managed ? (
              <label>
                Scope
                <select
                  aria-label="Scope"
                  disabled={applying}
                  value={scope}
                  onChange={event => {
                    invalidate();
                    setScope(event.target.value as ManagerDevSkillsScope);
                    setCwd('');
                  }}
                >
                  {managed.scopes.map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {managed && scope !== 'user' ? (
              <label>
                Registered project path
                <select
                  aria-label="Registered project path"
                  disabled={applying}
                  value={cwd}
                  onChange={event => {
                    invalidate();
                    setCwd(event.target.value);
                  }}
                >
                  <option value="">Select a registered project or existing installation</option>
                  {projectPaths.map(path => (
                    <option key={path} value={path}>
                      {projects.find(project => project.path === path)?.name ?? 'Existing installation'} · {path}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {managed?.scopeReason ? <p>{managed.scopeReason}</p> : null}
          {managed ? (
            <p>
              Catalog layout: {managed.layout} · supported platforms: {managed.platforms.join(', ')}
            </p>
          ) : null}
          {surface?.status === 'unsupported' ? <p role="status">{surface.reason}</p> : null}
          {managed && !platformSupported ? (
            <p role="status">
              This {managed.profile} target is unavailable on {catalog?.platform}. Use Threadnote setup, update or start
              in a supported environment.
            </p>
          ) : null}
          {managed && scope !== 'user' && !cwd ? <p>Select a registered project or existing installation.</p> : null}
          {projectError ? <p role="alert">Registered projects unavailable: {projectError}</p> : null}
          {inventoryError ? <p role="alert">Existing installation inventory unavailable: {inventoryError}</p> : null}
          <p>
            Available release: {catalog?.bundle.releaseVersion ?? 'Loading'} · digest{' '}
            <code>{catalog?.bundle.digest ?? 'Loading'}</code>
          </p>
          <p>
            Runtime automatic update policy: {policy ? policy.policy : 'unavailable'}
            {policy?.automaticRunning ? ' · update running' : ''}. Target refresh outcomes appear separately below.
          </p>
          {policy?.automaticFailure ? (
            <p role="status">Last runtime update failure: {policy.automaticFailure}</p>
          ) : null}
          {policyError ? <p role="status">Runtime policy unavailable: {policyError}</p> : null}
          <div className="worksets-form-row">
            <button type="button" disabled={!canInstall} onClick={() => void previewAction('install')}>
              Preview install
            </button>
            <button type="button" disabled={!canUpdate} onClick={() => void previewAction('update')}>
              Preview update
            </button>
            <button type="button" disabled={!canRemove} onClick={() => void previewAction('remove')}>
              Preview remove
            </button>
          </div>
        </div>
      </section>
      {busy ? <p role="status">{busy}…</p> : null}
      {error ? (
        <p className="worksets-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="worksets-notice" role="status">
          {notice}
        </p>
      ) : null}
      {target ? <TargetDetails status={target} /> : null}
      {preview ? (
        <>
          <PreviewDetails plan={preview} />
          <button
            className="primary"
            type="button"
            disabled={!preview.canApply || !!busy || applying}
            onClick={() => void confirmPreview()}
          >
            Review and confirm {preview.action}
          </button>
        </>
      ) : null}
    </div>
  );
}
