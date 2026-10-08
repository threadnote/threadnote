import * as yaml from 'js-yaml';
import {Console, Crypto, DateTime, Effect, FileSystem, Path, Result, Schema} from 'effect';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {ResourceStore} from '@threadnote/store/resource-store';
import {readSeedManifest, uriSegment} from '@threadnote/workspace/manifest';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/hygiene';
import {MemoryOperationError, migrateMemoryDocumentV4ToV5} from '@threadnote/memory/migrations';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  memoryHeaderValue,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import type {MigrateLifecycleOptions, MigrateMemoriesOptions, MigrateProjectNamesOptions} from '../types.js';
import type {ProjectManifest, RuntimeConfig} from '@threadnote/workspace/config';
import {
  ensureDirectory,
  gitValue,
  isJsonObject,
  parentResourceUri,
  parsePositiveInteger,
  readFileIfExists,
  resolveGitRemoteRepoName,
  resolveRepoFolderName,
  safeTimestamp,
  sha256,
  trimTrailingSlash,
} from '../utils.js';
import {errorMessage} from '@threadnote/platform/errors';
import {expandPath} from '@threadnote/platform/paths';
import {writeMemoryFile} from '../share/index.js';

interface LegacyMemoryCandidate {
  readonly comparableHash: string;
  readonly hash: string;
  readonly sourceAccount: string;
  readonly sourceArchive: string;
  readonly sourceSession: string;
  readonly text: string;
}

interface LifecycleHandoffCandidate {
  readonly metadata: MemoryMetadata;
  readonly original: string;
  readonly sourceUri: string;
}

interface ProjectNameMigrationContext {
  readonly newProject: string;
  readonly newSegment: string;
  readonly oldProject: string;
  readonly oldSegment: string;
  readonly repoRoot: string;
}

interface ProjectNameMigrationCandidate {
  readonly destinationContent: string;
  readonly destinationExistsWithSameContent: boolean;
  readonly destinationUri: string;
  readonly sourceContent: string;
  readonly sourceUri: string;
}

interface ProjectNameMigrationProjectEvidence {
  oldProject: string;
  readonly oldSegment: string;
  readonly repoPaths: Set<string>;
}

interface ProjectMemoryLocation {
  readonly relativePath: readonly string[];
  readonly uriPath: string;
}

export {MemoryOperationError, migrateMemoryDocumentV4ToV5};

export const attemptSync = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(MemoryOperationError)(cause) ? cause : MemoryOperationError.make({cause, message: errorMessage(cause)}),
  });

export const NATIVE_RESOURCE_BACKEND = 'threadnote-native';

