// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {SuperhumanConnectionForm} from '../src/manager-ui/connection-form.js';
import type {SuperhumanSource} from '../src/manager-contracts.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render(source?: SuperhumanSource): Promise<void> {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerDialogProvider>
        <SuperhumanConnectionForm source={source} onClose={() => undefined} onSaved={async () => undefined} />
      </ManagerDialogProvider>,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const value = [...document.querySelectorAll('button')].find(
    item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!value) throw new Error(`Missing button: ${label}`);
  return value;
}
async function fill(selector: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
const source: SuperhumanSource = {
  id: 'docs',
  enabled: true,
  project: null,
  documents: [{id: 'doc_a', pages: ['page_a', 'page_b']}, {id: 'doc_b'}],
  credentialEnv: 'DOCS_TOKEN',
  credentialStorage: 'local',
  credentialConfigured: true,
  includeHidden: false,
  refreshIntervalMinutes: 15,
  maxStaleHours: 24,
  status: 'needs-sync',
  chunks: 0,
};
const json = (value: unknown) => new Response(JSON.stringify(value));
const pageA = {
  documentId: 'doc_a',
  pageId: 'page_a',
  name: 'Launch checklist',
  browserLink: 'https://docs.superhuman.com/d/_ddoc_a/Checklist_spage_a',
  iconUrl: 'https://cdn.coda.io/icons/png/color/checklist.png',
};
const pageB = {
  documentId: 'doc_a',
  pageId: 'page_b',
  name: 'Handoff notes',
  browserLink: 'https://docs.superhuman.com/d/_ddoc_a/Handoff_spage_b',
};
const whole = {
  documentId: 'doc_b',
  name: 'Team handbook',
  browserLink: 'https://docs.superhuman.com/d/_ddoc_b',
  iconUrl: 'https://codahosted.io/docs/doc_b/blobs/upload/book.png',
};
const selection = {documents: source.documents, selections: [pageA, pageB, whole]};

describe('Superhuman link chips', () => {
  it('shows legacy saved scope immediately, hydrates titles, and saves the original IDs without re-entering links', async () => {
    const metadata = Promise.withResolvers<Response>();
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        return body.action === 'describe-selection' ? metadata.promise : json({});
      }),
    );
    await render(source);
    expect(document.querySelectorAll('.integration-link-chip')).toHaveLength(3);
    expect(document.body.textContent).toContain('Page page_a');
    expect(document.querySelectorAll('.integration-link-chip-icon svg')).toHaveLength(3);
    expect(button('Save settings').disabled).toBe(false);
    await act(async () => metadata.resolve(json(selection)));
    expect(document.querySelectorAll('.integration-link-chip[data-kind="page"]')).toHaveLength(2);
    expect(document.querySelectorAll('.integration-link-chip[data-kind="document"]')).toHaveLength(1);
    expect(document.querySelector('.integration-link-chip a')?.getAttribute('href')).toBe(pageA.browserLink);
    expect(document.body.textContent).toContain('Team handbook');
    expect(
      [...document.querySelectorAll('.integration-link-chip-icon img')].map(item => item.getAttribute('src')),
    ).toEqual([pageA.iconUrl, whole.iconUrl]);
    expect(document.querySelector('.integration-link-chip-icon img')?.getAttribute('referrerpolicy')).toBe(
      'no-referrer',
    );
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    await act(async () => button('Save settings').click());
    expect(calls[0]).toEqual({action: 'describe-selection', id: 'docs'});
    expect(calls[1]).toMatchObject({action: 'save-source', documents: source.documents});
    expect(calls[1]).not.toHaveProperty('token');
    expect(calls[1]).not.toHaveProperty('links');
  });

  it('retains usable page/document fallback icons when assigned artwork fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(selection)),
    );
    await render(source);
    for (const image of [...document.querySelectorAll('.integration-link-chip-icon img')]) {
      await act(async () => image.dispatchEvent(new Event('error')));
    }
    expect(document.querySelectorAll('.integration-link-chip-icon img')).toHaveLength(0);
    expect(document.querySelectorAll('.integration-link-chip-icon svg')).toHaveLength(3);
    expect(document.querySelectorAll('.integration-link-chip')).toHaveLength(3);
    expect(document.body.textContent).toContain('Launch checklist');
    expect(button('Save settings').disabled).toBe(false);
  });

  it('preserves visible scope when titles cannot be loaded and removes only the chosen page', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        return body.action === 'describe-selection' ? new Response('{}', {status: 401}) : json({});
      }),
    );
    await render(source);
    expect(document.querySelectorAll('.integration-link-chip')).toHaveLength(3);
    expect(document.body.textContent).toContain('Your saved selection is still available');
    await act(async () => button('Remove Page page_a').click());
    expect(document.activeElement?.id).toBe('superhuman-links');
    await act(async () => button('Save settings').click());
    expect(calls[1]?.documents).toEqual([{id: 'doc_a', pages: ['page_b']}, {id: 'doc_b'}]);
  });

  it('does not restore a removed selection when a delayed title response arrives', async () => {
    const metadata = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => metadata.promise),
    );
    await render(source);
    await act(async () => button('Remove Page page_a').click());
    await act(async () => metadata.resolve(json(selection)));
    expect(document.querySelectorAll('.integration-link-chip')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('Launch checklist');
    expect(document.body.textContent).toContain('Handoff notes');
  });

  it('adds title chips with Enter, deduplicates pages, and replaces page chips with their whole document', async () => {
    const calls: Record<string, unknown>[] = [];
    const docA = {
      ...whole,
      documentId: 'doc_a',
      name: 'Project plan',
      browserLink: 'https://docs.superhuman.com/d/_ddoc_a',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (body.action !== 'resolve-links') return json({});
        const item = body.links[0] === pageA.browserLink ? pageA : body.links[0] === pageB.browserLink ? pageB : docA;
        return json({
          documents: [{id: item.documentId, ...('pageId' in item ? {pages: [item.pageId]} : {})}],
          selections: [item],
        });
      }),
    );
    await render();
    await fill('input[placeholder="team-docs"]', 'docs');
    await fill('input[type="password"]', 'synthetic-token');
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('select')!;
      select.value = 'projectless';
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
    for (const url of [pageA.browserLink, pageA.browserLink, pageB.browserLink, docA.browserLink]) {
      await fill('#superhuman-links', url);
      await act(async () =>
        document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})),
      );
      expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
      if (url === pageA.browserLink)
        expect(document.querySelector('.integration-link-chip-icon img')?.getAttribute('src')).toBe(pageA.iconUrl);
    }
    expect(document.querySelectorAll('.integration-link-chip')).toHaveLength(1);
    expect(document.querySelector('.integration-link-chip')?.getAttribute('data-kind')).toBe('document');
    expect(document.body.textContent).toContain('Project plan');
    expect(document.querySelector('.integration-link-chip-icon img')?.getAttribute('src')).toBe(docA.iconUrl);
    expect(document.body.textContent).not.toContain('Launch checklist');
    await act(async () => button('Create connection').click());
    expect(calls.at(-1)?.documents).toEqual([{id: 'doc_a'}]);
    await act(async () => button('Remove Project plan').click());
    expect(button('Create connection').disabled).toBe(true);
  });

  it('keeps existing chips and the draft link after an add failure, without silently saving the old scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return body.action === 'describe-selection'
          ? json(selection)
          : new Response(JSON.stringify({error: 'Link unavailable'}), {status: 409});
      }),
    );
    await render(source);
    await fill('#superhuman-links', 'https://docs.superhuman.com/d/missing');
    await act(async () => button('Add links').click());
    expect(document.querySelectorAll('.integration-link-chip')).toHaveLength(3);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Link unavailable');
    expect(button('Save settings').disabled).toBe(true);
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toContain('/missing');
    await fill('#superhuman-links', '');
    expect(button('Save settings').disabled).toBe(false);
  });
});
