import React, {useEffect, useState} from 'react';
import {Schema} from 'effect';
import type {CandidateReview} from '@threadnote/memory/candidate';
import {isSharedMemoryUri} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {KnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import type {ManagerContextHealthResponseV1} from './attention/contracts.js';
import {DetailModal, MemoryBody} from './detail_modal.js';
import {api, errorMessage, ManagerApiError} from './ui/support.js';

type ReviewPreview = {review: CandidateReview; delta: KnowledgeDeltaV1};

export function ReviewDetail(props: {
  readonly project: string;
  readonly reviewId: string;
  readonly candidateId: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly onOpenLibrary: (uri?: string) => void;
}): React.ReactElement {
  const [replacementApproved, setReplacementApproved] = useState(false);
  const [missingTargetApproved, setMissingTargetApproved] = useState(false);
  const [missingTarget, setMissingTarget] = useState(false);
  const [operation, setOperation] = useState<'create' | 'replace' | ''>('');
  const [preview, setPreview] = useState<ReviewPreview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api<ReviewPreview>('/api/reviews/preview', {
      project: props.project,
      reviewId: props.reviewId,
    })
      .then(result => {
        if (!cancelled) setPreview(result);
      })
      .catch(cause => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.project, props.reviewId]);
  const candidate = preview?.review.candidates.find(item => item.candidateId === props.candidateId);
  const mutation = preview?.delta.items.find(item => item.candidateId === props.candidateId)?.mutationPreview;
  const reviewedOperation =
    mutation?.operation === 'create' || mutation?.operation === 'replace' ? mutation.operation : '';
  const personalCopyRequired =
    candidate?.targetUri !== undefined &&
    isSharedMemoryUri(candidate.targetUri) &&
    (mutation?.operation === 'replace' || mutation?.operation === 'requires_explicit_operation');
  const needsOperationChoice = mutation?.operation === 'requires_explicit_operation' || personalCopyRequired;
  const selectedOperation = operation || (personalCopyRequired ? '' : reviewedOperation);
  const needsSafetyRefresh = !personalCopyRequired && mutation?.replacementSafety?.classification === 'review-required';
  const canCreateMissingTarget =
    needsSafetyRefresh && missingTarget && selectedOperation === 'create' && missingTargetApproved;
  const replacementCheckSatisfied =
    (personalCopyRequired && selectedOperation === 'create') ||
    canCreateMissingTarget ||
    (!needsSafetyRefresh && (!mutation?.replacementSafety?.requiresExplicitApproval || replacementApproved));
  const canApprove =
    mutation &&
    !mutation.truncated &&
    (!needsOperationChoice || selectedOperation !== '') &&
    (!personalCopyRequired || selectedOperation === 'create') &&
    replacementCheckSatisfied;
  async function refreshSafety(): Promise<void> {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<ReviewPreview>('/api/reviews/refresh-safety', {
        project: props.project,
        reviewId: props.reviewId,
        candidateId: props.candidateId,
        revision: preview.review.revision,
      });
      setPreview(result);
      setOperation('');
      setReplacementApproved(false);
      setMissingTarget(false);
      setMissingTargetApproved(false);
    } catch (cause) {
      if (Schema.is(ManagerApiError)(cause) && cause.code === 'replacement-target-missing') {
        setMissingTarget(true);
        setOperation('create');
        setError('');
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: 'approve' | 'defer' | 'reject'): Promise<void> {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/reviews/decide', {
        project: props.project,
        reviewId: props.reviewId,
        candidateId: props.candidateId,
        revision: preview.review.revision,
        action,
        approved: action === 'approve',
        allowDestructiveReplacement: selectedOperation === 'replace' && replacementApproved,
        allowMissingReplacementCreate: canCreateMissingTarget,
        ...(selectedOperation ? {operation: selectedOperation} : {}),
      });
      props.onChanged();
      props.onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailModal title="Review proposed memory" onClose={props.onClose}>
      {error && !candidate ? <p role="alert">{error}</p> : null}
      {candidate && preview ? (
        <>
          <p>{preview.review.task}</p>
          <p className="muted">
            {candidate.kind} · {candidate.topic} · revision {preview.review.revision} · {candidate.state}
          </p>
          <MemoryBody content={candidate.applyBodyText ?? candidate.proposedText} />
          <h3>What will change</h3>
          <p>{candidate.reason}</p>
          <p>
            Operation:{' '}
            {personalCopyRequired
              ? 'Create a personal copy after your approval'
              : (mutation?.operation.replaceAll('_', ' ') ?? 'Unavailable')}
          </p>
          {candidate.targetUri ? (
            <button onClick={() => props.onOpenLibrary(candidate.targetUri)} type="button">
              Inspect existing memory in Library
            </button>
          ) : null}
          {personalCopyRequired ? (
            <section className="review-safety-state" role="status">
              <h3>Personal copy of shared memory</h3>
              <p>
                The existing memory belongs to a shared team. You can approve this proposal as a personal memory. The
                shared source will stay unchanged.
              </p>
            </section>
          ) : needsSafetyRefresh && missingTarget ? (
            <section className="review-safety-state">
              <h3>Previous memory no longer exists</h3>
              <p>
                The memory this proposal was going to replace has been removed. Creating the proposal now will not
                overwrite another memory. Threadnote will check its project, topic, and kind again before writing.
              </p>
              <label className="review-confirmation">
                <input
                  checked={missingTargetApproved}
                  onChange={event => setMissingTargetApproved(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>Create this as the current memory</strong>
                  <small>A new durable memory will be written from the reviewed proposal.</small>
                </span>
              </label>
              <p className="muted" role="status">
                {missingTargetApproved
                  ? 'Ready to create. Use “Create current memory” below.'
                  : 'Select the option above to enable creation.'}
              </p>
            </section>
          ) : needsSafetyRefresh ? (
            <section className="review-safety-state">
              <h3>Check the memory being replaced</h3>
              <p>
                Before approval, Threadnote verifies that the same reviewed memory still exists and checks whether this
                proposal would remove sections from it. This check does not change any memory.
              </p>
              <button disabled={busy} onClick={() => void refreshSafety()} type="button">
                {busy ? 'Checking current memory…' : 'Check current memory'}
              </button>
            </section>
          ) : mutation?.replacementSafety?.classification === 'preserving' ? (
            <section className="review-safety-state" role="status">
              <h3>Replacement check passed</h3>
              <p>The existing memory still matches this review. Approval will replace that exact version.</p>
            </section>
          ) : mutation?.replacementSafety?.warning ? (
            <p role="alert">{managerReplacementWarning(mutation.replacementSafety.warning)}</p>
          ) : null}
          {needsOperationChoice ? (
            <label>
              Choose the intended change
              <select
                value={operation}
                onChange={event =>
                  setOperation(
                    event.target.value === 'create' || event.target.value === 'replace' ? event.target.value : '',
                  )
                }
              >
                <option value="">Select an operation</option>
                <option value="create">
                  {personalCopyRequired ? 'Create a personal copy' : 'Create a separate memory'}
                </option>
                {candidate.targetUri && !personalCopyRequired ? (
                  <option value="replace">Replace the reviewed existing memory</option>
                ) : null}
              </select>
            </label>
          ) : null}
          {!personalCopyRequired && mutation?.replacementSafety?.classification === 'destructive-loss-risk' ? (
            <label>
              <input
                type="checkbox"
                checked={replacementApproved}
                onChange={event => setReplacementApproved(event.target.checked)}
              />
              I reviewed the existing memory and approve the content removal described above.
            </label>
          ) : null}
          {!canApprove && !needsSafetyRefresh ? (
            <p>
              {personalCopyRequired
                ? mutation?.truncated
                  ? 'This preview is incomplete and cannot be approved. You can defer or reject the proposal here.'
                  : 'Choose the personal-copy option before approving. You can defer or reject the proposal here.'
                : 'Review the required operation and replacement warning before approving. You can defer or reject the proposal here.'}
            </p>
          ) : null}
          {candidate.evidence.length > 0 ? (
            <details>
              <summary>Source evidence</summary>
              <ul>
                {candidate.evidence.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <footer>
            <button disabled={busy || !canApprove} onClick={() => void decide('approve')} type="button">
              {personalCopyRequired
                ? 'Approve and create personal copy'
                : missingTarget && selectedOperation === 'create'
                  ? 'Create current memory'
                  : mutation?.operation === 'no_action'
                    ? 'Confirm no change needed'
                    : 'Approve and apply'}
            </button>
            <button disabled={busy} onClick={() => void decide('defer')} type="button">
              Defer
            </button>
            <button className="danger" disabled={busy} onClick={() => void decide('reject')} type="button">
              Reject
            </button>
          </footer>
        </>
      ) : !error ? (
        <p role="status">Loading full review…</p>
      ) : null}
    </DetailModal>
  );
}

type Finding = ManagerContextHealthResponseV1['findings'][number];
interface RepairProposal {
  readonly proposalId: string;
  readonly revision: string;
  readonly summary: string;
  readonly mutation: {
    readonly kind: string;
    readonly citationId?: string;
    readonly reason?: string;
    readonly replacement?: MemoryCodeCitationV1;
    readonly subjectUri?: string;
    readonly targetUri?: string;
  };
  readonly selector?: {
    readonly findingCategory?: string;
    readonly after?: string;
    readonly topic?: string;
    readonly kind?: string;
  };
  readonly preconditions: readonly {readonly uri: string; readonly expectedContentHash: string}[];
}
export function HealthDetail(props: {
  readonly finding: Finding;
  readonly project: string;
  readonly repairsAvailable: boolean;
  readonly after?: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly onOpenLibrary: (uri?: string) => void;
}): React.ReactElement {
  const [proposal, setProposal] = useState<RepairProposal>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const finding = props.finding;
  const sourceUri =
    finding.repair.subjectUri ?? finding.uris.find(uri => uri !== finding.repair.targetUri && !uri.includes('#'));
  const targetUri = finding.repair.targetUri;
  const citationEvidenceReady =
    proposal?.mutation.kind !== 'replace-citation' ||
    (proposal.mutation.citationId !== undefined && proposal.mutation.replacement !== undefined);
  async function preview(): Promise<void> {
    setBusy(true);
    setError('');
    setProposal(undefined);
    try {
      const result = await api<{proposal: RepairProposal}>('/api/context-health/preview', {
        project: props.project,
        findingId: finding.id,
        subjectUri: sourceUri,
        findingCategory: finding.category,
        after: props.after,
      });
      setProposal(result.proposal);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function apply(): Promise<void> {
    if (!proposal || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{status: string}>('/api/context-health/apply', {
        project: props.project,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        approved: true,
        ...proposal.selector,
      });
      if (result.status === 'review-required') {
        setNotice('This repair requires manual review. Open the affected memory and follow the instructions below.');
        return;
      }
      props.onChanged();
      props.onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailModal title={finding.category.replaceAll('-', ' ')} onClose={props.onClose}>
      <p>{healthFindingSummary(finding.category)}</p>
      <h3>What this means</h3>
      <p>{healthFindingGuidance(finding.category)}</p>
      <h3>Next step</h3>
      <p>{healthFindingNextStep(finding.category)}</p>
      {sourceUri ? (
        <p>
          <strong>Source memory</strong>
          <br />
          <button onClick={() => props.onOpenLibrary(sourceUri)} type="button">
            Open source memory in Library
          </button>
        </p>
      ) : null}
      {targetUri && targetUri !== sourceUri ? (
        <p>
          <strong>
            {finding.category.startsWith('citation-') ? 'Stored code reference' : 'Related memory target'}
          </strong>
          <br />
          <small>
            {finding.category.startsWith('citation-')
              ? 'Compare the current source excerpt with the proposed replacement below.'
              : 'The related memory is unavailable; preview the repair before removing the broken link.'}
          </small>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!props.repairsAvailable ? (
        <p role="status">Repository-backed repairs require a configured local checkout for this project.</p>
      ) : proposal ? (
        <section>
          <h3>Repair preview</h3>
          <p>{proposal.summary}</p>
          <p>
            {proposal.mutation.kind === 'review-only'
              ? proposal.mutation.reason
              : `This will ${proposal.mutation.kind.replaceAll('-', ' ')}.`}
          </p>
          {proposal.mutation.kind === 'replace-citation' && proposal.mutation.replacement ? (
            <CitationReplacementEvidence replacement={proposal.mutation.replacement} />
          ) : proposal.mutation.kind === 'replace-citation' ? (
            <p role="alert">The proposed citation evidence is incomplete. Refresh this repair preview.</p>
          ) : null}
          <details>
            <summary>Exact revision and checked memories</summary>
            <code>{proposal.revision}</code>
            {proposal.preconditions.map(item => (
              <p key={item.uri}>
                {item.uri}
                <br />
                <code>{item.expectedContentHash}</code>
              </p>
            ))}
          </details>
          {proposal.mutation.kind === 'review-only' ? (
            <p>
              No automatic change is available for this finding. Review and update the memory in Library, then refresh
              context health.
            </p>
          ) : (
            <footer>
              <button disabled={busy || !citationEvidenceReady} onClick={() => void apply()} type="button">
                {repairActionLabel(proposal.mutation.kind)}
              </button>
            </footer>
          )}
        </section>
      ) : (
        <button disabled={busy} onClick={() => void preview()} type="button">
          {busy ? 'Preparing preview…' : 'Preview repair'}
        </button>
      )}
    </DetailModal>
  );
}

function CitationReplacementEvidence(props: {readonly replacement: MemoryCodeCitationV1}): React.ReactElement {
  const citation = props.replacement;
  const target = citation.target;
  return (
    <section aria-label="Proposed citation evidence">
      <h4>Proposed citation evidence</h4>
      <dl className="activation-review-guide">
        <div>
          <dt>Path</dt>
          <dd>
            <code>{citation.path}</code>
          </dd>
        </div>
        <div>
          <dt>Source commit</dt>
          <dd>
            <code>{citation.sourceCommit}</code>
            {citation.sourceDirty ? ' · working tree had changes' : ''}
          </dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>
            {target.kind === 'file' ? (
              'Whole file'
            ) : (
              <>
                {target.symbolKind} <code>{target.qualifiedName}</code> · {target.language} · lines {target.span.line}:
                {target.span.column}–{target.span.endLine}:{target.span.endColumn}
              </>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function managerReplacementWarning(warning: string): string {
  return warning.includes('review_session_context')
    ? 'Refresh the safety check against the current memory before approving this replacement.'
    : warning;
}

function repairActionLabel(mutationKind: string): string {
  switch (mutationKind) {
    case 'remove-relations':
      return 'Remove broken relation';
    case 'archive-memory':
      return 'Archive outdated memory';
    case 'replace-citation':
      return 'Recapture citation';
    case 'recapture-citations':
    case 'repair-citations':
    case 'replace-code-citations':
      return 'Apply citation repair';
    default:
      return 'Approve and apply repair';
  }
}

export function healthFindingGuidance(category: Finding['category']): string {
  if (category === 'citation-changed' || category === 'citation-missing' || category === 'citation-unknown')
    return 'The citation no longer resolves exactly against current graph evidence. Preview a recapture, review the exact source change, and apply it only when the memory still matches the current code.';
  if (category === 'relation-target-missing')
    return 'A link points to a memory that no longer exists. Open the source memory to decide whether to replace the link with a current memory. Preview repair can remove the broken relation when the target is confirmed absent; it does not recreate the missing memory.';
  return 'Inspect the affected memories and preview the proposed change. Automatic repairs are available only when the current evidence supports a safe, exact change.';
}

function healthFindingNextStep(category: Finding['category']): string {
  switch (category) {
    case 'citation-changed':
      return 'Compare this memory with the current source evidence below. Recapture the reference only when the guidance still matches the code.';
    case 'citation-missing':
      return 'Choose a current file or symbol that supports this memory, or remove the stale reference when it no longer applies.';
    case 'citation-unknown':
      return 'Refresh graph evidence, then review the current source before attaching a replacement reference.';
    case 'relation-target-missing':
      return 'Review the source memory, then remove the broken relation or replace it with a current memory.';
    case 'relation-target-inactive':
      return 'Review whether the relation should point to an active memory or be removed.';
    case 'relation-target-conflicted':
      return 'Resolve the related memory conflict before keeping or replacing this relation.';
    case 'exact-duplicate':
      return 'Compare both memories and retain the one that represents the current knowledge.';
    case 'validity-expired':
      return 'Confirm whether the memory remains current, then update or archive it.';
    case 'review-overdue':
      return 'Review the memory and record whether it remains current.';
    case 'candidate-contradiction':
    case 'candidate-possible-duplicate':
      return 'Compare the proposal with current knowledge before accepting or rejecting it.';
    case 'semantic-contradiction':
      return 'Compare the conflicting memories and update the one that no longer reflects the current decision.';
    case 'guidance-locally-modified':
    case 'guidance-missing-block':
    case 'guidance-stale-sources':
    case 'guidance-unavailable':
      return 'Review the project guidance source and refresh its managed memory after correcting the mismatch.';
  }
}

function healthFindingSummary(category: Finding['category']): string {
  if (category.startsWith('citation-')) return 'A stored code reference no longer matches the current project graph.';
  if (category === 'relation-target-missing') return 'A memory links to a related memory that is no longer available.';
  return 'This memory has a quality issue that needs review.';
}
