import {
  isManagerValueDeletionReceipt,
  isManagerValueReport,
  isManagerValueRetentionReceipt,
} from './api/response_guards.js';
import React, {useEffect, useRef, useState} from 'react';
import type {
  ManagerValueDeletionReceipt,
  ManagerValueReport,
  ManagerValueRetentionReceipt,
} from '@threadnote/manager/value/contracts';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {ApiResponseGuard} from './api/response_guard.js';

export function ValuePanel(props: {readonly project?: string}): React.ReactElement {
  const [period, setPeriod] = useState(30);
  const [retentionDays, setRetentionDays] = useState(365);
  const [report, setReport] = useState<ManagerValueReport>();
  const [retention, setRetention] = useState<ManagerValueRetentionReceipt>();
  const [deletion, setDeletion] = useState<ManagerValueDeletionReceipt>();
  const [deleteFeedback, setDeleteFeedback] = useState(true);
  const [deleteEvents, setDeleteEvents] = useState(true);
  const [deleteExports, setDeleteExports] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const request = useRef<AbortController>(undefined);

  useEffect(() => () => request.current?.abort(), []);

  async function submit<T>(
    path: string,
    body: Record<string, unknown>,
    label: string,
    guard: ApiResponseGuard<T>,
  ): Promise<T | undefined> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(label);
    setError('');
    try {
      return await api<T>(path, body, {signal: controller.signal}, guard);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
      return undefined;
    } finally {
      if (!controller.signal.aborted) setBusy('');
    }
  }

  async function loadReport(): Promise<void> {
    const result = await submit<ManagerValueReport>(
      '/api/value/report',
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain narrowing for the project field.
      {period, ...(props.project?.trim() ? {project: props.project.trim()} : {})},
      'report',
      isManagerValueReport,
    );
    if (result) setReport(result);
  }

  async function reviewRetention(apply: boolean): Promise<void> {
    const result = await submit<ManagerValueRetentionReceipt>(
      '/api/value/retention',
      {apply, days: retentionDays},
      apply ? 'retention-apply' : 'retention-preview',
      isManagerValueRetentionReceipt,
    );
    if (result) {
      setRetention(result);
      if (apply) await loadReport();
    }
  }

  async function reviewDeletion(apply: boolean): Promise<void> {
    const result = await submit<ManagerValueDeletionReceipt>(
      '/api/value/delete',
      {apply, events: deleteEvents, exports: deleteExports, feedback: deleteFeedback},
      apply ? 'delete-apply' : 'delete-preview',
      isManagerValueDeletionReceipt,
    );
    if (result) {
      setDeletion(result);
      if (apply) await loadReport();
    }
  }

  const selectionEmpty = !deleteFeedback && !deleteEvents && !deleteExports;
  return (
    <section className="value-workspace" aria-busy={Boolean(busy)}>
      <div className="value-toolbar">
        <label>
          Report period (days)
          <input
            min={1}
            max={3_650}
            onChange={event => setPeriod(Number(event.target.value))}
            type="number"
            value={period}
          />
        </label>
        <button
          disabled={Boolean(busy) || !Number.isSafeInteger(period) || period < 1}
          onClick={() => void loadReport()}
          type="button"
        >
          {busy === 'report' ? 'Loading…' : report ? 'Refresh value report' : 'Load value report'}
        </button>
        <p>
          Local and content-free. The report excludes paths, repository names, stable user IDs, queries, memory bodies,
          source fragments, and raw logs.
        </p>
      </div>
      {error ? (
        <p className="context-status is-error" role="alert">
          {error}
        </p>
      ) : null}
      {report ? <ValueReportSummary report={report} /> : null}
      <div className="value-data-controls">
        <section>
          <h3>Retention</h3>
          <p>Preview a one-time prune of local recall feedback and count-only value events.</p>
          <label>
            Keep days
            <input
              min={1}
              max={3_650}
              onChange={event => setRetentionDays(Number(event.target.value))}
              type="number"
              value={retentionDays}
            />
          </label>
          <div className="context-form-actions">
            <button disabled={Boolean(busy)} onClick={() => void reviewRetention(false)} type="button">
              Preview retention
            </button>
            <button disabled={Boolean(busy)} onClick={() => void reviewRetention(true)} type="button">
              Apply retention
            </button>
          </div>
          {retention ? (
            <p role="status">
              {retention.applied ? 'Applied' : 'Preview'}: remove {retention.feedback.removed} feedback and{' '}
              {retention.valueEvents.removed} value event(s); keep {retention.retentionDays} days.
            </p>
          ) : null}
        </section>
        <section>
          <h3>Delete local value data</h3>
          <p>Select exact local categories. Preview is the default; deletion requires the explicit apply button.</p>
          <label className="context-check">
            <input
              checked={deleteFeedback}
              onChange={event => setDeleteFeedback(event.target.checked)}
              type="checkbox"
            />
            Recall feedback
          </label>
          <label className="context-check">
            <input checked={deleteEvents} onChange={event => setDeleteEvents(event.target.checked)} type="checkbox" />
            Value events
          </label>
          <label className="context-check">
            <input checked={deleteExports} onChange={event => setDeleteExports(event.target.checked)} type="checkbox" />
            Export bundles
          </label>
          <div className="context-form-actions">
            <button disabled={Boolean(busy) || selectionEmpty} onClick={() => void reviewDeletion(false)} type="button">
              Preview deletion
            </button>
            <button disabled={Boolean(busy) || selectionEmpty} onClick={() => void reviewDeletion(true)} type="button">
              Delete selected
            </button>
          </div>
          {deletion ? (
            <p role="status">
              {deletion.applied ? 'Deleted' : 'Preview'}: {deletion.feedback.removed} feedback,{' '}
              {deletion.valueEvents.removed} value event(s), {deletion.exports.removed} export bundle(s).
            </p>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function ValueReportSummary(props: {readonly report: ManagerValueReport}): React.ReactElement {
  const report = props.report;
  return (
    <div className="value-report" aria-label="Local value report">
      <header>
        <h3>Local value report</h3>
        <span>
          {report.period.from} – {report.period.to}
        </span>
      </header>
      <div className="value-report-grid">
        <ValueMetric
          title="Recall actions"
          value={`${report.feedback.total}`}
          detail={`${report.feedback.applied} applied · ${report.feedback.useful} useful · ${report.feedback.wrong} wrong · ${report.feedback.pin} pinned · ${report.feedback.dismiss} dismissed`}
        />
        <ValueMetric
          title="Context Brief"
          value={`${report.contextBrief.successful}/${report.contextBrief.attempts}`}
          detail={`${report.contextBrief.coverageGaps} coverage gaps`}
        />
        <ValueMetric
          title="Activation"
          value={report.setup.availability}
          detail={`${report.setup.completed} completed · ${report.setup.supportedAgentReuse} second-agent reuse${report.setup.timeToFirstEvidenceMilliseconds === undefined ? '' : ` · ${report.setup.timeToFirstEvidenceMilliseconds} ms first evidence`}`}
        />
        <ValueMetric
          title="Knowledge Delta"
          value={`${report.knowledgeDelta.approved}/${report.knowledgeDelta.proposed}`}
          detail={`${report.knowledgeDelta.edited} edited · ${report.knowledgeDelta.rejected} rejected · ${report.knowledgeDelta.deferred} deferred`}
        />
        <ValueMetric
          title="Health"
          value={`${report.health.resolved} resolved`}
          detail={`${report.health.opened} opened`}
        />
      </div>
    </div>
  );
}

function ValueMetric(props: {
  readonly detail: string;
  readonly title: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <article>
      <span>{props.title}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </article>
  );
}
