import {Array as EffectArray} from 'effect';
import {Context, Effect, Layer, Option} from 'effect';
import {createCachedCodeGraphContractHash} from '../cached_contract_hash.js';
import {CODE_GRAPH_PARSER_FACTS_VERSION} from '../fact/budget.js';
import {BUILTIN_CODE_GRAPH_LANGUAGE_PACKS} from './catalog.generated.js';
import {
  CodeGraphLanguagePackError,
  type CodeGraphExtractionContext,
  type CodeGraphFileMatcher,
  type CodeGraphLanguageMatch,
  type CodeGraphLanguagePack,
  type CodeGraphWorkspace,
  type CodeGraphWorkspaceProject,
} from './types.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';
import type {CodeGraphLanguagePackProvenance} from '../store/models.js';
import {TREE_SITTER_RUNTIME_CACHE_IDENTITY, type TreeSitterRuntime} from '../tree_sitter/runtime.js';
import {mergeCodeGraphWorkspaces, projectForPath} from '../workspace.js';
import {isXcodeAssetContentsPath} from './schemas/policy.js';
import {
  augmentRationaleFacts,
  captureRationaleInputs,
  CODE_GRAPH_RATIONALE_EXTRACTOR_VERSION,
  CODE_GRAPH_RATIONALE_INPUT_VERSION,
} from '../rationale.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {CODE_GRAPH_PARSER_FACTS_VERSION} from '../fact/budget.js';

const cacheIdentityHash = createCachedCodeGraphContractHash();
const derivationIdentityHash = createCachedCodeGraphContractHash();
const basenamePatterns = new Map<string, RegExp>();

export interface CodeGraphLanguagePackRegistryShape {
  readonly activeCacheIdentities: (paths: readonly string[]) => readonly string[];
  readonly activeDerivationIdentities: (paths: readonly string[]) => readonly string[];
  readonly activePackProvenance: (paths: readonly string[]) => readonly CodeGraphLanguagePackProvenance[];
  readonly cacheIdentities: readonly string[];
  readonly cacheIdentityForPath: (path: string) => Option.Option<string>;
  readonly discoverWorkspace: (
    files: readonly CodeGraphInventoryFile[],
  ) => Effect.Effect<CodeGraphWorkspace, CodeGraphLanguagePackError>;
  readonly extractFile: (
    file: CodeGraphInventoryFile,
    projects?: readonly CodeGraphWorkspaceProject[],
  ) => Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime>;
  readonly extractRawFile: (
    file: CodeGraphInventoryFile,
    projects?: readonly CodeGraphWorkspaceProject[],
  ) => Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime>;
  readonly isResolutionContext: (path: string) => boolean;
  readonly match: (path: string) => Option.Option<CodeGraphLanguageMatch>;
  readonly postprocessFile: (file: CodeGraphInventoryFile, facts: CodeGraphFileFacts) => CodeGraphFileFacts;
  readonly packs: readonly CodeGraphLanguagePack[];
}

export class CodeGraphLanguagePackRegistry extends Context.Service<
  CodeGraphLanguagePackRegistry,
  CodeGraphLanguagePackRegistryShape
>()('@threadnote/graph/languages/registry/CodeGraphLanguagePackRegistry') {
  static readonly layer = Layer.succeed(
    CodeGraphLanguagePackRegistry,
    createCodeGraphLanguagePackRegistry(BUILTIN_CODE_GRAPH_LANGUAGE_PACKS),
  );
}

export const BUILTIN_LANGUAGE_PACK_REGISTRY = createCodeGraphLanguagePackRegistry(BUILTIN_CODE_GRAPH_LANGUAGE_PACKS);

