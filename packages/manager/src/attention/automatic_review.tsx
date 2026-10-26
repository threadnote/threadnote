import React, {useEffect, useRef, useState} from 'react';
import {DetailModal, MemoryBody} from '../detail_modal.js';
import {MemoryExcerpt, ReviewBadge, ReviewNotice} from '../review_presentation.js';
import {api, errorMessage} from '../ui/support.js';
import {ReviewProgress} from '../review_progress.js';
import {SourceExcerpt} from '../source_code.js';
import type {ManagerAutomaticReview, ManagerAutomaticReviewResponse} from './topic_contracts.js';

export function automaticReviewIsVerified(review: ManagerAutomaticReview): boolean {
  return (
    review.verified === true &&
    review.state === 'applied' &&
    review.approval?.stage === 'written' &&
    /^[a-f0-9]{64}$/u.test(review.approval.contentHash)
  );
}

function isNoUpdateAssessment(review: ManagerAutomaticReview): boolean {
  return (
    review.purpose === 'automatic' &&
    ['insufficient-evidence', 'policy-conflict'].includes(review.proposal.draft.outcome)
  );
}

function hasApplicablePreview(review: ManagerAutomaticReview): boolean {
  return (
    review.state === 'pending' &&
    !review.ownerProposal &&
    !isNoUpdateAssessment(review) &&
    review.canApply &&
    review.approval?.stage === 'preview' &&
    /^[a-f0-9]{64}$/u.test(review.approval.approvalDigest) &&
    /^[a-f0-9]{64}$/u.test(review.approval.contentHash)
  );
}

