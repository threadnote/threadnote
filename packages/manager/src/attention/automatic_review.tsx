import React, {useEffect, useRef, useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import {DetailModal, MemoryBody} from '../detail_modal.js';
import {MemoryExcerpt, ReviewBadge, ReviewNotice} from '../review_presentation.js';
import {api, errorMessage} from '../ui/support.js';
import type {ManagerAutomaticReview, ManagerAutomaticReviewResponse} from './topic_contracts.js';

export function automaticReviewIsVerified(review: ManagerAutomaticReview): boolean {
  return (
    review.verified === true &&
    review.state === 'applied' &&
    review.approval?.stage === 'written' &&
    /^[a-f0-9]{64}$/u.test(review.approval.contentHash)
  );
}

export function AutomaticMemoryReviewDialog(props: {
  readonly project: string;
  readonly reviewId: string;
  readonly initialReview?: ManagerAutomaticReview;
  readonly onClose: () => void;
  readonly onChanged?: () => void;
  readonly onApplied?: (review: ManagerAutomaticReview) => void;
  readonly onRead?: (review: ManagerAutomaticReview) => void;
  readonly onIdentity?: (identity: Pick<ManagerAutomaticReview, 'project' | 'reviewId' | 'revision'>) => void;
}) {
  const [review, setReview] = useState<ManagerAutomaticReviewResponse | undefined>(props.initialReview);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  function acceptRead(result: ManagerAutomaticReviewResponse) {
    setReview(result);
    props.onIdentity?.({project: result.project, reviewId: result.reviewId, revision: result.revision});
    if (result.kind === 'automatic-memory-review') props.onRead?.(result);
  }
  const owned = useRef(false);
  const epoch = useRef(0);
  const selection = JSON.stringify([props.project, props.reviewId]);
  const active = useRef(selection);
  if (active.current !== selection) {
    active.current = selection;
    epoch.current++;
    owned.current = false;
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setBusy(false);
    setAction('');
    setConfirmed(false);
  }, [selection]);
  useEffect(() => {
    if (props.initialReview && refresh === 0) return;
    const controller = new AbortController();
    const requestEpoch = epoch.current;
    setError('');
    void api<ManagerAutomaticReviewResponse>(
      `/api/attention/automatic-review?project=${encodeURIComponent(props.project)}&reviewId=${encodeURIComponent(props.reviewId)}`,
      undefined,
      {signal: controller.signal},
    )
      .then(result => {
        if (
          !controller.signal.aborted &&
          active.current === selection &&
          epoch.current === requestEpoch &&
          !owned.current
        ) {
          if (
            !['automatic-memory-review', 'topic-maintenance-recovery'].includes(result.kind) ||
            result.project !== props.project ||
            result.reviewId !== props.reviewId
          )
            throw new Error('The selected review changed. Refresh its exact proposal.');
          acceptRead(result);
          setConfirmed(false);
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted && active.current === selection) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [selection, refresh, props.project, props.reviewId, props.initialReview]);
  const selected = review?.project === props.project && review.reviewId === props.reviewId ? review : undefined;
  const current = selected?.kind === 'automatic-memory-review' ? selected : undefined;
  const recovery = selected?.kind === 'topic-maintenance-recovery' ? selected : undefined;
  async function act(nextAction: 'preview' | 'apply' | 'reject' | 'defer' | 'resume') {
    if (
      owned.current ||
      !selected ||
      (!current && nextAction !== 'reject' && nextAction !== 'resume') ||
      (nextAction === 'apply' && !confirmed && !current?.canFinishVerification)
    )
      return;
    owned.current = true;
    epoch.current++;
    const requestEpoch = epoch.current;
    setBusy(true);
    setAction(nextAction);
    setError('');
    setConfirmed(false);
    try {
      const result = await api<ManagerAutomaticReviewResponse>('/api/attention/automatic-review', {
        action: nextAction,
        project: props.project,
        reviewId: selected.reviewId,
        revision: selected.revision,
        ...(nextAction === 'apply' ? {approvalDigest: current?.approval?.approvalDigest, approved: true} : {}),
      });
      if (!mounted.current || active.current !== selection || epoch.current !== requestEpoch) return;
      if (
        !['automatic-memory-review', 'topic-maintenance-recovery'].includes(result.kind) ||
        result.project !== props.project ||
        result.reviewId !== selected.reviewId ||
        (result.kind === 'automatic-memory-review' && current && result.targetUri !== current.targetUri)
      )
        throw new Error('The selected review changed. Reload its exact target.');
      acceptRead(result);
      if (result.kind === 'topic-maintenance-recovery') {
        props.onChanged?.();
        if (nextAction === 'reject' && result.state === 'rejected') props.onClose();
        else setRefresh(value => value + 1);
        return;
      }
      if (nextAction === 'apply' && automaticReviewIsVerified(result)) {
        props.onApplied?.(result);
        props.onClose();
        return;
      }
      if (nextAction === 'apply')
        setError('The write is not yet verified. Reload this review and use Finish verification when available.');
      props.onChanged?.();
    } catch (cause) {
      if (mounted.current && active.current === selection && epoch.current === requestEpoch) {
        setError(errorMessage(cause));
        setRefresh(value => value + 1);
      }
    } finally {
      if (epoch.current === requestEpoch) owned.current = false;
      if (mounted.current && active.current === selection && epoch.current === requestEpoch) {
        setBusy(false);
        setAction('');
      }
    }
  }
  const approval = current?.approval;
  const close = () => {
    if (!owned.current) props.onClose();
  };
  return (
    <DetailModal
      title={current?.purpose === 'manual-edit' ? 'Review your memory edit' : 'Review memory update'}
      onClose={close}
      className="topic-review-dialog automatic-review-dialog"
    >
      {error ? (
        <ReviewNotice role="alert" title="Review needs attention" tone="warning">
          <p>{error}</p>
          <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>
            Reload exact review
          </button>
        </ReviewNotice>
      ) : null}
      {busy ? (
        <p role="status" aria-live="polite">
          <LoaderCircle className="automatic-memory-spinner" size={16} />
          {action === 'apply'
            ? 'Saving and verifying the approved document…'
            : action === 'preview'
              ? 'Preparing the exact full preview…'
              : 'Saving review decision…'}
        </p>
      ) : null}
      {recovery ? (
        <ReviewNotice title="Source access changed" tone="warning">
          <p>
            Private memory and source text are withheld. You can discard this exact obsolete review without changing the
            memory, or restore source access and reload.
          </p>
          <p>
            Review state: {recovery.state} · revision {recovery.revision}
          </p>
          {recovery.recovery?.action === 'reject' ? (
            <button type="button" disabled={busy} onClick={() => void act('reject')}>
              Reject obsolete review
            </button>
          ) : null}
          {recovery.state === 'deferred' ? (
            <button type="button" disabled={busy} onClick={() => void act('resume')}>
              Resume review
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>
            Reload exact review
          </button>
        </ReviewNotice>
      ) : !current ? (
        <p role="status">Loading the selected review…</p>
      ) : (
        <>
          <div className="attention-tags">
            <ReviewBadge tone="proposal">
              {current.purpose === 'manual-edit' ? 'Your authored edit' : 'Proposed update'}
            </ReviewBadge>
            <ReviewBadge tone="neutral">{current.state}</ReviewBadge>
            <ReviewBadge tone="neutral">
              {current.coverage.outcome} coverage · {current.coverage.scope.replaceAll('-', ' ')}
            </ReviewBadge>
          </div>
          <p className="muted">
            Source scope is bounded; {current.coverage.omittedSources} sources omitted. Role and support decisions
            become reviewed only after explicit approval.
          </p>
          {current.coverage.searchedScopes.length ? (
            <details className="review-disclosure">
              <summary>Source search bounds</summary>
              <ul>
                {current.coverage.searchedScopes.map(scope => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
              <p>{current.coverage.omittedParagraphs ?? 'Unknown'} paragraphs omitted from assessment.</p>
            </details>
          ) : null}
          {current.ownerProposal ? (
            <ReviewNotice title="Shared owner review" tone="protected">
              <p>{current.ownerProposal.instructions}</p>
              <p>
                <code>{current.targetUri}</code>
              </p>
              <p>
                Exact proposal: <code>{current.reviewId}</code> · revision {current.revision}. The authorized owner can
                use the existing share_propose review export.
              </p>
            </ReviewNotice>
          ) : null}
          {current.purpose === 'manual-edit' ? (
            <ReviewNotice title="Affected support will be invalidated" tone="warning">
              Changed paragraphs become unknown with unresolved support. Unchanged available support and the approval
              history are retained. Inspect the exact support metadata below.
            </ReviewNotice>
          ) : null}
          <div className="automatic-review-comparison">
            <MemoryExcerpt label="Accepted memory">{current.acceptedBody}</MemoryExcerpt>
            <div className="review-proposal-preview">
              <h3>Proposed memory</h3>
              <MemoryBody content={current.proposal.body} />
            </div>
          </div>
          <section className="automatic-review-roles">
            <h3>Paragraph roles & support</h3>
            {current.proposal.draft.paragraphDecisions.map(item => (
              <div className="attention-tags" key={item.ordinal}>
                <span>Paragraph {item.ordinal + 1}</span>
                <ReviewBadge tone={item.role === 'unknown' ? 'warning' : 'neutral'}>{item.role}</ReviewBadge>
                <ReviewBadge tone={item.support === 'unresolved' ? 'warning' : 'neutral'}>{item.support}</ReviewBadge>
                <span className="muted">{item.evidenceIds.length} source references · proposed</span>
              </div>
            ))}
          </section>
          <section>
            <h3>Source evidence</h3>
            {current.sourceEvidence.length ? (
              current.sourceEvidence.map(source => (
                <details className="review-disclosure" key={source.handleId}>
                  <summary>
                    {source.descriptor.source.kind === 'memory'
                      ? source.descriptor.source.uri
                      : source.descriptor.source.kind === 'code'
                        ? source.descriptor.source.citation.path
                        : source.descriptor.source.evidence.relativePath}
                    <ReviewBadge tone="neutral">{source.descriptor.scope}</ReviewBadge>
                  </summary>
                  <MemoryExcerpt label="Exact source quotation">{source.content}</MemoryExcerpt>
                  <code>{source.contentHash}</code>
                </details>
              ))
            ) : (
              <p>No source quotations are available in this bounded review.</p>
            )}
          </section>
          {current.proposal.draft.rationale ? <p>{current.proposal.draft.rationale}</p> : null}
          {approval ? (
            <section className="automatic-review-exact">
              <h3>Exact document & metadata preview</h3>
              <p>This complete document is the only content this approval authorizes.</p>
              <pre tabIndex={0}>{approval.content}</pre>
              <dl className="review-metadata">
                <div>
                  <dt>Document hash</dt>
                  <dd>
                    <code>{approval.contentHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Approval digest</dt>
                  <dd>
                    <code>{approval.approvalDigest}</code>
                  </dd>
                </div>
              </dl>
              <details className="review-disclosure">
                <summary>Support provenance & metadata changes</summary>
                <pre>
                  {JSON.stringify(
                    {metadataDiff: approval.metadataDiff, reviewedSupport: approval.reviewedSupport},
                    null,
                    2,
                  )}
                </pre>
              </details>
            </section>
          ) : null}
          {current.canFinishVerification ? (
            <ReviewNotice title="Saved; verification remains" tone="warning">
              The persisted approval can finish verification without writing a different proposal.
            </ReviewNotice>
          ) : null}
          {automaticReviewIsVerified(current) ? (
            <ReviewNotice title="Saved and verified" tone="proposal">
              The approved document matches canonical readback.
            </ReviewNotice>
          ) : null}
          <footer className="automatic-review-actions">
            {!current.ownerProposal && current.state === 'pending' ? (
              <button
                className={!approval ? 'primary' : undefined}
                disabled={busy}
                type="button"
                onClick={() => void act('preview')}
              >
                Preview exact update
              </button>
            ) : null}
            {current.canApply && !current.canFinishVerification ? (
              <label className="review-confirmation">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={confirmed}
                  onChange={event => setConfirmed(event.target.checked)}
                />
                <span>I approve this exact full document and metadata.</span>
              </label>
            ) : null}
            {current.canApply || current.canFinishVerification ? (
              <button
                className="primary"
                type="button"
                disabled={busy || (!confirmed && !current.canFinishVerification)}
                onClick={() => void act('apply')}
              >
                {current.canFinishVerification ? 'Finish verification' : 'Confirm and apply'}
              </button>
            ) : null}
            {current.state === 'pending' ? (
              <>
                <button disabled={busy} type="button" onClick={() => void act('defer')}>
                  Defer
                </button>
                <button disabled={busy} type="button" onClick={() => void act('reject')}>
                  Reject
                </button>
              </>
            ) : current.state === 'deferred' ? (
              <button disabled={busy} type="button" onClick={() => void act('resume')}>
                Resume review
              </button>
            ) : null}
          </footer>
        </>
      )}
    </DetailModal>
  );
}
