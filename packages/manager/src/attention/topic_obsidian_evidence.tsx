import React, {useState} from 'react';
import {FileText, History, LockKeyhole} from 'lucide-react';
import type {TopicMaintenanceObsidianEvidencePacketV2} from '@threadnote/context/topic_maintenance';
import {ReviewBadge} from '../review_presentation.js';

export interface TopicCaptureControls {
  readonly disabled: boolean;
  readonly onCapture: (start: number, end: number, retentionDays: number) => void;
}

export function TopicObsidianEvidence({
  topic,
  capture,
}: {
  readonly topic: TopicMaintenanceObsidianEvidencePacketV2;
  readonly capture?: TopicCaptureControls;
}): React.ReactElement {
  const [selection, setSelection] = useState<{start: number; end: number}>();
  const [approved, setApproved] = useState(false);
  const [retentionDays, setRetentionDays] = useState(90);
  const current = topic.obsidian.current;
  return (
    <section aria-label="Source evidence" className="topic-source-evidence">
      <header className="review-section-heading">
        <h4>Review the note source</h4>
        <ReviewBadge tone="protected">
          <LockKeyhole size={13} aria-hidden="true" /> Private Obsidian note
        </ReviewBadge>
      </header>
      {[
        {label: 'Original supporting excerpt', source: topic.obsidian.origin},
        {label: 'Accepted supporting excerpt', source: topic.obsidian.active},
      ].map(({label, source}) => (
        <details key={label} className="review-source-card">
          <summary>
            <History size={14} aria-hidden="true" />
            {label}
            <ReviewBadge tone={source?.historical === 'available' ? 'info' : 'warning'}>
              {source?.historical === 'available' ? 'Retained excerpt available' : 'Retained excerpt unavailable'}
            </ReviewBadge>
          </summary>
          {source ? (
            <>
              <p>{source.citation.relativePath}</p>
              <p>
                Current note:{' '}
                {source.currentRevision === 'same'
                  ? 'matches this excerpt'
                  : source.currentRevision === 'changed'
                    ? 'has changed'
                    : source.currentRevision === 'removed'
                      ? 'removed'
                      : 'could not be verified'}
                .
              </p>
            </>
          ) : null}
          {source?.historical === 'available' && source.fragment !== undefined ? (
            <pre>{source.fragment}</pre>
          ) : (
            <p>No authorized retained excerpt is available.</p>
          )}
        </details>
      ))}
      {current ? (
        <section aria-label="Current note source" className="review-source-card">
          <h5>
            <FileText size={14} aria-hidden="true" /> Current note{' '}
            <ReviewBadge tone="info">Current access verified</ReviewBadge>
          </h5>
          <p>{current.relativePath}</p>
          {capture && topic.obsidian.capture?.state !== 'captured' ? (
            <>
              <p>
                Select the exact text that supports this topic, then approve keeping a private excerpt before generating
                a draft.
              </p>
              <textarea
                aria-label="Select current note excerpt"
                readOnly
                value={current.content}
                rows={12}
                disabled={capture.disabled}
                onSelect={event => {
                  if (capture.disabled) return;
                  setSelection({start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd});
                  setApproved(false);
                }}
              />
              {selection && selection.end > selection.start ? (
                <pre aria-label="Selected note excerpt">{current.content.slice(selection.start, selection.end)}</pre>
              ) : (
                <p>No source text selected.</p>
              )}
              <label>
                Keep excerpt for days{' '}
                <input
                  aria-label="Excerpt retention days"
                  type="number"
                  min={1}
                  max={365}
                  value={retentionDays}
                  disabled={capture.disabled}
                  onChange={event => {
                    if (capture.disabled) return;
                    setRetentionDays(Number(event.target.value));
                    setApproved(false);
                  }}
                />
              </label>
              <label className="review-confirmation">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={capture.disabled || !selection || selection.end <= selection.start}
                  onChange={event => {
                    if (!capture.disabled) setApproved(event.target.checked);
                  }}
                />
                I approve keeping this exact private excerpt for the selected period.
              </label>
              <button
                type="button"
                disabled={
                  capture.disabled ||
                  !approved ||
                  !selection ||
                  selection.end <= selection.start ||
                  !Number.isSafeInteger(retentionDays) ||
                  retentionDays < 1 ||
                  retentionDays > 365
                }
                onClick={() => {
                  if (!capture.disabled && selection && approved)
                    capture.onCapture(selection.start, selection.end, retentionDays);
                }}
              >
                Keep selected excerpt
              </button>
            </>
          ) : (
            <pre>{current.content}</pre>
          )}
          {current.truncated ? (
            <p>Only the beginning of this note is shown. Choose an excerpt within the visible text.</p>
          ) : null}
        </section>
      ) : (
        <p>Current note access is unavailable. Refresh source access to continue.</p>
      )}
      {topic.obsidian.capture?.state === 'captured' ? (
        <section className="review-source-card">
          <p role="status">A private excerpt is retained for this review. Generation uses that approved excerpt.</p>
          {topic.obsidian.capture.fragment !== undefined ? (
            <pre aria-label="Retained note excerpt">{topic.obsidian.capture.fragment}</pre>
          ) : null}
        </section>
      ) : (
        <p role="status">Keep an approved source excerpt before generating a draft.</p>
      )}
    </section>
  );
}
