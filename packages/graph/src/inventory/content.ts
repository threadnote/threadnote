import {Array as EffectArray} from 'effect';
import {Option, Predicate} from 'effect';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT} from '../languages/corpus/policy.js';
import {isLowSignalStructuredPath} from '../languages/schemas/policy.js';
import type {CodeGraphInventoryFile} from '../types.js';
import {xcodeNativeTargetNames} from '../workspace/xcode.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const COMPACT_RESOLUTION_CONTEXT_NAMES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'gradle.properties',
  'package.json',
  'package.swift',
  'pom.xml',
  'project.pbxproj',
  'settings.gradle',
  'settings.gradle.kts',
  'tsconfig.json',
]);

export function retainResolutionContext(
  file: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile {
  const name =
    Effect.pipe(Effect.pipe(file.path, EffectString.split('/')).at(-1), effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    ) ?? '';
  const content =
    file.content === undefined
      ? undefined
      : (compactResolutionContext(name, file.content) ??
        (languagePacks.isResolutionContext(file.path) && !COMPACT_RESOLUTION_CONTEXT_NAMES.has(name)
          ? file.content
          : undefined));
  if (content !== undefined) {
    return {...file, content};
  }
  const {bytes: _bytes, content: _content, contentOmittedReason: _contentOmittedReason, ...metadata} = file;
  return metadata;
}

function isCorpusContent(path: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  return Option.match(languagePacks.match(path), {
    onNone: () => false,
    onSome: value => value.role === 'corpus',
  });
}

export function shouldOmitRepositoryContent(
  path: string,
  size: number,
  languagePacks: CodeGraphLanguagePackRegistryShape = BUILTIN_LANGUAGE_PACK_REGISTRY,
): boolean {
  return repositoryContentOmissionReason(path, size, languagePacks) !== undefined;
}

export function repositoryContentOmissionReason(
  path: string,
  size: number,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile['contentOmittedReason'] {
  const match = languagePacks.match(path);
  if (Option.isNone(match)) return undefined;
  if (
    (match.value.language === 'json' || match.value.language === 'jsonc' || match.value.language === 'yaml') &&
    isLowSignalStructuredPath(path)
  ) {
    return 'metadata-only';
  }
  if (match.value.role !== 'corpus') return undefined;
  if (size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT) return 'size-budget';
  return match.value.language === 'image' || match.value.language === 'audio' || match.value.language === 'video'
    ? 'metadata-only'
    : undefined;
}

export function acceptsBinaryContent(path: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  return isCorpusContent(path, languagePacks);
}

function compactResolutionContext(name: string, content: string): string | undefined {
  if (name === 'go.mod') return compactGoModule(content);
  if (name === 'pom.xml') return compactMavenManifest(content);
  if (name === 'settings.gradle' || name === 'settings.gradle.kts') return compactGradleSettings(content);
  if (name === 'build.gradle' || name === 'build.gradle.kts') return compactGradleBuild(content);
  if (name === 'gradle.properties') return '';
  if (name === 'package.swift') return compactSwiftPackage(content);
  if (name === 'project.pbxproj') return compactXcodeProject(content);
  if (name !== 'package.json' && name !== 'tsconfig.json') return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return undefined;
    if (name === 'package.json') {
      const entry = packageEntryForResolution(parsed.exports, parsed.main);
      const dependencySections = EffectRecord.fromEntries(
        EffectArray.flatMap(
          ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'],
          section => {
            const value = parsed[section];
            if (!value || typeof value !== 'object' || EffectArray.isArray(value)) return [];
            return [
              [
                section,
                EffectRecord.fromEntries(
                  EffectArray.flatMap(EffectRecord.toEntries(value), ([dependency, version]) =>
                    typeof version === 'string' ? [[dependency, version]] : [],
                  ),
                ),
              ],
            ];
          },
        ),
      );
      return JSON.stringify({
        ...dependencySections,
        ...(entry === undefined ? {} : {main: entry}),
        ...(typeof parsed.name === 'string' ? {name: parsed.name} : {}),
        ...(typeof parsed.packageManager === 'string' ? {packageManager: parsed.packageManager} : {}),
        ...(EffectArray.isArray(parsed.workspaces)
          ? {workspaces: EffectArray.filter(parsed.workspaces, (value): value is string => typeof value === 'string')}
          : Predicate.isObject(parsed.workspaces)
            ? {
                workspaces: {
                  packages: EffectArray.isArray(parsed.workspaces.packages)
                    ? EffectArray.filter(
                        parsed.workspaces.packages,
                        (value): value is string => typeof value === 'string',
                      )
                    : [],
                },
              }
            : {}),
      });
    }
    const compilerOptions = Predicate.isObject(parsed.compilerOptions) ? parsed.compilerOptions : {};
    const paths = Predicate.isObject(compilerOptions.paths)
      ? EffectRecord.fromEntries(
          EffectArray.flatMap(EffectRecord.toEntries(compilerOptions.paths), ([alias, targets]) =>
            EffectArray.isArray(targets)
              ? [[alias, EffectArray.filter(targets, (target): target is string => typeof target === 'string')]]
              : [],
          ),
        )
      : undefined;
    const compact: Record<string, unknown> = {
      compilerOptions: {
        ...(typeof compilerOptions.baseUrl === 'string' ? {baseUrl: compilerOptions.baseUrl} : {}),
        ...(typeof compilerOptions.outDir === 'string' ? {outDir: compilerOptions.outDir} : {}),
        ...(paths === undefined ? {} : {paths}),
      },
    };
    for (const field of ['exclude', 'files', 'include'] as const) {
      if (EffectRecord.has(parsed, field)) {
        compact[field] = EffectArray.isArray(parsed[field])
          ? EffectArray.filter(parsed[field], (value): value is string => typeof value === 'string')
          : parsed[field];
      }
    }
    if (EffectArray.isArray(parsed.references)) {
      compact.references = EffectArray.flatMap(parsed.references, reference =>
        reference && Predicate.isObject(reference) && typeof reference.path === 'string'
          ? [{path: reference.path}]
          : [],
      );
    }
    return JSON.stringify(compact);
  } catch {
    return undefined;
  }
}

function compactGoModule(content: string): string {
  const output: string[] = [];
  let inRequireBlock = false;
  for (const rawLine of Effect.pipe(content, EffectString.split(/\r?\n/))) {
    const comment = Effect.pipe(
      rawLine,
      EffectString.indexOf('//'),
      Effect.Option.getOrElse(() => -1),
    );
    const line = Effect.pipe(
      comment < 0 ? rawLine : Effect.pipe(rawLine, EffectString.slice(0, comment)),
      EffectString.trim,
    );
    if (!line) continue;
    if (/^module\s+\S+/.test(line)) {
      output.push(line);
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock && /^\S+\s+v\S+/.test(line)) {
      output.push(line);
      continue;
    }
    if (/^require\s+\S+\s+v\S+/.test(line)) output.push(line);
  }
  return `${EffectArray.join(output, '\n')}\n`;
}

function compactMavenManifest(content: string): string | undefined {
  const project = Effect.pipe(content, EffectString.replace(/<parent\b[\s\S]*?<\/parent>/i, ''));
  const group = compactXmlTag(project, 'groupId');
  const artifact = compactXmlTag(project, 'artifactId');
  if (!artifact) return undefined;
  const modules = compactXmlTags(content, 'module');
  const dependencies = EffectArray.flatMap(
    [...Effect.pipe(content, EffectString.matchAll(/<dependency\b[\s\S]*?<\/dependency>/gi))],
    match => {
      const dependencyArtifact = compactXmlTag(match[0], 'artifactId');
      if (!dependencyArtifact) return [];
      const dependencyGroup = compactXmlTag(match[0], 'groupId');
      return [
        `<dependency>${dependencyGroup ? `<groupId>${dependencyGroup}</groupId>` : ''}<artifactId>${dependencyArtifact}</artifactId></dependency>`,
      ];
    },
  );
  return EffectArray.join(
    [
      '<project>',
      group ? `<groupId>${group}</groupId>` : '',
      `<artifactId>${artifact}</artifactId>`,
      modules.length > 0
        ? `<modules>${EffectArray.join(
            EffectArray.map(modules, module => `<module>${module}</module>`),
            '',
          )}</modules>`
        : '',
      dependencies.length > 0 ? `<dependencies>${EffectArray.join(dependencies, '')}</dependencies>` : '',
      '</project>',
    ],
    '',
  );
}

function compactGradleSettings(content: string): string {
  return `${EffectArray.join(
    EffectArray.filter(
      Effect.pipe(content, EffectString.split(/\r?\n/)),
      __effectArrayValue =>
        !!(line => /\brootProject\.name\b|^\s*include\b|\.projectDir\s*=/.test(line))(__effectArrayValue),
    ),
    '\n',
  )}\n`;
}

function compactGradleBuild(content: string): string {
  return `${EffectArray.join(
    EffectArray.filter(
      Effect.pipe(content, EffectString.split(/\r?\n/)),
      __effectArrayValue => !!(line => /\bproject\s*\(/.test(line))(__effectArrayValue),
    ),
    '\n',
  )}\n`;
}

function compactSwiftPackage(content: string): string | undefined {
  const packageName = /\bPackage\s*\(\s*name\s*:\s*"([^"]+)"/m.exec(content)?.[1];
  const starts = [
    ...Effect.pipe(
      content,
      EffectString.matchAll(/\.(target|executableTarget|testTarget)\s*\(\s*name\s*:\s*"([^"]+)"/g),
    ),
  ];
  if (!packageName && starts.length === 0) return undefined;
  const targets = EffectArray.map(starts, (match, index) => {
    const body = Effect.pipe(content, EffectString.slice(match.index, starts[index + 1]?.index ?? content.length));
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const dependencies = /\bdependencies\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? '';
    const names = EffectArray.map(
      [...Effect.pipe(dependencies, EffectString.matchAll(/"([^"]+)"/g))],
      value => value[1],
    );
    return `.${match[1]}(name: ${JSON.stringify(match[2])}, dependencies: [${EffectArray.join(
      EffectArray.map(names, name => JSON.stringify(name)),
      ', ',
    )}]${path ? `, path: ${JSON.stringify(path)}` : ''})`;
  });
  return `let package = Package(name: ${JSON.stringify(packageName ?? 'Package')}, targets: [${EffectArray.join(targets, ', ')}])\n`;
}

function compactXcodeProject(content: string): string {
  const targets = xcodeNativeTargetNames(content);
  return `${EffectArray.join(
    EffectArray.map(targets, target => `isa = PBXNativeTarget; name = ${JSON.stringify(target)};`),
    '\n',
  )}\n`;
}

function compactXmlTag(content: string, tag: string): string | undefined {
  return Effect.pipe(
    new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(content)?.[1],
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
}

function compactXmlTags(content: string, tag: string): readonly string[] {
  return EffectArray.map(
    [
      ...Effect.pipe(
        content,
        EffectString.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'gi')),
      ),
    ],
    match => Effect.pipe(match[1], EffectString.trim),
  );
}

