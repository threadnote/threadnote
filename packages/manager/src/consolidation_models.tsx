import {isConsolidationModelsResponse} from './api/response_guards.js';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import React, {useEffect, useState} from 'react';
import {api, errorMessage} from './ui/support.js';
import type {ConsolidationModelOption, ConsolidationModelsResponse} from './ui/contracts.js';
import {ModelSetupIndicator, useModelSetup} from './model_setup.js';

interface ModelChoice {
  readonly id: string;
  readonly explicit: boolean;
}

export function reconcileConsolidationModelChoice(
  preferred: ModelChoice | undefined,
  models: readonly ConsolidationModelOption[],
): ModelChoice | undefined {
  if (preferred?.explicit || EffectArray.some(models, model => model.id === preferred?.id)) return preferred;
  const recommended =
    EffectOption.getOrUndefined(EffectArray.findFirst(models, model => Boolean(model.isDefault))) ?? models[0];
  return recommended ? {id: recommended.id, explicit: false} : undefined;
}

export function useConsolidationModels(agent: string, enabled: boolean, storageKey = 'consolidationModel') {
  const setup = useModelSetup(enabled && agent === 'local-ai');
  const readyVersion = agent === 'local-ai' ? setup.readyVersion : 0;
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<{
    readonly key: string;
    readonly attempt: number;
    readonly readyVersion: number;
    readonly models: readonly ConsolidationModelOption[];
    readonly error?: string;
  }>();
  const [choices, setChoices] = useState<Readonly<Record<string, ModelChoice>>>({});
  const key = modelKey(agent, storageKey);
  const stored = readModel(agent, storageKey);
  const selected = choices[key] ?? (stored === undefined ? undefined : {id: stored, explicit: true});
  const current =
    enabled && catalog?.key === key && catalog.attempt === attempt && catalog.readyVersion === readyVersion
      ? catalog
      : undefined;
  const models = current?.models ?? [];
  const model = EffectArray.some(models, item => item.id === selected?.id) ? selected?.id : undefined;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setCatalog(undefined);
    void api<ConsolidationModelsResponse>(
      `/api/consolidation-models?agent=${encodeURIComponent(agent)}`,
      undefined,
      {
        signal: controller.signal,
        timeoutMilliseconds: 20_000,
      },
      isConsolidationModelsResponse,
    ).then(
      result => {
        if (controller.signal.aborted) return;
        const models = result.models;
        const stored = readModel(agent, storageKey);
        setCatalog({key, attempt, readyVersion, models});
        setChoices(previous => {
          const preferred = previous[key] ?? (stored === undefined ? undefined : {id: stored, explicit: true});
          const choice = reconcileConsolidationModelChoice(preferred, models);
          return choice ? {...previous, [key]: choice} : previous;
        });
      },
      error => {
        if (!controller.signal.aborted)
          setCatalog({key, attempt, readyVersion, models: [], error: errorMessage(error)});
      },
    );
    return () => controller.abort();
  }, [agent, attempt, enabled, key, readyVersion, storageKey]);

  return {
    models,
    model,
    selectedId: selected?.id,
    unavailable: !!current && !!selected && !model,
    local: agent === 'local-ai',
    setupEnabled: enabled && agent === 'local-ai',
    loading: enabled && !current,
    error: current?.error,
    reload: () => setAttempt(value => value + 1),
    select: (id: string) => {
      if (!EffectArray.some(models, item => item.id === id)) return;
      setChoices(previous => ({...previous, [key]: {id, explicit: true}}));
      try {
        localStorage.setItem(key, id);
      } catch {
        /* Model choice remains available when browser storage is disabled. */
      }
    },
  };
}

function modelKey(agent: string, storageKey: string): string {
  return `threadnote.manager.${storageKey}.${agent}`;
}

function readModel(agent: string, storageKey: string): string | undefined {
  try {
    return localStorage.getItem(modelKey(agent, storageKey)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function ConsolidationModelPicker(props: {
  readonly selection: ReturnType<typeof useConsolidationModels>;
  readonly disabled: boolean;
  readonly label?: string;
}): React.ReactElement {
  const {selection} = props;
  return (
    <>
      <label>
        {props.label ?? 'Model'}
        <select
          aria-label={props.label ?? 'Consolidation model'}
          aria-busy={selection.loading}
          disabled={props.disabled || selection.loading || !selection.models.length}
          value={selection.selectedId ?? ''}
          onChange={event => selection.select(event.target.value)}
        >
          {selection.selectedId && !selection.model ? (
            <option value={selection.selectedId} disabled>
              {selection.selectedId} ({selection.loading ? 'checking availability…' : 'unavailable'})
            </option>
          ) : !selection.models.length ? (
            <option value="">{selection.loading ? 'Loading models…' : 'No models loaded'}</option>
          ) : null}
          {EffectArray.map(selection.models, model => (
            <option key={model.id} value={model.id}>
              {model.label}
              {model.isDefault ? ' (recommended)' : ''}
            </option>
          ))}
        </select>
        {selection.unavailable ? <span role="status">Choose an available model before generating.</span> : null}
      </label>
      {selection.local ? <ModelSetupIndicator enabled={selection.setupEnabled} /> : null}
    </>
  );
}

export function consolidationFailureGuidance(
  error: string,
  agent?: string,
): {readonly title: string; readonly message: string} {
  if (agent === 'local-ai')
    return {
      title: 'Local generation failed',
      message: 'Reload installed models and try again, or choose another model.',
    };
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
