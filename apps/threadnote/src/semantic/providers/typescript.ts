import {Effect, Exit, Option, Schema, Semaphore} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  Evidence,
  Counter,
  FileUri,
  Observation,
  Position,
  observationKey,
  type QueryOutcome,
} from '@threadnote/semantic/contracts';
import {LspFault, type LspClient} from '../lsp_transport.js';

export class SemanticSessionFault extends Schema.TaggedError<SemanticSessionFault>()('SemanticSessionFault', {
  reason: Schema.Literals(['invalid', 'conflict', 'stale', 'not-ready', 'provider']),
}) {}
const Range = Schema.Struct({start: Position, end: Position});
const Location = Schema.Struct({uri: FileUri, range: Range});
const LocationLink = Schema.Struct({
  targetUri: FileUri,
  targetRange: Range,
  targetSelectionRange: Range,
  originSelectionRange: Schema.optional(Range),
});
const Navigation = Schema.NullOr(Schema.Union([Location, Schema.Array(Location), Schema.Array(LocationLink)]));
const Diagnostic = Schema.Struct({
  message: Schema.String,
  start: Counter,
  length: Counter,
  startLocation: Schema.Struct({line: Counter, offset: Counter}),
  endLocation: Schema.Struct({line: Counter, offset: Counter}),
  category: Schema.String,
  code: Counter,
});
export interface SemanticDiagnostic {
  readonly id: string;
  readonly range: typeof Range.Type;
  readonly message: string;
  readonly category: string;
  readonly code: number;
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
interface OpenDocument {
  observation: Observation;
  readonly text: string;
  readonly wireVersion: number;
  readonly language: 'typescript' | 'typescriptreact' | 'javascript' | 'javascriptreact';
  ready: boolean;
  diagnosticRequest: number;
  diagnostics?: DiagnosticSnapshot;
  project?: {configuration: string; fileCount: number};
}
export interface TypeScriptSessionOptions {
  readonly basis: Observation;
  /** Absolute SDK path comes only from the host-qualified candidate, never repository configuration. */
  readonly tsserver: string;
  readonly maxMemoryMb: number;
  readonly startupMilliseconds: number;
}
const invalid = () => SemanticSessionFault.make({reason: 'invalid'});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(invalid));

