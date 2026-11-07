import {ProposalOperation, ProposalChangeAnnotations} from '@threadnote/semantic/proposals';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Clock, Effect, Exit, Option, Schema, Semaphore} from 'effect';
import {typeScriptPolicyCommand, typeScriptPolicyVersion} from './typescript_runtime.js';
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
import {
  SemanticSessionFault,
  SemanticRange as Range,
  validTextPosition,
  validRange,
  wellFormed,
  type SemanticDiagnostic,
  type DiagnosticSnapshot,
  type DiagnosticDelta,
  type SemanticActionQuery,
  type SemanticActionSelection,
} from '../provider.js';
export {SemanticSessionFault, validTextPosition} from '../provider.js';
export type {SemanticDiagnostic, DiagnosticSnapshot, DiagnosticDelta} from '../provider.js';
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
export const typeScriptEditClosureLimits = {
  maxFiles: 256,
  maxRetainedBytes: 8 * 1024 * 1024,
  maxEdits: 100000,
  maxProjectFiles: 100000,
  maxRecomputeRounds: 2,
} as const;
interface OpenDocument {
  observation: Observation;
  readonly text: string;
  readonly wireVersion: number;
  readonly language: 'typescript' | 'typescriptreact' | 'javascript' | 'javascriptreact';
  ready: boolean;
  diagnosticRequest: number;
  diagnostics?: DiagnosticSnapshot;
  project?: {
    configuration: string;
    fileCount: number;
    files: readonly string[];
  };
}
export interface TypeScriptEditSource {
  readonly uri: string;
  readonly text: string;
  readonly content: string;
  readonly identity: string;
}
export interface TypeScriptSessionOptions {
  /** Host-owned canonical disk reader. No caller JSON can provide this authority. */
  readonly captureEditSource?: (uri: string) => Effect.Effect<TypeScriptEditSource, unknown>;
  readonly basis: Observation;
  /** Absolute SDK path comes only from the host-qualified candidate, never repository configuration. */
  readonly tsserver: string;
  readonly compiler: string;
  readonly sourceRoot: string;
  readonly verifyPolicy: Effect.Effect<void, unknown>;
  readonly challenge: Effect.Effect<string, unknown>;
  /** Host inspection is bound to the actual projectInfo-selected configuration. Unknown is false. */
  readonly configurationIncomplete?: (configuration: string) => Effect.Effect<boolean, unknown>;
  readonly maxMemoryMb: number;
  readonly startupMilliseconds: number;
}
const invalid = () => SemanticSessionFault.make({reason: 'invalid'});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(invalid));
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
    !EffectString.startsWith('/')(options.tsserver) ||
    !EffectString.startsWith('/')(options.compiler) ||
    !EffectString.startsWith('/')(options.sourceRoot) ||
    !Number.isSafeInteger(options.maxMemoryMb) ||
    options.maxMemoryMb < 128 ||
    options.maxMemoryMb > 4096
  )
    return yield* invalid();
  yield* options.verifyPolicy;
  const initialized = yield* client.request(
    'initialize',
    {
      processId: null,
      rootUri: basis.project,
      workspaceFolders: [{uri: basis.project, name: 'semantic-project'}],
      capabilities: {
        general: {positionEncodings: ['utf-16']},
        workspace: {configuration: true, workspaceEdit: {documentChanges: false}},
        textDocument: {publishDiagnostics: {versionSupport: false}, definition: {linkSupport: true}},
      },
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        plugins: [],
        tsserver: {path: options.tsserver, fallbackPath: options.tsserver, useSyntaxServer: 'never'},
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
  let processInstance: string | undefined;
  const policy = (milliseconds: number) =>
    Effect.gen(function* () {
      const challenge = yield* options.challenge;
      if (!/^[a-f0-9]{64}$/u.test(challenge)) return yield* invalid();
      yield* options.verifyPolicy;
      const raw = yield* client.request(
        'workspace/executeCommand',
        {
          command: 'typescript.tsserverRequest',
          arguments: [typeScriptPolicyCommand, {challenge}, {expectsResult: true, isAsync: false}],
        },
        Math.min(milliseconds, 2000),
      );
      const response = yield* decode(
        Schema.Struct({
          success: Schema.Literal(true),
          body: Schema.Struct({
            policy: Schema.Literal(typeScriptPolicyVersion),
            launcher: Schema.Literal(options.tsserver),
            compiler: Schema.Literal(options.compiler),
            version: Schema.Literal('6.0.3'),
            pid: Counter.check(Schema.isGreaterThan(0)),
            instance: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
            challenge: Schema.Literal(challenge),
            locked: Schema.Literal(true),
          }),
        }),
        raw,
      );
      const instance = response.body.pid + ':' + response.body.instance;
      if (invalidated || (processInstance !== undefined && processInstance !== instance))
        return yield* SemanticSessionFault.make({reason: 'not-ready'});
      processInstance = instance;
    }).pipe(
      Effect.timeoutOption(Math.min(milliseconds, 2000)),
      Effect.flatMap(result => (Option.isSome(result) ? Effect.void : Effect.fail(LspFault.make({code: 'timeout'})))),
      Effect.onExit(exit =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) invalidated = true;
        }),
      ),
    );
  // Initialization alone can silently fall back to an unguarded SDK. No document opens before this proof.
  yield* policy(options.startupMilliseconds);
  const allowedRoots = [decodeURIComponent(new URL(basis.worktree).pathname), options.sourceRoot];
  const contained = (file: string) =>
    EffectString.startsWith('/')(file) &&
    !EffectString.includes('//')(file) &&
    !EffectArray.some(EffectString.split('/')(file), part => part === '.' || part === '..') &&
    EffectArray.some(allowedRoots, root => EffectString.startsWith(root + '/')(file));
  const projectInfo = (uri: string, milliseconds: number) =>
    Effect.gen(function* () {
      const project = yield* custom('projectInfo', {file: uri, needFileNameList: true}, milliseconds);
      const result = yield* decode(
        Schema.Struct({
          success: Schema.Literal(true),
          body: Schema.Struct({
            configFileName: Schema.String,
            fileNames: Schema.Array(Schema.String).check(
              Schema.isMaxLength(typeScriptEditClosureLimits.maxProjectFiles),
            ),
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
        EffectArray.some(result.body.fileNames, file => !contained(file))
      )
        return yield* SemanticSessionFault.make({reason: 'not-ready'});
      return {
        configuration: result.body.configFileName,
        fileCount: result.body.fileNames.length,
        files: [...new Set(result.body.fileNames)].sort(),
      };
    });
  const upsertUnlocked = (
    observation: Observation,
    text: string,
    language: OpenDocument['language'],
    milliseconds: number,
    internalDisk = false,
  ) =>
    Effect.gen(function* () {
      let fixed = structuredClone(yield* decode(Observation, observation));
      if (
        !wellFormed(text) ||
        text.length > 4 * 1024 * 1024 ||
        sha256HexSync(text) !== fixed.content ||
        !sameBasis(fixed, basis) ||
        (internalDisk
          ? fixed.documentVersion !== null
          : fixed.view.kind === 'disk'
            ? fixed.documentVersion !== null
            : fixed.documentVersion === null) ||
        invalidated ||
        !['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language)
      )
        return yield* invalid();
      yield* policy(milliseconds);
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
      for (const document of documents.values()) document.observation = {...document.observation, projectEpoch: epoch};
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
    });
  const upsert = (observation: Observation, text: string, language: OpenDocument['language'], milliseconds: number) =>
    mutations.withPermit(upsertUnlocked(observation, text, language, milliseconds));
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
      yield* policy(milliseconds);
      const incomplete =
        options.configurationIncomplete && document.project
          ? yield* options.configurationIncomplete(document.project.configuration)
          : false;
      const method = operation === 'symbols' ? 'textDocument/documentSymbol' : `textDocument/${operation}`;
      const response = incomplete
        ? null
        : yield* client.request(
            method,
            {
              textDocument: {uri: fixed.uri},
              ...(position ? {position} : {}),
              ...(operation === 'references' ? {context: {includeDeclaration: true}} : {}),
            },
            milliseconds,
          );
      const project = yield* projectInfo(fixed.uri, milliseconds);
      yield* policy(milliseconds);
      if (!current(fixed) || document.project?.configuration !== project.configuration) return stale();
      if (incomplete)
        return {
          version: 1,
          status: 'unavailable',
          reason: 'semantic-project-configuration-incomplete',
          evidence: evidence(fixed),
        } satisfies QueryOutcome;
      let items: Schema.Json[];
      if (operation === 'definition' || operation === 'references') {
        const locations = yield* decode(Navigation, response);
        items = locations === null ? [] : Schema.is(Location)(locations) ? [locations] : [...locations];
        for (const item of items) {
          // Same-document links are bound to this exact retained observation.
          // Foreign locations retain their navigation meaning; context cannot
          // use them as same-document symbol identity.
          if (Schema.is(LocationLink)(item) && item.targetUri === fixed.uri) {
            const compare = (a: Position, b: Position) => a.line - b.line || a.character - b.character;
            if (
              !validRange(document.text, item.targetRange) ||
              !validRange(document.text, item.targetSelectionRange) ||
              compare(item.targetRange.start, item.targetSelectionRange.start) > 0 ||
              compare(item.targetSelectionRange.end, item.targetRange.end) > 0 ||
              (item.originSelectionRange && !validRange(document.text, item.originSelectionRange))
            )
              return yield* SemanticSessionFault.make({reason: 'provider'});
          } else if (Schema.is(Location)(item) && item.uri === fixed.uri && !validRange(document.text, item.range))
            return yield* SemanticSessionFault.make({reason: 'provider'});
        }
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
        yield* policy(milliseconds);
        if (
          !current(fixed) ||
          document.project?.configuration !== project.configuration ||
          document.diagnosticRequest !== sequence
        )
          return yield* SemanticSessionFault.make({reason: 'stale'});
        const previous = document.diagnostics;
        const old = new Map(
          (effectOptionalValue =>
            effectOptionalValue == null ? undefined : EffectArray.map(effectOptionalValue, item => [item.id, item]))(
            previous?.items,
          ) ?? [],
        );
        const snapshot: DiagnosticSnapshot = {observation: fixed, items: [...items.values()]};
        const delta: DiagnosticDelta = {
          ...snapshot,
          evidence: evidence(fixed),
          added: EffectArray.filter(snapshot.items, item => !old.has(item.id)),
          remaining: EffectArray.filter(snapshot.items, item => old.has(item.id)),
          resolved: previous
            ? EffectArray.map(
                EffectArray.filter(previous.items, item => !items.has(item.id)),
                item => ({item, observation: previous.observation, resolvedIn: fixed}),
              )
            : [],
        };
        document.diagnostics = structuredClone(snapshot);
        return structuredClone(delta);
      });
      const result = yield* refresh.pipe(Effect.timeoutOption(milliseconds));
      if (Option.isNone(result)) return yield* LspFault.make({code: 'timeout'});
      return result.value;
    });
  const prepare = (
    operation: 'rename' | 'code-action',
    inputObservation: Observation,
    inputPosition: Position,
    newName: string | undefined,
    milliseconds: number,
    inputActionQuery?: SemanticActionQuery,
    inputSelection?: SemanticActionSelection,
  ) =>
    Effect.gen(function* () {
      const {observation, position, actionQuery, selection} = yield* Effect.try({
        try: () =>
          structuredClone({
            observation: inputObservation,
            position: inputPosition,
            actionQuery: inputActionQuery,
            selection: inputSelection,
          }),
        catch: invalid,
      });
      return yield* mutations.withPermit(
        Effect.gen(function* () {
          if (!options.captureEditSource)
            return {
              version: 1,
              status: 'unsupported',
              reason: 'Edit family source basis is unqualified',
              evidence: null,
            } satisfies QueryOutcome;
          const initial = current(observation);
          if (!initial) return stale();
          if (
            !validTextPosition(initial.text, position) ||
            (operation === 'rename' &&
              (!newName || newName.length > 512 || !wellFormed(newName) || /\p{Cc}/u.test(newName))) ||
            (operation === 'code-action' && (!actionQuery || !validRange(initial.text, actionQuery.range)))
          )
            return yield* invalid();
          const started = yield* Clock.currentTimeMillis;
          const remaining = Effect.gen(function* () {
            const left = milliseconds - ((yield* Clock.currentTimeMillis) - started);
            if (left <= 0) return yield* LspFault.make({code: 'timeout'});
            return left;
          });
          const Edit = Schema.Struct({range: Range, newText: Schema.String});
          const Response = Schema.Struct({changes: Schema.Record(FileUri, Schema.Array(Edit))});
          const normalizeActionEdit = (raw: unknown) =>
            Effect.gen(function* () {
              const envelope = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  changes: Schema.optionalKey(Schema.Record(FileUri, Schema.Array(Schema.Json))),
                  documentChanges: Schema.optionalKey(Schema.Array(Schema.Json)),
                  changeAnnotations: Schema.optionalKey(ProposalChangeAnnotations),
                }),
                {onExcessProperty: 'error'},
              )(raw).pipe(Effect.mapError(invalid));
              if ((envelope.changes === undefined) === (envelope.documentChanges === undefined))
                return yield* invalid();
              const operations: ProposalOperation[] = [];
              if (envelope.documentChanges) {
                for (const raw of envelope.documentChanges) {
                  if (!isJsonObject(raw)) return yield* invalid();
                  if ('kind' in raw)
                    operations.push(
                      yield* Schema.decodeUnknownEffect(ProposalOperation, {onExcessProperty: 'error'})(raw),
                    );
                  else {
                    const change = yield* Schema.decodeUnknownEffect(
                      Schema.Struct({
                        textDocument: Schema.Struct({uri: FileUri, version: Schema.NullOr(Counter)}),
                        edits: Schema.Array(Schema.Json),
                      }),
                      {onExcessProperty: 'error'},
                    )(raw);
                    operations.push(
                      yield* Schema.decodeUnknownEffect(ProposalOperation, {onExcessProperty: 'error'})({
                        kind: 'text',
                        ...change.textDocument,
                        edits: change.edits,
                        target: null,
                      }),
                    );
                  }
                }
              } else
                for (const [uri, edits] of EffectRecord.toEntries(envelope.changes!))
                  operations.push(
                    yield* Schema.decodeUnknownEffect(ProposalOperation, {onExcessProperty: 'error'})({
                      kind: 'text',
                      uri,
                      version: null,
                      edits,
                      target: null,
                    }),
                  );
              if (!operations.length || operations.length > typeScriptEditClosureLimits.maxEdits)
                return yield* invalid();
              return {
                operations,
                ...(envelope.changeAnnotations ? {changeAnnotations: envelope.changeAnnotations} : {}),
              };
            });
          const actionOutcome = (observation: Observation, items: readonly Schema.Json[]): QueryOutcome => ({
            version: 1,
            status: 'ok',
            evidence: evidence(observation),
            items: [...items],
          });
          const sourceFamilies: Readonly<Record<string, string>> = {
            'source.organizeImports.ts': 'Organize Imports',
            'source.sortImports.ts': 'Sort Imports',
            'source.removeUnusedImports.ts': 'Remove Unused Imports',
          };
          const actionList = () =>
            Effect.gen(function* () {
              const fixed = documents.get(observation.uri)?.observation;
              if (!fixed || !actionQuery) return yield* invalid();
              // Recompute diagnostics as well as actions; stale data/edits are never replayed.
              const refreshed = yield* diagnostics(fixed, yield* remaining);
              const subset = actionQuery.diagnosticIds;
              if (
                subset &&
                (new Set(subset).size !== subset.length ||
                  EffectArray.some(subset, id => !EffectArray.some(refreshed.items, item => item.id === id)))
              )
                return yield* SemanticSessionFault.make({reason: 'stale'});
              const native = EffectArray.map(
                EffectArray.filter(refreshed.items, item => !subset || subset.includes(item.id)),
                item => ({
                  range: item.range,
                  code: item.code,
                  message: item.message,
                  severity: item.category === 'error' ? 1 : item.category === 'warning' ? 2 : 3,
                }),
              );
              const queryDigest = sha256HexSync(
                JSON.stringify([
                  actionQuery.range,
                  actionQuery.only ?? null,
                  EffectArray.map(refreshed.items, item => item.id).sort(),
                  subset ?? null,
                ]),
              );
              const raw = yield* client.request(
                'textDocument/codeAction',
                {
                  textDocument: {uri: fixed.uri},
                  range: actionQuery.range,
                  context: {diagnostics: native, ...(actionQuery.only ? {only: [...actionQuery.only]} : {})},
                },
                yield* remaining,
              );
              const actions =
                (yield* decode(Schema.NullOr(Schema.Array(Schema.Json).check(Schema.isMaxLength(128))), raw)) ?? [];
              const choices = [];
              for (const raw of actions) {
                if (!isJsonObject(raw) || typeof raw.title !== 'string' || !wellFormed(raw.title))
                  return yield* invalid();
                const kind = typeof raw.kind === 'string' ? raw.kind : '';
                const disabled =
                  'disabled' in raw
                    ? isJsonObject(raw.disabled) &&
                      typeof raw.disabled.reason === 'string' &&
                      wellFormed(raw.disabled.reason)
                      ? raw.disabled.reason
                      : 'Provider disabled this action'
                    : null;
                const command = 'command' in raw;
                // Commands/opaque provider data are never executed or retained as authority.
                const parsed =
                  !command && !disabled && 'edit' in raw
                    ? yield* normalizeActionEdit(raw.edit).pipe(Effect.option)
                    : Option.none();
                const preview = Option.getOrUndefined(parsed);
                const independent =
                  preview &&
                  EffectArray.every(preview.operations, op => op.kind === 'text') &&
                  new Set(EffectArray.map(preview.operations, op => (op.kind === 'text' ? op.uri : ''))).size ===
                    preview.operations.length;
                // TLS6.0.2 / TS6.0.3 provide exactly these finite semantic source families as inline edits.
                const qualified = sourceFamilies[kind] === raw.title && !command && !disabled && !!independent;
                const rawDigest = preview ? sha256HexSync(JSON.stringify(preview)) : null;
                const selector = sha256HexSync(
                  JSON.stringify([
                    'tls-6.0.2-ts-6.0.3-source-v1',
                    qualified ? kind : [kind, raw.title, disabled, command, rawDigest],
                    queryDigest,
                  ]),
                );
                choices.push({
                  raw,
                  preview,
                  choice: {
                    kind: 'action-choice' as const,
                    title: raw.title,
                    actionKind: kind,
                    disabled,
                    command,
                    qualified,
                    selector,
                    queryDigest,
                    blocker: disabled
                      ? 'disabled'
                      : command
                        ? 'command'
                        : qualified
                          ? null
                          : preview && !independent
                            ? 'unsupported-operation-sequence'
                            : 'unqualified-action-family',
                  },
                });
              }
              if (!current(fixed)) return yield* SemanticSessionFault.make({reason: 'stale'});
              return {fixed, choices, queryDigest};
            });
          const request = () =>
            Effect.gen(function* () {
              yield* policy(yield* remaining);
              if (operation === 'code-action') {
                const listed = yield* actionList();
                const choices = EffectArray.map(listed.choices, item => item.choice);
                if (!selection) return {outcome: actionOutcome(listed.fixed, choices)};
                if (selection.queryDigest !== listed.queryDigest)
                  return {
                    outcome: actionOutcome(listed.fixed, [
                      {kind: 'action-result', status: 'changed-selection'},
                      ...choices,
                    ]),
                  };
                const matches = EffectArray.filter(listed.choices, item => item.choice.selector === selection.selector);
                if (matches.length !== 1)
                  return {
                    outcome: actionOutcome(listed.fixed, [
                      {kind: 'action-result', status: matches.length ? 'ambiguous' : 'no-match'},
                      ...choices,
                    ]),
                  };
                const selected = matches[0];
                if (!selected.choice.qualified) {
                  if (selected.preview && selected.choice.blocker === 'unsupported-operation-sequence')
                    return {
                      outcome: actionOutcome(listed.fixed, [
                        {
                          kind: 'prepared-edit',
                          operation: 'code-action',
                          sourceBasis: 'unqualified-operation-sequence-v1',
                          qualification: 'unsupported-operation-sequence',
                          files: [],
                          ...selected.preview,
                          scope: 'all-provider-returned-edits',
                          applied: false,
                        },
                      ]),
                    };
                  return {
                    outcome: actionOutcome(listed.fixed, [
                      {kind: 'action-result', status: 'unsupported', reason: selected.choice.blocker},
                      ...choices,
                    ]),
                  };
                }
                if (!selected.preview) return yield* invalid();
                const changes: Record<string, readonly (typeof Edit.Type)[]> = {};
                const versions: Record<string, number | null> = {};
                for (const item of selected.preview.operations) {
                  if (item.kind !== 'text' || changes[item.uri]) return yield* invalid();
                  const doc = documents.get(item.uri);
                  if (doc && item.version !== null && item.version !== doc.wireVersion)
                    return yield* SemanticSessionFault.make({reason: 'stale'});
                  changes[item.uri] = item.edits;
                  versions[item.uri] = item.version;
                }
                return {changes, versions, preview: selected.preview};
              }
              const raw = yield* client.request(
                'textDocument/rename',
                {
                  textDocument: {uri: observation.uri},
                  position,
                  newName: newName!,
                },
                yield* remaining,
              );
              if (raw === null) return yield* SemanticSessionFault.make({reason: 'invalid'});
              return yield* Schema.decodeUnknownEffect(Response, {onExcessProperty: 'error'})(raw).pipe(
                Effect.mapError(invalid),
              );
            });
          // Discovery has no authority. All edits from it are discarded before the retained-source request.
          let discovered = yield* request();
          if ('outcome' in discovered && discovered.outcome) return discovered.outcome;
          for (let round = 0; round < typeScriptEditClosureLimits.maxRecomputeRounds; round++) {
            const uris = EffectRecord.keys(discovered.changes).sort();
            if (
              !uris.length ||
              uris.length > typeScriptEditClosureLimits.maxFiles ||
              new Set([...documents.keys(), ...uris]).size > typeScriptEditClosureLimits.maxFiles
            )
              return yield* LspFault.make({code: 'capacity'});
            const proof = new Map<string, TypeScriptEditSource>();
            let bytes = 0;
            for (const document of documents.values()) bytes += new TextEncoder().encode(document.text).length;
            if (bytes > typeScriptEditClosureLimits.maxRetainedBytes) return yield* LspFault.make({code: 'capacity'});
            for (const uri of uris) {
              const retained = documents.get(uri);
              if (retained && retained.observation.documentVersion !== null) continue;
              const captured = yield* options.captureEditSource(uri);
              if (
                captured.uri !== uri ||
                sha256HexSync(captured.text) !== captured.content ||
                !wellFormed(captured.text)
              )
                return yield* SemanticSessionFault.make({reason: 'stale'});
              bytes +=
                new TextEncoder().encode(captured.text).length -
                (retained ? new TextEncoder().encode(retained.text).length : 0);
              if (bytes > typeScriptEditClosureLimits.maxRetainedBytes) return yield* LspFault.make({code: 'capacity'});
              proof.set(uri, captured);
              const extension = EffectString.split('.')(new URL(uri).pathname).pop();
              const language =
                extension === 'tsx'
                  ? 'typescriptreact'
                  : extension === 'jsx'
                    ? 'javascriptreact'
                    : extension === 'js' || extension === 'mjs' || extension === 'cjs'
                      ? 'javascript'
                      : 'typescript';
              // Internal disk opens keep disk provenance, even in an owned-buffer provider view.
              yield* upsertUnlocked(
                {...observation, uri, content: captured.content, documentVersion: null, view: observation.view},
                captured.text,
                language,
                yield* remaining,
                true,
              );
            }
            const refreshed = documents.get(observation.uri);
            if (!refreshed?.ready) return stale();
            const finalObservation = structuredClone(refreshed.observation);
            const before = new Map(
              EffectArray.map([...documents], ([uri, doc]) => [
                uri,
                {text: doc.text, wireVersion: doc.wireVersion, observation: structuredClone(doc.observation)},
              ]),
            );
            // Ordered projectInfo runs on the same tsserver queue after every didOpen/didChange.
            const barrier = yield* projectInfo(observation.uri, yield* remaining);
            if (
              barrier.configuration !== initial.project?.configuration ||
              JSON.stringify(barrier.files) !== JSON.stringify(initial.project.files) ||
              !barrier.files.includes(decodeURIComponent(new URL(observation.uri).pathname))
            )
              return stale();
            const final = yield* request();
            if ('outcome' in final && final.outcome) return final.outcome;
            const finalUris = EffectRecord.keys(final.changes).sort();
            if (EffectArray.some(finalUris, uri => !uris.includes(uri))) {
              discovered = final;
              if (round === 0) continue;
              return yield* SemanticSessionFault.make({reason: 'stale'});
            }
            const files = [];
            let editCount = 0;
            for (const uri of finalUris) {
              const source = before.get(uri);
              const live = documents.get(uri);
              if (
                !source ||
                !live ||
                live.project?.configuration !== barrier.configuration ||
                !barrier.files.includes(decodeURIComponent(new URL(uri).pathname)) ||
                live.wireVersion !== source.wireVersion ||
                source.observation.projectEpoch !== finalObservation.projectEpoch
              )
                return yield* SemanticSessionFault.make({reason: 'stale'});
              const edits = [...final.changes[uri]].sort(
                (a, b) =>
                  a.range.start.line - b.range.start.line ||
                  a.range.start.character - b.range.start.character ||
                  a.range.end.line - b.range.end.line ||
                  a.range.end.character - b.range.end.character,
              );
              if (!edits.length) return yield* invalid();
              for (const edit of edits) {
                if (
                  ++editCount > typeScriptEditClosureLimits.maxEdits ||
                  !validRange(source.text, edit.range) ||
                  !wellFormed(edit.newText)
                )
                  return yield* invalid();
              }
              const captured = proof.get(uri);
              if (captured) {
                const closing = yield* options.captureEditSource(uri);
                if (closing.content !== captured.content || closing.identity !== captured.identity)
                  return yield* SemanticSessionFault.make({reason: 'stale'});
              }
              files.push({
                uri,
                content: source.observation.content,
                documentVersion: source.observation.documentVersion,
                source: source.observation.documentVersion === null ? 'disk' : 'overlay',
                beforeText: source.text,
                ...(operation === 'code-action' && 'versions' in final
                  ? {providerDocumentVersion: final.versions[uri]}
                  : {}),
                observation: source.observation,
                precondition: {
                  sourceKind: source.observation.documentVersion === null ? 'disk' : 'overlay',
                  rawDigest: source.observation.content,
                  encoding: 'utf-8',
                  physicalIdentity: captured?.identity ?? null,
                  owner: source.observation.view.owner,
                  documentVersion: source.observation.documentVersion,
                },
                edits,
              });
            }
            const closingProject = yield* projectInfo(observation.uri, yield* remaining);
            yield* policy(yield* remaining);
            if (
              !current(finalObservation) ||
              closingProject.configuration !== barrier.configuration ||
              JSON.stringify(closingProject.files) !== JSON.stringify(barrier.files)
            )
              return stale();
            return {
              version: 1,
              status: 'ok',
              evidence: evidence(finalObservation),
              items: [
                {
                  kind: 'prepared-edit',
                  operation,
                  files,
                  ...(operation === 'code-action' && 'preview' in final
                    ? {
                        qualification: 'qualified-text-only',
                        operations: EffectArray.map(final.preview.operations, op =>
                          op.kind === 'text' ? {...op, target: finalUris.indexOf(op.uri)} : op,
                        ),
                        ...(final.preview.changeAnnotations
                          ? {changeAnnotations: final.preview.changeAnnotations}
                          : {}),
                      }
                    : {}),
                  scope: 'all-provider-returned-edits',
                  applied: false,
                  sourceBasis: 'pre-request-synchronized-text-v1',
                },
              ],
            } satisfies QueryOutcome;
          }
          return stale();
        }),
      );
    });
  return {
    upsert,
    prepare,
    actions: (
      observation: Observation,
      query: SemanticActionQuery,
      milliseconds: number,
      selection?: SemanticActionSelection,
    ) => prepare('code-action', observation, query.range.start, undefined, milliseconds, query, selection),
    verifyPolicy: policy(2000),
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