function packageEntryForResolution(exportsValue: unknown, mainValue: unknown): string | undefined {
  if (exportsValue === undefined) return typeof mainValue === 'string' ? mainValue : undefined;
  let root: unknown = exportsValue;
  if (
    Predicate.isObject(exportsValue) &&
    EffectArray.some(EffectRecord.keys(exportsValue), key => Effect.pipe(key, EffectString.startsWith('.')))
  ) {
    root = exportsValue['.'];
  }
  const targets = new Set(collectResolutionExportTargets(root));
  return targets.size === 1 ? [...targets][0] : undefined;
}

function collectResolutionExportTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (EffectArray.isArray(value))
    return EffectArray.flatMap(value, (__effectFlatMapValue, __effectFlatMapIndex) =>
      __effectFlatMapIndex in value ? collectResolutionExportTargets(__effectFlatMapValue) : [],
    );
  if (typeof value !== 'object' || value === null) return [];
  return EffectArray.flatMap(EffectRecord.values(value), collectResolutionExportTargets);
}

export function appearsBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.byteLength, 8192)).includes(0);
}

export function appearsGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 1024) return false;
  return Effect.pipe(
    new TextDecoder().decode(bytes),
    EffectString.startsWith('version https://git-lfs.github.com/spec/v1\n'),
  );
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}
