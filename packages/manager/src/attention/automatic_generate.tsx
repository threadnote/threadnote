import React, {useEffect, useRef, useState} from 'react';
import {ConsolidationModelPicker, useConsolidationModels} from '../consolidation_models.js';
import {api, errorMessage} from '../ui/support.js';
import {ReviewNotice} from '../review_presentation.js';
import type {ManagerAutomaticMemoryItem, ManagerAutomaticReview} from './topic_contracts.js';

/** Optional foreground generation reuses the selected-model UI and the existing bounded draft controller. */
export function AutomaticGenerate(props: {
  readonly project: string;
  readonly item: ManagerAutomaticMemoryItem;
  readonly onReady: (reviewId: string) => void;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [backend, setBackend] = useState<'local-ai' | 'effect-ai'>('local-ai');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const model = useConsolidationModels(backend, open, 'automaticMemoryModel');
  const owned = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function generate() {
    if (owned.current || props.disabled || !model.model) return;
    owned.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<ManagerAutomaticReview>('/api/attention/automatic-review', {
        action: 'generate',
        project: props.project,
        uri: props.item.uri,
        expectedContentHash: props.item.targetHash,
        backend,
        modelId: model.model,
      });
      if (
        result.kind !== 'automatic-memory-review' ||
        result.project !== props.project ||
        result.targetUri !== props.item.uri
      )
        throw new Error('The generated review does not match this exact memory. Refresh automatic updates.');
      if (
        mounted.current &&
        result.kind === 'automatic-memory-review' &&
        result.project === props.project &&
        result.targetUri === props.item.uri
      )
        props.onReady(result.reviewId);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      owned.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <details className="review-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Generate now (optional)</summary>
      <p>
        Automatic preparation runs during normal use when enabled. This explicit request uses the selected model and the
        same bounded evidence checks; it never approves a memory.
      </p>
      <fieldset disabled={busy}>
        <label>
          Provider
          <select value={backend} onChange={event => setBackend(event.target.value as 'local-ai' | 'effect-ai')}>
            <option value="local-ai">Local model</option>
            <option value="effect-ai">Configured remote provider</option>
          </select>
        </label>
        <ConsolidationModelPicker selection={model} disabled={busy} />
        {model.error ? <p role="alert">{model.error}</p> : null}
        <button type="button" disabled={props.disabled || busy || !model.model} onClick={() => void generate()}>
          {busy ? 'Preparing draft…' : 'Generate now'}
        </button>
      </fieldset>
      {busy ? <p role="status">Generating from the exact selected memory and source bounds…</p> : null}
      {error ? (
        <ReviewNotice title="Generation unavailable" tone="warning" role="alert">
          {error}
        </ReviewNotice>
      ) : null}
    </details>
  );
}