export const runMigrateMemories = Effect.fn('runMigrateMemories')(function* (
  config: RuntimeConfig,
  options: MigrateMemoriesOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dryRun = options.dryRun === true;
  const limit = options.limit
    ? yield* attemptSync(() => parsePositiveInteger(options.limit!, 'migration limit'))
    : undefined;
  const sourceAccounts = yield* legacySourceAccounts(config, options);
  if (sourceAccounts.length === 0) {
    yield* Console.log('No local canonical accounts found to scan.');
    return;
  }

  const candidates = yield* legacyMemoryCandidates(config, sourceAccounts);
  const existingHashes = yield* existingDurableMemoryHashes(config);
  const ov = NATIVE_RESOURCE_BACKEND;
  const migrationPath = path.join(config.agentContextHome, 'legacy-memory-migration.txt');

  let duplicateCount = 0;
  let migratedCount = 0;
  let sensitiveCount = 0;
  if (!dryRun && candidates.length > 0) {
    yield* ensureDurableMemoryDirectory(ov, config);
  }

  const migrate = Effect.gen(function* () {
    for (const candidate of candidates) {
      if (existingHashes.has(candidate.hash)) {
        duplicateCount += 1;
        continue;
      }
      if (existingHashes.has(candidate.comparableHash)) {
        duplicateCount += 1;
        continue;
      }
      const sensitiveReason = sensitiveMemoryReason(candidate.text);
      if (sensitiveReason) {
        sensitiveCount += 1;
        yield* Console.log(
          `SKIP ${legacySourceLabel(candidate)}: possible ${sensitiveReason}; inspect the source archive manually if needed.`,
        );
        continue;
      }
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }

      const memoryUri = migratedDurableMemoryUri(config, candidate.hash);
      if (!dryRun && (yield* resourceExists(ov, config, memoryUri))) {
        duplicateCount += 1;
        existingHashes.add(candidate.hash);
        continue;
      }

      yield* Console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${legacySourceLabel(candidate)} -> ${memoryUri}`);
      if (!dryRun) {
        yield* fs.writeFileString(migrationPath, candidate.text, {mode: 0o600});
        yield* fs.chmod(migrationPath, 0o600);
        yield* writeDurableMemoryFile(ov, config, memoryUri, migrationPath, 'create');
        existingHashes.add(candidate.hash);
      }
      migratedCount += 1;
    }
  }).pipe(Effect.ensuring(dryRun ? Effect.void : Effect.ignore(fs.remove(migrationPath, {force: true}))));

  yield* migrate;
  yield* Console.log(
    [
      `Migration summary: ${migratedCount} ${dryRun ? 'would be migrated' : 'migrated'}`,
      `${duplicateCount} duplicate(s) skipped`,
      `${sensitiveCount} sensitive-looking item(s) skipped`,
      `${candidates.length} legacy Threadnote item(s) scanned`,
      `source account(s): ${sourceAccounts.join(', ')}`,
    ].join('; '),
  );
});

export const runMigrateLifecycle = Effect.fn('runMigrateLifecycle')(function* (
  config: RuntimeConfig,
  options: MigrateLifecycleOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'lifecycle migration limit') : undefined;
  const ov = NATIVE_RESOURCE_BACKEND;
  const candidates = yield* legacyLifecycleHandoffCandidates(config);
  const migrationPath = path.join(config.agentContextHome, 'lifecycle-memory-migration.txt');
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;

  yield* Effect.gen(function* () {
    for (const candidate of candidates) {
      if (limit !== undefined && migratedCount >= limit) {
        break;
      }
      const destinationUri = lifecycleMigrationUri(
        config,
        candidate.metadata,
        yield* sha256(candidate.original.trim()),
      );
      const migratedMemory = formatMemoryDocument(
        'HANDOFF',
        candidate.metadata,
        ['Migrated legacy handoff from the historical events trail.', '', candidate.original.trim()].join('\n'),
      );

      yield* Console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${candidate.sourceUri} -> ${destinationUri}`);
      if (!dryRun) {
        if (yield* resourceExists(ov, config, destinationUri)) {
          existingCount += 1;
          yield* Console.log(`Archived copy already exists; cleaning up legacy source: ${candidate.sourceUri}`);
        } else {
          yield* fs.writeFileString(migrationPath, migratedMemory, {mode: 0o600});
          yield* fs.chmod(migrationPath, 0o600);
          yield* ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, candidate.metadata));
          yield* writeDurableMemoryFile(ov, config, destinationUri, migrationPath, 'create');
        }
        const removedOriginal = yield* removeResourceWithRetry(ov, config, candidate.sourceUri, {
          expectedContent: candidate.original,
        });
        if (!removedOriginal) {
          yield* Console.error(
            `Migrated copy stored, but original is still processing. Retry later: threadnote forget ${candidate.sourceUri}`,
          );
          skippedCount += 1;
        }
      }
      migratedCount += 1;
    }
  }).pipe(Effect.ensuring(dryRun ? Effect.void : fs.remove(migrationPath, {force: true}).pipe(Effect.ignore)));

  yield* Console.log(
    [
      `Lifecycle migration summary: ${migratedCount} clear legacy handoff(s) ${dryRun ? 'would be migrated' : 'migrated'}`,
      `${existingCount} existing archived copy/copies reused`,
      `${skippedCount} legacy source(s) still processing`,
      `${candidates.length} clear legacy handoff candidate(s) found`,
      dryRun ? 'Run with --apply to perform this migration.' : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; '),
  );
});

export const runMigrateProjectNames = Effect.fn('runMigrateProjectNames')(function* (
  config: RuntimeConfig,
  options: MigrateProjectNamesOptions,
) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const limit = options.limit ? parsePositiveInteger(options.limit, 'project-name migration limit') : undefined;
  const contexts = yield* projectNameMigrationContexts(config);
  if (contexts.length === 0) {
    yield* Console.log('No git remote project-name changes apply across configured projects.');
    return;
  }

  const plans: Array<{
    readonly candidates: readonly ProjectNameMigrationCandidate[];
    readonly context: ProjectNameMigrationContext;
  }> = [];
  let remaining = limit;
  for (const context of contexts) {
    const candidates = remaining === 0 ? [] : yield* projectNameMigrationCandidates(config, context, remaining);
    plans.push({candidates, context});
    if (remaining !== undefined) {
      remaining = Math.max(0, remaining - candidates.length);
    }
  }
  const seedManifestMigration = yield* seedManifestProjectNameMigration(config, contexts);
  if (!plans.some(plan => plan.candidates.length > 0) && !seedManifestMigration) {
    yield* Console.log('No project-name migration candidates found across configured projects.');
    return;
  }

  const seedManifestUpdated = yield* migrateSeedManifestProjectNames(config, seedManifestMigration, dryRun);
  let existingCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;
  const candidates = plans.flatMap(plan => [...plan.candidates]);
  if (candidates.length > 0) {
    const ov = NATIVE_RESOURCE_BACKEND;
    for (const candidate of candidates) {
      const action = candidate.destinationExistsWithSameContent
        ? dryRun
          ? 'Would consolidate duplicate'
          : 'Consolidating duplicate'
        : dryRun
          ? 'Would migrate'
          : 'Migrating';
      yield* Console.log(`${action} ${candidate.sourceUri} -> ${candidate.destinationUri}`);
      if (!dryRun) {
        if (candidate.destinationExistsWithSameContent) {
          existingCount += 1;
        } else {
          yield* ensureMemoryDirectory(ov, config, parentResourceUri(candidate.destinationUri));
          yield* writeMemoryFile(config, ov, candidate.destinationUri, candidate.destinationContent, 'create', false);
        }
        const removedOriginal = yield* removeResourceWithRetry(ov, config, candidate.sourceUri, {
          expectedContent: candidate.sourceContent,
        });
        if (!removedOriginal) {
          yield* Console.error(
            `Migrated copy stored, but original is still processing. Retry later: threadnote forget ${candidate.sourceUri}`,
          );
          skippedCount += 1;
        }
      }
      migratedCount += 1;
    }
  }
  const activeContexts = projectNameMigrationActiveContexts(plans, seedManifestMigration);
  const newProjectsToSeed = [...new Set(seedManifestMigration?.newProjects ?? [])];

  yield* Console.log(
    [
      projectNameMigrationSummary(migratedCount, dryRun, activeContexts),
      seedManifestUpdated ? `seed manifest ${dryRun ? 'would be updated' : 'updated'}` : 'seed manifest unchanged',
      `${existingCount} duplicate destination(s) reused`,
      `${skippedCount} source(s) still processing`,
      dryRun ? 'Run with --apply to perform this migration.' : undefined,
      ...newProjectsToSeed.map(
        project => `Run threadnote seed --only ${project} to re-ingest seeded resources under the new project URI.`,
      ),
    ]
      .filter((part): part is string => part !== undefined)
      .join('; '),
  );
});

