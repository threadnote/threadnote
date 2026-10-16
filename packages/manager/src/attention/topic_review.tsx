import React, {useEffect, useRef, useState} from 'react';
import {consolidationSections} from '@threadnote/memory/consolidation';
import type {
  TopicMaintenanceDraftV1,
  TopicMaintenanceReplaceOperationV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {ConsolidationModelPicker, useConsolidationModels} from '../consolidation_models.js';
import {DetailModal, MemoryBody} from '../detail_modal.js';
import {api, errorMessage} from '../ui/support.js';
import type {ManagerContextMaintenancePacketV2} from './contracts.js';
import type {ManagerTopicReviewActionV1, ManagerTopicReviewV1} from './topic_contracts.js';

interface TopicReviewProps {
  readonly project: string;
  readonly caseId?: string;
  readonly reviewId?: string;
  readonly initialPacket?: ManagerContextMaintenancePacketV2;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly onOpenLibrary: (uri: string) => void;
}

export function TopicReviewDialog(props: TopicReviewProps): React.ReactElement {
  return (
    <DetailModal title="Review topic update" onClose={props.onClose} className="topic-review-dialog">
      <TopicReviewContent {...props} />
    </DetailModal>
  );
}

export function TopicReviewContent(props: Omit<TopicReviewProps, 'onClose'>): React.ReactElement {
  const [packet, setPacket] = useState(props.initialPacket);
  const [review, setReview] = useState<ManagerTopicReviewV1>();
  const [draft, setDraft] = useState<TopicMaintenanceDraftV1>();
  const [backend, setBackend] = useState<'local-ai' | 'effect-ai'>('local-ai');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const operationEpoch = useRef(0);
  const mutationInFlight = useRef(false);
  useEffect(
    () => () => {
      operationEpoch.current += 1;
    },
    [],
  );
  const localModels = useConsolidationModels('local-ai', backend === 'local-ai', 'topicModel');
  const effectModels = useConsolidationModels('effect-ai', backend === 'effect-ai', 'topicModel');
  const modelSelection = backend === 'local-ai' ? localModels : effectModels;
  const caseId = props.caseId ?? review?.caseId;

  useEffect(() => {
    const controller = new AbortController();
    const epoch = operationEpoch.current;
    const options = {signal: controller.signal, timeoutMilliseconds: 30_000};
    setLoading(true);
    setPacket(undefined);
    async function load() {
      try {
        let currentPacket = props.initialPacket;
        let selectedReviewId = props.reviewId ?? currentPacket?.reviewId;
        let result: ManagerTopicReviewV1 | undefined;
        if (selectedReviewId) {
          result = await api<ManagerTopicReviewV1>(
            `/api/attention/topic-review?project=${encodeURIComponent(props.project)}&reviewId=${encodeURIComponent(selectedReviewId)}`,
            undefined,
            options,
          );
        }
        const needsPacket = !result || (result.state === 'pending' && result.caseObservationMatches);
        if (props.caseId && needsPacket) {
          currentPacket = await api<ManagerContextMaintenancePacketV2>(
            `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}&caseId=${encodeURIComponent(props.caseId)}`,
            undefined,
            options,
          );
          if (currentPacket.project !== props.project || currentPacket.caseId !== props.caseId)
            throw new Error('The selected topic case changed. Refresh its evidence.');
          if (!controller.signal.aborted && operationEpoch.current === epoch) setPacket(currentPacket);
        }
        selectedReviewId ??= currentPacket?.reviewId;
        if (selectedReviewId) {
          result ??= await api<ManagerTopicReviewV1>(
            `/api/attention/topic-review?project=${encodeURIComponent(props.project)}&reviewId=${encodeURIComponent(selectedReviewId)}`,
            undefined,
            options,
          );
          if (
            result.project !== props.project ||
            result.reviewId !== selectedReviewId ||
            result.kind !== 'topic-maintenance'
          )
            throw new Error('The selected topic review changed. Refresh it.');
          if (!controller.signal.aborted && operationEpoch.current === epoch) {
            setReview(result);
            setDraft(result.draft);
          }
          if (!props.caseId && result.caseId && result.state === 'pending' && result.caseObservationMatches) {
            const reviewPacket = await api<ManagerContextMaintenancePacketV2>(
              `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}&caseId=${encodeURIComponent(result.caseId)}`,
              undefined,
              options,
            );
            if (reviewPacket.project !== props.project || reviewPacket.caseId !== result.caseId)
              throw new Error('The topic case changed. Refresh its evidence.');
            if (!controller.signal.aborted && operationEpoch.current === epoch) setPacket(reviewPacket);
          }
        } else if (!controller.signal.aborted && operationEpoch.current === epoch) {
          setReview(undefined);
          setDraft(undefined);
        }
      } catch (cause) {
        if (!controller.signal.aborted && operationEpoch.current === epoch) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted && operationEpoch.current === epoch) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [props.project, props.caseId, props.reviewId, generation]);

  const topic = packet?.topicEvidence;
  const acceptedBody = review?.acceptedBody ?? topic?.body;
  const originalParagraphs = acceptedBody ? safeSections(acceptedBody) : [];
  const changedDraft =
    review !== undefined && draft !== undefined && JSON.stringify(draft) !== JSON.stringify(review.draft);
  const draftReady =
    !!draft &&
    (draft.outcome === 'propose-update' || draft.outcome === 'propose-revalidation') &&
    (draft.outcome !== 'propose-update' || draft.operations.length > 0) &&
    (draft.outcome !== 'propose-revalidation' || (draft.operations.length === 0 && draft.reviewedHandles.length > 0)) &&
    draft.operations.every(
      operation =>
        operation.text.trim() === operation.text &&
        !!operation.text &&
        !/\n[\t ]*\n/u.test(operation.text) &&
        operation.supportHandles.length > 0,
    );
  const currentPacket = packet?.project === props.project && topic?.outcome === 'ready';
  const packetMatchesReview =
    !review ||
    (currentPacket &&
      topic?.targetUri === review.targetUri &&
      topic?.targetHash === review.targetHash &&
      topic?.observationRevision === review.observationRevision);
  const observationMatches = !review || review.generation.origin === 'manual' || review.caseObservationMatches;
  const canPreview =
    !!review &&
    draftReady &&
    !!packetMatchesReview &&
    observationMatches &&
    !loading &&
    !busy &&
    !error &&
    review.state === 'pending';
  const approval = review?.approval;
  const previewCurrent =
    !!approval && !changedDraft && approval.reviewRevision === review?.revision && approval.stage === 'preview';
  const canApply =
    review?.state === 'pending' &&
    !!review.canApply &&
    !!previewCurrent &&
    !!packetMatchesReview &&
    observationMatches &&
    !loading &&
    !busy &&
    !error;
  const canResumeAcceptance =
    review?.state === 'applying' &&
    approval?.stage === 'prepared' &&
    !!review.canApply &&
    !changedDraft &&
    !loading &&
    !busy &&
    !error;
  const availableToGenerate =
    !!caseId &&
    !!currentPacket &&
    !loading &&
    !busy &&
    !!modelSelection.model &&
    (!review || review.state === 'pending');

  async function mutate(action: ManagerTopicReviewActionV1) {
    if (busy || loading || mutationInFlight.current) return;
    mutationInFlight.current = true;
    const epoch = ++operationEpoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<ManagerTopicReviewV1>('/api/attention/topic-review', action);
      if (operationEpoch.current !== epoch || result.project !== props.project || result.kind !== 'topic-maintenance')
        return;
      setReview(result);
      setDraft(result.draft);
      setLoading(true);
      setGeneration(value => value + 1);
      props.onChanged();
      setNotice(
        action.action === 'apply'
          ? result.approval?.stage === 'written' || result.state === 'applied'
            ? 'The reviewed topic update was saved.'
            : 'The saved result needs another review. Refresh the evidence below.'
          : action.action === 'preview'
            ? 'Exact final document prepared for review.'
            : action.action === 'generate' || action.action === 'regenerate'
              ? 'Draft ready to review.'
              : `Review ${action.action === 'resume' ? 'resumed' : action.action === 'defer' ? 'deferred' : 'rejected'}.`,
      );
    } catch (cause) {
      if (operationEpoch.current === epoch) {
        setError(errorMessage(cause));
        setLoading(true);
        setGeneration(value => value + 1);
        props.onChanged();
      }
    } finally {
      mutationInFlight.current = false;
      if (operationEpoch.current === epoch) setBusy(false);
    }
  }

  function editParagraph(ordinal: number, text: string) {
    if (!draft || !review) return;
    const before = review.paragraphs[ordinal];
    if (!before || before.role !== 'descriptive') return;
    const existing = draft.operations.find(item => item.ordinal === ordinal);
    const accepted = originalParagraphs[ordinal] ?? '';
    if (text === accepted) {
      const operations = draft.operations.filter(item => item.ordinal !== ordinal);
      const reviewedHandles = [
        ...new Set([
          ...draft.reviewedHandles,
          ...review.support.filter(source => source.variant === 'current').map(source => source.handleId),
        ]),
      ];
      setDraft({
        ...draft,
        operations,
        reviewedHandles,
        outcome: operations.length ? 'propose-update' : 'propose-revalidation',
      });
      return;
    }
    const paragraphHandles = review.support
      .filter(source => source.variant === 'current' && before.citationIds.includes(source.citationId))
      .map(source => source.handleId);
    const operation: TopicMaintenanceReplaceOperationV1 = existing
      ? {...existing, text}
      : {
          ordinal,
          beforeHash: before.hash,
          text,
          supportHandles: paragraphHandles,
          rationale: 'Reviewed edit to the descriptive claim.',
        };
    setDraft({
      ...draft,
      outcome: 'propose-update',
      reviewedHandles: [...new Set([...draft.reviewedHandles, ...paragraphHandles])],
      operations: [...draft.operations.filter(item => item.ordinal !== ordinal), operation].sort(
        (a, b) => a.ordinal - b.ordinal,
      ),
    });
  }

  function editSupport(ordinal: number, handleId: string, checked: boolean) {
    if (!draft || !review) return;
    const existing = draft.operations.find(item => item.ordinal === ordinal);
    const before = review.paragraphs[ordinal];
    if (!before || before.role !== 'descriptive') return;
    if (!existing) return;
    const operation: TopicMaintenanceReplaceOperationV1 = existing;
    const supportHandles = checked
      ? [...new Set([...operation.supportHandles, handleId])]
      : operation.supportHandles.filter(value => value !== handleId);
    setDraft({
      ...draft,
      reviewedHandles: checked ? [...new Set([...draft.reviewedHandles, handleId])] : draft.reviewedHandles,
      operations: [...draft.operations.filter(item => item.ordinal !== ordinal), {...operation, supportHandles}].sort(
        (a, b) => a.ordinal - b.ordinal,
      ),
    });
  }

  return (
    <section aria-busy={loading || busy} className="topic-review-content">
      {loading ? <p role="status">Loading topic and review…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <header className="health-dialog-section-heading">
        <h3>{review?.topic ?? 'Topic and source evidence'}</h3>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setError('');
            setNotice('');
            setGeneration(value => value + 1);
          }}
        >
          Refresh evidence
        </button>
      </header>
      <p>Source checks cover declared references only. Other claims may need separate review.</p>
      {topic?.outcome === 'unavailable' ? (
        <p role="alert">
          Current source evidence is unavailable: {topic.reason ?? 'no verified excerpt was returned'}.
        </p>
      ) : null}
      {!packet && review?.state === 'pending' ? (
        <p className="muted">The source case is unavailable. Refresh it before accepting this update.</p>
      ) : null}
      {review?.generation.origin !== 'manual' && review && !review.caseObservationMatches ? (
        <p role="status">Source evidence changed since this draft. Review the updated case before continuing.</p>
      ) : null}
      {topic?.outcome === 'ready' ? (
        <section aria-label="Source evidence">
          <h4>What changed in the source</h4>
          {topic.sources?.map(source => (
            <article key={source.citationId} className="health-code-preview">
              <p>
                {source.current.path} · {source.status.replaceAll('-', ' ')}
              </p>
              <div className="health-evidence-comparison">
                <section>
                  <h5>Original source</h5>
                  <pre>{source.oldExcerpt.content}</pre>
                </section>
                <section>
                  <h5>Current source</h5>
                  <pre>{source.newExcerpt.content}</pre>
                </section>
              </div>
            </article>
          ))}
          {!topic.sources?.length ? <p>No bounded source excerpts are available.</p> : null}
          {!!topic.truncatedExcerpts && <p>Some source excerpts were omitted because of the view limit.</p>}
        </section>
      ) : null}
      {review ? (
        <>
          <p className="muted">
            Review {review.state.replaceAll('-', ' ')} · checked revision {review.revision} · generated with{' '}
            {review.generation.agent} / {review.generation.model}
          </p>
          <p className="muted">
            {review.generation.usage.status === 'measured'
              ? `${review.generation.usage.inputTokens} input and ${review.generation.usage.outputTokens} output tokens measured`
              : 'Model usage unavailable'}{' '}
            · {review.generation.attempts} generation {review.generation.attempts === 1 ? 'attempt' : 'attempts'}
          </p>
          {review.warnings.map((warning, index) => (
            <p key={index} role="status">
              {warning}
            </p>
          ))}
          {review.draft.unresolvedQuestions.map((question, index) => (
            <p key={`q${index}`}>Unresolved: {question}</p>
          ))}
          {review.draft.removedClaims.map((claim, index) => (
            <p key={`r${index}`}>Claim removed from proposal: {claim}</p>
          ))}
          {review.draft.outcome === 'policy-conflict' ? (
            <p role="alert">
              This source change conflicts with a policy claim. Review the requirement before proposing an update.
            </p>
          ) : review.draft.outcome === 'insufficient-evidence' ? (
            <p role="alert">
              The available source does not support a decision yet. Refresh evidence or defer this review.
            </p>
          ) : null}
          <section aria-label="Focused topic comparison">
            <h4>Review proposed changes</h4>
            {review.paragraphs.map((paragraph, ordinal) => {
              const operation = draft?.operations.find(item => item.ordinal === ordinal);
              const original = originalParagraphs[ordinal] ?? '';
              const proposed = operation?.text ?? original;
              return (
                <article key={`${ordinal}:${paragraph.hash}`} className="health-code-preview">
                  <h5>
                    Paragraph {ordinal + 1}:{' '}
                    {paragraph.role === 'descriptive'
                      ? 'Observed behavior'
                      : paragraph.role === 'normative'
                        ? 'Policy requirement'
                        : 'Historical decision'}
                  </h5>
                  <p className="muted">
                    {paragraph.scope ? `Scope: ${paragraph.scope}. ` : ''}Support: {paragraph.support}.{' '}
                    {paragraph.role !== 'descriptive' ? 'This paragraph is preserved.' : ''}
                  </p>
                  {paragraph.role === 'descriptive' && operation ? (
                    <>
                      <strong>Accepted</strong>
                      <pre>{original}</pre>
                      <strong>Proposed</strong>
                    </>
                  ) : null}
                  {paragraph.role === 'descriptive' && review.state === 'pending' ? (
                    <textarea
                      aria-label={`Proposed descriptive paragraph ${ordinal + 1}`}
                      rows={Math.max(4, Math.min(12, proposed.split('\n').length + 2))}
                      value={proposed}
                      onChange={event => editParagraph(ordinal, event.target.value)}
                    />
                  ) : (
                    <pre>{proposed}</pre>
                  )}
                  {paragraph.role === 'descriptive' && operation ? (
                    <fieldset disabled={review.state !== 'pending'}>
                      <legend>Current source support for paragraph {ordinal + 1}</legend>
                      {review.support
                        .filter(source => source.variant === 'current')
                        .map(source => (
                          <label key={source.handleId} className="review-confirmation">
                            <input
                              type="checkbox"
                              checked={operation.supportHandles.includes(source.handleId)}
                              onChange={event => editSupport(ordinal, source.handleId, event.target.checked)}
                            />
                            {source.path}
                            {paragraph.citationIds.includes(source.citationId)
                              ? ' · declared for this paragraph'
                              : ' · other declared source'}
                          </label>
                        ))}
                    </fieldset>
                  ) : null}
                </article>
              );
            })}
          </section>
          {review.additionalDependencies.length > 0 ? (
            <details>
              <summary>Other declared dependencies</summary>
              {review.additionalDependencies.map(dependency => (
                <p key={dependency.citationId}>
                  {dependency.kind}: {dependency.citationId}
                </p>
              ))}
            </details>
          ) : null}
          <details>
            <summary>Full proposed topic</summary>
            <MemoryBody content={review.proposal.body} />
          </details>
          {approval && !changedDraft ? (
            <section aria-label="Exact final document" className="health-code-preview">
              <h4>
                {approval.stage === 'written'
                  ? 'Saved final document'
                  : previewCurrent || approval.stage === 'prepared'
                    ? 'Exact final document to save'
                    : 'Previous exact preview'}
              </h4>
              <p>
                {approval.stage === 'written'
                  ? 'This approved document was saved.'
                  : previewCurrent || approval.stage === 'prepared'
                    ? 'Review this full document and its metadata before accepting.'
                    : 'This preview is retained for reference. Prepare a fresh preview before accepting.'}
              </p>
              <MemoryBody content={approval.content} />
              <details>
                <summary>Metadata and provenance changes</summary>
                {approval.metadataDiff.length ? (
                  approval.metadataDiff.map(diff => (
                    <p key={diff.field}>
                      {diff.field} changed · previous {diff.beforeHash} · final {diff.afterHash}
                    </p>
                  ))
                ) : (
                  <p>No metadata fields changed.</p>
                )}
                <p>Final content checksum: {approval.contentHash}</p>
              </details>
            </section>
          ) : null}
          {changedDraft ? <p role="status">Edits need a new preview before acceptance.</p> : null}
          {!draftReady ? (
            <p role="status">
              This draft needs supported descriptive text or a supported unchanged review before preview.
            </p>
          ) : null}
          {review.blockingReason && !canApply ? (
            <p role="status">Acceptance paused: {review.blockingReason}. Refresh evidence or prepare a new preview.</p>
          ) : null}
          {review.state === 'applying' && approval?.stage === 'prepared' ? (
            <p role="status">
              The approved update was interrupted while saving. Resume the same approved change; Threadnote will check
              what was already written.
            </p>
          ) : null}
          {review.state === 'conflict' ? (
            <p role="alert">
              The accepted topic or its source changed during application. Refresh the case before closing this
              conflicted review.
            </p>
          ) : null}
        </>
      ) : null}
      <footer>
        {review?.targetUri ? (
          <button type="button" onClick={() => props.onOpenLibrary(review.targetUri)}>
            Open accepted topic
          </button>
        ) : null}
        <label>
          Generate with
          <select
            aria-label="Topic generation provider"
            disabled={busy || loading}
            value={backend}
            onChange={event => setBackend(event.target.value === 'effect-ai' ? 'effect-ai' : 'local-ai')}
          >
            <option value="local-ai">Local AI</option>
            <option value="effect-ai">Configured AI provider</option>
          </select>
        </label>
        <ConsolidationModelPicker
          selection={modelSelection}
          disabled={busy || loading}
          label="Topic generation model"
        />
        {modelSelection.error ? <p role="alert">{modelSelection.error}</p> : null}
        {!modelSelection.loading && !modelSelection.models.length ? (
          <p>No generation model is available for this provider.</p>
        ) : null}
        {caseId && (
          <button
            type="button"
            disabled={!availableToGenerate}
            onClick={() =>
              modelSelection.model &&
              void mutate({
                action: review ? 'regenerate' : 'generate',
                project: props.project,
                caseId,
                backend,
                modelId: modelSelection.model,
              })
            }
          >
            {review ? 'Regenerate draft' : 'Generate draft'}
          </button>
        )}
        {review?.state === 'pending' ? (
          <>
            <button
              type="button"
              disabled={!canPreview}
              onClick={() =>
                review &&
                void mutate({
                  action: 'preview',
                  project: props.project,
                  reviewId: review.reviewId,
                  revision: review.revision,
                  editedDraftJson: draft ? JSON.stringify(draft) : undefined,
                })
              }
            >
              Preview exact final document
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canApply}
              onClick={() =>
                approval &&
                void mutate({
                  action: 'apply',
                  project: props.project,
                  reviewId: review.reviewId,
                  revision: approval.reviewRevision,
                  approvalDigest: approval.approvalDigest,
                  approved: true,
                })
              }
            >
              {review.draft.outcome === 'propose-revalidation' ? 'Confirm unchanged' : 'Accept update'}
            </button>
            <button
              type="button"
              disabled={busy || loading || (review.generation.origin !== 'manual' && !caseId)}
              onClick={() =>
                void mutate({
                  action: 'defer',
                  project: props.project,
                  reviewId: review.reviewId,
                  revision: review.revision,
                  ...(caseId ? {caseId} : {}),
                })
              }
            >
              Defer
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || loading || (review.generation.origin !== 'manual' && !caseId)}
              onClick={() =>
                void mutate({
                  action: 'reject',
                  project: props.project,
                  reviewId: review.reviewId,
                  revision: review.revision,
                  ...(caseId ? {caseId} : {}),
                })
              }
            >
              Reject
            </button>
          </>
        ) : null}
        {review?.state === 'deferred' && (
          <button
            type="button"
            disabled={busy || loading || !observationMatches || (review.generation.origin !== 'manual' && !caseId)}
            onClick={() =>
              void mutate({
                action: 'resume',
                project: props.project,
                reviewId: review.reviewId,
                revision: review.revision,
                ...(caseId ? {caseId} : {}),
              })
            }
          >
            Resume review
          </button>
        )}
        {review?.state === 'applying' && approval?.stage === 'prepared' && (
          <button
            type="button"
            className="primary"
            disabled={!canResumeAcceptance}
            onClick={() =>
              void mutate({
                action: 'apply',
                project: props.project,
                reviewId: review.reviewId,
                revision: approval.reviewRevision,
                approvalDigest: approval.approvalDigest,
                approved: true,
              })
            }
          >
            Resume approved update
          </button>
        )}
        {review?.state === 'conflict' && (
          <button
            type="button"
            className="danger"
            disabled={busy || loading || !caseId}
            onClick={() =>
              void mutate({
                action: 'reject',
                project: props.project,
                reviewId: review.reviewId,
                revision: review.revision,
                caseId,
              })
            }
          >
            Close conflicted review
          </button>
        )}
      </footer>
    </section>
  );
}

function safeSections(body: string): readonly string[] {
  try {
    return consolidationSections(body);
  } catch {
    return [];
  }
}
