import React, {useEffect, useRef, useState} from 'react';
import {Schema} from 'effect';
import {consolidationSections} from '@threadnote/memory/consolidation';
import type {
  TopicMaintenanceDraftV1,
  TopicMaintenanceReplaceOperationV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  topicMaintenanceParagraphCoverage,
  topicMaintenanceParagraphEligible,
} from '@threadnote/memory/topic-maintenance-draft';
import {ConsolidationModelPicker, useConsolidationModels} from '../consolidation_models.js';
import {DetailModal, MemoryBody} from '../detail_modal.js';
import {RefreshCw} from 'lucide-react';
import {ReviewNotice} from '../review_presentation.js';
import {
  TopicParagraphComparison,
  TopicReviewNotes,
  TopicReviewSummary,
  TopicSourceEvidence,
} from './topic_review_presentation.js';
import {api, errorMessage, ManagerApiError} from '../ui/support.js';
import {evidenceReadError, maintenanceEvidenceBusy} from './evidence_refresh.js';
import {memoryDocumentParts} from '../library_model.js';
import type {ManagerContextMaintenancePacketV2, ManagerMaintenanceRefreshResultV1} from './contracts.js';
import type {
  ManagerTopicReviewActionV1,
  ManagerTopicReviewV1,
  ManagerTopicReviewResponseV1,
  ManagerTopicReviewRecoveryV1,
  ManagerTopicReviewAppliedV1,
} from './topic_contracts.js';

interface TopicReviewProps {
  readonly project: string;
  readonly caseId?: string;
  readonly reviewId?: string;
  readonly initialPacket?: ManagerContextMaintenancePacketV2;
  readonly onRefreshEvidence?: () => Promise<ManagerContextMaintenancePacketV2 | undefined>;
  readonly onChanged: () => void;
  readonly onApplied?: (result: ManagerTopicReviewAppliedV1) => void;
  readonly onClose: () => void;
  readonly onOpenLibrary: (uri: string) => void;
  readonly writesDisabled?: boolean;
}

const ReviewRecovery = Schema.Struct({
  action: Schema.Literal('open-review'),
  reviewId: Schema.String.check(Schema.isPattern(/^review-[a-f0-9]{24}$/u)),
  state: Schema.Literals(['applying', 'conflict', 'deferred', 'rejected', 'pending']),
});
const isReviewRecovery = Schema.is(ReviewRecovery);

export function TopicReviewDialog(props: TopicReviewProps): React.ReactElement {
  return (
    <DetailModal title="Review topic update" onClose={props.onClose} className="topic-review-dialog">
      <TopicReviewContent {...props} />
    </DetailModal>
  );
}

