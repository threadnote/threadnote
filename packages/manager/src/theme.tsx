import {Sun, Moon, Monitor} from 'lucide-react';
import React, {useEffect, useState} from 'react';
import {readManagerPreference, writeManagerPreference} from './preferences.js';

export type ManagerTheme = 'light' | 'dark' | 'system';
export const MANAGER_THEME_KEY = 'threadnote.manager.theme';
export function managerTheme(value: string | null): ManagerTheme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function ThemeSwitch(): React.ReactElement {
  const [theme, setTheme] = useState<ManagerTheme>(() => managerTheme(readManagerPreference(MANAGER_THEME_KEY)));
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    writeManagerPreference(MANAGER_THEME_KEY, theme);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return (
    <div className="appearance-control">
      <span className="sidebar-label">Appearance</span>
      <div className="segmented-control" aria-label="Appearance">
        {(['light', 'dark', 'system'] as const).map(value => (
          <button
            key={value}
            aria-pressed={theme === value}
            className={theme === value ? 'is-active' : undefined}
            onClick={() => setTheme(value)}
            type="button"
          >
            {value === 'light' ? (
              <Sun aria-hidden="true" />
            ) : value === 'dark' ? (
              <Moon aria-hidden="true" />
            ) : (
              <Monitor aria-hidden="true" />
            )}
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
