import React from 'react';
import {createPortal} from 'react-dom';

/** Lets each module own its action while sharing the Manager page header. */
export function PageActions({children}: {readonly children: React.ReactNode}): React.ReactElement {
  const target = typeof document === 'undefined' ? null : document.getElementById('manager-page-actions');
  return target ? createPortal(children, target) : <div className="section-actions">{children}</div>;
}
