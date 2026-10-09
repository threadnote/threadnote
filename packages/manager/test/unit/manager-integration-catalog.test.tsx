// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '../../src/dialog.js';
import {filteredIntegrationProducts, type IntegrationProduct} from '../../src/integration_catalog.js';
import {defineIntegration} from '../../src/integration_registration.js';
import {IntegrationsPanel} from '../../src/integrations_view.js';

const products: readonly IntegrationProduct[] = [
  {
    id: 'notes',
    name: 'Notes',
    description: 'Selected text',
    capabilities: ['Read only'],
    logo: '/notes.svg',
    setupLabel: 'Connect notes',
  },
  {
    id: 'archive',
    name: 'Archive',
    description: 'Saved documents',
    capabilities: ['Export'],
    logo: '/archive.svg',
    setupLabel: 'Connect archive',
  },
];
type Connections = {readonly sources: readonly {readonly id: string}[]};
const integrations = products.map(product =>
  defineIntegration<Connections>({
    product,
    count: (data, query) => (data?.sources ?? []).filter(source => source.id.includes(query)).length,
    View: ({data, visible, query, setupAction, onSetupClosed}) => (
      <>
        {visible
          ? (data?.sources ?? [])
              .filter(source => source.id.includes(query))
              .map(source => (
                <p className="integration-row" key={source.id}>
                  {source.id}
                </p>
              ))
          : null}
        {setupAction ? <button onClick={onSetupClosed}>Close setup</button> : null}
      </>
    ),
  }),
);
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render(): Promise<void> {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerDialogProvider>
        <IntegrationsPanel integrations={integrations} onChanged={async () => undefined} onReviews={() => undefined} />
      </ManagerDialogProvider>,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(label));
  if (!match) throw new Error('Button not found: ' + label);
  return match;
}

describe('Generic integration catalog', () => {
  it('preserves catalog ordering and query normalization', () => {
    fc.assert(
      fc.property(fc.constantFrom('Notes', 'documents', 'read only', 'export', 'missing'), query => {
        const filtered = filteredIntegrationProducts(products, query);
        expect(filtered).toEqual(filteredIntegrationProducts(products, `  ${query.toUpperCase()}  `));
        expect(filtered.map(product => products.indexOf(product))).toEqual(
          [...filtered.map(product => products.indexOf(product))].sort((a, b) => a - b),
        );
      }),
      {numRuns: 30},
    );
  });
  it('renders injected connections and setup actions and supports keyboard tab navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({notes: {sources: [{id: 'first-note'}]}, archive: {sources: []}}))),
    );
    await render();
    expect(document.querySelectorAll('.integration-row')).toHaveLength(1);
    expect(document.body.textContent).toContain('first-note');
    await act(async () =>
      document
        .querySelector('#integration-connections-tab')!
        .dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})),
    );
    expect(document.querySelector('#integration-catalog-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('.integration-product')).toHaveLength(2);
    expect(document.querySelectorAll('.integration-row')).toHaveLength(0);
    await act(async () => button('Connect archive').click());
    expect(button('Close setup')).toBeDefined();
    await act(async () => button('Close setup').click());
    expect(document.body.textContent).not.toContain('Close setup');
    await act(async () => button('Your connections').click());
    await act(async () => button('Archive').click());
    expect(document.body.textContent).toContain('No matching connections');
    expect(document.body.textContent).not.toContain('first-note');
  });
  it('aborts the aggregate read when the panel unmounts and ignores a delayed response', async () => {
    const response = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return response.promise;
      }),
    );
    await render();
    expect(document.body.textContent).toContain('Loading connections');
    await act(async () => root?.unmount());
    root = undefined;
    expect(signal?.aborted).toBe(true);
    await act(async () => response.resolve(new Response(JSON.stringify({notes: {sources: [{id: 'late-note'}]}}))));
    expect(document.body.textContent).not.toContain('late-note');
  });
});
