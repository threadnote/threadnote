import {isManagerContextMaintenanceResult, isManagerContextMaintenanceStatusV2} from '../api/response_guards.js';
import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ShieldCheck} from 'lucide-react';
import {WorkspaceUtilities} from '../workspace_utilities.js';
import {Schema} from 'effect';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {
  ManagerContextHealthResponseV1,
  ManagerContextMaintenanceStatusV2,
  ManagerContextMaintenanceCaseV2,
} from './contracts.js';
import type {ManagerTopicReviewAppliedV1} from './topic_contracts.js';
import {
  automaticReviewMaintenanceReceipts,
  groupMaintenanceCauses,
  healthDecisionGroups,
  healthDecisionTask,
  maintenanceDecisionExplanation,
  maintenanceDecisionLabel,
  maintenanceMemoryTitle,
  maintenanceRecoveryInstruction,
  maintenanceStatusLabel,
  maintenanceUndoConflictMessage,
  mergeMaintenanceStatusPage,
  reconcileAppliedMaintenanceCases,
  reconcileAppliedHealthReport,
} from './maintenance.js';
import {HealthDetail} from '../attention_details.js';
import {MemoryExcerpt, ReviewBadge} from '../review_presentation.js';
import {MaintenanceCaseDialog, MaintenanceTaskDialog} from './maintenance_dialogs.js';
import {api, errorMessage, ManagerApiError} from '../ui/support.js';
import {AutomaticMemoryPanel} from './automatic_memory.js';
import {useManagerLiveResource} from '../live/provider.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface Props {
  readonly controlGeneration?: number;
  readonly project: string;
  readonly projects: readonly string[];
  readonly report: ManagerContextHealthResponseV1;
  readonly onProjectChange: (project: string) => void;
  readonly onOpenLibrary: (uri?: string) => void;
  readonly onChanged: () => void;
  readonly onDecisionCountChange?: (project: string, count: number | undefined) => void;
  readonly nextCursor?: string;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly reportError?: string;
  readonly onRefresh?: () => void;
  readonly healthLiveStale?: boolean;
  readonly healthLegacy?: boolean;
  readonly healthFallback?: boolean;
}

