type Position = {line: number; character: number};
type Range = {start: Position; end: Position};
type Location = {uri: string; range: Range};
type Edit = {range: Range; newText: string};
const file = (uri: string, rootUri: string) => {
  const url = new URL(uri);
  const prefix = new URL(rootUri).href.replace(/\/$/u, '') + '/';
  if (url.protocol !== 'file:' || url.search || url.hash || !url.href.startsWith(prefix))
    throw new Error('Out-of-fixture target');
  return decodeURIComponent(url.href.slice(prefix.length));
};
const key = (name: string, range: Range) =>
  `${name}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;

/** Independent oracle for the fixed, disposable two-file unsaved-symbol fixture. */
export function checkProbeReferences(
  files: Record<string, string>,
  result: unknown,
  rootUri = 'file:///fixture',
): boolean {
  if (!Array.isArray(result)) return false;
  const expected: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    for (const [line, content] of text.split('\n').entries()) {
      for (const match of content.matchAll(/UnsavedName/gu)) {
        expected.push(key(name, {start: {line, character: match.index}, end: {line, character: match.index + 11}}));
      }
    }
  }
  try {
    const actual = (result as Location[]).map(x => key(file(x.uri, rootUri), x.range));
    return expected.length > 0 && JSON.stringify(actual.sort()) === JSON.stringify(expected.sort());
  } catch {
    return false;
  }
}

/** The first fixture file declares the symbol; definition requests come from its dependent file. */
export function checkProbeDefinition(
  files: Record<string, string>,
  result: unknown,
  rootUri = 'file:///fixture',
): boolean {
  try {
    const [name, text] = Object.entries(files)[0];
    const line = text.split('\n').findIndex(content => content.includes('UnsavedName'));
    const character = text.split('\n')[line].indexOf('UnsavedName');
    const expected = key(name, {start: {line, character}, end: {line, character: character + 11}});
    const values = Array.isArray(result) ? result : [result];
    if (values.length !== 1) return false;
    const value = values[0];
    return key(file(value.uri ?? value.targetUri, rootUri), value.range ?? value.targetSelectionRange) === expected;
  } catch {
    return false;
  }
}

export function checkProbeRename(files: Record<string, string>, result: unknown, rootUri = 'file:///fixture'): boolean {
  try {
    const value = result as {
      changes?: Record<string, Edit[]>;
      documentChanges?: {textDocument: {uri: string; version?: number | null}; edits: Edit[]}[];
    };
    if (!value || (value.changes !== undefined && value.documentChanges !== undefined)) return false;
    if (value.documentChanges?.some(x => x.textDocument.version != null && x.textDocument.version !== 2)) return false;
    const entries =
      value.documentChanges?.map(x => [x.textDocument.uri, x.edits] as const) ?? Object.entries(value.changes ?? {});
    const seen = new Set<string>();
    for (const [uri, edits] of entries) {
      const name = file(uri, rootUri);
      const text = files[name];
      if (text === undefined || seen.has(name)) return false;
      seen.add(name);
      const lines = text.split('\n');
      const offset = (p: Position) => {
        if (
          !Number.isInteger(p.line) ||
          !Number.isInteger(p.character) ||
          p.line < 0 ||
          p.character < 0 ||
          p.line >= lines.length ||
          p.character > lines[p.line].replace(/\r$/u, '').length
        )
          throw new Error('Invalid position');
        return lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.character;
      };
      const changes = edits
        .map(e => ({start: offset(e.range.start), end: offset(e.range.end), text: e.newText}))
        .sort((a, b) => b.start - a.start);
      let transformed = text;
      let boundary = text.length;
      for (const change of changes) {
        if (change.start > change.end || change.end > boundary || typeof change.text !== 'string') return false;
        transformed = transformed.slice(0, change.start) + change.text + transformed.slice(change.end);
        boundary = change.start;
      }
      if (transformed !== text.replaceAll('UnsavedName', 'RenamedName')) return false;
    }
    return Object.keys(files).every(name => seen.has(name));
  } catch {
    return false;
  }
}
