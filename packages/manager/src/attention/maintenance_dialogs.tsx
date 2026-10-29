import {HealthDetail} from '../attention_details.js';
import {SemanticResolutionReview} from './semantic_comparison.js';
import {TopicReviewContent} from './topic_review.js';
import type {ManagerTopicReviewAppliedV1} from './topic_contracts.js';
import {Copy, ExternalLink, RefreshCw} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import {Schema} from 'effect';
import {DetailModal, MemoryBody} from '../detail_modal.js';
import {MemoryExcerpt} from '../review_presentation.js';
import {SourceExcerpt} from '../source_code.js';
import {memoryDocumentParts} from '../library_model.js';
import {api, ManagerApiError} from '../ui/support.js';
import {evidenceReadError, retryEvidenceRead} from './evidence_refresh.js';
import type {
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenancePacketV2,
  ManagerContextMaintenanceStatusV2,
  ManagerMaintenanceRefreshResultV1,
} from './contracts.js';
import {
  healthDecisionTask,
  maintenanceCaseMemoryUri,
  maintenanceDecisionExplanation,
  maintenanceDecisionLabel,
  maintenanceMemoryTitle,
} from './maintenance.js';

export function MaintenanceTaskDialog(props: {
  readonly task: string;
  readonly onClose: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    setError('');
    setCopied(false);
    try {
      await navigator.clipboard.writeText(props.task);
      setCopied(true);
    } catch {
      setError('Copy is unavailable. Select the task below and use your keyboard’s copy shortcut.');
    }
  }
  return (
    <DetailModal title="Review with your coding agent" onClose={props.onClose} className="health-task-dialog">
      <p>
        Copy this task and paste it into your coding agent. It identifies the selected memory cases and asks the agent
        to compare evidence before proposing a change.
      </p>
      <p className="muted">Preparing or copying this task does not change any memories.</p>
      <textarea
        aria-label="Scoped health decision task"
        readOnly
        value={props.task}
        rows={8}
        onFocus={event => event.target.select()}
      />
      {error ? <p role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="primary" onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" /> Copy task
        </button>
        {copied ? <span role="status">Task copied. Paste it into your coding agent to continue.</span> : null}
      </footer>
    </DetailModal>
  );
}

export function MaintenanceCaseDialog(props: {
  readonly project: string;
  readonly caseId: string;
  readonly memoryUri?: string;
  readonly initialCase?: ManagerContextMaintenanceCaseV2;
  readonly relatedCases?: readonly ManagerContextMaintenanceCaseV2[];
  readonly title?: string;
  readonly onClose: () => void;
  readonly onOpenLibrary: (uri: string) => void;
  readonly onTask: (task: string) => void;
  readonly onChanged?: () => void;
  readonly onApplied?: (result: ManagerTopicReviewAppliedV1) => void;
  readonly stale?: boolean;
  readonly onEvidenceUpdated?: (item: ManagerContextMaintenanceCaseV2, previousCaseId?: string) => void;
}): React.ReactElement {
  const [caseId, setCaseId] = useState(props.caseId);
  const [item, setItem] = useState(props.initialCase);
  const [packet, setPacket] = useState<ManagerContextMaintenancePacketV2>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [repairOpen, setRepairOpen] = useState(false);
  const [selection, setSelection] = useState<{memoryUri: string; citationId: string}>();
  const [blocked, setBlocked] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [redactedScopes, setRedactedScopes] = useState<ReadonlySet<string>>(() => new Set());
  const scopeKey = JSON.stringify([props.project, caseId]);
  const explicitRefresh = useRef(!!props.stale);
  const previousStale = useRef(!!props.stale);
  const selectedRefresh = useRef<(() => Promise<ManagerContextMaintenancePacketV2 | undefined>) | undefined>(undefined);
  const onEvidenceUpdated = useRef(props.onEvidenceUpdated);
  onEvidenceUpdated.current = props.onEvidenceUpdated;
  useEffect(() => {
    const becameStale = !!props.stale && !previousStale.current;
    previousStale.current = !!props.stale;
    if (becameStale) {
      explicitRefresh.current = true;
      setRefresh(value => value + 1);
    }
  }, [props.stale]);
  useEffect(() => {
    const controller = new AbortController();
    const refreshing = explicitRefresh.current;
    explicitRefresh.current = false;
    setLoading(true);
    const current = () => !controller.signal.aborted;
    const options = {signal: controller.signal, timeoutMilliseconds: 30_000};
    const read = <A,>(path: string, body?: Record<string, unknown>) =>
      retryEvidenceRead(() => api<A>(path, body, options), controller.signal);
    const selectedUri =
      selection?.memoryUri ??
      (props.initialCase?.family === 'topic-maintenance' || item?.family === 'topic-maintenance'
        ? undefined
        : props.memoryUri);
    async function refreshSelected() {
      const result = await read<ManagerMaintenanceRefreshResultV1>('/api/attention/context-maintenance', {
        action: 'refresh-case',
        project: props.project,
        caseId,
        ...(selectedUri ? {memoryUri: selectedUri} : {}),
        ...(selection ? {citationId: selection.citationId} : {}),
      });
      if (!current()) return;
      if (!['ready', 'resolved', 'unavailable', 'changing', 'incomplete', 'superseded'].includes(result.outcome))
        throw new Error('The selected evidence check returned an incomplete response. Check again.');
      if (result.outcome === 'incomplete') {
        setBlocked(true);
        setError('');
        setOutcome(result.reason);
        return;
      }
      if (result.outcome !== 'ready' && result.outcome !== 'resolved') {
        setBlocked(true);
        setPacket(undefined);
        setRedactedScopes(scopes => new Set(scopes).add(scopeKey));
        if (result.item) {
          setItem(result.item);
          onEvidenceUpdated.current?.(result.item, caseId);
        }
        setOutcome('reason' in result ? result.reason : 'Current evidence is unavailable.');
        return;
      }
      if (result.packet.project !== props.project || result.packet.caseId !== result.item.caseId)
        throw new Error('The refreshed decision does not match the selected memory.');
      setItem(result.item);
      if (result.item.caseId !== caseId) setCaseId(result.item.caseId);
      setPacket(result.packet);
      if (result.packet.topicEvidence?.version === 2 && result.packet.topicEvidence.outcome === 'unavailable') {
        setBlocked(true);
        setRedactedScopes(scopes => new Set(scopes).add(scopeKey));
        setOutcome(
          result.packet.topicEvidence.reason ??
            'Private source access is unavailable. Restore access before reviewing this update.',
        );
        onEvidenceUpdated.current?.(result.item, caseId);
        return result.packet;
      }
      setBlocked(false);
      setError('');
      setOutcome('');
      setRedactedScopes(scopes => {
        const next = new Set(scopes);
        next.delete(scopeKey);
        return next;
      });
      onEvidenceUpdated.current?.(result.item, caseId);
      if (result.outcome === 'resolved') setOutcome('This check now passes. No memory content was changed.');
      return result.packet;
    }
    selectedRefresh.current = refreshSelected;
    async function load() {
      try {
        if (refreshing) {
          await refreshSelected();
          return;
        }
        const path = `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}&caseId=${encodeURIComponent(caseId)}`;
        const details = await read<ManagerContextMaintenanceStatusV2>(`${path}&view=status`);
        if (!current()) return;
        const currentCase = details.cases?.find(value => value.caseId === caseId);
        if (currentCase) setItem(currentCase);
        const result = await read<ManagerContextMaintenancePacketV2>(
          `${path}${selectedUri ? `&memoryUri=${encodeURIComponent(selectedUri)}` : ''}${selection ? `&citationId=${encodeURIComponent(selection.citationId)}` : ''}`,
        );
        if (!current()) return;
        if (result.version !== 2 || result.project !== props.project || result.caseId !== caseId)
          throw new Error('The selected maintenance case changed. Check its evidence again.');
        setPacket(result);
        if (result.topicEvidence?.version === 2 && result.topicEvidence.outcome === 'unavailable') {
          setBlocked(true);
          setRedactedScopes(scopes => new Set(scopes).add(scopeKey));
          setOutcome(result.topicEvidence.reason ?? 'Private source access is unavailable.');
          return;
        }
        setBlocked(false);
        setError('');
        setOutcome('');
        if (currentCase) onEvidenceUpdated.current?.(currentCase);
      } catch (failure) {
        let cause = failure;
        if (!current()) return;
        if (!refreshing && Schema.is(ManagerApiError)(cause) && cause.status === 409) {
          try {
            await refreshSelected();
            return;
          } catch (refreshError) {
            cause = refreshError;
          }
        }
        if (!current()) return;
        if (
          packet?.topicEvidence?.version === 2 ||
          (Schema.is(ManagerApiError)(cause) && [401, 403, 404].includes(cause.status))
        ) {
          setPacket(undefined);
          setRedactedScopes(scopes => new Set(scopes).add(scopeKey));
        }
        setBlocked(true);
        setError(evidenceReadError(cause));
      } finally {
        if (current()) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [props.project, props.memoryUri, caseId, refresh, selection]);
  const reviewFrozen = loading || blocked;
  function refreshEvidence() {
    explicitRefresh.current = true;
    setRefresh(value => value + 1);
  }
  const revalidate = (
    <>
      <p role={outcome ? 'status' : undefined} style={{visibility: outcome ? 'visible' : 'hidden'}}>
        {outcome || '\u00a0'}
      </p>
      <p role={blocked ? 'alert' : undefined} style={{visibility: blocked ? 'visible' : 'hidden'}}>
        {error || outcome}{' '}
        <button type="button" disabled={loading} onClick={refreshEvidence}>
          Check current evidence
        </button>
      </p>
    </>
  );
  const uri = selection?.memoryUri ?? props.memoryUri ?? packet?.memoryUri ?? maintenanceCaseMemoryUri(item);
  const reason = packet?.reason ?? item?.reason;
  const semanticReview = packet?.semanticEvidence !== undefined || item?.family === 'semantic-contradiction';
  const topicReview =
    (packet?.family ?? item?.family) === 'topic-maintenance' && (packet?.slot ?? item?.slot) === 'declared-support';
  const reviewWithAgent = (
    <button
      type="button"
      onClick={() =>
        props.onTask(
          healthDecisionTask(
            props.project,
            [{caseId}],
            semanticReview
              ? 'Compare both memories and their applicability before proposing any change'
              : 'Review this memory and propose a supported change',
            uri,
          ),
        )
      }
    >
      <Copy size={14} aria-hidden="true" /> Review with agent…
    </button>
  );
  if (repairOpen && packet?.repairFinding)
    return (
      <HealthDetail
        finding={packet.repairFinding}
        project={props.project}
        repairsAvailable
        onClose={() => setRepairOpen(false)}
        onChanged={() => {
          setRepairOpen(false);
          refreshEvidence();
          props.onChanged?.();
        }}
        onOpenLibrary={uri => {
          if (uri) props.onOpenLibrary(uri);
        }}
      />
    );
  if (topicReview)
    return (
      <DetailModal
        title="Review topic update"
        onClose={props.onClose}
        className="topic-review-dialog"
        footer={revalidate}
      >
        {!redactedScopes.has(scopeKey) ? (
          <TopicReviewContent
            key={scopeKey}
            project={props.project}
            caseId={caseId}
            initialPacket={packet}
            onRefreshEvidence={() => selectedRefresh.current?.() ?? Promise.resolve(undefined)}
            onChanged={() => props.onChanged?.()}
            onApplied={props.onApplied}
            onClose={props.onClose}
            onOpenLibrary={props.onOpenLibrary}
            writesDisabled={reviewFrozen}
          />
        ) : (
          <p role={error ? 'alert' : 'status'}>{error || 'Loading review evidence…'}</p>
        )}
      </DetailModal>
    );
  return (
    <DetailModal
      title={semanticReview ? 'Compare conflicting memories' : (props.title ?? maintenanceMemoryTitle(uri))}
      onClose={props.onClose}
      className={`health-case-dialog${semanticReview ? ' semantic-review-dialog' : ''}`}
      footer={packet?.semanticEvidence ? undefined : revalidate}
    >
      {(props.relatedCases?.length ?? 0) > 1 ? (
        <label className="health-case-selector">
          Check to review
          <select
            aria-label="Check to review"
            value={caseId}
            onChange={event => {
              setSelection(undefined);
              setPacket(undefined);
              setBlocked(false);
              setCaseId(event.target.value);
              setItem(props.relatedCases?.find(value => value.caseId === event.target.value));
            }}
          >
            {props.relatedCases?.map((value, index) => (
              <option key={value.caseId} value={value.caseId}>
                {maintenanceDecisionLabel(value.reason)} · check {index + 1}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {reason && !semanticReview ? (
        <section className="health-decision-explanation">
          <strong>{maintenanceDecisionLabel(reason)}</strong>
          <p>{maintenanceDecisionExplanation(reason)}</p>
          {reason === 'source-changed' || reason === 'citation-changed' ? (
            <div className="health-source-next-step">
              <strong>
                {item && ['queued', 'repairing', 'waiting-evidence', 'deferred-policy'].includes(item.disposition)
                  ? 'Evidence refresh is pending'
                  : 'Your review is needed'}
              </strong>
              <p>
                {item && ['queued', 'repairing', 'waiting-evidence', 'deferred-policy'].includes(item.disposition)
                  ? 'Check Automatic recovery for the next evidence refresh. If this remains in Needs a decision, compare the advice with the updated source before making a change.'
                  : 'Start with Review with agent to compare the memory and current code. Then review the proposed update, or edit or archive the memory in Library. Refresh evidence only rechecks the source; it does not approve or rewrite the memory.'}
              </p>
              {reviewWithAgent}
            </div>
          ) : null}
        </section>
      ) : null}
      {uri && !semanticReview ? <CaseMemory key={uri} uri={uri} refresh={refresh} /> : null}
      <section aria-label="Case evidence" aria-busy={loading}>
        <header className="health-dialog-section-heading">
          <h3>{semanticReview ? 'Compare the original statements' : 'Source evidence'}</h3>
          <button disabled={loading} type="button" onClick={refreshEvidence}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh evidence
          </button>
        </header>
        <p role="status" style={{visibility: loading ? 'visible' : 'hidden'}}>
          {packet ? 'Checking current evidence…' : 'Loading this case and its evidence…'}
        </p>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <p>
              You can still open the memory or copy a review task. If the case is stale, check current evidence again.
            </p>
          </div>
        ) : null}
        {packet ? (
          <>
            <div className="health-evidence-selectors">
              {packet.evidenceSelectors?.map((selector, index) => (
                <button
                  type="button"
                  key={`${selector.memoryUri}:${selector.citationId}`}
                  title={selector.citationId}
                  aria-pressed={
                    selection?.citationId === selector.citationId && selection.memoryUri === selector.memoryUri
                  }
                  onClick={() => setSelection(selector)}
                >
                  Reference {index + 1}
                </button>
              ))}
            </div>
            {(packet.omittedEvidenceSelectors ?? 0) > 0 ? (
              <p className="muted">More references are available in the full memory in Library.</p>
            ) : null}
            {packet.semanticEvidence ? (
              <SemanticResolutionReview
                project={props.project}
                evidence={packet.semanticEvidence}
                onOpenLibrary={props.onOpenLibrary}
                onResolved={() => {
                  props.onChanged?.();
                  props.onClose();
                }}
                onRefresh={refreshEvidence}
                secondaryAction={reviewWithAgent}
                ownerInstructions={packet.ownerProposal?.publication.instructions}
                writesDisabled={reviewFrozen}
                reviewNotice={revalidate}
              />
            ) : null}
            <div className="health-evidence-comparison">
              {packet.evidence?.excerpts.map(excerpt => (
                <section className="health-code-preview" key={`${excerpt.provenance}:${excerpt.excerptHash}`}>
                  <h4>{excerpt.provenance === 'historical-verified' ? 'Historical source' : 'Current source'}</h4>
                  <p className="muted">
                    {excerpt.provenance === 'historical-verified'
                      ? 'Preserves the original evidence; does not verify today’s claim.'
                      : excerpt.supportsCitation
                        ? 'Citation support verified. Review whether the advice still matches.'
                        : 'Source changed. Review the claim before updating its citation.'}
                  </p>
                  <p>
                    <code>
                      {excerpt.source.path}:{excerpt.startLine}
                    </code>
                  </p>
                  <SourceExcerpt content={excerpt.content} path={excerpt.source.path} />
                </section>
              ))}
            </div>
            {!packet.evidence?.excerpts.length && !packet.semanticEvidence ? (
              <p>No source excerpt is available for this case. Review the memory and the choices below.</p>
            ) : null}
            {!semanticReview ? (
              <>
                {packet.reference ? (
                  <section aria-label="Selected source reference">
                    <h3>{packet.reference.path}</h3>
                    <p>
                      {packet.reference.status === 'exact' || packet.reference.status === 'relocated'
                        ? 'The current source supports this reference.'
                        : packet.reference.status === 'changed'
                          ? 'This source changed. Compare the recorded and current code above before updating the advice.'
                          : 'Current support for this reference could not be verified. The recorded source remains preserved.'}
                    </p>
                    {packet.repairFinding ? (
                      <button type="button" onClick={() => setRepairOpen(true)}>
                        Review repair for this reference
                      </button>
                    ) : null}
                    {uri ? (
                      <button type="button" onClick={() => props.onOpenLibrary(uri)}>
                        Edit advice for {packet.reference.path}
                      </button>
                    ) : null}
                  </section>
                ) : null}
                <h3>What you can do</h3>
                <ul>
                  {packet.choices.map(choice => (
                    <li key={choice}>{choice}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {packet.ownerProposal && !packet.semanticEvidence ? (
              <section aria-label="Shared owner proposal">
                <h4>Proposed changes for the team owner</h4>
                {packet.ownerProposal.selectedEdits.map((edit, index) => (
                  <p key={index}>
                    {edit.operation}: {edit.relation.type} → {edit.relation.uri}
                  </p>
                ))}
                <p>{packet.ownerProposal.publication.instructions}</p>
              </section>
            ) : null}
          </>
        ) : null}
        {item || packet ? (
          <details>
            <summary>Case details and history</summary>
            {packet ? (
              <p>{packet.instructions}</p>
            ) : (
              <p>This retained history is read-only. Fresh evidence is required before choosing a change.</p>
            )}
            <p>
              Case: <code>{caseId}</code>
            </p>
            <p>
              Evidence revision: <code>{packet?.evidenceRevision ?? item?.evidenceRevision}</code>
            </p>
            {item?.events.map((event, index) => (
              <p key={index}>
                {event.at} — {event.reason}
              </p>
            ))}
          </details>
        ) : null}
      </section>
      {!packet?.semanticEvidence ? (
        <footer>
          {uri && (!semanticReview || !packet?.semanticEvidence) ? (
            <button type="button" className="primary" onClick={() => props.onOpenLibrary(uri)}>
              <ExternalLink size={14} aria-hidden="true" /> Edit or archive in Library
            </button>
          ) : null}
          {reviewWithAgent}
        </footer>
      ) : null}
    </DetailModal>
  );
}

function CaseMemory(props: {readonly uri: string; readonly refresh: number}): React.ReactElement {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  const contentUri = useRef(props.uri);
  useEffect(() => {
    const controller = new AbortController();
    if (contentUri.current !== props.uri) {
      contentUri.current = props.uri;
      setContent(undefined);
      setError('');
    }
    void retryEvidenceRead(
      () =>
        api<{content: string}>(`/api/memory?uri=${encodeURIComponent(props.uri)}`, undefined, {
          signal: controller.signal,
          timeoutMilliseconds: 30_000,
        }),
      controller.signal,
    )
      .then(result => {
        if (!controller.signal.aborted) {
          setContent(result.content);
          setError('');
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          if (Schema.is(ManagerApiError)(cause) && [401, 403, 404].includes(cause.status)) setContent(undefined);
          setError(evidenceReadError(cause));
        }
      });
    return () => controller.abort();
  }, [props.uri, props.refresh]);
  return (
    <section aria-label="Memory being reviewed" className="health-case-memory">
      <h3>Stored memory</h3>
      {content === undefined ? (
        error ? (
          <p role="alert">{error}</p>
        ) : (
          <p role="status">Loading memory…</p>
        )
      ) : (
        <MemoryExcerpt label="Stored memory">
          <MemoryBody content={memoryDocumentParts(content).body} />
        </MemoryExcerpt>
      )}
      {error && content !== undefined ? <p role="alert">{error}</p> : null}
    </section>
  );
}