export function createCodeGraphLanguagePackRegistry(
  packs: readonly CodeGraphLanguagePack[],
): CodeGraphLanguagePackRegistryShape {
  validatePacks(packs);
  const entries = EffectArray.flatMap(packs, pack =>
    EffectArray.map(pack.files, matcher => ({
      cacheIdentity: packCacheIdentity(pack),
      matcher,
      pack,
      priority:
        matcher.kind === 'extension'
          ? 1
          : matcher.kind === 'basename-pattern'
            ? 2
            : matcher.kind === 'basename'
              ? 3
              : 4,
    })),
  ).sort((left, right) => right.priority - left.priority);
  const match = (path: string): Option.Option<CodeGraphLanguageMatch> => {
    const normalized = normalizeRepositoryPath(path);
    const basename =
      Effect2.pipe(Effect2.pipe(normalized, EffectString.split('/')).at(-1), effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
      ) ?? '';
    const entry = Option.getOrUndefined(
      EffectArray.findFirst(
        entries,
        __effectArrayValue => !!(candidate => matches(candidate.matcher, normalized, basename))(__effectArrayValue),
      ),
    );
    return entry
      ? Option.some({
          cacheIdentity: entry.cacheIdentity,
          language: entry.matcher.language,
          pack: entry.pack,
          role: entry.matcher.role,
        })
      : Option.none();
  };
  const workspaceDetectors = [...new Set(EffectArray.flatMap(packs, pack => Option.toArray(pack.workspaceDetector)))];
  return {
    activeCacheIdentities: paths =>
      [
        ...new Set(
          EffectArray.flatMap(paths, path => Option.toArray(Option.map(match(path), value => value.cacheIdentity))),
        ),
      ].sort(),
    activeDerivationIdentities: paths =>
      [
        ...new Set(
          EffectArray.flatMap(paths, path =>
            Option.toArray(Option.map(match(path), value => packDerivationIdentity(value.pack))),
          ),
        ),
      ].sort(),
    activePackProvenance: paths => {
      const activeIds = new Set(
        EffectArray.flatMap(paths, path => Option.toArray(Option.map(match(path), value => value.pack.id))),
      );
      return EffectArray.map(
        EffectArray.filter(packs, (pack, __effectArrayIndex) => __effectArrayIndex in packs && activeIds.has(pack.id)),
        codeGraphLanguagePackProvenance,
      ).sort((left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id)));
    },
    cacheIdentityForPath: path => Option.map(match(path), value => value.cacheIdentity),
    cacheIdentities: [...new Set(EffectArray.map(entries, entry => entry.cacheIdentity))].sort(),
    discoverWorkspace: files =>
      Effect.forEach(workspaceDetectors, detector => detector.detect(files), {
        concurrency: 1,
      }).pipe(Effect.map(mergeCodeGraphWorkspaces)),
    extractFile: (file, projects = []) =>
      extractRawFile(file, projects).pipe(Effect.map(facts => postprocessFile(file, facts))),
    extractRawFile,
    isResolutionContext: path =>
      Option.match(match(path), {
        onNone: () => false,
        onSome: value => value.role === 'manifest' || value.role === 'workspace',
      }),
    match,
    packs: [...packs],
    postprocessFile,
  };

  function postprocessFile(file: CodeGraphInventoryFile, facts: CodeGraphFileFacts): CodeGraphFileFacts {
    const matched = match(file.path);
    const attributed = Option.isSome(matched) ? {...file, language: matched.value.language} : file;
    return augmentRationaleFacts(attributed, facts);
  }

  function extractRawFile(file: CodeGraphInventoryFile, projects: readonly CodeGraphWorkspaceProject[] = []) {
    const matched = match(file.path);
    if (Option.isNone(matched)) {
      return Effect.fail(
        CodeGraphLanguagePackError.make({message: `No code graph language pack accepts ${file.path}.`}),
      );
    }
    const nearestProjectContext = matched.value.role === 'corpus' || isXcodeAssetContentsPath(file.path);
    const project = projectForPath(
      projects,
      file.path,
      nearestProjectContext ? undefined : matched.value.pack.resolutionStrategy.domain,
    );
    const context: CodeGraphExtractionContext = {
      packageName: Option.map(project, value => value.name),
      project,
    };
    const attributed = {...file, language: matched.value.language};
    return matched.value.pack.extractor
      .extract(attributed, context)
      .pipe(Effect.map(facts => captureRationaleInputs(attributed, facts)));
  }
}

export function codeGraphLanguagePackProvenance(pack: CodeGraphLanguagePack): CodeGraphLanguagePackProvenance {
  return {
    cacheIdentity: packCacheIdentity(pack),
    derivationIdentity: packDerivationIdentity(pack),
    id: pack.id,
    resolutionDomain: pack.resolutionStrategy.domain,
    resolutionVersion: pack.resolutionStrategy.version,
  };
}

