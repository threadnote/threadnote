import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Effect, Option, Path, Schema} from 'effect';
import {Digest, type Position} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LspFault, type LspClient} from '../lsp_transport.js';
import {validTextPosition, wellFormed, type LspDiagnosticRequest} from '../provider.js';
import {javaDiagnosticBundle} from './java_diagnostics_bundle.js';

const protocol = () => LspFault.make({code: 'protocol'});
export const javaTypeDefinitionCommand = 'threadnote.java.typeDefinitionSnapshot.v1';
const Input = Schema.Struct({
  uri: Schema.String,
  contentSha256: Digest,
  utf16Length: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2 * 1024 * 1024})),
});
const CompilerOptions = Schema.Record(
  Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^org\.eclipse\.jdt\.core\.compiler\./u)),
  Schema.String.check(Schema.isMaxLength(8192), Schema.makeFilter(wellFormed)),
).check(
  Schema.makeFilter(
    options =>
      EffectRecord.keys(options).length <= 2048 &&
      EffectRecord.reduce(options, 0, (characters, value, key) => characters + key.length + value.length) <=
        128 * 1024 &&
      options['org.eclipse.jdt.core.compiler.compliance'] === '21' &&
      options['org.eclipse.jdt.core.compiler.source'] === '21' &&
      options['org.eclipse.jdt.core.compiler.codegen.targetPlatform'] === '21' &&
      options['org.eclipse.jdt.core.compiler.release'] === 'enabled',
  ),
);
export const JavaSnapshotHeader = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestToken: Schema.String.check(Schema.isBetweenLength(1, 128)),
  uri: Schema.String,
  contentSha256: Digest,
  utf16Length: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2 * 1024 * 1024})),
  model: Schema.Struct({
    projectUri: Schema.String,
    javaHomeUri: Schema.String,
    sourceRoots: Schema.Array(Schema.String).check(Schema.isBetweenLength(1, 32)),
    libraries: Schema.Array(Schema.String).check(Schema.isMaxLength(128)),
    compilerOptions: CompilerOptions,
    annotationProcessing: Schema.Literal('disabled-for-snapshot'),
  }),
  inputs: Schema.Array(Input).check(Schema.isBetweenLength(1, 128)),
});
export interface JavaSnapshotModel {
  readonly projectUri: string;
  readonly javaHomeUri: string;
  readonly sourceRoots: readonly string[];
  readonly libraries: readonly string[];
  readonly compilerOptions?: Readonly<Record<string, string>>;
}
/** Snapshot mode, paths and options belong to one admitted request, including when its verification suspends. */
export function captureJavaSnapshotModel(model: JavaSnapshotModel): JavaSnapshotModel {
  const compilerOptions = model.compilerOptions;
  return Object.freeze({
    projectUri: model.projectUri,
    javaHomeUri: model.javaHomeUri,
    sourceRoots: Object.freeze([...model.sourceRoots]),
    libraries: Object.freeze([...model.libraries]),
    ...(compilerOptions === undefined ? {} : {compilerOptions: Object.freeze({...compilerOptions})}),
  });
}
/** Match Java Path.toUri: directory identities end in '/', while classpath artifact identities do not. */
export const makeJavaSnapshotModel = Effect.fn('semantic.makeJavaSnapshotModel')(function* (options: {
  readonly project: string;
  readonly javaHome: string;
  readonly sourceRoots: readonly string[];
  readonly libraries: readonly string[];
  readonly compilerOptions?: Readonly<Record<string, string>>;
}) {
  const selected = {...options, sourceRoots: [...options.sourceRoots], libraries: [...options.libraries]};
  const compilerOptions =
    selected.compilerOptions === undefined
      ? undefined
      : Object.freeze(yield* Schema.decodeEffect(CompilerOptions)({...selected.compilerOptions}));
  const path = yield* Path.Path;
  const directoryUri = (directory: string) =>
    path
      .toFileUrl(EffectString.endsWith(path.sep)(directory) ? directory : directory + path.sep)
      .pipe(Effect.map(uri => uri.href));
  return captureJavaSnapshotModel({
    projectUri: yield* directoryUri(selected.project),
    javaHomeUri: yield* directoryUri(selected.javaHome),
    sourceRoots: yield* Effect.forEach(selected.sourceRoots, directoryUri),
    libraries: yield* Effect.forEach(selected.libraries, file =>
      path.toFileUrl(file).pipe(Effect.map(uri => uri.href)),
    ),
    ...(compilerOptions === undefined ? {} : {compilerOptions}),
  });
});
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && EffectArray.every(a, (value, index) => value === b[index]);