export function TopicReviewContent(
  props: Omit<TopicReviewProps, 'onClose'> & {readonly onClose?: () => void},
): React.ReactElement {
  const [packet, setPacket] = useState(props.initialPacket);
  const [sourceKind, setSourceKind] = useState<'code' | 'obsidian' | undefined>(
    props.initialPacket?.topicEvidence?.version === 2 ? 'obsidian' : undefined,
  );
  const [review, setReview] = useState<ManagerTopicReviewV1>();
  const [redactedReview, setRedactedReview] = useState<ManagerTopicReviewRecoveryV1>();
  const [draft, setDraft] = useState<TopicMaintenanceDraftV1>();
  const [backend, setBackend] = useState<'local-ai' | 'effect-ai'>('local-ai');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recovery, setRecovery] = useState<typeof ReviewRecovery.Type>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<ManagerTopicReviewActionV1['action']>();
  const [generation, setGeneration] = useState(0);
  const [invalidatedApproval, setInvalidatedApproval] = useState<string>();
  const selectionKey = JSON.stringify([props.project, props.caseId, props.reviewId, props.initialPacket?.reviewId]);
  const packetRevision = JSON.stringify([
    props.initialPacket?.evidenceRevision,
    props.initialPacket?.expectedContentHash,
    props.initialPacket?.topicEvidence?.observationRevision,
    props.initialPacket?.topicEvidence?.outcome,
  ]);
  const refreshRequested = useRef(false);
  const preparationAttempts = useRef(new Set<string>());
  const preparationBlocked = useRef(false);
  const mutationController = useRef<AbortController | undefined>(undefined);
  const heldDraft = useRef<
    {readonly selection: string; readonly reviewId: string; readonly draft: TopicMaintenanceDraftV1} | undefined
  >(undefined);
  const previousPacketRevision = useRef<string | undefined>(undefined);
  const incomingUnavailable = props.initialPacket?.topicEvidence?.outcome === 'unavailable';
  const activeSelection = useRef(selectionKey);
  const learnedReview = useRef<{readonly selection: string; readonly reviewId: string} | undefined>(undefined);
  const operationEpoch = useRef(0);
  const mutationInFlight = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      operationEpoch.current += 1;
      mutationController.current?.abort();
    },
    [],
  );
  const localModels = useConsolidationModels('local-ai', backend === 'local-ai', 'topicModel');
  const effectModels = useConsolidationModels('effect-ai', backend === 'effect-ai', 'topicModel');
  const modelSelection = backend === 'local-ai' ? localModels : effectModels;
  const caseId = props.caseId ?? review?.caseId ?? redactedReview?.caseId;

  useEffect(() => {
    const freshProvidedPacket =
      previousPacketRevision.current !== undefined && previousPacketRevision.current !== packetRevision;
    previousPacketRevision.current = packetRevision;
    const selectedRefreshRequested = refreshRequested.current;
    refreshRequested.current = false;
    const retained = activeSelection.current === selectionKey ? {packet, review, draft} : undefined;
    if (
      activeSelection.current === selectionKey &&
      review &&
      draft &&
      (review.generation.origin === 'manual' || JSON.stringify(draft) !== JSON.stringify(review.draft))
    )
      heldDraft.current = {selection: selectionKey, reviewId: review.reviewId, draft};
    if (activeSelection.current !== selectionKey) {
      activeSelection.current = selectionKey;
      heldDraft.current = undefined;
      preparationBlocked.current = false;
      mutationController.current?.abort();
      operationEpoch.current += 1;
      mutationInFlight.current = undefined;
      setBusy(false);
      setActiveAction(undefined);
      setReview(undefined);
      setRedactedReview(undefined);
      setDraft(undefined);
      setError('');
      setNotice('');
      setRecovery(undefined);
      setInvalidatedApproval(undefined);
      setSourceKind(undefined);
    }
    const controller = new AbortController();
    const epoch = operationEpoch.current;
    const options = {signal: controller.signal, timeoutMilliseconds: 30_000};
    setLoading(true);
    setPacket(undefined);
    // A refresh must discard previously authorized private text before any new read.
    if (
      review?.sourceKind === 'obsidian' ||
      packet?.topicEvidence?.version === 2 ||
      props.initialPacket?.topicEvidence?.version === 2
    ) {
      setReview(undefined);
      setDraft(undefined);
    }
    if (incomingUnavailable) {
      heldDraft.current = undefined;
      setPacket(props.initialPacket);
      setReview(undefined);
      setDraft(undefined);
      setRedactedReview(undefined);
      setLoading(false);
      return () => controller.abort();
    }
    async function load() {
      let selectedObservationPending = false;
      let privateLoad =
        sourceKind === 'obsidian' ||
        review?.sourceKind === 'obsidian' ||
        props.initialPacket?.topicEvidence?.version === 2;
      async function readSelectedReview(selectedReviewId: string) {
        const result = await api<ManagerTopicReviewResponseV1>(
          `/api/attention/topic-review?project=${encodeURIComponent(props.project)}&reviewId=${encodeURIComponent(selectedReviewId)}`,
          undefined,
          options,
        );
        if (
          result.project !== props.project ||
          result.reviewId !== selectedReviewId ||
          (result.kind !== 'topic-maintenance' && result.kind !== 'topic-maintenance-recovery')
        )
          throw new Error('The selected topic review changed. Refresh it.');
        if (result.kind === 'topic-maintenance-recovery') {
          if (props.caseId && result.caseId !== props.caseId)
            throw new Error('The selected topic case changed. Refresh it.');
          if (!controller.signal.aborted && operationEpoch.current === epoch) {
            learnedReview.current = {selection: selectionKey, reviewId: result.reviewId};
            setReview(undefined);
            setDraft(undefined);
            setPacket(undefined);
            setRedactedReview(result);
            setSourceKind('obsidian');
          }
          return undefined;
        }
        return result;
      }
      try {
        let currentPacket = freshProvidedPacket ? props.initialPacket : undefined;
        if (selectedRefreshRequested) {
          selectedObservationPending = !!props.onRefreshEvidence || !!caseId;
          if (props.onRefreshEvidence) currentPacket = await props.onRefreshEvidence();
          else if (caseId) {
            const refreshed = await api<ManagerMaintenanceRefreshResultV1>(
              '/api/attention/context-maintenance',
              {action: 'refresh-case', project: props.project, caseId},
              options,
            );
            if (refreshed.outcome !== 'ready' && refreshed.outcome !== 'resolved')
              throw new Error('reason' in refreshed ? refreshed.reason : 'Current selected evidence is unavailable.');
            currentPacket = refreshed.packet;
          }
          selectedObservationPending = false;
          if (controller.signal.aborted || operationEpoch.current !== epoch) return;
          if (caseId && (!currentPacket || currentPacket.project !== props.project || currentPacket.caseId !== caseId))
            throw new Error('The selected evidence could not be refreshed. Check source access and try again.');
        }

        let selectedReviewId =
          (learnedReview.current?.selection === selectionKey ? learnedReview.current.reviewId : undefined) ??
          props.reviewId ??
          props.initialPacket?.reviewId;
        let result: ManagerTopicReviewV1 | undefined;
        if (!selectedReviewId && props.caseId) {
          try {
            const qualified = await api<ManagerTopicReviewResponseV1>(
              `/api/attention/topic-review?project=${encodeURIComponent(props.project)}&caseId=${encodeURIComponent(props.caseId)}`,
              undefined,
              options,
            );
            if (
              qualified.kind !== 'topic-maintenance' ||
              qualified.project !== props.project ||
              qualified.caseId !== props.caseId ||
              !qualified.canFinishVerification
            )
              throw new Error('The saved topic review changed. Refresh its evidence.');
            selectedReviewId = qualified.reviewId;
            result = qualified;
            privateLoad ||= qualified.sourceKind === 'obsidian';
          } catch (cause) {
            if (!Schema.is(ManagerApiError)(cause) || cause.status !== 404) throw cause;
          }
        }
        if (selectedReviewId) {
          result ??= await readSelectedReview(selectedReviewId);
          if (!result) return;
          privateLoad ||= result.sourceKind === 'obsidian';
        }
        const selectedCaseId = props.caseId ?? result?.caseId ?? caseId;
        if (caseId && result?.caseId && result.caseId !== caseId)
          throw new Error('The selected topic case changed. Refresh its evidence.');
        const needsPacket = !result || result.state === 'pending';
        if (selectedCaseId && needsPacket) {
          currentPacket ??= await api<ManagerContextMaintenancePacketV2>(
            `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}&caseId=${encodeURIComponent(selectedCaseId)}`,
            undefined,
            options,
          );
          privateLoad ||= currentPacket.topicEvidence?.version === 2;
          if (currentPacket.project !== props.project || currentPacket.caseId !== selectedCaseId)
            throw new Error('The selected topic case changed. Refresh its evidence.');
          if (currentPacket.topicEvidence?.version === 2 && currentPacket.topicEvidence.outcome === 'unavailable')
            result = undefined;
          if (!controller.signal.aborted && operationEpoch.current === epoch) setPacket(currentPacket);
          if (!controller.signal.aborted && operationEpoch.current === epoch)
            setSourceKind(currentPacket.topicEvidence?.version === 2 ? 'obsidian' : 'code');
        }
        selectedReviewId ??= currentPacket?.reviewId;
        if (selectedReviewId) {
          if (currentPacket?.topicEvidence?.version === 2 && currentPacket.topicEvidence.outcome === 'unavailable')
            throw new Error(
              'Private source access is unavailable. Refresh source access before reviewing this update.',
            );
          result ??= await readSelectedReview(selectedReviewId);
          if (!result) return;
          privateLoad ||= result.sourceKind === 'obsidian';
          if (
            result.project !== props.project ||
            result.reviewId !== selectedReviewId ||
            result.kind !== 'topic-maintenance'
          )
            throw new Error('The selected topic review changed. Refresh it.');
          if (!controller.signal.aborted && operationEpoch.current === epoch) {
            learnedReview.current = {selection: selectionKey, reviewId: result.reviewId};
            setReview(result);
            setRedactedReview(undefined);
            setDraft(
              heldDraft.current?.selection === selectionKey && heldDraft.current.reviewId === result.reviewId
                ? heldDraft.current.draft
                : result.draft,
            );
            heldDraft.current = undefined;
            setSourceKind(result.sourceKind);
          }
        } else if (!controller.signal.aborted && operationEpoch.current === epoch) {
          setReview(undefined);
          setDraft(undefined);
        }
      } catch (cause) {
        if (!controller.signal.aborted && operationEpoch.current === epoch) {
          // Restore only when this selected observation never entered; later source/read failures still redact.
          if (selectedObservationPending && maintenanceEvidenceBusy(cause)) {
            if (retained) {
              setPacket(retained.packet);
              setReview(retained.review);
              setDraft(retained.draft);
            }
            setError(evidenceReadError(cause));
            return;
          }
          if (privateLoad) {
            heldDraft.current = undefined;
            setReview(undefined);
            setDraft(undefined);
            setPacket(undefined);
          }
          setError(errorMessage(cause));
        }
      } finally {
        if (!controller.signal.aborted && operationEpoch.current === epoch) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [props.project, props.caseId, props.reviewId, selectionKey, packetRevision, generation]);

  const topic = packet?.topicEvidence;
  const acceptedBody = review?.acceptedBody ?? topic?.body;
  const originalParagraphs = acceptedBody ? safeSections(acceptedBody) : [];
  const changedDraft =
    review !== undefined && draft !== undefined && JSON.stringify(draft) !== JSON.stringify(review.draft);
  const paragraphCoverage = review && draft ? topicMaintenanceParagraphCoverage(review, draft) : undefined;
  const paragraphsReady = review?.generation.origin === 'manual' || paragraphCoverage?.status === 'complete';
  const draftReady =
    !!draft &&
    paragraphsReady &&
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
    !!approval &&
    !!packetMatchesReview &&
    observationMatches &&
    !changedDraft &&
    approval.reviewRevision === review?.revision &&
    approval.stage === 'preview' &&
    approvalIdentity(review) !== invalidatedApproval;
  const canApply =
    review?.state === 'pending' &&
    !!review.canApply &&
    paragraphsReady &&
    !!previewCurrent &&
    !!packetMatchesReview &&
    observationMatches &&
    !loading &&
    !busy &&
    !error;
  const canResumeAcceptance =
    !!review &&
    ((review.state === 'applying' &&
      approval?.stage === 'prepared' &&
      (review.canApply || !!review.canFinishVerification)) ||
      (review.state === 'applied' && approval?.stage === 'written' && !!review.canFinishVerification)) &&
    !changedDraft &&
    !loading &&
    !busy &&
    !error;
  const availableToGenerate =
    !!caseId &&
    !!currentPacket &&
    (topic?.version !== 2 || topic.canDraft) &&
    !loading &&
    !busy &&
    !!modelSelection.model &&
    (!review || review.state === 'pending') &&
    !props.writesDisabled;

  // A saved revision identifies the unchanged server draft; never retain private draft text in attempt keys.
  const preparationIdentity =
    review &&
    JSON.stringify([selectionKey, review.reviewId, review.revision, review.targetHash, review.observationRevision]);
  useEffect(() => {
    if (
      !canPreview ||
      changedDraft ||
      previewCurrent ||
      !preparationIdentity ||
      review?.blockingReason ||
      preparationBlocked.current ||
      preparationAttempts.current.has(preparationIdentity) ||
      props.writesDisabled ||
      review?.approval?.stage === 'prepared' ||
      review?.approval?.stage === 'written'
    )
      return;
    preparationAttempts.current.add(preparationIdentity);
    void prepareDocument();
  }, [canPreview, changedDraft, previewCurrent, preparationIdentity, props.writesDisabled]);

  function prepareDocument() {
    if (!review || !canPreview) return;
    if (preparationIdentity) preparationAttempts.current.add(preparationIdentity);
    return mutate({
      action: 'preview',
      project: props.project,
      reviewId: review.reviewId,
      revision: review.revision,
      editedDraftJson: draft ? JSON.stringify(draft) : undefined,
    });
  }

  async function captureEvidence(start: number, end: number, retentionDays: number) {
    if (
      props.writesDisabled ||
      busy ||
      loading ||
      mutationInFlight.current !== undefined ||
      !caseId ||
      topic?.version !== 2 ||
      !topic.obsidian.current ||
      !packet
    )
      return;
    const epoch = ++operationEpoch.current;
    mutationInFlight.current = epoch;
    setBusy(true);
    setActiveAction('capture');
    setError('');
    setNotice('');
    const action: ManagerTopicReviewActionV1 = {
      action: 'capture',
      project: props.project,
      caseId,
      expectedContentHash: packet.expectedContentHash,
      observationRevision: topic.observationRevision,
      inspectionDigest: topic.obsidian.current.inspectionDigest,
      fragmentStart: start,
      fragmentEnd: end,
      retentionDays,
      approved: true,
    };
    try {
      const result = await api<ManagerContextMaintenancePacketV2>('/api/attention/topic-review', action);
      if (operationEpoch.current !== epoch) return;
      if (
        result.project !== props.project ||
        result.caseId !== caseId ||
        result.topicEvidence?.version !== 2 ||
        result.topicEvidence.outcome !== 'ready' ||
        result.topicEvidence.obsidian.capture?.state !== 'captured'
      )
        throw new Error('The selected source changed. Refresh its evidence.');
      setReview(undefined);
      setDraft(undefined);
      setPacket(result);
      setNotice('The approved private excerpt is retained. Review it before generating a draft.');
      props.onChanged();
    } catch (cause) {
      if (operationEpoch.current === epoch) {
        if (review?.sourceKind === 'obsidian' || topic?.version === 2) {
          setReview(undefined);
          setDraft(undefined);
          setPacket(undefined);
        }
        setError(errorMessage(cause));
        setLoading(true);
        setGeneration(value => value + 1);
      }
    } finally {
      if (mutationInFlight.current === epoch) mutationInFlight.current = undefined;
      if (operationEpoch.current === epoch) {
        setBusy(false);
        setActiveAction(undefined);
      }
    }
  }

  async function mutate(action: Exclude<ManagerTopicReviewActionV1, {readonly action: 'capture'}>) {
    if (props.writesDisabled || busy || loading || mutationInFlight.current !== undefined) return;
    const epoch = ++operationEpoch.current;
    mutationInFlight.current = epoch;
    setBusy(true);
    setActiveAction(action.action);
    setError('');
    setNotice('');
    setRecovery(undefined);
    const controller = new AbortController();
    mutationController.current = controller;
    try {
      const result = await api<ManagerTopicReviewResponseV1>('/api/attention/topic-review', action, {
        signal: controller.signal,
        timeoutMilliseconds: 30_000,
      });
      if (
        operationEpoch.current !== epoch ||
        result.project !== props.project ||
        ('reviewId' in action && result.reviewId !== action.reviewId)
      )
        return;
      if (result.kind === 'topic-maintenance-recovery') {
        if (
          action.action !== 'reject' ||
          result.state !== 'rejected' ||
          result.revision !== action.revision + 1 ||
          (action.caseId && result.caseId !== action.caseId)
        )
          throw new Error('The selected topic review changed. Refresh it.');
        learnedReview.current = {selection: selectionKey, reviewId: result.reviewId};
        setReview(undefined);
        setDraft(undefined);
        setPacket(undefined);
        setRedactedReview(result);
        setSourceKind('obsidian');
        setNotice('Review rejected.');
        props.onChanged();
        return;
      }
      if (result.kind !== 'topic-maintenance') throw new Error('The selected topic review changed. Refresh it.');
      if (
        action.action === 'apply' &&
        result.state === 'applied' &&
        result.approval?.stage === 'written' &&
        result.approval.reviewRevision === action.revision &&
        result.approval.approvalDigest === action.approvalDigest &&
        review &&
        result.observationRevision === review?.observationRevision &&
        result.targetUri === review.targetUri &&
        result.targetHash === review.targetHash &&
        (!result.caseId || !caseId || result.caseId === caseId)
      ) {
        learnedReview.current = {selection: selectionKey, reviewId: result.reviewId};
        setReview(result);
        setDraft(result.draft);
        setNotice('The reviewed topic update was saved.');
        props.onChanged();
        props.onApplied?.({
          project: result.project,
          caseId: result.caseId ?? caseId,
          evidenceRevision: result.observationRevision,
          targetUri: result.targetUri,
          targetHash: result.targetHash,
          ...(result.resolvedCitationIds === undefined ? {} : {resolvedCitationIds: result.resolvedCitationIds}),
        });
        props.onClose?.();
        return;
      }
      if (action.action === 'apply' && (result.state === 'applied' || result.approval?.stage === 'written'))
        throw new Error('The saved result does not match this exact approval. Refresh the review before continuing.');
      preparationBlocked.current = false;
      learnedReview.current = {selection: selectionKey, reviewId: result.reviewId};
      if (action.action === 'preview') setInvalidatedApproval(undefined);
      setReview(result);
      setRedactedReview(undefined);
      setDraft(result.draft);
      setLoading(true);
      setGeneration(value => value + 1);
      props.onChanged();
      setNotice(
        action.action === 'apply'
          ? 'The update is not confirmed. Refresh the evidence below before continuing.'
          : action.action === 'preview'
            ? 'Exact final document prepared for review.'
            : action.action === 'generate' || action.action === 'regenerate'
              ? 'Draft ready to review.'
              : `Review ${action.action === 'resume' ? 'resumed' : action.action === 'defer' ? 'deferred' : 'rejected'}.`,
      );
    } catch (cause) {
      if (operationEpoch.current === epoch) {
        preparationBlocked.current = true;
        if (
          Schema.is(ManagerApiError)(cause) &&
          cause.code === 'topic-draft-review-blocked' &&
          isReviewRecovery(cause.recovery)
        )
          setRecovery(cause.recovery);
        if ((action.action === 'apply' || action.action === 'preview') && review?.approval?.stage === 'preview')
          setInvalidatedApproval(approvalIdentity(review));
        setError(errorMessage(cause));
        if (review?.sourceKind === 'obsidian' || topic?.version === 2) {
          setReview(undefined);
          setDraft(undefined);
          setPacket(undefined);
        }
        setLoading(true);
        setGeneration(value => value + 1);
        props.onChanged();
      }
    } finally {
      if (mutationController.current === controller) mutationController.current = undefined;
      if (mutationInFlight.current === epoch) mutationInFlight.current = undefined;
      if (operationEpoch.current === epoch) {
        setBusy(false);
        setActiveAction(undefined);
      }
    }
  }

  function canEditParagraph(ordinal: number): boolean {
    const paragraph = review?.paragraphs[ordinal];
    return (
      !busy &&
      !loading &&
      mutationInFlight.current === undefined &&
      review?.state === 'pending' &&
      paragraph?.role === 'descriptive' &&
      (review.generation.origin === 'manual' || topicMaintenanceParagraphEligible(paragraph))
    );
  }

  function editParagraph(ordinal: number, text: string) {
    if (!draft || !review || !canEditParagraph(ordinal)) return;
    const before = review.paragraphs[ordinal];
    if (!before || before.role !== 'descriptive') return;
    const existing = draft.operations.find(item => item.ordinal === ordinal);
    const accepted = originalParagraphs[ordinal] ?? '';
    if (text === accepted) {
      const operations = draft.operations.filter(item => item.ordinal !== ordinal);
      const reviewedHandles = [...new Set([...draft.reviewedHandles, ...(existing?.supportHandles ?? [])])];
      setDraft({
        ...reviseDisposition(draft, ordinal, {
          disposition: 'revalidate',
          supportHandles: existing?.supportHandles ?? [],
        }),
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
      ...reviseDisposition(draft, ordinal, {disposition: 'update', supportHandles: operation.supportHandles}),
      outcome: 'propose-update',
      reviewedHandles: [...new Set([...draft.reviewedHandles, ...paragraphHandles])],
      operations: [...draft.operations.filter(item => item.ordinal !== ordinal), operation].sort(
        (a, b) => a.ordinal - b.ordinal,
      ),
    });
  }

  function editSupport(ordinal: number, handleId: string, checked: boolean) {
    if (!draft || !review || !canEditParagraph(ordinal)) return;
    const existing = draft.operations.find(item => item.ordinal === ordinal);
    const disposition = draft.paragraphDispositions?.entries.find(item => item.ordinal === ordinal);
    const before = review.paragraphs[ordinal];
    if (!before || before.role !== 'descriptive') return;
    if (!existing && (!disposition || disposition.disposition === 'unresolved')) return;
    const selected = existing?.supportHandles ?? disposition!.supportHandles;
    const supportHandles = checked
      ? [...new Set([...selected, handleId])]
      : selected.filter(value => value !== handleId);
    setDraft({
      ...reviseDisposition(draft, ordinal, {supportHandles}),
      reviewedHandles: checked ? [...new Set([...draft.reviewedHandles, handleId])] : draft.reviewedHandles,
      operations: draft.operations.map(item => (item.ordinal === ordinal ? {...item, supportHandles} : item)),
    });
  }

  function editDisposition(ordinal: number, decision: string) {
    if (!draft || !review || !canEditParagraph(ordinal)) return;
    const paragraph = review.paragraphs[ordinal];
    if (!paragraph || !topicMaintenanceParagraphEligible(paragraph)) return;
    if (!['', 'update', 'revalidate', 'unresolved'].includes(decision)) return;
    const operation = draft.operations.find(item => item.ordinal === ordinal);
    if (decision === 'update' && !operation) return;
    const operations =
      decision === 'revalidate' || decision === 'unresolved'
        ? draft.operations.filter(item => item.ordinal !== ordinal)
        : draft.operations;
    const entries = draft.paragraphDispositions?.entries.filter(item => item.ordinal !== ordinal) ?? [];
    if (decision)
      entries.push({
        ordinal,
        beforeHash: paragraph.hash,
        disposition: decision as 'update' | 'revalidate' | 'unresolved',
        supportHandles: decision === 'update' ? operation!.supportHandles : [],
        rationale: decision === 'unresolved' ? 'Needs manual review.' : 'Explicit paragraph review.',
      });
    setDraft({
      ...draft,
      operations,
      outcome: operations.length ? 'propose-update' : 'propose-revalidation',
      paragraphDispositions: {version: 1, entries: entries.sort((a, b) => a.ordinal - b.ordinal)},
    });
  }

  if (redactedReview)
    return (
      <section aria-busy={loading || busy} className="topic-review-content">
        <header className="health-dialog-section-heading">
          <h3>Private topic review</h3>
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => {
              setError('');
              setNotice('');
              setLoading(true);
              refreshRequested.current = true;
              setGeneration(value => value + 1);
            }}
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh evidence
          </button>
        </header>
        <ReviewNotice
          tone="warning"
          title={redactedReview.state === 'rejected' ? 'Review closed' : 'Source text is unavailable or changed'}
        >
          {redactedReview.state === 'rejected'
            ? 'The rejected review is closed. Refresh maintenance to review the next source change.'
            : redactedReview.recovery?.action === 'reject'
              ? 'This review can no longer display its private text. Discard the exact review to start again. Accepted memory stays as saved.'
              : 'This review can no longer display its private text. Restore source access and refresh maintenance before continuing.'}
        </ReviewNotice>
        {loading ? <p role="status">Loading topic and review…</p> : null}
        {error ? (
          <ReviewNotice role="alert" tone="danger" title="Review needs attention">
            {error}
          </ReviewNotice>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {redactedReview.recovery?.action === 'reject' && redactedReview.caseId ? (
          <button
            type="button"
            className="danger"
            disabled={busy || loading || props.writesDisabled}
            onClick={() =>
              void mutate({
                action: 'reject',
                project: props.project,
                reviewId: redactedReview.reviewId,
                revision: redactedReview.revision,
                caseId: redactedReview.caseId,
              })
            }
          >
            {redactedReview.state === 'conflict' ? 'Close conflicted review' : 'Discard stale review'}
          </button>
        ) : null}
      </section>
    );

  if (incomingUnavailable)
    return (
      <ReviewNotice role="alert" tone="warning" title="Current source evidence is unavailable">
        {props.initialPacket?.topicEvidence?.reason ??
          'Source access is unavailable. Restore access before reviewing this update.'}
      </ReviewNotice>
    );
  return (
    <section aria-busy={loading || busy} className="topic-review-content">
      <header className="health-dialog-section-heading">
        <h3>{review?.topic ?? 'Topic and source evidence'}</h3>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setError('');
            setNotice('');
            setLoading(true);
            refreshRequested.current = true;
            setGeneration(value => value + 1);
          }}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh evidence
        </button>
      </header>
      <TopicReviewSummary
        review={review}
        draft={draft}
        sourceKind={topic?.version === 2 ? 'obsidian' : (sourceKind ?? review?.sourceKind)}
      />
      {busy && activeAction ? (
        <div className="topic-review-progress" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>
              {activeAction === 'generate' || activeAction === 'regenerate'
                ? 'Generating draft…'
                : activeAction === 'apply'
                  ? 'Saving and verifying the approved update…'
                  : activeAction === 'preview'
                    ? 'Preparing the exact final document…'
                    : 'Updating review…'}
            </strong>
            <p>
              {activeAction === 'generate' || activeAction === 'regenerate'
                ? 'Waiting for the model, then checking the draft against the selected evidence. Your saved memory stays unchanged until you approve.'
                : 'Keep this review open while Threadnote checks the result.'}
            </p>
          </div>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="muted">
          Loading topic and review…
        </p>
      ) : null}
      {error ? (
        <ReviewNotice role="alert" tone="danger" title="Review needs attention">
          {error}
          {!recovery ? (
            <p>
              Refresh evidence to check the current case before trying again. Generating another draft remains your
              choice.
            </p>
          ) : null}
          {recovery ? (
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => {
                learnedReview.current = {selection: selectionKey, reviewId: recovery.reviewId};
                setRecovery(undefined);
                setError('');
                setLoading(true);
                setGeneration(value => value + 1);
              }}
            >
              Open existing review
            </button>
          ) : null}
        </ReviewNotice>
      ) : null}
      {notice ? (
        <ReviewNotice tone="proposal" title="Review updated">
          {notice}
        </ReviewNotice>
      ) : null}
      {topic?.outcome === 'unavailable' ? (
        <ReviewNotice role="alert" tone="warning" title="Current source evidence is unavailable">
          {topic.version === 2
            ? 'The private note or its retained supporting excerpt cannot be verified. Restore source access and refresh before continuing.'
            : `${topic.reason ?? 'No verified excerpt was returned'}. Refresh evidence before continuing.`}
        </ReviewNotice>
      ) : null}
      {!packet && review?.state === 'pending' && !error ? (
        <ReviewNotice tone="warning" title="Refresh source evidence">
          The source case is unavailable. Refresh it before accepting this update.
        </ReviewNotice>
      ) : null}
      {packet &&
      topic?.outcome !== 'unavailable' &&
      review?.generation.origin !== 'manual' &&
      review &&
      !review.caseObservationMatches ? (
        <ReviewNotice tone="warning" title="This draft needs fresh evidence">
          Source evidence changed since this draft. Review the updated case before continuing.
        </ReviewNotice>
      ) : null}
      {review ? (
        <>
          {review.state === 'pending' &&
          review.generation.origin === 'model' &&
          paragraphCoverage?.status !== 'complete' ? (
            <ReviewNotice tone="warning" title="Paragraph review incomplete">
              Record an update, an unchanged decision with source support, or a manual-review need for each eligible
              paragraph. A new exact preview requires all decisions to be resolved. Regenerate a legacy draft if needed.
            </ReviewNotice>
          ) : null}
          {paragraphCoverage?.status === 'complete' ? (
            <p className="muted">
              {paragraphCoverage.resolvedCount} of {paragraphCoverage.eligibleCount} paragraph decisions recorded. Check
              each decision against its sources; accounting does not verify correctness.
            </p>
          ) : null}
          <TopicReviewNotes review={review} />
          {review.draft.unresolvedQuestions.map((question, index) => (
            <ReviewNotice key={`q${index}`} tone="warning" title="Unresolved question">
              {question}
            </ReviewNotice>
          ))}
          {review.draft.removedClaims.map((claim, index) => (
            <ReviewNotice key={`r${index}`} tone="warning" title="Claim removed from proposal">
              {claim}
            </ReviewNotice>
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
          <TopicParagraphComparison
            review={review}
            draft={draft}
            originalParagraphs={originalParagraphs}
            disabled={busy || loading}
            onEditParagraph={editParagraph}
            onEditSupport={editSupport}
            onEditDisposition={editDisposition}
          />
          {topic ? (
            <TopicSourceEvidence
              topic={topic}
              capture={{
                disabled: busy || loading || !!props.writesDisabled,
                onCapture: (start, end, days) => void captureEvidence(start, end, days),
              }}
            />
          ) : null}
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
            <section aria-label="Exact final document" className="review-final-document">
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
              <MemoryBody content={memoryDocumentParts(approval.content).body} />
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
                <h5>Full stored document</h5>
                <pre>{approval.content}</pre>
              </details>
            </section>
          ) : null}
          {changedDraft ? (
            <p role="status">Save your draft to review the updated final document before applying.</p>
          ) : null}
          {review.state === 'pending' &&
          approval?.stage === 'preview' &&
          approvalIdentity(review) === invalidatedApproval ? (
            <p role="status">Prepare a new exact preview before accepting this update.</p>
          ) : null}
          {!draftReady ? (
            <p role="status">
              This draft needs supported descriptive text or a supported unchanged review before preview.
            </p>
          ) : null}
          {review.state === 'pending' && review.blockingReason && !canApply ? (
            <ReviewNotice tone="warning" title="Before you accept">
              Acceptance paused: {review.blockingReason}. Refresh evidence or prepare a new preview.
            </ReviewNotice>
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
      {!review && topic ? (
        <TopicSourceEvidence
          topic={topic}
          capture={{
            disabled: busy || loading || !!props.writesDisabled,
            onCapture: (start, end, days) => void captureEvidence(start, end, days),
          }}
        />
      ) : null}
      <details className="review-disclosure topic-generation-settings" open={!review}>
        <summary>Generation settings</summary>
        <div className="topic-generation-controls">
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
              className="primary"
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
              {busy && (activeAction === 'generate' || activeAction === 'regenerate') ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Generating draft…
                </>
              ) : review ? (
                'Regenerate draft'
              ) : (
                'Generate draft'
              )}
            </button>
          )}
        </div>
      </details>
      <footer className="topic-review-actions">
        {review?.targetUri ? (
          <button type="button" onClick={() => props.onOpenLibrary(review.targetUri)}>
            Open accepted topic
          </button>
        ) : null}
        {review?.state === 'pending' ? (
          <>
            {changedDraft || (!previewCurrent && preparationBlocked.current) ? (
              <button
                type="button"
                disabled={!canPreview || props.writesDisabled}
                onClick={() => void prepareDocument()}
              >
                {changedDraft ? 'Save draft' : 'Retry preparing document'}
              </button>
            ) : null}
            <button
              type="button"
              className="primary"
              disabled={!canApply || props.writesDisabled}
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
              {busy && activeAction === 'apply'
                ? 'Saving update…'
                : review.draft.outcome === 'propose-revalidation'
                  ? 'Confirm unchanged'
                  : 'Apply update'}
            </button>
            <button
              type="button"
              disabled={busy || loading || props.writesDisabled || (review.generation.origin !== 'manual' && !caseId)}
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
              disabled={busy || loading || props.writesDisabled || (review.generation.origin !== 'manual' && !caseId)}
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
            disabled={
              busy ||
              loading ||
              props.writesDisabled ||
              !observationMatches ||
              (review.generation.origin !== 'manual' && !caseId)
            }
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
        {review &&
          ((review.state === 'applying' && approval?.stage === 'prepared') ||
            (review.state === 'applied' && approval?.stage === 'written' && review.canFinishVerification)) && (
            <button
              type="button"
              className="primary"
              disabled={!canResumeAcceptance || props.writesDisabled}
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
              {review.canFinishVerification ? 'Finish saved update verification' : 'Resume approved update'}
            </button>
          )}
        {review?.state === 'conflict' && (
          <button
            type="button"
            className="danger"
            disabled={busy || loading || !caseId || props.writesDisabled}
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

function approvalIdentity(review: ManagerTopicReviewV1 | undefined): string | undefined {
  const approval = review?.approval;
  return approval ? `${review.reviewId}:${approval.reviewRevision}:${approval.approvalDigest}` : undefined;
}

function reviseDisposition(
  draft: TopicMaintenanceDraftV1,
  ordinal: number,
  changes: Partial<
    Pick<
      NonNullable<TopicMaintenanceDraftV1['paragraphDispositions']>['entries'][number],
      'disposition' | 'supportHandles'
    >
  >,
): TopicMaintenanceDraftV1 {
  const accounting = draft.paragraphDispositions;
  return accounting
    ? {
        ...draft,
        paragraphDispositions: {
          ...accounting,
          entries: accounting.entries.map(entry => (entry.ordinal === ordinal ? {...entry, ...changes} : entry)),
        },
      }
    : draft;
}

function safeSections(body: string): readonly string[] {
  try {
    return consolidationSections(body);
  } catch {
    return [];
  }
}
