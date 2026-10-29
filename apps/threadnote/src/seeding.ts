import {Array as EffectArray} from 'effect';
import {Cause, Console, Effect, FileSystem, Option, Path, PlatformError, Result, Schema} from 'effect';
import * as yaml from 'js-yaml';
import {
  inspectContainedStableRegularFile,
  materializeContainedStableRegularFile,
} from '@threadnote/graph/inventory/contained_file';
import {DEFAULT_SEED_PATTERNS, SEED_STATE_FILE, USER_MANIFEST_NAME} from './constants.js';
import {buildGraphDocument, type DependencyFacts, extractDependencyFacts, resolveGraphEdges} from './graph.js';
import {applicationError} from '@threadnote/platform/errors';
import {ResourceStore, type ResourceStoreMutation, type ResourceStoreShape} from '@threadnote/store/resource-store';
import {SystemInfo} from '@threadnote/platform/system';
import {readSeedManifest, uriSegment} from '@threadnote/workspace/manifest';
import {validateProjectSeedPattern, validateProjectSeedPatterns} from './seed_pattern.js';
import {applyScrubber} from '@threadnote/platform/scrubber';
import type {InitManifestOptions, SeedCandidate, SeedOptions, SkillCandidate} from './types.js';
import type {ProjectManifest, RuntimeConfig, SeedManifest} from '@threadnote/workspace/config';
import {withSetupMutationLock} from './setup/lock.js';
import {
  exists,
  getGlobBase,
  gitValue,
  hasGlob,
  isDirectory,
  isFile,
  isJsonObject,
  portablePath,
  redactText,
  resolveRepoName,
  sha256,
  toPosixPath,
  trimTrailingSlash,
  walkFiles,
} from './utils.js';
import {globToRegExp} from '@threadnote/platform/glob';
import {expandPath, getInvocationCwd} from '@threadnote/platform/paths';
import {toolRoot} from '@threadnote/workspace/installation';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly project?: string;
  readonly sha256?: string;
  readonly size: number;
}

interface SeedStateFile {
  readonly files: Record<string, SeedStateEntry>;
  readonly version: 1;
}

