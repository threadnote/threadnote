import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

/** Loopback cookies survive Manager's changing ports; localStorage supports older sessions. */
export function readManagerPreference(key: string): string | null {
  try {
    const prefix = `${encodeURIComponent(key)}=`;
    const cookie = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.map(Effect.pipe(document.cookie, EffectString.split(';')), value =>
          Effect.pipe(value, EffectString.trim),
        ),
        __effectArrayValue => !!(value => Effect.pipe(value, EffectString.startsWith(prefix)))(__effectArrayValue),
      ),
    );
    if (cookie) return decodeURIComponent(Effect.pipe(cookie, EffectString.slice(prefix.length)));
  } catch {
    /* Storage may be disabled by the browser. */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeManagerPreference(key: string, value: string): void {
  try {
    document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Strict`;
  } catch {
    /* Keep the session usable without persistent storage. */
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The cookie can still preserve the preference. */
  }
}
