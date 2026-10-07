import React, {useEffect, useId, useRef, useState} from 'react';
import {MarkdownViewer} from './ui/controls.js';
import {api, errorMessage} from './ui/support.js';

export function DetailModal(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly className?: string;
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
      className={['detail-modal', props.className].filter(Boolean).join(' ')}
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
    </dialog>
  );
}

export function MemoryBody({content}: {readonly content: string}): React.ReactElement {
  return <MarkdownViewer markdown={content} />;
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
    void api<{content: string}>(`/api/memory?uri=${encodeURIComponent(props.uri)}`)
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
        <MemoryBody content={content} />
      )}
      <footer>
        <button onClick={() => props.onOpenLibrary(props.uri)} type="button">
          Open in Library
        </button>
      </footer>
    </DetailModal>
  );
}
