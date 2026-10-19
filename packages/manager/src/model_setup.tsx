import React, {useSyncExternalStore} from 'react';
import {ArrowDownToLine, CircleAlert, Cpu} from 'lucide-react';
import {api} from './ui/support.js';
import type {ModelSetupAction, ModelSetupStatus} from './model_setup_contracts.js';

const endpoint = '/api/models/setup';
interface Snapshot {
  readonly status?: ModelSetupStatus;
  readonly error: string;
  readonly busy: boolean;
  readonly readyVersion: number;
}
const empty: Snapshot = {error: '', busy: false, readyVersion: 0};
let snapshot = empty;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let failures = 0;

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
function cancel(): void {
  clearTimeout(timer);
  timer = undefined;
  request?.abort();
  request = undefined;
}
function schedule(delay: number): void {
  clearTimeout(timer);
  if (listeners.size) timer = setTimeout(() => void load(), delay);
}
function accept(status: ModelSetupStatus): void {
  const readyVersion = snapshot.readyVersion + Number(status.artifactReady && !snapshot.status?.artifactReady);
  publish({status, error: '', busy: false, readyVersion});
}
function pollNext(): void {
  const status = snapshot.status;
  if (status && ['pending', 'downloading', 'verifying', 'retry-wait'].includes(status.phase)) {
    const delay =
      status.phase === 'retry-wait' ? Math.min(30_000, Math.max(1500, (status.nextAttemptAt ?? 0) - Date.now())) : 1500;
    schedule(delay);
  }
}
async function load(body?: ModelSetupAction): Promise<void> {
  cancel();
  if (!listeners.size) return;
  const controller = new AbortController();
  request = controller;
  if (body) publish({...snapshot, busy: true, error: ''});
  try {
    const status = await api<ModelSetupStatus>(endpoint, body ? {...body} : undefined, {
      signal: controller.signal,
      timeoutMilliseconds: 10_000,
    });
    if (controller.signal.aborted || request !== controller) return;
    failures = 0;
    accept(status);
    pollNext();
  } catch {
    if (controller.signal.aborted || request !== controller) return;
    publish({
      ...snapshot,
      busy: false,
      error: body
        ? 'Could not change model setup. Refreshing its current status…'
        : 'Model setup status is unavailable. Retrying…',
    });
    failures = Math.min(failures + 1, 6);
    schedule(Math.min(30_000, 1500 * 2 ** (failures - 1)));
  } finally {
    if (request === controller) request = undefined;
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void load();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      cancel();
      failures = 0;
      // Keep the readiness token across remounts, but never leave a cancelled action busy.
      snapshot = {...snapshot, busy: false};
    }
  };
}
const disabledSubscribe = () => () => {};
const read = () => snapshot;
const readEmpty = () => empty;
function action(value: {action: 'setup' | 'retry'} | {action: 'policy'; policy: 'automatic' | 'off'}): Promise<void> {
  if (!snapshot.status || snapshot.busy) return Promise.resolve();
  return load({...value, confirm: true, expectedEpoch: snapshot.status.intentEpoch});
}
const setup = () => action({action: 'setup'});
const retry = () => action({action: 'retry'});
const setPolicy = (policy: 'automatic' | 'off') => action({action: 'policy', policy});
const refresh = () => (snapshot.busy ? Promise.resolve() : load());

/** Every mounted surface shares one request, timer, readiness token and action fence. */
export function useModelSetup(enabled = true) {
  const value = useSyncExternalStore(enabled ? subscribe : disabledSubscribe, enabled ? read : readEmpty, readEmpty);
  return {...value, setup, retry, setPolicy, refresh};
}

function label(status?: ModelSetupStatus): string {
  if (!status) return 'Reading model setup…';
  if (status.environmentOff) return 'Automatic setup is managed off';
  if (status.policy === 'off' || status.phase === 'off') return 'Automatic setup is off';
  switch (status.phase) {
    case 'not-requested':
      return 'Local model is not set up';
    case 'pending':
      return 'Preparing local model';
    case 'downloading':
      return 'Downloading local model';
    case 'verifying':
      return 'Verifying local model';
    case 'ready':
      return status.artifactReady ? 'Local model is ready' : 'Local model needs verification';
    case 'retry-wait':
      return 'Setup will retry';
    case 'action-required':
      return 'Model setup needs attention';
  }
}
function size(bytes: number): string {
  return `${(Math.max(0, bytes) / 1_000_000_000).toFixed(2)} GB`;
}
function reason(status: ModelSetupStatus): string {
  switch (status.reason) {
    case 'insufficient-disk':
      return 'Free disk space, then retry setup.';
    case 'insufficient-memory':
      return 'This device does not have enough memory for this model.';
    case 'unsupported-platform':
      return 'This platform does not support automatic local model setup.';
    case 'environment-off':
      return 'Automatic setup is disabled by an environment setting.';
    case 'authentication-required':
      return 'The model download requires access. Check access before retrying.';
    case 'model-busy':
      return 'Another installation is using this model. Setup will try again.';
    case 'checksum-mismatch':
    case 'artifact-changed':
      return 'The model could not be verified. Retry to obtain verified files.';
    default:
      return 'Setup could not finish. Check connectivity and local storage, then retry.';
  }
}

