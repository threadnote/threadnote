import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Crypto, Deferred, Effect, Exit, FileSystem, Option, Path, Schema} from 'effect';
import {
  canonicalFileUri,
  FileUri,
  observationKey,
  type Observation,
  type QueryOutcome,
} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LspFault, type LspClient} from '../lsp_transport.js';
import {
  makeLspSession,
  SemanticSessionFault,
  validRange,
  wellFormed,
  type LspSessionClient,
  type LspSessionOptions,
} from '../provider.js';
import {readBounded} from '../fingerprint.js';
import {
  materializeJavaDiagnosticBundle,
  requestJavaDiagnostics,
  requestJavaTypeDefinition,
  type JavaDiagnosticModel,
} from './java_diagnostics.js';
import {javaDiagnosticBundle} from './java_diagnostics_bundle.js';
import {captureJavaSnapshotModel, javaTypeDefinitionCommand, javaFileUri} from './java_snapshot.js';
import {makeJavaProject} from './java_project.js';

class JavaSourceTargetFault extends Schema.TaggedError<JavaSourceTargetFault, {readonly brand: unique symbol}>()(
  'JavaSourceTargetFault',
  {},
) {}
const unsupported = () => JavaSourceTargetFault.make({});
const protocol = () => LspFault.make({code: 'protocol'});
const object = (value: Schema.Json): value is Record<string, Schema.Json> =>
  value !== null && typeof value === 'object' && !EffectArray.isArray<Schema.Json>(value);
const limitations = [
  'Experimental Java 21 prepared offline Maven/Gradle profile',
  'Selected source roots and pinned binary dependencies only; virtual/library source targets unsupported',
  'Builds, imports, annotation processors, dependency acquisition and provider commands disabled during analysis',
  'Only complete edit-only actions are returned; command, resource and unqualified-source actions are omitted',
];

/** Canonical source spelling is selected by root/file identity, never by case folding or a whole-tree alias inventory. */
export const makeJavaSourceUri = Effect.fn('semantic.makeJavaSourceUri')(function* (sourceRoots: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const identity = (info: FileSystem.File.Info) =>
    Option.map(info.ino, ino => `${info.dev}:${ino}`).pipe(Option.getOrUndefined);
  if (sourceRoots.length < 1 || sourceRoots.length > 32) return yield* unsupported();
  const roots = yield* Effect.forEach(sourceRoots, directory =>
    Effect.gen(function* () {
      const info = yield* fs.stat(directory);
      const id = identity(info);
      if (
        !path.isAbsolute(directory) ||
        path.resolve(directory) !== directory ||
        (yield* fs.realPath(directory)) !== directory ||
        info.type !== 'Directory' ||
        !id
      )
        return yield* unsupported();
      return {directory, id};
    }),
  );
  if (new Set(EffectArray.map(roots, root => root.id)).size !== roots.length) return yield* unsupported();
  for (const [index, root] of roots.entries())
    if (
      EffectArray.some(
        roots.slice(index + 1),
        other =>
          EffectString.startsWith(root.directory + path.sep)(other.directory) ||
          EffectString.startsWith(other.directory + path.sep)(root.directory),
      )
    )
      return yield* unsupported();
  return (uri: string) =>
    Effect.gen(function* () {
      if (uri.length > 8192 || !wellFormed(uri) || /\p{Cc}/u.test(uri)) return yield* unsupported();
      const encoded = yield* Effect.try({try: () => canonicalFileUri(uri), catch: unsupported});
      if (!Schema.is(FileUri)(encoded)) return yield* unsupported();
      const file = yield* path.fromFileUrl(new URL(encoded));
      if (path.resolve(file) !== file || EffectString.split(path.sep)(file).includes('.git'))
        return yield* unsupported();
      const info = yield* fs.stat(file);
      const id = identity(info);
      if (info.type !== 'File' || !id) return yield* unsupported();
      let ancestor = path.dirname(file);
      for (let depth = 0; depth < 128; depth++) {
        const parent = yield* fs.stat(ancestor);
        const root = EffectArray.findFirst(roots, root => root.id === identity(parent));
        if (Option.isSome(root)) {
          const selected = root.value;
          const relative = path.relative(ancestor, file);
          const canonical = path.join(selected.directory, relative);
          if (
            parent.type !== 'Directory' ||
            !EffectString.startsWith(selected.directory + path.sep)(canonical) ||
            (yield* fs.realPath(selected.directory)) !== selected.directory ||
            identity(yield* fs.stat(selected.directory)) !== selected.id ||
            (yield* fs.realPath(canonical)) !== canonical ||
            identity(yield* fs.stat(canonical)) !== id ||
            identity(yield* fs.stat(file)) !== id
          )
            return yield* unsupported();
          return javaFileUri(yield* path.toFileUrl(canonical));
        }
        const next = path.dirname(ancestor);
        if (next === ancestor) break;
        ancestor = next;
      }
      return yield* unsupported();
    }).pipe(
      Effect.catchTag('PlatformError', fault => Effect.fail(fault.reason._tag === 'NotFound' ? unsupported() : fault)),
    );
});

