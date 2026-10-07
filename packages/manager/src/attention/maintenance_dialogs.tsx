import {Copy, ExternalLink, RefreshCw} from 'lucide-react';
import React, {useEffect, useState} from 'react';
import {DetailModal, MemoryBody} from '../detail_modal.js';
import {memoryDocumentParts} from '../library_model.js';
import {api, errorMessage} from '../ui/support.js';
import type {
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenancePacketV2,
  ManagerContextMaintenanceStatusV2,
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
  readonly initialCase?: ManagerContextMaintenanceCaseV2;
  readonly relatedCases?: readonly ManagerContextMaintenanceCaseV2[];
  readonly title?: string;
  readonly onClose: () => void;
  readonly onOpenLibrary: (uri: string) => void;
  readonly onTask: (task: string) => void;
}): React.ReactElement {
  const [caseId, setCaseId] = useState(props.caseId);
  const [item, setItem] = useState(props.initialCase);
  const [packet, setPacket] = useState<ManagerContextMaintenancePacketV2>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<{memoryUri: string; citationId: string}>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPacket(undefined);
    const current = () => !controller.signal.aborted;
    const options = {signal: controller.signal, timeoutMilliseconds: 30_000};
    async function load() {
      try {
        const path = `/api/attention/context-maintenance?project=${encodeURIComponent(props.project)}&caseId=${encodeURIComponent(caseId)}`;
        const details = await api<ManagerContextMaintenanceStatusV2>(`${path}&view=status`, undefined, options);
        if (!current()) return;
        setItem(details.cases?.find(value => value.caseId === caseId));
        const result = await api<ManagerContextMaintenancePacketV2>(
          `${path}${selection ? `&memoryUri=${encodeURIComponent(selection.memoryUri)}&citationId=${encodeURIComponent(selection.citationId)}` : ''}`,
          undefined,
          options,
        );
        if (!current()) return;
        if (result.version !== 2 || result.project !== props.project || result.caseId !== caseId)
          throw new Error('The selected maintenance case changed. Refresh its evidence.');
        setPacket(result);
      } catch (cause) {
        if (current()) setError(errorMessage(cause));
      } finally {
        if (current()) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [props.project, caseId, refresh, selection]);
  const uri = packet?.memoryUri ?? maintenanceCaseMemoryUri(item);
  const reason = packet?.reason ?? item?.reason;
  return (
    <DetailModal
      title={props.title ?? maintenanceMemoryTitle(uri)}
      onClose={props.onClose}
      className="health-case-dialog"
    >
      {(props.relatedCases?.length ?? 0) > 1 ? (
        <label className="health-case-selector">
          Check to review
          <select
            aria-label="Check to review"
            value={caseId}
            onChange={event => {
              setSelection(undefined);
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
      {reason ? (
        <section className="health-decision-explanation">
          <strong>{maintenanceDecisionLabel(reason)}</strong>
          <p>{maintenanceDecisionExplanation(reason)}</p>
        </section>
      ) : null}
      {uri ? <CaseMemory uri={uri} refresh={refresh} /> : null}
      <section aria-label="Case evidence" aria-busy={loading}>
        <header className="health-dialog-section-heading">
          <h3>Source evidence</h3>
          <button disabled={loading} type="button" onClick={() => setRefresh(value => value + 1)}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh evidence
          </button>
        </header>
        {loading ? <p role="status">Loading this case and its evidence…</p> : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <p>
              You can still open the memory or copy a review task. If the case is stale, run maintenance to refresh it,
              then reopen this review.
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
                  <pre>{excerpt.content}</pre>
                </section>
              ))}
            </div>
            {!packet.evidence?.excerpts.length ? (
              <p>No source excerpt is available for this case. Review the memory and the choices below.</p>
            ) : null}
            <h3>What you can do</h3>
            <ul>
              {packet.choices.map(choice => (
                <li key={choice}>{choice}</li>
              ))}
            </ul>
            {packet.ownerProposal ? (
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
      <footer>
        {uri ? (
          <button type="button" className="primary" onClick={() => props.onOpenLibrary(uri)}>
            <ExternalLink size={14} aria-hidden="true" /> Edit or archive in Library
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            props.onTask(
              healthDecisionTask(props.project, [{caseId}], 'Review this memory and propose a supported change'),
            )
          }
        >
          <Copy size={14} aria-hidden="true" /> Review with agent…
        </button>
      </footer>
    </DetailModal>
  );
}

function CaseMemory(props: {readonly uri: string; readonly refresh: number}): React.ReactElement {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setError('');
    void api<{content: string}>(`/api/memory?uri=${encodeURIComponent(props.uri)}`, undefined, {
      signal: controller.signal,
      timeoutMilliseconds: 30_000,
    })
      .then(result => {
        if (!controller.signal.aborted) setContent(result.content);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [props.uri, props.refresh]);
  return (
    <section aria-label="Memory being reviewed" className="health-case-memory">
      <h3>Stored memory</h3>
      {error ? (
        <p role="alert">{error}</p>
      ) : content === undefined ? (
        <p role="status">Loading memory…</p>
      ) : (
        <MemoryBody content={memoryDocumentParts(content).body} />
      )}
    </section>
  );
}