export const hasProjectNameMigrationCandidates = Effect.fn('memory.hasProjectNameMigrationCandidates')(function* (
  config: RuntimeConfig,
) {
  const contexts = yield* projectNameMigrationContexts(config);
  if (contexts.length === 0) {
    return false;
  }
  for (const context of contexts) {
    if ((yield* projectNameMigrationCandidates(config, context, 1)).length > 0) {
      return true;
    }
  }
  return (yield* seedManifestProjectNameMigration(config, contexts)) !== undefined;
});

const projectNameMigrationContexts = Effect.fn('memory.projectNameMigrationContexts')(function* (
  config: RuntimeConfig,
) {
  const evidence = yield* projectNameMigrationMemoryEvidence(config);
  const contexts: ProjectNameMigrationContext[] = [];
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'Some') {
    for (const project of manifest.value.projects) {
      const projectEvidence = evidence.get(uriSegment(project.name));
      if (projectEvidence) {
        projectEvidence.repoPaths.add(yield* expandPath(project.path));
      }
    }
  }
  for (const projectEvidence of evidence.values()) {
    for (const repoPath of projectEvidence.repoPaths) {
      const context = yield* projectNameMigrationContextForRepoPath(projectEvidence.oldProject, repoPath);
      if (context) {
        contexts.push(context);
      }
    }
  }
  const currentContext = yield* currentWorkspaceProjectNameMigrationContext(evidence);
  if (currentContext) {
    contexts.push(currentContext);
  }
  return dedupeProjectNameMigrationContexts(contexts);
});

const projectNameMigrationMemoryEvidence = Effect.fn('memory.projectNameMigrationMemoryEvidence')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const evidence = new Map<string, ProjectNameMigrationProjectEvidence>();
  for (const location of projectMemoryLocations()) {
    const locationRoot = path.join(yield* localUserMemoriesRoot(config), ...location.relativePath);
    const projectEntries = yield* fs.readDirectory(locationRoot).pipe(Effect.option);
    if (projectEntries._tag === 'None') {
      continue;
    }
    for (const projectEntry of projectEntries.value) {
      if (projectEntry.startsWith('.')) {
        continue;
      }
      const projectDirectory = path.join(locationRoot, projectEntry);
      const projectInfo = yield* fs.stat(projectDirectory).pipe(Effect.option);
      if (projectInfo._tag === 'None' || projectInfo.value.type !== 'Directory') {
        continue;
      }
      const oldSegment = projectEntry;
      const projectEvidence = ensureProjectNameMigrationEvidence(evidence, oldSegment);
      const memoryEntries = yield* fs.readDirectory(projectDirectory).pipe(Effect.option);
      if (memoryEntries._tag === 'None') {
        continue;
      }
      for (const memoryEntry of memoryEntries.value) {
        if (memoryEntry.startsWith('.') || !memoryEntry.endsWith('.md')) {
          continue;
        }
        const memoryPath = path.join(projectDirectory, memoryEntry);
        const memoryInfo = yield* fs.stat(memoryPath).pipe(Effect.option);
        if (memoryInfo._tag === 'None' || memoryInfo.value.type !== 'File') {
          continue;
        }
        const content = yield* readTextIfExists(memoryPath);
        if (!content) {
          continue;
        }
        const sourceUri = `threadnote://user/${uriSegment(config.user)}/memories/${location.uriPath}/${oldSegment}/${memoryEntry}`;
        const record = parseMemoryDocument(sourceUri, content);
        if (record?.metadata.project && uriSegment(record.metadata.project) === oldSegment) {
          projectEvidence.oldProject = record.metadata.project;
        }
        const repoPath = yield* repoPathEvidenceFromMemory(content);
        if (repoPath) {
          projectEvidence.repoPaths.add(repoPath);
        }
      }
    }
  }
  return evidence;
});

function ensureProjectNameMigrationEvidence(
  evidence: Map<string, ProjectNameMigrationProjectEvidence>,
  oldSegment: string,
): ProjectNameMigrationProjectEvidence {
  const existing = evidence.get(oldSegment);
  if (existing) {
    return existing;
  }
  const created: ProjectNameMigrationProjectEvidence = {oldProject: oldSegment, oldSegment, repoPaths: new Set()};
  evidence.set(oldSegment, created);
  return created;
}

