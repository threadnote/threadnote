import React from 'react';
import {LoaderCircle} from 'lucide-react';

export function ReviewProgress(props: {readonly title: string; readonly description?: string}): React.ReactElement {
  return (
    <div className="review-progress" role="status" aria-live="polite">
      <LoaderCircle className="automatic-memory-spinner" size={24} aria-hidden="true" />
      <div>
        <strong>{props.title}</strong>
        {props.description ? <p>{props.description}</p> : null}
      </div>
    </div>
  );
}
