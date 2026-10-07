import React, {useEffect, useState} from 'react';
import type {ObsidianProjection, ObsidianSource} from './integrations_contracts.js';
import {DetailModal} from './detail_modal.js';
import {useManagerDialogs} from './dialog.js';
import {api, errorMessage} from './ui/support.js';

export function ObsidianConnectionForm({
  connection,
  onClose,
  onSaved,
}: {
  readonly connection:
    | {readonly kind: 'source'; readonly value?: ObsidianSource}
    | {readonly kind: 'projection'; readonly value?: ObsidianProjection};
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): React.ReactElement {
  const source = connection.kind === 'source' ? connection.value : undefined;
  const projection = connection.kind === 'projection' ? connection.value : undefined;
  const importing = connection.kind === 'source';
  const existing = connection.value;
  const dialogs = useManagerDialogs();
  const [id, setId] = useState(existing?.id ?? '');
  const [vault, setVault] = useState(existing?.vault ?? '');
  const [include, setInclude] = useState(source?.include.join('\n') ?? '**/*.md');
  const [exclude, setExclude] = useState(source?.exclude.join('\n') ?? '.obsidian/**\n.trash/**');
  const [inbox, setInbox] = useState(source?.inbox ?? '');
  const [folder, setFolder] = useState(projection?.folder ?? 'Threadnote');
  const [kinds, setKinds] = useState<readonly string[]>(projection?.kinds ?? ['durable', 'handoff']);
  const [statuses, setStatuses] = useState<readonly string[]>(projection?.statuses ?? ['active']);
  const [includeShared, setIncludeShared] = useState(projection?.includeShared ?? false);
  const [selection, setSelection] = useState(projection?.selectedUris === undefined ? 'all' : 'selected');
  const [uris, setUris] = useState(projection?.selectedUris?.join('\n') ?? '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    if (dirty || busy) window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  async function close(): Promise<void> {
    if (
      !busy &&
      (!dirty ||
        (await dialogs.confirm({
          title: 'Discard connection changes?',
          confirmLabel: 'Discard changes',
          tone: 'danger',
        })))
    )
      onClose();
  }
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/integrations/obsidian', {
        action: importing ? 'save-source' : 'save-projection',
        id,
        vault,
        apply: true,
        confirm: true,
        editing: !!existing,
        ...(importing
          ? {include: lines(include), exclude: lines(exclude), inbox}
          : {folder, kinds, statuses, includeShared, selection, selectedUris: lines(uris)}),
      });
      setDirty(false);
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailModal
      title={existing ? 'Obsidian connection settings' : importing ? 'Connect a vault source' : 'Set up memory export'}
      onClose={() => void close()}
    >
      <form className="integration-form" onSubmit={event => void save(event)} onChange={() => setDirty(true)}>
        <p className="muted">
          {importing
            ? 'Choose which vault notes agents can use as reference material.'
            : 'Choose which memories to copy into a dedicated folder in your vault.'}
        </p>
        {error ? (
          <p role="alert" className="workspace-note danger-text">
            {error}
          </p>
        ) : null}
        <fieldset disabled={busy}>
          <label>
            Connection name
            <input
              required
              pattern="[a-z0-9][a-z0-9._-]*"
              value={id}
              disabled={!!existing}
              onChange={event => setId(event.target.value)}
              placeholder={importing ? 'personal-notes' : 'memory-library'}
            />
          </label>
          <label>
            Vault path
            <input
              required
              value={vault}
              disabled={!!existing}
              onChange={event => setVault(event.target.value)}
              placeholder="/Users/you/Documents/My vault"
            />
          </label>
          {existing ? (
            <small className="muted">
              To change the vault or export folder, disconnect this connection and create a new one.
            </small>
          ) : null}
          {importing ? (
            <>
              <label>
                Include patterns
                <textarea required rows={3} value={include} onChange={event => setInclude(event.target.value)} />
                <small>One pattern per line, for example Engineering/**/*.md.</small>
              </label>
              <label>
                Exclude patterns
                <textarea rows={3} value={exclude} onChange={event => setExclude(event.target.value)} />
                <small>Obsidian settings, trash, and managed export folders are always excluded.</small>
              </label>
              <label>
                Inbox folder <span className="muted">(optional)</span>
                <input value={inbox} onChange={event => setInbox(event.target.value)} placeholder="Threadnote Inbox" />
                <small>
                  Relative to the vault. Notes marked threadnote_candidate: true can be submitted to Reviews.
                </small>
              </label>
            </>
          ) : (
            <>
              <label>
                Export folder
                <input
                  required
                  value={folder}
                  disabled={!!existing}
                  onChange={event => setFolder(event.target.value)}
                />
                <small>A folder relative to the vault. Threadnote protects edits to managed files.</small>
              </label>
              <label>
                Memory selection
                <select value={selection} onChange={event => setSelection(event.target.value)}>
                  <option value="all">All matching memories</option>
                  <option value="selected">Specific memory URIs</option>
                </select>
              </label>
              {selection === 'selected' ? (
                <label>
                  Memory URIs
                  <textarea
                    required
                    rows={4}
                    value={uris}
                    onChange={event => setUris(event.target.value)}
                    placeholder="threadnote://…"
                  />
                  <small>One memory URI per line.</small>
                </label>
              ) : null}
              <Choices
                title="Memory kinds"
                values={['durable', 'handoff', 'preference', 'incident', 'smoke']}
                selected={kinds}
                onChange={setKinds}
              />
              <Choices
                title="Statuses"
                values={['active', 'archived', 'superseded', 'expired']}
                selected={statuses}
                onChange={setStatuses}
              />
              <label className="integration-checkbox">
                <input
                  type="checkbox"
                  checked={includeShared}
                  onChange={event => setIncludeShared(event.target.checked)}
                />{' '}
                Include shared team memories
              </label>
            </>
          )}
        </fieldset>
        <footer className="conflict-footer">
          <button type="button" disabled={busy} onClick={() => void close()}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || (!importing && (!kinds.length || !statuses.length))}
          >
            {busy ? 'Saving…' : existing ? 'Save settings' : 'Create connection'}
          </button>
        </footer>
      </form>
    </DetailModal>
  );
}
function lines(value: string): readonly string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}
function Choices({
  title,
  values,
  selected,
  onChange,
}: {
  readonly title: string;
  readonly values: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
}): React.ReactElement {
  return (
    <fieldset className="integration-checks">
      <legend>{title}</legend>
      {values.map(value => (
        <label key={value} className="integration-checkbox">
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={event =>
              onChange(event.target.checked ? [...selected, value] : selected.filter(item => item !== value))
            }
          />
          {value}
        </label>
      ))}
    </fieldset>
  );
}