const repoPathEvidenceFromMemory = Effect.fn('memory.repoPathEvidenceFromMemory')(function* (content: string) {
  const match = /^repo_path:\s*(.+)$/m.exec(content);
  if (!match?.[1]) {
    return undefined;
  }
  const cleaned = match[1]
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;]+$/g, '');
  if (!cleaned.startsWith('/') && !cleaned.startsWith('~/')) {
    return undefined;
  }
  return yield* expandPath(cleaned);
});

const projectNameMigrationContextForRepoPath = Effect.fn('memory.projectNameMigrationContextForRepoPath')(function* (
  oldProject: string,
  repoPath: string,
) {
  const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel'], repoPath);
  if (!repoRoot) {
    return undefined;
  }
  const newProject = yield* resolveGitRemoteRepoName(repoRoot);
  if (!newProject) {
    return undefined;
  }
  return projectNameMigrationContextFromParts({
    newProject,
    oldProject,
    repoRoot,
  });
});

const currentWorkspaceProjectNameMigrationContext = Effect.fn('memory.currentWorkspaceProjectNameMigrationContext')(
  function* (evidence: Map<string, ProjectNameMigrationProjectEvidence>) {
    const repoRoot = yield* gitValue(['rev-parse', '--show-toplevel']);
    if (!repoRoot) {
      return undefined;
    }
    const newProject = yield* resolveGitRemoteRepoName(repoRoot);
    const oldProject = yield* resolveRepoFolderName(repoRoot);
    if (!newProject || !oldProject) {
      return undefined;
    }
    const oldSegment = uriSegment(oldProject);
    if (!evidence.has(oldSegment)) {
      return undefined;
    }
    return projectNameMigrationContextFromParts({newProject, oldProject, repoRoot});
  },
);

function projectNameMigrationContextFromParts(params: {
  readonly newProject: string;
  readonly oldProject: string;
  readonly repoRoot: string;
}): ProjectNameMigrationContext | undefined {
  const newSegment = uriSegment(params.newProject);
  const oldSegment = uriSegment(params.oldProject);
  if (newSegment === oldSegment) {
    return undefined;
  }
  return {
    newProject: params.newProject,
    newSegment,
    oldProject: params.oldProject,
    oldSegment,
    repoRoot: params.repoRoot,
  };
}

function dedupeProjectNameMigrationContexts(
  contexts: readonly ProjectNameMigrationContext[],
): readonly ProjectNameMigrationContext[] {
  const seen = new Set<string>();
  const out: ProjectNameMigrationContext[] = [];
  for (const context of contexts) {
    const key = `${context.oldSegment}\0${context.newSegment}\0${context.repoRoot}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(context);
  }
  return out;
}

const projectNameMigrationCandidates = Effect.fn('memory.projectNameMigrationCandidates')(function* (
  config: RuntimeConfig,
  context: ProjectNameMigrationContext,
  limit?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: ProjectNameMigrationCandidate[] = [];
  for (const location of projectMemoryLocations()) {
    const sourceDirectory = path.join(
      yield* localUserMemoriesRoot(config),
      ...location.relativePath,
      context.oldSegment,
    );
    const sourceDirectoryUri = `threadnote://user/${uriSegment(config.user)}/memories/${location.uriPath}/${context.oldSegment}`;
    const entries = yield* fs.readDirectory(sourceDirectory).pipe(Effect.option);
    if (entries._tag === 'None') {
      continue;
    }
    for (const entry of entries.value) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) {
        continue;
      }
      const sourcePath = path.join(sourceDirectory, entry);
      const sourceInfo = yield* fs.stat(sourcePath).pipe(Effect.option);
      if (sourceInfo._tag === 'None' || sourceInfo.value.type !== 'File') {
        continue;
      }
      const sourceUri = `${sourceDirectoryUri}/${entry}`;
      const content = yield* readTextIfExists(sourcePath);
      if (!content) {
        continue;
      }
      const record = parseMemoryDocument(sourceUri, content);
      if (!record || !canMigrateProjectName(record, context)) {
        continue;
      }
      assertMemoryDocumentSchemaWritable(content);
      const metadata = {...record.metadata, project: context.newProject};
      const destinationDirectoryUri = memoryDirectoryUri(config, metadata);
      const destinationDirectory = yield* localMemoryPathForUri(config, destinationDirectoryUri);
      if (!destinationDirectory) {
        continue;
      }
      const destinationContent = formatMemoryDocument(record.headerTitle, metadata, record.body);
      const destination = yield* projectNameMigrationDestination(
        destinationDirectory,
        entry,
        destinationContent,
        context.oldSegment,
      );
      candidates.push({
        destinationContent,
        destinationExistsWithSameContent: destination.existsWithSameContent,
        destinationUri: `${destinationDirectoryUri}/${destination.filename}`,
        sourceContent: content,
        sourceUri,
      });
      if (limit !== undefined && candidates.length >= limit) {
        return candidates;
      }
    }
  }
  return candidates;
});

