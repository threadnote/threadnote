import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Schema} from 'effect';
import * as yaml from 'js-yaml';
import type {JsonObject} from '@threadnote/platform/json';
import type {
  ProjectGraphManifest,
  ProjectManifest,
  ResolvedWorkset,
  SeedManifest,
  WorksetManifest,
} from '@threadnote/workspace/config';
import {parseResourceId} from '@threadnote/store/resource-id';
import {escapeRegExp} from '@threadnote/platform/glob';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export {uriSegment} from '@threadnote/store/resource-segment';

class ManifestOperationError extends Schema.TaggedError<ManifestOperationError, {readonly brand: unique symbol}>()(
  'ManifestOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const GENERIC_PROJECT_NAME_SEGMENTS = new Set([
  'application',
  'front',
  'monorepo',
  'native',
  'repo',
  'repository',
  'service',
  'web',
]);

/**
 * Returns the seed manifest project named by `query`. An exact project name
 * wins; otherwise a unique, non-generic segment can identify a compound name
 * (`worker` → `orion-worker`). Ambiguous or generic segments do not scope
 * recall.
 */
export const inferProjectFromQuery = Effect.fn('manifest.inferProjectFromQuery')(function* (
  manifestPath: string,
  query: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  return inferProjectFromManifest(manifest.value, query);
});

export function inferProjectFromManifest(manifest: SeedManifest, query: string): ProjectManifest | undefined {
  const exactMentions = EffectArray.flatMap(manifest.projects, project =>
    EffectArray.map(nameTokenSpans(query, project.name), span => ({...span, project})),
  );
  const maximalMentions = EffectArray.filter(
    exactMentions,
    mention =>
      !EffectArray.some(
        exactMentions,
        other =>
          other.project !== mention.project &&
          other.start <= mention.start &&
          other.end >= mention.end &&
          other.end - other.start > mention.end - mention.start,
      ),
  );
  const exactProjects = new Set(EffectArray.map(maximalMentions, mention => mention.project));
  if (exactProjects.size > 0) {
    return exactProjects.size === 1 ? [...exactProjects][0] : undefined;
  }
  const queryTerms = new Set(
    Effect2.pipe(query, __effectPipeInput => {
      const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.toLowerCase);
      const __effectPipeStage1 = Effect2.pipe(
        __effectPipeStage0,
        EffectString.match(/[a-z0-9]+/g),
        Effect2.Option.getOrElse(() => null),
      );
      return __effectPipeStage1;
    }) ?? [],
  );
  const projectsBySegment = new Map<string, ProjectManifest[]>();
  for (const project of manifest.projects) {
    for (const segment of new Set(
      Effect2.pipe(project.name, EffectString.toLowerCase, EffectString.split(/[^a-z0-9]+/)),
    )) {
      if (segment.length < 4 || GENERIC_PROJECT_NAME_SEGMENTS.has(segment)) {
        continue;
      }
      const projects = projectsBySegment.get(segment);
      if (projects) {
        projects.push(project);
      } else {
        projectsBySegment.set(segment, [project]);
      }
    }
  }
  const matches = new Set<ProjectManifest>();
  for (const [segment, projects] of projectsBySegment) {
    if (projects.length === 1 && projects[0] && queryTerms.has(segment)) {
      matches.add(projects[0]);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

/**
 * Resolves a workset's member names to their `ProjectManifest` entries, dropping
 * names that do not match a known project. A workset is a named set of manifest
 * projects that recall expands into one multi-repo working set.
 */
function resolveWorksetProjects(manifest: SeedManifest, workset: WorksetManifest): ResolvedWorkset {
  const byName = new Map(
    EffectArray.map(manifest.projects, project => [Effect2.pipe(project.name, EffectString.toLowerCase), project]),
  );
  const projects: ProjectManifest[] = [];
  const unresolvedProjects: string[] = [];
  for (const name of workset.projects) {
    const project = byName.get(Effect2.pipe(name, EffectString.toLowerCase));
    if (project === undefined) unresolvedProjects.push(name);
    else projects.push(project);
  }
  return {name: workset.name, projects, unresolvedProjects};
}

/** Looks up a workset by exact (case-insensitive) name; undefined when unknown or unreadable. */
export const resolveWorkset = Effect.fn('manifest.resolveWorkset')(function* (
  manifestPath: string,
  worksetName: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  const workset = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(manifest.value.worksets), __effectArrayReceiver =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          __effectArrayReceiver,
          entry =>
            Effect2.pipe(entry.name, EffectString.toLowerCase) === Effect2.pipe(worksetName, EffectString.toLowerCase),
        ),
      ),
    ),
  );
  return workset ? resolveWorksetProjects(manifest.value, workset) : undefined;
});