class SeedingOperationError extends Schema.TaggedError<SeedingOperationError, {readonly brand: unique symbol}>()(
  'SeedingOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const log = Console.log;
const MAX_SEED_CANDIDATES_PER_PROJECT = 20_000;
const MAX_SEED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SEED_WALK_ENTRIES_PER_PROJECT = 250_000;
const SEED_MUTATION_BATCH_SIZE = 16;

interface SeedCounters {
  failedProjects: number;
  imported: number;
  removed: number;
  skipped: number;
  unchanged: number;
}

interface SeedWalkBudget {
  candidates: number;
  entries: number;
}

interface SeedTraversalBoundary {
  readonly inspections: Map<string, SeedPathInspection | null>;
  readonly logicalRoot: string;
  readonly realRoot: string;
}

interface SeedPathInspection {
  readonly type: 'Directory' | 'File' | 'Other';
}

interface PendingSeedMutation {
  readonly mutation: ResourceStoreMutation;
  readonly stateEntry?: SeedStateEntry;
  readonly stateUri: string;
}

export function runSeed(config: RuntimeConfig, options: SeedOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* readSeedManifest(config.manifestPath);
    const ignorePatterns = yield* loadIgnorePatterns();
    const store = yield* ResourceStore;
    const statePath = path.join(config.agentContextHome, SEED_STATE_FILE);
    const state: {files: Record<string, SeedStateEntry>; version: 1} =
      options.force === true ? {files: {}, version: 1} : yield* readSeedState(statePath);
    yield* Effect.try({
      try: () => assertUniqueProjectUriRoots(manifest.projects),
      catch: cause => applicationError('validate seed project URI roots', cause),
    });
    const projects = yield* Effect.try({
      try: () => filterProjects(manifest.projects, options.only),
      catch: cause => applicationError('filter seed projects', cause),
    });
    const counters: SeedCounters = {
      failedProjects: 0,
      imported: 0,
      removed: 0,
      skipped: 0,
      unchanged: 0,
    };
    const failedProjectNames: string[] = [];

    for (const project of projects) {
      const projectRoot = yield* expandPath(project.path);
      if (!(yield* fs.exists(projectRoot))) {
        yield* log(`WARN project missing: ${project.name} (${projectRoot})`);
        continue;
      }

      const result = yield* Effect.result(
        Effect.sandbox(
          seedProject({
            config,
            counters,
            ignorePatterns,
            manifest,
            options,
            project,
            projectRoot,
            state,
            store,
          }),
        ),
      );
      if (Result.isFailure(result)) {
        if (Cause.hasInterruptsOnly(result.failure)) {
          return yield* Effect.failCause(result.failure);
        }
        counters.failedProjects += 1;
        failedProjectNames.push(project.name);
        const error = Cause.squash(result.failure);
        yield* log(`ERROR project ${project.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.dryRun !== true) {
      yield* writeSeedState(statePath, state);
    }
    yield* log(
      `Seed complete: ${counters.imported} candidate(s), ${counters.unchanged} unchanged, ${counters.removed} stale removed, ${counters.skipped} skipped for safety, ${counters.failedProjects} project(s) failed.`,
    );
    if (counters.skipped > 0) {
      yield* log(
        `Seed safety summary: ${counters.skipped} file(s) were not seeded. Review the SKIP lines above for details.`,
      );
    }

    if (options.graph === true) {
      yield* seedDependencyGraphs(config, 'threadnote-native', manifest, projects, options.dryRun === true);
    }
    if (failedProjectNames.length > 0) {
      return yield* applicationError(
        'seed projects',
        SeedingOperationError.make({
          message: `${failedProjectNames.length} project(s) failed after the remaining projects were processed: ${EffectArray.join(failedProjectNames, ', ')}`,
        }),
      );
    }
  });
}

const seedProject = Effect.fn('seeding.seedProject')(function* ({
  config,
  counters,
  ignorePatterns,
  manifest,
  options,
  project,
  projectRoot,
  state,
  store,
}: {
  readonly config: RuntimeConfig;
  readonly counters: SeedCounters;
  readonly ignorePatterns: readonly string[];
  readonly manifest: SeedManifest;
  readonly options: SeedOptions;
  readonly project: ProjectManifest;
  readonly projectRoot: string;
  readonly state: {files: Record<string, SeedStateEntry>; version: 1};
  readonly store: ResourceStoreShape;
}) {
  const fs = yield* FileSystem.FileSystem;
  const canonicalProjectRoot = yield* fs.realPath(projectRoot);
  const currentUris = new Set<string>();
  const pending: PendingSeedMutation[] = [];
  const location = resourceStoreLocation(config);
  const flush = Effect.fn('seeding.flushMutations')(function* () {
    if (pending.length === 0 || options.dryRun === true) {
      return;
    }
    const batch = pending.splice(0);
    yield* store.mutate(
      location,
      EffectArray.map(batch, entry => entry.mutation),
    );
    for (const entry of batch) {
      if (entry.stateEntry === undefined) {
        delete state.files[entry.stateUri];
      } else {
        state.files[entry.stateUri] = entry.stateEntry;
      }
    }
  });
  const queue = Effect.fn('seeding.queueMutation')(function* (entry: PendingSeedMutation) {
    pending.push(entry);
    if (pending.length >= SEED_MUTATION_BATCH_SIZE) {
      yield* flush();
    }
  });

  yield* visitSeedCandidates(project, projectRoot, ignorePatterns, candidate =>
    Effect.gen(function* () {
      currentUris.add(candidate.destinationUri);
      const fileRead = yield* readSeedFile(canonicalProjectRoot, candidate.relativePath);
      const recorded = state.files[candidate.destinationUri];
      if (fileRead.type === 'too-large') {
        yield* log(
          `SKIP ${candidate.projectName}/${candidate.relativePath}: file is ${fileRead.size} bytes; maximum seed file size is ${MAX_SEED_FILE_BYTES} bytes`,
        );
        if (recorded) {
          if (options.dryRun === true) {
            yield* log(`Would remove unsafe seeded resource: ${candidate.destinationUri}`);
          } else {
            yield* queue({
              mutation: {ignoreMissing: true, type: 'remove', uri: candidate.destinationUri},
              stateUri: candidate.destinationUri,
            });
          }
          counters.removed += 1;
        }
        counters.skipped += 1;
        return;
      }
      if (
        recorded &&
        recorded.mtimeMs === fileRead.mtimeMs &&
        recorded.size === fileRead.size &&
        recorded.sha256 === fileRead.sha256
      ) {
        counters.unchanged += 1;
        if (options.dryRun !== true && recorded.project !== project.name) {
          state.files[candidate.destinationUri] = {...recorded, project: project.name};
        }
        return;
      }
      const content = yield* prepareSeedContent(candidate, fileRead.bytes);
      if (content === undefined) {
        if (recorded) {
          if (options.dryRun === true) {
            yield* log(`Would remove unsafe seeded resource: ${candidate.destinationUri}`);
          } else {
            yield* queue({
              mutation: {ignoreMissing: true, type: 'remove', uri: candidate.destinationUri},
              stateUri: candidate.destinationUri,
            });
          }
          counters.removed += 1;
        }
        counters.skipped += 1;
        return;
      }
      if (options.dryRun === true) {
        yield* log(`Would seed resource: ${candidate.filePath} -> ${candidate.destinationUri}`);
      } else {
        yield* queue({
          mutation: {
            content,
            options: {mode: 'upsert'},
            type: 'write',
            uri: candidate.destinationUri,
          },
          stateEntry: {
            mtimeMs: fileRead.mtimeMs,
            project: project.name,
            sha256: fileRead.sha256,
            size: fileRead.size,
          },
          stateUri: candidate.destinationUri,
        });
      }
      counters.imported += 1;
    }),
  );
  yield* flush();

  for (const uri of EffectArray.filter(
    EffectRecord.keys(state.files),
    uri => seedStateEntryOwnedByProject(uri, state.files[uri], project, manifest.projects) && !currentUris.has(uri),
  )) {
    if (options.dryRun === true) {
      yield* log(`Would remove stale seeded resource: ${uri}`);
    } else {
      yield* queue({mutation: {ignoreMissing: true, type: 'remove', uri}, stateUri: uri});
    }
    counters.removed += 1;
  }
  yield* flush();
});

/**
 * Seeds a per-project `.graph.md` dependency-facts resource. Facts are extracted
 * from every manifest project (so cross-repo `[[project]]` edges resolve even
 * under --only), then a document is rendered and seeded for each target
 * project. Synthesized content is routed through the same secret scanner as
 * every other seeded file before it can reach the canonical store. Stored as a plain
 * resource, never a memory.
 */
export function seedDependencyGraphs(
  config: RuntimeConfig,
  _legacyOv: string,
  manifest: SeedManifest,
  targetProjects: readonly ProjectManifest[],
  dryRun: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const factsByProject = new Map<string, DependencyFacts>();
    for (const project of manifest.projects) {
      const projectRoot = yield* expandPath(project.path);
      if (!(yield* fs.exists(projectRoot))) {
        continue;
      }
      factsByProject.set(project.name, yield* extractDependencyFacts(projectRoot));
    }
    const projectByPublishedName = new Map<string, string>();
    for (const [name, facts] of factsByProject) {
      if (facts.publishedName) {
        projectByPublishedName.set(Effect2.pipe(facts.publishedName, EffectString.toLowerCase), name);
      }
    }

    let written = 0;
    let skipped = 0;
    const mutations: ResourceStoreMutation[] = [];
    for (const project of targetProjects) {
      const facts = factsByProject.get(project.name);
      if (!facts || facts.manifestFiles.length === 0) {
        continue;
      }
      const {externalCount, internalEdges} = resolveGraphEdges(
        project.name,
        facts.dependencies,
        projectByPublishedName,
      );
      const document = buildGraphDocument({externalCount, facts, internalEdges, projectName: project.name});
      const scrubbed = applyScrubber(document, {redact: true});
      if (scrubbed.blocker !== undefined) {
        skipped += 1;
        yield* log(`SKIP ${project.name}/.graph.md: possible secret (${scrubbed.blocker})`);
        continue;
      }
      const destinationUri = `${trimTrailingSlash(project.uri)}/.graph.md`;
      if (dryRun) {
        yield* log(`Would seed dependency facts: ${destinationUri} (${internalEdges.length} in-workspace edge(s))`);
        written += 1;
        continue;
      }
      mutations.push({content: scrubbed.cleaned, options: {mode: 'upsert'}, type: 'write', uri: destinationUri});
      written += 1;
    }
    if (!dryRun) {
      const store = yield* ResourceStore;
      yield* store.mutate(resourceStoreLocation(config), mutations);
    }
    yield* log(
      `Dependency graph seed complete: ${written} .graph.md resource(s)${skipped > 0 ? `, ${skipped} skipped for safety` : ''}.`,
    );
  });
}

function filterProjects(
  projects: readonly ProjectManifest[],
  only: readonly string[] | undefined,
): readonly ProjectManifest[] {
  if (!only || only.length === 0) {
    return projects;
  }
  const known = new Set(EffectArray.map(projects, project => project.name));
  const missing = EffectArray.filter(only, name => !known.has(name));
  if (missing.length > 0) {
    const all = EffectArray.join([...known], ', ');
    throw SeedingOperationError.make({
      message: `Unknown project(s) in --only: ${EffectArray.join(missing, ', ')}. Manifest projects: ${all}`,
    });
  }
  const want = new Set(only);
  return EffectArray.filter(projects, __effectArrayValue => !!(project => want.has(project.name))(__effectArrayValue));
}

const readSeedFile = Effect.fn('seeding.readSeedFile')(function* (projectRoot: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspected = yield* inspectContainedStableRegularFile(fs, path, projectRoot, relativePath);
  if (inspected.size > MAX_SEED_FILE_BYTES) {
    return {size: inspected.size, type: 'too-large' as const};
  }
  const target = path.join(projectRoot, ...Effect2.pipe(relativePath, EffectString.split('/')));
  const info = yield* fs.stat(target);
  if (info.type !== 'File' || Number(info.size) !== inspected.size) {
    return yield* SeedingOperationError.make({message: `Seed file changed before it was read: ${relativePath}`});
  }
  const materialized = yield* materializeContainedStableRegularFile(
    fs,
    path,
    projectRoot,
    relativePath,
    () => false,
    inspected.size,
  );
  if (materialized.bytes === undefined) {
    return yield* SeedingOperationError.make({message: `Seed file content was not materialized: ${relativePath}`});
  }
  return {
    bytes: materialized.bytes,
    mtimeMs: Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
    sha256: materialized.contentHash,
    size: materialized.size,
    type: 'file' as const,
  };
});

function optionOnSeedNotFound<A>(effect: Effect.Effect<A, PlatformError.PlatformError>) {
  return effect.pipe(
    Effect.asSome,
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeedNone,
    ),
  );
}

function readSeedLink(fs: FileSystem.FileSystem, target: string) {
  return fs.readLink(target).pipe(
    Effect.asSome,
    Effect.catchIf(isMissingOrNonLink, () => Effect.succeedNone),
  );
}

function isMissingOrNonLink(error: PlatformError.PlatformError): boolean {
  if (error.reason._tag === 'NotFound') return true;
  if (error.reason._tag !== 'Unknown' || !('cause' in error.reason)) return false;
  const cause = error.reason.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as {readonly code?: unknown}).code === 'EINVAL'
  );
}

function readSeedState(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        error => error.reason._tag === 'NotFound',
        () => Effect.void,
      ),
    );
    if (raw === undefined) {
      return {files: {}, version: 1} as const;
    }
    const parsedResult = Result.try((): unknown => JSON.parse(raw));
    if (Result.isFailure(parsedResult)) {
      return {files: {}, version: 1} as const;
    }
    const parsed = parsedResult.success;
    if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.files)) {
      return {files: {}, version: 1} as const;
    }
    const files: Record<string, SeedStateEntry> = {};
    for (const [uri, entry] of EffectRecord.toEntries(parsed.files)) {
      if (isJsonObject(entry) && typeof entry.mtimeMs === 'number' && typeof entry.size === 'number') {
        files[uri] = {
          mtimeMs: entry.mtimeMs,
          project: typeof entry.project === 'string' ? entry.project : undefined,
          sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
          size: entry.size,
        };
      }
    }
    return {files, version: 1 as const};
  });
}

function assertUniqueProjectUriRoots(projects: readonly ProjectManifest[]): void {
  const ownerByRoot = new Map<string, string>();
  for (const project of projects) {
    const root = trimTrailingSlash(project.uri);
    const existing = ownerByRoot.get(root);
    if (existing !== undefined) {
      throw SeedingOperationError.make({
        message: `Projects ${existing} and ${project.name} use the same seed URI root: ${root}.`,
      });
    }
    ownerByRoot.set(root, project.name);
  }
}

function seedStateEntryOwnedByProject(
  uri: string,
  entry: SeedStateEntry,
  project: ProjectManifest,
  projects: readonly ProjectManifest[],
): boolean {
  if (entry.project !== undefined && EffectArray.some(projects, candidate => candidate.name === entry.project)) {
    return entry.project === project.name;
  }
  const matchingOwners = EffectArray.filter(
    projects,
    __effectArrayValue =>
      !!(candidate => {
        const root = trimTrailingSlash(candidate.uri);
        return uri === root || Effect2.pipe(uri, EffectString.startsWith(`${root}/`));
      })(__effectArrayValue),
  ).sort(
    (left, right) =>
      trimTrailingSlash(right.uri).length - trimTrailingSlash(left.uri).length ||
      Effect2.pipe(left.name, EffectString.localeCompare(right.name)),
  );
  return matchingOwners[0]?.name === project.name;
}

function writeSeedState(path: string, state: SeedStateFile) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    yield* fs.writeFileString(path, `${JSON.stringify(state, undefined, 2)}\n`, {mode: 0o600});
  });
}

export function runInitManifest(config: RuntimeConfig, options: InitManifestOptions) {
  const operation = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const manifestPath = yield* expandPath(
      options.path ??
        system.environment().THREADNOTE_MANIFEST ??
        path.join(config.agentContextHome, USER_MANIFEST_NAME),
    );
    const repoInputs = options.repo && options.repo.length > 0 ? options.repo : [yield* getInvocationCwd()];
    const existingManifest =
      options.replace === true || !(yield* fs.exists(manifestPath)) ? undefined : yield* readSeedManifest(manifestPath);
    const existingProjects = existingManifest?.projects ?? [];
    const projects = [...existingProjects];
    const seen = new Set<string>();

    for (const project of existingProjects) {
      seen.add(yield* projectIdentity(project.path));
    }

    for (const repoInput of repoInputs) {
      const repoRoot = yield* resolveRepoRoot(repoInput);
      const identity = yield* projectIdentity(repoRoot);
      if (seen.has(identity)) {
        yield* log(`Already in manifest: ${repoRoot}`);
        continue;
      }
      seen.add(identity);
      projects.push(yield* projectManifestForRepo(repoRoot, projects));
    }

    const outputManifest: Record<string, unknown> = {
      version: 1,
      projects: EffectArray.map(projects, project => ({
        ...(project.graph === undefined
          ? {}
          : {
              graph: {
                closure: project.graph.closure,
                ...(project.graph.include === undefined ? {} : {include: [...project.graph.include]}),
                roots: [...project.graph.roots],
              },
            }),
        name: project.name,
        path: project.path,
        uri: project.uri,
        seed: [...project.seed],
      })),
    };
    if (existingManifest?.futureMonorepo) {
      const futureMonorepoKey = 'future_monorepo';
      const pathCandidatesKey = 'path_candidates';
      outputManifest[futureMonorepoKey] = {
        [pathCandidatesKey]: [...existingManifest.futureMonorepo.pathCandidates],
        uri: existingManifest.futureMonorepo.uri,
      };
    }
    if (existingManifest?.worksets) {
      outputManifest.worksets = EffectArray.map(existingManifest.worksets, workset => ({
        name: workset.name,
        ...(workset.description !== undefined ? {description: workset.description} : {}),
        projects: [...workset.projects],
      }));
    }
    const output = yaml.dump(outputManifest, {lineWidth: 120, noRefs: true});

    if (options.dryRun === true) {
      yield* log(`# Would write ${manifestPath}`);
      yield* log(Effect2.pipe(output, EffectString.trimEnd));
      return;
    }

    yield* fs.makeDirectory(path.dirname(manifestPath), {recursive: true});
    yield* fs.writeFileString(manifestPath, output, {mode: 0o600});
    yield* fs.chmod(manifestPath, 0o600);
    yield* log(`Wrote manifest: ${manifestPath}`);
    yield* log('Seed with:');
    yield* log('  threadnote seed --dry-run');
    yield* log('  threadnote seed');
  });
  return options.dryRun === true || options.setupLockHeld === true
    ? operation
    : withSetupMutationLock(config.agentContextHome, operation);
}

export function runWorksetList(config: RuntimeConfig) {
  return Effect.gen(function* () {
    const manifest = yield* readSeedManifest(config.manifestPath);
    const worksets = manifest.worksets ?? [];
    if (worksets.length === 0) {
      yield* log(
        'No worksets defined. Add a top-level `worksets:` list to the seed manifest to group related projects.',
      );
      return;
    }
    yield* log(`Worksets (${worksets.length}):`);
    for (const workset of worksets) {
      const summary = workset.description ? ` — ${workset.description}` : '';
      yield* log(`- ${workset.name} (${workset.projects.length} project(s))${summary}`);
    }
  });
}

export function runWorksetShow(config: RuntimeConfig, name: string) {
  return Effect.gen(function* () {
    const manifest = yield* readSeedManifest(config.manifestPath);
    const workset = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(manifest.worksets), __effectArrayReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            entry =>
              Effect2.pipe(entry.name, EffectString.toLowerCase) === Effect2.pipe(name, EffectString.toLowerCase),
          ),
        ),
      ),
    );
    if (!workset) {
      return yield* applicationError(
        'show workset',
        SeedingOperationError.make({message: `No workset named "${name}" in ${config.manifestPath}.`}),
      );
    }
    yield* log(`Workset: ${workset.name}`);
    if (workset.description) {
      yield* log(workset.description);
    }
    yield* log('Projects:');
    for (const memberName of workset.projects) {
      const project = Option.getOrUndefined(
        EffectArray.findFirst(
          manifest.projects,
          entry =>
            Effect2.pipe(entry.name, EffectString.toLowerCase) === Effect2.pipe(memberName, EffectString.toLowerCase),
        ),
      );
      yield* log(project ? `- ${project.name} (${project.uri})` : `- ${memberName} [not found in manifest projects]`);
    }
  });
}