function projectNameMigrationActiveContexts(
  plans: readonly {
    readonly candidates: readonly ProjectNameMigrationCandidate[];
    readonly context: ProjectNameMigrationContext;
  }[],
  seedManifestMigration:
    | {
        readonly contexts: readonly ProjectNameMigrationContext[];
        readonly newProjects: readonly string[];
        readonly output: string;
      }
    | undefined,
): readonly ProjectNameMigrationContext[] {
  return dedupeProjectNameMigrationContexts([
    ...plans.filter(plan => plan.candidates.length > 0).map(plan => plan.context),
    ...(seedManifestMigration?.contexts ?? []),
  ]);
}

function projectNameMigrationSummary(
  migratedCount: number,
  dryRun: boolean,
  contexts: readonly ProjectNameMigrationContext[],
): string {
  const memoryWord = migratedCount === 1 ? 'memory' : 'memories';
  const verb = dryRun ? 'would be migrated' : 'migrated';
  if (contexts.length === 1) {
    const [context] = contexts;
    return `Project-name migration summary: ${migratedCount} ${memoryWord} ${verb} from ${context.oldProject} to ${context.newProject}`;
  }
  const renameSummary = contexts.map(context => `${context.oldProject} -> ${context.newProject}`).join(', ');
  return `Project-name migration summary: ${migratedCount} ${memoryWord} ${verb} across ${contexts.length} project rename(s)${renameSummary ? `: ${renameSummary}` : ''}`;
}

const migrateSeedManifestProjectNames = Effect.fn('memory.migrateSeedManifestProjectNames')(function* (
  config: RuntimeConfig,
  migration:
    | {
        readonly contexts: readonly ProjectNameMigrationContext[];
        readonly newProjects: readonly string[];
        readonly output: string;
      }
    | undefined,
  dryRun: boolean,
) {
  if (!migration) {
    return false;
  }
  if (dryRun) {
    yield* Console.log(`Would update seed manifest: ${config.manifestPath}`);
    yield* Console.log(migration.output.trimEnd());
    return true;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* ensureDirectory(path.dirname(config.manifestPath), false);
  const currentContent = yield* readFileIfExists(config.manifestPath);
  if (currentContent !== undefined) {
    const backupPath = `${config.manifestPath}.project-name-${safeTimestamp()}`;
    yield* fs.writeFileString(backupPath, currentContent, {mode: 0o600});
    yield* fs.chmod(backupPath, 0o600);
    yield* Console.log(`Backup: ${backupPath}`);
  }
  yield* fs.writeFileString(config.manifestPath, migration.output, {mode: 0o600});
  yield* fs.chmod(config.manifestPath, 0o600);
  yield* Console.log(`Updated seed manifest: ${config.manifestPath}`);
  return true;
});

const seedManifestProjectNameMigration = Effect.fn('memory.seedManifestProjectNameMigration')(function* (
  config: RuntimeConfig,
  contexts: readonly ProjectNameMigrationContext[],
) {
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  const renamed = new Map<string, ProjectNameMigrationContext>();
  let changed = false;
  const projects = manifest.value.projects.map(project => {
    const context = contexts.find(candidate =>
      isSeedManifestProjectNameCandidate(
        project,
        candidate,
        `threadnote://resources/repos/${candidate.oldSegment}`,
        `threadnote://resources/repos/${candidate.newSegment}`,
      ),
    );
    if (!context) {
      return project;
    }
    const newNameExists = manifest.value.projects.some(
      other => other !== project && uriSegment(other.name) === context.newSegment,
    );
    if (newNameExists || [...renamed.values()].some(existing => existing.newSegment === context.newSegment)) {
      return project;
    }
    changed = true;
    renamed.set(context.oldSegment, context);
    return {
      ...project,
      name: context.newProject,
      uri:
        trimTrailingSlash(project.uri) === `threadnote://resources/repos/${context.oldSegment}`
          ? `threadnote://resources/repos/${context.newSegment}`
          : project.uri,
    };
  });
  const worksets =
    renamed.size > 0
      ? manifest.value.worksets?.map(workset => {
          const members = workset.projects.map(projectName => {
            const context = renamed.get(uriSegment(projectName));
            if (!context) {
              return projectName;
            }
            changed = true;
            return context.newProject;
          });
          return {...workset, projects: members};
        })
      : manifest.value.worksets;
  if (!changed) {
    return undefined;
  }
  return {
    contexts: [...renamed.values()],
    newProjects: [...new Set([...renamed.values()].map(context => context.newProject))],
    output: `${yaml.dump(
      {
        version: manifest.value.version,
        projects: projects.map(project => ({
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
        ...(worksets
          ? {
              worksets: worksets.map(workset => ({
                name: workset.name,
                ...(workset.description ? {description: workset.description} : {}),
                projects: [...workset.projects],
              })),
            }
          : {}),
        ...(manifest.value.futureMonorepo
          ? {
              future_monorepo: {
                path_candidates: [...manifest.value.futureMonorepo.pathCandidates],
                uri: manifest.value.futureMonorepo.uri,
              },
            }
          : {}),
      },
      {lineWidth: 120, noRefs: true},
    )}`,
  };
});

function isSeedManifestProjectNameCandidate(
  project: ProjectManifest,
  context: ProjectNameMigrationContext,
  oldDefaultUri: string,
  newDefaultUri: string,
): boolean {
  const nameSegment = uriSegment(project.name);
  const uriMatchesOld = trimTrailingSlash(project.uri) === oldDefaultUri;
  const pathMatchesRepo = project.path === context.repoRoot || project.path === `~/${context.repoRoot}`;
  if (nameSegment === context.newSegment && !uriMatchesOld) {
    return false;
  }
  if (nameSegment !== context.oldSegment && !uriMatchesOld && !pathMatchesRepo) {
    return false;
  }
  return nameSegment !== context.newSegment || uriMatchesOld || trimTrailingSlash(project.uri) !== newDefaultUri;
}

function canMigrateProjectName(record: MemoryRecord, context: ProjectNameMigrationContext): boolean {
  const projectSegment = record.metadata.project ? uriSegment(record.metadata.project) : context.oldSegment;
  return projectSegment === context.oldSegment || projectSegment === context.newSegment;
}

const projectNameMigrationDestination = Effect.fn('memory.projectNameMigrationDestination')(function* (
  destinationDirectory: string,
  filename: string,
  content: string,
  oldProjectSegment: string,
) {
  const direct = yield* projectNameMigrationDestinationState(destinationDirectory, filename, content);
  if (!direct.exists || direct.sameContent) {
    return {existsWithSameContent: direct.sameContent, filename};
  }
  const stem = filename.replace(/\.md$/i, '');
  const fromOldProject = `${stem}-from-${oldProjectSegment}.md`;
  const renamed = yield* projectNameMigrationDestinationState(destinationDirectory, fromOldProject, content);
  if (!renamed.exists || renamed.sameContent) {
    return {existsWithSameContent: renamed.sameContent, filename: fromOldProject};
  }
  return {
    existsWithSameContent: false,
    filename: `${stem}-from-${oldProjectSegment}-${(yield* sha256(content)).slice(0, 12)}.md`,
  };
});

const projectNameMigrationDestinationState = Effect.fn('memory.projectNameMigrationDestinationState')(function* (
  destinationDirectory: string,
  filename: string,
  content: string,
) {
  const path = yield* Path.Path;
  const existing = yield* readTextIfExists(path.join(destinationDirectory, filename));
  return {exists: existing !== undefined, sameContent: existing?.trim() === content.trim()};
});

function projectMemoryLocations(): readonly ProjectMemoryLocation[] {
  return [
    {relativePath: ['durable', 'projects'], uriPath: 'durable/projects'},
    {relativePath: ['durable', 'archived'], uriPath: 'durable/archived'},
    {relativePath: ['durable', 'superseded'], uriPath: 'durable/superseded'},
    {relativePath: ['handoffs', 'active'], uriPath: 'handoffs/active'},
    {relativePath: ['handoffs', 'archived'], uriPath: 'handoffs/archived'},
    {relativePath: ['handoffs', 'superseded'], uriPath: 'handoffs/superseded'},
    {relativePath: ['incidents', 'active'], uriPath: 'incidents/active'},
    {relativePath: ['incidents', 'archived'], uriPath: 'incidents/archived'},
    {relativePath: ['incidents', 'superseded'], uriPath: 'incidents/superseded'},
  ];
}

export const localMemoryPathForUri = Effect.fn('memory.localMemoryPathForUri')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  if (relative.includes('..') || relative.startsWith('/')) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...relative.split('/'));
});