export function AutomaticMemoryReviewDialog(props: {
  readonly project: string;
  readonly reviewId: string;
  readonly initialReview?: ManagerAutomaticReview;
  readonly onClose: () => void;
  readonly onOpenMemory?: (uri: string) => void;
  readonly onChanged?: () => void;
  readonly onApplied?: (review: ManagerAutomaticReview) => void;
  readonly onRead?: (review: ManagerAutomaticReview) => void;
  readonly onIdentity?: (identity: Pick<ManagerAutomaticReview, 'project' | 'reviewId' | 'revision'>) => void;
}) {
  const [review, setReview] = useState<ManagerAutomaticReviewResponse | undefined>(props.initialReview);
  const [error, setError] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!props.initialReview);
  const [focusPreview, setFocusPreview] = useState<string>();
  const previewRef = useRef<HTMLElement>(null);
  const [action, setAction] = useState('');
  const [refresh, setRefresh] = useState(0);
  function acceptRead(result: ManagerAutomaticReviewResponse) {
    setReview(result);
    props.onIdentity?.({project: result.project, reviewId: result.reviewId, revision: result.revision});
    if (result.kind === 'automatic-memory-review') props.onRead?.(result);
  }
  const owned = useRef(false);
  const acquiring = useRef(true);
  const epoch = useRef(0);
  const selection = JSON.stringify([props.project, props.reviewId]);
  const active = useRef(selection);
  const selectedTarget = useRef<{selection: string; uri?: string}>({selection});
  if (selectedTarget.current.selection !== selection) selectedTarget.current = {selection};
  if (
    selectedTarget.current.uri === undefined &&
    props.initialReview?.project === props.project &&
    props.initialReview.reviewId === props.reviewId
  )
    selectedTarget.current.uri = props.initialReview.targetUri;
  if (active.current !== selection) {
    active.current = selection;
    epoch.current++;
    owned.current = false;
    acquiring.current = true;
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
    setFocusPreview(undefined);
    setReadFailed(false);
    setError('');
  }, [selection]);
  // Each selection/retry gets one bounded acquisition and at most one preparation.
  // Unknown preparation outcomes are reconciled by reading, never by replaying the POST.
  // Defer starting until after effect setup so StrictMode's discarded setup cannot prepare twice.
  useEffect(() => {
    const controller = new AbortController();
    const requestEpoch = epoch.current;
    const isCurrent = () =>
      mounted.current && !controller.signal.aborted && active.current === selection && epoch.current === requestEpoch;
    acquiring.current = true;
    setLoading(true);
    setReadFailed(false);
    setFocusPreview(undefined);
    async function load() {
      await Promise.resolve();
      if (!isCurrent()) return;
      try {
        let result =
          refresh === 0 &&
          props.initialReview?.project === props.project &&
          props.initialReview.reviewId === props.reviewId
            ? props.initialReview
            : await api<ManagerAutomaticReviewResponse>(
                `/api/attention/automatic-review?project=${encodeURIComponent(props.project)}&reviewId=${encodeURIComponent(props.reviewId)}`,
                undefined,
                {signal: controller.signal, timeoutMilliseconds: 30_000},
              );
        if (!isCurrent() || owned.current) return;
        validateResult(result);
        const targetUri = result.kind === 'automatic-memory-review' ? result.targetUri : undefined;
        acceptRead(result);
        if (
          result.kind === 'automatic-memory-review' &&
          result.purpose === 'automatic' &&
          !isNoUpdateAssessment(result) &&
          result.state === 'pending' &&
          !result.ownerProposal &&
          !result.canFinishVerification &&
          (!result.approval || result.approval.stage === 'preview') &&
          !hasApplicablePreview(result)
        ) {
          setAction('preview');
          let preparationError: Error | undefined;
          try {
            result = await api<ManagerAutomaticReviewResponse>(
              '/api/attention/automatic-review',
              {action: 'preview', project: props.project, reviewId: result.reviewId, revision: result.revision},
              {signal: controller.signal, timeoutMilliseconds: 30_000},
            );
          } catch (cause) {
            if (!isCurrent()) return;
            preparationError = cause instanceof Error ? cause : new Error(errorMessage(cause));
          }
          if (!isCurrent() || owned.current) return;
          validateResult(result, targetUri);
          // A timed-out/disconnected request may already have saved the exact preview.
          // Reuse the canonical outcome, including source-access recovery, without another prepare.
          if (preparationError || (result.kind === 'automatic-memory-review' && !hasApplicablePreview(result))) {
            const recovered = await api<ManagerAutomaticReviewResponse>(
              `/api/attention/automatic-review?project=${encodeURIComponent(props.project)}&reviewId=${encodeURIComponent(props.reviewId)}`,
              undefined,
              {signal: controller.signal, timeoutMilliseconds: 30_000},
            );
            if (!isCurrent() || owned.current) return;
            validateResult(recovered, targetUri);
            result = recovered;
            acceptRead(result);
            if (preparationError && result.kind === 'automatic-memory-review' && !hasApplicablePreview(result))
              throw preparationError;
          } else acceptRead(result);
        }
        if (
          result.kind === 'automatic-memory-review' &&
          result.state === 'pending' &&
          !isNoUpdateAssessment(result) &&
          !result.ownerProposal &&
          !result.canFinishVerification &&
          !hasApplicablePreview(result)
        )
          throw new Error(
            'This update is blocked: an applicable exact approval preview is unavailable. Reload the exact review to retry.',
          );
        setError('');
        if (result.kind === 'automatic-memory-review' && hasApplicablePreview(result))
          setFocusPreview(result.approval!.approvalDigest);
      } catch (cause) {
        if (isCurrent()) {
          setError(errorMessage(cause));
          setReadFailed(true);
        }
      } finally {
        if (isCurrent()) {
          acquiring.current = false;
          setLoading(false);
          setAction('');
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [selection, refresh]);
  function validateResult(result: ManagerAutomaticReviewResponse, targetUri = selectedTarget.current.uri) {
    if (
      !['automatic-memory-review', 'topic-maintenance-recovery'].includes(result.kind) ||
      result.project !== props.project ||
      result.reviewId !== props.reviewId ||
      (result.kind === 'automatic-memory-review' && targetUri !== undefined && result.targetUri !== targetUri)
    )
      throw new Error('The selected review changed. Reload its exact target.');
    if (result.kind === 'automatic-memory-review') selectedTarget.current.uri = result.targetUri;
  }
  const selected = review?.project === props.project && review.reviewId === props.reviewId ? review : undefined;
  const current = selected?.kind === 'automatic-memory-review' ? selected : undefined;
  const recovery = selected?.kind === 'topic-maintenance-recovery' ? selected : undefined;
  async function act(nextAction: 'apply' | 'reject' | 'defer' | 'resume') {
    if (
      owned.current ||
      active.current !== selection ||
      !mounted.current ||
      acquiring.current ||
      loading ||
      readFailed ||
      !selected ||
      (!current && nextAction !== 'reject' && nextAction !== 'resume') ||
      (nextAction === 'apply' && (!current || (!hasApplicablePreview(current) && !current.canFinishVerification)))
    )
      return;
    owned.current = true;
    epoch.current++;
    const requestEpoch = epoch.current;
    setBusy(true);
    setAction(nextAction);
    setError('');
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
      if (nextAction === 'apply') {
        setError('The write is not yet verified. Reload this review and use Finish verification when available.');
        setReadFailed(!result.canFinishVerification);
      }
      if (nextAction === 'resume') {
        acquiring.current = true;
        setRefresh(value => value + 1);
      }
      props.onChanged?.();
    } catch (cause) {
      if (mounted.current && active.current === selection && epoch.current === requestEpoch) {
        setError(errorMessage(cause));
        setReadFailed(true);
      }
    } finally {
      if (epoch.current === requestEpoch) owned.current = false;
      if (mounted.current && active.current === selection && epoch.current === requestEpoch) {
        setBusy(false);
        setAction('');
      }
    }
  }
  const reload = () => {
    if (owned.current || acquiring.current) return;
    acquiring.current = true;
    setRefresh(value => value + 1);
  };
  const noUpdate = current ? isNoUpdateAssessment(current) : false;
  const approval = current?.approval;
  const controlsDisabled = busy || loading || readFailed;
  useEffect(() => {
    if (focusPreview && approval?.approvalDigest === focusPreview) {
      previewRef.current?.scrollIntoView?.({block: 'start'});
      previewRef.current?.focus({preventScroll: true});
    }
  }, [focusPreview, approval?.approvalDigest]);
  const openMemory = props.onOpenMemory
    ? (uri: string) => {
        if (!owned.current) props.onOpenMemory?.(uri);
      }
    : undefined;
  const close = () => {
    if (!owned.current) props.onClose();
  };
  return (
    <DetailModal
      title={
        current?.purpose === 'manual-edit'
          ? 'Review your memory edit'
          : noUpdate
            ? 'Memory assessment'
            : 'Review memory update'
      }
      onClose={close}
      className="topic-review-dialog automatic-review-dialog"
    >
      {error ? (
        <ReviewNotice role="alert" title="Review needs attention" tone="warning">
          <p>{error}</p>
          <button type="button" disabled={busy || loading} onClick={reload}>
            Reload exact review
          </button>
        </ReviewNotice>
      ) : null}
      {loading ? (
        <ReviewProgress
          title={action === 'preview' ? 'Preparing the exact full preview…' : 'Loading the selected review…'}
          description="Checking the saved proposal and its current source access. You can close this dialog while it loads."
        />
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
            <button type="button" disabled={controlsDisabled} onClick={() => void act('reject')}>
              Reject obsolete review
            </button>
          ) : null}
          {recovery.state === 'deferred' ? (
            <button type="button" disabled={controlsDisabled} onClick={() => void act('resume')}>
              Resume review
            </button>
          ) : null}
          <button type="button" disabled={busy || loading} onClick={reload}>
            Reload exact review
          </button>
        </ReviewNotice>
      ) : !current ? null : (
        <>
          <div className="attention-tags">
            <ReviewBadge tone="proposal">
              {current.purpose === 'manual-edit' ? 'Your authored edit' : noUpdate ? 'Assessment' : 'Proposed update'}
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
          {noUpdate ? (
            <ReviewNotice title="No update proposed" tone="info">
              <p>
                {current.proposal.draft.outcome === 'insufficient-evidence'
                  ? 'Waiting for sufficient evidence. The accepted memory is unchanged.'
                  : 'Waiting for the source policy conflict to change. The accepted memory is unchanged.'}
              </p>
              <p>Automatic assessment can try again when material evidence changes.</p>
              {current.proposal.draft.unresolvedQuestions.length ? (
                <ul>
                  {current.proposal.draft.unresolvedQuestions.map(question => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              ) : null}
            </ReviewNotice>
          ) : null}
          <div className="automatic-review-comparison">
            <MemoryExcerpt label="Accepted memory" markdown onOpenMemory={openMemory}>
              {current.acceptedBody}
            </MemoryExcerpt>
            {!noUpdate ? (
              <div className="review-proposal-preview">
                <h3>Proposed memory</h3>
                <MemoryBody content={current.proposal.body} onOpenMemory={openMemory} />
              </div>
            ) : null}
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
                  <SourceExcerpt
                    label="Exact source quotation"
                    content={source.content}
                    path={
                      source.descriptor.source.kind === 'code'
                        ? source.descriptor.source.citation.path
                        : source.descriptor.source.kind === 'memory'
                          ? undefined
                          : source.descriptor.source.evidence.relativePath
                    }
                  />
                  <code>{source.contentHash}</code>
                </details>
              ))
            ) : (
              <p>No source quotations are available in this bounded review.</p>
            )}
          </section>
          {current.proposal.draft.rationale ? <p>{current.proposal.draft.rationale}</p> : null}
          {approval ? (
            <section
              className="automatic-review-exact"
              ref={previewRef}
              tabIndex={-1}
              aria-label="Exact memory update preview"
            >
              {hasApplicablePreview(current) ? (
                <ReviewNotice title="Preview ready" tone="proposal">
                  Review the full document below, then approve and apply this exact update.
                </ReviewNotice>
              ) : null}
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
              {hasApplicablePreview(current) || current.canFinishVerification ? (
                <button className="primary" type="button" disabled={controlsDisabled} onClick={() => void act('apply')}>
                  {current.canFinishVerification ? 'Finish verification' : 'Apply update'}
                </button>
              ) : null}
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
            {busy ? (
              <ReviewProgress
                title={action === 'apply' ? 'Saving and verifying the approved document…' : 'Saving review decision…'}
              />
            ) : null}
            {current.state === 'pending' ? (
              <>
                <button disabled={controlsDisabled} type="button" onClick={() => void act('defer')}>
                  Defer
                </button>
                <button disabled={controlsDisabled} type="button" onClick={() => void act('reject')}>
                  Reject
                </button>
              </>
            ) : current.state === 'deferred' ? (
              <button disabled={controlsDisabled} type="button" onClick={() => void act('resume')}>
                Resume review
              </button>
            ) : null}
          </footer>
        </>
      )}
    </DetailModal>
  );
}