/** All Java snapshot operations bind independently observed source and model identity to the captured request. */
export function assertJavaSnapshotHeader(
  report: typeof JavaSnapshotHeader.Type,
  request: LspDiagnosticRequest,
  model: JavaSnapshotModel,
) {
  if (
    report.requestToken !== request.requestToken ||
    report.uri !== request.target.uri ||
    report.contentSha256 !== sha256HexSync(request.target.text) ||
    report.utf16Length !== request.target.text.length ||
    report.model.projectUri !== model.projectUri ||
    report.model.javaHomeUri !== model.javaHomeUri ||
    !same(report.model.sourceRoots, model.sourceRoots) ||
    !same(report.model.libraries, model.libraries) ||
    (model.compilerOptions !== undefined &&
      (EffectRecord.keys(report.model.compilerOptions).length !== EffectRecord.keys(model.compilerOptions).length ||
        !EffectRecord.every(model.compilerOptions, (value, key) => report.model.compilerOptions[key] === value))) ||
    report.inputs.length !== request.inputs.length
  )
    throw protocol();
  for (const [index, input] of request.inputs.entries()) {
    const observed = report.inputs[index];
    if (
      observed.uri !== input.uri ||
      observed.contentSha256 !== sha256HexSync(input.text) ||
      observed.utf16Length !== input.text.length
    )
      throw protocol();
  }
}

/** Closed compiler reads only. The setup-only project observer has a separate authority and process lifetime. */
export const requestJavaSnapshot = (
  client: LspClient,
  inputModel: JavaSnapshotModel,
  verify: Effect.Effect<void, unknown>,
) => {
  const model = captureJavaSnapshotModel(inputModel);
  return (
    request: LspDiagnosticRequest,
    milliseconds: number,
    operation: {readonly kind: 'diagnostics'} | {readonly kind: 'type-definition'; readonly position: Position},
  ) =>
    Effect.gen(function* () {
      if (
        request.inputs.length === 0 ||
        request.inputs.length > 128 ||
        new Set(EffectArray.map(request.inputs, input => input.uri)).size !== request.inputs.length ||
        !EffectArray.some(
          request.inputs,
          input => input.uri === request.target.uri && input.text === request.target.text,
        )
      )
        return yield* LspFault.make({code: 'prerequisite'});
      let size = 0;
      for (const input of request.inputs) {
        if (!wellFormed(input.text) || input.text.length > 2 * 1024 * 1024)
          return yield* LspFault.make({code: 'capacity'});
        size += input.text.length;
      }
      if (size > 8 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
      if (operation.kind === 'type-definition' && !validTextPosition(request.target.text, operation.position))
        return yield* protocol();
      yield* verify;
      const report = yield* client.request(
        'workspace/executeCommand',
        {
          command: operation.kind === 'diagnostics' ? javaDiagnosticBundle.command : javaTypeDefinitionCommand,
          arguments: [
            {
              protocolVersion: 1,
              requestToken: request.requestToken,
              uri: request.target.uri,
              ...model,
              inputs: EffectArray.map(request.inputs, input => ({
                uri: input.uri,
                contentSha256: sha256HexSync(input.text),
                utf16Length: input.text.length,
              })),
              ...(operation.kind === 'type-definition' ? {position: operation.position} : {}),
            },
          ],
        },
        milliseconds,
      );
      yield* verify;
      return report;
    }).pipe(
      Effect.timeoutOption(milliseconds),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    );
};
