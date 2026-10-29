import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Schema} from 'effect';
import {useManagerLiveQuery} from '../live/provider.js';
import {api, errorMessage} from '../ui/support.js';

interface MaintenanceControl {
  readonly paused: boolean;
}
const endpoint = '/api/attention/context-maintenance?view=controls';
const isMaintenanceControl = Schema.is(Schema.Struct({paused: Schema.Boolean}));

export function MaintenanceControls(props: {
  readonly project: string;
  readonly onChanged?: () => void;
}): React.ReactElement {
  const [control, setControl] = useState<MaintenanceControl>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const mounted = useRef(false);
  const actionBusy = useRef(false);
  const read = useCallback(async (signal: AbortSignal) => {
    const request = epoch.current;
    const result = await api<MaintenanceControl>(
      endpoint,
      undefined,
      {signal, timeoutMilliseconds: 5_000},
      isMaintenanceControl,
    );
    if (mounted.current && !signal.aborted && !actionBusy.current && request === epoch.current) {
      setControl(result);
      setError('');
    }
    return result;
  }, []);
  // The setting is global; a selected project's existing subscription also carries control invalidations.
  const live = useManagerLiveQuery<MaintenanceControl>(
    props.project ? {topic: 'context-maintenance', project: props.project} : undefined,
    'controls',
    read,
    isMaintenanceControl,
  );
  const fallback = !live.active || live.snapshot.status === 'unsupported';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      if (actionBusy.current) return;
      if (!fallback) live.invalidate();
      else
        void read(controller.signal).catch(cause => {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
    };
  }, [fallback, props.project, read]);
  useEffect(() => {
    if (!fallback && live.snapshot.status === 'error') setError(errorMessage(live.snapshot.error));
  }, [fallback, live.snapshot]);

  async function change() {
    if (!control || actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true);
    setError('');
    const request = ++epoch.current;
    try {
      const result = await api<MaintenanceControl>(
        endpoint,
        {action: control.paused ? 'resume' : 'pause'},
        undefined,
        isMaintenanceControl,
      );
      if (mounted.current && request === epoch.current) {
        epoch.current += 1;
        setControl(result);
        live.invalidate();
        props.onChanged?.();
      }
    } catch (cause) {
      if (mounted.current && request === epoch.current) {
        epoch.current += 1;
        setError(errorMessage(cause));
      }
    } finally {
      actionBusy.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="attention-bulk-repair" aria-label="Automatic maintenance controls">
      <div>
        <div className="health-maintenance-heading">
          <strong>Automatic maintenance</strong>
          <span className="health-status-badge" data-tone={control?.paused ? 'neutral' : 'info'}>
            {control ? (control.paused ? 'Off' : 'On') : 'Checking…'}
          </span>
        </div>
        <p>Applies to all projects. Off by default. Work already running can finish safely when paused.</p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <button type="button" disabled={busy || !control} onClick={() => void change()}>
        {busy ? 'Saving…' : control?.paused ? 'Enable automatic maintenance' : 'Pause automatic maintenance'}
      </button>
    </section>
  );
}
