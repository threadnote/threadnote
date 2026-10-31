import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Deferred, Effect, Exit, FileSystem, Option, Path, Schema, Semaphore} from 'effect';
import {
  Counter,
  Evidence,
  FileUri,
  Identifier,
  Observation,
  Position,
  observationKey,
  type QueryOutcome,
} from '@threadnote/semantic/contracts';
import {LspFault, type LspClient} from './lsp_transport.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readBounded} from './fingerprint.js';
import {isJsonObject} from '@threadnote/platform/json';
export const SemanticLanguage = Schema.Literals([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'python',
  'go',
  'rust',
]);
export type SemanticLanguage = typeof SemanticLanguage.Type;
export interface SdkHostCandidate {
  readonly executable: string;
  readonly executableDigest: string;
  readonly sdkDirectory: string;
  readonly sdkTreeDigest: string;
}
export class SemanticSetupFault extends Schema.TaggedError<SemanticSetupFault, {readonly brand: unique symbol}>()(
  'SemanticSetupFault',
  {
    providerId: Schema.Literals(['gopls', 'rust-analyzer']),
    reason: Schema.Literals(['missing', 'incompatible', 'unavailable']),
    component: Schema.Literals(['provider', 'sdk']),
    requiredVersion: Schema.String,
    requiredSdkVersion: Schema.String,
    nextAction: Schema.String,
  },
) {}
export const SemanticQuery = Schema.Literals([
  'definition',
  'references',
  'hover',
  'symbols',
  'completion',
  'signature',
  'implementation',
  'type-definition',
  'call-hierarchy',
  'type-hierarchy',
]);
export type SemanticQuery = typeof SemanticQuery.Type;
export const isCoreSemanticQuery = (
  operation: SemanticQuery,
): operation is 'definition' | 'references' | 'hover' | 'symbols' =>
  ['definition', 'references', 'hover', 'symbols'].includes(operation);
