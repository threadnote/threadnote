import React, {useEffect, useRef, useState} from 'react';
import {ArrowDownToLine, BookOpen, Check, CircleAlert, RefreshCw, ShieldCheck} from 'lucide-react';
import {api, errorMessage} from './ui/support.js';
import {MarkdownViewer} from './ui/controls.js';
import type {RuntimeReleaseNotes, RuntimeUpdates} from './update_contracts.js';

const endpoint = '/api/runtime/updates';

export function RuntimeUpdatesPanel({onChanged}: {readonly onChanged: () => void}): React.ReactElement {
  const [data, setData] = useState<RuntimeUpdates>();
  const [busy, setBusy] = useState<string>('Loading updates');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    const controller = new AbortController();
    setBusy('Loading updates');
    void api<RuntimeUpdates>(endpoint, undefined, {signal: controller.signal, timeoutMilliseconds: 20_000})
      .then(setData)
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy('');
      });
    return () => controller.abort();
  }, [generation]);
  const running = data?.job?.status === 'running' || data?.automaticRunning;
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      try {
        const next = await api<RuntimeUpdates>(endpoint + '?view=status', undefined, {
          signal: controller.signal,
          timeoutMilliseconds: 10_000,
        });
        if (controller.signal.aborted) return;
        setData(next);
        setError('');
        if (next.job?.status !== 'running' && !next.automaticRunning) {
          setGeneration(value => value + 1);
          changed.current();
          return;
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    }
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [running]);
  async function act(action: 'check' | 'policy' | 'update'): Promise<void> {
    if (busy || running) return;
    setBusy(
      action === 'check' ? 'Checking for updates' : action === 'policy' ? 'Saving preference' : 'Starting update',
    );
    setError('');
    try {
      const next = await api<RuntimeUpdates>(
        endpoint,
        {
          action,
          confirm: true,
          ...(action === 'policy' ? {policy: data?.policy === 'automatic' ? 'notify' : 'automatic'} : {}),
        },
        {timeoutMilliseconds: 20_000},
      );
      setData(next);
      if (action === 'policy') changed.current();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  const disabled = !!busy || !!running;
  return (
    <div className="runtime-updates" aria-busy={disabled}>
      {error ? (
        <div className="workspace-note runtime-update-error" role="alert">
          <CircleAlert />
          {error}
        </div>
      ) : null}
      <section className="workspace-card">
        <header>
          <h3>Threadnote updates</h3>
          <button disabled={disabled} onClick={() => void act('check')}>
            <RefreshCw aria-hidden="true" />
            {busy === 'Checking for updates' ? 'Checking…' : 'Check for updates'}
          </button>
        </header>
        <div className="workspace-row runtime-version-row">
          <ShieldCheck aria-hidden="true" />
          <div className="row-copy">
            <strong>
              Installed version{' '}
              {data?.installedVersion ? <span className="runtime-version">{data.installedVersion}</span> : ''}
            </strong>
            <p>
              {data ? `${data.channel === 'beta' ? 'Beta' : 'Stable'} channel` : 'Reading the installation…'}
              {data?.checkedAt ? ` · Last checked ${new Date(data.checkedAt).toLocaleString()}` : ''}
            </p>
          </div>
          {data ? (
            <span className={`workspace-status ${data.updateAvailable || data.checkError ? 'warn' : 'neutral'}`}>
              {data.developmentBuild
                ? 'Development build'
                : data.checkError
                  ? 'Check failed'
                  : data.updateAvailable
                    ? `v${data.latestVersion} available`
                    : data.latestVersion
                      ? 'Up to date'
                      : data.checkedAt
                        ? 'No release published'
                        : 'Not checked'}
            </span>
          ) : null}
        </div>
        <div className="workspace-row">
          <RefreshCw aria-hidden="true" />
          <div className="row-copy">
            <strong>Automatic updates</strong>
            <p>Install eligible updates automatically when Threadnote is in use.</p>
            {data?.policyManaged ? <p>Managed by an environment setting.</p> : null}
            {data?.developmentBuild ? <p>Development builds are updated from their owning checkout.</p> : null}
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Automatic updates"
            aria-checked={data?.policy === 'automatic'}
            className="runtime-update-switch"
            disabled={disabled || !data || data.policyManaged}
            onClick={() => void act('policy')}
          >
            <span aria-hidden="true" />
            <span>{data?.policy === 'automatic' ? 'On' : 'Off'}</span>
          </button>
        </div>
        {data?.checkError ? (
          <p className="runtime-update-message" role="alert">
            Could not check for updates. {data.checkError}
          </p>
        ) : null}
        {data?.automaticFailure ? (
          <p className="runtime-update-message">Last automatic update: {data.automaticFailure}</p>
        ) : null}
        {data?.restartRequired ? (
          <div className="workspace-note runtime-update-restart">
            <Check />
            <span>
              Version {data.installedVersion} is installed. This Manager is still running {data.runningVersion}. Close
              it and run <code>threadnote manage</code> again to use the new version.
            </span>
          </div>
        ) : null}
        {data?.job || data?.automaticRunning ? (
          <div className="runtime-update-message" role={data.job?.status === 'failed' ? 'alert' : 'status'}>
            <strong>
              {data.job?.status === 'running'
                ? 'Updating Threadnote'
                : data.job?.status === 'failed'
                  ? 'Update needs attention'
                  : data.automaticRunning
                    ? 'Automatic update in progress'
                    : 'Update completed'}
            </strong>
            <p>{data.job?.message ?? 'The automatic updater is installing an eligible release.'}</p>
            {data.job?.status === 'running' ? (
              <p>You can continue using Manager. Keep this Manager process running until the update finishes.</p>
            ) : null}
            {data.job?.output ? (
              <details>
                <summary>Update details</summary>
                <pre>{data.job.output}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="workspace-card runtime-release-card">
        <header>
          <div className="runtime-release-heading">
            <ArrowDownToLine aria-hidden="true" />
            <h3>{data?.updateAvailable ? `Update to ${data.latestVersion}` : 'Available update'}</h3>
          </div>
          <button className="primary" disabled={disabled || !data?.updateAvailable} onClick={() => void act('update')}>
            <ArrowDownToLine aria-hidden="true" />
            {running ? 'Updating…' : 'Update Threadnote'}
          </button>
        </header>
        <div className="workspace-pad">
          {data?.updateAvailable ? (
            <p className="muted">What changes between your installed version and the latest release.</p>
          ) : (
            <p className="muted">
              {data?.developmentBuild
                ? 'Use the development installer to update this build.'
                : data?.checkError
                  ? 'Check again to find available updates.'
                  : data?.latestVersion
                    ? 'No newer release is available.'
                    : busy
                      ? 'Checking available releases…'
                      : 'Check for updates to find the latest release.'}
            </p>
          )}
          {data?.updateAvailable ? <ReleaseNotes notes={data.availableNotes} error={data.notesError} /> : null}
        </div>
      </section>
      <section className="workspace-card runtime-release-card">
        <header>
          <div className="runtime-release-heading">
            <BookOpen aria-hidden="true" />
            <h3>Installed release notes</h3>
          </div>
        </header>
        <div className="workspace-pad">
          {data ? (
            <ReleaseNotes notes={data.installedNotes} error={data.notesError} />
          ) : (
            <p className="muted">Loading release notes…</p>
          )}
        </div>
      </section>
    </div>
  );
}

function ReleaseNotes({
  notes,
  error,
}: {
  readonly notes: readonly RuntimeReleaseNotes[];
  readonly error?: string;
}): React.ReactElement {
  if (error)
    return (
      <p className="runtime-update-message" role="alert">
        Release notes are unavailable. {error}
      </p>
    );
  if (!notes.length) return <p className="muted">No published release notes were found for this version.</p>;
  return (
    <div className="runtime-release-notes">
      {[...notes].reverse().map((note, index) => (
        <details key={note.version} open={index === 0}>
          <summary>
            <span className="workspace-status neutral">v{note.version}</span>{' '}
            {note.title.replace(/^v/, '') === note.version ? 'Release notes' : note.title}
          </summary>
          <MarkdownViewer markdown={note.body} />
        </details>
      ))}
    </div>
  );
}