export function ModelSetupPanel(): React.ReactElement {
  const {status, error, busy, setup, retry, setPolicy, refresh} = useModelSetup();
  const running = !!status && ['pending', 'downloading', 'verifying'].includes(status.phase);
  const disabled = busy || !status || status.environmentOff;
  return (
    <section className="workspace-card model-setup-card" aria-busy={busy}>
      <header>
        <div className="runtime-release-heading">
          <Cpu aria-hidden="true" />
          <h3>Local model setup</h3>
        </div>
        <span className={`workspace-status ${status?.phase === 'action-required' ? 'warn' : 'neutral'}`} role="status">
          {label(status)}
        </span>
      </header>
      <div className="workspace-row">
        <ArrowDownToLine aria-hidden="true" />
        <div className="row-copy">
          <strong>Automatic local model setup</strong>
          <p>Prepare Gemma for local generation in the background. Generation starts only when you choose it.</p>
          {status ? (
            <p>
              {status.modelId} · {size(status.totalBytes)} download
            </p>
          ) : null}
          {status?.environmentOff ? <p>Managed by an environment setting.</p> : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Automatic local model setup"
          aria-checked={status?.policy === 'automatic' && !status.environmentOff}
          className="runtime-update-switch"
          disabled={disabled}
          onClick={() => void setPolicy(status?.policy === 'automatic' ? 'off' : 'automatic')}
        >
          <span aria-hidden="true" />
          <span>{status?.policy === 'automatic' && !status.environmentOff ? 'On' : 'Off'}</span>
        </button>
      </div>
      <div className="workspace-pad">
        {status?.phase === 'downloading' ? (
          <div>
            <progress
              aria-label="Local model download"
              max={status.totalBytes || 1}
              value={Math.min(status.totalBytes, Math.max(0, status.bytes))}
            />
            <p className="muted">
              {size(status.bytes)} of {size(status.totalBytes)}
            </p>
          </div>
        ) : null}
        {status?.phase === 'verifying' ? (
          <p role="status">Checking the downloaded files before making the model available.</p>
        ) : null}
        {status?.artifactReady ? (
          <p className="muted">Model files are verified. The model loads when you explicitly generate.</p>
        ) : null}
        {status?.phase === 'retry-wait' ? (
          <p className="muted">
            {status.nextAttemptAt ? `Next attempt after ${new Date(status.nextAttemptAt).toLocaleString()}. ` : ''}You
            can retry now.
          </p>
        ) : null}
        {status?.reason ? (
          <details>
            <summary>Setup details</summary>
            <p className="muted">{reason(status)}</p>
          </details>
        ) : null}
        {error ? (
          <p className="runtime-update-message" role="alert">
            <CircleAlert aria-hidden="true" />
            {error}
          </p>
        ) : null}
        {error ? (
          <button disabled={busy} onClick={() => void refresh()}>
            Refresh status
          </button>
        ) : null}
        {!status?.artifactReady ? (
          <button
            className="primary"
            disabled={disabled || running || status?.policy === 'off'}
            onClick={() =>
              void (status?.phase === 'retry-wait' || status?.phase === 'action-required' ? retry() : setup())
            }
          >
            {busy
              ? 'Saving…'
              : running
                ? 'Setting up…'
                : status?.policy === 'off' || status?.environmentOff
                  ? 'Enable automatic setup to continue'
                  : status?.phase === 'retry-wait' || status?.phase === 'action-required'
                    ? 'Retry setup'
                    : 'Set up local model'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ModelSetupIndicator({enabled = true}: {readonly enabled?: boolean} = {}): React.ReactElement | null {
  const {status, error} = useModelSetup(enabled);
  if (!enabled) return null;
  return (
    <p className="model-setup-indicator muted" role="status">
      {error ? 'Local model setup status is unavailable.' : label(status)}
      {status?.phase === 'downloading' ? ` · ${size(status.bytes)} of ${size(status.totalBytes)}` : ''}
    </p>
  );
}
