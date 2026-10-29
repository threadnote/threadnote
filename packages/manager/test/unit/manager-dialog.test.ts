import {Array as EffectArray, Option as EffectOption} from 'effect';
// @vitest-environment happy-dom

import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import React, {useState} from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ManagerAutocompleteInput,
  ManagerDialogProvider,
  managerAutocompleteEntries,
  type ManagerDialogs,
  type ManagerDialogField,
  useManagerDialogs,
  validateManagerDialogValues,
} from '@threadnote/manager/dialog';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const root = process.cwd();
let reactRoot: Root | undefined;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterEach(async () => {
  if (reactRoot) {
    await act(async () => reactRoot?.unmount());
    reactRoot = undefined;
  }
  document.body.replaceChildren();
});

describe('manager dialogs', () => {
  it('trims every submitted field without dropping optional empty values', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (project, team) => {
        const fields: readonly ManagerDialogField[] = [
          {id: 'project', label: 'Project'},
          {id: 'team', label: 'Team'},
        ];
        const result = validateManagerDialogValues(fields, {
          project: `  ${project}  `,
          team: `\t${team}\n`,
        });

        expect(result).toEqual({
          ok: true,
          values: {project: Effect.pipe(project, EffectString.trim), team: Effect.pipe(team, EffectString.trim)},
        });
      }),
    );
  });

  it('reports the first blank required field', () => {
    const fields: readonly ManagerDialogField[] = [
      {id: 'project', label: 'Project', required: true},
      {id: 'topic', label: 'Topic', required: true},
    ];

    expect(validateManagerDialogValues(fields, {project: ' \n ', topic: 'kept'})).toEqual({
      fieldId: 'project',
      ok: false,
    });
  });

  it('deduplicates and filters autocomplete options while offering novel values explicitly', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), {maxLength: 40}), fc.string(), (options, query) => {
        const entries = managerAutocompleteEntries(options, query, true);
        const normalizedQuery = Effect.pipe(query, EffectString.trim, EffectString.toLocaleLowerCase());
        const normalizedOptions = new Set(
          EffectArray.map(
            EffectArray.filter(
              EffectArray.map(options, option => Effect.pipe(option, EffectString.trim)),
              Boolean,
            ),
            option => Effect.pipe(option, EffectString.toLocaleLowerCase()),
          ),
        );
        const existing = EffectArray.filter(entries, entry => entry.kind === 'existing');
        const normalizedExisting = EffectArray.map(existing, entry =>
          Effect.pipe(entry.value, EffectString.toLocaleLowerCase()),
        );
        const shouldCreate = normalizedQuery.length > 0 && !normalizedOptions.has(normalizedQuery);

        expect(new Set(normalizedExisting).size).toBe(normalizedExisting.length);
        expect(
          EffectArray.every(normalizedExisting, option => Effect.pipe(option, EffectString.includes(normalizedQuery))),
        ).toBe(true);
        expect(entries[0]?.kind === 'create').toBe(shouldCreate);
        if (shouldCreate) expect(entries[0]?.value).toBe(Effect.pipe(query, EffectString.trim));
      }),
    );
  });

  it('does not offer creation when the typed value already exists with different casing', () => {
    expect(managerAutocompleteEntries(['Threadnote', ' threadnote '], 'THREADNOTE', true)).toEqual([
      {kind: 'existing', label: 'Threadnote', value: 'Threadnote'},
    ]);
  });

  it('queues dialogs, resolves cancel and confirm, and focuses the safe danger action', async () => {
    let dialogs: ManagerDialogs | undefined;
    await render(
      React.createElement(
        ManagerDialogProvider,
        undefined,
        React.createElement(DialogCapture, {onReady: value => (dialogs = value)}),
      ),
    );

    let first!: Promise<Readonly<Record<string, string>> | undefined>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = dialogs!.prompt({title: 'First prompt'});
      second = dialogs!.confirm({title: 'Dangerous follow-up', tone: 'danger'});
    });
    expect(document.querySelector('h2')?.textContent).toBe('First prompt');

    await clickButton('Cancel');
    await expect(first).resolves.toBeUndefined();
    expect(document.querySelector('h2')?.textContent).toBe('Dangerous follow-up');
    expect(document.activeElement?.textContent).toBe('Cancel');

    await clickButton('Continue');
    await expect(second).resolves.toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('keeps a required prompt open, reports the error, and focuses the invalid field', async () => {
    let dialogs: ManagerDialogs | undefined;
    await render(
      React.createElement(
        ManagerDialogProvider,
        undefined,
        React.createElement(DialogCapture, {onReady: value => (dialogs = value)}),
      ),
    );

    let result!: Promise<Readonly<Record<string, string>> | undefined>;
    await act(async () => {
      result = dialogs!.prompt({
        fields: [{id: 'project', label: 'Project', required: true}],
        title: 'Required project',
      });
    });
    await clickButton('Continue');

    const input = document.querySelector<HTMLInputElement>('input[name="project"]');
    expect(document.querySelector('.manager-dialog-field strong')?.textContent).toBe('Enter a value to continue.');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);

    await clickButton('Cancel');
    await expect(result).resolves.toBeUndefined();
  });

  it('dismisses the active prompt with Escape', async () => {
    let dialogs: ManagerDialogs | undefined;
    await render(
      React.createElement(
        ManagerDialogProvider,
        undefined,
        React.createElement(DialogCapture, {onReady: value => (dialogs = value)}),
      ),
    );

    let result!: Promise<Readonly<Record<string, string>> | undefined>;
    await act(async () => {
      result = dialogs!.prompt({title: 'Escape prompt'});
    });
    await act(async () => {
      document.querySelector('dialog')?.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Escape'}));
    });

    await expect(result).resolves.toBeUndefined();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('supports keyboard selection in the autocomplete listbox', async () => {
    await render(React.createElement(AutocompleteHarness));
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;

    await act(async () => input.click());
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowDown'})));
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Enter'})));

    expect(input.value).toBe('Beta');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps native browser prompts out of every Manager surface', async () => {
    const sources = await Promise.all(
      EffectArray.map(['packages/manager/src/ui.tsx', 'packages/manager/src/graph.tsx'], file =>
        readFile(join(root, file), 'utf8'),
      ),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/);
    }
  });
});

function DialogCapture(props: {readonly onReady: (dialogs: ManagerDialogs) => void}): null {
  props.onReady(useManagerDialogs());
  return null;
}

function AutocompleteHarness(): React.ReactElement {
  const [value, setValue] = useState('');
  return React.createElement(ManagerAutocompleteInput, {
    onChange: setValue,
    options: ['Alpha', 'Beta'],
    value,
  });
}

async function render(element: React.ReactElement): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(element));
}

async function clickButton(label: string): Promise<void> {
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst([...document.querySelectorAll('button')], candidate => candidate.textContent === label),
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}
