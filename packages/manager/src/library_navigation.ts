export interface LibraryHistory {
  readonly entries: readonly string[];
  readonly index: number;
}

export const emptyLibraryHistory: LibraryHistory = {entries: [], index: -1};

export function visitLibraryUri(history: LibraryHistory, uri: string): LibraryHistory {
  if (history.entries[history.index] === uri) return history;
  const entries = [...history.entries.slice(0, history.index + 1), uri].slice(-100);
  return {entries, index: entries.length - 1};
}

export function canonicalizeLibraryHistory(
  history: LibraryHistory,
  requested: string,
  resolved: string,
): LibraryHistory {
  if (requested === resolved || history.entries[history.index] !== requested) return history;
  return {...history, entries: history.entries.map((uri, index) => (index === history.index ? resolved : uri))};
}
