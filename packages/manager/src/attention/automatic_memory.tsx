import React, {useEffect, useRef, useState} from 'react';
import {LoaderCircle, RefreshCw, Sparkles} from 'lucide-react';
import {ReviewBadge, ReviewNotice} from '../review_presentation.js';
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

const labels: Record<ManagerAutomaticMemoryItem['state'], string> = {
  preparing: 'Preparing evidence',
  queued: 'Queued',
  generating: 'Generating draft',
  'waiting-model': 'Model setup needed',
  'waiting-budget': 'Waiting for generation budget',
  paused: 'Automatic preparation paused',
  policy: 'Waiting for policy or source access',
  retry: 'Waiting for one bounded retry',
  failed: 'Draft preparation stopped',
  ready: 'Ready to review',
  reviewed: 'Approved support recorded',
  unknown: 'Coverage unknown',
  deferred: 'Review deferred',
  verification: 'Finish verification',
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
        summary.current?.(props.project, {
          ready: result.items.filter(item => item.state === 'ready' || item.state === 'verification').length,
          pending:
            result.incomplete === true || result.omitted > 0 || result.items.some(item => item.state !== 'reviewed'),
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
  const current =
    status?.project === props.project ? reconcileAutomaticMemoryItems(status.items, props.project, applied) : [];
  const groups = automaticMemoryGroups(current, !!props.uri);
  return (
    <section className="automatic-memory-panel" aria-label="Automatic memory updates">
      <header className="automatic-memory-heading">
        <div>
          <span className="attention-kicker">Automatic memory care</span>
          <h3>{props.uri ? 'Assessment & support' : 'Prepared updates'}</h3>
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
      {groups.items.map(item => (
        <article className={`automatic-memory-card${item.state === 'ready' ? ' is-ready' : ''}`} key={item.uri}>
          <header>
            <h4>{item.title}</h4>
            <ReviewBadge tone={item.state === 'ready' ? 'proposal' : item.state === 'failed' ? 'warning' : 'neutral'}>
              {['preparing', 'generating', 'queued'].includes(item.state) ? (
                <LoaderCircle className="automatic-memory-spinner" size={13} />
              ) : null}
              {labels[item.state]}
            </ReviewBadge>
          </header>
          <p className="muted">
            {item.coverage.outcome} coverage · {item.coverage.scope.replaceAll('-', ' ')} ·{' '}
            {item.coverage.omittedSources} omitted sources
          </p>
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
              onClick={() => setSelected(item.reviewId)}
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
              onReady={setSelected}
            />
          ) : null}
        </article>
      ))}
      {groups.coverage.length ? (
        <details className="review-disclosure automatic-memory-coverage">
          <summary>
            {groups.coverage.length} older or uncited{' '}
            {groups.coverage.length === 1 ? 'memory awaits' : 'memories await'} source coverage
          </summary>
          <p>
            Automatic checks continue during normal use. Missing or unknown support does not mean current or verified.
          </p>
          <ul>
            {groups.coverage.map(item => (
              <li key={item.uri}>
                {item.title} · {labels[item.state]} · {item.coverage.outcome}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {status?.omitted ? (
        <p className="muted">{status.omitted} additional memories are outside this bounded view.</p>
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
        <nav className="automatic-review-actions" aria-label="Memory update pages">
          <button
            type="button"
            disabled={cursors.length < 2}
            onClick={() => {
              setStatus(undefined);
              setPagination({selection, cursors: cursors.slice(0, -1)});
            }}
          >
            Previous memories
          </button>
          <span className="muted">Page {cursors.length} · ready reviews appear first on each page.</span>
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
          </button>
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
            props.onChanged?.();
          }}
          onApplied={result => {
            mutation.current++;
            setApplied(old => [...old, result]);
            setSelected(undefined);
            setNotice('The exact approved document and its support were saved.');
            setRefresh(value => value + 1);
            props.onChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}
