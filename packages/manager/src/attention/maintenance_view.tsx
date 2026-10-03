import {Schema} from 'effect';
import React, {useEffect, useRef, useState} from 'react';
import type {ManagerContextHealthResponseV1, ManagerContextMaintenanceStatusV2} from './contracts.js';
import {
  groupMaintenanceCauses,
  healthDecisionGroups,
  healthDecisionTask,
  maintenanceRecoveryInstruction,
  maintenanceStatusLabel,
  maintenanceUndoConflictMessage,
} from './maintenance.js';
import {HealthDetail} from '../attention_details.js';
import {api, errorMessage, ManagerApiError} from '../ui/support.js';

interface Props {
  readonly project: string;
  readonly projects: readonly string[];
  readonly report: ManagerContextHealthResponseV1;
  readonly onProjectChange: (project: string) => void;
  readonly onOpenLibrary: (uri?: string) => void;
  readonly onChanged: () => void;
  readonly nextCursor?: string;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly reportError?: string;
  readonly onRefresh?: () => void;
}

export function ContextMaintenanceView(props: Props): React.ReactElement {
  const [snapshot, setSnapshot] = useState<{project: string; status: ManagerContextMaintenanceStatusV2}>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflictSubjectUri, setConflictSubjectUri] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<ManagerContextHealthResponseV1['findings'][number]>();
  const [task, setTask] = useState('');
  const activeProject = useRef(props.project);
  const projectEpoch = useRef(0);
  if (activeProject.current !== props.project) {
    projectEpoch.current += 1;
    activeProject.current = props.project;
  }
  const mounted = useRef(true);
  const mutationEpoch = useRef(0);
  const actionBusy = useRef(false);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;
  const lastGeneration = useRef<string | undefined>(undefined);
  const status = snapshot?.project === props.project ? snapshot.status : undefined;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setNotice('');
    setConflictSubjectUri(undefined);
    setSelected(undefined);
    setTask('');
  }, [props.project]);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setError('');
    setBusy(false);
    actionBusy.current = false;
    lastGeneration.current = undefined;
    const poll = async () => {
      const epoch = mutationEpoch.current;
      if (actionBusy.current) {
        timer = window.setTimeout(() => void poll(), 1_000);
        return;
      }
      try {
        const result = await api<ManagerContextMaintenanceStatusV2>(
          `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}`,
        );
        if (cancelled || mutationEpoch.current !== epoch) return;
        if (result.version !== 2)
          throw new Error('Maintenance status is unavailable. Refresh after updating Threadnote.');
        setSnapshot({project: props.project, status: result});
        setError('');
        if (lastGeneration.current !== undefined && lastGeneration.current !== result.generation) onChanged.current();
        lastGeneration.current = result.generation;
        if (!result.paused && result.state !== 'failed')
          timer = window.setTimeout(() => void poll(), result.state === 'running' ? 1_000 : 30_000);
      } catch (cause) {
        if (!cancelled && mutationEpoch.current === epoch) setError(errorMessage(cause));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.project, refresh]);

  async function act(action: 'run-now' | 'pause' | 'resume' | 'undo', receiptId?: string) {
    if (actionBusy.current) return;
    const project = props.project;
    const epoch = projectEpoch.current;
    mutationEpoch.current += 1;
    actionBusy.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setConflictSubjectUri(undefined);
    try {
      const result = await api<
        ManagerContextMaintenanceStatusV2 | {status: 'undone' | 'already-undone' | 'conflict'; reason?: string}
      >('/api/attention/context-maintenance', {project, action, ...(receiptId ? {receiptId} : {})});
      if (!mounted.current || activeProject.current !== project || projectEpoch.current !== epoch) return;
      if ('version' in result) {
        setSnapshot({project, status: result});
        if (action === 'run-now') onChanged.current();
        if (action === 'resume' || action === 'run-now') setRefresh(value => value + 1);
      } else if (result.status === 'conflict') {
        setError(maintenanceUndoConflictMessage(result.reason));
        setConflictSubjectUri(status?.receipts.find(item => item.receiptId === receiptId)?.subjectUri);
      } else {
        setNotice(
          result.status === 'already-undone'
            ? 'This change was already undone.'
            : 'Change undone after checking the current memory.',
        );
        setRefresh(value => value + 1);
        onChanged.current();
      }
    } catch (cause) {
      if (mounted.current && activeProject.current === project && projectEpoch.current === epoch) {
        if (action === 'undo' && Schema.is(ManagerApiError)(cause) && cause.status === 409) {
          setError(maintenanceUndoConflictMessage(cause.message));
          setConflictSubjectUri(status?.receipts.find(item => item.receiptId === receiptId)?.subjectUri);
        } else setError(errorMessage(cause));
      }
    } finally {
      if (mounted.current && activeProject.current === project && projectEpoch.current === epoch) {
        setBusy(false);
        actionBusy.current = false;
      }
    }
  }

  const summary = props.report.maintenance;
  const groups = healthDecisionGroups(props.report);
  const decisionCount = Math.max(
    summary?.affectedMemories ?? 0,
    status?.counts?.decisionMemories ?? 0,
    groups.length,
    new Set(
      status?.cases
        .filter(item => item.project === props.project && item.disposition === 'needs-decision')
        .map(item => item.memoryId) ?? [],
    ).size,
  );
  const citation = summary?.citationCoverage;
  const semantic = summary?.semanticCoverage ?? props.report.semanticCompleteness;
  const coverage =
    citation?.state === 'complete' && semantic.state === 'complete'
      ? 'complete'
      : citation?.state === 'unavailable' && semantic.state === 'unavailable'
        ? 'unavailable'
        : 'partial';
  const projectProgress = status?.projects.find(item => item.project === props.project);
  const causes =
    status?.groups === undefined
      ? groupMaintenanceCauses((status?.cases ?? []).filter(item => item.project === props.project))
      : status.groups
          .filter(
            item =>
              item.project === props.project &&
              ['queued', 'repairing', 'waiting-evidence', 'deferred-policy'].includes(item.disposition),
          )
          .map(item => ({
            key: item.causeKey,
            reason: item.reason,
            repositoryId: item.repositoryId,
            count: item.affectedMemories,
            nextAttemptAt: item.nextAttemptAt,
          }));
  const receipts = (status?.receipts ?? []).filter(item => item.project === props.project);
  const cases = (status?.cases ?? []).filter(item => item.project === props.project);
  const dispositionCount = (disposition: string) =>
    status?.counts?.[disposition] ?? cases.filter(item => item.disposition === disposition).length;
  const representedCases = new Set(props.report.findings.map(finding => finding.caseId));
  const unloadedDecisions = cases.filter(
    item => item.disposition === 'needs-decision' && !representedCases.has(item.caseId),
  );
  return (
    <section aria-busy={busy} className="panel attention-panel is-active">
      <header className="attention-header">
        <div>
          <p className="eyebrow">Living context</p>
          <h2>Context health</h2>
          <p role="status" aria-live="polite">
            {maintenanceStatusLabel({
              decisions: decisionCount,
              coverage,
              paused: status?.paused ?? false,
              state: status?.state,
            })}
          </p>
        </div>
        <label>
          Project
          <select
            aria-label="Context health project"
            value={props.project}
            onChange={event => props.onProjectChange(event.target.value)}
          >
            {props.projects.map(project => (
              <option key={project}>{project}</option>
            ))}
          </select>
        </label>
      </header>
      <div className="attention-metrics">
        <Metric
          label="Needs your decision"
          value={`${decisionCount.toLocaleString()} ${decisionCount === 1 ? 'memory' : 'memories'}`}
        />
        <Metric label="Automatic work" value={(summary?.automaticallyManagedFindings ?? 0).toLocaleString()} />
        <Metric label="Evidence coverage" value={coverage} />
        <Metric
          label="Historical items"
          value={((summary?.historicalFindings ?? 0) + (citation?.historicalVerified ?? 0)).toLocaleString()}
        />
      </div>
      <section className="attention-bulk-repair" aria-label="Maintenance controls">
        <div>
          <strong>Automatic maintenance</strong>
          <p>Safe local work runs during normal use. Pausing applies to all projects.</p>
        </div>
        <div className="attention-bulk-repair-actions">
          <button
            type="button"
            disabled={busy || !status || status.paused || status.state === 'running'}
            onClick={() => void act('run-now')}
          >
            {busy ? 'Working…' : 'Run maintenance now'}
          </button>
          <button
            type="button"
            disabled={busy || !status}
            onClick={() => void act(status?.paused ? 'resume' : 'pause')}
          >
            {status?.paused ? 'Resume automatic maintenance' : 'Pause automatic maintenance'}
          </button>
        </div>
      </section>
      {props.reportError ? (
        <p role="alert">
          Evidence page changed or could not refresh: {props.reportError}{' '}
          <button type="button" onClick={props.onRefresh}>
            Refresh evidence from the first page
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>
            Refresh maintenance status
          </button>
        </p>
      ) : null}
      {conflictSubjectUri ? (
        <button type="button" onClick={() => props.onOpenLibrary(conflictSubjectUri)}>
          Inspect current memory
        </button>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {status?.error ? (
        <p role="alert">
          Maintenance stopped: {status.error.reason}. Progress is preserved; inspect the diagnostic before resuming.
        </p>
      ) : null}
      <section aria-label="Evidence coverage" className="attention-card">
        <h3>Evidence coverage</h3>
        <p>
          {citation?.checked.toLocaleString() ?? '0'} of {citation?.eligible.toLocaleString() ?? '0'} citations checked
          against current evidence; {citation?.deferred.toLocaleString() ?? '0'} await evidence checks.
        </p>
        {citation && citation.eligible > 0 ? (
          <progress aria-label="Current citation evidence coverage" value={citation.checked} max={citation.eligible} />
        ) : null}
        <p>
          {semantic.analyzedRecords?.toLocaleString() ?? '0'} of {semantic.eligibleRecords?.toLocaleString() ?? '0'}{' '}
          durable memories fully analyzed; {semantic.unknownRecords?.toLocaleString() ?? '0'} durable memories remain
          outside the completed heuristic checks. Partial coverage is not a content defect.
        </p>
        {props.report.repositoryEvidence.state === 'unavailable' ? (
          <p>
            Current repository evidence is unavailable. Memory and relation checks remain useful; local evidence
            recovery continues when a verified source becomes available.
          </p>
        ) : null}
        {citation && citation.historicalVerified > 0 ? (
          <p>
            {citation.historicalVerified} anchors have verified historical provenance. They do not verify today’s
            source.
          </p>
        ) : null}
        <details>
          <summary>Coverage details and scan progress</summary>
          <p>
            {props.report.recordsScanned.toLocaleString()} records scanned.{' '}
            {projectProgress
              ? `${projectProgress.checked} of ${projectProgress.eligible} maintenance tasks checked.`
              : 'No completed maintenance checkpoint yet.'}
          </p>
          {citation?.reasons.map(reason => (
            <p key={reason.reason}>
              {reason.count} — {reason.reason.replaceAll('-', ' ')}. {maintenanceRecoveryInstruction(reason.reason)}
            </p>
          ))}
          {semantic.unknownReasons?.map(reason => (
            <p key={reason.reason}>
              {reason.count} semantic checks: {reason.reason.replaceAll('-', ' ')}.
            </p>
          ))}
        </details>
      </section>
      <section aria-label="Needs your decision" className="attention-list health-record-list">
        <h3>Needs your decision</h3>
        {groups.length === 0 && unloadedDecisions.length === 0 ? (
          <p>No supported decisions are waiting in the loaded context. Evidence coverage remains visible above.</p>
        ) : null}
        {groups.map(group => (
          <article key={group.uri} className="attention-card health-record">
            <header>
              <div>
                <h3>{group.preview?.title ?? 'Memory needing a decision'}</h3>
                <p>{group.preview?.excerpt ?? 'Open the memory to read the claim before deciding.'}</p>
              </div>
              <span className="attention-count">{group.findings.length} supporting checks</span>
            </header>
            <button type="button" onClick={() => props.onOpenLibrary(group.uri)}>
              Open memory
            </button>
            {group.preview?.code.map(code => (
              <section className="health-code-preview" key={code.citationId}>
                <h4>{code.targetLabel ?? code.path}</h4>
                <p>
                  {code.path}
                  {code.line ? `:${code.line}` : ''}
                </p>
                {code.excerpt ? (
                  <pre>{code.excerpt}</pre>
                ) : (
                  <p>Current source is unavailable; historical evidence cannot discharge this claim.</p>
                )}
              </section>
            ))}
            {group.findings.map(finding => (
              <section key={finding.caseId ?? finding.id} className="health-finding">
                <h4>{finding.category.replaceAll('-', ' ')}</h4>
                <p>{finding.summary}</p>
                <p>
                  {finding.confidence} confidence · {finding.repairability.replaceAll('-', ' ')}. The engine stopped
                  because this requires a supported content or authority decision.
                </p>
                <button type="button" onClick={() => setSelected(finding)}>
                  Compare evidence and preview change
                </button>
              </section>
            ))}
            <p>
              Choose a supported claim, preserve this memory as historical, or archive obsolete advice after reviewing
              its evidence.
            </p>
            <div className="health-record-actions">
              <button
                type="button"
                onClick={() =>
                  setTask(healthDecisionTask(props.project, group.findings, 'Determine the supported current claim'))
                }
              >
                Prepare claim review task
              </button>
              <button
                type="button"
                onClick={() =>
                  setTask(
                    healthDecisionTask(
                      props.project,
                      group.findings,
                      'Review whether the memory should be historical or archived',
                    ),
                  )
                }
              >
                Prepare historical or archive decision
              </button>
            </div>
          </article>
        ))}
        {unloadedDecisions.map(item => (
          <article className="attention-card" key={item.caseId}>
            <h4>{item.reason.replaceAll('-', ' ')}</h4>
            <p>{maintenanceRecoveryInstruction(item.reason)}</p>
            <button
              type="button"
              onClick={() =>
                setTask(
                  `Use $threadnote-health for project ${JSON.stringify(props.project)} and exact case ${JSON.stringify(item.caseId)}. Read its fresh decision packet, inspect current and historical evidence, and return supported choices. Do not repeat unchanged work or mutate shared knowledge without reviewed authority.`,
                )
              }
            >
              Prepare scoped decision task
            </button>
          </article>
        ))}
        {props.nextCursor ? (
          <button type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>
            {props.loadingMore ? 'Loading decision details…' : 'Load more decision details'}
          </button>
        ) : null}
      </section>
      {task ? (
        <section className="attention-card" aria-label="Task for threadnote-health">
          <h3>Task for threadnote-health</h3>
          <p>Copy this task into your coding agent to compare the claim and review an exact change.</p>
          <textarea
            aria-label="Scoped health decision task"
            readOnly
            value={task}
            rows={6}
            onFocus={event => event.target.select()}
          />
        </section>
      ) : null}
      <section aria-label="Automatic recovery" className="attention-list">
        <h3>Automatic recovery</h3>
        {causes.length === 0 ? (
          <p>No blocked recovery groups are reported. Queued evidence checks are tracked in coverage.</p>
        ) : (
          causes.map(group => (
            <article key={group.key} className="attention-card">
              <h4>{group.reason.replaceAll('-', ' ')}</h4>
              <p>
                {group.count} {status?.groups === undefined ? 'affected anchors or checks' : 'affected memories'}
                {group.repositoryId ? ' in one repository' : ''}.
              </p>
              <p>{maintenanceRecoveryInstruction(group.reason)}</p>
              {group.nextAttemptAt ? (
                <p>Next eligible check: {new Date(group.nextAttemptAt).toLocaleString()}.</p>
              ) : (
                <p>Waiting for new evidence; repeated unchanged retries are stopped.</p>
              )}
              <details>
                <summary>Recovery evidence</summary>
                {group.repositoryId ? <code>{group.repositoryId}</code> : null}
                <p>{group.key}</p>
              </details>
            </article>
          ))
        )}
      </section>
      <section aria-label="Recent maintenance and history" className="attention-list">
        <h3>Recent maintenance and history</h3>
        <p>
          Last progress:{' '}
          {status?.lastProgressAt
            ? new Date(status.lastProgressAt).toLocaleString()
            : 'No completed check recorded yet'}
          .
        </p>
        <p>
          {dispositionCount('resolved')} resolved · {dispositionCount('retired')} retired ·{' '}
          {dispositionCount('historical')} historical · {dispositionCount('waiting-evidence')} waiting for evidence ·{' '}
          {dispositionCount('needs-decision')} decision cases.
        </p>
        {(status?.omittedCases ?? 0) > 0 ? (
          <p>
            {status!.omittedCases} additional case details are outside this bounded view. Totals include those cases.
          </p>
        ) : null}
        {receipts.map(receipt => (
          <article key={receipt.receiptId} className="attention-card">
            <p>
              {receipt.state === 'applied'
                ? 'Safe local structural change applied'
                : receipt.state.replaceAll('-', ' ')}{' '}
              · {new Date(receipt.timestamp).toLocaleString()}
            </p>
            <button type="button" onClick={() => props.onOpenLibrary(receipt.subjectUri)}>
              Inspect changed memory
            </button>
            {receipt.state === 'applied' ? (
              <button type="button" disabled={busy} onClick={() => void act('undo', receipt.receiptId)}>
                Undo this change
              </button>
            ) : null}
          </article>
        ))}
        <details>
          <summary>Bounded maintenance diagnostics</summary>
          <p>Evidence generation: {projectProgress?.generation ?? status?.generation ?? 'unavailable'}.</p>
          {cases.slice(0, 50).map(item => (
            <p key={item.caseId}>
              {item.disposition.replaceAll('-', ' ')}: {item.reason.replaceAll('-', ' ')} · {item.attemptCount} attempts
              · last checked {item.lastChecked}
            </p>
          ))}
        </details>
      </section>
      {selected ? (
        <HealthDetail
          key={`${props.project}:${selected.caseId ?? selected.id}`}
          project={props.project}
          finding={selected}
          repairsAvailable={props.report.repositoryEvidence.state === 'available'}
          onClose={() => setSelected(undefined)}
          onChanged={props.onChanged}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : null}
    </section>
  );
}

function Metric(props: {readonly label: string; readonly value: string}) {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
