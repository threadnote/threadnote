import React from 'react';
import {AlertTriangle, Info, Quote} from 'lucide-react';

export type ReviewTone = 'neutral' | 'info' | 'proposal' | 'warning' | 'danger' | 'protected';

export function ReviewBadge(props: {
  readonly tone?: ReviewTone;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="review-badge" data-tone={props.tone ?? 'neutral'}>
      {props.children}
    </span>
  );
}

export function MemoryExcerpt(props: {
  readonly children: React.ReactNode;
  readonly label?: string;
  readonly tone?: 'info' | 'protected';
}): React.ReactElement {
  return (
    <figure className="memory-excerpt" data-tone={props.tone ?? 'info'}>
      <figcaption>
        <Quote size={14} aria-hidden="true" />
        {props.label ?? 'Accepted memory'}
      </figcaption>
      <blockquote>{props.children}</blockquote>
    </figure>
  );
}

export function ReviewNotice(props: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly tone?: ReviewTone;
  readonly role?: 'alert' | 'status';
}): React.ReactElement {
  const Icon = props.tone === 'danger' || props.tone === 'warning' ? AlertTriangle : Info;
  return (
    <div className="review-notice" data-tone={props.tone ?? 'info'} role={props.role ?? 'status'}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{props.title}</strong>
        <div>{props.children}</div>
      </div>
    </div>
  );
}
