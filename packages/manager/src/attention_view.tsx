import React, {useEffect, useRef, useState} from 'react';
import type {
  ManagerCitationRepairJobResponseV1,
  ManagerCitationRepairJobV1,
  ManagerContextHealthResponseV1,
  ManagerReviewInboxResponseV1,
} from '@threadnote/manager/attention/contracts';
import {ContextMaintenanceView} from './attention/maintenance_view.js';
import {ReviewDetail, HealthDetail} from './attention_details.js';
import {api, errorMessage} from '@threadnote/manager/ui/support';

interface AttentionPanelProps {
  readonly onOpenLibrary: (uri?: string) => void;
  readonly onProjectChange: (project: string) => void;
  readonly project: string;
  readonly projects: readonly string[];
  readonly refreshGeneration: number;
}

interface CitationRepairPreview {
  readonly items: readonly {
    readonly category: 'citation-changed' | 'citation-missing' | 'citation-unknown';
    readonly citationId: string;
    readonly findingId: string;
    readonly path: string;
    readonly proposalId: string;
    readonly replacementId: string;
    readonly revision: string;
    readonly sourceCommit: string;
    readonly subjectExcerpt?: string;
    readonly subjectTitle?: string;
    readonly subjectUri: string;
    readonly targetKind: 'file' | 'symbol';
  }[];
  readonly project: string;
  readonly nextCursor?: string;
  readonly repairableCount: number;
  readonly requiresGraphCount: number;
  readonly truncated: boolean;
  readonly version: 1;
}

type CitationRepairProgress =
  | {readonly stage: 'rebuild'}
  | {readonly stage: 'scan'}
  | {
      readonly appliedCount: number;
      readonly completedCount: number;
      readonly failedCount: number;
      readonly recordCount: number;
      readonly stage: 'apply';
      readonly totalCount: number;
    };

interface CitationRepairApplyResult {
  readonly appliedCount: number;
  readonly failedCount: number;
  readonly results: readonly {readonly error?: string; readonly findingId: string; readonly status: string}[];
}

