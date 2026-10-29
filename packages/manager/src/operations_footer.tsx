import {Array as EffectArray} from 'effect';
import React, {useEffect, useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import {
  managerProcessIsActive,
  orderManagerProcessesByAttention,
  type ManageableManagerProcess,
} from './process/contracts.js';
import {useManagerProcesses} from './process/live.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function ManagerOperationsFooter({onOpen}: {readonly onOpen: () => void}): React.ReactElement {
  const {diagnostics, loadError} = useManagerProcesses();
  const ordered = orderManagerProcessesByAttention(diagnostics?.processes ?? []);
  const active = EffectArray.filter(ordered, (process, index) => index in ordered && managerProcessIsActive(process));
  const [displayed, setDisplayed] = useState<readonly ManageableManagerProcess[]>([]);
  useEffect(() => {
    if (active.length > 0) setDisplayed(active);
  }, [diagnostics]);
  const visible = active.length > 0 || Boolean(loadError);
  const processes = active.length > 0 ? active : displayed;
  return (
    <div className={`footer-operations${visible ? ' is-visible' : ''}`} aria-hidden={!visible} inert={!visible}>
      <div className="footer-operations-clip">
        <div className="footer-operations-content">
          <button
            aria-label="Inspect active operations"
            className="footer-operations-summary"
            onClick={onOpen}
            type="button"
          >
            {active.length > 0 && !loadError ? <LoaderCircle aria-hidden="true" /> : null}
            <span role="status">
              {loadError
                ? 'Operation status unavailable'
                : `${processes.length} active operation${processes.length === 1 ? '' : 's'}`}
            </span>
          </button>
          {!loadError ? (
            <ul aria-label="Active operations">
              {EffectArray.map(processes, process => {
                const label = Effect.pipe(
                  process.currentOperation ?? process.activityRole ?? process.role,
                  EffectString.replaceAll('-', ' '),
                );
                return (
                  <li key={`${process.processId}:${process.startedAt}`} title={`${label} · PID ${process.processId}`}>
                    {label}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {diagnostics?.truncated ? <span>Inventory truncated</span> : null}
        </div>
      </div>
    </div>
  );
}
