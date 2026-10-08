import React from 'react';
import {DropdownSelect} from './ui/controls.js';
import type {SelectId} from './ui/contracts.js';
import {
  consolidationSections,
  reviewConsolidation,
  type ConsolidationReview,
  type ConsolidationSource,
} from '@threadnote/memory/consolidation';

export function consolidationReviewProblem(
  draft: string,
  sources: readonly ConsolidationSource[],
  reviews: readonly ConsolidationReview[],
): string | undefined {
  try {
    reviewConsolidation(draft, sources, reviews, {
      operationId: 'preview',
      cleanup: 'archive',
      cleanupShared: false,
      target: {kind: 'durable', status: 'active', project: '', topic: '', sourceAgentClient: 'manager'},
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Evidence review is incomplete.';
  }
}

export function ConsolidationDraftReview(props: {
  readonly draft: string;
  readonly sources: readonly ConsolidationSource[];
  readonly reviews: readonly ConsolidationReview[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onDraftChange: (draft: string) => void;
  readonly onReviewChange: (reviews: readonly ConsolidationReview[]) => void;
}): React.ReactElement {
  let sections: readonly string[] = [];
  try {
    if (props.draft) sections = consolidationSections(props.draft);
  } catch {
    /* The bound error is shown below. */
  }
  const update = (index: number, change: Partial<ConsolidationReview>) => {
    const next: ConsolidationReview[] = sections.map((section, i) =>
      props.reviews[i]?.section === section ? props.reviews[i] : {section, disposition: 'unresolved', supports: []},
    );
    const current = next[index];
    next[index] = {...current, ...change};
    props.onReviewChange(next);
  };
  const problem =
    props.draft && props.sources.length
      ? consolidationReviewProblem(props.draft, props.sources, props.reviews)
      : undefined;
  return (
    <section aria-label="Consolidation evidence review">
      <textarea
        aria-label="Consolidation draft"
        aria-busy={props.busy}
        placeholder={props.busy ? 'Generating draft...' : 'Draft preview'}
        readOnly={props.disabled}
        value={props.draft}
        spellCheck={false}
        onChange={event => {
          props.onDraftChange(event.target.value);
          props.onReviewChange([]);
        }}
      />
      {props.sources.length ? (
        <p>
          Review every final paragraph. Choose direct support, context, or explicitly unsupported. Editing the draft
          clears its evidence reviews.
        </p>
      ) : null}
      {problem ? <p role="status">{problem}</p> : null}
      {sections.map((section, index) => {
        const review = props.reviews[index]?.section === section ? props.reviews[index] : undefined;
        return (
          <fieldset key={`${index}:${section}`} disabled={props.disabled}>
            <legend>Paragraph {index + 1}</legend>
            <pre style={{whiteSpace: 'pre-wrap'}}>{section}</pre>
            <label>
              Support decision{' '}
              <select
                aria-label={`Support decision for paragraph ${index + 1}`}
                value={review?.disposition ?? 'unresolved'}
                onChange={event => {
                  const value = event.target.value;
                  if (value === 'direct' || value === 'contextual' || value === 'unsupported')
                    update(index, {disposition: value, supports: []});
                }}
              >
                <option value="unresolved" disabled>
                  Unresolved — choose a decision
                </option>
                <option value="direct">Direct support</option>
                <option value="contextual">Context only</option>
                <option value="unsupported">Explicitly unsupported</option>
              </select>
            </label>
            {review?.disposition === 'unsupported' ? (
              <p>This paragraph will have no active evidence.</p>
            ) : review?.disposition && review.disposition !== 'unresolved' ? (
              props.sources.map(source => (
                <details key={source.uri}>
                  <summary>
                    {source.uri} — revision {source.revision.slice(0, 12)}
                  </summary>
                  {source.fragments.map((fragment, fragmentIndex) => {
                    const support = review.supports.find(
                      s => s.sourceUri === source.uri && s.fragment === fragmentIndex,
                    );
                    const setSupport = (change: Partial<NonNullable<typeof support>>) =>
                      update(index, {supports: review.supports.map(s => (s === support ? {...s, ...change} : s))});
                    return (
                      <div key={fragmentIndex}>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            aria-label={`Use source fragment ${fragmentIndex + 1} from ${source.uri} for paragraph ${index + 1}`}
                            checked={!!support}
                            onChange={event =>
                              update(index, {
                                supports: event.target.checked
                                  ? [
                                      ...review.supports,
                                      {
                                        sourceUri: source.uri,
                                        fragment: fragmentIndex,
                                        citationIds: [],
                                        relationIndexes: [],
                                      },
                                    ]
                                  : review.supports.filter(s => s !== support),
                              })
                            }
                          />
                          Use this source fragment
                        </label>
                        <pre style={{whiteSpace: 'pre-wrap'}}>{fragment}</pre>
                        {support ? (
                          <div>
                            <p>
                              Select only evidence that applies to this paragraph.{' '}
                              {review.disposition === 'contextual'
                                ? 'Context selections remain in derivation history.'
                                : 'Direct selections become active dependencies.'}
                            </p>
                            {source.codeCitations.map(citation => (
                              <label className="check-row" key={citation.id}>
                                <input
                                  type="checkbox"
                                  aria-label={`${citation.path} for paragraph ${index + 1} fragment ${fragmentIndex + 1}`}
                                  checked={support.citationIds.includes(citation.id)}
                                  onChange={event =>
                                    setSupport({
                                      citationIds: event.target.checked
                                        ? [...support.citationIds, citation.id]
                                        : support.citationIds.filter(id => id !== citation.id),
                                    })
                                  }
                                />
                                Code: {citation.path} (
                                {citation.target.kind === 'symbol' ? citation.target.qualifiedName : 'file'}) @{' '}
                                {citation.sourceCommit.slice(0, 12)}
                              </label>
                            ))}
                            {source.relations.map((relation, ordinal) => (
                              <label className="check-row" key={ordinal}>
                                <input
                                  type="checkbox"
                                  aria-label={`${relation.type} ${relation.uri} for paragraph ${index + 1}`}
                                  checked={support.relationIndexes.includes(ordinal)}
                                  onChange={event =>
                                    setSupport({
                                      relationIndexes: event.target.checked
                                        ? [...support.relationIndexes, ordinal]
                                        : support.relationIndexes.filter(i => i !== ordinal),
                                    })
                                  }
                                />
                                Relation: {relation.type} {relation.uri}
                              </label>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </details>
              ))
            ) : (
              <p>Support is unresolved.</p>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}

export function ConsolidationPanel(props: {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly canResume: boolean;
  readonly error?: string;
  readonly topic: string;
  readonly project: string;
  readonly onTopicChange: (value: string) => void;
  readonly onProjectChange: (value: string) => void;
  readonly agents: readonly {readonly id: string; readonly label: string; readonly available: boolean}[];
  readonly agent: string;
  readonly onAgentChange: (value: string) => void;
  readonly openSelect: SelectId | undefined;
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly canDraft: boolean;
  readonly drafting: boolean;
  readonly applying: boolean;
  readonly draft: string;
  readonly sources: readonly ConsolidationSource[];
  readonly reviews: readonly ConsolidationReview[];
  readonly onDraftChange: (draft: string) => void;
  readonly onReviewChange: (reviews: readonly ConsolidationReview[]) => void;
  readonly hasJob: boolean;
  readonly onDraft: () => void;
  readonly onApply: () => void;
  readonly onResume: () => void;
}): React.ReactElement {
  return (
    <details className="consolidation-details">
      <summary>Consolidate memories</summary>
      {props.canResume ? (
        <button disabled={props.disabled} onClick={() => void props.onResume()}>
          Resume saved source cleanup
        </button>
      ) : null}
      {props.error ? <p role="alert">{props.error}</p> : null}
      <label>
        Result topic
        <input
          aria-label="Consolidated memory topic"
          value={props.topic}
          placeholder="Automatic unique topic"
          disabled={props.disabled}
          onChange={event => props.onTopicChange(event.target.value)}
        />
      </label>
      <label>
        Result project
        <input
          aria-label="Consolidated memory project"
          value={props.project}
          disabled={props.disabled}
          onChange={event => props.onProjectChange(event.target.value)}
        />
      </label>
      <div className="field-row select-row">
        <DropdownSelect
          id="agent"
          label="Agent"
          onChange={props.onAgentChange}
          openSelect={props.openSelect}
          options={props.agents.map(item => ({
            disabled: !item.available || (item.id !== 'codex' && item.id !== 'claude'),
            label: `${item.label}${item.available ? '' : ' unavailable'}`,
            value: item.id,
          }))}
          setOpenSelect={props.setOpenSelect}
          value={props.agent}
        />
        <button
          style={{flexShrink: 0, whiteSpace: 'nowrap'}}
          disabled={props.disabled || !props.canDraft}
          onClick={() => void props.onDraft()}
        >
          {props.drafting ? 'Drafting...' : 'Draft'}
        </button>
      </div>
      <ConsolidationDraftReview
        draft={props.draft}
        sources={props.sources}
        reviews={props.reviews}
        disabled={props.disabled}
        busy={props.busy}
        onDraftChange={props.onDraftChange}
        onReviewChange={props.onReviewChange}
      />
      <button
        disabled={
          props.busy ||
          props.disabled ||
          !props.hasJob ||
          !props.draft ||
          !!consolidationReviewProblem(props.draft, props.sources, props.reviews)
        }
        onClick={() => void props.onApply()}
      >
        {props.applying ? 'Applying...' : 'Apply draft'}
      </button>
    </details>
  );
}
