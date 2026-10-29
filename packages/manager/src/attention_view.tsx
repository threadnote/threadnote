import {
  isCitationRepairApplyResult,
  isCitationRepairPreview,
  isManagerCitationRepairJobResponseV1,
  isManagerContextHealthResponseV1,
  isManagerReviewInboxResponseV1,
} from './api/response_guards.js';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ManagerResponseContractError} from './api/response_guard.js';
import {MarkdownViewer} from './ui/controls.js';
import {Sparkles} from 'lucide-react';
import {Schema} from 'effect';
import {MemoryExcerpt, ReviewBadge} from './review_presentation.js';
import {ReviewProgress} from './review_progress.js';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {
  ManagerCitationRepairJobResponseV1,
  ManagerCitationRepairJobV1,
  ManagerContextHealthResponseV1,
  ManagerReviewInboxResponseV1,
} from '@threadnote/manager/attention/contracts';
import {ContextMaintenanceView} from './attention/maintenance_view.js';
import {TopicReviewDialog} from './attention/topic_review.js';
import {AutomaticMemoryReviewDialog} from './attention/automatic_review.js';
import {ReviewDetail, HealthDetail} from './attention_details.js';
import {api, errorMessage, ManagerApiError} from '@threadnote/manager/ui/support';
import {useManagerLiveQuery, useManagerLiveResource} from './live/provider.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface AttentionPanelProps {
  readonly onOpenLibrary: (uri?: string) => void;
  readonly onProjectChange: (project: string) => void;
  readonly project: string;
  readonly projects: readonly string[];
  readonly refreshGeneration: number;
  readonly onDecisionCountChange?: (project: string, count: number | undefined) => void;
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
  const [view, setView] = useState<'pending' | 'deferred' | 'history'>('pending');
  const [selected, setSelected] = useState<{
    reviewId: string;
    candidateId: string;
    project: string;
    kind?: 'topic-maintenance' | 'automatic-memory';
    view: 'pending' | 'deferred' | 'history';
  }>();
  const [generation, setGeneration] = useState(0);
  const scope = JSON.stringify([props.project, view]);
  const [storedInbox, setInbox] = useState<{scope: string; value: ManagerReviewInboxResponseV1}>();
  const inbox = storedInbox?.scope === scope ? storedInbox.value : undefined;
  const returnFocus = useRef<{reviewId: string; candidateId: string} | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const live = useManagerLiveQuery<ManagerReviewInboxResponseV1>(
    props.project ? {topic: 'automatic-memory', project: props.project} : {topic: 'home', scope: 'account'},
    `reviews:${view}`,
    signal =>
      api<ManagerReviewInboxResponseV1>(
        `/api/reviews?project=${encodeURIComponent(props.project)}&view=${view}`,
        undefined,
        {signal, timeoutMilliseconds: 8_000},
        isManagerReviewInboxResponseV1,
      ),
    isManagerReviewInboxResponseV1,
  );
  const fallback = !live.active || live.snapshot.status === 'unsupported';
  useEffect(() => {
    const next = inbox?.background?.nextRetryAt;
    if (!fallback || next === undefined || !Number.isFinite(next)) return;
    let due = false;
    const retry = () => {
      due = true;
      if (!document.hidden) {
        due = false;
        setGeneration(value => value + 1);
      }
    };
    const visible = () => {
      if (due && !document.hidden) retry();
    };
    const timer = window.setTimeout(retry, Math.max(25, next - Date.now()));
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [fallback, inbox?.background?.nextRetryAt, scope]);
  useEffect(() => {
    if (fallback) return;
    if (live.snapshot.status === 'ready') {
      const result = live.snapshot.data;
      if (result.version === 1 && result.project === props.project && EffectArray.isArray(result.items)) {
        setInbox({scope, value: result});
        setError('');
        setLoading(false);
      } else {
        setInbox(undefined);
        setSelected(undefined);
        setError('The review inbox does not match this selection. Refresh Manager.');
      }
    } else if (live.snapshot.status === 'error') {
      if (attentionReadRequiresRedaction(live.snapshot.error)) {
        setInbox(undefined);
        setSelected(undefined);
      }
      setError(errorMessage(live.snapshot.error));
      setLoading(false);
    } else setLoading(true);
  }, [fallback, live.snapshot, scope, props.project]);
  useEffect(() => {
    setSelected(undefined);
    setNotice('');
    setError('');
  }, [props.project, view]);
  useEffect(() => {
    if (selected || !returnFocus.current) return;
    const target = returnFocus.current;
    const button = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button[data-review-id]')],
        item => item.dataset.reviewId === target.reviewId && item.dataset.candidateId === target.candidateId,
      ),
    );
    if (button) {
      button.focus();
      returnFocus.current = undefined;
    }
  }, [selected, inbox]);
  useEffect(() => {
    if (!fallback) {
      live.invalidate();
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    void api<ManagerReviewInboxResponseV1>(
      `/api/reviews?project=${encodeURIComponent(props.project)}&view=${view}`,
      undefined,
      {signal: controller.signal, timeoutMilliseconds: 8_000},
      isManagerReviewInboxResponseV1,
    )
      .then(result => {
        if (cancelled) return;
        if (!result || result.version !== 1 || result.project !== props.project || !EffectArray.isArray(result.items)) {
          throw ManagerApiError.of('The review inbox does not match this selection. Refresh Manager.', 409);
        }
        setInbox({scope, value: result});
        setError('');
      })
      .catch(cause => {
        if (!cancelled) {
          if (attentionReadRequiresRedaction(cause)) {
            setInbox(undefined);
            setSelected(undefined);
          }
          setError(
            Schema.is(ManagerResponseContractError)(cause)
              ? 'The review inbox does not match this selection. Refresh Manager.'
              : errorMessage(cause),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.project, props.refreshGeneration, generation, view, fallback]);
  const activeSelection =
    selected && selected.view === view && (!props.project || selected.project === props.project) ? selected : undefined;

  return (
    <section aria-busy={loading} className="panel attention-panel is-active">
      {notice ? <p role="status">{notice}</p> : null}
      <div className="workspace-tabs" role="tablist" aria-label="Review sections">
        {EffectArray.map(['pending', 'deferred', 'history'] as const, value => (
          <button
            key={value}
            role="tab"
            aria-selected={view === value}
            className={view === value ? 'is-active' : undefined}
            onClick={() => setView(value)}
          >
            {Effect.pipe(value, __effectPipeInput => {
              const __effectPipeStage0 = Effect.pipe(
                __effectPipeInput,
                EffectString.charAt(0),
                Effect.Option.getOrElse(() => ''),
              );
              const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.toUpperCase);
              return __effectPipeStage1;
            }) + Effect.pipe(value, EffectString.slice(1))}
          </button>
        ))}
      </div>
      {view === 'pending' &&
      inbox?.background &&
      (inbox.background.assessments > 0 || inbox.background.awaitingSources > 0 || inbox.background.obsolete > 0) ? (
        <div className="review-notice" role="status">
          <p>
            {inbox.background.assessments} background assessments · {inbox.background.awaitingSources} updates waiting
            for source verification.
          </p>
          <p>
            Assessments and unavailable sources are checked automatically as evidence changes. No review or discard is
            required.
          </p>
          {inbox.background.obsolete > 0 ? (
            <p>{inbox.background.obsolete} obsolete generated reviews are retained in History.</p>
          ) : null}
        </div>
      ) : null}
      <div className="attention-refresh-status" style={{blockSize: '3.5rem', overflowY: 'auto'}}>
        {error ? (
          <div role="alert">
            {error}
            <button type="button" onClick={() => setGeneration(value => value + 1)}>
              Retry loading reviews
            </button>
          </div>
        ) : inbox && loading ? (
          <p role="status">Checking for review updates…</p>
        ) : null}
      </div>
      {!inbox && loading ? (
        <ReviewProgress
          title="Loading the review inbox…"
          description="Loading saved review summaries. You can switch tabs while this loads."
        />
      ) : !inbox && error ? null : !inbox || inbox.items.length === 0 ? (
        <AttentionEmpty
          text={
            view === 'pending'
              ? `No knowledge reviews need attention for ${props.project || 'all projects'}.`
              : `No ${view === 'history' ? 'completed' : 'deferred'} reviews for ${props.project || 'all projects'}.`
          }
        />
      ) : (
        <div className="attention-list">
          {EffectArray.map(inbox.items, review => (
            <article className="attention-card" key={review.reviewId}>
              <header>
                <div>
                  <span className="attention-kicker">
                    {!props.project ? `${review.project} · ` : ''}
                    {review.topic || 'Untitled review'}
                  </span>
                  <h3>{review.task}</h3>
                </div>
                <ReviewBadge tone="proposal">
                  {review.queueStatus ? (
                    review.queueStatus === 'assessment' ? (
                      'Background assessment'
                    ) : (
                      'Obsolete review'
                    )
                  ) : (
                    <>
                      <Sparkles size={12} aria-hidden="true" /> {review.candidates.length}{' '}
                      {review.candidates.length === 1 ? 'proposal' : 'proposals'}
                    </>
                  )}
                </ReviewBadge>
              </header>
              <p className="muted">
                Created {new Date(review.createdAt).toLocaleString()} · revision {review.revision}
              </p>
              <div className="attention-candidates">
                {EffectArray.map(review.candidates, candidate => (
                  <section key={candidate.candidateId}>
                    <div className="attention-tags">
                      <ReviewBadge
                        tone={
                          candidate.state === 'conflict'
                            ? 'danger'
                            : candidate.state === 'pending'
                              ? 'warning'
                              : candidate.state === 'applied'
                                ? 'proposal'
                                : 'neutral'
                        }
                      >
                        {review.queueStatus ?? candidate.state}
                      </ReviewBadge>
                      {!review.kind ? (
                        <>
                          <span>{Effect.pipe(candidate.recommendation, EffectString.replaceAll('_', ' '))}</span>
                          <span>{Math.round(candidate.confidence * 100)}% confidence</span>
                        </>
                      ) : null}
                    </div>
                    {review.kind ? (
                      <p>Compare the accepted memory, its proposed update, and the current source before deciding.</p>
                    ) : (
                      <div className="review-proposal-preview">
                        <div className="review-content-label">
                          <Sparkles size={14} aria-hidden="true" /> Proposed memory
                        </div>
                        <MarkdownViewer markdown={candidate.proposedText} />
                      </div>
                    )}
                    <button
                      className="attention-review-button"
                      data-review-id={review.reviewId}
                      data-candidate-id={candidate.candidateId}
                      onClick={() =>
                        setSelected({
                          reviewId: review.reviewId,
                          candidateId: candidate.candidateId,
                          project: review.project,
                          kind: review.kind,
                          view,
                        })
                      }
                      type="button"
                    >
                      <strong>
                        {view === 'history'
                          ? 'View review details →'
                          : review.kind === 'automatic-memory'
                            ? 'Review update →'
                            : 'Review and decide →'}
                      </strong>
                    </button>
                    <p className="muted">{candidate.reason}</p>
                    {candidate.targetUri && !review.kind ? <code>{candidate.targetUri}</code> : null}
                  </section>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      {inbox && inbox.items.length > 0 && view !== 'history' ? (
        <footer className="attention-footer">
          <p>Open a proposal to read it in full and approve, defer, or reject it.</p>
          <button onClick={() => props.onOpenLibrary()} type="button">
            Browse related memories
          </button>
        </footer>
      ) : null}
      {activeSelection?.kind === 'automatic-memory' ? (
        <AutomaticMemoryReviewDialog
          onOpenMemory={props.onOpenLibrary}
          key={`${activeSelection.project}:${activeSelection.reviewId}`}
          project={activeSelection.project}
          reviewId={activeSelection.reviewId}
          onClose={() => setSelected(undefined)}
          onChanged={() => setGeneration(value => value + 1)}
          onApplied={() => {
            setNotice('Memory update saved and verified.');
            setSelected(undefined);
            setGeneration(value => value + 1);
          }}
        />
      ) : activeSelection?.kind === 'topic-maintenance' ? (
        <TopicReviewDialog
          key={`${activeSelection.project}:${activeSelection.reviewId}`}
          project={activeSelection.project}
          reviewId={activeSelection.reviewId}
          onClose={() => {
            returnFocus.current = activeSelection;
            setSelected(undefined);
          }}
          onChanged={() => setGeneration(value => value + 1)}
          onApplied={() => setNotice('Topic update saved and verified.')}
          onOpenLibrary={uri => props.onOpenLibrary(uri)}
        />
      ) : activeSelection ? (
        <ReviewDetail
          key={`${activeSelection.project}:${activeSelection.reviewId}:${activeSelection.candidateId}`}
          {...activeSelection}
          onClose={() => {
            returnFocus.current = activeSelection;
            setSelected(undefined);
          }}
          onChanged={() => setGeneration(value => value + 1)}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : null}
    </section>
  );
}

export function ContextHealthPanel(props: AttentionPanelProps): React.ReactElement {
  const readHealth = useCallback(
    (signal: AbortSignal) =>
      api<ManagerContextHealthResponseV1>(
        `/api/context-health?project=${encodeURIComponent(props.project)}`,
        undefined,
        {signal, timeoutMilliseconds: 8_000},
        isManagerContextHealthResponseV1,
      ),
    [props.project],
  );
  const live = useManagerLiveResource('context-health', props.project, readHealth, isManagerContextHealthResponseV1);
  const legacyHealth = !live.active || live.snapshot.status === 'unsupported';
  const [selected, setSelected] = useState<ManagerContextHealthResponseV1['findings'][number]>();
  const [generation, setGeneration] = useState(0);
  const requestEpoch = useRef(0);
  const requestController = useRef<AbortController | undefined>(undefined);
  const [storedReport, setReport] = useState<ManagerContextHealthResponseV1>();
  const liveReadInvalid =
    !legacyHealth &&
    ((live.snapshot.status === 'error' && attentionReadRequiresRedaction(live.snapshot.error)) ||
      (live.snapshot.status === 'ready' && !validHealthReport(live.snapshot.data, props.project)));
  const report = storedReport?.project === props.project && !liveReadInvalid ? storedReport : undefined;
  const [nextCursor, setNextCursor] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fallbackFreshProject, setFallbackFreshProject] = useState<string>();
  const healthUnconfirmed =
    loading || !!error || (live.active && live.snapshot.status !== 'ready' && fallbackFreshProject !== props.project);
  const [citationRepairOpen, setCitationRepairOpen] = useState(false);
  const [citationRepairJob, setCitationRepairJob] = useState<ManagerCitationRepairJobV1>();
  const [citationRepairJobError, setCitationRepairJobError] = useState('');
  const [citationRepairJobGeneration, setCitationRepairJobGeneration] = useState(0);
  const [citationRepairJobStarting, setCitationRepairJobStarting] = useState(false);
  const citationLive = useManagerLiveQuery<ManagerCitationRepairJobResponseV1>(
    props.project && report !== undefined && report.maintenance === undefined
      ? {topic: 'citation-repair-jobs', project: props.project}
      : undefined,
    'jobs',
    signal =>
      api<ManagerCitationRepairJobResponseV1>(
        `/api/context-health/citations/jobs?project=${encodeURIComponent(props.project)}`,
        undefined,
        {signal},
        isManagerCitationRepairJobResponseV1,
      ),
    isManagerCitationRepairJobResponseV1,
  );
  const citationFallback = !citationLive.active || citationLive.snapshot.status === 'unsupported';
  const activeCitationRepairJobId = useRef<string | undefined>(undefined);
  const citationRepairJobProjectEpoch = useRef(0);
  const citationRepairJobProject = useRef('');
  const refreshedCitationRepairJobId = useRef<string | undefined>(undefined);
  const liveRefresh = useRef({project: props.project, external: props.refreshGeneration, local: generation});
  useEffect(() => {
    if (!citationFallback && citationLive.snapshot.status === 'ready') {
      const next = citationLive.snapshot.data.job;
      setCitationRepairJob(next ?? undefined);
      setCitationRepairJobError('');
      if (next?.status === 'running') activeCitationRepairJobId.current = next.id;
      else if (
        next &&
        activeCitationRepairJobId.current === next.id &&
        refreshedCitationRepairJobId.current !== next.id
      ) {
        activeCitationRepairJobId.current = undefined;
        refreshedCitationRepairJobId.current = next.id;
        setGeneration(value => value + 1);
      }
    } else if (!citationFallback && citationLive.snapshot.status === 'error') {
      setCitationRepairJobError(errorMessage(citationLive.snapshot.error));
    }
  }, [citationFallback, citationLive.snapshot]);
  useEffect(() => {
    if (!citationFallback) citationLive.invalidate();
  }, [citationRepairJobGeneration]);
  useEffect(() => {
    requestEpoch.current += 1;
    requestController.current?.abort();
    setSelected(undefined);
    setCitationRepairOpen(false);
    setReport(undefined);
    setNextCursor(undefined);
    setError('');
    setLoading(false);
    setLoadingMore(false);
    setFallbackFreshProject(undefined);
  }, [props.project]);
  useEffect(() => {
    setFallbackFreshProject(undefined);
  }, [legacyHealth, props.project]);
  useEffect(() => {
    if (!legacyHealth) return;
    requestEpoch.current += 1;
    if (!props.project) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    requestController.current = controller;
    setLoadingMore(false);
    const poll = () => {
      requestEpoch.current += 1;
      setLoading(true);
      setFallbackFreshProject(undefined);
      setLoadingMore(false);
      void readHealth(controller.signal)
        .then(result => {
          if (!cancelled) {
            if (!validHealthReport(result, props.project)) {
              throw ManagerApiError.of('Context health does not match this project. Refresh Manager.', 409);
            }
            setReport(result);
            setNextCursor(result.nextCursor);
            setFallbackFreshProject(props.project);
            setError('');
          }
        })
        .catch(cause => {
          if (!cancelled) {
            if (attentionReadRequiresRedaction(cause)) {
              setReport(undefined);
              setSelected(undefined);
              setCitationRepairOpen(false);
              setNextCursor(undefined);
            }
            setFallbackFreshProject(undefined);
            setError(contextHealthReadErrorMessage(cause));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            timer = window.setTimeout(poll, 30_000);
          }
        });
    };
    let timer: number | undefined;
    poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.project, props.refreshGeneration, generation, legacyHealth, readHealth]);
  useEffect(() => {
    if (legacyHealth || live.snapshot.status !== 'ready') return;
    if (!validHealthReport(live.snapshot.data, props.project)) {
      setReport(undefined);
      setSelected(undefined);
      setCitationRepairOpen(false);
      setNextCursor(undefined);
      setError('Context health does not match this project. Refresh Manager.');
      setLoading(false);
      return;
    }
    requestEpoch.current += 1;
    requestController.current?.abort();
    requestController.current = new AbortController();
    setReport(live.snapshot.data);
    setNextCursor(live.snapshot.data.nextCursor);
    setError('');
    setLoading(false);
    setLoadingMore(false);
  }, [legacyHealth, live.snapshot, props.project]);
  useEffect(() => {
    if (legacyHealth) return;
    if (live.snapshot.status === 'error') {
      if (attentionReadRequiresRedaction(live.snapshot.error)) {
        setReport(undefined);
        setSelected(undefined);
        setCitationRepairOpen(false);
        setNextCursor(undefined);
      }
      setError(errorMessage(live.snapshot.error));
      setLoading(false);
    } else if (live.snapshot.status === 'loading' || live.snapshot.status === 'stale') {
      setLoading(true);
    }
  }, [legacyHealth, live.snapshot, report]);
  useEffect(() => {
    const previous = liveRefresh.current;
    liveRefresh.current = {project: props.project, external: props.refreshGeneration, local: generation};
    if (
      previous.project === props.project &&
      previous.external === props.refreshGeneration &&
      previous.local === generation
    )
      return;
    if (previous.project === props.project && !legacyHealth) live.invalidate();
  }, [props.project, props.refreshGeneration, generation, legacyHealth]);

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
    if (!citationFallback) return;
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
          undefined,
          undefined,
          isManagerCitationRepairJobResponseV1,
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
  }, [
    props.project,
    citationRepairJobGeneration,
    report !== undefined,
    report?.maintenance !== undefined,
    citationFallback,
  ]);

  function loadMore(): void {
    if (!nextCursor || loadingMore || loading || error) return;
    const epoch = requestEpoch.current;
    setLoadingMore(true);
    void api<ManagerContextHealthResponseV1>(
      `/api/context-health?project=${encodeURIComponent(props.project)}&after=${encodeURIComponent(nextCursor)}`,
      undefined,
      {signal: requestController.current?.signal, timeoutMilliseconds: 8_000},
      isManagerContextHealthResponseV1,
    )
      .then(next => {
        if (epoch !== requestEpoch.current) return;
        if (!validHealthReport(next, props.project)) {
          throw ManagerApiError.of('Context health does not match this project. Refresh Manager.', 409);
        }
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
        setError('');
      })
      .catch(cause => {
        if (epoch === requestEpoch.current) {
          if (attentionReadRequiresRedaction(cause)) {
            setReport(undefined);
            setSelected(undefined);
            setCitationRepairOpen(false);
            setNextCursor(undefined);
          }
          setError(contextHealthReadErrorMessage(cause));
        }
      })
      .finally(() => {
        if (epoch === requestEpoch.current) setLoadingMore(false);
      });
  }

  async function startBackgroundCitationRepair(): Promise<void> {
    if (!props.project || healthUnconfirmed || citationRepairJobStarting || citationRepairJob?.status === 'running')
      return;
    const project = props.project;
    const projectEpoch = citationRepairJobProjectEpoch.current;
    setCitationRepairJobStarting(true);
    setCitationRepairJobError('');
    try {
      const response = await api<ManagerCitationRepairJobResponseV1>(
        '/api/context-health/citations/jobs',
        {
          project,
        },
        undefined,
        isManagerCitationRepairJobResponseV1,
      );
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

  if (!props.project) {
    return (
      <section className="panel attention-panel is-active">
        <AttentionHeader
          eyebrow="Memory quality"
          onProjectChange={props.onProjectChange}
          project=""
          projects={props.projects}
          summary="Inspect context health within each project’s repository evidence."
          title="Context health across projects"
        />
        <p className="muted">
          Health checks and repairs are scoped to one project. Choose a project to see its current findings and
          maintenance status.
        </p>
        {props.projects.length === 0 ? (
          <AttentionEmpty text="No projects are available yet. Save a project memory or configure a repository to get started." />
        ) : (
          <div className="health-project-grid">
            {EffectArray.map(props.projects, project => (
              <button
                aria-label={`Inspect ${project}`}
                className="health-project-tile"
                key={project}
                onClick={() => props.onProjectChange(project)}
                type="button"
              >
                <strong>{project}</strong>
                <span>
                  View context health <span aria-hidden="true">→</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    );
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
        onDecisionCountChange={props.onDecisionCountChange}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        reportError={error}
        onRefresh={() => setGeneration(value => value + 1)}
        healthLiveStale={healthUnconfirmed}
        healthLegacy={legacyHealth}
        healthFallback={live.active && legacyHealth && fallbackFreshProject === props.project}
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
      <div className="attention-refresh-status" style={{blockSize: '3.5rem', overflowY: 'auto'}}>
        {error ? (
          <p role="alert">
            {error}{' '}
            <button type="button" onClick={() => setGeneration(value => value + 1)}>
              Retry checking context
            </button>
          </p>
        ) : report && loading ? (
          <p role="status">Checking for context updates…</p>
        ) : null}
      </div>
      {!report && loading ? (
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
          (EffectArray.some(report.findings, finding => finding.repair.kind === 'repair-citation') ||
            citationRepairJob) ? (
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
                    disabled={healthUnconfirmed || citationRepairJobStarting || citationRepairJob?.status === 'running'}
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
              {EffectArray.map(healthRecordGroups(report), group => (
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
                  {group.preview?.excerpt ? (
                    <MemoryExcerpt label="Saved memory">{group.preview.excerpt}</MemoryExcerpt>
                  ) : null}
                  <div className="health-record-actions">
                    <button onClick={() => props.onOpenLibrary(group.uri)} type="button">
                      Open memory
                    </button>
                  </div>
                  {EffectOption.getOrUndefined(
                    EffectOption.map(EffectOption.fromNullishOr(group.preview?.code), __effectArrayReceiver =>
                      EffectArray.map(__effectArrayReceiver, code => (
                        <section className="health-code-preview" key={code.citationId}>
                          <header>
                            <strong>{code.targetLabel ?? code.path}</strong>
                            <span>
                              {code.path}
                              {code.line === undefined ? '' : `:${code.line}`}
                            </span>
                          </header>
                          {code.excerpt ? (
                            <pre>{code.excerpt}</pre>
                          ) : (
                            <p>Review this finding to check source evidence.</p>
                          )}
                        </section>
                      )),
                    ),
                  )}
                  <div className="health-issues">
                    {EffectArray.map(group.findings, finding => (
                      <section className="health-finding" key={finding.id}>
                        <header>
                          <strong>{contextHealthCategoryLabel(finding.category)}</strong>
                          <span className={`attention-state is-${finding.severity}`}>{finding.severity}</span>
                        </header>
                        <p>{contextHealthExplanation(finding.category)}</p>
                        <p>{contextHealthNextStep(finding.category)}</p>
                        <div className="attention-tags">
                          <span>{finding.confidence} confidence</span>
                          <span>{Effect.pipe(finding.repairability, EffectString.replaceAll('-', ' '))}</span>
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
              <button disabled={loadingMore || healthUnconfirmed} onClick={loadMore} type="button">
                {loadingMore ? 'Loading more findings…' : `Load ${report.remainingFindings ?? 'more'} findings`}
              </button>
            </footer>
          ) : null}
        </>
      ) : null}
      {selected && report ? (
        <HealthDetail
          key={`${props.project}:${selected.id}`}
          finding={selected}
          memoryPreview={EffectOption.getOrUndefined(
            EffectOption.flatMap(EffectOption.fromNullishOr(report?.recordPreviews), __effectOptionalArrayReceiver =>
              EffectArray.findFirst(
                __effectOptionalArrayReceiver,
                preview => preview.uri === selected.repair.subjectUri,
              ),
            ),
          )}
          project={props.project}
          repairsAvailable={report?.repositoryEvidence.state === 'available'}
          stale={
            healthUnconfirmed ||
            (live.active && live.snapshot.status !== 'ready' && fallbackFreshProject !== props.project) ||
            JSON.stringify(
              EffectOption.getOrUndefined(EffectArray.findFirst(report.findings, item => item.id === selected.id)),
            ) !== JSON.stringify(selected)
          }
          onClose={() => setSelected(undefined)}
          onChanged={() => setGeneration(value => value + 1)}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : null}
      {citationRepairOpen && report ? (
        <CitationRepairDialog
          project={props.project}
          stale={healthUnconfirmed}
          onChanged={() => setGeneration(value => value + 1)}
          onClose={() => setCitationRepairOpen(false)}
        />
      ) : null}
    </section>
  );
}

function contextHealthReadErrorMessage(cause: unknown): string {
  return Schema.is(ManagerResponseContractError)(cause)
    ? 'Context health does not match this project. Refresh Manager.'
    : errorMessage(cause);
}

function attentionReadRequiresRedaction(cause: unknown): boolean {
  return (
    Schema.is(ManagerResponseContractError)(cause) ||
    (Schema.is(ManagerApiError)(cause) && [400, 401, 403, 404, 409, 410].includes(cause.status))
  );
}

function validHealthReport(result: ManagerContextHealthResponseV1, project: string): boolean {
  return (
    !!result &&
    result.version === 1 &&
    result.project === project &&
    EffectArray.isArray(result.findings) &&
    EffectArray.isArray(result.recordPreviews)
  );
}

function healthRecordGroups(report: ManagerContextHealthResponseV1) {
  type Finding = ManagerContextHealthResponseV1['findings'][number];
  const previews = new Map(EffectArray.map(report.recordPreviews ?? [], preview => [preview.uri, preview] as const));
  const groups = new Map<string, Finding[]>();
  for (const finding of report.findings) {
    const uri = finding.repair.subjectUri ?? finding.uris[0] ?? finding.id;
    groups.set(uri, [...(groups.get(uri) ?? []), finding]);
  }
  return EffectArray.map([...groups.entries()], ([uri, findings]) => ({findings, preview: previews.get(uri), uri}));
}

function mergeHealthRecordPreviews(
  current: ManagerContextHealthResponseV1['recordPreviews'],
  next: ManagerContextHealthResponseV1['recordPreviews'],
) {
  const merged = new Map(EffectArray.map(current, preview => [preview.uri, preview] as const));
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
              ...EffectArray.filter(
                preview.code,
                item => !EffectArray.some(prior.code, currentItem => currentItem.citationId === item.citationId),
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
        <span>{Effect.pipe(job.progress.phase, EffectString.replaceAll('-', ' '))}</span>
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
  readonly stale?: boolean;
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
    if (rebuild && props.stale) return;
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
        await api<CitationRepairPreview>(
          '/api/context-health/citations/preview',
          {
            project: props.project,
          },
          undefined,
          isCitationRepairPreview,
        ),
      );
    } catch (cause) {
      setError(contextHealthReadErrorMessage(cause));
    } finally {
      setProgress(undefined);
      setBusy(false);
    }
  }

  async function applyAll(): Promise<void> {
    if (props.stale || !preview || preview.items.length === 0) return;
    setBusy(true);
    setError('');
    setResult(undefined);
    const items = EffectArray.map(preview.items, item => ({
      category: item.category,
      citationId: item.citationId,
      findingId: item.findingId,
      proposalId: item.proposalId,
      replacementId: item.replacementId,
      revision: item.revision,
      subjectUri: item.subjectUri,
    }));
    const recordCount = new Set(EffectArray.map(items, item => item.subjectUri)).size;
    setProgress({
      appliedCount: 0,
      completedCount: 0,
      failedCount: 0,
      recordCount,
      stage: 'apply',
      totalCount: items.length,
    });
    try {
      const applied = await api<CitationRepairApplyResult>(
        '/api/context-health/citations/apply',
        {
          approved: true,
          items,
          project: props.project,
        },
        undefined,
        isCitationRepairApplyResult,
      );
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
      setError(contextHealthReadErrorMessage(cause));
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
                {EffectArray.map(citationRepairGroups(preview.items), group => (
                  <article key={group.subjectUri}>
                    <strong>{group.title}</strong>
                    {group.excerpt ? <MemoryExcerpt label="Saved memory">{group.excerpt}</MemoryExcerpt> : null}
                    <span>
                      {group.items.length} citation{group.items.length === 1 ? '' : 's'} ready in this memory
                    </span>
                    <ul>
                      {EffectArray.map(group.items, item => (
                        <li key={`${item.findingId}:${item.replacementId}`}>
                          <code>{item.path}</code>
                          <span>
                            {item.targetKind} · {Effect.pipe(item.category, EffectString.replaceAll('-', ' '))} · commit{' '}
                            <code>{Effect.pipe(item.sourceCommit, EffectString.slice(0, 12))}</code>
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
          <button disabled={busy || props.stale} onClick={() => void loadPreview(true)} type="button">
            {busy && progress?.stage !== 'apply' ? 'Working…' : 'Rebuild project graph and retry'}
          </button>
          <button
            disabled={busy || props.stale || !preview || preview.items.length === 0}
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
  return EffectArray.map([...groups.entries()], ([subjectUri, groupItems]) => ({
    excerpt: groupItems[0]?.subjectExcerpt,
    items: groupItems,
    subjectUri,
    title: groupItems[0]?.subjectTitle ?? memoryNameFromUri(subjectUri),
  }));
}

function memoryNameFromUri(uri: string): string {
  return (
    Effect.pipe(uri, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(
        __effectPipeInput,
        EffectString.slice(
          Effect.pipe(
            uri,
            EffectString.lastIndexOf('/'),
            Effect.Option.getOrElse(() => -1),
          ) + 1,
        ),
      );
      const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.replace(/\.md$/u, ''));
      const __effectPipeStage2 = Effect.pipe(__effectPipeStage1, EffectString.replaceAll('-', ' '));
      return __effectPipeStage2;
    }) || 'Affected memory'
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
  return EffectArray.join(
    EffectArray.map(
      Effect.pipe(category, EffectString.split('-')),
      word =>
        `${Effect.pipe(word, EffectString.slice(0, 1), EffectString.toUpperCase)}${Effect.pipe(word, EffectString.slice(1))}`,
    ),
    ' ',
  );
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
          <option value="">All</option>
          {EffectArray.map(props.projects, project => (
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

function Metric(props: {readonly label: string; readonly value: string}): React.ReactElement {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
