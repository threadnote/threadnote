import React, {useState} from 'react';
import {
  ConsolidationModelPicker,
  consolidationFailureGuidance,
  useConsolidationModels,
} from './consolidation_models.js';
import {DropdownSelect} from './ui/controls.js';
import type {SelectId} from './ui/contracts.js';
import {
  MAX_CONSOLIDATION_SOURCES,
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
    if (props.draft && props.sources.length) sections = consolidationSections(props.draft);
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
  const reviewedCount = sections.filter((section, index) => {
    const review = props.reviews[index];
    return (
      review?.section === section &&
      (review.disposition === 'unsupported' ||
        ((review.disposition === 'direct' || review.disposition === 'contextual') && review.supports.length > 0))
    );
  }).length;
  return (
    <section aria-label="Consolidation evidence review">
      <div className="consolidation-step">
        <h4>2. Edit and review</h4>
        <p>Read the draft below and edit it as needed. Then choose how each paragraph is supported.</p>
      </div>
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
      {sections.length ? (
        <div className="consolidation-support-guide">
          <div className="consolidation-review-progress">
            <strong>Paragraph support</strong>
            <span>
              {reviewedCount} of {sections.length} reviewed
            </span>
          </div>
          <dl>
            <dt>Backed by a source</dt>
            <dd>The source supports this claim. Choose its passage and the references to keep.</dd>
            <dt>Background context</dt>
            <dd>Related information only. Its evidence stays in review history, not active references.</dd>
            <dt>No source support</dt>
            <dd>Your own judgment or a new claim. Save it without supporting references.</dd>
          </dl>
          <p>Editing the draft resets these choices. Nothing is saved until you confirm.</p>
        </div>
      ) : null}
      {problem && reviewedCount === sections.length ? <p role="status">{problem}</p> : null}
      {sections.map((section, index) => {
        const review = props.reviews[index]?.section === section ? props.reviews[index] : undefined;
        return (
          <fieldset key={`${index}:${section}`} disabled={props.disabled}>
            <legend>Paragraph {index + 1}</legend>
            <pre style={{whiteSpace: 'pre-wrap'}}>{section}</pre>
            <label>
              How is this paragraph supported?{' '}
              <select
                aria-label={`Support for paragraph ${index + 1}`}
                value={review?.disposition ?? 'unresolved'}
                onChange={event => {
                  const value = event.target.value;
                  if (value === 'direct' || value === 'contextual' || value === 'unsupported')
                    update(index, {disposition: value, supports: []});
                }}
              >
                <option value="unresolved" disabled>
                  Choose support…
                </option>
                <option value="direct">Backed by a source</option>
                <option value="contextual">Background context</option>
                <option value="unsupported">No source support</option>
              </select>
            </label>
            {review?.disposition === 'unsupported' ? (
              <p>This paragraph will be saved without supporting code references or memory links.</p>
            ) : review?.disposition && review.disposition !== 'unresolved' ? (
              <>
                <p>
                  {review.disposition === 'direct'
                    ? 'Open a source below and choose the passage that supports this claim. Then check the code references or memory links to keep.'
                    : 'Open a source below and choose a passage that provides background. Its selected evidence will stay in review history.'}
                </p>
                {props.sources.map((source, sourceIndex) => (
                  <details key={source.uri}>
                    <summary>
                      Source {sourceIndex + 1}: {source.uri.split('/').at(-1)?.replace(/\.md$/, '')}
                    </summary>
                    <p className="consolidation-source-origin">
                      {source.uri}
                      <br />
                      Revision {source.revision.slice(0, 12)}
                    </p>
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
                            Use this passage
                          </label>
                          <pre style={{whiteSpace: 'pre-wrap'}}>{fragment}</pre>
                          {support ? (
                            <div>
                              <p>
                                References for this passage:{' '}
                                {review.disposition === 'contextual'
                                  ? 'kept as background only.'
                                  : 'only checked references are carried into the saved memory.'}
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
                ))}
              </>
            ) : (
              <p>Choose a support option above to continue.</p>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}

export function ConsolidationPanel(props: {
  readonly standalone?: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly canResume: boolean;
  readonly error?: string;
  readonly draftError?: string;
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
  readonly onDraft: (model: string) => void;
  readonly onApply: () => void;
  readonly onResume: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const modelSelection = useConsolidationModels(props.agent, props.standalone === true || expanded);
  const guidance = props.draftError ? consolidationFailureGuidance(props.draftError, props.agent) : undefined;
  const Container = props.standalone ? 'section' : 'details';
  return (
    <Container
      className="consolidation-details"
      onToggle={event => {
        if (event.currentTarget instanceof HTMLDetailsElement) setExpanded(event.currentTarget.open);
      }}
    >
      {props.standalone ? null : <summary>Consolidate memories</summary>}
      <p className="consolidation-intro">
        Create one new memory from the selected sources. Review it before saving. Personal sources are then archived
        unless the result still links to them. Shared memories stay available.
      </p>
      {props.canResume ? (
        <button disabled={props.disabled} onClick={() => void props.onResume()}>
          Resume saved source cleanup
        </button>
      ) : null}
      {props.error ? <p role="alert">{props.error}</p> : null}
      <div className="consolidation-step">
        <h4>1. Generate a draft</h4>
      </div>
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
      <div className="consolidation-agent-model">
        <label>
          Generate with
          <DropdownSelect
            id="agent"
            disabled={props.disabled}
            label="AI provider"
            onChange={props.onAgentChange}
            openSelect={props.openSelect}
            options={props.agents
              .filter(
                item =>
                  ['codex', 'claude', 'local-ai'].includes(item.id) || (item.id === 'effect-ai' && item.available),
              )
              .map(item => ({
                disabled: !item.available && item.id !== 'local-ai',
                label: `${item.label}${item.available ? '' : item.id === 'local-ai' ? ' (install a model)' : ' unavailable'}`,
                value: item.id,
              }))}
            setOpenSelect={props.setOpenSelect}
            value={props.agent}
          />
        </label>
        <ConsolidationModelPicker selection={modelSelection} disabled={props.disabled} />
        <button
          style={{flexShrink: 0, whiteSpace: 'nowrap'}}
          disabled={props.disabled || !props.canDraft || !modelSelection.model}
          onClick={() => modelSelection.model && props.onDraft(modelSelection.model)}
        >
          {props.drafting ? 'Generating…' : 'Generate draft'}
        </button>
      </div>
      {props.agent === 'local-ai' ? (
        <p className="consolidation-hint">Your selected memories are processed on this computer.</p>
      ) : null}
      {modelSelection.error ||
      (!modelSelection.loading && !modelSelection.models.length && (props.standalone || expanded)) ? (
        <section className="consolidation-error" role="alert">
          <strong>
            {props.agent === 'local-ai' && !modelSelection.error ? 'Install a local model' : 'Could not load models'}
          </strong>
          <p>
            {props.agent === 'local-ai' && !modelSelection.error ? (
              <>
                Run <code>threadnote models list</code>, then install a generation model with{' '}
                <code>threadnote models install &lt;model-id&gt;</code> and reload the list.
              </>
            ) : (
              'Reload the model list or choose another provider to continue.'
            )}
          </p>
          <button disabled={props.disabled} onClick={modelSelection.reload}>
            Reload models
          </button>
          {modelSelection.error ? (
            <details>
              <summary>Technical details</summary>
              <pre>{modelSelection.error}</pre>
            </details>
          ) : null}
        </section>
      ) : null}
      {!props.canDraft ? (
        <p className="consolidation-hint">
          Select 2–{MAX_CONSOLIDATION_SOURCES} memories in Library using their checkboxes.
        </p>
      ) : null}
      {props.draftError ? (
        <section className="consolidation-error" role="alert">
          <strong>{guidance?.title}</strong>
          <p>{guidance?.message} Your source memories have not been changed.</p>
          <button disabled={props.disabled} onClick={modelSelection.reload}>
            Reload models
          </button>
          <details>
            <summary>Show agent error</summary>
            <pre>{props.draftError}</pre>
          </details>
        </section>
      ) : null}
      {props.hasJob ? (
        <>
          <ConsolidationDraftReview
            draft={props.draft}
            sources={props.sources}
            reviews={props.reviews}
            disabled={props.disabled}
            busy={props.busy}
            onDraftChange={props.onDraftChange}
            onReviewChange={props.onReviewChange}
          />
          <div className="consolidation-step">
            <h4>3. Save memory</h4>
            <p>
              Review every paragraph to enable saving. You’ll confirm before saving and archiving eligible personal
              sources. Shared memories and sources kept as active links stay available.
            </p>
          </div>
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
            {props.applying ? 'Saving…' : 'Save memory'}
          </button>
        </>
      ) : null}
    </Container>
  );
}