export function runSeedSkills(config: RuntimeConfig, options: SeedOptions) {
  return Effect.gen(function* () {
    const store = yield* ResourceStore;
    const catalogItems = yield* collectSkillCandidates(config);
    const mutations: ResourceStoreMutation[] = [];
    yield* log(
      options.native === true
        ? 'Skill seed mode: native Threadnote resource catalog (--native is retained as a compatibility alias).'
        : 'Skill seed mode: native Threadnote resource catalog.',
    );
    for (const skill of catalogItems) {
      yield* log(`${skill.kind === 'command' ? 'Command' : 'Skill'} ${skill.source}: ${skill.filePath}`);
      const destinationUri = skillResourceUri(skill);
      if (options.dryRun === true) {
        yield* log(`Would seed skill resource: ${skill.filePath} -> ${destinationUri}`);
      } else {
        mutations.push({
          content: skill.content,
          options: {mode: 'upsert'},
          type: 'write',
          uri: destinationUri,
        });
      }
    }
    if (options.dryRun !== true) {
      yield* store.mutate(resourceStoreLocation(config), mutations);
    }
    yield* log(`Skill seed complete: ${catalogItems.length} unique catalog item(s).`);
  });
}

export const resolveRepoRoot = Effect.fn('seeding.resolveRepoRoot')(function* (repoInput: string) {
  const inputPath = yield* expandPath(repoInput);
  if (!(yield* isDirectory(inputPath))) {
    return yield* SeedingOperationError.make({message: `Repo path is not a directory: ${inputPath}`});
  }
  return (yield* gitValue(['rev-parse', '--show-toplevel'], inputPath)) ?? inputPath;
});

