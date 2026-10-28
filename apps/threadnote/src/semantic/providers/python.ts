import {Deferred, Effect, Exit, FileSystem, Option, Path, Schema, Semaphore} from 'effect';
import {
  Counter,
  Evidence,
  FileUri,
  Observation,
  Position,
  observationKey,
  type QueryOutcome,
} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LspFault, type LspClient} from '../lsp_transport.js';
import {readBounded} from '../fingerprint.js';
import {
  SemanticSessionFault,
  SemanticRange as Range,
  validTextPosition,
  wellFormed,
  type SemanticDiagnostic,
  type DiagnosticSnapshot,
  type DiagnosticDelta,
  type SemanticQuery,
} from '../provider.js';

const invalid = () => SemanticSessionFault.make({reason: 'invalid'});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));
const compare = (a: Position, b: Position) => a.line - b.line || a.character - b.character;
const validRange = (text: string, range: typeof Range.Type) =>
  validTextPosition(text, range.start) && validTextPosition(text, range.end) && compare(range.start, range.end) <= 0;
const TextEdit = Schema.Struct({range: Range, newText: Schema.String});
const CompletionItem = Schema.Struct({
  label: Schema.String,
  kind: Schema.optional(Counter),
  detail: Schema.optional(Schema.String),
  documentation: Schema.optional(Schema.Json),
  insertText: Schema.optional(Schema.String),
  insertTextFormat: Schema.optional(Counter),
  filterText: Schema.optional(Schema.String),
  sortText: Schema.optional(Schema.String),
});
const HierarchyItem = Schema.Struct({
  name: Schema.String,
  kind: Counter,
  uri: FileUri,
  range: Range,
  selectionRange: Range,
  detail: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Counter)),
  data: Schema.optional(Schema.Json),
});
const Location = Schema.Struct({uri: FileUri, range: Range});
const LocationLink = Schema.Struct({
  targetUri: FileUri,
  targetRange: Range,
  targetSelectionRange: Range,
  originSelectionRange: Schema.optional(Range),
});
const Diagnostic = Schema.Struct({
  range: Range,
  message: Schema.String,
  severity: Schema.optional(Counter),
  code: Schema.optional(Schema.Union([Schema.String, Counter])),
});
const Published = Schema.Struct({
  uri: FileUri,
  version: Counter,
  diagnostics: Schema.Array(Diagnostic).check(Schema.isMaxLength(100000)),
});
export function makePythonNotifications() {
  let listener = (_method: string, _params: unknown) => {};
  return {
    receive: (method: string, params: unknown) => listener(method, params),
    subscribe: (next: typeof listener) => {
      listener = next;
    },
  };
}
interface Document {
  observation: Observation;
  readonly text: string;
  wireVersion: number;
  ready: boolean;
  published?: DiagnosticSnapshot;
  delivered?: DiagnosticSnapshot;
  wake: Deferred.Deferred<void>;
  diagnosticRequest: number;
}
export interface PythonSessionOptions {
  readonly basis: Observation;
  readonly notifications: ReturnType<typeof makePythonNotifications>;
  readonly roots: readonly string[];
  readonly profile: Schema.Json;
  readonly environmentReady: Effect.Effect<void, unknown>;
  readonly startupMilliseconds: number;
}

