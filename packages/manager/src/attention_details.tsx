import {
  isManagerContextHealthResponseV1,
  isManagerMaintenanceRefreshResultV1,
  isManagerSemanticRefreshResultV1,
  isProposalResponse,
  isReviewPreview,
  isStatusResponse2,
} from './api/response_guards.js';
import {Array as EffectArray, Option as EffectOption, Order} from 'effect';
import type {
  ManagerMaintenanceRefreshResultV1,
  ManagerContextMaintenanceCaseV2,
  ManagerSemanticRefreshResultV1,
} from './attention/contracts.js';
import {SemanticResolutionReview} from './attention/semantic_comparison.js';
import {ArrowRight, BookOpen, FileCode2, Sparkles} from 'lucide-react';
import {MemoryExcerpt, ReviewBadge, ReviewNotice} from './review_presentation.js';
import React, {useEffect, useRef, useState} from 'react';
import {Schema} from 'effect';
import type {CandidateReview} from '@threadnote/memory/candidate';
import {isSharedMemoryUri} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {KnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import type {ManagerContextHealthResponseV1} from './attention/contracts.js';
import {DetailModal, MemoryBody} from './detail_modal.js';
import {api, errorMessage, ManagerApiError} from './ui/support.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {evidenceReadError, retryEvidenceRead} from './attention/evidence_refresh.js';

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
    void api<ReviewPreview>(
      '/api/reviews/preview',
      {
        project: props.project,
        reviewId: props.reviewId,
      },
      undefined,
      isReviewPreview,
    )
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
  const candidate = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(preview?.review.candidates), __effectArrayReceiver =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(__effectArrayReceiver, item => item.candidateId === props.candidateId),
      ),
    ),
  );
  const canDecide = candidate?.state === 'pending' || candidate?.state === 'deferred';
  const mutation = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(preview?.delta.items), __effectArrayReceiver =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(__effectArrayReceiver, item => item.candidateId === props.candidateId),
      ),
    ),
  )?.mutationPreview;
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
    if (!preview || busy || !canDecide) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<ReviewPreview>(
        '/api/reviews/refresh-safety',
        {
          project: props.project,
          reviewId: props.reviewId,
          candidateId: props.candidateId,
          revision: preview.review.revision,
        },
        undefined,
        isReviewPreview,
      );
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
    if (!preview || busy || !canDecide) return;
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
          <h3>{canDecide ? 'What will change' : 'Review outcome'}</h3>
          <p>{candidate.reason}</p>
          <p>
            Operation:{' '}
            {personalCopyRequired
              ? 'Create a personal copy after your approval'
              : (Effect.pipe(mutation?.operation, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.replaceAll('_', ' ')),
                ) ?? 'Unavailable')}
          </p>
          {candidate.targetUri ? (
            <button onClick={() => props.onOpenLibrary(candidate.targetUri)} type="button">
              Inspect existing memory in Library
            </button>
          ) : null}
          {canDecide ? (
            <>
              {personalCopyRequired ? (
                <section className="review-safety-state" role="status">
                  <h3>Personal copy of shared memory</h3>
                  <p>
                    The existing memory belongs to a shared team. You can approve this proposal as a personal memory.
                    The shared source will stay unchanged.
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
                    Before approval, Threadnote verifies that the same reviewed memory still exists and checks whether
                    this proposal would remove sections from it. This check does not change any memory.
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
            </>
          ) : (
            <p className="workspace-note">This proposal is {candidate.state}. Its decision controls are read-only.</p>
          )}
          {(candidate.evidence?.length ?? 0) > 0 ? (
            <details>
              <summary>Source evidence</summary>
              <ul>
                {EffectArray.map(candidate.evidence ?? [], item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          {canDecide ? (
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
          ) : null}
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
  readonly memoryPreview?: ManagerContextHealthResponseV1['recordPreviews'][number];
  readonly project: string;
  readonly repairsAvailable: boolean;
  readonly after?: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly onRefresh?: () => void;
  readonly onOpenLibrary: (uri?: string) => void;
  readonly stale?: boolean;
  readonly onEvidenceUpdated?: (item: ManagerContextMaintenanceCaseV2) => void;
}): React.ReactElement {
  const [currentFinding, setCurrentFinding] = useState(props.finding);
  const [proposal, setProposal] = useState<RepairProposal>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [frozen, setFrozen] = useState(false);
  const [semanticEvidence, setSemanticEvidence] = useState(props.finding.semanticEvidence);
  const [semanticChecking, setSemanticChecking] = useState(false);
  const [semanticUnavailable, setSemanticUnavailable] = useState('');
  const semanticRequest = useRef<AbortController | undefined>(undefined);
  const reviewFrozen = frozen || semanticChecking;
  const finding = currentFinding;
  const supportsSelectedRefresh =
    finding.category === 'semantic-contradiction' || EffectString.startsWith('citation-')(finding.category);
  const sourceUri =
    finding.repair.subjectUri ??
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        finding.uris,
        uri => uri !== finding.repair.targetUri && !Effect.pipe(uri, EffectString.includes('#')),
      ),
    );
  const targetUri = finding.repair.targetUri;
  const memoryPreview = props.memoryPreview?.uri === sourceUri ? props.memoryPreview : undefined;
  const citationEvidenceReady =
    proposal?.mutation.kind !== 'replace-citation' ||
    (proposal.mutation.citationId !== undefined && proposal.mutation.replacement !== undefined);
  async function preview(): Promise<void> {
    if (reviewFrozen) return;
    setBusy(true);
    setError('');
    setProposal(undefined);
    try {
      const result = await api<{proposal: RepairProposal}>(
        '/api/context-health/preview',
        {
          project: props.project,
          findingId: finding.id,
          subjectUri: sourceUri,
          findingCategory: finding.category,
          after: props.after,
        },
        undefined,
        isProposalResponse,
      );
      setProposal(result.proposal);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function apply(): Promise<void> {
    if (!proposal || busy || reviewFrozen) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{status: string}>(
        '/api/context-health/apply',
        {
          project: props.project,
          proposalId: proposal.proposalId,
          revision: proposal.revision,
          approved: true,
          ...proposal.selector,
        },
        undefined,
        isStatusResponse2,
      );
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
  async function revalidate(): Promise<void> {
    if (busy) return;
    if (supportsSelectedRefresh && finding.caseId) {
      await refreshSemanticEvidence();
      return;
    }
    semanticRequest.current?.abort();
    const controller = new AbortController();
    semanticRequest.current = controller;
    setBusy(true);
    setFrozen(true);
    setError('');
    try {
      const current = await api<ManagerContextHealthResponseV1>(
        `/api/context-health?project=${encodeURIComponent(props.project)}`,
        undefined,
        {signal: controller.signal, timeoutMilliseconds: 30_000},
        isManagerContextHealthResponseV1,
      );
      if (controller.signal.aborted) return;
      const sameFinding = EffectOption.getOrUndefined(
        EffectArray.findFirst(current.findings, item => item.id === finding.id),
      );
      if (!sameFinding) {
        setNotice('This check is no longer present in current evidence. No repair was applied.');
        return;
      }
      if (JSON.stringify(sameFinding) !== JSON.stringify(finding)) {
        setError('This decision changed. Close and reopen it to review current evidence.');
        return;
      }
      setCurrentFinding(sameFinding);
      setProposal(undefined);
      setFrozen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function refreshSemanticEvidence() {
    if (finding.category !== 'semantic-contradiction') {
      await refreshMaintenanceEvidence();
      return;
    }
    const selected = semanticEvidence ?? finding.semanticEvidence;
    if (!selected) return;
    semanticRequest.current?.abort();
    const controller = new AbortController();
    semanticRequest.current = controller;
    setSemanticChecking(true);
    setFrozen(true);
    try {
      const source = (claim: typeof selected.left) => ({
        recordUri: claim.recordUri,
        recordContentFingerprint: claim.recordContentFingerprint,
        claimFingerprint: claim.claimFingerprint,
      });
      const result = await retryEvidenceRead(async () => {
        const checked = await api<ManagerSemanticRefreshResultV1>(
          '/api/context-health/semantic/refresh',
          {
            project: props.project,
            contradictionId: selected.contradictionId,
            left: source(selected.left),
            right: source(selected.right),
          },
          {signal: controller.signal, timeoutMilliseconds: 30_000},
          isManagerSemanticRefreshResultV1,
        );
        if (checked.outcome === 'changing') throw new Error(checked.reason);
        return checked;
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.outcome === 'ready') {
        const expected = EffectArray.join(
          EffectArray.sort([selected.left.recordUri, selected.right.recordUri], Order.String),
          '\n',
        );
        if (
          EffectArray.join(
            EffectArray.sort([result.evidence.left.recordUri, result.evidence.right.recordUri], Order.String),
            '\n',
          ) !== expected ||
          EffectArray.some(
            [result.evidence.left, result.evidence.right],
            claim => claim.context.project !== props.project,
          )
        )
          throw new Error('The refreshed comparison does not match the selected memories.');
        setSemanticEvidence(result.evidence);
        setCurrentFinding(value => ({...value, semanticEvidence: result.evidence}));
        setFrozen(false);
        setSemanticUnavailable('');
      } else if (result.outcome === 'unavailable' || result.outcome === 'superseded') {
        setSemanticEvidence(undefined);
        setSemanticUnavailable(result.reason);
      } else if (result.outcome === 'incomplete') {
        setSemanticUnavailable(result.reason);
      } else throw new Error('The current comparison check was incomplete.');
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (Schema.is(ManagerApiError)(cause) && [401, 403, 404].includes(cause.status)) setSemanticEvidence(undefined);
      setSemanticUnavailable(evidenceReadError(cause));
    } finally {
      if (!controller.signal.aborted) setSemanticChecking(false);
    }
  }
  async function refreshMaintenanceEvidence() {
    if (!finding.caseId) return;
    semanticRequest.current?.abort();
    const controller = new AbortController();
    semanticRequest.current = controller;
    setSemanticChecking(true);
    setFrozen(true);
    try {
      const result = await retryEvidenceRead(
        () =>
          api<ManagerMaintenanceRefreshResultV1>(
            '/api/attention/context-maintenance',
            {action: 'refresh-case', project: props.project, caseId: finding.caseId},
            {signal: controller.signal, timeoutMilliseconds: 30_000},
            isManagerMaintenanceRefreshResultV1,
          ),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.outcome === 'ready' || result.outcome === 'resolved') {
        setFrozen(false);
        setSemanticUnavailable('');
        setError('');
        if (result.packet.semanticEvidence) {
          setSemanticEvidence(result.packet.semanticEvidence);
          setCurrentFinding(value => ({
            ...value,
            caseId: result.item.caseId,
            semanticEvidence: result.packet.semanticEvidence,
          }));
        }
        if (result.packet.repairFinding) {
          setCurrentFinding(result.packet.repairFinding);
          setProposal(undefined);
        }
        props.onEvidenceUpdated?.(result.item);
        if (result.outcome === 'resolved') {
          setProposal(undefined);
          setNotice('This check now passes. No memory content was changed.');
        }
      } else {
        setSemanticEvidence(undefined);
        if (result.item) props.onEvidenceUpdated?.(result.item);
        setSemanticUnavailable('reason' in result ? result.reason : 'Current evidence is unavailable.');
        setError('reason' in result ? result.reason : 'Current evidence is unavailable.');
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (Schema.is(ManagerApiError)(cause) && [401, 403, 404].includes(cause.status)) setSemanticEvidence(undefined);
      setSemanticUnavailable(evidenceReadError(cause));
      setError(evidenceReadError(cause));
    } finally {
      if (!controller.signal.aborted) setSemanticChecking(false);
    }
  }
  useEffect(() => {
    if (props.stale) void revalidate();
  }, [props.stale, props.project, finding.caseId, supportsSelectedRefresh]);
  useEffect(() => () => semanticRequest.current?.abort(), []);
  const frozenNotice = (
    <p role={reviewFrozen ? 'alert' : undefined} style={{visibility: reviewFrozen ? 'visible' : 'hidden'}}>
      {semanticChecking ? 'Checking current evidence…' : 'Check the current evidence before confirming this repair.'}{' '}
      <button type="button" disabled={busy || semanticChecking} onClick={() => void revalidate()}>
        Check current evidence
      </button>
    </p>
  );
  if (finding.category === 'semantic-contradiction') {
    const evidenceNotice = (
      <div>
        <p role={semanticChecking ? 'status' : undefined} style={{visibility: semanticChecking ? 'visible' : 'hidden'}}>
          Checking current statements…
        </p>
        <p
          role={semanticUnavailable ? 'alert' : undefined}
          style={{visibility: semanticUnavailable ? 'visible' : 'hidden'}}
        >
          {semanticUnavailable}{' '}
          <button type="button" disabled={semanticChecking} onClick={() => void refreshSemanticEvidence()}>
            Check current evidence
          </button>
        </p>
      </div>
    );
    return (
      <DetailModal
        title="Compare conflicting memories"
        onClose={props.onClose}
        className="semantic-review-dialog"
        footer={!semanticEvidence ? evidenceNotice : undefined}
      >
        {semanticEvidence ? (
          <SemanticResolutionReview
            project={props.project}
            evidence={semanticEvidence}
            onOpenLibrary={props.onOpenLibrary}
            onResolved={() => {
              props.onChanged();
              props.onClose();
            }}
            onRefresh={refreshSemanticEvidence}
            writesDisabled={semanticChecking || !!semanticUnavailable}
            reviewNotice={evidenceNotice}
          />
        ) : (
          <>
            <p>These memories may disagree. Open both to compare their advice and the situations it applies to.</p>
            <p className="muted">Comparison evidence is unavailable. Review any change in Library.</p>
            {EffectArray.map(finding.uris, (uri, index) => (
              <button key={uri} type="button" onClick={() => props.onOpenLibrary(uri)}>
                Open memory {index === 0 ? 'A' : 'B'}
              </button>
            ))}
          </>
        )}
      </DetailModal>
    );
  }
  return (
    <DetailModal
      className="health-repair-dialog"
      title={
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks transform the matched text; Effect String accepts replacement strings only.
        Effect.pipe(finding.category, EffectString.replaceAll('-', ' ')).replace(/^./u, letter =>
          Effect.pipe(letter, EffectString.toUpperCase),
        )
      }
      onClose={props.onClose}
      footer={
        <>
          {frozenNotice}
          {!props.repairsAvailable &&
          Effect.pipe(finding.category, EffectString.startsWith('citation-')) ? undefined : proposal ? (
            proposal.mutation.kind === 'review-only' ? undefined : (
              <>
                <span className="muted">Apply only when the memory still matches the evidence.</span>
                <button
                  className="primary"
                  disabled={busy || !citationEvidenceReady || reviewFrozen}
                  onClick={() => void apply()}
                  type="button"
                >
                  {repairActionLabel(proposal.mutation.kind)}
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </>
            )
          ) : (
            <>
              <span className="muted">Review the proposed change before applying it.</span>
              <button className="primary" disabled={busy || reviewFrozen} onClick={() => void preview()} type="button">
                <Sparkles size={15} aria-hidden="true" />
                {busy ? 'Preparing preview…' : 'Preview repair'}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="health-repair-intro">
        <div className="review-badge-row">
          <ReviewBadge tone="warning">Needs review</ReviewBadge>
          <ReviewBadge tone="info">
            <FileCode2 size={13} aria-hidden="true" />
            {Effect.pipe(finding.category, EffectString.startsWith('citation-')) ? 'Code evidence' : 'Memory health'}
          </ReviewBadge>
        </div>
        <p>{healthFindingSummary(finding.category)}</p>
      </div>
      <ReviewNotice title="What this means" tone="warning">
        {healthFindingGuidance(finding.category)}
      </ReviewNotice>
      <section className="health-repair-step">
        <h3>
          <ArrowRight size={17} aria-hidden="true" />
          Next step
        </h3>
        <p>{healthFindingNextStep(finding.category)}</p>
      </section>
      {sourceUri ? (
        <section className="health-repair-source" aria-label="Source memory">
          <div className="health-dialog-section-heading">
            <h3>
              <BookOpen size={17} aria-hidden="true" />
              Source memory
            </h3>
            <ReviewBadge tone="info">Saved context</ReviewBadge>
          </div>
          {memoryPreview ? <strong>{memoryPreview.title}</strong> : null}
          {memoryPreview?.excerpt ? <MemoryExcerpt label="Saved memory">{memoryPreview.excerpt}</MemoryExcerpt> : null}
          <button onClick={() => props.onOpenLibrary(sourceUri)} type="button">
            Open source memory in Library
          </button>
        </section>
      ) : null}
      {targetUri && targetUri !== sourceUri ? (
        <section className="health-repair-reference">
          <h3>
            {Effect.pipe(finding.category, EffectString.startsWith('citation-'))
              ? 'Stored code reference'
              : 'Related memory target'}
          </h3>
          <p className="muted">
            {Effect.pipe(finding.category, EffectString.startsWith('citation-'))
              ? 'Compare the current source excerpt with the proposed replacement below.'
              : 'The related memory is unavailable; preview the repair before removing the broken link.'}
          </p>
        </section>
      ) : null}
      {error ? (
        <ReviewNotice title="Repair unavailable" tone="danger" role="alert">
          {error}
        </ReviewNotice>
      ) : null}
      {notice ? (
        <ReviewNotice title="Manual review needed" tone="warning">
          {notice}
        </ReviewNotice>
      ) : null}
      {!props.repairsAvailable && Effect.pipe(finding.category, EffectString.startsWith('citation-')) ? (
        <ReviewNotice title="Local checkout required" tone="warning">
          Repository-backed repairs require a configured local checkout for this project.
        </ReviewNotice>
      ) : proposal ? (
        <section className="review-proposal health-repair-proposal">
          <div className="health-dialog-section-heading">
            <h3>
              <Sparkles size={17} aria-hidden="true" />
              Repair preview
            </h3>
            <ReviewBadge tone={proposal.mutation.kind === 'review-only' ? 'warning' : 'proposal'}>
              {proposal.mutation.kind === 'review-only' ? 'Review required' : 'Proposed change'}
            </ReviewBadge>
          </div>
          <p>{proposal.summary}</p>
          <p className="muted">
            {proposal.mutation.kind === 'review-only'
              ? proposal.mutation.reason
              : `This will ${Effect.pipe(proposal.mutation.kind, EffectString.replaceAll('-', ' '))}.`}
          </p>
          {proposal.mutation.kind === 'replace-citation' && proposal.mutation.replacement ? (
            <CitationReplacementEvidence replacement={proposal.mutation.replacement} />
          ) : proposal.mutation.kind === 'replace-citation' ? (
            <p role="alert">The proposed citation evidence is incomplete. Refresh this repair preview.</p>
          ) : null}
          <details className="health-repair-diagnostics">
            <summary>Exact revision and checked memories</summary>
            <code>{proposal.revision}</code>
            {EffectArray.map(proposal.preconditions, item => (
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
          ) : null}
        </section>
      ) : null}
    </DetailModal>
  );
}

function CitationReplacementEvidence(props: {readonly replacement: MemoryCodeCitationV1}): React.ReactElement {
  const citation = props.replacement;
  const target = citation.target;
  return (
    <section className="health-repair-evidence" aria-label="Proposed citation evidence">
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
  return Effect.pipe(warning, EffectString.includes('review_session_context'))
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
      return 'Compare both source claims, applicability, and roles. Preserve compatible rules and historical decisions; review any policy violation or correction explicitly.';
    case 'guidance-locally-modified':
    case 'guidance-missing-block':
    case 'guidance-stale-sources':
    case 'guidance-unavailable':
      return 'Review the project guidance source and refresh its managed memory after correcting the mismatch.';
  }
}

function healthFindingSummary(category: Finding['category']): string {
  if (Effect.pipe(category, EffectString.startsWith('citation-')))
    return 'A stored code reference no longer matches the current project graph.';
  if (category === 'relation-target-missing') return 'A memory links to a related memory that is no longer available.';
  return 'This memory has a quality issue that needs review.';
}