const projectIdentity = Effect.fn('seeding.projectIdentity')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const expanded = yield* expandPath(path);
  return yield* fs.realPath(expanded).pipe(Effect.orElseSucceed(() => expanded));
});

export const projectManifestForRepo = Effect.fn('seeding.projectManifestForRepo')(function* (
  repoRoot: string,
  existingProjects: readonly ProjectManifest[],
) {
  const path = yield* Path.Path;
  const baseName = uriSegment((yield* resolveRepoName(repoRoot)) ?? path.basename(repoRoot));
  const usedNames = new Set(EffectArray.map(existingProjects, project => project.name));
  const usedUris = new Set(EffectArray.map(existingProjects, project => project.uri));
  let name = baseName;
  let uri = `threadnote://resources/repos/${name}`;
  if (usedNames.has(name) || usedUris.has(uri)) {
    name = `${baseName}-${Effect2.pipe(yield* sha256(repoRoot), EffectString.slice(0, 8))}`;
    uri = `threadnote://resources/repos/${name}`;
  }
  return {
    name,
    path: yield* portablePath(repoRoot),
    seed: DEFAULT_SEED_PATTERNS,
    uri,
  };
});

const visitSeedCandidates = Effect.fn('seeding.visitSeedCandidates')(function* (
  project: ProjectManifest,
  projectRoot: string,
  ignorePatterns: readonly string[],
  visit: (candidate: SeedCandidate) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const seen = new Set<string>();
  const budget: SeedWalkBudget = {candidates: 0, entries: 0};
  const logicalRoot = path.resolve(projectRoot);
  const resolvedRoot = yield* optionOnSeedNotFound(Effect.all([fs.realPath(logicalRoot), fs.stat(logicalRoot)]));
  if (resolvedRoot._tag === 'None' || resolvedRoot.value[1].type !== 'Directory') {
    return yield* SeedingOperationError.make({message: `Project path is not a readable directory: ${projectRoot}`});
  }
  const boundary: SeedTraversalBoundary = {
    inspections: new Map([[logicalRoot, {type: 'Directory'}]]),
    logicalRoot,
    realRoot: resolvedRoot.value[0],
  };
  const patterns = yield* Effect.try({
    try: () => validateProjectSeedPatterns(project.seed),
    catch: cause =>
      SeedingOperationError.make({message: cause instanceof Error ? cause.message : 'Invalid project seed patterns.'}),
  });
  for (const pattern of patterns) {
    yield* visitProjectPattern(boundary, pattern, ignorePatterns, budget, filePath =>
      Effect.gen(function* () {
        const relativePath = toPosixPath(path.relative(boundary.logicalRoot, filePath));
        if (seen.has(relativePath)) {
          return;
        }
        seen.add(relativePath);
        budget.candidates += 1;
        if (budget.candidates > MAX_SEED_CANDIDATES_PER_PROJECT) {
          return yield* SeedingOperationError.make({
            message: `candidate limit exceeded (${MAX_SEED_CANDIDATES_PER_PROJECT}); narrow the project's seed patterns`,
          });
        }
        yield* visit({
          destinationUri: `${trimTrailingSlash(project.uri)}/${relativePath}`,
          filePath,
          projectName: project.name,
          relativePath,
        });
      }),
    );
  }
});

