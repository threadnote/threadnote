import * as Schema from 'effect/Schema';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
type Position = {
  line: number;
  character: number;
};
type Range = {
  start: Position;
  end: Position;
};
const positionSchema = Schema.Struct({line: Schema.Finite, character: Schema.Finite});
const rangeSchema = Schema.Struct({start: positionSchema, end: positionSchema});
const definitionSchema = Schema.Union([
  Schema.Struct({uri: Schema.String, range: rangeSchema}),
  Schema.Struct({targetUri: Schema.String, targetSelectionRange: rangeSchema}),
]);
const file = (uri: string, rootUri: string) => {
  const url = new URL(uri);
  const prefix = EffectString.replace(/\/$/u, '')(new URL(rootUri).href) + '/';
  if (url.protocol !== 'file:' || url.search || url.hash || !EffectString.startsWith(prefix)(url.href))
    throw new Error('Out-of-fixture target');
  return decodeURIComponent(EffectString.slice(prefix.length)(url.href));
};
const key = (name: string, range: Range) =>
  `${name}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
export function checkProbeShutdown(stop: {
  code: number | null;
  forced: boolean;
  exitObserved: boolean;
  exitTimedOut: boolean;
  shutdownError?: string;
  stderr: string;
  panicObserved: boolean;
  shutdownCompleted: boolean;
  stdioClosed: boolean;
  cleanup: {
    drained: boolean;
    scope: string;
  };
}): boolean {
  return (
    stop.code === 0 &&
    stop.exitObserved &&
    !stop.exitTimedOut &&
    !stop.shutdownError &&
    stop.shutdownCompleted &&
    stop.stdioClosed &&
    !stop.forced &&
    stop.cleanup.drained &&
    stop.cleanup.scope === 'posix-process-group' &&
    !stop.panicObserved &&
    !EffectString.includes('panicked at')(stop.stderr)
  );
}
/** Independent oracle for the fixed, disposable two-file unsaved-symbol fixture. */
export function checkProbeReferences(
  files: Record<string, string>,
  result: unknown,
  rootUri = 'file:///fixture',
): boolean {
  if (!EffectArray.isArray(result)) return false;
  const expected: string[] = [];
  for (const [name, text] of EffectRecord.toEntries(files)) {
    for (const [line, content] of EffectString.split('\n')(text).entries()) {
      for (const match of EffectString.matchAll(/UnsavedName/gu)(content)) {
        if (match.index === undefined) return false;
        expected.push(key(name, {start: {line, character: match.index}, end: {line, character: match.index + 11}}));
      }
    }
  }
  try {
    const actual = EffectArray.map(
      Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            uri: Schema.String,
            range: Schema.Struct({
              start: Schema.Struct({
                line: Schema.Finite,
                character: Schema.Finite,
              }),
              end: Schema.Struct({
                line: Schema.Finite,
                character: Schema.Finite,
              }),
            }),
          }),
        ),
      )(result),
      x => key(file(x.uri, rootUri), x.range),
    );
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
    const [name, text] = EffectRecord.toEntries(files)[0];
    const line = EffectOption.getOrElse(
      EffectArray.findFirstIndex(EffectString.split('\n')(text), content =>
        EffectString.includes('UnsavedName')(content),
      ),
      () => -1,
    );
    const character = EffectOption.getOrElse(
      EffectString.indexOf('UnsavedName')(EffectString.split('\n')(text)[line]),
      () => -1,
    );
    const expected = key(name, {start: {line, character}, end: {line, character: character + 11}});
    const values = EffectArray.isArray(result) ? result : [result];
    if (values.length !== 1) return false;
    const value = Schema.decodeUnknownSync(definitionSchema)(values[0]);
    return (
      ('uri' in value
        ? key(file(value.uri, rootUri), value.range)
        : key(file(value.targetUri, rootUri), value.targetSelectionRange)) === expected
    );
  } catch {
    return false;
  }
}
export function checkProbeRename(files: Record<string, string>, result: unknown, rootUri = 'file:///fixture'): boolean {
  try {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        changes: Schema.optional(
          Schema.Record(
            Schema.String,
            Schema.Array(
              Schema.Struct({
                range: Schema.Struct({
                  start: Schema.Struct({
                    line: Schema.Finite,
                    character: Schema.Finite,
                  }),
                  end: Schema.Struct({
                    line: Schema.Finite,
                    character: Schema.Finite,
                  }),
                }),
                newText: Schema.String,
              }),
            ),
          ),
        ),
        documentChanges: Schema.Struct({
          textDocument: Schema.Struct({
            uri: Schema.String,
            version: Schema.optional(Schema.Union([Schema.Finite, Schema.Null])),
          }),
          edits: Schema.Array(
            Schema.Struct({
              range: Schema.Struct({
                start: Schema.Struct({
                  line: Schema.Finite,
                  character: Schema.Finite,
                }),
                end: Schema.Struct({
                  line: Schema.Finite,
                  character: Schema.Finite,
                }),
              }),
              newText: Schema.String,
            }),
          ),
        }).pipe(Schema.Array, Schema.optional),
      }),
    )(result);
    if (!value || (value.changes !== undefined && value.documentChanges !== undefined)) return false;
    if (
      (effectOptionalValue =>
        effectOptionalValue == null
          ? undefined
          : EffectArray.some(effectOptionalValue, x => x.textDocument.version != null && x.textDocument.version !== 2))(
        value.documentChanges,
      )
    )
      return false;
    const entries =
      (effectOptionalValue =>
        effectOptionalValue == null
          ? undefined
          : EffectArray.map(effectOptionalValue, x => [x.textDocument.uri, x.edits] as const))(value.documentChanges) ??
      EffectRecord.toEntries(value.changes ?? {});
    const seen = new Set<string>();
    for (const [uri, edits] of entries) {
      const name = file(uri, rootUri);
      const text = files[name];
      if (text === undefined || seen.has(name)) return false;
      seen.add(name);
      const lines = EffectString.split('\n')(text);
      const offset = (p: Position) => {
        if (
          !Number.isInteger(p.line) ||
          !Number.isInteger(p.character) ||
          p.line < 0 ||
          p.character < 0 ||
          p.line >= lines.length ||
          p.character > EffectString.replace(/\r$/u, '')(lines[p.line]).length
        )
          throw new Error('Invalid position');
        return EffectArray.reduce(lines.slice(0, p.line), 0, (sum, line) => sum + line.length + 1) + p.character;
      };
      const changes = EffectArray.map(edits, e => ({
        start: offset(e.range.start),
        end: offset(e.range.end),
        text: e.newText,
      })).sort((a, b) => b.start - a.start);
      let transformed = text;
      let boundary = text.length;
      for (const change of changes) {
        if (change.start > change.end || change.end > boundary || typeof change.text !== 'string') return false;
        transformed =
          EffectString.slice(0, change.start)(transformed) + change.text + EffectString.slice(change.end)(transformed);
        boundary = change.start;
      }
      if (transformed !== EffectString.replaceAll('UnsavedName', 'RenamedName')(text)) return false;
    }
    return EffectArray.every(EffectRecord.keys(files), name => seen.has(name));
  } catch {
    return false;
  }
}