/** UTF-16 LSP positions must be within a line and cannot split a surrogate pair. */
export function validTextPosition(text: string, position: Position): boolean {
  if (!Schema.is(Position)(position)) return false;
  const lines = text.split(/\r\n|\r|\n/u);
  const line = lines[position.line];
  if (line === undefined || position.character > line.length) return false;
  const before = line.charCodeAt(position.character - 1);
  const after = line.charCodeAt(position.character);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const sameBasis = (a: Observation, b: Observation) =>
  observationKey({
    ...a,
    uri: b.uri,
    content: b.content,
    documentVersion: b.documentVersion,
    projectEpoch: b.projectEpoch,
  }) === observationKey(b);

/** One isolated provider process per worktree/project/source-view owner. No edit or arbitrary command surface. */
export const makeTypeScriptSession = Effect.fn('semantic.makeTypeScriptSession')(function* (
  client: LspClient,
  options: TypeScriptSessionOptions,
) {
  const basis = structuredClone(yield* decode(Observation, options.basis));
  if (
    !options.tsserver.startsWith('/') ||
    !Number.isSafeInteger(options.maxMemoryMb) ||
    options.maxMemoryMb < 128 ||
    options.maxMemoryMb > 4096
  )
    return yield* invalid();
  const initialized = yield* client.request(
    'initialize',
    {
      processId: null,
      rootUri: basis.project,
      workspaceFolders: [{uri: basis.project, name: 'semantic-project'}],
      capabilities: {
        general: {positionEncodings: ['utf-16']},
        workspace: {configuration: true, workspaceEdit: {documentChanges: false}},
        textDocument: {publishDiagnostics: {versionSupport: false}},
      },
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        plugins: [],
        tsserver: {path: options.tsserver, fallbackPath: options.tsserver},
        maxTsServerMemory: options.maxMemoryMb,
      },
    },
    options.startupMilliseconds,
  );
  const init = yield* decode(
    Schema.Struct({capabilities: Schema.Struct({positionEncoding: Schema.optional(Schema.String)})}),
    initialized,
  );
  if (init.capabilities.positionEncoding !== undefined && init.capabilities.positionEncoding !== 'utf-16')
    return yield* SemanticSessionFault.make({reason: 'provider'});
  yield* client.notify('initialized', {});
  const mutations = yield* Semaphore.make(1);
  const documents = new Map<string, OpenDocument>();
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
  const custom = (
    command: 'projectInfo' | 'semanticDiagnosticsSync' | 'syntacticDiagnosticsSync' | 'suggestionDiagnosticsSync',
    args: Schema.Json,
    milliseconds: number,
  ) =>
    client.request(
      'workspace/executeCommand',
      {
        command: 'typescript.tsserverRequest',
        arguments: [command, args, {expectsResult: true, isAsync: false}],
      },
      milliseconds,
    );
  const allowedRoots = [
    decodeURIComponent(new URL(basis.worktree).pathname),
    options.tsserver.slice(0, options.tsserver.lastIndexOf('/')),
  ];
  const contained = (file: string) =>
    file.startsWith('/') &&
    !file.includes('//') &&
    !file.split('/').some(part => part === '.' || part === '..') &&
    allowedRoots.some(root => file.startsWith(root + '/'));
  const projectInfo = (uri: string, milliseconds: number) =>
    Effect.gen(function* () {
      const project = yield* custom('projectInfo', {file: uri, needFileNameList: true}, milliseconds);
      const result = yield* decode(
        Schema.Struct({
          success: Schema.Literal(true),
          body: Schema.Struct({
            configFileName: Schema.String,
            fileNames: Schema.Array(Schema.String).check(Schema.isMaxLength(100000)),
            languageServiceDisabled: Schema.optional(Schema.Boolean),
          }),
        }),
        project,
      );
      if (
        result.body.languageServiceDisabled ||
        invalidated ||
        (!contained(result.body.configFileName) &&
          !/^\/dev\/null\/inferredProject[0-9]+\*$/u.test(result.body.configFileName)) ||
        result.body.fileNames.some(file => !contained(file))
      )
        return yield* SemanticSessionFault.make({reason: 'not-ready'});
      return {configuration: result.body.configFileName, fileCount: result.body.fileNames.length};
    });
  const upsert = (observation: Observation, text: string, language: OpenDocument['language'], milliseconds: number) =>
    mutations.withPermit(
      Effect.gen(function* () {
        let fixed = structuredClone(yield* decode(Observation, observation));
        if (
          !wellFormed(text) ||
          text.length > 4 * 1024 * 1024 ||
          sha256HexSync(text) !== fixed.content ||
          !sameBasis(fixed, basis) ||
          (fixed.view.kind === 'disk' ? fixed.documentVersion !== null : fixed.documentVersion === null) ||
          invalidated ||
          !['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language)
        )
          return yield* invalid();
        const previous = documents.get(fixed.uri);
        if (
          previous &&
          previous.ready &&
          previous.text === text &&
          previous.language === language &&
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
        const wireVersion = (previous?.wireVersion ?? 0) + 1;
        if (wireVersion > 2147483647) return yield* SemanticSessionFault.make({reason: 'not-ready'});
        if (previous && previous.language !== language) return yield* SemanticSessionFault.make({reason: 'conflict'});
        if (!previous && documents.size >= 256) return yield* LspFault.make({code: 'capacity'});
        if (documents.size) {
          if (epoch >= Number.MAX_SAFE_INTEGER) return yield* SemanticSessionFault.make({reason: 'not-ready'});
          epoch++;
        }
        fixed = {...fixed, projectEpoch: epoch};
        // Every buffer can affect every other document in this provider view.
        updating = true;
        for (const document of documents.values())
          document.observation = {...document.observation, projectEpoch: epoch};
        const document: OpenDocument = {
          observation: fixed,
          wireVersion,
          text,
          language,
          ready: false,
          diagnosticRequest: 0,
          ...(previous?.diagnostics ? {diagnostics: previous.diagnostics} : {}),
        };
        documents.set(fixed.uri, document);
        return yield* Effect.gen(function* () {
          yield* client.notify(
            previous ? 'textDocument/didChange' : 'textDocument/didOpen',
            previous
              ? {
                  textDocument: {uri: fixed.uri, version: wireVersion},
                  contentChanges: [{text}],
                }
              : {textDocument: {uri: fixed.uri, version: wireVersion, languageId: language, text}},
          );
          document.project = yield* projectInfo(fixed.uri, milliseconds);
          document.ready = true;
          return structuredClone(fixed);
        }).pipe(
          Effect.onExit(exit =>
            Effect.sync(() => {
              updating = false;
              // An interrupted/failed write leaves engine state uncertain; require a fresh provider generation.
              if (Exit.isFailure(exit)) invalidated = true;
            }),
          ),
        );
      }),
    );
  const evidence = (observation: Observation): Evidence => ({
    basis: 'semantic',
    observation: structuredClone(observation),
    scope: 'project:' + sha256HexSync(documents.get(observation.uri)?.project?.configuration ?? basis.project),
    completeness: 'partial',
    limitations: [
      'Experimental TypeScript read pilot',
      'Selected project and provider-resolved dependencies only',
      'Repository execution and automatic dependency acquisition disabled',
    ],
  });
  const stale = (): QueryOutcome => ({
    version: 1,
    status: 'stale',
    reason: 'Source view or analysis basis changed',
    evidence: null,
  });
  const query = (
    operation: 'definition' | 'references' | 'hover' | 'symbols',
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
      const method = operation === 'symbols' ? 'textDocument/documentSymbol' : `textDocument/${operation}`;
      const response = yield* client.request(
        method,
        {
          textDocument: {uri: fixed.uri},
          ...(position ? {position} : {}),
          ...(operation === 'references' ? {context: {includeDeclaration: true}} : {}),
        },
        milliseconds,
      );
      const project = yield* projectInfo(fixed.uri, milliseconds);
      if (!current(fixed) || document.project?.configuration !== project.configuration) return stale();
      let items: Schema.Json[];
      if (operation === 'definition' || operation === 'references') {
        const locations = yield* decode(Navigation, response);
        items = locations === null ? [] : Array.isArray(locations) ? [...locations] : [locations];
      } else if (operation === 'symbols') {
        items = [...((yield* decode(Schema.NullOr(Schema.Array(Schema.Json)), response)) ?? [])];
      } else {
        const hover = yield* decode(
          Schema.NullOr(Schema.Struct({contents: Schema.Json, range: Schema.optional(Range)})),
          response,
        );
        items = hover ? [hover] : [];
      }
      return {version: 1, status: 'ok', evidence: evidence(fixed), items} satisfies QueryOutcome;
    });
  const diagnostics = (observation: Observation, milliseconds: number) =>
    Effect.gen(function* () {
      const fixed = structuredClone(yield* decode(Observation, observation));
      const document = current(fixed);
      if (!document) return yield* SemanticSessionFault.make({reason: 'stale'});
      const sequence = ++document.diagnosticRequest;
      const refresh = Effect.gen(function* () {
        const items = new Map<string, SemanticDiagnostic>();
        for (const command of [
          'syntacticDiagnosticsSync',
          'semanticDiagnosticsSync',
          'suggestionDiagnosticsSync',
        ] as const) {
          const raw = yield* custom(command, {file: fixed.uri, includeLinePosition: true}, milliseconds);
          const response = yield* decode(
            Schema.Struct({success: Schema.Literal(true), body: Schema.Array(Diagnostic)}),
            raw,
          );
          for (const diagnostic of response.body) {
            const range = {
              start: {line: diagnostic.startLocation.line - 1, character: diagnostic.startLocation.offset - 1},
              end: {line: diagnostic.endLocation.line - 1, character: diagnostic.endLocation.offset - 1},
            };
            if (
              !validTextPosition(document.text, range.start) ||
              !validTextPosition(document.text, range.end) ||
              range.start.line > range.end.line ||
              (range.start.line === range.end.line && range.start.character > range.end.character)
            )
              return yield* SemanticSessionFault.make({reason: 'provider'});
            const id = sha256HexSync(JSON.stringify([range, diagnostic.code, diagnostic.category, diagnostic.message]));
            items.set(id, {
              id,
              range,
              code: diagnostic.code,
              category: diagnostic.category,
              message: diagnostic.message,
            });
          }
        }
        const project = yield* projectInfo(fixed.uri, milliseconds);
        if (
          !current(fixed) ||
          document.project?.configuration !== project.configuration ||
          document.diagnosticRequest !== sequence
        )
          return yield* SemanticSessionFault.make({reason: 'stale'});
        const previous = document.diagnostics;
        const old = new Map(previous?.items.map(item => [item.id, item]) ?? []);
        const snapshot: DiagnosticSnapshot = {observation: fixed, items: [...items.values()]};
        const delta: DiagnosticDelta = {
          ...snapshot,
          added: snapshot.items.filter(item => !old.has(item.id)),
          remaining: snapshot.items.filter(item => old.has(item.id)),
          resolved: previous
            ? previous.items
                .filter(item => !items.has(item.id))
                .map(item => ({item, observation: previous.observation, resolvedIn: fixed}))
            : [],
        };
        document.diagnostics = structuredClone(snapshot);
        return structuredClone(delta);
      });
      const result = yield* refresh.pipe(Effect.timeoutOption(milliseconds));
      if (Option.isNone(result)) return yield* LspFault.make({code: 'timeout'});
      return result.value;
    });
  return {
    upsert,
    available: Effect.sync(() => !invalidated),
    project: (uri: string) => Effect.sync(() => structuredClone(documents.get(uri)?.project)),
    query,
    diagnostics,
    invalidate: Effect.sync(() => {
      invalidated = true;
    }),
    close: client.close,
    observation: (uri: string) =>
      Effect.sync(() => {
        const document = documents.get(uri);
        return !invalidated && !updating && document?.ready ? structuredClone(document.observation) : undefined;
      }),
  };
});