const visitProjectPattern = Effect.fn('seeding.visitProjectPattern')(function* (
  boundary: SeedTraversalBoundary,
  pattern: string,
  ignorePatterns: readonly string[],
  budget: SeedWalkBudget,
  visitFile: (filePath: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalizedPattern = yield* Effect.try({
    try: () => toPosixPath(validateProjectSeedPattern(pattern)),
    catch: cause =>
      SeedingOperationError.make({message: cause instanceof Error ? cause.message : 'Invalid project seed pattern.'}),
  });
  if (!hasGlob(normalizedPattern)) {
    const filePath = path.join(boundary.logicalRoot, normalizedPattern);
    const relativePath = toPosixPath(path.relative(boundary.logicalRoot, filePath));
    const inspection = yield* inspectSeedPathWithinBoundary(fs, path, boundary, filePath);
    if (inspection?.type === 'File' && !matchesIgnore(relativePath, ignorePatterns)) {
      yield* visitFile(filePath);
    }
    return;
  }

  const globBase = getGlobBase(normalizedPattern);
  const basePath = path.join(boundary.logicalRoot, globBase);
  if (!(yield* inspectSeedPathWithinBoundary(fs, path, boundary, basePath))) {
    return;
  }

  const regex = globToRegExp(normalizedPattern);
  const patternDepth = EffectArray.filter(
    Effect2.pipe(normalizedPattern, EffectString.split('/')),
    segment => segment !== '' && segment !== '.',
  ).length;
  const recursiveGlob = Effect2.pipe(normalizedPattern, EffectString.includes('**'));
  const explicitlyIncludedHiddenDirectories = new Set(
    EffectArray.filter(
      Effect2.pipe(normalizedPattern, EffectString.split('/')),
      __effectArrayValue2 =>
        !!(segment =>
          Effect2.pipe(segment, EffectString.startsWith('.')) &&
          segment !== '.' &&
          segment !== '..' &&
          !hasGlob(segment))(__effectArrayValue2),
    ),
  );
  const visitPath: (
    currentPath: string,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo> = Effect.fn(
    'seeding.visitProjectPath',
  )(function* (currentPath: string) {
    const relativePath = toPosixPath(path.relative(boundary.logicalRoot, currentPath));
    if (relativePath !== '' && matchesIgnore(relativePath, ignorePatterns)) {
      return;
    }
    const inspection = yield* inspectSeedPathWithinBoundary(fs, path, boundary, currentPath);
    if (!inspection) {
      return;
    }
    if (inspection.type === 'File') {
      if (regex.test(relativePath)) {
        yield* visitFile(currentPath);
      }
      return;
    }
    if (inspection.type !== 'Directory') {
      return;
    }
    const directoryName = Effect2.pipe(relativePath, EffectString.split('/')).at(-1) ?? '';
    if (
      Effect2.pipe(directoryName, EffectString.startsWith('.')) &&
      relativePath !== '' &&
      !explicitlyIncludedHiddenDirectories.has(directoryName)
    ) {
      return;
    }
    const directoryDepth =
      relativePath === ''
        ? 0
        : EffectArray.filter(
            Effect2.pipe(relativePath, EffectString.split('/')),
            segment => segment !== '' && segment !== '.',
          ).length;
    if (!recursiveGlob && directoryDepth >= patternDepth) {
      return;
    }
    for (const entry of yield* fs.readDirectory(currentPath)) {
      const entryPath = path.join(currentPath, entry);
      const entryRelativePath = toPosixPath(path.relative(boundary.logicalRoot, entryPath));
      if (matchesIgnore(entryRelativePath, ignorePatterns)) {
        continue;
      }
      budget.entries += 1;
      if (budget.entries > MAX_SEED_WALK_ENTRIES_PER_PROJECT) {
        return yield* SeedingOperationError.make({
          message: `filesystem traversal limit exceeded (${MAX_SEED_WALK_ENTRIES_PER_PROJECT} entries); narrow the project's seed patterns or extend .threadnoteignore`,
        });
      }
      yield* visitPath(entryPath);
    }
  });
  yield* visitPath(basePath);
});

/**
 * Resolves a logical seed path only through regular directory entries beneath
 * the canonical project boundary. The per-project cache preserves the bounded
 * walk's linear behavior while checking every path component exactly once.
 */
function inspectSeedPathWithinBoundary(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  boundary: SeedTraversalBoundary,
  candidate: string,
): Effect.Effect<SeedPathInspection | undefined, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const resolvedCandidate = path.resolve(candidate);
    const relativePath = path.relative(boundary.logicalRoot, resolvedCandidate);
    if (pathEscapesSeedBoundary(relativePath, path)) {
      return undefined;
    }
    if (relativePath === '') {
      return boundary.inspections.get(boundary.logicalRoot) ?? undefined;
    }

    let currentPath = boundary.logicalRoot;
    const segments = EffectArray.filter(
      Effect2.pipe(relativePath, EffectString.split(path.sep)),
      segment => segment !== '' && segment !== '.',
    );
    for (let index = 0; index < segments.length; index += 1) {
      currentPath = path.join(currentPath, segments[index]);
      let inspection = boundary.inspections.get(currentPath);
      if (inspection === undefined && !boundary.inspections.has(currentPath)) {
        const link = yield* readSeedLink(fs, currentPath);
        if (Option.isSome(link)) {
          boundary.inspections.set(currentPath, null);
          return undefined;
        }
        const inspectedPath = yield* optionOnSeedNotFound(Effect.all([fs.realPath(currentPath), fs.stat(currentPath)]));
        const expectedRealPath = path.resolve(boundary.realRoot, path.relative(boundary.logicalRoot, currentPath));
        if (Option.isNone(inspectedPath) || path.relative(expectedRealPath, inspectedPath.value[0]) !== '') {
          boundary.inspections.set(currentPath, null);
          return undefined;
        }
        const info = inspectedPath.value[1];
        inspection = {
          type: info.type === 'Directory' ? 'Directory' : info.type === 'File' ? 'File' : 'Other',
        };
        boundary.inspections.set(currentPath, inspection);
      }
      if (!inspection || (index < segments.length - 1 && inspection.type !== 'Directory')) {
        return undefined;
      }
    }
    return boundary.inspections.get(resolvedCandidate) ?? undefined;
  });
}

