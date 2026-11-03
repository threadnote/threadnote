import {Array as EffectArray} from 'effect';
import {PageActions} from './workspace.js';
import {Check, Circle, Cpu, GitBranch, Monitor, Plug, RefreshCw, ShieldCheck} from 'lucide-react';
import React, {useState} from 'react';
import {useManagerProcesses} from './process/live.js';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import {
  orderManagerProcessesByAttention,
  managerProcessIsActive,
  recallEmbeddingProgressLabel,
  type ManageableManagerProcess,
} from '@threadnote/manager/process/contracts';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {pipe as effectPipe} from 'effect';

export function ProcessesPanel(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const {diagnostics, loadError, load} = useManagerProcesses();
  const [operationError, setOperationError] = useState('');
  const [terminating, setTerminating] = useState<string>();
  const displayedProcesses =
    diagnostics === undefined ? undefined : orderManagerProcessesForPresentation(diagnostics.processes);

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
            {active && process.currentOperation ? processOperationLabel(process) : processRoleLabel(process.role)}
          </strong>
          <p>
            {current
              ? 'This session · Verified runtime'
              : `${processRoleLabel(process.role)}${process.activityRole ? ` · ${processRoleLabel(process.activityRole)} activity` : ''} · Started ${formatDuration(process.ageMilliseconds)} ago`}
          </p>
          {process.embeddingProgress ? <p>{recallEmbeddingProgressLabel(process.embeddingProgress)}</p> : null}
          <ProcessMetadata process={process} />
          {!process.terminable ? <p className="process-stop-reason">{terminationTitle(process)}</p> : null}
        </div>
        <div className="process-row-actions">
          <span
            className={`workspace-status process-status-${active ? 'running' : process.role === 'legacy' ? 'legacy' : 'idle'}`}
          >
            <Circle aria-hidden="true" />
            {active ? 'Running' : process.role === 'legacy' ? 'Legacy' : 'Idle'}
          </span>
          {current ? (
            <span className="workspace-status neutral process-identity-current">
              <Check aria-hidden="true" />
              Current
            </span>
          ) : null}
          {unverified ? <span className="workspace-status warn">Unverified</span> : null}
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
        </div>
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
              {displayedProcesses !== undefined &&
              EffectArray.some(displayedProcesses, (process): boolean => managerProcessIsActive(process)) ? (
                EffectArray.map(
                  EffectArray.filter(
                    displayedProcesses,
                    (__effectFilterValue: (typeof displayedProcesses)[number], __effectFilterIndex: number) =>
                      __effectFilterIndex in displayedProcesses && managerProcessIsActive(__effectFilterValue),
                  ),
                  row,
                )
              ) : (
                <p className="workspace-empty">No active background operations.</p>
              )}
            </section>
            <section className="workspace-card">
              <header>
                <h3>Other runtimes</h3>
              </header>
              {displayedProcesses !== undefined &&
              EffectArray.some(displayedProcesses, process => !managerProcessIsActive(process)) ? (
                EffectArray.map(
                  EffectArray.filter(displayedProcesses, process => !managerProcessIsActive(process)),
                  row,
                )
              ) : (
                <p className="workspace-empty">No other runtimes are registered.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function ProcessMetadata({process}: {readonly process: ManageableManagerProcess}): React.ReactElement {
  const context = process.displayContext;
  const workspace = context?.workspace;
  const branch = context?.branch;
  const client = context?.client;
  const cpu = process.cpu;
  const detail = (name: string, value: React.ReactNode, title?: string) => (
    <div>
      <dt>{name}</dt>
      <dd title={title}>{value}</dd>
    </div>
  );
  return (
    <dl className="process-lane-metadata">
      {detail(
        'CPU',
        cpu?.state === 'sampled'
          ? `${cpu.percent.toFixed(1)}%`
          : cpu?.state === 'sampling'
            ? 'Sampling…'
            : 'Unavailable',
        cpu
          ? `Recent CPU · 100% = one logical core · ${cpu.state === 'sampled' ? `${(cpu.windowMilliseconds / 1000).toFixed(1)}s window · ` : ''}Sample ${cpu.sampledAt}`
          : undefined,
      )}
      {detail('Memory', process.rssBytes === undefined ? 'Unavailable' : formatBytes(process.rssBytes))}
      {detail('Process', `PID ${process.processId}`)}
      {detail('Parent', parentLabel(process))}
      {detail('Age', formatDuration(process.ageMilliseconds))}
      {detail('Version', process.releaseVersion ? `v${process.releaseVersion}` : 'Unavailable')}
      {detail('Operation', process.currentOperation ? processOperationLabel(process) : 'Idle')}
      <div className="process-lane-path">
        <dt>Worktree</dt>
        <dd>
          {workspace?.state === 'multiple'
            ? 'Multiple workspaces'
            : (workspace?.path ?? context?.launchDirectory ?? 'Unavailable')}
          <small>
            {workspace
              ? `${workspace.state === 'active' ? 'Active workspace' : workspace.state === 'last' ? 'Last workspace' : 'Concurrent calls'} · ${workspace.observedAt}`
              : context?.launchDirectory
                ? 'Launch directory'
                : 'No workspace reported'}
          </small>
        </dd>
      </div>
      {detail(
        'Branch',
        branch?.state === 'branch'
          ? branch.name
          : branch?.state === 'detached'
            ? `Detached · ${branch.commit}`
            : workspace?.state === 'multiple'
              ? 'Multiple workspaces'
              : 'Unavailable',
      )}
      {workspace && context?.launchDirectory ? (
        <div className="process-lane-path">
          <dt>Launch directory</dt>
          <dd>{context.launchDirectory}</dd>
        </div>
      ) : null}
      {client || process.role === 'mcp' || process.role === 'mcp-broker' || context?.owner
        ? detail(
            'MCP client',
            client ? `${client.name}${client.version ? ` v${client.version}` : ''}` : 'Not provided by client',
            'Client-reported name and version',
          )
        : null}
      {context?.owner
        ? detail('Context owner', `${processRoleLabel(context.owner.role)} · PID ${context.owner.processId}`)
        : null}
      {process.role === 'mcp' || process.role === 'mcp-broker' || client
        ? detail('Chat title', 'Not provided by client')
        : null}
    </dl>
  );
}

function processOperationLabel(process: ManageableManagerProcess): string {
  if (process.role === 'local-model-worker' && process.currentOperation === 'unknown')
    return 'Local inference · activity unavailable';
  return operationLabel(process.currentOperation ?? 'idle');
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
    case 'graph-embedding-worker':
      return 'Graph embedding worker';
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
  const labels: Readonly<Record<string, string>> = {
    'embed-many': 'Embedding documents',
    'embed-many-idle': 'Embedding documents in background',
    'embed-many-capacity': 'Embedding documents with spare capacity',
    'generate-text': 'Generating text',
    'rerank-results': 'Reranking results',
    'check-local-model': 'Checking local model',
    'local-inference': 'Local inference',
  };
  if (labels[operation]) return labels[operation];
  return EffectArray.join(
    EffectArray.map(
      effectPipe(operation, EffectString.split('-'), values =>
        EffectArray.filter(values, (value, index) => index in values && Boolean(value)),
      ),
      (part, index) =>
        index === 0
          ? `${Effect.pipe(part, EffectString.slice(0, 1), EffectString.toUpperCase)}${Effect.pipe(part, EffectString.slice(1))}`
          : part,
    ),
    ' ',
  );
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
