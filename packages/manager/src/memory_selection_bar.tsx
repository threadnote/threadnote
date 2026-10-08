import React from 'react';
import {Download, ListChecks} from 'lucide-react';
import {MAX_CONSOLIDATION_SOURCES} from '@threadnote/memory/consolidation';
import type {LibraryScope} from './library_model.js';

export function MemorySelectionBar(props: {
  readonly count: number;
  readonly disabled: boolean;
  readonly canConsolidate: boolean;
  readonly canPublish: boolean;
  readonly scope: LibraryScope;
  readonly onConsolidate: () => void;
  readonly onBulkAction: (action: 'archive' | 'publish' | 'forget' | 'unpublish') => void;
  readonly onClear: () => void;
}): React.ReactElement | null {
  if (props.count === 0) return null;
  return (
    <div className="selection-bar" aria-live="polite">
      <span>
        <strong>{props.count}</strong> {props.count === 1 ? 'memory' : 'memories'} selected · includes hidden
        descendants
      </span>
      <button
        className="primary"
        disabled={props.disabled || !props.canConsolidate}
        title={`Select 2–${MAX_CONSOLIDATION_SOURCES} memories to consolidate`}
        onClick={props.onConsolidate}
      >
        <ListChecks aria-hidden="true" />
        Consolidate
      </button>
      {props.scope !== 'local' ? (
        <button disabled={props.disabled} onClick={() => props.onBulkAction('unpublish')}>
          <Download aria-hidden="true" />
          Unpublish…
        </button>
      ) : (
        <>
          <button disabled={props.disabled} onClick={() => props.onBulkAction('archive')}>
            Archive
          </button>
          <button disabled={props.disabled || !props.canPublish} onClick={() => props.onBulkAction('publish')}>
            Publish…
          </button>
          <button className="danger" disabled={props.disabled} onClick={() => props.onBulkAction('forget')}>
            Forget…
          </button>
        </>
      )}
      <button disabled={props.disabled} onClick={props.onClear}>
        Clear
      </button>
    </div>
  );
}
