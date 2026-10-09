import {PageActions} from './workspace.js';
import {Check, Circle, Cpu, GitBranch, Monitor, Plug, RefreshCw, ShieldCheck} from 'lucide-react';
import {DetailModal} from './detail_modal.js';
import React, {useEffect, useState} from 'react';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import {
  orderManagerProcessesByAttention,
  managerProcessIsActive,
  type ManageableManagerProcess,
  type ManagerProcessDiagnostics,
} from '@threadnote/manager/process/contracts';

const PROCESS_POLL_MILLISECONDS = 2_000;

export function ProcessesPanel(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [diagnostics, setDiagnostics] = useState<ManagerProcessDiagnostics>();
  const [loadError, setLoadError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [inspected, setInspected] = useState<ManageableManagerProcess>();
  const [terminating, setTerminating] = useState<string>();
  const displayedProcesses =
    diagnostics === undefined ? undefined : orderManagerProcessesForPresentation(diagnostics.processes);

  const load = async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await api<ManagerProcessDiagnostics>('/api/processes', undefined, {signal});
      setDiagnostics(next);
      setLoadError('');
    } catch (cause) {
      if (!signal?.aborted) setLoadError(errorMessage(cause));
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), PROCESS_POLL_MILLISECONDS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const terminate = async (process: ManageableManagerProcess): Promise<void> => {
    if (!process.terminable || process.processRef === undefined) return;
    const approved = await dialogs.confirm({
      confirmLabel: 'Terminate process',
      detail: `${processRoleLabel(process.role)} · PID ${process.processId}${process.currentOperation ? ` · ${process.currentOperation}` : ''}`,
      message: 'Threadnote will request a graceful stop and may force-stop this exact process instance if needed.',
      title: 'Terminate Threadnote process?',
      tone: 'danger',
    });
    if (!approved) return;
    setTerminating(process.processRef);
    setOperationError('');
    try {
      await api('/api/processes/terminate', {
        confirm: true,
        processId: process.processId,
        processRef: process.processRef,
      });
      await load();
    } catch (cause) {
      setOperationError(errorMessage(cause));
      await load();
    } finally {
      setTerminating(undefined);
    }
  };

  const row = (process: ManageableManagerProcess) => {
    const active = managerProcessIsActive(process);
    const current = process.terminationBlockedReason === 'current-manager';
    const unverified = process.terminationBlockedReason === 'identity-unverified';
    const Icon = active
      ? GitBranch
      : process.role === 'manager'
        ? Monitor
        : process.role === 'mcp' || process.role === 'mcp-broker'
          ? Plug
          : Cpu;
    return (
      <article className="workspace-row process-row" key={`${process.processId}:${process.startedAt}`} role="listitem">
        <Icon aria-hidden="true" />
        <div className="row-copy">
          <strong>
            {active && process.currentOperation
              ? operationLabel(process.currentOperation)
              : processRoleLabel(process.role)}
          </strong>
          <p>
            {current
              ? 'This session · Verified runtime'
              : `${processRoleLabel(process.role)}${process.activityRole ? ` · ${processRoleLabel(process.activityRole)} activity` : ''} · Started ${formatDuration(process.ageMilliseconds)} ago`}
          </p>
        </div>
        <span className={`workspace-status ${current ? '' : unverified ? 'warn' : 'neutral'}`}>
          {current ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
          {current
            ? 'Current'
            : unverified
              ? 'Unverified'
              : active
                ? 'Running'
                : process.role === 'legacy'
                  ? 'Legacy'
                  : 'Idle'}
        </span>
        <button
          aria-label={`Inspect ${processRoleLabel(process.role)} process ${process.processId}`}
          onClick={() => setInspected(process)}
        >
          {active ? 'Inspect' : 'Details'}
        </button>
        {process.terminable ? (
          <button
            aria-label={`Terminate ${processRoleLabel(process.role)} process ${process.processId}`}
            className="danger"
            disabled={terminating !== undefined}
            onClick={() => void terminate(process)}
            title={terminationTitle(process)}
          >
            {terminating === process.processRef ? 'Stopping…' : 'Stop…'}
          </button>
        ) : null}
      </article>
    );
  };
  return (
    <div className="process-workspace">
      <PageActions>
        <button aria-label="Refresh process list" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </button>
      </PageActions>
      <div className="workspace-note">
        <ShieldCheck aria-hidden="true" />
        Only registered Threadnote processes and identity-verified legacy runtimes appear here.
      </div>
      {loadError ? <p className="process-notice is-error">{loadError}</p> : null}
      {operationError ? (
        <p aria-live="polite" className="process-notice is-error">
          {operationError}
        </p>
      ) : null}
      {diagnostics?.truncated ? (
        <p className="process-notice">The bounded inventory is truncated. Refresh after other processes exit.</p>
      ) : null}
      <div className="workspace-stack" aria-label="Threadnote process inventory" role="list">
        {diagnostics === undefined ? (
          <p className="workspace-empty">Loading registered processes…</p>
        ) : (
          <>
            <section className="workspace-card">
              <header>
                <h3>Active operations</h3>
              </header>
              {displayedProcesses?.some(managerProcessIsActive) ? (
                displayedProcesses.filter(managerProcessIsActive).map(row)
              ) : (
                <p className="workspace-empty">No active background operations.</p>
              )}
            </section>
            <section className="workspace-card">
              <header>
                <h3>Other runtimes</h3>
              </header>
              {displayedProcesses?.some(process => !managerProcessIsActive(process)) ? (
                displayedProcesses.filter(process => !managerProcessIsActive(process)).map(row)
              ) : (
                <p className="workspace-empty">No other runtimes are registered.</p>
              )}
            </section>
          </>
        )}
      </div>
      {inspected ? (
        <DetailModal title={processRoleLabel(inspected.role)} onClose={() => setInspected(undefined)}>
          <p className="workspace-note">
            <ShieldCheck />
            {inspected.terminationBlockedReason === 'identity-unverified'
              ? 'The process identity could not be verified. Stop it from its owning application.'
              : 'Verified Threadnote runtime. Private arguments and environment variables stay hidden.'}
          </p>
          <dl className="process-detail-grid">
            <div>
              <dt>Process</dt>
              <dd>PID {inspected.processId}</dd>
            </div>
            <div>
              <dt>Parent</dt>
              <dd>{parentLabel(inspected)}</dd>
            </div>
            <div>
              <dt>Operation</dt>
              <dd>{inspected.currentOperation ? operationLabel(inspected.currentOperation) : 'Idle'}</dd>
            </div>
            <div>
              <dt>Running</dt>
              <dd>{formatDuration(inspected.ageMilliseconds)}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>{inspected.rssBytes === undefined ? 'Unavailable' : formatBytes(inspected.rssBytes)}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{inspected.releaseVersion ? `v${inspected.releaseVersion}` : 'Current runtime'}</dd>
            </div>
          </dl>
          {!inspected.terminable ? <p className="muted">{terminationTitle(inspected)}</p> : null}
        </DetailModal>
      ) : null}
    </div>
  );
}

export function orderManagerProcessesForPresentation(
  processes: readonly ManageableManagerProcess[],
): readonly ManageableManagerProcess[] {
  return orderManagerProcessesByAttention(processes);
}

function processRoleLabel(role: ManageableManagerProcess['role']): string {
  switch (role) {
    case 'cli':
      return 'CLI';
    case 'graph-builder':
      return 'Graph builder';
    case 'graph-compaction-worker':
      return 'Graph compaction worker';
    case 'graph-diagnostics-worker':
      return 'Graph diagnostics worker';
    case 'graph-parser-worker':
      return 'Graph parser worker';
    case 'graph-query-worker':
      return 'Graph query worker';
    case 'graph-waiter':
      return 'Graph waiter';
    case 'integration-sync-worker':
      return 'Integration sync worker';
    case 'legacy':
      return 'Legacy runtime';
    case 'local-model-worker':
      return 'Local model worker';
    case 'manager':
      return 'Manager';
    case 'mcp':
      return 'MCP server';
    case 'mcp-broker':
      return 'MCP session broker';
  }
}

function operationLabel(operation: string): string {
  return operation
    .split('-')
    .filter(Boolean)
    .map((part, index) => (index === 0 ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
}

function parentLabel(process: ManageableManagerProcess): string {
  if (process.parentProcessId === 0) return 'Unavailable';
  return process.parentRole
    ? `${processRoleLabel(process.parentRole)} · PID ${process.parentProcessId}`
    : `PID ${process.parentProcessId}`;
}

function terminationTitle(process: ManageableManagerProcess): string {
  if (process.terminable) return `Terminate ${processRoleLabel(process.role)}`;
  switch (process.terminationBlockedReason) {
    case 'current-manager':
      return 'The current Manager process is protected';
    case 'identity-unverified':
      return 'Process identity could not be verified';
    case 'legacy-process':
      return 'Restart the owning client to stop this legacy process safely';
    default:
      return 'This process cannot be terminated from Manager';
  }
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}