/** One project/environment/view. Reads and preparation only; no command or apply-edit entry point exists. */
export const makePythonSession = Effect.fn('semantic.makePythonSession')(function* (
  client: LspClient,
  options: PythonSessionOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const basis = structuredClone(yield* decode(Observation, options.basis));
  const worktree = yield* path.fromFileUrl(new URL(basis.worktree));
  const allowedRoots = [worktree, ...options.roots];
  const initialized = yield* client.request(
    'initialize',
    {
      processId: null,
      rootUri: basis.project,
      workspaceFolders: [{uri: basis.project, name: 'semantic-python-project'}],
      capabilities: {
        general: {positionEncodings: ['utf-16']},
        workspace: {configuration: true, workspaceEdit: {documentChanges: true, resourceOperations: []}},
        textDocument: {
          publishDiagnostics: {versionSupport: true},
          rename: {prepareSupport: true},
          codeAction: {codeActionLiteralSupport: {codeActionKind: {valueSet: ['quickfix']}}},
        },
      },
    },
    options.startupMilliseconds,
  );
  const init = yield* decode(
    Schema.Struct({
      capabilities: Schema.Struct({
        positionEncoding: Schema.optional(Schema.String),
        definitionProvider: Schema.optional(Schema.Unknown),
        referencesProvider: Schema.optional(Schema.Unknown),
        hoverProvider: Schema.optional(Schema.Unknown),
        documentSymbolProvider: Schema.optional(Schema.Unknown),
        renameProvider: Schema.optional(Schema.Unknown),
        codeActionProvider: Schema.optional(Schema.Unknown),
        completionProvider: Schema.optional(Schema.Unknown),
        signatureHelpProvider: Schema.optional(Schema.Unknown),
        implementationProvider: Schema.optional(Schema.Unknown),
        typeDefinitionProvider: Schema.optional(Schema.Unknown),
        callHierarchyProvider: Schema.optional(Schema.Unknown),
        typeHierarchyProvider: Schema.optional(Schema.Unknown),
      }),
      serverInfo: Schema.optional(Schema.Struct({name: Schema.String, version: Schema.String})),
    }),
    initialized,
  );
  if (
    (init.capabilities.positionEncoding !== undefined && init.capabilities.positionEncoding !== 'utf-16') ||
    init.serverInfo?.version !== '1.40.2' ||
    !init.serverInfo.name.toLowerCase().includes('basedpyright')
  )
    return yield* SemanticSessionFault.make({reason: 'provider'});
  const capabilities = init.capabilities;
  const mutations = yield* Semaphore.make(1);
  const documents = new Map<string, Document>();
  let invalidated = false;
  let updating = false;
  let epoch = basis.projectEpoch;
  const current = (observation: Observation) => {
    const document = documents.get(observation.uri);
    return !invalidated &&
      !updating &&
      document?.ready &&
      observationKey(document.observation) === observationKey(observation)
      ? document
      : undefined;
  };
  options.notifications.subscribe((method, params) => {
    if (method !== 'textDocument/publishDiagnostics' || invalidated || !Schema.is(Published)(params)) return;
    const document = documents.get(params.uri);
    if (!document || params.version !== document.wireVersion) return;
    const items = new Map<string, SemanticDiagnostic>();
    for (const diagnostic of params.diagnostics) {
      if (
        !validRange(document.text, diagnostic.range) ||
        !wellFormed(diagnostic.message) ||
        (diagnostic.severity !== undefined && (diagnostic.severity < 1 || diagnostic.severity > 4))
      )
        return;
      const category = ['unknown', 'error', 'warning', 'information', 'hint'][diagnostic.severity ?? 0] ?? 'unknown';
      const code = diagnostic.code ?? '';
      const id = sha256HexSync(JSON.stringify([diagnostic.range, code, category, diagnostic.message]));
      items.set(id, {id, range: structuredClone(diagnostic.range), code, category, message: diagnostic.message});
    }
    document.published = {observation: structuredClone(document.observation), items: [...items.values()]};
    Deferred.doneUnsafe(document.wake, Effect.void);
  });
  yield* client.notify('initialized', {});
  const sameBasis = (a: Observation, b: Observation) =>
    observationKey({
      ...a,
      uri: b.uri,
      content: b.content,
      documentVersion: b.documentVersion,
      projectEpoch: b.projectEpoch,
    }) === observationKey(b);
  const upsert = (observation: Observation, text: string, language: string, milliseconds: number) =>
    mutations.withPermit(
      Effect.gen(function* () {
        let fixed = structuredClone(yield* decode(Observation, observation));
        if (
          language !== 'python' ||
          !wellFormed(text) ||
          text.length > 4 * 1024 * 1024 ||
          sha256HexSync(text) !== fixed.content ||
          !sameBasis(fixed, basis) ||
          invalidated ||
          (fixed.view.kind === 'disk' ? fixed.documentVersion !== null : fixed.documentVersion === null)
        )
          return yield* invalid();
        const previous = documents.get(fixed.uri);
        if (
          previous?.ready &&
          previous.text === text &&
          observationKey({...fixed, projectEpoch: previous.observation.projectEpoch}) ===
            observationKey(previous.observation)
        )
          return structuredClone(previous.observation);
        if (
          previous &&
          fixed.documentVersion !== null &&
          previous.observation.documentVersion !== null &&
          fixed.documentVersion <= previous.observation.documentVersion
        )
          return yield* SemanticSessionFault.make({reason: 'conflict'});
        if (!previous && documents.size >= 256) return yield* LspFault.make({code: 'capacity'});
        if (documents.size && ++epoch >= Number.MAX_SAFE_INTEGER)
          return yield* SemanticSessionFault.make({reason: 'not-ready'});
        fixed = {...fixed, projectEpoch: epoch};
        updating = true;
        const document: Document = {
          observation: fixed,
          text,
          wireVersion: previous?.wireVersion ?? 0,
          ready: false,
          wake: Deferred.makeUnsafe<void>(),
          diagnosticRequest: 0,
          ...(previous?.delivered ? {delivered: previous.delivered} : {}),
        };
        documents.set(fixed.uri, document);
        return yield* Effect.gen(function* () {
          // Publish the changed buffer before reannouncing dependent buffers with their new diagnostic versions.
          for (const [uri, entry] of [
            [fixed.uri, document] as const,
            ...[...documents].filter(([uri]) => uri !== fixed.uri),
          ]) {
            entry.observation = {...entry.observation, projectEpoch: epoch};
            entry.ready = false;
            entry.published = undefined;
            Deferred.doneUnsafe(entry.wake, Effect.void);
            entry.wake = Deferred.makeUnsafe<void>();
            if (++entry.wireVersion > 2147483647) return yield* SemanticSessionFault.make({reason: 'not-ready'});
            yield* client.notify(
              uri === fixed.uri && !previous ? 'textDocument/didOpen' : 'textDocument/didChange',
              uri === fixed.uri && !previous
                ? {textDocument: {uri, version: entry.wireVersion, languageId: 'python', text: entry.text}}
                : {textDocument: {uri, version: entry.wireVersion}, contentChanges: [{text: entry.text}]},
            );
          }
          // A harmless LSP query forms a bounded startup barrier; the metadata receipt must come from the actual server.
          yield* client.request('textDocument/documentSymbol', {textDocument: {uri: fixed.uri}}, milliseconds);
          yield* options.environmentReady;
          for (const entry of documents.values()) entry.ready = true;
          return structuredClone(fixed);
        }).pipe(
          Effect.onExit(exit =>
            Effect.sync(() => {
              updating = false;
              if (Exit.isFailure(exit)) invalidated = true;
            }),
          ),
        );
      }),
    );
  const evidence = (fixed: Observation): Evidence => ({
    basis: 'semantic',
    observation: structuredClone(fixed),
    scope: 'project:' + sha256HexSync(basis.project + basis.toolchain),
    completeness: 'partial',
    limitations: [
      'Experimental Python static-environment profile',
      'Selected project and verified static dependencies only',
      'Interpreter execution, import hooks, commands and dependency acquisition disabled',
    ],
  });
  const stale = (): QueryOutcome => ({
    version: 1,
    status: 'stale',
    reason: 'Source view or analysis basis changed',
    evidence: null,
  });
  const source = (uri: string, editsOnly = false) =>
    Effect.gen(function* () {
      if (!Schema.is(FileUri)(uri)) return yield* invalid();
      const file = yield* path.fromFileUrl(new URL(uri));
      const roots = editsOnly ? [worktree] : allowedRoots;
      if (
        file.split(path.sep).includes('.git') ||
        !roots.some(root => file.startsWith(root + path.sep)) ||
        (yield* fs.realPath(file)) !== file ||
        (yield* fs.stat(file)).type !== 'File'
      )
        return yield* SemanticSessionFault.make({reason: 'provider'});
      const document = documents.get(uri);
      const bytes = document ? undefined : yield* readBounded(file, 4 * 1024 * 1024);
      const text =
        document?.text ??
        (yield* Effect.try({
          try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
          catch: invalid,
        }));
      if (!wellFormed(text)) return yield* invalid();
      return {
        uri,
        text,
        content: sha256HexSync(bytes ?? text),
        documentVersion: document?.observation.documentVersion ?? null,
        wireVersion: document?.wireVersion ?? null,
        source: document && document.observation.view.kind !== 'disk' ? ('overlay' as const) : ('disk' as const),
      };
    });
  const checkedLocations = (response: unknown) =>
    Effect.gen(function* () {
      const decoded = yield* decode(
        Schema.NullOr(Schema.Union([Location, Schema.Array(Location), Schema.Array(LocationLink)])),
        response,
      );
      const items = decoded === null ? [] : Array.isArray(decoded) ? [...decoded] : [decoded];
      for (const item of items) {
        const target = yield* source('targetUri' in item ? item.targetUri : item.uri);
        if (
          'targetUri' in item
            ? !validRange(target.text, item.targetRange) || !validRange(target.text, item.targetSelectionRange)
            : !validRange(target.text, item.range)
        )
          return yield* SemanticSessionFault.make({reason: 'provider'});
      }
      return items;
    });
  const validateHierarchyItem = (item: typeof HierarchyItem.Type) =>
    Effect.gen(function* () {
      const target = yield* source(item.uri);
      if (
        !wellFormed(item.name) ||
        !validRange(target.text, item.range) ||
        !validRange(target.text, item.selectionRange) ||
        compare(item.range.start, item.selectionRange.start) > 0 ||
        compare(item.selectionRange.end, item.range.end) > 0
      )
        return yield* SemanticSessionFault.make({reason: 'provider'});
    });
  const hierarchy = (
    operation: 'call-hierarchy' | 'type-hierarchy',
    response: unknown,
    fixed: Observation,
    milliseconds: number,
  ) =>
    Effect.gen(function* () {
      const roots =
        (yield* decode(Schema.NullOr(Schema.Array(HierarchyItem).check(Schema.isMaxLength(8))), response)) ?? [];
      const result: Schema.Json[] = [];
      let bytes = 0;
      for (const root of roots) {
        yield* validateHierarchyItem(root);
        let value: Schema.Json;
        if (operation === 'call-hierarchy') {
          const incoming = yield* decode(
            Schema.NullOr(Schema.Array(Schema.Struct({from: HierarchyItem, fromRanges: Schema.Array(Range)}))),
            yield* client.request('callHierarchy/incomingCalls', {item: root}, milliseconds),
          );
          if (!current(fixed)) return undefined;
          const outgoing = yield* decode(
            Schema.NullOr(Schema.Array(Schema.Struct({to: HierarchyItem, fromRanges: Schema.Array(Range)}))),
            yield* client.request('callHierarchy/outgoingCalls', {item: root}, milliseconds),
          );
          if (!current(fixed)) return undefined;
          const rootSource = yield* source(root.uri);
          for (const call of incoming ?? []) {
            yield* validateHierarchyItem(call.from);
            const from = yield* source(call.from.uri);
            if (call.fromRanges.some(range => !validRange(from.text, range))) return yield* invalid();
          }
          for (const call of outgoing ?? []) {
            yield* validateHierarchyItem(call.to);
            if (call.fromRanges.some(range => !validRange(rootSource.text, range))) return yield* invalid();
          }
          value = {root, incoming: incoming ?? [], outgoing: outgoing ?? []};
        } else {
          const supertypes = yield* decode(
            Schema.NullOr(Schema.Array(HierarchyItem)),
            yield* client.request('typeHierarchy/supertypes', {item: root}, milliseconds),
          );
          if (!current(fixed)) return undefined;
          const subtypes = yield* decode(
            Schema.NullOr(Schema.Array(HierarchyItem)),
            yield* client.request('typeHierarchy/subtypes', {item: root}, milliseconds),
          );
          if (!current(fixed)) return undefined;
          for (const item of [...(supertypes ?? []), ...(subtypes ?? [])]) yield* validateHierarchyItem(item);
          value = {root, supertypes: supertypes ?? [], subtypes: subtypes ?? []};
        }
        bytes += new TextEncoder().encode(JSON.stringify(value)).length;
        if (bytes > 32 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
        result.push(value);
      }
      return result;
    });
  const query = (
    operation: SemanticQuery,
    observation: Observation,
    position: Position | undefined,
    milliseconds: number,
  ) =>
    Effect.gen(function* () {
      const fixed = structuredClone(yield* decode(Observation, observation));
      const document = current(fixed);
      if (!document) return stale();
      if (operation !== 'symbols' && (!position || !validTextPosition(document.text, position)))
        return yield* invalid();
      const capability = {
        definition: capabilities.definitionProvider,
        references: capabilities.referencesProvider,
        hover: capabilities.hoverProvider,
        symbols: capabilities.documentSymbolProvider,
        completion: capabilities.completionProvider,
        signature: capabilities.signatureHelpProvider,
        implementation: capabilities.implementationProvider,
        'type-definition': capabilities.typeDefinitionProvider,
        'call-hierarchy': capabilities.callHierarchyProvider,
        'type-hierarchy': capabilities.typeHierarchyProvider,
      }[operation];
      if (!capability)
        return {
          version: 1,
          status: 'unsupported',
          reason: 'Provider does not advertise this operation',
          evidence: evidence(fixed),
        } satisfies QueryOutcome;
      const method =
        {
          definition: 'definition',
          references: 'references',
          hover: 'hover',
          completion: 'completion',
          implementation: 'implementation',
          symbols: 'documentSymbol',
          signature: 'signatureHelp',
          'type-definition': 'typeDefinition',
          'call-hierarchy': 'prepareCallHierarchy',
          'type-hierarchy': 'prepareTypeHierarchy',
        }[operation] ?? operation;
      const response = yield* client.request(
        'textDocument/' + method,
        {
          textDocument: {uri: fixed.uri},
          ...(position ? {position} : {}),
          ...(operation === 'references' ? {context: {includeDeclaration: true}} : {}),
        },
        milliseconds,
      );
      if (!current(fixed)) return stale();
      let items: Schema.Json[];
      if (['definition', 'references', 'implementation', 'type-definition'].includes(operation))
        items = yield* checkedLocations(response);
      else if (operation === 'symbols')
        items = [...((yield* decode(Schema.NullOr(Schema.Array(Schema.Json)), response)) ?? [])];
      else if (operation === 'completion') {
        const completions = yield* decode(
          Schema.NullOr(
            Schema.Union([
              Schema.Array(CompletionItem),
              Schema.Struct({isIncomplete: Schema.Boolean, items: Schema.Array(CompletionItem)}),
            ]),
          ),
          response,
        );
        // Suggestions are read-only. Provider commands and unversioned insert/import edits are never exposed as preparation.
        let suggestions: readonly (typeof CompletionItem.Type)[] = [];
        let isIncomplete = false;
        if (completions !== null) {
          if ('items' in completions) {
            suggestions = completions.items;
            isIncomplete = completions.isIncomplete;
          } else suggestions = completions;
        }
        items = [{kind: 'completion-list', readOnly: true, isIncomplete, suggestions: [...suggestions]}];
      } else if (operation === 'call-hierarchy' || operation === 'type-hierarchy') {
        const graph = yield* hierarchy(operation, response, fixed, milliseconds);
        if (!graph) return stale();
        items = graph;
      } else if (operation === 'signature') {
        const signature = yield* decode(Schema.NullOr(Schema.Json), response);
        items = signature === null ? [] : [signature];
      } else {
        const hover = yield* decode(
          Schema.NullOr(Schema.Struct({contents: Schema.Json, range: Schema.optional(Range)})),
          response,
        );
        if (hover?.range && !validRange(document.text, hover.range))
          return yield* SemanticSessionFault.make({reason: 'provider'});
        items = hover ? [hover] : [];
      }
      return current(fixed)
        ? ({version: 1, status: 'ok', evidence: evidence(fixed), items} satisfies QueryOutcome)
        : stale();
    });
  const diagnostics = (observation: Observation, milliseconds: number) =>
    Effect.gen(function* () {
      const fixed = structuredClone(yield* decode(Observation, observation));
      const document = current(fixed);
      if (!document) return yield* SemanticSessionFault.make({reason: 'stale'});
      const sequence = ++document.diagnosticRequest;
      const received = yield* Effect.gen(function* () {
        while (!document.published) {
          yield* Deferred.await(document.wake);
          if (!current(fixed)) return yield* SemanticSessionFault.make({reason: 'stale'});
        }
        return document.published;
      }).pipe(Effect.timeoutOption(milliseconds));
      if (Option.isNone(received)) return yield* LspFault.make({code: 'timeout'});
      if (
        !current(fixed) ||
        document.diagnosticRequest !== sequence ||
        observationKey(received.value.observation) !== observationKey(fixed)
      )
        return yield* SemanticSessionFault.make({reason: 'stale'});
      const snapshot = received.value;
      const previous = document.delivered;
      const old = new Set(previous?.items.map(item => item.id));
      const present = new Set(snapshot.items.map(item => item.id));
      const delta: DiagnosticDelta = {
        ...snapshot,
        added: snapshot.items.filter(item => !old.has(item.id)),
        remaining: snapshot.items.filter(item => old.has(item.id)),
        resolved: previous
          ? previous.items
              .filter(item => !present.has(item.id))
              .map(item => ({item, observation: previous.observation, resolvedIn: fixed}))
          : [],
      };
      document.delivered = structuredClone(snapshot);
      return structuredClone(delta);
    });
  const prepareEdit = (raw: unknown) =>
    Effect.gen(function* () {
      const edit = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          changes: Schema.optional(Schema.Record(FileUri, Schema.Array(TextEdit))),
          documentChanges: Schema.optional(
            Schema.Array(
              Schema.Struct({
                textDocument: Schema.Struct({uri: FileUri, version: Schema.NullOr(Counter)}),
                edits: Schema.Array(TextEdit),
              }),
            ),
          ),
        }),
        {onExcessProperty: 'error'},
      )(raw).pipe(Effect.mapError(invalid));
      if (typeof raw !== 'object' || raw === null || (edit.changes !== undefined && edit.documentChanges !== undefined))
        return yield* invalid();
      const entries =
        edit.documentChanges?.map(change => ({
          uri: change.textDocument.uri,
          version: change.textDocument.version,
          edits: change.edits,
        })) ?? Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({uri, version: null, edits}));
      if (!entries.length || entries.length > 10000 || new Set(entries.map(entry => entry.uri)).size !== entries.length)
        return yield* invalid();
      const files: Schema.Json[] = [];
      let count = 0;
      for (const entry of entries) {
        const original = yield* source(entry.uri, true);
        if (!entry.edits.length || (entry.version !== null && entry.version !== original.wireVersion))
          return yield* invalid();
        const edits = [...entry.edits].sort(
          (a, b) => compare(a.range.start, b.range.start) || compare(a.range.end, b.range.end),
        );
        for (let i = 0; i < edits.length; i++) {
          const item = edits[i];
          if (
            ++count > 100000 ||
            !validRange(original.text, item.range) ||
            !wellFormed(item.newText) ||
            item.newText.length > 4 * 1024 * 1024 ||
            (i > 0 &&
              (compare(edits[i - 1].range.end, item.range.start) > 0 ||
                compare(edits[i - 1].range.start, item.range.start) === 0))
          )
            return yield* invalid();
        }
        files.push({
          uri: entry.uri,
          content: original.content,
          documentVersion: original.documentVersion,
          source: original.source,
          edits,
        });
      }
      // Re-read every closed file; retain all provider edits or fail the whole preparation.
      for (const entry of files) {
        const file = entry as {uri: string; content: string};
        if ((yield* source(file.uri, true)).content !== file.content)
          return yield* SemanticSessionFault.make({reason: 'stale'});
      }
      return files;
    });
  const prepare = (
    operation: 'rename' | 'code-action',
    observation: Observation,
    position: Position,
    newName: string | undefined,
    milliseconds: number,
  ) =>
    Effect.gen(function* () {
      const fixed = structuredClone(yield* decode(Observation, observation));
      const document = current(fixed);
      if (!document) return stale();
      if (!validTextPosition(document.text, position)) return yield* invalid();
      if (!(operation === 'rename' ? capabilities.renameProvider : capabilities.codeActionProvider))
        return {
          version: 1,
          status: 'unsupported',
          reason: 'Provider does not advertise edit preparation',
          evidence: evidence(fixed),
        } satisfies QueryOutcome;
      if (
        operation === 'rename' &&
        (!newName || newName.length > 512 || !wellFormed(newName) || /\p{Cc}/u.test(newName))
      )
        return yield* invalid();
      const response = yield* client.request(
        operation === 'rename' ? 'textDocument/rename' : 'textDocument/codeAction',
        operation === 'rename'
          ? {textDocument: {uri: fixed.uri}, position, newName: newName!}
          : {
              textDocument: {uri: fixed.uri},
              range: {start: position, end: position},
              context: {diagnostics: [], only: ['quickfix']},
            },
        milliseconds,
      );
      if (!current(fixed)) return stale();
      const items: Schema.Json[] = [];
      if (operation === 'rename') {
        if (response === null)
          return {
            version: 1,
            status: 'unsupported',
            reason: 'Provider cannot rename this occurrence',
            evidence: evidence(fixed),
          } satisfies QueryOutcome;
        if (
          typeof response === 'object' &&
          response !== null &&
          !Array.isArray(response) &&
          (Object.keys(response).length === 0 ||
            ('changes' in response &&
              response.changes !== null &&
              typeof response.changes === 'object' &&
              Object.keys(response.changes).length === 0) ||
            ('documentChanges' in response &&
              Array.isArray(response.documentChanges) &&
              response.documentChanges.length === 0))
        )
          return {
            version: 1,
            status: 'unsupported',
            reason: 'Provider returned no rename changes',
            evidence: evidence(fixed),
          } satisfies QueryOutcome;
        const files = yield* prepareEdit(response);
        items.push({kind: 'prepared-edit', operation, files, scope: 'all-provider-returned-edits', applied: false});
      } else {
        const actions = yield* decode(Schema.Array(Schema.Json), response);
        for (const raw of actions) {
          if (
            !raw ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            'command' in raw ||
            'disabled' in raw ||
            !('edit' in raw) ||
            typeof raw.title !== 'string' ||
            !wellFormed(raw.title)
          )
            continue;
          const files = yield* prepareEdit(raw.edit);
          items.push({
            kind: 'prepared-edit',
            operation,
            title: raw.title,
            files,
            scope: 'all-provider-returned-edits',
            applied: false,
          });
        }
      }
      return current(fixed)
        ? ({version: 1, status: 'ok', evidence: evidence(fixed), items} satisfies QueryOutcome)
        : stale();
    });
  return {
    upsert,
    query,
    diagnostics,
    prepare,
    available: Effect.sync(() => !invalidated),
    project: (_uri: string) => Effect.succeed({configuration: basis.project, profile: options.profile}),
    invalidate: Effect.sync(() => {
      invalidated = true;
      for (const document of documents.values()) Deferred.doneUnsafe(document.wake, Effect.void);
    }),
    close: client.close,
    observation: (uri: string) =>
      Effect.sync(() => {
        const document = documents.get(uri);
        return document && current(document.observation) ? structuredClone(document.observation) : undefined;
      }),
  };
});
