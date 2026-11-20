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
export const JavaCompilerOptions = Schema.Record(
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
const ProjectionText = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter(wellFormed),
  Schema.isPattern(/^[^\p{Cc}\uFFFE\uFFFF]*$/u),
);
const ProjectionEntry = Schema.Struct({
  kind: Schema.Literals([1, 3, 5]),
  contentKind: Schema.Literals([1, 2]),
  path: ProjectionText,
  exported: Schema.Boolean,
  combineAccessRules: Schema.Boolean,
  inclusions: Schema.Array(ProjectionText).check(Schema.isMaxLength(128)),
  exclusions: Schema.Array(ProjectionText).check(Schema.isMaxLength(128)),
  attributes: Schema.Array(
    Schema.Union([
      Schema.Struct({name: ProjectionText, value: ProjectionText}),
      Schema.Struct({
        name: Schema.Literal('javadoc_location'),
        valueSha256: Digest,
        access: Schema.Literal('disabled'),
      }),
    ]),
  ).check(Schema.isMaxLength(32)),
  accessRules: Schema.Array(
    Schema.Struct({pattern: ProjectionText, kind: Schema.Literals([0, 1, 2]), ignoreIfBetter: Schema.Boolean}),
  ).check(Schema.isMaxLength(32)),
  outputPath: Schema.optional(ProjectionText),
  sourceAttachmentPath: Schema.optional(ProjectionText),
  sourceAttachmentRoot: Schema.optional(ProjectionText),
});
/** Actual passive Eclipse metadata, observed inside a genuine source snapshot rather than a model-only command. */
export const JavaProjectionImage = Schema.Struct({
  format: Schema.Literal('threadnote-passive-java-projection-v1'),
  projectCharset: Schema.Literal('UTF-8'),
  outputPath: ProjectionText,
  rawClasspath: Schema.Array(ProjectionEntry).check(Schema.isBetweenLength(1, 162)),
  resolvedClasspath: Schema.Array(ProjectionEntry).check(Schema.isBetweenLength(1, 512)),
  links: Schema.Array(Schema.Struct({path: ProjectionText, uri: ProjectionText, type: Schema.Literal(2)})).check(
    Schema.isBetweenLength(1, 32),
  ),
  resourceFilters: Schema.Array(
    Schema.Struct({
      id: ProjectionText,
      path: Schema.Literal(''),
      type: Schema.Literal(30),
      matcherId: Schema.Literal('org.eclipse.core.resources.regexFilterMatcher'),
      arguments: ProjectionText,
    }),
  ).check(Schema.isMaxLength(1)),
});
const projectionFrame = (value: unknown): string => {
  if (value === null) return 'z';
  if (typeof value === 'string') return 's' + value.length + ':' + value;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return 'n' + value + ';';
  if (EffectArray.isArray(value))
    return 'a' + value.length + ':[' + EffectArray.join(EffectArray.map(value, projectionFrame), '') + ']';
  if (Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value)) {
    const fields = EffectRecord.toEntries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      'o' +
      fields.length +
      ':[' +
      EffectArray.join(
        EffectArray.map(fields, ([key, field]) => projectionFrame(key) + projectionFrame(field)),
        '',
      ) +
      ']'
    );
  }
  throw protocol();
};
/** UTF-16 length framing agrees with the pinned JVM; object keys sort, semantic arrays retain their order. */
export const javaProjectionDigest = (image: typeof JavaProjectionImage.Type) => {
  const framed = 'threadnote-java-passive-projection-v1\n' + projectionFrame(image);
  if (framed.length > 2 * 1024 * 1024) throw protocol();
  return sha256HexSync(framed);
};
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
    compilerOptions: JavaCompilerOptions,
    annotationProcessing: Schema.Literal('disabled-for-snapshot'),
    projection: Schema.optional(JavaProjectionImage),
  }),
  inputs: Schema.Array(Input).check(Schema.isBetweenLength(1, 128)),
});
export interface JavaSnapshotModel {
  readonly projectUri: string;
  readonly javaHomeUri: string;
  readonly sourceRoots: readonly string[];
  readonly libraries: readonly string[];
  readonly compilerOptions?: Readonly<Record<string, string>>;
  readonly projectionDigest?: string;
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
    ...(model.projectionDigest === undefined ? {} : {projectionDigest: model.projectionDigest}),
  });
}

/** Java Path.toUri retains literal tildes; Bun's physical file URL conversion percent-encodes them. */
export function javaFileUri(url: URL): string {
  return EffectString.replaceAll('%7E', '~')(url.href);
}
/** Match Java Path.toUri: directory identities end in '/', while classpath artifact identities do not. */
export const makeJavaSnapshotModel = Effect.fn('semantic.makeJavaSnapshotModel')(function* (options: {
  readonly project: string;
  readonly javaHome: string;
  readonly sourceRoots: readonly string[];
  readonly libraries: readonly string[];
  readonly compilerOptions?: Readonly<Record<string, string>>;
  readonly projectionDigest?: string;
}) {
  const selected = {...options, sourceRoots: [...options.sourceRoots], libraries: [...options.libraries]};
  const compilerOptions =
    selected.compilerOptions === undefined
      ? undefined
      : Object.freeze(yield* Schema.decodeEffect(JavaCompilerOptions)({...selected.compilerOptions}));
  const projectionDigest =
    selected.projectionDigest === undefined ? undefined : yield* Schema.decodeEffect(Digest)(selected.projectionDigest);
  if (projectionDigest !== undefined && compilerOptions === undefined) return yield* protocol();
  const path = yield* Path.Path;
  const directoryUri = (directory: string) =>
    path
      .toFileUrl(EffectString.endsWith(path.sep)(directory) ? directory : directory + path.sep)
      .pipe(Effect.map(javaFileUri));
  return captureJavaSnapshotModel({
    projectUri: yield* directoryUri(selected.project),
    javaHomeUri: yield* directoryUri(selected.javaHome),
    sourceRoots: yield* Effect.forEach(selected.sourceRoots, directoryUri),
    libraries: yield* Effect.forEach(selected.libraries, file => path.toFileUrl(file).pipe(Effect.map(javaFileUri))),
    ...(compilerOptions === undefined ? {} : {compilerOptions}),
    ...(projectionDigest === undefined ? {} : {projectionDigest}),
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
    (model.projectionDigest !== undefined && model.compilerOptions === undefined) ||
    !same(report.model.sourceRoots, model.sourceRoots) ||
    !same(report.model.libraries, model.libraries) ||
    (model.projectionDigest === undefined
      ? report.model.projection !== undefined
      : report.model.projection === undefined ||
        javaProjectionDigest(report.model.projection) !== model.projectionDigest) ||
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
        model.projectionDigest !== undefined &&
        (!Schema.is(Digest)(model.projectionDigest) || model.compilerOptions === undefined)
      )
        return yield* LspFault.make({code: 'prerequisite'});
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
      const report = yield* Effect.exit(
        client.request(
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
        ),
      );
      yield* verify;
      return yield* report;
    }).pipe(
      Effect.timeoutOption(milliseconds),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    );
};