function pathEscapesSeedBoundary(relativePath: string, path: Path.Path): boolean {
  return (
    relativePath === '..' ||
    Effect2.pipe(relativePath, EffectString.startsWith(`..${path.sep}`)) ||
    path.isAbsolute(relativePath)
  );
}

const prepareSeedContent = Effect.fn('seeding.prepareSeedContent')(function* (
  candidate: SeedCandidate,
  bytes: Uint8Array,
) {
  const content = new TextDecoder().decode(bytes);
  const preRedactedContent = shouldRedactPath(candidate.relativePath)
    ? redactContent(candidate.relativePath, content)
    : content;
  const scrubbed = applyScrubber(preRedactedContent, {redact: true});
  if (scrubbed.blocker !== undefined) {
    yield* Console.log(
      `SKIP ${candidate.projectName}/${candidate.relativePath}: possible secret (${scrubbed.blocker})`,
    );
    return undefined;
  }

  return scrubbed.cleaned;
});

function resourceStoreLocation(config: RuntimeConfig) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  } as const;
}

const collectSkillCandidates = Effect.fn('seeding.collectSkillCandidates')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const sources: Array<{
    readonly kind: SkillCandidate['kind'];
    readonly pattern: string;
    readonly source: string;
  }> = [
    {kind: 'skill', pattern: '~/.codex/skills/**/SKILL.md', source: 'codex-global'},
    {kind: 'skill', pattern: '~/.codex/plugins/cache/**/skills/**/SKILL.md', source: 'codex-plugin-cache'},
    {kind: 'skill', pattern: '~/.claude/skills/**/SKILL.md', source: 'claude-global'},
    {kind: 'skill', pattern: '~/.cursor/skills/**/SKILL.md', source: 'cursor-global'},
    {kind: 'command', pattern: '~/.claude/commands/**/*.md', source: 'claude-commands-global'},
  ];

  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'Some') {
    for (const project of manifest.value.projects) {
      sources.push({
        kind: 'skill',
        pattern: `${project.path}/.claude/skills/**/SKILL.md`,
        source: `repo-local:${project.name}`,
      });
      sources.push({
        kind: 'command',
        pattern: `${project.path}/.claude/commands/**/*.md`,
        source: `repo-local:${project.name}:claude-commands`,
      });
    }
  } else {
    yield* Console.log('WARN cannot read manifest for repo-local skill/command discovery.');
  }

  const seenHashes = new Set<string>();
  const skills: SkillCandidate[] = [];
  for (const source of sources) {
    const files = yield* resolveAbsolutePattern(yield* expandPath(source.pattern));
    for (const filePath of files) {
      const content = yield* fs.readFileString(filePath);
      const scrubbed = applyScrubber(content, {redact: true});
      if (scrubbed.blocker !== undefined) {
        yield* Console.log(`SKIP skill with possible secret (${scrubbed.blocker}): ${filePath}`);
        continue;
      }
      const hash = yield* sha256(scrubbed.cleaned);
      if (seenHashes.has(hash)) {
        continue;
      }
      seenHashes.add(hash);
      skills.push({content: scrubbed.cleaned, filePath, hash, kind: source.kind, source: source.source});
    }
  }
  return skills;
});