/** Only protocol source-location slots change. Opaque data, documentation and provider commands retain their bytes. */
export const mapJavaSourceResponse = Effect.fn('semantic.mapJavaSourceResponse')(function* (
  method: string,
  response: Schema.Json,
  sourceUri: (uri: string) => Effect.Effect<string, unknown>,
) {
  let count = 0;
  const mapped = new Map<string, string>();
  const uri = (value: Schema.Json) =>
    Effect.gen(function* () {
      if (typeof value !== 'string') return yield* protocol();
      const previous = mapped.get(value);
      if (previous !== undefined) return previous;
      if (++count > 8192) return yield* LspFault.make({code: 'capacity'});
      const canonical = yield* sourceUri(value);
      mapped.set(value, canonical);
      return canonical;
    });
  const location = (value: Schema.Json) =>
    Effect.gen(function* () {
      if (!object(value)) return value;
      if ('uri' in value) return {...value, uri: yield* uri(value.uri)};
      if ('targetUri' in value) return {...value, targetUri: yield* uri(value.targetUri)};
      return value;
    });
  const list = (value: Schema.Json, map: (item: Schema.Json) => Effect.Effect<Schema.Json, unknown>) =>
    EffectArray.isArray<Schema.Json>(value) ? Effect.forEach(value, map) : map(value);
  const edit = (value: Schema.Json) =>
    Effect.gen(function* () {
      if (!object(value)) return value;
      const result = {...value};
      const originalChanges = value.changes;
      if (originalChanges !== undefined && object(originalChanges)) {
        const changes: Record<string, Schema.Json> = {};
        for (const [target, edits] of EffectRecord.toEntries(originalChanges)) {
          const canonical = yield* uri(target);
          if (EffectRecord.has(changes, canonical)) return yield* unsupported();
          changes[canonical] = edits;
        }
        result.changes = changes;
      }
      if (EffectArray.isArray<Schema.Json>(value.documentChanges))
        result.documentChanges = yield* Effect.forEach(value.documentChanges, change =>
          Effect.gen(function* () {
            if (!object(change) || 'kind' in change) return yield* unsupported();
            const document = change.textDocument;
            if (document === undefined || !object(document)) return yield* unsupported();
            return {...change, textDocument: {...document, uri: yield* uri(document.uri)}};
          }),
        );
      return result;
    });
  if (
    [
      'textDocument/definition',
      'textDocument/references',
      'textDocument/implementation',
      'textDocument/typeDefinition',
      'textDocument/prepareCallHierarchy',
      'textDocument/prepareTypeHierarchy',
      'typeHierarchy/supertypes',
      'typeHierarchy/subtypes',
    ].includes(method)
  )
    return yield* list(response, location);
  if (method === 'callHierarchy/incomingCalls' || method === 'callHierarchy/outgoingCalls') {
    const key = method === 'callHierarchy/incomingCalls' ? 'from' : 'to';
    return yield* list(response, value =>
      Effect.gen(function* () {
        return object(value) && key in value ? {...value, [key]: yield* location(value[key])} : value;
      }),
    );
  }
  if (method === 'textDocument/documentSymbol')
    return yield* list(response, value =>
      Effect.gen(function* () {
        return object(value) && 'location' in value ? {...value, location: yield* location(value.location)} : value;
      }),
    );
  if (method === 'textDocument/rename') return yield* edit(response);
  if (method === 'textDocument/codeAction')
    return yield* list(response, value =>
      Effect.gen(function* () {
        if (!object(value) || !('edit' in value) || 'command' in value || 'disabled' in value) return value;
        return yield* edit(value.edit).pipe(
          Effect.map(mappedEdit => ({...value, edit: mappedEdit})),
          Effect.catchIf(Schema.is(JavaSourceTargetFault), () =>
            Effect.succeed({
              ...value,
              disabled: {reason: 'This complete action requires an unqualified source or resource operation'},
            }),
          ),
        );
      }),
    );
  return response;
});