export interface SemanticSession {
  readonly upsert: (
    observation: Observation,
    text: string,
    language: SemanticLanguage,
    milliseconds: number,
  ) => Effect.Effect<Observation, unknown>;
  readonly query: (
    operation: SemanticQuery,
    observation: Observation,
    position: Position | undefined,
    milliseconds: number,
  ) => Effect.Effect<QueryOutcome, unknown>;
  readonly diagnostics: (observation: Observation, milliseconds: number) => Effect.Effect<DiagnosticDelta, unknown>;
  readonly prepare?: (
    operation: 'rename' | 'code-action',
    observation: Observation,
    position: Position,
    newName: string | undefined,
    milliseconds: number,
  ) => Effect.Effect<QueryOutcome, unknown>;
  readonly project: (uri: string) => Effect.Effect<
    | {
        readonly configuration: string;
        readonly fileCount?: number;
        readonly profile?: Schema.Json;
      }
    | undefined,
    unknown
  >;
  readonly available: Effect.Effect<boolean>;
  readonly invalidate: Effect.Effect<void>;
  readonly close: LspClient['close'];
}
export class SemanticSessionFault extends Schema.TaggedError<SemanticSessionFault, {readonly brand: unique symbol}>()(
  'SemanticSessionFault',
  {
    reason: Schema.Literals(['invalid', 'conflict', 'stale', 'not-ready', 'provider']),
  },
) {}
export const SemanticRange = Schema.Struct({start: Position, end: Position});
export interface SemanticDiagnostic {
  readonly id: string;
  readonly range: typeof SemanticRange.Type;
  readonly message: string;
  readonly category: string;
  readonly code: string | number;
}
export interface DiagnosticSnapshot {
  readonly observation: Observation;
  readonly items: readonly SemanticDiagnostic[];
}
export interface DiagnosticDelta extends DiagnosticSnapshot {
  readonly added: readonly SemanticDiagnostic[];
  readonly remaining: readonly SemanticDiagnostic[];
  readonly resolved: readonly {
    readonly item: SemanticDiagnostic;
    readonly observation: Observation;
    readonly resolvedIn: Observation;
  }[];
}
/** UTF-16 LSP positions must be within a line and cannot split a surrogate pair. */
export function validTextPosition(text: string, position: Position): boolean {
  if (!Schema.is(Position)(position)) return false;
  const lines = EffectString.split(/\r\n|\r|\n/u)(text);
  const line = lines[position.line];
  if (line === undefined || position.character > line.length) return false;
  const before = EffectOption.getOrElse(EffectString.charCodeAt(position.character - 1)(line), () => NaN);
  const after = EffectOption.getOrElse(EffectString.charCodeAt(position.character)(line), () => NaN);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
export function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = EffectOption.getOrElse(EffectString.charCodeAt(i)(text), () => NaN);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = EffectOption.getOrElse(EffectString.charCodeAt(++i)(text), () => NaN);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const Range = SemanticRange;
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
const FullDiagnosticReport = Schema.Struct({
  kind: Schema.Literal('full'),
  items: Schema.Array(Diagnostic).check(Schema.isMaxLength(100000)),
  resultId: Schema.optional(Schema.String),
});
const DiagnosticProvider = Schema.Struct({
  identifier: Schema.optional(Identifier),
  interFileDependencies: Schema.Boolean,
  workspaceDiagnostics: Schema.Boolean,
});
export function makeSemanticNotifications() {
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
  nativeDiagnostics?: readonly Schema.Json[];
  delivered?: DiagnosticSnapshot;
  wake: Deferred.Deferred<void>;
  diagnosticRequest: number;
}
/** Backend-owned policy; never decoded from repository requests. */
export interface LspSessionPolicy {
  readonly language: 'python' | 'go' | 'rust';
  readonly workspaceName: string;
  readonly acceptsServer: (
    server:
      | {
          readonly name: string;
          readonly version: string;
        }
      | undefined,
  ) => boolean;
  readonly limitations: readonly string[];
  readonly initializationOptions?: Schema.Json;
  readonly experimentalCapabilities?: Schema.Json;
  readonly receive?: (method: string, params: unknown) => void;
  readonly resolveCodeActions?: boolean;
  /** A qualified backend's explicit unknown-version sentinel, only for documents this session never opened. */
  readonly unopenedDocumentVersion?: 0;
  readonly pullDiagnostics?: boolean;
  readonly codeActionKinds?: readonly string[];
}
export interface LspSessionOptions {
  readonly basis: Observation;
  readonly notifications: ReturnType<typeof makeSemanticNotifications>;
  readonly roots: readonly string[];
  readonly profile: Schema.Json;
  readonly ready: Effect.Effect<void, unknown>;
  readonly policy: LspSessionPolicy;
  readonly startupMilliseconds: number;
}
/** One project/environment/view. Reads and preparation only; no command or apply-edit entry point exists. */
export const makeLspSession = Effect.fn('semantic.makeLspSession')(function* (
  client: LspClient,
  options: LspSessionOptions,
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
      workspaceFolders: [{uri: basis.project, name: options.policy.workspaceName}],
      capabilities: {
        general: {positionEncodings: ['utf-16']},
        ...(options.policy.experimentalCapabilities === undefined
          ? {}
          : {experimental: options.policy.experimentalCapabilities}),
        workspace: {configuration: true, workspaceEdit: {documentChanges: true, resourceOperations: []}},
        textDocument: {
          publishDiagnostics: {versionSupport: true},
          ...(options.policy.pullDiagnostics
            ? {diagnostic: {dynamicRegistration: false, relatedDocumentSupport: false}}
            : {}),
          rename: {prepareSupport: true},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {valueSet: [...(options.policy.codeActionKinds ?? ['quickfix'])]},
            },
            ...(options.policy.resolveCodeActions ? {dataSupport: true, resolveSupport: {properties: ['edit']}} : {}),
          },
        },
      },
      ...(options.policy.initializationOptions === undefined
        ? {}
        : {initializationOptions: options.policy.initializationOptions}),
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
        diagnosticProvider: Schema.optional(Schema.Unknown),
      }),
      serverInfo: Schema.optional(Schema.Struct({name: Schema.String, version: Schema.String})),
    }),
    initialized,
  );
  if (
    (init.capabilities.positionEncoding !== undefined && init.capabilities.positionEncoding !== 'utf-16') ||
    !options.policy.acceptsServer(init.serverInfo)
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
  const ingestDiagnostics = (params: typeof Published.Type) => {
    if (invalidated) return false;
    const document = documents.get(params.uri);
    if (!document || params.version !== document.wireVersion) return false;
    const items = new Map<string, SemanticDiagnostic>();
    for (const diagnostic of params.diagnostics) {
      if (
        !validRange(document.text, diagnostic.range) ||
        !wellFormed(diagnostic.message) ||
        (diagnostic.severity !== undefined && (diagnostic.severity < 1 || diagnostic.severity > 4))
      )
        return false;
      const category = ['unknown', 'error', 'warning', 'information', 'hint'][diagnostic.severity ?? 0] ?? 'unknown';
      const code = diagnostic.code ?? '';
      const id = sha256HexSync(JSON.stringify([diagnostic.range, code, category, diagnostic.message]));
      items.set(id, {id, range: structuredClone(diagnostic.range), code, category, message: diagnostic.message});
    }
    document.published = {observation: structuredClone(document.observation), items: [...items.values()]};
    if (options.policy.resolveCodeActions && Schema.is(Schema.Array(Schema.Json))(params.diagnostics))
      document.nativeDiagnostics = structuredClone(params.diagnostics);
    Deferred.doneUnsafe(document.wake, Effect.void);
    return true;
  };
  options.notifications.subscribe((method, params) => {
    options.policy.receive?.(method, params);
    if (!options.policy.pullDiagnostics && method === 'textDocument/publishDiagnostics' && Schema.is(Published)(params))
      ingestDiagnostics(params);
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
          language !== options.policy.language ||
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
            ...EffectArray.filter([...documents], ([uri]) => uri !== fixed.uri),
          ]) {
            entry.observation = {...entry.observation, projectEpoch: epoch};
            entry.ready = false;
            entry.published = undefined;
            entry.nativeDiagnostics = undefined;
            Deferred.doneUnsafe(entry.wake, Effect.void);
            entry.wake = Deferred.makeUnsafe<void>();
            if (++entry.wireVersion > 2147483647) return yield* SemanticSessionFault.make({reason: 'not-ready'});
            yield* client.notify(
              uri === fixed.uri && !previous ? 'textDocument/didOpen' : 'textDocument/didChange',
              uri === fixed.uri && !previous
                ? {
                    textDocument: {
                      uri,
                      version: entry.wireVersion,
                      languageId: options.policy.language,
                      text: entry.text,
                    },
                  }
                : {textDocument: {uri, version: entry.wireVersion}, contentChanges: [{text: entry.text}]},
            );
          }
          // A harmless LSP query forms a bounded startup barrier; the metadata receipt must come from the actual server.
          yield* client.request('textDocument/documentSymbol', {textDocument: {uri: fixed.uri}}, milliseconds);
          yield* options.ready;
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
    limitations: [...options.policy.limitations],
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
        EffectString.split(path.sep)(file).includes('.git') ||
        !EffectArray.some(roots, root => EffectString.startsWith(root + path.sep)(file)) ||
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
      const items = decoded === null ? [] : Schema.is(Location)(decoded) ? [decoded] : [...decoded];
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
            if (EffectArray.some(call.fromRanges, range => !validRange(from.text, range))) return yield* invalid();
          }
          for (const call of outgoing ?? []) {
            yield* validateHierarchyItem(call.to);
            if (EffectArray.some(call.fromRanges, range => !validRange(rootSource.text, range)))
              return yield* invalid();
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
      if (options.policy.pullDiagnostics) {
        const descriptor = capabilities.diagnosticProvider;
        if (!Schema.is(DiagnosticProvider)(descriptor)) return yield* SemanticSessionFault.make({reason: 'provider'});
        const wireVersion = document.wireVersion;
        const report = yield* client.request(
          'textDocument/diagnostic',
          {
            textDocument: {uri: fixed.uri},
            ...(descriptor.identifier === undefined ? {} : {identifier: descriptor.identifier}),
          },
          milliseconds,
        );
        if (!current(fixed) || document.diagnosticRequest !== sequence)
          return yield* SemanticSessionFault.make({reason: 'stale'});
        if (
          !Schema.is(FullDiagnosticReport)(report) ||
          ('relatedDocuments' in report &&
            (!isJsonObject(report.relatedDocuments) ||
              EffectRecord.keys<string, Schema.Json>(report.relatedDocuments).length > 0))
        )
          return yield* SemanticSessionFault.make({reason: 'provider'});
        // Pull reports are bound to this still-current request; unsolicited unversioned pushes are never accepted.
        if (!ingestDiagnostics({uri: fixed.uri, version: wireVersion, diagnostics: report.items}))
          return yield* SemanticSessionFault.make({reason: 'provider'});
      }
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
      const old = new Set(
        (effectOptionalValue =>
          effectOptionalValue == null ? undefined : EffectArray.map(effectOptionalValue, item => item.id))(
          previous?.items,
        ),
      );
      const present = new Set(EffectArray.map(snapshot.items, item => item.id));
      const delta: DiagnosticDelta = {
        ...snapshot,
        added: EffectArray.filter(snapshot.items, item => !old.has(item.id)),
        remaining: EffectArray.filter(snapshot.items, item => old.has(item.id)),
        resolved: previous
          ? EffectArray.map(
              EffectArray.filter(previous.items, item => !present.has(item.id)),
              item => ({item, observation: previous.observation, resolvedIn: fixed}),
            )
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
        (effectOptionalValue =>
          effectOptionalValue == null
            ? undefined
            : EffectArray.map(effectOptionalValue, change => ({
                uri: change.textDocument.uri,
                version: change.textDocument.version,
                edits: change.edits,
              })))(edit.documentChanges) ??
        EffectArray.map(EffectRecord.toEntries(edit.changes ?? {}), ([uri, edits]) => ({uri, version: null, edits}));
      if (
        !entries.length ||
        entries.length > 10000 ||
        new Set(EffectArray.map(entries, entry => entry.uri)).size !== entries.length
      )
        return yield* invalid();
      const files: {
        uri: string;
        content: string;
        documentVersion: number | null;
        source: 'disk' | 'overlay';
        edits: (typeof TextEdit.Type)[];
      }[] = [];
      let count = 0;
      for (const entry of entries) {
        const original = yield* source(entry.uri, true);
        const unknownClosedVersion =
          original.wireVersion === null && entry.version === options.policy.unopenedDocumentVersion;
        if (
          !entry.edits.length ||
          (entry.version !== null && entry.version !== original.wireVersion && !unknownClosedVersion)
        )
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
        if ((yield* source(entry.uri, true)).content !== entry.content)
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
              context: {
                diagnostics: document.nativeDiagnostics ?? [],
                only: [...(options.policy.codeActionKinds ?? ['quickfix'])],
              },
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
          isJsonObject(response) &&
          (EffectRecord.keys<string, Schema.Json>(response).length === 0 ||
            ('changes' in response &&
              isJsonObject(response.changes) &&
              EffectRecord.keys<string, Schema.Json>(response.changes).length === 0) ||
            ('documentChanges' in response &&
              EffectArray.isArray(response.documentChanges) &&
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
        const actions =
          (yield* decode(Schema.NullOr(Schema.Array(Schema.Json).check(Schema.isMaxLength(128))), response)) ?? [];
        const canResolve =
          options.policy.resolveCodeActions &&
          typeof capabilities.codeActionProvider === 'object' &&
          capabilities.codeActionProvider !== null &&
          'resolveProvider' in capabilities.codeActionProvider &&
          capabilities.codeActionProvider.resolveProvider === true;
        for (let raw of actions) {
          if (
            canResolve &&
            raw &&
            typeof raw === 'object' &&
            !EffectArray.isArray(raw) &&
            !('command' in raw) &&
            !('disabled' in raw) &&
            !('edit' in raw) &&
            'data' in raw
          ) {
            raw = yield* client.request('codeAction/resolve', raw, milliseconds);
            if (!current(fixed)) return stale();
          }
          if (
            !raw ||
            typeof raw !== 'object' ||
            EffectArray.isArray(raw) ||
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
