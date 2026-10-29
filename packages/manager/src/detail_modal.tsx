import {isContentResponse} from './api/response_guards.js';
import React, {useEffect, useId, useRef, useState} from 'react';
import {MarkdownViewer} from './ui/controls.js';
import {api, errorMessage} from './ui/support.js';
import {Array as EffectArray} from 'effect';

export function DetailModal(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly footer?: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={EffectArray.join(
        EffectArray.map(EffectArray.filter(['detail-modal', props.className], Boolean), item =>
          item === null || item === undefined ? '' : String(item),
        ),
        ' ',
      )}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={event => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{props.title}</h2>
        <button aria-label="Close details" onClick={props.onClose} type="button">
          Close
        </button>
      </header>
      <div className="detail-modal-body">{props.children}</div>
      {props.footer ? <footer className="detail-modal-actions">{props.footer}</footer> : null}
    </dialog>
  );
}

export function MemoryBody({
  content,
  onOpenMemory,
}: {
  readonly content: string;
  readonly onOpenMemory?: (uri: string) => void;
}): React.ReactElement {
  return <MarkdownViewer markdown={content} onOpenMemory={onOpenMemory} />;
}

export function MemoryDetailModal(props: {
  readonly uri: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly onOpenLibrary: (uri: string) => void;
}): React.ReactElement {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api<{content: string}>(
      `/api/memory?uri=${encodeURIComponent(props.uri)}`,
      undefined,
      undefined,
      isContentResponse,
    )
      .then(result => {
        if (!cancelled) setContent(result.content);
      })
      .catch(cause => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.uri]);
  return (
    <DetailModal title={props.title} onClose={props.onClose}>
      {error ? (
        <p role="alert">{error}</p>
      ) : content === undefined ? (
        <p role="status">Loading memory…</p>
      ) : (
        <MemoryBody content={content} onOpenMemory={props.onOpenLibrary} />
      )}
      <footer>
        <button onClick={() => props.onOpenLibrary(props.uri)} type="button">
          Open in Library
        </button>
      </footer>
    </DetailModal>
  );
}