const resolveAbsolutePattern = Effect.fn('seeding.resolveAbsolutePattern')(function* (pattern: string) {
  const normalizedPattern = toPosixPath(pattern);
  if (!hasGlob(normalizedPattern)) {
    return (yield* isFile(normalizedPattern)) ? [normalizedPattern] : [];
  }
  const globBase = getGlobBase(normalizedPattern);
  const basePath = Effect2.pipe(globBase, EffectString.startsWith('/')) ? globBase : `/${globBase}`;
  if (!(yield* exists(basePath))) {
    return [];
  }
  const regex = globToRegExp(normalizedPattern);
  const files = yield* walkFiles(basePath);
  return EffectArray.filter(
    files,
    (filePath, __effectArrayIndex) => __effectArrayIndex in files && regex.test(toPosixPath(filePath)),
  );
});

function skillResourceUri(skill: SkillCandidate): string {
  return `threadnote://resources/agent-skills/${uriSegment(skill.source)}/${skillResourceName(skill)}-${Effect2.pipe(skill.hash, EffectString.slice(0, 12))}.md`;
}

function skillResourceName(skill: SkillCandidate): string {
  const parts = Effect2.pipe(toPosixPath(skill.filePath), EffectString.split('/'));
  const fileName = parts.at(-1) ?? skill.filePath;
  if (Effect2.pipe(fileName, EffectString.toLowerCase) === 'skill.md') {
    return uriSegment(parts.at(-2) ?? 'skill');
  }
  const extensionIndex = Effect2.pipe(
    fileName,
    EffectString.lastIndexOf('.'),
    Effect2.Option.getOrElse(() => -1),
  );
  const stem = extensionIndex > 0 ? Effect2.pipe(fileName, EffectString.slice(0, extensionIndex)) : fileName;
  return uriSegment(stem);
}

