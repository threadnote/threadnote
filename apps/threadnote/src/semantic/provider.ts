import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Clock, Deferred, Effect, Exit, FileSystem, Option, Path, Schema, Semaphore} from 'effect';
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
  'java',
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
    providerId: Schema.Literals(['gopls', 'rust-analyzer', 'jdtls']),
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
  /** Host-only action query/selection; public callers never supply adapter selectors or provider data. */
  readonly actions?: (
    observation: Observation,
    query: SemanticActionQuery,
    milliseconds: number,
    selection?: SemanticActionSelection,
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
  /** Provider-aware current observation; Java includes its own full publication fences. */
  readonly observation: (uri: string) => Effect.Effect<Observation | undefined, unknown>;
  readonly available: Effect.Effect<boolean>;
  readonly invalidate: Effect.Effect<void>;
  readonly close: LspClient['close'];
}
export interface SemanticActionQuery {
  readonly range: typeof SemanticRange.Type;
  readonly only?: readonly string[];
  readonly diagnosticIds?: readonly string[];
}
export interface SemanticActionSelection {
  readonly selector: string;
  readonly queryDigest: string;
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
  /** Additive internal metadata; public reads require this observation-bound coverage proof. */
  readonly evidence?: Evidence;
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
export const validRange = (text: string, range: typeof Range.Type) =>
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
  nativeDiagnosticSnapshot?: {readonly byId: ReadonlyMap<string, Schema.Json | null>};
  delivered?: DiagnosticSnapshot;
  wake: Deferred.Deferred<void>;
  diagnosticRequest: number;
}
export interface LspDiagnosticRequest {
  readonly requestToken: string;
  readonly target: {readonly uri: string; readonly text: string};
  readonly inputs: readonly {readonly uri: string; readonly text: string}[];
}
/** Backend-owned policy; never decoded from repository requests. */
export interface LspSessionPolicy {
  readonly language: 'python' | 'go' | 'rust' | 'java';
  /** Host-selected UTF-16 view limits, enforced before document state or notifications change. */
  readonly documentLimits?: {
    readonly maxDocuments: number;
    readonly maxTextLength: number;
    readonly maxTotalTextLength: number;
  };
  /** Finite host policy backed by the pinned adapter's source snapshot contract. */
  readonly editSourceQualification?:
    'versioned-text-document-v1' | 'versioned-diagnostics-foreground-v1' | 'immutable-provider-input-v1';
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
  readonly initializationRoot?: string;
  readonly requiredCommands?: readonly string[];
  readonly requestDiagnostics?: (
    request: LspDiagnosticRequest,
    milliseconds: number,
  ) => Effect.Effect<readonly Schema.Json[], unknown>;
  readonly requestTypeDefinition?: (
    request: LspDiagnosticRequest,
    position: Position,
    milliseconds: number,
  ) => Effect.Effect<Schema.Json, unknown>;
  readonly resolveCodeActions?: boolean;
  /** A qualified backend's explicit unknown-version sentinel, only for documents this session never opened. */
  readonly unopenedDocumentVersion?: 0;
  /** Backend-owned immutable provider-input byte witness; only closed edit targets use it. */
  readonly verifyClosedEditSource?: (uri: string, content: string) => Effect.Effect<void, unknown>;
  readonly pullDiagnostics?: boolean;
  readonly codeActionKinds?: readonly string[];
}
export interface LspEditSource {
  readonly uri: string;
  readonly text: string;
  readonly content: string;
  readonly identity: string;
}
export interface LspSessionOptions {
  /** Canonical, authorized host disk capture; never supplied by the caller. */
  readonly captureEditSource?: (uri: string) => Effect.Effect<LspEditSource, unknown>;
  readonly basis: Observation;
  readonly notifications: ReturnType<typeof makeSemanticNotifications>;
  readonly roots: readonly string[];
  readonly profile: Schema.Json;
  readonly ready: Effect.Effect<void, unknown>;
  readonly policy: LspSessionPolicy;
  readonly startupMilliseconds: number;
}
/** A backend may reject an unqualified source target before the shared session consumes its response. */
export type LspSessionClient = Omit<LspClient, 'request'> & {
  readonly request: (...args: Parameters<LspClient['request']>) => Effect.Effect<Schema.Json, unknown>;
};
const DocumentLimits = Schema.Struct({
  maxDocuments: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 256})),
  maxTextLength: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 4 * 1024 * 1024})),
  maxTotalTextLength: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 256 * 4 * 1024 * 1024})),
});
/** One project/environment/view. Reads and preparation only; no command or apply-edit entry point exists. */
export const makeLspSession = Effect.fn('semantic.makeLspSession')(function* (
  client: LspSessionClient,
  options: LspSessionOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const basis = structuredClone(yield* decode(Observation, options.basis));
  const {maxDocuments, maxTextLength, maxTotalTextLength} = yield* decode(
    DocumentLimits,
    options.policy.documentLimits === undefined
      ? {maxDocuments: 256, maxTextLength: 4 * 1024 * 1024, maxTotalTextLength: 256 * 4 * 1024 * 1024}
      : options.policy.documentLimits,
  );
  const worktree = yield* path.fromFileUrl(new URL(basis.worktree));
  const allowedRoots = [worktree, ...options.roots];
  options.notifications.subscribe((method, params) => options.policy.receive?.(method, params));
  const initializationRoot = options.policy.initializationRoot ?? basis.project;
  const initialized = yield* client.request(
    'initialize',
    {
      processId: null,
      rootUri: initializationRoot,
      workspaceFolders: [{uri: initializationRoot, name: options.policy.workspaceName}],
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
        executeCommandProvider: Schema.optional(Schema.Unknown),
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
  if (options.policy.requiredCommands) {
    const descriptor = capabilities.executeCommandProvider;
    const commandProvider = Schema.Struct({commands: Schema.Array(Schema.String).check(Schema.isMaxLength(1024))});
    if (
      !Schema.is(commandProvider)(descriptor) ||
      EffectArray.some(options.policy.requiredCommands, command => !descriptor.commands.includes(command))
    )
      return yield* SemanticSessionFault.make({reason: 'provider'});
  }
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
    const nativeIds: string[] = [];
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
      nativeIds.push(id);
    }
    document.published = {observation: structuredClone(document.observation), items: [...items.values()]};
    document.nativeDiagnosticSnapshot = undefined;
    if (Schema.is(Schema.Array(Schema.Json))(params.diagnostics)) {
      const native = structuredClone(params.diagnostics);
      const byId = new Map<string, Schema.Json | null>();
      for (const [index, diagnostic] of native.entries()) {
        const id = nativeIds[index];
        // Identical semantic fields cannot select between duplicate native source/data witnesses.
        byId.set(id, byId.has(id) ? null : diagnostic);
      }
      if (options.policy.resolveCodeActions || options.policy.requestDiagnostics) document.nativeDiagnostics = native;
      document.nativeDiagnosticSnapshot = {byId};
    }
    Deferred.doneUnsafe(document.wake, Effect.void);
    return true;
  };
  options.notifications.subscribe((method, params) => {
    options.policy.receive?.(method, params);
    if (
      !options.policy.pullDiagnostics &&
      !options.policy.requestDiagnostics &&
      method === 'textDocument/publishDiagnostics' &&
      Schema.is(Published)(params)
    )
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
  const upsertUnlocked = (
    observation: Observation,
    text: string,
    language: string,
    milliseconds: number,
    internalDisk = false,
  ) =>
    Effect.gen(function* () {
      let fixed = structuredClone(yield* decode(Observation, observation));
      if (
        language !== options.policy.language ||
        !wellFormed(text) ||
        text.length > 4 * 1024 * 1024 ||
        sha256HexSync(text) !== fixed.content ||
        !sameBasis(fixed, basis) ||
        invalidated ||
        (fixed.view.kind === 'disk' ? fixed.documentVersion !== null : fixed.documentVersion === null && !internalDisk)
      )
        return yield* invalid();
      const previous = documents.get(fixed.uri);
      const totalTextLength = EffectArray.reduce(
        [...documents],
        text.length,
        (total, [uri, document]) => total + (uri === fixed.uri ? 0 : document.text.length),
      );
      if (
        text.length > maxTextLength ||
        documents.size + (previous ? 0 : 1) > maxDocuments ||
        totalTextLength > maxTotalTextLength
      )
        return yield* LspFault.make({code: 'capacity'});
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
          entry.nativeDiagnosticSnapshot = undefined;
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
    });
  const upsert = (observation: Observation, text: string, language: string, milliseconds: number) =>
    mutations.withPermit(upsertUnlocked(observation, text, language, milliseconds));
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
  let snapshotSequence = 0;
  const captureSnapshot = (fixed: Observation, document: Document) =>
    Effect.gen(function* () {
      if (++snapshotSequence >= Number.MAX_SAFE_INTEGER) return yield* LspFault.make({code: 'capacity'});
      return Object.freeze({
        requestToken: sha256HexSync(JSON.stringify([observationKey(fixed), snapshotSequence])),
        target: Object.freeze({uri: fixed.uri, text: document.text}),
        inputs: Object.freeze(
          EffectArray.map([...documents], ([uri, entry]) => Object.freeze({uri, text: entry.text})),
        ),
      }) satisfies LspDiagnosticRequest;
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
      const response = yield* operation === 'type-definition' && options.policy.requestTypeDefinition
        ? options.policy.requestTypeDefinition(
            yield* captureSnapshot(fixed, document),
            Object.freeze({line: position!.line, character: position!.character}),
            milliseconds,
          )
        : client.request(
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
  const diagnostics = (observation: Observation, milliseconds: number, commit = true) =>
    Effect.gen(function* () {
      const fixed = structuredClone(yield* decode(Observation, observation));
      const document = current(fixed);
      if (!document) return yield* SemanticSessionFault.make({reason: 'stale'});
      const sequence = ++document.diagnosticRequest;
      if (options.policy.requestDiagnostics) {
        const wireVersion = document.wireVersion;
        const request = yield* captureSnapshot(fixed, document);
        const items = yield* options.policy.requestDiagnostics(request, milliseconds);
        if (!current(fixed) || document.diagnosticRequest !== sequence)
          return yield* SemanticSessionFault.make({reason: 'stale'});
        const publication = {uri: fixed.uri, version: wireVersion, diagnostics: items};
        if (!Schema.is(Published)(publication) || !ingestDiagnostics(publication))
          return yield* SemanticSessionFault.make({reason: 'provider'});
      } else if (options.policy.pullDiagnostics) {
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
        evidence: evidence(fixed),
        added: EffectArray.filter(snapshot.items, item => !old.has(item.id)),
        remaining: EffectArray.filter(snapshot.items, item => old.has(item.id)),
        resolved: previous
          ? EffectArray.map(
              EffectArray.filter(previous.items, item => !present.has(item.id)),
              item => ({item, observation: previous.observation, resolvedIn: fixed}),
            )
          : [],
      };
      if (commit) document.delivered = structuredClone(snapshot);
      return structuredClone(delta);
    });
  const editEntries = (raw: unknown) =>
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
      return entries;
    });
  const prepareEdit = (raw: unknown) =>
    Effect.gen(function* () {
      const entries = yield* editEntries(raw);
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
        if (original.wireVersion === null && options.policy.verifyClosedEditSource)
          yield* options.policy.verifyClosedEditSource(entry.uri, original.content);
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
  const prepareLegacy = (
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
  const actionRequest = (
    observation: Observation,
    query: SemanticActionQuery,
    selection: SemanticActionSelection | undefined,
    remaining: Effect.Effect<number, LspFault>,
  ) =>
    Effect.gen(function* () {
      const document = documents.get(observation.uri);
      if (!document || !current(document.observation)) return yield* SemanticSessionFault.make({reason: 'stale'});
      const fixed = structuredClone(document.observation);
      const refreshed = yield* diagnostics(fixed, yield* remaining, false);
      const diagnosticSequence = document.diagnosticRequest;
      const subset = query.diagnosticIds;
      if (
        subset &&
        (new Set(subset).size !== subset.length ||
          EffectArray.some(subset, id => !EffectArray.some(refreshed.items, item => item.id === id)))
      )
        return yield* SemanticSessionFault.make({reason: 'stale'});
      const nativeSnapshot = document.nativeDiagnosticSnapshot;
      // Fingerprinting is action-only; ordinary diagnostic reads do not sort/hash private metadata.
      const nativeDigest = () => {
        const snapshot = document.nativeDiagnosticSnapshot;
        return snapshot
          ? sha256HexSync(JSON.stringify([...snapshot.byId].sort(([a], [b]) => EffectString.localeCompare(b)(a))))
          : null;
      };
      const nativeFingerprint = nativeDigest();
      const native: Schema.Json[] = [];
      for (const item of refreshed.items) {
        if (subset && !subset.includes(item.id)) continue;
        const diagnostic = nativeSnapshot?.byId.get(item.id);
        if (diagnostic === undefined || diagnostic === null)
          return yield* SemanticSessionFault.make({reason: 'provider'});
        // Echo only our current provider publication, never caller metadata or a reduced public DTO.
        native.push(structuredClone(diagnostic));
      }
      const queryDigest = sha256HexSync(
        JSON.stringify([
          'lsp-quickfix-query-v2',
          observationKey({...fixed, projectEpoch: 0}),
          options.profile,
          query.range,
          query.only ? [...query.only].sort() : null,
          EffectArray.map(refreshed.items, item => item.id).sort(),
          subset ? [...subset].sort() : null,
          nativeFingerprint,
        ]),
      );
      const response = yield* client.request(
        'textDocument/codeAction',
        {
          textDocument: {uri: fixed.uri},
          range: query.range,
          context: {diagnostics: native, ...(query.only ? {only: [...query.only]} : {})},
        },
        yield* remaining,
      );
      const rawActions =
        (yield* decode(Schema.NullOr(Schema.Array(Schema.Json).check(Schema.isMaxLength(128))), response)) ?? [];
      const canResolve =
        options.policy.resolveCodeActions &&
        isJsonObject(capabilities.codeActionProvider) &&
        capabilities.codeActionProvider.resolveProvider === true;
      const sources = new Map<
        string,
        {text: string; content: string; identity: string | null; documentVersion: number | null}
      >();
      let retainedBytes = 0;
      const choices = [];
      for (let raw of rawActions) {
        if (!isJsonObject(raw) || typeof raw.title !== 'string' || !wellFormed(raw.title) || raw.title.length > 8192)
          return yield* invalid();
        if (
          canResolve &&
          raw.kind === 'quickfix' &&
          !('command' in raw) &&
          !('disabled' in raw) &&
          !('edit' in raw) &&
          'data' in raw &&
          (!query.only || query.only.includes('quickfix'))
        ) {
          raw = yield* client.request('codeAction/resolve', raw, yield* remaining);
          if (!isJsonObject(raw) || typeof raw.title !== 'string' || !wellFormed(raw.title) || raw.title.length > 8192)
            return yield* invalid();
        }
        const kind = typeof raw.kind === 'string' ? raw.kind : '';
        if (!wellFormed(kind) || kind.length > 512) return yield* invalid();
        const command = 'command' in raw;
        const disabled =
          'disabled' in raw
            ? isJsonObject(raw.disabled) &&
              typeof raw.disabled.reason === 'string' &&
              wellFormed(raw.disabled.reason) &&
              raw.disabled.reason.length <= 8192 &&
              raw.disabled.reason
              ? raw.disabled.reason
              : 'Provider disabled this action'
            : null;
        const family = kind === 'quickfix' && (!query.only || query.only.includes(kind));
        const parsed =
          !command && disabled === null && family && 'edit' in raw
            ? yield* editEntries(raw.edit).pipe(Effect.option)
            : Option.none();
        let entries = Option.getOrUndefined(parsed);
        const witness: Schema.Json[] = [];
        if (entries) {
          entries = EffectArray.map(
            [...entries].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri)),
            entry => ({
              ...entry,
              edits: [...entry.edits].sort(
                (a, b) => compare(a.range.start, b.range.start) || compare(a.range.end, b.range.end),
              ),
            }),
          );
          let count = 0;
          for (const entry of entries) {
            let captured = sources.get(entry.uri);
            if (!captured) {
              if (sources.size >= maxDocuments) return yield* LspFault.make({code: 'capacity'});
              const retained = documents.get(entry.uri);
              if (retained && retained.observation.documentVersion !== null) {
                if (!current(retained.observation)) return yield* SemanticSessionFault.make({reason: 'stale'});
                captured = {
                  text: retained.text,
                  content: retained.observation.content,
                  identity: null,
                  documentVersion: retained.observation.documentVersion,
                };
              } else {
                const disk = yield* options.captureEditSource!(entry.uri);
                if (disk.uri !== entry.uri || !wellFormed(disk.text) || sha256HexSync(disk.text) !== disk.content)
                  return yield* SemanticSessionFault.make({reason: 'stale'});
                if (options.policy.editSourceQualification === 'immutable-provider-input-v1') {
                  if (!options.policy.verifyClosedEditSource) return yield* invalid();
                  yield* options.policy.verifyClosedEditSource(entry.uri, disk.content);
                }
                captured = {...disk, documentVersion: null};
              }
              retainedBytes += new TextEncoder().encode(captured.text).length;
              if (retainedBytes > Math.min(8 * 1024 * 1024, maxTotalTextLength * 3))
                return yield* LspFault.make({code: 'capacity'});
              sources.set(entry.uri, captured);
            }
            if (
              !entry.edits.length ||
              EffectArray.some(
                entry.edits,
                (edit, index) =>
                  ++count > 100000 ||
                  !validRange(captured.text, edit.range) ||
                  !wellFormed(edit.newText) ||
                  edit.newText.length > maxTextLength ||
                  (index > 0 &&
                    (compare(entry.edits[index - 1].range.end, edit.range.start) > 0 ||
                      compare(entry.edits[index - 1].range.start, edit.range.start) === 0)),
              )
            ) {
              entries = undefined;
              break;
            }
            // Provider wire versions can advance only through our later source synchronization;
            // semantic choice identity binds the complete edits and exact source bytes/physical identity.
            witness.push([entry.uri, captured.content, captured.identity, captured.documentVersion, entry.edits]);
          }
        }
        const qualified = !!entries;
        const selector = sha256HexSync(
          JSON.stringify([
            'lsp-text-only-quickfix-v1',
            queryDigest,
            raw.title,
            kind,
            disabled,
            command,
            qualified ? witness : null,
          ]),
        );
        choices.push({
          entries,
          choice: {
            kind: 'action-choice' as const,
            title: raw.title,
            actionKind: kind,
            disabled,
            command,
            qualified,
            selector,
            queryDigest,
            blocker:
              disabled !== null
                ? 'disabled'
                : command
                  ? 'command'
                  : !family
                    ? 'unqualified-action-family'
                    : qualified
                      ? null
                      : 'unsupported-operation-sequence',
          },
        });
      }
      if (
        !current(fixed) ||
        document.diagnosticRequest !== diagnosticSequence ||
        nativeDigest() !== nativeFingerprint ||
        !document.published ||
        observationKey(document.published.observation) !== observationKey(fixed) ||
        JSON.stringify(EffectArray.map(document.published.items, item => item.id).sort()) !==
          JSON.stringify(EffectArray.map(refreshed.items, item => item.id).sort())
      )
        return yield* SemanticSessionFault.make({reason: 'stale'});
      for (const item of choices)
        if (EffectArray.filter(choices, other => other.choice.selector === item.choice.selector).length > 1) {
          item.choice.qualified = false;
          item.choice.blocker = 'ambiguous';
        }
      const items = EffectArray.map(choices, item => item.choice);
      const outcome = (prefix: Schema.Json[] = []): QueryOutcome => ({
        version: 1,
        status: 'ok',
        evidence: evidence(fixed),
        items: [...prefix, ...items],
      });
      if (!selection) return {outcome: outcome()};
      if (selection.queryDigest !== queryDigest)
        return {outcome: outcome([{kind: 'action-result', status: 'changed-selection'}])};
      const matches = EffectArray.filter(choices, item => item.choice.selector === selection.selector);
      if (matches.length !== 1)
        return {outcome: outcome([{kind: 'action-result', status: matches.length ? 'ambiguous' : 'no-match'}])};
      const selected = matches[0];
      return selected.entries
        ? {entries: selected.entries}
        : {outcome: outcome([{kind: 'action-result', status: 'unsupported', reason: selected.choice.blocker}])};
    });
  const qualifiedPreparation = (
    observation: Observation,
    position: Position,
    newName: string | undefined,
    milliseconds: number,
    actionQuery?: SemanticActionQuery,
    selection?: SemanticActionSelection,
  ) =>
    mutations
      .withPermit(
        Effect.gen(function* () {
          const fixed = structuredClone(yield* decode(Observation, observation));
          const operation = actionQuery ? 'code-action' : 'rename';
          const initiating = current(fixed);
          if (!initiating) return stale();
          if (
            !validTextPosition(initiating.text, position) ||
            (actionQuery
              ? !validRange(initiating.text, actionQuery.range)
              : !newName || newName.length > 512 || !wellFormed(newName) || /\p{Cc}/u.test(newName))
          )
            return yield* invalid();
          if (
            !(actionQuery ? capabilities.codeActionProvider : capabilities.renameProvider) ||
            !options.captureEditSource ||
            !options.policy.editSourceQualification
          )
            return {
              version: 1,
              status: 'unsupported',
              reason: 'Qualified source preparation is unavailable',
              evidence: evidence(fixed),
            } satisfies QueryOutcome;
          const started = yield* Clock.currentTimeMillis;
          const remaining = Effect.gen(function* () {
            const left = milliseconds - ((yield* Clock.currentTimeMillis) - started);
            if (left <= 0) return yield* LspFault.make({code: 'timeout'});
            return left;
          });
          const request = Effect.gen(function* () {
            if (actionQuery) return yield* actionRequest(fixed, actionQuery, selection, remaining);
            const raw = yield* client.request(
              'textDocument/rename',
              {textDocument: {uri: fixed.uri}, position, newName: newName!},
              yield* remaining,
            );
            return {entries: raw === null ? [] : yield* editEntries(raw)};
          });
          // Discovery identifies targets only. Its edits never acquire source authority.
          const discovery = yield* request;
          if (discovery.outcome) return discovery.outcome;
          let discovered = discovery.entries;
          if (!discovered.length)
            return {
              version: 1,
              status: 'unsupported',
              reason: 'Provider cannot rename this occurrence',
              evidence: evidence(fixed),
            } satisfies QueryOutcome;
          for (let round = 0; round < 2; round++) {
            const uris = EffectArray.map(discovered, entry => entry.uri);
            if (new Set([...documents.keys(), ...uris]).size > maxDocuments)
              return yield* LspFault.make({code: 'capacity'});
            const captures = new Map<string, LspEditSource>();
            let retainedBytes = EffectArray.reduce(
              [...documents.values()],
              0,
              (sum, document) => sum + new TextEncoder().encode(document.text).length,
            );
            if (retainedBytes > Math.min(8 * 1024 * 1024, maxTotalTextLength * 3))
              return yield* LspFault.make({code: 'capacity'});
            for (const uri of uris) {
              const retained = documents.get(uri);
              if (retained && retained.observation.documentVersion !== null) continue;
              const captured = yield* options.captureEditSource(uri);
              if (
                captured.uri !== uri ||
                !wellFormed(captured.text) ||
                sha256HexSync(captured.text) !== captured.content
              )
                return yield* SemanticSessionFault.make({reason: 'stale'});
              retainedBytes +=
                new TextEncoder().encode(captured.text).length -
                (retained ? new TextEncoder().encode(retained.text).length : 0);
              if (retainedBytes > Math.min(8 * 1024 * 1024, maxTotalTextLength * 3))
                return yield* LspFault.make({code: 'capacity'});
              if (options.policy.editSourceQualification === 'immutable-provider-input-v1') {
                if (!options.policy.verifyClosedEditSource) return yield* invalid();
                yield* options.policy.verifyClosedEditSource(uri, captured.content);
              }
              captures.set(uri, captured);
              yield* upsertUnlocked(
                {...fixed, uri, content: captured.content, documentVersion: null},
                captured.text,
                options.policy.language,
                yield* remaining,
                true,
              );
            }
            const refreshed = documents.get(fixed.uri);
            if (!refreshed || !current(refreshed.observation)) return stale();
            const finalObservation = structuredClone(refreshed.observation);
            const before = new Map(
              EffectArray.map(
                [...documents],
                ([uri, document]) =>
                  [
                    uri,
                    {
                      text: document.text,
                      wireVersion: document.wireVersion,
                      observation: structuredClone(document.observation),
                    },
                  ] as const,
              ),
            );
            // Basedpyright 1.40.2 publishes the exact client version only after synchronously
            // updating its foreground Program, which is also the rename provider's input.
            if (options.policy.editSourceQualification === 'versioned-diagnostics-foreground-v1') {
              for (const uri of uris) {
                const document = documents.get(uri);
                if (!document) return yield* invalid();
                // Waiting for the source acknowledgment must not consume the public
                // diagnostic delta cursor or synthesize a fresh provider publication.
                while (!document.published) {
                  yield* Deferred.await(document.wake);
                  if (!current(document.observation)) return yield* SemanticSessionFault.make({reason: 'stale'});
                }
                if (observationKey(document.published.observation) !== observationKey(document.observation))
                  return yield* SemanticSessionFault.make({reason: 'stale'});
              }
            }
            const completion = yield* request;
            if (completion.outcome) return completion.outcome;
            const final = completion.entries;
            if (!final.length) return yield* invalid();
            if (EffectArray.some(final, entry => !uris.includes(entry.uri))) {
              discovered = final;
              if (round === 0) continue;
              return yield* SemanticSessionFault.make({reason: 'stale'});
            }
            const files = [];
            let count = 0;
            for (const entry of final) {
              const saved = before.get(entry.uri);
              const live = documents.get(entry.uri);
              if (!saved || !live || !current(saved.observation) || live.wireVersion !== saved.wireVersion)
                return yield* SemanticSessionFault.make({reason: 'stale'});
              const immutableDisk =
                options.policy.editSourceQualification === 'immutable-provider-input-v1' &&
                saved.observation.documentVersion === null &&
                captures.has(entry.uri);
              if (
                (options.policy.editSourceQualification === 'versioned-text-document-v1' ||
                  (options.policy.editSourceQualification === 'immutable-provider-input-v1' && !immutableDisk)) &&
                entry.version !== saved.wireVersion
              )
                return yield* SemanticSessionFault.make({reason: 'stale'});
              if (entry.version !== null && entry.version !== saved.wireVersion) return yield* invalid();
              const edits = [...entry.edits].sort(
                (a, b) => compare(a.range.start, b.range.start) || compare(a.range.end, b.range.end),
              );
              if (!edits.length) return yield* invalid();
              for (let i = 0; i < edits.length; i++) {
                const edit = edits[i];
                if (
                  ++count > 100000 ||
                  !validRange(saved.text, edit.range) ||
                  !wellFormed(edit.newText) ||
                  edit.newText.length > maxTextLength ||
                  (i > 0 &&
                    (compare(edits[i - 1].range.end, edit.range.start) > 0 ||
                      compare(edits[i - 1].range.start, edit.range.start) === 0))
                )
                  return yield* invalid();
              }
              const capture = captures.get(entry.uri);
              if (capture) {
                const closing = yield* options.captureEditSource(entry.uri);
                if (closing.content !== capture.content || closing.identity !== capture.identity)
                  return yield* SemanticSessionFault.make({reason: 'stale'});
              }
              const sourceKind = saved.observation.documentVersion === null ? 'disk' : 'overlay';
              files.push({
                uri: entry.uri,
                content: saved.observation.content,
                documentVersion: saved.observation.documentVersion,
                source: sourceKind,
                observation: saved.observation,
                beforeText: saved.text,
                ...(actionQuery ? {providerDocumentVersion: entry.version} : {}),
                edits,
                precondition: {
                  sourceKind,
                  rawDigest: saved.observation.content,
                  encoding: 'utf-8',
                  physicalIdentity: capture?.identity ?? null,
                  owner: saved.observation.view.owner,
                  documentVersion: saved.observation.documentVersion,
                },
              });
            }
            if (!current(finalObservation)) return stale();
            return {
              version: 1,
              status: 'ok',
              evidence: evidence(finalObservation),
              items: [
                {
                  kind: 'prepared-edit',
                  operation,
                  ...(actionQuery
                    ? {
                        qualification: 'qualified-text-only',
                        operations: EffectArray.map(final, (entry, index) => ({
                          kind: 'text',
                          uri: entry.uri,
                          version: entry.version,
                          edits: entry.edits,
                          target: index,
                        })),
                      }
                    : {}),
                  sourceBasis: 'pre-request-synchronized-text-v1',
                  files,
                  scope: 'all-provider-returned-edits',
                  applied: false,
                },
              ],
            } satisfies QueryOutcome;
          }
          return stale();
        }),
      )
      .pipe(
        Effect.timeoutOption(milliseconds),
        Effect.flatMap(result =>
          Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
        ),
      );
  const prepare = (
    operation: 'rename' | 'code-action',
    observation: Observation,
    position: Position,
    newName: string | undefined,
    milliseconds: number,
  ) => {
    const fixed = structuredClone(observation);
    const cursor = structuredClone(position);
    return operation === 'rename' && options.policy.editSourceQualification && options.captureEditSource
      ? qualifiedPreparation(fixed, cursor, newName, milliseconds)
      : prepareLegacy(operation, fixed, cursor, newName, milliseconds);
  };
  return {
    upsert,
    query,
    diagnostics,
    prepare,
    actions: (
      observation: Observation,
      query: SemanticActionQuery,
      milliseconds: number,
      selection?: SemanticActionSelection,
    ) => {
      const fixed = structuredClone(observation);
      const actionQuery = structuredClone(query);
      return qualifiedPreparation(
        fixed,
        actionQuery.range.start,
        undefined,
        milliseconds,
        actionQuery,
        selection ? structuredClone(selection) : undefined,
      );
    },
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