export function ReviewsPanel(props: AttentionPanelProps): React.ReactElement {
  const [selected, setSelected] = useState<{reviewId: string; candidateId: string}>();
  const [generation, setGeneration] = useState(0);
  const [inbox, setInbox] = useState<ManagerReviewInboxResponseV1>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setSelected(undefined);
    if (!props.project) {
      setInbox(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    void api<ManagerReviewInboxResponseV1>(`/api/reviews?project=${encodeURIComponent(props.project)}`)
      .then(result => {
        if (!cancelled) setInbox(result);
      })
      .catch(cause => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.project, props.refreshGeneration, generation]);

  return (
    <section aria-busy={loading} className="panel attention-panel is-active">
      <AttentionHeader
        eyebrow="Knowledge review"
        onProjectChange={props.onProjectChange}
        project={props.project}
        projects={props.projects}
        summary="Review the exact proposed memories that still need a decision."
        title="Review inbox"
      />
      {!props.project ? (
        <AttentionEmpty text="Select a project to load its pending reviews." />
      ) : error ? (
        <AttentionError error={error} />
      ) : loading ? (
        <AttentionEmpty text="Loading the review inbox…" />
      ) : !inbox || inbox.pendingCount === 0 ? (
        <AttentionEmpty text={`No knowledge reviews need attention for ${props.project}.`} />
      ) : (
        <div className="attention-list">
          {inbox.items.map(review => (
            <article className="attention-card" key={review.reviewId}>
              <header>
                <div>
                  <span className="attention-kicker">{review.topic || 'Untitled review'}</span>
                  <h3>{review.task}</h3>
                </div>
                <span className="attention-count">{review.candidates.length}</span>
              </header>
              <p className="muted">
                Created {new Date(review.createdAt).toLocaleString()} · revision {review.revision}
              </p>
              <div className="attention-candidates">
                {review.candidates.map(candidate => (
                  <section key={candidate.candidateId}>
                    <div className="attention-tags">
                      <span className={`attention-state is-${candidate.state}`}>{candidate.state}</span>
                      <span>{candidate.recommendation.replaceAll('_', ' ')}</span>
                      <span>{Math.round(candidate.confidence * 100)}% confidence</span>
                    </div>
                    <button
                      className="attention-item-button"
                      onClick={() => setSelected({reviewId: review.reviewId, candidateId: candidate.candidateId})}
                      type="button"
                    >
                      <pre>{candidate.proposedText}</pre>
                      <strong>Review and decide →</strong>
                    </button>
                    <p>{candidate.reason}</p>
                    {candidate.targetUri ? <code>{candidate.targetUri}</code> : null}
                  </section>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      {inbox && inbox.pendingCount > 0 ? (
        <footer className="attention-footer">
          <p>Open a proposal to read it in full and approve, defer, or reject it.</p>
          <button onClick={() => props.onOpenLibrary()} type="button">
            Browse related memories
          </button>
        </footer>
      ) : null}
      {selected ? (
        <ReviewDetail
          key={`${props.project}:${selected.reviewId}:${selected.candidateId}`}
          {...selected}
          project={props.project}
          onClose={() => setSelected(undefined)}
          onChanged={() => setGeneration(value => value + 1)}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : null}
    </section>
  );
}

export function ContextHealthPanel(props: AttentionPanelProps): React.ReactElement {
  const [selected, setSelected] = useState<ManagerContextHealthResponseV1['findings'][number]>();
  const [generation, setGeneration] = useState(0);
  const requestEpoch = useRef(0);
  const requestController = useRef<AbortController | undefined>(undefined);
  const [report, setReport] = useState<ManagerContextHealthResponseV1>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [citationRepairOpen, setCitationRepairOpen] = useState(false);
  const [citationRepairJob, setCitationRepairJob] = useState<ManagerCitationRepairJobV1>();
  const [citationRepairJobError, setCitationRepairJobError] = useState('');
  const [citationRepairJobGeneration, setCitationRepairJobGeneration] = useState(0);
  const [citationRepairJobStarting, setCitationRepairJobStarting] = useState(false);
  const activeCitationRepairJobId = useRef<string | undefined>(undefined);
  const citationRepairJobProjectEpoch = useRef(0);
  const citationRepairJobProject = useRef('');
  const refreshedCitationRepairJobId = useRef<string | undefined>(undefined);
  useEffect(() => {
    requestEpoch.current += 1;
    setSelected(undefined);
    setCitationRepairOpen(false);
    if (!props.project) {
      setReport(undefined);
      setNextCursor(undefined);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError('');
    void api<ManagerContextHealthResponseV1>(
      `/api/context-health?project=${encodeURIComponent(props.project)}`,
      undefined,
      {
        signal: controller.signal,
        timeoutMilliseconds: 8_000,
      },
    )
      .then(result => {
        if (!cancelled && result.project === props.project) {
          setReport(result);
          setNextCursor(result.nextCursor);
        }
      })
      .catch(cause => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.project, props.refreshGeneration, generation]);

  useEffect(() => {
    if (citationRepairJobProject.current !== props.project) {
      citationRepairJobProjectEpoch.current += 1;
      citationRepairJobProject.current = props.project;
      activeCitationRepairJobId.current = undefined;
      refreshedCitationRepairJobId.current = undefined;
      setCitationRepairJobStarting(false);
    }
    if (!props.project || report === undefined || report?.maintenance !== undefined) {
      setCitationRepairJob(undefined);
      setCitationRepairJobError('');
      return;
    }
    let cancelled = false;
    let failedPollCount = 0;
    let timer: number | undefined;
    const schedulePoll = (delay: number): void => {
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async (): Promise<void> => {
      try {
        const response = await api<ManagerCitationRepairJobResponseV1>(
          `/api/context-health/citations/jobs?project=${encodeURIComponent(props.project)}`,
        );
        if (cancelled) return;
        if (!response.job && (activeCitationRepairJobId.current || refreshedCitationRepairJobId.current)) {
          if (activeCitationRepairJobId.current) schedulePoll(1_000);
          return;
        }
        setCitationRepairJob(response.job ?? undefined);
        setCitationRepairJobError('');
        failedPollCount = 0;
        if (response.job?.status === 'running') {
          activeCitationRepairJobId.current = response.job.id;
          schedulePoll(1_000);
        } else if (
          response.job &&
          activeCitationRepairJobId.current === response.job.id &&
          refreshedCitationRepairJobId.current !== response.job.id
        ) {
          activeCitationRepairJobId.current = undefined;
          refreshedCitationRepairJobId.current = response.job.id;
          setGeneration(value => value + 1);
        }
      } catch (cause) {
        if (cancelled) return;
        setCitationRepairJobError(errorMessage(cause));
        if (activeCitationRepairJobId.current) {
          failedPollCount = Math.min(failedPollCount + 1, 4);
          schedulePoll(Math.min(1_000 * 2 ** (failedPollCount - 1), 5_000));
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.project, citationRepairJobGeneration, report !== undefined, report?.maintenance !== undefined]);

  function loadMore(): void {
    if (!nextCursor || loadingMore) return;
    const epoch = requestEpoch.current;
    setLoadingMore(true);
    setError('');
    void api<ManagerContextHealthResponseV1>(
      `/api/context-health?project=${encodeURIComponent(props.project)}&after=${encodeURIComponent(nextCursor)}`,
      undefined,
      {signal: requestController.current?.signal, timeoutMilliseconds: 8_000},
    )
      .then(next => {
        if (epoch !== requestEpoch.current || next.project !== props.project) return;
        setReport(current =>
          current === undefined
            ? next
            : {
                ...current,
                findings: [...current.findings, ...next.findings],
                omittedFindings: next.remainingFindings ?? 0,
                recordPreviews: mergeHealthRecordPreviews(current.recordPreviews, next.recordPreviews),
                ...(next.remainingFindings === undefined ? {} : {remainingFindings: next.remainingFindings}),
              },
        );
        setNextCursor(next.nextCursor);
      })
      .catch(cause => {
        if (epoch === requestEpoch.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (epoch === requestEpoch.current) setLoadingMore(false);
      });
  }

  async function startBackgroundCitationRepair(): Promise<void> {
    if (!props.project || citationRepairJobStarting || citationRepairJob?.status === 'running') return;
    const project = props.project;
    const projectEpoch = citationRepairJobProjectEpoch.current;
    setCitationRepairJobStarting(true);
    setCitationRepairJobError('');
    try {
      const response = await api<ManagerCitationRepairJobResponseV1>('/api/context-health/citations/jobs', {
        project,
      });
      if (citationRepairJobProjectEpoch.current !== projectEpoch || citationRepairJobProject.current !== project)
        return;
      const job = response.job ?? undefined;
      setCitationRepairJob(job);
      if (job?.status === 'running') {
        activeCitationRepairJobId.current = job.id;
      } else if (job && refreshedCitationRepairJobId.current !== job.id) {
        activeCitationRepairJobId.current = undefined;
        refreshedCitationRepairJobId.current = job.id;
        setGeneration(value => value + 1);
      }
      setCitationRepairJobGeneration(value => value + 1);
    } catch (cause) {
      if (citationRepairJobProjectEpoch.current === projectEpoch && citationRepairJobProject.current === project) {
        setCitationRepairJobError(errorMessage(cause));
      }
    } finally {
      if (citationRepairJobProjectEpoch.current === projectEpoch && citationRepairJobProject.current === project) {
        setCitationRepairJobStarting(false);
      }
    }
  }

  if (report?.maintenance !== undefined && report.project === props.project) {
    return (
      <ContextMaintenanceView
        key={props.project}
        project={props.project}
        projects={props.projects}
        report={report}
        onProjectChange={props.onProjectChange}
        onOpenLibrary={props.onOpenLibrary}
        onChanged={() => setGeneration(value => value + 1)}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        reportError={error}
        onRefresh={() => setGeneration(value => value + 1)}
      />
    );
  }

  return (
    <section aria-busy={loading} className="panel attention-panel is-active">
      <AttentionHeader
        eyebrow="Memory quality"
        onProjectChange={props.onProjectChange}
        project={props.project}
        projects={props.projects}
        summary="Inspect stale, conflicting, duplicated, or disconnected context for this project."
        title="Context health"
      />
      {!props.project ? (
        <AttentionEmpty text="Select a project to inspect its context health." />
      ) : error ? (
        <AttentionError error={error} />
      ) : loading ? (
        <AttentionEmpty text="Checking project context…" />
      ) : report ? (
        <>
          <div className="attention-metrics">
            <Metric label="Status" value={report.status} />
            <Metric label="Records scanned" value={report.recordsScanned.toLocaleString()} />
            <Metric label="Issues" value={(report.findings.length + report.omittedFindings).toLocaleString()} />
            <Metric label="Semantic coverage" value={report.semanticCompleteness.state} />
          </div>
          <p className="health-count-explanation">
            One memory can have several issues. The list groups the loaded issues by affected memory.
          </p>
          {report.repositoryEvidence.state === 'available' &&
          (report.findings.some(finding => finding.repair.kind === 'repair-citation') || citationRepairJob) ? (
            <>
              <div className="attention-bulk-repair">
                <div>
                  <strong>Repair code citations</strong>
                  <p>Review a bounded batch, or let a background worker repair the full citation backlog.</p>
                </div>
                <div className="attention-bulk-repair-actions">
                  <button onClick={() => setCitationRepairOpen(true)} type="button">
                    Review citation repairs
                  </button>
                  <button
                    disabled={citationRepairJobStarting || citationRepairJob?.status === 'running'}
                    onClick={() => void startBackgroundCitationRepair()}
                    type="button"
                  >
                    {citationRepairJobStarting
                      ? 'Starting…'
                      : citationRepairJob?.status === 'running'
                        ? 'Repair running'
                        : 'Repair all in background'}
                  </button>
                </div>
              </div>
              {citationRepairJob ? (
                <CitationRepairJobStatus
                  job={citationRepairJob}
                  totalIssueCount={report.findings.length + report.omittedFindings}
                />
              ) : null}
              {citationRepairJobError ? (
                <p className="activation-error" role="alert">
                  {citationRepairJobError}
                </p>
              ) : null}
            </>
          ) : null}
          {report.repositoryEvidence.state === 'unavailable' ? (
            <AttentionEmpty text="Repository evidence is unavailable for this project. Citation and relation repairs require a configured local checkout." />
          ) : null}
          {report.findings.length === 0 ? (
            <AttentionEmpty
              text={
                report.status === 'clean'
                  ? `No actionable context findings for ${props.project}.`
                  : 'No findings are visible because health coverage is incomplete.'
              }
            />
          ) : (
            <div className="attention-list health-record-list">
              {healthRecordGroups(report).map(group => (
                <article className="attention-card health-record" key={group.uri}>
                  <header>
                    <div>
                      <span className="attention-kicker">{group.preview?.kind ?? 'memory'} context</span>
                      <h3>{group.preview?.title ?? 'Memory needing review'}</h3>
                      {group.preview?.topic ? <p className="muted">{group.preview.topic}</p> : null}
                    </div>
                    <span className="attention-count">
                      {group.findings.length} issue{group.findings.length === 1 ? '' : 's'}
                    </span>
                  </header>
                  {group.preview?.excerpt ? <p className="health-memory-preview">{group.preview.excerpt}</p> : null}
                  <div className="health-record-actions">
                    <button onClick={() => props.onOpenLibrary(group.uri)} type="button">
                      Open memory
                    </button>
                  </div>
                  {group.preview?.code.map(code => (
                    <section className="health-code-preview" key={code.citationId}>
                      <header>
                        <strong>{code.targetLabel ?? code.path}</strong>
                        <span>
                          {code.path}
                          {code.line === undefined ? '' : `:${code.line}`}
                        </span>
                      </header>
                      {code.excerpt ? <pre>{code.excerpt}</pre> : <p>Review this finding to check source evidence.</p>}
                    </section>
                  ))}
                  <div className="health-issues">
                    {group.findings.map(finding => (
                      <section className="health-finding" key={finding.id}>
                        <header>
                          <strong>{contextHealthCategoryLabel(finding.category)}</strong>
                          <span className={`attention-state is-${finding.severity}`}>{finding.severity}</span>
                        </header>
                        <p>{contextHealthExplanation(finding.category)}</p>
                        <p>{contextHealthNextStep(finding.category)}</p>
                        <div className="attention-tags">
                          <span>{finding.confidence} confidence</span>
                          <span>{finding.repairability.replaceAll('-', ' ')}</span>
                        </div>
                        <button onClick={() => setSelected(finding)} type="button">
                          {report.repositoryEvidence.state === 'available' ? 'Review and repair' : 'Review issue'}
                        </button>
                      </section>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
          {nextCursor ? (
            <footer className="attention-footer">
              <button disabled={loadingMore} onClick={loadMore} type="button">
                {loadingMore ? 'Loading more findings…' : `Load ${report.remainingFindings ?? 'more'} findings`}
              </button>
            </footer>
          ) : null}
        </>
      ) : null}
      {selected ? (
        <HealthDetail
          key={`${props.project}:${selected.id}`}
          finding={selected}
          project={props.project}
          repairsAvailable={report?.repositoryEvidence.state === 'available'}
          onClose={() => setSelected(undefined)}
          onChanged={() => setGeneration(value => value + 1)}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : null}
      {citationRepairOpen ? (
        <CitationRepairDialog
          project={props.project}
          onChanged={() => setGeneration(value => value + 1)}
          onClose={() => setCitationRepairOpen(false)}
        />
      ) : null}
    </section>
  );
}

function healthRecordGroups(report: ManagerContextHealthResponseV1) {
  type Finding = ManagerContextHealthResponseV1['findings'][number];
  const previews = new Map((report.recordPreviews ?? []).map(preview => [preview.uri, preview] as const));
  const groups = new Map<string, Finding[]>();
  for (const finding of report.findings) {
    const uri = finding.repair.subjectUri ?? finding.uris[0] ?? finding.id;
    groups.set(uri, [...(groups.get(uri) ?? []), finding]);
  }
  return [...groups.entries()].map(([uri, findings]) => ({findings, preview: previews.get(uri), uri}));
}

function mergeHealthRecordPreviews(
  current: ManagerContextHealthResponseV1['recordPreviews'],
  next: ManagerContextHealthResponseV1['recordPreviews'],
) {
  const merged = new Map(current.map(preview => [preview.uri, preview] as const));
  for (const preview of next) {
    const prior = merged.get(preview.uri);
    merged.set(
      preview.uri,
      prior === undefined
        ? preview
        : {
            ...prior,
            code: [
              ...prior.code,
              ...preview.code.filter(
                item => !prior.code.some(currentItem => currentItem.citationId === item.citationId),
              ),
            ],
          },
    );
  }
  return [...merged.values()];
}

function CitationRepairJobStatus(props: {
  readonly job: ManagerCitationRepairJobV1;
  readonly totalIssueCount: number;
}): React.ReactElement {
  const {job} = props;
  const completedCountsAreCompatible =
    job.status === 'completed' && job.progress.unresolvedCount <= props.totalIssueCount;
  const otherIssueCount = completedCountsAreCompatible
    ? props.totalIssueCount - job.progress.unresolvedCount
    : undefined;
  const title =
    job.status === 'running'
      ? 'Repairing citations in background'
      : job.status === 'completed'
        ? 'Automatic citation repair finished'
        : 'Automatic citation repair stopped';
  return (
    <section aria-live="polite" className={`citation-repair-job is-${job.status}`} role="status">
      <header>
        <strong>{title}</strong>
        <span>{job.progress.phase.replaceAll('-', ' ')}</span>
      </header>
      <p>{job.progress.message}</p>
      {job.status === 'running' ? <progress aria-label="Background citation repair progress" /> : null}
      <div className="citation-repair-job-counts">
        <span>{job.progress.pagesScanned.toLocaleString()} pages scanned</span>
        {job.progress.initialCitationCount === undefined ? null : (
          <span>{job.progress.initialCitationCount.toLocaleString()} citation issues at start</span>
        )}
        {job.status === 'running' ? (
          <span>{job.progress.repairableCount.toLocaleString()} ready in this batch</span>
        ) : null}
        {job.status === 'completed' && job.progress.initialCitationCount !== undefined ? (
          <span>
            {Math.max(0, job.progress.initialCitationCount - job.progress.unresolvedCount).toLocaleString()} citation
            issues cleared
          </span>
        ) : null}
        <span>{job.progress.repairedCount.toLocaleString()} citation updates applied</span>
        <span>
          {job.progress.unresolvedCount.toLocaleString()}{' '}
          {job.status === 'failed'
            ? 'citation issues observed before stop'
            : job.status === 'running'
              ? 'citation issues seen in this pass'
              : 'citation issues remain'}
        </span>
        {job.progress.failedCount > 0 ? (
          <span>{job.progress.failedCount.toLocaleString()} conflicts retried</span>
        ) : null}
      </div>
      {completedCountsAreCompatible && otherIssueCount !== undefined ? (
        <small>
          Current health total: {job.progress.unresolvedCount.toLocaleString()} citation issue
          {job.progress.unresolvedCount === 1 ? '' : 's'} + {otherIssueCount.toLocaleString()} other issue
          {otherIssueCount === 1 ? '' : 's'} = {props.totalIssueCount.toLocaleString()} issues.
        </small>
      ) : job.status === 'completed' ? (
        <small>
          Current health reports {props.totalIssueCount.toLocaleString()} total issues. The backlog changed after this
          repair completed, so the citation breakdown is no longer exact.
        </small>
      ) : job.status === 'failed' ? (
        <small>
          Current health reports {props.totalIssueCount.toLocaleString()} total issues. The stopped scan is partial; run
          repair again to reconcile the backlog.
        </small>
      ) : null}
      {job.status === 'completed' && job.progress.repairedCount > 0 ? (
        <small>
          Issues cleared compares the full health scans before and after this run. Updates applied counts successful
          memory writes; one write is not necessarily one cleared issue.
        </small>
      ) : null}
      {job.status === 'running' ? (
        <small>You can close this browser window. The Manager service will keep the worker running.</small>
      ) : null}
      {job.warning ? <small>{job.warning}</small> : null}
      {job.error ? <small className="danger-text">{job.error}</small> : null}
    </section>
  );
}

function CitationRepairDialog(props: {
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly project: string;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<CitationRepairPreview>();
  const [result, setResult] = useState<CitationRepairApplyResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<CitationRepairProgress>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    dialogRef.current?.showModal();
    void loadPreview(false);
    return () => dialogRef.current?.close();
  }, []);
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function loadPreview(rebuild: boolean): Promise<void> {
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      if (rebuild) {
        setProgress({stage: 'rebuild'});
        await api('/api/context-health/citations/rebuild', {project: props.project});
      }
      setProgress({stage: 'scan'});
      setPreview(
        await api<CitationRepairPreview>('/api/context-health/citations/preview', {
          project: props.project,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setProgress(undefined);
      setBusy(false);
    }
  }

  async function applyAll(): Promise<void> {
    if (!preview || preview.items.length === 0) return;
    setBusy(true);
    setError('');
    setResult(undefined);
    const items = preview.items.map(item => ({
      category: item.category,
      citationId: item.citationId,
      findingId: item.findingId,
      proposalId: item.proposalId,
      replacementId: item.replacementId,
      revision: item.revision,
      subjectUri: item.subjectUri,
    }));
    const recordCount = new Set(items.map(item => item.subjectUri)).size;
    setProgress({
      appliedCount: 0,
      completedCount: 0,
      failedCount: 0,
      recordCount,
      stage: 'apply',
      totalCount: items.length,
    });
    try {
      const applied = await api<CitationRepairApplyResult>('/api/context-health/citations/apply', {
        approved: true,
        items,
        project: props.project,
      });
      setResult(applied);
      setProgress({
        appliedCount: applied.appliedCount,
        completedCount: items.length,
        failedCount: applied.failedCount,
        recordCount,
        stage: 'apply',
        totalCount: items.length,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setProgress(undefined);
      setBusy(false);
    }
  }

  function close(): void {
    if ((result?.appliedCount ?? 0) > 0) props.onChanged();
    props.onClose();
  }

  return (
    <dialog aria-label="Bulk citation repair" className="detail-modal" ref={dialogRef}>
      <header>
        <div>
          <p className="eyebrow">Code evidence</p>
          <h2>Repair citations</h2>
        </div>
        <button disabled={busy} onClick={close} type="button">
          Close
        </button>
      </header>
      <div className="detail-modal-body citation-repair-body">
        <p>
          Threadnote recaptures each stored code reference against an exact current graph. You review the paths and new
          source commit before any memory is changed.
        </p>
        {busy && progress ? <CitationRepairProgressView elapsedSeconds={elapsedSeconds} progress={progress} /> : null}
        {error ? (
          <p className="activation-error" role="alert">
            {error}
          </p>
        ) : null}
        {preview ? (
          <>
            <div className="attention-metrics citation-repair-metrics">
              <Metric label="Ready to repair" value={preview.repairableCount.toLocaleString()} />
              <Metric label="Need graph evidence" value={preview.requiresGraphCount.toLocaleString()} />
            </div>
            {preview.items.length > 0 ? (
              <div className="citation-repair-list">
                {citationRepairGroups(preview.items).map(group => (
                  <article key={group.subjectUri}>
                    <strong>{group.title}</strong>
                    {group.excerpt ? <p>{group.excerpt}</p> : null}
                    <span>
                      {group.items.length} citation{group.items.length === 1 ? '' : 's'} ready in this memory
                    </span>
                    <ul>
                      {group.items.map(item => (
                        <li key={`${item.findingId}:${item.replacementId}`}>
                          <code>{item.path}</code>
                          <span>
                            {item.targetKind} · {item.category.replaceAll('-', ' ')} · commit{' '}
                            <code>{item.sourceCommit.slice(0, 12)}</code>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            ) : (
              <p>No citation can be recaptured from the current graph yet.</p>
            )}
            {preview.truncated ? (
              <p>This is a bounded batch. Apply it, then preview again for remaining findings.</p>
            ) : null}
          </>
        ) : null}
        {result ? (
          <p role="status">
            Repaired {result.appliedCount} citation{result.appliedCount === 1 ? '' : 's'}.
            {result.failedCount > 0 ? ` ${result.failedCount} need another preview.` : ''}
          </p>
        ) : null}
        <footer>
          <button disabled={busy} onClick={() => void loadPreview(true)} type="button">
            {busy && progress?.stage !== 'apply' ? 'Working…' : 'Rebuild project graph and retry'}
          </button>
          <button
            disabled={busy || !preview || preview.items.length === 0}
            onClick={() => void applyAll()}
            type="button"
          >
            {busy && progress?.stage === 'apply'
              ? `Applying ${progress.completedCount}/${progress.totalCount}…`
              : preview
                ? `Apply ${preview.items.length} citation repair${preview.items.length === 1 ? '' : 's'}`
                : 'Apply repairs'}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function citationRepairGroups(items: CitationRepairPreview['items']) {
  const groups = new Map<string, CitationRepairPreview['items'][number][]>();
  for (const item of items) groups.set(item.subjectUri, [...(groups.get(item.subjectUri) ?? []), item]);
  return [...groups.entries()].map(([subjectUri, groupItems]) => ({
    excerpt: groupItems[0]?.subjectExcerpt,
    items: groupItems,
    subjectUri,
    title: groupItems[0]?.subjectTitle ?? memoryNameFromUri(subjectUri),
  }));
}

function memoryNameFromUri(uri: string): string {
  return (
    uri
      .slice(uri.lastIndexOf('/') + 1)
      .replace(/\.md$/u, '')
      .replaceAll('-', ' ') || 'Affected memory'
  );
}

function CitationRepairProgressView(props: {
  readonly elapsedSeconds: number;
  readonly progress: CitationRepairProgress;
}): React.ReactElement {
  const progress = props.progress;
  if (progress.stage === 'apply') {
    return (
      <section className="citation-repair-progress" role="status">
        <progress
          aria-label="Citation repair apply progress"
          max={progress.totalCount}
          value={progress.completedCount}
        />
        <div>
          <strong>
            Applying citation repairs · {progress.completedCount} of {progress.totalCount}
          </strong>
          <p>
            {progress.recordCount} affected memories are verified and each is written once. {props.elapsedSeconds}s
            elapsed
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="citation-repair-progress" role="status">
      <progress
        aria-label="Citation repair preview progress"
        max={1}
        value={progress.stage === 'rebuild' ? 0 : undefined}
      />
      <div>
        <strong>
          {progress.stage === 'rebuild'
            ? 'Rebuilding the project graph'
            : 'Matching stored citations against the current project graph'}
        </strong>
        <p>
          {progress.stage === 'rebuild'
            ? 'Refreshing source evidence before citation matching.'
            : 'Collecting all citation issues once and preparing one update per affected memory.'}{' '}
          {props.elapsedSeconds}s elapsed
        </p>
      </div>
    </section>
  );
}

function contextHealthExplanation(category: ManagerContextHealthResponseV1['findings'][number]['category']): string {
  switch (category) {
    case 'citation-changed':
      return 'The source code cited by this memory has changed, so its guidance may no longer match the code.';
    case 'relation-target-missing':
      return 'This memory points to another memory that is no longer available, so its supporting context is incomplete.';
    default:
      return 'Review the affected memory and the suggested repair before changing durable project context.';
  }
}

function contextHealthNextStep(category: ManagerContextHealthResponseV1['findings'][number]['category']): string {
  switch (category) {
    case 'citation-changed':
      return 'Compare the memory with the current source excerpt, then recapture the code reference if the guidance is still correct.';
    case 'citation-missing':
      return 'Review the memory and choose a current file or symbol to replace the missing code reference.';
    case 'citation-unknown':
      return 'Refresh graph evidence, then review the current source before attaching a replacement code reference.';
    case 'relation-target-missing':
      return 'Review the source memory, then remove the broken relation or link it to a current memory.';
    case 'relation-target-inactive':
      return 'Review whether the relation should point to an active memory or be removed.';
    case 'relation-target-conflicted':
      return 'Resolve the related memory conflict before keeping or replacing this relation.';
    case 'exact-duplicate':
      return 'Compare the memories and keep one current copy.';
    case 'validity-expired':
      return 'Confirm whether the memory is still current, then update or archive it.';
    case 'review-overdue':
      return 'Review the memory now and record whether it remains current.';
    case 'candidate-contradiction':
    case 'candidate-possible-duplicate':
      return 'Compare the proposed knowledge with the current memory before accepting or rejecting it.';
    case 'semantic-contradiction':
      return 'Compare the conflicting memories and update the one that no longer reflects the current decision.';
    case 'guidance-locally-modified':
    case 'guidance-missing-block':
    case 'guidance-stale-sources':
    case 'guidance-unavailable':
      return 'Review the project guidance source and refresh its managed memory after correcting the mismatch.';
  }
}

function contextHealthCategoryLabel(category: ManagerContextHealthResponseV1['findings'][number]['category']): string {
  return category
    .split('-')
    .map(word => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function AttentionHeader(props: {
  readonly eyebrow: string;
  readonly onProjectChange: (project: string) => void;
  readonly project: string;
  readonly projects: readonly string[];
  readonly summary: string;
  readonly title: string;
}): React.ReactElement {
  return (
    <header className="attention-header">
      <div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h2>{props.title}</h2>
        <p>{props.summary}</p>
      </div>
      <label>
        Project
        <select onChange={event => props.onProjectChange(event.target.value)} value={props.project}>
          <option value="">Select project</option>
          {props.projects.map(project => (
            <option key={project}>{project}</option>
          ))}
        </select>
      </label>
    </header>
  );
}

function AttentionEmpty(props: {readonly text: string}): React.ReactElement {
  return <div className="attention-empty">{props.text}</div>;
}

function AttentionError(props: {readonly error: string}): React.ReactElement {
  return (
    <div className="attention-empty is-error" role="alert">
      {props.error}
    </div>
  );
}

function Metric(props: {readonly label: string; readonly value: string}): React.ReactElement {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