export function packCacheIdentity(pack: CodeGraphLanguagePack): string {
  const matchers = EffectArray.join(
    EffectArray.map(
      pack.files,
      matcher => `${matcher.kind}:${Effect2.pipe(matcher.value, EffectString.toLowerCase)}:${matcher.language}`,
    ).sort(),
    '\n',
  );
  const assets = EffectArray.join(
    EffectArray.map(pack.assets, asset => `${asset.relativePath}:${asset.sha256}:${asset.abi}:${asset.version}`).sort(),
    '\n',
  );
  return cacheIdentityHash(
    pack,
    EffectArray.join(
      [
        'code-graph-language-pack-v3',
        CODE_GRAPH_PARSER_FACTS_VERSION,
        `derivation-inputs:${CODE_GRAPH_RATIONALE_INPUT_VERSION}`,
        `id:${pack.id}`,
        `extractor:${pack.extractor.version}`,
        `parser-runtime:${pack.assets.length > 0 ? TREE_SITTER_RUNTIME_CACHE_IDENTITY : 'pack-owned'}`,
        `files:\n${matchers}`,
        `assets:\n${assets}`,
      ],
      '\n',
    ),
  );
}

export function packDerivationIdentity(pack: CodeGraphLanguagePack): string {
  const matchers = EffectArray.join(
    EffectArray.map(
      pack.files,
      matcher =>
        `${matcher.kind}:${Effect2.pipe(matcher.value, EffectString.toLowerCase)}:${matcher.language}:${matcher.role}`,
    ).sort(),
    '\n',
  );
  return derivationIdentityHash(
    pack,
    EffectArray.join(
      [
        'code-graph-language-pack-derivation-v1',
        `postprocessors:${CODE_GRAPH_RATIONALE_EXTRACTOR_VERSION}`,
        `id:${pack.id}`,
        `version:${pack.version}`,
        `resolver:${pack.resolutionStrategy.domain}:${pack.resolutionStrategy.version}`,
        `capabilities:${EffectArray.join([...pack.capabilities].sort(), ',')}`,
        `files:\n${matchers}`,
      ],
      '\n',
    ),
  );
}

function validatePacks(packs: readonly CodeGraphLanguagePack[]): void {
  const ids = new Set<string>();
  const matchers = new Set<string>();
  for (const pack of packs) {
    if (!/^[a-z][a-z0-9-]*$/.test(pack.id)) {
      throw CodeGraphLanguagePackError.make({message: `Invalid code graph language pack id: ${pack.id}.`});
    }
    if (ids.has(pack.id))
      throw CodeGraphLanguagePackError.make({message: `Duplicate code graph language pack id: ${pack.id}.`});
    ids.add(pack.id);
    if (pack.files.length === 0) {
      throw CodeGraphLanguagePackError.make({
        message: `Code graph language pack ${pack.id} does not declare any file matchers.`,
      });
    }
    for (const matcher of pack.files) {
      if (
        matcher.kind === 'basename-pattern' &&
        (!Effect2.pipe(matcher.value, EffectString.includes('*')) ||
          Effect2.pipe(matcher.value, EffectString.includes('**')) ||
          /[/\\]/u.test(matcher.value))
      ) {
        throw CodeGraphLanguagePackError.make({
          message: `Invalid code graph basename pattern: ${matcher.value}.`,
        });
      }
      const key = `${matcher.kind}:${Effect2.pipe(matcher.value, EffectString.toLowerCase)}`;
      if (matchers.has(key)) {
        throw CodeGraphLanguagePackError.make({message: `Duplicate code graph file matcher: ${key}.`});
      }
      matchers.add(key);
    }
  }
}

function matches(matcher: CodeGraphFileMatcher, path: string, basename: string): boolean {
  const value = Effect2.pipe(matcher.value, EffectString.toLowerCase);
  if (matcher.kind === 'basename') return basename === value;
  if (matcher.kind === 'basename-pattern') return basenamePattern(value).test(basename);
  if (matcher.kind === 'path-suffix') return Effect2.pipe(path, EffectString.toLowerCase, EffectString.endsWith(value));
  return Effect2.pipe(basename, EffectString.endsWith(value));
}

function basenamePattern(value: string): RegExp {
  const cached = basenamePatterns.get(value);
  if (cached !== undefined) return cached;
  const source = EffectArray.join(
    EffectArray.map(Effect2.pipe(value, EffectString.split('*')), part =>
      Effect2.pipe(part, EffectString.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
    ),
    '[^/]+',
  );
  const compiled = new RegExp(`^${source}$`, 'u');
  basenamePatterns.set(value, compiled);
  return compiled;
}

function normalizeRepositoryPath(value: string): string {
  return Effect2.pipe(value, EffectString.replace(/^\.\/+/, ''), EffectString.replace(/\/+/g, '/'));
}
