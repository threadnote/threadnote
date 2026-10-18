import React from 'react';
import {Check, FileCode2, History, Info, Link2, LockKeyhole, Shield, Sparkles} from 'lucide-react';
import type {TopicMaintenanceDraftV1} from '@threadnote/memory/topic-maintenance-draft';
import {MemoryExcerpt, ReviewBadge, type ReviewTone} from '../review_presentation.js';
import type {ManagerContextMaintenancePacketV2} from './contracts.js';
import type {ManagerTopicReviewV1} from './topic_contracts.js';

const statePresentation = {
  pending: {label: 'Awaiting review', tone: 'warning'},
  deferred: {label: 'Deferred', tone: 'neutral'},
  rejected: {label: 'Rejected', tone: 'neutral'},
  applying: {label: 'Saving update', tone: 'info'},
  applied: {label: 'Update saved', tone: 'proposal'},
  conflict: {label: 'Needs attention', tone: 'danger'},
} as const satisfies Record<ManagerTopicReviewV1['state'], {label: string; tone: ReviewTone}>;

export function TopicReviewSummary(props: {
  readonly review?: ManagerTopicReviewV1;
  readonly draft?: TopicMaintenanceDraftV1;
}): React.ReactElement {
  const state = props.review ? statePresentation[props.review.state] : undefined;
  const changes = props.draft?.operations.length ?? 0;
  return (
    <div className="topic-review-summary">
      <div className="review-badge-row">
        {state ? <ReviewBadge tone={state.tone}>{state.label}</ReviewBadge> : null}
        {props.draft ? (
          <ReviewBadge tone="proposal">
            <Sparkles size={13} aria-hidden="true" />
            {changes ? `${changes} proposed ${changes === 1 ? 'change' : 'changes'}` : 'No text changes proposed'}
          </ReviewBadge>
        ) : null}
        <ReviewBadge tone="protected">
          <LockKeyhole size={12} aria-hidden="true" /> Policy &amp; history protected
        </ReviewBadge>
      </div>
      <div className="review-scope-note">
        <Shield size={16} aria-hidden="true" />
        <p>
          <strong>Declared sources only.</strong> Other claims may need separate review.
        </p>
      </div>
    </div>
  );
}

