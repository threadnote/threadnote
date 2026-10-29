import {Effect, FileSystem, Path, Predicate} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const WORKSPACE_COMPONENT_MANIFESTS = [
  'package.json',
  'project.json',
  'pyproject.toml',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'Package.swift',
  'BUILD',
  'BUILD.bazel',
  'MODULE.bazel',
  'WORKSPACE.bazel',
] as const;

export const findWorkspaceComponentManifest = Effect.fn('workspaceComponent.findManifest')(function* (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  directory: string,
) {
  for (const name of WORKSPACE_COMPONENT_MANIFESTS) {
    const path = pathService.join(directory, name);
    if (!(yield* fs.exists(path))) continue;
    const content = yield* fs.readFileString(path).pipe(Effect.option);
    return {
      declaredName: content._tag === 'Some' ? declaredWorkspaceName(name, content.value) : undefined,
      path,
    };
  }
  const projectFile = EffectArray.filter(
    yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [])),
    __effectArrayValue => !!(name => /\.csproj$/i.test(name))(__effectArrayValue),
  ).sort()[0];
  if (projectFile) {
    return {
      declaredName: Effect2.pipe(projectFile, EffectString.replace(/\.csproj$/i, '')),
      path: pathService.join(directory, projectFile),
    };
  }
  return undefined;
});

function declaredWorkspaceName(manifestName: string, content: string): string | undefined {
  const name = Effect2.pipe(manifestName, EffectString.toLowerCase);
  if (name === 'package.json' || name === 'project.json') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!Predicate.isObject(parsed)) return undefined;
      const value = parsed.name;
      return typeof value === 'string' ? Effect2.pipe(value, EffectString.trim) || undefined : undefined;
    } catch {
      return undefined;
    }
  }
  if (name === 'pyproject.toml' || name === 'cargo.toml') {
    return Effect2.pipe(/^name\s*=\s*["']([^"']+)["']/m.exec(content)?.[1], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
  }
  if (name === 'pom.xml') {
    return Effect2.pipe(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/i.exec(content)?.[1], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
  }
  return undefined;
}