const loadIgnorePatterns = Effect.fn('seeding.loadIgnorePatterns')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs.readFileString(path.join(yield* toolRoot(), '.threadnoteignore'));
  return EffectArray.filter(
    EffectArray.map(Effect2.pipe(raw, EffectString.split('\n')), line => Effect2.pipe(line, EffectString.trim)),
    line => line.length > 0 && !Effect2.pipe(line, EffectString.startsWith('#')),
  );
});

function matchesIgnore(relativePath: string, patterns: readonly string[]): boolean {
  const path = toPosixPath(relativePath);
  for (const pattern of patterns) {
    const normalizedPattern = toPosixPath(pattern);
    if (Effect2.pipe(normalizedPattern, EffectString.endsWith('/'))) {
      const directory = Effect2.pipe(normalizedPattern, EffectString.slice(0, -1));
      if (
        path === directory ||
        Effect2.pipe(path, EffectString.includes(`/${directory}/`)) ||
        Effect2.pipe(path, EffectString.startsWith(`${directory}/`))
      ) {
        return true;
      }
      continue;
    }
    if (globToRegExp(normalizedPattern).test(path) || globToRegExp(`**/${normalizedPattern}`).test(path)) {
      return true;
    }
  }
  return false;
}

function shouldRedactPath(relativePath: string): boolean {
  const path = toPosixPath(relativePath);
  return (
    Effect2.pipe(path, EffectString.endsWith('.mcp.json')) ||
    Effect2.pipe(path, EffectString.endsWith('config.toml')) ||
    Effect2.pipe(path, EffectString.includes('/settings')) ||
    Effect2.pipe(path, EffectString.includes('/settings.local'))
  );
}

function redactContent(relativePath: string, content: string): string {
  if (Effect2.pipe(relativePath, EffectString.endsWith('.json'))) {
    const parsed = Result.try((): unknown => JSON.parse(content));
    return Result.isSuccess(parsed)
      ? `${JSON.stringify(redactJsonValue(parsed.success), null, 2)}\n`
      : redactText(content);
  }
  return redactText(content);
}

function redactJsonValue(value: unknown): unknown {
  if (EffectArray.isArray(value)) {
    return EffectArray.map(value, item => redactJsonValue(item));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of EffectRecord.toEntries(value)) {
    output[key] = isSensitiveKey(key) ? '[REDACTED]' : redactJsonValue(nestedValue);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|credential|authorization|api[_-]?key|client[_-]?secret|bearer/i.test(key);
}
