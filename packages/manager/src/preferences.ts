/** Loopback cookies survive Manager's changing ports; localStorage supports older sessions. */
export function readManagerPreference(key: string): string | null {
  try {
    const prefix = `${encodeURIComponent(key)}=`;
    const cookie = document.cookie
      .split(';')
      .map(value => value.trim())
      .find(value => value.startsWith(prefix));
    if (cookie) return decodeURIComponent(cookie.slice(prefix.length));
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