export interface JavaSessionOptions extends Omit<LspSessionOptions, 'policy' | 'ready'> {
  readonly prepared: Effect.Success<ReturnType<typeof makeJavaProject>>;
  readonly bundle: Effect.Success<ReturnType<typeof materializeJavaDiagnosticBundle>>;
  readonly diagnosticModel: JavaDiagnosticModel;
  readonly runtime: {
    readonly verify: Effect.Effect<void, unknown>;
    readonly projectJavaHome: string;
  };
}
/** The shared session alone owns documents, versions and epochs; Java adds readiness and checked URI translation. */
export const makeJavaSession = Effect.fn('semantic.makeJavaSession')(
  function* (client: LspClient, options: JavaSessionOptions) {
    const diagnosticModel = captureJavaSnapshotModel(options.diagnosticModel);
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const serviceReady = yield* Deferred.make<void, LspFault>();
    const basis = structuredClone(options.basis);
    const settings = structuredClone(options.prepared.settings);
    if (diagnosticModel.javaHomeUri !== javaFileUri(yield* path.toFileUrl(options.runtime.projectJavaHome + path.sep)))
      return yield* LspFault.make({code: 'prerequisite'});
    const sourceUri = yield* makeJavaSourceUri(options.prepared.sourceRoots);
    let retire: Effect.Effect<void> = Effect.void;
    // Full SDK reads bound public operations; source and project checks also guard each transport exchange.
    const sourceVerify = Effect.all([options.prepared.verify, options.bundle.verify]).pipe(
      Effect.asVoid,
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.onExit(exit => (Exit.isFailure(exit) ? retire : Effect.void)),
    );
    const verify = options.runtime.verify.pipe(
      Effect.andThen(sourceVerify),
      Effect.onExit(exit => (Exit.isFailure(exit) ? retire : Effect.void)),
    );
    const mapped: LspSessionClient = {
      ...client,
      request: (method, params, milliseconds) =>
        Effect.gen(function* () {
          yield* sourceVerify;
          const response = yield* Effect.exit(
            client
              .request(method, params, milliseconds)
              .pipe(Effect.flatMap(result => mapJavaSourceResponse(method, result, sourceUri))),
          );
          yield* sourceVerify;
          return yield* response;
        }).pipe(
          Effect.timeoutOption(milliseconds),
          Effect.flatMap(result =>
            Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
          ),
        ),
      notify: (method, params) =>
        client
          .notify(method, params)
          .pipe(
            Effect.andThen(
              method === 'initialized' ? client.notify('workspace/didChangeConfiguration', {settings}) : Effect.void,
            ),
          ),
    };
    yield* verify;
    const session = yield* makeLspSession(mapped, {
      ...options,
      basis,
      ready: sourceVerify,
      policy: {
        language: 'java',
        documentLimits: {maxDocuments: 128, maxTextLength: 2 * 1024 * 1024, maxTotalTextLength: 8 * 1024 * 1024},
        workspaceName: 'threadnote-private-java21',
        acceptsServer: server =>
          server?.name === 'JDT Language Server (Standard)' && server.version === '1.63.0-SNAPSHOT',
        limitations,
        initializationRoot: (yield* path.toFileUrl(options.prepared.project)).href,
        initializationOptions: {
          settings,
          bundles: [options.bundle.file],
          extendedClientCapabilities: {classFileContentsSupport: false, progressReportProvider: true},
        },
        requiredCommands: [javaDiagnosticBundle.command, javaTypeDefinitionCommand],
        // Finish the Java fence before the shared session advances its diagnostic sequence/delivery cursor.
        requestDiagnostics: (request, milliseconds) =>
          requestJavaDiagnostics(
            client,
            diagnosticModel,
            sourceVerify,
          )(request, milliseconds).pipe(Effect.tap(() => verify)),
        requestTypeDefinition: (request, position, milliseconds) =>
          Effect.gen(function* () {
            const result = yield* requestJavaTypeDefinition(client, diagnosticModel, sourceVerify)(
              request,
              position,
              milliseconds,
            );
            if (result.status === 'unsupported') return yield* unsupported();
            const uri = yield* sourceUri(result.location.uri);
            const input = EffectArray.findFirst(request.inputs, input => input.uri === uri);
            let text: string;
            if (Option.isSome(input)) text = input.value.text;
            else {
              const file = yield* path.fromFileUrl(new URL(uri));
              const bytes = yield* readBounded(file, 4 * 1024 * 1024).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              );
              text = yield* Effect.try({
                try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
                catch: protocol,
              });
            }
            if (
              sha256HexSync(text) !== result.location.contentSha256 ||
              text.length !== result.location.utf16Length ||
              !validRange(text, result.location.range)
            )
              return yield* protocol();
            return [{uri, range: result.location.range}];
          }),
        receive: (method, params) => {
          if (method !== 'language/status' || !Schema.is(Schema.Struct({type: Schema.String}))(params)) return;
          if (params.type === 'ServiceReady') Deferred.doneUnsafe(serviceReady, Effect.void);
          if (params.type === 'Error') Deferred.doneUnsafe(serviceReady, LspFault.make({code: 'prerequisite'}));
        },
      },
    });
    retire = session.invalidate;
    yield* Deferred.await(serviceReady);
    yield* verify;
    const targets = (
      observation: Observation,
      milliseconds: number,
      operation: (fixed: Observation) => Effect.Effect<QueryOutcome, unknown>,
    ) =>
      Effect.gen(function* () {
        const fixed = structuredClone(observation);
        yield* verify;
        const completed = yield* operation(fixed).pipe(
          Effect.catchIf(Schema.is(JavaSourceTargetFault), () =>
            Effect.gen(function* () {
              const current = yield* session.observation(fixed.uri);
              if (!current || observationKey(current) !== observationKey(fixed))
                return {
                  version: 1,
                  status: 'stale',
                  reason: 'Source view or analysis basis changed',
                  evidence: null,
                } satisfies QueryOutcome;
              return {
                version: 1,
                status: 'unsupported',
                reason:
                  'Provider returned a virtual, ambiguous or unqualified source target; the complete result was refused',
                evidence: {
                  basis: 'semantic',
                  observation: fixed,
                  scope: 'project:' + sha256HexSync(basis.project + basis.toolchain),
                  completeness: 'partial',
                  limitations,
                },
              } satisfies QueryOutcome;
            }),
          ),
          Effect.exit,
        );
        yield* verify;
        const result = yield* completed;
        if (result.status === 'stale') return result;
        const current = yield* session.observation(fixed.uri);
        return current && observationKey(current) === observationKey(fixed)
          ? result
          : ({
              version: 1,
              status: 'stale',
              reason: 'Source view or analysis basis changed',
              evidence: null,
            } satisfies QueryOutcome);
      }).pipe(
        Effect.timeoutOption(milliseconds),
        Effect.flatMap(result =>
          Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
        ),
      );
    return {
      ...session,
      upsert: (...args: Parameters<typeof session.upsert>) =>
        Effect.gen(function* () {
          const fixed = structuredClone(args[0]);
          yield* verify;
          const completed = yield* Effect.exit(session.upsert(fixed, args[1], args[2], args[3]));
          yield* verify;
          const result = yield* completed;
          const current = yield* session.observation(result.uri);
          if (!current || observationKey(current) !== observationKey(result))
            return yield* SemanticSessionFault.make({reason: 'stale'});
          return result;
        }).pipe(
          Effect.timeoutOption(args[3]),
          Effect.flatMap(result =>
            Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
          ),
        ),
      diagnostics: (...args: Parameters<typeof session.diagnostics>) =>
        Effect.gen(function* () {
          const fixed = structuredClone(args[0]);
          yield* verify;
          // Failure has not committed a delivered delta; success must return without another asynchronous fence.
          return yield* session
            .diagnostics(fixed, args[1])
            .pipe(Effect.catchCause(cause => verify.pipe(Effect.andThen(Effect.failCause(cause)))));
        }).pipe(
          Effect.timeoutOption(args[1]),
          Effect.flatMap(result =>
            Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
          ),
        ),
      query: (...args: Parameters<typeof session.query>) =>
        Effect.suspend(() => {
          const position = structuredClone(args[2]);
          return targets(args[1], args[3], fixed => session.query(args[0], fixed, position, args[3]));
        }),
      prepare: (...args: Parameters<typeof session.prepare>) =>
        Effect.suspend(() => {
          const position = structuredClone(args[2]);
          return targets(args[1], args[4], fixed =>
            session.prepare(args[0], fixed, position, args[3], args[4]).pipe(
              Effect.map(result =>
                args[0] === 'code-action' && result.status === 'ok' && result.items.length === 0
                  ? ({
                      version: 1,
                      status: 'unsupported',
                      reason: 'No complete qualified edit-only Java action is available',
                      evidence: result.evidence,
                    } satisfies QueryOutcome)
                  : result,
              ),
            ),
          );
        }),
    };
  },
  (effect, _client, options) =>
    effect.pipe(
      Effect.timeoutOption(options.startupMilliseconds),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    ),
);
