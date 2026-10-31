import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Digest, FileUri, Position} from '@threadnote/semantic/contracts';
import {boundedFileDigest} from '../fingerprint.js';
import {LspFault, type LspClient} from '../lsp_transport.js';
import {SemanticRange, validRange, wellFormed, type LspDiagnosticRequest} from '../provider.js';
import {javaDiagnosticBundle} from './java_diagnostics_bundle.js';
import {
  JavaSnapshotHeader,
  assertJavaSnapshotHeader,
  captureJavaSnapshotModel,
  requestJavaSnapshot,
  type JavaSnapshotModel as JavaDiagnosticModel,
} from './java_snapshot.js';
export {
  makeJavaSnapshotModel as makeJavaDiagnosticModel,
  type JavaSnapshotModel as JavaDiagnosticModel,
} from './java_snapshot.js';

const protocol = () => LspFault.make({code: 'protocol'});
const prerequisite = () => LspFault.make({code: 'prerequisite'});
const NativeDiagnostic = Schema.Struct({
  range: SemanticRange,
  severity: Schema.Literals([1, 2, 3]),
  code: Schema.String.check(Schema.isBetweenLength(1, 32)),
  source: Schema.Literal('Java'),
  message: Schema.String.check(Schema.isMaxLength(16384)),
  data: Schema.Struct({
    arguments: Schema.Array(Schema.String.check(Schema.isMaxLength(16384))).check(Schema.isMaxLength(128)),
  }),
});
const Report = Schema.Struct({
  ...JavaSnapshotHeader.fields,
  diagnostics: Schema.Array(NativeDiagnostic).check(Schema.isMaxLength(4096)),
});
/** Request correlation plus independently observed contents/model; no provider wire version is invented. */
export function readJavaDiagnosticReport(raw: unknown, request: LspDiagnosticRequest, model: JavaDiagnosticModel) {
  const report = Schema.decodeUnknownSync(Report, {onExcessProperty: 'error'})(raw);
  assertJavaSnapshotHeader(report, request, model);
  let characters = 0;
  for (const item of report.diagnostics) {
    if (
      !validRange(request.target.text, item.range) ||
      !wellFormed(item.message) ||
      !EffectArray.every(item.data.arguments, wellFormed)
    )
      throw protocol();
    characters +=
      item.message.length + EffectArray.reduce(item.data.arguments, 0, (size, argument) => size + argument.length);
    if (characters > 1024 * 1024) throw protocol();
  }
  return structuredClone(report.diagnostics);
}

export const requestJavaDiagnostics = (
  client: LspClient,
  model: JavaDiagnosticModel,
  verify: Effect.Effect<void, unknown>,
) => {
  const captured = captureJavaSnapshotModel(model);
  const read = requestJavaSnapshot(client, captured, verify);
  return (request: LspDiagnosticRequest, milliseconds: number) =>
    read(request, milliseconds, {kind: 'diagnostics'}).pipe(
      Effect.flatMap(report =>
        Effect.try({try: () => readJavaDiagnosticReport(report, request, captured), catch: protocol}),
      ),
    );
};

const TypeDefinition = Schema.Struct({
  ...JavaSnapshotHeader.fields,
  position: Position,
  typeDefinition: Schema.Union([
    Schema.Struct({
      status: Schema.Literal('unsupported'),
      reason: Schema.Literals(['no-source-type', 'binary-type', 'unrepresentable-source']),
    }),
    Schema.Struct({
      status: Schema.Literal('source'),
      location: Schema.Struct({
        uri: FileUri,
        range: SemanticRange,
        contentSha256: Digest,
        utf16Length: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2 * 1024 * 1024})),
      }),
    }),
  ]),
});
export function readJavaTypeDefinitionReport(
  raw: unknown,
  request: LspDiagnosticRequest,
  model: JavaDiagnosticModel,
  position: Position,
) {
  const report = Schema.decodeUnknownSync(TypeDefinition, {onExcessProperty: 'error'})(raw);
  assertJavaSnapshotHeader(report, request, model);
  if (report.position.line !== position.line || report.position.character !== position.character) throw protocol();
  return structuredClone(report.typeDefinition);
}
export const requestJavaTypeDefinition = (
  client: LspClient,
  model: JavaDiagnosticModel,
  verify: Effect.Effect<void, unknown>,
) => {
  const captured = captureJavaSnapshotModel(model);
  const read = requestJavaSnapshot(client, captured, verify);
  return (request: LspDiagnosticRequest, position: Position, milliseconds: number) =>
    read(request, milliseconds, {kind: 'type-definition', position}).pipe(
      Effect.flatMap(report =>
        Effect.try({try: () => readJavaTypeDefinitionReport(report, request, captured, position), catch: protocol}),
      ),
    );
};

/** Exact embedded host bundle in the already-admitted private Java directory; no repository bundle discovery. */
export const materializeJavaDiagnosticBundle = Effect.fn('semantic.materializeJavaDiagnosticBundle')(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    (yield* fs.realPath(directory)) !== directory ||
    (yield* fs.stat(directory)).type !== 'Directory' ||
    (yield* fs.stat(directory)).mode & 0o077
  )
    return yield* prerequisite();
  const file = path.join(directory, javaDiagnosticBundle.jarSha256 + '.jar');
  const bytes = Uint8Array.from(atob(javaDiagnosticBundle.jarBase64), character =>
    EffectString.charCodeAt(0)(character).pipe(Option.getOrThrow),
  );
  if (bytes.length > 128 * 1024 || sha256HexSync(bytes) !== javaDiagnosticBundle.jarSha256)
    return yield* prerequisite();
  if (!(yield* fs.exists(file))) yield* fs.writeFile(file, bytes, {flag: 'wx', mode: 0o400});
  const verify = Effect.gen(function* () {
    if (
      (yield* fs.realPath(file)) !== file ||
      (yield* fs.stat(file)).mode & 0o222 ||
      (yield* boundedFileDigest(file, 128 * 1024)) !== javaDiagnosticBundle.jarSha256
    )
      return yield* prerequisite();
  });
  yield* verify;
  return {file, verify, jarSha256: javaDiagnosticBundle.jarSha256};
});
