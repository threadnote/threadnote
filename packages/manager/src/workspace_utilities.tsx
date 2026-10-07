import {Download, Upload, Sprout, Blocks, BrushCleaning} from 'lucide-react';
import React, {useState} from 'react';
import {ActionMenu, type MenuAction} from './action_menu.js';
import {useManagerDialogs} from './dialog.js';
import type {PanelName} from './ui/contracts.js';
import {api, errorMessage} from './ui/support.js';

/** Maintenance lives with the content it affects instead of a catch-all Tools page. */
export function WorkspaceUtilities({
  inline = false,
  panel,
  project,
  projects,
  onChanged,
  extraActions = [],
}: {
  readonly inline?: boolean;
  readonly extraActions?: readonly MenuAction[];
  readonly panel: PanelName;
  readonly project: string;
  readonly projects: readonly string[];
  readonly onChanged: () => Promise<void>;
}): React.ReactElement | null {
  const dialogs = useManagerDialogs();
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      await dialogs.confirm({title: 'Operation failed', detail: errorMessage(cause), confirmLabel: 'Close'});
    } finally {
      setBusy(false);
    }
  }
  async function report(result: {readonly output?: string}): Promise<void> {
    await onChanged();
    await dialogs.confirm({
      title: 'Operation complete',
      detail: result.output ?? 'Completed successfully.',
      confirmLabel: 'Done',
    });
  }
  async function pack(importing: boolean): Promise<void> {
    const values = await dialogs.prompt({
      title: importing ? 'Import Library pack' : 'Export Library pack',
      confirmLabel: importing ? 'Import' : 'Export',
      message: importing
        ? 'Import memories and resources into local storage.'
        : 'Export memories and resources to a local .ovpack file.',
      fields: [{id: 'path', label: 'Local .ovpack path', required: true, placeholder: '/path/to/library.ovpack'}],
    });
    if (values)
      await report(await api(importing ? '/api/import-pack' : '/api/export-pack', {path: values.path, confirm: true}));
  }
  async function hygiene(): Promise<void> {
    const scope = await dialogs.prompt({
      title: 'Preview memory hygiene',
      confirmLabel: 'Preview',
      fields: [
        {id: 'project', label: 'Project', options: projects, initialValue: project, required: true},
        {id: 'topic', label: 'Topic (optional)'},
      ],
    });
    if (!scope) return;
    const preview = await api<{readonly output: string}>('/api/compact', scope);
    if (
      await dialogs.confirm({
        title: 'Apply memory hygiene?',
        detail: preview.output,
        message: 'Review the scope and proposed changes before applying.',
        confirmLabel: 'Apply',
      })
    ) {
      await report(await api('/api/compact', {...scope, apply: true, confirm: true}));
    }
  }
  async function seed(skills: boolean): Promise<void> {
    if (
      await dialogs.confirm({
        title: skills ? 'Set up agent skills?' : 'Seed configured resources?',
        message: skills
          ? 'Write configured Threadnote skills to their managed destinations.'
          : 'Import configured source material into local storage.',
        confirmLabel: 'Set up',
      })
    ) {
      await report(await api('/api/seed', {confirm: true, ...(skills ? {skills: true} : {})}));
    }
  }
  const actions: readonly MenuAction[] =
    panel === 'memory'
      ? [
          {label: 'Import pack…', icon: <Download />, onSelect: () => void run(() => pack(true))},
          {label: 'Export pack…', icon: <Upload />, onSelect: () => void run(() => pack(false))},
        ]
      : panel === 'context-health'
        ? [{label: 'Memory hygiene…', icon: <BrushCleaning />, onSelect: () => void run(hygiene)}]
        : panel === 'worksets'
          ? [
              {label: 'Seed resources…', icon: <Sprout />, onSelect: () => void run(() => seed(false))},
              {label: 'Set up agent skills…', icon: <Blocks />, onSelect: () => void run(() => seed(true))},
            ]
          : [];
  if (inline && actions[0])
    return (
      <button disabled={busy} onClick={actions[0].onSelect}>
        {actions[0].icon}
        {actions[0].label}
      </button>
    );
  return actions.length ? (
    <ActionMenu
      label={`${panel === 'memory' ? 'Library' : panel === 'worksets' ? 'Project setup' : 'Context Health'} options`}
      actions={[...actions, ...extraActions]}
      disabled={busy}
    />
  ) : null;
}