export function ContextMaintenanceView(props: Props): React.ReactElement {
  const readStatus = useCallback(
    (signal: AbortSignal) =>
      api<ManagerContextMaintenanceStatusV2>(
        `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}`,
        undefined,
        {signal, timeoutMilliseconds: 10_000},
        isManagerContextMaintenanceStatusV2,
      ),
    [props.project],
  );
  const live = useManagerLiveResource(
    'context-maintenance',
    props.project,
    readStatus,
    isManagerContextMaintenanceStatusV2,
  );
  const legacyStatus = !live.active || live.snapshot.status === 'unsupported';
  const [tab, setTab] = useState<'decisions' | 'recovery' | 'history' | 'hygiene'>('decisions');
  const [snapshot, setSnapshot] = useState<{
    project: string;
    status: ManagerContextMaintenanceStatusV2;
  }>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [blockedProject, setBlockedProject] = useState<string>();
  const [legacyStatusFreshProject, setLegacyStatusFreshProject] = useState<string>();
  const [notice, setNotice] = useState('');
  const [automatic, setAutomatic] = useState<{project: string; ready: number; pending: boolean}>();
  const [conflictSubjectUri, setConflictSubjectUri] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lastControlGeneration = useRef(props.controlGeneration);
  useEffect(() => {
    if (lastControlGeneration.current === props.controlGeneration) return;
    lastControlGeneration.current = props.controlGeneration;
    setRefresh(value => value + 1);
  }, [props.controlGeneration]);
  const [selected, setSelected] = useState<ManagerContextHealthResponseV1['findings'][number]>();
  const [task, setTask] = useState('');
  const [inspectedCase, setInspectedCase] = useState<{
    caseId: string;
    memoryUri?: string;
    title?: string;
    evidenceRevision?: string;
  }>();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [appliedCases, setAppliedCases] = useState<readonly ManagerTopicReviewAppliedV1[]>([]);
  const automaticObservation = useRef<
    | {
        project: string;
        reviewId: string;
        cases: readonly ManagerContextMaintenanceCaseV2[];
        report: ManagerContextHealthResponseV1;
      }
    | undefined
  >(undefined);
  const activeProject = useRef(props.project);
  const projectEpoch = useRef(0);
  if (activeProject.current !== props.project) {
    projectEpoch.current += 1;
    activeProject.current = props.project;
  }
  const mounted = useRef(true);
  const mutationEpoch = useRef(0);
  const lastLiveRefresh = useRef({project: props.project, refresh});
  const actionBusy = useRef(false);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;
  const lastReportRevision = useRef<string | undefined>(undefined);
  const status =
    snapshot?.project === props.project ? reconcileAppliedMaintenanceCases(snapshot.status, appliedCases) : undefined;
  const report = reconcileAppliedHealthReport(props.report, appliedCases, status);
  const statusUnconfirmed =
    checking ||
    !!error ||
    (live.active && live.snapshot.status !== 'ready' && !(legacyStatus && legacyStatusFreshProject === props.project));
  function redactProjectEvidence(project: string) {
    setBlockedProject(project);
    setSnapshot(undefined);
    setSelected(undefined);
    setInspectedCase(undefined);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setBusy(false);
    actionBusy.current = false;
    setNotice('');
    setConflictSubjectUri(undefined);
    setSelected(undefined);
    setTask('');
    setInspectedCase(undefined);
    setLoadingHistory(false);
    setError('');
  }, [props.project]);
  useEffect(() => {
    setLegacyStatusFreshProject(undefined);
  }, [legacyStatus, props.project]);
  useEffect(() => {
    if (!legacyStatus) return;
    let cancelled = false;
    let timer: number | undefined;
    lastReportRevision.current = undefined;
    const poll = async () => {
      const epoch = mutationEpoch.current;
      if (actionBusy.current) {
        timer = window.setTimeout(() => void poll(), 1_000);
        return;
      }
      setChecking(true);
      setLegacyStatusFreshProject(undefined);
      try {
        const result = await api<ManagerContextMaintenanceStatusV2>(
          `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}`,
          undefined,
          undefined,
          isManagerContextMaintenanceStatusV2,
        );
        if (cancelled || mutationEpoch.current !== epoch) return;
        if (!validMaintenanceStatus(result))
          throw ManagerApiError.of('Maintenance status is unavailable. Refresh after updating Threadnote.', 409);
        setBlockedProject(undefined);
        setSnapshot(previous => {
          const old = previous?.project === props.project ? previous.status : undefined;
          return {
            project: props.project,
            status:
              old !== undefined && old.page !== undefined && old.page.generation === result.page?.generation
                ? {
                    ...result,
                    cases: old.cases,
                    receipts: old.receipts,
                    page: old.page,
                    omittedCases: old.omittedCases,
                    omittedReceipts: old.omittedReceipts,
                  }
                : result,
          };
        });
        setLegacyStatusFreshProject(props.project);
        setError('');
        const reportRevision = JSON.stringify([
          result.generation,
          result.page?.generation,
          EffectOption.getOrUndefined(EffectArray.findFirst(result.projects, item => item.project === props.project)),
        ]);
        if (
          props.healthLegacy !== false &&
          lastReportRevision.current !== undefined &&
          lastReportRevision.current !== reportRevision
        )
          onChanged.current();
        lastReportRevision.current = reportRevision;
        if (!result.paused && result.state !== 'failed')
          timer = window.setTimeout(() => void poll(), result.state === 'running' ? 1_000 : 30_000);
      } catch (cause) {
        if (!cancelled && mutationEpoch.current === epoch) {
          if (maintenanceReadRequiresRedaction(cause)) {
            redactProjectEvidence(props.project);
          }
          setLegacyStatusFreshProject(undefined);
          setError(errorMessage(cause));
          timer = window.setTimeout(() => void poll(), 30_000);
        }
      } finally {
        if (!cancelled && mutationEpoch.current === epoch) setChecking(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.project, refresh, legacyStatus]);
  useEffect(() => {
    if (legacyStatus || live.snapshot.status !== 'ready' || actionBusy.current) return;
    const result = live.snapshot.data;
    if (!validMaintenanceStatus(result)) {
      redactProjectEvidence(props.project);
      setError('Maintenance status is unavailable. Refresh after updating Threadnote.');
      return;
    }
    setBlockedProject(undefined);
    setChecking(false);
    setSnapshot(previous => {
      const old = previous?.project === props.project ? previous.status : undefined;
      return {
        project: props.project,
        status:
          old?.page !== undefined && old.page.generation === result.page?.generation
            ? {
                ...result,
                cases: old.cases,
                receipts: old.receipts,
                page: old.page,
                omittedCases: old.omittedCases,
                omittedReceipts: old.omittedReceipts,
              }
            : result,
      };
    });
    setError('');
    const reportRevision = JSON.stringify([
      result.generation,
      result.page?.generation,
      EffectOption.getOrUndefined(EffectArray.findFirst(result.projects, item => item.project === props.project)),
    ]);
    if (
      props.healthLegacy !== false &&
      lastReportRevision.current !== undefined &&
      lastReportRevision.current !== reportRevision
    )
      onChanged.current();
    lastReportRevision.current = reportRevision;
  }, [legacyStatus, live.snapshot, props.project]);
  useEffect(() => {
    if (legacyStatus || live.snapshot.status !== 'error') return;
    if (maintenanceReadRequiresRedaction(live.snapshot.error)) {
      redactProjectEvidence(props.project);
    }
    setChecking(false);
    setError(errorMessage(live.snapshot.error));
  }, [legacyStatus, live.snapshot, props.project]);
  useEffect(() => {
    const previous = lastLiveRefresh.current;
    lastLiveRefresh.current = {project: props.project, refresh};
    if (previous.project === props.project && previous.refresh !== refresh && !legacyStatus) live.invalidate();
  }, [props.project, refresh, legacyStatus]);

  function adoptEvidence(item: ManagerContextMaintenanceCaseV2, previousCaseId = item.caseId) {
    if (item.project !== activeProject.current) return;
    setSnapshot(previous =>
      previous?.project === item.project
        ? {
            ...previous,
            status: {
              ...previous.status,
              cases: adoptMaintenanceEvidence(previous.status.cases, item, previousCaseId),
            },
          }
        : previous,
    );
    setInspectedCase(previous =>
      previous?.caseId === previousCaseId
        ? {...previous, caseId: item.caseId, evidenceRevision: item.evidenceRevision}
        : previous,
    );
  }
  function refreshEvidence() {
    setNotice('');
    mutationEpoch.current += 1;
    setRefresh(value => value + 1);
    onChanged.current();
  }
  function refreshAfterDecision() {
    refreshEvidence();
    setNotice('Change saved.');
  }

  async function act(action: 'run-now' | 'undo', receiptId?: string) {
    if (actionBusy.current || statusUnconfirmed || props.healthLiveStale) return;
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
      >(
        '/api/attention/context-maintenance',
        {
          project,
          action,
          ...(receiptId ? {receiptId} : {}),
        },
        undefined,
        isManagerContextMaintenanceResult,
      );
      if (!mounted.current || activeProject.current !== project || projectEpoch.current !== epoch) return;
      if ('version' in result) {
        setSnapshot({project, status: result});
        if (action === 'run-now') onChanged.current();
        if (legacyStatus && action === 'run-now') setRefresh(value => value + 1);
      } else if (result.status === 'conflict') {
        setError(maintenanceUndoConflictMessage(result.reason));
        setConflictSubjectUri(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(status?.receipts), __effectArrayReceiver =>
              EffectOption.getOrUndefined(
                EffectArray.findFirst(__effectArrayReceiver, item => item.receiptId === receiptId),
              ),
            ),
          )?.subjectUri,
        );
      } else {
        setNotice(
          result.status === 'already-undone'
            ? 'This change was already undone.'
            : 'Change undone after checking the current memory.',
        );
        if (legacyStatus) setRefresh(value => value + 1);
        onChanged.current();
      }
    } catch (cause) {
      if (mounted.current && activeProject.current === project && projectEpoch.current === epoch) {
        if (action === 'undo' && Schema.is(ManagerApiError)(cause) && cause.status === 409) {
          setError(maintenanceUndoConflictMessage(cause.message));
          setConflictSubjectUri(
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(status?.receipts), items =>
                EffectOption.getOrUndefined(EffectArray.findFirst(items, item => item.receiptId === receiptId)),
              ),
            )?.subjectUri,
          );
        } else {
          if (maintenanceReadRequiresRedaction(cause)) redactProjectEvidence(project);
          setError(errorMessage(cause));
        }
      }
    } finally {
      if (mounted.current && activeProject.current === project && projectEpoch.current === epoch) {
        setBusy(false);
        actionBusy.current = false;
        if (!legacyStatus) live.invalidate();
      }
    }
  }

  async function loadHistory(kind: 'cases' | 'receipts') {
    const cursor = kind === 'cases' ? status?.page?.caseNextCursor : status?.page?.receiptNextCursor;
    if (!status || !cursor || loadingHistory) return;
    const project = props.project;
    const epoch = projectEpoch.current;
    const current = status;
    setLoadingHistory(true);
    try {
      const page = await api<ManagerContextMaintenanceStatusV2>(
        `/api/attention/context-maintenance?project=${encodeURIComponent(project)}&${kind === 'cases' ? 'caseCursor' : 'receiptCursor'}=${encodeURIComponent(cursor)}`,
        undefined,
        undefined,
        isManagerContextMaintenanceStatusV2,
      );
      if (!mounted.current || activeProject.current !== project || projectEpoch.current !== epoch) return;
      const merged = mergeMaintenanceStatusPage(current, page, kind);
      setSnapshot(previous =>
        previous?.status.page?.generation === current.page?.generation ? {project, status: merged} : previous,
      );
    } catch (cause) {
      if (mounted.current && activeProject.current === project && projectEpoch.current === epoch) {
        if (maintenanceReadRequiresRedaction(cause)) redactProjectEvidence(project);
        setError(errorMessage(cause));
      }
    } finally {
      if (mounted.current && activeProject.current === project && projectEpoch.current === epoch)
        setLoadingHistory(false);
    }
  }

  const summary = report.maintenance;
  const cases = EffectArrayPipe(status?.cases ?? [], __effectArrayValues2 =>
    EffectArray.filter(
      __effectArrayValues2,
      (item, __effectArrayIndex3) => __effectArrayIndex3 in __effectArrayValues2 && item.project === props.project,
    ),
  );
  const groups = healthDecisionGroups(report, cases);
  const moreDecisionCases =
    status?.page?.caseNextCursor !== undefined &&
    (status.counts?.['needs-decision'] ?? Infinity) >
      EffectArray.filter(cases, item => item.disposition === 'needs-decision').length;
  const decisionCount =
    (automatic?.project === props.project ? automatic.ready : 0) +
    Math.max(
      summary?.affectedMemories ?? 0,
      status?.counts?.decisionMemories ?? 0,
      groups.length,
      new Set(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(status), __status => {
            const __cases = __status.cases;
            return EffectArray.map(
              EffectArray.filter(
                __cases,
                (__item, __effectArrayIndex) =>
                  __effectArrayIndex in __cases &&
                  __item.project === props.project &&
                  __item.disposition === 'needs-decision',
              ),
              __item => __item.memoryId,
            );
          }),
        ) ?? [],
      ).size,
    );
  const onDecisionCountChange = props.onDecisionCountChange;
  const completeDecisionCount = status?.counts?.decisionMemories === undefined ? undefined : decisionCount;
  useEffect(() => {
    onDecisionCountChange?.(props.project, completeDecisionCount);
  }, [onDecisionCountChange, props.project, completeDecisionCount]);
  useEffect(() => () => onDecisionCountChange?.(props.project, undefined), [onDecisionCountChange, props.project]);
  const citation = summary?.citationCoverage;
  const semantic = summary?.semanticCoverage ?? report.semanticCompleteness;
  const semanticProgress = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(status?.semanticCoverage), __effectArrayReceiver =>
      EffectOption.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver, item => item.project === props.project)),
    ),
  );
  const semanticState = semanticProgress?.state ?? semantic.state;
  const semanticScanComplete =
    semanticProgress === undefined || (semanticProgress.extractionComplete && semanticProgress.comparisonComplete);
  const coverage =
    citation?.state === 'complete' && semanticState === 'complete'
      ? 'complete'
      : citation?.state === 'unavailable' && semanticState === 'unavailable'
        ? 'unavailable'
        : 'partial';
  const projectProgress = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(status?.projects), __effectArrayReceiver =>
      EffectOption.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver, item => item.project === props.project)),
    ),
  );
  const emptyProject =
    projectProgress === undefined && status?.preparation?.complete === true && report.recordsScanned === 0;
  const scanComplete =
    semanticScanComplete &&
    (emptyProject ||
      (projectProgress !== undefined &&
        projectProgress.checked === projectProgress.eligible &&
        status?.preparation?.complete !== false));
  const scanTone =
    status?.state === 'failed' ? 'danger' : status?.paused ? 'warning' : scanComplete ? 'success' : 'info';
  const scanLabel =
    status?.state === 'failed'
      ? 'Stopped'
      : status?.paused
        ? 'Paused'
        : !status
          ? 'Checking…'
          : scanComplete
            ? 'Caught up'
            : 'Scanning';
  const causes =
    status?.groups === undefined
      ? groupMaintenanceCauses(
          EffectArrayPipe(status?.cases ?? [], __effectArrayValues2 =>
            EffectArray.filter(
              __effectArrayValues2,
              (item, __effectArrayIndex3) =>
                __effectArrayIndex3 in __effectArrayValues2 && item.project === props.project,
            ),
          ),
        )
      : EffectArray.map(
          EffectArrayPipe(status.groups, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (item, __effectArrayIndex2) =>
                __effectArrayIndex2 in __effectArrayValues &&
                item.project === props.project &&
                ['queued', 'repairing', 'waiting-evidence', 'deferred-policy'].includes(item.disposition),
            ),
          ),
          item => ({
            key: item.causeKey,
            reason: item.reason,
            repositoryId: item.repositoryId,
            count: item.affectedMemories,
            nextAttemptAt: item.nextAttemptAt,
          }),
        );
  const receipts = EffectArrayPipe(status?.receipts ?? [], __effectArrayValues2 =>
    EffectArray.filter(
      __effectArrayValues2,
      (item, __effectArrayIndex3) => __effectArrayIndex3 in __effectArrayValues2 && item.project === props.project,
    ),
  );
  const dispositionCount = (disposition: string) =>
    status?.counts?.[disposition] ?? EffectArray.filter(cases, item => item.disposition === disposition).length;
  if (
    blockedProject === props.project ||
    (!legacyStatus &&
      ((live.snapshot.status === 'error' && maintenanceReadRequiresRedaction(live.snapshot.error)) ||
        (live.snapshot.status === 'ready' && !validMaintenanceStatus(live.snapshot.data))))
  ) {
    return (
      <section className="panel attention-panel context-health is-active">
        <p role="alert">{error || 'Current maintenance evidence is unavailable.'}</p>
        <button type="button" onClick={() => setRefresh(value => value + 1)}>
          Refresh maintenance status
        </button>
      </section>
    );
  }
  return (
    <section aria-busy={busy} className="panel attention-panel context-health is-active">
      <div className="workspace-tabs" role="tablist" aria-label="Context Health sections">
        {EffectArray.map(
          [
            ['decisions', 'Needs a decision'],
            ['recovery', 'Automatic recovery'],
            ['history', 'History'],
            ['hygiene', 'Hygiene'],
          ] as const,
          ([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? 'is-active' : undefined}
              onClick={() => setTab(value)}
            >
              {label}
              {value === 'decisions' && decisionCount > 0 ? <span>{decisionCount}</span> : null}
            </button>
          ),
        )}
      </div>
      <p role="status" aria-live="polite" className="workspace-note">
        <ShieldCheck />
        {maintenanceStatusLabel({
          decisions: decisionCount,
          coverage: automatic?.project === props.project && !automatic.pending ? coverage : 'partial',
          paused: status?.paused ?? false,
          state: status?.state,
        })}
      </p>
      <div className="attention-metrics" hidden={tab !== 'recovery'}>
        <Metric
          label="Needs your decision"
          value={`${decisionCount.toLocaleString()} ${decisionCount === 1 ? 'memory' : 'memories'}`}
          tone={decisionCount > 0 ? 'warning' : 'success'}
        />
        <Metric
          label="Automatic work"
          value={(summary?.automaticallyManagedFindings ?? 0).toLocaleString()}
          tone={(summary?.automaticallyManagedFindings ?? 0) > 0 ? 'info' : 'neutral'}
        />
        <Metric label="Evidence coverage" value={coverage} tone={coverage === 'complete' ? 'success' : 'info'} />
        <Metric
          label="Historical items"
          value={((summary?.historicalFindings ?? 0) + (citation?.historicalVerified ?? 0)).toLocaleString()}
          tone="neutral"
        />
      </div>
      <section hidden={tab !== 'recovery'} className="attention-bulk-repair" aria-label="Project maintenance actions">
        <div>
          <strong>Run maintenance for this project</strong>
          <p>Check this project now using the current automatic maintenance setting.</p>
        </div>
        <button
          type="button"
          className="health-primary-action"
          disabled={
            busy || statusUnconfirmed || props.healthLiveStale || !status || status.paused || status.state === 'running'
          }
          onClick={() => void act('run-now')}
        >
          {busy ? 'Working…' : 'Run maintenance now'}
        </button>
      </section>
      <div className="health-refresh-status" style={{blockSize: '4.5rem', overflowY: 'auto'}}>
        {props.reportError ? (
          <p role="alert">
            Evidence page changed or could not refresh: {props.reportError}{' '}
            <button type="button" onClick={props.onRefresh}>
              Refresh evidence from the first page
            </button>
          </p>
        ) : null}
        {statusUnconfirmed ? (
          <p role="status">
            {checking
              ? 'Checking for maintenance updates. Open reviews are paused until current evidence is checked.'
              : 'Maintenance evidence is unconfirmed. The displayed evidence may be older than the current project.'}
            {!checking ? (
              <button type="button" onClick={() => setRefresh(value => value + 1)}>
                Retry maintenance status
              </button>
            ) : null}
          </p>
        ) : null}
        {live.active && legacyStatus && legacyStatusFreshProject === props.project ? (
          <p role="status">Live maintenance updates are unavailable; this view checks for changes periodically.</p>
        ) : null}
        {props.healthLiveStale && !props.reportError ? (
          <p role="status">
            Context health evidence is being refreshed. Open reviews are paused until current evidence is checked.
          </p>
        ) : null}
        {props.healthFallback ? (
          <p role="status">
            Live context health updates are unavailable; this view checks for changes every 30 seconds.
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
      </div>
      {conflictSubjectUri ? (
        <button type="button" onClick={() => props.onOpenLibrary(conflictSubjectUri)}>
          Inspect current memory
        </button>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {status?.error ? (
        <section
          role="alert"
          aria-label="Maintenance failure diagnostic"
          className="attention-card maintenance-failure-diagnostic"
        >
          <p>Maintenance stopped: {status.error.reason}. Progress is preserved.</p>
          {status.error.diagnostic ? (
            <>
              <p>{status.error.diagnostic.summary}</p>
              <p>Stage: {Effect.pipe(status.error.diagnostic.stage, EffectString.replaceAll('-', ' '))}</p>
              {status.error.diagnostic.memoryUri ? (
                <p>
                  <code>{status.error.diagnostic.memoryUri}</code>
                </p>
              ) : null}
              <p>{status.error.diagnostic.recovery}</p>
            </>
          ) : (
            <p>
              Run maintenance again to collect current failure details. Update Threadnote if this version keeps
              reporting only a reason.
            </p>
          )}
        </section>
      ) : null}
      <section
        hidden={tab !== 'recovery'}
        aria-label="Evidence coverage"
        className="attention-card health-coverage-card"
      >
        <header>
          <h3>Evidence coverage</h3>
          <span className="health-status-badge" data-tone={coverage === 'complete' ? 'success' : 'info'}>
            {coverage}
          </span>
        </header>
        <div className="health-scan-progress" aria-label="Background scan" data-tone={scanTone}>
          <header>
            <strong>Background scan</strong>
            <span className="health-status-badge" data-tone={scanTone}>
              {scanLabel}
            </span>
          </header>
          {projectProgress ? (
            <>
              <p>
                <strong>{projectProgress.checked.toLocaleString()}</strong> of{' '}
                {projectProgress.eligible.toLocaleString()} background checks completed
                {projectProgress.eligible > 0
                  ? ` · ${Math.round((projectProgress.checked / projectProgress.eligible) * 100)}%`
                  : ''}
              </p>
              <progress
                aria-label="Background maintenance progress"
                value={projectProgress.checked}
                max={Math.max(1, projectProgress.eligible)}
              />
              <p>
                {projectProgress.checkedCitations.toLocaleString()} citation evidence checks completed, including
                retained historical evidence.
              </p>
            </>
          ) : emptyProject ? (
            <p>No eligible background checks.</p>
          ) : (
            <progress aria-label="Preparing background maintenance" />
          )}
          <p>
            {status?.paused
              ? 'Resume automatic maintenance to continue scanning.'
              : status?.state === 'failed'
                ? 'Progress is preserved. See the maintenance diagnostic above.'
                : scanComplete
                  ? 'The scan is caught up. Evidence may remain unavailable until a usable source becomes available.'
                  : 'Checks continue automatically while Threadnote is running. You do not need to keep starting them.'}
          </p>
          {status?.lastProgressAt ? (
            <small>
              Last progress:{' '}
              <time dateTime={status.lastProgressAt}>{new Date(status.lastProgressAt).toLocaleTimeString()}</time>
            </small>
          ) : null}
        </div>
        {citation ? (
          <div className="attention-metrics health-evidence-metrics">
            <Metric label="Current source checks" value={citation.checked.toLocaleString()} tone="info" />
            <Metric label="Verified historically" value={citation.historicalVerified.toLocaleString()} tone="neutral" />
            <Metric
              label="Pending checks"
              value={(
                citation.pending ?? Math.max(0, citation.deferred - citation.historicalVerified)
              ).toLocaleString()}
              tone="info"
            />
            <Metric
              label="Waiting for source evidence"
              value={citation.unavailable?.toLocaleString() ?? '—'}
              tone="neutral"
            />
          </div>
        ) : null}
        <p>
          Historical evidence preserves an earlier source; it does not verify today’s code. Missing source evidence is
          retried automatically when sources change.
        </p>
        {semanticProgress ? (
          <div className="health-scan-progress" aria-label="Semantic scan progress">
            <header>
              <strong>Memory comparisons</strong>
              <span
                className="health-status-badge"
                data-tone={semanticProgress.state === 'complete' ? 'success' : 'info'}
              >
                {semanticScanComplete
                  ? semanticProgress.state === 'complete'
                    ? 'Checked'
                    : 'Checked with gaps'
                  : 'In progress'}
              </span>
            </header>
            <p>
              {semanticProgress.extractedRecords.toLocaleString()} of {semanticProgress.totalRecords.toLocaleString()}{' '}
              durable memories read
            </p>
            <progress
              aria-label="Claim extraction progress"
              value={semanticProgress.extractedRecords}
              max={Math.max(1, semanticProgress.totalRecords)}
            />
            {semanticProgress.churnCount > 0 ? (
              <p>
                {semanticProgress.comparedClaimPairs.toLocaleString()} comparison checks performed across source
                revisions.{' '}
                {semanticProgress.comparisonComplete
                  ? 'Current comparisons finished.'
                  : 'Changed claims are being checked again.'}
              </p>
            ) : semanticProgress.totalClaimPairs === undefined ? (
              <p>
                {semanticProgress.comparedClaimPairs.toLocaleString()} claim comparisons checked. The total grows as
                remaining memories are read.
              </p>
            ) : (
              <>
                <p>
                  {semanticProgress.comparedClaimPairs.toLocaleString()} of{' '}
                  {semanticProgress.totalClaimPairs.toLocaleString()} claim comparisons checked
                </p>
                <progress
                  aria-label="Claim comparison progress"
                  value={semanticProgress.comparedClaimPairs}
                  max={Math.max(1, semanticProgress.totalClaimPairs)}
                />
              </>
            )}
            {semanticProgress.unsupportedClaims > 0 ? (
              <p>
                {semanticProgress.unsupportedClaims.toLocaleString()} claims in{' '}
                {semanticProgress.unsupportedRecords.toLocaleString()} memories could not be interpreted.
              </p>
            ) : null}
            {semanticProgress.bodyLimitedRecords > 0 ? (
              <p>
                {semanticProgress.bodyLimitedRecords.toLocaleString()}{' '}
                {semanticProgress.bodyLimitedRecords === 1 ? 'memory exceeded' : 'memories exceeded'} the supported text
                limit.
              </p>
            ) : null}
            {semanticProgress.outputOmittedFindings > 0 ? (
              <p>
                {semanticProgress.outputOmittedFindings.toLocaleString()} findings are outside the retained output
                limit. Coverage remains partial.
              </p>
            ) : null}
            {semanticProgress.churnCount > 0 ? (
              <p>
                {semanticProgress.churnCount.toLocaleString()} source changes invalidated affected work; unaffected
                progress is preserved.
              </p>
            ) : null}
            <p>
              Completed checks do not prove that memories agree. Unsupported text and comparisons with missing context
              still need review.
            </p>
          </div>
        ) : (
          <p>
            The bounded English extractor assessed supported claims in{' '}
            {semantic.analyzedRecords?.toLocaleString() ?? '0'} of {semantic.eligibleRecords?.toLocaleString() ?? '0'}{' '}
            durable memories. Extraction coverage can remain partial after scanning finishes and does not establish
            semantic correctness. Comparisons with missing context require review.
          </p>
        )}
        {report.repositoryEvidence.state === 'unavailable' ? (
          <p>
            Current repository evidence is unavailable. Memory and relation checks remain useful; local evidence
            recovery continues when a verified source becomes available.
          </p>
        ) : null}
        <details>
          <summary>Coverage details and scan progress</summary>
          {status?.preparation?.incompleteReason ? (
            <p>
              Inventory check: {Effect.pipe(status.preparation.incompleteReason, EffectString.replaceAll('-', ' '))}.
              Progress is preserved.
            </p>
          ) : null}
          <p>
            {report.recordsScanned.toLocaleString()} records scanned.{' '}
            {projectProgress
              ? `${projectProgress.checked} of ${projectProgress.eligible} maintenance tasks checked.`
              : 'No completed maintenance checkpoint yet.'}
          </p>
          {EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(citation?.reasons), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, reason => (
                <p key={reason.reason}>
                  {reason.count} — {Effect.pipe(reason.reason, EffectString.replaceAll('-', ' '))}.{' '}
                  {maintenanceRecoveryInstruction(reason.reason)}
                </p>
              )),
            ),
          )}
          {EffectArray.map(semantic.unknownReasons, reason => (
            <p key={reason.reason}>
              {reason.count} semantic checks: {Effect.pipe(reason.reason, EffectString.replaceAll('-', ' '))}.
            </p>
          ))}
        </details>
      </section>
      <section
        hidden={tab !== 'decisions'}
        aria-label="Needs your decision"
        className="attention-list health-record-list"
      >
        <h3>Needs your decision</h3>
        {groups.length === 0 ? (
          <p>No decisions are waiting in the loaded context. Open Automatic recovery to inspect evidence coverage.</p>
        ) : null}
        {EffectArray.map(groups, group => (
          <article key={group.key} className="attention-card health-record health-decision-card">
            <header>
              <div>
                <h3>{group.preview?.title ?? maintenanceMemoryTitle(group.uri)}</h3>
                {group.preview?.excerpt ? (
                  <MemoryExcerpt label="Saved memory">{group.preview.excerpt}</MemoryExcerpt>
                ) : (
                  <p>{maintenanceDecisionExplanation(group.cases[0]?.reason ?? '')}</p>
                )}
              </div>
              <ReviewBadge tone="warning">
                {group.findings.length + group.cases.length} supporting{' '}
                {group.findings.length + group.cases.length === 1 ? 'check' : 'checks'}
              </ReviewBadge>
            </header>
            {group.uri ? (
              <button type="button" className="health-quiet-action" onClick={() => props.onOpenLibrary(group.uri)}>
                Open memory
              </button>
            ) : null}
            {EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(group.preview?.code), __effectArrayReceiver2 =>
                EffectArray.map(__effectArrayReceiver2, code => (
                  <section className="health-code-preview" key={code.citationId}>
                    <h4>{code.targetLabel ?? code.path}</h4>
                    <p>
                      {code.path}
                      {code.line ? `:${code.line}` : ''}
                    </p>
                    {code.evidence ? (
                      EffectArray.map(code.evidence.excerpts, excerpt => (
                        <section key={`${excerpt.provenance}:${excerpt.excerptHash}`}>
                          <p>
                            {excerpt.provenance === 'historical-verified'
                              ? 'Historical evidence preserved; does not verify current source'
                              : excerpt.supportsCitation
                                ? 'Current source supports this citation'
                                : 'Current source changed; review the claim'}
                          </p>
                          <p>
                            {excerpt.source.path}:{excerpt.startLine} · {excerpt.source.sourceCommit}
                          </p>
                          <pre>{excerpt.content}</pre>
                        </section>
                      ))
                    ) : code.excerpt ? (
                      <pre>{code.excerpt}</pre>
                    ) : (
                      <p>Open the review to compare source evidence.</p>
                    )}
                  </section>
                )),
              ),
            )}
            {EffectArray.map(group.findings, finding => (
              <section key={finding.caseId ?? finding.id} className="health-finding">
                <h4>{Effect.pipe(finding.category, EffectString.replaceAll('-', ' '))}</h4>
                <p>{finding.summary}</p>
                <p>
                  {finding.confidence} confidence ·{' '}
                  {Effect.pipe(finding.repairability, EffectString.replaceAll('-', ' '))}. The engine stopped because
                  this requires a supported content or authority decision.
                </p>
                <button type="button" className="health-primary-action" onClick={() => setSelected(finding)}>
                  Compare evidence and preview change
                </button>
              </section>
            ))}
            {group.cases.length > 0 ? (
              <section className="health-finding">
                {EffectArray.map([...new Set(EffectArray.map(group.cases, item => item.reason))], reason => (
                  <div key={reason}>
                    <h4>{maintenanceDecisionLabel(reason)}</h4>
                    {group.preview || group.cases.length > 1 ? <p>{maintenanceDecisionExplanation(reason)}</p> : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="health-primary-action"
                  onClick={() =>
                    setInspectedCase({
                      caseId: group.cases[0].caseId,
                      memoryUri: group.uri,
                      title: group.preview?.title,
                      evidenceRevision: group.cases[0].evidenceRevision,
                    })
                  }
                >
                  Review memory and evidence
                </button>
              </section>
            ) : null}
            <p className="muted">
              Review the evidence here, edit the memory in Library, or copy a task for your coding agent.
            </p>
            <div className="health-record-actions">
              <button
                type="button"
                onClick={() =>
                  setTask(
                    healthDecisionTask(
                      props.project,
                      [...group.findings, ...group.cases],
                      'Determine the supported current claim',
                      group.uri,
                    ),
                  )
                }
              >
                Review with agent…
              </button>
              <button
                type="button"
                onClick={() =>
                  setTask(
                    healthDecisionTask(
                      props.project,
                      [...group.findings, ...group.cases],
                      'Review whether the memory should be historical or archived',
                      group.uri,
                    ),
                  )
                }
              >
                Ask agent about historical or archive options…
              </button>
            </div>
          </article>
        ))}
        {moreDecisionCases ? (
          <button type="button" disabled={loadingHistory} onClick={() => void loadHistory('cases')}>
            {loadingHistory ? 'Loading more reviews…' : 'Load more memories to review'}
          </button>
        ) : null}
        {props.nextCursor ? (
          <button type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>
            {props.loadingMore ? 'Loading decision details…' : 'Load more decision details'}
          </button>
        ) : null}
      </section>
      <section
        hidden={tab !== 'recovery'}
        aria-label="Automatic recovery"
        className="attention-list health-recovery-list"
      >
        <h3>Automatic recovery</h3>
        {causes.length === 0 ? (
          <p>No blocked recovery groups are reported. Queued evidence checks are tracked in coverage.</p>
        ) : (
          EffectArray.map(causes, group => (
            <article key={group.key} className="attention-card health-recovery-card">
              <h4>{Effect.pipe(group.reason, EffectString.replaceAll('-', ' '))}</h4>
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
      <section
        hidden={tab !== 'history'}
        aria-label="Recent maintenance and history"
        className="attention-list health-history-list"
      >
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
        {EffectArray.map(receipts, receipt => (
          <article key={receipt.receiptId} className="attention-card health-history-card">
            <p>
              {receipt.state === 'applied'
                ? 'Safe local structural change applied'
                : Effect.pipe(receipt.state, EffectString.replaceAll('-', ' '))}{' '}
              · {new Date(receipt.timestamp).toLocaleString()}
            </p>
            <div className="health-record-actions">
              <button
                type="button"
                className="health-quiet-action"
                onClick={() => props.onOpenLibrary(receipt.archivedUri ?? receipt.subjectUri)}
              >
                Inspect changed memory
              </button>
              {receipt.state === 'applied' ? (
                <button
                  type="button"
                  className="health-quiet-action"
                  disabled={busy || statusUnconfirmed || props.healthLiveStale}
                  onClick={() => void act('undo', receipt.receiptId)}
                >
                  Undo this change
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {status?.page?.receiptNextCursor ? (
          <button type="button" disabled={loadingHistory || busy} onClick={() => void loadHistory('receipts')}>
            {loadingHistory ? 'Loading history…' : 'Load more retained changes and undo'}
          </button>
        ) : null}
        <details>
          <summary>Bounded maintenance diagnostics</summary>
          <p>Evidence generation: {projectProgress?.generation ?? status?.generation ?? 'unavailable'}.</p>
          {EffectArray.map(cases, item => (
            <p key={item.caseId}>
              {Effect.pipe(item.disposition, EffectString.replaceAll('-', ' '))}:{' '}
              {Effect.pipe(item.reason, EffectString.replaceAll('-', ' '))} · {item.attemptCount} attempts · last
              checked {item.lastChecked}{' '}
              <button
                type="button"
                onClick={() => setInspectedCase({caseId: item.caseId, evidenceRevision: item.evidenceRevision})}
              >
                Inspect exact case and evidence
              </button>
            </p>
          ))}
          {status?.page?.caseNextCursor ? (
            <button type="button" disabled={loadingHistory || busy} onClick={() => void loadHistory('cases')}>
              {loadingHistory ? 'Loading history…' : 'Load more retained cases'}
            </button>
          ) : null}
        </details>
      </section>
      {tab === 'hygiene' ? (
        <section className="workspace-card">
          <header>
            <h3>Memory hygiene</h3>
          </header>
          <div className="workspace-pad">
            <p>
              Find overlapping memories and preview a smaller, clearer set of context. Review the proposed changes
              before applying.
            </p>
            <WorkspaceUtilities
              inline
              panel="context-health"
              project={props.project}
              projects={props.projects}
              onChanged={async () => props.onChanged()}
            />
          </div>
        </section>
      ) : null}
      <AutomaticMemoryPanel
        onOpenMemory={props.onOpenLibrary}
        key={props.project}
        project={props.project}
        onChanged={props.onChanged}
        onReview={reviewId => {
          automaticObservation.current = {
            project: props.project,
            reviewId,
            cases: structuredClone(status?.cases ?? []),
            report: structuredClone(report),
          };
        }}
        onApplied={result => {
          const observed = automaticObservation.current;
          if (
            !mounted.current ||
            activeProject.current !== result.project ||
            observed?.project !== result.project ||
            observed.reviewId !== result.reviewId
          )
            return;
          const receipts = automaticReviewMaintenanceReceipts(result, observed.cases, observed.report);
          mutationEpoch.current += 1;
          setAppliedCases(previous => [...previous, ...receipts]);
          setRefresh(value => value + 1);
        }}
        onSummaryChange={(project, summary) => setAutomatic(summary ? {project, ...summary} : undefined)}
      />
      {inspectedCase ? (
        <MaintenanceCaseDialog
          key={`case:${props.project}`}
          project={props.project}
          caseId={inspectedCase.caseId}
          memoryUri={inspectedCase.memoryUri}
          initialCase={EffectOption.getOrUndefined(
            EffectArray.findFirst(cases, item => item.caseId === inspectedCase.caseId),
          )}
          relatedCases={
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                groups,
                __effectArrayValue =>
                  !!(group =>
                    (inspectedCase.memoryUri === undefined || group.uri === inspectedCase.memoryUri) &&
                    EffectArray.some(group.cases, item => item.caseId === inspectedCase.caseId))(__effectArrayValue),
              ),
            )?.cases
          }
          title={inspectedCase.title}
          stale={
            inspectedCase.evidenceRevision !== undefined &&
            EffectOption.getOrUndefined(EffectArray.findFirst(cases, item => item.caseId === inspectedCase.caseId))
              ?.evidenceRevision !== inspectedCase.evidenceRevision
          }
          onEvidenceUpdated={adoptEvidence}
          onClose={() => setInspectedCase(undefined)}
          onChanged={refreshAfterDecision}
          onApplied={result => {
            if (result.project !== activeProject.current) return;
            mutationEpoch.current += 1;
            setAppliedCases(previous => [
              ...EffectArray.filter(
                previous,
                (item, __effectArrayIndex) =>
                  __effectArrayIndex in previous &&
                  (item.project !== result.project ||
                    item.caseId !== result.caseId ||
                    item.evidenceRevision !== result.evidenceRevision),
              ),
              result,
            ]);
            setNotice(
              'Topic update saved and verified. The resolved source change has been removed from your decisions.',
            );
          }}
          onOpenLibrary={uri => {
            setInspectedCase(undefined);
            props.onOpenLibrary(uri);
          }}
          onTask={value => {
            setInspectedCase(undefined);
            setTask(value);
          }}
        />
      ) : null}
      {task ? <MaintenanceTaskDialog task={task} onClose={() => setTask('')} /> : null}
      {selected ? (
        <HealthDetail
          key={`${props.project}:${selected.caseId ?? selected.id}`}
          project={props.project}
          finding={selected}
          memoryPreview={EffectOption.getOrUndefined(
            EffectArray.findFirst(report.recordPreviews, preview => preview.uri === selected.repair.subjectUri),
          )}
          repairsAvailable={report.repositoryEvidence.state === 'available'}
          stale={
            !!props.healthLiveStale ||
            statusUnconfirmed ||
            JSON.stringify(
              EffectOption.getOrUndefined(EffectArray.findFirst(report.findings, item => item.id === selected.id)),
            ) !== JSON.stringify(selected)
          }
          onEvidenceUpdated={adoptEvidence}
          onClose={() => setSelected(undefined)}
          onChanged={refreshAfterDecision}
          onRefresh={refreshEvidence}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : null}
    </section>
  );
}

function maintenanceReadRequiresRedaction(cause: unknown): boolean {
  return Schema.is(ManagerApiError)(cause) && [400, 401, 403, 404, 409, 410].includes(cause.status);
}

function validMaintenanceStatus(result: ManagerContextMaintenanceStatusV2): boolean {
  return (
    !!result &&
    result.version === 2 &&
    EffectArray.isArray(result.projects) &&
    EffectArray.isArray(result.cases) &&
    EffectArray.isArray(result.receipts)
  );
}

function Metric(props: {
  readonly label: string;
  readonly value: string;
  readonly tone: 'warning' | 'success' | 'info' | 'neutral';
}) {
  return (
    <div data-tone={props.tone}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

/** Replace either observation at its first position and retain one current case. */
export function adoptMaintenanceEvidence(
  cases: readonly ManagerContextMaintenanceCaseV2[],
  item: ManagerContextMaintenanceCaseV2,
  previousCaseId = item.caseId,
): readonly ManagerContextMaintenanceCaseV2[] {
  const first = EffectOption.getOrElse(
    EffectArray.findFirstIndex(cases, value => value.caseId === previousCaseId || value.caseId === item.caseId),
    () => -1,
  );
  if (first < 0) return [...cases, item];
  return EffectArray.flatMap(cases, (value, index) =>
    value.caseId === previousCaseId || value.caseId === item.caseId ? (index === first ? [item] : []) : [value],
  );
}
