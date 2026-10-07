// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import {ThemeSwitch, MANAGER_THEME_KEY} from '../../src/theme.js';

it('persists explicit appearance and follows system changes only in System mode', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const media = new EventTarget() as EventTarget & {matches: boolean};
  media.matches = false;
  const match = vi.spyOn(window, 'matchMedia').mockReturnValue(media as MediaQueryList);
  localStorage.setItem(MANAGER_THEME_KEY, 'dark');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ThemeSwitch />));
    expect(document.documentElement.dataset.theme).toBe('dark');
    const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
    await act(async () => button('Light').click());
    expect(localStorage.getItem(MANAGER_THEME_KEY)).toBe('light');
    await act(async () => {
      media.matches = true;
      media.dispatchEvent(new Event('change'));
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    await act(async () => button('System').click());
    expect(document.documentElement.dataset.theme).toBe('dark');
    await act(async () => {
      media.matches = false;
      media.dispatchEvent(new Event('change'));
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    match.mockRestore();
  }
});