export function TopicReviewNotes({review}: {readonly review: ManagerTopicReviewV1}): React.ReactElement {
  return (
    <div className="topic-review-notes">
      {review.warnings.length > 0 ? (
        <details className="review-disclosure review-advisory">
          <summary>
            <Info size={15} aria-hidden="true" /> Review notes
            <ReviewBadge tone="warning">
              {review.warnings.length} {review.warnings.length === 1 ? 'advisory' : 'advisories'}
            </ReviewBadge>
          </summary>
          <p>These checks are advisory and do not verify every claim. Review the limits before deciding.</p>
          <ul>
            {review.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <details className="review-disclosure">
        <summary>
          <Sparkles size={15} aria-hidden="true" /> Generation details
          <span className="review-disclosure-hint">{review.generation.model}</span>
        </summary>
        <dl className="review-metadata">
          <div>
            <dt>Provider</dt>
            <dd>{review.generation.agent}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{review.generation.model}</dd>
          </div>
          <div>
            <dt>Review revision</dt>
            <dd>{review.revision}</dd>
          </div>
          <div>
            <dt>Generation attempts</dt>
            <dd>{review.generation.attempts}</dd>
          </div>
          <div>
            <dt>Token usage</dt>
            <dd>
              {review.generation.usage.status === 'measured'
                ? `${review.generation.usage.inputTokens} input · ${review.generation.usage.outputTokens} output`
                : 'Model usage unavailable'}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

export function TopicSourceEvidence(props: {
  readonly topic: NonNullable<ManagerContextMaintenancePacketV2['topicEvidence']>;
}): React.ReactElement | null {
  const {topic} = props;
  if (topic.outcome !== 'ready') return null;
  return (
    <section aria-label="Source evidence" className="topic-source-evidence">
      <header className="review-section-heading">
        <h4>What changed in the source</h4>
        <ReviewBadge>
          <FileCode2 size={13} aria-hidden="true" /> {topic.sources?.length ?? 0} references
        </ReviewBadge>
      </header>
      {topic.sources?.map(source => (
        <details key={source.citationId} className="review-source-card" open={source.status === 'changed'}>
          <summary>
            <FileCode2 size={16} aria-hidden="true" />
            <code>{source.current.path}</code>
            <ReviewBadge tone={source.status === 'changed' ? 'warning' : 'info'}>
              {source.status.replaceAll('-', ' ')}
            </ReviewBadge>
          </summary>
          <div className="health-evidence-comparison">
            <section>
              <h5>
                <History size={13} aria-hidden="true" /> Original source
              </h5>
              <pre>{source.oldExcerpt.content}</pre>
            </section>
            <section>
              <h5>
                <FileCode2 size={13} aria-hidden="true" /> Current source
              </h5>
              <pre>{source.newExcerpt.content}</pre>
            </section>
          </div>
        </details>
      ))}
      {!topic.sources?.length ? <p>No bounded source excerpts are available.</p> : null}
      {!!topic.truncatedExcerpts && <p>Some source excerpts were omitted because of the view limit.</p>}
    </section>
  );
}

export function TopicParagraphComparison(props: {
  readonly review: ManagerTopicReviewV1;
  readonly draft?: TopicMaintenanceDraftV1;
  readonly originalParagraphs: readonly string[];
  readonly onEditParagraph: (ordinal: number, text: string) => void;
  readonly onEditSupport: (ordinal: number, handleId: string, checked: boolean) => void;
}): React.ReactElement {
  const {review} = props;
  return (
    <section aria-label="Focused topic comparison" className="topic-paragraphs">
      <header className="review-section-heading">
        <h4>
          <Sparkles size={17} aria-hidden="true" /> Review proposed changes
        </h4>
        <span>Compare with your accepted memory</span>
      </header>
      {review.paragraphs.map((paragraph, ordinal) => {
        const operation = props.draft?.operations.find(item => item.ordinal === ordinal);
        const original = props.originalParagraphs[ordinal] ?? '';
        const proposed = operation?.text ?? original;
        const preserved = paragraph.role !== 'descriptive';
        return (
          <article
            className={`topic-paragraph${operation ? ' has-proposal' : ''}`}
            key={`${ordinal}:${paragraph.hash}`}
          >
            <header>
              <div className="topic-paragraph-title">
                <span className="topic-paragraph-number">{String(ordinal + 1).padStart(2, '0')}</span>
                <h5>Paragraph {ordinal + 1}</h5>
              </div>
              <div className="review-badge-row">
                <ReviewBadge tone={preserved ? 'protected' : 'info'}>
                  {paragraph.role === 'descriptive'
                    ? 'Observed behavior'
                    : paragraph.role === 'normative'
                      ? 'Policy requirement'
                      : 'Historical decision'}
                </ReviewBadge>
                {preserved ? (
                  <ReviewBadge tone="protected">
                    <LockKeyhole size={12} aria-hidden="true" /> Preserved
                  </ReviewBadge>
                ) : operation ? (
                  <ReviewBadge tone="proposal">
                    <Sparkles size={12} aria-hidden="true" /> Updated
                  </ReviewBadge>
                ) : (
                  <ReviewBadge>Unchanged</ReviewBadge>
                )}
              </div>
            </header>
            <div className="topic-paragraph-context">
              {paragraph.scope ? <span>Scope: {paragraph.scope}</span> : null}
              <span>
                <Link2 size={12} aria-hidden="true" /> {paragraph.support} support
              </span>
            </div>
            <div className={operation ? 'topic-text-comparison' : undefined}>
              {operation ? <MemoryExcerpt>{original}</MemoryExcerpt> : null}
              {paragraph.role === 'descriptive' && review.state === 'pending' ? (
                <div className={operation ? 'review-proposal' : 'review-current-text'}>
                  <div className="review-content-label">
                    {operation ? <Sparkles size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                    {operation ? 'Proposed update' : 'Current text'}
                  </div>
                  <textarea
                    aria-label={`Proposed descriptive paragraph ${ordinal + 1}`}
                    rows={Math.max(4, Math.min(12, proposed.split('\n').length + 2))}
                    value={proposed}
                    onChange={event => props.onEditParagraph(ordinal, event.target.value)}
                  />
                </div>
              ) : operation ? (
                <div className="review-proposal">
                  <div className="review-content-label">
                    <Sparkles size={14} aria-hidden="true" /> Proposed update
                  </div>
                  <p className="review-proposal-text">{proposed}</p>
                </div>
              ) : (
                <MemoryExcerpt
                  label={preserved ? 'Preserved memory' : 'Accepted memory'}
                  tone={preserved ? 'protected' : 'info'}
                >
                  {proposed}
                </MemoryExcerpt>
              )}
            </div>
            {paragraph.role === 'descriptive' && operation ? (
              <fieldset className="topic-support-choices" disabled={review.state !== 'pending'}>
                <legend>
                  <Link2 size={13} aria-hidden="true" /> Current source support for paragraph {ordinal + 1}
                </legend>
                {review.support
                  .filter(source => source.variant === 'current')
                  .map(source => (
                    <label key={source.handleId} className="review-confirmation">
                      <input
                        type="checkbox"
                        checked={operation.supportHandles.includes(source.handleId)}
                        onChange={event => props.onEditSupport(ordinal, source.handleId, event.target.checked)}
                      />
                      <span>
                        {source.path}
                        <small>
                          {paragraph.citationIds.includes(source.citationId)
                            ? ' · declared for this paragraph'
                            : ' · other declared source'}
                        </small>
                      </span>
                    </label>
                  ))}
              </fieldset>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