export const writeDurableMemoryFile = Effect.fn('memory.writeDurableMemoryFile')(function* (
  ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  memoryPath: string,
  writeMode: 'create' | 'replace',
) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFileString(memoryPath);
  yield* writeMemoryFile(config, ov, memoryUri, content, writeMode, false);
});

export function removeResourceWithRetry(
  _ov: string,
  config: RuntimeConfig,
  uri: string,
  options: {
    readonly alreadyLocked?: boolean;
    readonly expectedContent?: string;
    readonly expectedFingerprint?: string;
    readonly recursive?: boolean;
  } = {},
) {
  const remove = Effect.gen(function* () {
    const store = yield* ResourceStore;
    yield* store.remove(resourceStoreLocation(config), uri, {
      recursive: options.recursive === true,
      expectedFingerprint: options.expectedFingerprint,
    });
    return true;
  }).pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)));
  if (options.alreadyLocked) {
    return remove;
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [uri],
      Effect.gen(function* () {
        if (options.expectedContent !== undefined) {
          const localPath = yield* localMemoryPathForUri(config, uri);
          const currentContent = localPath ? yield* readFileIfExists(localPath) : undefined;
          if (currentContent === undefined || currentContent.trim() !== options.expectedContent.trim()) {
            return yield* MemoryOperationError.make({
              message: `Memory changed before removal; review the current content and retry: ${uri}`,
            });
          }
        }
        return yield* remove;
      }),
    );
  });
}

