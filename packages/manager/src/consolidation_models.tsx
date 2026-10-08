import React, {useEffect, useState} from 'react';
import {api, errorMessage} from './ui/support.js';
import type {ConsolidationModelOption, ConsolidationModelsResponse} from './ui/contracts.js';

export function useConsolidationModels(agent: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<{
    readonly agent: string;
    readonly attempt: number;
    readonly models: readonly ConsolidationModelOption[];
    readonly error?: string;
  }>();
  const [selected, setSelected] = useState<{readonly agent: string; readonly id: string}>();
  const current = catalog?.agent === agent && catalog.attempt === attempt ? catalog : undefined;
  const models = current?.models ?? [];
  const model = selected?.agent === agent && models.some(item => item.id === selected.id) ? selected.id : undefined;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setCatalog(undefined);
    void api<ConsolidationModelsResponse>(`/api/consolidation-models?agent=${encodeURIComponent(agent)}`, undefined, {
      signal: controller.signal,
      timeoutMilliseconds: 20_000,
    }).then(
      result => {
        if (controller.signal.aborted) return;
        const models = result.models;
        const stored = readModel(agent);
        setCatalog({agent, attempt, models});
        setSelected(previous => {
          const preferred = previous?.agent === agent ? previous.id : stored;
          const option = models.find(item => item.id === preferred) ?? models.find(item => item.isDefault) ?? models[0];
          return option ? {agent, id: option.id} : undefined;
        });
      },
      error => {
        if (!controller.signal.aborted) setCatalog({agent, attempt, models: [], error: errorMessage(error)});
      },
    );
    return () => controller.abort();
  }, [agent, attempt, enabled]);

  return {
    models,
    model,
    loading: enabled && !current,
    error: current?.error,
    reload: () => setAttempt(value => value + 1),
    select: (id: string) => {
      if (!models.some(item => item.id === id)) return;
      setSelected({agent, id});
      try {
        localStorage.setItem(modelKey(agent), id);
      } catch {
        /* Model choice remains available when browser storage is disabled. */
      }
    },
  };
}

function modelKey(agent: string): string {
  return `threadnote.manager.consolidationModel.${agent}`;
}

function readModel(agent: string): string | undefined {
  try {
    return localStorage.getItem(modelKey(agent)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function ConsolidationModelPicker(props: {
  readonly selection: ReturnType<typeof useConsolidationModels>;
  readonly disabled: boolean;
}): React.ReactElement {
  const {selection} = props;
  return (
    <label>
      Model
      <select
        aria-label="Consolidation model"
        aria-busy={selection.loading}
        disabled={props.disabled || selection.loading || !selection.models.length}
        value={selection.model ?? ''}
        onChange={event => selection.select(event.target.value)}
      >
        {!selection.models.length ? (
          <option value="">{selection.loading ? 'Loading models…' : 'No models loaded'}</option>
        ) : null}
        {selection.models.map(model => (
          <option key={model.id} value={model.id}>
            {model.label}
            {model.isDefault ? ' (recommended)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function consolidationFailureGuidance(error: string): {readonly title: string; readonly message: string} {
  if (
    /model.*(?:not supported|unsupported|unavailable|not available|no longer available|not found)|model_not_found/iu.test(
      error,
    )
  )
    return {
      title: 'Try another model',
      message: 'This model is not available for your account. Choose another model and generate again.',
    };
  if (/unauthorized|authentication|sign.?in|log.?in|invalid.api.key|401/iu.test(error))
    return {
      title: 'Reconnect your agent',
      message: 'Your agent account needs to be reconnected before it can generate a draft.',
    };
  if (/rate.limit|quota|429/iu.test(error))
    return {
      title: 'Agent usage limit reached',
      message: 'Try another agent or wait for your usage limit to reset, then generate again.',
    };
  return {title: 'Draft generation failed', message: 'Try generating again, or choose another model or agent.'};
}
