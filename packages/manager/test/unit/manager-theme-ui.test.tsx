// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {ThemeSwitch, MANAGER_THEME_KEY} from '../../src/theme.js';
import {readManagerPreference, writeManagerPreference} from '../../src/preferences.js';
import {NavigationToggle, useNavigationCollapse} from '../../src/navigation.js';

const preferenceKeys = [MANAGER_THEME_KEY, 'threadnote.manager.navigationCollapsed'];
function clearPreferences(): void {
  localStorage.clear();
  for (const key of preferenceKeys) document.cookie = `${key}=; Path=/; Max-Age=0`;
}
beforeEach(clearPreferences);
afterEach(clearPreferences);

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

it.each(['light', 'dark', 'system'])(
  'restores %s from the shared loopback cookie ahead of stale per-port storage',
  value => {
    writeManagerPreference(MANAGER_THEME_KEY, value);
    localStorage.setItem(MANAGER_THEME_KEY, value === 'dark' ? 'light' : 'dark');
    expect(readManagerPreference(MANAGER_THEME_KEY)).toBe(value);
    localStorage.clear();
    expect(readManagerPreference(MANAGER_THEME_KEY)).toBe(value);
  },
);

it('retains sidebar collapse on remount and exposes an accessible expand control', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  function Harness(): React.ReactElement {
    const [collapsed, toggle] = useNavigationCollapse();
    return <NavigationToggle collapsed={collapsed} onToggle={toggle} />;
  }
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Expand sidebar');
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Collapse sidebar');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
