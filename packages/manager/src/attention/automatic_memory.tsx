import React, {useEffect, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CircleHelp,
  Clock3,
  FolderSearch,
  Info,
  LoaderCircle,
  Pause,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {ReviewBadge, ReviewNotice, type ReviewTone} from '../review_presentation.js';
import {api, errorMessage} from '../ui/support.js';
import type {
  ManagerAutomaticMemoryItem,
  ManagerAutomaticMemoryStatus,
  ManagerAutomaticReview,
} from './topic_contracts.js';
import {AutomaticMemoryReviewDialog, automaticReviewIsVerified} from './automatic_review.js';
import {AutomaticGenerate} from './automatic_generate.js';

export function reconcileAutomaticMemoryItems(
  items: readonly ManagerAutomaticMemoryItem[],
  project: string,
  applied: readonly ManagerAutomaticReview[],
) {
  return items.filter(
    item =>
      !applied.some(
        receipt =>
          automaticReviewIsVerified(receipt) &&
          receipt.project === project &&
          receipt.reviewId === item.reviewId &&
          receipt.targetUri === item.uri &&
          receipt.evidenceRevision === item.evidenceRevision &&
          receipt.targetHash === item.targetHash,
      ),
  );
}

const states: Record<
  ManagerAutomaticMemoryItem['state'],
  {readonly label: string; readonly tone: ReviewTone; readonly icon: LucideIcon}
> = {
  preparing: {label: 'Preparing evidence', tone: 'info', icon: LoaderCircle},
  queued: {label: 'Queued', tone: 'info', icon: Clock3},
  generating: {label: 'Generating draft', tone: 'info', icon: LoaderCircle},
  'waiting-model': {label: 'Model setup needed', tone: 'warning', icon: AlertTriangle},
  'waiting-budget': {label: 'Waiting for generation budget', tone: 'neutral', icon: Clock3},
  paused: {label: 'Automatic preparation paused', tone: 'neutral', icon: Pause},
  policy: {label: 'Waiting for policy or source access', tone: 'warning', icon: ShieldAlert},
  retry: {label: 'Waiting for one bounded retry', tone: 'warning', icon: RefreshCw},
  failed: {label: 'Draft preparation stopped', tone: 'danger', icon: AlertTriangle},
  ready: {label: 'Ready to review', tone: 'proposal', icon: Sparkles},
  reviewed: {label: 'Approved support recorded', tone: 'info', icon: BadgeCheck},
  unknown: {label: 'Coverage unknown', tone: 'neutral', icon: CircleHelp},
  deferred: {label: 'Review deferred', tone: 'neutral', icon: Clock3},
  verification: {label: 'Finish verification', tone: 'warning', icon: ShieldAlert},
};

const coverageScopes = {
  'recorded-only': 'Recorded sources only',
  'bounded-search': 'Bounded source search',
  none: 'Sources not yet assessed',
};

/** Stable, nonmutating grouping: an uncited backlog is one coverage item, never many alarms. */
export function automaticMemoryGroups(items: readonly ManagerAutomaticMemoryItem[], detail = false) {
  const coverage = items
    .filter(item => !detail && item.legacyUncited && !item.reviewId && !['queued', 'generating'].includes(item.state))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  const grouped = new Set(coverage.map(item => item.uri));
  const priority = (item: ManagerAutomaticMemoryItem) =>
    item.state === 'ready' || item.state === 'verification' ? 0 : 1;
  return {
    coverage,
    items: items
      .filter(item => !grouped.has(item.uri))
      .sort((a, b) => priority(a) - priority(b) || a.uri.localeCompare(b.uri)),
  };
}

export function AutomaticMemoryPanel(props: {
  readonly project: string;
  readonly uri?: string;
  readonly onChanged?: () => void;
  readonly onReview?: (reviewId: string) => void;
  readonly onApplied?: (review: ManagerAutomaticReview) => void;
  readonly onSummaryChange?: (
    project: string,
    summary: {readonly ready: number; readonly pending: boolean} | undefined,
  ) => void;
}) {
  const [status, setStatus] = useState<ManagerAutomaticMemoryStatus>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [applied, setApplied] = useState<readonly ManagerAutomaticReview[]>([]);
  const selection = JSON.stringify([props.project, props.uri]);
  const [pagination, setPagination] = useState<{
    readonly selection: string;
    readonly cursors: readonly (string | undefined)[];
  }>({selection, cursors: [undefined]});
  const cursors = pagination.selection === selection ? pagination.cursors : [undefined];
  const afterUri = cursors.at(-1);
  const requestSelection = JSON.stringify([selection, afterUri]);
  const active = useRef(requestSelection);
  active.current = requestSelection;
  const mutation = useRef(0);
  const summary = useRef(props.onSummaryChange);
  summary.current = props.onSummaryChange;
  useEffect(() => {
    setSelected(undefined);
    setNotice('');
  }, [selection]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    setStatus(undefined);
    summary.current?.(props.project, undefined);
    const poll = async () => {
      const epoch = mutation.current;
      try {
        const result = await api<ManagerAutomaticMemoryStatus>(
          `/api/attention/automatic-memory?project=${encodeURIComponent(props.project)}${props.uri ? `&uri=${encodeURIComponent(props.uri)}` : afterUri ? `&afterUri=${encodeURIComponent(afterUri)}` : ''}`,
          undefined,
          {signal: controller.signal},
        );
        if (controller.signal.aborted || active.current !== requestSelection || epoch !== mutation.current) return;
        if (result.version !== 1 || result.project !== props.project || !Array.isArray(result.items))
          throw new Error('Automatic memory status is unavailable. Refresh Manager.');
        setStatus(result);
        const retained = reconcileAutomaticMemoryItems(result.items, props.project, applied);
        summary.current?.(props.project, {
          ready: retained.filter(item => item.state === 'ready' || item.state === 'verification').length,
          pending: result.incomplete === true || result.omitted > 0 || retained.some(item => item.state !== 'reviewed'),
        });
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted && active.current === requestSelection) setError(errorMessage(cause));
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [requestSelection, refresh, props.project, props.uri, afterUri]);
  function openReview(reviewId: string) {
    props.onReview?.(reviewId);
    setSelected(reviewId);
  }
  const current =
    status?.project === props.project ? reconcileAutomaticMemoryItems(status.items, props.project, applied) : [];
  const groups = automaticMemoryGroups(current, !!props.uri);
  return (
    <section className="automatic-memory-panel" aria-label="Automatic memory updates">
      <header className="automatic-memory-heading">
        <div className="automatic-memory-title">
          <span className="automatic-memory-heading-icon" aria-hidden="true">
            <Sparkles size={21} />
          </span>
          <div>
            <span className="attention-kicker">Automatic memory care</span>
            <h3>{props.uri ? 'Assessment & support' : 'Prepared updates'}</h3>
          </div>
        </div>
        <button
          type="button"
          className="quiet-icon"
          aria-label="Refresh automatic updates"
          onClick={() => setRefresh(value => value + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      {notice ? (
        <ReviewNotice title="Update saved and verified" tone="proposal">
          {notice}
        </ReviewNotice>
      ) : null}
      {error ? (
        <ReviewNotice title="Automatic status unavailable" tone="warning" role="alert">
          {error}
        </ReviewNotice>
      ) : null}
      {!status && !error ? (
        <p role="status">
          <LoaderCircle className="automatic-memory-spinner" size={16} /> Loading automatic assessment…
        </p>
      ) : null}
      {groups.items.map(item => {
        const state = states[item.state];
        const Icon = state.icon;
        return (
          <article className="automatic-memory-card" data-state={item.state} data-tone={state.tone} key={item.uri}>
            <header>
              <h4>{item.title}</h4>
              <ReviewBadge tone={state.tone}>
                <Icon
                  className={['preparing', 'generating'].includes(item.state) ? 'automatic-memory-spinner' : undefined}
                  size={14}
                  aria-hidden="true"
                />
                {state.label}
              </ReviewBadge>
            </header>
            <div className="automatic-memory-source-summary">
              <ReviewBadge tone={item.coverage.outcome === 'partial' ? 'warning' : 'neutral'}>
                <FolderSearch size={13} aria-hidden="true" />
                {item.coverage.outcome === 'unknown' ? 'Coverage unknown' : `${item.coverage.outcome} coverage`}
              </ReviewBadge>
              <span>{coverageScopes[item.coverage.scope]}</span>
              {item.coverage.omittedSources > 0 ? (
                <span className="automatic-memory-omitted">
                  {item.coverage.omittedSources} omitted {item.coverage.omittedSources === 1 ? 'source' : 'sources'}
                </span>
              ) : null}
            </div>
            {item.reason ? <p>{item.reason.replaceAll('-', ' ')}</p> : null}
            {item.nextEligibleAt !== undefined ? (
              <p className="muted">
                Next eligible: {new Date(item.nextEligibleAt).toLocaleString()}
                {item.retryCount !== undefined ? ` · retry ${item.retryCount}/1` : ''}
              </p>
            ) : null}
            {item.paragraphs.length ? (
              <div className="attention-tags">
                {[...new Set(item.paragraphs.map(p => `${p.authority} ${p.role} · ${p.support}`))].map(label => (
                  <ReviewBadge key={label} tone="neutral">
                    {label}
                  </ReviewBadge>
                ))}
              </div>
            ) : (
              <p className="muted">Roles and source support have not been assessed.</p>
            )}
            {item.route === 'shared-owner-review' ? (
              <p>
                Shared memory: an authorized team owner reviews the exact proposal; publication requires separate
                approval.
              </p>
            ) : item.route === 'read-only' ? (
              <p>Read-only source. Ask its authorized owner to review this memory.</p>
            ) : null}
            {item.reviewId ? (
              <button
                type="button"
                className={item.state === 'ready' || item.state === 'verification' ? 'primary' : undefined}
                onClick={() => openReview(item.reviewId!)}
              >
                <Sparkles size={15} />
                {item.state === 'verification'
                  ? 'Finish verification'
                  : item.state === 'deferred'
                    ? 'Open deferred review'
                    : 'Review update'}
              </button>
            ) : item.state === 'failed' ? (
              <p>Refresh source access or model setup, then wait for changed evidence. Automatic retries are finite.</p>
            ) : null}
            {item.canGenerate && !item.reviewId && item.route === 'personal-review' ? (
              <AutomaticGenerate
                key={`${props.project}:${item.uri}:${item.targetHash}`}
                project={props.project}
                item={item}
                onReady={openReview}
              />
            ) : null}
          </article>
        );
      })}
      {groups.coverage.length ? (
        <details className="review-disclosure automatic-memory-coverage">
          <summary>
            <FolderSearch size={18} aria-hidden="true" />
            <span>
              <strong>{groups.coverage.length} older or uncited</strong>{' '}
              {groups.coverage.length === 1 ? 'memory awaits' : 'memories await'} source coverage
            </span>
          </summary>
          <p>
            Automatic checks continue during normal use. Missing or unknown support does not mean current or verified.
          </p>
          <ul>
            {groups.coverage.map(item => (
              <li key={item.uri}>
                {item.title} · {states[item.state].label} · {item.coverage.outcome}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {status?.omitted ? (
        <p className="automatic-memory-limit">
          <Info size={15} aria-hidden="true" />
          <span>
            <strong>{status.omitted} additional memories</strong> are outside this bounded view.
          </span>
        </p>
      ) : null}
      {status?.incomplete ? (
        <p className="muted" role="status">
          Coverage is still being assessed. This view does not establish that every memory or source is current.
          {status.unavailableRecords
            ? ` ${status.unavailableRecords} memories could not be read in this bounded check.`
            : ''}
        </p>
      ) : null}
      {!props.uri && status && (cursors.length > 1 || status.nextCursor) ? (
        <nav className="automatic-memory-pagination" aria-label="Memory update pages">
          <div className="automatic-memory-page-info">
            <strong>Page {cursors.length}</strong>
            <span>Ready reviews appear first on each page.</span>
          </div>
          <div className="automatic-memory-page-buttons">
            <button
              type="button"
              disabled={cursors.length < 2}
              onClick={() => {
                setStatus(undefined);
                setPagination({selection, cursors: cursors.slice(0, -1)});
              }}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Previous memories
            </button>
            <button
              type="button"
              disabled={!status.nextCursor}
              onClick={() => {
                if (status.nextCursor) {
                  setStatus(undefined);
                  setPagination({selection, cursors: [...cursors, status.nextCursor]});
                }
              }}
            >
              Next memories
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </nav>
      ) : null}
      {status && !current.length ? (
        <p className="muted">No prepared updates in this view. Source coverage is assessed during normal use.</p>
      ) : null}
      {selected ? (
        <AutomaticMemoryReviewDialog
          key={`${selection}:${selected}`}
          project={props.project}
          reviewId={selected}
          onClose={() => setSelected(undefined)}
          onChanged={() => {
            mutation.current++;
            setRefresh(value => value + 1);
          }}
          onApplied={result => {
            mutation.current++;
            setApplied(old => [...old, result]);
            setSelected(undefined);
            setNotice('The exact approved document and its support were saved.');
            setRefresh(value => value + 1);
            props.onApplied?.(result);
            props.onChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}