/** Resolves an explicit workset name; throws when the manifest is readable but no such workset exists. */
export const requireWorkset = Effect.fn('manifest.requireWorkset')(function* (
  manifestPath: string,
  worksetName: string,
) {
  const manifest = yield* readSeedManifest(manifestPath);
  return yield* Effect.try({
    try: () => requireManifestWorkset(manifest, worksetName, manifestPath),
    catch: cause =>
      Schema.is(ManifestOperationError)(cause) ? cause : ManifestOperationError.make({cause, message: String(cause)}),
  });
});

export function requireManifestWorkset(
  manifest: SeedManifest,
  worksetName: string,
  manifestPath = 'manifest',
): ResolvedWorkset {
  const workset = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(manifest.worksets), __effectArrayReceiver =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          __effectArrayReceiver,
          entry =>
            Effect2.pipe(entry.name, EffectString.toLowerCase) === Effect2.pipe(worksetName, EffectString.toLowerCase),
        ),
      ),
    ),
  );
  if (!workset) {
    throw ManifestOperationError.make({message: `No workset named "${worksetName}" in ${manifestPath}.`});
  }
  const resolved = resolveWorksetProjects(manifest, workset);
  if (resolved.unresolvedProjects.length > 0) {
    throw ManifestOperationError.make({
      message: `Workset "${worksetName}" contains unknown projects: ${EffectArray.join(resolved.unresolvedProjects, ', ')}.`,
    });
  }
  return resolved;
}

/** Returns the workset whose name appears as a token in `query`, or undefined. */
export const inferWorksetFromQuery = Effect.fn('manifest.inferWorksetFromQuery')(function* (
  manifestPath: string,
  query: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  if (!manifest.value.worksets || manifest.value.worksets.length === 0) {
    return undefined;
  }
  const workset = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      manifest.value.worksets,
      __effectArrayValue => !!(entry => containsNameToken(query, entry.name))(__effectArrayValue),
    ),
  );
  return workset ? resolveWorksetProjects(manifest.value, workset) : undefined;
});

function containsNameToken(query: string, name: string): boolean {
  return nameTokenSpans(query, name).length > 0;
}

function nameTokenSpans(query: string, name: string): readonly {readonly end: number; readonly start: number}[] {
  const escaped = escapeRegExp(Effect2.pipe(name, EffectString.toLowerCase));
  const spans: Array<{end: number; start: number}> = [];
  for (const match of Effect2.pipe(query, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.toLowerCase);
    const __effectPipeStage1 = Effect2.pipe(
      __effectPipeStage0,
      EffectString.matchAll(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'g')),
    );
    return __effectPipeStage1;
  })) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    spans.push({end: start + name.length, start});
  }
  return spans;
}

export const readSeedManifest = Effect.fn('manifest.readSeedManifest')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseSeedManifest(raw, path),
    catch: cause =>
      Schema.is(ManifestOperationError)(cause)
        ? cause
        : ManifestOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

