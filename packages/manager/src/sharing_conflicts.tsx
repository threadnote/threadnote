import React, {useEffect, useState} from 'react';
import {AlertTriangle, Check, ChevronRight, GitCompareArrows, Pencil, RefreshCw} from 'lucide-react';
import type {SharingConflict, SharingConflictDetail} from './sharing_contracts.js';
import {api, errorMessage} from './ui/support.js';
import {MarkdownViewer} from './ui/controls.js';
import {memoryDocumentParts} from './library_model.js';
import {MemoryEditor} from './memory_editor.js';
import {DetailModal} from './detail_modal.js';
import {useManagerDialogs} from './dialog.js';

export function SharingConflicts({
  refreshVersion,
  onChanged,
  onLoaded,
}: {
  readonly refreshVersion: number;
  readonly onLoaded: (counts: Readonly<Record<string, number>>) => void;
  readonly onChanged: () => Promise<void>;
}): React.ReactElement {
  const [conflicts, setConflicts] = useState<readonly SharingConflict[]>([]);
  const [selected, setSelected] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<{conflicts: readonly SharingConflict[]}>('/api/shares/conflicts', undefined, {signal: controller.signal})
      .then(result => {
        if (!controller.signal.aborted) {
          setConflicts(result.conflicts);
          const counts: Record<string, number> = {};
          for (const conflict of result.conflicts) counts[conflict.team] = (counts[conflict.team] ?? 0) + 1;
          onLoaded(counts);
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshVersion, generation, onLoaded]);
  return (
    <section className="workspace-card sharing-conflicts" aria-label="Shared memory conflicts">
      <header>
        <h3>
          <GitCompareArrows aria-hidden="true" /> Conflicts <span className="memory-tag">{conflicts.length}</span>
        </h3>
        <button aria-label="Refresh conflicts" disabled={loading} onClick={() => setGeneration(value => value + 1)}>
          <RefreshCw />
        </button>
      </header>
      {error ? (
        <p className="workspace-pad danger-text" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="workspace-pad" role="status">
          Checking shared memories…
        </p>
      ) : conflicts.length ? (
        <>
          <p className="workspace-pad muted">
            These memories have different local and shared versions. Compare them before choosing what to keep.
          </p>
          {conflicts.map(conflict => (
            <button className="conflict-list-row" key={conflict.id} onClick={() => setSelected(conflict.id)}>
              <AlertTriangle aria-hidden="true" />
              <span>
                <strong>{conflictTitle(conflict)}</strong>
                <small>
                  {conflict.team} ·{' '}
                  {conflict.status === 'removed'
                    ? 'Deleted in shared repository'
                    : conflict.identityConflict === 'changed'
                      ? 'Different memory identities'
                      : 'Versions need reconciliation'}
                </small>
              </span>
              <span className="memory-tag">Needs review</span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </>
      ) : (
        <p className="workspace-pad conflict-empty">
          <Check aria-hidden="true" /> No shared memory conflicts. Your next sync will check for new changes.
        </p>
      )}
      {notice ? (
        <p className="workspace-pad" role="status">
          {notice}
        </p>
      ) : null}
      {selected ? (
        <ConflictResolver
          id={selected}
          onClose={() => setSelected(undefined)}
          onResolved={async () => {
            setSelected(undefined);
            setGeneration(value => value + 1);
            setNotice('Conflict resolved. The selected version is now in use.');
            await onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function conflictTitle(conflict: SharingConflict): string {
  return (conflict.relativePath.split('/').at(-1) ?? conflict.relativePath)
    .replace(/\.md$/u, '')
    .replace(/[-_]/gu, ' ');
}

export function ConflictResolver({
  id,
  onClose,
  onResolved,
}: {
  readonly id: string;
  readonly onClose: () => void;
  readonly onResolved: () => Promise<void>;
}): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [detail, setDetail] = useState<SharingConflictDetail>();
  const [resolution, setResolution] = useState<'local' | 'shared' | 'manual'>();
  const [draft, setDraft] = useState('');
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const original = detail?.localContent ?? detail?.sharedContent ?? '';
  const dirty = draft !== original;
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setError('');
    void api<SharingConflictDetail>('/api/shares/conflicts/detail?id=' + encodeURIComponent(id), undefined, {
      signal: controller.signal,
    })
      .then(value => {
        if (!controller.signal.aborted) {
          setDetail(value);
          setDraft(value.localContent ?? value.sharedContent ?? '');
          setResolution(undefined);
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [id, generation]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    if (dirty || busy) window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  async function mayDiscard(): Promise<boolean> {
    return (
      !dirty ||
      dialogs.confirm({
        title: 'Discard your resolution draft?',
        confirmLabel: 'Discard draft',
        message: 'Your edits have not been applied.',
        tone: 'danger',
      })
    );
  }
  async function close(): Promise<void> {
    if (!busy && (await mayDiscard())) onClose();
  }
  async function resolve(): Promise<void> {
    if (!detail || !resolution || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/shares/conflicts/resolve', {
        id,
        revision: detail.revision,
        resolution,
        ...(resolution === 'manual' ? {content: draft} : {}),
        confirm: true,
      });
      await onResolved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailModal
      title={detail ? 'Resolve: ' + conflictTitle(detail) : 'Resolve shared memory conflict'}
      className="conflict-modal"
      onClose={() => void close()}
    >
      {error ? (
        <div className="workspace-note danger-text" role="alert">
          {error}{' '}
          <button
            disabled={busy}
            onClick={() =>
              void mayDiscard().then(ok => {
                if (ok) setGeneration(value => value + 1);
              })
            }
          >
            Reload versions
          </button>
        </div>
      ) : null}
      {!detail ? (
        !error && <p role="status">Loading both versions…</p>
      ) : (
        <>
          <p className="muted">
            {detail.team} · {detail.relativePath}
          </p>
          {detail.readOnly ? (
            <p className="workspace-note">
              This team is read-only. Only accepting an eligible shared version is available.
            </p>
          ) : null}
          {detail.identityConflict === 'changed' ? (
            <p className="workspace-note danger-text">
              These versions refer to different memory identities. Keep the local identity, or edit a resolution based
              on the local version. The shared version cannot replace it directly.
            </p>
          ) : null}
          {detail.identityConflict === 'missing' ? (
            <p className="workspace-note">
              The shared version is missing its memory identity. Accepting it will preserve and repair the existing
              identity.
            </p>
          ) : null}
          <div className="conflict-comparison">
            <Version
              title="Local version"
              description="The version currently used by your local Threadnote."
              content={detail.localContent}
            />
            <Version
              title="Shared version"
              description={
                detail.status === 'removed'
                  ? 'This memory was deleted from the team repository.'
                  : 'The incoming version from the team repository.'
              }
              content={detail.sharedContent}
            />
          </div>
          <details className="conflict-diff">
            <summary>See exact changes and metadata</summary>
            <pre>
              {detail.diff.split('\n').map((line, index) => (
                <span
                  key={index}
                  data-change={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : undefined}
                >
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          </details>
          <fieldset className="conflict-choices" disabled={busy}>
            <legend>Choose a resolution</legend>
            <button
              type="button"
              aria-pressed={resolution === 'local'}
              disabled={!detail.canKeepLocal}
              onClick={() => setResolution('local')}
            >
              Keep local<small>Publish the local version to the team.</small>
            </button>
            <button
              type="button"
              aria-pressed={resolution === 'shared'}
              disabled={!detail.canUseShared}
              onClick={() => setResolution('shared')}
            >
              Use shared
              <small>
                {detail.status === 'removed'
                  ? 'Accept the deletion and remove the local copy.'
                  : 'Replace the local copy with the shared version.'}
              </small>
            </button>
            <button
              type="button"
              aria-pressed={resolution === 'manual'}
              disabled={!detail.canMerge}
              onClick={() => setResolution('manual')}
            >
              <Pencil aria-hidden="true" /> Edit resolution<small>Combine the versions and publish your result.</small>
            </button>
          </fieldset>
          {resolution === 'manual' ? (
            <section className="conflict-editor">
              <h3>Resolved memory</h3>
              <p className="muted">
                Starts from the {detail.localContent === undefined ? 'shared' : 'local'} version. Memory identity and
                metadata are preserved.
              </p>
              <MemoryEditor key={id + generation} content={draft} disabled={busy} onChange={setDraft} />
            </section>
          ) : null}
          <footer className="conflict-footer">
            <span className="muted">A backup of the conflicting versions is kept locally.</span>
            <button className="primary" disabled={!resolution || busy} onClick={() => void resolve()}>
              {busy
                ? 'Resolving…'
                : resolution === 'local'
                  ? 'Keep local and share'
                  : resolution === 'shared' && detail.status === 'removed'
                    ? 'Accept shared deletion'
                    : resolution === 'shared'
                      ? 'Use shared version'
                      : resolution === 'manual'
                        ? 'Save and share resolution'
                        : 'Choose a resolution'}
            </button>
          </footer>
        </>
      )}
    </DetailModal>
  );
}

function Version({
  title,
  description,
  content,
}: {
  readonly title: string;
  readonly description: string;
  readonly content?: string;
}): React.ReactElement {
  return (
    <section className="conflict-version">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div>
        {content === undefined ? (
          <p className="muted">No content in this version.</p>
        ) : (
          <MarkdownViewer markdown={memoryDocumentParts(content).body} />
        )}
      </div>
    </section>
  );
}
