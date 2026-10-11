import {Context, Effect, Exit, FileSystem, Layer, Option, Path, Semaphore, Schema} from 'effect';
import {Language, Parser, Query, type Node} from 'web-tree-sitter';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromise} from '@threadnote/platform/errors';
import {SystemInfo} from '@threadnote/platform/system';
import {toolRoot} from '@threadnote/workspace/installation';
import type {VerifiedLanguageAsset} from '../languages/types.js';

const RUNTIME_RELATIVE_PATH = 'runtime/web-tree-sitter.wasm';
const RUNTIME_SHA256 = 'beca80e44cccbf2299ed4d1e3fa6462a9a6fe818aeebf847547a392227ce4acc';
export const TREE_SITTER_RUNTIME_CACHE_IDENTITY = `web-tree-sitter:0.27.1:${RUNTIME_SHA256}`;

export interface ParsedTreeSitterSource {
  readonly language: Language;
  readonly query: (source: string) => Query;
  readonly root: Node;
}

export interface TreeSitterRuntimeShape {
  readonly withParsedSource: <A>(
    asset: VerifiedLanguageAsset,
    source: string,
    use: (parsed: ParsedTreeSitterSource) => A,
  ) => Effect.Effect<A, TreeSitterRuntimeError>;
}

export class TreeSitterRuntime extends Context.Service<TreeSitterRuntime, TreeSitterRuntimeShape>()(
  '@threadnote/graph/tree_sitter/runtime/TreeSitterRuntime',
) {
  static readonly layer = Layer.effect(
    TreeSitterRuntime,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const configuredRoot = system.environment().THREADNOTE_CODE_GRAPH_ASSET_ROOT?.trim();
      const root = yield* toolRoot();
      const assetRoot = configuredRoot ? path.resolve(configuredRoot) : path.join(root, 'assets', 'code-graph');
      const runtimePath = path.join(assetRoot, RUNTIME_RELATIVE_PATH);
      const initialization = yield* Effect.cached(
        verifyAsset(fs, runtimePath, RUNTIME_SHA256, 'Tree-sitter runtime').pipe(
          Effect.andThen(
            fromPromise('initialize tree-sitter parser', () => Parser.init({locateFile: () => runtimePath})),
          ),
          Effect.mapError(cause =>
            Schema.is(TreeSitterRuntimeError)(cause)
              ? cause
              : TreeSitterRuntimeError.make({cause, message: 'Could not initialize the Tree-sitter WASM runtime.'}),
          ),
        ),
      );
      const languages = new Map<string, Effect.Effect<Language, TreeSitterRuntimeError>>();
      const queries = new Map<string, Query>();
      const languageCacheLock = yield* Semaphore.make(1);

      const loadLanguage = (asset: VerifiedLanguageAsset) =>
        languageCacheLock
          .withPermit(
            Effect.gen(function* () {
              const existing = languages.get(asset.relativePath);
              if (existing) return {loading: existing};
              const installedLanguagePath = path.join(assetRoot, asset.relativePath);
              const installedLanguageExists = yield* fs.exists(installedLanguagePath).pipe(
                Effect.mapError(cause =>
                  TreeSitterRuntimeError.make({
                    cause,
                    message: `Could not inspect grammar asset ${installedLanguagePath}.`,
                  }),
                ),
              );
              const languagePath =
                !configuredRoot && asset.developmentRelativePath !== undefined && !installedLanguageExists
                  ? path.join(root, asset.developmentRelativePath)
                  : installedLanguagePath;
              const loading = yield* Effect.cached(
                initialization.pipe(
                  Effect.andThen(verifyAsset(fs, languagePath, asset.sha256, `${asset.version} grammar`)),
                  Effect.andThen(fromPromise('load tree-sitter language', () => Language.load(languagePath))),
                  Effect.mapError(cause =>
                    Schema.is(TreeSitterRuntimeError)(cause)
                      ? cause
                      : TreeSitterRuntimeError.make({cause, message: `Could not load grammar ${asset.relativePath}.`}),
                  ),
                ),
              );
              languages.set(asset.relativePath, loading);
              return {loading};
            }),
          )
          .pipe(
            Effect.flatMap(({loading}) =>
              loading.pipe(
                Effect.onExit(exit =>
                  Exit.isFailure(exit)
                    ? Effect.sync(() => {
                        if (languages.get(asset.relativePath) === loading) languages.delete(asset.relativePath);
                      })
                    : Effect.void,
                ),
              ),
            ),
          );

      return TreeSitterRuntime.of({
        withParsedSource: (asset, source, use) =>
          Effect.gen(function* () {
            const language = yield* loadLanguage(asset);
            return yield* Effect.try({
              try: () => {
                const parser = new Parser();
                try {
                  parser.setLanguage(language);
                  const tree = Option.fromNullishOr(parser.parse(source));
                  if (Option.isNone(tree))
                    throw TreeSitterRuntimeError.make({message: 'Tree-sitter did not return a syntax tree.'});
                  try {
                    return use({
                      language,
                      query: querySource => {
                        const key = `${asset.relativePath}\0${querySource}`;
                        const existing = queries.get(key);
                        if (existing !== undefined) return existing;
                        const compiled = new Query(language, querySource);
                        queries.set(key, compiled);
                        return compiled;
                      },
                      root: tree.value.rootNode,
                    });
                  } finally {
                    tree.value.delete();
                  }
                } finally {
                  parser.delete();
                }
              },
              catch: cause =>
                Schema.is(TreeSitterRuntimeError)(cause)
                  ? cause
                  : TreeSitterRuntimeError.make({cause, message: 'Tree-sitter parsing failed.'}),
            });
          }),
      });
    }),
  );
}

export class TreeSitterRuntimeError extends Schema.TaggedError<TreeSitterRuntimeError>()('TreeSitterRuntimeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

function verifyAsset(
  fs: FileSystem.FileSystem,
  assetPath: string,
  expectedSha256: string,
  label: string,
): Effect.Effect<void, TreeSitterRuntimeError> {
  return fs.readFile(assetPath).pipe(
    Effect.flatMap(bytes => {
      const actual = sha256HexSync(bytes);
      return actual === expectedSha256
        ? Effect.void
        : Effect.fail(
            TreeSitterRuntimeError.make({
              message: `${label} checksum mismatch at ${assetPath}: expected ${expectedSha256}, received ${actual}.`,
            }),
          );
    }),
    Effect.mapError(cause =>
      Schema.is(TreeSitterRuntimeError)(cause)
        ? cause
        : TreeSitterRuntimeError.make({cause, message: `Could not verify ${label} at ${assetPath}.`}),
    ),
  );
}
