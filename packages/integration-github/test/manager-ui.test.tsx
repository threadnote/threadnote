// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {GitHubConnectionForm} from '../src/manager-ui/connection-form.js';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(node: React.ReactNode): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ManagerDialogProvider>{node}</ManagerDialogProvider>));
}
function button(label: string): HTMLButtonElement {
  const match = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('button')],
      __effectArrayValue =>
        !!(item =>
          Effect.pipe(
            item.textContent,
            effectOptionalString =>
              effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
            effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect.pipe(effectOptionalString, EffectString.startsWith(label)),
          ))(__effectArrayValue),
    ),
  );
  if (!match) throw new Error('Button not found: ' + label);
  return match;
}
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  });
}
describe('GitHub connection', () => {
  it('saves only explicitly selected repositories with a protected local token and project choice', async () => {
    let saved: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body: unknown = JSON.parse(String(init.body));
        if (!isJsonObject(body)) throw new Error('Expected a GitHub request object.');
        saved = body;
        return new Response('{}');
      }),
    );
    await render(<GitHubConnectionForm onClose={() => undefined} onSaved={async () => undefined} />);
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="engineering"]')!, 'eng');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-token');
    await fill(
      document.querySelector<HTMLTextAreaElement>('textarea')!,
      'openai/threadnote\nhttps://github.com/openai/codex',
    );
    await choose(document.querySelector<HTMLSelectElement>('select')!, 'projectless');
    await act(async () => button('Connect and sync').click());
    expect(saved).toMatchObject({
      action: 'save-source',
      id: 'eng',
      repositories: ['openai/threadnote', 'https://github.com/openai/codex'],
      token: 'synthetic-token',
      project: null,
      apply: true,
      confirm: true,
    });
    expect(saved?.credentialEnv).toBeUndefined();
  });
});