export const resourceExists = Effect.fn('memory.resourceExists')(function* (
  _ov: string,
  config: RuntimeConfig,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

const ensureDurableMemoryDirectory = Effect.fn('memory.ensureDurableMemoryDirectory')(
  (ov: string, config: RuntimeConfig) => ensureMemoryDirectory(ov, config, durableMemoryDirectoryUri(config)),
);

export const ensureMemoryDirectory = Effect.fn('memory.ensureMemoryDirectory')(function* (
  _ov: string,
  config: RuntimeConfig,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  yield* store.makeDirectory(resourceStoreLocation(config), directoryUri);
});

function durableMemoryDirectoryUri(config: RuntimeConfig): string {
  return `threadnote://user/${uriSegment(config.user)}/memories/events`;
}

function migratedDurableMemoryUri(config: RuntimeConfig, hash: string): string {
  return `${durableMemoryDirectoryUri(config)}/threadnote-migrated-${hash.slice(0, 16)}.md`;
}

export const hasLegacyLifecycleHandoffCandidates = Effect.fn('memory.hasLegacyLifecycleHandoffCandidates')(function* (
  config: RuntimeConfig,
) {
  return (yield* legacyLifecycleHandoffCandidates(config, 1)).length > 0;
});

const legacyLifecycleHandoffCandidates = Effect.fn('memory.legacyLifecycleHandoffCandidates')(function* (
  config: RuntimeConfig,
  limit?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const eventsRoot = path.join(yield* localUserMemoriesRoot(config), 'events');
  const entries = yield* fs.readDirectory(eventsRoot).pipe(Effect.option);
  if (entries._tag === 'None') {
    return [];
  }

  const candidates: LifecycleHandoffCandidate[] = [];
  for (const entry of entries.value) {
    if (entry.startsWith('.') || !entry.endsWith('.md')) {
      continue;
    }
    const sourcePath = path.join(eventsRoot, entry);
    const info = yield* fs.stat(sourcePath).pipe(Effect.option);
    if (info._tag === 'None' || info.value.type !== 'File') {
      continue;
    }
    const original = yield* readTextIfExists(sourcePath);
    if (!original || !isClearLegacyHandoffMemory(original) || sensitiveMemoryReason(original)) {
      continue;
    }
    const sourceUri = `${durableMemoryDirectoryUri(config)}/${entry}`;
    candidates.push({
      metadata: {
        archivedFrom: sourceUri,
        kind: 'handoff',
        project: inferLegacyProject(original),
        sourceAgentClient: 'threadnote',
        status: 'archived',
        timestamp: DateTime.formatIso(yield* DateTime.now),
      },
      original,
      sourceUri,
    });
    if (limit !== undefined && candidates.length >= limit) {
      break;
    }
  }
  return candidates;
});

function lifecycleMigrationUri(config: RuntimeConfig, metadata: MemoryMetadata, hash: string): string {
  return `${memoryDirectoryUri(config, metadata)}/legacy-${hash.slice(0, 16)}.md`;
}

export function memoryDirectoryUri(config: RuntimeConfig, metadata: MemoryMetadata): string {
  const baseUri = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(metadata.project ?? 'general');
  switch (metadata.kind) {
    case 'preference':
      return metadata.status === 'active'
        ? `${baseUri}/preferences`
        : `${baseUri}/preferences/${uriSegment(metadata.status)}`;
    case 'handoff':
      return `${baseUri}/handoffs/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'incident':
      return `${baseUri}/incidents/${uriSegment(metadata.status)}/${projectSegment}`;
    case 'smoke':
      return `${baseUri}/smoke/${uriSegment(metadata.status)}`;
    case 'durable':
      return metadata.status === 'active'
        ? `${baseUri}/durable/projects/${projectSegment}`
        : `${baseUri}/durable/${uriSegment(metadata.status)}/${projectSegment}`;
  }
}

export function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  };
}

function isClearLegacyHandoffMemory(memory: string): boolean {
  if (/^kind:\s*/m.test(memory) || /^status:\s*/m.test(memory)) {
    return false;
  }
  const trimmed = memory.trim();
  if (trimmed.startsWith('HANDOFF\n')) {
    return true;
  }
  if (!trimmed.startsWith('MEMORY\n')) {
    return false;
  }
  return /^(?:#+\s*)?(?:final\s+)?handoff(?:\s+update)?\b/i.test(memoryBody(trimmed));
}

function memoryBody(memory: string): string {
  const separatorIndex = memory.indexOf('\n\n');
  return separatorIndex === -1 ? '' : memory.slice(separatorIndex + 2).trim();
}

function inferLegacyProject(memory: string): string {
  const explicit =
    memoryHeaderValue(memory, 'project') ??
    memoryHeaderValue(memory, 'repo') ??
    memoryHeaderValue(memory, 'repo_path') ??
    /\brepo(?:_path)?\s+([~/A-Za-z0-9_.:/-]+)/.exec(memory)?.[1];
  if (!explicit) {
    return 'general';
  }
  const trimmed = explicit.trim().replace(/[`.,;]+$/g, '');
  return trimmed.includes('/') ? (trimmed.split('/').at(-1) ?? trimmed) : trimmed;
}

export function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const legacySourceAccounts = Effect.fn('memory.legacySourceAccounts')(function* (
  config: RuntimeConfig,
  options: MigrateMemoriesOptions,
) {
  const explicitAccounts = options.sourceAccount?.filter(account => account.trim().length > 0) ?? [];
  if (explicitAccounts.length > 0) {
    return uniqueStrings(explicitAccounts);
  }
  if (options.allAccounts === true) {
    const accounts = yield* childDirectoryNames(yield* localDataRoot(config));
    return accounts.filter(account => !account.startsWith('_'));
  }
  return [config.account];
});

const legacyMemoryCandidates = Effect.fn('memory.legacyMemoryCandidates')(function* (
  config: RuntimeConfig,
  sourceAccounts: readonly string[],
) {
  const path = yield* Path.Path;
  const dataRoot = yield* localDataRoot(config);
  const candidates: LegacyMemoryCandidate[] = [];
  for (const sourceAccount of sourceAccounts) {
    const sessionRoot = path.join(dataRoot, sourceAccount, 'session');
    for (const sourceSession of yield* childDirectoryNames(sessionRoot)) {
      const historyRoot = path.join(sessionRoot, sourceSession, 'history');
      for (const sourceArchive of yield* childDirectoryNames(historyRoot)) {
        if (!sourceArchive.startsWith('archive_')) {
          continue;
        }
        const sourcePath = path.join(historyRoot, sourceArchive, 'messages.jsonl');
        for (const text of yield* legacyMemoryTexts(sourcePath)) {
          candidates.push({
            comparableHash: yield* sha256(comparableMemoryText(text)),
            hash: yield* sha256(text),
            sourceAccount,
            sourceArchive,
            sourceSession,
            text,
          });
        }
      }
    }
  }
  return candidates.sort((left, right) => legacySourceLabel(left).localeCompare(legacySourceLabel(right)));
});

const legacyMemoryTexts = Effect.fn('memory.legacyMemoryTexts')(function* (sourcePath: string) {
  const raw = yield* readTextIfExists(sourcePath);
  if (!raw) {
    return [];
  }
  const memories: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const parsed = Result.try((): unknown => JSON.parse(trimmedLine));
    if (Result.isFailure(parsed)) {
      continue;
    }
    const text = legacyMessageText(parsed.success)?.trim();
    if (text && isLegacyThreadnoteMemory(text)) {
      memories.push(text);
    }
  }
  return memories;
});