export function parseSeedManifest(raw: string, path: string): SeedManifest {
  const loaded = yaml.load(raw);
  if (!isJsonObject(loaded)) {
    throw ManifestOperationError.make({message: `Manifest must be an object: ${path}`});
  }
  const version = readNumber(loaded, 'version');
  const projectsValue = loaded.projects;
  if (!EffectArray.isArray(projectsValue)) {
    throw ManifestOperationError.make({message: `Manifest projects must be an array: ${path}`});
  }
  const projects: ProjectManifest[] = [];
  for (const projectValue of projectsValue) {
    if (!isJsonObject(projectValue)) {
      throw ManifestOperationError.make({message: `Manifest project must be an object: ${path}`});
    }
    const seed = readStringArray(projectValue, 'seed');
    const graph = readProjectGraph(projectValue);
    projects.push({
      ...(graph === undefined ? {} : {graph}),
      name: readString(projectValue, 'name'),
      path: readString(projectValue, 'path'),
      seed,
      uri: parseResourceId(readString(projectValue, 'uri')).canonicalUri,
    });
  }

  let futureMonorepo: SeedManifest['futureMonorepo'];
  if (isJsonObject(loaded.future_monorepo)) {
    futureMonorepo = {
      pathCandidates: readStringArray(loaded.future_monorepo, 'path_candidates'),
      uri: parseResourceId(readString(loaded.future_monorepo, 'uri')).canonicalUri,
    };
  }

  let worksets: readonly WorksetManifest[] | undefined;
  if (loaded.worksets !== undefined) {
    if (!EffectArray.isArray(loaded.worksets)) {
      throw ManifestOperationError.make({message: `Manifest worksets must be an array: ${path}`});
    }
    worksets = EffectArray.map(loaded.worksets, worksetValue => {
      if (!isJsonObject(worksetValue)) {
        throw ManifestOperationError.make({message: `Manifest workset must be an object: ${path}`});
      }
      return {
        description: readOptionalString(worksetValue, 'description'),
        name: readString(worksetValue, 'name'),
        projects: readStringArray(worksetValue, 'projects'),
      };
    });
  }
  return {futureMonorepo, projects, version, worksets};
}

function readProjectGraph(project: JsonObject): ProjectGraphManifest | undefined {
  const value = project.graph;
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw ManifestOperationError.make({message: 'Expected object for graph'});
  }
  const roots = readRepositoryPathArray(value, 'roots');
  if (roots.length === 0) {
    throw ManifestOperationError.make({message: 'Project graph roots must not be empty'});
  }
  const closure = readString(value, 'closure');
  if (closure !== 'dependencies') {
    throw ManifestOperationError.make({message: 'Project graph closure must be dependencies'});
  }
  const include = value.include === undefined ? undefined : readRepositoryPathArray(value, 'include');
  return {...(include === undefined ? {} : {include}), closure, roots};
}

function readRepositoryPathArray(object: JsonObject, key: string): readonly string[] {
  const values = readStringArray(object, key);
  const normalized = EffectArray.map(values, value => normalizeRepositoryPath(value, key));
  if (new Set(normalized).size !== normalized.length) {
    throw ManifestOperationError.make({message: `Project graph ${key} must not contain duplicate paths`});
  }
  return normalized;
}

function normalizeRepositoryPath(value: string, key: string): string {
  if (
    value.length === 0 ||
    Effect2.pipe(value, EffectString.startsWith('/')) ||
    Effect2.pipe(value, EffectString.includes('\\')) ||
    hasControlCharacter(value)
  ) {
    throw ManifestOperationError.make({message: `Project graph ${key} contains an invalid repository-relative path`});
  }
  if (
    EffectArray.some(
      Effect2.pipe(value, EffectString.split('/')),
      segment => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw ManifestOperationError.make({message: `Project graph ${key} contains an invalid repository-relative path`});
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return EffectArray.some([...value], character => {
    const code =
      Effect2.pipe(
        character,
        EffectString.codePointAt(0),
        Effect2.Option.getOrElse(() => undefined),
      ) ?? 0;
    return code <= 31 || code === 127;
  });
}

function readOptionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw ManifestOperationError.make({message: `Expected string for ${key}`});
  }
  return value;
}

function readString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw ManifestOperationError.make({message: `Expected non-empty string for ${key}`});
  }
  return value;
}

function readNumber(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== 'number') {
    throw ManifestOperationError.make({message: `Expected number for ${key}`});
  }
  return value;
}

function readStringArray(object: JsonObject, key: string): readonly string[] {
  const value = object[key];
  if (!EffectArray.isArray(value) || !EffectArray.every(value, item => typeof item === 'string')) {
    throw ManifestOperationError.make({message: `Expected string array for ${key}`});
  }
  return value;
}
