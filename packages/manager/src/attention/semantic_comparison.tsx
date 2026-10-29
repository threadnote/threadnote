import {retainSemanticChoice, semanticEvidenceIdentity} from './semantic_recovery.js';
import React, {useEffect, useId, useRef, useState} from 'react';
import {Schema} from 'effect';
import {ExternalLink, Info} from 'lucide-react';
import type {ContextHealthSemanticContradictionV2} from '@threadnote/context/health_semantic';
import {maintenanceMemoryTitle} from './maintenance.js';
import type {
  ManagerSemanticReviewInputV1,
  ManagerSemanticReviewPreviewV1,
  ManagerSemanticReviewApplyResultV1,
} from './contracts.js';
import {MemoryBody} from '../detail_modal.js';
import {MemoryExcerpt, ReviewBadge} from '../review_presentation.js';
import {memoryDocumentParts} from '../library_model.js';
import {api, errorMessage, ManagerApiError} from '../ui/support.js';

export type SemanticResolutionChoice = ManagerSemanticReviewInputV1['choice'];

export function SemanticComparisonEvidence(props: {
  readonly evidence: ContextHealthSemanticContradictionV2;
  readonly onOpenLibrary: (uri: string) => void;
  readonly selection?: {
    readonly choice?: SemanticResolutionChoice;
    readonly onChoose: (choice: SemanticResolutionChoice) => void;
    readonly disabled?: boolean;
  };
}): React.ReactElement {
  const {evidence, selection} = props;
  const choiceName = useId();
  const needsContext = evidence.classification === 'uncertain-comparison' || evidence.uncertainty.length > 0;
  const explanation =
    evidence.reason === 'policy-conflict'
      ? 'One memory describes what happens; the other says what should happen. They may need to be brought into agreement.'
      : evidence.reason === 'opposite-polarity'
        ? 'These memories ask for opposite behavior. Check whether they apply to the same situation.'
        : evidence.reason === 'incompatible-values'
          ? 'These memories give different values for the same setting. Check which situations and dates each value applies to.'
          : 'These memories may disagree. Threadnote could not reliably interpret their meaning, so they need your review.';
  return (
    <section aria-label="Semantic comparison evidence" className="semantic-comparison">
      <div className="semantic-comparison-intro">
        <span className="semantic-comparison-status">
          <Info size={14} aria-hidden="true" />
          {needsContext ? 'Possible conflict · context needed' : 'Conflict to review'}
        </span>
        <p>{explanation}</p>
        {needsContext ? (
          <p className="muted">
            Missing context could explain the difference. This is a possible conflict, not a verdict.
          </p>
        ) : null}
      </div>
      {selection ? (
        <div className="semantic-choice-intro">
          <h3>Which memory is correct?</h3>
          <p>Choose the advice that should apply today, then review the proposed change before confirming.</p>
        </div>
      ) : null}
      <div role={selection ? 'radiogroup' : undefined} aria-label={selection ? 'Which memory is correct?' : undefined}>
        <div className="semantic-memory-grid">
          {[evidence.left, evidence.right].map((claim, index) => {
            const label = index === 0 ? 'A' : 'B';
            return (
              <article
                className={`semantic-memory-card${selection?.choice === (index === 0 ? 'left' : 'right') ? ' is-selected' : ''}`}
                key={claim.claimId}
                aria-label={`Memory ${label}`}
              >
                <header>
                  <h3>Memory {label}</h3>
                  <ReviewBadge tone={claim.role === 'descriptive' ? 'info' : 'protected'}>
                    {claim.role === 'descriptive'
                      ? 'Observed behavior'
                      : claim.role === 'normative'
                        ? 'Required behavior'
                        : 'Historical decision'}
                  </ReviewBadge>
                </header>
                <p className="semantic-memory-name">{maintenanceMemoryTitle(claim.recordUri)}</p>
                <MemoryExcerpt label={`Statement from memory ${label}`}>{claim.text}</MemoryExcerpt>
                <dl className="semantic-memory-context">
                  <div>
                    <dt>Section</dt>
                    <dd>{claim.context.headings.join(' / ') || 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Environment</dt>
                    <dd>
                      {claim.context.environment === '*'
                        ? 'All environments'
                        : (claim.context.environment ?? 'Unknown')}
                    </dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>{claim.context.workspaceScope ?? 'Repository-wide'}</dd>
                  </div>
                  <div>
                    <dt>Valid from</dt>
                    <dd>{claim.context.validFrom ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Valid until</dt>
                    <dd>{claim.context.validTo ?? 'Unknown'}</dd>
                  </div>
                </dl>
                {selection ? (
                  <label className="semantic-memory-choice">
                    <input
                      type="radio"
                      name={choiceName}
                      value={index === 0 ? 'left' : 'right'}
                      checked={selection.choice === (index === 0 ? 'left' : 'right')}
                      disabled={selection.disabled}
                      onChange={() => selection.onChoose(index === 0 ? 'left' : 'right')}
                    />
                    <span>Memory {label} is correct</span>
                  </label>
                ) : null}
                <div className="semantic-memory-actions">
                  <button type="button" onClick={() => props.onOpenLibrary(claim.recordUri)}>
                    <ExternalLink size={14} aria-hidden="true" /> Open memory {label}
                  </button>
                </div>
                <details className="semantic-source-details">
                  <summary>Source and extraction details</summary>
                  <p>
                    Source: <code>{claim.recordUri}</code>
                  </p>
                  <p>
                    Project: {claim.context.project ?? 'Unknown'}. Body span: {claim.span.start}–{claim.span.end}.
                    Extraction: {claim.extraction.replaceAll('-', ' ')}.
                  </p>
                  <p>
                    Claim: <code>{claim.claimId}</code>
                  </p>
                  <p>
                    Source revision: <code>{claim.recordContentFingerprint}</code>
                  </p>
                </details>
              </article>
            );
          })}
        </div>
        {selection ? (
          <label className={`semantic-both-choice${selection.choice === 'both' ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={choiceName}
              value="both"
              checked={selection.choice === 'both'}
              disabled={selection.disabled}
              onChange={() => selection.onChoose('both')}
            />
            <span>
              <strong>Both memories apply</strong>
              <small>The difference is intentional: each describes a different context or time.</small>
            </span>
          </label>
        ) : null}
      </div>
      <section className="semantic-review-guide" aria-label="How to review">
        <h3>How to review</h3>
        <ol>
          <li>Check whether both statements apply to the same environment, workspace, and dates.</li>
          <li>
            Open each memory for the full context. Decide whether the difference is intentional or the advice needs
            updating.
          </li>
          <li>
            {selection
              ? 'Select your choice, preview the exact outcome, and confirm only after reviewing the full change.'
              : 'Make any needed edits in Library, then refresh context health to check again.'}
          </li>
        </ol>
        <p className="muted">
          {selection
            ? 'Selecting advice or opening a memory does not change anything. You will review the exact outcome before confirming.'
            : 'This comparison is review-only. Opening memories or preparing a review task does not change them.'}
        </p>
      </section>
      <details className="semantic-source-details">
        <summary>Comparison details</summary>
        <p>
          {evidence.reason.replaceAll('-', ' ')}; {evidence.classification.replaceAll('-', ' ')}
          {evidence.uncertainty.length === 0 ? '' : `; ${evidence.uncertainty.join(', ').replaceAll('-', ' ')}`}.
        </p>
      </details>
    </section>
  );
}

export function SemanticResolutionReview(props: {
  readonly project: string;
  readonly evidence: ContextHealthSemanticContradictionV2;
  readonly onOpenLibrary: (uri: string) => void;
  readonly onResolved: () => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly secondaryAction?: React.ReactNode;
  readonly ownerInstructions?: string;
  readonly writesDisabled?: boolean;
  readonly reviewNotice?: React.ReactNode;
}): React.ReactElement {
  const [choice, setChoice] = useState<SemanticResolutionChoice>();
  const [preview, setPreview] = useState<ManagerSemanticReviewPreviewV1>();
  const [reviewedWholeMemory, setReviewedWholeMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const review = useRef<HTMLElement>(null);
  const previewScope = useRef<string | undefined>(undefined);
  const {evidence} = props;
  const prior = useRef({project: props.project, evidence});
  const evidenceKey = semanticEvidenceIdentity(evidence);
  const scopeKey = JSON.stringify([props.project, evidenceKey]);
  useEffect(() => {
    const previous = prior.current;
    prior.current = {project: props.project, evidence};
    request.current?.abort();
    setChoice(value =>
      previous.project === props.project ? retainSemanticChoice(value, previous.evidence, evidence) : undefined,
    );
    setPreview(undefined);
    setReviewedWholeMemory(false);
    setBusy(false);
    setError(
      previous.project === props.project && semanticEvidenceIdentity(previous.evidence) !== evidenceKey
        ? 'The statements changed. Review the current outcome before confirming your choice.'
        : '',
    );
    setStale(false);
  }, [props.project, evidenceKey]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (preview || error) review.current?.focus();
  }, [preview, error]);
  const archiveReady =
    preview?.mode === 'archive-other' &&
    choice !== 'both' &&
    preview.keptUri === (choice === 'left' ? evidence.left.recordUri : evidence.right.recordUri) &&
    preview.archivedUri === (choice === 'left' ? evidence.right.recordUri : evidence.left.recordUri) &&
    preview.archivedContent !== undefined;
  const canConfirm =
    preview?.choice === choice &&
    previewScope.current === scopeKey &&
    !busy &&
    !stale &&
    !props.writesDisabled &&
    (preview?.mode === 'keep-both' || (archiveReady && reviewedWholeMemory));
  function choose(value: SemanticResolutionChoice) {
    setChoice(value);
    setPreview(undefined);
    setReviewedWholeMemory(false);
    setError('');
  }
  function failed(cause: unknown) {
    const isStale = Schema.is(ManagerApiError)(cause) && cause.status === 409;
    setError(
      isStale
        ? 'Checking the current statements. Your choice is retained; review the refreshed outcome before confirming.'
        : errorMessage(cause),
    );
    setPreview(undefined);
    setReviewedWholeMemory(false);
    setStale(isStale);
    if (isStale) void Promise.resolve(props.onRefresh()).then(() => setStale(false));
  }
  async function prepare() {
    if (!choice || busy || stale || props.writesDisabled) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setPreview(undefined);
    setReviewedWholeMemory(false);
    try {
      const source = (claim: typeof evidence.left) => ({
        recordUri: claim.recordUri,
        recordContentFingerprint: claim.recordContentFingerprint,
        claimFingerprint: claim.claimFingerprint,
      });
      const result = await api<{preview: ManagerSemanticReviewPreviewV1}>(
        '/api/context-health/semantic/preview',
        {
          project: props.project,
          contradictionId: evidence.contradictionId,
          left: source(evidence.left),
          right: source(evidence.right),
          choice,
        },
        {signal: controller.signal, timeoutMilliseconds: 30_000},
      );
      if (controller.signal.aborted) return;
      if (result.preview.choice !== choice)
        throw new Error('This preview belongs to a different choice. Prepare it again.');
      previewScope.current = scopeKey;
      setPreview(result.preview);
    } catch (cause) {
      if (!controller.signal.aborted) failed(cause);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function confirm() {
    if (!preview || !canConfirm || props.writesDisabled) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await api<{result: ManagerSemanticReviewApplyResultV1}>(
        '/api/context-health/semantic/apply',
        {
          project: props.project,
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        },
        {signal: controller.signal, timeoutMilliseconds: 30_000},
      );
      if (controller.signal.aborted) return;
      if (response.result?.status !== 'applied' && response.result?.status !== 'already-applied')
        throw new Error('The change was not confirmed. Refresh context health before trying again.');
      props.onResolved();
    } catch (cause) {
      if (!controller.signal.aborted) failed(cause);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <SemanticComparisonEvidence
        evidence={evidence}
        onOpenLibrary={props.onOpenLibrary}
        selection={{choice, onChoose: choose, disabled: busy || stale || props.writesDisabled}}
      />
      <section
        ref={review}
        tabIndex={-1}
        className="semantic-resolution"
        aria-label="Review your choice"
        aria-busy={busy}
      >
        {error ? <p role="alert">{error}</p> : null}
        {preview ? (
          <>
            <h3>{preview.mode === 'review-only' ? 'Review the source advice' : 'Review before confirming'}</h3>
            <p>{preview.summary}</p>
            {preview.reason ? <p>{preview.reason}</p> : null}
            {preview.constraints?.length ? (
              <ul>
                {preview.constraints.map(value => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            ) : null}
            {preview.mode === 'archive-other' ? (
              <>
                <p className="semantic-archive-warning">
                  This moves the <strong>whole memory {choice === 'left' ? 'B' : 'A'}</strong> to preserved history,
                  including advice outside the quote above. It will no longer be current advice.
                </p>
                {preview.archivedContent !== undefined ? (
                  <details className="semantic-whole-memory">
                    <summary>Review the whole memory that moves to history</summary>
                    <MemoryBody content={memoryDocumentParts(preview.archivedContent).body} />
                  </details>
                ) : null}
                {archiveReady ? (
                  <label className="semantic-archive-confirmation">
                    <input
                      type="checkbox"
                      checked={reviewedWholeMemory}
                      disabled={busy}
                      onChange={event => setReviewedWholeMemory(event.target.checked)}
                    />
                    <span>I reviewed the whole memory and approve moving it to history.</span>
                  </label>
                ) : (
                  <p role="alert">
                    The full memory preview is incomplete. Prepare your choice again before confirming.
                  </p>
                )}
              </>
            ) : preview.mode === 'keep-both' ? (
              <p>
                Both memories stay current. This saves your decision locally without changing or publishing either
                source. Your review applies to these exact versions; future edits need a new review.
              </p>
            ) : (
              <>
                <p>
                  This choice cannot change these sources here. Open memory A or B to review its ownership and full
                  context.
                </p>
                {props.ownerInstructions ? (
                  <details className="semantic-source-details">
                    <summary>How to review shared changes</summary>
                    <p>{props.ownerInstructions}</p>
                  </details>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </section>
      <footer className="semantic-resolution-footer" aria-label="Conflict resolution actions">
        {props.reviewNotice}
        <span className="semantic-selection-status" role="status">
          {stale
            ? 'Refresh this comparison to continue.'
            : !choice
              ? 'Choose memory A, memory B, or both to continue.'
              : choice === 'both'
                ? 'Both memories selected'
                : `Memory ${choice === 'left' ? 'A' : 'B'} selected`}
        </span>
        <div className="semantic-resolution-actions">
          {stale ? (
            <button type="button" className="primary" onClick={() => void props.onRefresh()}>
              Refresh comparison
            </button>
          ) : (
            <>
              {preview && preview.mode !== 'review-only' ? (
                <button type="button" className="primary" disabled={!canConfirm} onClick={() => void confirm()}>
                  {busy
                    ? 'Confirming…'
                    : preview.mode === 'keep-both'
                      ? 'Confirm both apply'
                      : `Confirm and move memory ${choice === 'left' ? 'B' : 'A'} to history`}
                </button>
              ) : null}
              <button
                type="button"
                className={preview ? undefined : 'primary'}
                disabled={!choice || busy || props.writesDisabled}
                onClick={() => void prepare()}
              >
                {busy ? 'Checking current memories…' : preview ? 'Refresh my preview' : 'Preview my choice'}
              </button>
            </>
          )}
          {props.secondaryAction}
        </div>
      </footer>
    </>
  );
}