function legacyMessageText(value: unknown): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }
  if (!Array.isArray(value.parts)) {
    return undefined;
  }
  const parts = value.parts
    .map(part => (isJsonObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : undefined))
    .filter((text): text is string => text !== undefined);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isLegacyThreadnoteMemory(text: string): boolean {
  return text.startsWith('MEMORY\n') || text.startsWith('HANDOFF\n');
}

const existingDurableMemoryHashes = Effect.fn('memory.existingDurableMemoryHashes')(function* (config: RuntimeConfig) {
  const hashes = new Set<string>();
  yield* collectDurableMemoryHashes(yield* localDataRoot(config), hashes);
  return hashes;
});

const collectDurableMemoryHashes: (
  root: string,
  hashes: Set<string>,
) => Effect.Effect<void, unknown, Crypto.Crypto | FileSystem.FileSystem | Path.Path> = Effect.fn(
  'memory.collectDurableMemoryHashes',
)(function* (root: string, hashes: Set<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root).pipe(Effect.option);
  if (entries._tag === 'None') {
    return;
  }
  for (const entry of entries.value) {
    const entryPath = path.join(root, entry);
    const info = yield* fs.stat(entryPath).pipe(Effect.option);
    if (info._tag === 'None') {
      continue;
    }
    if (info.value.type === 'Directory') {
      yield* collectDurableMemoryHashes(entryPath, hashes);
      continue;
    }
    if (
      info.value.type !== 'File' ||
      entry.startsWith('.') ||
      !entry.endsWith('.md') ||
      !isDurableMemoryPath(entryPath)
    ) {
      continue;
    }
    const content = yield* readTextIfExists(entryPath);
    if (content) {
      const trimmedContent = content.trim();
      hashes.add(yield* sha256(trimmedContent));
      hashes.add(yield* sha256(comparableMemoryText(trimmedContent)));
    }
  }
});

function isDurableMemoryPath(path: string): boolean {
  return path.replaceAll('\\', '/').split('/').includes('memories');
}

const childDirectoryNames = Effect.fn('memory.childDirectoryNames')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const entries = yield* fs.readDirectory(path).pipe(Effect.option);
  if (entries._tag === 'None') {
    return [];
  }
  const directories: string[] = [];
  for (const entry of entries.value) {
    const info = yield* fs.stat(pathService.join(path, entry)).pipe(Effect.option);
    if (info._tag === 'Some' && info.value.type === 'Directory') {
      directories.push(entry);
    }
  }
  return directories.sort();
});

export const readTextIfExists = Effect.fn('memory.readTextIfExists')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (info._tag === 'None' || info.value.type !== 'File') {
    return undefined;
  }
  return yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
});

function sensitiveMemoryReason(text: string): string | undefined {
  const patterns: readonly {readonly name: string; readonly regex: RegExp}[] = [
    {name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
    {name: 'API key', regex: /\bsk-[A-Za-z0-9_-]{16,}/},
    {name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{16,}/},
    {name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i},
    {name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/},
  ];
  return patterns.find(pattern => pattern.regex.test(text))?.name;
}

function comparableMemoryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('MEMORY\n')) {
    return trimmed;
  }
  const separatorIndex = trimmed.indexOf('\n\n');
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 2).trim();
}

function legacySourceLabel(candidate: LegacyMemoryCandidate): string {
  return `${candidate.sourceAccount}/${candidate.sourceSession}/${candidate.sourceArchive}`;
}

const localDataRoot = Effect.fn('memory.localDataRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'data');
});

export const localUserMemoriesRoot = Effect.fn('memory.localUserMemoriesRoot')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  return path.join(yield* localDataRoot(config), config.account, 'user', uriSegment(config.user), 'memories');
});

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
